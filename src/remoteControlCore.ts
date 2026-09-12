import { createHash, createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import {
  REMOTE_CONTROL_MAX_SESSIONS,
  REMOTE_CONTROL_PROTOCOL_VERSION,
  normalizeRemoteControlSupportedFeatures,
  type RemoteControlSupportedFeature,
} from './remoteControlProtocol';
import {
  publicRemoteControlProject,
  type RemoteControlProjectAction,
  type RemoteControlRegisteredTarget,
} from './remoteControlProcessGateway';

export { REMOTE_CONTROL_PROTOCOL_VERSION } from './remoteControlProtocol';
export const REMOTE_CONTROL_PAIRING_TTL_MS = 30 * 24 * 60 * 60_000;
export const REMOTE_CONTROL_IDLE_TTL_MS = 30 * 24 * 60 * 60_000;
export const REMOTE_CONTROL_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60_000;
export const REMOTE_CONTROL_ACTION_ID_LIMIT = 1_024;
export const REMOTE_CONTROL_ACTION_ID_MAX_LENGTH = 100;
export const REMOTE_CONTROL_PROJECT_PAGE_SIZE = 20;
/**
 * Byte budget for one page's `projects` array, sized to leave room for the
 * session/result envelope under the relay's 11,000-byte plaintext ceiling.
 */
export const REMOTE_CONTROL_PROJECT_PAGE_BYTES = 9_000;
// Defined in the browser-safe protocol module so UI can state the cap without
// dragging node:crypto into the bundle. Re-exported for existing importers.
export { REMOTE_CONTROL_MAX_SESSIONS } from './remoteControlProtocol';

const TOKEN_BYTES = 32;
const BASE64URL_256_RE = /^[A-Za-z0-9_-]{43}$/;
const ACTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const INTERNAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type RemoteControlReadAction =
  | 'protocol.capabilities'
  | 'projects.list'
  | 'project.status'
  | 'workspace-roots.list';
export type RemoteControlMutationAction = RemoteControlProjectAction | 'project.create';
export type RemoteControlAction = RemoteControlReadAction | RemoteControlMutationAction;

const REMOTE_CONTROL_ACTIONS = new Set<RemoteControlAction>([
  'protocol.capabilities',
  'projects.list',
  'project.status',
  'workspace-roots.list',
  'project.create',
  'start',
  'stop',
  'restart',
  'folder.open',
  'localhost.open',
  'orca.open',
  'agent.claude',
  'agent.codex',
  'agent.agy',
  'agent.hermes',
  'app.claude',
  'app.codex',
  'app.hermes',
  'claude.thread.start',
  'codex.thread.start',
  'git.commit',
  'git.pull',
  'git.push',
  'git.merge',
  'worktree.add',
  'worktree.add.orca',
]);

const MUTATING_ACTIONS = new Set<RemoteControlAction>([
  'start',
  'stop',
  'restart',
  'folder.open',
  'localhost.open',
  'orca.open',
  'agent.claude',
  'agent.codex',
  'agent.agy',
  'agent.hermes',
  'app.claude',
  'app.codex',
  'app.hermes',
  'claude.thread.start',
  'codex.thread.start',
  'project.create',
  'git.commit',
  'git.pull',
  'git.push',
  'git.merge',
  'worktree.add',
  'worktree.add.orca',
]);

/**
 * Every action the host can attach to a project card. Both phone surfaces must
 * be able to render all of them — the LAN page silently omitted the Git and
 * worktree actions for several releases because nothing compared the two.
 */
export const REGISTERED_PROJECT_ACTIONS = new Set<RemoteControlProjectAction>([
  'start', 'stop', 'restart',
  'folder.open', 'localhost.open', 'orca.open',
  'agent.claude', 'agent.codex', 'agent.agy', 'agent.hermes',
  // No 'app.claude': Claude Code registers `claude-cli:`, not `claude:`, so the
  // deep link was silently swallowed by Claude Desktop. `agent.claude` opens
  // the Claude Code CLI in Orca and is the single Claude Code entry point.
  'app.codex', 'app.hermes',
  'claude.thread.start',
  'codex.thread.start',
  'git.commit', 'git.pull', 'git.push', 'git.merge', 'worktree.add', 'worktree.add.orca',
]);

export type RemoteControlProjectStatus = 'running' | 'stopped' | 'unknown';
export type { RemoteControlProjectAction } from './remoteControlProcessGateway';

export interface RemoteControlProjectDto {
  controlId: string;
  name: string;
  /** Secondary AI alias; null when it is absent or equal to `name`. */
  alias: string | null;
  /** Display-only workspace-root name; no local path or registry id. */
  workspaceRoot: string | null;
  /** Checked-out branch of this card's tree; null when detached or unknown. */
  branch: string | null;
  port: number | null;
  kind: 'main' | 'worktree';
  status: RemoteControlProjectStatus;
  actions: RemoteControlProjectAction[];
}

export interface RemoteControlGatewayAction {
  action: RemoteControlProjectAction;
  target: RemoteControlRegisteredTarget;
  actionId: string;
  input?: string;
}

export interface RemoteControlWorkspaceRootTarget {
  /** Server-only registry identifier. It must never be serialized to the controller. */
  internalId: string;
  name: string;
}

export interface RemoteControlWorkspaceRootDto {
  controlId: string;
  name: string;
}

export interface RemoteControlCreateProjectAction {
  workspaceRoot: RemoteControlWorkspaceRootTarget;
  projectName: string;
  actionId: string;
  /** Server-derived pairing identity. Never accepted from the request DTO. */
  controllerId: string;
  sessionExpiresAt: string;
}

export interface RemoteControlActionAuthority {
  controllerId: string;
  expiresAt: string;
}

/**
 * The LAN surface never accepts a path, command, environment value, or secret.
 * The core re-reads current registered targets immediately before execution;
 * an integration must execute only the supplied canonical target. A canonical
 * start may retain the same dependency self-heal as the Mac button, but the LAN
 * protocol must not expose a separate install or arbitrary-shell capability.
 */
export interface RemoteControlGateway {
  listRegisteredProjects(): readonly RemoteControlRegisteredTarget[] | Promise<readonly RemoteControlRegisteredTarget[]>;
  executeRegisteredProjectAction(action: RemoteControlGatewayAction): void | Promise<void>;
  listWorkspaceRoots?(): readonly RemoteControlWorkspaceRootTarget[] | Promise<readonly RemoteControlWorkspaceRootTarget[]>;
  createProject?(action: RemoteControlCreateProjectAction): void | {internalId: string} | Promise<void | {internalId: string}>;
}

/**
 * Server-only bridge between a session-scoped phone control ID and the freshly
 * reloaded registered target that currently owns it. The target may contain a
 * local path and therefore must never be serialized to a controller.
 */
export interface RemoteControlTaskTargetBinding {
  controlId: string;
  target: RemoteControlRegisteredTarget;
}

export type RemoteControlPairRequest = {
  type: 'controller.pair';
  protocolVersion: typeof REMOTE_CONTROL_PROTOCOL_VERSION;
  token: string;
};

export type RemoteControlActionRequest = {
  type: 'action.request';
  protocolVersion: typeof REMOTE_CONTROL_PROTOCOL_VERSION;
  sessionToken: string;
  actionId: string;
  action: RemoteControlAction;
  controlId?: string;
  remoteConfirmed?: boolean;
  page?: number;
  input?: string;
  workspaceRootId?: string;
};

export type RemoteControlClientMessage =
  | RemoteControlPairRequest
  | RemoteControlRestoreRequest
  | RemoteControlEndRequest
  | RemoteControlActionRequest;

/**
 * A controller ending its own session on purpose.
 *
 * Needed because a plain socket close now means "away, I will be back". Without a way to say
 * otherwise, a phone that the user explicitly disconnected stayed listed on the Mac until its
 * 30-day deadline, and the operator had to revoke a device that had already left.
 */
export type RemoteControlEndRequest = {
  type: 'session.end';
  protocolVersion: typeof REMOTE_CONTROL_PROTOCOL_VERSION;
  sessionToken: string;
};

export type RemoteControlRestoreRequest = {
  type: 'session.restore';
  protocolVersion: typeof REMOTE_CONTROL_PROTOCOL_VERSION;
  sessionToken: string;
};

export type RemoteControlSessionReady = {
  type: 'session.ready' | 'session.restored';
  protocolVersion: typeof REMOTE_CONTROL_PROTOCOL_VERSION;
  sessionToken: string;
  hostName: string;
  expiresAt: string;
  idleExpiresAt: string;
  projects: RemoteControlProjectDto[];
  projectCount: number;
  nextPage: number | null;
};

export type RemoteControlActionResult =
  | {
      type: 'action.result';
      actionId: string;
      ok: true;
      supportedFeatures: RemoteControlSupportedFeature[];
    }
  | {
      type: 'action.result';
      actionId: string;
      ok: true;
      projects: RemoteControlProjectDto[];
      page: number;
      projectCount: number;
      nextPage: number | null;
    }
  | {
      type: 'action.result';
      actionId: string;
      ok: true;
      workspaceRoots: RemoteControlWorkspaceRootDto[];
    }
  | {
      type: 'action.result';
      actionId: string;
      ok: true;
      project: RemoteControlProjectDto | null;
    }
  | {
      type: 'action.result';
      actionId: string;
      ok: false;
      error: { code: string; message: string; changedPaths?: string[] };
    };

export type RemoteControlPairingDescriptor = {
  pairingUrl: string;
  expiresAt: string;
};

export type RemoteControlCoreStatus = {
  enabled: boolean;
  pairingPending: boolean;
  pairingExpiresAt: string | null;
  /** True when at least one phone is connected. */
  sessionActive: boolean;
  sessionCount: number;
  /** Soonest upcoming expiry across all connected phones. */
  sessionExpiresAt: string | null;
  sessionIdleExpiresAt: string | null;
};

export type RemoteControlClosedSession = {
  sessionToken: string;
  reason: 'idle' | 'absolute';
};

/**
 * A sweep can now close several sessions at once. This was a single optional
 * token back when a Mac could hold exactly one phone; callers that only looked
 * at the first would have silently leaked the rest.
 */
export type RemoteControlExpiryEvent = {
  closed: RemoteControlClosedSession[];
};

export class RemoteControlError extends Error {
  constructor(
    readonly code: string,
    readonly publicMessage: string,
    readonly status = 400,
    /**
     * Repository-relative paths that explain the refusal, e.g. the uncommitted
     * files blocking `worktree.add`. A bare "commit first" message left the
     * phone with no way to act, so the cause travels with the error. Absolute
     * paths are never included — the controller must not learn the local
     * filesystem layout.
     */
    readonly detailPaths: readonly string[] = [],
  ) {
    super(publicMessage);
    this.name = 'RemoteControlError';
  }
}

export function remoteControlPublicError(
  error: unknown,
): { code: string; message: string; changedPaths?: string[] } {
  if (error instanceof RemoteControlError) {
    return {
      code: error.code,
      message: error.publicMessage,
      ...(error.detailPaths.length > 0 ? { changedPaths: [...error.detailPaths] } : {}),
    };
  }
  return { code: 'REMOTE_CONTROL_FAILED', message: '원격 제어 요청을 처리하지 못했습니다.' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function assertBase64Url256(value: unknown, code: string, message: string): asserts value is string {
  if (typeof value !== 'string' || !BASE64URL_256_RE.test(value)) {
    throw new RemoteControlError(code, message, 401);
  }
}

export function parseRemoteControlClientMessage(value: unknown): RemoteControlClientMessage {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new RemoteControlError('INVALID_MESSAGE', '원격 제어 메시지가 올바르지 않습니다.');
  }
  if (value.type === 'controller.pair') {
    if (!hasExactKeys(value, ['type', 'protocolVersion', 'token'])) {
      throw new RemoteControlError('INVALID_PAIRING', 'QR 연결 요청 형식이 올바르지 않습니다.', 401);
    }
    if (value.protocolVersion !== REMOTE_CONTROL_PROTOCOL_VERSION) {
      throw new RemoteControlError('PROTOCOL_MISMATCH', '지원하지 않는 원격 제어 버전입니다.', 409);
    }
    assertBase64Url256(value.token, 'INVALID_PAIRING', 'QR 연결 정보가 올바르지 않습니다.');
    return value as RemoteControlPairRequest;
  }
  // `session.restore` is the whole reason a phone can survive a screen lock. It is part of
  // RemoteControlClientMessage and the LAN server has a handler for it, but this parser used to
  // reject it here, so that handler was unreachable and reconnect could never work.
  if (value.type === 'session.restore') {
    if (!hasExactKeys(value, ['type', 'protocolVersion', 'sessionToken'])) {
      throw new RemoteControlError('INVALID_ACTION', '원격 제어 재연결 요청 형식이 올바르지 않습니다.');
    }
    if (value.protocolVersion !== REMOTE_CONTROL_PROTOCOL_VERSION) {
      throw new RemoteControlError('PROTOCOL_MISMATCH', '지원하지 않는 원격 제어 버전입니다.', 409);
    }
    assertBase64Url256(value.sessionToken, 'INVALID_SESSION_TOKEN', '원격 제어 세션 정보가 올바르지 않습니다.');
    return value as RemoteControlRestoreRequest;
  }
  if (value.type === 'session.end') {
    if (!hasExactKeys(value, ['type', 'protocolVersion', 'sessionToken'])) {
      throw new RemoteControlError('INVALID_ACTION', '원격 제어 종료 요청 형식이 올바르지 않습니다.');
    }
    if (value.protocolVersion !== REMOTE_CONTROL_PROTOCOL_VERSION) {
      throw new RemoteControlError('PROTOCOL_MISMATCH', '지원하지 않는 원격 제어 버전입니다.', 409);
    }
    assertBase64Url256(value.sessionToken, 'INVALID_SESSION_TOKEN', '원격 제어 세션 정보가 올바르지 않습니다.');
    return value as RemoteControlEndRequest;
  }
  if (value.type !== 'action.request') {
    throw new RemoteControlError('ACTION_NOT_ALLOWED', '허용되지 않은 원격 제어 기능입니다.', 403);
  }
  if (!hasExactKeys(
    value,
    ['type', 'protocolVersion', 'sessionToken', 'actionId', 'action'],
    ['controlId', 'remoteConfirmed', 'page', 'input', 'workspaceRootId'],
  )) {
    throw new RemoteControlError('INVALID_ACTION', '원격 제어 요청 형식이 올바르지 않습니다.');
  }
  if (value.protocolVersion !== REMOTE_CONTROL_PROTOCOL_VERSION) {
    throw new RemoteControlError('PROTOCOL_MISMATCH', '지원하지 않는 원격 제어 버전입니다.', 409);
  }
  assertBase64Url256(value.sessionToken, 'INVALID_SESSION_TOKEN', '원격 제어 세션 정보가 올바르지 않습니다.');
  if (typeof value.actionId !== 'string' || !ACTION_ID_RE.test(value.actionId)) {
    throw new RemoteControlError('INVALID_ACTION_ID', 'actionId가 올바르지 않습니다.');
  }
  if (typeof value.action !== 'string' || !REMOTE_CONTROL_ACTIONS.has(value.action as RemoteControlAction)) {
    throw new RemoteControlError('ACTION_NOT_ALLOWED', '허용되지 않은 원격 제어 기능입니다.', 403);
  }
  const action = value.action as RemoteControlAction;
  if (action === 'projects.list') {
    if (value.controlId !== undefined || value.remoteConfirmed !== undefined
      || value.input !== undefined || value.workspaceRootId !== undefined
      || (value.page !== undefined && (typeof value.page !== 'number'
        || !Number.isInteger(value.page) || value.page < 0 || value.page > 99))) {
      throw new RemoteControlError('INVALID_ACTION', '프로젝트 목록 요청에는 추가 입력을 사용할 수 없습니다.');
    }
  } else if (action === 'workspace-roots.list' || action === 'protocol.capabilities') {
    if (value.controlId !== undefined || value.remoteConfirmed !== undefined
      || value.page !== undefined || value.input !== undefined || value.workspaceRootId !== undefined) {
      throw new RemoteControlError(
        'INVALID_ACTION',
        action === 'protocol.capabilities'
          ? '프로토콜 기능 확인 요청에는 추가 입력을 사용할 수 없습니다.'
          : '작업 루트 목록 요청에는 추가 입력을 사용할 수 없습니다.',
      );
    }
  } else if (action === 'project.create') {
    if (value.controlId !== undefined || value.page !== undefined || value.remoteConfirmed !== true) {
      throw new RemoteControlError('INVALID_ACTION', '프로젝트 생성 요청에는 휴대폰 확인과 작업 루트가 필요합니다.');
    }
    assertBase64Url256(value.workspaceRootId, 'INVALID_WORKSPACE_ROOT_ID', '작업 루트 제어 ID가 올바르지 않습니다.');
    if (typeof value.input !== 'string'
      || !value.input.trim()
      || value.input.length > 120
      || /[\u0000-\u001f\u007f\u2028\u2029]/.test(value.input)) {
      throw new RemoteControlError('INVALID_PROJECT_NAME', '프로젝트 이름은 한 줄 1~120자로 입력하세요.');
    }
  } else {
    if (value.page !== undefined) throw new RemoteControlError('INVALID_ACTION', '프로젝트 기능 요청에는 페이지를 사용할 수 없습니다.');
    if (value.workspaceRootId !== undefined) throw new RemoteControlError('INVALID_ACTION', '프로젝트 기능 요청에는 작업 루트 ID를 사용할 수 없습니다.');
    assertBase64Url256(value.controlId, 'INVALID_CONTROL_ID', '프로젝트 제어 ID가 올바르지 않습니다.');
    if (value.remoteConfirmed !== undefined && typeof value.remoteConfirmed !== 'boolean') {
      throw new RemoteControlError('INVALID_ACTION', '확인 값이 올바르지 않습니다.');
    }
    if (action === 'project.status' && value.remoteConfirmed !== undefined) {
      throw new RemoteControlError('INVALID_ACTION', '상태 조회에는 실행 확인 값을 사용할 수 없습니다.');
    }
    const needsInput = action === 'git.commit' || action === 'worktree.add' || action === 'worktree.add.orca';
    if (needsInput) {
      if (typeof value.input !== 'string'
        || !value.input.trim()
        || value.input.length > 120
        || /[\u0000-\u001f\u007f\u2028\u2029]/.test(value.input)) {
        throw new RemoteControlError(
          action === 'git.commit' ? 'INVALID_COMMIT_MESSAGE' : 'INVALID_BRANCH_NAME',
          action === 'git.commit' ? '커밋 메시지는 한 줄 1~120자로 입력하세요.' : '브랜치 이름은 한 줄 1~120자로 입력하세요.',
        );
      }
    } else if (value.input !== undefined) {
      throw new RemoteControlError('INVALID_ACTION', '이 프로젝트 기능에는 추가 입력을 사용할 수 없습니다.');
    }
  }
  return value as RemoteControlActionRequest;
}

export function parseRemoteControlClientJson(raw: string): RemoteControlClientMessage {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new RemoteControlError('INVALID_JSON', 'JSON 메시지가 올바르지 않습니다.');
  }
  return parseRemoteControlClientMessage(value);
}

function sanitizeRegisteredTargets(rows: readonly RemoteControlRegisteredTarget[]): RemoteControlRegisteredTarget[] {
  const projects: RemoteControlRegisteredTarget[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(0, 500)) {
    if (!isRecord(row) || typeof row.internalId !== 'string' || !INTERNAL_ID_RE.test(row.internalId) || seen.has(row.internalId)) continue;
    if (typeof row.name !== 'string') continue;
    const name = row.name.trim();
    if (!name || name.length > 120
      || (row.port !== null && (!Number.isInteger(row.port) || row.port < 1 || row.port > 65_535))
      || (row.kind !== 'main' && row.kind !== 'worktree')
      || (row.status !== 'running' && row.status !== 'stopped' && row.status !== 'unknown')
      || !Array.isArray(row.actions)
      || row.actions.some((action) => !REGISTERED_PROJECT_ACTIONS.has(action))
      || (row.port === null && (row.status !== 'unknown'
        || row.actions.some(action => ['start', 'stop', 'restart', 'localhost.open', 'orca.open'].includes(action))))) continue;
    const rawAlias = typeof row.alias === 'string' ? row.alias.trim() : '';
    const alias = rawAlias && rawAlias !== name && rawAlias.length <= 120 ? rawAlias : undefined;
    const rawWorkspaceRoot = typeof row.workspaceRoot === 'string' ? row.workspaceRoot.trim() : '';
    const workspaceRoot = rawWorkspaceRoot && rawWorkspaceRoot.length <= 120
      && !/[\u0000-\u001f\u007f]/.test(rawWorkspaceRoot)
      ? rawWorkspaceRoot
      : undefined;
    // Branch names come from git, i.e. from whoever created the branch. Bound
    // the length and reject control characters before it reaches the phone.
    const rawBranch = typeof row.branch === 'string' ? row.branch.trim() : '';
    const branch = rawBranch && rawBranch.length <= 200 && !/[\u0000-\u001f\u007f]/.test(rawBranch)
      ? rawBranch
      : undefined;
    const {
      alias: _discardedAlias,
      workspaceRoot: _discardedWorkspaceRoot,
      branch: _discardedBranch,
      ...rest
    } = row;
    projects.push({
      ...rest,
      name,
      ...(alias ? { alias } : {}),
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(branch ? { branch } : {}),
      actions: [...new Set(row.actions)],
    });
    seen.add(row.internalId);
  }
  return projects;
}

function sanitizeWorkspaceRoots(rows: readonly RemoteControlWorkspaceRootTarget[]): RemoteControlWorkspaceRootTarget[] {
  const roots: RemoteControlWorkspaceRootTarget[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(0, 100)) {
    if (!isRecord(row) || typeof row.internalId !== 'string' || !INTERNAL_ID_RE.test(row.internalId) || seen.has(row.internalId)) continue;
    if (typeof row.name !== 'string') continue;
    const name = row.name.trim();
    if (!name || name.length > 120) continue;
    roots.push({ internalId: row.internalId, name });
    seen.add(row.internalId);
  }
  return roots;
}

type RandomBytes = (length: number) => Uint8Array;

export interface RemoteControlCoreOptions {
  hostName: string;
  /** Bounded, additive protocol support; never an authorization grant. */
  supportedFeatures?: readonly RemoteControlSupportedFeature[];
  now?: () => number;
  randomBytes?: RandomBytes;
  pairingTtlMs?: number;
  idleTtlMs?: number;
  absoluteTtlMs?: number;
  rateWindowMs?: number;
  maxActionsPerRateWindow?: number;
  maxReadsPerRateWindow?: number;
  maxActionIdsPerSession?: number;
}

type PairingState = {
  tokenHash: Buffer;
  expiresAt: number;
};

type IdempotencyEntry = {
  fingerprint: string;
  promise: Promise<RemoteControlActionResult>;
};

/** The delivery identity a single request was admitted under. */
type CapturedDelivery = { generation: number; isDeliverable?: () => boolean };

type SessionState = {
  sessionToken: string;
  createdAt: number;
  lastActiveAt: number;
  rateWindowStartedAt: number;
  actionsInRateWindow: number;
  readsInRateWindow: number;
  inFlightActionId: string | null;
  actionResults: Map<string, IdempotencyEntry>;
  internalIdsByControlId: Map<string, string>;
  workspaceRootIdsByControlId: Map<string, string>;
  issuedControlIds: Set<string>;
  /**
   * Whether the transport can still deliver to whoever asked. A session may legitimately outlive
   * its connection — a locked phone keeps its session so it can resume — but an action that was
   * still resolving when the connection went away must not be dispatched on its way out.
   * Unset means "no transport opinion", which is the previous behaviour.
   */
  isDeliverable?: () => boolean;
  /**
   * Bumped every time the transport rebinds. A request captures this at entry, so an action left
   * mid-flight by one connection is cancelled when a different connection takes the session over —
   * asking only "is someone connected?" would answer yes and dispatch the abandoned action to the
   * newcomer's credit.
   */
  deliveryGeneration: number;
};

function positiveDuration(value: number | undefined, fallback: number, label: string): number {
  const duration = value ?? fallback;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`${label} must be positive`);
  return duration;
}

function opaqueToken(randomBytes: RandomBytes): string {
  const bytes = Buffer.from(randomBytes(TOKEN_BYTES));
  if (bytes.byteLength !== TOKEN_BYTES) throw new Error('randomBytes must return exactly 32 bytes');
  return bytes.toString('base64url');
}

function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

function equalOpaqueToken(token: string, expectedHash: Buffer): boolean {
  const actual = tokenDigest(token);
  return actual.byteLength === expectedHash.byteLength && timingSafeEqual(actual, expectedHash);
}

function normalizedHostName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 80) throw new Error('hostName must be 1-80 characters');
  return name;
}

function pairingUrl(baseUrl: string, token: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('pairing base URL must use http or https');
  if (url.username || url.password || url.search || url.hash) throw new Error('pairing base URL must not contain credentials, query, or fragment');
  url.pathname = '/remote/';
  url.search = '';
  url.hash = `pair=${token}`;
  return url.toString();
}

export class RemoteControlCore {
  readonly #gateway: RemoteControlGateway;
  readonly #hostName: string;
  readonly #supportedFeatures: RemoteControlSupportedFeature[];
  readonly #now: () => number;
  readonly #randomBytes: RandomBytes;
  readonly #pairingTtlMs: number;
  readonly #idleTtlMs: number;
  readonly #absoluteTtlMs: number;
  readonly #rateWindowMs: number;
  readonly #maxActionsPerRateWindow: number;
  readonly #maxReadsPerRateWindow: number;
  readonly #maxActionIdsPerSession: number;
  #enabled = false;
  #pairing: PairingState | null = null;
  /** Keyed by sessionToken. Insertion order is the pairing order. */
  readonly #sessions = new Map<string, SessionState>();

  constructor(gateway: RemoteControlGateway, options: RemoteControlCoreOptions) {
    this.#gateway = gateway;
    this.#hostName = normalizedHostName(options.hostName);
    this.#supportedFeatures = normalizeRemoteControlSupportedFeatures(options.supportedFeatures ?? []);
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? ((length) => nodeRandomBytes(length));
    this.#pairingTtlMs = positiveDuration(options.pairingTtlMs, REMOTE_CONTROL_PAIRING_TTL_MS, 'pairingTtlMs');
    this.#idleTtlMs = positiveDuration(options.idleTtlMs, REMOTE_CONTROL_IDLE_TTL_MS, 'idleTtlMs');
    this.#absoluteTtlMs = positiveDuration(options.absoluteTtlMs, REMOTE_CONTROL_ABSOLUTE_TTL_MS, 'absoluteTtlMs');
    this.#rateWindowMs = positiveDuration(options.rateWindowMs, 10_000, 'rateWindowMs');
    this.#maxActionsPerRateWindow = options.maxActionsPerRateWindow ?? 6;
    // Reading the list is not a request the phone chose to make: the host hands it a nextPage and
    // the phone must follow it to see its own projects. Sharing the mutating budget meant a Mac
    // with enough projects could not finish its own enumeration — measured on 134 registered rows,
    // the six pages consumed the entire window and the work-root lookup that follows was refused.
    // Reads re-read local rows and commit nothing, so they get a window of their own.
    // Independent of the mutating budget, but never below it: a caller that deliberately raises
    // the action allowance is not asking for a *smaller* read allowance as a side effect.
    //
    // Twenty is measured, not chosen for roundness. A read rebuilds every card, and the port scan
    // inside that costs ~40ms on this hardware (30 back-to-back lsof runs took 1.31s), so the
    // ceiling is what an authenticated phone can make the host spend per window. Twenty covers a
    // ~400-project enumeration in one window; past that the phone's own retry finishes the walk in
    // the next one rather than the host handing out an unbounded allowance.
    this.#maxReadsPerRateWindow = options.maxReadsPerRateWindow ?? Math.max(20, this.#maxActionsPerRateWindow);
    this.#maxActionIdsPerSession = options.maxActionIdsPerSession ?? REMOTE_CONTROL_ACTION_ID_LIMIT;
    if (!Number.isInteger(this.#maxReadsPerRateWindow)
      || this.#maxReadsPerRateWindow < 1
      || this.#maxReadsPerRateWindow > 1000) {
      throw new Error('maxReadsPerRateWindow must be an integer between 1 and 1000');
    }
    if (!Number.isInteger(this.#maxActionsPerRateWindow) || this.#maxActionsPerRateWindow < 1 || this.#maxActionsPerRateWindow > 100) {
      throw new Error('maxActionsPerRateWindow must be an integer between 1 and 100');
    }
    if (!Number.isInteger(this.#maxActionIdsPerSession) || this.#maxActionIdsPerSession < 1 || this.#maxActionIdsPerSession > 1_024) {
      throw new Error('maxActionIdsPerSession must be an integer between 1 and 1024');
    }
  }

  enable(baseUrl: string): RemoteControlPairingDescriptor {
    this.#enabled = true;
    return this.#newPairing(baseUrl);
  }

  rotatePairing(baseUrl: string): RemoteControlPairingDescriptor {
    if (!this.#enabled) throw new RemoteControlError('REMOTE_CONTROL_DISABLED', '원격 제어가 꺼져 있습니다.', 409);
    return this.#newPairing(baseUrl);
  }

  disable(): void {
    this.#enabled = false;
    this.#pairing = null;
    this.#sessions.clear();
  }

  /**
   * Whether a paired session is still held. A transport that keeps a phone listed while its
   * socket is away needs this to tell "away" from "already ended", without reaching into the
   * session map or handling the token itself.
   */
  sessionExists(sessionToken: string): boolean {
    for (const session of this.#sessions.values()) {
      if (this.#sameOpaqueId(sessionToken, session.sessionToken)) return true;
    }
    return false;
  }

  /**
   * Re-install sessions a transport persisted across a restart.
   *
   * The tokens are the ones the phones already hold, so this is a resume, not a grant: expired
   * records are dropped here rather than revived, and the session limit still applies. Called
   * once, immediately after enable(), before any socket can arrive.
   */
  restoreSessions(records: readonly { sessionToken: string; createdAt: number; lastActiveAt: number }[]): number {
    if (!this.#enabled) throw new RemoteControlError('REMOTE_CONTROL_DISABLED', '원격 제어가 꺼져 있습니다.', 409);
    const now = this.#now();
    let restored = 0;
    for (const record of records) {
      if (this.#sessions.size >= REMOTE_CONTROL_MAX_SESSIONS) break;
      if (this.#sessions.has(record.sessionToken)) continue;
      // The deadlines are the host's, not the record's: a token that aged out while the Mac was
      // off must not come back to life merely because it was written down.
      if (now - record.createdAt >= this.#absoluteTtlMs) continue;
      if (now - record.lastActiveAt >= this.#idleTtlMs) continue;
      this.#sessions.set(record.sessionToken, {
        sessionToken: record.sessionToken,
        createdAt: record.createdAt,
        lastActiveAt: record.lastActiveAt,
        rateWindowStartedAt: now,
        actionsInRateWindow: 0,
        readsInRateWindow: 0,
        deliveryGeneration: 0,
        inFlightActionId: null,
        actionResults: new Map(),
        internalIdsByControlId: new Map(),
        workspaceRootIdsByControlId: new Map(),
        issuedControlIds: new Set(),
      });
      restored += 1;
    }
    return restored;
  }

  /** What a transport has to write down for restoreSessions() to bring these phones back. */
  exportSessions(): { sessionToken: string; createdAt: number; lastActiveAt: number }[] {
    return [...this.#sessions.values()].map(session => ({
      sessionToken: session.sessionToken,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
    }));
  }

  /**
   * Let a transport say whether it can still reach the controller behind a session. Called on
   * pairing and again on every reconnect, so the predicate always describes the current socket.
   */
  bindSessionDelivery(sessionToken: string, isDeliverable: () => boolean): void {
    for (const session of this.#sessions.values()) {
      if (this.#sameOpaqueId(sessionToken, session.sessionToken)) {
        session.isDeliverable = isDeliverable;
        session.deliveryGeneration += 1;
        return;
      }
    }
  }

  /** Close one session, or every session when no token is given. */
  closeSession(sessionToken?: string): boolean {
    if (sessionToken === undefined) {
      if (this.#sessions.size === 0) return false;
      this.#sessions.clear();
      return true;
    }
    for (const session of this.#sessions.values()) {
      if (this.#sameOpaqueId(sessionToken, session.sessionToken)) {
        this.#sessions.delete(session.sessionToken);
        return true;
      }
    }
    return false;
  }

  status(): RemoteControlCoreStatus {
    this.sweep();
    const now = this.#now();
    return {
      enabled: this.#enabled,
      pairingPending: !!this.#pairing && this.#pairing.expiresAt > now,
      pairingExpiresAt: this.#pairing ? new Date(this.#pairing.expiresAt).toISOString() : null,
      sessionActive: this.#sessions.size > 0,
      sessionCount: this.#sessions.size,
      // The soonest upcoming expiry across every connected phone. A single
      // timestamp cannot describe N sessions, and "when does something end"
      // is the question the status surface is actually answering.
      sessionExpiresAt: this.#earliest(session => session.createdAt + this.#absoluteTtlMs),
      sessionIdleExpiresAt: this.#earliest(session => session.lastActiveAt + this.#idleTtlMs),
    };
  }

  #sessionFor(sessionToken: string): SessionState | null {
    for (const session of this.#sessions.values()) {
      if (this.#sameOpaqueId(sessionToken, session.sessionToken)) return session;
    }
    return null;
  }

  #earliest(deadline: (session: SessionState) => number): string | null {
    let soonest: number | null = null;
    for (const session of this.#sessions.values()) {
      const value = deadline(session);
      if (soonest === null || value < soonest) soonest = value;
    }
    return soonest === null ? null : new Date(soonest).toISOString();
  }

  sweep(): RemoteControlExpiryEvent {
    const now = this.#now();
    if (this.#pairing && this.#pairing.expiresAt <= now) this.#pairing = null;
    const closed: RemoteControlClosedSession[] = [];
    for (const session of [...this.#sessions.values()]) {
      const absoluteExpired = session.createdAt + this.#absoluteTtlMs <= now;
      const idleExpired = session.lastActiveAt + this.#idleTtlMs <= now;
      if (!absoluteExpired && !idleExpired) continue;
      this.#sessions.delete(session.sessionToken);
      closed.push({
        sessionToken: session.sessionToken,
        reason: absoluteExpired ? 'absolute' : 'idle',
      });
    }
    return { closed };
  }

  async pair(token: string): Promise<RemoteControlSessionReady> {
    if (!this.#enabled) throw new RemoteControlError('REMOTE_CONTROL_DISABLED', '원격 제어가 꺼져 있습니다.', 409);
    assertBase64Url256(token, 'INVALID_PAIRING', 'QR 연결 정보가 올바르지 않습니다.');
    this.sweep();
    const pairing = this.#pairing;
    if (!pairing) throw new RemoteControlError('PAIRING_EXPIRED', 'QR 연결 시간이 만료되었습니다.', 401);
    if (!equalOpaqueToken(token, pairing.tokenHash)) {
      throw new RemoteControlError('INVALID_PAIRING', 'QR 연결 정보가 올바르지 않습니다.', 401);
    }
    // Consume before any async work. Two concurrent scans can never both pair.
    this.#pairing = null;
    if (this.#sessions.size >= REMOTE_CONTROL_MAX_SESSIONS) {
      // Sessions now outlive their sockets so a locked phone can resume, which means "away"
      // sessions occupy slots. A client that reconnects by scanning a fresh QR each time — the
      // native iOS app does exactly this — therefore filled all eight and locked the owner out on
      // the ninth pairing. Measured: pairs 1-8 succeeded, 9 returned SESSION_LIMIT.
      //
      // A QR the operator just scanned is an explicit act; a session with no socket attached is
      // the least valuable thing in the room. Retire the one that has been idle longest instead of
      // refusing. Sessions no transport reports on (the internet relay never binds a predicate)
      // count as present and are never evicted this way, and a room of eight live phones still
      // refuses — the limit is a limit on connections, not a suggestion.
      const away = [...this.#sessions.values()]
        .filter(session => session.isDeliverable?.() === false)
        .sort((first, second) => first.lastActiveAt - second.lastActiveAt)[0];
      if (!away) {
        throw new RemoteControlError(
          'SESSION_LIMIT',
          `이 Mac에는 최대 ${REMOTE_CONTROL_MAX_SESSIONS}대까지 동시에 연결할 수 있습니다. 쓰지 않는 연결을 먼저 해제하세요.`,
          409,
        );
      }
      this.#sessions.delete(away.sessionToken);
    }
    const now = this.#now();
    const session: SessionState = {
      sessionToken: opaqueToken(this.#randomBytes),
      createdAt: now,
      lastActiveAt: now,
      rateWindowStartedAt: now,
      actionsInRateWindow: 0,
      readsInRateWindow: 0,
      deliveryGeneration: 0,
      inFlightActionId: null,
      actionResults: new Map(),
      internalIdsByControlId: new Map(),
      workspaceRootIdsByControlId: new Map(),
      issuedControlIds: new Set(),
    };
    this.#sessions.set(session.sessionToken, session);
    try {
      const projects = (await this.#refreshProjectCards(session)).cards;
      const firstPage = this.#projectPage(projects, 0);
      if (!this.#enabled || this.#sessions.get(session.sessionToken) !== session) {
        throw new RemoteControlError('SESSION_INVALIDATED', 'QR 연결이 Mac에서 취소되었습니다.', 409);
      }
      return {
        type: 'session.ready',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        sessionToken: session.sessionToken,
        hostName: this.#hostName,
        expiresAt: new Date(session.createdAt + this.#absoluteTtlMs).toISOString(),
        idleExpiresAt: new Date(session.lastActiveAt + this.#idleTtlMs).toISOString(),
        projects: firstPage.projects,
        projectCount: projects.length,
        nextPage: firstPage.nextPage,
      };
    } catch (error) {
      // Remove only this pairing's session. Another phone's live session must
      // not be torn down because this one failed to build its first page.
      if (this.#sessions.get(session.sessionToken) === session) {
        this.#sessions.delete(session.sessionToken);
      }
      if (error instanceof RemoteControlError) throw error;
      throw new RemoteControlError('GATEWAY_UNAVAILABLE', '등록 프로젝트 목록을 불러오지 못했습니다.', 503);
    }
  }

  /**
   * Restore a session by sessionToken after a transient WebSocket disconnect.
   * The phone keeps its sessionToken in sessionStorage and attempts to resume
   * on reconnect, avoiding the need to re-scan the QR.
   */
  async restore(sessionToken: string): Promise<RemoteControlSessionReady> {
    if (!this.#enabled) throw new RemoteControlError('REMOTE_CONTROL_DISABLED', '원격 제어가 꺼져 있습니다.', 409);
    this.sweep();
    const session = this.#sessionFor(sessionToken);
    if (!session) {
      throw new RemoteControlError('SESSION_EXPIRED', '원격 제어 연결 시간이 만료되었습니다.', 401);
    }
    // Refresh activity timestamp
    session.lastActiveAt = this.#now();
    try {
      const projects = (await this.#refreshProjectCards(session)).cards;
      const firstPage = this.#projectPage(projects, 0);
      if (!this.#enabled || this.#sessions.get(session.sessionToken) !== session) {
        throw new RemoteControlError('SESSION_INVALIDATED', '원격 제어 연결이 Mac에서 취소되었습니다.', 409);
      }
      return {
        type: 'session.restored',
        protocolVersion: REMOTE_CONTROL_PROTOCOL_VERSION,
        sessionToken: session.sessionToken,
        hostName: this.#hostName,
        expiresAt: new Date(session.createdAt + this.#absoluteTtlMs).toISOString(),
        idleExpiresAt: new Date(session.lastActiveAt + this.#idleTtlMs).toISOString(),
        projects: firstPage.projects,
        projectCount: projects.length,
        nextPage: firstPage.nextPage,
      };
    } catch (error) {
      if (error instanceof RemoteControlError) throw error;
      throw new RemoteControlError('GATEWAY_UNAVAILABLE', '등록 프로젝트 목록을 불러오지 못했습니다.', 503);
    }
  }

  perform(request: RemoteControlActionRequest, authority?: RemoteControlActionAuthority): Promise<RemoteControlActionResult> {
    if (!this.#enabled) return Promise.reject(new RemoteControlError('REMOTE_CONTROL_DISABLED', '원격 제어가 꺼져 있습니다.', 409));
    // Keep what this sweep retired: a token that has just expired deserves
    // "your connection timed out", not "bad token". Reporting them the same way
    // tells a phone whose session simply aged out that something is wrong with
    // its credentials.
    const expired = this.sweep().closed;
    const session = this.#sessionFor(request.sessionToken);
    if (!session) {
      const justExpired = expired.some(closed => this.#sameOpaqueId(request.sessionToken, closed.sessionToken));
      return Promise.reject(justExpired
        ? new RemoteControlError('SESSION_EXPIRED', '원격 제어 연결 시간이 만료되었습니다.', 401)
        : new RemoteControlError('INVALID_SESSION_TOKEN', '원격 제어 연결이 유효하지 않습니다.', 401));
    }
    const fingerprint = `${request.action}\u0000${request.controlId ?? ''}\u0000${request.remoteConfirmed === true ? '1' : '0'}\u0000${request.page ?? ''}\u0000${request.input ?? ''}\u0000${request.workspaceRootId ?? ''}`;
    const previous = session.actionResults.get(request.actionId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        return Promise.reject(new RemoteControlError('ACTION_ID_REUSED', '같은 actionId를 다른 요청에 사용할 수 없습니다.', 409));
      }
      session.lastActiveAt = this.#now();
      return previous.promise;
    }
    if (session.actionResults.size >= this.#maxActionIdsPerSession) {
      return Promise.reject(new RemoteControlError('SESSION_ACTION_LIMIT', '이 연결의 실행 한도에 도달했습니다. QR을 새로 만들어 연결하세요.', 429));
    }
    if (session.inFlightActionId !== null) {
      return Promise.reject(new RemoteControlError('ACTION_IN_PROGRESS', '다른 원격 제어 작업이 진행 중입니다.', 409));
    }
    const now = this.#now();
    if (now - session.rateWindowStartedAt >= this.#rateWindowMs) {
      session.rateWindowStartedAt = now;
      session.actionsInRateWindow = 0;
      session.readsInRateWindow = 0;
    }
    const mutating = MUTATING_ACTIONS.has(request.action);
    const spent = mutating ? session.actionsInRateWindow : session.readsInRateWindow;
    const budget = mutating ? this.#maxActionsPerRateWindow : this.#maxReadsPerRateWindow;
    if (spent >= budget) {
      return Promise.reject(new RemoteControlError('RATE_LIMITED', '원격 제어 요청이 너무 빠릅니다. 잠시 후 다시 시도하세요.', 429));
    }
    if (mutating && request.remoteConfirmed !== true) {
      return Promise.reject(new RemoteControlError('REMOTE_CONFIRMATION_REQUIRED', '휴대폰에서 실행을 확인해야 합니다.', 409));
    }
    if (mutating) session.actionsInRateWindow += 1;
    else session.readsInRateWindow += 1;
    session.lastActiveAt = now;
    session.inFlightActionId = request.actionId;
    // Captured before the first await: this request belongs to the connection that made it.
    const delivery: CapturedDelivery = {
      generation: session.deliveryGeneration,
      isDeliverable: session.isDeliverable,
    };
    const promise = this.#execute(session, request, delivery, authority).finally(() => {
      if (this.#sessions.get(session.sessionToken) === session
        && session.inFlightActionId === request.actionId) {
        session.inFlightActionId = null;
      }
    });
    session.actionResults.set(request.actionId, { fingerprint, promise });
    return promise;
  }

  /**
   * Rebuild the exact project authority for one live session before a semantic
   * Agent Runtime operation. A control ID from another phone, a removed row, or
   * a stale Git worktree simply has no binding in the returned snapshot.
   *
   * This method intentionally returns server-only registered targets. Callers
   * must project them through a path-free task protocol before encryption.
   */
  async taskTargetBindings(sessionToken: string): Promise<RemoteControlTaskTargetBinding[]> {
    if (!this.#enabled) {
      throw new RemoteControlError('REMOTE_CONTROL_DISABLED', '원격 제어가 꺼져 있습니다.', 409);
    }
    const expired = this.sweep().closed;
    const session = this.#sessionFor(sessionToken);
    if (!session) {
      const justExpired = expired.some(closed => this.#sameOpaqueId(sessionToken, closed.sessionToken));
      throw new RemoteControlError(
        justExpired ? 'SESSION_EXPIRED' : 'INVALID_SESSION_TOKEN',
        justExpired ? '원격 제어 연결 시간이 만료되었습니다.' : '원격 제어 세션 정보가 올바르지 않습니다.',
        401,
      );
    }
    session.lastActiveAt = this.#now();
    try {
      const refreshed = await this.#refreshProjectCards(session);
      // No captured delivery here: bindings are a lookup for the terminal gateway, which gates
      // liveness itself through the connected-owner list.
      this.#assertSessionStillActive(session);
      const bindings: RemoteControlTaskTargetBinding[] = [];
      for (const [controlId, internalId] of session.internalIdsByControlId) {
        const target = refreshed.targetsByInternalId.get(internalId);
        if (target) bindings.push({ controlId, target });
      }
      return bindings;
    } catch (error) {
      if (error instanceof RemoteControlError) throw error;
      throw new RemoteControlError(
        'GATEWAY_UNAVAILABLE',
        '등록 프로젝트 목록을 불러오지 못했습니다.',
        503,
      );
    }
  }

  async #execute(
    session: SessionState,
    request: RemoteControlActionRequest,
    delivery?: CapturedDelivery,
    authority?: RemoteControlActionAuthority,
  ): Promise<RemoteControlActionResult> {
    try {
      if (request.action === 'protocol.capabilities') {
        return {
          type: 'action.result',
          actionId: request.actionId,
          ok: true,
          supportedFeatures: [...this.#supportedFeatures],
        };
      }
      if (request.action === 'projects.list') {
        const refreshed = await this.#refreshProjectCards(session);
        this.#assertSessionStillActive(session, delivery);
        const page = request.page ?? 0;
        const result = this.#projectPage(refreshed.cards, page);
        return {
          type: 'action.result', actionId: request.actionId, ok: true,
          projects: result.projects,
          page,
          projectCount: refreshed.cards.length,
          nextPage: result.nextPage,
        };
      }
      if (request.action === 'workspace-roots.list') {
        const refreshed = await this.#refreshWorkspaceRoots(session);
        this.#assertSessionStillActive(session, delivery);
        return {
          type: 'action.result', actionId: request.actionId, ok: true,
          workspaceRoots: refreshed.roots,
        };
      }
      if (request.action === 'project.create') {
        if (!this.#gateway.createProject) {
          throw new RemoteControlError('ACTION_NOT_AVAILABLE', '이 설치본에서는 원격 프로젝트 생성을 사용할 수 없습니다.', 409);
        }
        const requestedRootId = request.workspaceRootId!;
        const priorInternalId = session.workspaceRootIdsByControlId.get(requestedRootId);
        if (!priorInternalId) throw new RemoteControlError('WORKSPACE_ROOT_NOT_FOUND', '현재 연결에서 사용할 수 있는 작업 루트가 아닙니다.', 404);
        const refreshedRoots = await this.#refreshWorkspaceRoots(session);
        this.#assertSessionStillActive(session, delivery);
        if (session.workspaceRootIdsByControlId.get(requestedRootId) !== priorInternalId) {
          throw new RemoteControlError('WORKSPACE_ROOT_NOT_FOUND', '등록된 작업 루트가 변경되었습니다. 목록을 다시 확인하세요.', 404);
        }
        const workspaceRoot = refreshedRoots.targetsByInternalId.get(priorInternalId);
        if (!workspaceRoot) throw new RemoteControlError('WORKSPACE_ROOT_NOT_FOUND', '등록된 작업 루트를 찾을 수 없습니다.', 404);
        const created = await this.#gateway.createProject({
          workspaceRoot,
          projectName: request.input!.trim(),
          actionId: request.actionId,
          controllerId: authority?.controllerId ?? `lan:${createHash('sha256').update(`agentstoz-lan-pairing-v1:${session.sessionToken}`).digest('hex')}`,
          sessionExpiresAt: authority?.expiresAt ?? new Date(session.createdAt + this.#absoluteTtlMs).toISOString(),
        });
        const refreshed = await this.#refreshProjectCards(session);
        this.#assertSessionStillActive(session, delivery);
        if (created) {
          const entry = [...session.internalIdsByControlId.entries()].find(([, id]) => id === created.internalId);
          const project = entry && refreshed.cards.find(card => card.controlId === entry[0]);
          if (!project) throw new RemoteControlError('CREATED_PROJECT_UNAVAILABLE', '프로젝트는 생성했지만 현재 등록 상태를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.', 409);
          return {type: 'action.result', actionId: request.actionId, ok: true, project};
        }
        const result = this.#projectPage(refreshed.cards, 0);
        return {
          type: 'action.result', actionId: request.actionId, ok: true,
          projects: result.projects,
          page: 0,
          projectCount: refreshed.cards.length,
          nextPage: result.nextPage,
        };
      }
      const controlId = request.controlId!;
      const internalId = session.internalIdsByControlId.get(controlId);
      if (!internalId) throw new RemoteControlError('PROJECT_NOT_FOUND', '현재 연결에서 제어 가능한 프로젝트가 아닙니다.', 404);
      // Re-read the registered rows immediately before every operation. The
      // opaque mapping is rebuilt from current rows, so deletion/replacement
      // cannot leave a stale controlId executable.
      const refreshedBeforeAction = await this.#refreshProjectCards(session);
      this.#assertSessionStillActive(session, delivery);
      if (session.internalIdsByControlId.get(controlId) !== internalId) {
        throw new RemoteControlError('PROJECT_NOT_FOUND', '현재 등록된 프로젝트가 아닙니다.', 404);
      }
      const current = refreshedBeforeAction.cards.find((project) => project.controlId === controlId);
      const currentTarget = refreshedBeforeAction.targetsByInternalId.get(internalId);
      if (!current) throw new RemoteControlError('PROJECT_NOT_FOUND', '현재 등록된 프로젝트가 아닙니다.', 404);
      if (!currentTarget) throw new RemoteControlError('PROJECT_NOT_FOUND', '현재 등록된 프로젝트가 아닙니다.', 404);
      if (request.action === 'project.status') {
        return { type: 'action.result', actionId: request.actionId, ok: true, project: current };
      }
      if (!current.actions.includes(request.action)) {
        throw new RemoteControlError('ACTION_NOT_AVAILABLE', '현재 프로젝트 상태에서는 이 기능을 실행할 수 없습니다.', 409);
      }
      await this.#gateway.executeRegisteredProjectAction({
        action: request.action,
        target: currentTarget,
        actionId: request.actionId,
        ...(request.input ? { input: request.input.trim() } : {}),
      });
      const refreshed = await this.#refreshProjectCards(session);
      if (request.action === 'worktree.add' || request.action === 'worktree.add.orca') {
        // Answer with the page the NEW card is on, not page 0. The controller
        // replaces its whole accumulated list on a page-0 result, so returning
        // page 0 collapsed the list back to the first 20 cards and hid the
        // worktree that was just created — the creation read as a silent
        // no-op. The gateway now groups a child directly after its parent, so
        // this is normally the page the user is already looking at.
        const knownBefore = new Set(refreshedBeforeAction.cards.map((project) => project.controlId));
        const createdIndex = refreshed.cards.findIndex((project) => !knownBefore.has(project.controlId));
        const page = createdIndex >= 0
          ? Math.floor(createdIndex / REMOTE_CONTROL_PROJECT_PAGE_SIZE)
          : 0;
        const result = this.#projectPage(refreshed.cards, page);
        return {
          type: 'action.result', actionId: request.actionId, ok: true,
          projects: result.projects,
          page,
          projectCount: refreshed.cards.length,
          nextPage: result.nextPage,
        };
      }
      return {
        type: 'action.result',
        actionId: request.actionId,
        ok: true,
        project: refreshed.cards.find((project) => project.controlId === controlId) ?? null,
      };
    } catch (error) {
      return {
        type: 'action.result',
        actionId: request.actionId,
        ok: false,
        error: remoteControlPublicError(error),
      };
    }
  }

  #newPairing(baseUrl: string): RemoteControlPairingDescriptor {
    const token = opaqueToken(this.#randomBytes);
    const expiresAt = this.#now() + this.#pairingTtlMs;
    this.#pairing = { tokenHash: tokenDigest(token), expiresAt };
    // Minting a new QR must NOT drop the phones already connected. Adding a
    // second device is exactly "rotate the QR and scan it from the other
    // phone", so tearing down the existing sessions here would make the
    // multi-device flow impossible to perform. Callers that genuinely want the
    // old connections gone call closeSession()/disable() explicitly.
    return {
      pairingUrl: pairingUrl(baseUrl, token),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async #refreshProjectCards(session: SessionState): Promise<{
    cards: RemoteControlProjectDto[];
    targetsByInternalId: Map<string, RemoteControlRegisteredTarget>;
  }> {
    const registered = sanitizeRegisteredTargets(await this.#gateway.listRegisteredProjects());
    const priorControlIdByInternalId = new Map<string, string>();
    for (const [controlId, internalId] of session.internalIdsByControlId) {
      priorControlIdByInternalId.set(internalId, controlId);
    }
    const nextIds = new Map<string, string>();
    const cards: RemoteControlProjectDto[] = [];
    for (const project of registered) {
      const existing = priorControlIdByInternalId.get(project.internalId);
      let controlId = existing;
      if (!controlId) {
        if (session.issuedControlIds.size >= 4_096) {
          throw new RemoteControlError('CONTROL_ID_LIMIT', '프로젝트 목록 변경이 너무 많아 QR을 새로 만들어야 합니다.', 429);
        }
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const candidate = createHmac('sha256', session.sessionToken).update(`agentstoz-project-control-v1\0${project.internalId}\0${attempt}`).digest('base64url');
          if (!session.issuedControlIds.has(candidate)) {
            controlId = candidate;
            session.issuedControlIds.add(candidate);
            break;
          }
        }
      }
      if (!controlId) throw new RemoteControlError('CONTROL_ID_UNAVAILABLE', '프로젝트 제어 ID를 만들지 못했습니다.', 503);
      nextIds.set(controlId, project.internalId);
      cards.push(publicRemoteControlProject(project, controlId));
    }
    session.internalIdsByControlId = nextIds;
    return {
      cards,
      targetsByInternalId: new Map(registered.map((target) => [target.internalId, target])),
    };
  }

  async #refreshWorkspaceRoots(session: SessionState): Promise<{
    roots: RemoteControlWorkspaceRootDto[];
    targetsByInternalId: Map<string, RemoteControlWorkspaceRootTarget>;
  }> {
    if (!this.#gateway.listWorkspaceRoots) {
      throw new RemoteControlError('ACTION_NOT_AVAILABLE', '이 설치본에서는 원격 프로젝트 생성을 사용할 수 없습니다.', 409);
    }
    const registered = sanitizeWorkspaceRoots(await this.#gateway.listWorkspaceRoots());
    const priorControlIdByInternalId = new Map<string, string>();
    for (const [controlId, internalId] of session.workspaceRootIdsByControlId) {
      priorControlIdByInternalId.set(internalId, controlId);
    }
    const nextIds = new Map<string, string>();
    const roots: RemoteControlWorkspaceRootDto[] = [];
    for (const root of registered) {
      let controlId = priorControlIdByInternalId.get(root.internalId);
      if (!controlId) {
        if (session.issuedControlIds.size >= 4_096) {
          throw new RemoteControlError('CONTROL_ID_LIMIT', '원격 제어 ID 한도에 도달해 QR을 새로 만들어야 합니다.', 429);
        }
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const candidate = createHmac('sha256', session.sessionToken).update(`agentstoz-workspace-root-control-v1\0${root.internalId}\0${attempt}`).digest('base64url');
          if (!session.issuedControlIds.has(candidate)) {
            controlId = candidate;
            session.issuedControlIds.add(candidate);
            break;
          }
        }
      }
      if (!controlId) throw new RemoteControlError('CONTROL_ID_UNAVAILABLE', '작업 루트 제어 ID를 만들지 못했습니다.', 503);
      nextIds.set(controlId, root.internalId);
      roots.push({ controlId, name: root.name });
    }
    session.workspaceRootIdsByControlId = nextIds;
    return {
      roots,
      targetsByInternalId: new Map(registered.map((root) => [root.internalId, root])),
    };
  }

  #sameOpaqueId(actual: string, expected: string): boolean {
    if (!BASE64URL_256_RE.test(actual) || !BASE64URL_256_RE.test(expected)) return false;
    const a = Buffer.from(actual, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.byteLength === b.byteLength && timingSafeEqual(a, b);
  }

  /**
   * Pages are bounded by BYTES first and card count second, because the ceiling
   * that matters is the relay's: `encryptRemoteControlRelayEnvelope` refuses a
   * plaintext over REMOTE_CONTROL_RELAY_MAX_PLAINTEXT_BYTES, so an oversized
   * page cannot be sent at all — the phone gets nothing rather than a long
   * list. Fixed 20-card pages were already within ~280 bytes of that ceiling
   * with long names, so any added field or a few long branch names would have
   * silently crossed it.
   */
  #projectPage(projects: RemoteControlProjectDto[], page: number): {
    projects: RemoteControlProjectDto[];
    nextPage: number | null;
  } {
    const pages: RemoteControlProjectDto[][] = [];
    let current: RemoteControlProjectDto[] = [];
    let bytes = 0;
    for (const project of projects) {
      const size = Buffer.byteLength(JSON.stringify(project), 'utf8') + 1;
      const full = current.length >= REMOTE_CONTROL_PROJECT_PAGE_SIZE
        || bytes + size > REMOTE_CONTROL_PROJECT_PAGE_BYTES;
      // A single card larger than the budget still gets a page of its own —
      // sending one oversized message that fails loudly beats looping forever.
      if (current.length > 0 && full) {
        pages.push(current);
        current = [];
        bytes = 0;
      }
      current.push(project);
      bytes += size;
    }
    if (current.length > 0) pages.push(current);
    return {
      projects: pages[page] ?? [],
      nextPage: page + 1 < pages.length ? page + 1 : null,
    };
  }

  #assertSessionStillActive(session: SessionState, delivery?: CapturedDelivery): void {
    if (!this.#enabled || this.#sessions.get(session.sessionToken) !== session) {
      throw new RemoteControlError('SESSION_EXPIRED', '원격 제어 연결이 Mac에서 종료되었습니다.', 401);
    }
    // Checked on the same edges as session validity: every await inside #execute happens before a
    // side effect, so a connection that died while a lookup was in flight cancels the action
    // rather than committing it to a phone that is no longer listening. The generation is what
    // makes this per-request: a reconnect during the await replaces the predicate, and asking the
    // new one would answer "connected" for an action the old connection abandoned.
    if (!delivery) return;
    if (session.deliveryGeneration !== delivery.generation || delivery.isDeliverable?.() === false) {
      throw new RemoteControlError('SESSION_DISCONNECTED', '요청 중에 원격 연결이 끊겨 실행하지 않았습니다.', 409);
    }
  }
}
