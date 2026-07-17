import type { WorkspaceDraftTabSetup } from "@/stores/workspace-tabs-store";

// Tracks the draft agent config (target.setup) each open composer last emitted
// from its OWN form, keyed by `${serverId}:${draftId}`. The draft panel uses it
// to tell a LOCAL setup change (mirrored here by the composer's own edit) apart
// from a REMOTE one (applied to target.setup by hydrateWorkspaceUiState). Only
// remote changes should remount the composer to re-seed the mount-once form —
// remounting on the device that just changed the config would flash the composer
// for no reason.
const locallyEmittedDraftSetup = new Map<string, WorkspaceDraftTabSetup | null>();

export function buildDraftSetupEchoKey(serverId: string, draftId: string): string {
  return `${serverId}:${draftId}`;
}

export function recordLocalDraftSetup(key: string, setup: WorkspaceDraftTabSetup | null): void {
  locallyEmittedDraftSetup.set(key, setup);
}

export function getLocalDraftSetup(key: string): WorkspaceDraftTabSetup | null | undefined {
  return locallyEmittedDraftSetup.get(key);
}
