import pino from "pino";
import { describe, expect, it } from "vitest";
import {
  CONDUCTOR_ROLE_LABEL,
  CONDUCTOR_ROLE_VALUE,
  DEPLOYMENT_ROLE_VALUE,
} from "@getpaseo/protocol/agent-labels";
import type { KanbanTask, TaskBoard, TaskColumn } from "@getpaseo/protocol/tasks/types";
import { injectResponseFormat, responseFormatBody } from "../../services/response-format.js";
import { TASK_AGENT_LABEL } from "./agent-launch.js";
import {
  createTaskResponseTemplateHook,
  resolveTaskResponseTemplate,
} from "./response-template.js";

const logger = pino({ level: "silent" });

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
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    ...overrides,
  };
}

function makeBoard(tasks: KanbanTask[]): TaskBoard {
  return { version: 1, projectId: "project-1", folders: [], tasks };
}

interface HookHarnessOptions {
  task?: KanbanTask | null;
  labels?: Record<string, string>;
  workspaceId?: string | null;
  projectId?: string | null;
}

function makeHook(options: HookHarnessOptions = {}) {
  const task = options.task === undefined ? makeTask() : options.task;
  const labels = options.labels ?? { [TASK_AGENT_LABEL]: "task-1" };
  const workspaceId = options.workspaceId === undefined ? "workspace-1" : options.workspaceId;
  const projectId = options.projectId === undefined ? "project-1" : options.projectId;
  let boardReads = 0;
  const hook = createTaskResponseTemplateHook({
    agentManager: {
      getAgent: () =>
        ({ id: "agent-1", labels, workspaceId }) as unknown as ReturnType<
          Parameters<typeof createTaskResponseTemplateHook>[0]["agentManager"]["getAgent"]
        >,
    },
    workspaceRegistry: {
      get: async () => (projectId ? ({ projectId } as never) : undefined),
    },
    taskBoardService: {
      getBoard: async () => {
        boardReads += 1;
        return makeBoard(task ? [task] : []);
      },
    },
    logger,
  });
  return { hook, boardReads: () => boardReads };
}

describe("resolveTaskResponseTemplate", () => {
  const cases: [TaskColumn, string][] = [
    ["validated", "analysis"],
    ["scheduled", "analysis"],
    ["in_progress", "progress"],
    ["done", "progress"],
    // "À déployer" is the publication QUEUE: the card still reports its work.
    ["deployed", "progress"],
    ["backlog", "default"],
    ["notes", "default"],
  ];

  for (const [column, expected] of cases) {
    it(`maps "${column}" to the ${expected} template`, () => {
      expect(resolveTaskResponseTemplate(makeTask({ column }))).toBe(expected);
    });
  }

  it("a card's check state never steers the template any more", () => {
    // Finishing a card is a plain move: no agent turn happens in "En cours"
    // beyond the work itself, so a card carrying validation state (a leftover
    // from an older daemon) still reports its work.
    for (const state of ["running", "passed", "failed"] as const) {
      expect(
        resolveTaskResponseTemplate(
          makeTask({
            column: "in_progress",
            validation: { state, checkedAt: "2026-07-28T12:00:00.000Z" },
          }),
        ),
      ).toBe("progress");
    }
  });

  it("a running publication wins over the column it started from", () => {
    const task = makeTask({ column: "done", deployment: { state: "running" } });
    expect(resolveTaskResponseTemplate(task)).toBe("publication");
  });

  it("work that is live reports a publication, whatever the column says", () => {
    expect(
      resolveTaskResponseTemplate(
        makeTask({ column: "deployed", deployedAt: "2026-07-28T12:00:00.000Z" }),
      ),
    ).toBe("publication");
    expect(
      resolveTaskResponseTemplate(makeTask({ column: "done", deployment: { state: "deployed" } })),
    ).toBe("publication");
  });
});

describe("createTaskResponseTemplateHook", () => {
  it("resolves the template of the card the agent belongs to", async () => {
    const { hook } = makeHook({ task: makeTask({ column: "in_progress" }) });
    expect(await hook({ agentId: "agent-1" })).toBe("progress");
  });

  it("returns null for an agent that is not a card agent", async () => {
    const { hook } = makeHook({ labels: {} });
    expect(await hook({ agentId: "agent-1" })).toBeNull();
  });

  it("returns null when the card no longer exists", async () => {
    const { hook } = makeHook({ task: null });
    expect(await hook({ agentId: "agent-1" })).toBeNull();
  });

  it("returns null when the agent's workspace has no project", async () => {
    const { hook } = makeHook({ projectId: null });
    expect(await hook({ agentId: "agent-1" })).toBeNull();
  });

  it("gives the conductor its own shape, not the generic report", async () => {
    // The conductor carries no card label, so before this it fell through to the
    // five-section report and answered "combien de cartes en attente ?" with a
    // chantier report plus an invoice line.
    const { hook, boardReads } = makeHook({
      labels: { [CONDUCTOR_ROLE_LABEL]: CONDUCTOR_ROLE_VALUE },
    });
    expect(await hook({ agentId: "agent-1" })).toBe("conductor");
    // Decided from the label alone — no board read, no card lookup.
    expect(boardReads()).toBe(0);
  });

  it("gives the grouped-deployment agent the batch publication shape", async () => {
    // It spans several cards, so it carries no card label and would otherwise
    // fall through to the generic report. Its deployment role label routes it
    // straight to the batch publication log — no board read needed.
    const { hook, boardReads } = makeHook({
      labels: { [CONDUCTOR_ROLE_LABEL]: DEPLOYMENT_ROLE_VALUE },
    });
    expect(await hook({ agentId: "agent-1" })).toBe("batchPublication");
    expect(boardReads()).toBe(0);
  });

  it("re-reads the board every time, so moving the card changes the next answer", async () => {
    const { hook, boardReads } = makeHook({
      task: makeTask({ column: "deployed", deployedAt: "2026-07-28T12:00:00.000Z" }),
    });
    expect(await hook({ agentId: "agent-1" })).toBe("publication");
    expect(await hook({ agentId: "agent-1" })).toBe("publication");
    expect(boardReads()).toBe(2);
  });
});

describe("column → sections, end to end", () => {
  it("sends the analysis sections for a validated card", async () => {
    const { hook } = makeHook({ task: makeTask({ column: "validated" }) });
    const template = await hook({ agentId: "agent-1" });
    expect(template).not.toBeNull();
    const body = responseFormatBody(template ?? "default");
    expect(body).toContain("## 1. Objectif");
    expect(body).not.toContain("## 1. Ce qui est fait");
  });

  it("sends the publication sections for a card whose work is live", async () => {
    const { hook } = makeHook({
      task: makeTask({ column: "deployed", deployedAt: "2026-07-28T12:00:00.000Z" }),
    });
    const template = await hook({ agentId: "agent-1" });
    const body = responseFormatBody(template ?? "default");
    expect(body).toContain("## 1. Ce qui a été publié");
    expect(body).not.toContain("Évolutions possibles");
  });

  it("sends the work report to a card being finished, not a check report", async () => {
    const { hook } = makeHook({
      task: makeTask({
        column: "in_progress",
        validation: { state: "running", checkedAt: "2026-07-28T12:00:00.000Z" },
      }),
    });
    const template = await hook({ agentId: "agent-1" });
    expect(template).toBe("progress");
    const body = responseFormatBody(template ?? "default");
    expect(body).toContain("## 1. Ce qui est fait");
    expect(body).not.toContain("## 1. Ce qui a été vérifié");
  });

  it("sends the conductor no sections, no estimate and no billing at all", async () => {
    const { hook } = makeHook({
      labels: { [CONDUCTOR_ROLE_LABEL]: CONDUCTOR_ROLE_VALUE },
    });
    const template = await hook({ agentId: "agent-1" });
    expect(template).toBe("conductor");
    const body = responseFormatBody(template ?? "default");
    // No numbered sections, no model header, no estimate/quota/cost, no billing.
    expect(body).not.toContain("## 1.");
    expect(body).not.toContain("130 CHF/h");
    // Read flat: the body is hard-wrapped, and the sense is what matters.
    const flat = body.replace(/\s+/g, " ");
    expect(flat).toContain("aucune estimation");
    expect(flat).toContain("aucune facturation");
    expect(flat).toContain("aucun en-tête de modèle");
    // A simple question gets a simple answer; touched cards get a bullet recap.
    expect(flat).toContain("1 à 3 phrases de français simple");
    expect(flat).toContain("une puce par carte");
  });

  it("injects the conductor format directive into the prompt actually sent", async () => {
    // Proves the guarantee end to end: the conductor's answer-shape directive is
    // resolved by the hook AND embedded in the prompt envelope the daemon sends
    // on every message — not merely defined somewhere.
    const { hook } = makeHook({
      labels: { [CONDUCTOR_ROLE_LABEL]: CONDUCTOR_ROLE_VALUE },
    });
    const template = await hook({ agentId: "agent-1" });
    expect(template).toBe("conductor");
    const sent = injectResponseFormat("combien de cartes en attente ?", template ?? "default");
    expect(sent).toContain("<paseo-format>");
    expect(sent).toContain(responseFormatBody("conductor"));
    // The conductor never carries the card/report shape it must not use.
    expect(sent).not.toContain("## 1.");
    expect(sent).not.toContain("130 CHF/h");
  });
});
