import { useCallback, useEffect, useRef } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceUiState } from "@getpaseo/protocol/messages";
import { getIsElectron } from "@/constants/platform";
import { useHostFeature } from "@/runtime/host-features";
import { useDraftStore } from "@/stores/draft-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { hydrateWorkspaceUiState } from "@/session-ui-state/hydrate";
import {
  buildWorkspaceUiState,
  canonicalizeWorkspaceUiState,
  listWorkspaceIdsForServer,
} from "@/session-ui-state/snapshot";
import {
  materializeDraftImageBytes,
  uploadDraftImageBytes,
} from "@/session-ui-state/attachment-sync";
import { logTabSync } from "@/session-ui-state/sync-log";

const PUSH_DEBOUNCE_MS = 600;

function isEmptyState(state: WorkspaceUiState): boolean {
  return state.tabs.length === 0 && Object.keys(state.drafts).length === 0;
}

/**
 * Syncs per-workspace UI session state (open tabs, order, focus, and the drafts
 * referenced by draft tabs) with the daemon so every device shares the same
 * workspace surface. Modeled on useSidebarOrderSync: the daemon is the source of
 * truth once it holds state; a fresh (empty) daemon is seeded from the desktop's
 * local state only. Gated on the sessionUiStateSync host feature — when the
 * daemon predates it, behaviour is fully local as before.
 */
export function useSessionUiStateSync(
  serverId: string,
  client: DaemonClient,
  isConnected: boolean,
): void {
  const supported = useHostFeature(serverId, "sessionUiStateSync");
  // Skip pushing while we're applying state that came FROM the daemon, and skip
  // re-pushing a value we already synced (the daemon echoes our own set).
  const applyingRemoteRef = useRef(false);
  const lastSyncedRef = useRef<Map<string, string>>(new Map());
  // Do not push local state until the initial adopt-from-daemon pass has run, so
  // a device with a thin local set never clobbers the daemon before adopting it.
  const initializedRef = useRef(false);
  // Corrective pushes are debounced per workspace (latest-wins). Fired
  // immediately, two devices that disagree about a snapshot answer each other's
  // broadcasts at network round-trip speed — observed live as 9 uiState sets in
  // 27ms and a React #185 (max update depth) crash on the receiving phone. The
  // debounce turns a persistent disagreement into a slow, visible trickle while
  // the terminal-lifecycle rule in hydrateDrafts converges the actual content.
  const correctiveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const applyRemote = useCallback(
    (workspaceId: string, state: WorkspaceUiState) => {
      applyingRemoteRef.current = true;
      try {
        hydrateWorkspaceUiState({ serverId, workspaceId, state });
      } finally {
        applyingRemoteRef.current = false;
      }
      const applied = buildWorkspaceUiState({ serverId, workspaceId, revision: 0 });
      if (applied) {
        const appliedCanonical = canonicalizeWorkspaceUiState(applied);
        lastSyncedRef.current.set(workspaceId, appliedCanonical);
        // Hydrate can deliberately refuse part of a remote snapshot — a draft
        // tab this device already converted into its created agent tab (see
        // resolveDraftHandoffTarget). Without a corrective push the daemon
        // keeps the stale layout as authoritative and every other device shows
        // the resurrected draft forever. The push is convergent: receivers
        // apply it fully, so their applied state matches and they stay silent.
        if (appliedCanonical !== canonicalizeWorkspaceUiState(state)) {
          logTabSync("corrective push scheduled (device refused part of the host snapshot)", {
            workspaceId,
            remoteRevision: state.revision,
            remoteTabIds: state.tabs.map((tab) => tab.tabId),
            appliedTabIds: applied.tabs.map((tab) => tab.tabId),
          });
          const timers = correctiveTimersRef.current;
          const existing = timers.get(workspaceId);
          if (existing) {
            clearTimeout(existing);
          }
          timers.set(
            workspaceId,
            setTimeout(() => {
              timers.delete(workspaceId);
              // Re-snapshot at fire time: the local stores may have moved on
              // (including having adopted a newer broadcast) since scheduling.
              const current = buildWorkspaceUiState({ serverId, workspaceId, revision: 0 });
              if (!current) {
                return;
              }
              lastSyncedRef.current.set(workspaceId, canonicalizeWorkspaceUiState(current));
              void client
                .setWorkspaceUiState(workspaceId, { ...current, revision: Date.now() })
                .catch(() => undefined);
            }, PUSH_DEBOUNCE_MS),
          );
        }
      }
      // Pull down any draft image bytes this device is missing. Runs after the
      // synchronous hydrate; the canonical is storageKey-agnostic so patching the
      // materialized metadata does not echo back as a push.
      void materializeDraftImageBytes(client, state);
    },
    [serverId, client],
  );

  // Pending corrective pushes die with the connection they were scheduled for.
  useEffect(() => {
    const timers = correctiveTimersRef.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  }, [client]);

  // Fetch on connect: adopt the daemon's per-workspace state, then seed the
  // daemon (desktop only) for workspaces it does not know yet.
  useEffect(() => {
    if (!supported || !isConnected) {
      return;
    }
    let cancelled = false;
    const sync = async () => {
      const remoteStates = await client.getWorkspaceUiStates();
      if (cancelled) {
        return;
      }
      for (const [workspaceId, state] of Object.entries(remoteStates)) {
        logTabSync("adopting host state on connect", {
          workspaceId,
          remoteRevision: state.revision,
          remoteTabIds: state.tabs.map((tab) => tab.tabId),
        });
        applyRemote(workspaceId, state);
      }
      if (getIsElectron()) {
        const known = new Set(Object.keys(remoteStates));
        for (const workspaceId of listWorkspaceIdsForServer(serverId)) {
          if (known.has(workspaceId)) {
            continue;
          }
          const state = buildWorkspaceUiState({ serverId, workspaceId, revision: Date.now() });
          if (!state || isEmptyState(state)) {
            continue;
          }
          lastSyncedRef.current.set(workspaceId, canonicalizeWorkspaceUiState(state));
          await client.setWorkspaceUiState(workspaceId, state);
        }
      }
      initializedRef.current = true;
    };
    void sync().catch(() => {
      // Even on failure, allow local pushes so the feature degrades to
      // best-effort rather than never syncing.
      initializedRef.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, [supported, isConnected, client, serverId, applyRemote]);

  // Live updates broadcast by the daemon when another device changes a workspace.
  useEffect(() => {
    if (!supported) {
      return;
    }
    const unsub = client.on("status", (message) => {
      if (message.type !== "status") {
        return;
      }
      const payload = message.payload as {
        status?: string;
        workspaceId?: string;
        state?: WorkspaceUiState;
      };
      if (payload.status !== "session_ui_state_changed" || !payload.workspaceId || !payload.state) {
        return;
      }
      logTabSync("applying host broadcast", {
        workspaceId: payload.workspaceId,
        remoteRevision: payload.state.revision,
        remoteTabIds: payload.state.tabs.map((tab) => tab.tabId),
      });
      applyRemote(payload.workspaceId, payload.state);
    });
    return unsub;
  }, [supported, client, applyRemote]);

  // Push local changes (tabs + drafts) to the daemon, debounced, ignoring
  // daemon-driven writes and unchanged snapshots.
  useEffect(() => {
    if (!supported || !isConnected) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = async () => {
      for (const workspaceId of listWorkspaceIdsForServer(serverId)) {
        const probe = buildWorkspaceUiState({ serverId, workspaceId, revision: 0 });
        if (!probe) {
          continue;
        }
        const serialized = canonicalizeWorkspaceUiState(probe);
        if (lastSyncedRef.current.get(workspaceId) === serialized) {
          continue;
        }
        lastSyncedRef.current.set(workspaceId, serialized);
        const state: WorkspaceUiState = { ...probe, revision: Date.now() };
        logTabSync("pushing local state to host", {
          workspaceId,
          revision: state.revision,
          tabIds: state.tabs.map((tab) => tab.tabId),
        });
        // Upload this device's draft image bytes BEFORE advertising the state, so
        // a device that receives the broadcast can always fetch the bytes. Pushing
        // first raced the upload: the receiver's materialize could run before the
        // bytes existed on the daemon and, with no further draft change, never
        // retried — leaving the image unviewable until the tab was reopened.
        await uploadDraftImageBytes(client, state);
        await client.setWorkspaceUiState(workspaceId, state).then(
          () => undefined,
          () => undefined,
        );
      }
    };
    const schedule = () => {
      if (applyingRemoteRef.current || !initializedRef.current) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        void flush().catch(() => undefined);
      }, PUSH_DEBOUNCE_MS);
    };
    const unsubLayout = useWorkspaceLayoutStore.subscribe(schedule);
    const unsubDraft = useDraftStore.subscribe(schedule);
    return () => {
      if (timer) {
        clearTimeout(timer);
      }
      unsubLayout();
      unsubDraft();
    };
  }, [supported, isConnected, client, serverId]);
}
