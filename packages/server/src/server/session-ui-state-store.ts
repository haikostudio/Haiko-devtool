import { promises as fs } from "node:fs";

import type { Logger } from "pino";
import { z } from "zod";

import { type WorkspaceUiState, WorkspaceUiStateSchema } from "@getpaseo/protocol/messages";
import { writeJsonFileAtomic } from "./atomic-file.js";

// The whole file: every workspace's UI state keyed by opaque workspaceId.
const StoreFileSchema = z.record(z.string(), WorkspaceUiStateSchema);
type StoreFile = Record<string, WorkspaceUiState>;

export type SessionUiStateChangeListener = (input: {
  workspaceId: string;
  state: WorkspaceUiState;
}) => void;

/**
 * Daemon-persisted per-workspace UI session state (open tabs, order, focus,
 * drafts), shared across every client (PWA, desktop, mobile) connected to this
 * daemon. Backed by a single JSON file at `$PASEO_HOME/ui-state.json` with
 * atomic writes. The daemon stores and rebroadcasts each workspace's state
 * opaquely — only the app interprets tab targets and draft records. Change
 * listeners let the websocket server broadcast `session_ui_state_changed` to all
 * clients so other devices update live.
 */
export class SessionUiStateStore {
  private readonly filePath: string;
  private readonly logger: Logger;
  private current: StoreFile = {};
  private loaded = false;
  private persistQueue: Promise<void> = Promise.resolve();
  private readonly changeListeners = new Set<SessionUiStateChangeListener>();

  constructor(filePath: string, logger: Logger) {
    this.filePath = filePath;
    this.logger = logger.child({ module: "session-ui-state-store" });
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async getAll(): Promise<StoreFile> {
    await this.load();
    return this.current;
  }

  async setWorkspace(workspaceId: string, state: WorkspaceUiState): Promise<WorkspaceUiState> {
    await this.load();
    const parsed = WorkspaceUiStateSchema.parse(state);
    this.current = { ...this.current, [workspaceId]: parsed };
    await this.enqueuePersist();
    for (const listener of this.changeListeners) {
      listener({ workspaceId, state: parsed });
    }
    return parsed;
  }

  onChange(listener: SessionUiStateChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this.current = StoreFileSchema.parse(JSON.parse(raw));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.error({ err: error, filePath: this.filePath }, "Failed to load ui-state file");
      }
      this.current = {};
    }
    this.loaded = true;
  }

  private async enqueuePersist(): Promise<void> {
    const snapshot = this.current;
    const nextPersist = this.persistQueue.then(() => writeJsonFileAtomic(this.filePath, snapshot));
    this.persistQueue = nextPersist.catch(() => {});
    await nextPersist;
  }
}
