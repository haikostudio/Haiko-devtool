import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { MessageTriage, matchesTaskIntent } from "./message-triage.js";
import { TaskBoardService } from "./service.js";
import { TaskBoardStore } from "./store.js";

const logger = pino({ level: "silent" });

describe("matchesTaskIntent", () => {
  test.each([
    "voilà le mail du client, ajoute ça aux tâches",
    "il faudrait refactorer le module d'auth",
    "note ça comme une tâche pour plus tard",
    "add a task to update the docs",
    "todo: fix the login redirect",
    "crée une tâche pour le paiement",
    "remind me to review the PR",
  ])("matches task intent: %s", (text) => {
    expect(matchesTaskIntent(text)).toBe(true);
  });

  test.each([
    "comment marche cette fonction ?",
    "merci !",
    "run the tests please",
    "ok", // below min length
    "explique-moi le bug",
  ])("does not match: %s", (text) => {
    expect(matchesTaskIntent(text)).toBe(false);
  });
});

describe("MessageTriage", () => {
  let dir: string;
  let service: TaskBoardService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-msg-triage-"));
    service = new TaskBoardService({ store: new TaskBoardStore(dir), logger });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function buildTriage(options: {
    finalText: string | Error;
    sourceAgent?: { provider: string; config: { model?: string; thinkingOptionId?: string } };
  }) {
    const runAgent = vi.fn(async () => {
      if (options.finalText instanceof Error) {
        throw options.finalText;
      }
      return { canceled: false, finalText: options.finalText, timeline: [] };
    });
    const createAgent = vi.fn(async () => ({
      snapshot: { id: "triage-agent-1" },
      initialPromptError: null,
    }));
    const appendTimelineItem = vi.fn(async (_agentId: string, _item: AgentTimelineItem) => {});
    const triage = new MessageTriage({
      agentManager: {
        runAgent,
        archiveAgent: vi.fn(async () => {}),
        appendTimelineItem,
        getAgent: vi.fn(() => options.sourceAgent ?? null),
      } as never,
      createAgent: createAgent as never,
      taskBoardService: service,
      resolveProjectId: async () => "proj-1",
      resolveProjectCwd: async () => "/tmp/proj-1",
      logger,
    });
    return { triage, runAgent, createAgent, appendTimelineItem };
  }

  test("proposes tasks in chat WITHOUT writing anything to the board", async () => {
    const { triage, appendTimelineItem } = buildTriage({
      finalText: JSON.stringify({
        kind: "tasks",
        tasks: [
          { title: "Ajouter le mode sombre", folderName: "Features", tags: ["ui"] },
          { title: "Corriger le redirect login", tags: [] },
        ],
      }),
    });

    triage.triage({ agentId: "agent-1", text: "voilà le mail, ajoute ça aux tâches" });

    // The proposal only emits a chat pill — nothing is created until approval.
    await vi.waitFor(() => {
      expect(appendTimelineItem).toHaveBeenCalled();
    });
    const board = await service.getBoard("proj-1");
    expect(board.tasks).toEqual([]);
    expect(board.folders).toEqual([]);
    expect(board.proposalResolutions ?? []).toEqual([]);

    const proposedCall = appendTimelineItem.mock.calls.at(-1)?.[1] as AgentTimelineItem;
    expect(proposedCall).toMatchObject({
      type: "task_triage",
      status: "proposed",
      proposedCount: 2,
    });
    // Full payloads ride along so approval can create the exact task later.
    const proposedTasks = proposedCall.tasks as {
      proposalId: string;
      title: string;
      folderName?: string;
    }[];
    expect(proposedTasks.map((entry) => entry.title)).toEqual([
      "Ajouter le mode sombre",
      "Corriger le redirect login",
    ]);
    expect(proposedTasks[0]?.folderName).toBe("Features");
    for (const entry of proposedTasks) {
      expect(entry.proposalId).toBeTruthy();
    }
    // Distinct proposal ids so each approval stays independently idempotent.
    expect(proposedTasks[0]?.proposalId).not.toBe(proposedTasks[1]?.proposalId);
  });

  test("a proposal inherits the chatting agent's provider, model and effort", async () => {
    const { triage, appendTimelineItem } = buildTriage({
      finalText: JSON.stringify({
        kind: "tasks",
        tasks: [{ title: "Ajouter le mode sombre", tags: [] }],
      }),
      sourceAgent: {
        provider: "codex",
        config: { model: "gpt-5.4", thinkingOptionId: "high" },
      },
    });

    triage.triage({ agentId: "agent-1", text: "il faudrait ajouter ça aux tâches" });

    await vi.waitFor(() => {
      expect(appendTimelineItem).toHaveBeenCalled();
    });
    const proposedCall = appendTimelineItem.mock.calls.at(-1)?.[1] as AgentTimelineItem;
    const proposedTasks = proposedCall.tasks as { runConfig?: unknown }[];
    expect(proposedTasks[0]?.runConfig).toEqual({
      provider: "codex",
      model: "gpt-5.4",
      thinkingOptionId: "high",
    });
  });

  test("surfaces clarifying questions without creating tasks", async () => {
    const { triage, appendTimelineItem } = buildTriage({
      finalText: JSON.stringify({
        kind: "questions",
        questions: ["Dans quel dossier ?", "Priorité haute ?"],
      }),
    });

    triage.triage({ agentId: "agent-1", text: "ajoute ces trucs aux tâches" });

    await vi.waitFor(() => {
      expect(appendTimelineItem).toHaveBeenCalled();
    });
    const board = await service.getBoard("proj-1");
    expect(board.tasks.length).toBe(0);
    const call = appendTimelineItem.mock.calls.at(-1)?.[1] as AgentTimelineItem;
    expect(call).toMatchObject({
      type: "task_triage",
      status: "questions",
      questions: ["Dans quel dossier ?", "Priorité haute ?"],
    });
  });

  test("does nothing when the LLM returns kind=none", async () => {
    const { triage, appendTimelineItem, createAgent } = buildTriage({
      finalText: JSON.stringify({ kind: "none" }),
    });

    triage.triage({ agentId: "agent-1", text: "il faudrait vraiment que je dorme" });

    await vi.waitFor(() => {
      expect(createAgent).toHaveBeenCalled();
    });
    const board = await service.getBoard("proj-1");
    expect(board.tasks.length).toBe(0);
    expect(appendTimelineItem).not.toHaveBeenCalled();
  });

  test("swallows agent failures without creating tasks or surfacing errors", async () => {
    const { triage, appendTimelineItem, createAgent } = buildTriage({
      finalText: new Error("haiku exploded"),
    });

    triage.triage({ agentId: "agent-1", text: "ajoute ça aux tâches stp" });

    await vi.waitFor(() => {
      expect(createAgent).toHaveBeenCalled();
    });
    const board = await service.getBoard("proj-1");
    expect(board.tasks.length).toBe(0);
    expect(appendTimelineItem).not.toHaveBeenCalled();
  });

  test("skips the LLM entirely for chatty messages (pre-filter gate)", async () => {
    const { triage, createAgent } = buildTriage({ finalText: JSON.stringify({ kind: "none" }) });

    triage.triage({ agentId: "agent-1", text: "comment marche cette fonction ?" });

    // Give any (incorrectly) scheduled async work a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(createAgent).not.toHaveBeenCalled();
  });
});
