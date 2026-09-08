import {normalizeRemoteTerminalRequest,type RemoteTerminalGateway} from './remoteControlTerminalProtocol';
import { randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import type { Server, ServerWebSocket } from 'bun';
import {
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
  port?: number;
  now?: () => number;
  randomBytes?: RandomBytes;
  pairingTtlMs?: number;
  idleTtlMs?: number;
  absoluteTtlMs?: number;
  rateWindowMs?: number;
  maxActionsPerRateWindow?: number;
  maxActionIdsPerSession?: number;
}

export type RemoteControlLanSessionStatus = {
  id: string;
  label: string;
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

export type RemoteControlLanStartResult = {
  status: RemoteControlLanStatus;
  pairing: RemoteControlPairingDescriptor;
};

type ActiveSession = {
  id: string;
  socket: LanSocket;
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
        label: '모바일 브라우저',
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
      this.#sweepTimer = setInterval(() => this.#expireSessions(), SESSION_SWEEP_INTERVAL_MS);
      (this.#sweepTimer as { unref?: () => void }).unref?.();
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

  stop(): RemoteControlLanStatus {
    this.#closeAllSessions('Mac에서 원격 제어를 껐습니다.');
    for (const socket of this.#sockets) this.#closeSocket(socket, 1001, 'remote control stopped');
    this.#sockets.clear();
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.#sweepTimer = null;
    this.#core.disable();
    this.#server?.stop(true);
    this.#server = null;
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
          const body=await this.terminalGateway(terminal.request,bindings,'lan:'+socket.data.managementSessionId);
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
        socket.send(JSON.stringify(ready));
        return;
      }
      if (message.type === 'session.restore') {
        if (socket.data.sessionToken) throw new RemoteControlError('ALREADY_PAIRED', '이미 연결된 원격 제어 화면입니다.', 409);
        const restored = await this.#core.restore(message.sessionToken);
        if (!this.#sockets.has(socket)) {
          return;
        }
        const managementSessionId = randomIdentifier(this.#randomBytes);
        socket.data.sessionToken = restored.sessionToken;
        socket.data.managementSessionId = managementSessionId;
        this.#activeSessions.set(managementSessionId, {
          id: managementSessionId,
          socket,
          sessionToken: restored.sessionToken,
          pairedAt: new Date(now).toISOString(),
          lastSeenAt: new Date(now).toISOString(),
          expiresAt: restored.expiresAt,
        });
        socket.send(JSON.stringify(restored));
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
    if (socket.data.sessionToken) this.#core.closeSession(socket.data.sessionToken);
    for (const session of [...this.#activeSessions.values()]) {
      if (session.socket === socket) this.#activeSessions.delete(session.id);
    }
  }

  #closeSocket(socket: LanSocket, code: number, reason: string): void {
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

  #closeSession(session: ActiveSession, reason: string): void {
    this.#activeSessions.delete(session.id);
    this.#core.closeSession(session.sessionToken);
    session.socket.send(JSON.stringify({ type: 'session.closed', reason }));
    this.#closeSocket(session.socket, 1000, 'session revoked');
  }

  #closeAllSessions(reason: string): void {
    for (const session of [...this.#activeSessions.values()]) this.#closeSession(session, reason);
  }
}
