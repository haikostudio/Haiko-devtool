import { existsSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { ProjectPromptSyncService } from "./project-prompt-sync.js";
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
  constructor(private projects: PersistedProjectRecord[]) {}

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
  current = {
    projectKind: "git" as const,
    branch: "main",
    headSha: "abc123",
    headSummary: "Initial sync",
    remoteUrl: "git@example.test:paseo.git",
    dirtyFiles: ["packages/server/src/server/bootstrap.ts"],
  };

  async inspect(_rootPath: string) {
    return this.current;
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
