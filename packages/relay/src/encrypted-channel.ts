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
  /**
   * Whether the peer advertised support for chunked framing. On the daemon side
   * this is known from the client's hello at construction time; on the client
   * side it is learned later from the daemon's ready and set then.
   */
  peerSupportsChunking?: boolean;
}

interface E2EEHelloMessage {
  type: "e2ee_hello";
  key: string;
  /** Optional capability tokens. Absent on peers predating chunked framing. */
  caps?: string[];
}

interface E2EEReadyMessage {
  type: "e2ee_ready";
  /** Optional capability tokens. Absent on peers predating chunked framing. */
  caps?: string[];
}

/**
 * A slice of an oversized encrypted frame. The `d` fields of all `n` chunks
 * sharing an `id`, concatenated in `i` order, reproduce the original base64
 * ciphertext string, which is then decrypted as a whole.
 */
interface E2EEChunkMessage {
  type: "e2ee_chunk";
  id: string;
  i: number;
  n: number;
  d: string;
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
    typeof value.id === "string" &&
    Number.isInteger(value.n) &&
    (value.n as number) > 0 &&
    Number.isInteger(value.i) &&
    (value.i as number) >= 0 &&
    (value.i as number) < (value.n as number) &&
    typeof value.d === "string"
  );
}

/** Capability advertised by both peers once they support chunked framing. */
const CHUNK_CAP = "chunk";
const LOCAL_CAPS: readonly string[] = [CHUNK_CAP];

function peerAdvertisesChunking(parsed: unknown): boolean {
  if (!isRecord(parsed)) return false;
  const caps = parsed.caps;
  return Array.isArray(caps) && caps.includes(CHUNK_CAP);
}

/**
 * Cloudflare (which fronts the relay) rejects any single WebSocket message
 * larger than 1 MiB, closing the socket with code 1009. Keep whole frames
 * comfortably under that; larger encrypted payloads are split into
 * {@link E2EEChunkMessage} frames and reassembled by the peer.
 */
const MAX_WIRE_FRAME_CHARS = 900_000;
/** base64 chars carried per chunk frame (well under the 1 MiB wire ceiling). */
const CHUNK_PAYLOAD_CHARS = 512 * 1024;
/** Hard cap on a single reassembled message, to bound memory from a hostile relay. */
const MAX_REASSEMBLED_WIRE_CHARS = 64 * 1024 * 1024;

/**
 * Thrown by {@link EncryptedChannel.send} when a message exceeds the wire
 * ceiling and the peer is too old to reassemble chunks. Surfaced to the caller
 * instead of silently blowing the transport with a 1009.
 */
export class EncryptedMessageTooLargeError extends Error {
  constructor(
    public readonly wireChars: number,
    public readonly limitChars: number,
  ) {
    super(
      `Encrypted message too large for relay (${wireChars} > ${limitChars} base64 chars) ` +
        `and the peer does not support chunked framing`,
    );
    this.name = "EncryptedMessageTooLargeError";
  }
}

interface ChunkReassembly {
  total: number;
  parts: Array<string | undefined>;
  received: number;
  chars: number;
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
    caps: [...LOCAL_CAPS],
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

        const channel = new EncryptedChannel(transport, sharedKey, events, {
          daemonKeyPair,
          peerSupportsChunking: peerAdvertisesChunking(msg),
        });
        transport.send(
          JSON.stringify({ type: "e2ee_ready", caps: [...LOCAL_CAPS] } satisfies E2EEReadyMessage),
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
  private peerSupportsChunking: boolean;
  private chunkSeq = 0;
  private readonly incomingChunks = new Map<string, ChunkReassembly>();

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
    this.peerSupportsChunking = options.peerSupportsChunking ?? false;

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

  private async handleMessage(data: string | ArrayBuffer): Promise<void> {
    if (this.state === "handshaking") {
      try {
        const text = typeof data === "string" ? data : new TextDecoder().decode(data);
        const parsed: unknown = JSON.parse(text);
        if (isE2EEReadyMessage(parsed)) {
          this.peerSupportsChunking = peerAdvertisesChunking(parsed);
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

    // JSON control traffic (base64 ciphertext never starts with "{").
    const text = tryDecodeText(data);
    if (text !== null && text.trim().startsWith("{")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (parsed !== undefined) {
        if (isE2EEHelloMessage(parsed)) {
          if (this.options.daemonKeyPair) {
            await this.handleDaemonRehello(parsed.key);
          }
          return;
        }
        if (isE2EEReadyMessage(parsed)) return;
        if (isE2EEChunkMessage(parsed)) {
          await this.handleChunkFrame(parsed);
          return;
        }
        // Any other JSON-looking payload is plaintext app traffic, which
        // means the peer is not encrypting (or we are out of sync).
        this.failFatal(new Error("Received plaintext frame on encrypted channel"));
        return;
      }
    }

    await this.decryptAndEmit(data);
  }

  /** Decode a base64 ciphertext frame, decrypt it, and emit the plaintext. */
  private async decryptAndEmit(data: string | ArrayBuffer): Promise<void> {
    try {
      let ciphertext: ArrayBuffer;
      if (typeof data === "string") {
        ciphertext = base64ToArrayBuffer(data);
      } else {
        // Some WebSocket implementations deliver text frames as ArrayBuffer.
        // Our protocol always transmits ciphertext as base64 text.
        try {
          ciphertext = base64ToArrayBuffer(new TextDecoder().decode(data));
        } catch {
          ciphertext = data;
        }
      }
      const plaintext = decrypt(this.sharedKey, ciphertext);
      this.events.onmessage?.(plaintext);
    } catch (error) {
      this.failFatal(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Buffer a chunk; once all chunks of its message arrive, decrypt the whole. */
  private async handleChunkFrame(msg: E2EEChunkMessage): Promise<void> {
    let entry = this.incomingChunks.get(msg.id);
    if (!entry) {
      entry = {
        total: msg.n,
        parts: Array.from({ length: msg.n }, () => undefined),
        received: 0,
        chars: 0,
      };
      this.incomingChunks.set(msg.id, entry);
    }
    if (entry.total !== msg.n || msg.i >= entry.total) {
      this.incomingChunks.delete(msg.id);
      this.failFatal(new Error("Invalid e2ee_chunk framing"));
      return;
    }
    if (entry.parts[msg.i] !== undefined) return; // duplicate slice, ignore
    entry.parts[msg.i] = msg.d;
    entry.received += 1;
    entry.chars += msg.d.length;
    if (entry.chars > MAX_REASSEMBLED_WIRE_CHARS) {
      this.incomingChunks.delete(msg.id);
      this.failFatal(new Error("e2ee_chunk reassembly exceeds size cap"));
      return;
    }
    if (entry.received < entry.total) return;
    this.incomingChunks.delete(msg.id);
    await this.decryptAndEmit(entry.parts.join(""));
  }

  /**
   * Treat decryption/protocol errors as fatal so the peer can reconnect and
   * re-handshake. Emitting an error event here can cause higher-level code to
   * tear down the session without triggering a clean reconnect.
   */
  private failFatal(error: Error): void {
    try {
      this.transport.close(1011, error.message);
    } catch {
      // ignore
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
    // Send as base64 for WebSocket text compatibility.
    const wire = arrayBufferToBase64(ciphertext);

    if (wire.length <= MAX_WIRE_FRAME_CHARS) {
      this.transport.send(wire);
      return;
    }

    // Oversized: the relay's 1 MiB per-message ceiling would otherwise close the
    // socket with 1009. Split into chunk frames the peer reassembles.
    if (!this.peerSupportsChunking) {
      throw new EncryptedMessageTooLargeError(wire.length, MAX_WIRE_FRAME_CHARS);
    }
    const id = `${this.chunkSeq++}`;
    const total = Math.ceil(wire.length / CHUNK_PAYLOAD_CHARS);
    for (let i = 0; i < total; i += 1) {
      const d = wire.slice(i * CHUNK_PAYLOAD_CHARS, (i + 1) * CHUNK_PAYLOAD_CHARS);
      this.transport.send(
        JSON.stringify({ type: "e2ee_chunk", id, i, n: total, d } satisfies E2EEChunkMessage),
      );
    }
  }

  private async flushPendingSends(): Promise<void> {
    if (this.state !== "open") return;
    const pending = this.pendingSends;
    this.pendingSends = [];
    for (const item of pending) {
      await this.send(item);
    }
  }

  private async handleDaemonRehello(clientKeyB64: string): Promise<void> {
    if (!this.options.daemonKeyPair) return;
    const clientPublicKey = importPublicKey(clientKeyB64);
    const nextSharedKey = deriveSharedKey(this.options.daemonKeyPair.secretKey, clientPublicKey);

    // If it's the same client key (handshake retry), re-send
    // "ready" but do not re-key. Re-keying here would desync
    // the channel and cause decrypt failures.
    if (keysEqual(nextSharedKey, this.sharedKey)) {
      this.transport.send(JSON.stringify({ type: "e2ee_ready" } satisfies E2EEReadyMessage));
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

/** Best-effort decode of a wire frame to text; returns null if it is not decodable. */
function tryDecodeText(data: string | ArrayBuffer): string | null {
  if (typeof data === "string") return data;
  try {
    return new TextDecoder().decode(data);
  } catch {
    return null;
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
