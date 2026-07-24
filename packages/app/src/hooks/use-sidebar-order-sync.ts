import { useEffect, useRef } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SidebarOrder } from "@getpaseo/protocol/messages";
import { getIsElectron } from "@/constants/platform";
import { useHostFeature } from "@/runtime/host-features";
import { type SidebarOrderSnapshot, useSidebarOrderStore } from "@/stores/sidebar-order-store";

const PUSH_DEBOUNCE_MS = 400;

// Canonical serialization so echo detection is stable regardless of key order.
function canonicalize(order: SidebarOrderSnapshot): string {
  const workspaceOrderByProject: Record<string, string[]> = {};
  for (const key of Object.keys(order.workspaceOrderByProject).sort()) {
    workspaceOrderByProject[key] = order.workspaceOrderByProject[key];
  }
  return JSON.stringify({ projectOrder: order.projectOrder, workspaceOrderByProject });
}

function isEmptyOrder(order: SidebarOrder): boolean {
  return order.projectOrder.length === 0 && Object.keys(order.workspaceOrderByProject).length === 0;
}

function pushOrder(client: DaemonClient, snapshot: SidebarOrderSnapshot): void {
  void client.setSidebarOrder(snapshot).then(
    () => undefined,
    () => undefined,
  );
}

/**
 * Syncs the sidebar project/workspace order with the daemon so every device
 * shares the same order. The daemon is the source of truth once it holds an
 * order; a fresh (empty) daemon is seeded from the desktop's local order only
 * — see the "Desktop = source initiale" decision. Gated on the sidebarOrderSync
 * host feature; when the daemon predates it, behaviour is fully local as before.
 */
export function useSidebarOrderSync(
  serverId: string,
  client: DaemonClient,
  isConnected: boolean,
): void {
  const supported = useHostFeature(serverId, "sidebarOrderSync");
  // Skip pushing while we're applying an order that came FROM the daemon, and
  // skip re-pushing a value we already synced (the daemon echoes our own set).
  const applyingRemoteRef = useRef(false);
  const lastSyncedRef = useRef<string | null>(null);

  const applyRemote = (order: SidebarOrder) => {
    lastSyncedRef.current = canonicalize(order);
    applyingRemoteRef.current = true;
    try {
      useSidebarOrderStore.getState().hydrateFromRemote(order);
    } finally {
      applyingRemoteRef.current = false;
    }
  };

  // Fetch on connect: adopt the daemon order, or seed it from desktop.
  useEffect(() => {
    if (!supported || !isConnected) return;
    let cancelled = false;
    const sync = async () => {
      const remote = await client.getSidebarOrder();
      if (cancelled) return;
      if (!isEmptyOrder(remote)) {
        applyRemote(remote);
        return;
      }
      if (!getIsElectron()) return;
      const local = useSidebarOrderStore.getState().getSnapshot();
      if (isEmptyOrder(local)) return;
      lastSyncedRef.current = canonicalize(local);
      await client.setSidebarOrder(local);
    };
    void sync().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [supported, isConnected, client]);

  // Live updates broadcast by the daemon when another device reorders.
  useEffect(() => {
    if (!supported) return;
    const unsub = client.on("status", (message) => {
      if (message.type !== "status") return;
      const payload = message.payload as { status?: string; order?: SidebarOrder };
      if (payload.status !== "sidebar_order_changed" || !payload.order) return;
      applyRemote(payload.order);
    });
    return unsub;
  }, [supported, client]);

  // Push local reorders to the daemon (debounced), ignoring daemon-driven writes.
  useEffect(() => {
    if (!supported || !isConnected) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = useSidebarOrderStore.subscribe((state) => {
      if (applyingRemoteRef.current) return;
      const snapshot: SidebarOrderSnapshot = {
        projectOrder: state.projectOrder,
        workspaceOrderByProject: state.workspaceOrderByProject,
      };
      const serialized = canonicalize(snapshot);
      if (serialized === lastSyncedRef.current) return;
      lastSyncedRef.current = serialized;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => pushOrder(client, snapshot), PUSH_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
    };
  }, [supported, isConnected, client]);
}
