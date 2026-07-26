import { basename } from "path";
import { createHash } from "node:crypto";
import { parseGitHubRemoteUrl } from "@getpaseo/protocol/git-remote";
import { slugify } from "../utils/worktree.js";

export interface WorkspaceGitMetadata {
  projectKind: "git" | "directory";
  projectDisplayName: string;
  workspaceDisplayName: string;
  gitRemote: string | null;
  isWorktree: boolean;
  projectSlug: string;
  repoRoot: string | null;
  currentBranch: string | null;
  remoteUrl: string | null;
}

export function parseGitHubRepoFromRemote(remoteUrl: string): string | null {
  return parseGitHubRemoteUrl(remoteUrl)?.repo ?? null;
}

export function parseGitHubRepoNameFromRemote(remoteUrl: string): string | null {
  const githubRepo = parseGitHubRepoFromRemote(remoteUrl);
  if (!githubRepo) {
    return null;
  }

  return githubRepo.split("/").pop() || null;
}

export function deriveProjectSlug(cwd: string, remoteUrl: string | null = null): string {
  const githubRepoName = remoteUrl ? parseGitHubRepoNameFromRemote(remoteUrl) : null;
  const sourceName = githubRepoName ?? basename(cwd);
  return slugify(sourceName) || "untitled";
}

function deriveProjectGroupingKey(options: {
  cwd: string;
  remoteUrl: string | null;
  mainRepoRoot: string | null;
}): string {
  const remoteRepo = options.remoteUrl ? parseGitHubRepoFromRemote(options.remoteUrl) : null;
  if (remoteRepo) {
    return `remote:github.com/${remoteRepo.toLowerCase()}`;
  }

  const mainRepoRoot = options.mainRepoRoot?.trim();
  if (mainRepoRoot) {
    return mainRepoRoot;
  }

  return options.cwd;
}

function deriveProjectGroupingName(projectKey: string): string {
  if (projectKey.startsWith("remote:")) {
    const remainder = projectKey.slice("remote:".length);
    const pathSegments = remainder.split("/").filter(Boolean).slice(1);
    if (pathSegments.length >= 2) {
      return pathSegments.slice(-2).join("/");
    }
    if (pathSegments.length === 1) {
      return pathSegments[0];
    }
    return projectKey;
  }

  const segments = projectKey.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || projectKey;
}

export function buildWorkspaceGitMetadataFromSnapshot(input: {
  cwd: string;
  directoryName: string;
  isGit: boolean;
  repoRoot: string | null;
  mainRepoRoot: string | null;
  currentBranch: string | null;
  remoteUrl: string | null;
}): WorkspaceGitMetadata {
  if (!input.isGit) {
    return {
      projectKind: "directory",
      projectDisplayName: input.directoryName,
      workspaceDisplayName: input.directoryName,
      gitRemote: null,
      isWorktree: false,
      projectSlug: deriveProjectSlug(input.cwd),
      repoRoot: null,
      currentBranch: null,
      remoteUrl: null,
    };
  }

  const isWorktree =
    input.mainRepoRoot !== null && input.repoRoot !== null && input.mainRepoRoot !== input.repoRoot;
  const projectKey = deriveProjectGroupingKey({
    cwd: input.repoRoot ?? input.cwd,
    remoteUrl: input.remoteUrl,
    mainRepoRoot: input.mainRepoRoot,
  });
  const projectDisplayName = projectKey.startsWith("remote:")
    ? deriveProjectGroupingName(projectKey)
    : input.directoryName;

  return {
    projectKind: "git",
    projectDisplayName,
    workspaceDisplayName: input.currentBranch ?? input.directoryName,
    gitRemote: input.remoteUrl,
    isWorktree,
    projectSlug: deriveProjectSlug(input.cwd, input.remoteUrl),
    repoRoot: input.repoRoot,
    currentBranch: input.currentBranch,
    remoteUrl: input.remoteUrl,
  };
}

export function deriveProjectServiceSlug(project: { projectId: string; rootPath: string }): string {
  const identity = createHash("sha256").update(project.projectId).digest("hex").slice(0, 8);
  return `${deriveProjectSlug(project.rootPath)}-${identity}`;
}
