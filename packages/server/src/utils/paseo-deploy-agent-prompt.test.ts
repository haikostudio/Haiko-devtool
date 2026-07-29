import { describe, expect, it } from "vitest";
import { buildPaseoDeployAgentPrompt } from "./paseo-deploy-agent-prompt.js";

const LAUNCH = {
  repoRoot: "/root/paseo",
  shipScript: "/home/paseo/paseo-build-local.sh",
  logFile: "/home/paseo/paseo-ship-now.log",
  phaseFile: "/home/paseo/paseo-build-local.phase",
  mergedBranches: [] as string[],
};

describe("buildPaseoDeployAgentPrompt", () => {
  it("hands the agent the one script that publishes, in the deploy checkout", () => {
    const prompt = buildPaseoDeployAgentPrompt(LAUNCH);
    expect(prompt).toContain(LAUNCH.shipScript);
    expect(prompt).toContain(LAUNCH.repoRoot);
    expect(prompt).toContain(LAUNCH.phaseFile);
  });

  it("requires the live marker to be checked before claiming a publication", () => {
    // The agent's own impression is not evidence: the verdict is the served
    // marker matching HEAD. Without this the sheet would go back to reporting
    // success for builds that never reached the site.
    const prompt = buildPaseoDeployAgentPrompt(LAUNCH);
    expect(prompt).toContain(".deployed-sha");
    expect(prompt).toContain("git rev-parse HEAD");
  });

  it("keeps the agent on the batch until success or a proven non-repairable failure", () => {
    const prompt = buildPaseoDeployAgentPrompt(LAUNCH);
    expect(prompt).toContain("Ne modifie jamais le code de l'application");
    expect(prompt).toContain("Après chaque correction ciblée, relance le script");
    expect(prompt).toContain("Ne fais jamais de relance aveugle");
    expect(prompt).toContain("Ne quitte jamais sur un simple délai d'attente");
  });

  it("keeps the session alive and leaves the final restart to the batch orchestrator", () => {
    const prompt = buildPaseoDeployAgentPrompt(LAUNCH);
    expect(prompt).toContain('wait "$publication_pid"');
    expect(prompt).toContain("archive les cartes publiées");
    expect(prompt).toContain("déclenche le redémarrage final automatiquement");
    expect(prompt).toContain("Si au moins une carte du lot demande un redémarrage");
  });

  it("names the ateliers folded into this publication, and says so when there are none", () => {
    expect(buildPaseoDeployAgentPrompt(LAUNCH)).toContain("Aucun atelier à fusionner");
    const withBranches = buildPaseoDeployAgentPrompt({
      ...LAUNCH,
      mergedBranches: ["task/corriger-le-voyant", "task/quotas"],
    });
    expect(withBranches).toContain("task/corriger-le-voyant, task/quotas");
  });
});
