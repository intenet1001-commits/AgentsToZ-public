import {normalizeRemoteTerminalRequest,type RemoteTerminalGateway} from './remoteControlTerminalProtocol';
import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import type { Server, ServerWebSocket } from 'bun';
import {
  REMOTE_CONTROL_ABSOLUTE_TTL_MS,
  REMOTE_CONTROL_PROTOCOL_VERSION,
  RemoteControlCore,
  RemoteControlError,
  parseRemoteControlClientJson,
  remoteControlPublicError,
  type RemoteControlActionRequest,
  type RemoteControlGateway,
  type RemoteControlPairingDescriptor,
} from './remoteControlCore';
import {
  remoteControlMobileAsset,
  remoteControlSecurityHeaders,
} from './remoteControlMobilePage';

export function remoteTerminalLanControllerId(token:string):string {return createHash('sha256').update('agentstoz-lan-pairing-v1:'+token).digest('hex');}

const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_WIRE_MESSAGES_PER_SECOND = 10;
const MAX_OPEN_SOCKETS = 8;
export const REMOTE_CONTROL_LAN_MAX_QUEUED_MESSAGES = 20;
export const REMOTE_CONTROL_LAN_MAX_QUEUED_BYTES = 256 * 1024;
const UNPAIRED_SOCKET_TTL_MS = 30_000;
const SESSION_SWEEP_INTERVAL_MS = 2_000;

type RandomBytes = (length: number) => Uint8Array;

type SocketData = {
  connectedAt: number;
  wireWindowStartedAt: number;
  wireMessagesInWindow: number;
  sessionToken: string | null;
  managementSessionId: string | null;
  messageQueue: Promise<void>;
  pendingMessages: (string | Buffer)[];
  pendingBytes: number;
  processingMessages: boolean;
};

type LanSocket = ServerWebSocket<SocketData>;

export interface RemoteControlLanServerOptions {
  bindAddress: string;
  hostName: string;
  gateway: RemoteControlGateway;
  terminalGateway?: RemoteTerminalGateway;
  workspaceSupported?: boolean;
  port?: number;
  now?: () => number;
  randomBytes?: RandomBytes;
  pairingTtlMs?: number;
  idleTtlMs?: number;
  absoluteTtlMs?: number;
  rateWindowMs?: number;
  maxActionsPerRateWindow?: number;
  maxActionIdsPerSession?: number;
  /** Phones this Mac had before the restart. Their own tokens; a resume, not a grant. */
  restore?: RemoteControlLanRestore;
  /** Called on every change to the persisted set, and with null when the listener stops. */
  onRecordChanged?: (record: { bindAddress: string; port: number; sessions: RemoteControlLanRestore['sessions'] } | null) => void;
}

export type RemoteControlLanSessionStatus = {
  id: string;
  controllerId: string;
  label: string;
  /** A socket is attached right now. Listed-but-away sessions report false. */
  connected: boolean;
  pairedAt: string;
  lastSeenAt: string | null;
  expiresAt: string | null;
};

export type RemoteControlLanStatus = {
  enabled: boolean;
  listener: { host: string; port: number } | null;
  pairing: { expiresAt: string } | null;
  sessions: RemoteControlLanSessionStatus[];
};

/** What a resumed listener needs to bring its phones back. */
export type RemoteControlLanRestore = {
  sessions: readonly { sessionToken: string; createdAt: number; lastActiveAt: number; pairedAt: string }[];
};

export type RemoteControlLanStartResult = {
  status: RemoteControlLanStatus;
  pairing: RemoteControlPairingDescriptor;
};

type ActiveSession = {
  id: string;
  /** null while the phone is away. An iPhone drops this socket every time the screen locks,
   * which must not be the same event as the operator revoking the connection. */
  socket: LanSocket | null;
  sessionToken: string;
  pairedAt: string;
  lastSeenAt: string;
  expiresAt: string;
};

function parseIpv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => /^(?:0|[1-9][0-9]{0,2})$/.test(part) ? Number(part) : NaN);
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : null;
}

/** V1 deliberately excludes loopback, link-local, public, wildcard, and IPv6 binds. */
export function isPrivateRemoteControlIpv4(value: unknown): value is string {
  if (typeof value !== 'string' || value !== value.trim()) return false;
  const octets = parseIpv4(value);
  if (!octets) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

export function isAllowedRemoteControlLanRoute(pathname: string): boolean {
  return pathname === '/remote/'
    || pathname === '/remote/index.html'
    || pathname === '/remote/xterm.js'
    || pathname === '/remote/xterm.css'
    || pathname === '/remote/app.js'
    || pathname === '/remote/styles.css'
    || pathname === '/remote/manifest.webmanifest'
    || pathname === '/remote/icon.svg'
    || pathname === '/remote/health'
    || pathname === '/remote/ws';
}

export function remoteControlLanRequestAllowed(input: {
  method: string;
  pathname: string;
  search: string;
  host: string | null;
  origin: string | null;
  expectedHost: string;
  expectedOrigin: string;
  websocket: boolean;
}): boolean {
  if (input.method !== 'GET' || input.search || input.host !== input.expectedHost) return false;
  if (!isAllowedRemoteControlLanRoute(input.pathname)) return false;
  if (input.websocket) {
    return input.pathname === '/remote/ws' && input.origin === input.expectedOrigin;
  }
  if (input.pathname === '/remote/ws') return false;
  return input.origin === null || input.origin === input.expectedOrigin;
}

function validPort(value: number): boolean {
  return Number.isInteger(value) && (value === 0 || (value >= 1_024 && value <= 65_535));
}

function randomIdentifier(randomBytes: RandomBytes): string {
  const bytes = Buffer.from(randomBytes(16));
  if (bytes.byteLength !== 16) throw new Error('randomBytes must return exactly 16 bytes for a session id');
  return bytes.toString('base64url');
}

function opaqueTokensEqual(actual: string, expected: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(actual) || !/^[A-Za-z0-9_-]{43}$/.test(expected)) return false;
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.byteLength === expectedBytes.byteLength
    && timingSafeEqual(actualBytes, expectedBytes);
}

function rawMessageText(raw: string | Buffer | ArrayBuffer | Uint8Array): string {
  if (typeof raw === 'string') return raw;
  if (raw instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(raw));
  return new TextDecoder().decode(raw);
}

function rawMessageBytes(raw: string | Buffer | ArrayBuffer | Uint8Array): number {
  return typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.byteLength;
}

function responseWithSecurity(origin: string, body: BodyInit | null, init: ResponseInit & { contentType?: string } = {}): Response {
  const headers = remoteControlSecurityHeaders(origin, init.contentType);
  return new Response(body, { ...init, headers });
}

function errorResponse(origin: string, status: number, code: string, message: string): Response {
  return responseWithSecurity(origin, JSON.stringify({ error: message, code }), { status });
}

export class RemoteControlLanServer {
  readonly terminalGateway: RemoteTerminalGateway | undefined;
  readonly #options: RemoteControlLanServerOptions;
  readonly #now: () => number;
  readonly #randomBytes: RandomBytes;
  readonly #core: RemoteControlCore;
  readonly #sockets = new Set<LanSocket>();
  #server: Server<SocketData> | null = null;
  #origin: string | null = null;
  #expectedHost: string | null = null;
  /**
   * Every paired phone, keyed by its session id. A Mac used to hold exactly one
   * (`#activeSession`), which is why a second device could never connect.
   */
  readonly #activeSessions = new Map<string, ActiveSession>();
  #sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Teardown closes every session on its way out; that is not the operator revoking them. */
  #suppressPersist = false;
  /** Set by a policy close so the record is rewritten once the entry is actually gone. */
  #persistAfterClose = false;

  constructor(options: RemoteControlLanServerOptions) {
    this.terminalGateway=options.terminalGateway;
    if (!isPrivateRemoteControlIpv4(options.bindAddress)) {
      throw new Error('bindAddress must be one selected RFC1918 IPv4 address');
    }
    if (!validPort(options.port ?? 0)) throw new Error('port must be 0 or an integer between 1024 and 65535');
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? ((length) => nodeRandomBytes(length));
    this.#core = new RemoteControlCore(options.gateway, {
      hostName: options.hostName,
      supportedFeatures: options.terminalGateway && options.workspaceSupported ? ['workspace-v1'] : [],
      now: this.#now,
      randomBytes: this.#randomBytes,
      pairingTtlMs: options.pairingTtlMs,
      idleTtlMs: options.idleTtlMs,
      absoluteTtlMs: options.absoluteTtlMs,
      rateWindowMs: options.rateWindowMs,
      maxActionsPerRateWindow: options.maxActionsPerRateWindow,
      maxActionIdsPerSession: options.maxActionIdsPerSession,
    });
  }

  status(): RemoteControlLanStatus {
    this.#reconcileSessions();
    this.#expireSessions();
    const coreStatus = this.#core.status();
    const listenerPort = this.#server?.port;
    return {
      enabled: this.#server !== null && coreStatus.enabled,
      listener: this.#server && typeof listenerPort === 'number'
        ? { host: this.#options.bindAddress, port: listenerPort }
        : null,
      pairing: coreStatus.pairingPending && coreStatus.pairingExpiresAt
        ? { expiresAt: coreStatus.pairingExpiresAt }
        : null,
      sessions: [...this.#activeSessions.values()].map(session => ({
        id: session.id,
        controllerId: remoteTerminalLanControllerId(session.sessionToken),
        label: session.socket ? '모바일 브라우저' : '모바일 브라우저 · 연결 대기',
        connected: session.socket !== null,
        pairedAt: session.pairedAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
      })),
    };
  }

  start(): RemoteControlLanStartResult {
    if (this.#server) throw new RemoteControlError('REMOTE_CONTROL_ALREADY_ENABLED', '원격 제어가 이미 켜져 있습니다.', 409);
    try {
      this.#server = Bun.serve<SocketData>({
        hostname: this.#options.bindAddress,
        port: this.#options.port ?? 0,
        fetch: (request, server) => this.#handleHttp(request, server),
        websocket: {
          // Preserve the public 16 KiB error at ingress; much larger frames
          // are rejected by Bun before application allocation/dispatch.
          maxPayloadLength: MAX_MESSAGE_BYTES * 2,
          open: (socket) => this.#handleOpen(socket),
          message: (socket, raw) => this.#enqueueMessage(socket, raw),
          close: (socket) => this.#handleClose(socket),
        },
      });
      const actualPort = this.#server.port;
      if (typeof actualPort !== 'number' || !Number.isInteger(actualPort) || actualPort < 1 || actualPort > 65_535) {
        throw new Error('LAN listener did not provide a valid bound port');
      }
      this.#expectedHost = `${this.#options.bindAddress}:${actualPort}`;
      this.#origin = `http://${this.#expectedHost}`;
      const pairing = this.#core.enable(this.#origin);
      // Bring back the phones this Mac had before the restart. They keep their own tokens, so
      // this is a resume, not a grant; each comes back detached (no socket) and revocable, and
      // reconnects on its own when the phone next opens the page.
      for (const session of this.#options.restore?.sessions ?? []) {
        if (this.#core.restoreSessions([session]) !== 1) continue;
        const managementSessionId = randomIdentifier(this.#randomBytes);
        this.#activeSessions.set(managementSessionId, {
          id: managementSessionId,
          socket: null,
          sessionToken: session.sessionToken,
          pairedAt: session.pairedAt,
          lastSeenAt: new Date(session.lastActiveAt).toISOString(),
          expiresAt: new Date(session.createdAt + REMOTE_CONTROL_ABSOLUTE_TTL_MS).toISOString(),
        });
      }
      this.#sweepTimer = setInterval(() => this.#expireSessions(), SESSION_SWEEP_INTERVAL_MS);
      (this.#sweepTimer as { unref?: () => void }).unref?.();
      // Not fatal: the listener works either way, and the broken promise is only "it comes back
      // after a restart" — the operator finds out then and re-scans. Revocation is the write that
      // must never fail quietly, and that one propagates.
      try { this.#persist(); } catch (error) {
        console.error('[RemoteControl] LAN 상태를 기록하지 못해 재시작 후에는 복구되지 않습니다:', error);
      }
      return { status: this.status(), pairing };
    } catch (error) {
      this.#core.disable();
      this.#server?.stop(true);
      this.#server = null;
      this.#origin = null;
      this.#expectedHost = null;
      throw error;
    }
  }

  rotatePairing(): RemoteControlPairingDescriptor {
    if (!this.#server || !this.#origin) throw new RemoteControlError('REMOTE_CONTROL_DISABLED', '원격 제어가 꺼져 있습니다.', 409);
    // A new QR no longer evicts the phones already connected — rotating and
    // scanning from a second device is how you add one.
    return this.#core.rotatePairing(this.#origin);
  }

  revokeSession(sessionId: string): RemoteControlLanStatus {
    const session = this.#activeSessions.get(sessionId);
    if (!session) {
      throw new RemoteControlError('SESSION_NOT_FOUND', '연결된 원격 제어 세션을 찾지 못했습니다.', 404);
    }
    this.#closeSession(session, 'Mac에서 이 원격 제어 연결을 해제했습니다.');
    return this.status();
  }

  revokeAllSessions(): RemoteControlLanStatus {
    this.#closeAllSessions('Mac에서 모든 원격 제어 연결을 해제했습니다.');
    return this.status();
  }

  /**
   * `keepRecord` separates two things that both stop the listener but mean opposite things.
   * The operator turning it off should forget the phones. A Mac that merely moved networks should
   * not: it will hold that address again, and erasing the record would turn a Wi-Fi change into a
   * permanent re-pair.
   */
  stop(options: { keepRecord?: boolean } = {}): RemoteControlLanStatus {
    // Closing each session on the way down would otherwise rewrite the record empty, so a crash
    // or an update would erase exactly the phones this is meant to bring back.
    this.#suppressPersist = options.keepRecord === true;
    try {
      if (options.keepRecord) {
        // 1012 Service Restart, and no session.closed: the phone treats an explicit end by clearing
        // its stored token, which would throw away exactly the credential this teardown is keeping.
        for (const socket of this.#sockets) this.#closeSocket(socket, 1012, 'remote control restarting');
      } else {
        this.#closeAllSessions('Mac에서 원격 제어를 껐습니다.');
        for (const socket of this.#sockets) this.#closeSocket(socket, 1001, 'remote control stopped');
      }
      this.#sockets.clear();
      if (this.#sweepTimer) clearInterval(this.#sweepTimer);
      this.#sweepTimer = null;
      this.#core.disable();
      this.#server?.stop(true);
      this.#server = null;
    } finally {
      // A throw mid-teardown must not leave persistence muted for the rest of the process.
      this.#suppressPersist = false;
    }
    // After the listener is gone, so this records "off" rather than an empty listener the next
    // startup would try to resume.
    if (!options.keepRecord) this.#persist();
    this.#origin = null;
    this.#expectedHost = null;
    return this.status();
  }

  #handleHttp(request: Request, server: Server<SocketData>): Response | undefined {
    const origin = this.#origin;
    const expectedHost = this.#expectedHost;
    if (!origin || !expectedHost) return new Response('Unavailable', { status: 503 });
    const url = new URL(request.url);
    const websocket = url.pathname === '/remote/ws';
    const allowed = remoteControlLanRequestAllowed({
      method: request.method,
      pathname: url.pathname,
      search: url.search,
      host: request.headers.get('host'),
      origin: request.headers.get('origin'),
      expectedHost,
      expectedOrigin: origin,
      websocket,
    });
    if (!allowed) {
      if (!isAllowedRemoteControlLanRoute(url.pathname)) {
        return errorResponse(origin, 404, 'ROUTE_NOT_FOUND', '허용되지 않은 원격 제어 경로입니다.');
      }
      return errorResponse(origin, 403, 'LAN_REQUEST_DENIED', '허용되지 않은 원격 제어 요청입니다.');
    }
    if (websocket) {
      const upgraded = server.upgrade(request, {
        data: {
          connectedAt: this.#now(),
          wireWindowStartedAt: this.#now(),
          wireMessagesInWindow: 0,
          sessionToken: null,
          managementSessionId: null,
          messageQueue: Promise.resolve(),
          pendingMessages: [],
          pendingBytes: 0,
          processingMessages: false,
        },
      });
      return upgraded ? undefined : errorResponse(origin, 400, 'WEBSOCKET_UPGRADE_FAILED', '원격 제어 연결을 열지 못했습니다.');
    }
    if (url.pathname === '/remote/health') {
      return responseWithSecurity(origin, JSON.stringify({ ok: true, protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION }));
    }
    const asset = remoteControlMobileAsset(url.pathname);
    if (!asset) return errorResponse(origin, 404, 'ROUTE_NOT_FOUND', '허용되지 않은 원격 제어 경로입니다.');
    return responseWithSecurity(origin, asset.body, { contentType: asset.contentType });
  }

  #handleOpen(socket: LanSocket): void {
    this.#sockets.add(socket);
    if (this.#sockets.size > MAX_OPEN_SOCKETS) {
      this.#closeSocket(socket, 1008, 'too many connections');
    }
  }

  #enqueueMessage(socket: LanSocket, raw: string | Buffer): void {
    if (!this.#sockets.has(socket)) return;
    const bytes = rawMessageBytes(raw);
    if (bytes > MAX_MESSAGE_BYTES) {
      this.#sendError(socket, new RemoteControlError('MESSAGE_TOO_LARGE', '원격 제어 메시지가 너무 큽니다.', 413), true);
      return;
    }
    // Count at ingress, before an async pairing/action can hold later frames.
    const now = this.#now();
    if (now - socket.data.wireWindowStartedAt >= 1_000) {
      socket.data.wireWindowStartedAt = now;
      socket.data.wireMessagesInWindow = 0;
    }
    socket.data.wireMessagesInWindow += 1;
    if (socket.data.wireMessagesInWindow > MAX_WIRE_MESSAGES_PER_SECOND) {
      this.#sendError(socket, new RemoteControlError('RATE_LIMITED', '원격 제어 요청이 너무 빠릅니다.', 429), true);
      return;
    }
    if (socket.data.pendingMessages.length >= REMOTE_CONTROL_LAN_MAX_QUEUED_MESSAGES
      || socket.data.pendingBytes + bytes > REMOTE_CONTROL_LAN_MAX_QUEUED_BYTES) {
      this.#sendError(socket, new RemoteControlError('REQUEST_QUEUE_FULL', '대기 중인 원격 제어 요청이 너무 많습니다.', 429), true);
      return;
    }
    socket.data.pendingMessages.push(raw);
    socket.data.pendingBytes += bytes;
    if (socket.data.processingMessages) return;
    socket.data.processingMessages = true;
    socket.data.messageQueue = (async () => {
      try {
        while (this.#sockets.has(socket) && socket.data.pendingMessages.length) {
          const next = socket.data.pendingMessages.shift()!;
          socket.data.pendingBytes -= rawMessageBytes(next);
          try {await this.#handleMessage(socket, next);} catch { /* A closed socket cannot receive an error. */ }
        }
      } finally {
        socket.data.processingMessages = false;
      }
    })();
  }

  async #handleMessage(socket: LanSocket, raw: string | Buffer): Promise<void> {
    if (!this.#sockets.has(socket)) return;
    const now = this.#now();
    let actionRequest: RemoteControlActionRequest | null = null;
    try {
      const decoded=JSON.parse(rawMessageText(raw));
      if(decoded?.type==='terminal.request') {
        const terminal=normalizeRemoteTerminalRequest(decoded);
        try {
          if(!socket.data.sessionToken || !opaqueTokensEqual(socket.data.sessionToken,terminal.sessionToken)) throw new Error('이 연결의 터미널 요청이 아닙니다.');
          if(!this.terminalGateway)throw new Error('AI 터미널을 지원하지 않는 Mac입니다.');
          const bindings=await this.#core.taskTargetBindings(terminal.sessionToken);
          const body=await this.terminalGateway(terminal.request,bindings,'lan:'+socket.data.managementSessionId,()=>this.#sockets.has(socket)&&socket.data.sessionToken===terminal.sessionToken);
          if(this.#sockets.has(socket))socket.send(JSON.stringify({type:'terminal.result',requestId:terminal.request.requestId,ok:true,body}));
        } catch(error) {if(this.#sockets.has(socket))socket.send(JSON.stringify({type:'terminal.result',requestId:terminal.request.requestId,ok:false,error:error instanceof Error?error.message.slice(0,500):'터미널 요청 실패'}));}
        return;
      }
      const message = parseRemoteControlClientJson(rawMessageText(raw));
      if (message.type === 'controller.pair') {
        if (socket.data.sessionToken) throw new RemoteControlError('ALREADY_PAIRED', '이미 연결된 원격 제어 화면입니다.', 409);
        const ready = await this.#core.pair(message.token);
        if (!this.#sockets.has(socket)) {
          this.#core.closeSession(ready.sessionToken);
          return;
        }
        const managementSessionId = randomIdentifier(this.#randomBytes);
        socket.data.sessionToken = ready.sessionToken;
        socket.data.managementSessionId = managementSessionId;
        this.#activeSessions.set(managementSessionId, {
          id: managementSessionId,
          socket,
          sessionToken: ready.sessionToken,
          pairedAt: new Date(now).toISOString(),
          lastSeenAt: new Date(now).toISOString(),
          expiresAt: ready.expiresAt,
        });
        this.#core.bindSessionDelivery(ready.sessionToken, () => this.#sockets.has(socket));
        this.#persist();
        socket.send(JSON.stringify(ready));
        return;
      }
      if (message.type === 'session.restore') {
        if (socket.data.sessionToken) throw new RemoteControlError('ALREADY_PAIRED', '이미 연결된 원격 제어 화면입니다.', 409);
        const restored = await this.#core.restore(message.sessionToken);
        if (!this.#sockets.has(socket)) {
          return;
        }
        // Restoring moves the session to this socket. Any socket still holding the same token
        // would otherwise keep passing the token check below and stay able to run actions while
        // management lists only the new one — two authorized connections, one of them invisible.
        for (const other of [...this.#sockets]) {
          if (other === socket || !other.data.sessionToken) continue;
          if (!opaqueTokensEqual(other.data.sessionToken, restored.sessionToken)) continue;
          other.data.sessionToken = '';
          this.#closeSocket(other, 1000, 'session moved');
        }
        const existing = [...this.#activeSessions.values()]
          .find(session => opaqueTokensEqual(session.sessionToken, restored.sessionToken));
        // A fresh management id on every reconnect. The AI terminal grant is keyed by
        // 'lan:<id>', so reusing the id would resurrect a grant the operator gave to a
        // connection that has since ended. Reconnecting restores the phone's project
        // buttons; terminal access has to be granted again.
        if (existing) this.#activeSessions.delete(existing.id);
        const managementSessionId = randomIdentifier(this.#randomBytes);
        socket.data.sessionToken = restored.sessionToken;
        socket.data.managementSessionId = managementSessionId;
        this.#activeSessions.set(managementSessionId, {
          id: managementSessionId,
          socket,
          sessionToken: restored.sessionToken,
          // Reconnecting is not a new pairing; keeping the original time is what lets the
          // operator recognise the phone they approved instead of an apparently new device.
          pairedAt: existing?.pairedAt ?? new Date(now).toISOString(),
          lastSeenAt: new Date(now).toISOString(),
          expiresAt: restored.expiresAt,
        });
        this.#core.bindSessionDelivery(restored.sessionToken, () => this.#sockets.has(socket));
        this.#persist();
        socket.send(JSON.stringify(restored));
        return;
      }
      if (message.type === 'session.end') {
        // The controller is leaving for good, which a socket close can no longer express: a plain
        // close means "away". Without this the operator kept seeing a phone that had already gone.
        if (!socket.data.sessionToken || !opaqueTokensEqual(socket.data.sessionToken, message.sessionToken)) {
          throw new RemoteControlError('INVALID_SESSION_TOKEN', '이 WebSocket의 원격 제어 세션이 아닙니다.', 401);
        }
        const owner = [...this.#activeSessions.values()]
          .find(session => opaqueTokensEqual(session.sessionToken, message.sessionToken));
        socket.data.sessionToken = '';
        if (owner) this.#closeSession(owner, '휴대폰에서 연결을 종료했습니다.');
        else this.#core.closeSession(message.sessionToken);
        return;
      }
      actionRequest = message;
      if (!socket.data.sessionToken || !opaqueTokensEqual(socket.data.sessionToken, message.sessionToken)) {
        throw new RemoteControlError('INVALID_SESSION_TOKEN', '이 WebSocket의 원격 제어 세션이 아닙니다.', 401);
      }
      const result = await this.#core.perform(message);
      for (const session of this.#activeSessions.values()) {
        if (session.socket === socket) session.lastSeenAt = new Date(this.#now()).toISOString();
      }
      socket.send(JSON.stringify(result));
    } catch (error) {
      if (!this.#sockets.has(socket)) return;
      if (actionRequest) {
        socket.send(JSON.stringify({
          type: 'action.result',
          actionId: actionRequest.actionId,
          ok: false,
          error: remoteControlPublicError(error),
        }));
        if (error instanceof RemoteControlError
          && (error.code === 'INVALID_SESSION_TOKEN' || error.code === 'SESSION_EXPIRED')) {
          this.#closeSocket(socket, 1008, error.code);
        }
      } else {
        this.#sendError(socket, error, true);
      }
    }
  }

  #handleClose(socket: LanSocket): void {
    this.#sockets.delete(socket);
    socket.data.pendingMessages.length = 0;
    socket.data.pendingBytes = 0;
    // Destroying the core session here made `session.restore` pointless and turned every screen
    // lock into "go back to the Mac and scan a new QR", because the pairing token is single use.
    // The session is kept, still listed and still revocable; only the socket is detached.
    // Deliberate ends (#closeSession, #expireSessions, disable) drop the entry before arriving here.
    for (const session of [...this.#activeSessions.values()]) {
      if (session.socket !== socket) continue;
      // Listed while away, but only while the core still holds the session. A policy close
      // has already dropped it, and leaving a dead row on screen would offer the operator a
      // revoke button for a connection that no longer exists.
      if (this.#core.sessionExists(session.sessionToken)) session.socket = null;
      else this.#activeSessions.delete(session.id);
    }
    if (this.#persistAfterClose) {
      this.#persistAfterClose = false;
      // A socket close callback is not a place to throw: an unhandled rejection here takes the
      // whole API process with it. Operator-facing paths (revoke, disable) still propagate.
      try { this.#persist(); } catch (error) {
        console.error('[RemoteControl] 정책 종료 후 LAN 상태를 기록하지 못했습니다:', error);
      }
    }
  }

  /**
   * 1008 is this server's policy-violation code: an unparseable message, a rate or queue
   * overflow, too many connections. Those end the session outright — an abusing client does
   * not get to resume. An ordinary drop (1000/1001, or the phone simply going away) leaves
   * the session restorable, which is what lets a locked iPhone come back.
   */
  #closeSocket(socket: LanSocket, code: number, reason: string): void {
    if (code === 1008 && socket.data.sessionToken) {
      this.#core.closeSession(socket.data.sessionToken);
      // #handleClose drops the management entry below, but neither of them wrote the record, so a
      // client that got itself policy-closed kept a token the next startup would happily restore.
      this.#persistAfterClose = true;
    }
    // Bun's close callback may follow later. Drop queued input immediately.
    this.#handleClose(socket);
    socket.close(code, reason);
  }

  #sendError(socket: LanSocket, error: unknown, close: boolean): void {
    const publicError = remoteControlPublicError(error);
    try {socket.send(JSON.stringify({ type: 'error', ...publicError }));}
    finally {if (close) this.#closeSocket(socket, 1008, publicError.code);}
  }

  #expireSessions(): void {
    // A sweep can retire several phones at once; handling only the first would
    // leave the others believing they are still connected.
    for (const closed of this.#core.sweep().closed) {
      for (const session of [...this.#activeSessions.values()]) {
        if (session.sessionToken !== closed.sessionToken) continue;
        const reason = closed.reason === 'absolute'
          ? '원격 제어의 최대 연결 시간이 끝났습니다.'
          : '활동이 없어 원격 제어 연결이 만료되었습니다.';
        this.#activeSessions.delete(session.id);
        // Sweep runs on a timer; log and keep sweeping rather than killing the interval.
        try { this.#persist(); } catch (error) {
          console.error('[RemoteControl] 만료된 LAN 세션을 기록하지 못했습니다:', error);
        }
        if (!session.socket) continue;
        session.socket.send(JSON.stringify({ type: 'session.closed', reason }));
        this.#closeSocket(session.socket, 1000, 'session expired');
      }
    }
    const now = this.#now();
    for (const socket of this.#sockets) {
      if (!socket.data.sessionToken && now - socket.data.connectedAt >= UNPAIRED_SOCKET_TTL_MS) {
        this.#closeSocket(socket, 1008, 'pairing timeout');
      }
    }
  }

  /**
   * Write down what a restart needs, or say it is off. Called on every change to the session set
   * and on stop, because a record that lags reality either resurrects a revoked phone or loses a
   * live one.
   */
  /**
   * Drop management rows whose core session is gone. The core can retire a session on its own —
   * a TTL sweep, or making room for a freshly scanned QR — and a row left behind would offer the
   * operator a revoke button for nothing and be written into the record as a restorable phone.
   */
  #reconcileSessions(): void {
    for (const session of [...this.#activeSessions.values()]) {
      if (!this.#core.sessionExists(session.sessionToken)) this.#activeSessions.delete(session.id);
    }
  }

  #persist(): void {
    const record = this.#options.onRecordChanged;
    if (!record || this.#suppressPersist) return;
    this.#reconcileSessions();
    const listenerPort = this.#server?.port;
    if (!this.#server || typeof listenerPort !== 'number') { record(null); return; }
    record({
      bindAddress: this.#options.bindAddress,
      port: listenerPort,
      // Timestamps come from the core, which owns the deadlines a restore is judged against.
      // Reconstructing them from the management row's display strings let an edited record shorten
      // or extend a session's life, and drifted from the activity the core actually tracks.
      sessions: this.#core.exportSessions().flatMap(session => {
        const entry = [...this.#activeSessions.values()]
          .find(candidate => candidate.sessionToken === session.sessionToken);
        if (!entry) return [];
        return [{ ...session, pairedAt: entry.pairedAt }];
      }),
    });
  }

  #closeSession(session: ActiveSession, reason: string): void {
    this.#activeSessions.delete(session.id);
    this.#core.closeSession(session.sessionToken);
    // Deliberately allowed to throw. A revoked phone that survives the next restart is the one
    // outcome the operator must never be told did not happen.
    this.#persist();
    if (!session.socket) return;
    session.socket.send(JSON.stringify({ type: 'session.closed', reason }));
    this.#closeSocket(session.socket, 1000, 'session revoked');
  }

  #closeAllSessions(reason: string): void {
    for (const session of [...this.#activeSessions.values()]) this.#closeSession(session, reason);
  }
}
