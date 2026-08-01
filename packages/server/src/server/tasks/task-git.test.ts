import { describe, expect, it } from "vitest";
import {
  type CommandOutcome,
  readTaskGitFacts,
  type TaskGitExec,
  withTaskGitBranch,
  withTaskGitFacts,
  withTaskGitStep,
} from "./task-git.js";

function ok(stdout: string): CommandOutcome {
  return { exitCode: 0, stdout, stderr: "" };
}

function fail(stderr = "boom"): CommandOutcome {
  return { exitCode: 1, stdout: "", stderr };
}

const SEP = "\u001f";

function execWith(responses: Record<string, CommandOutcome>): TaskGitExec {
  return {
    git: async (args) => {
      const key = args[0] === "remote" && args[1] === "get-url" ? `remote:${args[2]}` : args[0];
      return responses[key ?? ""] ?? fail("unexpected command");
    },
  };
}

describe("readTaskGitFacts", () => {
  it("reads the branch tip and resolves the GitHub repository", async () => {
    const exec = execWith({
      log: ok(`abc123def456${SEP}abc123d${SEP}2026-07-01T09:00:00Z${SEP}feat: encart`),
      remote: ok("origin\nfork\n"),
      "remote:origin": ok("git@github.com:haikostudio/paseo.git\n"),
      branch: ok("  origin/task/t1\n"),
    });

    const facts = await readTaskGitFacts({ exec, cwd: "/repo", branch: "task/t1" });

    expect(facts).toMatchObject({
      commitSha: "abc123def456",
      commitShortSha: "abc123d",
      commitAt: "2026-07-01T09:00:00Z",
      commitSubject: "feat: encart",
      pushed: true,
      repo: {
        forge: "github",
        owner: "haikostudio",
        name: "paseo",
        webUrl: "https://github.com/haikostudio/paseo",
      },
    });
  });

  it("reports a commit that never left the machine as not pushed", async () => {
    const exec = execWith({
      log: ok(`abc123def456${SEP}abc123d${SEP}2026-07-01T09:00:00Z${SEP}wip`),
      remote: ok("origin\n"),
      "remote:origin": ok("git@github.com:haikostudio/paseo.git\n"),
      branch: ok("\n"),
    });

    const facts = await readTaskGitFacts({ exec, cwd: "/repo", branch: "task/t1" });

    expect(facts.pushed).toBe(false);
  });

  it("leaves the push unknown rather than failed when git cannot answer", async () => {
    const exec = execWith({ log: fail(), remote: fail() });

    const facts = await readTaskGitFacts({ exec, cwd: "/repo", branch: "task/t1" });

    expect(facts).toEqual({ pushed: null });
  });

  it("keeps working on a project with no forge remote", async () => {
    const exec = execWith({
      log: ok(`abc123def456${SEP}abc123d${SEP}2026-07-01T09:00:00Z${SEP}wip`),
      remote: ok("backup\n"),
      "remote:backup": ok("/srv/mirrors/project.git\n"),
      branch: ok("\n"),
    });

    const facts = await readTaskGitFacts({ exec, cwd: "/repo", branch: "task/t1" });

    expect(facts.commitSha).toBe("abc123def456");
    expect(facts.repo).toBeUndefined();
  });
});

describe("withTaskGitBranch", () => {
  it("keeps the first stamp when the same branch is recorded again", () => {
    const first = withTaskGitBranch(null, "task/t1", "2026-07-01T10:00:00.000Z");
    const second = withTaskGitBranch(first, "task/t1", "2026-07-01T11:00:00.000Z");

    expect(second.branchAt).toBe("2026-07-01T10:00:00.000Z");
  });
});

describe("withTaskGitFacts", () => {
  it("never rewrites a successful push back to waiting", () => {
    const pushed = withTaskGitFacts(null, { pushed: true }, "2026-07-01T10:00:00.000Z");
    const later = withTaskGitFacts(pushed, { pushed: false }, "2026-07-01T12:00:00.000Z");

    expect(later.push).toEqual({ state: "success", at: "2026-07-01T10:00:00.000Z" });
  });

  it("leaves the other steps untouched", () => {
    const current = withTaskGitStep(
      { branch: "task/t1" },
      "merge",
      { state: "failed", at: "2026-07-01T10:00:00.000Z", detail: "conflit" },
      "2026-07-01T10:00:00.000Z",
    );

    const next = withTaskGitFacts(
      current,
      { commitSha: "abc123def456", pushed: true },
      "2026-07-01T11:00:00.000Z",
    );

    expect(next.merge).toMatchObject({ state: "failed", detail: "conflit" });
    expect(next.commitSha).toBe("abc123def456");
    expect(next.branch).toBe("task/t1");
  });
});
