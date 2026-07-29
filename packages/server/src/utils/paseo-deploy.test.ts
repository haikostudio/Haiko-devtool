import { describe, expect, it } from "vitest";
import {
  annotateDeployCommits,
  AUTO_RESOLVABLE_CONFLICT_PATHS,
  classifyMergeConflicts,
  extractShipFailureReason,
  isPaseoDeployRepairBranch,
  parseWorktreeList,
  sanitizeAgentFailureReason,
} from "./paseo-deploy.js";

describe("annotateDeployCommits", () => {
  const A = { sha: "aaa", subject: "Corriger le voyant" };
  const B = { sha: "bbb", subject: "Ajouter les quotas" };
  const C = { sha: "ccc", subject: "Écrit pendant la publication" };

  it("marks everything as waiting when no publication has run", () => {
    const result = annotateDeployCommits({
      unshipped: [A, B],
      runCommits: null,
      running: false,
      outcome: null,
    });
    expect(result.map((commit) => commit.state)).toEqual(["pending", "pending"]);
  });

  it("marks every change as being published while a run is going", () => {
    // Including one committed after the click: the build takes the whole trunk,
    // so calling it "waiting" while it is on its way up would be a lie.
    const result = annotateDeployCommits({
      unshipped: [C, A, B],
      runCommits: [A, B],
      running: true,
      outcome: null,
    });
    expect(result.map((commit) => commit.state)).toEqual(["deploying", "deploying", "deploying"]);
  });

  it("keeps the published changes visible and green once the run succeeded", () => {
    // git reports nothing unshipped after a successful publish. Without the run
    // snapshot the list would go empty at the exact moment the reader wants
    // confirmation — which reads as "my changes disappeared".
    const result = annotateDeployCommits({
      unshipped: [],
      runCommits: [A, B],
      running: false,
      outcome: "success",
    });
    expect(result).toEqual([
      { ...A, state: "deployed" },
      { ...B, state: "deployed" },
    ]);
  });

  it("separates what went live from what landed after the publication started", () => {
    const result = annotateDeployCommits({
      unshipped: [C],
      runCommits: [A],
      running: false,
      outcome: "success",
    });
    expect(result).toEqual([
      { ...A, state: "deployed" },
      { ...C, state: "pending" },
    ]);
  });

  it("says plainly, on every line, that a failed run put nothing online", () => {
    const result = annotateDeployCommits({
      unshipped: [A, B],
      runCommits: [A, B],
      running: false,
      outcome: "failed",
    });
    expect(result.map((commit) => commit.state)).toEqual(["failed", "failed"]);
  });
});

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

describe("sanitizeAgentFailureReason", () => {
  it("drops the model/level/time/cost header and keeps the real cause", () => {
    const summary = [
      "**Modèle : Codex très haut · 12 min · coût ≈ 26 CHF (0,2 h × 130 CHF/h)**",
      "La construction a échoué : dépendance manquante.",
    ].join("\n");
    expect(sanitizeAgentFailureReason(summary)).toBe(
      "La construction a échoué : dépendance manquante.",
    );
  });

  it("ignores intermediate progress chatter", () => {
    const summary = [
      "Le moniteur est en place, je serai notifié dès la fin.",
      "Conflit de fusion sur la branche login.",
    ].join("\n");
    expect(sanitizeAgentFailureReason(summary)).toBe("Conflit de fusion sur la branche login.");
  });

  it("prefers the line that names a failure over later prose", () => {
    const summary = [
      "Le serveur a redémarré pendant la publication.",
      "Je vous laisse relancer quand vous voulez.",
    ].join("\n");
    expect(sanitizeAgentFailureReason(summary)).toBe(
      "Le serveur a redémarré pendant la publication.",
    );
  });

  it("returns null when only noise remains", () => {
    const summary = "**Codex très haut · 8 min · ≈ 17 CHF**\nLe moniteur est en place.";
    expect(sanitizeAgentFailureReason(summary)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(sanitizeAgentFailureReason("")).toBeNull();
    expect(sanitizeAgentFailureReason(null)).toBeNull();
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
