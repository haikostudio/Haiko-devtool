// Console tracing for board gestures the move guard refuses. A refusal is a
// silent no-op on purpose (the card simply stays put — see task-move-guard), and
// silence is exactly what makes "j'ai déplacé la carte et rien ne s'est passé"
// impossible to diagnose after the fact. Every refused drag, menu pick or
// chevron press leaves a line here instead. Grep for "[paseo:board-move]".
// Intentionally active in production builds: the gestures this traces happen on
// the user's real board, never in dev.
import type { KanbanTask, TaskColumn } from "@/data/tasks";

export function logRefusedMove(task: KanbanTask, target: TaskColumn, source: string): void {
  console.info("[paseo:board-move] refused", {
    source,
    taskId: task.id,
    from: task.column,
    to: target,
    // The two states that explain most refusals, so the line answers "why?" on
    // its own instead of sending the reader back to the guard.
    validation: task.validation?.state ?? null,
    deployment: task.deployment?.state ?? null,
    completedAt: task.completedAt ?? null,
  });
}
