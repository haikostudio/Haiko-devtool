import { describe, expect, it } from "vitest";
import { needsDaemonRestartForFiles } from "./restart-impact.js";

describe("needsDaemonRestartForFiles", () => {
  it("asks for a restart when the daemon's own code changed", () => {
    expect(needsDaemonRestartForFiles(["packages/server/src/server/tasks/service.ts"])).toBe(true);
  });

  it("asks for a restart for the packages compiled into the daemon", () => {
    expect(needsDaemonRestartForFiles(["packages/protocol/src/tasks/types.ts"])).toBe(true);
    expect(needsDaemonRestartForFiles(["packages/relay/src/index.ts"])).toBe(true);
    expect(needsDaemonRestartForFiles(["packages/highlight/src/index.ts"])).toBe(true);
  });

  it("stays silent for an app-only change (a republication is enough)", () => {
    expect(
      needsDaemonRestartForFiles([
        "packages/app/src/components/tasks/task-card.tsx",
        "packages/website/src/index.astro",
      ]),
    ).toBe(false);
  });

  it("asks for a restart for the CLI, which is the daemon's own entry point", () => {
    expect(needsDaemonRestartForFiles(["packages/cli/src/main.ts"])).toBe(true);
  });

  it("stays silent for the desktop wrapper, a separate process", () => {
    expect(needsDaemonRestartForFiles(["packages/desktop/src/main.ts"])).toBe(false);
  });

  it("ignores files the daemon never loads, even under a daemon package", () => {
    expect(
      needsDaemonRestartForFiles([
        "packages/server/src/server/tasks/service.test.ts",
        "packages/server/CLAUDE.md",
        "docs/architecture.md",
      ]),
    ).toBe(false);
  });

  it("flags a mixed change as needing a restart", () => {
    // One daemon-side file among app work is enough: the failure the user feels
    // is an unannounced restart, never a redundant one.
    expect(
      needsDaemonRestartForFiles([
        "packages/app/src/components/tasks/task-card.tsx",
        "packages/server/src/server/tasks/restart-impact.ts",
      ]),
    ).toBe(true);
  });

  it("says no when nothing changed", () => {
    expect(needsDaemonRestartForFiles([])).toBe(false);
  });
});
