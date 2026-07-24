import { describe, expect, it } from "vitest";
import {
  AUTO_RESOLVABLE_CONFLICT_PATHS,
  classifyMergeConflicts,
  isPaseoDeployRepairBranch,
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
