import { describe, it, expect, vi } from "vitest";
import {
  createClientChannel,
  createDaemonChannel,
  EncryptedMessageTooLargeError,
  Transport,
} from "./encrypted-channel.js";
import { generateKeyPair, exportPublicKey } from "./crypto.js";

/** Cloudflare closes a relayed WebSocket message larger than this with code 1009. */
const CLOUDFLARE_MESSAGE_LIMIT_BYTES = 1024 * 1024;

/**
 * Creates a pair of connected mock transports.
 * Messages sent on one are received on the other.
 */
function createMockTransportPair(): [Transport, Transport] {
  const transportA: Transport = {
    send: vi.fn(),
    close: vi.fn(),
    onmessage: null,
    onclose: null,
    onerror: null,
  };

  const transportB: Transport = {
    send: vi.fn(),
    close: vi.fn(),
    onmessage: null,
    onclose: null,
    onerror: null,
  };

  // Wire them together
  (transportA.send as ReturnType<typeof vi.fn>).mockImplementation((data: string | ArrayBuffer) => {
    setTimeout(() => transportB.onmessage?.(data), 0);
  });

  (transportB.send as ReturnType<typeof vi.fn>).mockImplementation((data: string | ArrayBuffer) => {
    setTimeout(() => transportA.onmessage?.(data), 0);
  });

  return [transportA, transportB];
}

async function waitForAsyncDelivery(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("EncryptedChannel", () => {
  it("establishes encrypted channel between daemon and client", async () => {
    const [daemonTransport, clientTransport] = createMockTransportPair();

    // Daemon generates keypair (public key goes in QR)
    const daemonKeyPair = generateKeyPair();
    const daemonPubKeyB64 = exportPublicKey(daemonKeyPair.publicKey);

    let clientOpenedResolve: (() => void) | null = null;
    const clientOpened = new Promise<void>((resolve) => {
      clientOpenedResolve = resolve;
    });

    // Start daemon waiting for client
    const daemonChannelPromise = createDaemonChannel(daemonTransport, daemonKeyPair);

    // Client connects (scanned QR, got daemon's public key)
    const clientChannel = await createClientChannel(clientTransport, daemonPubKeyB64, {
      onopen: () => clientOpenedResolve?.(),
    });

    // Daemon receives hello and completes handshake
    const daemonChannel = await daemonChannelPromise;
    await clientOpened;

    expect(clientChannel.isOpen()).toBe(true);
    expect(daemonChannel.isOpen()).toBe(true);
  });

  it("exchanges encrypted messages bidirectionally", async () => {
    const [daemonTransport, clientTransport] = createMockTransportPair();

    const daemonKeyPair = generateKeyPair();
    const daemonPubKeyB64 = exportPublicKey(daemonKeyPair.publicKey);

    const daemonMessages: (string | ArrayBuffer)[] = [];
    const clientMessages: (string | ArrayBuffer)[] = [];

    let clientOpenedResolve: (() => void) | null = null;
    const clientOpened = new Promise<void>((resolve) => {
      clientOpenedResolve = resolve;
    });

    const daemonChannelPromise = createDaemonChannel(daemonTransport, daemonKeyPair, {
      onmessage: (data) => daemonMessages.push(data),
    });

    const clientChannel = await createClientChannel(clientTransport, daemonPubKeyB64, {
      onmessage: (data) => clientMessages.push(data),
      onopen: () => clientOpenedResolve?.(),
    });

    const daemonChannel = await daemonChannelPromise;
    await clientOpened;

    // Send messages both directions
    await clientChannel.send("Hello from client");
    await daemonChannel.send("Hello from daemon");
    await clientChannel.send("Second message from client");

    // Wait for async delivery
    await waitForAsyncDelivery();

    expect(daemonMessages).toEqual(["Hello from client", "Second message from client"]);
    expect(clientMessages).toEqual(["Hello from daemon"]);
  });

  it("encrypted messages are opaque to transport", async () => {
    const [daemonTransport, clientTransport] = createMockTransportPair();

    const daemonKeyPair = generateKeyPair();
    const daemonPubKeyB64 = exportPublicKey(daemonKeyPair.publicKey);

    let clientOpenedResolve: (() => void) | null = null;
    const clientOpened = new Promise<void>((resolve) => {
      clientOpenedResolve = resolve;
    });

    const daemonChannelPromise = createDaemonChannel(daemonTransport, daemonKeyPair);
    const clientChannel = await createClientChannel(clientTransport, daemonPubKeyB64, {
      onopen: () => clientOpenedResolve?.(),
    });
    await daemonChannelPromise;
    await clientOpened;

    // Clear mock call history
    (clientTransport.send as ReturnType<typeof vi.fn>).mockClear();

    // Send a plaintext message
    const plaintext = "Secret message";
    await clientChannel.send(plaintext);

    // Check what was actually sent over the transport
    expect(clientTransport.send).toHaveBeenCalledTimes(1);
    const sentData = (clientTransport.send as ReturnType<typeof vi.fn>).mock.calls[0][0];

    // Should be base64 string (encrypted)
    expect(typeof sentData).toBe("string");
    // Should NOT contain the plaintext
    expect(sentData).not.toContain(plaintext);
    // Should be significantly longer than plaintext (IV + auth tag overhead)
    expect(sentData.length).toBeGreaterThan(plaintext.length + 20);
  });

  it("does not throw uncaught when handshake hello retry send fails", async () => {
    vi.useFakeTimers();
    try {
      const daemonKeyPair = generateKeyPair();
      const daemonPubKeyB64 = exportPublicKey(daemonKeyPair.publicKey);

      const transport: Transport = {
        send: vi.fn(),
        close: vi.fn(),
        onmessage: null,
        onclose: null,
        onerror: null,
      };

      let sendAttempts = 0;
      (transport.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
        sendAttempts += 1;
        if (sendAttempts >= 2) {
          throw new Error("WebSocket not open (readyState=2)");
        }
      });

      const onerror = vi.fn();
      await createClientChannel(transport, daemonPubKeyB64, { onerror });

      expect(() => {
        vi.advanceTimersByTime(1000);
      }).not.toThrow();

      expect(onerror).toHaveBeenCalledTimes(1);
      expect(onerror.mock.calls[0][0]).toBeInstanceOf(Error);
      expect((onerror.mock.calls[0][0] as Error).message).toContain("WebSocket not open");

      // Close the transport to stop retry timer.
      transport.onclose?.(1000, "closed");
      vi.runOnlyPendingTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails handshake on invalid hello", async () => {
    const [daemonTransport] = createMockTransportPair();

    const daemonKeyPair = generateKeyPair();

    const daemonChannelPromise = createDaemonChannel(daemonTransport, daemonKeyPair);

    // Send invalid hello
    setTimeout(() => {
      daemonTransport.onmessage?.('{"type":"invalid"}');
    }, 0);

    await expect(daemonChannelPromise).rejects.toThrow("Invalid hello message");
  });

  it("accepts duplicate hello from the same client without re-keying", async () => {
    const [daemonTransport, clientTransport] = createMockTransportPair();

    const daemonKeyPair = generateKeyPair();
    const daemonPubKeyB64 = exportPublicKey(daemonKeyPair.publicKey);
    const daemonMessages: (string | ArrayBuffer)[] = [];

    let clientOpenedResolve: (() => void) | null = null;
    const clientOpened = new Promise<void>((resolve) => {
      clientOpenedResolve = resolve;
    });

    const daemonChannelPromise = createDaemonChannel(daemonTransport, daemonKeyPair, {
      onmessage: (data) => daemonMessages.push(data),
    });

    const clientChannel = await createClientChannel(clientTransport, daemonPubKeyB64, {
      onopen: () => clientOpenedResolve?.(),
    });

    await daemonChannelPromise;
    await clientOpened;

    const firstHello = (clientTransport.send as ReturnType<typeof vi.fn>).mock.calls.find(
      ([data]) => typeof data === "string" && data.includes('"type":"e2ee_hello"'),
    )?.[0];
    expect(typeof firstHello).toBe("string");

    daemonTransport.onmessage?.(firstHello as string);
    await waitForAsyncDelivery();

    expect(daemonTransport.close).not.toHaveBeenCalled();

    await clientChannel.send("still encrypted with original key");
    await waitForAsyncDelivery();

    expect(daemonMessages).toEqual(["still encrypted with original key"]);
  });

  it("closes an open daemon channel when a different client key sends hello", async () => {
    const [daemonTransport, clientTransport] = createMockTransportPair();

    const daemonKeyPair = generateKeyPair();
    const daemonPubKeyB64 = exportPublicKey(daemonKeyPair.publicKey);

    let clientOpenedResolve: (() => void) | null = null;
    const clientOpened = new Promise<void>((resolve) => {
      clientOpenedResolve = resolve;
    });

    const daemonChannelPromise = createDaemonChannel(daemonTransport, daemonKeyPair);

    await createClientChannel(clientTransport, daemonPubKeyB64, {
      onopen: () => clientOpenedResolve?.(),
    });

    await daemonChannelPromise;
    await clientOpened;

    const attackerKeyPair = generateKeyPair();
    const attackerHello = JSON.stringify({
      type: "e2ee_hello",
      key: exportPublicKey(attackerKeyPair.publicKey),
    });

    daemonTransport.onmessage?.(attackerHello);
    await waitForAsyncDelivery();

    expect(daemonTransport.close).toHaveBeenCalledWith(1008, "E2EE re-handshake key mismatch");
  });

  it("round-trips messages larger than the relay frame ceiling via chunking", async () => {
    const [daemonTransport, clientTransport] = createMockTransportPair();

    const daemonKeyPair = generateKeyPair();
    const daemonPubKeyB64 = exportPublicKey(daemonKeyPair.publicKey);

    const daemonMessages: (string | ArrayBuffer)[] = [];
    const clientMessages: (string | ArrayBuffer)[] = [];

    let clientOpenedResolve: (() => void) | null = null;
    const clientOpened = new Promise<void>((resolve) => {
      clientOpenedResolve = resolve;
    });

    const daemonChannelPromise = createDaemonChannel(daemonTransport, daemonKeyPair, {
      onmessage: (data) => daemonMessages.push(data),
    });
    const clientChannel = await createClientChannel(clientTransport, daemonPubKeyB64, {
      onmessage: (data) => clientMessages.push(data),
      onopen: () => clientOpenedResolve?.(),
    });
    const daemonChannel = await daemonChannelPromise;
    await clientOpened;

    // ~3 MB — comfortably over the 1 MiB single-frame ceiling, so it must chunk.
    const bigFromClient = "A".repeat(3_000_000);
    (clientTransport.send as ReturnType<typeof vi.fn>).mockClear();
    await clientChannel.send(bigFromClient);
    await waitForAsyncDelivery();

    // Delivered whole and intact on the other side.
    expect(daemonMessages).toEqual([bigFromClient]);

    // The wire carried several frames, each safely under Cloudflare's ceiling.
    const frames = (clientTransport.send as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) {
      expect(typeof frame).toBe("string");
      expect((frame as string).length).toBeLessThan(CLOUDFLARE_MESSAGE_LIMIT_BYTES);
      expect(JSON.parse(frame as string).type).toBe("e2ee_chunk");
    }

    // The reverse direction chunks too (daemon -> client).
    const bigFromDaemon = "B".repeat(3_000_000);
    await daemonChannel.send(bigFromDaemon);
    await waitForAsyncDelivery();
    expect(clientMessages).toEqual([bigFromDaemon]);

    // A small message still rides as a single opaque ciphertext frame.
    (clientTransport.send as ReturnType<typeof vi.fn>).mockClear();
    await clientChannel.send("tiny");
    await waitForAsyncDelivery();
    const smallFrames = (clientTransport.send as ReturnType<typeof vi.fn>).mock.calls;
    expect(smallFrames.length).toBe(1);
    expect((smallFrames[0][0] as string).startsWith("{")).toBe(false);
    expect(daemonMessages).toEqual([bigFromClient, "tiny"]);
  });

  it("throws instead of blowing the transport when the peer cannot reassemble", async () => {
    const daemonKeyPair = generateKeyPair();
    const daemonPubKeyB64 = exportPublicKey(daemonKeyPair.publicKey);

    const transport: Transport = {
      send: vi.fn(),
      close: vi.fn(),
      onmessage: null,
      onclose: null,
      onerror: null,
    };

    const channel = await createClientChannel(transport, daemonPubKeyB64);

    // Simulate an old daemon that acknowledges without advertising chunk support.
    transport.onmessage?.('{"type":"e2ee_ready"}');
    await waitForAsyncDelivery();
    expect(channel.isOpen()).toBe(true);

    (transport.send as ReturnType<typeof vi.fn>).mockClear();
    await expect(channel.send("C".repeat(3_000_000))).rejects.toBeInstanceOf(
      EncryptedMessageTooLargeError,
    );
    // Nothing oversized was pushed onto the wire.
    expect(transport.send).not.toHaveBeenCalled();
  });
});
