import type {MobileWorkspaceRequest,MobileWorkspaceResult} from './mobileWorkspaceProtocol';
import {normalizeRemoteTerminalResult,type RemoteTerminalResult} from './remoteControlTerminalProtocol';
import type {AiTerminalRequest,AiTerminalResponse} from './aiTerminalProtocol';
import type {
  RemoteControlAction,
  RemoteControlActionResult,
  RemoteControlSessionReady,
} from './remoteControlCore';
import {
  REMOTE_CONTROL_PROTOCOL_VERSION,
  normalizeRemoteControlSupportedFeatures,
  type RemoteControlSupportedFeature,
} from './remoteControlProtocol';
import {
  REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
  acceptRemoteControlRelayEnvelope,
  createRemoteControlRelayReceiveCursor,
  isRemoteControlRelayPairingExpired,
  normalizeRemoteControlRelayId,
  parseRemoteControlRelayEnvelope,
  parseRemoteControlRelayPairingUrl,
  type RemoteControlRelayEnvelope,
  type RemoteControlRelayPairingBootstrap,
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
  isRemoteControlRelaySessionKey,
} from './remoteControlRelayCrypto';
import {
  normalizeQrRemoteControlProjectCards,
  normalizeQrRemoteControlWorkspaceRoots,
  type QrRemoteControlProjectCard,
  type QrRemoteControlWorkspaceRoot,
} from './qrRemoteControlContract';
import type {
  RemoteControlRelayClaimResult,
  RemoteControlRelayControllerRpcClient,
  RemoteControlRelayControllerSessionStatus,
} from './remoteControlRelayRpcClient';
import { remoteControlRelaySasCode } from './remoteControlRelaySas';
import {
  assertRemoteControlTaskResultMatchesRequest,
  normalizeRemoteControlTaskRequest,
  normalizeRemoteControlTaskResult,
  REMOTE_CONTROL_TASK_SCOPE,
  REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
  type RemoteControlTaskOperation,
  type RemoteControlTaskRequest,
  type RemoteControlTaskRequestPayloadByOperation,
  type RemoteControlTaskResult,
} from './remoteControlTaskProtocol';
import { AGENT_RUNTIME_PROTOCOL_VERSION } from './agentRuntimeProtocol';
import {
  assertRemoteControlConversationResultMatchesRequest,
  normalizeRemoteControlConversationRequest,
  normalizeRemoteControlConversationResult,
  REMOTE_CONTROL_CONVERSATION_SCOPE,
  type RemoteControlConversationOperation,
  type RemoteControlConversationRequest,
  type RemoteControlConversationRequestPayloadByOperation,
  type RemoteControlConversationResult,
} from './remoteControlConversationProtocol';
import { AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION } from './agentRuntimeConversationProtocol';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MESSAGE_TTL_MS = 10 * 60_000;
/**
 * A request whose envelope has expired on the relay can never be answered —
 * the host's receive RPC filters on `envelope_expires_at`. Give up one minute
 * after that so the controller reports a timeout instead of staying busy
 * forever with no message.
 */
const REMOTE_CONTROL_PENDING_ACTION_TIMEOUT_MS = MESSAGE_TTL_MS + 60_000;

export type RemoteControlRelayControllerState =
  | 'idle'
  | 'claiming'
  | 'approval-required'
  | 'connecting'
  | 'online'
  | 'closed'
  | 'error';

/**
 * A host accepted the encrypted session but rejected one concrete request.
 * Keep the bounded machine code beside the human message so the portal can
 * distinguish an old host from a missing scope or a local runtime failure.
 */
export class RemoteControlRelayRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RemoteControlRelayRequestError';
  }
}

export const REMOTE_CONTROL_HOST_UPDATE_REQUIRED = 'REMOTE_CONTROL_HOST_UPDATE_REQUIRED' as const;

export interface RemoteControlRelayControllerStatus {
  state: RemoteControlRelayControllerState;
  hostName: string | null;
  sasCode: string | null;
  controllerKeyFingerprint: string | null;
  expiresAt: string | null;
  projects: QrRemoteControlProjectCard[];
  workspaceRoots: QrRemoteControlWorkspaceRoot[];
  projectCount: number;
  nextPage: number | null;
  /** Null until probed; empty means an authenticated legacy/base-v7 host. */
  supportedFeatures: RemoteControlSupportedFeature[] | null;
  busy: boolean;
  error: string | null;
  /**
   * When the Mac last spoke to the relay, as the relay saw it. Null means the
   * question could not be answered — an older sidecar, or no status read yet —
   * and must never be shown or treated as "asleep".
   */
  hostLastSeenAt: string | null;
}

export const REMOTE_CONTROL_RELAY_CONTROLLER_SNAPSHOT_VERSION = 1 as const;

export interface RemoteControlRelayControllerSnapshot {
  schemaVersion: typeof REMOTE_CONTROL_RELAY_CONTROLLER_SNAPSHOT_VERSION;
  pairingUrl: string;
  claim: RemoteControlRelayClaimResult;
  sendKey: CryptoKey;
  receiveKey: CryptoKey;
  sendSequence: number;
  pairRequestSent: boolean;
  pendingOutbound: RemoteControlRelayEnvelope | null;
  pendingActionId: string | null;
  /** Optional additive marker so a reload can recognize a legacy-host probe refusal. */
  pendingCapabilityProbeActionId?: string | null;
  /** Optional so older sealed sessions restore with one bounded grace window. */
  pendingActionSentAt?: number;
  /** Optional so pre-v8 sealed controller sessions remain restorable. */
  pendingTaskOperationId?: string | null;
  pendingTaskSentAt?: number;
  /** Optional additive field; old sealed sessions have no conversation request. */
  pendingConversationOperationId?: string | null;
  pendingConversationSentAt?: number;
  receiveCursor: RemoteControlRelayReceiveCursor;
  relayCursor: string;
  sessionToken: string;
  hostName: string;
  /** Optional so snapshots sealed before capability probing remain restorable. */
  supportedFeatures?: RemoteControlSupportedFeature[];
  sasCode: string;
  controllerKeyFingerprint: string;
}

export interface RemoteControlRelayControllerTransport {
  claimPairing(input: {
    pairingId: string;
    pairingSecret: string;
    controllerName: string;
    controllerPublicKey: string;
  }): Promise<RemoteControlRelayClaimResult>;
  status(hostId: string, sessionId: string): Promise<RemoteControlRelayControllerSessionStatus>;
  sendEnvelope(hostId: string, sessionId: string, envelope: RemoteControlRelayEnvelope): Promise<void>;
  receiveEnvelopes(hostId: string, sessionId: string, afterRelaySequence: string): Promise<Array<{
    relaySequence: string;
    envelope: RemoteControlRelayEnvelope;
  }>>;
  acknowledge(hostId: string, sessionId: string, throughRelaySequence: string): Promise<void>;
  revoke(hostId: string, sessionId: string): Promise<void>;
}

export interface RemoteControlRelayControllerOptions {
  transport: RemoteControlRelayControllerTransport | RemoteControlRelayControllerRpcClient;
  pairingUrl?: string;
  restoredSession?: unknown;
  controllerName: string;
  now?: () => number;
  randomUuid?: () => string;
  onClaimed?: () => void | Promise<void>;
  onSessionChanged?: (snapshot: RemoteControlRelayControllerSnapshot | null) => void | Promise<void>;
  /** Injected so tests can wait for a late host reply without real delay. */
  sleep?: (ms: number) => Promise<void>;
}

type ParsedRemoteControlSessionReady = Omit<RemoteControlSessionReady, 'type'> & {
  type: 'session.ready';
};

type ServerMessage = ParsedRemoteControlSessionReady | RemoteControlActionResult
  | RemoteControlTaskResult | RemoteControlConversationResult | RemoteTerminalResult | {
  type: 'error';
  code: string;
  message: string;
};

function exactObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('REMOTE_CONTROL_RESPONSE_INVALID');
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('REMOTE_CONTROL_RESPONSE_INVALID');
  return value;
}

function iso(value: unknown): string {
  const raw = boundedString(value, 64);
  if (!Number.isFinite(Date.parse(raw))) throw new Error('REMOTE_CONTROL_RESPONSE_INVALID');
  return new Date(Date.parse(raw)).toISOString();
}

/**
 * Repository-relative paths attached to a refusal (e.g. the uncommitted files
 * blocking a worktree). Bounded in both count and length: this is display text
 * from the host, and an unbounded list would be a way to push arbitrary data
 * into the phone through an error field.
 */
function boundedPathList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('REMOTE_CONTROL_RESPONSE_INVALID');
  return value.map(entry => boundedString(entry, 240));
}

function boundedSupportedFeatures(value: unknown): RemoteControlSupportedFeature[] {
  try {
    return normalizeRemoteControlSupportedFeatures(value);
  } catch {
    throw new Error('REMOTE_CONTROL_RESPONSE_INVALID');
  }
}

function parseServerMessage(value: unknown): ServerMessage {
  const raw = exactObject(value);
  if (raw.type === 'terminal.result') return normalizeRemoteTerminalResult(raw);
  if (raw.type === 'tasks.result') return normalizeRemoteControlTaskResult(raw);
  if (raw.type === 'conversations.result') return normalizeRemoteControlConversationResult(raw);
  // `session.restored` answers a reconnect that resumed an existing session
  // (remoteControlCore.restore). It carries the same fields as `session.ready`;
  // handling only the latter meant every successful resume fell through to the
  // final throw and surfaced as a connection failure.
  if (raw.type === 'session.ready' || raw.type === 'session.restored') {
    const requiredKeys = ['type', 'protocolVersion', 'sessionToken', 'hostName', 'expiresAt', 'idleExpiresAt', 'projects', 'projectCount', 'nextPage'];
    if (Object.keys(raw).length !== requiredKeys.length
      || requiredKeys.some(key => !Object.prototype.hasOwnProperty.call(raw, key))
      || raw.protocolVersion !== REMOTE_CONTROL_PROTOCOL_VERSION) throw new Error('REMOTE_CONTROL_RESPONSE_INVALID');
    const sessionToken = boundedString(raw.sessionToken, 43);
    if (!/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) throw new Error('REMOTE_CONTROL_RESPONSE_INVALID');
    const projectCount = raw.projectCount;
    const nextPage = raw.nextPage;
    if (typeof projectCount !== 'number' || !Number.isInteger(projectCount) || projectCount < 0 || projectCount > 500
      || (nextPage !== null && (typeof nextPage !== 'number' || !Number.isInteger(nextPage) || nextPage < 1 || nextPage > 99))) {
      throw new Error('REMOTE_CONTROL_RESPONSE_INVALID');
    }
    return {
      type: 'session.ready',
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      sessionToken,
      hostName: boundedString(raw.hostName, 80),
      expiresAt: iso(raw.expiresAt),
      idleExpiresAt: iso(raw.idleExpiresAt),
      projects: normalizeQrRemoteControlProjectCards({ projects: raw.projects }),
      projectCount,
      nextPage,
    };
  }
  if (raw.type === 'action.result') {
    const actionId = boundedString(raw.actionId, 100);
    if (typeof raw.ok !== 'boolean') throw new Error('REMOTE_CONTROL_RESPONSE_INVALID');
    if (raw.ok) {
      const hasProjects = Object.prototype.hasOwnProperty.call(raw, 'projects');
      const hasProject = Object.prototype.hasOwnProperty.call(raw, 'project');
      const hasWorkspaceRoots = Object.prototype.hasOwnProperty.call(raw, 'workspaceRoots');
      const hasSupportedFeatures = Object.prototype.hasOwnProperty.call(raw, 'supportedFeatures');
      if ([hasProjects, hasProject, hasWorkspaceRoots, hasSupportedFeatures].filter(Boolean).length !== 1
        || Object.keys(raw).some(key => !['type', 'actionId', 'ok', 'projects', 'project', 'workspaceRoots', 'supportedFeatures', 'page', 'projectCount', 'nextPage'].includes(key))) {
        throw new Error('REMOTE_CONTROL_RESPONSE_INVALID');
      }
      if (hasProjects) {
        if (Object.keys(raw).length !== 7) throw new Error('REMOTE_CONTROL_RESPONSE_INVALID');
        const page = raw.page;
        const projectCount = raw.projectCount;
        const nextPage = raw.nextPage;
        if (typeof page !== 'number' || !Number.isInteger(page) || page < 0 || page > 99
          || typeof projectCount !== 'number' || !Number.isInteger(projectCount) || projectCount < 0 || projectCount > 500
          || (nextPage !== null && (typeof nextPage !== 'number' || !Number.isInteger(nextPage) || nextPage <= page || nextPage > 99))) {
          throw new Error('REMOTE_CONTROL_RESPONSE_INVALID');
        }
        return {
          type: 'action.result', actionId, ok: true,
          projects: normalizeQrRemoteControlProjectCards({ projects: raw.projects }),
          page, projectCount, nextPage,
        };
      }
      if (hasWorkspaceRoots) {
        if (Object.keys(raw).length !== 4) throw new Error('REMOTE_CONTROL_RESPONSE_INVALID');
        return {
          type: 'action.result', actionId, ok: true,
          workspaceRoots: normalizeQrRemoteControlWorkspaceRoots({ workspaceRoots: raw.workspaceRoots }),
        };
      }
      if (hasSupportedFeatures) {
        if (Object.keys(raw).length !== 4) throw new Error('REMOTE_CONTROL_RESPONSE_INVALID');
        return {
          type: 'action.result', actionId, ok: true,
          supportedFeatures: boundedSupportedFeatures(raw.supportedFeatures),
        };
      }
      if (Object.keys(raw).length !== 4) throw new Error('REMOTE_CONTROL_RESPONSE_INVALID');
      if (raw.project === null) return { type: 'action.result', actionId, ok: true, project: null };
      const projects = normalizeQrRemoteControlProjectCards({ projects: [raw.project] });
      return { type: 'action.result', actionId, ok: true, project: projects[0] ?? null };
    }
    const error = exactObject(raw.error);
    // `changedPaths` is optional: the host attaches it to WORKTREE_SOURCE_DIRTY
    // so the phone can name the files that block the worktree. Requiring exactly
    // {code, message} rejected that improved refusal as an invalid response, and
    // the parse throws before the payload is read — so the very explanation this
    // field carries was replaced by "check your internet".
    const errorKeys = Object.keys(error);
    if (Object.keys(raw).length !== 4
      || errorKeys.length < 2
      || errorKeys.length > 3
      || errorKeys.some(key => !['code', 'message', 'changedPaths'].includes(key))
      || !Object.prototype.hasOwnProperty.call(error, 'code')
      || !Object.prototype.hasOwnProperty.call(error, 'message')
      || Object.keys(raw).some(key => !['type', 'actionId', 'ok', 'error'].includes(key))) {
      throw new Error('REMOTE_CONTROL_RESPONSE_INVALID');
    }
    const changedPaths = Object.prototype.hasOwnProperty.call(error, 'changedPaths')
      ? boundedPathList(error.changedPaths)
      : undefined;
    return {
      type: 'action.result', actionId, ok: false,
      error: {
        code: boundedString(error.code, 80),
        message: boundedString(error.message, 240),
        ...(changedPaths ? { changedPaths } : {}),
      },
    };
  }
  if (raw.type === 'error') {
    if (Object.keys(raw).length !== 3) throw new Error('REMOTE_CONTROL_RESPONSE_INVALID');
    return { type: 'error', code: boundedString(raw.code, 80), message: boundedString(raw.message, 240) };
  }
  throw new Error('REMOTE_CONTROL_RESPONSE_INVALID');
}

function safeError(error: unknown): string {
  if (error && typeof error === 'object') {
    const value = error as { message?: unknown; code?: unknown };
    if (typeof value.message === 'string' && /^REMOTE_CONTROL_[A-Z0-9_]+$/.test(value.message)) return value.message;
    if (typeof value.code === 'string' && /^REMOTE_CONTROL_[A-Z0-9_]+$/.test(value.code)) return value.code;
  }
  return '외부 원격제어 연결을 처리하지 못했습니다.';
}

function relayErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const value = error as { code?: unknown; message?: unknown };
  if (typeof value.code === 'string' && /^(?:REMOTE_CONTROL|RELAY)_[A-Z0-9_]+$/.test(value.code)) return value.code;
  if (typeof value.message === 'string' && /^(?:REMOTE_CONTROL|RELAY)_[A-Z0-9_]+$/.test(value.message)) return value.message;
  return '';
}

function isAmbiguousClaimFailure(error: unknown): boolean {
  return new Set([
    'RELAY_CONNECTION_FAILED',
    'RELAY_REQUEST_FAILED',
    'RELAY_RESPONSE_INVALID',
  ]).has(relayErrorCode(error));
}

function isTerminalRelaySessionFailure(error: unknown): boolean {
  return new Set([
    'REMOTE_CONTROL_SESSION_ACCESS_DENIED',
    'REMOTE_CONTROL_SESSION_UNAVAILABLE',
    'REMOTE_CONTROL_SESSION_NOT_FOUND',
    'REMOTE_CONTROL_SESSION_REVOKED',
    'REMOTE_CONTROL_HOST_UNAVAILABLE',
    'REMOTE_CONTROL_HOST_DISABLED',
    'REMOTE_CONTROL_RELAY_EXPIRED',
  ]).has(relayErrorCode(error));
}

function minExpiry(now: number, expiresAt: string): string {
  return new Date(Math.min(now + MESSAGE_TTL_MS, Date.parse(expiresAt))).toISOString();
}

function restoredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value || value.length > maxLength) {
    throw new Error(`REMOTE_CONTROL_RESTORE_${field.toUpperCase()}_INVALID`);
  }
  return value;
}

function restoredDate(value: unknown): string {
  const raw = restoredString(value, 'expiry', 64);
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) throw new Error('REMOTE_CONTROL_RESTORE_EXPIRY_INVALID');
  return new Date(timestamp).toISOString();
}

function restoredPendingSentAt(value: unknown, pending: boolean, now: number): number {
  if (!pending) {
    if (value !== undefined && value !== 0) throw new Error('REMOTE_CONTROL_RESTORE_INVALID');
    return 0;
  }
  // Old snapshots did not carry the timestamp. Give those one grace window;
  // once persisted again, every later reload retains this same origin.
  if (value === undefined) return now;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error('REMOTE_CONTROL_RESTORE_INVALID');
  }
  // A wall-clock correction must not turn a pending request into an unbounded
  // lock. Clamping a future timestamp to now preserves one finite window.
  return Math.min(value as number, now);
}

function parseRestoredSession(value: unknown, now: number): RemoteControlRelayControllerSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('REMOTE_CONTROL_RESTORE_INVALID');
  }
  const raw = value as Record<string, unknown>;
  const requiredKeys = [
    'schemaVersion', 'pairingUrl', 'claim', 'sendKey', 'receiveKey', 'sendSequence', 'pairRequestSent',
    'pendingOutbound', 'pendingActionId', 'receiveCursor', 'relayCursor', 'sessionToken',
    'hostName', 'sasCode', 'controllerKeyFingerprint',
  ];
  const allowedKeys = new Set([
    ...requiredKeys,
    'pendingActionSentAt',
    'pendingCapabilityProbeActionId',
    'pendingTaskOperationId',
    'pendingTaskSentAt',
    'pendingConversationOperationId',
    'pendingConversationSentAt',
    'supportedFeatures',
  ]);
  if (Object.keys(raw).some(key => !allowedKeys.has(key))
    || requiredKeys.some(key => !Object.prototype.hasOwnProperty.call(raw, key))
    || raw.schemaVersion !== REMOTE_CONTROL_RELAY_CONTROLLER_SNAPSHOT_VERSION
    || !isRemoteControlRelaySessionKey(raw.sendKey, 'encrypt')
    || !isRemoteControlRelaySessionKey(raw.receiveKey, 'decrypt')) {
    throw new Error('REMOTE_CONTROL_RESTORE_INVALID');
  }
  const parsedPairing = parseRemoteControlRelayPairingUrl(restoredString(raw.pairingUrl, 'pairing', 4_096));
  const claimRaw = exactObject(raw.claim);
  const claim: RemoteControlRelayClaimResult = {
    sessionId: normalizeRemoteControlRelayId(claimRaw.sessionId, 'sessionId'),
    controllerId: normalizeRemoteControlRelayId(claimRaw.controllerId, 'controllerId'),
    hostId: normalizeRemoteControlRelayId(claimRaw.hostId, 'hostId'),
    hostName: restoredString(claimRaw.hostName, 'host_name', 80),
    hostPublicKey: restoredString(claimRaw.hostPublicKey, 'host_key', 87),
    hostPublicKeyFingerprint: restoredString(claimRaw.hostPublicKeyFingerprint, 'host_fingerprint', 43),
    approvalState: claimRaw.approvalState === 'pending' ? 'pending' : (() => { throw new Error('REMOTE_CONTROL_RESTORE_INVALID'); })(),
    expiresAt: restoredDate(claimRaw.expiresAt),
  };
  if (Object.keys(claimRaw).length !== 8
    || claim.hostId !== parsedPairing.bootstrap.hostId
    || claim.hostPublicKey !== parsedPairing.bootstrap.hostPublicKey
    || !/^[A-Za-z0-9_-]{87}$/.test(claim.hostPublicKey)
    || !/^[A-Za-z0-9_-]{43}$/.test(claim.hostPublicKeyFingerprint)
    || Date.parse(claim.expiresAt) <= now) {
    throw new Error('REMOTE_CONTROL_RESTORE_INVALID');
  }
  const cursorRaw = exactObject(raw.receiveCursor);
  const cursorKeys = ['sessionId', 'controllerId', 'highestSequence', 'recentMessageIds'];
  if (Object.keys(cursorRaw).length !== cursorKeys.length
    || cursorKeys.some(key => !Object.prototype.hasOwnProperty.call(cursorRaw, key))
    || !Number.isSafeInteger(cursorRaw.highestSequence)
    || (cursorRaw.highestSequence as number) < 0
    || !Array.isArray(cursorRaw.recentMessageIds)
    || cursorRaw.recentMessageIds.length > 256) {
    throw new Error('REMOTE_CONTROL_RESTORE_INVALID');
  }
  const recentMessageIds = cursorRaw.recentMessageIds.map(messageId => (
    normalizeRemoteControlRelayId(messageId, 'messageId')
  ));
  if (new Set(recentMessageIds).size !== recentMessageIds.length) {
    throw new Error('REMOTE_CONTROL_RESTORE_INVALID');
  }
  const receiveCursor: RemoteControlRelayReceiveCursor = {
    sessionId: normalizeRemoteControlRelayId(cursorRaw.sessionId, 'sessionId'),
    controllerId: normalizeRemoteControlRelayId(cursorRaw.controllerId, 'controllerId'),
    highestSequence: cursorRaw.highestSequence as number,
    recentMessageIds,
  };
  if (receiveCursor.sessionId !== claim.sessionId || receiveCursor.controllerId !== claim.controllerId) {
    throw new Error('REMOTE_CONTROL_RESTORE_INVALID');
  }
  if (!Number.isSafeInteger(raw.sendSequence) || (raw.sendSequence as number) < 0) {
    throw new Error('REMOTE_CONTROL_RESTORE_INVALID');
  }
  if (typeof raw.pairRequestSent !== 'boolean') throw new Error('REMOTE_CONTROL_RESTORE_INVALID');
  const pendingOutbound = raw.pendingOutbound === null ? null : parseRemoteControlRelayEnvelope(raw.pendingOutbound);
  if (pendingOutbound && (pendingOutbound.sessionId !== claim.sessionId
    || pendingOutbound.controllerId !== claim.controllerId
    || pendingOutbound.sequence !== (raw.sendSequence as number) + 1)) {
    throw new Error('REMOTE_CONTROL_RESTORE_INVALID');
  }
  const pendingActionId = raw.pendingActionId === null
    ? null
    : normalizeRemoteControlRelayId(raw.pendingActionId, 'actionId');
  const pendingCapabilityProbeActionId = raw.pendingCapabilityProbeActionId === undefined
    || raw.pendingCapabilityProbeActionId === null
    ? null
    : normalizeRemoteControlRelayId(raw.pendingCapabilityProbeActionId, 'actionId');
  if (pendingCapabilityProbeActionId !== null
    && pendingCapabilityProbeActionId !== pendingActionId) {
    throw new Error('REMOTE_CONTROL_RESTORE_INVALID');
  }
  const pendingTaskOperationId = raw.pendingTaskOperationId === undefined
    || raw.pendingTaskOperationId === null
    ? null
    : normalizeRemoteControlRelayId(raw.pendingTaskOperationId, 'operationId');
  const pendingConversationOperationId = raw.pendingConversationOperationId === undefined
    || raw.pendingConversationOperationId === null
    ? null
    : normalizeRemoteControlRelayId(raw.pendingConversationOperationId, 'operationId');
  if ([pendingActionId, pendingTaskOperationId, pendingConversationOperationId]
    .filter(value => value !== null).length > 1) {
    throw new Error('REMOTE_CONTROL_RESTORE_INVALID');
  }
  const pendingActionSentAt = restoredPendingSentAt(raw.pendingActionSentAt, pendingActionId !== null, now);
  const pendingTaskSentAt = restoredPendingSentAt(raw.pendingTaskSentAt, pendingTaskOperationId !== null, now);
  const pendingConversationSentAt = restoredPendingSentAt(
    raw.pendingConversationSentAt,
    pendingConversationOperationId !== null,
    now,
  );
  const relayCursor = restoredString(raw.relayCursor, 'relay_cursor', 19);
  if (!/^(?:0|[1-9][0-9]{0,18})$/.test(relayCursor)) throw new Error('REMOTE_CONTROL_RESTORE_INVALID');
  const sessionToken = raw.sessionToken === '' ? '' : restoredString(raw.sessionToken, 'session_token', 43);
  if (sessionToken && !/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) throw new Error('REMOTE_CONTROL_RESTORE_INVALID');
  const sasCode = restoredString(raw.sasCode, 'sas', 6);
  const controllerKeyFingerprint = restoredString(raw.controllerKeyFingerprint, 'controller_fingerprint', 43);
  const supportedFeatures = raw.supportedFeatures === undefined
    ? undefined
    : (() => {
        try {
          return normalizeRemoteControlSupportedFeatures(raw.supportedFeatures);
        } catch {
          throw new Error('REMOTE_CONTROL_RESTORE_INVALID');
        }
      })();
  if (!/^\d{6}$/.test(sasCode) || !/^[A-Za-z0-9_-]{43}$/.test(controllerKeyFingerprint)) {
    throw new Error('REMOTE_CONTROL_RESTORE_INVALID');
  }
  return {
    schemaVersion: REMOTE_CONTROL_RELAY_CONTROLLER_SNAPSHOT_VERSION,
    pairingUrl: restoredString(raw.pairingUrl, 'pairing', 4_096),
    claim,
    sendKey: raw.sendKey,
    receiveKey: raw.receiveKey,
    sendSequence: raw.sendSequence as number,
    pairRequestSent: raw.pairRequestSent,
    pendingOutbound,
    pendingActionId,
    pendingActionSentAt,
    ...(pendingCapabilityProbeActionId ? { pendingCapabilityProbeActionId } : {}),
    pendingTaskOperationId,
    pendingTaskSentAt,
    pendingConversationOperationId,
    pendingConversationSentAt,
    receiveCursor,
    relayCursor,
    sessionToken,
    hostName: restoredString(raw.hostName, 'host_name', 80),
    ...(supportedFeatures ? { supportedFeatures } : {}),
    sasCode,
    controllerKeyFingerprint,
  };
}

export class RemoteControlRelayController {
  readonly #transport: RemoteControlRelayControllerTransport;
  readonly #bootstrap: RemoteControlRelayPairingBootstrap;
  readonly #controllerName: string;
  readonly #now: () => number;
  readonly #randomUuid: () => string;
  readonly #onClaimed?: () => void | Promise<void>;
  readonly #onSessionChanged?: (snapshot: RemoteControlRelayControllerSnapshot | null) => void | Promise<void>;
  readonly #pairingUrl: string;
  #state: RemoteControlRelayControllerState = 'idle';
  #claim: RemoteControlRelayClaimResult | null = null;
  #keyPair: CryptoKeyPair | null = null;
  #sendKey: CryptoKey | null = null;
  #receiveKey: CryptoKey | null = null;
  #sendSequence = 0;
  #pairRequestSent = false;
  #pendingOutbound: RemoteControlRelayEnvelope | null = null;
  #completedActionResult: RemoteControlActionResult | undefined;
  #resultForAction(actionId:string):RemoteControlActionResult|undefined { return this.#completedActionResult?.actionId===actionId?this.#completedActionResult:undefined; }
  #pendingActionId: string | null = null;
  #pendingCapabilityProbeActionId: string | null = null;
  #pendingActionSentAt = 0;
  #terminalResult: RemoteTerminalResult | null = null;
  #terminalRequestId: string | null = null;
  #pendingTaskOperationId: string | null = null;
  #pendingTaskRequest: RemoteControlTaskRequest | null = null;
  #pendingTaskResult: RemoteControlTaskResult | null = null;
  #pendingTaskSentAt = 0;
  #pendingConversationOperationId: string | null = null;
  #pendingConversationRequest: RemoteControlConversationRequest | null = null;
  #pendingConversationResult: RemoteControlConversationResult | null = null;
  #pendingConversationSentAt = 0;
  #receiveCursor: RemoteControlRelayReceiveCursor | null = null;
  #relayCursor = '0';
  #sessionToken = '';
  #hostName: string | null = null;
  #supportedFeatures: RemoteControlSupportedFeature[] | null = null;
  #sasCode: string | null = null;
  #controllerKeyFingerprint: string | null = null;
  #projects: QrRemoteControlProjectCard[] = [];
  #workspaceRoots: QrRemoteControlWorkspaceRoot[] = [];
  #projectCount = 0;
  #nextPage: number | null = null;
  #busy = false;
  #error: string | null = null;
  #requestErrorCode: string | null = null;
  #hostLastSeenAt: string | null = null;
  #sleep: (ms: number) => Promise<void>;

  constructor(options: RemoteControlRelayControllerOptions) {
    this.#transport = options.transport;
    this.#controllerName = options.controllerName.trim();
    if (!this.#controllerName || this.#controllerName.length > 80) throw new Error('REMOTE_CONTROL_CONTROLLER_NAME_INVALID');
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.#randomUuid = options.randomUuid ?? (() => globalThis.crypto.randomUUID());
    this.#onClaimed = options.onClaimed;
    this.#onSessionChanged = options.onSessionChanged;
    if ((options.pairingUrl ? 1 : 0) + (options.restoredSession ? 1 : 0) !== 1) {
      throw new Error('REMOTE_CONTROL_CONTROLLER_SOURCE_INVALID');
    }
    if (options.restoredSession) {
      const restored = parseRestoredSession(options.restoredSession, this.#now());
      const parsed = parseRemoteControlRelayPairingUrl(restored.pairingUrl);
      this.#pairingUrl = restored.pairingUrl;
      this.#bootstrap = parsed.bootstrap;
      this.#claim = restored.claim;
      this.#sendKey = restored.sendKey;
      this.#receiveKey = restored.receiveKey;
      this.#sendSequence = restored.sendSequence;
      this.#pairRequestSent = restored.pairRequestSent;
      this.#pendingOutbound = restored.pendingOutbound;
      this.#pendingActionId = restored.pendingActionId;
      this.#pendingCapabilityProbeActionId = restored.pendingCapabilityProbeActionId ?? null;
      this.#pendingActionSentAt = restored.pendingActionSentAt ?? 0;
      this.#pendingTaskOperationId = restored.pendingTaskOperationId ?? null;
      this.#pendingTaskSentAt = restored.pendingTaskSentAt ?? 0;
      this.#pendingConversationOperationId = restored.pendingConversationOperationId ?? null;
      this.#pendingConversationSentAt = restored.pendingConversationSentAt ?? 0;
      this.#receiveCursor = restored.receiveCursor;
      this.#relayCursor = restored.relayCursor;
      this.#sessionToken = restored.sessionToken;
      this.#hostName = restored.hostName;
      this.#supportedFeatures = restored.supportedFeatures === undefined
        ? null
        : [...restored.supportedFeatures];
      this.#sasCode = restored.sasCode;
      this.#controllerKeyFingerprint = restored.controllerKeyFingerprint;
      this.#state = restored.sessionToken
        ? 'online'
        : restored.pairRequestSent || restored.pendingOutbound ? 'connecting' : 'approval-required';
      return;
    }
    this.#pairingUrl = options.pairingUrl!;
    const parsed = parseRemoteControlRelayPairingUrl(this.#pairingUrl);
    this.#bootstrap = parsed.bootstrap;
  }

  snapshot(): RemoteControlRelayControllerSnapshot | null {
    const claim = this.#claim;
    const sendKey = this.#sendKey;
    const receiveKey = this.#receiveKey;
    const receiveCursor = this.#receiveCursor;
    if (!claim || !sendKey || !receiveKey || !receiveCursor || this.#state === 'closed'
      || !this.#hostName || !this.#sasCode || !this.#controllerKeyFingerprint) return null;
    return {
      schemaVersion: REMOTE_CONTROL_RELAY_CONTROLLER_SNAPSHOT_VERSION,
      pairingUrl: this.#pairingUrl,
      claim: { ...claim },
      sendKey,
      receiveKey,
      sendSequence: this.#sendSequence,
      pairRequestSent: this.#pairRequestSent,
      pendingOutbound: this.#pendingOutbound ? { ...this.#pendingOutbound } : null,
      pendingActionId: this.#pendingActionId,
      pendingCapabilityProbeActionId: this.#pendingCapabilityProbeActionId,
      pendingActionSentAt: this.#pendingActionSentAt,
      pendingTaskOperationId: this.#pendingTaskOperationId,
      pendingTaskSentAt: this.#pendingTaskSentAt,
      pendingConversationOperationId: this.#pendingConversationOperationId,
      pendingConversationSentAt: this.#pendingConversationSentAt,
      receiveCursor: { ...receiveCursor, recentMessageIds: [...receiveCursor.recentMessageIds] },
      relayCursor: this.#relayCursor,
      sessionToken: this.#sessionToken,
      hostName: this.#hostName,
      ...(this.#supportedFeatures === null
        ? {}
        : { supportedFeatures: [...this.#supportedFeatures] }),
      sasCode: this.#sasCode,
      controllerKeyFingerprint: this.#controllerKeyFingerprint,
    };
  }

  async #persistSession(): Promise<void> {
    await this.#onSessionChanged?.(this.snapshot());
  }

  status(): RemoteControlRelayControllerStatus {
    return {
      state: this.#state,
      hostName: this.#hostName,
      sasCode: this.#sasCode,
      controllerKeyFingerprint: this.#controllerKeyFingerprint,
      expiresAt: this.#claim?.expiresAt ?? this.#bootstrap.expiresAt,
      projects: this.#projects.map(project => ({ ...project, actions: [...project.actions] })),
      workspaceRoots: this.#workspaceRoots.map(root => ({ ...root })),
      projectCount: this.#projectCount,
      nextPage: this.#nextPage,
      supportedFeatures: this.#supportedFeatures === null ? null : [...this.#supportedFeatures],
      busy: this.#busy
        || this.#pendingOutbound !== null
        || this.#pendingActionId !== null
        || this.#pendingTaskOperationId !== null
        || this.#pendingConversationOperationId !== null,
      error: this.#error,
      hostLastSeenAt: this.#hostLastSeenAt,
    };
  }

  /**
   * Is the Mac demonstrably not listening? Only `true` when the relay actually
   * told us how long it has been silent — an unknown answer must never block an
   * action, because a Mac that is answering fine would then look broken.
   */
  #hostIsSilent(): boolean {
    if (!this.#hostLastSeenAt) return false;
    const lastSeen = Date.parse(this.#hostLastSeenAt);
    return Number.isFinite(lastSeen) && this.#now() - lastSeen > REMOTE_CONTROL_HOST_SILENT_MS;
  }

  async initialize(): Promise<RemoteControlRelayControllerStatus> {
    if (this.#state !== 'idle') throw new Error('REMOTE_CONTROL_CONTROLLER_ALREADY_INITIALIZED');
    if (isRemoteControlRelayPairingExpired(this.#bootstrap, this.#now())) {
      this.#state = 'closed';
      this.#error = 'QR 연결 시간이 만료되었습니다.';
      return this.status();
    }
    this.#state = 'claiming';
    this.#busy = true;
    try {
      const keyPair = await generateRemoteControlRelayKeyPair();
      const controllerPublicKey = await exportRemoteControlRelayPublicKey(keyPair.publicKey);
      const controllerFingerprint = await fingerprintRemoteControlRelayPublicKey(controllerPublicKey);
      const claimInput = {
        pairingId: this.#bootstrap.pairingId,
        pairingSecret: this.#bootstrap.pairingSecret,
        controllerName: this.#controllerName,
        controllerPublicKey,
      };
      let claim: RemoteControlRelayClaimResult;
      try {
        claim = await this.#transport.claimPairing(claimInput);
      } catch (error) {
        if (!isAmbiguousClaimFailure(error)) throw error;
        // Retry the exact public-key-bound claim once. The relay may return the
        // already-created pending session only for this identical controller.
        claim = await this.#transport.claimPairing(claimInput);
      }
      const expectedHostFingerprint = await fingerprintRemoteControlRelayPublicKey(this.#bootstrap.hostPublicKey);
      if (claim.hostId !== this.#bootstrap.hostId
        || claim.hostPublicKey !== this.#bootstrap.hostPublicKey
        || claim.hostPublicKeyFingerprint !== expectedHostFingerprint) {
        throw new Error('REMOTE_CONTROL_HOST_KEY_MISMATCH');
      }
      const hostPublicKey = await importRemoteControlRelayPublicKey(claim.hostPublicKey);
      this.#sendKey = await deriveRemoteControlRelaySessionKey({
        privateKey: keyPair.privateKey,
        peerPublicKey: hostPublicKey,
        sessionId: claim.sessionId,
        controllerId: claim.controllerId,
        direction: 'controller-to-host',
        usages: ['encrypt'],
      });
      this.#receiveKey = await deriveRemoteControlRelaySessionKey({
        privateKey: keyPair.privateKey,
        peerPublicKey: hostPublicKey,
        sessionId: claim.sessionId,
        controllerId: claim.controllerId,
        direction: 'host-to-controller',
        usages: ['decrypt'],
      });
      this.#keyPair = keyPair;
      this.#claim = claim;
      this.#hostName = claim.hostName;
      this.#controllerKeyFingerprint = controllerFingerprint;
      this.#sasCode = await remoteControlRelaySasCode({
        hostPublicKey: claim.hostPublicKey,
        controllerPublicKey,
        pairingSecret: this.#bootstrap.pairingSecret,
      });
      this.#receiveCursor = createRemoteControlRelayReceiveCursor(claim.sessionId, claim.controllerId);
      this.#state = 'approval-required';
      await this.#persistSession();
      await this.#onClaimed?.();
    } catch (error) {
      this.#state = 'error';
      this.#error = safeError(error);
      throw error;
    } finally {
      this.#busy = false;
    }
    return this.status();
  }

  async refresh(): Promise<RemoteControlRelayControllerStatus> {
    const claim = this.#claim;
    if (!claim || !this.#sendKey || !this.#receiveKey || !this.#receiveCursor) return this.status();
    if (this.#busy) return this.status();
    this.#busy = true;
    try {
      const status = await this.#transport.status(claim.hostId, claim.sessionId);
      this.#hostLastSeenAt = status.hostLastSeenAt;
      const now = this.#now();
      let stopped = false;
      if (status.sessionId !== claim.sessionId || status.controllerId !== claim.controllerId
        || !status.hostEnabled
        || status.approvalState === 'revoked' || status.revokedAt) {
        this.#closeLocal('이 Mac에서 원격제어 연결을 종료했습니다.');
        stopped = true;
      }
      if (!stopped && (Date.parse(status.hostExpiresAt) <= now || Date.parse(status.sessionExpiresAt) <= now)) {
        this.#closeLocal('원격제어 연결 시간이 만료되었습니다.');
        stopped = true;
      }
      if (!stopped) {
        this.#claim = { ...claim, expiresAt: status.sessionExpiresAt };
        this.#error = null;
        this.#requestErrorCode = null;
        // An unanswered request cannot be answered once its envelope has
        // expired on the relay: the host's receive RPC filters on
        // envelope_expires_at. Release the in-flight lock and say why, rather
        // than leaving every button disabled with no message.
        if (this.#pendingActionId !== null
          && this.#pendingActionSentAt > 0
          && now - this.#pendingActionSentAt > REMOTE_CONTROL_PENDING_ACTION_TIMEOUT_MS) {
          this.#pendingActionId = null;
          this.#pendingCapabilityProbeActionId = null;
          this.#pendingActionSentAt = 0;
          this.#error = 'Mac이 응답하지 않아 요청을 취소했습니다. Mac에서 AgentsToZ가 실행 중인지 확인하세요.';
        }
        if (this.#pendingTaskOperationId !== null
          && this.#pendingTaskSentAt > 0
          && now - this.#pendingTaskSentAt > REMOTE_CONTROL_PENDING_ACTION_TIMEOUT_MS) {
          this.#pendingTaskOperationId = null;
          this.#pendingTaskRequest = null;
          this.#pendingTaskResult = null;
          this.#pendingTaskSentAt = 0;
          this.#error = 'Mac이 응답하지 않아 작업 요청을 닫았습니다. 작업 목록을 새로고침해 실제 상태를 확인하세요.';
        }
        if (this.#pendingConversationOperationId !== null
          && this.#pendingConversationSentAt > 0
          && now - this.#pendingConversationSentAt > REMOTE_CONTROL_PENDING_ACTION_TIMEOUT_MS) {
          this.#pendingConversationOperationId = null;
          this.#pendingConversationRequest = null;
          this.#pendingConversationResult = null;
          this.#pendingConversationSentAt = 0;
          this.#error = 'Mac이 응답하지 않아 대화 요청을 닫았습니다. 대화 목록을 새로고침해 실제 상태를 확인하세요.';
        }
        if (status.approvalState === 'approved' && this.#pendingOutbound) {
          await this.#flushPendingOutbound();
        }
        if (status.approvalState === 'approved') await this.#receive();
        if (status.approvalState === 'approved'
          && !this.#sessionToken
          && !this.#pendingOutbound
          && !this.#pairRequestSent
          && (this.#state === 'approval-required' || this.#state === 'error')) {
          this.#state = 'connecting';
          this.#pairRequestSent = true;
          await this.#sendPayload({
            type: 'controller.pair',
            protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
            token: this.#bootstrap.pairingSecret,
          });
          await this.#receive();
        }
      }
    } catch (error) {
      if (isTerminalRelaySessionFailure(error)) {
        this.#closeLocal('원격제어 연결 시간이 만료되었거나 종료되었습니다.');
        await this.#persistSession();
        throw error;
      }
      this.#error = safeError(error);
      if (this.#state !== 'online') this.#state = 'error';
      await this.#persistSession();
      throw error;
    } finally {
      this.#busy = false;
    }
    await this.#persistSession();
    return this.status();
  }

  /**
   * `refresh()` holds `#busy` for a whole relay round trip and the portal runs it every second,
   * so a tap that landed inside that window was refused with REMOTE_CONTROL_ACTION_IN_PROGRESS
   * even though nothing was actually in flight. Waiting the poll out is the difference between
   * a button that works and one that randomly rejects on a healthy connection. A real pending
   * request is checked separately and still refuses immediately.
   */
  async #waitForPollToRelease(): Promise<void> {
    for (let attempt = 0; this.#busy && attempt < REMOTE_CONTROL_BUSY_WAIT_ATTEMPTS; attempt += 1) {
      await this.#sleep(REMOTE_CONTROL_BUSY_WAIT_POLL_MS);
    }
  }

  projectCreationIdentity(): {hostId: string; controllerId: string} {
    if (!this.#claim || !this.#sessionToken) throw new Error('REMOTE_CONTROL_SESSION_NOT_READY');
    return {hostId: this.#claim.hostId, controllerId: this.#claim.controllerId};
  }

  async sendAction(
    action: RemoteControlAction,
    controlId?: string,
    page?: number,
    input?: string,
    workspaceRootId?: string,
    creationActionId?: string,
  ): Promise<RemoteControlActionResult | undefined> {
    if (this.#state !== 'online' || !this.#sessionToken) throw new Error('REMOTE_CONTROL_SESSION_NOT_READY');
    if (this.#pendingOutbound || this.#pendingActionId
      || this.#pendingTaskOperationId || this.#pendingConversationOperationId) {
      throw new Error('REMOTE_CONTROL_ACTION_IN_PROGRESS');
    }
    await this.#waitForPollToRelease();
    if (this.#state !== 'online' || !this.#sessionToken) throw new Error('REMOTE_CONTROL_SESSION_NOT_READY');
    if (this.#busy || this.#pendingOutbound || this.#pendingActionId
      || this.#pendingTaskOperationId || this.#pendingConversationOperationId) {
      throw new Error('REMOTE_CONTROL_ACTION_IN_PROGRESS');
    }
    if (creationActionId !== undefined && (action !== 'project.create' || !/^[A-Za-z0-9_-]{8,100}$/.test(creationActionId))) {
      throw new Error('REMOTE_CONTROL_CREATE_INTENT_INVALID');
    }
    const actionId = creationActionId ?? this.#randomUuid();
    const request: Record<string, unknown> = {
      type: 'action.request',
      protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
      sessionToken: this.#sessionToken,
      actionId,
      action,
    };
    if (action === 'project.create') {
      if (!input || !workspaceRootId) throw new Error('REMOTE_CONTROL_PROJECT_INPUT_REQUIRED');
      request.input = input;
      request.workspaceRootId = workspaceRootId;
      request.remoteConfirmed = true;
    } else if (action !== 'projects.list'
      && action !== 'workspace-roots.list'
      && action !== 'protocol.capabilities') {
      if (!controlId) throw new Error('REMOTE_CONTROL_CONTROL_ID_REQUIRED');
      request.controlId = controlId;
      if (action !== 'project.status') request.remoteConfirmed = true;
      if (input) request.input = input;
    } else if (page !== undefined) {
      if (action !== 'projects.list') throw new Error('REMOTE_CONTROL_PAGE_NOT_ALLOWED');
      request.page = page;
    }
    this.#completedActionResult = undefined;
    this.#pendingActionId = actionId;
    this.#pendingCapabilityProbeActionId = action === 'protocol.capabilities' ? actionId : null;
    this.#pendingActionSentAt = this.#now();
    this.#busy = true;
    try {
      // Refuse up front when the relay says the Mac has not spoken in a minute.
      // The alternative is a full result budget of spinner for a reply that a
      // sleeping Mac was never going to send.
      if (this.#hostIsSilent()) {
        this.#pendingActionId = null;
        this.#pendingCapabilityProbeActionId = null;
        this.#pendingActionSentAt = 0;
        throw new Error('Mac이 응답하지 않습니다. 절전 상태이거나 AgentsToZ가 꺼져 있을 수 있습니다 — Mac을 깨운 뒤 다시 실행하세요.');
      }
      this.#error = null;
      this.#requestErrorCode = null;
      await this.#sendPayload(request);
      // Poll for this action's own result. Resolving without one printed a green
      // "요청을 완료했습니다" for work that never ran; failing after a single
      // receive printed a red "응답하지 않습니다" for work that was still running.
      // Both are wrong, and only waiting tells them apart.
      for (let attempt = 0; ; attempt += 1) {
        await this.#receive();
        if (this.#error) throw this.#requestErrorCode
          ? new RemoteControlRelayRequestError(this.#requestErrorCode, this.#error)
          : new Error(this.#error);
        if (this.#pendingActionId !== actionId) return this.#resultForAction(actionId);
        if (attempt >= REMOTE_CONTROL_ACTION_RESULT_ATTEMPTS) break;
        await this.#sleep(REMOTE_CONTROL_ACTION_RESULT_POLL_MS);
      }
      // Bounded by attempts, not wall clock, so an injected frozen clock still
      // terminates. Say what is true: it was delivered and may still be running.
      // "다시 시도하세요" here is what produced duplicate commits and worktrees.
      throw new Error('Mac이 아직 결과를 보내지 않았습니다. 요청은 전달되었고 아직 실행 중일 수 있으니, 목록을 새로고침해 확인한 뒤에 다시 실행하세요.');
    } finally {
      this.#busy = false;
    }
  }

  /**
   * Negotiate additive Internet-relay features without changing the frozen
   * session.ready shape. An old host rejects the unknown read action with
   * ACTION_NOT_ALLOWED; #receive turns only this marked refusal into the
   * authenticated empty/base-only result.
   */
  async probeSupportedFeatures(force = false): Promise<RemoteControlRelayControllerStatus> {
    if (this.#state !== 'online' || !this.#sessionToken) {
      throw new Error('REMOTE_CONTROL_SESSION_NOT_READY');
    }
    if (!force && this.#supportedFeatures !== null) return this.status();
    await this.sendAction('protocol.capabilities');
    return this.status();
  }

  async sendTask<TOperation extends RemoteControlTaskOperation>(
    operation: TOperation,
    payload: RemoteControlTaskRequestPayloadByOperation[TOperation],
  ): Promise<RemoteControlTaskResult> {
    if (this.#state !== 'online' || !this.#sessionToken) throw new Error('REMOTE_CONTROL_SESSION_NOT_READY');
    if (!this.#supportedFeatures?.includes(REMOTE_CONTROL_TASK_SCOPE)) {
      throw new RemoteControlRelayRequestError(
        REMOTE_CONTROL_HOST_UPDATE_REQUIRED,
        '이 Mac의 AgentsToZ 앱이 원격 Codex 작업 기능을 지원하지 않는 이전 설치본입니다.',
      );
    }
    if (this.#pendingOutbound || this.#pendingActionId
      || this.#pendingTaskOperationId || this.#pendingConversationOperationId) {
      throw new Error('REMOTE_CONTROL_ACTION_IN_PROGRESS');
    }
    await this.#waitForPollToRelease();
    // A refresh can land session.restored during the wait, replacing the token and clearing the
    // negotiated feature list. Re-deciding is the point: otherwise the request goes out on the new
    // session under the old session's permission, and the update-required gate is bypassed.
    if (this.#state !== 'online' || !this.#sessionToken) throw new Error('REMOTE_CONTROL_SESSION_NOT_READY');
    if (!this.#supportedFeatures?.includes(REMOTE_CONTROL_TASK_SCOPE)) {
      throw new RemoteControlRelayRequestError(
        REMOTE_CONTROL_HOST_UPDATE_REQUIRED,
        '이 Mac의 AgentsToZ 앱이 원격 Codex 작업 기능을 지원하지 않는 이전 설치본입니다.',
      );
    }
    if (this.#busy || this.#pendingOutbound || this.#pendingActionId
      || this.#pendingTaskOperationId || this.#pendingConversationOperationId) {
      throw new Error('REMOTE_CONTROL_ACTION_IN_PROGRESS');
    }
    const request = normalizeRemoteControlTaskRequest({
      type: 'tasks.request',
      protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
      taskProtocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      sessionToken: this.#sessionToken,
      operationId: this.#randomUuid(),
      operation,
      payload,
    });
    this.#pendingTaskOperationId = request.operationId;
    this.#pendingTaskRequest = request;
    this.#pendingTaskResult = null;
    this.#pendingTaskSentAt = this.#now();
    this.#busy = true;
    try {
      if (this.#hostIsSilent()) {
        this.#pendingTaskOperationId = null;
        this.#pendingTaskRequest = null;
        this.#pendingTaskSentAt = 0;
        throw new Error('Mac이 응답하지 않습니다. 절전 상태이거나 AgentsToZ가 꺼져 있을 수 있습니다 — Mac을 깨운 뒤 다시 실행하세요.');
      }
      this.#error = null;
      this.#requestErrorCode = null;
      await this.#sendPayload(request);
      for (let attempt = 0; ; attempt += 1) {
        await this.#receive();
        if (this.#error) throw this.#requestErrorCode
          ? new RemoteControlRelayRequestError(this.#requestErrorCode, this.#error)
          : new Error(this.#error);
        if (this.#pendingTaskResult) {
          const result = this.#pendingTaskResult;
          this.#pendingTaskResult = null;
          return result;
        }
        if (this.#pendingTaskOperationId !== request.operationId) {
          throw new Error('Mac이 다시 시작되어 작업 요청 결과를 확정할 수 없습니다. 작업 목록을 새로고침해 확인하세요.');
        }
        if (attempt >= REMOTE_CONTROL_ACTION_RESULT_ATTEMPTS) break;
        await this.#sleep(REMOTE_CONTROL_ACTION_RESULT_POLL_MS);
      }
      throw new Error('Mac이 아직 결과를 보내지 않았습니다. 요청은 전달되었고 실행 중일 수 있으니 작업 목록을 새로고침해 확인하세요.');
    } finally {
      this.#busy = false;
    }
  }

  async sendTerminal(request: AiTerminalRequest): Promise<AiTerminalResponse>;
  async sendTerminal(request: MobileWorkspaceRequest): Promise<MobileWorkspaceResult>;
  async sendTerminal(request: AiTerminalRequest|MobileWorkspaceRequest): Promise<AiTerminalResponse|MobileWorkspaceResult> {
    if(request.operation==='workspace'&&!this.#supportedFeatures?.includes('workspace-v1'))throw new Error('연결한 Mac 앱을 업데이트하세요.');
    // Periodic host refresh shares the relay cursor. Wait for that reader instead of dropping a typed key.
    for(let attempt=0;this.#busy&&attempt<400;attempt++)await this.#sleep(25);
    if(this.#state!=='online'||!this.#sessionToken) throw new Error('원격 연결을 먼저 완료하세요.');
    if(this.#busy||this.#pendingOutbound||this.#pendingActionId||this.#pendingTaskOperationId||this.#pendingConversationOperationId) throw new Error('다른 원격 요청이 진행 중입니다.');
    this.#busy=true;this.#terminalRequestId=request.requestId;this.#terminalResult=null;
    const token=this.#sessionToken;
    try {
      this.#error=null;
      await this.#sendPayload({type:'terminal.request',sessionToken:token,request});
      for(let attempt=0;attempt<REMOTE_CONTROL_ACTION_RESULT_ATTEMPTS;attempt++) {
        await this.#receive();
        if(this.#error)throw new Error(this.#error);
        const result=this.#terminalResult as RemoteTerminalResult|null;
        if(result){if(!result.ok)throw new Error(result.error);if((request.operation==='workspace')!==!!(result.body&&'kind' in result.body&&result.body.kind==='workspace'))throw new Error('모바일 요청과 응답이 일치하지 않습니다.');return result.body!;}
        if(this.#sessionToken!==token)throw new Error('Mac의 연결이 갱신되었습니다. 터미널 목록을 새로고침하세요.');
        await this.#sleep(REMOTE_CONTROL_ACTION_RESULT_POLL_MS);
      }
      throw new Error('터미널 응답을 확인하지 못했습니다. 입력은 전달되었을 수 있으므로 화면을 확인한 뒤 다시 시도하세요.');
    } finally {this.#busy=false;this.#terminalRequestId=null;this.#terminalResult=null;}
  }

  async sendConversation<TOperation extends RemoteControlConversationOperation>(
    operation: TOperation,
    payload: RemoteControlConversationRequestPayloadByOperation[TOperation],
  ): Promise<RemoteControlConversationResult> {
    if (this.#state !== 'online' || !this.#sessionToken) throw new Error('REMOTE_CONTROL_SESSION_NOT_READY');
    if (!this.#supportedFeatures?.includes(REMOTE_CONTROL_CONVERSATION_SCOPE)) {
      throw new RemoteControlRelayRequestError(
        REMOTE_CONTROL_HOST_UPDATE_REQUIRED,
        '이 Mac의 AgentsToZ 앱이 원격 Codex 대화 기능을 지원하지 않는 이전 설치본입니다.',
      );
    }
    if (this.#pendingOutbound || this.#pendingActionId
      || this.#pendingTaskOperationId || this.#pendingConversationOperationId) {
      throw new Error('REMOTE_CONTROL_ACTION_IN_PROGRESS');
    }
    await this.#waitForPollToRelease();
    // Same reason as sendTask: the wait is long enough for the session and its feature list to be
    // replaced underneath a tap that was already judged admissible.
    if (this.#state !== 'online' || !this.#sessionToken) throw new Error('REMOTE_CONTROL_SESSION_NOT_READY');
    if (!this.#supportedFeatures?.includes(REMOTE_CONTROL_CONVERSATION_SCOPE)) {
      throw new RemoteControlRelayRequestError(
        REMOTE_CONTROL_HOST_UPDATE_REQUIRED,
        '이 Mac의 AgentsToZ 앱이 원격 Codex 대화 기능을 지원하지 않는 이전 설치본입니다.',
      );
    }
    if (this.#busy || this.#pendingOutbound || this.#pendingActionId
      || this.#pendingTaskOperationId || this.#pendingConversationOperationId) {
      throw new Error('REMOTE_CONTROL_ACTION_IN_PROGRESS');
    }
    const request = normalizeRemoteControlConversationRequest({
      type: 'conversations.request',
      protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
      conversationProtocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      sessionToken: this.#sessionToken,
      operationId: this.#randomUuid(),
      operation,
      payload,
    });
    this.#pendingConversationOperationId = request.operationId;
    this.#pendingConversationRequest = request;
    this.#pendingConversationResult = null;
    this.#pendingConversationSentAt = this.#now();
    this.#busy = true;
    try {
      if (this.#hostIsSilent()) {
        this.#pendingConversationOperationId = null;
        this.#pendingConversationRequest = null;
        this.#pendingConversationSentAt = 0;
        throw new Error('Mac이 응답하지 않습니다. 절전 상태이거나 AgentsToZ가 꺼져 있을 수 있습니다 — Mac을 깨운 뒤 다시 실행하세요.');
      }
      this.#error = null;
      this.#requestErrorCode = null;
      await this.#sendPayload(request);
      for (let attempt = 0; ; attempt += 1) {
        await this.#receive();
        if (this.#error) throw this.#requestErrorCode
          ? new RemoteControlRelayRequestError(this.#requestErrorCode, this.#error)
          : new Error(this.#error);
        if (this.#pendingConversationResult) {
          const result = this.#pendingConversationResult;
          this.#pendingConversationResult = null;
          return result;
        }
        if (this.#pendingConversationOperationId !== request.operationId) {
          throw new Error('Mac이 다시 시작되어 대화 요청 결과를 확정할 수 없습니다. 대화 목록을 새로고침해 확인하세요.');
        }
        if (attempt >= REMOTE_CONTROL_ACTION_RESULT_ATTEMPTS) break;
        await this.#sleep(REMOTE_CONTROL_ACTION_RESULT_POLL_MS);
      }
      throw new Error('Mac이 아직 결과를 보내지 않았습니다. 요청은 전달되었을 수 있으니 대화 목록을 새로고침해 확인하세요.');
    } finally {
      this.#busy = false;
    }
  }

  async revoke(): Promise<void> {
    const claim = this.#claim;
    this.#closeLocal(null);
    await this.#persistSession();
    if (claim) await this.#transport.revoke(claim.hostId, claim.sessionId);
  }

  #closeLocal(error: string | null): void {
    this.#state = 'closed';
    this.#error = error;
    this.#requestErrorCode = null;
    this.#sessionToken = '';
    this.#pairRequestSent = false;
    this.#pendingOutbound = null;
    this.#pendingActionId = null;
    this.#pendingCapabilityProbeActionId = null;
    this.#pendingActionSentAt = 0;
    this.#pendingTaskOperationId = null;
    this.#pendingTaskRequest = null;
    this.#pendingTaskResult = null;
    this.#pendingTaskSentAt = 0;
    this.#pendingConversationOperationId = null;
    this.#pendingConversationRequest = null;
    this.#pendingConversationResult = null;
    this.#pendingConversationSentAt = 0;
    this.#keyPair = null;
    this.#sendKey = null;
    this.#receiveKey = null;
    this.#receiveCursor = null;
    this.#claim = null;
    this.#relayCursor = '0';
    this.#projects = [];
    this.#workspaceRoots = [];
    this.#projectCount = 0;
    this.#nextPage = null;
    this.#supportedFeatures = null;
    this.#sasCode = null;
  }

  async #sendPayload(payload: unknown): Promise<void> {
    const claim = this.#claim;
    const key = this.#sendKey;
    if (!claim || !key) throw new Error('REMOTE_CONTROL_SESSION_NOT_READY');
    if (this.#pendingOutbound) throw new Error('REMOTE_CONTROL_ACTION_IN_PROGRESS');
    const sequence = this.#sendSequence + 1;
    this.#pendingOutbound = await encryptRemoteControlRelayEnvelope({
      key,
      metadata: {
        schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
        messageId: this.#randomUuid(),
        sessionId: claim.sessionId,
        controllerId: claim.controllerId,
        sequence,
        expiresAt: minExpiry(this.#now(), claim.expiresAt),
      },
      plaintext: encoder.encode(JSON.stringify(payload)),
      now: this.#now(),
    });
    await this.#persistSession();
    await this.#flushPendingOutbound();
  }

  async #flushPendingOutbound(): Promise<void> {
    const claim = this.#claim;
    const envelope = this.#pendingOutbound;
    if (!claim || !envelope) return;
    if(Date.parse(envelope.expiresAt)<=this.#now()) {
      // A ten-minute delivery expiry is not the thirty-day device expiry.
      // Never re-encrypt/replay the uncertain command. Consume its sequence
      // and send only an authenticated pairing checkpoint to repair the gap.
      if(!this.#sendKey)throw new Error('REMOTE_CONTROL_SESSION_NOT_READY');
      const checkpoint=await encryptRemoteControlRelayEnvelope({key:this.#sendKey,metadata:{
        schemaVersion:REMOTE_CONTROL_RELAY_SCHEMA_VERSION,messageId:this.#randomUuid(),
        sessionId:claim.sessionId,controllerId:claim.controllerId,sequence:envelope.sequence+1,
        expiresAt:minExpiry(this.#now(),claim.expiresAt),
      },plaintext:encoder.encode(JSON.stringify({type:'controller.pair',protocolVersion:REMOTE_CONTROL_PROTOCOL_VERSION,token:this.#bootstrap.pairingSecret})),now:this.#now()});
      // Persist the new checkpoint together with the consumed sequence. A
      // crash must leave either the old uncertain envelope or this checkpoint,
      // never an empty outbox that could let the next command skip recovery.
      this.#sendSequence=envelope.sequence;
      this.#pendingOutbound=checkpoint;
      this.#sessionToken='';
      this.#pairRequestSent=true;
      this.#state='connecting';
      await this.#persistSession();
      await this.#flushPendingOutbound();
      return;
    }
    // Preserve the exact message id, sender sequence, nonce, ciphertext, and
    // expiry across an ambiguous network failure. The relay accepts only an
    // exact duplicate, so a retry cannot become a second command.
    await this.#transport.sendEnvelope(claim.hostId, claim.sessionId, envelope);
    this.#sendSequence = envelope.sequence;
    this.#pendingOutbound = null;
    await this.#persistSession();
  }

  async #receive(): Promise<void> {
    const claim = this.#claim;
    const key = this.#receiveKey;
    let cursor = this.#receiveCursor;
    if (!claim || !key || !cursor) throw new Error('REMOTE_CONTROL_SESSION_NOT_READY');
    const deliveries = await this.#transport.receiveEnvelopes(claim.hostId, claim.sessionId, this.#relayCursor);
    for (const delivery of deliveries) {
      const decision = acceptRemoteControlRelayEnvelope(delivery.envelope, cursor, this.#now());
      const isSequenceGap = !decision.ok && decision.reason === 'sequence-gap';
      if (!decision.ok && !isSequenceGap) {
        throw new Error(`REMOTE_CONTROL_RELAY_${decision.reason.toUpperCase().replace(/-/g, '_')}`);
      }
      const plaintext = await decryptRemoteControlRelayEnvelope({
        key,
        envelope: delivery.envelope,
        now: this.#now(),
        expected: {
          sessionId: claim.sessionId,
          controllerId: claim.controllerId,
          // A Mac restart proactively emits session.ready. If the phone stays
          // asleep past the relay's ten-minute envelope TTL, that checkpoint
          // disappears and the next freshly minted session.ready necessarily
          // arrives after a sender-sequence gap. Authenticate the actual
          // sequence first, then admit ONLY that full-state checkpoint below.
          // Normal action results still require strict contiguous delivery.
          sequence: isSequenceGap ? delivery.envelope.sequence : cursor.highestSequence + 1,
        },
      });
      const message = parseServerMessage(JSON.parse(decoder.decode(plaintext)));
      if (isSequenceGap && message.type !== 'session.ready') {
        throw new Error('REMOTE_CONTROL_RELAY_SEQUENCE_GAP');
      }
      const acceptedCursor: RemoteControlRelayReceiveCursor = decision.ok
        ? decision.cursor
        : {
            sessionId: cursor.sessionId,
            controllerId: cursor.controllerId,
            highestSequence: delivery.envelope.sequence,
            recentMessageIds: [delivery.envelope.messageId],
          };
      if (message.type === 'session.ready') {
        // The Mac pushes this unprompted when it restarts and resumes us, so it
        // can arrive while an action is in flight. The previous process can no
        // longer answer, but the action may already have completed. Release the
        // lock without inviting a duplicate retry and require a state refresh.
        if (this.#pendingActionId) {
          const wasCapabilityProbe = this.#pendingCapabilityProbeActionId === this.#pendingActionId;
          this.#pendingActionId = null;
          this.#pendingCapabilityProbeActionId = null;
          this.#pendingActionSentAt = 0;
          if (!wasCapabilityProbe) {
            this.#error = 'Mac이 다시 시작되어 연결을 복구했습니다. 이전 요청의 완료 여부는 확인할 수 없으니, 목록을 새로고침해 상태를 확인한 뒤 판단하세요.';
            this.#requestErrorCode = null;
          }
        }
        if (this.#pendingTaskOperationId) {
          this.#pendingTaskOperationId = null;
          this.#pendingTaskRequest = null;
          this.#pendingTaskResult = null;
          this.#pendingTaskSentAt = 0;
          this.#error = 'Mac이 다시 시작되어 연결을 복구했습니다. 이전 작업 요청의 완료 여부는 작업 목록에서 확인하세요.';
          this.#requestErrorCode = null;
        }
        if (this.#pendingConversationOperationId) {
          this.#pendingConversationOperationId = null;
          this.#pendingConversationRequest = null;
          this.#pendingConversationResult = null;
          this.#pendingConversationSentAt = 0;
          this.#error = 'Mac이 다시 시작되어 연결을 복구했습니다. 이전 대화 요청의 결과는 대화 목록에서 확인하세요.';
          this.#requestErrorCode = null;
        }
        this.#sessionToken = message.sessionToken;
        this.#pairRequestSent = false;
        this.#hostName = message.hostName;
        // A new authenticated token belongs to the newly running host process;
        // never inherit an earlier manifest across a restart or restore.
        this.#supportedFeatures = null;
        this.#projects = message.projects;
        this.#projectCount = message.projectCount;
        this.#nextPage = message.nextPage;
        this.#state = 'online';
      } else if (message.type === 'terminal.result') {
        if(message.requestId===this.#terminalRequestId)this.#terminalResult=message;
      } else if (message.type === 'tasks.result') {
        if (message.operationId === this.#pendingTaskOperationId) {
          const matched = this.#pendingTaskRequest
            ? assertRemoteControlTaskResultMatchesRequest(this.#pendingTaskRequest, message)
            : message;
          this.#pendingTaskResult = matched;
          this.#pendingTaskOperationId = null;
          this.#pendingTaskRequest = null;
          this.#pendingTaskSentAt = 0;
        }
      } else if (message.type === 'conversations.result') {
        if (message.operationId === this.#pendingConversationOperationId) {
          const matched = this.#pendingConversationRequest
            ? assertRemoteControlConversationResultMatchesRequest(
                this.#pendingConversationRequest,
                message,
              )
            : message;
          this.#pendingConversationResult = matched;
          this.#pendingConversationOperationId = null;
          this.#pendingConversationRequest = null;
          this.#pendingConversationSentAt = 0;
        }
      } else if (message.type === 'action.result') {
        const matchesPendingAction = message.actionId === this.#pendingActionId;
        const answersCapabilityProbe = matchesPendingAction
          && message.actionId === this.#pendingCapabilityProbeActionId;
        if (matchesPendingAction) {
          this.#completedActionResult = message;
          this.#pendingActionId = null;
          this.#pendingCapabilityProbeActionId = null;
          this.#pendingActionSentAt = 0;
        }
        if (!message.ok) {
          if (answersCapabilityProbe && message.error.code === 'ACTION_NOT_ALLOWED') {
            this.#supportedFeatures = [];
            this.#error = null;
            this.#requestErrorCode = null;
          } else {
            this.#error = message.error.message;
            this.#requestErrorCode = message.error.code;
          }
        }
        else if ('supportedFeatures' in message) {
          if (answersCapabilityProbe) this.#supportedFeatures = [...message.supportedFeatures];
        }
        else if ('projects' in message) {
          this.#projects = message.page === 0
            ? message.projects
            : [...this.#projects, ...message.projects.filter(project => (
                !this.#projects.some(current => current.controlId === project.controlId)
              ))];
          this.#projectCount = message.projectCount;
          this.#nextPage = message.nextPage;
        }
        else if ('workspaceRoots' in message) {
          this.#workspaceRoots = message.workspaceRoots;
        }
        else if (message.project) {
          const index = this.#projects.findIndex(project => project.controlId === message.project!.controlId);
          if (index >= 0) this.#projects = this.#projects.map((project, offset) => offset === index ? message.project! : project);
          else { this.#projects = [...this.#projects, message.project]; this.#projectCount = Math.max(this.#projectCount, this.#projects.length); }
        }
      } else {
        // A {type:'error'} reply is the Mac refusing the request outright
        // (a malformed message, an unsupported protocol version). It is NOT an
        // action.result, so without this the pending action id was never
        // released and every button stayed disabled forever — reachable today
        // with a commit message over 120 characters.
        const rejectedCapabilityProbe = message.code === 'ACTION_NOT_ALLOWED'
          && this.#pendingActionId !== null
          && this.#pendingCapabilityProbeActionId === this.#pendingActionId;
        const rejectedExtendedFeature = message.code === 'ACTION_NOT_ALLOWED'
          && (this.#pendingTaskOperationId !== null || this.#pendingConversationOperationId !== null);
        this.#pendingActionId = null;
        this.#pendingCapabilityProbeActionId = null;
        this.#pendingActionSentAt = 0;
        this.#pendingTaskOperationId = null;
        this.#pendingTaskRequest = null;
        this.#pendingTaskResult = null;
        this.#pendingTaskSentAt = 0;
        this.#pendingConversationOperationId = null;
        this.#pendingConversationRequest = null;
        this.#pendingConversationResult = null;
        this.#pendingConversationSentAt = 0;
        if (!this.#sessionToken) {
          // Refused before a session existed: pairing itself failed. Make it
          // terminal, otherwise the next poll blanks #error and the phone sits
          // on a spinner claiming the Mac approved.
          const errorMessage = 'message' in message ? message.message : '연결이 거부되었습니다.';
          this.#closeLocal(errorMessage);
          await this.#persistSession();
          return;
        }
        if (rejectedCapabilityProbe) {
          this.#supportedFeatures = [];
          this.#requestErrorCode = null;
          this.#error = null;
        } else if (rejectedExtendedFeature) {
          this.#requestErrorCode = REMOTE_CONTROL_HOST_UPDATE_REQUIRED;
          this.#error = '이 Mac의 AgentsToZ 앱이 원격 Codex 작업·대화 기능을 지원하지 않는 이전 설치본입니다.';
        } else {
          this.#requestErrorCode = message.code;
          this.#error = message.message;
        }
      }
      cursor = acceptedCursor;
      this.#receiveCursor = cursor;
      this.#relayCursor = delivery.relaySequence;
      await this.#persistSession();
      await this.#transport.acknowledge(claim.hostId, claim.sessionId, delivery.relaySequence);
    }
  }
}

/**
 * The portal polled its one Mac every second. With several remembered Macs that
 * cost multiplies by N — phone battery and relay requests spent on hosts nobody
 * is looking at. Only the Mac on screen keeps the one-second cadence; the rest
 * are polled slowly, which is still enough to keep a chip's online/offline dot
 * honest. A background host that has actually gone away is therefore reported
 * up to `REMOTE_CONTROL_BACKGROUND_HOST_POLL_MS` late, which is the deliberate
 * trade: nobody is acting on that host until they tap it, and tapping it makes
 * it the selected host and polls it immediately.
 */
export const REMOTE_CONTROL_SELECTED_HOST_POLL_MS = 1_000;
/**
 * How long the Mac may have been silent before an action is refused outright.
 *
 * The host polls the relay every 1s while it has sessions and every 5s when it
 * does not, and stamps the row each time. A gap much larger than that means it
 * is asleep, quit, or offline — and waiting the full result budget for a reply
 * nobody will send is the difference between a one-second answer and a minute
 * of spinner. Generous enough to absorb a slow poll or a backoff round.
 */
export const REMOTE_CONTROL_HOST_SILENT_MS = 60_000;
/**
 * How long an action waits for its own `action.result` before reporting that
 * nothing came back.
 *
 * ⚠️ **The host cannot answer during our send call.** It polls the relay every
 * `ACTIVE_POLL_MS` (1s) and only then runs the work — `perform()` is awaited to
 * completion before the reply is queued — so a single receive straight after
 * sending finds the result missing every time. Reading that as "the Mac is not
 * responding" turned a working remote into a red error on essentially every
 * button, and invited a retry of an action that had in fact already run.
 * Retrying is not free: the core memoizes by `actionId`, and a retry mints a
 * new one, so a second tap really is a second commit or a second worktree.
 */
/** How long a tap may wait for the 1s background poll to release its lock. Short enough that a
 * genuinely stuck controller still answers the tap, long enough to cover a normal relay round trip. */
export const REMOTE_CONTROL_BUSY_WAIT_POLL_MS = 100;
export const REMOTE_CONTROL_BUSY_WAIT_ATTEMPTS = 30;
export const REMOTE_CONTROL_ACTION_RESULT_POLL_MS = 1_000;
export const REMOTE_CONTROL_ACTION_RESULT_ATTEMPTS = 60;
export const REMOTE_CONTROL_BACKGROUND_HOST_POLL_MS = 20_000;

export interface RemoteControlRelayHostStatus {
  hostId: string;
  status: RemoteControlRelayControllerStatus;
}

/**
 * One `RemoteControlRelayController` per Mac, kept side by side. Switching the
 * visible Mac must not touch the others: each holds its own approved 30-day
 * session, and tearing one down to look at another would make the phone
 * re-pair every time it switched.
 */
export class RemoteControlRelayControllerManager {
  readonly #hosts = new Map<string, { controller: RemoteControlRelayController; lastPolledAt: number }>();

  get size(): number {
    return this.#hosts.size;
  }

  hostIds(): string[] {
    return [...this.#hosts.keys()];
  }

  has(hostId: string): boolean {
    return this.#hosts.has(hostId);
  }

  controller(hostId: string | null): RemoteControlRelayController | null {
    return hostId === null ? null : this.#hosts.get(hostId)?.controller ?? null;
  }

  adopt(hostId: string, controller: RemoteControlRelayController): void {
    // A fresh host is due immediately: its chip has no state to show until the
    // first poll answers.
    this.#hosts.set(hostId, { controller, lastPolledAt: 0 });
  }

  forget(hostId: string): RemoteControlRelayController | null {
    const entry = this.#hosts.get(hostId) ?? null;
    this.#hosts.delete(hostId);
    return entry?.controller ?? null;
  }

  statuses(): RemoteControlRelayHostStatus[] {
    return [...this.#hosts].map(([hostId, entry]) => ({ hostId, status: entry.controller.status() }));
  }

  dueForRefresh(now: number, selectedHostId: string | null): string[] {
    return [...this.#hosts]
      .filter(([hostId, entry]) => {
        const interval = hostId === selectedHostId
          ? REMOTE_CONTROL_SELECTED_HOST_POLL_MS
          : REMOTE_CONTROL_BACKGROUND_HOST_POLL_MS;
        return now - entry.lastPolledAt >= interval;
      })
      .map(([hostId]) => hostId);
  }

  markRefreshed(hostId: string, now: number): void {
    const entry = this.#hosts.get(hostId);
    if (entry) entry.lastPolledAt = now;
  }
}
