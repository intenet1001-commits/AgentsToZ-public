import { normalizeHttpsExactOrigin } from './portalDeployUrl';
import {
  decodeRemoteControlRelayBase64Url,
  parseRemoteControlRelayPairingUrl,
} from './remoteControlRelayContract';

export const INTERNET_REMOTE_CONTROL_PATHS = {
  status: '/api/remote-control/internet/status',
  enable: '/api/remote-control/internet/enable',
  issuePairing: '/api/remote-control/internet/pairing/issue',
  approveSession: '/api/remote-control/internet/sessions/approve',
  updateSessionScopes: '/api/remote-control/internet/sessions/scopes',
  revokeSession: '/api/remote-control/internet/sessions/revoke',
  disable: '/api/remote-control/internet/disable',
} as const;

export type InternetRemoteControlPath = typeof INTERNET_REMOTE_CONTROL_PATHS[keyof typeof INTERNET_REMOTE_CONTROL_PATHS];
export type InternetRemoteControlState =
  | 'disabled'
  | 'pairing'
  | 'approval-required'
  | 'online'
  | 'degraded'
  | 'offline';
export type InternetRemoteControlApprovalState = 'pending' | 'approved' | 'revoked';

export interface InternetRemoteControlSession {
  sessionId: string;
  /** Opaque relay pairing id; null only when talking to a pre-upgrade sidecar. */
  pairingId: string | null;
  controllerId: string;
  controllerName: string;
  controllerKeyFingerprint: string;
  approvalState: InternetRemoteControlApprovalState;
  sasCode: string | null;
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  /** Explicitly granted on this Mac. Missing in an old sidecar means false. */
  taskScopeGranted: boolean;
  /** Retained conversation/history access is a separate, explicit grant. */
  conversationScopeGranted: boolean;
}

export interface InternetRemoteControlStatus {
  enabled: boolean;
  state: InternetRemoteControlState;
  controllerUrl: string | null;
  hostExpiresAt: string | null;
  pairingExpiresAt: string | null;
  lastRelayContactAt: string | null;
  sessions: InternetRemoteControlSession[];
  error: string | null;
}

export interface InternetRemoteControlPairingIssue {
  pairingUrl: string;
  expiresAt: string;
}

export interface InternetRemoteControlEnableResult {
  status: InternetRemoteControlStatus;
  pairing: InternetRemoteControlPairingIssue | null;
}

/**
 * The address to offer when the field would otherwise be blank.
 *
 * Turning this feature on begins with typing an HTTPS origin that lives nowhere
 * in the app — the user has to remember where their own portal is deployed.
 * That is the first step and it blocks everything after it, so the Mac
 * remembers the address that last worked and offers it back.
 */
export interface InternetRemoteControlStatusResponse {
  status: InternetRemoteControlStatus;
  suggestedControllerOrigin: string | null;
}

export class InternetRemoteControlContractError extends Error {
  readonly code = 'INTERNET_REMOTE_CONTROL_RESPONSE_INVALID';

  constructor(message = '외부 인터넷 원격제어 응답이 올바르지 않습니다.') {
    super(message);
    this.name = 'InternetRemoteControlContractError';
  }
}

type JsonObject = Record<string, unknown>;

const STATUS_KEYS = [
  'enabled',
  'state',
  'controllerUrl',
  'hostExpiresAt',
  'pairingExpiresAt',
  'lastRelayContactAt',
  'sessions',
  'error',
] as const;
const SESSION_KEYS = [
  'sessionId',
  'controllerId',
  'controllerName',
  'controllerKeyFingerprint',
  'approvalState',
  'sasCode',
  'createdAt',
  'expiresAt',
  'approvedAt',
] as const;
const PAIRING_KEYS = ['pairingUrl', 'expiresAt'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const STATES = new Set<InternetRemoteControlState>([
  'disabled', 'pairing', 'approval-required', 'online', 'degraded', 'offline',
]);
const APPROVAL_STATES = new Set<InternetRemoteControlApprovalState>(['pending', 'approved', 'revoked']);

function invalid(message?: string): never {
  throw new InternetRemoteControlContractError(message);
}

function asObject(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as JsonObject;
}

function hasExactKeys(value: JsonObject, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every(key => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every(key => allowed.has(key))
    && keys.length >= required.length
    && keys.length <= required.length + optional.length;
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) return invalid();
  return value;
}

function oneLine(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized
    && normalized.length <= maxLength
    && !/[\r\n\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}

function canonicalIso(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 32) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? value
    : null;
}

function nullableIso(value: unknown): string | null {
  if (value === null) return null;
  return canonicalIso(value) ?? invalid();
}

function exactControllerUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2_048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const origin = normalizeHttpsExactOrigin(url.origin);
  if (!origin
    || url.username
    || url.password
    || url.pathname !== '/remote/'
    || url.search
    || url.hash
    || url.toString() !== `${origin}/remote/`) return null;
  return url.toString();
}

export function normalizeInternetRemoteControllerOrigin(value: unknown): string {
  return normalizeHttpsExactOrigin(value)
    ?? invalid('외부 원격제어 주소는 경로·query·fragment가 없는 HTTPS origin이어야 합니다.');
}

function normalizeFingerprint(value: unknown): string {
  if (typeof value !== 'string') return invalid();
  let bytes: Uint8Array;
  try {
    bytes = decodeRemoteControlRelayBase64Url(value, 'controllerKeyFingerprint');
  } catch {
    return invalid();
  }
  if (bytes.byteLength !== 32) return invalid();
  return value;
}

function normalizeSession(value: unknown): InternetRemoteControlSession {
  const raw = asObject(value);
  if (!hasExactKeys(raw, SESSION_KEYS, [
    'pairingId', 'taskScopeGranted', 'conversationScopeGranted',
  ])
    || (raw.taskScopeGranted !== undefined && typeof raw.taskScopeGranted !== 'boolean')
    || (raw.conversationScopeGranted !== undefined
      && typeof raw.conversationScopeGranted !== 'boolean')) return invalid();
  if (typeof raw.approvalState !== 'string'
    || !APPROVAL_STATES.has(raw.approvalState as InternetRemoteControlApprovalState)) return invalid();
  const approvalState = raw.approvalState as InternetRemoteControlApprovalState;
  const sasCode = raw.sasCode === null
    ? null
    : typeof raw.sasCode === 'string' && /^\d{6}$/u.test(raw.sasCode)
      ? raw.sasCode
      : invalid();
  if ((approvalState === 'pending') !== (sasCode !== null)) return invalid();
  const controllerName = oneLine(raw.controllerName, 80);
  const createdAt = canonicalIso(raw.createdAt);
  const expiresAt = canonicalIso(raw.expiresAt);
  if (!controllerName || !createdAt || !expiresAt || Date.parse(expiresAt) <= Date.parse(createdAt)) return invalid();
  return {
    sessionId: uuid(raw.sessionId),
    pairingId: raw.pairingId === undefined || raw.pairingId === null
      ? null
      : uuid(raw.pairingId),
    controllerId: uuid(raw.controllerId),
    controllerName,
    controllerKeyFingerprint: normalizeFingerprint(raw.controllerKeyFingerprint),
    approvalState,
    sasCode,
    createdAt,
    expiresAt,
    approvedAt: nullableIso(raw.approvedAt),
    taskScopeGranted: raw.taskScopeGranted === true,
    conversationScopeGranted: raw.conversationScopeGranted === true,
  };
}

export function normalizeInternetRemoteControlStatus(value: unknown): InternetRemoteControlStatus {
  const raw = asObject(value);
  if (!hasExactKeys(raw, STATUS_KEYS)
    || typeof raw.enabled !== 'boolean'
    || typeof raw.state !== 'string'
    || !STATES.has(raw.state as InternetRemoteControlState)
    || !Array.isArray(raw.sessions)
    || raw.sessions.length > 64) return invalid();

  const state = raw.state as InternetRemoteControlState;
  if (raw.enabled !== (state !== 'disabled')) return invalid();
  const controllerUrl = raw.controllerUrl === null ? null : exactControllerUrl(raw.controllerUrl) ?? invalid();
  const hostExpiresAt = nullableIso(raw.hostExpiresAt);
  const pairingExpiresAt = nullableIso(raw.pairingExpiresAt);
  const lastRelayContactAt = nullableIso(raw.lastRelayContactAt);
  const error = raw.error === null ? null : oneLine(raw.error, 500) ?? invalid();
  if (raw.enabled !== Boolean(controllerUrl && hostExpiresAt)) return invalid();

  const sessions = raw.sessions.map(normalizeSession);
  if (new Set(sessions.map(session => session.sessionId)).size !== sessions.length) return invalid();
  return {
    enabled: raw.enabled,
    state,
    controllerUrl,
    hostExpiresAt,
    pairingExpiresAt,
    lastRelayContactAt,
    sessions,
    error,
  };
}

function normalizePairing(value: unknown, status: InternetRemoteControlStatus): InternetRemoteControlPairingIssue {
  const raw = asObject(value);
  if (!hasExactKeys(raw, PAIRING_KEYS)
    || typeof raw.pairingUrl !== 'string'
    || raw.pairingUrl.length > 4_096) return invalid();
  const expiresAt = canonicalIso(raw.expiresAt) ?? invalid();
  try {
    const parsed = parseRemoteControlRelayPairingUrl(raw.pairingUrl);
    if (parsed.bootstrap.expiresAt !== expiresAt
      || status.pairingExpiresAt !== expiresAt
      || parsed.controllerUrl !== status.controllerUrl) return invalid();
  } catch {
    return invalid();
  }
  return { pairingUrl: raw.pairingUrl, expiresAt };
}

export function normalizeInternetRemoteControlStatusResponse(value: unknown): InternetRemoteControlStatus {
  return normalizeInternetRemoteControlStatusEnvelope(value).status;
}

export function normalizeInternetRemoteControlStatusEnvelope(
  value: unknown,
): InternetRemoteControlStatusResponse {
  const raw = asObject(value);
  if (!hasExactKeys(raw, ['status'], ['suggestedControllerOrigin'])) return invalid();
  // A bad suggestion must not fail the whole status read — the panel still has
  // to render so the user can type an address themselves.
  const suggested = typeof raw.suggestedControllerOrigin === 'string'
    ? normalizeHttpsExactOrigin(raw.suggestedControllerOrigin)
    : null;
  return {
    status: normalizeInternetRemoteControlStatus(raw.status),
    suggestedControllerOrigin: suggested,
  };
}

export function normalizeInternetRemoteControlEnableResponse(value: unknown): InternetRemoteControlEnableResult {
  const raw = asObject(value);
  if (!hasExactKeys(raw, ['status'], ['pairing'])) return invalid();
  const status = normalizeInternetRemoteControlStatus(raw.status);
  if (!status.enabled) return invalid();
  const pairing = raw.pairing === undefined || raw.pairing === null
    ? null
    : normalizePairing(raw.pairing, status);
  return { status, pairing };
}

export function isInternetRemoteControlExpired(expiresAt: string, now = Date.now()): boolean {
  const timestamp = Date.parse(expiresAt);
  return !Number.isFinite(timestamp) || !Number.isFinite(now) || timestamp <= now;
}

export function formatInternetRemoteControlRemaining(expiresAt: string, now = Date.now()): string {
  const remainingSeconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1_000));
  if (remainingSeconds >= 24 * 60 * 60) {
    // 30일짜리 QR을 "719시간 59분"으로 적으면 읽을 수 없다.
    const days = Math.floor(remainingSeconds / (24 * 60 * 60));
    const hours = Math.floor((remainingSeconds % (24 * 60 * 60)) / (60 * 60));
    return `${days}일 ${hours}시간`;
  }
  if (remainingSeconds >= 60 * 60) {
    const hours = Math.floor(remainingSeconds / (60 * 60));
    const minutes = Math.floor((remainingSeconds % (60 * 60)) / 60);
    return `${hours}시간 ${minutes}분`;
  }
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
