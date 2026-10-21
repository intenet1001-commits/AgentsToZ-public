/**
 * Failure reports written by a client surface and read back on the Mac.
 *
 * A portal error happens on a phone, which cannot reach the Mac's localhost
 * `/api/voc`, and `portmgr_voc_inbox` is a service-role write-only outbox the
 * Mac cannot read. `portmgr_client_errors` closes that loop: the phone inserts
 * as an authenticated member, the desktop app reads its own device's rows.
 *
 * Because a browser writes this row and the desktop app displays it, what the
 * row must NOT carry matters as much as what it does. Absolute paths and
 * token-shaped strings are stripped here — at construction — rather than being
 * trusted to callers, so a new call site cannot quietly widen what leaves the
 * device.
 */

export const MAX_CLIENT_ERROR_FIELD = 2_000;

export interface ClientErrorReportInput {
  deviceId?: string | null;
  deviceName?: string | null;
  surface?: string | null;
  code: string;
  message: string;
  detail?: string | null;
  appVersion?: string | null;
}

/** Column shape of `portmgr_client_errors`. */
export interface ClientErrorReport {
  id: string;
  device_id: string | null;
  device_name: string | null;
  surface: string | null;
  code: string;
  message: string;
  detail: string | null;
  app_version: string | null;
  created_at: string;
}

/** A row as the desktop app reads it back, including the server's own columns. */
export interface PortalClientError extends ClientErrorReport {
  resolved?: boolean;
}

// Absolute POSIX/Windows paths and long opaque secrets. Both are things a
// stack trace or an error string picks up incidentally; neither belongs in a
// row that syncs to a database and back to another machine.
const ABSOLUTE_PATH_RE = /(?:\/(?:Users|home|var|private|tmp|opt|Volumes)\/[^\s'"]*|[A-Za-z]:\\[^\s'"]*)/g;
const SECRET_RE = /\b(?:[A-Za-z0-9_-]{32,}|(?:eyJ|sk-|ghp_|gho_)[A-Za-z0-9._-]+)\b/g;

function scrub(value: string): string {
  return value
    .replace(ABSOLUTE_PATH_RE, '[path]')
    .replace(SECRET_RE, '[redacted]');
}

function boundedText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return scrub(value).trim().slice(0, MAX_CLIENT_ERROR_FIELD);
}

/** Empty optionals are stored as NULL, never as a blank string. */
function optionalText(value: unknown): string | null {
  const text = boundedText(value);
  return text ? text : null;
}

function newId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return random;
  return `cerr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Identity and vocabulary fields are bounded but never scrubbed.
 *
 * `device_id` is a UUID, `device_name` is user-chosen, and `code` comes from
 * the server's fixed error vocabulary — none is free text a secret could hide
 * in. Running them through the redactor was actively harmful twice: a device
 * UUID became `[redacted]` and made reports unattributable, and
 * `REMOTE_CONTROL_PAIRING_EXPIRED_OR_USED` tripped the 32+ character rule, so
 * the one field that identifies the fault arrived as `[redacted]`.
 */
function identityText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().slice(0, MAX_CLIENT_ERROR_FIELD);
  return text ? text : null;
}

export function buildClientErrorReport(input: ClientErrorReportInput): ClientErrorReport {
  return {
    id: newId(),
    device_id: identityText(input.deviceId),
    device_name: identityText(input.deviceName),
    surface: optionalText(input.surface),
    code: identityText(input.code) ?? 'UNKNOWN',
    message: boundedText(input.message) || '알 수 없는 오류가 발생했습니다.',
    detail: optionalText(input.detail),
    app_version: identityText(input.appVersion),
    created_at: new Date().toISOString(),
  };
}
