/**
 * Real-socket fixture: a relay on 127.0.0.1 with an OS-assigned ephemeral port, driven by real
 * Bun WebSocket clients. Nothing here mocks the transport — the point of these tests is that the
 * bytes genuinely cross a socket (contract §5: local fixtures may use ws://127.0.0.1 only).
 */

import {
  base64urlEncode,
  PROTOCOL_VERSION,
  type ErrorCode,
  type Purpose,
  type Role,
} from "../src/protocol.ts";
import { hostSignatureMessage } from "../src/protocol.ts";
import { createRelayServer, type RelayServer, type RelayServerOptions } from "../src/server.ts";
import { sha256Hex } from "../src/hostChallenge.ts";

export interface Frame {
  readonly kind: "text" | "binary";
  readonly text?: string;
  readonly bytes?: Uint8Array;
}

/** A client that records every frame in arrival order, so order assertions are real. */
export class TestClient {
  readonly frames: Frame[] = [];
  readonly socket: WebSocket;
  closed = false;
  closeCode?: number;
  private waiters: Array<() => void> = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      const data = (event as MessageEvent).data;
      if (typeof data === "string") this.frames.push({ kind: "text", text: data });
      else this.frames.push({ kind: "binary", bytes: new Uint8Array(data as ArrayBuffer) });
      this.notify();
    });
    socket.addEventListener("close", (event) => {
      this.closed = true;
      this.closeCode = (event as CloseEvent).code;
      this.notify();
    });
    socket.addEventListener("error", () => {
      this.closed = true;
      this.notify();
    });
  }

  static async connect(url: string): Promise<TestClient> {
    const socket = new WebSocket(url);
    const client = new TestClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("socket failed to open")), { once: true });
    });
    return client;
  }

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  /** Waits until at least `count` frames have arrived, or the socket closed, or time runs out. */
  async waitForFrames(count: number, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.frames.length < count && !this.closed) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for ${count} frames (have ${this.frames.length})`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, Math.min(remaining, 50));
      });
    }
  }

  async waitForClose(timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("timed out waiting for close");
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, Math.min(remaining, 50));
      });
    }
  }

  json(index: number): Record<string, unknown> {
    const frame = this.frames[index];
    if (!frame || frame.kind !== "text" || !frame.text) throw new Error(`frame ${index} is not text`);
    return JSON.parse(frame.text) as Record<string, unknown>;
  }

  /** The challenge nonce, which every host signature is bound to. */
  async nonce(): Promise<string> {
    await this.waitForFrames(1);
    const frame = this.json(0);
    if (frame.type !== "challenge" || typeof frame.nonce !== "string") {
      throw new Error(`expected a challenge, got ${JSON.stringify(frame)}`);
    }
    return frame.nonce;
  }

  /** The error code this client was refused with, if it was. */
  errorCode(): ErrorCode | undefined {
    for (const frame of this.frames) {
      if (frame.kind !== "text" || !frame.text) continue;
      const body = JSON.parse(frame.text) as Record<string, unknown>;
      if (body.type === "error") return body.code as ErrorCode;
    }
    return undefined;
  }

  binaryFrames(): Uint8Array[] {
    return this.frames.filter((f) => f.kind === "binary").map((f) => f.bytes!);
  }

  send(data: string | Uint8Array): void {
    this.socket.send(data as never);
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // already gone
    }
  }
}

/** A P-256 identity standing in for the Mac helper's Secure Enclave signing key. */
export interface MacIdentity {
  readonly publicKeyBytes: Uint8Array;
  readonly publicKeyBase64: string;
  readonly fingerprint: string;
  sign(message: Uint8Array): Promise<string>;
}

function standardBase64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

export async function createMacIdentity(): Promise<MacIdentity> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const fingerprint = await sha256Hex(raw);
  return {
    publicKeyBytes: raw,
    publicKeyBase64: standardBase64(raw),
    fingerprint,
    async sign(message: Uint8Array): Promise<string> {
      // Raw r‖s, matching CryptoKit's rawRepresentation (no DER).
      const signature = new Uint8Array(
        await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, message as BufferSource),
      );
      return standardBase64(signature);
    },
  };
}

/** A room name for this identity: `<fingerprint>.<43-char base64url capability>`. */
export function roomFor(identity: MacIdentity, capability?: string): string {
  const cap = capability ?? base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  return `${identity.fingerprint}.${cap}`;
}

export function hostJoin(
  identity: MacIdentity,
  room: string,
  nonce: string,
  purpose: Purpose = "screen",
  version: number = PROTOCOL_VERSION,
): Promise<string> {
  return identity
    .sign(hostSignatureMessage(purpose, room, nonce, version))
    .then((signature) =>
      JSON.stringify({
        type: "join",
        version,
        role: "host" satisfies Role,
        purpose,
        room,
        publicKey: identity.publicKeyBase64,
        signature,
      }),
    );
}

export function controllerJoin(room: string, purpose: Purpose = "screen"): string {
  return JSON.stringify({
    type: "join",
    version: PROTOCOL_VERSION,
    role: "controller" satisfies Role,
    purpose,
    room,
  });
}

export interface Fixture {
  readonly server: RelayServer;
  connect(): Promise<TestClient>;
  /**
   * Waits until the server reports at least `count` live rooms.
   *
   * Host admission is asynchronous (the P-256 challenge is verified with WebCrypto), and the
   * protocol sends a waiting host no acknowledgement — only `paired`. So a controller that joins
   * before verification finishes is correctly told `offline` (contract §11). Tests therefore wait
   * for the room to exist instead of racing it; a real controller retries on `offline` instead.
   */
  waitForRooms(count: number, timeoutMs?: number): Promise<void>;
  /** A host and controller already paired on `room`, with their `paired` frames consumed. */
  pair(options?: { purpose?: Purpose; identity?: MacIdentity; room?: string }): Promise<{
    host: TestClient;
    controller: TestClient;
    room: string;
    identity: MacIdentity;
  }>;
  stop(): Promise<void>;
}

/** Starts a relay on an ephemeral 127.0.0.1 port and tracks clients for teardown. */
export function startFixture(options: RelayServerOptions = {}): Fixture {
  const server = createRelayServer({ hostname: "127.0.0.1", port: 0, ...options });
  const clients: TestClient[] = [];

  const fixture: Fixture = {
    server,
    async connect(): Promise<TestClient> {
      const client = await TestClient.connect(server.url);
      clients.push(client);
      return client;
    },
    async waitForRooms(count: number, timeoutMs = 2_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (server.core.stats().rooms < count) {
        if (Date.now() >= deadline) {
          throw new Error(`timed out waiting for ${count} room(s); have ${server.core.stats().rooms}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async pair(opts = {}) {
      const purpose = opts.purpose ?? "screen";
      const identity = opts.identity ?? (await createMacIdentity());
      const room = opts.room ?? roomFor(identity);

      const roomsBefore = server.core.stats().rooms;
      const host = await fixture.connect();
      host.send(await hostJoin(identity, room, await host.nonce(), purpose));
      // The host must be registered before the controller joins, or the controller is told
      // `offline` — which is the contract's correct answer, not a server defect.
      await fixture.waitForRooms(roomsBefore + 1);

      const controller = await fixture.connect();
      await controller.nonce();
      controller.send(controllerJoin(room, purpose));

      // Both sides must see `paired` before any binary is legal (contract §12).
      await host.waitForFrames(2);
      await controller.waitForFrames(2);
      return { host, controller, room, identity };
    },
    async stop(): Promise<void> {
      for (const client of clients) client.close();
      // Let the close handlers run so room cleanup is observable before the server stops.
      await new Promise((resolve) => setTimeout(resolve, 60));
      server.stop();
    },
  };
  return fixture;
}

export function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

/** A deterministic pattern, so a byte-for-byte comparison is meaningful. */
export function pattern(length: number, seed = 7): Uint8Array {
  const out = new Uint8Array(length);
  let value = seed;
  for (let i = 0; i < length; i += 1) {
    value = (value * 1103515245 + 12345) & 0x7fffffff;
    out[i] = value & 0xff;
  }
  return out;
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
