import {normalizeRemoteTerminalRequest,type RemoteTerminalRequest,type RemoteTerminalGateway} from './remoteControlTerminalProtocol';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  REMOTE_CONTROL_MAX_SESSIONS,
  REMOTE_CONTROL_PROTOCOL_VERSION,
  RemoteControlCore,
  RemoteControlError,
  parseRemoteControlClientJson,
  remoteControlPublicError,
  type RemoteControlClientMessage,
  type RemoteControlGateway,
  type RemoteControlSessionReady,
} from './remoteControlCore';
import {
  REMOTE_CONTROL_RELAY_PAIRING_TTL_MS,
  REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
  acceptRemoteControlRelayEnvelope,
  buildRemoteControlRelayPairingUrl,
  createRemoteControlRelayReceiveCursor,
  decodeRemoteControlRelayBase64Url,
  encodeRemoteControlRelayBase64Url,
  parseRemoteControlRelayEnvelope,
  type RemoteControlRelayEnvelope,
  type RemoteControlRelayReceiveCursor,
} from './remoteControlRelayContract';
import {
  decryptRemoteControlRelayEnvelope,
  deriveRemoteControlRelaySessionKey,
  encryptRemoteControlRelayEnvelope,
  exportRemoteControlRelayPublicKey,
  fingerprintRemoteControlRelayPublicKey,
  generateRemoteControlRelayKeyPair,
  importRemoteControlRelayPublicKey,
  generateRemoteControlRelayHostKeyPair,
  importRemoteControlRelayHostKeyPair,
} from './remoteControlRelayCrypto';
import type {
  RemoteControlHostRecord,
  RemoteControlHostSessionRecord,
} from './remoteControlHostVault';
import { remoteControlRelaySasCode } from './remoteControlRelaySas';
import { normalizeHttpsExactOrigin } from './portalDeployUrl';
import type { RemoteControlConversationGateway } from './remoteControlConversationGateway';
import {
  REMOTE_CONTROL_CONVERSATION_SCOPE,
  normalizeRemoteControlConversationRequest,
  normalizeRemoteControlConversationResult,
  type RemoteControlConversationRequest,
  type RemoteControlConversationResult,
} from './remoteControlConversationProtocol';
import type { RemoteControlTaskGateway } from './remoteControlTaskGateway';
import { AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED } from './agentRuntimeProtocol';
import {
  REMOTE_CONTROL_TASK_SCOPE,
  REMOTE_CONTROL_TASK_SEMANTIC_VERSION,
  REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
  normalizeRemoteControlTaskRequest,
  normalizeRemoteControlTaskResult,
  type RemoteControlTaskRequest,
  type RemoteControlTaskResult,
} from './remoteControlTaskProtocol';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });
// The host has to outlive the longest chain it can anchor: a 30-day QR claimed
// on its last day, one day pending approval, then a full 30-day approved
// session. 62 days covers that; anything shorter silently clamps the QR
// (`least(now() + 30 days, host_expires_at)` in create_pairing) and the user
// sees a QR that expires sooner than the dialog says. Single-use is unchanged.
const HOST_TTL_SECONDS = 62 * 24 * 60 * 60;
/**
 * Renew the host once it is inside this window of expiring.
 *
 * `register_host` is a plain insert, so an expired host cannot be re-registered
 * under the same id — the QR, the pinned key and the approved session all die
 * with it and the user is back to scanning. Renewing while still authorized
 * keeps a Mac that is in daily use from ever reaching that cliff. Seven days is
 * far more slack than any laptop needs to be opened once.
 */
const HOST_RENEW_WITHIN_MS = 7 * 24 * 60 * 60_000;
const MESSAGE_TTL_MS = 10 * 60_000;
/**
 * Relay limits are 8 live sessions plus 8 still-unclaimed QRs. Keep both sets,
 * but never let repeated issuance grow secret material without a bound.
 */
const MAX_OUTSTANDING_PAIRING_SECRETS = REMOTE_CONTROL_MAX_SESSIONS;
const MAX_RETAINED_PAIRING_SECRETS = REMOTE_CONTROL_MAX_SESSIONS
  + MAX_OUTSTANDING_PAIRING_SECRETS;
const ACTIVE_POLL_MS = 1_000;
const IDLE_POLL_MS = 5_000;
const MAX_BACKOFF_MS = 30_000;

export type RemoteControlInternetState =
  | 'disabled'
  | 'pairing'
  | 'approval-required'
  | 'online'
  | 'degraded'
  | 'offline';

export type RemoteControlInternetRelayMessageType =
  | 'command' | 'result' | 'state' | 'task' | 'conversation' | 'ack';

export interface RemoteControlInternetHostRegistration {
  hostId: string;
  hostSecret: string;
  hostName: string;
  hostPublicKey: string;
  ttlSeconds: number;
}

export interface RemoteControlInternetPairingRegistration {
  hostId: string;
  hostSecret: string;
  pairingSecretHash: string;
}

export interface RemoteControlInternetPairingRow {
  pairingId: string;
  expiresAt: string;
  hostPublicKey: string;
  hostPublicKeyFingerprint: string;
  /** Unclaimed invitations atomically retired to make room for this one. */
  retiredPairingIds?: string[];
}

export interface RemoteControlInternetSessionRow {
  sessionId: string;
  pairingId: string;
  controllerId: string;
  controllerName: string;
  controllerPublicKey: string;
  controllerKeyFingerprint: string;
  approvalState: 'pending' | 'approved' | 'revoked';
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  revokedAt: string | null;
}

export interface RemoteControlInternetReceivedEnvelope {
  relaySequence: string;
  envelope: RemoteControlRelayEnvelope;
}

export interface RemoteControlInternetHostTransport {
  registerHost(input: RemoteControlInternetHostRegistration): Promise<{ expiresAt: string; hostPublicKeyFingerprint: string }>;
  /**
   * Push the host's expiry out while it is still authorized. Optional so an
   * older transport keeps working — it just cannot renew.
   */
  renewHost?(hostId: string, hostSecret: string, ttlSeconds: number): Promise<string>;
  createPairing(input: RemoteControlInternetPairingRegistration): Promise<RemoteControlInternetPairingRow>;
  listSessions(hostId: string, hostSecret: string): Promise<RemoteControlInternetSessionRow[]>;
  approveSession(hostId: string, hostSecret: string, sessionId: string): Promise<RemoteControlInternetSessionRow>;
  revokeSession(hostId: string, hostSecret: string, sessionId: string): Promise<void>;
  disableHost(hostId: string, hostSecret: string): Promise<void>;
  receiveEnvelopes(hostId: string, hostSecret: string, afterRelaySequence: string): Promise<RemoteControlInternetReceivedEnvelope[]>;
  sendEnvelope(
    hostId: string,
    hostSecret: string,
    sessionId: string,
    messageType: RemoteControlInternetRelayMessageType,
    envelope: RemoteControlRelayEnvelope,
  ): Promise<void>;
  acknowledge(hostId: string, hostSecret: string, sessionId: string, throughRelaySequence: string): Promise<void>;
}

export interface RemoteControlInternetPairingIssue {
  pairingUrl: string;
  expiresAt: string;
}

export interface RemoteControlInternetSessionStatus {
  sessionId: string;
  /** Opaque relay row id; pairing secrets and URLs never cross status. */
  pairingId?: string;
  controllerId: string;
  controllerName: string;
  controllerKeyFingerprint: string;
  approvalState: 'pending' | 'approved' | 'revoked';
  sasCode: string | null;
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  /** Explicit local grant; existing v7 sessions default to false. */
  taskScopeGranted: boolean;
  /** Separate retained conversation/history grant; existing sessions default to false. */
  conversationScopeGranted: boolean;
}

export interface RemoteControlInternetStatus {
  enabled: boolean;
  state: RemoteControlInternetState;
  controllerUrl: string | null;
  hostExpiresAt: string | null;
  pairingExpiresAt: string | null;
  lastRelayContactAt: string | null;
  sessions: RemoteControlInternetSessionStatus[];
  error: string | null;
}

export interface CreateRemoteControlInternetAgentOptions {
  gateway: RemoteControlGateway;
  transport: RemoteControlInternetHostTransport;
  controllerOrigin: string;
  hostName: string;
  now?: () => number;
  randomUuid?: () => string;
  randomSecret?: () => string;
  autoPoll?: boolean;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  /**
   * Come back as the SAME host instead of minting a new identity. Without this
   * every restart replaced the Mac with a different host while the phone still
   * held a pairing valid for weeks, so the only cure was a new QR scan.
   */
  restore?: RemoteControlHostRecord;
  /** Called whenever persistable host state changes, so the caller can store it. */
  onRecordChanged?: (record: RemoteControlHostRecord | null) => void;
  /** Optional semantic task surface. It remains inert without a per-session grant. */
  taskGateway?: Pick<RemoteControlTaskGateway, 'perform'>;
  /** E2EE-only persistent conversation surface, guarded by its own grant. */
  conversationGateway?: Pick<RemoteControlConversationGateway, 'perform'>;
  terminalGateway?: RemoteTerminalGateway;
}

type SessionCryptoState = {
  row: RemoteControlInternetSessionRow;
  receiveKey: CryptoKey;
  sendKey: CryptoKey;
  receiveCursor: RemoteControlRelayReceiveCursor;
  sendSequence: number;
  sasCode: string | null;
  /**
   * Set when a `session.ready` has been pushed to a restored session and the
   * controller has not been heard from since. The controller only re-pairs on
   * its own when it has no session token at all, so after a restart the host
   * has to hand it a fresh one — it cannot wait to be asked.
   */
  pendingSessionReadyAt: number | null;
  /**
   * The core session this relay session paired into. Revoking one phone must
   * close only its own core session — a bare closeSession() closed every
   * connected device, which was invisible while a Mac could hold only one.
   */
  coreSessionToken: string | null;
  responsesByInboundMessageId: Map<string, {
    messageType: RemoteControlInternetRelayMessageType;
    envelope: RemoteControlRelayEnvelope;
  }>;
  taskScopeGranted: boolean;
  conversationScopeGranted: boolean;
};

function controllerUrlFromOrigin(value: string): string {
  const origin = normalizeHttpsExactOrigin(value);
  if (!origin) throw new RemoteControlError('INVALID_CONTROLLER_ORIGIN', '외부 원격제어 주소는 경로·query가 없는 HTTPS 주소여야 합니다.');
  return `${origin}/remote/`;
}

function iso(value: unknown, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    throw new RemoteControlError('RELAY_RESPONSE_INVALID', `${field} 응답이 올바르지 않습니다.`, 502);
  }
  return value;
}

function corePairingToken(pairingUrl: string): string {
  const url = new URL(pairingUrl);
  const token = new URLSearchParams(url.hash.slice(1)).get('pair') ?? '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('REMOTE_CONTROL_CORE_PAIRING_TOKEN_INVALID');
  return token;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', textEncoder.encode(value).slice().buffer));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

function randomSecret(): string {
  return encodeRemoteControlRelayBase64Url(randomBytes(32));
}

function publicErrorMessage(error: unknown): string {
  if (error instanceof RemoteControlError) return error.publicMessage;
  return '암호화 릴레이에 연결하지 못했습니다.';
}

function sameOpaqueSecret(candidate: string, expected: string): boolean {
  const left = textEncoder.encode(candidate);
  const right = textEncoder.encode(expected);
  if (left.byteLength !== right.byteLength || right.byteLength === 0) return false;
  return timingSafeEqual(left, right);
}

function remoteTaskFailure(
  request: RemoteControlTaskRequest,
  code: string,
  message: string,
  retryable: boolean,
): RemoteControlTaskResult {
  return normalizeRemoteControlTaskResult({
    type: 'tasks.result',
    protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
    taskProtocolVersion: REMOTE_CONTROL_TASK_SEMANTIC_VERSION,
    operationId: request.operationId,
    ok: false,
    error: { code, message, retryable },
  });
}

function remoteConversationFailure(
  request: RemoteControlConversationRequest,
  code: string,
  message: string,
  retryable: boolean,
): RemoteControlConversationResult {
  return normalizeRemoteControlConversationResult({
    type: 'conversations.result',
    protocolVersion: request.protocolVersion,
    conversationProtocolVersion: request.conversationProtocolVersion,
    operationId: request.operationId,
    operation: request.operation,
    ok: false,
    error: { code, message, retryable },
  });
}

/**
 * The two codes that mean "this token is no longer live". They are recoverable
 * rather than terminal: the controller cannot mint its own token, so answering
 * with an error would strand it forever.
 */
function isRemoteControlSessionRecovery(code: string): boolean {
  return code === 'INVALID_SESSION_TOKEN' || code === 'SESSION_EXPIRED';
}

function minExpiry(now: number, sessionExpiresAt: string): string {
  return new Date(Math.min(now + MESSAGE_TTL_MS, Date.parse(sessionExpiresAt))).toISOString();
}

export class RemoteControlInternetAgent {
  readonly #transport: RemoteControlInternetHostTransport;
  readonly #core: RemoteControlCore;
  readonly #controllerUrl: string;
  readonly #hostName: string;
  readonly #now: () => number;
  readonly #randomUuid: () => string;
  readonly #setTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  readonly #clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  readonly #autoPoll: boolean;
  readonly #hostId: string;
  #hostSecret: string;
  readonly #controllerOrigin: string;
  #hostPrivateScalar = '';
  #restore: RemoteControlHostRecord | null;
  readonly #onRecordChanged: ((record: RemoteControlHostRecord | null) => void) | null;
  readonly #taskGateway: Pick<RemoteControlTaskGateway, 'perform'> | null;
  readonly #terminalGateway: RemoteTerminalGateway | null;
  readonly #conversationGateway: Pick<RemoteControlConversationGateway, 'perform'> | null;
  #hostKeyPair: CryptoKeyPair | null = null;
  #hostPublicKey = '';
  #hostPublicKeyFingerprint = '';
  readonly #randomSecret: () => string;
  #pairingSecret = '';
  /**
   * Every pairing secret this host has issued and not yet expired, newest last.
   *
   * The relay binds one pairing row to one controller public key, so a second
   * device genuinely needs a second QR. Keeping only the newest secret would
   * reject a device that was issued an earlier QR and later has to re-pair
   * (its stored session token lost), so `controller.pair` accepts any active
   * secret. Each secret stays paired with its relay pairing id so an older QR
   * scanned after a newer one still derives the same SAS on both devices.
   */
  #activePairingSecrets: Array<{ pairingId: string | null; secret: string }> = [];
  #pairingId = '';
  #pairingExpiresAt: string | null = null;
  #hostExpiresAt: string | null = null;
  #lastRelayContactAt: string | null = null;
  #sessions: RemoteControlInternetSessionRow[] = [];
  #sessionCrypto = new Map<string, SessionCryptoState>();
  #locallyRevokedSessions = new Map<string, string>();
  #relayCursor = '0';
  #error: string | null = null;
  #stopped = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #backoffMs = ACTIVE_POLL_MS;
  #pollPromise: Promise<void> | null = null;

  constructor(options: CreateRemoteControlInternetAgentOptions) {
    this.#transport = options.transport;
    const restore = options.restore ?? null;
    this.#restore = restore;
    for (const revoked of restore?.revokedSessions ?? []) {
      this.#locallyRevokedSessions.set(revoked.sessionId, revoked.revokedAt);
    }
    this.#onRecordChanged = options.onRecordChanged ?? null;
    this.#taskGateway = options.taskGateway ?? null;
    this.#conversationGateway = options.conversationGateway ?? null;
    this.#terminalGateway = options.terminalGateway ?? null;
    const controllerOrigin = normalizeHttpsExactOrigin(restore?.controllerOrigin ?? options.controllerOrigin);
    if (!controllerOrigin) {
      throw new RemoteControlError('INVALID_CONTROLLER_ORIGIN', '외부 원격제어 주소는 경로·query가 없는 HTTPS 주소여야 합니다.');
    }
    this.#controllerOrigin = controllerOrigin;
    this.#controllerUrl = controllerUrlFromOrigin(controllerOrigin);
    this.#hostName = (restore?.hostName ?? options.hostName).trim();
    if (!this.#hostName || this.#hostName.length > 80) throw new Error('hostName must be 1-80 characters');
    this.#now = options.now ?? Date.now;
    this.#randomUuid = options.randomUuid ?? randomUUID;
    this.#randomSecret = options.randomSecret ?? randomSecret;
    // A restored host keeps its relay identity; only a brand-new one mints it.
    this.#hostId = restore?.hostId ?? this.#randomUuid();
    this.#hostSecret = restore?.hostSecret ?? this.#randomSecret();
    if (!/^[A-Za-z0-9_-]{43}$/.test(this.#hostSecret)) throw new Error('randomSecret must return 32 canonical base64url bytes');
    this.#setTimer = options.setTimer ?? setTimeout;
    this.#clearTimer = options.clearTimer ?? clearTimeout;
    this.#autoPoll = options.autoPoll ?? true;
    // This is protocol support, not a scope grant. Still, tasks-v1 must not be
    // advertised by a production host while managed execution is fail-closed;
    // the independently sandboxed read-only conversation surface may advertise
    // only when its gateway is actually installed.
    const supportedFeatures = [
      ...(options.taskGateway && AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED
        ? [REMOTE_CONTROL_TASK_SCOPE]
        : []),
      ...(options.conversationGateway ? [REMOTE_CONTROL_CONVERSATION_SCOPE] : []),
    ];
    this.#core = new RemoteControlCore(options.gateway, {
      hostName: this.#hostName,
      now: this.#now,
      supportedFeatures,
    });
  }

  /**
   * Resume the stored host: same id, same secret, same key pair, same QR.
   *
   * `register_host` is a plain insert with no upsert (remoteControlRelaySql.ts),
   * so re-registering would collide — the host row is still there and still
   * ours. `listSessions` proves that: it authorizes on the host secret and
   * refuses once the row is revoked or expired, which is exactly when the
   * record is worthless and the caller should start clean.
   */
  async restore(): Promise<RemoteControlInternetPairingIssue> {
    const record = this.#restore;
    if (!record) throw new Error('REMOTE_CONTROL_AGENT_NOTHING_TO_RESTORE');
    if (this.#hostKeyPair || this.#stopped) throw new Error('REMOTE_CONTROL_AGENT_ALREADY_INITIALIZED');
    const keyPair = await importRemoteControlRelayHostKeyPair(record.hostPrivateScalar, record.hostPublicKey);
    const hostPublicKey = await exportRemoteControlRelayPublicKey(keyPair.publicKey);
    if (hostPublicKey !== record.hostPublicKey) {
      throw new RemoteControlError('RELAY_HOST_KEY_MISMATCH', '저장된 Mac 공개키가 개인키와 맞지 않습니다.', 500);
    }
    this.#hostKeyPair = keyPair;
    this.#hostPublicKey = hostPublicKey;
    this.#hostPublicKeyFingerprint = await fingerprintRemoteControlRelayPublicKey(hostPublicKey);
    this.#hostPrivateScalar = record.hostPrivateScalar;
    // The core has to be on for `pair()` to work, but its freshly minted token
    // is not the one any phone scanned — the stored secrets are.
    this.#core.enable(this.#controllerUrl);
    // Load first, then reconcile against the relay sessions. Pruning before
    // listSessions knows which pairing ids are active could evict the one
    // secret an approved controller still needs.
    this.#activePairingSecrets = record.pairingSecrets.map((secret, index) => ({
      secret,
      pairingId: record.pairingIds?.[index]
        ?? (index === record.pairingSecrets.length - 1 ? record.pairingId : null),
    }));
    this.#pairingSecret = record.pairingSecrets[record.pairingSecrets.length - 1]!;
    this.#pairingId = record.pairingId;
    this.#pairingExpiresAt = record.pairingExpiresAt;
    this.#hostExpiresAt = record.hostExpiresAt;
    this.#relayCursor = record.relayCursor;
    try {
      // Fail here rather than sitting in a half-restored state: this is the one
      // call that tells us the relay still recognises this host.
      this.#sessions = this.#applyLocalRevocations(
        await this.#transport.listSessions(this.#hostId, this.#hostSecret),
      );
      this.#prunePairingSecrets();
    } catch (error) {
      // ⚠️ Stop WITHOUT touching the stored record. A Mac that boots before its
      // network does would otherwise throw away its identity over a timeout,
      // and the phone would be told to scan a new QR for nothing. Only the
      // caller can tell a refusal from an unreachable relay.
      this.#stopped = true;
      if (this.#timer) this.#clearTimer(this.#timer);
      this.#timer = null;
      this.#core.disable();
      this.#hostKeyPair = null;
      this.#hostPublicKey = '';
      this.#hostPublicKeyFingerprint = '';
      this.#hostPrivateScalar = '';
      this.#pairingSecret = '';
      this.#activePairingSecrets = [];
      this.#sessions = [];
      throw error;
    }
    this.#lastRelayContactAt = new Date(this.#now()).toISOString();
    this.#persistRecord();
    if (this.#autoPoll) this.#schedule(ACTIVE_POLL_MS);
    return {
      pairingUrl: buildRemoteControlRelayPairingUrl(this.#controllerUrl, {
        schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
        hostId: this.#hostId,
        pairingId: this.#pairingId,
        pairingSecret: this.#pairingSecret,
        hostPublicKey,
        expiresAt: this.#pairingExpiresAt ?? new Date(this.#now()).toISOString(),
      }),
      expiresAt: this.#pairingExpiresAt ?? new Date(this.#now()).toISOString(),
    };
  }

  async initialize(): Promise<RemoteControlInternetPairingIssue> {
    if (this.#hostKeyPair || this.#stopped) throw new Error('REMOTE_CONTROL_AGENT_ALREADY_INITIALIZED');
    const generated = await generateRemoteControlRelayHostKeyPair();
    const keyPair = generated.keyPair;
    const hostPublicKey = generated.publicKey;
    const hostFingerprint = await fingerprintRemoteControlRelayPublicKey(hostPublicKey);
    this.#hostKeyPair = keyPair;
    this.#hostPublicKey = hostPublicKey;
    this.#hostPublicKeyFingerprint = hostFingerprint;
    this.#hostPrivateScalar = generated.privateScalar;
    const localPairing = this.#core.enable(this.#controllerUrl);
    const pairingSecret = corePairingToken(localPairing.pairingUrl);
    this.#pairingSecret = pairingSecret;
    try {
      const registered = await this.#transport.registerHost({
        hostId: this.#hostId,
        hostSecret: this.#hostSecret,
        hostName: this.#hostName,
        hostPublicKey,
        ttlSeconds: HOST_TTL_SECONDS,
      });
      this.#hostExpiresAt = iso(registered.expiresAt, 'host expiresAt');
      if (registered.hostPublicKeyFingerprint !== hostFingerprint) {
        throw new RemoteControlError('RELAY_HOST_KEY_MISMATCH', '릴레이가 이 Mac의 공개키를 다르게 등록했습니다.', 502);
      }
      const pairing = await this.#transport.createPairing({
        hostId: this.#hostId,
        hostSecret: this.#hostSecret,
        pairingSecretHash: await sha256Hex(pairingSecret),
      });
      this.#pairingId = pairing.pairingId;
      this.#pairingExpiresAt = iso(pairing.expiresAt, 'pairing expiresAt');
      this.#discardRetiredPairingSecrets(pairing.retiredPairingIds);
      this.#rememberPairingSecret(pairingSecret, this.#pairingId);
      if (pairing.hostPublicKey !== hostPublicKey
        || pairing.hostPublicKeyFingerprint !== hostFingerprint) {
        throw new RemoteControlError('RELAY_HOST_KEY_MISMATCH', 'QR의 Mac 공개키를 검증하지 못했습니다.', 502);
      }
      this.#lastRelayContactAt = new Date(this.#now()).toISOString();
      this.#persistRecord();
      if (this.#autoPoll) this.#schedule(ACTIVE_POLL_MS);
      return {
        pairingUrl: buildRemoteControlRelayPairingUrl(this.#controllerUrl, {
          schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
          hostId: this.#hostId,
          pairingId: this.#pairingId,
          pairingSecret,
          hostPublicKey,
          expiresAt: this.#pairingExpiresAt,
        }),
        expiresAt: this.#pairingExpiresAt,
      };
    } catch (error) {
      const hostSecret = this.#hostSecret;
      this.#clearLocalAuthority();
      if (hostSecret) {
        await this.#transport.disableHost(this.#hostId, hostSecret).catch(() => undefined);
      }
      throw error;
    }
  }

  status(): RemoteControlInternetStatus {
    this.#expireLocalAuthorityIfNeeded();
    const now = this.#now();
    const expired = !this.#hostExpiresAt || Date.parse(this.#hostExpiresAt) <= now;
    const enabled = !this.#stopped && !expired && !!this.#hostKeyPair;
    const pending = this.#sessions.some(session => session.approvalState === 'pending');
    const approved = this.#sessions.some(session => session.approvalState === 'approved');
    const state: RemoteControlInternetState = !enabled
      ? 'disabled'
      : this.#error
        ? 'degraded'
        : approved
          ? 'online'
          : pending
            ? 'approval-required'
            : this.#pairingExpiresAt && Date.parse(this.#pairingExpiresAt) > now
              ? 'pairing'
              : 'offline';
    return {
      enabled,
      state,
      controllerUrl: enabled ? this.#controllerUrl : null,
      hostExpiresAt: enabled ? this.#hostExpiresAt : null,
      pairingExpiresAt: enabled ? this.#pairingExpiresAt : null,
      lastRelayContactAt: this.#lastRelayContactAt,
      sessions: this.#sessions.map(session => ({
        sessionId: session.sessionId,
        pairingId: session.pairingId,
        controllerId: session.controllerId,
        controllerName: session.controllerName,
        controllerKeyFingerprint: session.controllerKeyFingerprint,
        approvalState: session.approvalState,
        sasCode: session.approvalState === 'pending'
          ? this.#sessionCrypto.get(session.sessionId)?.sasCode ?? null
          : null,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        approvedAt: session.approvedAt,
        taskScopeGranted: this.#sessionCrypto.get(session.sessionId)?.taskScopeGranted
          ?? this.#restoredSession(session.sessionId, session.controllerId)?.scopes?.includes(REMOTE_CONTROL_TASK_SCOPE)
          ?? false,
        conversationScopeGranted: this.#sessionCrypto.get(session.sessionId)?.conversationScopeGranted
          ?? this.#restoredSession(session.sessionId, session.controllerId)?.scopes?.includes(REMOTE_CONTROL_CONVERSATION_SCOPE)
          ?? false,
      })),
      error: this.#error,
    };
  }

  #rememberPairingSecret(secret: string, pairingId: string | null): void {
    // Deliberately NOT pruned by the 30-day pairing expiry. The relay's
    // claim_pairing only enforces expiry while `claimed_at is null`
    // (remoteControlRelaySql.ts:532), so an already-paired device may re-claim
    // its original QR indefinitely — and the controller re-sends that same
    // token on every reconnect that lost its session token. Expiring the
    // secret locally would disconnect device 1 on day 2. FIFO eviction only.
    this.#activePairingSecrets = this.#activePairingSecrets.filter(entry => (
      entry.secret !== secret && (!pairingId || entry.pairingId !== pairingId)
    ));
    this.#activePairingSecrets.push({ pairingId, secret });
    this.#prunePairingSecrets();
  }

  #discardRetiredPairingSecrets(pairingIds: string[] | undefined): void {
    if (!pairingIds?.length) return;
    const retired = new Set(pairingIds);
    this.#activePairingSecrets = this.#activePairingSecrets
      .filter(entry => !entry.pairingId || !retired.has(entry.pairingId));
  }

  #applyLocalRevocations(
    sessions: RemoteControlInternetSessionRow[],
    tombstones = this.#locallyRevokedSessions,
  ): RemoteControlInternetSessionRow[] {
    return sessions.map(session => {
      const revokedAt = tombstones.get(session.sessionId);
      return revokedAt
        ? { ...session, approvalState: 'revoked' as const, revokedAt }
        : session;
    });
  }

  #prunePairingSecrets(): void {
    const protectedPairingIds = new Set(this.#sessions
      .filter(session => session.approvalState === 'pending' || session.approvalState === 'approved')
      .map(session => session.pairingId));
    const removableIndex = () => this.#activePairingSecrets.findIndex(entry => (
      !entry.pairingId || !protectedPairingIds.has(entry.pairingId)
    ));
    const unprotectedCount = () => this.#activePairingSecrets.filter(entry => (
      !entry.pairingId || !protectedPairingIds.has(entry.pairingId)
    )).length;
    // The SQL atomically keeps at most eight unclaimed invitations. Mirror
    // that lifecycle locally so removed QR material cannot linger in the vault.
    while (unprotectedCount() > MAX_OUTSTANDING_PAIRING_SECRETS) {
      const removable = removableIndex();
      if (removable < 0) break;
      this.#activePairingSecrets.splice(removable, 1);
    }
    while (this.#activePairingSecrets.length > MAX_RETAINED_PAIRING_SECRETS) {
      const removable = removableIndex();
      if (removable < 0) {
        throw new RemoteControlError(
          'SESSION_LIMIT',
          `이 Mac에는 최대 ${REMOTE_CONTROL_MAX_SESSIONS}대까지 동시에 연결할 수 있습니다. 쓰지 않는 연결을 먼저 해제하세요.`,
          409,
        );
      }
      this.#activePairingSecrets.splice(removable, 1);
    }
  }

  #isActivePairingSecret(candidate: string): boolean {
    let matched = false;
    // No early return: the number of comparisons must not depend on which
    // secret matched.
    for (const entry of this.#activePairingSecrets) {
      if (sameOpaqueSecret(candidate, entry.secret)) matched = true;
    }
    return matched;
  }

  /**
   * Mint an additional single-use QR so another phone can connect, without
   * disturbing the devices already paired. The relay binds a pairing row to one
   * controller public key, so adding a device is necessarily a new pairing —
   * previously the only route was disabling the host, which revoked everyone.
   */
  async issuePairing(): Promise<RemoteControlInternetPairingIssue> {
    this.#assertActive();
    // Mint independently of the core's pairing state: `controller.pair` already
    // rotates the core pairing per device, and touching it here could race that.
    const pairingSecret = this.#randomSecret();
    // Validate the way buildRemoteControlRelayPairingUrl will, BEFORE the relay
    // stores a hash we could never satisfy — a 43-char shape check is weaker
    // than the canonical base64url decode the URL builder performs.
    try {
      if (decodeRemoteControlRelayBase64Url(pairingSecret, 'pairing secret').byteLength !== 32) {
        throw new Error('length');
      }
    } catch {
      throw new RemoteControlError('RELAY_PAIRING_SECRET_INVALID', 'QR 비밀값을 만들지 못했습니다.', 500);
    }
    const pairing = await this.#transport.createPairing({
      hostId: this.#hostId,
      hostSecret: this.#hostSecret,
      pairingSecretHash: await sha256Hex(pairingSecret),
    });
    if (pairing.hostPublicKey !== this.#hostPublicKey
      || pairing.hostPublicKeyFingerprint !== this.#hostPublicKeyFingerprint) {
      throw new RemoteControlError('RELAY_HOST_KEY_MISMATCH', 'QR의 Mac 공개키를 검증하지 못했습니다.', 502);
    }
    this.#pairingSecret = pairingSecret;
    this.#pairingId = pairing.pairingId;
    this.#pairingExpiresAt = iso(pairing.expiresAt, 'pairing expiresAt');
    this.#discardRetiredPairingSecrets(pairing.retiredPairingIds);
    this.#rememberPairingSecret(pairingSecret, this.#pairingId);
    this.#lastRelayContactAt = new Date(this.#now()).toISOString();
    this.#persistRecord();
    return {
      pairingUrl: buildRemoteControlRelayPairingUrl(this.#controllerUrl, {
        schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
        hostId: this.#hostId,
        pairingId: this.#pairingId,
        pairingSecret,
        hostPublicKey: this.#hostPublicKey,
        expiresAt: this.#pairingExpiresAt,
      }),
      expiresAt: this.#pairingExpiresAt,
    };
  }

  async approveSession(
    sessionId: string,
    expectedSasCode: string,
    grantTaskScope = false,
    grantConversationScope = false,
  ): Promise<RemoteControlInternetStatus> {
    this.#assertActive();
    const pending = this.#sessions.find(session => session.sessionId === sessionId && session.approvalState === 'pending');
    if (!pending) throw new RemoteControlError('SESSION_NOT_PENDING', '승인 대기 중인 연결이 아닙니다.', 409);
    const cryptoState = await this.#ensureSessionCrypto(pending);
    if (!cryptoState.sasCode
      || !/^\d{6}$/.test(expectedSasCode)
      || expectedSasCode !== cryptoState.sasCode) {
      throw new RemoteControlError('SAS_MISMATCH', '휴대폰에 표시된 6자리 확인 코드와 일치하지 않습니다.', 409);
    }
    if (typeof grantTaskScope !== 'boolean') {
      throw new RemoteControlError('INVALID_TASK_SCOPE', '에이전트 작업 권한 선택이 올바르지 않습니다.');
    }
    if (typeof grantConversationScope !== 'boolean') {
      throw new RemoteControlError('INVALID_CONVERSATION_SCOPE', '지속형 대화 권한 선택이 올바르지 않습니다.');
    }
    // Persist an affirmative grant before the relay can make the session live.
    // If the app-data write fails, the controller remains pending and cannot
    // inherit an in-memory permission that disappears or changes on restart.
    cryptoState.taskScopeGranted = grantTaskScope;
    cryptoState.conversationScopeGranted = grantConversationScope;
    if (grantTaskScope || grantConversationScope) {
      try {
        this.#persistRecordStrict();
      } catch {
        cryptoState.taskScopeGranted = false;
        cryptoState.conversationScopeGranted = false;
        this.#persistRecord();
        const taskOnly = grantTaskScope && !grantConversationScope;
        const conversationOnly = grantConversationScope && !grantTaskScope;
        throw new RemoteControlError(
          taskOnly
            ? 'TASK_SCOPE_PERSIST_FAILED'
            : conversationOnly
              ? 'CONVERSATION_SCOPE_PERSIST_FAILED'
              : 'RUNTIME_SCOPE_PERSIST_FAILED',
          taskOnly
            ? '에이전트 작업 권한을 이 Mac에 안전하게 저장하지 못해 연결을 승인하지 않았습니다.'
            : conversationOnly
              ? '지속형 대화 권한을 이 Mac에 안전하게 저장하지 못해 연결을 승인하지 않았습니다.'
              : '에이전트 작업·대화 권한을 이 Mac에 안전하게 저장하지 못해 연결을 승인하지 않았습니다.',
          500,
        );
      }
    }
    const approved = await this.#transport.approveSession(this.#hostId, this.#hostSecret, sessionId);
    if (approved.controllerId !== pending.controllerId
      || approved.controllerPublicKey !== pending.controllerPublicKey
      || approved.approvalState !== 'approved') {
      throw new RemoteControlError('RELAY_RESPONSE_INVALID', '승인된 연결 정보가 대기 중인 기기와 다릅니다.', 502);
    }
    this.#sessions = this.#sessions.map(session => session.sessionId === sessionId ? approved : session);
    cryptoState.row = approved;
    this.#error = null;
    this.#persistRecord();
    return this.status();
  }

  async revokeSession(sessionId: string): Promise<RemoteControlInternetStatus> {
    this.#assertActive();
    const session = this.#sessions.find(candidate => candidate.sessionId === sessionId);
    if (!session) throw new RemoteControlError('SESSION_NOT_FOUND', '연결된 기기를 찾지 못했습니다.', 404);
    const hostSecret = this.#hostSecret;
    const revokedAt = new Date(this.#now()).toISOString();
    const coreSessionToken = this.#sessionCrypto.get(sessionId)?.coreSessionToken ?? null;
    this.#locallyRevokedSessions.set(sessionId, revokedAt);
    this.#sessions = this.#sessions.map(candidate => candidate.sessionId === sessionId
      ? { ...candidate, approvalState: 'revoked', revokedAt }
      : candidate);
    this.#sessionCrypto.delete(sessionId);
    if (coreSessionToken) this.#core.closeSession(coreSessionToken);
    // Local authority is removed first and is never restored by a failed
    // relay cleanup. The remote host/session rows remain time-bounded by their
    // existing TTL and a later poll keeps this local tombstone authoritative.
    try {
      this.#persistRecord(true);
    } catch (persistError) {
      // The durable per-session marker and its host-level fallback both may be
      // unavailable (for example a read-only app-data volume). Preserve the
      // pre-disable secret long enough to make one best-effort relay revoke,
      // then still report the storage failure instead of claiming success.
      await this.#transport.revokeSession(this.#hostId, hostSecret, sessionId).catch(() => undefined);
      throw persistError;
    }
    try {
      await this.#transport.revokeSession(this.#hostId, this.#hostSecret, sessionId);
      this.#locallyRevokedSessions.delete(sessionId);
      this.#persistRecord();
    } catch {
      throw new RemoteControlError(
        'SESSION_REVOKE_PENDING',
        '이 기기는 이 Mac에서 즉시 차단했지만 릴레이 정리를 완료하지 못했습니다. 로컬 차단은 재시작 뒤에도 유지되며 자동으로 다시 시도합니다.',
        503,
      );
    }
    return this.status();
  }

  async updateSessionScopes(
    sessionId: string,
    grantTaskScope: boolean,
    grantConversationScope: boolean,
  ): Promise<RemoteControlInternetStatus> {
    this.#assertActive();
    if (typeof grantTaskScope !== 'boolean') {
      throw new RemoteControlError('INVALID_TASK_SCOPE', '에이전트 작업 권한 선택이 올바르지 않습니다.');
    }
    if (typeof grantConversationScope !== 'boolean') {
      throw new RemoteControlError('INVALID_CONVERSATION_SCOPE', '지속형 대화 권한 선택이 올바르지 않습니다.');
    }
    const approved = this.#sessions.find(session => (
      session.sessionId === sessionId && session.approvalState === 'approved'
    ));
    if (!approved) {
      throw new RemoteControlError('SESSION_NOT_APPROVED', '승인된 모바일 연결을 찾지 못했습니다.', 409);
    }
    const cryptoState = await this.#ensureSessionCrypto(approved);
    const previousTaskScope = cryptoState.taskScopeGranted;
    const previousConversationScope = cryptoState.conversationScopeGranted;
    if (previousTaskScope === grantTaskScope
      && previousConversationScope === grantConversationScope) return this.status();

    cryptoState.taskScopeGranted = grantTaskScope;
    cryptoState.conversationScopeGranted = grantConversationScope;
    try {
      // Scope grants and reductions are local Mac authority. Persist them
      // before reporting success so a restart cannot silently restore a stale
      // permission set.
      this.#persistRecordStrict();
    } catch {
      const reducesAuthority = (previousTaskScope && !grantTaskScope)
        || (previousConversationScope && !grantConversationScope);
      cryptoState.taskScopeGranted = previousTaskScope;
      cryptoState.conversationScopeGranted = previousConversationScope;
      if (reducesAuthority) {
        // A failed permission reduction must not leave an old durable grant
        // usable after restart. Revoke the entire controller fail-closed; the
        // revocation path has its own durable host-level fallback.
        try {
          await this.revokeSession(sessionId);
        } catch (error) {
          throw error;
        }
        throw new RemoteControlError(
          'RUNTIME_SCOPE_REDUCTION_DISCONNECTED',
          '권한 축소를 안전하게 저장하지 못해 이 모바일 기기의 연결을 전체 해제했습니다. 다시 연결한 뒤 필요한 권한만 승인하세요.',
          500,
        );
      }
      throw new RemoteControlError(
        'RUNTIME_SCOPE_PERSIST_FAILED',
        '새 런타임 권한을 이 Mac에 안전하게 저장하지 못해 권한을 변경하지 않았습니다.',
        500,
      );
    }
    this.#error = null;
    return this.status();
  }

  async disable(): Promise<RemoteControlInternetStatus> {
    if (this.#stopped) return this.status();
    const hostSecret = this.#hostSecret;
    this.#clearLocalAuthority();
    if (hostSecret) await this.#transport.disableHost(this.#hostId, hostSecret);
    return this.status();
  }

  pollNow(): Promise<void> {
    if (this.#pollPromise) return this.#pollPromise;
    this.#pollPromise = this.#poll().finally(() => { this.#pollPromise = null; });
    return this.#pollPromise;
  }

  #assertActive(): void {
    this.#expireLocalAuthorityIfNeeded();
    if (this.#stopped || !this.#hostKeyPair || !this.#hostSecret) {
      throw new RemoteControlError('INTERNET_REMOTE_DISABLED', '외부 인터넷 원격제어가 꺼져 있습니다.', 409);
    }
  }

  #expireLocalAuthorityIfNeeded(): void {
    if (!this.#stopped
      && this.#hostExpiresAt
      && Date.parse(this.#hostExpiresAt) <= this.#now()) {
      this.#clearLocalAuthority();
    }
  }

  #clearLocalAuthority(persist = true): void {
    this.#stopped = true;
    if (this.#timer) this.#clearTimer(this.#timer);
    this.#timer = null;
    this.#core.disable();
    this.#hostSecret = '';
    this.#hostKeyPair = null;
    this.#hostPublicKey = '';
    this.#hostPublicKeyFingerprint = '';
    this.#pairingSecret = '';
    this.#pairingId = '';
    this.#hostExpiresAt = null;
    this.#pairingExpiresAt = null;
    this.#sessionCrypto.clear();
    this.#locallyRevokedSessions.clear();
    this.#sessions = [];
    this.#error = null;
    this.#hostPrivateScalar = '';
    this.#activePairingSecrets = [];
    // Authority is gone: the stored record must go with it, or the next start
    // would resurrect a host the user turned off.
    if (persist) this.#persistRecord();
  }

  #restoredSession(sessionId: string, controllerId: string): RemoteControlHostSessionRecord | null {
    const stored = this.#restore?.sessions.find(session => session.sessionId === sessionId) ?? null;
    return stored && stored.controllerId === controllerId ? stored : null;
  }

  /**
   * Everything a future process needs to come back as this same host. Returns
   * null once local authority is gone, which is the caller's cue to delete the
   * stored record rather than resurrect a disabled host on the next start.
   */
  record(): RemoteControlHostRecord | null {
    if (this.#stopped || !this.#hostKeyPair || !this.#hostSecret || !this.#hostPrivateScalar) return null;
    if (!this.#pairingId || this.#activePairingSecrets.length === 0) return null;
    const live = new Map(this.#sessions
      .filter(session => session.approvalState === 'pending' || session.approvalState === 'approved')
      .map(session => [session.sessionId, session] as const));
    const sessions: RemoteControlHostSessionRecord[] = [];
    for (const [sessionId, row] of live) {
      const state = this.#sessionCrypto.get(sessionId);
      const restored = state ? null : this.#restoredSession(sessionId, row.controllerId);
      if (!state && !restored) continue;
      const sendSequence = state?.sendSequence ?? restored!.sendSequence;
      const receiveCursor = state?.receiveCursor ?? restored!.receiveCursor;
      const taskScopeGranted = state?.taskScopeGranted
        ?? Boolean(restored?.scopes?.includes(REMOTE_CONTROL_TASK_SCOPE));
      const conversationScopeGranted = state?.conversationScopeGranted
        ?? Boolean(restored?.scopes?.includes(REMOTE_CONTROL_CONVERSATION_SCOPE));
      sessions.push({
        sessionId,
        controllerId: row.controllerId,
        sendSequence,
        receiveCursor,
        scopes: [
          ...(taskScopeGranted ? [REMOTE_CONTROL_TASK_SCOPE] : []),
          ...(conversationScopeGranted ? [REMOTE_CONTROL_CONVERSATION_SCOPE] : []),
        ],
      });
    }
    return {
      schemaVersion: 1,
      hostId: this.#hostId,
      hostSecret: this.#hostSecret,
      hostPrivateScalar: this.#hostPrivateScalar,
      hostPublicKey: this.#hostPublicKey,
      hostName: this.#hostName,
      controllerOrigin: this.#controllerOrigin,
      pairingId: this.#pairingId,
      pairingExpiresAt: this.#pairingExpiresAt,
      hostExpiresAt: this.#hostExpiresAt,
      pairingSecrets: this.#activePairingSecrets.map(entry => entry.secret),
      pairingIds: this.#activePairingSecrets.map(entry => entry.pairingId),
      relayCursor: this.#relayCursor,
      sessions,
      revokedSessions: [...this.#locallyRevokedSessions.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([sessionId, revokedAt]) => ({ sessionId, revokedAt })),
    };
  }

  #persistRecord(required = false): void {
    if (!this.#onRecordChanged) return;
    const record = this.record();
    // Keep the in-memory restore view in step so `record()` still reports a
    // session whose crypto has not been rebuilt yet in this process.
    this.#restore = record;
    try {
      this.#onRecordChanged(record);
    } catch {
      // Routine cursor/status snapshots are best-effort. A destructive local
      // tombstone is different: without durable state the next process could
      // restore authority the user explicitly revoked.
      if (required) {
        // A per-session tombstone that cannot be stored is not durable enough
        // to survive a restart. Fall back to the stronger host-level local
        // disable marker (the null callback contract) and drop all in-memory
        // authority before reporting a retryable failure.
        try { this.#onRecordChanged(null); } catch { /* the failure remains visible below */ }
        this.#restore = null;
        this.#clearLocalAuthority(false);
        throw new RemoteControlError(
          'LOCAL_REVOCATION_PERSIST_FAILED',
          '기기 차단 상태를 저장하지 못해 이 실행의 외부 원격제어를 전체 차단했습니다. 앱 데이터 폴더 권한을 확인한 뒤 전체 끄기를 다시 시도하세요.',
          500,
        );
      }
    }
  }

  #persistRecordStrict(): void {
    if (!this.#onRecordChanged) {
      throw new Error('REMOTE_CONTROL_HOST_RECORD_WRITER_UNAVAILABLE');
    }
    const record = this.record();
    if (!record) throw new Error('REMOTE_CONTROL_HOST_RECORD_UNAVAILABLE');
    this.#onRecordChanged(record);
    this.#restore = record;
  }

  async #ensureSessionCrypto(row: RemoteControlInternetSessionRow): Promise<SessionCryptoState> {
    const existing = this.#sessionCrypto.get(row.sessionId);
    if (existing) return existing;
    if (!this.#hostKeyPair || !this.#pairingSecret) throw new Error('REMOTE_CONTROL_HOST_KEY_UNAVAILABLE');
    const pairingSecret = this.#activePairingSecrets
      .find(entry => entry.pairingId === row.pairingId)?.secret;
    if (!pairingSecret && row.approvalState === 'pending') {
      throw new RemoteControlError(
        'PAIRING_SECRET_UNAVAILABLE',
        '이 연결을 발급한 QR의 보안 정보를 찾지 못했습니다. 새 QR을 발급해 다시 연결해 주세요.',
        409,
      );
    }
    if (row.controllerKeyFingerprint !== await fingerprintRemoteControlRelayPublicKey(row.controllerPublicKey)) {
      throw new RemoteControlError('CONTROLLER_KEY_MISMATCH', '연결 기기의 공개키 지문이 일치하지 않습니다.', 502);
    }
    const controllerPublicKey = await importRemoteControlRelayPublicKey(row.controllerPublicKey);
    const receiveKey = await deriveRemoteControlRelaySessionKey({
      privateKey: this.#hostKeyPair.privateKey,
      peerPublicKey: controllerPublicKey,
      sessionId: row.sessionId,
      controllerId: row.controllerId,
      direction: 'controller-to-host',
      usages: ['decrypt'],
    });
    const sendKey = await deriveRemoteControlRelaySessionKey({
      privateKey: this.#hostKeyPair.privateKey,
      peerPublicKey: controllerPublicKey,
      sessionId: row.sessionId,
      controllerId: row.controllerId,
      direction: 'host-to-controller',
      usages: ['encrypt'],
    });
    // A resumed session must continue its counters. `acceptRemoteControlRelayEnvelope`
    // takes only `highest + 1`, so restarting at zero makes every message from
    // the phone a stale-sequence rejection and every message to it a gap.
    const stored = this.#restoredSession(row.sessionId, row.controllerId);
    const state: SessionCryptoState = {
      row,
      receiveKey,
      sendKey,
      receiveCursor: stored?.receiveCursor
        ?? createRemoteControlRelayReceiveCursor(row.sessionId, row.controllerId),
      sendSequence: stored?.sendSequence ?? 0,
      coreSessionToken: null,
      pendingSessionReadyAt: null,
      responsesByInboundMessageId: new Map(),
      taskScopeGranted: stored?.scopes?.includes(REMOTE_CONTROL_TASK_SCOPE) ?? false,
      conversationScopeGranted: stored?.scopes?.includes(REMOTE_CONTROL_CONVERSATION_SCOPE) ?? false,
      sasCode: pairingSecret
        ? await remoteControlRelaySasCode({
          hostPublicKey: this.#hostPublicKey,
          controllerPublicKey: row.controllerPublicKey,
          pairingSecret,
        })
        : null,
    };
    this.#sessionCrypto.set(row.sessionId, state);
    return state;
  }

  async #poll(): Promise<void> {
    this.#expireLocalAuthorityIfNeeded();
    if (this.#stopped) return;
    try {
      const relaySessions = await this.#transport.listSessions(this.#hostId, this.#hostSecret);
      const revocationsAtPollStart = new Map(this.#locallyRevokedSessions);
      const sessions = this.#applyLocalRevocations(relaySessions, revocationsAtPollStart);
      // A local revoke is authoritative immediately and durable in the vault.
      // Retry its relay cleanup without letting an outage revive the session or
      // take unrelated approved controllers offline.
      for (const sessionId of revocationsAtPollStart.keys()) {
        const relaySession = relaySessions.find(session => session.sessionId === sessionId);
        if (!relaySession || relaySession.approvalState === 'revoked') {
          this.#locallyRevokedSessions.delete(sessionId);
          continue;
        }
        try {
          await this.#transport.revokeSession(this.#hostId, this.#hostSecret, sessionId);
          this.#locallyRevokedSessions.delete(sessionId);
        } catch {
          // Keep the durable tombstone; the next poll retries.
        }
      }
      const activeSessionIds = new Set(
        sessions
          .filter(session => session.approvalState === 'pending' || session.approvalState === 'approved')
          .map(session => session.sessionId),
      );
      for (const sessionId of this.#sessionCrypto.keys()) {
        if (!activeSessionIds.has(sessionId)) this.#sessionCrypto.delete(sessionId);
      }
      for (let index = 0; index < sessions.length; index += 1) {
        const session = sessions[index]!;
        if (session.approvalState === 'pending' || session.approvalState === 'approved') {
          try {
            await this.#ensureSessionCrypto(session);
          } catch (error) {
            if (!(error instanceof RemoteControlError)
              || error.code !== 'PAIRING_SECRET_UNAVAILABLE'
              || session.approvalState !== 'pending') throw error;
            // A pending controller cannot be safely approved without the exact
            // QR secret that binds its SAS. Revoke only that candidate and keep
            // every valid/approved session online.
            const revokedAt = new Date(this.#now()).toISOString();
            const revoked = { ...session, approvalState: 'revoked' as const, revokedAt };
            sessions[index] = revoked;
            this.#locallyRevokedSessions.set(session.sessionId, revokedAt);
            this.#sessionCrypto.delete(session.sessionId);
            try {
              await this.#transport.revokeSession(this.#hostId, this.#hostSecret, session.sessionId);
              this.#locallyRevokedSessions.delete(session.sessionId);
            } catch {
              // The tombstone is persisted below and retried by later polls.
            }
          }
        }
      }
      this.#sessions = sessions;
      this.#prunePairingSecrets();
      // Hand every resumed session a working token before it asks. The phone
      // still holds the token this Mac issued in a previous process; the core
      // that minted it is gone, and the controller only re-pairs by itself when
      // it has no token at all. Nobody would ever ask.
      for (const session of sessions) {
        if (session.approvalState !== 'approved') continue;
        const state = this.#sessionCrypto.get(session.sessionId);
        if (state && state.coreSessionToken === null && this.#restoredSession(session.sessionId, session.controllerId)) {
          await this.#announceSessionReady(state);
        }
      }
      const received = await this.#transport.receiveEnvelopes(this.#hostId, this.#hostSecret, this.#relayCursor);
      for (const delivery of received) await this.#handleDelivery(delivery);
      await this.#renewHostIfExpiringSoon();
      this.#lastRelayContactAt = new Date(this.#now()).toISOString();
      this.#error = null;
      this.#persistRecord();
      this.#backoffMs = sessions.length ? ACTIVE_POLL_MS : IDLE_POLL_MS;
    } catch (error) {
      this.#error = publicErrorMessage(error);
      this.#backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(ACTIVE_POLL_MS, this.#backoffMs * 2));
      throw error;
    } finally {
      if (this.#autoPoll && !this.#stopped) this.#schedule(this.#backoffMs);
    }
  }

  /**
   * Push a fresh `session.ready` to a session whose core pairing this process
   * does not have. The controller adopts a `session.ready` whenever it arrives,
   * so this replaces its dead token without a QR scan.
   */

  /**
   * Recovery for the task branch. A dead session becomes a fresh session.ready;
   * anything else becomes an answered failure. Minting can itself throw
   * (SESSION_LIMIT when all 8 slots are taken), and an escape from a recovery
   * path would reopen the very hang this exists to prevent -- so that failure
   * is answered too.
   */
  async #recoverOrFailTask(
    state: SessionCryptoState,
    request: RemoteControlTaskRequest,
    publicError: { code: string; message: string },
  ): Promise<unknown> {
    if (isRemoteControlSessionRecovery(publicError.code)) {
      try {
        return await this.#mintSessionReady(state);
      } catch (mintError) {
        const mintPublic = remoteControlPublicError(mintError);
        return remoteTaskFailure(request, mintPublic.code, mintPublic.message, true);
      }
    }
    return remoteTaskFailure(request, publicError.code, publicError.message, true);
  }

  /** Conversation counterpart of {@link #recoverOrFailTask}. */
  async #recoverOrFailConversation(
    state: SessionCryptoState,
    request: RemoteControlConversationRequest,
    publicError: { code: string; message: string },
  ): Promise<unknown> {
    if (isRemoteControlSessionRecovery(publicError.code)) {
      try {
        return await this.#mintSessionReady(state);
      } catch (mintError) {
        const mintPublic = remoteControlPublicError(mintError);
        return remoteConversationFailure(request, mintPublic.code, mintPublic.message, true);
      }
    }
    return remoteConversationFailure(request, publicError.code, publicError.message, true);
  }

  async #mintSessionReady(state: SessionCryptoState): Promise<RemoteControlSessionReady> {
    // Nothing is using the previous one: either this process never issued it,
    // or the phone just proved it does not hold it.
    if (state.coreSessionToken) this.#core.closeSession(state.coreSessionToken);
    const minted = corePairingToken(this.#core.rotatePairing(this.#controllerUrl).pairingUrl);
    const ready = await this.#core.pair(minted);
    state.coreSessionToken = ready.sessionToken;
    return ready;
  }

  async #renewHostIfExpiringSoon(): Promise<void> {
    const renew = this.#transport.renewHost;
    if (!renew || !this.#hostExpiresAt) return;
    const expiresAt = Date.parse(this.#hostExpiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt - this.#now() > HOST_RENEW_WITHIN_MS) return;
    try {
      this.#hostExpiresAt = iso(
        await renew.call(this.#transport, this.#hostId, this.#hostSecret, HOST_TTL_SECONDS),
        'host expiresAt',
      );
      this.#persistRecord();
    } catch {
      // Best effort. A failed renewal must not take down a host that is still
      // valid today; the next poll tries again, and there are seven days of them.
    }
  }

  async #announceSessionReady(state: SessionCryptoState): Promise<void> {
    const ready = await this.#mintSessionReady(state);
    const envelope = await this.#preparePayload(state, ready);
    await this.#transport.sendEnvelope(
      this.#hostId,
      this.#hostSecret,
      state.row.sessionId,
      'state',
      envelope,
    );
    state.sendSequence = envelope.sequence;
    state.pendingSessionReadyAt = this.#now();
    this.#persistRecord();
  }

  async #handleDelivery(delivery: RemoteControlInternetReceivedEnvelope): Promise<void> {
    const envelope = parseRemoteControlRelayEnvelope(delivery.envelope);
    if (this.#locallyRevokedSessions.has(envelope.sessionId)) {
      // Never recreate keys or execute a queued command after local revoke,
      // even if the best-effort relay revoke failed. Advance locally and let
      // the bounded remote row expire if its cleanup ACK is also unavailable.
      this.#relayCursor = delivery.relaySequence;
      await this.#transport.acknowledge(
        this.#hostId,
        this.#hostSecret,
        envelope.sessionId,
        delivery.relaySequence,
      ).catch(() => undefined);
      return;
    }
    const state = this.#sessionCrypto.get(envelope.sessionId);
    if (!state || state.row.approvalState !== 'approved') {
      throw new RemoteControlError('SESSION_NOT_APPROVED', '승인되지 않은 연결의 요청을 거부했습니다.', 403);
    }
    const decision = acceptRemoteControlRelayEnvelope(envelope, state.receiveCursor, this.#now());
    if (!decision.ok) throw new RemoteControlError('RELAY_SEQUENCE_REJECTED', '원격 요청 순번이나 만료 상태가 올바르지 않습니다.', 409);
    let prepared = state.responsesByInboundMessageId.get(envelope.messageId);
    if (!prepared) {
      const plaintext = await decryptRemoteControlRelayEnvelope({
        key: state.receiveKey,
        envelope,
        now: this.#now(),
        expected: {
          sessionId: state.row.sessionId,
          controllerId: state.row.controllerId,
          sequence: state.receiveCursor.highestSequence + 1,
        },
      });
      const serialized = textDecoder.decode(plaintext);
      let decoded: unknown = null;
      try {
        decoded = JSON.parse(serialized);
      } catch {
        // The fixed public error below is shared with the v7 parser.
      }
      let request: RemoteControlClientMessage | null = null;
      let taskRequest: RemoteControlTaskRequest | null = null;
      let conversationRequest: RemoteControlConversationRequest | null = null;
      let terminalRequest: RemoteTerminalRequest | null = null;
      let response: unknown;
      let responseType: RemoteControlInternetRelayMessageType = 'state';
      if (decoded && typeof decoded === 'object' && (decoded as Record<string,unknown>).type === 'terminal.request') {
        try {terminalRequest=normalizeRemoteTerminalRequest(decoded);} catch {response={type:'error',code:'TERMINAL_REQUEST_INVALID',message:'터미널 요청 형식이 올바르지 않습니다.'};}
      } else if (decoded && typeof decoded === 'object'
        && !Array.isArray(decoded)
        && (decoded as Record<string, unknown>).type === 'tasks.request') {
        try {
          taskRequest = normalizeRemoteControlTaskRequest(decoded);
        } catch {
          response = {
            type: 'error',
            code: 'REMOTE_CONTROL_TASK_PROTOCOL_INVALID',
            message: '원격 에이전트 작업 요청 형식이 올바르지 않습니다.',
          };
        }
      } else if (decoded && typeof decoded === 'object'
        && !Array.isArray(decoded)
        && (decoded as Record<string, unknown>).type === 'conversations.request') {
        try {
          conversationRequest = normalizeRemoteControlConversationRequest(decoded);
        } catch {
          response = {
            type: 'error',
            code: 'REMOTE_CONTROL_CONVERSATION_PROTOCOL_INVALID',
            message: '원격 지속형 대화 요청 형식이 올바르지 않습니다.',
          };
        }
      } else {
        try {
          request = parseRemoteControlClientJson(serialized);
        } catch (error) {
          response = { type: 'error', ...remoteControlPublicError(error) };
        }
      }
      if (terminalRequest) {
        try {
          if(!state.coreSessionToken || !sameOpaqueSecret(terminalRequest.sessionToken,state.coreSessionToken)) {
            response=await this.#mintSessionReady(state);
          } else {
            if(!this.#terminalGateway) throw new Error('이 Mac은 AI 터미널을 지원하지 않습니다.');
            const bindings=await this.#core.taskTargetBindings(terminalRequest.sessionToken);
            const body=await this.#terminalGateway(terminalRequest.request,bindings,'internet:'+state.row.sessionId);
            response={type:'terminal.result',requestId:terminalRequest.request.requestId,ok:true,body};
          }
        } catch(error) {response={type:'terminal.result',requestId:terminalRequest.request.requestId,ok:false,error:error instanceof Error?error.message.slice(0,500):'터미널 요청 실패'};}
      } else if (taskRequest) {
        // Every exit from this block must produce a response. An escape answers
        // nothing and acks nothing, so the phone's operation never settles and
        // its later buttons are dead with no reason shown. The guard therefore
        // has to cover the mint path too: #mintSessionReady itself can raise
        // REMOTE_CONTROL_DISABLED from rotatePairing or SESSION_LIMIT from pair.
        try {
        if (!state.taskScopeGranted) {
          response = remoteTaskFailure(
            taskRequest,
            'REMOTE_CONTROL_TASK_SCOPE_REQUIRED',
            '이 연결에는 에이전트 작업 실행 권한이 없습니다. Mac 앱의 승인된 모바일 기기에서 Codex 작업 권한을 켜세요.',
            false,
          );
          responseType = 'task';
        } else if (!this.#taskGateway) {
          response = remoteTaskFailure(
            taskRequest,
            'REMOTE_CONTROL_TASK_UNAVAILABLE',
            '이 Mac의 에이전트 런타임을 준비하지 못했습니다.',
            true,
          );
          responseType = 'task';
        } else if (!state.coreSessionToken
          || !sameOpaqueSecret(taskRequest.sessionToken, state.coreSessionToken)) {
          // The Mac restarted and minted a new core bearer. Do not execute the
          // task against a stale token; refresh the session first so a retry
          // preserves the requestId and cannot become duplicate work.
          response = await this.#mintSessionReady(state);
          responseType = 'state';
        } else {
          const bindings = await this.#core.taskTargetBindings(taskRequest.sessionToken);
          response = await this.#taskGateway.perform(taskRequest, bindings);
          responseType = 'task';
        }
        } catch (error) {
          const publicError = remoteControlPublicError(error);
          // The pre-check above compares the phone's token against this agent's
          // own memory, not the core's live session set, so an idle-expired
          // session passes it and only fails here. Answering that with a task
          // error would repeat forever: the controller never drops a token on
          // its own. Hand it a live session instead, exactly as the
          // action.request path below does.
          response = await this.#recoverOrFailTask(state, taskRequest, publicError);
          responseType = isRemoteControlSessionRecovery(publicError.code) ? 'state' : 'task';
        }
      }
      if (conversationRequest) {
        // Same all-exits-answer contract as the task branch above.
        try {
        if (!state.conversationScopeGranted) {
          response = remoteConversationFailure(
            conversationRequest,
            'REMOTE_CONTROL_CONVERSATION_SCOPE_REQUIRED',
            '이 연결에는 지속형 대화 및 기록 열람 권한이 없습니다. Mac에서 별도로 권한을 켜세요.',
            false,
          );
          responseType = 'conversation';
        } else if (!this.#conversationGateway) {
          response = remoteConversationFailure(
            conversationRequest,
            'REMOTE_CONTROL_CONVERSATION_UNAVAILABLE',
            '이 Mac의 지속형 대화 런타임을 준비하지 못했습니다.',
            true,
          );
          responseType = 'conversation';
        } else if (!state.coreSessionToken
          || !sameOpaqueSecret(conversationRequest.sessionToken, state.coreSessionToken)) {
          response = await this.#mintSessionReady(state);
          responseType = 'state';
        } else {
          const bindings = await this.#core.taskTargetBindings(conversationRequest.sessionToken);
          response = await this.#conversationGateway.perform(conversationRequest, bindings);
          responseType = 'conversation';
        }
        } catch (error) {
          const publicError = remoteControlPublicError(error);
          response = await this.#recoverOrFailConversation(state, conversationRequest, publicError);
          responseType = isRemoteControlSessionRecovery(publicError.code) ? 'state' : 'conversation';
        }
      }
      if (request) {
        try {
          if (request.type === 'controller.pair') {
            // The core's pairing token is single-use, which is right on the LAN
            // — one QR, one socket. Over the relay it meant only the FIRST
            // device could ever pair: every controller presents the same secret
            // from the same QR, and the core consumed it on the first one.
            // Here the per-device gate is not the token but the Mac's SAS
            // approval of THIS relay session, which already happened. So verify
            // the shared QR secret, then mint a fresh core pairing to consume.
            if (!this.#isActivePairingSecret(request.token)) {
              throw new RemoteControlError('INVALID_PAIRING', 'QR 연결 정보가 올바르지 않습니다.', 401);
            }
            const minted = corePairingToken(this.#core.rotatePairing(this.#controllerUrl).pairingUrl);
            const ready = await this.#core.pair(minted);
            // Remember which core session this device owns so a later revoke
            // can disconnect it alone.
            state.coreSessionToken = ready.sessionToken;
            response = ready;
          } else {
            if (request.type === 'session.restore') {
              response = await this.#core.restore(request.sessionToken);
            } else {
              response = await this.#core.perform(request);
              responseType = 'result';
            }
          }
        } catch (error) {
          const publicError = remoteControlPublicError(error);
          // The phone arrived with a token this process never issued — its Mac
          // restarted between the two messages. Give it a live one instead of an
          // error it cannot act on: the controller never drops a token on its
          // own, so an error here would leave it stuck forever.
          // Not gated on whether we already pushed one: a request carrying a
          // token the core rejects IS the proof that the phone never received
          // it — the pushed envelope can expire unread while the phone sleeps.
          if (request.type === 'action.request'
            && (publicError.code === 'INVALID_SESSION_TOKEN' || publicError.code === 'SESSION_EXPIRED')) {
            response = await this.#mintSessionReady(state);
            responseType = 'state';
          } else {
            response = request.type === 'action.request'
              ? {
                  type: 'action.result',
                  actionId: request.actionId,
                  ok: false,
                  error: { code: publicError.code, message: publicError.message },
                }
              : { type: 'error', code: publicError.code, message: publicError.message };
            responseType = request.type === 'action.request' ? 'result' : 'state';
          }
        }
      }
      prepared = {
        messageType: responseType,
        envelope: await this.#preparePayload(state, response),
      };
      state.responsesByInboundMessageId.set(envelope.messageId, prepared);
      while (state.responsesByInboundMessageId.size > 128) {
        const oldest = state.responsesByInboundMessageId.keys().next().value;
        if (typeof oldest !== 'string') break;
        state.responsesByInboundMessageId.delete(oldest);
      }
    }
    await this.#transport.sendEnvelope(
      this.#hostId,
      this.#hostSecret,
      state.row.sessionId,
      prepared.messageType,
      prepared.envelope,
    );
    state.sendSequence = prepared.envelope.sequence;
    // Once the exact encrypted response is durably accepted by the relay, do
    // not execute the request again merely because the cleanup ACK is lost.
    state.receiveCursor = decision.cursor;
    // Hearing from the controller is the only proof it took the token we pushed.
    state.pendingSessionReadyAt = null;
    this.#relayCursor = delivery.relaySequence;
    this.#persistRecord();
    state.responsesByInboundMessageId.delete(envelope.messageId);
    await this.#transport.acknowledge(
      this.#hostId,
      this.#hostSecret,
      state.row.sessionId,
      delivery.relaySequence,
    );
  }

  async #preparePayload(
    state: SessionCryptoState,
    payload: unknown,
  ): Promise<RemoteControlRelayEnvelope> {
    const nextSequence = state.sendSequence + 1;
    return encryptRemoteControlRelayEnvelope({
      key: state.sendKey,
      metadata: {
        schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
        messageId: this.#randomUuid(),
        sessionId: state.row.sessionId,
        controllerId: state.row.controllerId,
        sequence: nextSequence,
        expiresAt: minExpiry(this.#now(), state.row.expiresAt),
      },
      plaintext: textEncoder.encode(JSON.stringify(payload)),
      now: this.#now(),
    });
  }

  #schedule(delay: number): void {
    if (this.#timer) this.#clearTimer(this.#timer);
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      void this.pollNow().catch(() => undefined);
    }, delay);
  }
}

export async function createRemoteControlInternetAgent(
  options: CreateRemoteControlInternetAgentOptions,
): Promise<{ agent: RemoteControlInternetAgent; pairing: RemoteControlInternetPairingIssue }> {
  const agent = new RemoteControlInternetAgent(options);
  const pairing = await agent.initialize();
  return { agent, pairing };
}

export const REMOTE_CONTROL_INTERNET_INNER_PROTOCOL_VERSION = REMOTE_CONTROL_PROTOCOL_VERSION;
