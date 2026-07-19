import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "../../server/agent/agent-sdk-types.js";
import { summarizeTurnActions } from "./turn-actions.js";

function shell(command: string): AgentTimelineItem {
  return {
    type: "tool_call",
    callId: `call-${command.length}-${command.slice(0, 8)}`,
    name: "Bash",
    status: "completed",
    error: null,
    detail: { type: "shell", command },
  } as AgentTimelineItem;
}

function edit(filePath: string): AgentTimelineItem {
  return {
    type: "tool_call",
    callId: `edit-${filePath}`,
    name: "Edit",
    status: "completed",
    error: null,
    detail: { type: "edit", filePath },
  } as AgentTimelineItem;
}

describe("summarizeTurnActions", () => {
  it("returns null when no durable action happened", () => {
    expect(
      summarizeTurnActions([
        shell("ls -la"),
        shell("npm run typecheck"),
        edit("src/foo.ts"),
        { type: "assistant_message", text: "voilà" } as AgentTimelineItem,
      ]),
    ).toBeNull();
  });

  it("ignores bare file edits (visible in the code, would be noise)", () => {
    expect(summarizeTurnActions([edit("a.ts"), edit("b.ts")])).toBeNull();
  });

  it("extracts the commit message from a git commit", () => {
    const summary = summarizeTurnActions([shell('git commit -m "feat: ajoute le bandeau"')]);
    expect(summary).toBe("- commit : « feat: ajoute le bandeau »");
  });

  it("captures pushes and deploys as commands", () => {
    const summary = summarizeTurnActions([
      shell("git push origin feat/x"),
      shell("systemctl restart paseo.service"),
    ]);
    expect(summary).toContain("- git push origin feat/x");
    expect(summary).toContain("- systemctl restart paseo.service");
  });

  it("dedupes identical commit messages", () => {
    const summary = summarizeTurnActions([
      shell('git commit -m "same"'),
      shell('git commit -m "same"'),
    ]);
    expect(summary).toBe("- commit : « same »");
  });

  it("orders commits before other commands", () => {
    const summary = summarizeTurnActions([shell("git push"), shell('git commit -m "msg"')]);
    expect(summary).toBe("- commit : « msg »\n- git push");
  });

  it("does not false-positive on lookalike words", () => {
    expect(summarizeTurnActions([shell("cat .gitignore"), shell("echo released_at")])).toBeNull();
  });
});
