import { test, expect } from "vitest";

import type { SidebarOrder } from "./messages.js";
import { DaemonClient } from "./test-utils/index.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

// End-to-end coverage for the daemon-persisted sidebar order: a set from one
// client persists, is readable by a freshly connected client, and is broadcast
// live to every other connected client.
test("settings.sidebarOrder persists and broadcasts across clients", async () => {
  const daemon = await createTestPaseoDaemon();
  const url = `ws://127.0.0.1:${daemon.port}/ws`;
  const clientA = new DaemonClient({ url, appVersion: "0.1.108" });
  const clientB = new DaemonClient({ url, appVersion: "0.1.108" });

  const order: SidebarOrder = {
    projectOrder: ["proj-b", "proj-a"],
    workspaceOrderByProject: { "proj-a": ["ws-2", "ws-1"] },
  };

  try {
    await clientA.connect();
    await clientB.connect();

    // Fresh daemon starts empty.
    const initial = await clientA.getSidebarOrder();
    expect(initial).toEqual({ projectOrder: [], workspaceOrderByProject: {} });

    // clientB listens for the broadcast triggered by clientA's write.
    const broadcast = new Promise<SidebarOrder>((resolve) => {
      clientB.on("status", (message) => {
        if (message.type !== "status") return;
        const payload = message.payload as { status?: string; order?: SidebarOrder };
        if (payload.status === "sidebar_order_changed" && payload.order) {
          resolve(payload.order);
        }
      });
    });

    await clientA.setSidebarOrder(order);

    // Persisted: the writer reads it back.
    expect(await clientA.getSidebarOrder()).toEqual(order);

    // Broadcast: the other connected client is notified live.
    expect(await broadcast).toEqual(order);

    // Durable: a brand-new connection sees the persisted order.
    const clientC = new DaemonClient({ url, appVersion: "0.1.108" });
    await clientC.connect();
    try {
      expect(await clientC.getSidebarOrder()).toEqual(order);
    } finally {
      await clientC.close().catch(() => undefined);
    }
  } finally {
    await clientA.close().catch(() => undefined);
    await clientB.close().catch(() => undefined);
    await daemon.close();
  }
}, 180000);
