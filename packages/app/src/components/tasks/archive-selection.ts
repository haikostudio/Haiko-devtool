import { useCallback, useMemo, useState } from "react";
import type { KanbanTask, TaskColumn } from "@/data/tasks";
import type { KanbanColumnModel } from "./kanban-columns";

// Bulk-archive selection for the "À déployer" column: the user picks a set of
// queued cards and files them all into "Archivé" at once. Archiving here is a
// PURE move to the terminal column — no publication, no side effect — so the
// state lives entirely on the client and is reused, card by card, through the
// board's ordinary `onMoveTask({ column: "archived" })` path (which the daemon
// gates and stamps with `preArchiveColumn`, exactly like the ⋮ menu's move).
//
// "All checked by default": we track the cards the user has UNCHECKED
// (`excluded`), so a card that arrives mid-selection is included too. Session
// state only — start/cancel/confirm all clear it, nothing is ever persisted.

const EMPTY_EXCLUDED: ReadonlySet<string> = new Set();

/** Per-card slice handed to a TaskCard so it can render + toggle its checkbox. */
export interface CardSelection {
  active: boolean;
  checked: boolean;
  onToggle: () => void;
}

/** The whole column's selection surface: what the cards and the bottom bar read. */
export interface ArchiveSelectionColumnProps {
  active: boolean;
  selectedCount: number;
  isSelected: (taskId: string) => boolean;
  onToggle: (task: KanbanTask) => void;
  onStart: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export interface ArchiveSelection {
  active: boolean;
  isSelected: (taskId: string) => boolean;
  toggle: (task: KanbanTask) => void;
  start: () => void;
  cancel: () => void;
}

export function useArchiveSelection(): ArchiveSelection {
  const [active, setActive] = useState(false);
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(EMPTY_EXCLUDED);
  const start = useCallback(() => {
    setExcluded(EMPTY_EXCLUDED);
    setActive(true);
  }, []);
  const cancel = useCallback(() => {
    setActive(false);
    setExcluded(EMPTY_EXCLUDED);
  }, []);
  const toggle = useCallback((task: KanbanTask) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(task.id)) {
        next.delete(task.id);
      } else {
        next.add(task.id);
      }
      return next;
    });
  }, []);
  const isSelected = useCallback((taskId: string) => !excluded.has(taskId), [excluded]);
  return { active, isSelected, toggle, start, cancel };
}

/**
 * Wires the raw selection state to the "À déployer" column: which cards are
 * checked, how many, and a confirm that files them into "Archivé". Shared by
 * both board shapes so the touch and desktop boards behave identically.
 *
 * Confirm is a plain, card-by-card move to the terminal column through the
 * board's own `onMoveTask` — the same choke point the ⋮ menu uses, so the daemon
 * gates each move and stamps `preArchiveColumn`. No publication is ever run.
 */
export function useDeployArchiveSelection(
  columns: KanbanColumnModel[],
  onMoveTask: (input: { taskId: string; column: TaskColumn; index: number }) => void,
): ArchiveSelectionColumnProps {
  const { active, isSelected, toggle, start, cancel } = useArchiveSelection();
  const deployedTasks = useMemo(
    () => columns.find((entry) => entry.column === "deployed")?.tasks ?? [],
    [columns],
  );
  const selectedIds = useMemo(
    () => deployedTasks.filter((task) => isSelected(task.id)).map((task) => task.id),
    [deployedTasks, isSelected],
  );
  const onConfirm = useCallback(() => {
    for (const taskId of selectedIds) {
      onMoveTask({ taskId, column: "archived", index: Number.MAX_SAFE_INTEGER });
    }
    cancel();
  }, [selectedIds, onMoveTask, cancel]);
  return useMemo(
    () => ({
      active,
      selectedCount: selectedIds.length,
      isSelected,
      onToggle: toggle,
      onStart: start,
      onCancel: cancel,
      onConfirm,
    }),
    [active, selectedIds.length, isSelected, toggle, start, cancel, onConfirm],
  );
}
