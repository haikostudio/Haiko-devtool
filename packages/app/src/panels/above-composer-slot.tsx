import { createContext, useContext, type ReactNode } from "react";

/**
 * A single node the agent panel renders immediately above the prompt composer.
 *
 * The task board uses it for the "Valider la tâche" bar: the bar has to sit
 * right on top of the composer, inside the same scroll/keyboard geometry, and
 * the agent panel is the only place that owns that spot. Everywhere else the
 * slot is empty, so the normal workspace is untouched.
 */
const AboveComposerSlotContext = createContext<ReactNode>(null);

export function AboveComposerSlotProvider({
  node,
  children,
}: {
  node: ReactNode;
  children: ReactNode;
}) {
  return (
    <AboveComposerSlotContext.Provider value={node}>{children}</AboveComposerSlotContext.Provider>
  );
}

export function useAboveComposerSlot(): ReactNode {
  return useContext(AboveComposerSlotContext);
}
