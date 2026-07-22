// In-memory registry of WHEN the focused tab last actually changed per workspace
// (wall-clock ms). This is the discriminator that makes cross-device focus sync
// converge and stops the focus-stealing race.
//
// The problem it solves: a workspace UI state's `revision` is Date.now() at PUSH
// time, bumped on every edit (draft typing, tab open/close). Two devices that
// disagree about a snapshot answer each other's broadcasts at network speed
// (observed live: a draft tab flip-flopping ~700ms apart for 20s). In such a
// duel EVERY incoming broadcast carries a fresh revision, so a guard that only
// rejects snapshots "older than my last local focus" never fires — remote focus
// keeps winning and yanks focus back to the previous/left tab.
//
// focusedAt records the moment the focus itself changed, independent of push
// timing. A device re-advertising an unchanged focus carries an OLD focusedAt,
// so hydrate resolves focus last-write-wins by focusedAt: the device the user is
// actually touching wins, and the duel converges (the loser adopts the winner's
// focusedAt and stops fighting). See hydrate.ts for the decision.
//
// suppressLocalFocusIntent brackets the entire remote-apply pass so the store
// focus mutations it triggers (focusTab, closeTab auto-focus, ...) never
// masquerade as local intent — the adopted value is set explicitly via
// adoptRemoteFocusedAt instead. Deliberately in-memory: after a reload the
// daemon state is authoritative again.

const focusedAtByWorkspace = new Map<string, number>();

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

// True while a remote snapshot is being adopted (hydrate). Lets other local
// registries (e.g. open-markers) skip recording daemon-driven store mutations as
// genuine local intent, the same way recordLocalFocusIntent no-ops below.
export function isApplyingRemoteState(): boolean {
  return remoteApplyDepth > 0;
}

// A local, user-driven focus change (clicking a tab, sending the first prompt).
// No-op while adopting remote state so daemon-driven focus never counts as local.
export function recordLocalFocusIntent(workspaceKey: string): void {
  if (remoteApplyDepth > 0) {
    return;
  }
  focusedAtByWorkspace.set(workspaceKey, Date.now());
}

// Records the focusedAt this device adopted from a remote snapshot, so our own
// subsequent pushes re-advertise the same value instead of minting a fresh one
// (which would re-open the duel). Called explicitly from hydrate after adopting
// remote focus — not gated by the suppress bracket.
export function adoptRemoteFocusedAt(workspaceKey: string, focusedAt: number): void {
  focusedAtByWorkspace.set(workspaceKey, focusedAt);
}

// The wall-clock time the focus last changed for this workspace, or null if this
// device has neither changed focus locally nor adopted a remote focus yet.
export function getFocusedAt(workspaceKey: string): number | null {
  return focusedAtByWorkspace.get(workspaceKey) ?? null;
}

export function resetLocalFocusIntentForTest(): void {
  remoteApplyDepth = 0;
  focusedAtByWorkspace.clear();
}
