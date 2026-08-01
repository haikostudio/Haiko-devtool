import express from "express";
import { createServer as createHTTPServer, type IncomingMessage, type ServerResponse } from "http";
import { constants, existsSync, unlinkSync } from "fs";
import { open } from "fs/promises";
import { randomUUID } from "node:crypto";
import { hostname as getHostname } from "node:os";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Logger } from "pino";
import { z } from "zod";
import { createBranchChangeRouteHandler } from "./script-route-branch-handler.js";

export type ListenTarget =
  | { type: "tcp"; host: string; port: number }
  | { type: "socket"; path: string }
  | { type: "pipe"; path: string };

function resolveBoundListenTarget(
  listenTarget: ListenTarget,
  httpServer: ReturnType<typeof createHTTPServer>,
): ListenTarget {
  if (listenTarget.type !== "tcp") {
    return listenTarget;
  }

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP server did not expose a TCP address after listening");
  }

  return {
    type: "tcp",
    host: listenTarget.host,
    port: address.port,
  };
}

// Matches a Windows drive-letter path like C:\ or D:\
const WINDOWS_DRIVE_RE = /^[A-Za-z]:\\/;

export function parseListenString(listen: string): ListenTarget {
  // 1. Windows named pipes: \\.\pipe\... or pipe://...
  if (listen.startsWith("\\\\.\\pipe\\") || listen.startsWith("pipe://")) {
    return {
      type: "pipe",
      path: listen.startsWith("pipe://") ? listen.slice("pipe://".length) : listen,
    };
  }
  // 2. Explicit unix:// prefix
  if (listen.startsWith("unix://")) {
    return { type: "socket", path: listen.slice(7) };
  }
  // 3. Reject Windows absolute drive paths — they are not Unix sockets
  if (WINDOWS_DRIVE_RE.test(listen)) {
    throw new Error(`Invalid listen string (Windows path is not a valid listen target): ${listen}`);
  }
  // 4. POSIX absolute path (/ or ~) — Unix socket
  if (listen.startsWith("/") || listen.startsWith("~")) {
    return { type: "socket", path: listen };
  }
  // 5. Pure numeric — TCP port on 127.0.0.1
  const trimmed = listen.trim();
  if (/^\d+$/.test(trimmed)) {
    const port = parseInt(trimmed, 10);
    return { type: "tcp", host: "127.0.0.1", port };
  }
  // 6. host:port — TCP
  if (listen.includes(":")) {
    const lastColonIdx = listen.lastIndexOf(":");
    const host = listen.slice(0, lastColonIdx);
    const portStr = listen.slice(lastColonIdx + 1);
    const parsedPort = parseInt(portStr, 10);
    if (!Number.isFinite(parsedPort)) {
      throw new Error(`Invalid port in listen string: ${listen}`);
    }
    const cleanHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    return { type: "tcp", host: cleanHost || "127.0.0.1", port: parsedPort };
  }
  throw new Error(`Invalid listen string: ${listen}`);
}

function formatListenTarget(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget) {
    return null;
  }
  if (listenTarget.type === "tcp") {
    return `${listenTarget.host}:${listenTarget.port}`;
  }
  return listenTarget.path;
}

import { VoiceAssistantWebSocketServer } from "./websocket-server.js";
import { createGitHubService } from "../services/github-service.js";
import {
  createPaseoWorktree as createRegisteredPaseoWorktree,
  createLocalCheckoutWorkspace,
} from "./paseo-worktree-service.js";
import { createPaseoWorktreeWorkflow } from "./worktree-session.js";
import { DownloadTokenStore } from "./file-download/token-store.js";
import { DownloadArchiveStore } from "./file-download/archive-store.js";
import { DownloadArchiveCleaner } from "./download-archive-cleaner.js";
import type { OpenAiSpeechProviderConfig } from "./speech/providers/openai/config.js";
import type { LocalSpeechProviderConfig } from "./speech/providers/local/config.js";
import type { RequestedSpeechProviders } from "./speech/speech-types.js";
import { createSpeechService } from "./speech/speech-runtime.js";
import { AgentManager } from "./agent/agent-manager.js";
import { FileAgentTimelineStore } from "./agent/file-agent-timeline-store.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { AgentTerminalRegistry } from "./agent/agent-terminal-registry.js";
import { UsageStatsStore } from "./stats/usage-stats-store.js";
import { ComptaLinksStore } from "./compta/compta-links-store.js";
import { ComptaSummaryService } from "./compta/compta-summary-service.js";
import { runClaudeTranscriptBackfill } from "./stats/claude-transcript-backfill.js";
import { attachAgentStoragePersistence } from "./persistence-hooks.js";
import { createAgentMcpServer } from "./agent/mcp-server.js";
import {
  createPaseoToolCatalog,
  type PaseoToolHostDependencies,
} from "./agent/tools/paseo-tools.js";
import type { PaseoToolRuntimeContext } from "./agent/tools/types.js";
import { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import { bootstrapWorkspaceRegistries } from "./workspace-registry-bootstrap.js";
import { WorkspaceReconciliationService } from "./workspace-reconciliation-service.js";
import {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  resolveProjectDisplayName,
} from "./workspace-registry.js";
import { FileBackedChatService } from "./chat/chat-service.js";
import { CheckoutDiffManager } from "./checkout-diff-manager.js";
import { LoopService } from "./loop-service.js";
import { QuotaResetWatcher } from "./quota-reset-watcher.js";
import { ScheduleService } from "./schedule/service.js";
import {
  isProviderUsageExhausted,
  ProviderUsageService,
} from "../services/quota-fetcher/service.js";
import { TaskBoardStore } from "./tasks/store.js";
import { DaemonRestartReminder } from "./tasks/daemon-restart-reminder.js";
import { resolveDaemonRestartImpact } from "./tasks/restart-impact.js";
import { TaskBoardService } from "./tasks/service.js";
import { TaskSessionCloser } from "./tasks/session-closer.js";
import { TaskProposalNotifier } from "./tasks/proposal-notifier.js";
import { DEFAULT_TASKS_QUIET_HOURS } from "./quiet-hours.js";
import { AgentTaskSyncService } from "./tasks/agent-sync.js";
import { createTaskResponseTemplateHook } from "./tasks/response-template.js";
import { ActivityLogService } from "./activity/service.js";
import { TaskEstimator } from "./tasks/estimator.js";
import { TaskAgentProvisioner } from "./tasks/agent-provisioner.js";
import { MessageTriage } from "./tasks/message-triage.js";
import { TaskUsageRecorder } from "./tasks/usage-recorder.js";
import { createWorkspaceProvisioningService } from "./session/workspace-provisioning/workspace-provisioning-service.js";
import type { HubRelationshipRemote } from "./hub/relationship-remote.js";
import type {
  HubRelationshipClock,
  HubRelationshipRetryPolicy,
} from "./hub/relationship-controller.js";
import { ConductorAgentService } from "./tasks/conductor-agent.js";
import { TaskScheduler } from "./tasks/scheduler.js";
import { TaskGitTracker } from "./tasks/task-git-tracker.js";
import { TaskPublisher } from "./tasks/publish-on-complete.js";
import { watchAgentIdle } from "./tasks/task-agent-link.js";
import { TaskValidator } from "./tasks/validator.js";
import { TaskDeployer } from "./tasks/deployer.js";
import { TaskBatchDeployer } from "./tasks/batch-deployer.js";
import { AutoDeployWatcher } from "./tasks/auto-deploy.js";
import { DaemonConfigStore, type MutableDaemonConfig } from "./daemon-config-store.js";
import { BrowserToolsBroker } from "./browser-tools/broker.js";
import { DaemonConfigBrowserToolsPolicy } from "./browser-tools/policy.js";
import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";
import { ProjectPromptSyncService } from "./project-prompt-sync.js";
import { resolveWorkspaceIdForPath } from "./resolve-workspace-id-for-path.js";
import {
  archiveByScope,
  archivePersistedWorkspaceRecord,
  killTerminalsForWorkspace,
  type ActiveWorkspaceRef,
} from "./workspace-archive-service.js";
import { setupAutoArchiveOnMerge } from "./auto-archive-on-merge/index.js";
import { wrapSessionMessage, type SessionOutboundMessage } from "./messages.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import { createConfiguredTerminalManager } from "../terminal/terminal-manager-factory.js";
import { applyTerminalAgentHookSetting } from "../terminal/agent-hooks/terminal-agent-hook-setting.js";
import { createConnectionOfferV2, encodeOfferToFragmentUrl } from "./connection-offer.js";
import { loadOrCreateDaemonKeyPair } from "./daemon-keypair.js";
import { startRelayTransport, type RelayTransportController } from "./relay-transport.js";
import type {
  PushHistoryContext,
  PushNotificationSender,
  PushPayload,
} from "./push/notifications.js";
import { getOrCreateServerId } from "./server-id.js";
import { resolveDaemonVersion } from "./daemon-version.js";
import {
  PASEO_DEPLOY_BRANCH_TAG_PREFIX,
  PASEO_DEPLOY_CONFLICT_TAG,
  isPaseoDeployRepairBranch,
  isPaseoDeployRoot,
  getPaseoDeployRoots,
  getPaseoDeployRunSnapshot,
  getHeadSha,
  getPublishedSha,
  getRunningEngineSha,
  isDaemonRestartPending,
  recordDaemonBootSha,
  setPaseoDeployConflictTaskCreator,
  setPaseoDeploySuccessListener,
  triggerPaseoDeploy,
} from "../utils/paseo-deploy.js";
import {
  getPaseoAppUrl,
  resolveProjectDevInstanceTarget,
  resolveProjectDevInstanceUrl,
} from "../utils/project-dev-instance.js";
import { runGitCommand } from "../utils/run-git-command.js";
import { execCommand } from "../utils/spawn.js";
import { ProjectDeployer, type ProjectDeployExec } from "./tasks/project-deployer.js";
import { sendPromptToAgent } from "./agent/agent-prompt.js";
import type { AgentClient, AgentProvider } from "./agent/agent-sdk-types.js";
import type { FirstAgentContext, TerminalProfile } from "@getpaseo/protocol/messages";
import type {
  AgentProviderRuntimeSettingsMap,
  ProviderOverride,
} from "./agent/provider-launch-config.js";
import type { PersistedConfig } from "./persisted-config.js";
import { createServiceProxySubsystem, type ServiceProxySubsystem } from "./service-proxy.js";
import { ScriptHealthMonitor } from "./script-health-monitor.js";
import { createScriptStatusEmitter } from "./script-status-projection.js";
import { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import {
  createManagedProcessRegistry,
  createSystemManagedProcessTable,
  type ManagedProcessRegistry,
} from "./managed-processes/managed-processes.js";
import { terminateWithTreeKill } from "../utils/tree-kill.js";
import { isHostnameAllowed, type HostnamesConfig } from "./hostnames.js";
import {
  createRequireBearerMiddleware,
  isAgentMcpRequestAuthorized,
  type DaemonAuthConfig,
} from "./auth.js";
import { createWebUiMiddleware } from "./web-ui.js";
import { WorkspaceAutoName } from "./workspace-auto-name.js";
import { createGitMutationService } from "./session/git-mutation/git-mutation-service.js";
import { workspaceIdsOnCheckout } from "./workspace-directory.js";
import { resolveFirstAgentPromptTitle } from "./agent/create-agent-title.js";
import {
  createAgentCommand,
  type CreateAgentCommandDependencies,
} from "./agent/create-agent/create.js";

const MAX_MCP_DEBUG_BATCH_ITEMS = 10;
const REDACTED_LOG_VALUE = "[redacted]";
const DOWNLOAD_OPEN_FLAGS =
  process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;

function formatHostForHttpUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function resolveAgentMcpClientHost(host: string): string {
  if (host === "0.0.0.0") {
    return "127.0.0.1";
  }
  if (host === "::" || host === "[::]") {
    return "::1";
  }
  return host;
}

function createAgentMcpBaseUrl(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget || listenTarget.type !== "tcp") {
    return null;
  }
  const host = resolveAgentMcpClientHost(listenTarget.host);
  return new URL(
    "/mcp/agents",
    `http://${formatHostForHttpUrl(host)}:${listenTarget.port}`,
  ).toString();
}

function createTerminalActivityUrl(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget || listenTarget.type !== "tcp") {
    return null;
  }
  const host = resolveAgentMcpClientHost(listenTarget.host);
  return new URL(
    "/api/terminal-activity",
    `http://${formatHostForHttpUrl(host)}:${listenTarget.port}`,
  ).toString();
}

const TerminalActivityReportSchema = z.object({
  terminalId: z.string().min(1),
  token: z.string().min(1),
  state: z.enum(["running", "idle", "needs-input"]),
});

const TERMINAL_ACTIVITY_STATE_MAP = {
  running: "working",
  idle: "idle",
  "needs-input": "attention",
} as const;

const LOOPBACK_REMOTE_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  return remoteAddress !== undefined && LOOPBACK_REMOTE_ADDRESSES.has(remoteAddress);
}

export function createTerminalActivityRouteHandler(
  terminalManager: TerminalManager,
): express.RequestHandler {
  return async (req, res) => {
    if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const parsed = TerminalActivityReportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid terminal activity report" });
      return;
    }

    const validation = terminalManager.validateTerminalActivityToken(
      parsed.data.terminalId,
      parsed.data.token,
    );
    if (validation !== "valid") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    try {
      const updated = await terminalManager.setTerminalActivity(
        parsed.data.terminalId,
        TERMINAL_ACTIVITY_STATE_MAP[parsed.data.state],
      );
      if (!updated) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      res.status(204).end();
    } catch {
      res.status(500).json({ error: "Failed to update terminal activity" });
    }
  };
}

function summarizeAgentMcpDebugMessage(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      type: body === null ? "null" : typeof body,
    };
  }

  const record = body as Record<string, unknown>;
  const method = typeof record.method === "string" ? record.method : undefined;
  return {
    type: "object",
    ...(typeof record.jsonrpc === "string" ? { jsonrpc: record.jsonrpc } : {}),
    ...(method ? { method } : {}),
    hasId: Object.prototype.hasOwnProperty.call(record, "id"),
    hasParams: Object.prototype.hasOwnProperty.call(record, "params"),
  };
}

function summarizeAgentMcpDebugBody(body: unknown): Record<string, unknown> {
  if (!Array.isArray(body)) {
    return summarizeAgentMcpDebugMessage(body);
  }

  const messages = body.slice(0, MAX_MCP_DEBUG_BATCH_ITEMS).map(summarizeAgentMcpDebugMessage);
  return {
    type: "batch",
    count: body.length,
    messages,
    ...(body.length > messages.length ? { omitted: body.length - messages.length } : {}),
  };
}

export type PaseoOpenAIConfig = OpenAiSpeechProviderConfig;
export type PaseoLocalSpeechConfig = LocalSpeechProviderConfig;

export interface PaseoSpeechSttLanguages {
  dictation: string;
  voice: string;
}

export interface PaseoSpeechConfig {
  providers: RequestedSpeechProviders;
  sttLanguages?: PaseoSpeechSttLanguages;
  local?: PaseoLocalSpeechConfig;
}

export type DaemonLifecycleIntent =
  | {
      type: "shutdown";
      clientId: string;
      requestId: string;
      reason: string;
    }
  | {
      type: "restart";
      clientId: string;
      requestId: string;
      reason: string;
    };

export interface PaseoDaemonConfig {
  listen: string;
  paseoHome: string;
  // Restauré : version du démon et démarrage piloté par l'application de bureau.
  daemonVersion?: string;
  desktopManaged?: boolean;
  worktreesRoot?: string;
  corsAllowedOrigins: string[];
  allowedHosts?: HostnamesConfig;
  hostnames?: HostnamesConfig;
  trustedProxies?: true | string[];
  mcpEnabled?: boolean;
  mcpInjectIntoAgents?: boolean;
  browserToolsEnabled?: boolean;
  autoArchiveAfterMerge?: boolean;
  enableTerminalAgentHooks?: boolean;
  appendSystemPrompt?: string;
  terminalProfiles?: TerminalProfile[];
  tasks?: MutableDaemonConfig["tasks"];
  staticDir: string;
  mcpDebug: boolean;
  isDev?: boolean;
  agentClients: Partial<Record<AgentProvider, AgentClient>>;
  agentStoragePath: string;
  relayEnabled?: boolean;
  relayEndpoint?: string;
  relayPublicEndpoint?: string;
  relayUseTls?: boolean;
  relayPublicUseTls?: boolean;
  serviceProxy?: {
    publicBaseUrl: string | null;
    standaloneListen: string | null;
  };
  webUi?: {
    enabled: boolean;
    distDir: string | null;
  };
  brainMemory?: {
    enabled: boolean;
    baseUrl: string;
    apiKey: string | null;
    globalFallback: boolean;
    curation: boolean;
    providerModel: string;
  };
  messageTriage?: {
    enabled: boolean;
    providerModel: string;
  };
  appBaseUrl?: string;
  auth?: DaemonAuthConfig;
  openai?: PaseoOpenAIConfig;
  speech?: PaseoSpeechConfig;
  voiceLlmProvider?: AgentProvider | null;
  voiceLlmProviderExplicit?: boolean;
  voiceLlmModel?: string | null;
  dictationFinalTimeoutMs?: number;
  downloadTokenTtlMs?: number;
  agentProviderSettings?: AgentProviderRuntimeSettingsMap;
  metadataGeneration?: {
    providers?: Array<{
      provider: string;
      model?: string;
      thinkingOptionId?: string;
    }>;
  };
  providerOverrides?: Record<string, ProviderOverride>;
  log?: PersistedConfig["log"];
  onLifecycleIntent?: (intent: DaemonLifecycleIntent) => void;
  pushNotificationSender?: PushNotificationSender;
  managedProcesses?: ManagedProcessRegistry;
}

export interface PaseoDaemon {
  config: PaseoDaemonConfig;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager: TerminalManager;
  serviceProxy: ServiceProxySubsystem;
  scriptRuntimeStore: WorkspaceScriptRuntimeStore;
  browserToolsBroker: BrowserToolsBroker;
  start(): Promise<void>;
  stop(): Promise<void>;
  getListenTarget(): ListenTarget | null;
}

function createBootstrapManagedProcessRegistry(
  config: Pick<PaseoDaemonConfig, "paseoHome" | "managedProcesses">,
  logger: Logger,
): ManagedProcessRegistry {
  if (config.managedProcesses) {
    return config.managedProcesses;
  }

  return createManagedProcessRegistry({
    paseoHome: config.paseoHome,
    processTable: createSystemManagedProcessTable(),
    terminateProcess: terminateWithTreeKill,
    logger,
  });
}

async function reconcileManagedProcessLedger(
  managedProcesses: ManagedProcessRegistry,
  logger: Logger,
): Promise<void> {
  const reapResult = await managedProcesses.reapStale();
  if (reapResult.checked > 0 || reapResult.errors.length > 0) {
    logger.info(reapResult, "Managed helper process ledger reconciled");
  }
}

function mountWebUi(app: express.Application, config: PaseoDaemonConfig, logger: Logger): void {
  app.use(
    createWebUiMiddleware({
      enabled: config.webUi?.enabled ?? false,
      distDir: config.webUi?.distDir ?? null,
      label: getHostname(),
      logger,
    }),
  );
}

function resolveExpressTrustProxySetting(config: PaseoDaemonConfig): true | string[] {
  return config.trustedProxies ?? ["loopback"];
}

function createInitialMutableDaemonConfig(config: PaseoDaemonConfig): MutableDaemonConfig {
  const providers: MutableDaemonConfig["providers"] = Object.fromEntries(
    Object.entries(config.providerOverrides ?? {}).map(([providerId, override]) => {
      const providerConfig: MutableDaemonConfig["providers"][string] = {};
      if (override.enabled !== undefined) {
        providerConfig.enabled = override.enabled;
      }
      if (override.additionalModels) {
        providerConfig.additionalModels = override.additionalModels;
      }
      return [providerId, providerConfig];
    }),
  );

  const initialConfig: MutableDaemonConfig = {
    mcp: { injectIntoAgents: config.mcpInjectIntoAgents ?? true },
    browserTools: { enabled: config.browserToolsEnabled ?? false },
    brainMemory: { enabled: config.brainMemory?.enabled ?? false },
    providers,
    metadataGeneration: {
      providers: config.metadataGeneration?.providers ?? [],
    },
    autoArchiveAfterMerge: config.autoArchiveAfterMerge ?? false,
    enableTerminalAgentHooks: config.enableTerminalAgentHooks ?? false,
    appendSystemPrompt: config.appendSystemPrompt ?? "",
  };

  if (config.terminalProfiles !== undefined) {
    initialConfig.terminalProfiles = config.terminalProfiles;
  }

  if (config.tasks !== undefined) {
    initialConfig.tasks = config.tasks;
  }

  return initialConfig;
}

/**
 * Points d'injection pour les tests du « hub » (pilotage de démons distants).
 * ATTENTION : cette version du démon ne construit pas encore le contrôleur de
 * relations du hub — le paramètre existe pour que le harnais de test compile et
 * pour offrir le point d'accroche le jour où le hub sera branché ici. Tant que
 * ce n'est pas fait, ce qui est passé ici n'a aucun effet.
 */
export interface PaseoDaemonDependencies {
  hubRelationshipRemote?: HubRelationshipRemote;
  hubRelationshipClock?: HubRelationshipClock;
  hubRelationshipRetryPolicy?: HubRelationshipRetryPolicy;
  createHubDaemonId?: () => string;
}

export async function createPaseoDaemon(
  config: PaseoDaemonConfig,
  rootLogger: Logger,
  _dependencies: PaseoDaemonDependencies = {},
): Promise<PaseoDaemon> {
  const logger = rootLogger.child({ module: "bootstrap" });
  const bootstrapStart = performance.now();
  const elapsed = () => `${(performance.now() - bootstrapStart).toFixed(0)}ms`;
  const daemonVersion = resolveDaemonVersion(import.meta.url);
  // Snapshot the commit this daemon is running (self-host deploy hint) before any
  // other startup work can advance HEAD. Best-effort: no-op off the self-host box.
  void recordDaemonBootSha();
  // Prime the Paseo checkout-roots cache so the deploy button can appear in every
  // Paseo worktree from the first connection (refreshed on each status poll).
  void getPaseoDeployRoots();
  const daemonConfigStore = new DaemonConfigStore(
    config.paseoHome,
    createInitialMutableDaemonConfig(config),
    logger,
  );
  const browserToolsPolicy = new DaemonConfigBrowserToolsPolicy(daemonConfigStore);
  const browserToolsBroker = new BrowserToolsBroker({});

  const serverId = getOrCreateServerId(config.paseoHome, { logger });
  const daemonKeyPair = await loadOrCreateDaemonKeyPair(config.paseoHome, logger);
  const managedProcesses = createBootstrapManagedProcessRegistry(config, logger);
  // Reconcile the helper-process ledger in the background so it never blocks the
  // daemon from coming up; terminating a live leftover can take a few seconds.
  // Best-effort, so a failure is logged here rather than crashing startup.
  void reconcileManagedProcessLedger(managedProcesses, logger).catch((error) => {
    logger.warn({ err: error }, "Failed to reconcile managed helper process ledger");
  });
  let relayTransport: RelayTransportController | null = null;

  const staticDir = config.staticDir;
  const downloadTokenTtlMs = config.downloadTokenTtlMs ?? 60000;

  const downloadTokenStore = new DownloadTokenStore({
    ttlMs: downloadTokenTtlMs,
  });

  // Temporary zip archives built by the conductor's create_project_archive tool,
  // served through the same /api/files/download route and swept after 24h.
  const downloadArchiveStore = new DownloadArchiveStore({
    paseoHome: config.paseoHome,
    logger,
  });
  const downloadArchiveCleaner = new DownloadArchiveCleaner({
    archiveStore: downloadArchiveStore,
    logger,
  });

  // Capability token authenticating the daemon's own agents to the loopback
  // Agent MCP endpoint (/mcp/agents). Random per daemon run, injected only into
  // local agent configs and the daemon's own MCP client — never sent to remote
  // clients — so it cannot be replayed off-box. This lets the injected MCP
  // authenticate even when the daemon password is set via the app (hash only,
  // no plaintext available). Mirrors the /api/files/download capability-token
  // pattern.
  const agentMcpAuthToken = randomUUID();

  const listenTarget = parseListenString(config.listen);

  const app = express();
  app.set("trust proxy", resolveExpressTrustProxySetting(config));
  let boundListenTarget: ListenTarget | null = null;
  let workspaceRegistry: FileBackedWorkspaceRegistry | null = null;
  const terminalManager = createConfiguredTerminalManager({
    getTerminalActivityUrl: () => createTerminalActivityUrl(boundListenTarget),
  });
  // Who opened which terminal — the link a terminal itself does not carry. Used
  // to close a card's terminals when the card is archived.
  const agentTerminalRegistry = new AgentTerminalRegistry();
  applyTerminalAgentHookSetting({ store: daemonConfigStore, logger });

  const serviceProxyPublicBaseUrl = config.serviceProxy?.publicBaseUrl
    ? config.serviceProxy.publicBaseUrl
    : null;
  const serviceProxy = createServiceProxySubsystem({
    logger,
    publicBaseUrl: serviceProxyPublicBaseUrl,
  });
  const scriptRuntimeStore = new WorkspaceScriptRuntimeStore();
  const configuredHostnames = config.hostnames ?? config.allowedHosts;
  let wsServer: VoiceAssistantWebSocketServer | null = null;
  let serviceProxyListenTarget: ListenTarget | null = null;
  const scriptHealthMonitor = new ScriptHealthMonitor({
    serviceProxy,
    onChange: createScriptStatusEmitter({
      sessions: () =>
        wsServer?.listActiveSessions().map((session) => ({
          emit: (message) => session.emitServerMessage(message),
        })) ?? [],
      serviceProxy,
      runtimeStore: scriptRuntimeStore,
      daemonPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
      resolveWorkspaceDirectory: async (workspaceId) =>
        (await workspaceRegistry?.get(workspaceId))?.cwd ?? null,
      logger,
      serviceProxyPublicBaseUrl,
    }),
  });
  const handleBranchChange = createBranchChangeRouteHandler({
    serviceProxy,
    onRoutesChanged: (workspaceId) => {
      scriptHealthMonitor.invalidateWorkspace(workspaceId);
    },
    logger,
  });

  // Service proxy classifies service hosts before daemon auth/route fallthrough.
  // Registered service hosts proxy directly; known service namespaces without a
  // route return 404 and never reach daemon APIs.
  app.use(serviceProxy.middleware());

  // Host allowlist / DNS rebinding protection (vite-like semantics).
  // For non-TCP (unix sockets), skip host validation.
  if (listenTarget.type === "tcp") {
    app.use((req, res, next) => {
      const hostHeader = typeof req.headers.host === "string" ? req.headers.host : undefined;
      if (!isHostnameAllowed(hostHeader, configuredHostnames)) {
        res.status(403).json({ error: "Invalid Host header" });
        return;
      }
      next();
    });
  }

  // CORS - allow same-origin + configured origins
  const allowedOrigins = new Set([
    ...config.corsAllowedOrigins,
    // Packaged desktop renderers use the custom paseo:// protocol scheme.
    "paseo://app",
    // For TCP, add localhost variants
    ...(listenTarget.type === "tcp"
      ? [
          `http://${listenTarget.host}:${listenTarget.port}`,
          `http://localhost:${listenTarget.port}`,
          `http://127.0.0.1:${listenTarget.port}`,
        ]
      : []),
  ]);

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (allowedOrigins.has("*") || allowedOrigins.has(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // Local, harmless, and token-gated; deliberately skips daemon auth.
  app.post(
    "/api/terminal-activity",
    express.json(),
    createTerminalActivityRouteHandler(terminalManager),
  );

  // Serve the bundled browser web UI when enabled. Mounted after service-proxy
  // classification and host/CORS handling, but before daemon bearer auth, so
  // static app files load without the daemon password while API/WebSocket calls
  // remain protected.
  mountWebUi(app, config, logger);

  app.use(
    createRequireBearerMiddleware(config.auth, (context) => {
      logger.warn(context, "Rejected HTTP request with invalid daemon password");
    }),
  );

  app.use(express.json());

  // Serve static files from public directory
  app.use("/public", express.static(staticDir));

  // Health check endpoint
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/api/status", (_req, res) => {
    res.json({
      status: "server_info",
      serverId,
      hostname: getHostname(),
      version: daemonVersion,
      listen: formatListenTarget(boundListenTarget ?? listenTarget),
    });
  });

  const handleFileDownload = async (req: express.Request, res: express.Response): Promise<void> => {
    const token =
      typeof req.query.token === "string" && req.query.token.trim().length > 0
        ? req.query.token.trim()
        : null;

    if (!token) {
      res.status(400).json({ error: "Missing download token" });
      return;
    }

    const entry = downloadTokenStore.consumeToken(token);
    if (!entry) {
      res.status(403).json({ error: "Invalid or expired token" });
      return;
    }

    let fileHandle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      fileHandle = await open(entry.absolutePath, DOWNLOAD_OPEN_FLAGS);
      const fileStats = await fileHandle.stat();
      if (!fileStats.isFile()) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      const safeFileName = entry.fileName.replace(/["\r\n]/g, "_");
      res.setHeader("Content-Type", entry.mimeType);
      res.setHeader("Content-Disposition", `attachment; filename="${safeFileName}"`);
      res.setHeader("Content-Length", fileStats.size.toString());

      const stream = fileHandle.createReadStream();
      fileHandle = null;
      stream.on("error", (err) => {
        logger.error({ err }, "Failed to stream download");
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to read file" });
        } else {
          res.end();
        }
      });
      stream.pipe(res);
    } catch (err) {
      logger.error({ err }, "Failed to download file");
      if (!res.headersSent) {
        res.status(404).json({ error: "File not found" });
      }
    } finally {
      await fileHandle?.close().catch(() => undefined);
    }
  };

  app.get("/api/files/download", (req, res) => {
    void handleFileDownload(req, res);
  });

  const httpServer = createHTTPServer(app);

  // Script proxy WebSocket upgrade handler — must be registered before the
  // VoiceAssistantWebSocketServer attaches its own "upgrade" listener so that
  // script-bound upgrades are forwarded first. The handler is a no-op for
  // requests that don't match a registered script route.
  httpServer.on("upgrade", serviceProxy.upgradeHandler({ passthroughUnknown: true }));

  if (config.serviceProxy?.standaloneListen) {
    serviceProxyListenTarget = parseListenString(config.serviceProxy.standaloneListen);
  }

  const agentStorage = new AgentStorage(config.agentStoragePath, logger);
  const projectRegistry = new FileBackedProjectRegistry(
    path.join(config.paseoHome, "projects", "projects.json"),
    logger,
  );
  workspaceRegistry = new FileBackedWorkspaceRegistry(
    path.join(config.paseoHome, "projects", "workspaces.json"),
    logger,
  );
  const chatService = new FileBackedChatService({
    paseoHome: config.paseoHome,
    logger,
  });
  const github = createGitHubService();
  const workspaceGitService = new WorkspaceGitServiceImpl({
    logger,
    paseoHome: config.paseoHome,
    worktreesRoot: config.worktreesRoot,
    deps: {
      forgeOverrides: { github },
    },
  });
  const workspaceProvisioning = createWorkspaceProvisioningService({
    workspaceRegistry,
    projectRegistry,
    workspaceGitService,
    logger,
  });
  const providerSnapshotLogger = logger.child({ module: "provider-snapshot-manager" });
  const providerSnapshotManager = new ProviderSnapshotManager({
    logger: providerSnapshotLogger,
    runtimeSettings: config.agentProviderSettings,
    providerOverrides: config.providerOverrides,
    workspaceGitService,
    managedProcesses,
    isDev: config.isDev === true,
    extraClients: config.agentClients,
  });
  const initialAgentManagerState = providerSnapshotManager.getAgentManagerProviderState();
  const usageStatsStore = new UsageStatsStore(
    path.join(config.paseoHome, "stats", "usage"),
    logger,
  );
  // Paseo's own permanent copy of every conversation. Without it the daemon
  // would keep timelines in memory only and replay the provider's private
  // transcripts after each restart — history we neither own nor control the
  // retention of (Claude Code prunes its own after 30 days). Task cards must stay
  // readable forever, including once they reach "deployed".
  const agentTimelineArchive = new FileAgentTimelineStore({
    directory: path.join(config.paseoHome, "timelines"),
    logger,
  });
  const agentManager = new AgentManager({
    clients: initialAgentManagerState.clients,
    providerDefinitions: initialAgentManagerState.providerDefinitions,
    registry: agentStorage,
    usageStatsStore,
    durableTimelineStore: agentTimelineArchive,
    appendSystemPrompt: config.appendSystemPrompt,
    onWorkspaceStateMayHaveChanged: ({ cwd }) => {
      workspaceGitService.onWorkspaceStateMayHaveChanged(cwd);
    },
    mcpAuthToken: agentMcpAuthToken,
    logger,
  });

  const detachAgentStoragePersistence = attachAgentStoragePersistence(
    logger,
    agentManager,
    agentStorage,
  );
  // One-shot historical usage backfill from Claude Code transcripts; runs in
  // the background and is a no-op once the marker file exists.
  void runClaudeTranscriptBackfill({
    store: usageStatsStore,
    markerFilePath: path.join(config.paseoHome, "stats", "claude-backfill.json"),
    logger,
  }).catch((error) => {
    logger.warn({ err: error }, "Claude Code usage backfill failed");
  });
  await agentStorage.initialize();
  logger.info({ elapsed: elapsed() }, "Agent storage initialized");
  await bootstrapWorkspaceRegistries({
    paseoHome: config.paseoHome,
    agentStorage,
    projectRegistry,
    workspaceRegistry,
    workspaceGitService,
    logger,
  });
  logger.info({ elapsed: elapsed() }, "Workspace registries bootstrapped");
  const workspaceReconciliation = new WorkspaceReconciliationService({
    projectRegistry,
    workspaceRegistry,
    logger,
    workspaceGitService,
  });
  void (async () => {
    try {
      const result = await workspaceReconciliation.runOnce();
      logger.info(
        {
          elapsed: elapsed(),
          changeCount: result.changesApplied.length,
        },
        "Workspace registries reconciled",
      );
    } catch (error) {
      logger.error({ err: error }, "Background workspace reconciliation failed");
    }
  })();
  await chatService.initialize();
  logger.info({ elapsed: elapsed() }, "Chat service initialized");
  const checkoutDiffManager = new CheckoutDiffManager({
    logger,
    paseoHome: config.paseoHome,
    workspaceGitService,
  });
  const archiveWorkspaceRecordExternal = async (workspaceId: string) => {
    const sessions = wsServer?.listActiveSessions() ?? [];
    if (sessions.length > 0) {
      await Promise.all(
        sessions.map((session) => session.archiveWorkspaceRecordForExternalMutation(workspaceId)),
      );
      return;
    }

    await archivePersistedWorkspaceRecord({
      workspaceId,
      workspaceRegistry,
    });
  };
  // external path→workspace adapter, not ownership: archive-by-path requests that
  // arrive with a worktree path and no workspaceId (old clients / CLI).
  const findWorkspaceIdForCwdExternal = async (cwd: string): Promise<string | null> => {
    return resolveWorkspaceIdForPath(cwd, await workspaceRegistry.list());
  };
  const ensureWorkspaceForCreateExternal = async (
    cwd: string,
    firstAgentContext?: FirstAgentContext,
  ): Promise<string> => {
    // Reuse the existing workspace for this directory instead of minting a new one.
    // This path backs MCP/internal agent creation — notably the Brain memory curator,
    // which spawns an internal agent on every message. Always-creating here leaked an
    // empty duplicate workspace per interaction; one directory maps to one workspace.
    const resolvedCwd = path.resolve(cwd);
    const existing = (await workspaceRegistry.list()).find(
      (workspace) => !workspace.archivedAt && path.resolve(workspace.cwd) === resolvedCwd,
    );
    if (existing) {
      return existing.workspaceId;
    }
    const workspace = await createLocalCheckoutWorkspace(
      { cwd, title: resolveFirstAgentPromptTitle(firstAgentContext) },
      { projectRegistry, workspaceRegistry, workspaceGitService },
    );
    if (firstAgentContext) {
      workspaceAutoName.scheduleForDirectory({
        workspaceId: workspace.workspaceId,
        cwd: workspace.cwd,
        firstAgentContext,
      });
    }
    return workspace.workspaceId;
  };
  const listActiveWorkspacesExternal = async (): Promise<ActiveWorkspaceRef[]> => {
    const workspaces = await workspaceRegistry.list();
    return workspaces
      .filter((workspace) => !workspace.archivedAt)
      .map((workspace) => ({
        workspaceId: workspace.workspaceId,
        cwd: workspace.cwd,
        kind: workspace.kind,
        worktreeRoot: workspace.worktreeRoot,
        isPaseoOwnedWorktree: workspace.isPaseoOwnedWorktree,
        mainRepoRoot: workspace.mainRepoRoot,
      }));
  };
  const markWorkspaceArchivingExternal = (workspaceIds: Iterable<string>, archivingAt: string) => {
    const workspaceIdList = Array.from(workspaceIds);
    for (const session of wsServer?.listActiveSessions() ?? []) {
      session.markWorkspaceArchivingForExternalMutation(workspaceIdList, archivingAt);
    }
  };
  const clearWorkspaceArchivingExternal = (workspaceIds: Iterable<string>) => {
    const workspaceIdList = Array.from(workspaceIds);
    for (const session of wsServer?.listActiveSessions() ?? []) {
      session.clearWorkspaceArchivingForExternalMutation(workspaceIdList);
    }
  };
  const emitWorkspaceUpdatesExternal = async (workspaceIds: Iterable<string>) => {
    const workspaceIdList = Array.from(workspaceIds);
    await Promise.all(
      (wsServer?.listActiveSessions() ?? []).map((session) =>
        session.emitWorkspaceUpdatesForExternalWorkspaceIds(workspaceIdList),
      ),
    );
  };
  const ensureWorkspaceForCreateAndBroadcastExternal = async (
    cwd: string,
    firstAgentContext?: FirstAgentContext,
  ): Promise<string> => {
    const workspaceId = await ensureWorkspaceForCreateExternal(cwd, firstAgentContext);
    await emitWorkspaceUpdatesExternal([workspaceId]);
    return workspaceId;
  };
  const emitWorkspaceUpdateForCwdExternal = async (cwd: string) => {
    const workspaceIds = workspaceIdsOnCheckout(await workspaceRegistry.list(), cwd);
    await emitWorkspaceUpdatesExternal(workspaceIds);
  };
  const emitExternalSessionMessage = (message: SessionOutboundMessage) => {
    wsServer?.broadcast(wrapSessionMessage(message));
  };
  const workspaceAutoName = new WorkspaceAutoName({
    agentManager,
    workspaceRegistry,
    workspaceGitService,
    providerSnapshotManager,
    readDaemonConfig: () => ({ metadataGeneration: daemonConfigStore.get().metadataGeneration }),
    gitMutation: createGitMutationService({
      workspaceGitService,
      logger,
    }),
    emitWorkspaceUpdateForCwd: emitWorkspaceUpdateForCwdExternal,
    emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
      await emitWorkspaceUpdatesExternal([workspaceId]);
    },
    logger,
  });

  setupAutoArchiveOnMerge({
    paseoHome: config.paseoHome,
    paseoWorktreesBaseRoot: config.worktreesRoot,
    daemonConfigStore,
    workspaceGitService,
    github,
    agentManager,
    agentStorage,
    terminalManager,
    logger,
    findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
    listActiveWorkspaces: listActiveWorkspacesExternal,
    archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
    markWorkspaceArchiving: markWorkspaceArchivingExternal,
    clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
    emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
  });

  const createPaseoWorktreeForTools = async (
    input: Parameters<typeof createPaseoWorktreeWorkflow>[1],
    serviceOptions?: Parameters<typeof createPaseoWorktreeWorkflow>[2],
  ) => {
    return createPaseoWorktreeWorkflow(
      {
        paseoHome: config.paseoHome,
        worktreesRoot: config.worktreesRoot,
        createPaseoWorktree: async (workflowInput, workflowOptions) => {
          return createRegisteredPaseoWorktree(workflowInput, {
            github,
            ...(workflowOptions?.resolveDefaultBranch
              ? {
                  resolveDefaultBranch: workflowOptions.resolveDefaultBranch,
                }
              : {}),
            workspaceProvisioning,
            workspaceGitService,
          });
        },
        warmWorkspaceGitData: async (workspace) => {
          await Promise.all(
            wsServer
              ?.listActiveSessions()
              .map((session) => session.warmWorkspaceGitDataForWorkspace(workspace)) ?? [],
          );
        },
        autoNameWorkspaceBranchForFirstAgent: (autoNameInput) =>
          workspaceAutoName.scheduleForWorktree(autoNameInput),
        emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
          await emitWorkspaceUpdatesExternal([workspaceId]);
        },
        cacheWorkspaceSetupSnapshot: () => {},
        emit: emitExternalSessionMessage,
        sessionLogger: logger,
        terminalManager,
        archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
        serviceProxy,
        scriptRuntimeStore,
        getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
        getDaemonTcpHost: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null),
        serviceProxyPublicBaseUrl,
        onScriptsChanged: null,
      },
      input,
      serviceOptions,
    );
  };

  const createAgentCommandDependencies: CreateAgentCommandDependencies = {
    agentManager,
    agentStorage,
    logger,
    paseoHome: config.paseoHome,
    worktreesRoot: config.worktreesRoot,
    terminalManager,
    providerSnapshotManager,
    createPaseoWorktree: createPaseoWorktreeForTools,
    ensureWorkspaceForCreate: ensureWorkspaceForCreateAndBroadcastExternal,
  };
  const createAgent = (input: Parameters<typeof createAgentCommand>[1]) =>
    createAgentCommand(createAgentCommandDependencies, input);
  const projectPromptSync = new ProjectPromptSyncService({
    paseoHome: config.paseoHome,
    projectRegistry,
    workspaceRegistry,
    workspaceGitService,
    logger,
  });
  await projectPromptSync.start();
  agentManager.setDaemonAppendSystemPromptResolver(({ agentId, config: agentConfig }) =>
    projectPromptSync.getDaemonAppendSystemPrompt({
      agentId,
      cwd: agentConfig.cwd,
    }),
  );
  agentManager.setProjectPromptHook(({ agentId, cwd, text }) =>
    projectPromptSync.augmentPrompt({ agentId, cwd, text }),
  );
  const loopService = new LoopService({
    paseoHome: config.paseoHome,
    logger,
    agentManager,
    createAgent,
    ensureWorkspaceForCreate: ensureWorkspaceForCreateAndBroadcastExternal,
  });
  await loopService.initialize();
  logger.info({ elapsed: elapsed() }, "Loop service initialized");
  const createScheduleLocalWorkspaceExternal = async (input: {
    cwd: string;
    firstAgentContext: FirstAgentContext;
  }) => {
    const workspace = await createLocalCheckoutWorkspace(
      { cwd: input.cwd, title: resolveFirstAgentPromptTitle(input.firstAgentContext) },
      { projectRegistry, workspaceRegistry, workspaceGitService },
    );
    workspaceAutoName.scheduleForDirectory({
      workspaceId: workspace.workspaceId,
      cwd: workspace.cwd,
      firstAgentContext: input.firstAgentContext,
    });
    await emitWorkspaceUpdatesExternal([workspace.workspaceId]);
    return workspace;
  };
  const createSchedulePaseoWorktreeExternal = async (input: {
    cwd: string;
    firstAgentContext: FirstAgentContext;
  }) => {
    const result = await createPaseoWorktreeForTools({
      cwd: input.cwd,
      firstAgentContext: input.firstAgentContext,
    });
    await emitWorkspaceUpdatesExternal([result.workspace.workspaceId]);
    return result;
  };
  const archiveScheduleWorkspaceExternal = async (workspaceId: string) => {
    await archiveByScope(
      {
        paseoHome: config.paseoHome,
        paseoWorktreesBaseRoot: config.worktreesRoot,
        github,
        workspaceGitService,
        agentManager,
        agentStorage,
        findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
        listActiveWorkspaces: listActiveWorkspacesExternal,
        archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
        emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
        markWorkspaceArchiving: markWorkspaceArchivingExternal,
        clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
        killTerminalsForWorkspace: (workspaceIdToKill) =>
          killTerminalsForWorkspace(
            {
              terminalManager,
              sessionLogger: logger,
            },
            workspaceIdToKill,
          ),
        sessionLogger: logger,
      },
      {
        scope: { kind: "workspace", workspaceId },
        requestId: "schedule-run-finish",
      },
    );
  };
  // MÉMOIRE LONGUE DURÉE (« Cerveau ») — RETIRÉE.
  // Chaque prompt de chaque agent interrogeait ici un service externe, repartait
  // avec un bloc de souvenirs collé devant, et déclenchait à la fin du tour un
  // second agent (le « greffier ») qui distillait la conversation. Soit, à chaque
  // message : deux appels de modèle supplémentaires et quelques milliers de
  // jetons de contexte, pour un gain marginal. Tout ce câblage est supprimé ; la
  // configuration `brainMemory` reste acceptée dans le fichier de config (elle
  // existe chez les utilisateurs) mais n'a plus aucun effet.
  const scheduleService = new ScheduleService({
    paseoHome: config.paseoHome,
    logger,
    agentManager,
    agentStorage,
    createAgent,
    createDirectoryWorkspace: createScheduleLocalWorkspaceExternal,
    createPaseoWorktreeWorkspace: createSchedulePaseoWorktreeExternal,
    archiveWorkspace: archiveScheduleWorkspaceExternal,
  });
  await scheduleService.start();
  agentManager.setAgentArchivedCallback(async (agentId) => {
    try {
      await scheduleService.completeForAgent(agentId);
    } catch (error) {
      logger.warn({ err: error, agentId }, "Failed to complete schedules for archived agent");
    }
  });
  logger.info({ elapsed: elapsed() }, "Schedule service initialized");
  const providerUsageService = new ProviderUsageService({ logger });
  // The watcher polls every minute and shares this one service on purpose: a private
  // instance had its own cache *and* its own rate-limit cooldown, so a provider that had
  // just told the daemon to back off kept being called anyway, once a minute, forever.
  const quotaResetWatcher = new QuotaResetWatcher({ agentManager, logger, providerUsageService });
  quotaResetWatcher.start();
  downloadArchiveCleaner.start();
  const taskBoardStore = new TaskBoardStore(path.join(config.paseoHome, "tasks"));
  const taskBoardService = new TaskBoardService({ store: taskBoardStore, logger });
  // A card that reaches "Terminée" tells the user, before they publish, whether
  // the work will only take effect after a daemon restart.
  taskBoardService.setRestartImpactResolver(async (projectId) => {
    const project = await projectRegistry.get(projectId);
    return resolveDaemonRestartImpact(project?.rootPath ?? null);
  });
  // An archived card closes its own conversation, so its tab leaves the band on
  // every connected client (see tasks/session-closer.ts).
  const taskSessionCloser = new TaskSessionCloser({
    agentManager,
    agentStorage,
    terminals: {
      takeForAgent: (agentId) => agentTerminalRegistry.takeForAgent(agentId),
      getActivityState: (terminalId) => {
        const terminal = terminalManager.getTerminal(terminalId);
        if (!terminal) {
          return null;
        }
        // No activity record yet means nothing has run in it: safe to close.
        return terminal.getActivity()?.state ?? "idle";
      },
      killTerminal: async (terminalId) => {
        await terminalManager.killTerminalAndWait(terminalId, {
          gracefulTimeoutMs: 2000,
          forceTimeoutMs: 1500,
        });
        agentTerminalRegistry.forget(terminalId);
      },
    },
    logger,
  });
  taskBoardService.setOnTaskArchived((projectId, task) =>
    taskSessionCloser.closeSessionsForTask(projectId, task),
  );
  // This process is running the current code, so every already-published card's
  // restart debt is settled. Done once at boot, per known project.
  void (async () => {
    try {
      for (const project of await projectRegistry.list()) {
        // Must run BEFORE anything reads the publication queue: it is what tells
        // the cards that were "Déployé" under the old meaning apart from the ones
        // genuinely waiting to go out.
        await taskBoardService.backfillLegacyDeployedCards(project.projectId);
        await taskBoardService.settleRestartFlags(project.projectId);
        // A publication frozen on "running" whose in-memory watcher died with the
        // previous process would otherwise spin forever: settle it to a failure so
        // the "Réinitialiser / Relancer" escape hatch appears.
        await taskBoardService.reconcileOrphanDeployBatch(project.projectId, () =>
          getPublishedSha(),
        );
        // Catch-up for the tabs that piled up before archiving closed anything.
        // Isolated: tidying tabs is cosmetic, and letting it throw here would
        // skip the restart-debt backfill of every project after this one.
        try {
          await taskSessionCloser.sweepArchivedTasks(
            project.projectId,
            await taskBoardService.getBoard(project.projectId),
          );
        } catch (error) {
          logger.warn(
            { err: error, projectId: project.projectId },
            "Failed to close the sessions of already-archived cards at boot",
          );
        }
      }
    } catch (error) {
      logger.warn({ err: error }, "Failed to settle daemon-restart flags at boot");
    }
  })();
  const conflictTaskCreationInFlight = new Set<string>();
  setPaseoDeployConflictTaskCreator(async ({ projectId, branch, worktreePath, reason }) => {
    // Automatic repair worktrees are implementation details. They must never
    // become inputs to another repair cycle.
    if (isPaseoDeployRepairBranch(branch)) {
      return;
    }
    const branchTag = `${PASEO_DEPLOY_BRANCH_TAG_PREFIX}${branch}`;
    if (conflictTaskCreationInFlight.has(branch)) return;
    conflictTaskCreationInFlight.add(branch);
    try {
      const folderId = await taskBoardService.ensureFolder(projectId, "Réparations de déploiement");
      const board = await taskBoardService.getBoard(projectId);
      const alreadyQueued = board.tasks.some(
        (task) =>
          task.tags.includes(PASEO_DEPLOY_CONFLICT_TAG) &&
          task.tags.includes(branchTag) &&
          task.column !== "done" &&
          task.column !== "deployed",
      );
      if (alreadyQueued) return;
      const completedRepair = board.tasks.find(
        (task) =>
          task.tags.includes(PASEO_DEPLOY_CONFLICT_TAG) &&
          task.tags.includes(branchTag) &&
          task.column === "done",
      );
      if (completedRepair) {
        await taskBoardService.patchTask(projectId, completedRepair.id, (current) => {
          const { completedAt: _completedAt, deployedAt: _deployedAt, ...reopened } = current;
          return {
            ...reopened,
            column: "validated",
            schedule: {
              state: current.estimate ? ("awaiting_slot" as const) : ("pending_estimate" as const),
              attempts: 0,
            },
          };
        });
        logger.info(
          { projectId, taskId: completedRepair.id, branch },
          "Reopened existing deploy repair instead of creating a duplicate task",
        );
        return;
      }
      const usage = await providerUsageService.listUsage({ forceRefresh: true });
      const claude = usage.providers.find((provider) => provider.providerId === "claude");
      const useCodex = !claude || isProviderUsageExhausted(claude);
      const repair = await taskBoardService.createTask(projectId, {
        folderId,
        title: `Réparer le conflit avant publication : ${branch}`,
        description: [
          "Cette tâche a été ouverte automatiquement par la fenêtre « À déployer ».",
          `Branche à réparer : ${branch}`,
          worktreePath
            ? `Atelier cible : ${worktreePath}`
            : "L'atelier cible n'a pas pu être retrouvé ; commence par le localiser.",
          `Constat : ${reason}`,
          "Travaille sur l'atelier cible, pas sur ton atelier temporaire : synchronise-le avec /root/paseo, résous les conflits, enregistre les changements, puis vérifie que la branche peut être fusionnée.",
          "Ne publie pas toi-même. Quand la branche est propre et fusionnable, termine la tâche : le mécanisme relancera automatiquement la publication.",
        ].join("\n"),
        tags: [PASEO_DEPLOY_CONFLICT_TAG, branchTag],
        runConfig: useCodex
          ? { provider: "codex", model: "gpt-5.4", mode: "direct" }
          : { provider: "claude", model: "claude-opus-4-8", mode: "direct" },
        schedulePreference: "asap",
        // Let the scheduler perform the same fresh quota check before the
        // first agent is created. Launching here could briefly start Claude
        // before the fallback switched the task to Codex.
        launch: false,
      });
      // The ONLY column move the daemon makes on the user's behalf, and the one
      // exception to "validation is manual": the user just clicked "Publier",
      // the publish is blocked on this conflict, and the repair exists purely to
      // unblock that click. Every other card waits in "À faire" for a human.
      // createTask always pins "backlog", so the move has to be explicit here.
      await taskBoardService.transitionTask(projectId, repair.id, "validated");
    } finally {
      conflictTaskCreationInFlight.delete(branch);
    }
  });
  const agentTaskSync = new AgentTaskSyncService({
    agentManager,
    workspaceRegistry,
    taskBoardService,
    logger,
  });
  agentTaskSync.start();
  // A card agent's answer structure follows the card's column: analysis in
  // "Validé", work report in "En cours", publication log in "Déployé". Resolved
  // at dispatch time, at the same choke point as the Cerveau recall.
  agentManager.setResponseFormatTemplateHook(
    createTaskResponseTemplateHook({
      agentManager,
      workspaceRegistry,
      taskBoardService,
      logger,
    }),
  );
  const activityLogService = new ActivityLogService({
    agentManager,
    agentStorage,
    workspaceRegistry,
    projectRegistry,
    paseoHome: config.paseoHome,
    logger,
  });
  activityLogService.start();
  // One agent per card, attached at birth and shared by every later phase.
  const taskAgentProvisioner = new TaskAgentProvisioner({
    createAgent,
    taskBoardService,
    projectRegistry,
    logger,
  });
  const taskEstimator = new TaskEstimator({
    agentManager,
    agentProvisioner: taskAgentProvisioner,
    taskBoardService,
    projectRegistry,
    logger,
  });
  // "Terminer la tâche": a plain move from "En cours" to "Terminé". No prompt, no
  // agent, no deployment — verification happens at publication time instead.
  const taskValidator = new TaskValidator({ taskBoardService, logger });
  // "Lancer le déploiement": the verify-then-publish action for a FINISHED card.
  // It hands the card's own agent a deploy-then-confirm prompt and lets it move
  // the card to "Déployée" while reporting whether a daemon restart is needed.
  const taskDeployer = new TaskDeployer({
    taskBoardService,
    projectRegistry,
    sendPrompt: async ({ agentId, prompt }) => {
      await sendPromptToAgent({ agentManager, agentStorage, agentId, prompt, logger });
    },
    watchAgentIdle: (agentId, onIdle) => watchAgentIdle(agentManager, agentId, onIdle),
    logger,
  });
  // The card's git journey (branch → commit → envoi → fusion → publication).
  // One tracker, shared by everything that knows a step: the scheduler when a
  // run ends, the batch publication for merge and mise en ligne.
  const taskGitTracker = new TaskGitTracker({
    taskBoardService,
    exec: {
      git: async (args, cwd) => {
        try {
          // Exit 1 is data here (an unknown ref, an empty result), never a crash.
          const result = await runGitCommand(args, { cwd, acceptExitCodes: [0, 1] });
          return { exitCode: result.exitCode ?? 0, stdout: result.stdout, stderr: result.stderr };
        } catch (error) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
          };
        }
      },
    },
    resolveRootPath: async (projectId) => (await projectRegistry.get(projectId))?.rootPath ?? null,
    logger,
  });
  const taskScheduler = new TaskScheduler({
    taskBoardService,
    taskEstimator,
    projectRegistry,
    agentManager,
    createAgent,
    providerUsageService,
    refreshTaskGit: (projectId, task) => taskGitTracker.refresh(projectId, task),
    logger,
    getQuietHours: () => daemonConfigStore.get().tasks?.quietHours ?? DEFAULT_TASKS_QUIET_HOURS,
  });
  taskBoardService.setOnTaskScheduled((projectId, taskId) => {
    taskEstimator.requestEstimate(projectId, taskId);
  });
  // A card gets its agent the moment it exists, so its conversation starts at
  // second zero and holds every later prompt, reply and check.
  taskBoardService.setOnTaskCreated((projectId, task) => {
    taskAgentProvisioner.ensureInBackground(projectId, task.id);
  });
  // Finishing a card STOPS it in "Terminé": it rests there and says so in its own
  // conversation. Nothing moves and nothing goes online until the user queues it
  // into "À déployer" and presses "Tout déployer" — with one exception, the
  // "Terminer et mettre en file" press, which arms the card to continue on its
  // own (queueForDeployment below).
  const taskPublisher = new TaskPublisher({
    agentManager,
    logger,
    queueForDeployment: async (projectId, taskId) => {
      await taskBoardService.transitionTask(projectId, taskId, "deployed");
    },
    clearQueueOnComplete: async (projectId, taskId) => {
      await taskBoardService.patchTask(projectId, taskId, (current) => ({
        ...current,
        queueOnComplete: false,
      }));
    },
  });
  // Central publisher for an ORDINARY project's dev instance. A plain process
  // that commits the lot card by card, restarts the project's service once and
  // verifies it live — never throwing on a non-zero exit, so the runner can
  // branch on it (a "nothing to commit" is a skip, not a crash).
  const projectDeployExec: ProjectDeployExec = {
    git: async (args, cwd) => {
      try {
        // Accept exit 1 without throwing: `git diff --cached --quiet` uses it to
        // report "there ARE staged changes", which the runner reads as data.
        const result = await runGitCommand(args, { cwd, acceptExitCodes: [0, 1] });
        return { exitCode: result.exitCode ?? 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    },
    exec: async (command, cmdArgs) => {
      try {
        const { stdout, stderr } = await execCommand(command, cmdArgs, { timeout: 60_000 });
        return { exitCode: 0, stdout, stderr };
      } catch (error) {
        const err = error as { code?: number; stdout?: string; stderr?: string; message?: string };
        return {
          exitCode: typeof err.code === "number" ? err.code : 1,
          stdout: err.stdout ?? "",
          stderr: err.stderr ?? err.message ?? "",
        };
      }
    },
  };
  const projectDeployer = new ProjectDeployer({ exec: projectDeployExec, logger });
  // "Tout déployer": one publication for the whole queue, then the service
  // restart. Paseo's own batch goes through the local build script
  // (triggerDeploy — a plain process, no model, no quota); any other project now
  // goes through the SAME kind of central actor (projectDeployer), instead of
  // each card's own agent.
  const taskBatchDeployer = new TaskBatchDeployer({
    taskBoardService,
    projectRegistry,
    agentManager,
    isSelfHostRoot: (rootPath) => isPaseoDeployRoot(rootPath),
    resolveProjectUrl: async (rootPath) =>
      isPaseoDeployRoot(rootPath) ? getPaseoAppUrl() : await resolveProjectDevInstanceUrl(rootPath),
    triggerDeploy: (input) => triggerPaseoDeploy(input),
    readDeployRun: () => getPaseoDeployRunSnapshot(),
    readPublishedSha: () => getPublishedSha(),
    readHeadSha: () => getHeadSha(),
    // Lets the batch skip its final restart when the engine is already executing
    // the version that just went online (a republish with no new commit).
    readRunningEngineSha: () => getRunningEngineSha(),
    // Et lui laisse aussi sauter le redémarrage quand la publication n'a
    // reconstruit que le site : aucun `dist` moteur installé, donc rien à
    // recharger — inutile de couper les sessions de tout le monde.
    readDaemonRestartPending: () => isDaemonRestartPending(),
    deployTask: (projectId, taskId) => taskDeployer.deploy(projectId, taskId),
    refreshTaskGit: (projectId, task) => taskGitTracker.refresh(projectId, task),
    // Ordinary projects publish centrally too: resolve the dev instance, then let
    // the single actor commit-per-card, restart the service once and verify it.
    triggerProjectDeploy: async ({ rootPath, cards }) => {
      const target = await resolveProjectDevInstanceTarget(rootPath);
      if (!target) {
        return {
          started: false,
          error:
            "Ce projet n'a pas d'instance de développement sur le serveur : rien à publier automatiquement.",
        };
      }
      return projectDeployer.trigger({ rootPath, slug: target.slug, url: target.url, cards });
    },
    readProjectDeployRun: async (rootPath) => projectDeployer.readRun(rootPath),
    // The user's press IS the authorization: the batch ends by restarting the
    // engine so the code that was just published is the code that runs.
    requestDaemonRestart: (reason) => {
      config.onLifecycleIntent?.({
        type: "restart",
        clientId: "task-batch-deploy",
        requestId: `batch-deploy-${Date.now()}`,
        reason,
      });
    },
    logger,
  });
  // Finishing a card no longer publishes it, and no longer queues it either: it
  // STOPS in "Terminée". The card rests there so the user sees the finished work
  // land, then moves it into "À déployer" with an explicit press when ready. That
  // last column still batches: the user's "Tout déployer" publishes the whole
  // queue in one run and restarts the daemon (see TaskBatchDeployer). One run per
  // batch instead of one per card is the whole point — concurrent per-card builds
  // on the shared checkout produced torn bundles. A deploy-conflict repair card
  // keeps its own express lane: the publication it unblocks is already waiting on
  // it, so it deploys straight away rather than resting in "Terminée".
  // "Publier automatiquement en heures creuses": opt-in twin of the button. Off
  // unless the user turns it on, in which case the same batch (and the same
  // closing restart) fires inside the quiet-hours window.
  const autoDeployWatcher = new AutoDeployWatcher({
    taskBoardService,
    taskBatchDeployer,
    projectRegistry,
    getSettings: () => ({
      enabled: daemonConfigStore.get().tasks?.autoDeployOffPeak === true,
      quietHours: daemonConfigStore.get().tasks?.quietHours ?? DEFAULT_TASKS_QUIET_HOURS,
    }),
    logger,
  });
  autoDeployWatcher.start();
  taskBoardService.setOnTaskCompleted(async (projectId, task) => {
    const repairBranch = task.tags.includes(PASEO_DEPLOY_CONFLICT_TAG)
      ? task.tags
          .find((tag) => tag.startsWith(PASEO_DEPLOY_BRANCH_TAG_PREFIX))
          ?.slice(PASEO_DEPLOY_BRANCH_TAG_PREFIX.length)
      : undefined;
    if (repairBranch) {
      const result = await triggerPaseoDeploy({ projectId, mergeBranches: [repairBranch] });
      if (!result.started) {
        logger.warn(
          { projectId, branch: repairBranch, error: result.error },
          "Automatic repaired-branch deploy did not start",
        );
      }
      return;
    }
    await taskPublisher.announceReady(projectId, task);
  });
  // Auto-move: when a publish goes live, promote the shipped task branches' done
  // cards into the terminal "deployed" column across every project's board.
  setPaseoDeploySuccessListener((event) => {
    const branches = event.mergedBranches.length > 0 ? new Set(event.mergedBranches) : null;
    if (branches === null) {
      return;
    }
    void (async () => {
      try {
        const projects = await projectRegistry.list();
        for (const project of projects) {
          if (project.archivedAt) {
            continue;
          }
          await taskBoardService.promoteDoneTasksToDeployed({
            projectId: project.projectId,
            branches,
          });
        }
      } catch (error) {
        logger.warn({ err: error }, "Auto-promotion of deployed tasks failed");
      }
    })();
  });
  // Rebound to the live websocket server once it exists (see setTasksServices site).
  let taskProposalPush: ((payload: PushPayload, context?: PushHistoryContext) => void) | null =
    null;
  const taskProposalNotifier = new TaskProposalNotifier({
    serverId,
    getProjectName: async (projectId) => {
      const project = await projectRegistry.get(projectId);
      return project ? resolveProjectDisplayName(project) : null;
    },
    sendPush: (payload, context) => taskProposalPush?.(payload, context),
    logger,
  });
  taskBoardService.setOnTaskProposed((projectId) => {
    taskProposalNotifier.notifyProposed(projectId);
  });
  // Published work that stays dormant because nobody restarted the daemon is
  // invisible by definition — the card says "Déployé" and nothing has changed.
  // This nudges the user once, hours later, if the restart never came. It only
  // ever notifies: restarting stays the user's explicit call.
  const daemonRestartReminder = new DaemonRestartReminder({
    sendPush: (payload) => taskProposalPush?.(payload),
    logger,
  });
  daemonRestartReminder.start();
  // Inline task-intent triage (opt-in): interprets chat messages that ask for
  // tasks and proposes them (awaiting approval) or asks clarifying questions.
  const messageTriage = config.messageTriage?.enabled
    ? new MessageTriage({
        agentManager,
        createAgent,
        taskBoardService,
        providerModel: config.messageTriage.providerModel,
        resolveProjectId: async (agentId) => {
          const agent = await agentStorage.get(agentId);
          if (!agent?.workspaceId) {
            return null;
          }
          const workspace = await workspaceRegistry.get(agent.workspaceId);
          return workspace?.projectId ?? null;
        },
        resolveProjectCwd: async (projectId) => {
          const project = await projectRegistry.get(projectId);
          return project?.rootPath ?? null;
        },
        logger,
      })
    : null;
  // Compteur de consommation par carte : additionne sur la carte ce que ses
  // agents dépensent réellement. Branché sur le flux de deltas des statistiques
  // d'usage — le seul endroit où les compteurs cumulés des fournisseurs sont
  // déjà transformés en écarts additionnables.
  const taskUsageRecorder = new TaskUsageRecorder({
    taskBoardService,
    resolveProjectId: async (agentId) => {
      const agent = await agentStorage.get(agentId);
      if (!agent?.workspaceId) {
        return null;
      }
      const workspace = await workspaceRegistry.get(agent.workspaceId);
      return workspace?.projectId ?? null;
    },
    logger,
  });
  agentManager.getUsageStatsStore()?.setDeltaListener((delta) => taskUsageRecorder.note(delta));
  // Persistent per-project "Chef d'orchestre" agent: manages the board via the
  // paseo task tools and survives restarts (persisted, discovered by label).
  const conductorService = new ConductorAgentService({
    createAgent,
    agentStorage,
    projectRegistry,
    logger,
  });
  taskScheduler.start();
  logger.info({ elapsed: elapsed() }, "Task board services initialized");
  logger.info({ elapsed: elapsed() }, "Loading persisted agent registry");
  const persistedRecords = await agentStorage.list();
  logger.info(
    { elapsed: elapsed() },
    `Agent registry loaded (${persistedRecords.length} record${persistedRecords.length === 1 ? "" : "s"}); agents will initialize on demand`,
  );
  logger.info(
    "Voice mode configured for agent-scoped resume flow (no dedicated voice assistant provider)",
  );
  logger.info({ elapsed: elapsed() }, "Preparing voice and MCP runtime");

  const createAgentToolHostDependencies = (
    runtime: PaseoToolRuntimeContext,
  ): PaseoToolHostDependencies => ({
    agentManager,
    agentStorage,
    terminalManager,
    getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
    scheduleService,
    providerSnapshotManager,
    github,
    workspaceGitService,
    findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
    listActiveWorkspaces: listActiveWorkspacesExternal,
    archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
    emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
    workspaceRegistry,
    markWorkspaceArchiving: markWorkspaceArchivingExternal,
    clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
    ensureWorkspaceForCreate: createAgentCommandDependencies.ensureWorkspaceForCreate,
    createPaseoWorktree: createAgentCommandDependencies.createPaseoWorktree,
    browserToolsEnabled: browserToolsPolicy.isEnabled(),
    browserToolsBroker,
    paseoHome: config.paseoHome,
    worktreesRoot: config.worktreesRoot,
    callerAgentId: runtime.callerAgentId,
    onAgentTerminalCreated: ({ agentId, terminalId }) =>
      agentTerminalRegistry.record(agentId, terminalId),
    enableVoiceTools: runtime.enableVoiceTools,
    voiceOnly: runtime.voiceOnly,
    taskBoardService,
    projectRegistry,
    downloadArchiveStore,
    resolveSpeakHandler: (agentId) => wsServer?.resolveVoiceSpeakHandler(agentId) ?? null,
    resolveCallerContext: (agentId) => wsServer?.resolveVoiceCallerContext(agentId) ?? null,
    logger,
  });
  const createAgentToolCatalog = (runtime: PaseoToolRuntimeContext) =>
    createPaseoToolCatalog(createAgentToolHostDependencies(runtime));
  agentManager.setPaseoToolCatalogFactory(createAgentToolCatalog);
  agentManager.setPaseoToolsEnabled(config.mcpInjectIntoAgents !== false);

  const mcpEnabled = config.mcpEnabled ?? true;
  let agentMcpBaseUrl: string | null = null;
  if (mcpEnabled) {
    const agentMcpRoute = "/mcp/agents";

    const createAgentMcpSession = async (callerAgentId?: string) => {
      const agentMcpServer = await createAgentMcpServer(
        createAgentToolHostDependencies({ callerAgentId }),
      );

      // Stateless mode: each HTTP request builds a fresh server + transport that is
      // torn down when the response closes, so no per-session state is retained between
      // requests. The agent control plane only lists and calls tools, neither of which
      // needs cross-request state, so sessions would only pin memory for the life of the
      // daemon (agents that exit without a clean DELETE never get reaped).
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        // NOTE: We enforce a Vite-like host allowlist at the app/websocket layer.
        // StreamableHTTPServerTransport's built-in check requires exact Host header matches.
        enableDnsRebindingProtection: false,
      });
      Object.assign(transport, {
        onerror: (err: Error) => {
          logger.error({ err }, "Agent MCP transport error");
        },
      });

      await agentMcpServer.connect(transport);
      return { server: agentMcpServer, transport };
    };

    const runAgentMcpRequest = async (
      req: express.Request,
      res: express.Response,
    ): Promise<void> => {
      // This route is exempt from the global daemon-password middleware, so it
      // authenticates here using the injected capability token (or a valid
      // daemon password). Without this, a password-protected daemon would be
      // wide open on its agent control plane.
      if (
        !(await isAgentMcpRequestAuthorized({
          password: config.auth?.password,
          capabilityToken: agentMcpAuthToken,
          authorizationHeader: req.header("authorization"),
        }))
      ) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      if (config.mcpDebug) {
        logger.debug(
          {
            method: req.method,
            url: req.originalUrl,
            sessionId: req.header("mcp-session-id"),
            authorization: req.header("authorization") ? REDACTED_LOG_VALUE : undefined,
            body: summarizeAgentMcpDebugBody(req.body),
          },
          "Agent MCP request",
        );
      }
      try {
        // Stateless: GET (standalone SSE) and DELETE (session termination) have no
        // meaning without sessions. The MCP client tolerates 405 on the GET stream
        // and never issues a DELETE because it is never handed a session id.
        if (req.method !== "POST") {
          res.status(405).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Method not allowed",
            },
            id: null,
          });
          return;
        }
        const callerAgentIdRaw = req.query.callerAgentId;
        let callerAgentId: string | undefined;
        if (typeof callerAgentIdRaw === "string") {
          callerAgentId = callerAgentIdRaw;
        } else if (Array.isArray(callerAgentIdRaw) && typeof callerAgentIdRaw[0] === "string") {
          callerAgentId = callerAgentIdRaw[0];
        }
        const { server, transport } = await createAgentMcpSession(callerAgentId);
        res.on("close", () => {
          void transport.close();
          void server.close();
        });

        await transport.handleRequest(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
          req.body,
        );
      } catch (err) {
        logger.error({ err }, "Failed to handle Agent MCP request");
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal MCP server error",
            },
            id: null,
          });
        }
      }
    };

    const handleAgentMcpRequest: express.RequestHandler = (req, res) => {
      void runAgentMcpRequest(req, res);
    };

    app.post(agentMcpRoute, handleAgentMcpRequest);
    app.get(agentMcpRoute, handleAgentMcpRequest);
    app.delete(agentMcpRoute, handleAgentMcpRequest);
    logger.info({ route: agentMcpRoute }, "Agent MCP server mounted on main app");
  } else {
    logger.info("Agent MCP HTTP endpoint disabled");
  }

  const speechService = createSpeechService({
    logger,
    openaiConfig: config.openai,
    speechConfig: config.speech,
  });
  logger.info({ elapsed: elapsed() }, "Speech service created");

  logger.info({ elapsed: elapsed() }, "Bootstrap complete, ready to start listening");

  const start = async () => {
    let mainStarted = false;
    try {
      if (serviceProxyListenTarget) {
        const boundServiceProxyTarget = await serviceProxy.startStandalone({
          listenTarget: serviceProxyListenTarget,
        });
        serviceProxyListenTarget = boundServiceProxyTarget;
        logger.info(
          {
            listen: formatListenTarget(serviceProxyListenTarget),
            publicBaseUrl: serviceProxyPublicBaseUrl,
            elapsed: elapsed(),
          },
          "Service proxy listening",
        );
      }

      // Start main HTTP server
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          httpServer.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          httpServer.off("error", onError);
          mainStarted = true;
          const logAndResolve = async () => {
            boundListenTarget = resolveBoundListenTarget(listenTarget, httpServer);
            const mcpBaseUrl = mcpEnabled ? createAgentMcpBaseUrl(boundListenTarget) : null;
            agentMcpBaseUrl = config.mcpInjectIntoAgents === false ? null : mcpBaseUrl;
            agentManager.setMcpBaseUrl(agentMcpBaseUrl);
            agentManager.setPaseoToolsEnabled(config.mcpInjectIntoAgents !== false);
            daemonConfigStore.onFieldChange("mcp.injectIntoAgents", (value) => {
              agentManager.setMcpBaseUrl(value ? mcpBaseUrl : null);
              agentManager.setPaseoToolsEnabled(value !== false);
            });
            daemonConfigStore.onFieldChange("appendSystemPrompt", (value) => {
              agentManager.setAppendSystemPrompt(typeof value === "string" ? value : "");
            });
            const relayEnabled = config.relayEnabled ?? true;
            const relayEndpoint = config.relayEndpoint ?? "relay.paseo.sh:443";
            const relayPublicEndpoint = config.relayPublicEndpoint ?? relayEndpoint;
            const relayUseTls = config.relayUseTls ?? relayEndpoint === "relay.paseo.sh:443";
            const relayPublicUseTls = config.relayPublicUseTls ?? relayUseTls;
            const appBaseUrl = config.appBaseUrl ?? "https://app.paseo.sh";

            if (boundListenTarget.type === "tcp") {
              logger.info(
                {
                  host: boundListenTarget.host,
                  port: boundListenTarget.port,
                  authRequired: !!config.auth?.password,
                  elapsed: elapsed(),
                },
                `Server listening on http://${boundListenTarget.host}:${boundListenTarget.port}`,
              );
            } else {
              logger.info(
                {
                  path: boundListenTarget.path,
                  authRequired: !!config.auth?.password,
                  elapsed: elapsed(),
                },
                `Server listening on ${boundListenTarget.path}`,
              );
            }
            if (config.auth?.password) {
              logger.info("Daemon password authentication enabled");
            }

            wsServer = new VoiceAssistantWebSocketServer(
              httpServer,
              logger,
              serverId,
              agentManager,
              agentStorage,
              downloadTokenStore,
              config.paseoHome,
              daemonConfigStore,
              mcpBaseUrl,
              { allowedOrigins, hostnames: configuredHostnames },
              workspaceAutoName,
              config.auth,
              speechService,
              terminalManager,
              {
                finalTimeoutMs: config.dictationFinalTimeoutMs,
              },
              daemonVersion,
              (intent) => {
                try {
                  config.onLifecycleIntent?.(intent);
                } catch (error) {
                  logger.error({ err: error, intent }, "Failed to handle daemon lifecycle intent");
                }
              },
              projectRegistry,
              workspaceRegistry,
              chatService,
              loopService,
              scheduleService,
              checkoutDiffManager,
              serviceProxy,
              scriptRuntimeStore,
              handleBranchChange,
              () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
              () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null),
              (hostname) => scriptHealthMonitor.getHealthForHostname(hostname),
              workspaceGitService,
              github,
              config.pushNotificationSender,
              providerSnapshotManager,
              {
                listen: formatListenTarget(boundListenTarget ?? listenTarget),
                worktreesRoot: config.worktreesRoot,
                appBaseUrl: config.appBaseUrl,
                relay: {
                  enabled: relayEnabled,
                  endpoint: relayEndpoint,
                  publicEndpoint: relayPublicEndpoint,
                  useTls: relayUseTls,
                  publicUseTls: relayPublicUseTls,
                },
              },
              serviceProxyPublicBaseUrl,
              browserToolsBroker,
              projectPromptSync,
            );
            wsServer.setTasksServices({
              taskBoardService,
              taskEstimator,
              taskScheduler,
              conductorService,
              taskValidator,
              taskDeployer,
              taskBatchDeployer,
              messageTriage,
            });
            wsServer.setActivityLogService(activityLogService);
            {
              // Dashboard accounting summary — enabled only when the machine
              // holds a compta API key (env var or ~/.config/compta/api-key).
              // The same service also backs the billing write feature (project→
              // client linking, add task to a document) when the certified CLI
              // is present on the host.
              const comptaSummaryService = ComptaSummaryService.fromEnvironment(logger);
              if (comptaSummaryService) {
                wsServer.setComptaSummaryService(comptaSummaryService);
                wsServer.setComptaLinksStore(
                  new ComptaLinksStore({ paseoHome: config.paseoHome, logger }),
                );
              }
            }
            {
              const boundWsServer = wsServer;
              taskProposalPush = (payload, context) => boundWsServer.sendPush(payload, context);
            }

            if (relayEnabled) {
              const offer = await createConnectionOfferV2({
                serverId,
                daemonPublicKeyB64: daemonKeyPair.publicKeyB64,
                relay: {
                  endpoint: relayPublicEndpoint,
                  useTls: relayPublicUseTls,
                },
              });

              encodeOfferToFragmentUrl({ offer, appBaseUrl });

              relayTransport?.stop().catch(() => undefined);
              relayTransport = startRelayTransport({
                logger,
                attachSocket: (ws, metadata) => {
                  if (!wsServer) {
                    throw new Error("WebSocket server not initialized");
                  }
                  return wsServer.attachExternalSocket(ws, metadata);
                },
                relayEndpoint,
                relayUseTls,
                serverId,
                daemonKeyPair: daemonKeyPair.keyPair,
              });
            }
          };

          logAndResolve().then(resolve, reject);
        };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);

        if (listenTarget.type === "tcp") {
          httpServer.listen(listenTarget.port, listenTarget.host);
        } else {
          if (listenTarget.type === "socket" && existsSync(listenTarget.path)) {
            unlinkSync(listenTarget.path);
          }
          httpServer.listen(listenTarget.path);
        }
      });

      // Start speech service after listening so synchronous Sherpa native
      // model loading doesn't block the server from accepting connections.
      speechService.start();
      scriptHealthMonitor.start();
    } catch (error) {
      await serviceProxy.stopStandalone().catch(() => undefined);
      if (mainStarted) {
        httpServer.closeAllConnections();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
      throw error;
    }
  };

  const stop = async () => {
    scriptHealthMonitor.stop();
    // Freeze both ingress and registration before taking the agent closure snapshot.
    wsServer?.prepareForShutdown();
    agentManager.prepareForShutdown();
    await closeAllAgents(logger, agentManager);
    await agentManager.flushForShutdown().catch(() => undefined);
    detachAgentStoragePersistence();
    await agentStorage.flush().catch(() => undefined);
    await providerSnapshotManager.shutdown();
    terminalManager.killAll();
    speechService.stop();
    await scheduleService.stop().catch(() => undefined);
    quotaResetWatcher.stop();
    downloadArchiveCleaner.stop();
    taskScheduler.stop();
    autoDeployWatcher.stop();
    projectPromptSync.dispose();
    // Le dernier lot de consommation est écrit avant l'arrêt : sans ce vidage,
    // les jetons des dix dernières secondes de travail disparaissent avec le
    // processus, et une carte publiée juste avant un redémarrage sous-compte.
    await taskUsageRecorder.flush().catch(() => undefined);
    taskUsageRecorder.dispose();
    agentTaskSync.stop();
    activityLogService.stop();
    await relayTransport?.stop().catch(() => undefined);
    if (wsServer) {
      await wsServer.close();
    }
    await serviceProxy.stopStandalone();
    // Force-drop remaining sockets so httpServer.close() resolves promptly.
    // We've already closed wsServer (which sent ws-layer close frames) and
    // stopped every other service, so anything still attached is a TCP
    // socket whose higher-level shutdown hasn't fully released it (e.g.
    // upgraded WS sockets in the closing handshake, or HTTP keep-alive
    // sockets in CLOSE_WAIT). closeIdleConnections() does not catch
    // upgraded sockets, so we use closeAllConnections() here.
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    // Clean up socket files
    if (listenTarget.type === "socket" && existsSync(listenTarget.path)) {
      unlinkSync(listenTarget.path);
    }
  };

  return {
    config,
    agentManager,
    agentStorage,
    terminalManager,
    serviceProxy,
    scriptRuntimeStore,
    browserToolsBroker,
    start,
    stop,
    getListenTarget: () => boundListenTarget,
  };
}

async function closeAllAgents(logger: Logger, agentManager: AgentManager): Promise<void> {
  const agents = agentManager.listAgents();
  await Promise.all(
    agents.map(async (agent) => {
      try {
        await agentManager.closeAgent(agent.id);
      } catch (err) {
        logger.error({ err, agentId: agent.id }, "Failed to close agent");
      }
    }),
  );
}
