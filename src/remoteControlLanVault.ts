/**
 * The Mac's LAN remote-control state, written down so a restart is not a re-pair.
 *
 * ⚠️ Why this exists: `remoteControlLanServer` was a module variable set only by a button, and the
 * listener took an ephemeral port. Every restart — every app update — therefore closed the listener,
 * dropped every paired phone, and changed the URL, so the QR taped to the fridge stopped working
 * and the only way back was walking to the Mac. The internet transport already survives this
 * (`remoteControlHostVault`); the LAN one, which is strictly less exposed, did not.
 *
 * ⚠️ Security trade-off, stated plainly: session tokens now rest on disk. They are bearer
 * credentials — holding one lets a device on the same Wi-Fi act as that paired phone until the
 * host's own idle/absolute deadline (30 days) or until the operator revokes it from the Mac. They
 * are written 0600 into the app data directory, beside `remote-control-host.json`, whose host
 * private scalar is strictly more powerful, and `supabase-service.json`, whose service_role key is
 * more powerful still. Reaching the Mac also requires being on its private network. Resuming the
 * listener without resuming sessions was considered and rejected: it keeps the URL stable but still
 * makes every morning start with a QR scan, which is the thing this is for.
 *
 * The opt-out is a file, not a setting, so it survives a corrupted config: create
 * `remote-control-lan.disabled` and startup refuses the record even if deleting it fails.
 *
 * ⚠️ Known limitation, not fixed here: the phone keeps its half of the token in web storage keyed
 * by origin, and the origin is `http://<private ip>:<port>`. A device that takes that address on
 * the same network inherits the origin and can serve a page that reads it. The token is useless
 * against the real Mac's core, but it is readable. Closing that needs host identity bound into the
 * pairing rather than the address, which is a protocol change, not a storage one.
 */
import { join } from 'node:path';
import { REMOTE_CONTROL_MAX_SESSIONS } from './remoteControlProtocol';
import {
  pathEntryExists,
  readPrivateFileStrict,
  unlinkPrivateFileStrict,
  writePrivateFileAtomically,
} from './remoteControlHostVault';

export const REMOTE_CONTROL_LAN_RECORD_VERSION = 1 as const;
export const REMOTE_CONTROL_LAN_RECORD_FILENAME = 'remote-control-lan.json';
export const REMOTE_CONTROL_LAN_DISABLED_FILENAME = 'remote-control-lan.disabled';

/** What a resumed session needs to be the same session, not a new one with the same name. */
export interface RemoteControlLanSessionRecord {
  sessionToken: string;
  createdAt: number;
  lastActiveAt: number;
  /** Display only. Lets the operator recognise the phone they approved. */
  pairedAt: string;
}

export interface RemoteControlLanRecord {
  schemaVersion: typeof REMOTE_CONTROL_LAN_RECORD_VERSION;
  /** The RFC1918 address the operator chose. Revalidated at startup; a Mac that moved networks
   * no longer has it, and claiming a listener on an address you do not hold is a dead QR. */
  bindAddress: string;
  /** Kept so the QR URL survives a restart. Ephemeral ports made every restart a new URL. */
  port: number;
  sessions: RemoteControlLanSessionRecord[];
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function timestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Fail closed: anything unreadable returns null and the Mac starts off, which costs one QR scan.
 * A half-restored listener is worse — it would advertise sessions no phone agrees with.
 */
export function normalizeRemoteControlLanRecord(value: unknown): RemoteControlLanRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== REMOTE_CONTROL_LAN_RECORD_VERSION) return null;
  const bindAddress = typeof raw.bindAddress === 'string' ? raw.bindAddress.trim() : '';
  if (!IPV4_RE.test(bindAddress)) return null;
  const port = raw.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  if (!Array.isArray(raw.sessions) || raw.sessions.length > REMOTE_CONTROL_MAX_SESSIONS) return null;

  const sessions: RemoteControlLanSessionRecord[] = [];
  for (const entry of raw.sessions) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const session = entry as Record<string, unknown>;
    const sessionToken = typeof session.sessionToken === 'string' ? session.sessionToken : '';
    const createdAt = timestamp(session.createdAt);
    const lastActiveAt = timestamp(session.lastActiveAt);
    const pairedAt = typeof session.pairedAt === 'string' ? session.pairedAt : '';
    if (!TOKEN_RE.test(sessionToken) || createdAt === null || lastActiveAt === null) return null;
    if (!pairedAt || !Number.isFinite(Date.parse(pairedAt))) return null;
    sessions.push({ sessionToken, createdAt, lastActiveAt, pairedAt });
  }
  if (new Set(sessions.map(session => session.sessionToken)).size !== sessions.length) return null;
  return { schemaVersion: REMOTE_CONTROL_LAN_RECORD_VERSION, bindAddress, port, sessions };
}

export function remoteControlLanRecordPath(appDataDir: string): string {
  return join(appDataDir, REMOTE_CONTROL_LAN_RECORD_FILENAME);
}

export function remoteControlLanDisabledPath(appDataDir: string): string {
  return join(appDataDir, REMOTE_CONTROL_LAN_DISABLED_FILENAME);
}

export function isRemoteControlLanLocallyDisabled(appDataDir: string): boolean {
  try {
    // Any entry counts, symlink or not. existsSync follows links, so a marker pointing at a
    // missing target would read as "not disabled" and quietly re-enable the listener.
    return pathEntryExists(remoteControlLanDisabledPath(appDataDir));
  } catch {
    // Unreadable means disabled. Guessing the other way re-enables a listener the operator turned
    // off, which is the one mistake this must not make.
    return true;
  }
}

/**
 * Uses the same strict reader as the host vault: O_NOFOLLOW plus descriptor-based mode and
 * link-count checks. A path-only lstat/read pair leaves a window to swap in a symlink between the
 * two calls, and it accepts a group-readable copy of a file full of bearer tokens.
 */
export function readRemoteControlLanRecord(appDataDir: string): RemoteControlLanRecord | null {
  if (isRemoteControlLanLocallyDisabled(appDataDir)) return null;
  const content = readPrivateFileStrict(remoteControlLanRecordPath(appDataDir));
  if (content === null || content.length > 256 * 1024) return null;
  try {
    return normalizeRemoteControlLanRecord(JSON.parse(content));
  } catch {
    return null;
  }
}

export function writeRemoteControlLanRecord(appDataDir: string, record: RemoteControlLanRecord): void {
  const normalized = normalizeRemoteControlLanRecord(record);
  if (!normalized) throw new Error('REMOTE_CONTROL_LAN_RECORD_INVALID');
  writePrivateFileAtomically(
    appDataDir,
    remoteControlLanRecordPath(appDataDir),
    `${JSON.stringify(normalized, null, 2)}\n`,
  );
}

export function deleteRemoteControlLanRecord(appDataDir: string): boolean {
  return unlinkPrivateFileStrict(appDataDir, remoteControlLanRecordPath(appDataDir));
}

/** Turning it off is durable first, then tidy: the marker is what startup obeys. */
export function markRemoteControlLanLocallyDisabled(appDataDir: string): void {
  writePrivateFileAtomically(
    appDataDir,
    remoteControlLanDisabledPath(appDataDir),
    `${JSON.stringify({ schemaVersion: REMOTE_CONTROL_LAN_RECORD_VERSION, disabled: true })}\n`,
  );
  deleteRemoteControlLanRecord(appDataDir);
}

/** Enabling again clears the marker; leaving it would silently defeat the next restart. */
export function clearRemoteControlLanLocalDisable(appDataDir: string): void {
  unlinkPrivateFileStrict(appDataDir, remoteControlLanDisabledPath(appDataDir));
}
