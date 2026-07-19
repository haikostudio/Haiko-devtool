import { createContext, useContext } from "react";
import { DEFAULT_TASKS_QUIET_HOURS, type QuietHours } from "./task-schedule";

// The board's quiet-hours window, provided once at the board root and read by
// each TaskCard to predict when a validated task will run. Defaults to the
// scheduler's built-in window so a card still shows a sensible hint before the
// daemon config loads (or on an older daemon that doesn't report it).
const TaskScheduleContext = createContext<QuietHours>(DEFAULT_TASKS_QUIET_HOURS);

export const TaskScheduleProvider = TaskScheduleContext.Provider;

export function useTaskQuietHours(): QuietHours {
  return useContext(TaskScheduleContext);
}
