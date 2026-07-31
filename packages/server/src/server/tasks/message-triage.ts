import { z } from "zod";
import type pino from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import {
  buildStructuredAgentResponsePrompt,
  getStructuredAgentResponse,
} from "../agent/agent-response-loop.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import {
  type TaskChatProposal,
  type TaskRunConfig,
  TaskRunConfigSchema,
} from "@getpaseo/protocol/tasks/types";
import type { TaskBoardService } from "./service.js";
import { generateTaskEntityId } from "./store.js";

const DEFAULT_TRIAGE_PROVIDER_MODEL = "claude/haiku";

// Default folder for triaged tasks when the LLM doesn't map to an existing one.
const DEFAULT_TRIAGE_FOLDER = "Boîte de réception";

const TriageTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  folderName: z.string().optional(),
  tags: z.array(z.string()).default([]),
  runConfig: TaskRunConfigSchema.optional(),
});

const MessageTriageResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("questions"),
    questions: z.array(z.string().min(1)).min(1).max(3),
  }),
  z.object({
    kind: z.literal("tasks"),
    tasks: z.array(TriageTaskSchema).min(1).max(5),
  }),
]);

type MessageTriageResult = z.infer<typeof MessageTriageResultSchema>;

// Task-intent phrases (FR + EN), matched against accent-stripped lowercase text.
// Deliberately recall-biased: the Haiku layer is the precision filter and can
// return "none", so a false positive here only costs one cheap LLM call.
const TASK_INTENT_PATTERNS: RegExp[] = [
  // FR
  /\bajoute[rz]?\b.*\b(aux|a la|en)\b.*\b(taches?|todo|liste)\b/,
  /\bcree[rz]?\b.*\btaches?\b/,
  /\bnote\b.*\b(comme )?(une )?taches?\b/,
  /\ba faire\b/,
  /\bil (faut|faudrait)\b/,
  /\brappelle[- ]?moi\b/,
  /\ba ajouter\b/,
  /\btaches? a\b/,
  /\btodo\b/,
  // EN
  /\badd\b.*\b(a |this |these )?(task|todo|ticket)/,
  /\bcreate\b.*\btask/,
  /\bremind me\b/,
  /\bto-?do\b/,
  /\bneed to\b/,
  /\bmake (a )?ticket\b/,
];

/**
 * Cheap synchronous gate so we only spend a Haiku call on messages that plausibly
 * ask for task creation. Runs before any agent is spawned.
 */
export function matchesTaskIntent(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 8) {
    return false;
  }
  const normalized = trimmed
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return TASK_INTENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

interface MessageTriageOptions {
  agentManager: Pick<AgentManager, "runAgent" | "archiveAgent" | "appendTimelineItem" | "getAgent">;
  createAgent: BoundCreateAgentCommand;
  taskBoardService: TaskBoardService;
  // Resolves the project a chat message belongs to (null = no board, skip triage).
  resolveProjectId: (agentId: string) => Promise<string | null>;
  // Absolute checkout path for the project, so the triage agent can read context.
  resolveProjectCwd: (projectId: string) => Promise<string | null>;
  providerModel?: string;
  logger: pino.Logger;
}

/**
 * Inline task-intent triage. When a user's chat message looks like it wants
 * task(s) created, a short-lived internal Haiku agent reads the message + the
 * project's folder list and either proposes task(s) (created awaiting approval)
 * or asks clarifying questions (surfaced as an in-thread pill). Entirely
 * fire-and-forget: it never blocks or hijacks the normal agent turn, and any
 * failure results in doing nothing (no error is ever surfaced to the user).
 */
export class MessageTriage {
  private readonly agentManager: Pick<
    AgentManager,
    "runAgent" | "archiveAgent" | "appendTimelineItem" | "getAgent"
  >;
  private readonly createAgent: BoundCreateAgentCommand;
  private readonly taskBoardService: TaskBoardService;
  private readonly resolveProjectId: (agentId: string) => Promise<string | null>;
  private readonly resolveProjectCwd: (projectId: string) => Promise<string | null>;
  private readonly providerModel: string;
  private readonly logger: pino.Logger;
  private readonly queue: { agentId: string; text: string }[] = [];
  private processing = false;

  constructor(options: MessageTriageOptions) {
    this.agentManager = options.agentManager;
    this.createAgent = options.createAgent;
    this.taskBoardService = options.taskBoardService;
    this.resolveProjectId = options.resolveProjectId;
    this.resolveProjectCwd = options.resolveProjectCwd;
    this.providerModel = options.providerModel ?? DEFAULT_TRIAGE_PROVIDER_MODEL;
    this.logger = options.logger.child({ module: "message-triage" });
  }

  /** Fire-and-forget: enqueue a message for triage if it trips the intent gate. */
  triage(input: { agentId: string; text: string }): void {
    if (!matchesTaskIntent(input.text)) {
      return;
    }
    this.queue.push({ agentId: input.agentId, text: input.text });
    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing) {
      return;
    }
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift();
        if (!next) {
          break;
        }
        try {
          await this.process(next.agentId, next.text);
        } catch (error) {
          this.logger.debug({ err: error, agentId: next.agentId }, "Message triage failed");
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async process(agentId: string, text: string): Promise<void> {
    const projectId = await this.resolveProjectId(agentId);
    if (!projectId) {
      return;
    }
    const cwd = await this.resolveProjectCwd(projectId);
    if (!cwd) {
      return;
    }
    const board = await this.taskBoardService.getBoard(projectId);
    const folderNames = board.folders.map((folder) => folder.name);

    const result = await this.runTriageAgent({ cwd, text, folderNames });
    if (!result || result.kind === "none") {
      return;
    }

    if (result.kind === "questions") {
      await this.emitTriagePill(agentId, {
        type: "task_triage",
        status: "questions",
        questions: result.questions,
        projectId,
      });
      return;
    }

    // A proposal writes NOTHING to the board: it is created only when the user
    // approves it from the chat pill. Each carries a stable proposalId (the key
    // the approval RPC uses to stay idempotent) and its full payload, so the
    // approval can materialise the exact task without any pre-created card.
    const proposed: TaskChatProposal[] = [];
    for (const task of result.tasks) {
      // Same rule as the conductor's create_task: a task born from a chat message
      // runs on the engine the user was talking to, unless triage proposed one.
      const runConfig = sanitizeRunConfig(task.runConfig) ?? this.sourceAgentRunConfig(agentId);
      const entry: TaskChatProposal = {
        proposalId: generateTaskEntityId(),
        title: task.title,
        folderName: task.folderName?.trim() || DEFAULT_TRIAGE_FOLDER,
      };
      if (task.description) {
        entry.description = task.description;
      }
      if (task.tags.length > 0) {
        entry.tags = task.tags;
      }
      if (runConfig !== undefined) {
        entry.runConfig = runConfig;
      }
      proposed.push(entry);
    }

    if (proposed.length > 0) {
      await this.emitTriagePill(agentId, {
        type: "task_triage",
        status: "proposed",
        proposedCount: proposed.length,
        projectId,
        // Full payloads let the client render approve/refuse/edit cards and, on
        // approval, create the task in "À faire" — nothing is on the board yet.
        tasks: proposed,
      });
    }
  }

  private async emitTriagePill(agentId: string, item: AgentTimelineItem): Promise<void> {
    try {
      await this.agentManager.appendTimelineItem(agentId, item);
    } catch (error) {
      this.logger.debug({ err: error, agentId }, "Triage timeline emit failed");
    }
  }

  private async runTriageAgent(input: {
    cwd: string;
    text: string;
    folderNames: string[];
  }): Promise<MessageTriageResult | null> {
    const folderList = input.folderNames.length > 0 ? input.folderNames.join(", ") : "(aucun)";
    const basePrompt = [
      "Tu es un agent de tri de tâches. On te donne UN message qu'un utilisateur vient d'envoyer à son agent de code — l'agent principal traite déjà ce message et va agir dessus. On te donne aussi la liste des dossiers de tâches du projet.",
      "Détermine si ce message demande d'ajouter une ou plusieurs tâches au board du projet, EN PLUS du travail que l'agent principal fait déjà.",
      "Tu peux lire quelques fichiers du dépôt (lecture seule) UNIQUEMENT si c'est nécessaire pour formuler des titres pertinents.",
      "",
      "Message de l'utilisateur :",
      '"""',
      input.text,
      '"""',
      "",
      `Dossiers existants du projet : ${folderList}`,
      "",
      "Réponds avec :",
      "- kind=\"tasks\" et un tableau de tâches si l'utilisateur demande explicitement d'ajouter des tâches (« ajoute ça aux tâches », « crée une tâche pour », « note pour plus tard »). Chaque tâche : titre court à l'impératif, description optionnelle reprenant le contexte utile, folderName choisi parmi les dossiers existants ou un nouveau nom pertinent, tags optionnels.",
      '- kind="questions" et 1 à 3 questions courtes UNIQUEMENT si l\'utilisateur demande explicitement des tâches mais que le découpage ou le dossier reste ambigu.',
      '- kind="none" dans tous les autres cas.',
      "IMPORTANT : du feedback direct à l'agent, un signalement de bug ou une instruction immédiate (« corrige X », « le champ doit prendre toute la largeur », « il faut que Y ») n'est PAS une demande de création de tâche — l'agent principal s'en occupe déjà. Réponds none. Dans le doute, réponds none.",
      "Ne crée jamais de tâche pour du bavardage, une simple question technique, ou une instruction que l'agent principal exécute déjà.",
    ].join("\n");

    let agentId: string | null = null;
    try {
      const created = await this.createAgent({
        kind: "mcp",
        provider: this.providerModel,
        cwd: input.cwd,
        title: "Tri de tâches",
        unattended: true,
        promptFailure: "return-error",
        background: true,
        notifyOnFinish: false,
        internal: true,
      });
      agentId = created.snapshot.id;
      if (created.initialPromptError) {
        throw created.initialPromptError;
      }
      const initialPrompt = buildStructuredAgentResponsePrompt({
        prompt: basePrompt,
        schema: MessageTriageResultSchema,
        schemaName: "MessageTriageResult",
      });
      let first = true;
      return await getStructuredAgentResponse({
        caller: async (nextPrompt) => {
          const prompt = first ? initialPrompt : nextPrompt;
          first = false;
          if (!agentId) {
            throw new Error("Triage agent missing");
          }
          const run = await this.agentManager.runAgent(agentId, prompt);
          return resolveFinalText(run.timeline, run.finalText);
        },
        prompt: basePrompt,
        schema: MessageTriageResultSchema,
        maxRetries: 1,
        schemaName: "MessageTriageResult",
      });
    } catch (error) {
      this.logger.debug({ err: error }, "Triage agent failed");
      return null;
    } finally {
      if (agentId) {
        try {
          await this.agentManager.archiveAgent(agentId);
        } catch {
          // Ignore cleanup errors for internal triage agents.
        }
      }
    }
  }

  /**
   * Provider/model/effort of the agent whose message triggered the triage, so a
   * proposed task defaults to that same engine. Returns undefined when the agent
   * is no longer live — there is simply nothing to inherit.
   */
  private sourceAgentRunConfig(agentId: string): TaskRunConfig | undefined {
    const sourceAgent = this.agentManager.getAgent(agentId);
    const provider = sourceAgent?.provider.trim();
    if (!sourceAgent || !provider) {
      return undefined;
    }
    return {
      provider,
      ...(sourceAgent.config.model ? { model: sourceAgent.config.model } : {}),
      ...(sourceAgent.config.thinkingOptionId
        ? { thinkingOptionId: sourceAgent.config.thinkingOptionId }
        : {}),
    };
  }
}

// Re-validate the LLM-suggested runConfig against the wire schema before storing;
// drop it entirely if it doesn't parse rather than trusting free-form output.
function sanitizeRunConfig(runConfig: TaskRunConfig | undefined): TaskRunConfig | undefined {
  if (!runConfig) {
    return undefined;
  }
  const parsed = TaskRunConfigSchema.safeParse(runConfig);
  return parsed.success ? parsed.data : undefined;
}

function resolveFinalText(timeline: AgentTimelineItem[], finalText: string): string {
  if (finalText.trim()) {
    return finalText;
  }
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (item?.type === "assistant_message" && item.text.trim()) {
      return item.text;
    }
  }
  return "";
}
