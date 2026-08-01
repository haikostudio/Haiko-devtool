import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import { TaskBoardService } from "./service.js";
import { TaskBoardStore } from "./store.js";
import { TaskGitTracker } from "./task-git-tracker.js";
import type { CommandOutcome } from "./task-git.js";

const logger = pino({ level: "silent" });

let dir: string;
let service: TaskBoardService;
let prompts: { agentId: string; prompt: string }[];
let gitCalls: string[][];

function ok(stdout: string): CommandOutcome {
  return { exitCode: 0, stdout, stderr: "" };
}

const SEP = "\u001f";

function buildTracker(): TaskGitTracker {
  return new TaskGitTracker({
    taskBoardService: service,
    exec: {
      git: async (args) => {
        gitCalls.push(args);
        switch (args[0]) {
          case "log":
            return ok(`abc123def456${SEP}abc123d${SEP}2026-07-28T09:00:00Z${SEP}feat: encart`);
          case "remote":
            return ok(
              args[1] === "get-url" ? "git@github.com:haikostudio/paseo.git\n" : "origin\n",
            );
          case "branch":
            return ok("  origin/task/t1\n");
          case "merge-base":
            return ok("basesha\n");
          case "rev-list":
            return ok("3\n");
          case "diff":
            return ok("a.ts\nb.ts\na.ts\n");
          default:
            return { exitCode: 1, stdout: "", stderr: "unexpected" };
        }
      },
    },
    resolveRootPath: async () => "/repo",
    sendPrompt: async (input) => {
      prompts.push(input);
    },
    logger,
  });
}

async function seedTask(overrides: Partial<KanbanTask> = {}): Promise<KanbanTask> {
  const created = await service.createTask("proj-1", { folderId: "f1", title: "Une carte" });
  return await service.patchTask("proj-1", created.id, (current) => ({ ...current, ...overrides }));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "paseo-task-git-"));
  service = new TaskBoardService({ store: new TaskBoardStore(dir), logger });
  prompts = [];
  gitCalls = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("TaskGitTracker.refreshById", () => {
  it("records the commit, the branch size and the push in one read", async () => {
    const task = await seedTask({ links: { agentIds: [], branch: "task/t1" } });

    const refreshed = await buildTracker().refreshById("proj-1", task.id);

    expect(refreshed.git).toMatchObject({
      branch: "task/t1",
      commitSha: "abc123def456",
      commitShortSha: "abc123d",
      commitCount: 3,
      // Three diff lines, two distinct files: a file touched twice is one file.
      changedFiles: 2,
      push: { state: "success" },
      repo: { owner: "haikostudio", name: "paseo" },
    });
  });

  it("measures the branch against where it was cut, not against a branch name", async () => {
    const task = await seedTask({ links: { agentIds: [], branch: "task/t1" } });

    await buildTracker().refreshById("proj-1", task.id);

    expect(gitCalls).toContainEqual(["merge-base", "HEAD", "task/t1"]);
    expect(gitCalls).toContainEqual(["rev-list", "--count", "basesha..task/t1"]);
  });
});

describe("TaskGitTracker.resumeConflict", () => {
  it("hands the repair to the card's own agent and re-opens the merge step", async () => {
    const task = await seedTask({
      links: { agentIds: ["agent-1"], taskAgentId: "agent-1", branch: "task/t1" },
      git: {
        branch: "task/t1",
        merge: { state: "failed", at: "2026-07-28T10:00:00.000Z", detail: "conflit" },
      },
    });

    const updated = await buildTracker().resumeConflict("proj-1", task.id);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.agentId).toBe("agent-1");
    expect(prompts[0]?.prompt).toContain("task/t1");
    // Never publishes: the repair prepares the branch, the user still decides.
    expect(prompts[0]?.prompt).toContain("Ne publie rien");
    expect(updated.git?.merge?.state).toBe("running");
  });

  it("refuses rather than pretending, when the card has no agent", async () => {
    const task = await seedTask({ links: { agentIds: [], branch: "task/t1" } });

    await expect(buildTracker().resumeConflict("proj-1", task.id)).rejects.toThrow(/agent/i);
    expect(prompts).toEqual([]);
  });

  it("refuses on a card that never had a branch", async () => {
    const task = await seedTask({ links: { agentIds: ["agent-1"], taskAgentId: "agent-1" } });

    await expect(buildTracker().resumeConflict("proj-1", task.id)).rejects.toThrow(/branch/i);
  });
});
