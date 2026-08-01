import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

interface EvolutionBlockEntry {
  title: string;
  order: number;
}

interface EvolutionBlockValue {
  titles: string[];
  /** Called by each mini-card; returns the unregister function. */
  register: (entry: EvolutionBlockEntry) => () => void;
}

const EvolutionBlockContext = createContext<EvolutionBlockValue | null>(null);

/**
 * Collects the proposals of one "Évolutions possibles" block so the block's
 * "tout ajouter" button knows what to add.
 *
 * The cards register themselves instead of the button re-parsing the markdown:
 * a card's title comes from the rendered syntax tree (emphasis and links
 * already stripped), and a second parse would drift from it — the button would
 * insert text the cards then fail to recognise as selected.
 */
export function EvolutionBlockProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<EvolutionBlockEntry[]>([]);

  const register = useCallback((entry: EvolutionBlockEntry) => {
    setEntries((previous) =>
      previous.some((candidate) => candidate.title === entry.title)
        ? previous
        : [...previous, entry].sort((left, right) => left.order - right.order),
    );
    return () => {
      setEntries((previous) => previous.filter((candidate) => candidate.title !== entry.title));
    };
  }, []);

  const value = useMemo<EvolutionBlockValue>(
    () => ({ titles: entries.map((entry) => entry.title), register }),
    [entries, register],
  );

  return <EvolutionBlockContext.Provider value={value}>{children}</EvolutionBlockContext.Provider>;
}

export function useEvolutionBlock(): EvolutionBlockValue | null {
  return useContext(EvolutionBlockContext);
}
