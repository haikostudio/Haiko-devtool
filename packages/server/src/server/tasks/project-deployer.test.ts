import pino from "pino";
import { describe, expect, test } from "vitest";
import { type CommandResult, ProjectDeployer, type ProjectDeployExec } from "./project-deployer.js";

const logger = pino({ level: "silent" });

/** A programmable command double: last matching rule wins, default is exit 0. */
class ExecRecorder implements ProjectDeployExec {
  readonly gitCalls: string[][] = [];
  readonly execCalls: { command: string; args: string[] }[] = [];
  private gitRules: { match: (args: string[]) => boolean; result: CommandResult }[] = [];
  private execRules: {
    match: (command: string, args: string[]) => boolean;
    result: CommandResult;
  }[] = [];

  onGit(match: (args: string[]) => boolean, result: Partial<CommandResult>): this {
    this.gitRules.push({ match, result: { exitCode: 0, stdout: "", stderr: "", ...result } });
    return this;
  }

  onExec(
    match: (command: string, args: string[]) => boolean,
    result: Partial<CommandResult>,
  ): this {
    this.execRules.push({
      match: match as (command: string, args: string[]) => boolean,
      result: { exitCode: 0, stdout: "", stderr: "", ...result },
    });
    return this;
  }

  git = async (args: string[]): Promise<CommandResult> => {
    this.gitCalls.push(args);
    for (let i = this.gitRules.length - 1; i >= 0; i -= 1) {
      if (this.gitRules[i].match(args)) {
        return this.gitRules[i].result;
      }
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  exec = async (command: string, args: string[]): Promise<CommandResult> => {
    this.execCalls.push({ command, args });
    for (let i = this.execRules.length - 1; i >= 0; i -= 1) {
      if (this.execRules[i].match(command, args)) {
        return this.execRules[i].result;
      }
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

/** Waits for a background run to reach a terminal outcome. */
async function settle(
  deployer: ProjectDeployer,
  rootPath: string,
): Promise<"success" | "failed" | null> {
  for (let i = 0; i < 200; i += 1) {
    const run = deployer.readRun(rootPath);
    if (!run.deploying && run.outcome) {
      return run.outcome;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return deployer.readRun(rootPath).outcome;
}

/** An instance whose site answers healthily and whose service comes back active. */
function healthyExec(): ExecRecorder {
  return new ExecRecorder()
    .onExec((c, a) => c === "systemctl" && a[0] === "is-active", { stdout: "active" })
    .onExec((c) => c === "curl", { stdout: "200" });
}

describe("ProjectDeployer", () => {
  const rootPath = "/root/formations";

  test("commits each card separately, pushes, restarts the service once, verifies", async () => {
    const exec = healthyExec().onGit((a) => a[0] === "diff", { exitCode: 1 });
    const deployer = new ProjectDeployer({ exec, logger });

    const { started } = deployer.trigger({
      rootPath,
      slug: "formations",
      url: "https://formations.haikostudio.cloud",
      cards: [{ title: "Login" }, { title: "Signup" }],
    });
    expect(started).toBe(true);
    expect(await settle(deployer, rootPath)).toBe("success");

    // One commit per card, message = its title — never one global commit.
    const commits = exec.gitCalls.filter((a) => a[0] === "commit");
    expect(commits).toEqual([
      ["commit", "-m", "Login"],
      ["commit", "-m", "Signup"],
    ]);
    expect(exec.gitCalls.filter((a) => a[0] === "push")).toHaveLength(1);
    // Exactly ONE restart for the lot, on the project's own service.
    const restarts = exec.execCalls.filter(
      (call) => call.command === "sudo" && call.args.includes("restart"),
    );
    expect(restarts).toEqual([
      { command: "sudo", args: ["systemctl", "restart", "autoproject-formations"] },
    ]);
  });

  test("skips a card with nothing to commit instead of failing", async () => {
    // diff --cached --quiet exits 0 => index clean => nothing to commit.
    const exec = healthyExec().onGit((a) => a[0] === "diff", { exitCode: 0 });
    const deployer = new ProjectDeployer({ exec, logger });

    deployer.trigger({ rootPath, slug: "formations", url: null, cards: [{ title: "Login" }] });
    expect(await settle(deployer, rootPath)).toBe("success");
    expect(exec.gitCalls.filter((a) => a[0] === "commit")).toHaveLength(0);
  });

  test("a failed restart fails the publication", async () => {
    const exec = healthyExec()
      .onGit((a) => a[0] === "diff", { exitCode: 1 })
      .onExec((c, a) => c === "sudo" && a.includes("restart"), {
        exitCode: 1,
        stderr: "unit not found",
      });
    const deployer = new ProjectDeployer({ exec, logger });

    deployer.trigger({ rootPath, slug: "formations", url: null, cards: [{ title: "Login" }] });
    expect(await settle(deployer, rootPath)).toBe("failed");
    expect(deployer.readRun(rootPath).error).toContain("unit not found");
  });

  test("a service that never comes back active fails the publication", async () => {
    const exec = new ExecRecorder()
      .onGit((a) => a[0] === "diff", { exitCode: 1 })
      .onExec((c, a) => c === "systemctl" && a[0] === "is-active", { stdout: "failed" });
    const deployer = new ProjectDeployer({ exec, logger });

    deployer.trigger({ rootPath, slug: "formations", url: null, cards: [{ title: "Login" }] });
    expect(await settle(deployer, rootPath)).toBe("failed");
    expect(deployer.readRun(rootPath).error).toContain("pas actif");
  });

  test("refuses a second run while one is already active for the same checkout", async () => {
    // A curl that never resolves holds the first run open past the second trigger.
    let releaseCurl: (() => void) | null = null;
    const exec = new ExecRecorder()
      .onGit((a) => a[0] === "diff", { exitCode: 1 })
      .onExec((c, a) => c === "systemctl" && a[0] === "is-active", { stdout: "active" });
    exec.exec = async (command, args) => {
      exec.execCalls.push({ command, args });
      if (command === "curl") {
        await new Promise<void>((resolve) => {
          releaseCurl = resolve;
        });
        return { exitCode: 0, stdout: "200", stderr: "" };
      }
      if (command === "systemctl" && args[0] === "is-active") {
        return { exitCode: 0, stdout: "active", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const deployer = new ProjectDeployer({ exec, logger });

    const first = deployer.trigger({
      rootPath,
      slug: "formations",
      url: "https://formations.haikostudio.cloud",
      cards: [{ title: "Login" }],
    });
    expect(first.started).toBe(true);
    // Let the first run advance to the (blocked) curl verify.
    for (let i = 0; i < 50; i += 1) {
      if (exec.execCalls.some((call) => call.command === "curl")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    const second = deployer.trigger({
      rootPath,
      slug: "formations",
      url: "https://formations.haikostudio.cloud",
      cards: [{ title: "Signup" }],
    });
    expect(second.started).toBe(false);
    expect(second.error).toContain("déjà en cours");

    releaseCurl?.();
    expect(await settle(deployer, rootPath)).toBe("success");
  });
});
