import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { extractTurnFileChanges } from "./turn-recap-files.js";

function edit(filePath: string, status: "completed" | "failed" = "completed"): AgentTimelineItem {
  return {
    type: "tool_call",
    callId: `edit:${filePath}:${status}`,
    name: "Edit",
    detail: { type: "edit", filePath },
    status,
    error: status === "failed" ? new Error("nope") : null,
  } as AgentTimelineItem;
}

function write(filePath: string, status: "completed" | "failed" = "completed"): AgentTimelineItem {
  return {
    type: "tool_call",
    callId: `write:${filePath}:${status}`,
    name: "Write",
    detail: { type: "write", filePath },
    status,
    error: status === "failed" ? new Error("nope") : null,
  } as AgentTimelineItem;
}

function read(filePath: string): AgentTimelineItem {
  return {
    type: "tool_call",
    callId: `read:${filePath}`,
    name: "Read",
    detail: { type: "read", filePath },
    status: "completed",
    error: null,
  } as AgentTimelineItem;
}

describe("extractTurnFileChanges", () => {
  it("marks edited files as edited and written files as created", () => {
    expect(extractTurnFileChanges([edit("a.ts"), write("b.ts")])).toEqual([
      { path: "a.ts", operation: "edited" },
      { path: "b.ts", operation: "created" },
    ]);
  });

  it("dedupes by path in first-seen order", () => {
    expect(extractTurnFileChanges([edit("a.ts"), edit("a.ts"), edit("b.ts")])).toEqual([
      { path: "a.ts", operation: "edited" },
      { path: "b.ts", operation: "edited" },
    ]);
  });

  it("lets edited win over created regardless of order (a write never downgrades an edit)", () => {
    expect(extractTurnFileChanges([write("a.ts"), edit("a.ts")])).toEqual([
      { path: "a.ts", operation: "edited" },
    ]);
    expect(extractTurnFileChanges([edit("b.ts"), write("b.ts")])).toEqual([
      { path: "b.ts", operation: "edited" },
    ]);
  });

  it("ignores reads and non-completed tool calls", () => {
    expect(
      extractTurnFileChanges([read("a.ts"), edit("b.ts", "failed"), write("c.ts", "failed")]),
    ).toEqual([]);
  });

  it("ignores non-tool-call items", () => {
    const items: AgentTimelineItem[] = [
      { type: "user_message", text: "hi" },
      { type: "assistant_message", text: "done" },
      edit("a.ts"),
    ];
    expect(extractTurnFileChanges(items)).toEqual([{ path: "a.ts", operation: "edited" }]);
  });

  it("skips blank paths", () => {
    expect(extractTurnFileChanges([edit("   "), write("real.ts")])).toEqual([
      { path: "real.ts", operation: "created" },
    ]);
  });
});
