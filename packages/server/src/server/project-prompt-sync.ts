import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import type pino from "pino";
import { z } from "zod";
import type {
  ProjectRegistry,
  WorkspaceRegistry,
  PersistedProjectRecord,
} from "./workspace-registry.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import { writePrivateFileAtomicSync } from "./private-files.js";
import { areEquivalentPaths, isPathInsideRoot } from "../utils/path.js";
import { readPaseoConfigForEdit } from "../utils/paseo-config-file.js";

const execFileAsync = promisify(execFile);
const PROJECT_PROMPT_SYNC_DEBOUNCE_MS = 250;
const PROJECT_PROMPT_HISTORY_LIMIT = 20;
const PROJECT_PROMPT_CHANGED_PATH_LIMIT = 12;
const PROJECT_PROMPT_WORKSPACE_LIMIT = 12;
const PROJECT_PROMPT_OUTPUTS = [
  { filename: "CLAUDE.md", providerLabel: "Claude" },
  {
    filename: "AGENTS.md",
    providerLabel: "Paseo agents (Codex, Copilot, OpenCode, Pi, and future providers)",
  },
] as const;

const ProjectPromptSyncHistoryEntrySchema = z.object({
  syncedAt: z.string(),
  fingerprint: z.string(),
  branch: z.string().nullable(),
  headSha: z.string().nullable(),
  dirtyFileCount: z.number().int().nonnegative(),
  changedFiles: z.array(z.string()).default([]),
});

const ProjectPromptSyncStateSchema = z.object({
  projectId: z.string(),
  slug: z.string(),
  rootPath: z.string(),
  latestFingerprint: z.string(),
  lastSyncedAt: z.string(),
  preview: z.string().optional(),
  history: z.array(ProjectPromptSyncHistoryEntrySchema).default([]),
});

type ProjectPromptSyncState = z.infer<typeof ProjectPromptSyncStateSchema>;

interface PromptWorkspaceSummary {
  workspaceId: string;
  displayName: string;
  cwd: string;
  kind: string;
  branch: string | null;
}

interface PromptGitSnapshot {
  projectKind: "git" | "non_git";
  branch: string | null;
  headSha: string | null;
  headSummary: string | null;
  remoteUrl: string | null;
  dirtyFiles: string[];
}

interface PromptProjectSnapshot {
  projectId: string;
  projectDisplayName: string;
  rootPath: string;
  slug: string;
  syncedAt: string;
  git: PromptGitSnapshot;
  workspaces: PromptWorkspaceSummary[];
  manualInstructionFiles: string[];
  preferences: ProjectPromptPreferences;
  fingerprint: string;
}

interface ProjectPromptPreferences {
  includeVersion: boolean;
  includeChangedFiles: boolean;
  includeWorkspaces: boolean;
  includeRemote: boolean;
  includeInstructionFiles: boolean;
}

export interface ProjectPromptSyncStatus {
  lastSyncedAt: string | null;
  recentFiles: string[];
  preview: string | null;
}

interface PromptCacheEntry {
  fingerprint: string;
  prompt: string;
}

interface ProjectPromptSyncClock {
  setTimeout(callback: () => void, delayMs: number): NodeJS.Timeout;
  clearTimeout(timer: NodeJS.Timeout): void;
}

interface ProjectPromptInspector {
  inspect(rootPath: string): Promise<PromptGitSnapshot>;
}

interface ProjectPromptSyncOptions {
  paseoHome: string;
  projectRegistry: Pick<ProjectRegistry, "list" | "subscribeToMutations">;
  workspaceRegistry: Pick<WorkspaceRegistry, "list">;
  workspaceGitService: Pick<WorkspaceGitService, "requestWorkingTreeWatch">;
  logger: pino.Logger;
  clock?: ProjectPromptSyncClock;
  inspector?: ProjectPromptInspector;
}

const systemClock: ProjectPromptSyncClock = {
  setTimeout(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  clearTimeout(timer) {
    clearTimeout(timer);
  },
};

export class ProjectPromptSyncService {
  private readonly baseDirectory: string;
  private readonly projectRegistry: Pick<ProjectRegistry, "list" | "subscribeToMutations">;
  private readonly workspaceRegistry: Pick<WorkspaceRegistry, "list">;
  private readonly workspaceGitService: Pick<WorkspaceGitService, "requestWorkingTreeWatch">;
  private readonly logger: pino.Logger;
  private readonly clock: ProjectPromptSyncClock;
  private readonly inspector: ProjectPromptInspector;
  private readonly watchUnsubscribes = new Map<string, () => void>();
  private readonly scheduledSyncs = new Map<string, NodeJS.Timeout>();
  private readonly syncQueues = new Map<string, Promise<PromptCacheEntry | null>>();
  private readonly promptCache = new Map<string, PromptCacheEntry>();
  private readonly deliveredFingerprints = new Map<string, string>();
  private unsubscribeRegistry: (() => void) | null = null;
  private started = false;
  private disposed = false;

  constructor(options: ProjectPromptSyncOptions) {
    this.baseDirectory = path.join(options.paseoHome, "project-prompts");
    this.projectRegistry = options.projectRegistry;
    this.workspaceRegistry = options.workspaceRegistry;
    this.workspaceGitService = options.workspaceGitService;
    this.logger = options.logger.child({ module: "project-prompt-sync" });
    this.clock = options.clock ?? systemClock;
    this.inspector = options.inspector ?? new GitProjectPromptInspector();
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.unsubscribeRegistry =
      this.projectRegistry.subscribeToMutations?.((mutation) => {
        void this.handleProjectMutation(mutation.projectId).catch((error) => {
          this.logSyncFailure(error, mutation.projectId);
        });
      }) ?? null;
    await this.syncProjectWatches();
    const projects = await this.listActiveProjects();
    for (const project of projects) {
      this.scheduleProjectSync(project.projectId);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeRegistry?.();
    this.unsubscribeRegistry = null;
    for (const unsubscribe of this.watchUnsubscribes.values()) {
      unsubscribe();
    }
    this.watchUnsubscribes.clear();
    for (const timer of this.scheduledSyncs.values()) {
      this.clock.clearTimeout(timer);
    }
    this.scheduledSyncs.clear();
  }

  async getDaemonAppendSystemPrompt(input: {
    agentId: string;
    cwd: string;
  }): Promise<string | null> {
    const project = await this.findProjectForCwd(input.cwd);
    if (!project) {
      return null;
    }
    const entry = await this.ensurePromptEntry(project);
    if (!entry) {
      return null;
    }
    this.deliveredFingerprints.set(input.agentId, entry.fingerprint);
    return entry.prompt;
  }

  async augmentPrompt(input: { agentId: string; cwd: string; text: string }): Promise<string> {
    if (!input.text.trim() || hasProjectPromptEnvelope(input.text)) {
      return input.text;
    }
    const project = await this.findProjectForCwd(input.cwd);
    if (!project) {
      return input.text;
    }
    const entry = await this.ensurePromptEntry(project);
    if (!entry) {
      return input.text;
    }
    if (this.deliveredFingerprints.get(input.agentId) === entry.fingerprint) {
      return input.text;
    }
    this.deliveredFingerprints.set(input.agentId, entry.fingerprint);
    return wrapProjectPrompt(entry.prompt, input.text);
  }

  async syncNow(project: PersistedProjectRecord): Promise<ProjectPromptSyncStatus> {
    await this.syncProject(project, true);
    return readProjectPromptSyncStatus({
      paseoHome: path.dirname(this.baseDirectory),
      project,
    });
  }

  private async handleProjectMutation(projectId: string): Promise<void> {
    if (this.disposed) {
      return;
    }
    await this.syncProjectWatches();
    this.scheduleProjectSync(projectId);
  }

  private scheduleProjectSync(projectId: string): void {
    if (this.disposed) {
      return;
    }
    const existing = this.scheduledSyncs.get(projectId);
    if (existing) {
      this.clock.clearTimeout(existing);
    }
    const timer = this.clock.setTimeout(() => {
      this.scheduledSyncs.delete(projectId);
      void this.syncProjectById(projectId).catch((error) => {
        this.logSyncFailure(error, projectId);
      });
    }, PROJECT_PROMPT_SYNC_DEBOUNCE_MS);
    this.scheduledSyncs.set(projectId, timer);
  }

  private async syncProjectById(projectId: string): Promise<void> {
    const project = (await this.listActiveProjects()).find((item) => item.projectId === projectId);
    if (!project) {
      return;
    }
    await this.syncProject(project);
  }

  private async ensurePromptEntry(
    project: PersistedProjectRecord,
  ): Promise<PromptCacheEntry | null> {
    const cached = this.promptCache.get(project.projectId);
    if (cached) {
      return cached;
    }
    return await this.syncProject(project);
  }

  private async syncProject(
    project: PersistedProjectRecord,
    force = false,
  ): Promise<PromptCacheEntry | null> {
    const previous = this.syncQueues.get(project.projectId);
    const pending = (previous ? previous.catch(() => null) : Promise.resolve(null)).then(() =>
      this.performProjectSync(project, force),
    );
    this.syncQueues.set(project.projectId, pending);
    try {
      return await pending;
    } finally {
      if (this.syncQueues.get(project.projectId) === pending) {
        this.syncQueues.delete(project.projectId);
      }
    }
  }

  private async performProjectSync(
    project: PersistedProjectRecord,
    force: boolean,
  ): Promise<PromptCacheEntry | null> {
    const snapshot = await this.buildSnapshot(project);
    const prompt = renderSharedPrompt(snapshot);
    const statePath = this.getStatePath(snapshot.slug);
    const currentState = loadProjectPromptSyncState(statePath);
    const nextEntry = { fingerprint: snapshot.fingerprint, prompt };
    this.promptCache.set(project.projectId, nextEntry);

    const filesExist =
      PROJECT_PROMPT_OUTPUTS.every((output) =>
        existsSync(this.getPromptPath(snapshot.slug, output.filename)),
      ) && existsSync(statePath);

    const hasCurrentPreview = currentState?.preview === prompt;
    if (
      !force &&
      currentState?.latestFingerprint === snapshot.fingerprint &&
      filesExist &&
      hasCurrentPreview
    ) {
      return nextEntry;
    }

    const nextState = buildProjectPromptSyncState({
      currentState,
      snapshot,
    });
    for (const output of PROJECT_PROMPT_OUTPUTS) {
      writePrivateFileAtomicSync(
        this.getPromptPath(snapshot.slug, output.filename),
        renderInstructionFile({
          providerLabel: output.providerLabel,
          snapshot,
          prompt,
          state: nextState,
        }),
      );
    }
    // Commit the status last so a successful timestamp always means every
    // generated instruction file was written.
    writePrivateFileAtomicSync(statePath, `${JSON.stringify(nextState, null, 2)}\n`);
    this.logger.debug(
      {
        projectId: project.projectId,
        rootPath: project.rootPath,
        fingerprint: snapshot.fingerprint,
      },
      "Project prompt files synced",
    );
    return nextEntry;
  }

  private logSyncFailure(error: unknown, projectId: string): void {
    this.logger.warn({ err: error, projectId }, "Project prompt sync failed");
  }

  private async buildSnapshot(project: PersistedProjectRecord): Promise<PromptProjectSnapshot> {
    const syncedAt = new Date().toISOString();
    const git = await this.inspector.inspect(project.rootPath);
    const workspaces = (await this.workspaceRegistry.list())
      .filter((workspace) => !workspace.archivedAt && workspace.projectId === project.projectId)
      .map((workspace) => ({
        workspaceId: workspace.workspaceId,
        displayName: workspace.title ?? workspace.displayName,
        cwd: workspace.cwd,
        kind: workspace.kind,
        branch: workspace.branch,
      }))
      .sort((left, right) => left.cwd.localeCompare(right.cwd))
      .slice(0, PROJECT_PROMPT_WORKSPACE_LIMIT);
    const manualInstructionFiles = ["CLAUDE.md", "AGENTS.md"].filter((filename) =>
      existsSync(path.join(project.rootPath, filename)),
    );
    const preferences = readProjectPromptPreferences(project.rootPath);
    const slug = `${slugify(project.displayName || path.basename(project.rootPath))}-${project.projectId}`;
    const fingerprint = createFingerprint({
      projectId: project.projectId,
      rootPath: project.rootPath,
      version: preferences.includeVersion
        ? {
            projectKind: git.projectKind,
            branch: git.branch,
            headSha: git.headSha,
            headSummary: git.headSummary,
          }
        : null,
      remoteUrl: preferences.includeRemote ? git.remoteUrl : null,
      dirtyFiles: preferences.includeChangedFiles ? git.dirtyFiles : [],
      workspaces: preferences.includeWorkspaces ? workspaces : [],
      manualInstructionFiles: preferences.includeInstructionFiles ? manualInstructionFiles : [],
      preferences,
    });
    return {
      projectId: project.projectId,
      projectDisplayName: project.displayName,
      rootPath: project.rootPath,
      slug,
      syncedAt,
      git,
      workspaces,
      manualInstructionFiles,
      preferences,
      fingerprint,
    };
  }

  private async listActiveProjects(): Promise<PersistedProjectRecord[]> {
    return (await this.projectRegistry.list()).filter((project) => !project.archivedAt);
  }

  private async findProjectForCwd(cwd: string): Promise<PersistedProjectRecord | null> {
    const projects = await this.listActiveProjects();
    const matches = projects.filter(
      (project) =>
        areEquivalentPaths(project.rootPath, cwd) || isPathInsideRoot(project.rootPath, cwd),
    );
    if (matches.length === 0) {
      return null;
    }
    matches.sort((left, right) => right.rootPath.length - left.rootPath.length);
    return matches[0] ?? null;
  }

  private async syncProjectWatches(): Promise<void> {
    const projects = await this.listActiveProjects();
    const activeProjectIds = new Set(projects.map((project) => project.projectId));

    for (const [projectId, unsubscribe] of this.watchUnsubscribes.entries()) {
      if (activeProjectIds.has(projectId)) {
        continue;
      }
      unsubscribe();
      this.watchUnsubscribes.delete(projectId);
    }

    for (const project of projects) {
      if (this.watchUnsubscribes.has(project.projectId)) {
        continue;
      }
      try {
        const watch = await this.workspaceGitService.requestWorkingTreeWatch(
          project.rootPath,
          () => {
            this.scheduleProjectSync(project.projectId);
          },
        );
        this.watchUnsubscribes.set(project.projectId, watch.unsubscribe);
      } catch (error) {
        this.logger.debug(
          { err: error, projectId: project.projectId, rootPath: project.rootPath },
          "Project prompt watch unavailable",
        );
      }
    }
  }

  private getStatePath(slug: string): string {
    return path.join(this.baseDirectory, slug, "state.json");
  }

  private getPromptPath(slug: string, filename: string): string {
    return path.join(this.baseDirectory, slug, filename);
  }
}

class GitProjectPromptInspector implements ProjectPromptInspector {
  async inspect(rootPath: string): Promise<PromptGitSnapshot> {
    const isGit = await this.isGitProject(rootPath);
    if (!isGit) {
      return {
        projectKind: "non_git",
        branch: null,
        headSha: null,
        headSummary: null,
        remoteUrl: null,
        dirtyFiles: [],
      };
    }

    const [branch, headSha, headSummary, remoteUrl, dirtyFiles] = await Promise.all([
      runGitRead(["symbolic-ref", "--quiet", "--short", "HEAD"], rootPath),
      runGitRead(["rev-parse", "HEAD"], rootPath),
      runGitRead(["log", "-1", "--pretty=%s"], rootPath),
      runGitRead(["config", "--get", "remote.origin.url"], rootPath),
      runGitStatus(rootPath),
    ]);

    return {
      projectKind: "git",
      branch,
      headSha,
      headSummary,
      remoteUrl,
      dirtyFiles,
    };
  }

  private async isGitProject(rootPath: string): Promise<boolean> {
    try {
      await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: rootPath,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return true;
    } catch {
      return false;
    }
  }
}

async function runGitRead(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function runGitStatus(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--short"], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => {
        const rawPath = line.slice(3).trim();
        const renameParts = rawPath.split(" -> ");
        return renameParts[renameParts.length - 1] ?? rawPath;
      })
      .slice(0, PROJECT_PROMPT_CHANGED_PATH_LIMIT);
  } catch {
    return [];
  }
}

function buildProjectPromptSyncState(input: {
  currentState: ProjectPromptSyncState | null;
  snapshot: PromptProjectSnapshot;
}): ProjectPromptSyncState {
  const historyEntry = {
    syncedAt: input.snapshot.syncedAt,
    fingerprint: input.snapshot.fingerprint,
    branch: input.snapshot.git.branch,
    headSha: input.snapshot.git.headSha,
    dirtyFileCount: input.snapshot.preferences.includeChangedFiles
      ? input.snapshot.git.dirtyFiles.length
      : 0,
    changedFiles: input.snapshot.preferences.includeChangedFiles
      ? input.snapshot.git.dirtyFiles
      : [],
  };
  const previousHistory = input.currentState?.history ?? [];
  const history =
    previousHistory[0]?.fingerprint === input.snapshot.fingerprint
      ? previousHistory
      : [historyEntry, ...previousHistory].slice(0, PROJECT_PROMPT_HISTORY_LIMIT);

  return {
    projectId: input.snapshot.projectId,
    slug: input.snapshot.slug,
    rootPath: input.snapshot.rootPath,
    latestFingerprint: input.snapshot.fingerprint,
    lastSyncedAt: input.snapshot.syncedAt,
    preview: renderSharedPrompt(input.snapshot),
    history,
  };
}

function renderSharedPrompt(snapshot: PromptProjectSnapshot): string {
  const lines = [
    "Paseo project sync. This block is generated from the live local project state, independently from Cerveau.",
    "If this block conflicts with an older project summary, trust this block.",
    `Project: ${snapshot.projectDisplayName}`,
    `Project root: ${snapshot.rootPath}`,
    `Synced at: ${snapshot.syncedAt}`,
  ];

  if (snapshot.preferences.includeVersion) {
    lines.push(
      `Project kind: ${snapshot.git.projectKind === "git" ? "git repository" : "directory"}`,
      `Current branch: ${snapshot.git.branch ?? "none"}`,
      `HEAD commit: ${snapshot.git.headSha ?? "none"}`,
      `Last commit title: ${snapshot.git.headSummary ?? "none"}`,
    );
  }

  if (snapshot.preferences.includeRemote) {
    lines.push(`Remote: ${snapshot.git.remoteUrl ?? "none"}`);
  }

  if (snapshot.preferences.includeChangedFiles) {
    lines.push(
      snapshot.git.dirtyFiles.length === 0
        ? "Latest file changes: none"
        : `Latest file changes: ${snapshot.git.dirtyFiles.length} file(s) currently touched`,
    );
    for (const changedPath of snapshot.git.dirtyFiles) {
      lines.push(`- ${changedPath}`);
    }
  }

  if (snapshot.preferences.includeWorkspaces) {
    if (snapshot.workspaces.length === 0) {
      lines.push("Active workspaces: none");
    } else {
      lines.push("Active workspaces:");
      for (const workspace of snapshot.workspaces) {
        lines.push(
          `- ${workspace.displayName} | ${workspace.kind} | branch=${workspace.branch ?? "none"} | cwd=${workspace.cwd}`,
        );
      }
    }
  }

  if (snapshot.preferences.includeInstructionFiles) {
    lines.push(
      snapshot.manualInstructionFiles.length === 0
        ? "Manual project instruction files: none in the project root"
        : `Manual project instruction files in the project root: ${snapshot.manualInstructionFiles.join(", ")}`,
    );
  }
  lines.push(
    "Use this state to keep answers and plans aligned with the current project, even when the repo has changed since the conversation started.",
  );
  return lines.join("\n");
}

function renderInstructionFile(input: {
  providerLabel: string;
  snapshot: PromptProjectSnapshot;
  prompt: string;
  state: ProjectPromptSyncState;
}): string {
  const lines = [
    `# Generated ${input.providerLabel} instructions`,
    "",
    "This file is generated by Paseo from the live local project state.",
    "Do not edit it by hand: the daemon rewrites it when the project changes.",
    "",
    "## Current project state",
    "",
    input.prompt,
    "",
    "## Sync history",
    "",
  ];
  for (const entry of input.state.history) {
    const details = [`- ${entry.syncedAt}`];
    if (input.snapshot.preferences.includeVersion) {
      details.push(`branch=${entry.branch ?? "none"}`, `head=${entry.headSha ?? "none"}`);
    }
    if (input.snapshot.preferences.includeChangedFiles) {
      details.push(`changed=${entry.dirtyFileCount}`);
    }
    lines.push(details.join(" | "));
    if (input.snapshot.preferences.includeChangedFiles && entry.changedFiles.length > 0) {
      lines.push(`  Files: ${entry.changedFiles.join(", ")}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function loadProjectPromptSyncState(filePath: string): ProjectPromptSyncState | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return ProjectPromptSyncStateSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

export function readProjectPromptSyncStatus(input: {
  paseoHome: string;
  project: PersistedProjectRecord;
}): ProjectPromptSyncStatus {
  const slug = `${slugify(
    input.project.displayName || path.basename(input.project.rootPath),
  )}-${input.project.projectId}`;
  const state = loadProjectPromptSyncState(
    path.join(input.paseoHome, "project-prompts", slug, "state.json"),
  );
  if (!state) {
    return { lastSyncedAt: null, recentFiles: [], preview: null };
  }
  return {
    lastSyncedAt: state.lastSyncedAt,
    recentFiles: state.history[0]?.changedFiles ?? [],
    preview: state.preview ?? null,
  };
}

function readProjectPromptPreferences(rootPath: string): ProjectPromptPreferences {
  const config = readPaseoConfigForEdit(rootPath);
  const preferences = config.ok ? config.config?.projectPromptSync : undefined;
  return {
    includeVersion: preferences?.includeVersion ?? true,
    includeChangedFiles: preferences?.includeChangedFiles ?? true,
    includeWorkspaces: preferences?.includeWorkspaces ?? true,
    includeRemote: preferences?.includeRemote ?? true,
    includeInstructionFiles: preferences?.includeInstructionFiles ?? true,
  };
}

function wrapProjectPrompt(projectPrompt: string, userText: string): string {
  return [
    '<contexte_projet source="paseo-sync">',
    projectPrompt,
    "</contexte_projet>",
    "",
    userText,
  ].join("\n");
}

function hasProjectPromptEnvelope(text: string): boolean {
  return text.includes("<contexte_projet") && text.includes("</contexte_projet>");
}

function createFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function slugify(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}
