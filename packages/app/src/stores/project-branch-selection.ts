// Remembers which branch each project was last viewing so a browser refresh (or
// app relaunch) lands on the same branch per project instead of resetting. The
// selection is keyed by (serverId, projectId) and persisted through an injected
// storage adapter (AsyncStorage on native, localStorage-backed on web).

export interface ProjectBranchSelection {
  serverId: string;
  projectId: string;
  branch: string;
}

export const PROJECT_BRANCH_SELECTION_STORAGE_KEY = "paseo:project-open-branch-selection";

export interface ProjectBranchSelectionStorage {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

function selectionKey(serverId: string, projectId: string): string {
  // JSON-encode both parts so an id containing the separator can never collide.
  return JSON.stringify([serverId, projectId]);
}

function normalizeSelection(input: unknown): ProjectBranchSelection | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  const serverId = typeof record.serverId === "string" ? record.serverId.trim() : "";
  const projectId = typeof record.projectId === "string" ? record.projectId.trim() : "";
  const branch = typeof record.branch === "string" ? record.branch.trim() : "";
  if (!serverId || !projectId || !branch) {
    return null;
  }
  return { serverId, projectId, branch };
}

function parseStoredSelections(stored: string | null): ProjectBranchSelection[] {
  if (!stored) {
    return [];
  }
  try {
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map(normalizeSelection)
      .filter((entry): entry is ProjectBranchSelection => entry !== null);
  } catch {
    return [];
  }
}

export function createProjectBranchSelectionStore(storage: ProjectBranchSelectionStorage) {
  const branches = new Map<string, ProjectBranchSelection>();
  let hydrated = false;
  let hydrationPromise: Promise<void> | null = null;
  // Keys the caller touched after hydration started: their in-memory value is
  // newer than anything on disk, so a late-finishing read must not clobber them.
  const touchedSinceHydration = new Set<string>();
  const listeners = new Set<() => void>();

  function notifyListeners() {
    for (const listener of listeners) {
      listener();
    }
  }

  function serialize(): string {
    return JSON.stringify(Array.from(branches.values()));
  }

  function getBranch(serverId: string | null, projectId: string | null): string | null {
    if (!serverId || !projectId) {
      return null;
    }
    return branches.get(selectionKey(serverId, projectId))?.branch ?? null;
  }

  function remember(next: ProjectBranchSelection) {
    const normalized = normalizeSelection(next);
    if (!normalized) {
      return;
    }
    const key = selectionKey(normalized.serverId, normalized.projectId);
    if (hydrationPromise && !hydrated) {
      touchedSinceHydration.add(key);
    }
    if (branches.get(key)?.branch === normalized.branch) {
      return;
    }
    branches.set(key, normalized);
    notifyListeners();
    void storage.write(serialize()).catch(() => {});
  }

  function forget(serverId: string, projectId: string) {
    const key = selectionKey(serverId, projectId);
    if (hydrationPromise && !hydrated) {
      touchedSinceHydration.add(key);
    }
    if (!branches.delete(key)) {
      return;
    }
    notifyListeners();
    void storage.write(serialize()).catch(() => {});
  }

  function hydrate(): Promise<void> {
    if (hydrationPromise) {
      return hydrationPromise;
    }
    hydrationPromise = storage
      .read()
      .then((stored) => {
        for (const entry of parseStoredSelections(stored)) {
          const key = selectionKey(entry.serverId, entry.projectId);
          // A branch remembered while the read was in flight is newer — keep it.
          if (touchedSinceHydration.has(key) || branches.has(key)) {
            continue;
          }
          branches.set(key, entry);
        }
        return undefined;
      })
      .catch(() => {})
      .finally(() => {
        hydrated = true;
        touchedSinceHydration.clear();
        notifyListeners();
      });
    return hydrationPromise;
  }

  return {
    getBranch,
    hydrate,
    isHydrated: () => hydrated,
    remember,
    forget,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type ProjectBranchSelectionStore = ReturnType<typeof createProjectBranchSelectionStore>;
