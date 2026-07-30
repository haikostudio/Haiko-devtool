import type pino from "pino";
import type { UsageStatsDeltaParams } from "../stats/usage-stats-store.js";
import type { TaskBoardService } from "./service.js";

/**
 * Combien de temps on laisse les deltas s'accumuler avant d'écrire sur la carte.
 *
 * Un fournisseur annonce sa consommation plusieurs fois par tour (parfois à
 * chaque bloc de réponse). Écrire le tableau à chaque annonce réécrirait le
 * fichier du projet des dizaines de fois par minute et ferait clignoter la
 * carte. Dix secondes suffisent : le compteur est une information de bilan, pas
 * un chronomètre.
 */
const FLUSH_INTERVAL_MS = 10_000;

interface PendingUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  turns: number;
}

export interface TaskUsageRecorderOptions {
  taskBoardService: Pick<TaskBoardService, "getBoard" | "addTaskUsage">;
  /** Le projet auquel appartient l'agent, ou null s'il n'a pas de tableau. */
  resolveProjectId: (agentId: string) => Promise<string | null>;
  logger: pino.Logger;
  /** Injecté par les tests pour ne pas attendre le vrai temps. */
  flushIntervalMs?: number;
}

/**
 * Additionne sur chaque carte ce que ses agents ont réellement consommé.
 *
 * La question « ce réglage économise-t-il vraiment ? » n'avait jusqu'ici que des
 * réponses d'impression : les statistiques d'usage existaient, mais agrégées par
 * heure et par projet, jamais rattachées au travail qui les avait causées. Le
 * compteur vit donc sur la carte elle-même, où il survit à l'archivage de
 * l'agent et au redémarrage du moteur.
 *
 * Ne compte QUE les cartes : un delta d'agent sans carte est ignoré en silence.
 */
export class TaskUsageRecorder {
  private readonly options: TaskUsageRecorderOptions;
  private readonly logger: pino.Logger;
  private readonly flushIntervalMs: number;
  private readonly pending = new Map<string, PendingUsage>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: TaskUsageRecorderOptions) {
    this.options = options;
    this.logger = options.logger.child({ module: "task-usage-recorder" });
    this.flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  }

  /** Enregistre un delta. Synchrone et infaillible : jamais de rejet. */
  note(delta: UsageStatsDeltaParams): void {
    const current = this.pending.get(delta.agentId) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: 0,
      turns: 0,
    };
    current.inputTokens += Math.max(0, delta.inputTokens);
    current.outputTokens += Math.max(0, delta.outputTokens);
    current.cachedInputTokens += Math.max(0, delta.cachedInputTokens);
    current.costUsd += Math.max(0, delta.costUsd);
    current.turns += Math.max(0, delta.turns);
    this.pending.set(delta.agentId, current);
    this.start();
  }

  private start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }

  /** Écrit tout ce qui attend. Appelée par le minuteur, les tests et l'arrêt. */
  async flush(): Promise<void> {
    if (this.pending.size === 0) {
      return;
    }
    // On vide la file AVANT d'écrire : un delta qui arrive pendant l'écriture
    // appartient au prochain tour de vidage, jamais à celui-ci (sinon il serait
    // perdu au moment du clear).
    const batch = Array.from(this.pending.entries());
    this.pending.clear();
    for (const [agentId, usage] of batch) {
      try {
        await this.applyToTask(agentId, usage);
      } catch (error) {
        this.logger.debug({ err: error, agentId }, "Task usage could not be recorded");
      }
    }
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async applyToTask(agentId: string, usage: PendingUsage): Promise<void> {
    const projectId = await this.options.resolveProjectId(agentId);
    if (!projectId) {
      return;
    }
    const board = await this.options.taskBoardService.getBoard(projectId);
    const task = board.tasks.find((entry) => entry.links.agentIds.includes(agentId));
    if (!task) {
      return;
    }
    await this.options.taskBoardService.addTaskUsage(projectId, task.id, usage);
  }
}
