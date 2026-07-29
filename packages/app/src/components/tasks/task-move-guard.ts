import type { KanbanTask, TaskColumn } from "@/data/tasks";
import { KANBAN_COLUMNS } from "./kanban-columns";

// ---------------------------------------------------------------------------
// Which manual moves the board accepts.
//
// The board's rule since e62ef15b8 is "dragging a card does exactly what its
// button does". The corollary was missing: a card that is *executing* offers no
// backward button at all, so no gesture may take it backward either. Dragging a
// card out of "En cours" — worse, while its final check is running — used to
// drop it back into "Planifié", where the scheduler would see it again. Work in
// flight only ever moves forward, and only through the action that owns the
// transition (the final-check bar).
//
// One pure predicate, consumed by every manual path (drag, the "Déplacer
// vers…" menu, the chevrons), so the three can never drift apart.
// ---------------------------------------------------------------------------

// Position in the pipeline. The board's column order IS the order of the work,
// so "amont" / "aval" is nothing more than this index.
function pipelineIndex(column: TaskColumn): number {
  return KANBAN_COLUMNS.indexOf(column);
}

// An action the user launched from the card is live right now: the final check
// ("Valider la tâche") or the publication. The server opens the window the
// instant the action starts and closes it when the agent stops, so this is the
// freshest truth about the card — and while it is open the card belongs to that
// action, not to the mouse.
function hasRunningAction(task: KanbanTask): boolean {
  return task.validation?.state === "running" || task.deployment?.state === "running";
}

/**
 * The card's work is under way: its agent is executing (the card sits in
 * "En cours") or an explicit action the user pressed is still running.
 *
 * Deliberately state-based, not position-based: a card whose final check runs is
 * executing wherever it happens to sit, which is exactly the case the drag bug
 * fell through.
 */
export function isTaskExecuting(task: KanbanTask): boolean {
  return task.column === "in_progress" || hasRunningAction(task);
}

/**
 * May the user move this card to `target` by hand?
 *
 * - Re-ordering inside the same column is always fine (it is not a transition).
 * - A card already in "Archivé" is frozen: history only, never walked back.
 * - A card that is not executing keeps the board's usual freedom — including
 *   filing itself into "Archivé" by hand (drag, menu or chevrons).
 * - A card with a running action is frozen where it is: the action owns the next
 *   transition and will perform it itself.
 * - An executing card may otherwise only reach the very next column — for
 *   "En cours" that is "Terminée" and nothing else. Every upstream column
 *   ("Planifié", "Validé", "À faire", "Notes") is refused, and so is every skip
 *   ahead: jumping straight to "À déployer" would bypass the final check that
 *   owns the completion.
 *
 * Refusals are silent no-ops at the call sites: the card simply stays put. There
 * is nothing to explain — the gesture was never an available action.
 */
export function isTaskMoveAllowed(task: KanbanTask, target: TaskColumn): boolean {
  if (task.column === target) {
    return true;
  }
  // "Archivé" is the terminal resting column: once a card is filed there it is
  // frozen. It may be re-ordered among its neighbours (handled above), but no
  // gesture ever walks it back into the pipeline — the column is history only.
  if (task.column === "archived") {
    return false;
  }
  // "À déployer" is the publication queue, and a card only ever queues work that
  // is finished: it is reachable from "Terminée" alone. Mirrors the same rule the
  // server enforces, so the gesture is a silent no-op here instead of a refused
  // move that bounces back. A card that already completed once (a re-queue) keeps
  // its way in.
  if (target === "deployed" && task.column !== "done" && task.completedAt == null) {
    return false;
  }
  if (!isTaskExecuting(task)) {
    return true;
  }
  if (hasRunningAction(task)) {
    return false;
  }
  return pipelineIndex(target) === pipelineIndex(task.column) + 1;
}
