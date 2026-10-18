import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { REMOTE_CONTROL_MAX_SESSIONS } from './remoteControlProtocol';
import type { RemoteControlRelayReceiveCursor } from './remoteControlRelayContract';
import {
  REMOTE_CONTROL_CONVERSATION_SCOPE,
  type RemoteControlConversationScope,
} from './remoteControlConversationProtocol';
import {
  REMOTE_CONTROL_TASK_SCOPE,
  type RemoteControlTaskScope,
} from './remoteControlTaskProtocol';

export type RemoteControlGrantedScope = RemoteControlTaskScope | RemoteControlConversationScope;

/**
 * The Mac's internet remote-control identity, written down so a restart does not
 * become a new host.
 *
 * ⚠️ Why this file has to exist at all: the agent used to mint `hostId`,
 * `hostSecret` and its key pair in the constructor, and `/enable` was reachable
 * only from a button. Every app restart — every update install — therefore
 * replaced the Mac with a *different* host, while Supabase still held the
 * 30-day pairing and an approved session. The phone showed a device
 * authenticated until its expiry date that nothing ever answered, and the only
 * way out was scanning a new QR.
 *
 * ⚠️ Security trade-off, stated plainly: the host private scalar now rests on
 * disk. Before, it lived only in process memory. It is written 0600 into the app
 * data directory — the same directory that already holds `supabase-service.json`,
 * whose service_role key grants full database access and is therefore strictly
 * more powerful. Reading this file lets an attacker impersonate the Mac to
 * already-paired phones; it does not by itself let them run anything, because
 * every action still crosses the relay and the phone's own approved session.
 * A Keychain/DPAPI-sealed variant was considered and rejected for now because
 * that provider fails closed on Linux, which would remove internet remote
 * control from the AWS Ubuntu hosts that have it today.
 */
export const REMOTE_CONTROL_HOST_RECORD_VERSION = 1 as const;
export const REMOTE_CONTROL_HOST_RECORD_FILENAME = 'remote-control-host.json';
export const REMOTE_CONTROL_HOST_DISABLED_FILENAME = 'remote-control-host.disabled';

/** Envelope ordering is strict (`sequence === highest + 1`) in both directions,
 *  so a resumed session has to continue its counters, not restart them. */
export interface RemoteControlHostSessionRecord {
  sessionId: string;
  controllerId: string;
  sendSequence: number;
  receiveCursor: RemoteControlRelayReceiveCursor;
  /**
   * Optional for schema-v1 compatibility. Absence means no semantic runtime
   * authority; upgrading an existing host must never grant a new scope.
   */
  scopes?: RemoteControlGrantedScope[];
}

export interface RemoteControlHostRecord {
  schemaVersion: typeof REMOTE_CONTROL_HOST_RECORD_VERSION;
  hostId: string;
  hostSecret: string;
  /** base64url JWK `d`. Re-imported as a non-extractable key. */
  hostPrivateScalar: string;
  hostPublicKey: string;
  hostName: string;
  controllerOrigin: string;
  pairingId: string;
  pairingExpiresAt: string | null;
  hostExpiresAt: string | null;
  /** Newest last, matching the agent's own ordering. */
  pairingSecrets: string[];
  /** Pairing ids aligned with `pairingSecrets`; absent in older schema-v1 files. */
  pairingIds?: Array<string | null>;
  /**
   * Host-level relay delivery cursor. Without it a resumed host re-reads
   * envelopes the previous process already consumed, and every one of them is
   * rejected as a stale sequence — which looks exactly like a broken session.
   */
  relayCursor: string;
  sessions: RemoteControlHostSessionRecord[];
  /** Local-first revocations awaiting confirmation from the relay. */
  revokedSessions?: Array<{ sessionId: string; revokedAt: string }>;
}

const OPAQUE_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_PAIRING_SECRETS = 16;
const MAX_RECENT_MESSAGE_IDS = 256;

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

function isoOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? value : undefined;
}

function sequence(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function cursor(value: unknown, sessionId: string, controllerId: string): RemoteControlRelayReceiveCursor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.sessionId !== sessionId || raw.controllerId !== controllerId) return null;
  const highestSequence = sequence(raw.highestSequence);
  if (highestSequence === null) return null;
  if (!Array.isArray(raw.recentMessageIds) || raw.recentMessageIds.length > MAX_RECENT_MESSAGE_IDS) return null;
  const recentMessageIds: string[] = [];
  for (const messageId of raw.recentMessageIds) {
    const id = text(messageId, 128);
    if (!id || !OPAQUE_ID_RE.test(id)) return null;
    recentMessageIds.push(id);
  }
  if (new Set(recentMessageIds).size !== recentMessageIds.length) return null;
  return { sessionId, controllerId, highestSequence, recentMessageIds };
}

/**
 * Fail closed: anything unreadable returns null and the caller starts a fresh
 * host. A half-restored host is worse than an honest re-pair — it would answer
 * with keys or counters that no phone agrees with.
 */
export function normalizeRemoteControlHostRecord(value: unknown): RemoteControlHostRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== REMOTE_CONTROL_HOST_RECORD_VERSION) return null;

  const hostId = text(raw.hostId, 128);
  const hostSecret = text(raw.hostSecret, 64);
  const hostPrivateScalar = text(raw.hostPrivateScalar, 128);
  const hostPublicKey = text(raw.hostPublicKey, 256);
  const hostName = text(raw.hostName, 80);
  const controllerOrigin = text(raw.controllerOrigin, 512);
  const pairingId = text(raw.pairingId, 128);
  if (!hostId || !OPAQUE_ID_RE.test(hostId)) return null;
  if (!hostSecret || !SECRET_RE.test(hostSecret)) return null;
  if (!hostPrivateScalar || !hostPublicKey || !hostName || !controllerOrigin) return null;
  if (!pairingId || !OPAQUE_ID_RE.test(pairingId)) return null;

  const pairingExpiresAt = isoOrNull(raw.pairingExpiresAt);
  const hostExpiresAt = isoOrNull(raw.hostExpiresAt);
  if (pairingExpiresAt === undefined || hostExpiresAt === undefined) return null;

  if (!Array.isArray(raw.pairingSecrets) || raw.pairingSecrets.length > MAX_PAIRING_SECRETS) return null;
  const pairingSecrets: string[] = [];
  for (const secret of raw.pairingSecrets) {
    const value = text(secret, 64);
    if (!value || !SECRET_RE.test(value)) return null;
    pairingSecrets.push(value);
  }
  if (pairingSecrets.length === 0) return null;

  const pairingIds: Array<string | null> = [];
  if (raw.pairingIds === undefined) {
    // Backward compatibility: old records retained only the newest id. Keep
    // the host/session identity; unknown old QR ids simply cannot create a new
    // SAS after restart and must be reissued.
    for (let index = 0; index < pairingSecrets.length; index += 1) {
      pairingIds.push(index === pairingSecrets.length - 1 ? pairingId : null);
    }
  } else {
    if (!Array.isArray(raw.pairingIds) || raw.pairingIds.length !== pairingSecrets.length) return null;
    for (const rawPairingId of raw.pairingIds) {
      if (rawPairingId === null) {
        pairingIds.push(null);
        continue;
      }
      const value = text(rawPairingId, 128);
      if (!value || !OPAQUE_ID_RE.test(value)) return null;
      pairingIds.push(value);
    }
  }

  const relayCursor = text(raw.relayCursor, 32);
  if (!relayCursor || !/^\d{1,20}$/.test(relayCursor)) return null;

  if (!Array.isArray(raw.sessions) || raw.sessions.length > REMOTE_CONTROL_MAX_SESSIONS) return null;
  const sessions: RemoteControlHostSessionRecord[] = [];
  for (const entry of raw.sessions) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const session = entry as Record<string, unknown>;
    const sessionId = text(session.sessionId, 128);
    const controllerId = text(session.controllerId, 128);
    if (!sessionId || !OPAQUE_ID_RE.test(sessionId)) return null;
    if (!controllerId || !OPAQUE_ID_RE.test(controllerId)) return null;
    const sendSequence = sequence(session.sendSequence);
    if (sendSequence === null) return null;
    const receiveCursor = cursor(session.receiveCursor, sessionId, controllerId);
    if (!receiveCursor) return null;
    let scopes: RemoteControlGrantedScope[] = [];
    if (session.scopes !== undefined) {
      if (!Array.isArray(session.scopes)
        || session.scopes.some(scope => (
          scope !== REMOTE_CONTROL_TASK_SCOPE && scope !== REMOTE_CONTROL_CONVERSATION_SCOPE
        ))
        || new Set(session.scopes).size !== session.scopes.length) return null;
      scopes = [...session.scopes] as RemoteControlGrantedScope[];
    }
    sessions.push({ sessionId, controllerId, sendSequence, receiveCursor, scopes });
  }
  if (new Set(sessions.map(session => session.sessionId)).size !== sessions.length) return null;

  const revokedSessions: Array<{ sessionId: string; revokedAt: string }> = [];
  if (raw.revokedSessions !== undefined) {
    if (!Array.isArray(raw.revokedSessions)
      || raw.revokedSessions.length > REMOTE_CONTROL_MAX_SESSIONS) return null;
    for (const entry of raw.revokedSessions) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const revoked = entry as Record<string, unknown>;
      const sessionId = text(revoked.sessionId, 128);
      const revokedAt = isoOrNull(revoked.revokedAt);
      if (!sessionId || !OPAQUE_ID_RE.test(sessionId) || typeof revokedAt !== 'string') return null;
      revokedSessions.push({ sessionId, revokedAt });
    }
    if (new Set(revokedSessions.map(entry => entry.sessionId)).size !== revokedSessions.length) return null;
  }

  return {
    schemaVersion: REMOTE_CONTROL_HOST_RECORD_VERSION,
    hostId,
    hostSecret,
    hostPrivateScalar,
    hostPublicKey,
    hostName,
    controllerOrigin,
    pairingId,
    pairingExpiresAt,
    hostExpiresAt,
    pairingSecrets,
    pairingIds,
    relayCursor,
    sessions,
    ...(raw.revokedSessions === undefined ? {} : { revokedSessions }),
  };
}

export function remoteControlHostRecordPath(appDataDir: string): string {
  return join(appDataDir, REMOTE_CONTROL_HOST_RECORD_FILENAME);
}

export function remoteControlHostDisabledPath(appDataDir: string): string {
  return join(appDataDir, REMOTE_CONTROL_HOST_DISABLED_FILENAME);
}

function isMissingPath(error: unknown): boolean {
  return !!error && typeof error === 'object'
    && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

/**
 * Read a private record without a TOCTOU window: open the object itself with O_NOFOLLOW, then
 * validate the inode that was actually opened. Exported alongside the write path so a second
 * transport cannot accidentally ship a weaker reader — a path-only lstat/read pair looks correct
 * and is not.
 */
export function readPrivateFileStrict(path: string): string | null {
  let descriptor: number | null = null;
  try {
    if (!existsSync(path)) return null;
    descriptor = openSync(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return null;
    if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.nlink !== 1)) return null;
    return readFileSync(descriptor, 'utf8');
  } catch {
    return null;
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* already closed or invalid */ }
    }
  }
}

/** Any entry at all counts, symlink or not — a dangling link must still disable. */
export function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

/** Any tombstone entry blocks restore. An unreadable or malformed marker is
 * still a fail-closed local disable decision, never permission to revive. */
export function isRemoteControlHostLocallyDisabled(appDataDir: string): boolean {
  try {
    return pathEntryExists(remoteControlHostDisabledPath(appDataDir));
  } catch {
    return true;
  }
}

function fsyncAppDataDirectory(appDataDir: string): void {
  if (process.platform === 'win32') return;
  const descriptor = openSync(appDataDir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * The canonical 0600 atomic write for anything in the app data directory that is a credential.
 * Exported so a second transport reuses this rather than growing its own copy: the O_EXCL,
 * O_NOFOLLOW, mode and nlink checks here are the whole point, and they are easy to omit by accident.
 */
export function writePrivateFileAtomically(appDataDir: string, path: string, content: string): void {
  mkdirSync(appDataDir, { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
      0o600,
    );
    const stat = fstatSync(descriptor);
    if (!stat.isFile()
      || (process.platform !== 'win32'
        && ((stat.mode & 0o077) !== 0 || stat.nlink !== 1))) {
      throw new Error('REMOTE_CONTROL_PRIVATE_FILE_TEMP_UNSAFE');
    }
    writeFileSync(descriptor, content, { encoding: 'utf8' });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
    fsyncAppDataDirectory(appDataDir);
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* already closed or invalid */ }
    }
    try { unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
}

/** Deletion that refuses to report success while the file is still there. */
export function unlinkPrivateFileStrict(appDataDir: string, path: string): boolean {
  let removed = false;
  try {
    unlinkSync(path);
    removed = true;
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
  if (pathEntryExists(path)) throw new Error('REMOTE_CONTROL_PRIVATE_FILE_DELETE_FAILED');
  if (removed) fsyncAppDataDirectory(appDataDir);
  return removed;
}

export function readRemoteControlHostRecord(appDataDir: string): RemoteControlHostRecord | null {
  if (isRemoteControlHostLocallyDisabled(appDataDir)) return null;
  const path = remoteControlHostRecordPath(appDataDir);
  let descriptor: number | null = null;
  try {
    if (!existsSync(path)) return null;
    // Open the object itself without following a last-component symlink, then
    // validate the exact opened inode. A path-only lstat/read pair has a TOCTOU
    // window where an attacker can swap in a link between the two operations.
    descriptor = openSync(
      path,
      constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    );
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return null;
    // Unix is where mode bits and hard-link counts are authoritative. Windows
    // keeps the prior regular-file behavior because its POSIX mode is synthetic.
    if (process.platform !== 'win32'
      && ((stat.mode & 0o077) !== 0 || stat.nlink !== 1)) return null;
    return normalizeRemoteControlHostRecord(JSON.parse(readFileSync(descriptor, 'utf8')));
  } catch {
    return null;
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* already closed or invalid */ }
    }
  }
}

/** Atomic: a torn write would strand the Mac with a record it cannot restore. */
export function writeRemoteControlHostRecord(appDataDir: string, record: RemoteControlHostRecord): void {
  const normalized = normalizeRemoteControlHostRecord(record);
  if (!normalized) throw new Error('REMOTE_CONTROL_HOST_RECORD_INVALID');
  writePrivateFileAtomically(
    appDataDir,
    remoteControlHostRecordPath(appDataDir),
    `${JSON.stringify(normalized, null, 2)}\n`,
  );
}

/** Strict deletion for non-disable cleanup. ENOENT is already the desired
 * state; every other failure is observable and retryable by the caller. */
export function deleteRemoteControlHostRecord(appDataDir: string): boolean {
  return unlinkPrivateFileStrict(appDataDir, remoteControlHostRecordPath(appDataDir));
}

/** First phase of local disable. Once this durable marker exists, startup will
 * refuse the vault even if deleting that vault fails afterward. */
export function markRemoteControlHostLocallyDisabled(appDataDir: string): void {
  writePrivateFileAtomically(
    appDataDir,
    remoteControlHostDisabledPath(appDataDir),
    `${JSON.stringify({ schemaVersion: 1, disabled: true })}\n`,
  );
}

export function disableRemoteControlHostRecord(appDataDir: string): void {
  markRemoteControlHostLocallyDisabled(appDataDir);
  deleteRemoteControlHostRecord(appDataDir);
}

/** Called only after an explicit enable has durably written a fresh identity. */
export function clearRemoteControlHostDisabledTombstone(appDataDir: string): boolean {
  return unlinkPrivateFileStrict(appDataDir, remoteControlHostDisabledPath(appDataDir));
}

/**
 * Did the relay actively refuse this host, or could we simply not reach it?
 *
 * `authorize_host` raises `REMOTE_CONTROL_HOST_AUTH_FAILED` when the row is
 * revoked, expired, or the secret no longer matches — the only cases where the
 * stored identity is genuinely dead. Everything else (DNS, TLS, the first
 * seconds after a laptop wakes) deserves a retry. Discarding the record there
 * would send the user off to scan a new QR for nothing, which is the exact
 * failure this whole mechanism exists to remove.
 */
export function remoteControlHostRejected(error: unknown): boolean {
  const detail = error && typeof error === 'object' && 'detail' in error
    ? JSON.stringify((error as { detail: unknown }).detail ?? '')
    : '';
  const message = error instanceof Error ? `${error.message} ${detail}` : String(error);
  return /REMOTE_CONTROL_HOST_AUTH_FAILED|REMOTE_CONTROL_HOST_DISABLED|RELAY_HOST_KEY_MISMATCH/.test(message);
}
