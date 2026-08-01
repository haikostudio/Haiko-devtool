import type { KanbanTask } from "@/data/tasks";

/**
 * The five steps a card's work goes through, in order, as the encart shows them:
 * its dedicated branch, its commit, the send to GitHub, the merge, the going
 * live.
 */
export type TaskGitStepId = "branch" | "commit" | "push" | "merge" | "publish";

/**
 * `none` is not a failure and not a wait: it is "this step does not apply here"
 * — a card that never had a branch has nothing to merge. Showing it as "en
 * attente" would promise something that is never coming.
 */
export type TaskGitStepState = "pending" | "running" | "success" | "failed" | "none";

export interface TaskGitJourneyStep {
  id: TaskGitStepId;
  state: TaskGitStepState;
  /** Branch name or short commit id, when the step has one to show. */
  value?: string;
  /** ISO date of the step's last change. */
  at?: string;
  /** Plain-language reason, on a failed step. */
  detail?: string;
  /** GitHub address, when the project's repository is known. */
  url?: string;
}

const SHORT_SHA_LENGTH = 7;

/** True once a publication actually put this card's work online. */
function isLive(task: KanbanTask): boolean {
  return Boolean(task.deployedAt) || task.deployment?.state === "deployed";
}

function shortSha(sha: string): string {
  return sha.length > SHORT_SHA_LENGTH ? sha.slice(0, SHORT_SHA_LENGTH) : sha;
}

/**
 * Turns what the daemon recorded into the five rows of the encart.
 *
 * Two sources, in this order: the card's own git record (written by whoever
 * performed each step) and, when it is absent, the older fields that predate it
 * (`links.branch`, `deployedSha`, `deployedAt`). A card finished before the
 * record existed still tells what is knowable about it instead of showing five
 * empty rows.
 */
export function buildTaskGitJourney(task: KanbanTask): TaskGitJourneyStep[] {
  return [branchStep(task), commitStep(task), pushStep(task), mergeStep(task), publishStep(task)];
}

function branchStep(task: KanbanTask): TaskGitJourneyStep {
  const branch = task.git?.branch ?? task.links.branch ?? null;
  if (!branch) {
    return { id: "branch", state: "pending" };
  }
  const webUrl = task.git?.repo?.webUrl ?? null;
  return {
    id: "branch",
    state: "success",
    value: branch,
    ...(task.git?.branchAt ? { at: task.git.branchAt } : {}),
    ...(webUrl ? { url: `${webUrl}/tree/${encodeURIComponent(branch)}` } : {}),
  };
}

function commitStep(task: KanbanTask): TaskGitJourneyStep {
  const git = task.git;
  const sha = git?.commitSha ?? task.deployedSha ?? null;
  if (!sha) {
    return { id: "commit", state: "pending" };
  }
  const webUrl = git?.repo?.webUrl ?? null;
  return {
    id: "commit",
    state: "success",
    value: git?.commitShortSha ?? shortSha(sha),
    ...(git?.commitAt ? { at: git.commitAt } : {}),
    ...(git?.commitSubject ? { detail: git.commitSubject } : {}),
    ...(webUrl ? { url: `${webUrl}/commit/${sha}` } : {}),
  };
}

function pushStep(task: KanbanTask): TaskGitJourneyStep {
  const push = task.git?.push;
  if (!push) {
    return { id: "push", state: "pending" };
  }
  return { id: "push", state: push.state, ...pick(push) };
}

function mergeStep(task: KanbanTask): TaskGitJourneyStep {
  const merge = task.git?.merge;
  if (merge) {
    return { id: "merge", state: merge.state, ...pick(merge) };
  }
  // A card with no branch had nothing to merge — never a wait, never a failure.
  const branch = task.git?.branch ?? task.links.branch ?? null;
  if (!branch) {
    return { id: "merge", state: "none" };
  }
  // A card published before this record existed: its work IS in the build, so
  // its branch was necessarily merged on the way.
  return { id: "merge", state: isLive(task) ? "success" : "pending" };
}

function publishStep(task: KanbanTask): TaskGitJourneyStep {
  const publish = task.git?.publish;
  if (publish) {
    return { id: "publish", state: publish.state, ...pick(publish) };
  }
  if (isLive(task)) {
    return {
      id: "publish",
      state: "success",
      ...(task.deployedAt ? { at: task.deployedAt } : {}),
    };
  }
  return {
    id: "publish",
    state: task.deployment?.state === "running" ? "running" : "pending",
  };
}

function pick(step: { at?: string; detail?: string }): { at?: string; detail?: string } {
  return {
    ...(step.at ? { at: step.at } : {}),
    ...(step.detail ? { detail: step.detail } : {}),
  };
}

/** True when the card knows a GitHub repository to open things in. */
export function hasForgeLink(task: KanbanTask): boolean {
  return Boolean(task.git?.repo?.webUrl);
}
