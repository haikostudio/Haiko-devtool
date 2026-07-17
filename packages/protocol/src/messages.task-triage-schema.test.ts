import { describe, expect, it } from "vitest";

import { AgentTimelineItemPayloadSchema } from "./messages.js";

describe("task_triage timeline item schema", () => {
  it("parses a proposed variant", () => {
    const parsed = AgentTimelineItemPayloadSchema.parse({
      type: "task_triage",
      status: "proposed",
      proposedCount: 3,
      projectId: "proj-1",
    });
    expect(parsed).toMatchObject({ type: "task_triage", status: "proposed", proposedCount: 3 });
  });

  it("parses a questions variant", () => {
    const parsed = AgentTimelineItemPayloadSchema.parse({
      type: "task_triage",
      status: "questions",
      questions: ["Dans quel dossier ?", "Priorité ?"],
    });
    expect(parsed).toMatchObject({
      type: "task_triage",
      status: "questions",
      questions: ["Dans quel dossier ?", "Priorité ?"],
    });
  });

  it("parses a minimal item (all refinements optional — back-compat)", () => {
    const parsed = AgentTimelineItemPayloadSchema.parse({
      type: "task_triage",
      status: "proposed",
    });
    expect(parsed).toMatchObject({ type: "task_triage", status: "proposed" });
  });

  it("rejects an unknown status", () => {
    const result = AgentTimelineItemPayloadSchema.safeParse({
      type: "task_triage",
      status: "bogus",
    });
    expect(result.success).toBe(false);
  });
});
