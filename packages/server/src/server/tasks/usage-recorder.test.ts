import { describe, expect, test } from "vitest";
import { TaskUsageRecorder } from "./usage-recorder.js";
import { createTestLogger } from "../../test-utils/test-logger.js";

const logger = createTestLogger();

interface RecordedCall {
  projectId: string;
  taskId: string;
  delta: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    costUsd: number;
    turns: number;
  };
}

function buildRecorder(input?: { projectId?: string | null; agentIds?: string[] }) {
  const calls: RecordedCall[] = [];
  const recorder = new TaskUsageRecorder({
    taskBoardService: {
      getBoard: async () =>
        ({
          tasks: [{ id: "task-1", links: { agentIds: input?.agentIds ?? ["agent-1"] } }],
        }) as never,
      addTaskUsage: async (projectId, taskId, delta) => {
        calls.push({ projectId, taskId, delta });
        return null;
      },
    },
    resolveProjectId: async () => (input?.projectId === undefined ? "proj-1" : input.projectId),
    logger,
    flushIntervalMs: 10_000,
  });
  return { recorder, calls };
}

function usageDelta(overrides: Partial<RecordedCall["delta"]> = {}) {
  return {
    timestamp: new Date("2026-07-30T12:00:00.000Z"),
    agentId: "agent-1",
    projectKey: "/root/x",
    projectName: "x",
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costUsd: 0,
    turns: 0,
    ...overrides,
  };
}

describe("TaskUsageRecorder", () => {
  test("sums several deltas into a single write", async () => {
    // Un fournisseur annonce sa consommation plusieurs fois par tour : écrire à
    // chaque annonce réécrirait le tableau des dizaines de fois par minute.
    const { recorder, calls } = buildRecorder();

    recorder.note(usageDelta({ inputTokens: 100, outputTokens: 10, turns: 1 }));
    recorder.note(usageDelta({ inputTokens: 50, outputTokens: 5 }));
    await recorder.flush();
    recorder.dispose();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      projectId: "proj-1",
      taskId: "task-1",
      delta: { inputTokens: 150, outputTokens: 15, turns: 1 },
    });
  });

  test("writes nothing when the agent belongs to no card", async () => {
    const { recorder, calls } = buildRecorder({ agentIds: ["someone-else"] });

    recorder.note(usageDelta({ outputTokens: 42 }));
    await recorder.flush();
    recorder.dispose();

    expect(calls).toEqual([]);
  });

  test("writes nothing when the agent belongs to no project", async () => {
    const { recorder, calls } = buildRecorder({ projectId: null });

    recorder.note(usageDelta({ outputTokens: 42 }));
    await recorder.flush();
    recorder.dispose();

    expect(calls).toEqual([]);
  });

  test("does not replay an already-written batch", async () => {
    const { recorder, calls } = buildRecorder();

    recorder.note(usageDelta({ outputTokens: 10 }));
    await recorder.flush();
    await recorder.flush();
    recorder.dispose();

    expect(calls).toHaveLength(1);
  });

  test("ignores a negative counter instead of subtracting from the total", async () => {
    // Un compteur qui recule est un changement de session côté fournisseur, pas
    // une consommation négative : le total d'une carte ne diminue jamais.
    const { recorder, calls } = buildRecorder();

    recorder.note(usageDelta({ inputTokens: -500, outputTokens: 20 }));
    await recorder.flush();
    recorder.dispose();

    expect(calls[0]?.delta).toMatchObject({ inputTokens: 0, outputTokens: 20 });
  });
});
