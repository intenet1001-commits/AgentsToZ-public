import type {MobileWorkspaceRequest,MobileWorkspaceResult} from './mobileWorkspaceProtocol';
import {normalizeRemoteTerminalResult,type RemoteTerminalResult} from './remoteControlTerminalProtocol';
import {AI_TERMINAL_REQUEST_INVALID_CODE,type AiTerminalRequest,type AiTerminalResponse} from './aiTerminalProtocol';
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
  normalizeQrRemoteControlOpsCandidates,
  normalizeQrRemoteControlOpsStatus,
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
import { phoneIsOnline, phoneOfflineNotice, phoneOfflineRefusal, relayUnreachableNotice, relayUnreachableRefusal } from './phoneNetwork';
import { isTransientNetworkError } from './remoteTransientNetworkError';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MESSAGE_TTL_MS = 10 * 60_000;
/**
 * Once the relay envelope expires, the host cannot take an undelivered request
 * (its receive RPC filters on `envelope_expires_at`). The host may already have
 * executed it, so the extra minute bounds the lock without claiming cancellation.
 */
const REMOTE_CONTROL_PENDING_ACTION_TIMEOUT_MS = MESSAGE_TTL_MS + 60_000;

/** Reads driven by the Workroom/tester refresh loops must not look like a user tap. */
/**
 * 릴레이는 요청을 **하나씩** 처리하므로 한 줄이 길어지면 사용자가 방금 누른 것까지 거절된다
 * (2026-10-05 실기: 기기 탭 아래에 「대기 중인 원격 입력이 많습니다」가 뜨고 프로젝트 목록이 비었다).
 * 그래서 상한을 **클래스별로** 둔다: 배경 조회와 음성은 자리를 다 차지할 수 없고, 사람이 누른
 * 요청(입력·시작·목록 요청)은 언제나 들어갈 자리가 남는다.
 */
export const TERMINAL_QUEUE_LIMIT=32;
export const TERMINAL_QUEUE_BACKGROUND_LIMIT=16;
export const TERMINAL_QUEUE_VOICE_LIMIT=8;
/** 음성은 자기 재시도·마감이 있으므로 줄을 길게 잡지 않는다(묵은 프레임은 의미가 없다). */
function isVoiceTerminalRequest(request: AiTerminalRequest|MobileWorkspaceRequest): boolean {
  return request.operation==='workspace'&&request.workspace.action==='voice';
}
export function terminalQueueRejection(counts:{total:number;background:number;voice:number},
  request:{background:boolean;voice:boolean}):string|null {
  const limit=request.voice?TERMINAL_QUEUE_VOICE_LIMIT:request.background?TERMINAL_QUEUE_BACKGROUND_LIMIT:TERMINAL_QUEUE_LIMIT;
  const used=request.voice?counts.voice:request.background?counts.background:counts.total;
  if(used<limit)return null;
  // 무엇이 줄을 채웠는지 말한다 — 화면에 그대로 나가므로 다음 보고가 추측이 아니라 자료가 된다.
  return `대기 중인 원격 입력이 많습니다 (조회 ${counts.background} · 음성 ${counts.voice} · 전체 ${counts.total}). 잠시 후 다시 시도하세요.`;
}

function isBackgroundTerminalRequest(request: AiTerminalRequest|MobileWorkspaceRequest): boolean {
  return request.operation === 'read'
    || request.operation === 'list'
    || (request.operation === 'workspace'
      // `community.status`는 기기 목록을 주기적으로 확인하는 **배경 조회**다. 사람이 누르는
      // `community.read`·`send`·`projects`는 전경으로 남긴다(그쪽이 기다리는 쪽이다).
      && ['workroom.status', 'memory.status', 'tester.status', 'tester.read', 'community.status'].includes(request.workspace.action));
}

const FOREGROUND_TASK_OPERATIONS: ReadonlySet<RemoteControlTaskOperation> = new Set([
  'tasks.start', 'tasks.cancel',
]);
const FOREGROUND_CONVERSATION_OPERATIONS: ReadonlySet<RemoteControlConversationOperation> = new Set([
  'conversations.start', 'conversations.continue', 'conversations.steer',
  'conversations.interrupt', 'conversations.archive', 'conversations.unarchive',
]);

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
    /** Files a dirty-tree refusal names; the portal lists them like the QR page does. */
    readonly changedPaths: readonly string[] = [],
  ) {
    super(message);
    this.name = 'RemoteControlRelayRequestError';
  }
}

export const REMOTE_CONTROL_HOST_UPDATE_REQUIRED = 'REMOTE_CONTROL_HOST_UPDATE_REQUIRED' as const;

/**
 * The phone's network, not the Mac (2026-10-10, iPhone with Wi‑Fi off). Two different situations:
 *
 * - `REMOTE_CONTROL_REQUEST_UNSENT` — an encrypted request is still in this phone's outbox
 *   (`#pendingOutbound`): its last send failed with a network error, or the relay is unreachable now.
 *   It is kept as the exact same envelope and sent once when a refresh reaches the relay again
 *   (the relay accepts only an exact duplicate, so it cannot run twice). Past its ~10-minute
 *   delivery expiry it is never replayed — `#flushPendingOutbound` sends a pairing checkpoint instead.
 *   Before this the phone said 「앞서 보낸 요청의 결과를 Mac이 아직 보내지 않았습니다」 for a request
 *   the Mac never saw.
 * - `REMOTE_CONTROL_REQUEST_UNSENT_AHEAD` — a NEW call refused because an earlier envelope is still in the
 *   outbox. This call itself was not kept: nothing of it goes out later. Callers that treat
 *   `REMOTE_CONTROL_REQUEST_UNSENT` as "this request is held" (aiTerminalScheduling's failGroup, remoteVoc) must
 *   not see this code as theirs — one shared code once promised delivery of input that was dropped (review
 *   2026-10-10).
 * - `REMOTE_CONTROL_PHONE_OFFLINE` — the device reports no network, so a new request is refused before
 *   anything is encrypted or queued. Nothing waits on the phone.
 */
export const REMOTE_CONTROL_REQUEST_UNSENT = 'REMOTE_CONTROL_REQUEST_UNSENT' as const;
export const REMOTE_CONTROL_REQUEST_UNSENT_AHEAD = 'REMOTE_CONTROL_REQUEST_UNSENT_AHEAD' as const;
export const REMOTE_CONTROL_PHONE_OFFLINE = 'REMOTE_CONTROL_PHONE_OFFLINE' as const;
/**
 * The request did reach the relay, but this phone could not read the Mac's answer (its network, or a
 * relay it cannot reach). It may be running or done on the Mac — the opposite of "unsent", so it must
 * never be shown as 「Mac 연결은 정상」 or cleared as a plain network blip.
 */
export const REMOTE_CONTROL_RESULT_UNREACHABLE = 'REMOTE_CONTROL_RESULT_UNREACHABLE' as const;
// Delivery is tied to this screen reconnecting, not to the network alone: only a refresh of this page
// flushes the outbox, and only within the envelope's expiry counted from the original tap.
const UNSENT_NOW_MESSAGE = '휴대폰 네트워크가 끊겨 이 요청을 아직 Mac에 보내지 못했을 수 있습니다. 요청은 이 휴대폰에 그대로 두었다가, 이 화면이 다시 연결되면 같은 요청을 한 번만 보냅니다 — 두 번 실행되지 않으니 다시 누르지 마세요. 처음 보낸 지 약 10분이 지나면 보내지 않습니다.';
const UNSENT_BLOCKED_PREFIX = '앞서 보낸 요청이 휴대폰 네트워크 문제로 아직 Mac에 전달되지 않았을 수 있습니다. 그 요청은 이 화면이 다시 연결되면 한 번만 보내고, 그 뒤에 새 요청을 보낼 수 있습니다.';
/** The time left is the envelope's own, fixed when it was encrypted — not a fresh 10 minutes per tap. */
function unsentBlockedMessage(remainingMs: number): string {
  if (remainingMs <= 0) return '앞서 보낸 요청이 휴대폰 네트워크 문제로 아직 Mac에 전달되지 않았을 수 있습니다. 전달 기한(처음 보낸 지 약 10분)이 지나 그 요청은 보내지 않습니다 — 이미 전달됐을 수도 있으니, 다시 연결되면 목록을 확인하세요.';
  const minutes = Math.ceil(remainingMs / 60_000);
  return minutes <= 1
    ? `${UNSENT_BLOCKED_PREFIX} 1분 안에 다시 연결되지 않으면 그 요청은 보내지 않습니다.`
    : `${UNSENT_BLOCKED_PREFIX} 약 ${minutes}분 안에 다시 연결되지 않으면 그 요청은 보내지 않습니다.`;
}
const MAC_SILENT_MESSAGE = 'Mac이 응답하지 않습니다. 절전 상태이거나 AgentsToZ가 꺼져 있을 수 있습니다 — Mac을 깨운 뒤 다시 실행하세요.';
const RESULT_UNREACHABLE_MESSAGE = '휴대폰에서 릴레이에 연결하지 못해 Mac의 응답을 받지 못했습니다. 요청은 이미 Mac에 전달됐고 실행 중이거나 끝났을 수 있으니, 다시 누르지 말고 네트워크가 돌아온 뒤 화면을 확인하세요.';
const RESULT_PENDING_UNREACHABLE_MESSAGE = '휴대폰에서 릴레이에 연결하지 못해 앞서 보낸 요청의 결과를 아직 받지 못했습니다. 그 요청은 Mac에서 실행 중이거나 끝났을 수 있으니, 네트워크가 돌아온 뒤 목록을 확인하세요.';
const EXPIRED_AFTER_STALL_MESSAGE = '휴대폰이 오래 오프라인이어서 보내지 못한 요청은 다시 보내지 않았습니다. 이미 전달됐을 수도 있으니 목록을 새로고침해 확인한 뒤 판단하세요.';
/**
 * An envelope still in the outbox outlived its expiry, and this side does not know why it stayed
 * there (a reloaded page forgets the network flags, or the last send failed ambiguously). The relay
 * never confirmed it, so the Mac is not to blame either way.
 */
const EXPIRED_UNSENT_MESSAGE = '보내지 못한 채 남아 있던 요청이 전달 기한(처음 보낸 지 약 10분)을 넘겨 다시 보내지 않았습니다. 이미 전달됐을 수도 있으니 목록을 새로고침해 확인한 뒤 판단하세요.';

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
  /** Null until probed; empty means an authenticated legacy/base host. */
  supportedFeatures: RemoteControlSupportedFeature[] | null;
  /** True only while a user-triggered request is queued or in flight. */
  requesting: boolean;
  busy: boolean;
  error: string | null;
  /**
   * When the Mac last spoke to the relay, as the relay saw it. Null means the
   * question could not be answered — an older sidecar, or no status read yet —
   * and must never be shown or treated as "asleep".
   */
  hostLastSeenAt: string | null;
  /**
   * The last relay call failed with a network error. While true, a frozen `hostLastSeenAt` says
   * nothing about the Mac — this side could not ask.
   */
  relayUnreachable: boolean;
  /** A request is still in this phone's outbox and the network is why (`REMOTE_CONTROL_REQUEST_UNSENT`). */
  unsentRequest: boolean;
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
  /** The device's network state; defaults to `navigator.onLine` through `phoneIsOnline`. */
  isOnline?: () => boolean;
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
      const hasOps = Object.prototype.hasOwnProperty.call(raw, 'ops');
      const hasOpsCandidates = Object.prototype.hasOwnProperty.call(raw, 'opsCandidates');
      if ([hasProjects, hasProject, hasWorkspaceRoots, hasSupportedFeatures, hasOps, hasOpsCandidates].filter(Boolean).length !== 1
        || Object.keys(raw).some(key => !['type', 'actionId', 'ok', 'projects', 'project', 'workspaceRoots', 'supportedFeatures', 'ops', 'opsCandidates', 'page', 'projectCount', 'nextPage'].includes(key))) {
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
      if (hasOps) {
        if (Object.keys(raw).length !== 4) throw new Error('REMOTE_CONTROL_RESPONSE_INVALID');
        return {type: 'action.result', actionId, ok: true, ops: normalizeQrRemoteControlOpsStatus({ops: raw.ops})};
      }
      if (hasOpsCandidates) {
        if (Object.keys(raw).length !== 4) throw new Error('REMOTE_CONTROL_RESPONSE_INVALID');
        return {type:'action.result',actionId,ok:true,opsCandidates:normalizeQrRemoteControlOpsCandidates({opsCandidates:raw.opsCandidates})};
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
  #pendingActionIsForeground = false;
  #pendingCapabilityProbeActionId: string | null = null;
  #pendingActionSentAt = 0;
  #terminalResult: RemoteTerminalResult | null = null;
  #terminalRequestId: string | null = null;
  #interactiveRead: {sessionId: string; token: string; until: number} | null = null;
  #pendingTaskOperationId: string | null = null;
  #pendingTaskIsForeground = false;
  #pendingTaskRequest: RemoteControlTaskRequest | null = null;
  #pendingTaskResult: RemoteControlTaskResult | null = null;
  #pendingTaskSentAt = 0;
  #pendingConversationOperationId: string | null = null;
  #pendingConversationIsForeground = false;
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
  #pollWaiters = 0;
  #userWaiters = 0;
  #foregroundTerminalRequests = 0;
  #error: string | null = null;
  #requestErrorCode: string | null = null;
  #requestChangedPaths: readonly string[] = [];
  #hostLastSeenAt: string | null = null;
  #sleep: (ms: number) => Promise<void>;
  readonly #isOnline: () => boolean;
  /**
   * The last relay call failed with a network error. Any answer from the relay — success or a
   * refusal — proves it is reachable and clears this.
   */
  #relayUnreachable = false;
  /** `#pendingOutbound`'s last send failed with a network error (a relay refusal clears it). */
  #outboundStalled = false;
  /**
   * An outbox envelope outlived its delivery expiry and was not replayed; said once at session.ready.
   * `stall` — this side knows the network held it back; `unknown` — it does not (a reloaded page
   * forgets the flags). Neither is a Mac restart: the relay never confirmed the envelope.
   */
  #expiredOutbox: 'stall' | 'unknown' | null = null;

  constructor(options: RemoteControlRelayControllerOptions) {
    this.#transport = options.transport;
    this.#controllerName = options.controllerName.trim();
    if (!this.#controllerName || this.#controllerName.length > 80) throw new Error('REMOTE_CONTROL_CONTROLLER_NAME_INVALID');
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.#isOnline = options.isOnline ?? (() => phoneIsOnline());
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
      requesting: this.#foregroundTerminalRequests > 0
        || this.#pendingActionIsForeground
        || this.#pendingTaskIsForeground
        || this.#pendingConversationIsForeground,
      busy: this.#busy
        || this.#pendingOutbound !== null
        || this.#pendingActionId !== null
        || this.#pendingTaskOperationId !== null
        || this.#pendingConversationOperationId !== null,
      error: this.#error,
      hostLastSeenAt: this.#hostLastSeenAt,
      relayUnreachable: this.#relayUnreachable,
      unsentRequest: this.#unsentRequest(),
    };
  }

  /**
   * A relay call that failed because this side has no usable network: a recognised fetch failure, or
   * a transport-level failure while the device reports no network. A refusal the Mac or the relay
   * actually sent is never reclassified.
   */
  #isNetworkFailure(error: unknown): boolean {
    if (isTransientNetworkError(error)) return true;
    if (this.#isOnline()) return false;
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    return code === 'RELAY_REQUEST_FAILED' || code === 'RELAY_CONNECTION_FAILED'
      || (code === undefined && error instanceof TypeError);
  }

  /** Every relay round trip records whether this side could reach the relay at all. */
  async #relay<T>(run: () => Promise<T>): Promise<T> {
    try {
      const result = await run();
      this.#relayUnreachable = false;
      return result;
    } catch (error) {
      // A refusal is an answer: the relay was reachable. Only a network failure says it was not.
      this.#relayUnreachable = this.#isNetworkFailure(error);
      throw error;
    }
  }

  /**
   * The device reported losing its network. Until a relay call succeeds again, a frozen last-seen
   * time is ours, not the Mac's — without this, the moment the network returned (and before the
   * first status read) the screen briefly called an awake Mac 「N분째 응답 없음」.
   */
  noteNetworkLost(): void {
    this.#relayUnreachable = true;
  }

  #unsentRequest(): boolean {
    return this.#pendingOutbound !== null
      && (this.#outboundStalled || this.#relayUnreachable || !this.#isOnline());
  }

  /**
   * The refusal for "something is still in flight". When that something never left the phone, say so —
   * the generic code made the portal claim 「Mac 연결은 정상」 beside a phone with no network.
   */
  #inProgressError(background = false): Error {
    if (this.#unsentRequest()) {
      // Its own code: this call was refused, not kept (only `#sendPayload`'s error means "held").
      const remaining = Date.parse(this.#pendingOutbound!.expiresAt) - this.#now();
      return new RemoteControlRelayRequestError(REMOTE_CONTROL_REQUEST_UNSENT_AHEAD, unsentBlockedMessage(remaining));
    }
    if (this.#relayUnreachable) {
      // Delivered, but this phone cannot read the answer: the Mac may be running it or done.
      if (this.#awaitingResult()) {
        return new RemoteControlRelayRequestError(REMOTE_CONTROL_RESULT_UNREACHABLE, RESULT_PENDING_UNREACHABLE_MESSAGE);
      }
      // Only a refresh is in flight, against a relay this phone cannot reach: nothing about the Mac is known.
      return new RemoteControlRelayRequestError(REMOTE_CONTROL_PHONE_OFFLINE, relayUnreachableRefusal(background));
    }
    return new Error('REMOTE_CONTROL_ACTION_IN_PROGRESS');
  }

  /** A request left the phone and its answer has not been read yet. */
  #awaitingResult(): boolean {
    return this.#pendingOutbound === null && (this.#pendingActionId !== null
      || this.#pendingTaskOperationId !== null || this.#pendingConversationOperationId !== null);
  }

  /**
   * Read the answer to a request that already reached the relay. A network failure here is not
   * "unsent" and not a Mac refusal: say the request may be running, and keep its lock.
   */
  async #receiveForResult(): Promise<void> {
    try {
      await this.#receive();
    } catch (error) {
      if (!(error instanceof RemoteControlRelayRequestError) && this.#isNetworkFailure(error)) {
        throw Object.assign(
          new RemoteControlRelayRequestError(REMOTE_CONTROL_RESULT_UNREACHABLE, RESULT_UNREACHABLE_MESSAGE),
          { cause: error },
        );
      }
      throw error;
    }
  }

  /**
   * What to say when a pending request is released because its outbox envelope expired unsent.
   * `#expiredOutbox` first: once `#flushPendingOutbound` has swapped the expired envelope for the pairing
   * checkpoint and sent it, the outbox is empty and the network flags are clear, but the reason is still known
   * (review 2026-10-10: a Mac answering the checkpoint after the 11-minute mark got the Mac blamed).
   */
  #expiredOutboxMessage(): string {
    if (this.#expiredOutbox) return this.#expiredOutbox === 'stall' ? EXPIRED_AFTER_STALL_MESSAGE : EXPIRED_UNSENT_MESSAGE;
    return this.#outboundStalled || this.#relayUnreachable ? EXPIRED_AFTER_STALL_MESSAGE : EXPIRED_UNSENT_MESSAGE;
  }

  /**
   * Refuse before anything is encrypted or queued: a request made offline must not occupy the outbox.
   * `background` — the workroom's own list/read poll: nobody pressed anything, so it says the page reconnects by itself.
   */
  #refuseWhilePhoneOffline(background = false): void {
    if (!this.#isOnline()) {
      throw new RemoteControlRelayRequestError(REMOTE_CONTROL_PHONE_OFFLINE, phoneOfflineRefusal(background));
    }
  }

  /** The silent-Mac refusal, unless the silence is ours: a relay this phone cannot reach proves nothing. */
  #silentHostError(): Error {
    return this.#relayUnreachable
      ? new RemoteControlRelayRequestError(REMOTE_CONTROL_PHONE_OFFLINE, relayUnreachableRefusal(false))
      : new Error(MAC_SILENT_MESSAGE);
  }

  /**
   * `#sendPayload` wraps its network failure as REQUEST_UNSENT for the request a user made. The automatic pairing
   * send is no such request: hand on the network error itself, so nothing claims 「다시 누르지 마세요」 or
   * 「약 10분이 지나면 보내지 않습니다」 for a message the user never sent (review 2026-10-10).
   */
  #notAUserRequest(error: unknown): unknown {
    return error instanceof RemoteControlRelayRequestError && error.code === REMOTE_CONTROL_REQUEST_UNSENT && error.cause
      ? error.cause : error;
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
    if (this.#busy || this.#pollWaiters > 0) return this.status();
    this.#busy = true;
    try {
      const status = await this.#relay(() => this.#transport.status(claim.hostId, claim.sessionId));
      this.#lastStatusAt = this.#now();
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
        // After the envelope expires, an undelivered request can no longer be
        // taken by the host. It may already have run, so release the bounded
        // lock while reporting an unknown outcome, never a cancellation.
        // Checked before the flush below, which is what replaces an expired outbox envelope. After that flush the
        // outbox is empty while `#expiredOutbox` still says why the request never went (until session.ready).
        const unconfirmed = this.#pendingOutbound !== null || this.#expiredOutbox !== null;
        if (this.#pendingActionId !== null
          && this.#pendingActionSentAt > 0
          && now - this.#pendingActionSentAt > REMOTE_CONTROL_PENDING_ACTION_TIMEOUT_MS) {
          this.#pendingActionId = null;
          this.#pendingCapabilityProbeActionId = null;
          this.#pendingActionSentAt = 0;
          // Still in the outbox: the relay never confirmed it, so the Mac is not why there is no answer.
          this.#error = unconfirmed ? this.#expiredOutboxMessage()
            : 'Mac의 응답을 받지 못해 이전 요청의 완료 여부를 알 수 없습니다. 이미 실행됐을 수 있으니 프로젝트 상태를 확인한 뒤 판단하세요.';
        }
        if (this.#pendingTaskOperationId !== null
          && this.#pendingTaskSentAt > 0
          && now - this.#pendingTaskSentAt > REMOTE_CONTROL_PENDING_ACTION_TIMEOUT_MS) {
          this.#pendingTaskOperationId = null;
          this.#pendingTaskRequest = null;
          this.#pendingTaskResult = null;
          this.#pendingTaskSentAt = 0;
          this.#error = unconfirmed ? this.#expiredOutboxMessage()
            : 'Mac이 응답하지 않아 작업 요청을 닫았습니다. 작업 목록을 새로고침해 실제 상태를 확인하세요.';
        }
        if (this.#pendingConversationOperationId !== null
          && this.#pendingConversationSentAt > 0
          && now - this.#pendingConversationSentAt > REMOTE_CONTROL_PENDING_ACTION_TIMEOUT_MS) {
          this.#pendingConversationOperationId = null;
          this.#pendingConversationRequest = null;
          this.#pendingConversationResult = null;
          this.#pendingConversationSentAt = 0;
          this.#error = unconfirmed ? this.#expiredOutboxMessage()
            : 'Mac이 응답하지 않아 대화 요청을 닫았습니다. 대화 목록을 새로고침해 실제 상태를 확인하세요.';
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
          }).catch(error => { throw this.#notAUserRequest(error); });
          await this.#receive();
        }
      }
    } catch (error) {
      if (isTerminalRelaySessionFailure(error)) {
        this.#closeLocal('원격제어 연결 시간이 만료되었거나 종료되었습니다.');
        await this.#persistSession();
        throw error;
      }
      // A dropped fetch is this phone's network, not a broken session: say that, keep the outbox as it is.
      // (The pairing send's error arrives unwrapped — `#notAUserRequest`.)
      this.#error = this.#isNetworkFailure(error)
        ? (this.#isOnline() ? relayUnreachableNotice() : phoneOfflineNotice())
        : safeError(error);
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
  async #waitForPollToRelease(attempts=REMOTE_CONTROL_BUSY_WAIT_ATTEMPTS,pollMs=REMOTE_CONTROL_BUSY_WAIT_POLL_MS,userInitiated=false): Promise<void> {
    // Reserve the next free slot while waiting. Repeated background refreshes
    // must not consume a tap's entire bounded wait budget by taking it first.
    this.#pollWaiters += 1;
    if (userInitiated) this.#userWaiters += 1;
    try {
      for (let attempt = 0; this.#busy && attempt < attempts; attempt += 1) {
        await this.#sleep(pollMs);
      }
    } finally { this.#pollWaiters -= 1; if (userInitiated) this.#userWaiters -= 1; }
  }

  /**
   * Background Workroom polling (output reads, session lists) steps aside while a tapped action,
   * task or conversation request waits for the channel. The Workroom reads about every second,
   * so without this a tap such as 「저장된 Codex 대화 · 열기」 almost always lost the race and
   * showed '앞선 요청이 아직 끝나지 않았습니다' (2026-09-27). Typed input never waits here.
   */
  async #yieldToUserRequests(): Promise<void> {
    for (let attempt = 0; this.#userWaiters > 0 && attempt < REMOTE_CONTROL_BUSY_WAIT_ATTEMPTS * 2; attempt += 1) {
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
    opsReview?: {candidateId:string;expectedRevision:string;accept:boolean},
  ): Promise<RemoteControlActionResult | undefined> {
    return this.#exclusive(async () => {
    if (this.#state !== 'online' || !this.#sessionToken) throw new Error('REMOTE_CONTROL_SESSION_NOT_READY');
    if (this.#unsentRequest()) throw this.#inProgressError();
    this.#refuseWhilePhoneOffline();
    if (this.#pendingOutbound || this.#pendingActionId
      || this.#pendingTaskOperationId || this.#pendingConversationOperationId) {
      throw this.#inProgressError();
    }
    await this.#waitForPollToRelease(REMOTE_CONTROL_BUSY_WAIT_ATTEMPTS, REMOTE_CONTROL_BUSY_WAIT_POLL_MS, true);
    if (this.#state !== 'online' || !this.#sessionToken) throw new Error('REMOTE_CONTROL_SESSION_NOT_READY');
    this.#refuseWhilePhoneOffline();
    if (this.#busy || this.#pendingOutbound || this.#pendingActionId
      || this.#pendingTaskOperationId || this.#pendingConversationOperationId) {
      throw this.#inProgressError();
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
    } else if (action === 'ops.open') {
      request.remoteConfirmed = true;
    } else if (action === 'ops.memory.review') {
      if (!opsReview || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(opsReview.candidateId) || !/^[a-f0-9]{64}$/.test(opsReview.expectedRevision) || typeof opsReview.accept !== 'boolean') throw new Error('REMOTE_CONTROL_OPS_REVIEW_INPUT_REQUIRED');
      request.candidateId=opsReview.candidateId;request.expectedRevision=opsReview.expectedRevision;request.accept=opsReview.accept;request.remoteConfirmed=true;
    } else if (action === 'ops.status' || action === 'ops.memory.pending') {
      // Authenticated read; no project-scoped control ID is needed.
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
    this.#pendingActionIsForeground = !READ_ONLY_RELAY_ACTIONS.has(action);
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
        throw this.#silentHostError();
      }
      this.#error = null;
      this.#requestErrorCode = null;
      this.#requestChangedPaths = [];
      await this.#sendPayload(request);
      // Poll for this action's own result. Resolving without one printed a green
      // "요청을 완료했습니다" for work that never ran; failing after a single
      // receive printed a red "응답하지 않습니다" for work that was still running.
      // Both are wrong, and only waiting tells them apart.
      for (let attempt = 0; ; attempt += 1) {
        await this.#receiveForResult();
        if (this.#error) throw this.#requestErrorCode
          ? new RemoteControlRelayRequestError(this.#requestErrorCode, this.#error, this.#requestChangedPaths)
          : new Error(this.#error);
        if (this.#pendingActionId !== actionId) return this.#resultForAction(actionId);
        if (attempt >= REMOTE_CONTROL_ACTION_RESULT_ATTEMPTS) break;
        await this.#sleep(REMOTE_CONTROL_ACTION_RESULT_POLL_MS);
      }
      // Bounded by attempts, not wall clock, so an injected frozen clock still
      // terminates. Say what is true: it was delivered and may still be running.
      // "다시 시도하세요" here is what produced duplicate commits and worktrees.
      if (READ_ONLY_RELAY_ACTIONS.has(action)) {
        // A read changes nothing, so asking again is safe and the lock only hurts: a list
        // request lost while the Mac restarted kept every later request refused for up to
        // 11 minutes — an empty project picker on the phone after each Mac update (2026-09-27).
        // A late answer carries this action id and is ignored once it is no longer pending.
        if (this.#pendingActionId === actionId) {
          this.#pendingActionId = null;
          this.#pendingCapabilityProbeActionId = null;
          this.#pendingActionSentAt = 0;
        }
        throw new Error('Mac의 응답이 늦어 조회를 멈췄습니다. 조회는 다시 해도 안전합니다 — 새로고침하세요.');
      }
      throw new Error('Mac이 아직 결과를 보내지 않았습니다. 요청은 전달되었고 아직 실행 중일 수 있으니, 목록을 새로고침해 확인한 뒤에 다시 실행하세요.');
    } finally {
      this.#busy = false;
      this.#pendingActionIsForeground = false;
    }
    });
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
    return this.#exclusive(async () => {
    if (this.#state !== 'online' || !this.#sessionToken) throw new Error('REMOTE_CONTROL_SESSION_NOT_READY');
    if (!this.#supportedFeatures?.includes(REMOTE_CONTROL_TASK_SCOPE)) {
      throw new RemoteControlRelayRequestError(
        REMOTE_CONTROL_HOST_UPDATE_REQUIRED,
        '이 Mac의 AgentsToZ 앱이 원격 Codex 작업 기능을 지원하지 않는 이전 설치본입니다.',
      );
    }
    if (this.#unsentRequest()) throw this.#inProgressError();
    this.#refuseWhilePhoneOffline();
    if (this.#pendingOutbound || this.#pendingActionId
      || this.#pendingTaskOperationId || this.#pendingConversationOperationId) {
      throw this.#inProgressError();
    }
    await this.#waitForPollToRelease(REMOTE_CONTROL_BUSY_WAIT_ATTEMPTS, REMOTE_CONTROL_BUSY_WAIT_POLL_MS, true);
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
    this.#refuseWhilePhoneOffline();
    if (this.#busy || this.#pendingOutbound || this.#pendingActionId
      || this.#pendingTaskOperationId || this.#pendingConversationOperationId) {
      throw this.#inProgressError();
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
    this.#pendingTaskIsForeground = FOREGROUND_TASK_OPERATIONS.has(operation);
    this.#pendingTaskRequest = request;
    this.#pendingTaskResult = null;
    this.#pendingTaskSentAt = this.#now();
    this.#busy = true;
    try {
      if (this.#hostIsSilent()) {
        this.#pendingTaskOperationId = null;
        this.#pendingTaskRequest = null;
        this.#pendingTaskSentAt = 0;
        throw this.#silentHostError();
      }
      this.#error = null;
      this.#requestErrorCode = null;
      await this.#sendPayload(request);
      for (let attempt = 0; ; attempt += 1) {
        await this.#receiveForResult();
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
      this.#pendingTaskIsForeground = false;
    }
    });
  }

  /**
   * One relay request at a time, in order. A later tap waits for the earlier one's reply instead of being
   * refused with 「다른 원격 요청이 진행 중입니다」 — on a freshly paired phone the ops status, list paging,
   * voice and workroom reads kept colliding and the user's own start was the one refused (2026-10-02).
   * Each request still bounds its own wait for a reply, so the queue always moves.
   */
  #exclusiveTail: Promise<void> = Promise.resolve();
  async #exclusive<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.#exclusiveTail;
    let release!: () => void;
    this.#exclusiveTail = new Promise<void>(resolve => { release = resolve; });
    try {
      await previous;
      await this.#statusIfStale();
      return await run();
    } finally { release(); }
  }

  /**
   * `refresh()` skips itself while a request is in flight. With requests queued back to back it never ran,
   * so the Mac's last-seen time froze, the phone said 「N분째 응답 없음」 and refused actions as if the Mac
   * slept (2026-10-02 iPhone 17). Between queued requests, read the relay status when it is over 5 s old.
   */
  #lastStatusAt = 0;
  async #statusIfStale(): Promise<void> {
    const claim = this.#claim;
    if (!claim || this.#now() - this.#lastStatusAt < REMOTE_CONTROL_STATUS_REFRESH_MS) return;
    // No network on this device: the request itself refuses with the phone's reason; asking would only fail.
    if (!this.#isOnline()) return;
    this.#lastStatusAt = this.#now();
    try { this.#hostLastSeenAt = (await this.#relay(() => this.#transport.status(claim.hostId, claim.sessionId))).hostLastSeenAt; }
    catch { /* the request itself reports a dead relay */ }
  }

  /** 결과를 놓친 마지막 시각 — 화면이 「왜 비었나」를 설명할 수 있게 상태에 싣는다. */
  #terminalAdmission: Promise<void> | null = null;
  #terminalQueued = 0;
  #backgroundTerminalQueued = 0;
  #voiceTerminalQueued = 0;

  /**
   * `device`는 봉투에만 실린다 — 그 Mac이 요청을 **다른 아젠투지**에 그대로 넘긴다
   * (`src/communityDeviceRef.ts`). 요청 안에 넣으면 실행하는 Mac의 키 검사가 거절한다.
   */
  async sendTerminal(request: AiTerminalRequest, device?: string): Promise<AiTerminalResponse>;
  async sendTerminal(request: MobileWorkspaceRequest, device?: string): Promise<MobileWorkspaceResult>;
  async sendTerminal(request: AiTerminalRequest|MobileWorkspaceRequest, device?: string): Promise<AiTerminalResponse|MobileWorkspaceResult> {
    // Workroom status and terminal input originate from separate UI requesters.
    // Serialize admission at their shared cursor owner, with a bounded queue.
    const background=isBackgroundTerminalRequest(request),voice=isVoiceTerminalRequest(request);
    const rejection=terminalQueueRejection(
      {total:this.#terminalQueued,background:this.#backgroundTerminalQueued,voice:this.#voiceTerminalQueued},
      {background,voice});
    if(rejection)throw new Error(rejection);
    if(!background)this.#foregroundTerminalRequests++;
    if(background)this.#backgroundTerminalQueued++;
    if(voice)this.#voiceTerminalQueued++;
    this.#terminalQueued++;
    const token = this.#sessionToken;
    const previous = this.#terminalAdmission;
    let release!: () => void;
    const admission = new Promise<void>(resolve => { release = resolve; });
    this.#terminalAdmission = admission;
    try {
      if (previous) await previous;
      if (this.#sessionToken !== token) throw new Error('Mac의 연결이 갱신되었습니다. 터미널 목록을 새로고침하세요.');
      return await this.#sendTerminalRequest(request,device);
    } finally {
      if(!background)this.#foregroundTerminalRequests--;
      if(background)this.#backgroundTerminalQueued--;
      if(voice)this.#voiceTerminalQueued--;
      this.#terminalQueued--;
      if (this.#terminalAdmission === admission) this.#terminalAdmission = null;
      release();
    }
  }

  async #sendTerminalRequest(request: AiTerminalRequest|MobileWorkspaceRequest, device?: string): Promise<AiTerminalResponse|MobileWorkspaceResult> {
    return this.#exclusive(async () => {
    if(request.operation==='workspace'&&!this.#supportedFeatures?.includes('workspace-v1'))throw new Error('연결한 Mac 앱을 업데이트하세요.');
    if(request.operation==='workspace'&&request.workspace.action==='voice'&&!this.#supportedFeatures?.includes('voice-v1'))throw new Error('연결한 Mac 앱을 업데이트하면 음성을 사용할 수 있습니다.');
    if(request.operation==='workspace'&&request.workspace.action.startsWith('tester.')&&!this.#supportedFeatures?.includes('tester-v1'))throw new Error('연결한 Mac 앱을 업데이트하면 테스터를 사용할 수 있습니다.');
    if(request.operation==='workspace'&&request.workspace.action==='voc.submit'&&!this.#supportedFeatures?.includes('voc-v1'))throw new Error('연결한 Mac 앱을 업데이트하면 휴대폰에서 VOC를 보낼 수 있습니다.');
    if(request.operation==='workspace'&&request.workspace.action==='voc.inbox'&&!this.#supportedFeatures?.includes('voc-inbox-v1'))throw new Error('Mac 앱 업데이트 필요 — 연결한 Mac 앱을 업데이트하면 쌓인 VOC를 볼 수 있습니다.');
    // Periodic host refresh shares the relay cursor. Wait for that reader instead of dropping a typed key.
    const background=isBackgroundTerminalRequest(request);
    if(background)await this.#yieldToUserRequests();
    await this.#waitForPollToRelease(400,25);
    if(background&&(this.#userWaiters>0||this.#busy)){await this.#yieldToUserRequests();await this.#waitForPollToRelease(400,25);}
    if(this.#state!=='online'||!this.#sessionToken) throw new Error('원격 연결을 먼저 완료하세요.');
    // The phone's own network first: 「Mac이 아직 결과를 보내지 않았습니다」 blamed the Mac for a request
    // that never left this phone (2026-10-10 iPhone, Wi‑Fi off).
    if(this.#unsentRequest())throw this.#inProgressError(background);
    this.#refuseWhilePhoneOffline(background);
    if(this.#busy||this.#pendingOutbound||this.#pendingActionId||this.#pendingTaskOperationId||this.#pendingConversationOperationId){
      // A relay this phone cannot reach says nothing about what the Mac has or has not sent.
      if(this.#relayUnreachable)throw this.#inProgressError(background);
      throw new Error('앞서 보낸 요청의 결과를 Mac이 아직 보내지 않았습니다. 그 요청은 실행 중일 수 있으니 목록을 새로고침해 확인한 뒤 다시 시도하세요.');
    }
    const token=this.#sessionToken;
    const interactiveRead=this.#interactiveRead;
    const fastControlInput=request.operation==='input'&&REMOTE_CONTROL_INTERACTIVE_INPUTS.has(request.data??'');
    const fastResultPoll=fastControlInput||(request.operation==='read'
      &&interactiveRead!==null
      &&interactiveRead.sessionId===request.sessionId
      &&interactiveRead.token===token
      &&interactiveRead.until>this.#now());
    this.#busy=true;this.#terminalRequestId=request.requestId;this.#terminalResult=null;
    try {
      this.#error=null;
      await this.#sendPayload({type:'terminal.request',sessionToken:token,request,...(device?{device}:{})});
      if(request.operation==='read'&&fastResultPoll)this.#interactiveRead=null;
      // A terminal key needs two relay round trips (input acknowledgement, then output read).
      // Poll just that key and its first read more responsively; the later idle reads and
      // workspace/status requests retain the one-second budget. Four short waits replace
      // one long wait, so the overall uncertain-result timeout stays about 60 seconds.
      const attempts=REMOTE_CONTROL_ACTION_RESULT_ATTEMPTS+(fastResultPoll?REMOTE_CONTROL_INTERACTIVE_TERMINAL_FAST_POLLS-1:0);
      for(let attempt=0;attempt<attempts;attempt++) {
        await this.#receive();
        if(this.#error){
          if(this.#requestErrorCode===AI_TERMINAL_REQUEST_INVALID_CODE){
            const refused=new RemoteControlRelayRequestError(AI_TERMINAL_REQUEST_INVALID_CODE,this.#error);
            if(request.operation==='read'&&request.snapshot){this.#error=null;this.#requestErrorCode=null;}
            throw refused;
          }
          throw new Error(this.#error);
        }
        const result=this.#terminalResult as RemoteTerminalResult|null;
        if(result){if(!result.ok)throw new Error(result.error);if((request.operation==='workspace')!==!!(result.body&&'kind' in result.body&&result.body.kind==='workspace'))throw new Error('모바일 요청과 응답이 일치하지 않습니다.');if(fastControlInput&&request.sessionId)this.#interactiveRead={sessionId:request.sessionId,token,until:this.#now()+REMOTE_CONTROL_INTERACTIVE_READ_WINDOW_MS};return result.body!;}
        if(this.#sessionToken!==token)throw new Error('Mac의 연결이 갱신되었습니다. 터미널 목록을 새로고침하세요.');
        await this.#sleep(fastResultPoll&&attempt<REMOTE_CONTROL_INTERACTIVE_TERMINAL_FAST_POLLS
          ?REMOTE_CONTROL_INTERACTIVE_TERMINAL_POLL_MS:REMOTE_CONTROL_ACTION_RESULT_POLL_MS);
      }
      throw new Error('터미널 응답을 확인하지 못했습니다. 입력은 전달되었을 수 있으므로 화면을 확인한 뒤 다시 시도하세요.');
    } catch(error) {
      // The request reached the relay; reading its answer failed on this side. The workroom shows the
      // message verbatim, so a raw "TypeError: Load failed" must not be what it shows.
      if(!(error instanceof RemoteControlRelayRequestError)&&this.#isNetworkFailure(error)){
        throw Object.assign(new RemoteControlRelayRequestError(REMOTE_CONTROL_RESULT_UNREACHABLE,RESULT_UNREACHABLE_MESSAGE),{cause:error});
      }
      throw error;
    } finally {this.#busy=false;this.#terminalRequestId=null;this.#terminalResult=null;}
    });
  }

  async sendConversation<TOperation extends RemoteControlConversationOperation>(
    operation: TOperation,
    payload: RemoteControlConversationRequestPayloadByOperation[TOperation],
  ): Promise<RemoteControlConversationResult> {
    return this.#exclusive(async () => {
    if (this.#state !== 'online' || !this.#sessionToken) throw new Error('REMOTE_CONTROL_SESSION_NOT_READY');
    if (!this.#supportedFeatures?.includes(REMOTE_CONTROL_CONVERSATION_SCOPE)) {
      throw new RemoteControlRelayRequestError(
        REMOTE_CONTROL_HOST_UPDATE_REQUIRED,
        '이 Mac의 AgentsToZ 앱이 원격 Codex 대화 기능을 지원하지 않는 이전 설치본입니다.',
      );
    }
    if (this.#unsentRequest()) throw this.#inProgressError();
    this.#refuseWhilePhoneOffline();
    if (this.#pendingOutbound || this.#pendingActionId
      || this.#pendingTaskOperationId || this.#pendingConversationOperationId) {
      throw this.#inProgressError();
    }
    await this.#waitForPollToRelease(REMOTE_CONTROL_BUSY_WAIT_ATTEMPTS, REMOTE_CONTROL_BUSY_WAIT_POLL_MS, true);
    // Same reason as sendTask: the wait is long enough for the session and its feature list to be
    // replaced underneath a tap that was already judged admissible.
    if (this.#state !== 'online' || !this.#sessionToken) throw new Error('REMOTE_CONTROL_SESSION_NOT_READY');
    if (!this.#supportedFeatures?.includes(REMOTE_CONTROL_CONVERSATION_SCOPE)) {
      throw new RemoteControlRelayRequestError(
        REMOTE_CONTROL_HOST_UPDATE_REQUIRED,
        '이 Mac의 AgentsToZ 앱이 원격 Codex 대화 기능을 지원하지 않는 이전 설치본입니다.',
      );
    }
    this.#refuseWhilePhoneOffline();
    if (this.#busy || this.#pendingOutbound || this.#pendingActionId
      || this.#pendingTaskOperationId || this.#pendingConversationOperationId) {
      throw this.#inProgressError();
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
    this.#pendingConversationIsForeground = FOREGROUND_CONVERSATION_OPERATIONS.has(operation);
    this.#pendingConversationRequest = request;
    this.#pendingConversationResult = null;
    this.#pendingConversationSentAt = this.#now();
    this.#busy = true;
    try {
      if (this.#hostIsSilent()) {
        this.#pendingConversationOperationId = null;
        this.#pendingConversationRequest = null;
        this.#pendingConversationSentAt = 0;
        throw this.#silentHostError();
      }
      this.#error = null;
      this.#requestErrorCode = null;
      await this.#sendPayload(request);
      for (let attempt = 0; ; attempt += 1) {
        await this.#receiveForResult();
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
      this.#pendingConversationIsForeground = false;
    }
    });
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
    this.#interactiveRead = null;
    this.#pairRequestSent = false;
    this.#pendingOutbound = null;
    this.#outboundStalled = false;
    this.#expiredOutbox = null;
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
    this.#outboundStalled = false;
    await this.#persistSession();
    try {
      await this.#flushPendingOutbound();
    } catch (error) {
      // The envelope stays in the outbox, unchanged (the lock this keeps is the exactly-once guarantee).
      // Only the words change: the network on this side is why, and the caller must not blame the Mac.
      if (!this.#isNetworkFailure(error)) throw error;
      throw Object.assign(
        new RemoteControlRelayRequestError(REMOTE_CONTROL_REQUEST_UNSENT, UNSENT_NOW_MESSAGE),
        { cause: error },
      );
    }
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
      // A request held back by this phone's network that outlived its expiry: say so at session.ready
      // instead of the restart notice — the Mac did not restart, the phone was offline.
      // Set even when this side does not know why it stayed (a reloaded page): an envelope still here
      // was never confirmed by the relay, so 「Mac이 다시 시작되어」 would be a guess against the Mac.
      this.#expiredOutbox=this.#outboundStalled||this.#relayUnreachable?'stall':'unknown';
      this.#outboundStalled=false;
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
    try {
      await this.#relay(() => this.#transport.sendEnvelope(claim.hostId, claim.sessionId, envelope));
    } catch (error) {
      // A relay refusal is not a stall: the network carried it and the relay answered.
      this.#outboundStalled = this.#isNetworkFailure(error);
      throw error;
    }
    this.#outboundStalled = false;
    this.#sendSequence = envelope.sequence;
    this.#pendingOutbound = null;
    await this.#persistSession();
  }

  /**
   * 놓친 결과가 있을 때 진행 중이던 잠금을 푼다. 풀지 않으면 폰은 **오지 않을 결과**를 기다리며
   * 모든 버튼이 잠긴다(이 저장소가 금지한 상태). 완료 여부는 알 수 없으므로 그렇게 말한다.
   */
  #releasePendingAfterMissedResults(arrived: {type?: unknown; actionId?: unknown; operationId?: unknown; requestId?: unknown}): void {
    // ⚠️ The message that revealed the gap may itself be the answer to the request in flight: keep that one
    // pending so the branch below can match it (2026-10-06 review — a real result was reported as missing).
    const answers = (type: string, id: unknown, pending: unknown) => arrived.type === type && id === pending;
    const notice = 'Mac이 보낸 결과 일부가 만료되어 받지 못했습니다. 그 요청의 완료 여부는 알 수 없으니 목록을 새로고침해 확인하세요.';
    if (this.#pendingActionId && !answers('action.result', arrived.actionId, this.#pendingActionId)) {
      const wasCapabilityProbe = this.#pendingCapabilityProbeActionId === this.#pendingActionId;
      this.#pendingActionId = null;
      this.#pendingCapabilityProbeActionId = null;
      this.#pendingActionSentAt = 0;
      if (!wasCapabilityProbe) { this.#error = notice; this.#requestErrorCode = null; }
    }
    if (this.#pendingTaskOperationId && !answers('tasks.result', arrived.operationId, this.#pendingTaskOperationId)) {
      this.#pendingTaskOperationId = null; this.#pendingTaskRequest = null;
      this.#pendingTaskResult = null; this.#pendingTaskSentAt = 0;
      this.#error = notice; this.#requestErrorCode = null;
    }
    if (this.#pendingConversationOperationId && !answers('conversations.result', arrived.operationId, this.#pendingConversationOperationId)) {
      this.#pendingConversationOperationId = null; this.#pendingConversationRequest = null;
      this.#pendingConversationResult = null; this.#pendingConversationSentAt = 0;
      this.#error = notice; this.#requestErrorCode = null;
    }
    if (this.#terminalRequestId && !answers('terminal.result', arrived.requestId, this.#terminalRequestId)) { this.#error = notice; this.#requestErrorCode = null; }
  }

  async #receive(): Promise<void> {
    const claim = this.#claim;
    const key = this.#receiveKey;
    let cursor = this.#receiveCursor;
    if (!claim || !key || !cursor) throw new Error('REMOTE_CONTROL_SESSION_NOT_READY');
    const deliveries = await this.#relay(() => this.#transport.receiveEnvelopes(claim.hostId, claim.sessionId, this.#relayCursor));
    for (const delivery of deliveries) {
      const decision = acceptRemoteControlRelayEnvelope(delivery.envelope, cursor, this.#now());
      const isSequenceGap = !decision.ok && decision.reason === 'sequence-gap';
      if (!decision.ok && !isSequenceGap) {
        throw new Error(`REMOTE_CONTROL_RELAY_${decision.reason.toUpperCase().replace(/-/g, '_')}`);
      }
      // An authenticated message from the Mac (decrypt below throws otherwise) is fresher proof that it is
      // awake than the relay's last-seen stamp, which only `refresh()` reads — and refresh skips itself
      // while requests run back to back, leaving 「N분째 응답 없음」 beside a Mac that is answering.
      const authenticatedFromHost = (plaintext: Uint8Array) => { this.#hostLastSeenAt = new Date(this.#now()).toISOString(); return plaintext; };
      const plaintext = authenticatedFromHost(await decryptRemoteControlRelayEnvelope({
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
      }));
      const message = parseServerMessage(JSON.parse(decoder.decode(plaintext)));
      // ⚠️ 예전에는 `session.ready`가 아닌 메시지가 순번 틈과 함께 오면 세션을 죽였고, 남는 길은
      // **Mac 앞에서 새 QR로 재페어링**뿐이었다(2026-10-05 실기: 폰이
      // `REMOTE_CONTROL_RELAY_SEQUENCE_GAP`으로 통째로 막혔다). 그런데 틈은 보통 Mac이 보낸 결과가
      // 릴레이 TTL(10분)을 넘겨 사라진 것이고 — 폰이 잠깐 자리를 비우면 생긴다 — **결과의 유실**이지
      // 위조가 아니다. 이 봉투는 이미 세션 키로 복호화되고 sessionId·controllerId·실제 순번까지
      // 확인됐으며, 모든 결과는 **id로 대조**된다(`requestId===#terminalRequestId`,
      // `operationId===#pending…`). 그래서 건너뛴 결과가 다른 요청에 잘못 적용될 수 없다.
      // 뒤로 가는 순번(`stale-sequence`)은 여전히 치명적으로 남긴다 — 그건 재생 공격의 모양이다.
      if (isSequenceGap && message.type !== 'session.ready') {
        this.#releasePendingAfterMissedResults(message as {type?: unknown});
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
            this.#error = this.#expiredOutbox
              ? (this.#expiredOutbox === 'stall' ? EXPIRED_AFTER_STALL_MESSAGE : EXPIRED_UNSENT_MESSAGE)
              : 'Mac이 다시 시작되어 연결을 복구했습니다. 이전 요청의 완료 여부는 확인할 수 없으니, 목록을 새로고침해 상태를 확인한 뒤 판단하세요.';
            this.#requestErrorCode = null;
          }
        }
        if (this.#pendingTaskOperationId) {
          this.#pendingTaskOperationId = null;
          this.#pendingTaskRequest = null;
          this.#pendingTaskResult = null;
          this.#pendingTaskSentAt = 0;
          this.#error = this.#expiredOutbox
            ? (this.#expiredOutbox === 'stall' ? EXPIRED_AFTER_STALL_MESSAGE : EXPIRED_UNSENT_MESSAGE)
            : 'Mac이 다시 시작되어 연결을 복구했습니다. 이전 작업 요청의 완료 여부는 작업 목록에서 확인하세요.';
          this.#requestErrorCode = null;
        }
        if (this.#pendingConversationOperationId) {
          this.#pendingConversationOperationId = null;
          this.#pendingConversationRequest = null;
          this.#pendingConversationResult = null;
          this.#pendingConversationSentAt = 0;
          this.#error = this.#expiredOutbox
            ? (this.#expiredOutbox === 'stall' ? EXPIRED_AFTER_STALL_MESSAGE : EXPIRED_UNSENT_MESSAGE)
            : 'Mac이 다시 시작되어 연결을 복구했습니다. 이전 대화 요청의 결과는 대화 목록에서 확인하세요.';
          this.#requestErrorCode = null;
        }
        this.#expiredOutbox = null;
        this.#sessionToken = message.sessionToken;
        this.#interactiveRead = null;
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
            this.#requestChangedPaths = message.error.changedPaths ?? [];
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
        else if ('ops' in message) {
          // Returned to the explicit caller; no controller-global OPS state is persisted.
        }
        else if ('opsCandidates' in message) {
          // Returned to the explicit caller; candidate text is never persisted in the controller vault.
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
 * The host polls the relay every 1s while a controller was seen within the last
 * minute, then every 5s, and every 20s after ten quiet minutes
 * (`remoteControlHostPollDelayMs`). The relay stamps the row at most every 10s,
 * so a healthy host is never more than ~30s stale. A gap much larger than that means it
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
 * `ACTIVE_POLL_MS` (1s while a phone is active; up to 20s when it has been
 * quiet, so a first tap after a long pause can take that long) and only then runs the work — `perform()` is awaited to
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
/** How old the relay status may get between back-to-back requests before one is read again. */
export const REMOTE_CONTROL_STATUS_REFRESH_MS = 5_000;
export const REMOTE_CONTROL_BUSY_WAIT_ATTEMPTS = 30;
export const REMOTE_CONTROL_ACTION_RESULT_POLL_MS = 1_000;
export const REMOTE_CONTROL_ACTION_RESULT_ATTEMPTS = 60;
/** Actions that only read; an unanswered one never holds the in-flight lock. */
const READ_ONLY_RELAY_ACTIONS: ReadonlySet<string> = new Set([
  'projects.list', 'workspace-roots.list', 'protocol.capabilities', 'project.status', 'ops.status', 'ops.memory.pending',
]);
export const REMOTE_CONTROL_INTERACTIVE_TERMINAL_POLL_MS = 250;
const REMOTE_CONTROL_INTERACTIVE_TERMINAL_FAST_POLLS = 4;
const REMOTE_CONTROL_INTERACTIVE_READ_WINDOW_MS = 5_000;
// Match the mobile Workroom's virtual safety/terminal controls. Ordinary text
// batches keep the existing poll rate so sustained typing cannot multiply RPC load.
const REMOTE_CONTROL_INTERACTIVE_INPUTS = new Set(['1','2','3','4','5','y','Y','n','N','\x1b','\t','\x1b[A','\x1b[B','\x1b[C','\x1b[D','\x1bOA','\x1bOB','\x1bOC','\x1bOD','\x03','\x0c','\x15','\r']);
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
