// Native/base kanban board. There is no cross-column drag on native
// (hover/pointer drag is unreliable on iOS); each card exposes a "move to…"
// menu instead — a committed shape, not a fallback. The implementation is
// shared with compact web in kanban-board-scrollable.tsx.
export { ScrollableKanbanBoard as KanbanBoard } from "./kanban-board-scrollable";
