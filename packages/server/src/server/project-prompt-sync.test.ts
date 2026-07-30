import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { ProjectPromptSyncService, readProjectPromptSyncStatus } from "./project-prompt-sync.js";
import type {
  PersistedProjectRecord,
  PersistedWorkspaceRecord,
  ProjectRegistry,
  WorkspaceRegistry,
} from "./workspace-registry.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import { createTestLogger } from "../test-utils/test-logger.js";

const logger = createTestLogger();

class MutableProjectRegistry implements Pick<ProjectRegistry, "list" | "subscribeToMutations"> {
  constructor(readonly projects: PersistedProjectRecord[]) {}

  async list(): Promise<PersistedProjectRecord[]> {
    return this.projects;
  }

  subscribeToMutations(): () => void {
    return () => {};
  }
}

class MutableWorkspaceRegistry implements Pick<WorkspaceRegistry, "list"> {
  constructor(private workspaces: PersistedWorkspaceRecord[]) {}

  async list(): Promise<PersistedWorkspaceRecord[]> {
    return this.workspaces;
  }
}

class MutableInspector {
  delayMs = 0;
  activeInspections = 0;
  maxConcurrentInspections = 0;
  current = {
    projectKind: "git" as const,
    branch: "main",
    headSha: "abc123",
    headSummary: "Initial sync",
    remoteUrl: "git@example.test:paseo.git",
    dirtyFiles: ["packages/server/src/server/bootstrap.ts"],
  };

  async inspect(_rootPath: string) {
    this.activeInspections += 1;
    this.maxConcurrentInspections = Math.max(this.maxConcurrentInspections, this.activeInspections);
    try {
      if (this.delayMs > 0) {
        await waitFor(this.delayMs);
      }
      return this.current;
    } finally {
      this.activeInspections -= 1;
    }
  }
}

describe("ProjectPromptSyncService", () => {
  let paseoHome: string;
  let projectRoot: string;

  beforeEach(() => {
    paseoHome = mkdtempSync(path.join(tmpdir(), "project-prompt-sync-home-"));
    projectRoot = mkdtempSync(path.join(tmpdir(), "project-prompt-sync-project-"));
    mkdirSync(path.join(projectRoot, "packages", "server"), { recursive: true });
  });
  test("writes Claude and GPT instruction files from the live project state", async () => {
    const projectRegistry = new MutableProjectRegistry([
      buildProjectRecord({ projectId: "prj_sync", rootPath: projectRoot, displayName: "Paseo" }),
    ]);
    const workspaceRegistry = new MutableWorkspaceRegistry([
      buildWorkspaceRecord({
        workspaceId: "ws_sync",
        projectId: "prj_sync",
        cwd: path.join(projectRoot, "packages", "server"),
        displayName: "Server",
      }),
    ]);
    const inspector = new MutableInspector();
    const workspaceGitService = createWorkspaceGitServiceStub();
    const service = new ProjectPromptSyncService({
      paseoHome,
      projectRegistry,
      workspaceRegistry,
      workspaceGitService,
      inspector,
      logger,
    });

    await service.start();
    const prompt = await service.getDaemonAppendSystemPrompt({
      agentId: "agent-1",
      cwd: path.join(projectRoot, "packages", "server"),
    });

    expect(prompt).toContain("Project: Paseo");
    expect(prompt).toContain("Current branch: main");
    expect(prompt).toContain("bootstrap.ts");

    const outputDir = path.join(paseoHome, "project-prompts", "paseo-prj_sync");
    expect(existsSync(path.join(outputDir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(path.join(outputDir, "AGENTS.md"))).toBe(true);
    expect(existsSync(path.join(outputDir, "state.json"))).toBe(true);
    expect(readFileSync(path.join(outputDir, "CLAUDE.md"), "utf8")).toContain(
      "Generated Claude instructions",
    );
    expect(
      readProjectPromptSyncStatus({ paseoHome, project: projectRegistry.projects[0]! }),
    ).toEqual({
      lastSyncedAt: expect.any(String),
      recentFiles: ["packages/server/src/server/bootstrap.ts"],
      preview: expect.stringContaining("Project: Paseo"),
    });
    const firstSyncedAt = readProjectPromptSyncStatus({
      paseoHome,
      project: projectRegistry.projects[0]!,
    }).lastSyncedAt;
    await waitFor(5);
    const refreshed = await service.syncNow(projectRegistry.projects[0]!);
    expect(refreshed.lastSyncedAt).not.toBe(firstSyncedAt);
  });

  test("respects the project choices when rendering generated instructions", async () => {
    const project = buildProjectRecord({
      projectId: "prj_private",
      rootPath: projectRoot,
      displayName: "Private",
    });
    writeFileSync(
      path.join(projectRoot, "paseo.json"),
      JSON.stringify({
        projectPromptSync: {
          includeVersion: false,
          includeChangedFiles: false,
          includeWorkspaces: false,
          includeRemote: false,
          includeInstructionFiles: false,
        },
      }),
    );
    const service = new ProjectPromptSyncService({
      paseoHome,
      projectRegistry: new MutableProjectRegistry([project]),
      workspaceRegistry: new MutableWorkspaceRegistry([]),
      workspaceGitService: createWorkspaceGitServiceStub(),
      inspector: new MutableInspector(),
      logger,
    });

    await service.start();
    const prompt = await service.getDaemonAppendSystemPrompt({
      agentId: "agent-private",
      cwd: projectRoot,
    });

    expect(prompt).toContain("Project: Private");
    expect(prompt).not.toContain("Current branch");
    expect(prompt).not.toContain("bootstrap.ts");
    expect(prompt).not.toContain("git@example.test");
  });

  test("carries the project memory and the instruction that keeps it alive", async () => {
    const project = buildProjectRecord({
      projectId: "prj_memory",
      rootPath: projectRoot,
      displayName: "Memory",
    });
    writeFileSync(
      path.join(projectRoot, "MEMOIRE.md"),
      "- Le déploiement ne reconstruit que ce qui a changé.\n",
    );
    const service = new ProjectPromptSyncService({
      paseoHome,
      projectRegistry: new MutableProjectRegistry([project]),
      workspaceRegistry: new MutableWorkspaceRegistry([]),
      workspaceGitService: createWorkspaceGitServiceStub(),
      inspector: new MutableInspector(),
      logger,
    });

    await service.start();
    const prompt = await service.getDaemonAppendSystemPrompt({
      agentId: "agent-memory",
      cwd: projectRoot,
    });

    expect(prompt).toContain("Le déploiement ne reconstruit que ce qui a changé.");
    // Sans cette consigne, la mémoire ne serait jamais alimentée : personne
    // d'autre que les agents ne l'écrit.
    expect(prompt).toContain("MEMOIRE.md");
    expect(prompt).toContain("fait DURABLE");
  });

  test("says the memory is empty rather than hiding the file when it is missing", async () => {
    const project = buildProjectRecord({
      projectId: "prj_no_memory",
      rootPath: projectRoot,
      displayName: "NoMemory",
    });
    const service = new ProjectPromptSyncService({
      paseoHome,
      projectRegistry: new MutableProjectRegistry([project]),
      workspaceRegistry: new MutableWorkspaceRegistry([]),
      workspaceGitService: createWorkspaceGitServiceStub(),
      inspector: new MutableInspector(),
      logger,
    });

    await service.start();
    const prompt = await service.getDaemonAppendSystemPrompt({
      agentId: "agent-no-memory",
      cwd: projectRoot,
    });

    // Un agent qui ignore que le fichier peut exister ne le créera jamais.
    expect(prompt).toContain("le fichier n'existe pas encore");
    expect(prompt).toContain("crée le fichier s'il manque");
  });

  test("truncates an oversized memory instead of paying for it forever", async () => {
    const project = buildProjectRecord({
      projectId: "prj_big_memory",
      rootPath: projectRoot,
      displayName: "BigMemory",
    });
    writeFileSync(path.join(projectRoot, "MEMOIRE.md"), `${"a".repeat(9_000)}\nFIN-DU-FICHIER\n`);
    const service = new ProjectPromptSyncService({
      paseoHome,
      projectRegistry: new MutableProjectRegistry([project]),
      workspaceRegistry: new MutableWorkspaceRegistry([]),
      workspaceGitService: createWorkspaceGitServiceStub(),
      inspector: new MutableInspector(),
      logger,
    });

    await service.start();
    const prompt = await service.getDaemonAppendSystemPrompt({
      agentId: "agent-big-memory",
      cwd: projectRoot,
    });

    expect(prompt).not.toContain("FIN-DU-FICHIER");
    expect(prompt).toContain("Mémoire tronquée");
  });

  test("lets a project turn the memory off", async () => {
    const project = buildProjectRecord({
      projectId: "prj_memory_off",
      rootPath: projectRoot,
      displayName: "MemoryOff",
    });
    writeFileSync(path.join(projectRoot, "MEMOIRE.md"), "- Un secret bien gardé.\n");
    writeFileSync(
      path.join(projectRoot, "paseo.json"),
      JSON.stringify({ projectPromptSync: { includeMemory: false } }),
    );
    const service = new ProjectPromptSyncService({
      paseoHome,
      projectRegistry: new MutableProjectRegistry([project]),
      workspaceRegistry: new MutableWorkspaceRegistry([]),
      workspaceGitService: createWorkspaceGitServiceStub(),
      inspector: new MutableInspector(),
      logger,
    });

    await service.start();
    const prompt = await service.getDaemonAppendSystemPrompt({
      agentId: "agent-memory-off",
      cwd: projectRoot,
    });

    expect(prompt).not.toContain("Un secret bien gardé");
    expect(prompt).not.toContain("MEMOIRE.md");
  });

  test("serializes overlapping sync requests for the same project", async () => {
    const project = buildProjectRecord({
      projectId: "prj_serial",
      rootPath: projectRoot,
      displayName: "Serial",
    });
    const inspector = new MutableInspector();
    inspector.delayMs = 10;
    const service = new ProjectPromptSyncService({
      paseoHome,
      projectRegistry: new MutableProjectRegistry([project]),
      workspaceRegistry: new MutableWorkspaceRegistry([]),
      workspaceGitService: createWorkspaceGitServiceStub(),
      inspector,
      logger,
    });

    await Promise.all([service.syncNow(project), service.syncNow(project)]);

    expect(inspector.maxConcurrentInspections).toBe(1);
  });

  test("prepends a fresh project block only after the project fingerprint changes", async () => {
    const projectRegistry = new MutableProjectRegistry([
      buildProjectRecord({ projectId: "prj_sync", rootPath: projectRoot, displayName: "Paseo" }),
    ]);
    const workspaceRegistry = new MutableWorkspaceRegistry([
      buildWorkspaceRecord({
        workspaceId: "ws_sync",
        projectId: "prj_sync",
        cwd: projectRoot,
        displayName: "Root",
      }),
    ]);
    const inspector = new MutableInspector();
    const workspaceGitService = createWorkspaceGitServiceStub();
    const service = new ProjectPromptSyncService({
      paseoHome,
      projectRegistry,
      workspaceRegistry,
      workspaceGitService,
      inspector,
      logger,
    });

    await service.start();
    await service.getDaemonAppendSystemPrompt({ agentId: "agent-1", cwd: projectRoot });

    const unchanged = await service.augmentPrompt({
      agentId: "agent-1",
      cwd: projectRoot,
      text: "Corrige le bug.",
    });
    expect(unchanged).toBe("Corrige le bug.");

    inspector.current = {
      ...inspector.current,
      headSha: "def456",
      headSummary: "Sync after change",
      dirtyFiles: ["packages/server/src/server/project-prompt-sync.ts"],
    };
    workspaceGitService.fire();
    await waitFor(400);

    const changed = await service.augmentPrompt({
      agentId: "agent-1",
      cwd: projectRoot,
      text: "Corrige le bug.",
    });
    expect(changed).toContain('<contexte_projet source="paseo-sync">');
    expect(changed).toContain("def456");
    expect(changed).toContain("Corrige le bug.");
  });
});

function createWorkspaceGitServiceStub(): Pick<WorkspaceGitService, "requestWorkingTreeWatch"> & {
  fire(): void;
} {
  let listener: (() => void) | null = null;
  return {
    async requestWorkingTreeWatch(_cwd: string, onChange: () => void) {
      listener = onChange;
      return {
        repoRoot: null,
        unsubscribe: () => {
          listener = null;
        },
      };
    },
    fire() {
      listener?.();
    },
  };
}

function buildProjectRecord(input: {
  projectId: string;
  rootPath: string;
  displayName: string;
}): PersistedProjectRecord {
  const now = new Date().toISOString();
  return {
    projectId: input.projectId,
    rootPath: input.rootPath,
    kind: "git",
    displayName: input.displayName,
    customName: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
}

function buildWorkspaceRecord(input: {
  workspaceId: string;
  projectId: string;
  cwd: string;
  displayName: string;
}): PersistedWorkspaceRecord {
  const now = new Date().toISOString();
  return {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    cwd: input.cwd,
    kind: "directory",
    displayName: input.displayName,
    title: null,
    branch: null,
    worktreeRoot: null,
    baseBranch: null,
    isPaseoOwnedWorktree: false,
    mainRepoRoot: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    pinnedAt: null,
    titleLockedByUser: false,
  };
}

async function waitFor(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
