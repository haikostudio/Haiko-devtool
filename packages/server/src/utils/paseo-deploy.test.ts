import { describe, expect, it } from "vitest";
import {
  AUTO_RESOLVABLE_CONFLICT_PATHS,
  classifyMergeConflicts,
  extractShipFailureReason,
  isPaseoDeployRepairBranch,
  parseWorktreeList,
} from "./paseo-deploy.js";

describe("classifyMergeConflicts", () => {
  it("treats the generated changelog snapshot as auto-resolvable", () => {
    const result = classifyMergeConflicts(["packages/app/src/generated/changelog-data.ts"]);
    expect(result.autoResolvable).toEqual(["packages/app/src/generated/changelog-data.ts"]);
    expect(result.manual).toEqual([]);
  });

  it("routes real code files to manual resolution", () => {
    const result = classifyMergeConflicts([
      "packages/app/src/generated/changelog-data.ts",
      "packages/server/src/server/session.ts",
    ]);
    expect(result.autoResolvable).toEqual(["packages/app/src/generated/changelog-data.ts"]);
    expect(result.manual).toEqual(["packages/server/src/server/session.ts"]);
  });

  it("marks a conflict with any real code file as needing a human", () => {
    const result = classifyMergeConflicts(["src/index.ts"]);
    expect(result.autoResolvable).toEqual([]);
    expect(result.manual).toEqual(["src/index.ts"]);
  });

  it("returns empty buckets for no conflicts", () => {
    const result = classifyMergeConflicts([]);
    expect(result.autoResolvable).toEqual([]);
    expect(result.manual).toEqual([]);
  });

  it("keeps the auto-resolvable list aligned with the .gitattributes rule", () => {
    expect(AUTO_RESOLVABLE_CONFLICT_PATHS).toContain(
      "packages/app/src/generated/changelog-data.ts",
    );
  });
});

describe("isPaseoDeployRepairBranch", () => {
  it("hides automatic repair branches from the deploy list", () => {
    expect(isPaseoDeployRepairBranch("task/reparer-le-conflit-avant-publication-tas-606984")).toBe(
      true,
    );
    expect(isPaseoDeployRepairBranch("task/refonte-modal-a-deployer-0815b3")).toBe(false);
  });
});

describe("extractShipFailureReason", () => {
  it("reports the build script's own reason instead of an exit code", () => {
    const log = [
      "==> Construction du site (expo export)…",
      "npm error code 1",
      "!! La construction a échoué — rien n'est publié.",
      "",
    ].join("\n");
    expect(extractShipFailureReason(log)).toBe("La construction a échoué — rien n'est publié.");
  });

  it("keeps the last failure when the log holds several runs", () => {
    const log = [
      "!! La copie vers /var/www/paseo-app a échoué.",
      "==> Build local — branche main",
      "!! /root/paseo introuvable",
    ].join("\n");
    expect(extractShipFailureReason(log)).toBe("/root/paseo introuvable");
  });

  it("returns null for a log that never failed", () => {
    expect(extractShipFailureReason("==> Terminé. 62 fichiers en ligne.\n")).toBeNull();
  });

  it("returns null for an empty log rather than an empty message", () => {
    expect(extractShipFailureReason("")).toBeNull();
    expect(extractShipFailureReason("!!   \n")).toBeNull();
  });
});

describe("parseWorktreeList", () => {
  it("reads path, head and branch for a live worktree", () => {
    const entries = parseWorktreeList(
      [
        "worktree /root/paseo",
        "HEAD 754107d5426d249105e849afc760fe7f18acfdf3",
        "branch refs/heads/main",
        "",
      ].join("\n"),
    );
    expect(entries).toEqual([
      {
        path: "/root/paseo",
        head: "754107d5426d249105e849afc760fe7f18acfdf3",
        branch: "main",
        prunable: false,
      },
    ]);
  });

  it("flags a worktree whose directory disappeared as prunable", () => {
    const entries = parseWorktreeList(
      [
        "worktree /home/paseo/.paseo/worktrees/1tw21woo/task-ghost",
        "HEAD 65633004b23d6eeeda9321e04f096ca647694b2b",
        "branch refs/heads/task/ghost-0be179",
        "prunable gitdir file points to non-existent location",
        "",
      ].join("\n"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.prunable).toBe(true);
  });

  it("marks a detached worktree with no branch", () => {
    const entries = parseWorktreeList(
      ["worktree /tmp/detached", "HEAD abc123", "detached", ""].join("\n"),
    );
    expect(entries[0]?.branch).toBeNull();
    expect(entries[0]?.prunable).toBe(false);
  });
});
