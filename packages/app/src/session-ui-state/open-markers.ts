// In-memory registry of locally-opened tabs the host has NOT yet acknowledged.
// The mirror image of close-tombstones, guarding the opposite race: the user
// opens a brand-new draft tab ("New Agent"), and before the debounced push
// reaches the daemon — or while the adopt-on-connect fetch is still in flight,
// during which local pushes are held back — a snapshot captured BEFORE the tab
// existed arrives and host-state adoption (hydrateWorkspaceUiState) would close
// it as "absent from host". The tab the user just opened vanishes on its own.
//
// An open marker lets hydrate recognize "this is a local creation the host
// simply hasn't heard about yet" and preserve it; the corrective push in
// useSessionUiStateSync then advertises the tab and the daemon converges to
// include it. The marker is cleared the moment any host snapshot DOES include
// the tab (it is now acknowledged — a later omission is a genuine cross-device
// close, not a stale replay) or when the tab is closed / converted locally.
//
// Only local intent is marked: recording is skipped while a remote snapshot is
// being applied (isApplyingRemoteState), so tabs hydrate itself reopens from the
// host are never treated as unacknowledged. Deliberately in-memory only: the
// race is live-session-only, and after a reload the daemon state is adopted as
// authoritative again.

import { isApplyingRemoteState } from "./focus-intent";

const MARKER_TTL_MS = 6 * 60 * 60 * 1000;

const openedAtByWorkspaceTab = new Map<string, Map<string, number>>();

function pruneExpired(entries: Map<string, number>, now: number): void {
  for (const [tabId, openedAt] of entries) {
    if (now - openedAt > MARKER_TTL_MS) {
      entries.delete(tabId);
    }
  }
}

// Marks a tab as locally opened and not yet acknowledged by the host. No-op
// while adopting remote state, so a hydrate-driven reopen is never marked.
export function recordLocalTabOpen(workspaceKey: string, tabId: string): void {
  if (isApplyingRemoteState()) {
    return;
  }
  const now = Date.now();
  let entries = openedAtByWorkspaceTab.get(workspaceKey);
  if (!entries) {
    entries = new Map();
    openedAtByWorkspaceTab.set(workspaceKey, entries);
  }
  pruneExpired(entries, now);
  entries.set(tabId, now);
}

// Clears the marker once the host acknowledges the tab (it appears in a
// snapshot) or the tab is closed / converted — from then on a host snapshot that
// omits the tab is a genuine close, not a stale replay.
export function clearTabOpenMarker(workspaceKey: string, tabId: string): void {
  openedAtByWorkspaceTab.get(workspaceKey)?.delete(tabId);
}

export function hasTabOpenMarker(workspaceKey: string, tabId: string): boolean {
  const entries = openedAtByWorkspaceTab.get(workspaceKey);
  if (!entries) {
    return false;
  }
  pruneExpired(entries, Date.now());
  return entries.has(tabId);
}

export function resetTabOpenMarkersForTest(): void {
  openedAtByWorkspaceTab.clear();
}
