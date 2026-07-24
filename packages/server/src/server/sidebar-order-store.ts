import { promises as fs } from "node:fs";

import type { Logger } from "pino";

import { type SidebarOrder, SidebarOrderSchema } from "@getpaseo/protocol/messages";
import { writeJsonFileAtomic } from "./atomic-file.js";

const EMPTY_ORDER: SidebarOrder = { projectOrder: [], workspaceOrderByProject: {} };

export type SidebarOrderChangeListener = (order: SidebarOrder) => void;

/**
 * Daemon-persisted sidebar project/workspace order, shared across every client
 * (PWA, desktop, mobile) connected to this daemon. Backed by a single JSON file
 * at `$PASEO_HOME/sidebar-order.json` with atomic writes. Change listeners let
 * the websocket server broadcast `sidebar_order_changed` to all clients.
 */
export class SidebarOrderStore {
  private readonly filePath: string;
  private readonly logger: Logger;
  private current: SidebarOrder = EMPTY_ORDER;
  private loaded = false;
  private persistQueue: Promise<void> = Promise.resolve();
  private readonly changeListeners = new Set<SidebarOrderChangeListener>();

  constructor(filePath: string, logger: Logger) {
    this.filePath = filePath;
    this.logger = logger.child({ module: "sidebar-order-store" });
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async get(): Promise<SidebarOrder> {
    await this.load();
    return this.current;
  }

  async set(order: SidebarOrder): Promise<SidebarOrder> {
    await this.load();
    const parsed = SidebarOrderSchema.parse(order);
    this.current = parsed;
    await this.enqueuePersist();
    for (const listener of this.changeListeners) {
      listener(parsed);
    }
    return parsed;
  }

  onChange(listener: SidebarOrderChangeListener): () => void {
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
      this.current = SidebarOrderSchema.parse(JSON.parse(raw));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.error(
          { err: error, filePath: this.filePath },
          "Failed to load sidebar-order file",
        );
      }
      this.current = EMPTY_ORDER;
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
