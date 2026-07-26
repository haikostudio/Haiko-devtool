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

  it("forbids the two shortcuts that would hurt: patching the app, restarting the engine", () => {
    const prompt = buildPaseoDeployAgentPrompt(LAUNCH);
    expect(prompt).toContain("Ne modifie jamais le code de l'application");
    expect(prompt).toContain("Ne redémarre pas le moteur");
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
