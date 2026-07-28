/**
 * Who is mounted, and who is merely visible, inside the tasks chat dock.
 *
 * The dock shows either the project's "chef d'orchestre" or a task's own chat.
 * Swapping between them used to be a swap of MOUNTED trees, and that lost live
 * conversations: send a prompt to the conductor, tap a card within the second,
 * come back — the conductor pane had been destroyed and rebuilt on a snapshot
 * taken before the send, so neither the prompt nor the streaming reply was on
 * screen even though the agent was working.
 *
 * So mounting and visibility are two different questions, and this is where they
 * are answered:
 * - the conductor stays MOUNTED for the dock's whole life once it exists,
 * - it is only HIDDEN while a task view covers it,
 * - and hidden means "not the interactive pane" too, so it stops competing for
 *   the keyboard and stops clearing its own attention badge off-screen.
 */
export interface ConductorDockPresenceInput {
  /** A task is docked (its Chat/Details/Billing view is showing). */
  hasDockedTask: boolean;
  /** This project's conductor agent has been resolved at least once. */
  conductorResolved: boolean;
}

export interface ConductorDockPresence {
  /** Render the docked task's view. */
  showTaskView: boolean;
  /** The conductor pane is on screen (never hide-by-unmount). */
  conductorVisible: boolean;
  /**
   * The conductor pane is the interactive one: drives keyboard focus and the
   * agent panel's own focus-driven history catch-up.
   */
  conductorFocused: boolean;
  /**
   * Hold the "ensure this project has a conductor" round-trip. Only true before
   * any conductor exists: tapping a card on a board whose conductor was never
   * opened must not spin an agent up. Once one is resolved this stays false, so
   * opening or closing a task never re-runs the ensure — no loading flash, and no
   * remount of a chat that may be mid-turn.
   */
  ensureSuspended: boolean;
}

export function resolveConductorDockPresence({
  hasDockedTask,
  conductorResolved,
}: ConductorDockPresenceInput): ConductorDockPresence {
  return {
    showTaskView: hasDockedTask,
    conductorVisible: !hasDockedTask,
    conductorFocused: !hasDockedTask,
    ensureSuspended: hasDockedTask && !conductorResolved,
  };
}
