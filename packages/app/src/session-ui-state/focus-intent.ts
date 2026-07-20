// In-memory registry of the wall-clock time of the last LOCAL, user-driven focus
// change per workspace. Guards host-state adoption (hydrateWorkspaceUiState)
// against the focus-stealing race: the user clicks a tab — or sends a prompt,
// which focuses the freshly created agent tab — and before the debounced local
// push (see useSessionUiStateSync) reaches the daemon, a stale broadcast (another
// device, or the daemon replaying an older revision) arrives carrying the PREVIOUS
// focusedTabId and yanks focus back to the previous tab. Focus then follows
// last-write-wins by revision, exactly like hydrateDrafts keeps the newer draft
// record: a remote snapshot whose revision predates our last local focus is
// refused for focus only, while genuinely newer cross-device focus still applies.
//
// suppressLocalFocusIntent brackets the entire remote-apply pass so the store
// focus mutations it triggers (focusTab, closeTab auto-focus, ...) never
// masquerade as local intent. Deliberately in-memory: the race is
// live-session-only, and after a reload the daemon state is authoritative again.

const FOCUS_INTENT_TTL_MS = 6 * 60 * 60 * 1000;

const focusIntentAtByWorkspace = new Map<string, number>();

let remoteApplyDepth = 0;

// Runs fn while local focus mutations are attributed to a remote apply (hydrate),
// so recordLocalFocusIntent becomes a no-op for the duration. Re-entrant.
export function suppressLocalFocusIntent<T>(fn: () => T): T {
  remoteApplyDepth += 1;
  try {
    return fn();
  } finally {
    remoteApplyDepth -= 1;
  }
}

export function recordLocalFocusIntent(workspaceKey: string): void {
  if (remoteApplyDepth > 0) {
    return;
  }
  focusIntentAtByWorkspace.set(workspaceKey, Date.now());
}

export function getLocalFocusIntent(workspaceKey: string): number | null {
  const at = focusIntentAtByWorkspace.get(workspaceKey);
  if (at === undefined) {
    return null;
  }
  if (Date.now() - at > FOCUS_INTENT_TTL_MS) {
    focusIntentAtByWorkspace.delete(workspaceKey);
    return null;
  }
  return at;
}

export function resetLocalFocusIntentForTest(): void {
  remoteApplyDepth = 0;
  focusIntentAtByWorkspace.clear();
}
