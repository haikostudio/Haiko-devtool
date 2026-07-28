import { createContext, useContext, type ReactNode } from "react";

/**
 * Optional extra controls injected into the composer's footer button row, on the
 * right side just after the voice controls (mic + « Parler » / mode vocal) and
 * before the send button. The conductor drawer uses this to place its
 * « Réinitialiser » button alongside the other input controls instead of in the
 * drawer header, so every input-control action lives in one place.
 *
 * The value is `null` on every other screen, so the shared composer renders
 * exactly as before there — the footer only grows an extra control when a parent
 * explicitly provides one.
 */
const ComposerFooterControlsContext = createContext<ReactNode>(null);

export function ComposerFooterControlsProvider({
  controls,
  children,
}: {
  controls: ReactNode;
  children: ReactNode;
}) {
  return (
    <ComposerFooterControlsContext.Provider value={controls}>
      {children}
    </ComposerFooterControlsContext.Provider>
  );
}

/** Extra footer controls provided by an ancestor, or `null` when none. */
export function useComposerFooterControls(): ReactNode {
  return useContext(ComposerFooterControlsContext);
}
