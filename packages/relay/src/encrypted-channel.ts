/// <reference lib="dom" />
/**
 * Encrypted channel that wraps a WebSocket-like transport.
 *
 * Handles ECDH handshake and encrypts/decrypts all messages.
 * Works identically for daemon and client sides.
 */

import {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSharedKey,
  encrypt,
  decrypt,
  type KeyPair,
  type SharedKey,
} from "./crypto.js";
import { arrayBufferToBase64, base64ToArrayBuffer } from "./base64.js";

export interface Transport {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onmessage: ((data: string | ArrayBuffer) => void) | null;
  onclose: ((code: number, reason: string) => void) | null;
  onerror: ((error: Error) => void) | null;
}

export interface EncryptedChannelEvents {
  onopen?: () => void;
  onmessage?: (data: string | ArrayBuffer) => void;
  onclose?: (code: number, reason: string) => void;
  onerror?: (error: Error) => void;
}

type ChannelState = "connecting" | "handshaking" | "open" | "closed";

interface EncryptedChannelOptions {
  /**
   * If set, the channel can validate repeated plaintext `{type:"e2ee_hello"}`
   * messages even after it is open.
   *
   * This is useful for robustness when the client retries the handshake
   * (e.g., it didn't observe the daemon's `{type:"e2ee_ready"}` yet). In that case,
   * the daemon should re-send `{type:"e2ee_ready"}` without changing keys.
   */
  daemonKeyPair?: KeyPair;
}

interface E2EEHelloMessage {
  type: "e2ee_hello";
  key: string;
  /** Optional channel features supported by the sender (e.g. chunking). */
  features?: string[];
}

interface E2EEReadyMessage {
  type: "e2ee_ready";
  /** Optional channel features supported by the sender (e.g. chunking). */
  features?: string[];
}

/**
 * A slice of one encrypted message, sent when the whole base64 ciphertext
 * would exceed the relay's per-frame limit. Only ever sent to peers that
 * advertised CHUNKING_FEATURE during the handshake; receivers always accept
 * chunks regardless of what they advertised.
 */
interface E2EEChunkMessage {
  type: "e2ee_chunk";
  id: number;
  seq: number;
  of: number;
  data: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isE2EEHelloMessage(value: unknown): value is E2EEHelloMessage {
  return (
    isRecord(value) &&
    value.type === "e2ee_hello" &&
    typeof value.key === "string" &&
    value.key.trim().length > 0
  );
}

function isE2EEReadyMessage(value: unknown): value is E2EEReadyMessage {
  return isRecord(value) && value.type === "e2ee_ready";
}

function isE2EEChunkMessage(value: unknown): value is E2EEChunkMessage {
  return (
    isRecord(value) &&
    value.type === "e2ee_chunk" &&
    typeof value.id === "number" &&
    typeof value.seq === "number" &&
    typeof value.of === "number" &&
    Number.isInteger(value.seq) &&
    Number.isInteger(value.of) &&
    value.seq >= 0 &&
    value.of >= 1 &&
    value.seq < value.of &&
    typeof value.data === "string"
  );
}

function extractPeerFeatures(value: E2EEHelloMessage | E2EEReadyMessage): string[] {
  if (!Array.isArray(value.features)) return [];
  return value.features.filter((feature): feature is string => typeof feature === "string");
}

/** Fatal chunk-reassembly protocol violation; closes the transport like a decrypt failure. */
class E2EEChunkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "E2EEChunkError";
  }
}

function buildInvalidHelloError(rawText: string, parsed?: unknown): Error {
  const parsedRecord = isRecord(parsed) ? parsed : null;
  const rawType = parsedRecord?.type;
  function describeType(value: unknown): string {
    if (typeof value === "string") return value;
    if (value === undefined) return "undefined";
    return typeof value;
  }
  const receivedType = describeType(rawType);
  const hasKey = typeof parsedRecord?.key === "string" && parsedRecord.key.trim().length > 0;
  const compact = rawText.replace(/\s+/g, " ").trim();
  const preview = compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
  return new Error(
    `Invalid hello message (receivedType=${receivedType}, hasKey=${hasKey}, preview=${JSON.stringify(preview)})`,
  );
}

const HANDSHAKE_RETRY_MS = 1000;
const MAX_PENDING_SENDS = 200;

/**
 * Cloudflare Workers closes WebSockets with code 1009 when a single frame
 * exceeds 1 MiB. Ciphertext travels as base64 text (1 char = 1 byte on the
 * wire), so keep single frames comfortably below the limit and split larger
 * messages into chunk envelopes when the peer supports reassembly.
 */
export const CHUNKING_FEATURE = "chunking_v1";
const CHANNEL_FEATURES = [CHUNKING_FEATURE];
const SINGLE_FRAME_MAX_CHARS = 900_000;
const CHUNK_DATA_CHARS = 800_000;
/** Upper bound on a reassembled message; guards against unbounded buffering. */
const MAX_CHUNKED_MESSAGE_CHARS = 64 * 1024 * 1024;
const REHANDSHAKE_KEY_MISMATCH_CLOSE_CODE = 1008;
const REHANDSHAKE_KEY_MISMATCH_CLOSE_REASON = "E2EE re-handshake key mismatch";

interface TimeoutWithUnref {
  unref(): void;
}

function hasUnref(timeout: unknown): timeout is TimeoutWithUnref {
  return (
    typeof timeout === "object" &&
    timeout !== null &&
    "unref" in timeout &&
    typeof (timeout as Record<string, unknown>).unref === "function"
  );
}

/**
 * Creates an encrypted channel as the initiator (client).
 *
 * The client:
 * 1. Receives daemon's public key via QR code
 * 2. Generates own keypair
 * 3. Sends e2ee_hello with own public key
 * 4. Derives shared key and starts encrypted communication
 */
export async function createClientChannel(
  transport: Transport,
  daemonPublicKeyB64: string,
  events: EncryptedChannelEvents = {},
): Promise<EncryptedChannel> {
  const keyPair = generateKeyPair();
  const daemonPublicKey = importPublicKey(daemonPublicKeyB64);
  const sharedKey = deriveSharedKey(keyPair.secretKey, daemonPublicKey);

  const channel = new EncryptedChannel(transport, sharedKey, events);

  // Send e2ee_hello with our public key
  const ourPublicKeyB64 = exportPublicKey(keyPair.publicKey);
  const hello: E2EEHelloMessage = {
    type: "e2ee_hello",
    key: ourPublicKeyB64,
    features: CHANNEL_FEATURES,
  };
  const helloText = JSON.stringify(hello);

  let retry: ReturnType<typeof setInterval> | null = null;
  const emitSendError = (error: unknown) => {
    const err = error instanceof Error ? error : new Error(String(error));
    events.onerror?.(err);
  };
  const sendHello = () => {
    try {
      transport.send(helloText);
      return true;
    } catch (error) {
      // This can happen during daemon restarts while the socket transitions
      // through CLOSING/CLOSED states. Report it but do not throw from timers.
      emitSendError(error);
      return false;
    }
  };
  const clearRetry = () => {
    if (retry) {
      clearInterval(retry);
      retry = null;
    }
  };

  channel.onTransitionToOpen(() => clearRetry());
  channel.onClose(() => clearRetry());

  sendHello();
  retry = setInterval(() => {
    if (channel.isOpen()) {
      clearRetry();
      return;
    }
    sendHello();
  }, HANDSHAKE_RETRY_MS);
  // Avoid keeping Node processes alive (e.g. tests) if the handshake is stuck.
  if (hasUnref(retry)) {
    retry.unref();
  }

  return channel;
}

/**
 * Creates an encrypted channel as the responder (daemon).
 *
 * The daemon:
 * 1. Has pre-generated keypair (public key was in QR)
 * 2. Waits for client's e2ee_hello with their public key
 * 3. Derives shared key and starts encrypted communication
 */
export async function createDaemonChannel(
  transport: Transport,
  daemonKeyPair: KeyPair,
  events: EncryptedChannelEvents = {},
): Promise<EncryptedChannel> {
  return new Promise((resolve, reject) => {
    const bufferedMessages: Array<string | ArrayBuffer> = [];
    const shouldIgnorePostHelloPlaintext = (data: string | ArrayBuffer): boolean => {
      try {
        const text = typeof data === "string" ? data : new TextDecoder().decode(data);
        const parsed: unknown = JSON.parse(text);
        return isE2EEHelloMessage(parsed) || isE2EEReadyMessage(parsed);
      } catch {
        return false;
      }
    };

    const handleHello = async (data: string | ArrayBuffer): Promise<void> => {
      try {
        const helloText = typeof data === "string" ? data : new TextDecoder().decode(data);

        let parsed: unknown;
        try {
          parsed = JSON.parse(helloText);
        } catch {
          throw buildInvalidHelloError(helloText);
        }

        if (!isE2EEHelloMessage(parsed)) {
          throw buildInvalidHelloError(helloText, parsed);
        }

        const msg = parsed;

        // Buffer any subsequent messages that arrive while we're doing async
        // WebCrypto work to derive the shared key. Without this, it's possible
        // for the next message (already encrypted) to be misinterpreted as a
        // second hello, causing the handshake to fail.
        const bufferNext = (next: string | ArrayBuffer): void => {
          bufferedMessages.push(next);
        };
        Object.assign(transport, { onmessage: bufferNext });

        const clientPublicKey = importPublicKey(msg.key);
        const sharedKey = deriveSharedKey(daemonKeyPair.secretKey, clientPublicKey);

        const channel = new EncryptedChannel(transport, sharedKey, events, { daemonKeyPair });
        channel.setPeerFeatures(extractPeerFeatures(msg));
        transport.send(
          JSON.stringify({
            type: "e2ee_ready",
            features: CHANNEL_FEATURES,
          } satisfies E2EEReadyMessage),
        );

        channel.setState("open");
        events.onopen?.();

        for (const buffered of bufferedMessages) {
          if (shouldIgnorePostHelloPlaintext(buffered)) continue;
          transport.onmessage?.(buffered);
        }

        resolve(channel);
      } catch (error) {
        reject(error);
      }
    };

    Object.assign(transport, {
      onmessage: handleHello,
      onerror: (error: Error) => {
        reject(error);
      },
      onclose: (code: number, reason: string) => {
        reject(new Error(`Connection closed during handshake: ${code} ${reason}`));
      },
    });
  });
}

/**
 * Encrypted channel that wraps a transport with E2EE.
 */
export class EncryptedChannel {
  private transport: Transport;
  private sharedKey: SharedKey;
  private state: ChannelState = "handshaking";
  private events: EncryptedChannelEvents;
  private options: EncryptedChannelOptions;
  private pendingSends: Array<string | ArrayBuffer> = [];
  private onOpenCallbacks: Array<() => void> = [];
  private onCloseCallbacks: Array<() => void> = [];
  private peerFeatures: ReadonlySet<string> = new Set();
  private chunkSendCounter = 0;
  private pendingChunks: { id: number; of: number; parts: string[]; chars: number } | null = null;

  constructor(
    transport: Transport,
    sharedKey: SharedKey,
    events: EncryptedChannelEvents = {},
    options: EncryptedChannelOptions = {},
  ) {
    this.transport = transport;
    this.sharedKey = sharedKey;
    this.events = events;
    this.options = options;

    Object.assign(transport, {
      onmessage: (data: string | ArrayBuffer) => this.handleMessage(data),
      onclose: (code: number, reason: string) => {
        this.state = "closed";
        this.events.onclose?.(code, reason);
        for (const cb of this.onCloseCallbacks) cb();
      },
      onerror: (error: Error) => {
        this.events.onerror?.(error);
      },
    });
  }

  setState(state: ChannelState): void {
    this.state = state;
  }

  setPeerFeatures(features: readonly string[]): void {
    this.peerFeatures = new Set(features);
  }

  private async handleMessage(data: string | ArrayBuffer): Promise<void> {
    if (this.state === "handshaking") {
      try {
        const text = typeof data === "string" ? data : new TextDecoder().decode(data);
        const parsed: unknown = JSON.parse(text);
        if (isE2EEReadyMessage(parsed)) {
          this.setPeerFeatures(extractPeerFeatures(parsed));
          this.state = "open";
          this.events.onopen?.();
          for (const cb of this.onOpenCallbacks) cb();
          await this.flushPendingSends();
        }
      } catch {
        // ignore non-ready handshake traffic
      }
      return;
    }

    if (this.state !== "open") return;

    try {
      const ciphertext = await (async () => {
        // Handle (or ignore) any stray plaintext handshake traffic.
        try {
          const text = typeof data === "string" ? data : new TextDecoder().decode(data);
          if (text.trim().startsWith("{")) {
            const parsed: unknown = JSON.parse(text);

            if (isE2EEHelloMessage(parsed)) {
              if (this.options.daemonKeyPair) {
                await this.handleDaemonRehello(parsed);
              }
              return null;
            }

            if (isE2EEReadyMessage(parsed)) {
              this.setPeerFeatures(extractPeerFeatures(parsed));
              return null;
            }

            if (isE2EEChunkMessage(parsed)) {
              // Returns the reassembled ciphertext once all chunks arrived,
              // or null while the message is still incomplete.
              return this.acceptChunk(parsed);
            }

            // Any other JSON-looking payload is plaintext app traffic, which
            // means the peer is not encrypting (or we are out of sync).
            throw new Error("Received plaintext frame on encrypted channel");
          }
        } catch (error) {
          // If we detected plaintext protocol mismatch or a chunk protocol
          // violation, fail hard.
          if (error instanceof E2EEChunkError) {
            throw error;
          }
          if (error instanceof Error && error.message.includes("plaintext frame")) {
            throw error;
          }
          // Otherwise ignore JSON parse/TextDecoder failures and fall back to
          // decoding ciphertext below.
        }

        if (typeof data === "string") {
          return base64ToArrayBuffer(data);
        }

        // Some WebSocket implementations deliver text frames as ArrayBuffer.
        // Our protocol always transmits ciphertext as base64 text.
        try {
          const decoded = new TextDecoder().decode(data);
          return base64ToArrayBuffer(decoded);
        } catch {
          return data;
        }
      })();

      if (ciphertext) {
        const plaintext = decrypt(this.sharedKey, ciphertext);
        this.events.onmessage?.(plaintext);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      // Treat decryption/protocol errors as fatal so the peer can reconnect and
      // re-handshake. Emitting an error event here can cause higher-level code
      // to tear down the session without triggering a clean reconnect.
      try {
        this.transport.close(1011, err.message);
      } catch {
        // ignore
      }
    }
  }

  async send(data: string | ArrayBuffer): Promise<void> {
    if (this.state === "handshaking") {
      if (this.pendingSends.length >= MAX_PENDING_SENDS) {
        this.pendingSends.shift();
      }
      this.pendingSends.push(data);
      return;
    }

    if (this.state !== "open") {
      throw new Error("Channel not open");
    }

    const ciphertext = encrypt(this.sharedKey, data);
    // Send as base64 for WebSocket text compatibility
    const encoded = arrayBufferToBase64(ciphertext);
    if (encoded.length <= SINGLE_FRAME_MAX_CHARS || !this.peerFeatures.has(CHUNKING_FEATURE)) {
      // Peers that never advertised chunking get the historical single-frame
      // behavior (the relay may reject oversized frames, as before).
      this.transport.send(encoded);
      return;
    }

    const id = ++this.chunkSendCounter;
    const total = Math.ceil(encoded.length / CHUNK_DATA_CHARS);
    for (let seq = 0; seq < total; seq += 1) {
      const chunk: E2EEChunkMessage = {
        type: "e2ee_chunk",
        id,
        seq,
        of: total,
        data: encoded.slice(seq * CHUNK_DATA_CHARS, (seq + 1) * CHUNK_DATA_CHARS),
      };
      this.transport.send(JSON.stringify(chunk));
    }
  }

  /**
   * Accepts one chunk of a split ciphertext. Chunks of a single message are
   * sent back-to-back on an ordered transport, so any gap, reorder, or
   * mismatch is a protocol violation and closes the channel.
   */
  private acceptChunk(chunk: E2EEChunkMessage): ArrayBuffer | null {
    if (chunk.seq === 0) {
      this.pendingChunks = { id: chunk.id, of: chunk.of, parts: [], chars: 0 };
    }

    const pending = this.pendingChunks;
    if (
      !pending ||
      pending.id !== chunk.id ||
      pending.of !== chunk.of ||
      pending.parts.length !== chunk.seq
    ) {
      this.pendingChunks = null;
      throw new E2EEChunkError("Received out-of-order e2ee chunk");
    }

    pending.chars += chunk.data.length;
    if (pending.chars > MAX_CHUNKED_MESSAGE_CHARS) {
      this.pendingChunks = null;
      throw new E2EEChunkError("Chunked e2ee message exceeds maximum size");
    }

    pending.parts.push(chunk.data);
    if (pending.parts.length < pending.of) {
      return null;
    }

    this.pendingChunks = null;
    return base64ToArrayBuffer(pending.parts.join(""));
  }

  private async flushPendingSends(): Promise<void> {
    if (this.state !== "open") return;
    const pending = this.pendingSends;
    this.pendingSends = [];
    for (const item of pending) {
      await this.send(item);
    }
  }

  private async handleDaemonRehello(hello: E2EEHelloMessage): Promise<void> {
    if (!this.options.daemonKeyPair) return;
    const clientPublicKey = importPublicKey(hello.key);
    const nextSharedKey = deriveSharedKey(this.options.daemonKeyPair.secretKey, clientPublicKey);

    // If it's the same client key (handshake retry), re-send
    // "ready" but do not re-key. Re-keying here would desync
    // the channel and cause decrypt failures.
    if (keysEqual(nextSharedKey, this.sharedKey)) {
      this.setPeerFeatures(extractPeerFeatures(hello));
      this.transport.send(
        JSON.stringify({
          type: "e2ee_ready",
          features: CHANNEL_FEATURES,
        } satisfies E2EEReadyMessage),
      );
      return;
    }

    // A different key on an already-open encrypted channel is not an
    // authenticated reconnect. Close and require a fresh transport instead of
    // allowing the relay to switch this channel to an attacker-chosen key.
    this.state = "closed";
    this.transport.close(
      REHANDSHAKE_KEY_MISMATCH_CLOSE_CODE,
      REHANDSHAKE_KEY_MISMATCH_CLOSE_REASON,
    );
  }

  close(code = 1000, reason = "Normal closure"): void {
    this.state = "closed";
    this.transport.close(code, reason);
  }

  isOpen(): boolean {
    return this.state === "open";
  }

  onTransitionToOpen(cb: () => void): void {
    this.onOpenCallbacks.push(cb);
  }

  onClose(cb: () => void): void {
    this.onCloseCallbacks.push(cb);
  }
}

function keysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let difference = 0;
  for (let i = 0; i < a.byteLength; i += 1) {
    difference |= a[i] ^ b[i];
  }
  return difference === 0;
}
