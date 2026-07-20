// In-memory registry of recently closed tabs, keyed by workspace persistence
// key. Guards host-state adoption (hydrateWorkspaceUiState) against the
// resurrection race: the user closes a tab, and before the debounced push
// reaches the daemon — or while the initial adopt-on-connect fetch is still in
// flight, during which local pushes are deliberately held back — a snapshot
// captured BEFORE the close arrives and would re-open the tab, silently losing
// the close. A tombstone lets hydrate recognize "this tab was closed locally
// AFTER that snapshot was taken" (snapshot revision <= closedAt) and skip the
// reopen; the corrective push in useSessionUiStateSync then advertises the
// closed state so the daemon converges. A snapshot with a NEWER revision still
// reopens the tab — that is a genuine cross-device open, not a stale replay.
//
// Deliberately in-memory only: the race is live-session-only, and after a
// reload the daemon state is adopted as authoritative again.

const TOMBSTONE_TTL_MS = 6 * 60 * 60 * 1000;

const closedAtByWorkspaceTab = new Map<string, Map<string, number>>();

function pruneExpired(entries: Map<string, number>, now: number): void {
  for (const [tabId, closedAt] of entries) {
    if (now - closedAt > TOMBSTONE_TTL_MS) {
      entries.delete(tabId);
    }
  }
}

export function recordTabClose(workspaceKey: string, tabId: string): void {
  const now = Date.now();
  let entries = closedAtByWorkspaceTab.get(workspaceKey);
  if (!entries) {
    entries = new Map();
    closedAtByWorkspaceTab.set(workspaceKey, entries);
  }
  pruneExpired(entries, now);
  entries.set(tabId, now);
}

// Clearing on every local open (user reopens the tab, a create flow converts a
// draft, hydrate adopts a genuine remote open) keeps a stale tombstone from
// ever suppressing a tab the device knowingly brought back.
export function clearTabCloseTombstone(workspaceKey: string, tabId: string): void {
  closedAtByWorkspaceTab.get(workspaceKey)?.delete(tabId);
}

export function getTabCloseTombstone(workspaceKey: string, tabId: string): number | null {
  const entries = closedAtByWorkspaceTab.get(workspaceKey);
  if (!entries) {
    return null;
  }
  pruneExpired(entries, Date.now());
  return entries.get(tabId) ?? null;
}

export function resetTabCloseTombstonesForTest(): void {
  closedAtByWorkspaceTab.clear();
}
