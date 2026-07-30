import type { KanbanTask, TaskBoard } from "@getpaseo/protocol/tasks/types";
import type pino from "pino";

import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { type AgentIdleWatcherHost, watchAgentIdle } from "./task-agent-link.js";

/**
 * Archiving a card closes its conversation.
 *
 * A card that is archived — filed away automatically once its work went live, or
 * hidden by hand — has nothing left to say, yet its agent tab kept sitting in the
 * top band of every connected client forever. Nobody ever closed those, so the
 * band silted up with finished work.
 *
 * Archiving the card's AGENT is the single lever that closes the tab everywhere:
 * an archived agent drops out of the workspace's active set, and the tab
 * reconciler already closes agent tabs whose agent is no longer active (see
 * `collapseStaleEntityTabs` / `shouldPruneWorkspaceAgentTab` in the app). That
 * also means no new resurrection path: the close travels through the existing
 * host snapshot, not through a second, competing "close this tab" channel.
 *
 * The card's TERMINALS go with it. A terminal the card's agent opened for its own
 * work outlives the card otherwise, and its tab sits in the same band. Ownership
 * comes from the `create_terminal` call itself (see AgentTerminalRegistry) —
 * never from the workspace, which a card shares with everything else in the
 * project.
 *
 * Three safety rules:
 * - a RUNNING agent is never cut off mid-sentence: the archive is deferred until
 *   it goes idle (the deploy path uses the same watcher);
 * - a terminal still WORKING is left alone: a build or a dev server the user is
 *   watching must not die because a card was filed away;
 * - failures are logged and swallowed — a card must archive even if its agent is
 *   already gone.
 */

export type TaskSessionCloserAgentHost = Pick<
  AgentManager,
  "getAgent" | "subscribe" | "archiveAgent" | "archiveSnapshot"
>;

/** The terminal side of a card: what it opened, and how to close it. */
export interface TaskSessionCloserTerminalHost {
  /** Terminal ids the agent opened, claimed once (see AgentTerminalRegistry). */
  takeForAgent: (agentId: string) => string[];
  /** "working" for a terminal still running a command; null when it is gone. */
  getActivityState: (terminalId: string) => "idle" | "working" | "attention" | null;
  killTerminal: (terminalId: string) => Promise<void>;
}

export interface TaskSessionCloserOptions {
  agentManager: TaskSessionCloserAgentHost;
  // A card's agent survives daemon restarts as a stored record the clients still
  // list — and still show a tab for. Closing only the live ones would leave every
  // pre-restart tab behind, which is most of the band.
  agentStorage: Pick<AgentStorage, "get">;
  // Omitted when no terminal manager is configured (tests, headless runs): the
  // card's conversation still closes, there is simply nothing else to close.
  terminals?: TaskSessionCloserTerminalHost;
  logger: pino.Logger;
}

/** Every agent id a card owns, deduplicated, newest link first. */
export function collectTaskAgentIds(task: KanbanTask): string[] {
  const ids = [
    task.links.taskAgentId ?? null,
    task.links.primaryAgentId ?? null,
    ...task.links.agentIds,
  ];
  const seen = new Set<string>();
  for (const id of ids) {
    const trimmed = typeof id === "string" ? id.trim() : "";
    if (trimmed) {
      seen.add(trimmed);
    }
  }
  return [...seen];
}

/** "Archived" covers both doors: the terminal column, and the manual hide. */
export function isTaskArchived(task: KanbanTask): boolean {
  return task.column === "archived" || task.archivedAt != null;
}

export class TaskSessionCloser {
  private readonly agentManager: TaskSessionCloserAgentHost;
  private readonly agentStorage: Pick<AgentStorage, "get">;
  private readonly terminals: TaskSessionCloserTerminalHost | null;
  private readonly logger: pino.Logger;
  // Agents already handled (archived, or waiting on the idle watcher). Keeps a
  // repeated archive — a board sweep on top of the live listener — from stacking
  // watchers on the same agent.
  private readonly handledAgentIds = new Set<string>();
  private readonly pendingWatchers = new Map<string, () => void>();

  constructor(options: TaskSessionCloserOptions) {
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.terminals = options.terminals ?? null;
    this.logger = options.logger;
  }

  /** Closes every session attached to a card. Never throws. */
  async closeSessionsForTask(projectId: string, task: KanbanTask): Promise<void> {
    for (const agentId of collectTaskAgentIds(task)) {
      await this.closeAgentSession(projectId, task.id, agentId);
    }
  }

  /**
   * Boot-time catch-up: cards archived before this existed still hold live
   * agents, and their tabs are exactly the ones already cluttering the band.
   * Idempotent — an agent that is gone or already archived is skipped.
   */
  async sweepArchivedTasks(projectId: string, board: TaskBoard): Promise<void> {
    for (const task of board.tasks) {
      if (isTaskArchived(task)) {
        await this.closeSessionsForTask(projectId, task);
      }
    }
  }

  /** Drops every pending idle watcher (daemon shutdown / tests). */
  dispose(): void {
    for (const cancel of this.pendingWatchers.values()) {
      cancel();
    }
    this.pendingWatchers.clear();
  }

  private async closeAgentSession(
    projectId: string,
    taskId: string,
    agentId: string,
  ): Promise<void> {
    if (this.handledAgentIds.has(agentId)) {
      return;
    }
    const agent = this.agentManager.getAgent(agentId);
    if (agent) {
      if (agent.lifecycle === "running") {
        this.deferUntilIdle(projectId, taskId, agentId);
        return;
      }
      this.handledAgentIds.add(agentId);
      await this.archive(projectId, taskId, agentId);
      return;
    }
    // Not running in this daemon, but still a stored record: the clients list it
    // and keep its tab, so it has to be archived on the record itself.
    let stored: Awaited<ReturnType<AgentStorage["get"]>> = null;
    try {
      stored = await this.agentStorage.get(agentId);
    } catch (error) {
      this.logger.warn(
        { err: error, projectId, taskId, agentId },
        "task.session-closer.lookup-failed: could not read the card's stored session",
      );
      return;
    }
    if (!stored || stored.archivedAt) {
      return;
    }
    this.handledAgentIds.add(agentId);
    await this.archive(projectId, taskId, agentId, stored.id);
  }

  /**
   * The card is archived but its agent is still talking (a card hidden by hand
   * while its final message streams). Cutting the process here would lose that
   * reply, so the close waits for the agent to fall silent.
   */
  private deferUntilIdle(projectId: string, taskId: string, agentId: string): void {
    if (this.pendingWatchers.has(agentId)) {
      return;
    }
    this.logger.debug(
      { projectId, taskId, agentId },
      "task.session-closer.deferred: agent still running",
    );
    const cancel = watchAgentIdle(this.agentManager as AgentIdleWatcherHost, agentId, () => {
      this.pendingWatchers.delete(agentId);
      if (this.handledAgentIds.has(agentId)) {
        return;
      }
      this.handledAgentIds.add(agentId);
      void this.archive(projectId, taskId, agentId);
    });
    this.pendingWatchers.set(agentId, cancel);
  }

  private async archive(
    projectId: string,
    taskId: string,
    agentId: string,
    storedOnlyId?: string,
  ): Promise<void> {
    try {
      if (storedOnlyId) {
        await this.agentManager.archiveSnapshot(storedOnlyId, new Date().toISOString());
      } else {
        await this.agentManager.archiveAgent(agentId);
      }
      this.logger.info(
        { projectId, taskId, agentId },
        "task.session-closer.archived: closed the archived card's session",
      );
    } catch (error) {
      // The card stays archived either way: a session we could not close is a
      // stale tab, not a broken board.
      this.handledAgentIds.delete(agentId);
      this.logger.warn(
        { err: error, projectId, taskId, agentId },
        "task.session-closer.failed: could not close the archived card's session",
      );
      return;
    }
    // Only once the conversation is closed: a terminal killed while its agent
    // still runs would cut work the card had not finished.
    await this.closeTerminalsForAgent(projectId, taskId, agentId);
  }

  /**
   * Closes the terminals this agent opened. A terminal still running a command
   * is kept — the user may be watching a build or a dev server — and is simply
   * released from the card's ownership, so nothing tries to kill it again.
   */
  private async closeTerminalsForAgent(
    projectId: string,
    taskId: string,
    agentId: string,
  ): Promise<void> {
    const terminals = this.terminals;
    if (!terminals) {
      return;
    }
    for (const terminalId of terminals.takeForAgent(agentId)) {
      const activity = terminals.getActivityState(terminalId);
      // Already gone: nothing to close, and no tab left either.
      if (activity === null) {
        continue;
      }
      if (activity === "working") {
        this.logger.info(
          { projectId, taskId, agentId, terminalId },
          "task.session-closer.terminal-busy: left a running terminal open",
        );
        continue;
      }
      try {
        await terminals.killTerminal(terminalId);
        this.logger.info(
          { projectId, taskId, agentId, terminalId },
          "task.session-closer.terminal-closed: closed the archived card's terminal",
        );
      } catch (error) {
        this.logger.warn(
          { err: error, projectId, taskId, agentId, terminalId },
          "task.session-closer.terminal-failed: could not close the card's terminal",
        );
      }
    }
  }
}
