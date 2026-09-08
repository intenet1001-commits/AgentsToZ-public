export const QR_REMOTE_CONTROL_PATHS = {
  status: '/api/remote-control/status',
  interfaces: '/api/remote-control/interfaces',
  enable: '/api/remote-control/enable',
  rotatePairing: '/api/remote-control/pairing/rotate',
  revokeSession: '/api/remote-control/sessions/revoke',
  disable: '/api/remote-control/disable',
} as const;

export type QrRemoteControlPath = typeof QR_REMOTE_CONTROL_PATHS[keyof typeof QR_REMOTE_CONTROL_PATHS];
export type QrRemoteControlProjectStatus = 'running' | 'stopped' | 'unknown';
export type QrRemoteControlAction =
  | 'start' | 'stop' | 'restart'
  | 'folder.open' | 'localhost.open' | 'orca.open'
  | 'agent.claude' | 'agent.codex' | 'agent.agy' | 'agent.hermes'
  | 'app.claude' | 'app.codex' | 'app.hermes'
  | 'claude.thread.start'
  | 'codex.thread.start'
  | 'git.commit' | 'git.pull' | 'git.push' | 'git.merge'
  | 'worktree.add' | 'worktree.add.orca';

export interface QrRemoteControlListener {
  host: string;
  port: number;
}

export interface QrRemoteControlPendingPairing {
  expiresAt: string;
}

export interface QrRemoteControlSession {
  id: string;
  label: string;
  pairedAt: string;
  lastSeenAt: string | null;
  expiresAt: string | null;
}

export interface QrRemoteControlStatus {
  enabled: boolean;
  listener: QrRemoteControlListener | null;
  pairing: QrRemoteControlPendingPairing | null;
  sessions: QrRemoteControlSession[];
}

export interface QrRemoteControlInterface {
  address: string;
  name: string;
}

export interface QrRemoteControlPairingIssue {
  pairingUrl: string;
  expiresAt: string;
}

/**
 * The mobile surface deliberately has no folder path, command, memory,
 * device credential, process, or What-I-said fields. `controlId` is random and
 * session-scoped; the Mac maps it back to a current local row only at action time.
 */
export interface QrRemoteControlProjectCard {
  controlId: string;
  name: string;
  /** Secondary AI alias shown under the title; absent when it equals `name`. */
  alias: string | null;
  /** Display-only local workspace-root name; paths and root ids stay on the Mac. */
  workspaceRoot: string | null;
  /** Checked-out branch of this card's tree; null when detached or unknown. */
  branch: string | null;
  port: number | null;
  kind: 'main' | 'worktree';
  status: QrRemoteControlProjectStatus;
  actions: QrRemoteControlAction[];
}

export interface QrRemoteControlWorkspaceRoot {
  controlId: string;
  name: string;
}

export class QrRemoteControlContractError extends Error {
  readonly code = 'REMOTE_CONTROL_RESPONSE_INVALID';

  constructor(message = 'QR 원격제어 응답이 올바르지 않습니다.') {
    super(message);
    this.name = 'QrRemoteControlContractError';
  }
}

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
);

function invalid(message?: string): never {
  throw new QrRemoteControlContractError(message);
}

const boundedString = (value: unknown, maxLength: number): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
};

const isoDate = (value: unknown): string | null => {
  const normalized = boundedString(value, 64);
  return normalized && Number.isFinite(Date.parse(normalized)) ? normalized : null;
};

const optionalIsoDate = (value: unknown): string | null => {
  if (value === undefined || value === null || value === '') return null;
  return isoDate(value) ?? invalid();
};

const identifier = (value: unknown): string | null => {
  const normalized = boundedString(value, 128);
  return normalized && /^[A-Za-z0-9_-]{8,128}$/.test(normalized) ? normalized : null;
};

function parsePrivateIpv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map(part => /^(?:0|[1-9][0-9]{0,2})$/.test(part) ? Number(part) : NaN);
  return octets.every(octet => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : null;
}

/** V1 listens only on a user-selected RFC1918 IPv4 address. */
export function isPrivateQrRemoteControlAddress(value: unknown): value is string {
  const normalized = boundedString(value, 128)?.replace(/^\[|\]$/g, '');
  if (!normalized) return false;
  const ipv4 = parsePrivateIpv4(normalized);
  return Boolean(ipv4 && (
    ipv4[0] === 10
    || (ipv4[0] === 172 && ipv4[1]! >= 16 && ipv4[1]! <= 31)
    || (ipv4[0] === 192 && ipv4[1] === 168)
  ));
}

function normalizeListener(value: unknown): QrRemoteControlListener {
  const raw = asObject(value) ?? invalid();
  const host = boundedString(raw.host, 128);
  const port = typeof raw.port === 'number' ? raw.port : NaN;
  if (!host || !isPrivateQrRemoteControlAddress(host)
    || !Number.isInteger(port) || port < 1 || port > 65_535) invalid();
  return { host: host.replace(/^\[|\]$/g, ''), port };
}

function normalizeSession(value: unknown): QrRemoteControlSession {
  const raw = asObject(value) ?? invalid();
  const id = identifier(raw.id);
  const pairedAt = isoDate(raw.pairedAt);
  if (!id || !pairedAt) invalid();
  return {
    id,
    label: boundedString(raw.label, 80) ?? '연결된 기기',
    pairedAt,
    lastSeenAt: optionalIsoDate(raw.lastSeenAt),
    expiresAt: optionalIsoDate(raw.expiresAt),
  };
}

function unwrapStatus(payload: unknown): JsonObject {
  const outer = asObject(payload) ?? invalid();
  return asObject(outer.status) ?? outer;
}

export function normalizeQrRemoteControlStatus(payload: unknown): QrRemoteControlStatus {
  const raw = unwrapStatus(payload);
  if (typeof raw.enabled !== 'boolean') invalid();
  if (!raw.enabled) {
    return { enabled: false, listener: null, pairing: null, sessions: [] };
  }

  const listener = normalizeListener(raw.listener);
  const pairingRaw = raw.pairing === undefined || raw.pairing === null
    ? null
    : asObject(raw.pairing) ?? invalid();
  const pairing = pairingRaw
    ? { expiresAt: isoDate(pairingRaw.expiresAt) ?? invalid() }
    : null;
  const sessionsRaw = raw.sessions ?? [];
  if (!Array.isArray(sessionsRaw)) invalid();
  const sessions = sessionsRaw.map((value: unknown) => normalizeSession(value));
  const seen = new Set<string>();
  if (sessions.some(session => seen.has(session.id) || !seen.add(session.id))) invalid();
  return { enabled: true, listener, pairing, sessions };
}

export function normalizeQrRemoteControlInterfaces(payload: unknown): QrRemoteControlInterface[] {
  const outer = asObject(payload) ?? invalid();
  const interfaces = outer.interfaces;
  if (!Array.isArray(interfaces)) invalid();
  const seen = new Set<string>();
  return interfaces.map((value: unknown) => {
    const raw = asObject(value) ?? invalid();
    const address = boundedString(raw.address, 128)?.replace(/^\[|\]$/g, '');
    if (!address || !isPrivateQrRemoteControlAddress(address) || seen.has(address)) invalid();
    seen.add(address);
    return {
      address,
      name: boundedString(raw.name, 80) ?? address,
    };
  });
}

export function normalizeQrRemoteControlPairingIssue(payload: unknown): QrRemoteControlPairingIssue {
  const outer = asObject(payload) ?? invalid();
  const pairingUrl = boundedString(outer.pairingUrl, 2_048);
  const expiresAt = isoDate(outer.expiresAt);
  if (!pairingUrl || !expiresAt) invalid();

  let parsed: URL;
  try {
    parsed = new URL(pairingUrl);
  } catch {
    return invalid();
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const port = Number(parsed.port);
  if (parsed.protocol !== 'http:'
    || parsed.username || parsed.password
    || !isPrivateQrRemoteControlAddress(host)
    || !Number.isInteger(port) || port < 1 || port > 65_535
    || parsed.pathname !== '/remote/'
    || parsed.search
    || !/^#pair=[A-Za-z0-9_-]{43}$/.test(parsed.hash)) invalid();
  return { pairingUrl: parsed.toString(), expiresAt };
}

const PROJECT_CARD_ALLOWED_KEYS = new Set([
  'controlId', 'name', 'alias', 'workspaceRoot', 'branch', 'port', 'kind', 'status', 'actions',
]);
const PROJECT_ACTIONS = new Set<QrRemoteControlAction>([
  'start', 'stop', 'restart',
  'folder.open', 'localhost.open', 'orca.open',
  'agent.claude', 'agent.codex', 'agent.agy', 'agent.hermes',
  'app.claude', 'app.codex', 'app.hermes',
  'claude.thread.start',
  'codex.thread.start',
  'git.commit', 'git.pull', 'git.push', 'git.merge',
  'worktree.add', 'worktree.add.orca',
]);

export function normalizeQrRemoteControlProjectCards(payload: unknown): QrRemoteControlProjectCard[] {
  const outer = asObject(payload) ?? invalid();
  const projects = outer.projects;
  if (!Array.isArray(projects)) invalid();
  const seen = new Set<string>();
  return projects.map((value: unknown) => {
    const raw = asObject(value) ?? invalid();
    if (Object.keys(raw).some(key => !PROJECT_CARD_ALLOWED_KEYS.has(key))) invalid();
    const controlId = identifier(raw.controlId);
    const name = boundedString(raw.name, 120);
    const alias = raw.alias === undefined || raw.alias === null ? null : boundedString(raw.alias, 120);
    if (raw.alias !== undefined && raw.alias !== null && !alias) invalid();
    const workspaceRoot = raw.workspaceRoot === undefined || raw.workspaceRoot === null
      ? null
      : boundedString(raw.workspaceRoot, 120);
    if (raw.workspaceRoot !== undefined && raw.workspaceRoot !== null
      && (!workspaceRoot || /[\u0000-\u001f\u007f]/.test(workspaceRoot))) invalid();
    const branch = raw.branch === undefined || raw.branch === null ? null : boundedString(raw.branch, 200);
    if (raw.branch !== undefined && raw.branch !== null && !branch) invalid();
    const port = raw.port === null || raw.port === undefined ? null : raw.port;
    const kind = raw.kind;
    const status = raw.status;
    if (!controlId || seen.has(controlId) || !name
      || (port !== null && (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535))
      || (kind !== 'main' && kind !== 'worktree')
      || (status !== 'running' && status !== 'stopped' && status !== 'unknown')) invalid();
    const actionsRaw = raw.actions;
    if (!Array.isArray(actionsRaw)) invalid();
    seen.add(controlId);
    const actions = actionsRaw.map((action: unknown): QrRemoteControlAction => {
      if (typeof action !== 'string' || !PROJECT_ACTIONS.has(action as QrRemoteControlAction)) invalid();
      return action as QrRemoteControlAction;
    });
    if (new Set(actions).size !== actions.length) invalid();
    if (port === null && (status !== 'unknown'
      || actions.some(action => ['start', 'stop', 'restart', 'localhost.open', 'orca.open'].includes(action)))) invalid();
    if (status === 'running' && actions.includes('start')) invalid();
    if (status === 'stopped' && (actions.includes('stop') || actions.includes('restart'))) invalid();
    return {
      controlId,
      name,
      alias: alias === name ? null : alias,
      workspaceRoot,
      branch,
      port: port as number | null,
      kind,
      status,
      actions,
    };
  });
}

export function normalizeQrRemoteControlWorkspaceRoots(payload: unknown): QrRemoteControlWorkspaceRoot[] {
  const outer = asObject(payload) ?? invalid();
  const roots = outer.workspaceRoots;
  if (!Array.isArray(roots) || roots.length > 100) invalid();
  const seen = new Set<string>();
  return roots.map((value: unknown) => {
    const raw = asObject(value) ?? invalid();
    if (Object.keys(raw).length !== 2
      || !Object.prototype.hasOwnProperty.call(raw, 'controlId')
      || !Object.prototype.hasOwnProperty.call(raw, 'name')) invalid();
    const controlId = identifier(raw.controlId);
    const name = boundedString(raw.name, 120);
    if (!controlId || seen.has(controlId) || !name) invalid();
    seen.add(controlId);
    return { controlId, name };
  });
}

export function isQrRemoteControlPairingExpired(expiresAt: string, now = Date.now()): boolean {
  const timestamp = Date.parse(expiresAt);
  return !Number.isFinite(timestamp) || timestamp <= now;
}

export function formatQrRemoteControlRemaining(expiresAt: string, now = Date.now()): string {
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
