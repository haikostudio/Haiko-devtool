import { homedir } from "node:os";
import type { Logger } from "pino";

import { ProviderUsageService } from "../services/quota-fetcher/service.js";
import type { AgentManager } from "./agent/agent-manager.js";

const DEFAULT_POLL_INTERVAL_MS = 60_000;
/**
 * If a fire didn't manage to start a fresh window (e.g. Claude wasn't
 * launchable at the time), wait this long before trying again rather than
 * hammering every poll.
 */
const DEFAULT_REFIRE_COOLDOWN_MS = 10 * 60_000;
/** Claude's rolling 5-hour window, as surfaced by the quota fetcher. */
const CLAUDE_PROVIDER_ID = "claude";
const CLAUDE_FIVE_HOUR_WINDOW_ID = "five_hour";

const KEEPALIVE_TITLE = "Quota keep-alive";
const KEEPALIVE_PROMPT =
  "Automated quota keep-alive: this throwaway request restarts your Claude 5-hour " +
  'usage window. Reply with a single word ("OK") and take no other action.';

/** Starts a fresh throwaway Claude conversation to restart the 5-hour window. */
export type KeepAliveRunner = (params: { cwd: string }) => Promise<void>;

export interface QuotaResetWatcherOptions {
  agentManager: AgentManager;
  logger: Logger;
  /** Injected for tests; defaults to a fresh fetcher-backed service. */
  providerUsageService?: ProviderUsageService;
  pollIntervalMs?: number;
  refireCooldownMs?: number;
  now?: () => number;
  /** Injected for tests; defaults to the throwaway-agent runner. */
  runKeepAlive?: KeepAliveRunner;
}

/**
 * Keeps a Claude 5-hour usage window perpetually running. The window only
 * counts down once a request lands, so the moment the current window lapses
 * (quota back to zero) this spins up a brand-new throwaway Claude conversation
 * that sends one tiny request — that request restarts the 5-hour countdown so
 * there is always a fresh window in progress instead of an idle quota waiting
 * to be spent.
 *
 * It never touches an existing conversation: each keep-alive is a fresh,
 * hidden (internal, no workspace, non-persisted) agent that is closed as soon
 * as its single turn completes.
 */
export class QuotaResetWatcher {
  private readonly agentManager: AgentManager;
  private readonly logger: Logger;
  private readonly providerUsageService: ProviderUsageService;
  private readonly pollIntervalMs: number;
  private readonly refireCooldownMs: number;
  private readonly now: () => number;
  private readonly runKeepAlive: KeepAliveRunner;

  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * When we last fired to restart the countdown. Used to avoid re-firing on
   * every poll while we wait for the fresh window to show up in the usage API.
   * Cleared as soon as we observe an active window again.
   */
  private lastFireAtMs: number | null = null;

  constructor(options: QuotaResetWatcherOptions) {
    this.agentManager = options.agentManager;
    this.logger = options.logger.child({ module: "quota-reset-watcher" });
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.refireCooldownMs = options.refireCooldownMs ?? DEFAULT_REFIRE_COOLDOWN_MS;
    this.providerUsageService =
      options.providerUsageService ??
      // Keep the cache short so we notice a lapsed window within roughly one
      // poll instead of the default 5-minute usage cache.
      new ProviderUsageService({ logger: this.logger, cacheTtlMs: this.pollIntervalMs });
    this.now = options.now ?? Date.now;
    this.runKeepAlive = options.runKeepAlive ?? ((params) => this.spawnKeepAliveAgent(params.cwd));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.logger.debug({ err }, "Quota reset watcher tick failed");
      });
    }, this.pollIntervalMs);
    // Don't keep the event loop alive just for this poller.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed for tests: run a single poll synchronously. */
  async tick(): Promise<void> {
    const usage = await this.providerUsageService.listUsage();
    const claude = usage.providers.find((p) => p.providerId === CLAUDE_PROVIDER_ID);
    // The provider only reports usable data when Claude is authenticated. When
    // it isn't, back off entirely rather than firing blind.
    if (!claude || claude.status !== "available") {
      return;
    }

    const window = claude.windows.find((w) => w.id === CLAUDE_FIVE_HOUR_WINDOW_ID);
    const resetAtMs = window?.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    const now = this.now();

    // A window is actively counting down as long as its reset timestamp is in
    // the future. Absent window or a past reset timestamp means the 5-hour
    // quota has lapsed and nothing is running.
    const windowActive = Number.isFinite(resetAtMs) && resetAtMs > now;
    if (windowActive) {
      this.lastFireAtMs = null;
      return;
    }

    // Window has lapsed. Restart the countdown — but not on every single poll
    // while we wait for the fresh window to register.
    if (this.lastFireAtMs !== null && now - this.lastFireAtMs < this.refireCooldownMs) {
      return;
    }

    this.lastFireAtMs = now;
    const cwd = this.pickCwd();
    this.logger.info({ cwd }, "Claude 5-hour window lapsed — restarting the countdown");
    await this.runKeepAlive({ cwd });
  }

  /**
   * Spin up a hidden throwaway Claude agent, send it one keep-alive turn, and
   * close it. Never reuses or resumes an existing conversation.
   */
  private async spawnKeepAliveAgent(cwd: string): Promise<void> {
    const agent = await this.agentManager.createAgent(
      { provider: CLAUDE_PROVIDER_ID, cwd, title: KEEPALIVE_TITLE, internal: true },
      undefined,
      { persistSession: false, workspaceId: undefined },
    );
    try {
      await this.agentManager.runAgent(agent.id, KEEPALIVE_PROMPT);
    } finally {
      await this.agentManager.closeAgent(agent.id).catch((err) => {
        this.logger.debug({ err, agentId: agent.id }, "Failed to close keep-alive agent");
      });
    }
  }

  /**
   * Where to run the throwaway agent. Reuse the most recently active Claude
   * agent's directory when there is one so it runs in a real project context;
   * otherwise fall back to the home directory.
   */
  private pickCwd(): string {
    const mostRecent = this.agentManager
      .listAgents()
      .filter((agent) => agent.provider === CLAUDE_PROVIDER_ID && !agent.internal)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
    return mostRecent?.cwd ?? homedir();
  }
}
