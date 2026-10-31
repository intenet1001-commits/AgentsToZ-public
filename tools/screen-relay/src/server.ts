/**
 * AgentsToZ screen relay v1 — an untrusted byte mover.
 *
 * What this server does: admit one host and one controller to a room, then copy opaque binary
 * frames between them, exactly and in order, under hard budgets.
 *
 * What it deliberately cannot do:
 *  - decrypt QR-v2 registration or authenticated screen/input records (keys never come here);
 *  - authorize a viewer (room admission is transport only — the native SIGMA/Face ID/App Attest
 *    checks run end to end and are what actually grant screen or input authority);
 *  - resume a session (peer loss closes both sockets, so an established native session is never
 *    silently replayed).
 *
 * It can deny service. That is the whole of its power (contract §16).
 *
 * Contract: /tmp/agentstoz-screen-relay-contract-20261026.md
 */

import {
  challengeFrame,
  errorFrame,
  isAuthenticatedFrame,
  NONCE_BYTES,
  PEER_ID_BYTES,
  pairedFrame,
  parseJoin,
  randomToken,
  RELAY_PATH,
  roomLabel,
  type ErrorCode,
  type Join,
  type ParsedRoom,
  type Purpose,
  type Role,
} from "./protocol.ts";
import { pairKey, verifyHostJoin } from "./hostChallenge.ts";
import { DEFAULT_LIMITS, resolveLimits, WindowCounter, type RelayLimits } from "./limits.ts";

/**
 * `verifying` exists because host admission is asynchronous. It is entered synchronously, before
 * the first `await`, so one socket's single challenge can start exactly one signature check: a
 * flood of duplicate joins finds the socket already past `challenged` and is refused without
 * spawning more verification work.
 */
type Phase = "challenged" | "verifying" | "waiting" | "paired" | "closing";

interface SocketState {
  readonly id: number;
  readonly ip: string;
  readonly nonce: string;
  readonly openedAt: number;
  phase: Phase;
  role?: Role;
  purpose?: Purpose;
  room?: ParsedRoom;
  pair?: Pair;
  /** Host-only: the budget signal has been given for this screen room (contract §13). */
  authenticated: boolean;
  /** Timer for the challenge window, then for the idle wait. */
  timer?: ReturnType<typeof setTimeout>;
  /** Absolute lifetime timer, armed when the pair forms. */
  lifetime?: ReturnType<typeof setTimeout>;
}

interface Pair {
  readonly key: string;
  readonly room: ParsedRoom;
  readonly purpose: Purpose;
  host?: Peer;
  controller?: Peer;
  pairedAt?: number;
}

type Peer = { socket: RelaySocket; state: SocketState };

/** The subset of Bun's ServerWebSocket this server uses, so tests can reason about it. */
export interface RelaySocket {
  send(data: string | Uint8Array): number;
  close(code?: number, reason?: string): void;
  readonly remoteAddress?: string;
  getBufferedAmount?(): number;
  data: SocketState;
}

export interface RelayStats {
  readonly sockets: number;
  readonly rooms: number;
  readonly pairedRooms: number;
  readonly pendingBytes: number;
  /**
   * How many host signature verifications this server has started. One per admitted host socket:
   * the invariant that makes a duplicate-join flood cheap.
   */
  readonly hostVerifications: number;
}

export interface RelayHandlers {
  open(socket: RelaySocket): void;
  message(socket: RelaySocket, message: string | Uint8Array): void;
  close(socket: RelaySocket): void;
}

/**
 * The relay's state and behaviour, independent of any listener. `createRelayServer` wires this to
 * `Bun.serve`; tests drive the same object through real sockets.
 */
export class RelayCore {
  private readonly limits: RelayLimits;
  private readonly pairs = new Map<string, Pair>();
  private readonly sockets = new Set<SocketState>();
  private readonly perIp = new Map<string, number>();
  private readonly admissions: WindowCounter;
  private nextId = 1;
  /** Mirrors the sum of every socket's buffered bytes, so the global budget is one lookup. */
  private pendingBytes = 0;
  /** Counts started host verifications; asserted by the duplicate-join tests. */
  private hostVerifications = 0;

  constructor(limits: Partial<RelayLimits> = {}) {
    this.limits = resolveLimits(limits);
    this.admissions = new WindowCounter(this.limits.maxAdmissionsPerIp, this.limits.admissionWindowMs);
  }

  /** State for a socket that is about to be opened; Bun carries this as `ws.data`. */
  createState(ip: string): SocketState {
    return {
      id: this.nextId++,
      ip,
      nonce: randomToken(NONCE_BYTES),
      openedAt: Date.now(),
      phase: "challenged",
      authenticated: false,
    };
  }

  stats(): RelayStats {
    let pairedRooms = 0;
    for (const pair of this.pairs.values()) if (pair.pairedAt !== undefined) pairedRooms += 1;
    return {
      sockets: this.sockets.size,
      rooms: this.pairs.size,
      pairedRooms,
      pendingBytes: this.pendingBytes,
      hostVerifications: this.hostVerifications,
    };
  }

  // ---------------------------------------------------------------- lifecycle

  open(socket: RelaySocket): void {
    const state = socket.data;
    const ipCount = (this.perIp.get(state.ip) ?? 0) + 1;

    // Counted before the budget check so `close` can decrement unconditionally.
    this.sockets.add(state);
    this.perIp.set(state.ip, ipCount);

    if (this.sockets.size > this.limits.maxSockets || ipCount > this.limits.maxSocketsPerIp) {
      this.refuse(socket, "limited");
      return;
    }

    // The challenge is one-use and this socket's own: a signature for another socket's nonce
    // cannot be replayed here, and the window is short (contract §6).
    socket.send(challengeFrame(state.nonce));
    state.timer = setTimeout(() => this.refuse(socket, "expired"), this.limits.challengeTtlMs);
  }

  close(socket: RelaySocket): void {
    const state = socket.data;
    // Mark the socket finished before anything else. A host verification may still be in flight;
    // without this the state would read `verifying` when it resolves and the attempt would attach
    // a room to a socket that is already gone, leaking the room and its slot.
    state.phase = "closing";
    this.releaseBuffered(state);
    this.clearTimers(state);
    this.sockets.delete(state);

    const ipCount = (this.perIp.get(state.ip) ?? 1) - 1;
    if (ipCount <= 0) this.perIp.delete(state.ip);
    else this.perIp.set(state.ip, ipCount);

    const pair = state.pair;
    state.pair = undefined;
    if (!pair) return;

    // Whichever side this was, drop it from the pair and take the peer down with it. An
    // established native session is never resumed through a new socket (contract §14).
    if (pair.host?.state === state) pair.host = undefined;
    if (pair.controller?.state === state) pair.controller = undefined;

    const peer = pair.host ?? pair.controller;
    if (peer) {
      // The peer loses its partner: close it rather than leave it waiting on a dead room.
      this.detach(peer.state);
      peer.socket.close(1001, "peer-closed");
    }
    // Pair cleanup: no empty room may linger and hold a room slot (contract §15).
    if (!pair.host && !pair.controller) this.pairs.delete(pair.key);
  }

  message(socket: RelaySocket, message: string | Uint8Array): void {
    const state = socket.data;
    if (state.phase === "closing") return;
    if (typeof message === "string") this.onText(socket, state, message);
    else this.onBinary(socket, state, message);
  }

  // ------------------------------------------------------------------- text

  private onText(socket: RelaySocket, state: SocketState, text: string): void {
    if (text.length > this.limits.maxTextFrameBytes) return this.refuse(socket, "malformed");

    if (state.phase === "paired") {
      // After pairing the only legal text is the host's budget signal. Everything else is
      // refused: there is no command, channel or injection surface here (contract §14).
      if (state.role === "host" && state.purpose === "screen" && isAuthenticatedFrame(text)) {
        state.authenticated = true;
        return;
      }
      return this.refuse(socket, "malformed");
    }

    if (state.phase !== "challenged") return this.refuse(socket, "malformed");

    const parsed = parseJoin(text);
    if (!parsed.ok) return this.refuse(socket, parsed.code);

    // Rate is charged per admission attempt, after the schema is known good, so a malformed
    // flood is cheap to reject and a valid flood is what the budget actually bounds.
    if (!this.admissions.admit(state.ip, Date.now())) return this.refuse(socket, "limited");

    if (parsed.join.role === "host") {
      // Consume the challenge here, synchronously, before any await. Without this the socket would
      // still read `challenged` when the next copy of the join arrives, and each copy would start
      // another P-256 verification against the same nonce — unauthenticated CPU amplification from
      // a single socket. One challenge, one verification.
      state.phase = "verifying";
      this.hostVerifications += 1;
      void this.admitHost(socket, state, parsed.join);
      return;
    }
    this.admitController(socket, state, parsed.join);
  }

  private async admitHost(socket: RelaySocket, state: SocketState, join: Join & { role: "host" }): Promise<void> {
    let ok = false;
    try {
      ok = await verifyHostJoin(join, state.nonce);
    } catch {
      // Verification must never throw past this point; a failure is simply not an admission.
      ok = false;
    }
    // While the signature was being checked the socket may have closed, been refused, or had its
    // challenge window expire. Any of those leaves a phase other than `verifying`, and this
    // attempt must then decide nothing: it may not attach, refuse again, or revive the socket.
    if (state.phase !== "verifying") return;
    if (!ok) return this.refuse(socket, "unauthorized");
    this.attach(socket, state, join.room, join.purpose, "host", join.version);
  }

  private admitController(socket: RelaySocket, state: SocketState, join: Join & { role: "controller" }): void {
    const key = pairKey(join.room, join.purpose);
    const existing = this.pairs.get(key);
    // A controller must not create a room: without a live host it is told `offline` and the
    // room is left untouched, so it cannot consume a host that has not arrived (contract §11).
    if (!existing?.host) return this.refuse(socket, "offline");
    if (existing.controller) return this.refuse(socket, "busy");
    this.attach(socket, state, join.room, join.purpose, "controller", join.version);
  }

  private attach(
    socket: RelaySocket,
    state: SocketState,
    room: ParsedRoom,
    purpose: Purpose,
    role: Role,
    version: number,
  ): void {
    const key = pairKey(room, purpose);
    let pair = this.pairs.get(key);

    if (!pair) {
      if (this.pairs.size >= this.limits.maxRooms) return this.refuse(socket, "limited");
      pair = { key, room, purpose };
      this.pairs.set(key, pair);
    }

    if (role === "host") {
      // One host per room/purpose. A second host does not displace the first: the room's
      // live Mac keeps it, and the newcomer is told the room is busy.
      if (pair.host) {
        if (!pair.controller && pair.host.state.phase === "waiting") {
          // fall through to `busy` as well: replacing a waiting host would let anyone holding
          // the key bump the real Mac off its own room.
        }
        return this.refuse(socket, "busy");
      }
      pair.host = { socket, state };
    } else {
      if (pair.controller) return this.refuse(socket, "busy");
      pair.controller = { socket, state };
    }

    state.role = role;
    state.purpose = purpose;
    state.room = room;
    state.pair = pair;
    state.phase = "waiting";

    this.clearTimers(state);
    // A side may wait for its partner, but not forever (contract §15).
    state.timer = setTimeout(() => this.refuse(socket, "expired"), this.limits.idleWaitingMs);

    if (role === "host" && version >= 2) {
      // Only v2 hosts receive this, after signature verification and room admission. It conveys no screen authority.
      if (socket.send('{"type":"waiting","version":2}') === 0) return this.refuse(socket, "offline");
    }

    if (pair.host && pair.controller) this.pairUp(pair);
  }

  private pairUp(pair: Pair): void {
    const host = pair.host;
    const controller = pair.controller;
    if (!host || !controller) return;
    pair.pairedAt = Date.now();

    for (const peer of [host, controller]) {
      peer.state.phase = "paired";
      this.clearTimers(peer.state);
      // Absolute lifetime: a session cannot live past this however busy it is.
      peer.state.lifetime = setTimeout(
        () => this.refuse(peer.socket, "expired"),
        this.limits.activeLifetimeMs,
      );
      // Each side gets its own peerId; no binary may precede this frame (contract §12).
      peer.socket.send(pairedFrame(randomToken(PEER_ID_BYTES)));
    }
  }

  // ----------------------------------------------------------------- binary

  private onBinary(socket: RelaySocket, state: SocketState, frame: Uint8Array): void {
    // No binary before paired: an unpaired socket has nowhere to send and nothing to say.
    if (state.phase !== "paired") return this.refuse(socket, "malformed");

    const pair = state.pair;
    const peer = pair ? (state.role === "host" ? pair.controller : pair.host) : undefined;
    if (!pair || !peer) return this.refuse(socket, "offline");

    if (frame.byteLength > this.frameCap(pair, state)) return this.refuse(socket, "limited");

    // Back-pressure is checked before the copy. Once a frame is handed to the peer it is never
    // dropped, truncated or reordered — an encrypted stream cannot survive a hole, so the only
    // safe response to pressure is to close both sides (contract §15).
    const buffered = peer.socket.getBufferedAmount?.() ?? 0;
    if (
      buffered + frame.byteLength > this.limits.maxPeerBufferedBytes ||
      this.pendingBytes + frame.byteLength > this.limits.maxTotalPendingBytes
    ) {
      this.refuse(socket, "limited");
      this.refuse(peer.socket, "limited");
      return;
    }

    // Bun -1 means already enqueued: retrying would duplicate an authenticated record. Zero means dropped;
    // continuing would leave a permanent hole in the ordered AES-GCM stream, so end both sides immediately.
    try {
      if (peer.socket.send(frame) === 0) {
        this.refuse(socket, "offline");
        this.refuse(peer.socket, "offline");
        return;
      }
    } catch {
      this.refuse(socket, "offline");
      this.refuse(peer.socket, "offline");
      return;
    }
    this.trackBuffered(peer);
  }

  /**
   * The size cap in force for this frame. Registration is always 16 KiB; a screen room is 16 KiB
   * until its host sends `authenticated`, then the native GCM record limit (contract §13).
   */
  private frameCap(pair: Pair, _sender: SocketState): number {
    if (pair.purpose !== "screen") return this.limits.preAuthMaxFrameBytes;
    return pair.host?.state.authenticated
      ? this.limits.screenMaxFrameBytes
      : this.limits.preAuthMaxFrameBytes;
  }

  /** Re-reads a socket's buffered amount into the global total. */
  private trackBuffered(peer: Peer): void {
    const previous = (peer.state as { buffered?: number }).buffered ?? 0;
    const current = peer.socket.getBufferedAmount?.() ?? 0;
    this.pendingBytes += current - previous;
    if (this.pendingBytes < 0) this.pendingBytes = 0;
    (peer.state as { buffered?: number }).buffered = current;
  }

  private releaseBuffered(state: SocketState): void {
    const held = (state as { buffered?: number }).buffered ?? 0;
    this.pendingBytes -= held;
    if (this.pendingBytes < 0) this.pendingBytes = 0;
    (state as { buffered?: number }).buffered = 0;
  }

  /** Called from Bun's `drain`: buffered bytes left the socket. */
  drain(socket: RelaySocket): void {
    const state = socket.data;
    const previous = (state as { buffered?: number }).buffered ?? 0;
    const current = socket.getBufferedAmount?.() ?? 0;
    this.pendingBytes += current - previous;
    if (this.pendingBytes < 0) this.pendingBytes = 0;
    (state as { buffered?: number }).buffered = current;
  }

  // ------------------------------------------------------------------ helpers

  /**
   * Send one error code and close. Nothing about the body, the room capability, keys or frames is
   * logged or echoed — the code is the whole message (contract §14, §15).
   */
  private refuse(socket: RelaySocket, code: ErrorCode): void {
    const state = socket.data;
    if (state.phase === "closing") return;
    this.detach(state);
    try {
      socket.send(errorFrame(code));
    } catch {
      // The socket may already be gone; closing below is what matters.
    }
    socket.close(1008, code);
  }

  /** Marks a socket as finished so no later event acts on it. */
  private detach(state: SocketState): void {
    state.phase = "closing";
    this.clearTimers(state);
  }

  private clearTimers(state: SocketState): void {
    if (state.timer) clearTimeout(state.timer);
    if (state.lifetime) clearTimeout(state.lifetime);
    state.timer = undefined;
    state.lifetime = undefined;
  }

  /** Releases every timer; for fixture teardown so a test process can exit. */
  shutdown(): void {
    for (const state of this.sockets) this.clearTimers(state);
  }
}

export interface RelayServerOptions extends Partial<RelayLimits> {
  /** Defaults to 127.0.0.1: this server is for a reverse proxy, never a public bind. */
  readonly hostname?: string;
  /** 0 asks the OS for an ephemeral port, which fixtures rely on. */
  readonly port?: number;
}

export interface RelayServer {
  readonly port: number;
  readonly hostname: string;
  readonly url: string;
  readonly core: RelayCore;
  stop(): void;
}

/**
 * Starts the relay on `Bun.serve`. Only `/screen-relay` upgrades; every other path is 404 with no
 * body of consequence. TLS is intentionally not terminated here — see README: run this behind a
 * reverse proxy with a normally validated certificate.
 */
export function createRelayServer(options: RelayServerOptions = {}): RelayServer {
  const { hostname = "127.0.0.1", port = 0, ...limits } = options;
  const core = new RelayCore(limits);

  // Only the WebSocket data type is pinned. Bun's second generic is the route-path union
  // (`R extends string = never`, bun-types/serve.d.ts); this server declares no `routes`, so it is
  // left at its default — the single `/screen-relay` upgrade is handled in `fetch`.
  const server = Bun.serve<SocketState>({
    hostname,
    port,
    fetch(request, bun) {
      const url = new URL(request.url);
      if (url.pathname !== RELAY_PATH) return new Response("not found", { status: 404 });
      // The room and its capability travel in the join frame, never in the URL (contract §7).
      if (url.search.length > 0) return new Response("bad request", { status: 400 });
      const ip = bun.requestIP(request)?.address ?? "unknown";
      if (bun.upgrade(request, { data: core.createState(ip) })) return undefined;
      return new Response("expected websocket", { status: 426 });
    },
    websocket: {
      // Bun gives binary frames as Uint8Array with this set; exact bytes are preserved.
      perMessageDeflate: false,
      maxPayloadLength: DEFAULT_LIMITS.screenMaxFrameBytes,
      backpressureLimit: limits.maxPeerBufferedBytes ?? DEFAULT_LIMITS.maxPeerBufferedBytes,
      closeOnBackpressureLimit: true,
      idleTimeout: 120,
      sendPings: true,
      open(ws) {
        core.open(ws as unknown as RelaySocket);
      },
      message(ws, message) {
        core.message(ws as unknown as RelaySocket, message as string | Uint8Array);
      },
      drain(ws) {
        core.drain(ws as unknown as RelaySocket);
      },
      close(ws) {
        core.close(ws as unknown as RelaySocket);
      },
    },
  });

  return {
    // `server.port` is optional in Bun's types (a unix-socket server has none). This server always
    // binds hostname:port, so an absent port means the listener did not come up as required.
    port: requirePort(server.port),
    hostname,
    url: `ws://${hostname}:${requirePort(server.port)}${RELAY_PATH}`,
    core,
    stop() {
      core.shutdown();
      server.stop(true);
    },
  };
}

function requirePort(port: number | undefined): number {
  if (typeof port !== "number") {
    throw new Error("screen-relay: the listener reported no TCP port; a hostname:port bind is required");
  }
  return port;
}
