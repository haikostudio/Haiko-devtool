import type { WorkspaceDraftTabSetup } from "@/stores/workspace-tabs-store";

// Tracks the draft agent config (target.setup) each open composer is currently
// displaying, keyed by `${serverId}:${draftId}`. It is written ONLY when the
// composer seeds at mount and when the LOCAL user changes a config control — never
// reactively — so the draft panel can tell a LOCAL config edit (echo == target)
// apart from a REMOTE one (target diverged from the echo) and remount only for
// remote changes. Reactive mirroring is what caused the cross-device write loop;
// keep this write-on-gesture-only.
const displayedDraftSetup = new Map<string, WorkspaceDraftTabSetup | null>();

export function buildDraftSetupEchoKey(serverId: string, draftId: string): string {
  return `${serverId}:${draftId}`;
}

export function recordLocalDraftSetup(key: string, setup: WorkspaceDraftTabSetup | null): void {
  displayedDraftSetup.set(key, setup);
}

export function getLocalDraftSetup(key: string): WorkspaceDraftTabSetup | null | undefined {
  return displayedDraftSetup.get(key);
}
