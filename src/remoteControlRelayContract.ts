export const REMOTE_CONTROL_RELAY_SCHEMA_VERSION = 1 as const;
export const REMOTE_CONTROL_RELAY_PROTOCOL_VERSION = 'agentstoz-relay-v1' as const;
export const REMOTE_CONTROL_RELAY_MAX_ENVELOPE_BYTES = 16 * 1024;
export const REMOTE_CONTROL_RELAY_NONCE_BYTES = 12;
export const REMOTE_CONTROL_RELAY_AUTH_TAG_BYTES = 16;
export const REMOTE_CONTROL_RELAY_PAIRING_SECRET_BYTES = 32;
export const REMOTE_CONTROL_RELAY_P256_PUBLIC_KEY_BYTES = 65;
export const REMOTE_CONTROL_RELAY_CONTROLLER_PATH = '/remote/' as const;
export const REMOTE_CONTROL_RELAY_PAIRING_FRAGMENT_KEY = 'pair' as const;
/**
 * QR 자체의 유효기간. 승인된 세션과 같은 30일이다 — 승인 전 QR만 24시간이면
 * 화면의 두 숫자가 서로 다른 것을 재는데도 같은 것을 재는 것처럼 읽혔다
 * (VOC 2026-09-01 "30일로 안되어있는데?"). QR은 여전히 1회용이고, 스캔한 뒤에도
 * Mac에서 6자리 코드가 일치해야만 승인된다 — 유효기간이 늘어도 이 관문은 그대로다.
 * ⚠️ 실제 만료 시각은 서버(`portmgr_remote_control_create_pairing`)가 정한다.
 * 이 상수만 바꾸면 아무것도 바뀌지 않는다.
 */
export const REMOTE_CONTROL_RELAY_PAIRING_TTL_MS = 30 * 24 * 60 * 60_000;
export const REMOTE_CONTROL_RELAY_AAD_DOMAIN = 'agentstoz.remote-control.relay/aad/v1' as const;

const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const ENVELOPE_KEYS = [
  'schemaVersion',
  'messageId',
  'sessionId',
  'controllerId',
  'sequence',
  'expiresAt',
  'nonce',
  'ciphertext',
] as const;
const METADATA_KEYS = ENVELOPE_KEYS.slice(0, 6);
const PAIRING_BOOTSTRAP_KEYS = [
  'schemaVersion',
  'hostId',
  'pairingId',
  'pairingSecret',
  'hostPublicKey',
  'expiresAt',
] as const;
const MAX_PAIRING_BOOTSTRAP_BYTES = 2 * 1024;
const MAX_PAIRING_URL_LENGTH = 4 * 1024;
const MAX_RECENT_MESSAGE_IDS = 256;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export interface RemoteControlRelayEnvelopeMetadata {
  schemaVersion: typeof REMOTE_CONTROL_RELAY_SCHEMA_VERSION;
  messageId: string;
  sessionId: string;
  controllerId: string;
  sequence: number;
  expiresAt: string;
}

/**
 * This is the complete relay-visible message. Project identity, display names,
 * process actions, paths, commands, and responses belong only in `ciphertext`.
 */
export interface RemoteControlRelayEnvelope extends RemoteControlRelayEnvelopeMetadata {
  nonce: string;
  ciphertext: string;
}

/**
 * The pairing secret and host public key may appear only in this one-use,
 * 24-hour bootstrap. The encoded bootstrap is carried in a URL
 * fragment so a hosting provider or relay never receives it in an HTTP request.
 * The pairing service must still hash and atomically consume `pairingSecret`.
 */
export interface RemoteControlRelayPairingBootstrap {
  schemaVersion: typeof REMOTE_CONTROL_RELAY_SCHEMA_VERSION;
  hostId: string;
  pairingId: string;
  pairingSecret: string;
  hostPublicKey: string;
  expiresAt: string;
}

export interface RemoteControlRelayParsedPairingUrl {
  controllerUrl: string;
  bootstrap: RemoteControlRelayPairingBootstrap;
}

export interface RemoteControlRelayReceiveCursor {
  sessionId: string;
  controllerId: string;
  highestSequence: number;
  recentMessageIds: readonly string[];
}

export type RemoteControlRelayReceiveDecision =
  | { ok: true; cursor: RemoteControlRelayReceiveCursor }
  | {
      ok: false;
      reason: 'expired' | 'identity-mismatch' | 'message-replay' | 'stale-sequence' | 'sequence-gap' | 'sequence-exhausted';
    };

export class RemoteControlRelayContractError extends Error {
  constructor(
    readonly code: string,
    message = '외부 원격제어 릴레이 메시지가 올바르지 않습니다.',
  ) {
    super(message);
    this.name = 'RemoteControlRelayContractError';
  }
}

type JsonObject = Record<string, unknown>;

function invalid(code: string, message?: string): never {
  throw new RemoteControlRelayContractError(code, message);
}

function asObject(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid('INVALID_ENVELOPE');
  }
  return value as JsonObject;
}

function hasExactKeys(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function utf8Length(value: string): number {
  return textEncoder.encode(value).byteLength;
}

export function normalizeRemoteControlRelayId(value: unknown, field = 'identifier'): string {
  if (typeof value !== 'string' || !OPAQUE_ID_RE.test(value)) {
    return invalid('INVALID_IDENTIFIER', `${field}가 올바르지 않습니다.`);
  }
  return value;
}

function normalizeSequence(value: unknown): number {
  if (typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 1) {
    return invalid('INVALID_SEQUENCE', '릴레이 순번이 올바르지 않습니다.');
  }
  return value;
}

function normalizeHighestSequence(value: unknown): number {
  if (typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0) {
    return invalid('INVALID_SEQUENCE', '수신 순번이 올바르지 않습니다.');
  }
  return value;
}

export function normalizeRemoteControlRelayExpiry(value: unknown): string {
  if (typeof value !== 'string' || value.length > 32) {
    return invalid('INVALID_EXPIRY', '릴레이 만료 시각이 올바르지 않습니다.');
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    return invalid('INVALID_EXPIRY', '릴레이 만료 시각은 정규 UTC ISO 형식이어야 합니다.');
  }
  return value;
}

export function encodeRemoteControlRelayBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

export function decodeRemoteControlRelayBase64Url(value: unknown, field = 'base64url'): Uint8Array {
  if (typeof value !== 'string'
    || !BASE64URL_RE.test(value)
    || value.length % 4 === 1
    || value.length > REMOTE_CONTROL_RELAY_MAX_ENVELOPE_BYTES) {
    return invalid('INVALID_BASE64URL', `${field}가 정규 base64url 형식이 아닙니다.`);
  }
  let binary: string;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
    binary = atob(padded);
  } catch {
    return invalid('INVALID_BASE64URL', `${field}가 정규 base64url 형식이 아닙니다.`);
  }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (encodeRemoteControlRelayBase64Url(bytes) !== value) {
    return invalid('INVALID_BASE64URL', `${field}가 정규 base64url 형식이 아닙니다.`);
  }
  return bytes;
}

function normalizeMetadataFields(raw: JsonObject): RemoteControlRelayEnvelopeMetadata {
  if (raw.schemaVersion !== REMOTE_CONTROL_RELAY_SCHEMA_VERSION) {
    return invalid('UNSUPPORTED_SCHEMA', '지원하지 않는 릴레이 스키마입니다.');
  }
  return {
    schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
    messageId: normalizeRemoteControlRelayId(raw.messageId, 'messageId'),
    sessionId: normalizeRemoteControlRelayId(raw.sessionId, 'sessionId'),
    controllerId: normalizeRemoteControlRelayId(raw.controllerId, 'controllerId'),
    sequence: normalizeSequence(raw.sequence),
    expiresAt: normalizeRemoteControlRelayExpiry(raw.expiresAt),
  };
}

export function parseRemoteControlRelayEnvelopeMetadata(value: unknown): RemoteControlRelayEnvelopeMetadata {
  const raw = asObject(value);
  if (!hasExactKeys(raw, METADATA_KEYS)) return invalid('INVALID_METADATA');
  return normalizeMetadataFields(raw);
}

function metadataFrom(value: RemoteControlRelayEnvelopeMetadata): RemoteControlRelayEnvelopeMetadata {
  return normalizeMetadataFields(asObject(value));
}

export function canonicalRemoteControlRelayAadText(value: RemoteControlRelayEnvelopeMetadata): string {
  const metadata = metadataFrom(value);
  return `${REMOTE_CONTROL_RELAY_AAD_DOMAIN}\n${JSON.stringify({
    schemaVersion: metadata.schemaVersion,
    messageId: metadata.messageId,
    sessionId: metadata.sessionId,
    controllerId: metadata.controllerId,
    sequence: metadata.sequence,
    expiresAt: metadata.expiresAt,
  })}`;
}

export function canonicalRemoteControlRelayAad(value: RemoteControlRelayEnvelopeMetadata): Uint8Array {
  return textEncoder.encode(canonicalRemoteControlRelayAadText(value));
}

function canonicalEnvelopeJson(envelope: RemoteControlRelayEnvelope): string {
  return JSON.stringify({
    schemaVersion: envelope.schemaVersion,
    messageId: envelope.messageId,
    sessionId: envelope.sessionId,
    controllerId: envelope.controllerId,
    sequence: envelope.sequence,
    expiresAt: envelope.expiresAt,
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
  });
}

export function parseRemoteControlRelayEnvelope(value: unknown): RemoteControlRelayEnvelope {
  const raw = asObject(value);
  if (!hasExactKeys(raw, ENVELOPE_KEYS)) return invalid('INVALID_ENVELOPE');
  const metadata = normalizeMetadataFields(raw);
  const nonce = decodeRemoteControlRelayBase64Url(raw.nonce, 'nonce');
  if (nonce.byteLength !== REMOTE_CONTROL_RELAY_NONCE_BYTES) {
    return invalid('INVALID_NONCE', 'AES-GCM nonce는 정확히 96비트여야 합니다.');
  }
  const ciphertext = decodeRemoteControlRelayBase64Url(raw.ciphertext, 'ciphertext');
  if (ciphertext.byteLength < REMOTE_CONTROL_RELAY_AUTH_TAG_BYTES) {
    return invalid('INVALID_CIPHERTEXT', 'AES-GCM 인증 태그가 없는 암호문입니다.');
  }
  const envelope: RemoteControlRelayEnvelope = {
    ...metadata,
    nonce: raw.nonce as string,
    ciphertext: raw.ciphertext as string,
  };
  if (utf8Length(canonicalEnvelopeJson(envelope)) > REMOTE_CONTROL_RELAY_MAX_ENVELOPE_BYTES) {
    return invalid('ENVELOPE_TOO_LARGE', '릴레이 메시지는 16KiB를 넘을 수 없습니다.');
  }
  return envelope;
}

export function parseRemoteControlRelayEnvelopeJson(raw: string): RemoteControlRelayEnvelope {
  if (typeof raw !== 'string' || utf8Length(raw) > REMOTE_CONTROL_RELAY_MAX_ENVELOPE_BYTES) {
    return invalid('ENVELOPE_TOO_LARGE', '릴레이 메시지는 16KiB를 넘을 수 없습니다.');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalid('INVALID_JSON', '릴레이 JSON이 올바르지 않습니다.');
  }
  return parseRemoteControlRelayEnvelope(value);
}

export function serializeRemoteControlRelayEnvelope(value: unknown): string {
  return canonicalEnvelopeJson(parseRemoteControlRelayEnvelope(value));
}

export function isRemoteControlRelayExpired(
  value: Pick<RemoteControlRelayEnvelopeMetadata, 'expiresAt'>,
  now = Date.now(),
): boolean {
  const expiresAt = normalizeRemoteControlRelayExpiry(value.expiresAt);
  return !Number.isFinite(now) || Date.parse(expiresAt) <= now;
}

export function isRemoteControlRelayPairingExpired(
  value: Pick<RemoteControlRelayPairingBootstrap, 'expiresAt'>,
  now = Date.now(),
): boolean {
  return isRemoteControlRelayExpired(value, now);
}

export function createRemoteControlRelayReceiveCursor(
  sessionId: string,
  controllerId: string,
  highestSequence = 0,
): RemoteControlRelayReceiveCursor {
  return {
    sessionId: normalizeRemoteControlRelayId(sessionId, 'sessionId'),
    controllerId: normalizeRemoteControlRelayId(controllerId, 'controllerId'),
    highestSequence: normalizeHighestSequence(highestSequence),
    recentMessageIds: [],
  };
}

function normalizeReceiveCursor(value: RemoteControlRelayReceiveCursor): RemoteControlRelayReceiveCursor {
  const sessionId = normalizeRemoteControlRelayId(value.sessionId, 'sessionId');
  const controllerId = normalizeRemoteControlRelayId(value.controllerId, 'controllerId');
  const highestSequence = normalizeHighestSequence(value.highestSequence);
  if (!Array.isArray(value.recentMessageIds)
    || value.recentMessageIds.length > MAX_RECENT_MESSAGE_IDS) {
    return invalid('INVALID_REPLAY_CURSOR');
  }
  const recentMessageIds = value.recentMessageIds.map(messageId => normalizeRemoteControlRelayId(messageId, 'messageId'));
  if (new Set(recentMessageIds).size !== recentMessageIds.length) {
    return invalid('INVALID_REPLAY_CURSOR');
  }
  return { sessionId, controllerId, highestSequence, recentMessageIds };
}

/**
 * Pure fail-closed receive-window transition. Delivery is accepted only in
 * contiguous order; retries, reordering, cross-session messages, and expiry do
 * not advance the cursor. Persist the returned cursor before dispatching an
 * irreversible local action.
 */
export function acceptRemoteControlRelayEnvelope(
  value: unknown,
  current: RemoteControlRelayReceiveCursor,
  now = Date.now(),
): RemoteControlRelayReceiveDecision {
  const envelope = parseRemoteControlRelayEnvelope(value);
  const cursor = normalizeReceiveCursor(current);
  if (isRemoteControlRelayExpired(envelope, now)) return { ok: false, reason: 'expired' };
  if (envelope.sessionId !== cursor.sessionId || envelope.controllerId !== cursor.controllerId) {
    return { ok: false, reason: 'identity-mismatch' };
  }
  if (cursor.recentMessageIds.includes(envelope.messageId)) {
    return { ok: false, reason: 'message-replay' };
  }
  if (cursor.highestSequence === Number.MAX_SAFE_INTEGER) return { ok: false, reason: 'sequence-exhausted' };
  if (envelope.sequence <= cursor.highestSequence) return { ok: false, reason: 'stale-sequence' };
  if (envelope.sequence !== cursor.highestSequence + 1) return { ok: false, reason: 'sequence-gap' };
  return {
    ok: true,
    cursor: {
      sessionId: cursor.sessionId,
      controllerId: cursor.controllerId,
      highestSequence: envelope.sequence,
      recentMessageIds: [...cursor.recentMessageIds, envelope.messageId].slice(-MAX_RECENT_MESSAGE_IDS),
    },
  };
}

function normalizePairingBootstrap(value: unknown): RemoteControlRelayPairingBootstrap {
  const raw = asObject(value);
  if (!hasExactKeys(raw, PAIRING_BOOTSTRAP_KEYS)) return invalid('INVALID_PAIRING_BOOTSTRAP');
  if (raw.schemaVersion !== REMOTE_CONTROL_RELAY_SCHEMA_VERSION) {
    return invalid('UNSUPPORTED_SCHEMA', '지원하지 않는 QR 연결 스키마입니다.');
  }
  const pairingSecret = decodeRemoteControlRelayBase64Url(raw.pairingSecret, 'pairingSecret');
  if (pairingSecret.byteLength !== REMOTE_CONTROL_RELAY_PAIRING_SECRET_BYTES) {
    return invalid('INVALID_PAIRING_SECRET', '일회용 QR 연결 비밀은 정확히 256비트여야 합니다.');
  }
  const hostPublicKey = decodeRemoteControlRelayBase64Url(raw.hostPublicKey, 'hostPublicKey');
  if (hostPublicKey.byteLength !== REMOTE_CONTROL_RELAY_P256_PUBLIC_KEY_BYTES || hostPublicKey[0] !== 0x04) {
    return invalid('INVALID_PUBLIC_KEY', '호스트 P-256 공개키가 올바르지 않습니다.');
  }
  return {
    schemaVersion: REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
    hostId: normalizeRemoteControlRelayId(raw.hostId, 'hostId'),
    pairingId: normalizeRemoteControlRelayId(raw.pairingId, 'pairingId'),
    pairingSecret: raw.pairingSecret as string,
    hostPublicKey: raw.hostPublicKey as string,
    expiresAt: normalizeRemoteControlRelayExpiry(raw.expiresAt),
  };
}

function canonicalPairingBootstrapJson(value: unknown): string {
  const bootstrap = normalizePairingBootstrap(value);
  return JSON.stringify({
    schemaVersion: bootstrap.schemaVersion,
    hostId: bootstrap.hostId,
    pairingId: bootstrap.pairingId,
    pairingSecret: bootstrap.pairingSecret,
    hostPublicKey: bootstrap.hostPublicKey,
    expiresAt: bootstrap.expiresAt,
  });
}

function normalizeControllerUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid('INVALID_CONTROLLER_URL', '원격제어 웹 주소가 올바르지 않습니다.');
  }
  if (url.protocol !== 'https:'
    || url.username
    || url.password
    || url.pathname !== REMOTE_CONTROL_RELAY_CONTROLLER_PATH
    || url.search
    || url.hash) {
    return invalid('INVALID_CONTROLLER_URL', '외부 원격제어 주소는 자격증명·query가 없는 HTTPS /remote/ 주소여야 합니다.');
  }
  return url;
}

export function buildRemoteControlRelayPairingUrl(
  controllerUrl: string,
  value: RemoteControlRelayPairingBootstrap,
): string {
  const url = normalizeControllerUrl(controllerUrl);
  const json = canonicalPairingBootstrapJson(value);
  if (utf8Length(json) > MAX_PAIRING_BOOTSTRAP_BYTES) return invalid('PAIRING_BOOTSTRAP_TOO_LARGE');
  url.hash = `${REMOTE_CONTROL_RELAY_PAIRING_FRAGMENT_KEY}=${encodeRemoteControlRelayBase64Url(textEncoder.encode(json))}`;
  const pairingUrl = url.toString();
  if (pairingUrl.length > MAX_PAIRING_URL_LENGTH) return invalid('PAIRING_URL_TOO_LARGE');
  return pairingUrl;
}

export function parseRemoteControlRelayPairingUrl(value: string): RemoteControlRelayParsedPairingUrl {
  if (typeof value !== 'string' || value.length > MAX_PAIRING_URL_LENGTH) {
    return invalid('PAIRING_URL_TOO_LARGE');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid('INVALID_CONTROLLER_URL');
  }
  const match = url.hash.match(/^#pair=([A-Za-z0-9_-]+)$/u);
  if (!match) return invalid('INVALID_PAIRING_FRAGMENT');
  url.hash = '';
  const controllerUrl = normalizeControllerUrl(url.toString()).toString();
  const jsonBytes = decodeRemoteControlRelayBase64Url(match[1], 'pairing fragment');
  if (jsonBytes.byteLength > MAX_PAIRING_BOOTSTRAP_BYTES) return invalid('PAIRING_BOOTSTRAP_TOO_LARGE');
  let decoded: unknown;
  try {
    decoded = JSON.parse(textDecoder.decode(jsonBytes));
  } catch {
    return invalid('INVALID_PAIRING_BOOTSTRAP');
  }
  return { controllerUrl, bootstrap: normalizePairingBootstrap(decoded) };
}
