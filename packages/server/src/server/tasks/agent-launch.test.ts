import { describe, expect, test } from "vitest";
import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import {
  ANALYSIS_FALLBACK_ESTIMATE,
  buildTaskAnalysisPrompt,
  buildTaskExecutionPrompt,
  parseTaskAnalysisEstimate,
} from "./agent-launch.js";

// The two "light task" thresholds the scheduler uses (scheduler.ts). The
// fallback must read as light so unknown work is governed by the quota gate,
// not blindly parked until quiet hours.
const LIGHT_TASK_MAX_QUOTA_PCT = 25;
const LIGHT_TASK_MAX_MINUTES = 45;

function makeTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "task-1",
    folderId: "folder-1",
    title: "Ajouter la connexion",
    tags: [],
    column: "validated",
    order: 0,
    origin: "manual",
    normalizedTitle: "ajouter la connexion",
    links: { agentIds: [] },
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
    ...overrides,
  };
}

describe("task analysis estimation", () => {
  test("the fallback is a short agent runtime that reads as a light task", () => {
    // Not a flat human-scale hour: this is the LLM's own (fast) runtime.
    expect(ANALYSIS_FALLBACK_ESTIMATE.estimatedMinutes).toBeLessThan(LIGHT_TASK_MAX_MINUTES);
    expect(ANALYSIS_FALLBACK_ESTIMATE.quotaPercent).toBeLessThan(LIGHT_TASK_MAX_QUOTA_PCT);
    expect(ANALYSIS_FALLBACK_ESTIMATE.confidence).toBe("low");
  });

  test("the prompt separates the two time dimensions and targets the run model", () => {
    const prompt = buildTaskAnalysisPrompt({
      task: makeTask({ runConfig: { provider: "codex", model: "gpt-5.4" } }),
      planMode: false,
      branch: "task/login",
    });
    // The card-facing machine time and the billing human effort are distinct fields.
    expect(prompt).toContain("estimatedMinutes");
    expect(prompt).toContain("billingHours");
    // estimatedMinutes is explicitly the agent's own runtime, not human effort.
    expect(prompt).toMatch(/estimatedMinutes[\s\S]*EXÉCUTER/);
    // Quota/tokens are sized for the task's actual target model.
    expect(prompt).toContain("codex/gpt-5.4");
  });

  test("defaults to claude in the prompt when no runConfig is set", () => {
    const prompt = buildTaskAnalysisPrompt({
      task: makeTask(),
      planMode: false,
      branch: "task/login",
    });
    expect(prompt).toContain("Agent d'exécution : claude");
  });

  test("a task with no images yields a plain string prompt (unchanged)", () => {
    expect(
      typeof buildTaskAnalysisPrompt({ task: makeTask(), planMode: false, branch: null }),
    ).toBe("string");
    expect(
      typeof buildTaskExecutionPrompt({ task: makeTask(), planMode: false, branch: null }),
    ).toBe("string");
  });

  test("attached pictures ride along as image blocks after the task text", () => {
    const task = makeTask({
      images: [
        { data: "aGVsbG8=", mimeType: "image/png" },
        { data: "d29ybGQ=", mimeType: "image/jpeg" },
      ],
    });
    for (const prompt of [
      buildTaskAnalysisPrompt({ task, planMode: false, branch: "task/login" }),
      buildTaskExecutionPrompt({ task, planMode: false, branch: "task/login" }),
    ]) {
      expect(Array.isArray(prompt)).toBe(true);
      const blocks = prompt as Array<{ type: string; text?: string; data?: string }>;
      // Text first, then one image block per attachment in order.
      expect(blocks[0]?.type).toBe("text");
      expect(blocks[0]?.text).toContain("Ajouter la connexion");
      expect(blocks.slice(1).map((block) => block.type)).toEqual(["image", "image"]);
      expect(blocks[1]?.data).toBe("aGVsbG8=");
    }
  });

  test("parses a trailing json estimate with both dimensions", () => {
    const parsed = parseTaskAnalysisEstimate(
      [
        "Analyse : petite tâche.",
        "```json",
        '{"tokens": 40000, "quotaPercent": 6, "estimatedMinutes": 8, "confidence": "high",',
        ' "summary": "Petit ajout", "billingHours": 3}',
        "```",
      ].join("\n"),
    );
    expect(parsed?.estimatedMinutes).toBe(8);
    expect(parsed?.billingHours).toBe(3);
  });
});
