import { describe, expect, it } from "vitest";
import type { KanbanTask } from "@/data/tasks";
import { buildTaskGitJourney, hasForgeLink } from "@/components/tasks/task-git-journey";

function makeTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "t1",
    folderId: "f1",
    title: "Une carte",
    tags: [],
    column: "in_progress",
    order: 0,
    origin: "manual",
    normalizedTitle: "une carte",
    links: { agentIds: [] },
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T10:00:00.000Z",
    ...overrides,
  };
}

function stepById(task: KanbanTask, id: string) {
  const step = buildTaskGitJourney(task).find((entry) => entry.id === id);
  if (!step) throw new Error(`missing step ${id}`);
  return step;
}

describe("buildTaskGitJourney", () => {
  it("shows the branch as soon as it exists, before anything is committed", () => {
    const task = makeTask({
      git: { branch: "task/t1-encart", branchAt: "2026-07-01T10:05:00.000Z" },
    });
    expect(stepById(task, "branch")).toMatchObject({
      state: "success",
      value: "task/t1-encart",
      at: "2026-07-01T10:05:00.000Z",
    });
    expect(stepById(task, "commit").state).toBe("pending");
    expect(stepById(task, "push").state).toBe("pending");
  });

  it("links branch and commit to GitHub when the repository is known", () => {
    const task = makeTask({
      git: {
        branch: "task/t1-encart",
        commitSha: "abcdef1234567890",
        commitShortSha: "abcdef1",
        repo: {
          forge: "github",
          owner: "haikostudio",
          name: "paseo",
          webUrl: "https://github.com/haikostudio/paseo",
        },
      },
    });
    expect(stepById(task, "branch").url).toBe(
      "https://github.com/haikostudio/paseo/tree/task%2Ft1-encart",
    );
    expect(stepById(task, "commit")).toMatchObject({
      state: "success",
      value: "abcdef1",
      url: "https://github.com/haikostudio/paseo/commit/abcdef1234567890",
    });
    expect(hasForgeLink(task)).toBe(true);
  });

  it("keeps every step readable without a GitHub remote", () => {
    const task = makeTask({
      git: { branch: "task/t1-encart", commitSha: "abcdef1234567890" },
    });
    expect(stepById(task, "commit")).toMatchObject({ state: "success", value: "abcdef1" });
    expect(stepById(task, "commit").url).toBeUndefined();
    expect(hasForgeLink(task)).toBe(false);
  });

  it("reports a merge conflict on this card only, with its reason", () => {
    const task = makeTask({
      git: {
        branch: "task/t1-encart",
        merge: {
          state: "failed",
          at: "2026-07-02T08:00:00.000Z",
          detail: "Conflit avec une autre carte du lot : la fusion a été annulée.",
        },
        publish: { state: "failed", at: "2026-07-02T08:00:00.000Z" },
      },
    });
    expect(stepById(task, "merge")).toMatchObject({
      state: "failed",
      detail: "Conflit avec une autre carte du lot : la fusion a été annulée.",
    });
    expect(stepById(task, "publish").state).toBe("failed");
  });

  it("marks the merge as not applicable for a card that never had a branch", () => {
    expect(stepById(makeTask(), "merge").state).toBe("none");
  });

  it("reads a card finished before the record existed from its legacy fields", () => {
    const task = makeTask({
      column: "archived",
      links: { agentIds: [], branch: "task/t1-legacy" },
      deployedSha: "1234567abcdef",
      deployedAt: "2026-06-01T12:00:00.000Z",
    });
    expect(stepById(task, "branch")).toMatchObject({ state: "success", value: "task/t1-legacy" });
    expect(stepById(task, "commit")).toMatchObject({ state: "success", value: "1234567" });
    expect(stepById(task, "merge").state).toBe("success");
    expect(stepById(task, "publish")).toMatchObject({
      state: "success",
      at: "2026-06-01T12:00:00.000Z",
    });
  });

  it("shows a publication under way while the card's deploy window is open", () => {
    const task = makeTask({ deployment: { state: "running" } });
    expect(stepById(task, "publish").state).toBe("running");
  });
});
