import { describe, expect, it } from "vitest";
import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import { needsDaemonRestartForFiles, settleDeployedRestartFlags } from "./restart-impact.js";

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

describe("settleDeployedRestartFlags", () => {
  function task(overrides: Partial<KanbanTask> = {}): KanbanTask {
    return {
      id: "t1",
      folderId: "f1",
      title: "Task",
      tags: [],
      column: "deployed",
      order: 0,
      origin: "manual",
      normalizedTitle: "task",
      links: { agentIds: [] },
      createdAt: "2026-07-28T10:00:00.000Z",
      updatedAt: "2026-07-28T10:00:00.000Z",
      ...overrides,
    };
  }

  it("clears the debt of a card whose work is already live", () => {
    // The daemon just booted on the current code: that restart has happened.
    const [settled] = settleDeployedRestartFlags([
      task({ deployedAt: "2026-07-28T11:00:00.000Z", needsDaemonRestart: true }),
    ]);
    expect(settled?.needsDaemonRestart).toBe(false);
  });

  it("keeps the forecast on a card merely QUEUED in « À déployer »", () => {
    // The column is a queue, not a publication: wiping the flag here would lose
    // the "Redémarrage requis" warning before the work has even gone out.
    const [kept] = settleDeployedRestartFlags([
      task({ column: "deployed", needsDaemonRestart: true }),
    ]);
    expect(kept?.needsDaemonRestart).toBe(true);
  });

  it("also clears a done card that was published (deployedUrl stamped)", () => {
    const [settled] = settleDeployedRestartFlags([
      task({ column: "done", deployedUrl: "https://app.example.com", needsDaemonRestart: true }),
    ]);
    expect(settled?.needsDaemonRestart).toBe(false);
  });

  it("keeps the forecast on a card that is not published yet", () => {
    // That flag is about the NEXT publication, which this boot says nothing about.
    const [kept] = settleDeployedRestartFlags([task({ column: "done", needsDaemonRestart: true })]);
    expect(kept?.needsDaemonRestart).toBe(true);
  });

  it("returns the very same array when nothing needed settling", () => {
    // Identity matters: the caller skips the disk write on an unchanged board.
    const tasks = [
      task({ deployedAt: "2026-07-28T11:00:00.000Z", needsDaemonRestart: false }),
      task({ column: "done" }),
    ];
    expect(settleDeployedRestartFlags(tasks)).toBe(tasks);
  });
});
