import { createContext, useContext, type ReactNode } from "react";

/**
 * Signals that the composer is embedded inside a host that already consumes the
 * phone's bottom safe-area inset (e.g. the task board's `AdaptiveModalSheet`
 * dock, which pads its body by `insets.bottom`). In that case the composer must
 * NOT add its own safe-area gap on top, or the two stack into an empty white
 * band under the input row.
 *
 * Unset (the default) means the composer owns the safe area itself, which is the
 * correct behaviour on the full-screen conversation panel where nothing else
 * pads the bottom.
 */
const HostOwnsComposerSafeAreaContext = createContext(false);

export function HostOwnsComposerSafeAreaProvider({ children }: { children: ReactNode }) {
  return (
    <HostOwnsComposerSafeAreaContext.Provider value={true}>
      {children}
    </HostOwnsComposerSafeAreaContext.Provider>
  );
}

export function useHostOwnsComposerSafeArea(): boolean {
  return useContext(HostOwnsComposerSafeAreaContext);
}
