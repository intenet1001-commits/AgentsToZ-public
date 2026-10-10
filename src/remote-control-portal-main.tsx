import {AI_TERMINAL_REFERENCES_FEATURE} from './aiTerminalProtocol';
import { buildVocWorkflowPrompt } from './vocWorkflowPrompt';
import { ErrorVocActions, ErrorVocProvider, RemoteVocComposer, type VocComposerDraft, type VocComposerMode, type VocComposerPrefill } from './RemoteVocComposer';
import { hostSupportsRemoteVoc, sendRemoteVoc, VOC_HELD_ON_PHONE, VOC_HELD_ON_PHONE_MESSAGE } from './remoteVoc';
import { findRemoteVocDevProject, selectRemoteVocTransportProject } from './remoteVocTargeting';
import { RemoteVocHub, type RemoteVocInboxState } from './RemoteVocHub';
import { REMOTE_VOC_INBOX_FEATURE, type RemoteVocInboxItem } from './vocInboxSummary';
import { memoryVocShareBackend, openIndexedDbVocShareBackend, receiveVocShareDelivery, VocShareCaptureStore, type VocShareCapture } from './vocShareCaptureStore';
import { buildVocInboxWorkroomHandoff, buildVocItemWorkroomHandoff } from './voc/vocWorkroomHandoff';
import { REMOTE_CONTROL_PROTOCOL_VERSION } from './remoteControlProtocol';
import type { RemoteVocError } from './vocAttachments';
import {RemoteOpsVoiceHost,remoteOpsVoiceProject} from './VoiceSessionPanel';
import {AgentsToZVoiceDock} from './components/AgentsToZVoiceDock';
import {remoteVoiceTransport} from './voiceSessionClient';
import {SharedPromptGuideBar} from './SharedPromptGuideBar';
import {MobileWorkspacePanel} from './MobileWorkspacePanel';
import {MOBILE_WORKSPACE_FEATURE,type MobileWorkspaceRequest} from './mobileWorkspaceProtocol';
import {RemoteCommunityPanel} from './RemoteCommunityPanel';
import {createCommunityForwardGate,type RemoteCommunityDevice,type RemoteCommunityProjects} from './remoteCommunity';
import {createProjectCreationIntentStore} from './projectLaunchIntent';
import {AiTerminalPanel, type AiTerminalEntry} from './AiTerminalPanel';
import { PortalCatalog } from './portal-main';
import { WorkspaceThemePicker } from './WorkspaceThemePicker';
import { initialWorkspaceTab, isWorkspaceTab, type WorkspaceTab } from './workspaceNavigation';
import { PortalEmailCodeLogin } from './PortalEmailCodeLogin';
import { PORTAL_IS_BUNDLED, PORTAL_SUPABASE_ANON_KEY, PORTAL_SUPABASE_URL, portalOrigin } from './portalRuntimeConfig';
import type { PortalEmailCodeClient } from './portalEmailCodeAuth';
import { PortalRemoteQrScanner } from './PortalRemoteQrScanner';
import { PortalRemoteQrError } from './portalRemoteQr';
import { bundledQrSupabaseMismatch } from './phoneConnectLink';
import { PORTAL_FOREIGN_PAIRING_APP_HINT, PORTAL_FOREIGN_PAIRING_TITLE, PORTAL_FOREIGN_PAIRING_WHY, portalForeignPairing } from './portalForeignPairing';
import {nativePortalOAuthAvailable,signInWithNativePortalOAuth} from './nativePortalOAuth';
import type {AiTerminalRequest,AiTerminalResponse} from './aiTerminalProtocol';
import {createTerminalRequester} from './aiTerminalScheduling';
import type {WorkroomMentionProject} from './workroomProjectMention';
import type {CommunityMentionDeviceProjects} from './workroomCommunityMention';
import {COMMUNITY_BYPASS_UNAVAILABLE,communityDeviceLabel} from './workroomDeviceLabel';
import {isTransientNetworkError,transientNetworkErrorMessage} from './remoteTransientNetworkError';
import {phoneIsOnline,phoneOfflineHostLine,phoneOfflineLabel,phoneOfflineNotice,phoneOfflineTapNotice,relayUnreachableLabel,portalNetworkFailureMessage} from './phoneNetwork';
import {usePhoneOnline} from './usePhoneOnline';
import {opsStatusText,remoteActionErrorHint} from './remoteControlScreenText';
import { IncrementalListMore } from './components/IncrementalListMore';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  Archive, BookMarked, Bot, Brain, CheckCircle2, FolderGit2, LayoutDashboard, ListTodo, Loader2,
  LockKeyhole, MessageSquare, Monitor, Play, Power, RefreshCw, ScanLine, Send,
  ShieldCheck, Smartphone, Square, X,
  MessageSquareWarning, WifiOff,
} from 'lucide-react';
import { getAuthenticatedSupabaseClient } from './lib/supabaseClient';
import { RemoteControlRelayBootstrapVault } from './remoteControlRelayBootstrapVault';
import {
  REMOTE_CONTROL_HOST_SILENT_MS,
  REMOTE_CONTROL_HOST_UPDATE_REQUIRED,
  REMOTE_CONTROL_PHONE_OFFLINE,
  REMOTE_CONTROL_REQUEST_UNSENT,
  REMOTE_CONTROL_REQUEST_UNSENT_AHEAD,
  REMOTE_CONTROL_RESULT_UNREACHABLE,
  REMOTE_CONTROL_SELECTED_HOST_POLL_MS,
  RemoteControlRelayController,
  RemoteControlRelayControllerManager,
  RemoteControlRelayRequestError,
  type RemoteControlRelayControllerSnapshot,
  type RemoteControlRelayControllerStatus,
  type RemoteControlRelayHostStatus,
} from './remoteControlRelayController';
import { RemoteControlRelaySessionVault } from './remoteControlRelaySessionVault';
import { parseRemoteControlRelayPairingUrl } from './remoteControlRelayContract';
import {
  RemoteControlRelayControllerRpcClient,
  createSupabaseRemoteControlRelayRpcInvoker,
} from './remoteControlRelayRpcClient';
import type { QrRemoteControlAction, QrRemoteControlProjectCard } from './qrRemoteControlContract';
import type { QrRemoteControlOpsCandidates, QrRemoteControlOpsStatus } from './qrRemoteControlContract';
import { RemoteControlProjectCard, remoteControlActionLabel } from './RemoteControlProjectCard';
import { groupRemoteControlCards, remoteControlWorktreeGroupLabel } from './remoteControlWorktreeGrouping';
import {
  REMOTE_CONTROL_PORTAL_MAX_PAGE,
  loadedPageDepthForHost,
  progressingRemoteControlPage,
  rememberLoadedPageDepth,
} from './remoteControlPortalPagination';
import { matchesSearchText } from './searchText';
import { matchesPhoneticName } from './phoneticSearch';
import { buildClientErrorReport } from './clientErrorReport';
import { BUILD_INFO, formatBuildTime } from './buildInfo';
import {
  authEventCountsAfterSessionFailure,
  isPortalNetworkFailure,
  keepVerifiedThroughFailure,
  sessionReadFailure,
  type SessionReadFailure,
  portalMembershipFailureMessage,
  verifyPortalMembership,
  type PortalMembershipRpcClient,
} from './portalMembership';
import {
  clearStoredPortalAuth,
  canContinuePortalGoogleOAuth,
  createPortalGoogleOAuthUrl,
  portalAuthErrorMessage,
  portalOAuthStartErrorMessage,
  preflightPortalGoogleOAuth,
  withPortalAuthTimeout,
} from './portalAuth';
import './remote-control-portal.css';
import {
  REMOTE_CONTROL_TASK_EVENT_PAGE_LIMIT,
  REMOTE_CONTROL_TASK_MODEL_PAGE_LIMIT,
  REMOTE_CONTROL_TASK_SCOPE,
  type RemoteControlTaskCancelResult,
  type RemoteControlTaskEvent,
  type RemoteControlTaskEventsResult,
  type RemoteControlTaskListResult,
  type RemoteControlTaskModel,
  type RemoteControlTaskModelsResult,
  type RemoteControlTaskStartResult,
  type RemoteControlTaskSummary,
} from './remoteControlTaskProtocol';
import {
  REMOTE_CONTROL_CONVERSATION_SCOPE,
  REMOTE_CONTROL_CONVERSATION_V1_ADAPTER_ID,
  type RemoteControlConversationEvent,
  type RemoteControlConversationHistoryMessage,
  type RemoteControlConversationModel,
  type RemoteControlConversationResult,
  type RemoteControlConversationSummary,
} from './remoteControlConversationProtocol';
import { AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED } from './agentRuntimeProtocol';
import { AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT } from './agentRuntimeConversationProtocol';
import { BUILTIN_AGENT_RUNTIME_LABELS } from './agentRuntimeRegistry';
import { matchesAgentRuntimeConversationSearch } from './agentRuntimeConversationSearch';
import {
  clearAgentRuntimePendingRequest,
  digestAgentRuntimeStartIntent,
  persistAgentRuntimePendingRequest,
  recoverAgentRuntimePendingRequestId,
} from './agentRuntimePendingStart';

declare global {
  interface Window {
    __agentstozRemotePairingFragment?: string;
    agentstozDisconnect?:()=>Promise<boolean>;
  }
}

// `remote/index.html` removes the fragment before this module and its imports
// execute. Take the in-memory copy once, then erase the global reference.
const capturedPairingFragment = window.__agentstozRemotePairingFragment ?? '';
try { delete window.__agentstozRemotePairingFragment; } catch { window.__agentstozRemotePairingFragment = ''; }

// A QR from a Mac on ANOTHER Supabase project (app-only self-hosters share the public default
// origin): this page must not offer a login or touch its own Supabase or relay at all.
const FOREIGN_PAIRING = portalForeignPairing({
  fragment: capturedPairingFragment,
  isBundled: PORTAL_IS_BUNDLED,
  portalSupabaseUrl: PORTAL_SUPABASE_URL,
  pageOrigin: window.location.origin,
});

function ForeignPairingPage({ qrSupabaseUrl }: { qrSupabaseUrl: string }) {
  return (
    <main className="remote-shell" data-testid="remote-foreign-pairing">
      <div className="remote-panel">
        <h2 data-testid="remote-foreign-pairing-title">{PORTAL_FOREIGN_PAIRING_TITLE}</h2>
        <p data-testid="remote-foreign-pairing-app-hint">{PORTAL_FOREIGN_PAIRING_APP_HINT}</p>
        <p>{PORTAL_FOREIGN_PAIRING_WHY}</p>
        <p className="remote-build-stamp">QR의 Supabase: {qrSupabaseUrl.replace(/^https:\/\//u, '')}</p>
      </div>
    </main>
  );
}

const SUPABASE_URL = PORTAL_SUPABASE_URL;
const SUPABASE_KEY = PORTAL_SUPABASE_ANON_KEY;
const SELECTED_HOST_STORAGE_KEY = 'agentstoz-remote-control-selected-host';
const UNASSIGNED_WORKSPACE_ROOT = '__unassigned__';
const WORKSPACE_ROOT_FILTER_PREFIX = 'root:';
const REMOTE_TASK_ACTIVE_POLL_MS = 3_000;
const REMOTE_TASK_TIMELINE_EVENT_LIMIT = 32;
const REMOTE_TASK_MODEL_PAGE_MAX = 4;
const REMOTE_CONVERSATION_PAGE_MAX = 4;
const REMOTE_CONVERSATION_EVENT_PAGE_MAX = 72;

type AuthState = 'checking' | 'signed-out' | 'signed-in' | 'denied' | 'verification-error' | 'unavailable';

/**
 * One remembered Mac. `pairingUrl` is a QR waiting to be claimed and
 * `restoredSession` an already approved session; a Mac can carry both when its
 * QR was rescanned while the old session was still valid.
 */
interface RemoteHostSource {
  hostId: string;
  pairingUrl?: string;
  restoredSession?: RemoteControlRelayControllerSnapshot;
}

interface RemoteTaskPanelState {
  open: boolean;
  busy: boolean;
  available: boolean | null;
  blocker: RemoteFeatureBlocker;
  models: RemoteControlTaskModel[];
  selectedModelId: string;
  selectedControlId: string;
  prompt: string;
  tasks: RemoteControlTaskSummary[];
  selectedTaskId: string;
  events: RemoteControlTaskEvent[];
  error: string;
}

const EMPTY_TASK_PANEL: RemoteTaskPanelState = {
  open: false,
  busy: false,
  available: null,
  blocker: null,
  models: [],
  selectedModelId: '',
  selectedControlId: '',
  prompt: '',
  tasks: [],
  selectedTaskId: '',
  events: [],
  error: '',
};

type RemoteFeatureBlocker = 'scope' | 'runtime' | 'host-update' | 'unknown' | null;

interface RemoteConversationPanelState {
  open: boolean;
  busy: boolean;
  available: boolean | null;
  blocker: RemoteFeatureBlocker;
  archivedOnly: boolean;
  query: string;
  models: RemoteControlConversationModel[];
  selectedModelId: string;
  selectedControlId: string;
  prompt: string;
  conversations: RemoteControlConversationSummary[];
  selectedConversationId: string;
  messages: RemoteControlConversationHistoryMessage[];
  historyTruncated: boolean;
  historyFiltered: boolean;
  /** Volatile only: never written to localStorage, vault, or host metadata. */
  pendingPrompts: Array<{ requestId: string; conversationId: string; text: string }>;
  events: RemoteControlConversationEvent[];
  eventCursor: number;
  /** Background list/history transport errors; must not overwrite action ambiguity. */
  syncError: string;
  error: string;
}

const EMPTY_CONVERSATION_PANEL: RemoteConversationPanelState = {
  open: false,
  busy: false,
  available: null,
  blocker: null,
  archivedOnly: false,
  query: '',
  models: [],
  selectedModelId: '',
  selectedControlId: '',
  prompt: '',
  conversations: [],
  selectedConversationId: '',
  messages: [],
  historyTruncated: false,
  historyFiltered: false,
  pendingPrompts: [],
  events: [],
  eventCursor: 0,
  syncError: '',
  error: '',
};

function remoteConversationStateLabel(state: RemoteControlConversationSummary['state']): string {
  return ({ idle: '대화 가능', running: '응답 중', archived: '보관됨', unknown: '확인 필요' } as const)[state];
}

function remoteConversationAdapterLabel(
  adapterId: RemoteControlConversationSummary['adapterId'],
): string {
  return BUILTIN_AGENT_RUNTIME_LABELS[adapterId];
}

function remoteConversationEventText(event: RemoteControlConversationEvent): string {
  switch (event.type) {
    case 'conversation.turn.started': return '에이전트가 응답을 시작했습니다.';
    case 'conversation.turn.completed': return '응답이 완료되었습니다.';
    case 'conversation.turn.interrupted': return '응답을 중단했습니다. 중단 전 변경은 남아 있을 수 있습니다.';
    case 'conversation.turn.unknown': return '연결 경계가 끊겨 실행 상태를 다시 확인해야 합니다.';
    case 'conversation.progress': return event.payload.summary;
    case 'conversation.artifact.summary': return event.payload.summary;
  }
}

export function remoteConversationIntentFingerprint(
  hostId: string,
  operation: 'start' | 'continue' | 'steer' | 'interrupt' | 'archive' | 'unarchive',
  identity: string,
  revision: number,
  modelId: string,
  prompt: string,
): string {
  return JSON.stringify([
    'remote-conversation', hostId, operation, identity, revision, modelId, prompt,
  ]);
}

function remoteTaskStatusLabel(status: RemoteControlTaskSummary['status']): string {
  return ({
    accepted: '대기', running: '실행 중', waiting: '응답 대기', succeeded: '완료',
    failed: '실패', cancelled: '취소됨', unknown: '확인 필요',
  } as const)[status];
}

function remoteTaskIsActive(status: RemoteControlTaskSummary['status']): boolean {
  return status === 'accepted' || status === 'running' || status === 'waiting';
}

function remoteTaskEventText(event: RemoteControlTaskEvent): string {
  switch (event.type) {
    case 'task.accepted': return `${event.payload.projectLabel} 작업을 접수했습니다.`;
    case 'task.started': return `${event.payload.adapterId} 실행을 시작했습니다.`;
    case 'task.progress': return event.payload.summary;
    case 'task.artifact.summary': return `${event.payload.label} · ${event.payload.summary}`;
    case 'task.result': return event.payload.summary;
    case 'task.failed': return `${event.payload.message} (${event.payload.code})`;
    case 'task.cancelled': return event.payload.reason;
  }
}

/**
 * Say whether the Mac is awake, before a tap has to find out the hard way.
 *
 * The host stamps the relay on every poll, so a long gap means asleep, quit, or
 * offline. Null is "not answerable" — an older Mac build or no status read yet —
 * and must not be dressed up as either state.
 */
function hostLiveness(hostLastSeenAt: string | null, now = Date.now()): string {
  if (!hostLastSeenAt) return '종단간 암호화';
  const silentMs = now - Date.parse(hostLastSeenAt);
  if (!Number.isFinite(silentMs)) return '종단간 암호화';
  if (silentMs <= REMOTE_CONTROL_HOST_SILENT_MS) return '응답 중 · 종단간 암호화';
  const minutes = Math.floor(silentMs / 60_000);
  if (minutes < 60) return `${minutes}분째 응답 없음 · 절전일 수 있음`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}시간째 응답 없음` : `${Math.floor(hours / 24)}일째 응답 없음`;
}

/**
 * Silent for five minutes. A sleeping Mac and a phone left holding a host identity the Mac no longer uses
 * (internet remote control turned off and on again) look the same from here, so both get said (2026-10-02:
 * two phones showed 「N분째 응답 없음 · 절전일 수 있음」 for an hour beside an awake, answering Mac).
 */
function hostSilentLong(hostLastSeenAt: string | null, now = Date.now()): boolean {
  if (!hostLastSeenAt) return false;
  const silentMs = now - Date.parse(hostLastSeenAt);
  return Number.isFinite(silentMs) && silentMs >= 5 * 60_000;
}

const EMPTY_STATUS: RemoteControlRelayControllerStatus = {
  state: 'idle',
  hostName: null,
  sasCode: null,
  controllerKeyFingerprint: null,
  expiresAt: null,
  projects: [],
  workspaceRoots: [],
  projectCount: 0,
  nextPage: null,
  supportedFeatures: null,
  requesting: false,
  busy: false,
  error: null,
  hostLastSeenAt: null,
  relayUnreachable: false,
  unsentRequest: false,
};

/** Candidate text is markdown-ish; inline code backticks read as noise on a phone. */
function plainOpsText(value: string): string {
  return value.replace(/`([^`\n]+)`/g, '$1');
}

function controllerPairingUrl(fragment: string): string | null {
  if (!fragment) return null;
  const origin = portalOrigin();
  const url = `${origin}/remote/#${fragment}`;
  const parsed = parseRemoteControlRelayPairingUrl(url);
  return new URL(parsed.controllerUrl).origin === origin ? url : null;
}

/**
 * Only the selected host id lives here — a relay-visible identifier, never a
 * secret; the sealed QR and session records stay in IndexedDB. It has to
 * survive the full-page OAuth redirect and a reload, and losing it costs one
 * tap rather than a connection, so a browser that refuses storage is fine.
 */
function readSelectedHostId(): string | null {
  try { return window.localStorage.getItem(SELECTED_HOST_STORAGE_KEY); } catch { return null; }
}

function writeSelectedHostId(hostId: string | null): void {
  try {
    if (hostId) window.localStorage.setItem(SELECTED_HOST_STORAGE_KEY, hostId);
    else window.localStorage.removeItem(SELECTED_HOST_STORAGE_KEY);
  } catch { /* Private browsing refuses the write; the selection just resets. */ }
}

function errorToken(value: unknown): string {
  return value && typeof value === 'object'
    ? String((value as { code?: unknown; message?: unknown }).code ?? (value as { message?: unknown }).message ?? '')
    : '';
}

function remoteOperationError(error: { code: string; message: string }): Error & { code: string } {
  return Object.assign(new Error(error.message), { code: error.code });
}

function remoteFeatureBlocker(value: unknown, scopeCode: string): RemoteFeatureBlocker {
  const token = errorToken(value);
  if (token.includes(REMOTE_CONTROL_HOST_UPDATE_REQUIRED)) return 'host-update';
  if (token.includes(scopeCode)) return 'scope';
  return 'unknown';
}

/**
 * A failure this phone's network explains.
 * `transient` (a bare dropped fetch, usually the 1 s poll) and `refused` (nothing was sent because the phone is
 * offline — mostly background reads) say no more than the offline banner: hidden beside it, dropped when the
 * network returns. A tap the user made gets its own notice instead (`reportTapError`).
 * `unsent` — a request is held on the phone and goes out once on reconnect, or a tap was refused behind such a
 * request (`…_UNSENT_AHEAD`, the same banner); `result` — the request reached the relay but its answer could not be
 * read, so it may be running. Both stay until that request is done, then give way to its outcome (see the effect).
 */
type PhoneNetworkErrorKind = 'transient' | 'refused' | 'unsent' | 'result';
function phoneNetworkErrorKind(value: unknown): PhoneNetworkErrorKind | null {
  if (isTransientNetworkError(value)) return 'transient';
  const token = errorToken(value);
  if (token === REMOTE_CONTROL_PHONE_OFFLINE) return 'refused';
  if (token === REMOTE_CONTROL_RESULT_UNREACHABLE) return 'result';
  return token === REMOTE_CONTROL_REQUEST_UNSENT || token === REMOTE_CONTROL_REQUEST_UNSENT_AHEAD ? 'unsent' : null;
}

/**
 * The held (or unread) request is done and the controller reported no error for it. Its own error, when there is
 * one (the Mac's refusal, the expiry notice), replaces the alert instead — see the effect that retires it.
 */
const HELD_REQUEST_SENT_NOTICE = '휴대폰에 보관했던 요청을 다시 연결된 뒤 Mac에 한 번 보냈습니다. 결과는 화면에서 확인하세요.';
const UNREAD_RESULT_ARRIVED_NOTICE = '받지 못했던 Mac의 응답을 다시 연결된 뒤 받았습니다. 결과는 화면에서 확인하세요.';

/**
 * The 1 s poll fails every second while the relay is out of reach. Its bare 「네트워크가 잠시 끊겼습니다」 must not
 * replace an alert that says what happens to a request the user made (review 2026-10-10: the unsent notice
 * lasted about one poll).
 */
function pollErrorOutranked(current: PhoneNetworkErrorKind | undefined, next: unknown): boolean {
  return (current === 'unsent' || current === 'result') && phoneNetworkErrorKind(next) === 'transient';
}

function userFacingError(value: unknown): string {
  if (isTransientNetworkError(value)) return transientNetworkErrorMessage();
  const token = errorToken(value);
  // 「Mac 연결은 정상」 is not something an offline phone can know.
  if (token.includes('REMOTE_CONTROL_ACTION_IN_PROGRESS') && !phoneIsOnline()) return phoneOfflineNotice();
  const messages: Record<string, string> = {
    REMOTE_CONTROL_PAIRING_EXPIRED_OR_USED: '이미 사용했거나 만료된 QR입니다. Mac에서 새 QR을 발급해 주세요.',
    REMOTE_CONTROL_MEMBER_REQUIRED: '이 Google 계정은 이 개인 배포본의 허용 회원이 아닙니다.',
    REMOTE_CONTROL_HOST_KEY_MISMATCH: 'QR과 릴레이의 Mac 공개키가 달라 연결을 중단했습니다.',
    REMOTE_CONTROL_SESSION_ACCESS_DENIED: '이 원격제어 세션에 접근할 수 없습니다.',
    REMOTE_CONTROL_SESSION_NOT_READY: 'Mac 승인이 끝날 때까지 잠시 기다려 주세요.',
    REMOTE_CONTROL_SESSION_LIMIT: '이 Mac에는 승인 대기·연결 기기를 합쳐 최대 8대까지 둘 수 있습니다. 쓰지 않는 연결을 해제한 뒤 다시 시도하세요.',
    REMOTE_CONTROL_PAIRING_LIMIT: '미사용 QR이 8개 남아 있습니다. Mac 앱과 데이터베이스를 최신 버전으로 업데이트하면 가장 오래된 미사용 QR을 자동 정리하고 새 QR을 만들 수 있습니다.',
    REMOTE_CONTROL_RELAY_SEQUENCE_GAP: '암호화 메시지 순서 일부를 확인하지 못해 안전하게 중단했습니다. 자동 복구되지 않으면 이 Mac 연결을 해제하고 새 QR로 다시 연결해 주세요.',
    REMOTE_CONTROL_HOST_UPDATE_REQUIRED: '이 Mac의 AgentsToZ 앱이 현재 원격 Codex 작업·대화 기능을 지원하지 않습니다. Mac 앱을 최신 설치본으로 업데이트하고 완전히 다시 연 뒤 새로고침해 주세요.',
    SESSION_LIMIT: '이 Mac에는 연결 기기를 최대 8대까지 둘 수 있습니다. 쓰지 않는 연결을 해제한 뒤 다시 시도하세요.',
    // Unmapped, this fell through to "check the Mac and your internet" — advice to inspect the
    // two things that are demonstrably fine, since the code only arises on a live session.
    REMOTE_CONTROL_ACTION_IN_PROGRESS: '앞선 요청이 아직 끝나지 않았습니다. Mac 연결은 정상이며, 진행 중인 요청이 끝나면 다시 누를 수 있습니다.',
  };
  const matched = Object.keys(messages).find(code => token.includes(code));
  if (matched) return messages[matched]!;
  if (value instanceof Error && value.message && !/^(?:REMOTE_CONTROL|RELAY)_[A-Z0-9_]+$/.test(value.message)) {
    return value.message.slice(0, 240);
  }
  return '외부 원격제어 연결을 처리하지 못했습니다. Mac과 인터넷 상태를 확인해 주세요.';
}

/**
 * The machine-readable token behind a failure.
 *
 * Every unmapped error used to collapse into "check your internet", so a screen
 * sitting in `approval-required` told the user to check a connection that was
 * fine and the real code never reached anyone who could act on it. The sentence
 * above stays human; this returns the token to show beside it, and is empty
 * when the sentence already IS the detail (a mapped code or a plain message).
 */
export function remoteControlErrorDetail(value: unknown): string {
  const token = errorToken(value).trim();
  if (!token) return '';
  if (value instanceof Error && value.message && !/^(?:REMOTE_CONTROL|RELAY)_[A-Z0-9_]+$/.test(value.message)) {
    // userFacingError already showed this message verbatim.
    return token === value.message ? '' : token.slice(0, 240);
  }
  return token.slice(0, 240);
}

/** The bounded re-check of a membership/session check that failed on the network while the phone is online. */
const MEMBERSHIP_NETWORK_RETRY_MS = 10_000;
const MEMBERSHIP_NETWORK_RETRIES = 9;

const controllerStateLabels: Record<RemoteControlRelayControllerStatus['state'], string> = {
  idle: '연결 준비',
  claiming: '보안 확인',
  'approval-required': 'Mac 승인 대기',
  connecting: '연결 중',
  online: '연결됨',
  closed: '종료됨',
  error: '연결 오류',
};

/**
 * The pill and host tabs: with no network on this phone — or a relay this phone cannot reach while the
 * device still reports a network (captive or dead Wi‑Fi) — 「연결됨」 is not something it can claim.
 */
function connectionStateLabel(
  state: RemoteControlRelayControllerStatus['state'], phoneOnline: boolean, relayUnreachable = false,
): string {
  if (!phoneOnline && state !== 'closed') return phoneOfflineLabel();
  if (relayUnreachable && state === 'online') return relayUnreachableLabel();
  return controllerStateLabels[state];
}

/** The class suffix that goes with `connectionStateLabel`: a warning about this side, not a verdict on the Mac. */
function connectionStateTone(state: RemoteControlRelayControllerStatus['state'], phoneOnline: boolean, relayUnreachable = false): string {
  if (!phoneOnline && state !== 'closed') return 'phone-offline';
  if (relayUnreachable && state === 'online') return 'phone-offline';
  return state;
}

// A Mac that has not answered its first poll has no name yet. The relay host id
// would be unreadable on a chip, so say what the chip is actually showing.
function hostLabel(host: RemoteControlRelayHostStatus): string {
  return host.status.hostName ?? '연결 중인 Mac';
}

function RemoteControlPortalApp() {
  const vaultRef = useRef<RemoteControlRelayBootstrapVault | null>(null);
  const sessionVaultRef = useRef<RemoteControlRelaySessionVault | null>(null);
  const managerRef = useRef<RemoteControlRelayControllerManager | null>(null);
  if (!managerRef.current) managerRef.current = new RemoteControlRelayControllerManager();
  const manager = managerRef.current;
  const initializedRef = useRef(false);
  const selectedHostIdRef = useRef<string | null>(null);
  const [sources, setSources] = useState<RemoteHostSource[]>([]);
  const [hosts, setHosts] = useState<RemoteControlRelayHostStatus[]>([]);
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [bootstrapChecked, setBootstrapChecked] = useState(false);
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [email, setEmail] = useState('');
  const [membershipError, setMembershipError] = useState('');
  const [membershipRetryNonce, setMembershipRetryNonce] = useState(0);
  // The membership/session check could not reach the server (no network). Shown as a network problem,
  // never as migration advice, and retried by itself when the network returns.
  // What the failed check was about ('membership' | 'session'); empty when the failure was not the network's.
  // The sentence is built at render time: the phone can come back online while the card is up.
  const [membershipNetworkSubject, setMembershipNetworkSubject] = useState<'' | 'membership' | 'session'>('');
  const membershipNetwork = membershipNetworkSubject !== '';
  // The account this page has verified with the DB allowlist. A later failure that is only the
  // network's keeps that verified state (and the polling it drives) instead of locking the screen.
  const verifiedEmailRef = useRef('');
  const reverifyPendingRef = useRef(false);
  const networkRetriesRef = useRef(0);
  const phoneOnline = usePhoneOnline();
  const [error, setErrorMessage] = useState('');
  // The token behind `error`, kept separate so the human sentence stays clean
  // while the code remains visible and copyable. Cleared whenever error is.
  const [errorDetail, setErrorDetail] = useState('');
  // Files a dirty-tree refusal names — knowing *what* to commit, not only that something must be.
  const [errorPaths, setErrorPaths] = useState<readonly string[]>([]);
  // A network drop clears itself once the Mac is seen again; any other error stays until the user acts.
  // `held` — for `unsent`/`result`: the controller still had the request in hand when this was reported, so the
  // alert may only give way to its outcome once the controller says it is done.
  const transientErrorRef = useRef<{seen: string | null; kind: PhoneNetworkErrorKind; held: boolean} | null>(null);
  // The last 「휴대폰이 오프라인입니다」 tap notice: present tense, so it goes when the network returns.
  const offlineNoticeRef = useRef('');
  const hostSeenRef = useRef<string | null>(null);
  // Plain-text errors carry no token; clearing the detail here keeps a stale
  // code from being shown under an unrelated message.
  const setError = useCallback((message: string) => {
    transientErrorRef.current = null;
    setErrorMessage(message);
    setErrorDetail('');
    setErrorPaths([]);
  }, []);
  // A tap the user made: when it was refused because the phone is offline, say that this tap was not sent
  // (a notice, not hidden behind the offline banner like a background read). Anything else is reported as usual.
  const noticePhoneOffline = (actionLabel?: string) => {
    const text = phoneOfflineTapNotice(actionLabel);
    offlineNoticeRef.current = text;
    setError('');
    setNotice(text);
  };
  const reportTapError = (value: unknown, actionLabel?: string) => {
    if (errorToken(value) === REMOTE_CONTROL_PHONE_OFFLINE && !phoneIsOnline()) {
      noticePhoneOffline(actionLabel);
      return;
    }
    reportError(value);
  };
  // A thrown failure: show the sentence, keep the code beside it.
  const reportError = useCallback((value: unknown) => {
    const kind = phoneNetworkErrorKind(value);
    // Read live, not the last rendered snapshot: that may predate the tap that just failed.
    const live = managerRef.current?.controller(selectedHostIdRef.current)?.status();
    transientErrorRef.current = kind
      ? {seen: hostSeenRef.current, kind, held: (kind === 'unsent' || kind === 'result') && !!live && (live.busy || live.unsentRequest)}
      : null;
    setErrorMessage(userFacingError(value));
    setErrorDetail(remoteControlErrorDetail(value));
    setErrorPaths(value instanceof RemoteControlRelayRequestError ? value.changedPaths.slice(0, 12) : []);
  }, []);

  const [notice, setNotice] = useState('');
  const [terminalOpen,setTerminalOpen]=useState(false);
  const [workspaceTab,setWorkspaceTab]=useState<WorkspaceTab>(() => isWorkspaceTab(history.state?.workspaceTab)?history.state.workspaceTab:initialWorkspaceTab(window.location.search));
  const [catalogVisited, setCatalogVisited] = useState(() => ['projects', 'bookmarks', 'records'].includes(workspaceTab));
  const [catalogTab,setCatalogTab]=useState<'ports'|'bookmarks'|'memories'>(()=>workspaceTab==='projects'?'ports':workspaceTab==='bookmarks'?'bookmarks':'memories');
  const [remotePane,setRemotePane]=useState<'projects'|'workroom'|'duty'|'community'>(()=>new URLSearchParams(window.location.search).get('tab')==='workroom'?'workroom':'projects');
  const [recordMode,setRecordMode]=useState<'said'|'memories'>(()=>new URLSearchParams(window.location.search).get('tab')==='memories'?'memories':'said');
  const [managementTarget,setManagementTarget]=useState('');
  const [showScanner, setShowScanner] = useState(() => new URLSearchParams(window.location.search).get('scan') === 'remote');
  const workspaceScroll=useRef(new Map<WorkspaceTab,number>());
  const workspaceTabRef=useRef(workspaceTab);workspaceTabRef.current=workspaceTab;
  useLayoutEffect(()=>{window.scrollTo(0,workspaceScroll.current.get(workspaceTab)??0)},[workspaceTab]);
  const navigateWorkspace = (tab: WorkspaceTab) => {
    workspaceScroll.current.set(workspaceTabRef.current,window.scrollY);
    if (tab === 'projects' || tab === 'bookmarks' || tab === 'records') {setCatalogVisited(true);setCatalogTab(tab==='projects'?'ports':tab==='bookmarks'?'bookmarks':'memories');}
    if (tab === 'workroom') setTerminalOpen(true);
    // The ref, not the render's value: listeners (e.g. a voice partner switch) may hold an older closure.
    if (tab !== workspaceTabRef.current) history.pushState({ ...history.state, workspaceTab: tab }, '');
    setWorkspaceTab(tab);
  };
  useEffect(() => {
    history.replaceState({ ...history.state, workspaceTab }, '');
    const restore = (event: PopStateEvent) => {
      workspaceScroll.current.set(workspaceTabRef.current,window.scrollY);
      const tab = isWorkspaceTab(event.state?.workspaceTab) ? event.state.workspaceTab : initialWorkspaceTab(window.location.search);
      setWorkspaceTab(tab);
      if (tab === 'projects' || tab === 'bookmarks' || tab === 'records') {setCatalogVisited(true);setCatalogTab(tab==='projects'?'ports':tab==='bookmarks'?'bookmarks':'memories');}
      if (tab === 'workroom') setTerminalOpen(true);
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  const [terminalEntry,setTerminalEntry]=useState<AiTerminalEntry|null>(null);
  const workroomNavigationNonce=useRef(0);
  const [vocComposer,setVocComposer]=useState<VocComposerPrefill|null>(null);
  const vocComposerKey=useRef(0);
  const findDevProject=async()=>{
    let dev = findRemoteVocDevProject(status.projects);
    if (!dev && status.nextPage !== null) {
      await loadAllProjects();
      const loaded = selectedController?.status().projects ?? [];
      dev = findRemoteVocDevProject(loaded);
    }
    return dev ?? null;
  };
  const findVocTransportProject=async()=>{
    let transport = selectRemoteVocTransportProject(status.projects,managementTarget);
    if (!transport && status.nextPage !== null) {
      await loadAllProjects();
      transport = selectRemoteVocTransportProject(selectedController?.status().projects ?? [],managementTarget);
    }
    return transport ?? null;
  };
  const screenLabel=()=>({home:'홈',projects:'프로젝트 현황',workroom:remotePane==='workroom'?'원격 작업 · 워크룸':'원격 작업',bookmarks:'북마크',records:'기록'} as Record<string,string>)[workspaceTab]??workspaceTab;
  const vocContext=(screen?:string)=>({screen:screen??screenLabel(),appVersion:'web v'+BUILD_INFO.buildNumber+(BUILD_INFO.sourceCommit?' · '+BUILD_INFO.sourceCommit.slice(0,7):''),protocolVersion:REMOTE_CONTROL_PROTOCOL_VERSION,...(status.hostName?{hostName:status.hostName}:{})});
  /** Last resort when the Mac cannot take a VOC over the relay (offline, or an older Mac app):
   *  the shared error table the Mac reads back. Text only — photos never go there. */
  const fileClientErrorFallback=async(error:RemoteVocError|undefined,comment:string)=>{
    if(!supabase)throw new Error('Mac에 연결되어 있지 않아 VOC를 보낼 수 없습니다. 연결한 뒤 다시 보내 주세요.');
    const row=buildClientErrorReport({deviceId:selectedHostId,deviceName:status.hostName,surface:error?.surface??'remote-voc',code:error?.code??'PHONE_VOC',message:error?.message??comment,detail:[error?comment:null,error?.detail??null,'state: '+status.state].filter(Boolean).join('\n'),appVersion:null});
    const {error:insertError}=await supabase.from('portmgr_client_errors').insert(row);
    if(insertError)throw new Error(`VOC를 저장하지 못했습니다. (${insertError.message??'알 수 없음'})`);
  };
  const openVocWorkroom=(devControlId:string,prompt:string)=>{
    setTerminalEntry({ nonce: ++workroomNavigationNonce.current, targetId: devControlId, title: 'VOC 처리 · 실행 전 확인', prompt });
    setRemotePane('workroom'); setTerminalOpen(true); navigateWorkspace('workroom');
  };
  /** One path for every entry point (share sheet, in-app button, error buttons): the set goes
   *  first, and only a Mac receipt counts as sent. */
  const submitVoc=async(mode:VocComposerMode,draft:VocComposerDraft,progress:(label:string)=>void)=>{
    const online=!!selectedController&&status.state==='online';
    const supported=hostSupportsRemoteVoc(status.supportedFeatures);
    const occurredAt=new Date().toISOString();
    const reportedError=draft.error?{code:draft.error.code,message:draft.error.message,detail:draft.error.detail??null,surface:draft.error.surface??'remote-control',hostName:status.hostName,occurredAt}:undefined;
    if(!online||!supported){
      if(draft.images.length)throw new Error(!online?'사진이 있는 VOC는 Mac에 연결된 상태에서 보낼 수 있습니다. 연결한 뒤 다시 보내 주세요.':'이 Mac의 AgentsToZ 앱이 사진 VOC를 지원하지 않는 이전 버전입니다. Mac 앱을 업데이트하거나 사진을 빼고 보내 주세요.');
      progress('Mac이 읽는 오류·VOC 목록에 남기는 중…');
      await fileClientErrorFallback(draft.error,draft.comment);
      if(mode==='workroom'){
        const dev=online?await findDevProject():null;
        if(!dev){
          setError('');setNotice('VOC는 저장했습니다. AgentsToZ DEV가 이 Mac의 검증된 원격 프로젝트 목록에 없어 워크룸만 열지 못했습니다. 프로젝트 등록을 확인한 뒤 「쌓인 VOC」에서 다시 처리할 수 있습니다.');
          return;
        }
        openVocWorkroom(dev.controlId,buildVocWorkflowPrompt({runsInWorkroom:true,reportedError:reportedError??{code:'PHONE_VOC',message:draft.comment,surface:'remote-voc',hostName:status.hostName,occurredAt}}));
        setNotice('VOC를 Mac에 남기고 AgentsToZ DEV 워크룸에 처리 요청을 채웠습니다. 내용을 확인한 뒤 「선택한 AI로 시작」을 누르세요.');
      } else setNotice('Mac의 AgentsToZ 앱 VOC 목록에서 확인할 수 있습니다.');
      return;
    }
    const transport=await findVocTransportProject();
    if(!transport)throw new Error('이 Mac에 VOC를 전달할 수 있는 검증된 프로젝트가 없습니다. Mac 앱에서 프로젝트를 등록한 뒤 다시 보내 주세요.');
    if(draft.images.length&&!supabase)throw new Error('사진을 보내려면 포털 로그인이 필요합니다.');
    const receipt=await sendRemoteVoc({supabase:supabase!,hostId:selectedHostId!,targetId:transport.controlId,comment:draft.comment,source:draft.source,
      context:vocContext(draft.screen),...(draft.error?{error:draft.error}:{}),images:draft.images,
      send:request=>selectedController!.sendTerminal(request),onProgress:progress})
      // Held on the phone: it goes out once on reconnect. Not a failure the user should answer by sending again.
      .catch(reason=>{if(errorToken(reason)===VOC_HELD_ON_PHONE)return null;throw reason;});
    if(!receipt){setError('');setNotice(VOC_HELD_ON_PHONE_MESSAGE);return 'held' as const;}
    if(mode==='workroom'){
      const dev=await findDevProject();
      if(!dev){
        setError('');setNotice(`VOC를 Mac에 저장했습니다${receipt.attachmentPaths.length?` (사진 ${receipt.attachmentPaths.length}장)`:''}. AgentsToZ DEV가 이 Mac의 검증된 원격 프로젝트 목록에 없어 워크룸만 열지 못했습니다. 「쌓인 VOC」에서 중복 없이 다시 처리할 수 있습니다.`);
        return;
      }
      openVocWorkroom(dev.controlId,buildVocWorkflowPrompt({runsInWorkroom:true,reportedError,focusVoc:{file:receipt.file,comment:draft.comment,attachmentPaths:receipt.attachmentPaths,source:draft.source}}));
      setError('');setNotice(`VOC를 Mac에 남겼습니다${receipt.attachmentPaths.length?` (사진 ${receipt.attachmentPaths.length}장)`:''}. AgentsToZ DEV 워크룸에 처리 요청을 채웠습니다 — 확인한 뒤 「선택한 AI로 시작」을 누르세요.`);
    } else setNotice(`VOC를 Mac에 남겼습니다${receipt.attachmentPaths.length?` (사진 ${receipt.attachmentPaths.length}장)`:''}.`);
  };
  const openVocComposer=(prefill:VocComposerPrefill)=>{vocComposerKey.current+=1;setVocHub(null);setVocComposer(prefill);};
  // ── 쌓인 VOC · 보내지 않은 캡처 ───────────────────────────────────────────────
  const [vocHub,setVocHub]=useState<{focusInbox:boolean}|null>(null);
  const [vocInbox,setVocInbox]=useState<RemoteVocInboxState>({kind:'offline'});
  const vocInboxRequest=useRef(0);
  const [captures,setCaptures]=useState<VocShareCapture[]>([]);
  const [capturesPersistent,setCapturesPersistent]=useState(true);
  const captureStoreRef=useRef<Promise<VocShareCaptureStore>|null>(null);
  const captureStore=()=>captureStoreRef.current??=openIndexedDbVocShareBackend().catch(()=>null).then(backend=>new VocShareCaptureStore(backend??memoryVocShareBackend()));
  const refreshCaptures=async()=>{const store=await captureStore();setCapturesPersistent(store.persistent);setCaptures(await store.list());};
  useEffect(()=>{void refreshCaptures().catch(()=>{});},[]);
  const openCaptureComposer=(capture:VocShareCapture)=>openVocComposer({source:'phone-share',comment:capture.comment,images:capture.images,screen:'사진 공유',captureId:capture.id});
  const loadVocInbox=async()=>{
    const mine=++vocInboxRequest.current;
    const online=!!selectedController&&status.state==='online';
    if(!online){setVocInbox({kind:'offline'});return;}
    if(!status.supportedFeatures?.includes(REMOTE_VOC_INBOX_FEATURE)){setVocInbox({kind:'update-required'});return;}
    setVocInbox(current=>({kind:'loading',previous:current.kind==='ready'?current.inbox:current.kind==='loading'?current.previous:undefined}));
    try{
      const transport=await findVocTransportProject();
      if(!transport)throw new Error('이 Mac에 VOC 목록을 읽을 수 있는 검증된 프로젝트가 없습니다. Mac 앱에서 프로젝트를 등록한 뒤 다시 시도해 주세요.');
      const result=await selectedController!.sendTerminal({operation:'workspace',requestId:crypto.randomUUID(),targetId:transport.controlId,workspace:{action:'voc.inbox'}});
      if(result.action!=='voc.inbox'||!result.vocInbox)throw new Error('Mac의 응답을 확인하지 못했습니다.');
      if(mine===vocInboxRequest.current)setVocInbox({kind:'ready',inbox:result.vocInbox});
    }catch(reason){
      if(mine===vocInboxRequest.current)setVocInbox({kind:'error',message:reason instanceof Error?reason.message:'쌓인 VOC를 불러오지 못했습니다.'});
    }
  };
  const openVocHub=(focusInbox:boolean)=>{setVocHub({focusInbox});void loadVocInbox();void refreshCaptures().catch(()=>{});};
  const processVocInbox=async(item?:RemoteVocInboxItem)=>{
    if(!selectedController||status.state!=='online')throw new Error('Mac에 연결되어 있어야 워크룸으로 처리할 수 있습니다.');
    const dev=await findDevProject();
    if(!dev)throw new Error('이 Mac의 프로젝트 목록에서 AgentsToZ DEV 프로젝트를 찾지 못했습니다. 목록을 새로고침한 뒤 다시 시도해 주세요.');
    const handoff=item
      ?buildVocItemWorkroomHandoff({file:item.file,comment:item.summary,source:item.source,photoCount:item.photos,commentIsSummary:true})
      :buildVocInboxWorkroomHandoff();
    setVocHub(null);
    openVocWorkroom(dev.controlId,handoff.prompt);
    setError('');setNotice(item?'고른 VOC의 처리 요청 초안을 AgentsToZ DEV 워크룸에 채웠습니다 — 확인한 뒤 「선택한 AI로 시작」을 누르세요.':'쌓인 VOC 처리 요청 초안을 AgentsToZ DEV 워크룸에 채웠습니다 — 확인한 뒤 「선택한 AI로 시작」을 누르세요.');
  };
  const errorVocImpl={
    compose:(error:RemoteVocError)=>openVocComposer({source:'phone-error',error,comment:'',screen:screenLabel()}),
    workroom:(error:RemoteVocError)=>{
      // One tap, like before: the error itself is the VOC. Photos or a longer note go through 「VOC 보내기」.
      void submitVoc('workroom',{comment:`이 오류를 재현하고 고쳐 주세요: ${error.message}`.slice(0,1500),images:[],error,source:'phone-error',screen:screenLabel()},label=>setNotice(label))
        .catch(reason=>setNotice(reason instanceof Error?reason.message:'VOC를 보내지 못했습니다.'));
    },
  };
  // Handlers read the latest render through a ref: the context value stays stable, and nothing
  // here touches state declared further down during render.
  const errorVocImplRef=useRef(errorVocImpl);errorVocImplRef.current=errorVocImpl;
  const errorVocHandlers=useMemo(()=>({compose:(e:RemoteVocError)=>errorVocImplRef.current.compose(e),workroom:(e:RemoteVocError)=>errorVocImplRef.current.workroom(e)}),[]);
  const sendErrorToWorkroomVoc = async () => {
    errorVocHandlers.workroom({code:errorDetail||'REMOTE_CONTROL_FAILED',message:error||status.error||'',detail:'state: '+status.state,surface:'remote-control'});
    setError('');
  };
  const vocComposerOpenRef=useRef(false);vocComposerOpenRef.current=!!vocComposer;
  const openCaptureComposerRef=useRef(openCaptureComposer);openCaptureComposerRef.current=openCaptureComposer;
  // Photos shared from the iOS Photos app wait in the app's outbox; the native shell hands them
  // over once this composer listener exists (see mobile/ios share extension). The page acks only
  // after it has taken the item, so nothing is lost if the page was not ready.
  useEffect(()=>{
    const nativeWindow=window as Window&{agentstozNativeVocShare?:boolean;webkit?:{messageHandlers?:{agentstozVocShare?:{postMessage(value:unknown):void}}}};
    const bridge=nativeWindow.webkit?.messageHandlers?.agentstozVocShare;
    if(!nativeWindow.agentstozNativeVocShare||!bridge)return;
    // The page stores the item in 「보내지 않은 캡처」 first and acks only after that, so a composer
    // closed without sending — or a second share arriving while one is open — loses nothing. The
    // shell re-delivers an unacknowledged item; the store keeps one copy per item id.
    const receive=(event:Event)=>{
      const detail=(event as CustomEvent).detail as {id?:unknown}|null;
      if(!detail||typeof detail.id!=='string')return;
      void captureStore().then(store=>receiveVocShareDelivery({store,detail,ack:id=>bridge.postMessage({type:'ack',id}),
        composerOpen:()=>vocComposerOpenRef.current,openComposer:capture=>openCaptureComposerRef.current(capture),notice:setNotice,refresh:refreshCaptures}));
    };
    window.addEventListener('agentstoz-voc-share',receive);
    bridge.postMessage({type:'ready'});
    return()=>window.removeEventListener('agentstoz-voc-share',receive);
  },[]);

  const openProjectWorkroom=(project:QrRemoteControlProjectCard)=>{
    if(!selectedController){setError('기기에 먼저 연결하세요.');return;}
    setTerminalEntry({nonce:++workroomNavigationNonce.current,targetId:project.controlId,resumeLatest:true});
    setRemotePane('workroom');setTerminalOpen(true);navigateWorkspace('workroom');
  };
  const [query, setQuery] = useState('');
  const [workspaceRootFilter, setWorkspaceRootFilter] = useState('');
  const [loadingAll, setLoadingAll] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // How many pages each host has served so far. This is per Mac: switching
  // A -> B -> A must restore A's depth instead of inheriting or resetting it.
  const loadedPageCountsByHostRef = useRef(new Map<string, number>());
  const searchSweptHostsRef = useRef(new Set<string>());
  const workspaceRootsRequestedHostsRef = useRef(new Set<string>());
  const opsStatusByHostRef = useRef(new Map<string, QrRemoteControlOpsStatus>());
  const opsCandidatesByHostRef = useRef(new Map<string, QrRemoteControlOpsCandidates>());
  const [opsStatus, setOpsStatus] = useState<QrRemoteControlOpsStatus | null>(null);
  const [opsCandidates, setOpsCandidates] = useState<QrRemoteControlOpsCandidates | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginRecovery, setLoginRecovery] = useState<{ error: unknown; changeAccount: boolean } | null>(null);
  const loginInFlight = useRef(false);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [workspaceRootId, setWorkspaceRootId] = useState('');
  const taskPanelsByHostRef = useRef(new Map<string, RemoteTaskPanelState>());
  const [taskPanel, setTaskPanelState] = useState<RemoteTaskPanelState>(EMPTY_TASK_PANEL);
  const conversationPanelsByHostRef = useRef(new Map<string, RemoteConversationPanelState>());
  const pendingConversationRequestsRef = useRef(new Map<string, string>());
  const remoteConversationSidebarRef = useRef<HTMLDivElement | null>(null);
  const remoteConversationMainRef = useRef<HTMLDivElement | null>(null);
  const [conversationPanel, setConversationPanelState] = useState<RemoteConversationPanelState>(
    EMPTY_CONVERSATION_PANEL,
  );

  const requestIdForRemoteConversationIntent = async (fingerprint: string): Promise<string> => {
    const digest = await digestAgentRuntimeStartIntent(fingerprint);
    const inMemory = pendingConversationRequestsRef.current.get(digest);
    if (inMemory) return inMemory;
    let recovered: string | null = null;
    try {
      recovered = recoverAgentRuntimePendingRequestId(window.localStorage, digest);
    } catch {
      // Private browsing can deny storage; the in-memory replay fence remains.
    }
    const requestId = recovered ?? `request_${crypto.randomUUID()}`;
    pendingConversationRequestsRef.current.set(digest, requestId);
    if (!recovered) {
      try {
        persistAgentRuntimePendingRequest(window.localStorage, digest, requestId);
      } catch {
        // The host receipt remains authoritative for this mounted session.
      }
    }
    return requestId;
  };

  const clearRemoteConversationIntent = async (fingerprint: string, requestId: string) => {
    const digest = await digestAgentRuntimeStartIntent(fingerprint);
    pendingConversationRequestsRef.current.delete(digest);
    try { clearAgentRuntimePendingRequest(window.localStorage, requestId); } catch { /* best effort */ }
  };

  const updateTaskPanel = useCallback((
    update: Partial<RemoteTaskPanelState> | ((current: RemoteTaskPanelState) => RemoteTaskPanelState),
  ) => {
    setTaskPanelState(current => {
      const next = typeof update === 'function' ? update(current) : { ...current, ...update };
      const hostId = selectedHostIdRef.current;
      if (hostId) taskPanelsByHostRef.current.set(hostId, next);
      return next;
    });
  }, []);
  const updateTaskPanelForHost = useCallback((
    hostId: string,
    update: Partial<RemoteTaskPanelState> | ((current: RemoteTaskPanelState) => RemoteTaskPanelState),
  ) => {
    const current = taskPanelsByHostRef.current.get(hostId) ?? { ...EMPTY_TASK_PANEL };
    const next = typeof update === 'function' ? update(current) : { ...current, ...update };
    taskPanelsByHostRef.current.set(hostId, next);
    if (selectedHostIdRef.current === hostId) setTaskPanelState(next);
  }, []);
  const updateConversationPanel = useCallback((
    update: Partial<RemoteConversationPanelState>
      | ((current: RemoteConversationPanelState) => RemoteConversationPanelState),
  ) => {
    setConversationPanelState(current => {
      const next = typeof update === 'function' ? update(current) : { ...current, ...update };
      const hostId = selectedHostIdRef.current;
      if (hostId) conversationPanelsByHostRef.current.set(hostId, next);
      return next;
    });
  }, []);
  const updateConversationPanelForHost = useCallback((
    hostId: string,
    update: Partial<RemoteConversationPanelState>
      | ((current: RemoteConversationPanelState) => RemoteConversationPanelState),
  ) => {
    const current = conversationPanelsByHostRef.current.get(hostId)
      ?? { ...EMPTY_CONVERSATION_PANEL };
    const next = typeof update === 'function' ? update(current) : { ...current, ...update };
    conversationPanelsByHostRef.current.set(hostId, next);
    if (selectedHostIdRef.current === hostId) setConversationPanelState(next);
  }, []);

  const supabase = useMemo(() => (
    SUPABASE_URL && SUPABASE_KEY ? getAuthenticatedSupabaseClient(SUPABASE_URL, SUPABASE_KEY) : null
  ), []);
  const status = hosts.find(host => host.hostId === selectedHostId)?.status ?? EMPTY_STATUS;
  hostSeenRef.current = status.hostLastSeenAt;
  const macReach: 'phone-offline' | 'relay-unreachable' | null = !phoneOnline ? 'phone-offline'
    : status.relayUnreachable ? 'relay-unreachable' : null;
  useEffect(() => {
    const transient = transientErrorRef.current;
    if (!transient) return;
    if (transient.kind === 'unsent' || transient.kind === 'result') {
      // The user was told this request is held (or its answer unread) and not to press again. What finally
      // happened to it must outlast the 1 s poll, which clears status.error on its next success: keep the alert
      // until the controller is done with the request, then turn its outcome into the sticky message
      // (review 2026-10-10: the outcome was on screen for about a second, then nothing).
      const live = manager.controller(selectedHostId)?.status();
      if (status.unsentRequest || status.busy || (live && (live.unsentRequest || live.busy))) { transient.held = true; return; }
      if (!transient.held) return;
      transientErrorRef.current = null;
      setErrorDetail('');
      setErrorPaths([]);
      const outcome = status.error || live?.error || '';
      if (outcome) { setErrorMessage(outcome); return; }
      setErrorMessage('');
      setNotice(transient.kind === 'unsent' ? HELD_REQUEST_SENT_NOTICE : UNREAD_RESULT_ARRIVED_NOTICE);
      return;
    }
    if (status.state !== 'online' || !status.hostLastSeenAt || status.hostLastSeenAt === transient.seen) return;
    transientErrorRef.current = null;
    setErrorMessage('');
    setErrorDetail('');
    setErrorPaths([]);
  }, [status.state, status.hostLastSeenAt, status.unsentRequest, status.busy, status.error]);
  // A dropped fetch reported while offline carries the offline sentence; once the network is back that
  // sentence is false. Drop it — the refresh that the 'online' event starts reports anything still wrong.
  // The same for the 「휴대폰이 오프라인입니다」 tap notice.
  useEffect(() => {
    if (!phoneOnline) return;
    const offlineNotice = offlineNoticeRef.current;
    if (offlineNotice) {
      offlineNoticeRef.current = '';
      setNotice(current => current === offlineNotice ? '' : current);
    }
    const kind = transientErrorRef.current?.kind;
    if (kind !== 'transient' && kind !== 'refused') return;
    transientErrorRef.current = null;
    setErrorMessage('');
    setErrorDetail('');
    setErrorPaths([]);
  }, [phoneOnline]);
  const selectedController = manager.controller(selectedHostId);
  const anyHostOnline = hosts.some(host => host.status.state === 'online');
  const workspaceConnectionKey = useMemo(() => crypto.randomUUID(), [selectedController]);
  const terminalTransport=useCallback((request:AiTerminalRequest)=>{
    if(!selectedController)throw new Error('연결된 Mac이 없습니다.');
    return selectedController.sendTerminal(request);
  },[selectedController]);
  const workroomTransport=useCallback((request:MobileWorkspaceRequest)=>{if(!selectedController)throw new Error('연결된 Mac이 없습니다.');return selectedController.sendTerminal(request);},[selectedController]);
  // 다른 아젠투지의 워크룸 — 같은 화면, 요청만 그 Mac으로 간다. 봉투에 기기 참조를 실으면 연결한 Mac이
  // 우체통이 된다(`src/communityDeviceRef.ts`). 세션·입력·읽기가 모두 그 기기에서 실행된다.
  const [communityDevice,setCommunityDevice]=useState<RemoteCommunityDevice|null>(null);
  const [communityDevices,setCommunityDevices]=useState<RemoteCommunityDevice[]>([]);
  const [communityProjects,setCommunityProjects]=useState<RemoteCommunityProjects|null>(null);
  // Every 12s read reports the device list; an equal list keeps its identity so the @-mention rows are not rebuilt.
  const setCommunityDevicesStable=useCallback((next:RemoteCommunityDevice[])=>setCommunityDevices(prior=>
    JSON.stringify(prior)===JSON.stringify(next)?prior:next),[]);

  const [communityProjectsError,setCommunityProjectsError]=useState('');
  const opsControlId=status.projects.find(p=>p.kind==='main'&&p.role==='ops')?.controlId;
  const workspaceFeatureReady=(status.supportedFeatures??[]).includes(MOBILE_WORKSPACE_FEATURE);
  // ⚠️ 전달 요청은 **동시 2개까지**만 보낸다(`createCommunityForwardGate`). 넘치면 쌓지 않고 거절해,
  // 답하지 않는 Mac 하나가 릴레이 대기열(32개)을 채워 「대기 중인 원격 입력이 많습니다」로 원인을
  // 가리는 것을 막는다 — 배경 조회는 다음 주기에 다시 온다.
  const forwardGate=useRef(createCommunityForwardGate());
  const deviceTerminalTransport=useCallback((request:AiTerminalRequest)=>{
    if(!selectedController)throw new Error('연결된 Mac이 없습니다.');
    if(!communityDevice)throw new Error('다른 아젠투지를 먼저 선택하세요.');
    const controller=selectedController,ref=communityDevice.ref;
    return forwardGate.current.run(()=>controller.sendTerminal(request,ref));
  },[selectedController,communityDevice]);
  const deviceWorkroomTransport=useCallback((request:MobileWorkspaceRequest)=>{
    if(!selectedController)throw new Error('연결된 Mac이 없습니다.');
    if(!communityDevice)throw new Error('다른 아젠투지를 먼저 선택하세요.');
    const controller=selectedController,ref=communityDevice.ref;
    return forwardGate.current.run(()=>controller.sendTerminal(request,ref));
  },[selectedController,communityDevice]);
  // The device the panel shows right now — a late answer for a device the user already left is dropped,
  // or A's projects would fill B's panel and sessions would start on A's targets through B (2026-10-06 review).
  const communityDeviceRefNow=useRef<string|null>(null);communityDeviceRefNow.current=communityDevice?.ref??null;
  // 그 기기의 프로젝트 목록은 **이 Mac이 대신 묻는다**(전달이 아니다) — 한 장 20개씩.
  const loadCommunityProjects=useCallback((device:RemoteCommunityDevice,page:number,retry=true)=>{
    if(!opsControlId){setCommunityProjectsError('이 기기에 아젠투지 총괄(OPS) 프로젝트가 허용되지 않았습니다.');return;}
    setCommunityProjectsError('');
    workroomTransport({operation:'workspace',requestId:crypto.randomUUID(),targetId:opsControlId,
      workspace:{action:'community.projects',deviceRef:device.ref,page}} as MobileWorkspaceRequest)
      .then(result=>{if(communityDeviceRefNow.current!==device.ref)return;setCommunityProjects(prior=>{
        const next=result.communityProjects??null;
        if(!next)return prior;
        // 장을 이어 붙인다 — 한 장만 들고 있으면 선택한 프로젝트가 목록에서 사라져 보인다.
        const merged=page>0&&prior?[...prior.projects.filter(item=>!next.projects.some(x=>x.targetId===item.targetId)),...next.projects]:next.projects;
        return {...next,projects:merged};
      });})
      .catch((error:unknown)=>{
        if(communityDeviceRefNow.current!==device.ref)return;
        // 첫 요청은 상대 Mac의 유휴 폴링(3초) 틈에 떨어지기 쉽다. 한 번 처리하고 나면 그 Mac은
        // 0.6초 간격으로 바뀌므로, **한 번만** 자동으로 다시 묻는다(그 뒤의 실패는 그대로 보여준다).
        if(retry){setTimeout(()=>loadCommunityProjectsRef.current?.(device,page,false),1500);return;}
        setCommunityProjectsError(error instanceof Error?error.message:'다른 아젠투지의 프로젝트 목록을 받지 못했습니다.');
      });
  },[opsControlId,workroomTransport]);
  // 자기 자신을 다시 부르기 위한 고정 참조(의존성 순환 없이).
  const loadCommunityProjectsRef=useRef(loadCommunityProjects);loadCommunityProjectsRef.current=loadCommunityProjects;
  // 커뮤니티 차원의 `@`·`#`(2026-10-05) — 입력칸에서 「2호 @…」를 쓰려면 기기마다 프로젝트 목록이 필요하다.
  // 「기기」 탭으로 고른 기기의 목록(`communityProjects`)과 달리 **쓸 때 한 번** 받고, 한 장 20개씩이라
  // 최대 다섯 장(100개)까지만 모은다 — 남은 것이 있으면 후보 목록이 그 사실을 말한다.
  const COMMUNITY_MENTION_PAGES=5;
  const [mentionProjects,setMentionProjects]=useState<Record<string,{projects?:WorkroomMentionProject[];error?:string;hasMore?:boolean}>>({});
  const mentionProjectsRef=useRef(mentionProjects);mentionProjectsRef.current=mentionProjects;
  const mentionInFlight=useRef(new Set<string>());
  const requestMentionProjects=useCallback((ref:string)=>{
    if(ref==='local'||mentionInFlight.current.has(ref)||mentionProjectsRef.current[ref]?.projects)return;
    if(!opsControlId){setMentionProjects(prior=>({...prior,[ref]:{error:'이 기기에 아젠투지 총괄(OPS) 프로젝트가 허용되지 않았습니다.'}}));return;}
    mentionInFlight.current.add(ref);
    (async()=>{
      const collected:WorkroomMentionProject[]=[];let hasMore=false;
      for(let page=0;page<COMMUNITY_MENTION_PAGES;page++){
        const result=await workroomTransport({operation:'workspace',requestId:crypto.randomUUID(),targetId:opsControlId,
          workspace:{action:'community.projects',deviceRef:ref,page}} as MobileWorkspaceRequest);
        const value=result.communityProjects;
        if(!value)break;
        for(const project of value.projects)if(!collected.some(item=>item.targetId===project.targetId))collected.push(project);
        hasMore=value.hasMore===true;
        if(!hasMore)break;
      }
      setMentionProjects(prior=>({...prior,[ref]:{projects:collected,hasMore}}));
    })().catch((error:unknown)=>setMentionProjects(prior=>({...prior,[ref]:{
      error:error instanceof Error?error.message:'그 아젠투지의 프로젝트 목록을 받지 못했습니다.'}})))
      .finally(()=>{mentionInFlight.current.delete(ref);});
  },[opsControlId,workroomTransport]);
  // ⚠️ 요청 함수는 기기마다 **한 번만** 만든다 — 순서를 지키는 대기열을 들고 있다.
  const mentionRequesters=useRef(new Map<string,(request:Omit<AiTerminalRequest,'requestId'>)=>Promise<AiTerminalResponse>>());
  const mentionRequester=useCallback((deviceId:string)=>{
    const cached=mentionRequesters.current.get(deviceId);
    if(cached)return cached;
    const made=createTerminalRequester(deviceId==='local'
      ?(request:AiTerminalRequest)=>{if(!selectedController)throw new Error('연결된 Mac이 없습니다.');return selectedController.sendTerminal(request);}
      :(request:AiTerminalRequest)=>{if(!selectedController)throw new Error('연결된 Mac이 없습니다.');
        const controller=selectedController;return forwardGate.current.run(()=>controller.sendTerminal(request,deviceId));},true);
    mentionRequesters.current.set(deviceId,made);
    return made;
  },[selectedController]);
  // Mac이 바뀌면 그 Mac을 거쳐 만든 요청 함수와 받아 둔 목록은 모두 버린다.
  useEffect(()=>{mentionRequesters.current.clear();mentionInFlight.current.clear();setMentionProjects({});
    // Another Mac is another community view: its devices, choice and project page start over (2026-10-06 review).
    setCommunityDevice(null);setCommunityDevices([]);setCommunityProjects(null);setCommunityProjectsError('');communityDevicesLoaded.current=false;},[selectedHostId]);
  // 지금 몰고 있는 기기는 목록에서 뺀다(그 기기의 프로젝트는 그냥 `@프로젝트`다). 다른 기기를 몰고
  // 있으면 **연결한 Mac**이 `@` 대상이 되므로 `local` 줄로 넣는다.
  const hostMentionProjects=useMemo(()=>status.projects.map(project=>({targetId:project.controlId,label:project.name})),[status.projects]);
  const communityMention=useMemo(()=>{
    const rows:CommunityMentionDeviceProjects[]=[];
    if(communityDevice)rows.push({deviceId:'local',label:status.hostName?.trim()||'연결한 기기',projects:hostMentionProjects});
    for(const item of communityDevices){
      if(communityDevice&&item.ref===communityDevice.ref)continue;
      const cached=mentionProjects[item.ref];
      // 기기 이름은 「<이름> / 아젠투지(OPS)」로 와서 그대로 쓰면 안내문이 길어진다 — 맥과 같은 함수로 줄인다.
      rows.push({deviceId:item.ref,label:communityDeviceLabel(item.name),
        ...(cached?.projects?{projects:cached.projects}:{}),...(cached?.error?{error:cached.error}:{}),...(cached?.hasMore?{hasMore:true}:{})});
    }
    return rows.length?{devices:rows,requestProjects:requestMentionProjects,requester:mentionRequester}:undefined;
  },[communityDevice?.ref,communityDevices,mentionProjects,status.hostName,hostMentionProjects,requestMentionProjects,mentionRequester]);
  // 워크룸 탭에 들어온 것만으로 「기기」 줄이 보이게 하는 느린 확인(45초). 커뮤니티 화면을 열면 그쪽이
  // 12초마다 읽으면서 같은 목록을 갱신한다 — 조회 예산(분당 60)에 비해 둘이 합쳐도 적다.
  // ⚠️ deps에 `status.supportedFeatures`(배열)를 넣으면 상태 폴링(~1초)마다 새 배열이 와서 이 effect가
  // **매초 다시 시작**하고, 그때마다 즉시 한 번 읽어 릴레이 32칸을 스스로 채운다 — 사용자가 본
  // 「대기 중인 원격 입력이 많습니다」의 직접 원인이었다(2026-10-05 감사). 불리언으로 고정한다.
  //   CLAUDE.md의 「패널은 projects를 내용(JSON)으로 고정한다」와 같은 함정이다.
  useEffect(()=>{
    if(!opsControlId||status.state!=='online'||workspaceTab!=='workroom'||!workspaceFeatureReady)return;
    let alive=true;
    const load=()=>workroomTransport({operation:'workspace',requestId:crypto.randomUUID(),targetId:opsControlId,
      workspace:{action:'community.status'}} as MobileWorkspaceRequest)
      .then(result=>{if(alive){communityDevicesLoaded.current=true;setCommunityDevices(prior=>{
        const next=result.community?.devices??[];
        return JSON.stringify(prior)===JSON.stringify(next)?prior:next;
      });}})
      // 실패하면 지난 목록을 그대로 둔다 — 비우면 고른 기기가 한 프레임 사라져 화면이 다시 마운트된다.
      .catch(()=>undefined);
    void load();const timer=setInterval(load,45_000);
    return ()=>{alive=false;clearInterval(timer);};
  },[opsControlId,status.state,workspaceFeatureReady,workspaceTab,workroomTransport]);
  // 커뮤니티에서 사라진 기기는 연결한 Mac으로 되돌린다 — 죽은 화면을 남기지 않는다.
  // ⚠️ 예전에는 목록이 **비어 있으면** 되돌리지 않아서, 상대가 커뮤니티에서 나간 뒤 그 기기에 갇혔다
  // (2026-10-05 감사). 실패한 조회는 목록을 비우지 않으므로(`catch`가 지난 목록을 유지) 빈 목록은
  // 「성공적으로 아무도 없음」이고, 그때는 되돌리는 것이 맞다. 첫 조회 전에는 되돌리지 않는다.
  const communityDevicesLoaded=useRef(false);
  useEffect(()=>{
    if(communityDevice&&communityDevicesLoaded.current&&!communityDevices.some(item=>item.ref===communityDevice.ref)){
      setCommunityDevice(null);setCommunityProjects(null);setCommunityProjectsError('');
    }
  },[communityDevice,communityDevices]);
  // `ops:true`면 그 기기의 **OPS 프로젝트까지** 골라 준다(목록이 도착한 뒤 한 번) — 음성 도크의
  // 「OPS 워크룸 열기 · 3호」가 쓰는 길이다. 음성으로 다른 호를 모는 것은 두 홉이라 넣지 않았다.
  const [communityOpsWanted,setCommunityOpsWanted]=useState(0);
  const driveCommunityDevice=useCallback((device:RemoteCommunityDevice,options:{ops?:boolean}={})=>{
    setCommunityDevice(device);setCommunityProjects(null);loadCommunityProjects(device,0);
    setCommunityOpsWanted(options.ops?Date.now():0);
    setRemotePane('workroom');setTerminalOpen(true);navigateWorkspace('workroom');
  },[loadCommunityProjects]);
  // 아젠투지 voice on a phone (VOC 2026-09-29): one panel and the always-on dock at the root, per Mac.
  const voiceProjects=useMemo(()=>status.projects.map(p=>({id:p.controlId,label:p.name,role:p.role,kind:p.kind})),[status.projects]);
  const opsVoiceProject=remoteOpsVoiceProject(voiceProjects);
  const opsVoiceTransport=useMemo(()=>remoteVoiceTransport(workroomTransport,opsVoiceProject?.id??'ops-unavailable'),[workroomTransport,opsVoiceProject?.id]);
  // A phone without the OPS project still has voice: an open workroom's AI (control ids — the phone's own list).
  const workroomVoiceFallback=useMemo(()=>({
    list:async()=>{
      const listed=await terminalTransport({operation:'list',requestId:crypto.randomUUID()} as AiTerminalRequest);
      const names=new Map(status.projects.map(p=>[p.controlId,p.name]));
      return (listed.sessions??[]).filter(s=>s.state==='running'&&names.has(s.targetId)).map(s=>({targetId:s.targetId,sessionId:s.id,label:`${names.get(s.targetId)} · ${s.agent}`}));
    },
    transport:(targetId:string)=>remoteVoiceTransport(workroomTransport,targetId),
  }),[terminalTransport,workroomTransport,status.projects]);
  // Like the Mac: when 아젠투지 switches to a project AI (tap or voice), show that workroom. The event carries the
  // Mac's runtime id, so the session is found in this phone's own list (control ids), never by that id.
  useEffect(()=>{
    const onTarget=async(event:Event)=>{
      const detail=(event as CustomEvent).detail as {kind?:string;sessionId?:string}|undefined;
      if(detail?.kind!=='workroom'||!detail.sessionId)return;
      try{
        const listed=await terminalTransport({operation:'list',requestId:crypto.randomUUID()} as AiTerminalRequest);
        const session=(listed.sessions??[]).find(s=>s.id===detail.sessionId);if(!session)return;
        setTerminalEntry({nonce:++workroomNavigationNonce.current,targetId:session.targetId,sessionId:session.id,agent:session.agent});
        setRemotePane('workroom');setTerminalOpen(true);navigateWorkspace('workroom');
      }catch{/* The dock already shows who answers; navigation is a convenience. */}
    };
    window.addEventListener('agentstoz:voice-target-change',onTarget);return()=>window.removeEventListener('agentstoz:voice-target-change',onTarget);
  },[terminalTransport]);
  const capabilityProbePending = status.state === 'online' && status.supportedFeatures === null;
  const conversationHostUpdateRequired = status.state === 'online'
    && status.supportedFeatures !== null
    && !status.supportedFeatures.includes(REMOTE_CONTROL_CONVERSATION_SCOPE);
  const taskHostUpdateRequired = status.state === 'online'
    && status.supportedFeatures !== null
    && !status.supportedFeatures.includes(REMOTE_CONTROL_TASK_SCOPE);
  const availableWorkspaceRoots = useMemo(() => Array.from(new Set([
    ...status.workspaceRoots.map(root => root.name),
    ...status.projects.flatMap(project => project.workspaceRoot ? [project.workspaceRoot] : []),
  ])).sort((left, right) => left.localeCompare(right, 'ko-KR', { numeric: true, sensitivity: 'base' })), [status.projects, status.workspaceRoots]);
  const filteredProjects = useMemo(() => {
    // The shared matcher handles macOS NFD filenames, Hangul initials and
    // a query typed with the wrong Korean/English keyboard layout.
    const normalized = query.trim();
    const rootFiltered = status.projects.filter(project => (
      !workspaceRootFilter
      || (workspaceRootFilter === UNASSIGNED_WORKSPACE_ROOT
        ? project.workspaceRoot === null
        : project.workspaceRoot === workspaceRootFilter.slice(WORKSPACE_ROOT_FILTER_PREFIX.length))
    ));
    if (!normalized) return rootFiltered;
    // Both labels are searchable: the phone shows the saved name, but the AI
    // alias is what an English-language search is likely to be typed against.
    // 브랜치도 넣는다 — 워크트리 카드는 이름이 서로 비슷해서 브랜치가 사실상 이름이다.
    return rootFiltered.filter(project => (
      matchesSearchText(project.name, normalized)
      || matchesSearchText(project.alias ?? '', normalized)
      || matchesSearchText(project.branch ?? '', normalized)
      // 「쉐도우루프」로 ShadowLoop를 찾는다 — Mac의 프로젝트 검색과 같은 판정(src/phoneticSearch.ts).
      || matchesPhoneticName(project.name, normalized)
      || matchesPhoneticName(project.alias ?? '', normalized)
    ));
  }, [query, workspaceRootFilter, status.projects]);

  const syncHosts = () => setHosts(manager.statuses());

  const applySelection = (hostId: string | null) => {
    selectedHostIdRef.current = hostId;
    setSelectedHostId(hostId);
    setOpsStatus(hostId ? opsStatusByHostRef.current.get(hostId) ?? null : null);
    setOpsCandidates(hostId ? opsCandidatesByHostRef.current.get(hostId) ?? null : null);
    writeSelectedHostId(hostId);
    setTaskPanelState(hostId
      ? taskPanelsByHostRef.current.get(hostId) ?? { ...EMPTY_TASK_PANEL }
      : { ...EMPTY_TASK_PANEL });
    setConversationPanelState(hostId
      ? conversationPanelsByHostRef.current.get(hostId) ?? { ...EMPTY_CONVERSATION_PANEL }
      : { ...EMPTY_CONVERSATION_PANEL });
  };

  const selectHost = (hostId: string | null) => {
    setTerminalEntry(null);
    applySelection(hostId);
    // Every panel below belongs to the selected Mac; carrying the previous
    // Mac's banner or search across would blame this one for it. Only a tap
    // clears them — an automatic reselection must not swallow the message that
    // explains why the previous Mac went away.
    setError('');
    setNotice('');
    setQuery('');
    setWorkspaceRootFilter('');
    setCreateProjectOpen(false);
    setWorkspaceRootId('');
    setProjectName('');
    setRefreshing(false);
    setLoadingAll(false);
    // Initialise a Mac only once. Returning to it preserves the depth already
    // loaded for that controller.
    if (hostId && !loadedPageCountsByHostRef.current.has(hostId)) {
      loadedPageCountsByHostRef.current.set(hostId, 1);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const vault = new RemoteControlRelayBootstrapVault();
    const sessionVault = new RemoteControlRelaySessionVault();
    vaultRef.current = vault;
    sessionVaultRef.current = sessionVault;
    void (async () => {
      const found = new Map<string, RemoteHostSource>();
      let scannedHostId: string | null = null;
      try {
        const fromFragment = controllerPairingUrl(capturedPairingFragment);
        if (fromFragment) scannedHostId = await vault.seal(fromFragment);
        for (const entry of await sessionVault.loadAll()) {
          found.set(entry.hostId, { hostId: entry.hostId, restoredSession: entry.snapshot });
        }
        // A QR that is still sealed for a Mac takes that Mac over from its
        // stored session: it was scanned to reconnect exactly this Mac. The
        // session is kept alongside it so a spent QR can fall back to it
        // instead of shadowing a working connection on every reload.
        for (const entry of await vault.loadAll()) {
          found.set(entry.hostId, { ...found.get(entry.hostId), hostId: entry.hostId, pairingUrl: entry.pairingUrl });
        }
      } catch (vaultError) {
        if (!cancelled) reportError(vaultError);
      }
      if (cancelled) return;
      const ordered = [...found.values()];
      const stored = readSelectedHostId();
      setSources(ordered);
      applySelection(scannedHostId
        ?? (stored && found.has(stored) ? stored : null)
        ?? ordered[0]?.hostId
        ?? null);
      setBootstrapChecked(true);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!supabase) { setAuthState('unavailable'); return; }
    let cancelled = false;
    // Set when this run's stored-session read failed: `error` locks the card until 「다시 확인」; a network
    // failure (`keep`/`network`) keeps listening for auth events (authEventCountsAfterSessionFailure).
    let sessionFailure: SessionReadFailure | null = null;
    let revision = 0;
    const verifySession = async (sessionEmail: string, expectedRevision: number) => {
      const membership = await verifyPortalMembership(supabase as unknown as PortalMembershipRpcClient);
      if (cancelled || expectedRevision !== revision) return;
      setLoginBusy(false);
      if (keepVerifiedThroughFailure(verifiedEmailRef.current, sessionEmail, membership)) {
        // auth-js re-emits SIGNED_IN on focus/refresh; offline, the re-check cannot reach the DB.
        // This account was verified on this page — keep it, and check again when the network returns.
        reverifyPendingRef.current = true;
        setMembershipNetworkSubject('');
        setMembershipError('');
        setAuthState('signed-in');
        return;
      }
      reverifyPendingRef.current = false;
      if (membership.state === 'member') {
        verifiedEmailRef.current = sessionEmail;
        setMembershipNetworkSubject('');
        setMembershipError('');
        setEmail(sessionEmail);
        setAuthState('signed-in');
        // OAuth's temporary `code` is no longer needed after the SDK creates a
        // session. The QR bootstrap was never stored in this query.
        window.history.replaceState(null, '', '/remote/');
        return;
      }
      // A denial or any non-network failure ends what this page had verified.
      verifiedEmailRef.current = '';
      setEmail(sessionEmail);
      setMembershipNetworkSubject(membership.state === 'error' && membership.network === true ? 'membership' : '');
      setMembershipError(portalMembershipFailureMessage(membership, sessionEmail));
      setAuthState(membership.state === 'denied' ? 'denied' : 'verification-error');
    };
    // The stored session could not be read or refreshed. Because there is no network: a page that already
    // verified its account keeps it, a cold load says it is the network — never migrations. Anything else locks
    // the card and ends what this page had verified (the caller then sets its own message).
    const sessionReadFailed = (sessionError: unknown): boolean => {
      sessionFailure = sessionReadFailure(verifiedEmailRef.current, isPortalNetworkFailure(sessionError));
      setLoginBusy(false);
      if (sessionFailure === 'keep') {
        reverifyPendingRef.current = true;
        setMembershipNetworkSubject('');
        setMembershipError('');
        setAuthState('signed-in');
        return true;
      }
      if (sessionFailure === 'network') {
        setMembershipNetworkSubject('session');
        setMembershipError('');
        setAuthState('verification-error');
        return true;
      }
      verifiedEmailRef.current = '';
      reverifyPendingRef.current = false;
      setMembershipNetworkSubject('');
      return false;
    };
    const observeSession = (sessionEmail: string) => {
      if (sessionFailure === 'error') return;
      const expectedRevision = ++revision;
      if (!sessionEmail) {
        verifiedEmailRef.current = '';
        reverifyPendingRef.current = false;
        setEmail('');
        setMembershipError('');
        setLoginBusy(false);
        setAuthState('signed-out');
        return;
      }
      setEmail(sessionEmail);
      // Re-checking an account this page already verified keeps the screen (and its polling) as is;
      // the result below still denies on a real refusal.
      if (verifiedEmailRef.current !== sessionEmail) setAuthState('checking');
      // Do not await an RPC while Supabase's auth callback owns its internal
      // lock. The DB allowlist remains the sole authority on the next task.
      window.setTimeout(() => void verifySession(sessionEmail, expectedRevision), 0);
    };
    void (async () => {
      try {
        const { data, error: sessionError } = await withPortalAuthTimeout(
          supabase.auth.getSession(),
          'SESSION',
        );
        if (cancelled) return;
        if (sessionError) {
          if (sessionReadFailed(sessionError)) return;
          setMembershipError(`Google 로그인 상태를 확인하지 못했습니다. (${portalAuthErrorMessage(sessionError)})`);
          setAuthState('verification-error');
          return;
        }
        observeSession(data.session?.user?.email ?? '');
      } catch (sessionError) {
        if (cancelled) return;
        if (sessionReadFailed(sessionError)) return;
        setMembershipError(
          `저장된 Google 로그인 상태 확인이 끝나지 않았습니다. 다시 확인하거나 이 기기의 로그인만 초기화해 주세요. (${portalAuthErrorMessage(sessionError)})`,
        );
        setAuthState('verification-error');
      }
    })();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (cancelled || !authEventCountsAfterSessionFailure(sessionFailure, event, !!session)) return;
      observeSession(session?.user?.email ?? '');
    });
    return () => { cancelled = true; revision += 1; subscription.unsubscribe(); };
  }, [membershipRetryNonce, supabase]);

  const connectHost = async (source: RemoteHostSource): Promise<void> => {
    const hostId = source.hostId;
    const pairingUrl = source.pairingUrl ?? null;
    const restoredSession = pairingUrl ? null : source.restoredSession ?? null;
    const controller = new RemoteControlRelayController({
      transport: new RemoteControlRelayControllerRpcClient(
        createSupabaseRemoteControlRelayRpcInvoker(supabase!),
      ),
      ...(restoredSession ? { restoredSession } : { pairingUrl: pairingUrl! }),
      // The Mac lists this name under 승인된 모바일 기기; the app must not call itself the web.
      controllerName: PORTAL_IS_BUNDLED ? 'AgentsToZ 앱 (iPhone·iPad)' : '휴대폰·iPad 웹',
      onSessionChanged: async snapshot => {
        if (snapshot) await sessionVaultRef.current?.save(snapshot);
        else await sessionVaultRef.current?.clearHost(hostId);
      },
      onClaimed: async () => {
        await vaultRef.current?.clearHost(hostId);
        // The QR is spent the moment it is claimed. Leaving it in `sources`
        // would re-seal a dead bootstrap on an account switch, and that record
        // then shadows the very session this claim created.
        setSources(current => current.map(source => (
          source.hostId === hostId ? { hostId } : source
        )));
      },
    });
    manager.adopt(hostId, controller);
    syncHosts();
    try {
      let next = restoredSession ? await controller.refresh() : await controller.initialize();
      if (restoredSession && next.state === 'online' && !next.busy) {
        if (next.supportedFeatures === null) {
          next = await controller.probeSupportedFeatures();
        }
        if (!next.busy) await controller.sendAction('projects.list', undefined, 0);
      }
    } catch (connectError) {
      // A QR is one-use. When claiming it fails on a Mac that still has an
      // approved session, drop the spent bootstrap and resume that session —
      // otherwise the dead QR shadows a working connection on every reload.
      if (pairingUrl && source.restoredSession
        && errorToken(connectError).includes('REMOTE_CONTROL_PAIRING_EXPIRED_OR_USED')) {
        await vaultRef.current?.clearHost(hostId).catch(() => undefined);
        manager.forget(hostId);
        await connectHost({ hostId, restoredSession: source.restoredSession });
        return;
      }
      throw connectError;
    } finally {
      syncHosts();
    }
  };

  useEffect(() => {
    if (!bootstrapChecked || authState !== 'signed-in' || sources.length === 0
      || !supabase || initializedRef.current) return;
    initializedRef.current = true;
    let cancelled = false;
    void (async () => {
      // Every controller owns a different E2EE session and host row, so Macs
      // can be resumed in parallel. One refusal remains isolated to that Mac.
      const outcomes = await Promise.allSettled(sources.map(source => connectHost(source)));
      if (cancelled) return;
      outcomes.forEach((outcome, index) => {
        const source = sources[index];
        if (outcome.status === 'rejected'
          && source?.hostId === selectedHostIdRef.current) {
          reportError(outcome.reason);
        }
      });
    })();
    return () => { cancelled = true; };
  }, [authState, bootstrapChecked, sources, supabase]);

  useEffect(() => {
    // A Mac still listed in `sources` is only waiting for its turn to connect,
    // so the stored selection must survive the pass that brings the others up.
    if (hosts.length > 0
      && !hosts.some(host => host.hostId === selectedHostId)
      && !sources.some(source => source.hostId === selectedHostId)) {
      applySelection(hosts[0]!.hostId);
    }
  }, [hosts, selectedHostId, sources]);

  const livePollTargets = hosts.filter(host => host.status.state !== 'closed').length;
  useEffect(() => {
    if (authState !== 'signed-in' || livePollTargets === 0) return;
    let cancelled = false;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight || document.hidden) return;
      // No network on this phone: asking would only fail once a second. The controllers learn that the
      // relay is out of reach (so a frozen last-seen is not read as the Mac sleeping), and the
      // 'online' event below refreshes at once.
      if (!phoneIsOnline()) {
        for (const hostId of manager.hostIds()) manager.controller(hostId)?.noteNetworkLost();
        syncHosts();
        return;
      }
      inFlight = true;
      try {
        const selected = selectedHostIdRef.current;
        const due = manager.dueForRefresh(Date.now(), selected);
        // Distinct Macs have distinct relay sessions. Refresh them concurrently
        // so an asleep background Mac cannot delay the selected Mac's 1s path.
        await Promise.all(due.map(async hostId => {
          const hostController = manager.controller(hostId);
          if (cancelled || !hostController) return;
          try {
            const next = await hostController.refresh();
            if (next.state === 'online'
              && next.supportedFeatures === null
              && !next.busy
              && !next.error) {
              await hostController.probeSupportedFeatures();
            }
          } catch (refreshError) {
            // Only the Mac on screen may raise the banner. A background host's
            // trouble is already visible on its chip, and reporting it here
            // would replace the message for the Mac being used.
            if (!cancelled && hostId === selected && !pollErrorOutranked(transientErrorRef.current?.kind, refreshError)) reportError(refreshError);
          } finally {
            manager.markRefreshed(hostId, Date.now());
          }
        }));
        if (!cancelled) syncHosts();
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => { void refresh(); }, REMOTE_CONTROL_SELECTED_HOST_POLL_MS);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    const onOffline = () => { void refresh(); };
    const onOnline = () => {
      // Every Mac is due now: each one's last status is as old as the outage.
      for (const hostId of manager.hostIds()) manager.markRefreshed(hostId, 0);
      void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [authState, livePollTargets]);

  // A membership/session check that failed only for want of a network runs again by itself when the
  // network returns or the page comes back — this is what lets polling resume after an offline load.
  useEffect(() => {
    const retry = () => {
      if (!phoneIsOnline() || document.hidden) return;
      if (reverifyPendingRef.current || (authState === 'verification-error' && membershipNetwork)) {
        reverifyPendingRef.current = false;
        networkRetriesRef.current = 0;
        setMembershipRetryNonce(value => value + 1);
      }
    };
    // Only on these events, never on a render: a network that reports online but still fails would
    // otherwise re-run the check in a tight loop.
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', retry);
    return () => {
      window.removeEventListener('online', retry);
      document.removeEventListener('visibilitychange', retry);
    };
  }, [authState, membershipNetwork]);

  // Online but failing, no 'online' event will come — and auth-js keeps a failed token refresh for 60 s, so the
  // first retries can fail at once. Keep asking on a bounded timer (every 10 s, nine times) instead of waiting
  // for an event that never fires (review 2026-10-10: an expired session never recovered after a 40 s outage).
  // The count survives the effect re-running (a retry can pass through 'checking' and fail again), so the bound
  // holds; it starts over once the page settles, on 'online', or on 「다시 확인」.
  useEffect(() => {
    if (authState === 'signed-in' || authState === 'denied' || authState === 'signed-out') networkRetriesRef.current = 0;
  }, [authState]);
  useEffect(() => {
    if (authState !== 'verification-error' || !membershipNetwork || !phoneOnline) return;
    const timer = window.setInterval(() => {
      if (document.hidden || !phoneIsOnline()) return;
      if (networkRetriesRef.current >= MEMBERSHIP_NETWORK_RETRIES) { window.clearInterval(timer); return; }
      networkRetriesRef.current += 1;
      setMembershipRetryNonce(value => value + 1);
    }, MEMBERSHIP_NETWORK_RETRY_MS);
    return () => window.clearInterval(timer);
  }, [authState, membershipNetwork, phoneOnline]);

  const login = async (changeAccount = false, continueAfterConnectionFailure = false) => {
    if (!supabase || loginInFlight.current || (sources.length === 0 && hosts.length === 0)) return;
    const continueDirectly = continueAfterConnectionFailure && canContinuePortalGoogleOAuth(loginRecovery?.error);
    loginInFlight.current = true;
    setLoginBusy(true);
    setError('');
    setLoginRecovery(null);
    try {
      // Keep every one-use QR bootstrap sealed across the full-page OAuth
      // redirect, including an explicit switch away from a denied account.
      for (const source of sources) {
        const pairingUrl = source.pairingUrl;
        if (pairingUrl) await vaultRef.current?.seal(pairingUrl);
      }
      // Prove that Auth and the Google provider answer before discarding a
      // denied account or leaving this recoverable page for `/authorize`.
      if (!continueDirectly) await preflightPortalGoogleOAuth({
        supabaseUrl: SUPABASE_URL,
        supabaseAnonKey: SUPABASE_KEY,
      });
      if (changeAccount) {
        const { error: signOutError } = await withPortalAuthTimeout(
          supabase.auth.signOut({ scope: 'local' }),
          'OAUTH',
        );
        if (signOutError) throw signOutError;
        setEmail('');
        setAuthState('signed-out');
      }
      if(nativePortalOAuthAvailable()){
        await signInWithNativePortalOAuth({client:supabase,supabaseUrl:SUPABASE_URL});
        setLoginBusy(false);
        return;
      }
      const authorizeUrl = await createPortalGoogleOAuthUrl({
        client: supabase,
        supabaseUrl: SUPABASE_URL,
        redirectTo: `${window.location.origin}/remote/`,
      });
      window.location.assign(authorizeUrl);
    } catch (loginError) {
      setLoginRecovery({ error: loginError, changeAccount });
      const message = portalOAuthStartErrorMessage(loginError);
      setErrorMessage(message);
      setErrorDetail(errorToken(loginError).slice(0, 240) || 'PORTAL_AUTH_OAUTH_FAILED');
    } finally {
      loginInFlight.current = false;
      setLoginBusy(false);
    }
  };

  const resetStoredLogin = () => {
    try { clearStoredPortalAuth(window.localStorage); } catch { /* reload still resets the client */ }
    window.history.replaceState(null, '', '/remote/');
    window.location.reload();
  };

  const runAction = async (project: QrRemoteControlProjectCard, action: QrRemoteControlAction, input?: string) => {
    const controller = selectedController;
    const hostId = selectedHostId;
    if (!controller || !hostId) return;
    const host = controller.status().hostName ?? '연결된 Mac';
    const targetKind = project.kind === 'worktree' ? '워크트리' : '프로젝트';
    const firstConversationNotice = action === 'codex.thread.start'
      ? '\n\n고정된 안전 안내문과 짧은 응답을 새 대화로 저장한 뒤, 이 Mac의 ChatGPT Codex 앱에 그 대화를 열도록 요청합니다. 파일 수정이나 임의 명령은 요청하지 않습니다.'
      : action === 'app.codex'
        ? '\n\n이 프로젝트에 정확히 연결된 가장 최근 Codex 대화만 다시 엽니다. 연결 기록이 없으면 다른 대화를 대신 열지 않습니다.'
        : action === 'app.hermes'
          ? '\n\n이 프로젝트에 정확히 연결된 가장 최근 Hermes 대화 열기를 요청합니다. Desktop 실행과 딥링크 전달까지만 확인하므로 실제 대화 선택은 Mac의 앱에서 확인해야 합니다.'
        : action.startsWith('agent.')
          ? '\n\n최초 로그인·약관 동의·폴더 신뢰 화면이 나타나면 Mac의 Orca에서 직접 확인해야 합니다.'
          : '';
    // Offline, nothing can be sent: say so for this tap instead of a 「요청을 보냈습니다」 that flashes and vanishes.
    if (!phoneIsOnline()) { noticePhoneOffline(remoteControlActionLabel(action)); return; }
    if (!window.confirm(`${host}\n${targetKind} ‘${project.name}’\n\n${remoteControlActionLabel(action)} 기능을 실행할까요?${firstConversationNotice}`)) return;
    setError('');
    // The Mac runs the work before it answers, so this await is as long as the
    // action itself. Buttons disable, but without a line of text a slow git
    // pull reads as a frozen page.
    setNotice(`${host} · ${project.name}: ${remoteControlActionLabel(action)} 요청을 보냈습니다. Mac이 끝낼 때까지 기다리는 중입니다.`);
    try {
      await controller.sendAction(action, project.controlId, undefined, input);
      syncHosts();
      if (selectedHostIdRef.current === hostId) {
        setNotice(action === 'codex.thread.start'
          ? `${host} · ${project.name}: 프로젝트 연결을 확인하고 Mac의 Codex 앱에 열기를 요청했습니다. 실제 화면은 Mac에서 확인하세요.`
          : action === 'app.hermes'
            ? `${host} · ${project.name}: 최근 Hermes 대화 열기 요청을 Mac에 전달했습니다. 실제 대화 선택은 Mac의 Hermes Desktop에서 확인하세요.`
            : `${host} · ${project.name}: ${remoteControlActionLabel(action)} 요청을 완료했습니다.`);
      }
    } catch (actionError) {
      // Leaving the "기다리는 중" line up next to a failure reads as if the work
      // were still going.
      if (selectedHostIdRef.current === hostId) {
        setNotice('');
        reportTapError(actionError, remoteControlActionLabel(action));
      }
    }
  };

  const runProjectAction = async (project: QrRemoteControlProjectCard, action: QrRemoteControlAction) => {
    let input: string | undefined;
    if (action === 'git.commit') {
      const value = window.prompt(`${project.name}\n커밋 메시지를 입력하세요. 변경 파일 전체가 로컬 앱과 같은 제외 규칙으로 커밋됩니다.`);
      if (value === null) return;
      input = value.trim();
      if (!input) { setError('커밋 메시지를 입력하세요.'); return; }
      // The host rejects >120 characters with a bare {type:'error'} reply, so
      // catch the length here instead of spending a round trip on it.
      if (input.length > 120) { setError('커밋 메시지는 한 줄 1~120자로 입력하세요.'); return; }
    }
    if (action === 'worktree.add' || action === 'worktree.add.orca') {
      const owner = action === 'worktree.add.orca' ? 'Orca 등록' : '표준 Git';
      const value = window.prompt(`${project.name}\n새 ${owner} 워크트리의 브랜치 이름을 입력하세요.`);
      if (value === null) return;
      input = value.trim();
      if (!input) { setError('브랜치 이름을 입력하세요.'); return; }
      if (input.length > 120) { setError('브랜치 이름은 한 줄 1~120자로 입력하세요.'); return; }
    }
    await runAction(project, action, input);
  };

  const refreshRemoteConversationHistory = async (
    conversation: RemoteControlConversationSummary,
    controller = selectedController,
    hostId = selectedHostId,
  ) => {
    if (!controller || !hostId) return;
    updateConversationPanelForHost(hostId, current => ({
      ...current, selectedConversationId: conversation.conversationId, busy: true, syncError: '',
    }));
    try {
      const previous = conversationPanelsByHostRef.current.get(hostId);
      const sameConversation = previous?.selectedConversationId === conversation.conversationId;
      const messages: RemoteControlConversationHistoryMessage[] =
        conversation.state === 'idle' || conversation.state === 'archived'
          ? []
          : sameConversation
            ? previous.messages
            : [];
      let historyTruncated = sameConversation ? previous?.historyTruncated ?? false : false;
      let historyFiltered = sameConversation ? previous?.historyFiltered ?? false : false;
      if (conversation.state === 'idle' || conversation.state === 'archived') {
        let cursor: string | null = null;
        const visited = new Set<string>();
        for (let page = 0; page < REMOTE_CONVERSATION_PAGE_MAX; page += 1) {
          const response: RemoteControlConversationResult = await controller.sendConversation('conversations.history', {
            conversationId: conversation.conversationId,
            expectedRevision: conversation.revision,
            cursor,
          });
          if (!response.ok) throw remoteOperationError(response.error);
          if (!('messages' in response.result)) throw new Error('대화 기록 응답을 확인하지 못했습니다.');
          messages.push(...response.result.messages);
          historyTruncated ||= response.result.truncated;
          historyFiltered ||= response.result.filtered;
          if (response.result.nextCursor === null) break;
          if (visited.has(response.result.nextCursor)) throw new Error('대화 기록 위치가 반복되어 불러오기를 중단했습니다.');
          visited.add(response.result.nextCursor);
          cursor = response.result.nextCursor;
          if (page === REMOTE_CONVERSATION_PAGE_MAX - 1) {
            throw new Error('최근 대화 기록이 원격 페이지 한도를 초과했습니다.');
          }
        }
      }

      const events: RemoteControlConversationEvent[] = sameConversation ? [...previous.events] : [];
      let after = sameConversation ? previous.eventCursor : 0;
      const visitedEventCursors = new Set<number>();
      for (let page = 0; page < REMOTE_CONVERSATION_EVENT_PAGE_MAX; page += 1) {
        if (visitedEventCursors.has(after)) throw new Error('대화 진행 기록 위치가 반복되어 불러오기를 중단했습니다.');
        visitedEventCursors.add(after);
        const response = await controller.sendConversation('conversations.events', {
          conversationId: conversation.conversationId,
          after,
        });
        if (!response.ok) throw remoteOperationError(response.error);
        if (!('events' in response.result)) throw new Error('대화 진행 기록 응답을 확인하지 못했습니다.');
        events.push(...response.result.events);
        if (response.result.events.length === 0) break;
        if (response.result.nextCursor <= after) throw new Error('대화 진행 기록 cursor가 전진하지 않았습니다.');
        after = response.result.nextCursor;
        if (page === REMOTE_CONVERSATION_EVENT_PAGE_MAX - 1) {
          throw new Error('최근 대화 진행 기록이 원격 페이지 한도를 초과했습니다.');
        }
      }
      updateConversationPanelForHost(hostId, current => ({
        ...current,
        busy: false,
        messages,
        historyTruncated,
        historyFiltered,
        pendingPrompts: conversation.state === 'idle' || conversation.state === 'archived'
          ? current.pendingPrompts.filter(prompt => prompt.conversationId !== conversation.conversationId)
          : current.pendingPrompts,
        events: events.filter((event, index, all) => (
          all.findIndex(candidate => candidate.seq === event.seq) === index
        )).slice(-64),
        eventCursor: after,
        syncError: '',
      }));
    } catch (conversationError) {
      updateConversationPanelForHost(hostId, current => ({
        ...current, busy: false, syncError: userFacingError(conversationError),
      }));
    } finally {
      syncHosts();
    }
  };

  const refreshRemoteConversationList = async (
    controller = selectedController,
    hostId = selectedHostId,
    selectedConversationId = conversationPanel.selectedConversationId,
    archivedOnly = (hostId
      ? conversationPanelsByHostRef.current.get(hostId)?.archivedOnly
      : undefined) ?? conversationPanel.archivedOnly,
  ) => {
    if (!controller || !hostId) return;
    updateConversationPanelForHost(hostId, current => ({ ...current, busy: true, syncError: '' }));
    try {
      const conversations: RemoteControlConversationSummary[] = [];
      let cursor: string | null = null;
      const visited = new Set<string>();
      for (let page = 0; page < REMOTE_CONVERSATION_PAGE_MAX; page += 1) {
        const response: RemoteControlConversationResult = await controller.sendConversation('conversations.list', {
          archivedOnly,
          cursor,
        });
        if (!response.ok) throw remoteOperationError(response.error);
        if (!('conversations' in response.result)) throw new Error('대화 목록 응답을 확인하지 못했습니다.');
        conversations.push(...response.result.conversations);
        if (response.result.nextCursor === null) break;
        if (visited.has(response.result.nextCursor)) throw new Error('대화 목록 위치가 반복되어 불러오기를 중단했습니다.');
        visited.add(response.result.nextCursor);
        cursor = response.result.nextCursor;
        if (page === REMOTE_CONVERSATION_PAGE_MAX - 1) {
          throw new Error('최근 대화 목록이 원격 페이지 한도를 초과했습니다.');
        }
      }
      const selected = conversations.find(item => item.conversationId === selectedConversationId)
        ?? conversations[0]
        ?? null;
      updateConversationPanelForHost(hostId, current => ({
        ...current,
        busy: false,
        conversations,
        archivedOnly,
        selectedConversationId: selected?.conversationId ?? '',
        messages: selected?.conversationId === current.selectedConversationId ? current.messages : [],
        events: selected?.conversationId === current.selectedConversationId ? current.events : [],
        eventCursor: selected?.conversationId === current.selectedConversationId ? current.eventCursor : 0,
        syncError: '',
      }));
      if (selected) await refreshRemoteConversationHistory(selected, controller, hostId);
    } catch (conversationError) {
      updateConversationPanelForHost(hostId, current => ({
        ...current, busy: false, syncError: userFacingError(conversationError),
      }));
    } finally {
      syncHosts();
    }
  };

  const openRemoteConversationPanel = async () => {
    if (!selectedController || !selectedHostId) return;
    if (!status.supportedFeatures?.includes(REMOTE_CONTROL_CONVERSATION_SCOPE)) return;
    const controller = selectedController;
    const hostId = selectedHostId;
    updateConversationPanelForHost(hostId, current => ({
      ...current, open: true, busy: true, available: null, blocker: null, error: '',
    }));
    try {
      const capabilities = await controller.sendConversation('capabilities', {});
      if (!capabilities.ok) {
        throw remoteOperationError(capabilities.error);
      }
      if (!('adapters' in capabilities.result)) throw new Error('지속형 대화 실행기 응답을 확인하지 못했습니다.');
      const codex = capabilities.result.adapters.find(adapter => (
        adapter.adapterId === REMOTE_CONTROL_CONVERSATION_V1_ADAPTER_ID
      ));
      if (!codex || codex.availability !== 'available') {
        updateConversationPanelForHost(hostId, current => ({
          ...current,
          busy: false,
          available: false,
          blocker: 'runtime',
          error: '이 Mac에서 Codex 지속형 대화를 사용할 수 없습니다.',
        }));
        return;
      }
      const models: RemoteControlConversationModel[] = [];
      const visitedModelCursors = new Set<string>();
      let catalogId: string | null = null;
      let cursor: string | null = null;
      for (let page = 0; page < REMOTE_CONVERSATION_PAGE_MAX; page += 1) {
        const response: RemoteControlConversationResult = await controller.sendConversation('models.list', {
          catalogId,
          cursor,
        });
        if (!response.ok) throw remoteOperationError(response.error);
        if (!('models' in response.result)) throw new Error('Codex 대화 모델 목록을 확인하지 못했습니다.');
        if (catalogId !== null && response.result.catalogId !== catalogId) {
          throw new Error('Codex 대화 모델 목록이 확인 중 변경되었습니다.');
        }
        catalogId = response.result.catalogId;
        models.push(...response.result.models);
        if (response.result.nextCursor === null) break;
        if (visitedModelCursors.has(response.result.nextCursor)) {
          throw new Error('Codex 대화 모델 목록 위치가 반복되어 불러오기를 중단했습니다.');
        }
        visitedModelCursors.add(response.result.nextCursor);
        cursor = response.result.nextCursor;
        if (page === REMOTE_CONVERSATION_PAGE_MAX - 1) {
          throw new Error('Codex 대화 모델 목록이 원격 페이지 한도를 초과했습니다.');
        }
      }
      if (new Set(models.map(model => model.modelId)).size !== models.length) {
        throw new Error('Codex 대화 모델 목록에 중복된 모델이 있습니다.');
      }
      updateConversationPanelForHost(hostId, current => ({
        ...current,
        busy: false,
        available: true,
        blocker: null,
        models,
        selectedModelId: current.selectedModelId
          || models.find(model => model.isDefault)?.modelId
          || models[0]?.modelId
          || '',
        selectedControlId: current.selectedControlId
          || controller.status().projects[0]?.controlId
          || '',
        error: '',
      }));
      await refreshRemoteConversationList(controller, hostId);
    } catch (conversationError) {
      updateConversationPanelForHost(hostId, current => ({
        ...current,
        busy: false,
        available: false,
        blocker: remoteFeatureBlocker(
          conversationError,
          'REMOTE_CONTROL_CONVERSATION_SCOPE_REQUIRED',
        ),
        error: userFacingError(conversationError),
      }));
    } finally {
      syncHosts();
    }
  };

  const showRemoteConversationArchive = async (archivedOnly: boolean) => {
    if (!selectedController || !selectedHostId) return;
    const controller = selectedController;
    const hostId = selectedHostId;
    updateConversationPanelForHost(hostId, current => ({
      ...current,
      archivedOnly,
      selectedConversationId: '',
      messages: [],
      historyTruncated: false,
      historyFiltered: false,
      events: [],
      eventCursor: 0,
      prompt: '',
      error: '',
    }));
    await refreshRemoteConversationList(controller, hostId, '', archivedOnly);
  };

  const submitRemoteConversation = async () => {
    if (!selectedController || !selectedHostId) return;
    const controller = selectedController;
    const hostId = selectedHostId;
    const prompt = conversationPanel.prompt.trim();
    if (!prompt || new TextEncoder().encode(prompt).byteLength > 4_096) {
      updateConversationPanel({ error: '대화 내용은 UTF-8 기준 4KB 이하여야 합니다.' });
      return;
    }
    const selected = conversationPanel.conversations.find(item => (
      item.conversationId === conversationPanel.selectedConversationId
    ));
    if (selected && selected.state !== 'idle' && selected.state !== 'running') {
      updateConversationPanel({ error: '상태 확인이 끝난 활성 대화에서만 지시를 보낼 수 있습니다.' });
      return;
    }
    updateConversationPanelForHost(hostId, current => ({ ...current, busy: true, error: '' }));
    try {
      const operation = selected
        ? selected.state === 'running' ? 'steer' as const : 'continue' as const
        : 'start' as const;
      const fingerprint = remoteConversationIntentFingerprint(
        hostId,
        operation,
        selected?.conversationId ?? conversationPanel.selectedControlId,
        selected?.revision ?? 1,
        selected?.modelId ?? conversationPanel.selectedModelId,
        prompt,
      );
      const requestId = await requestIdForRemoteConversationIntent(fingerprint);
      const response = selected
        ? selected.state === 'running' && selected.activeTurnId
          ? await controller.sendConversation('conversations.steer', {
              conversationId: selected.conversationId,
              expectedRevision: selected.revision,
              expectedTurnId: selected.activeTurnId,
              requestId,
              prompt,
            })
          : await controller.sendConversation('conversations.continue', {
              conversationId: selected.conversationId,
              expectedRevision: selected.revision,
              requestId,
              prompt,
            })
        : await controller.sendConversation('conversations.start', {
            controlId: conversationPanel.selectedControlId,
            adapterId: REMOTE_CONTROL_CONVERSATION_V1_ADAPTER_ID,
            modelId: conversationPanel.selectedModelId,
            requestId,
            historyRetentionConsent: AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT,
            prompt,
          });
      if (!response.ok) throw remoteOperationError(response.error);
      if (!('conversation' in response.result)) throw new Error('대화 요청 응답을 확인하지 못했습니다.');
      const accepted = response.result.conversation;
      await clearRemoteConversationIntent(fingerprint, requestId);
      updateConversationPanelForHost(hostId, current => ({
        ...current,
        busy: false,
        prompt: '',
        selectedConversationId: accepted.conversationId,
        pendingPrompts: [
          ...current.pendingPrompts,
          { requestId, conversationId: accepted.conversationId, text: prompt },
        ].slice(-8),
        conversations: [accepted, ...current.conversations.filter(item => (
          item.conversationId !== accepted.conversationId
        ))],
        error: '',
      }));
      if (selectedHostIdRef.current === hostId) {
        setNotice(selected?.state === 'running'
          ? '실행 중인 대화에 추가 지시를 보냈습니다.'
          : 'Codex 대화를 시작했습니다.');
      }
    } catch (conversationError) {
      const mutationError = userFacingError(conversationError);
      updateConversationPanelForHost(hostId, current => ({
        ...current, busy: true, error: mutationError,
      }));
      // A provider may have accepted the mutation before the encrypted reply
      // was lost. Keep the composer locked until the host projects its fresh
      // durable state; refresh never clears the primary mutation error.
      await refreshRemoteConversationList(
        controller,
        hostId,
        selected?.conversationId ?? '',
        conversationPanel.archivedOnly,
      );
    } finally {
      syncHosts();
    }
  };

  const interruptRemoteConversation = async (conversation: RemoteControlConversationSummary) => {
    if (!selectedController || !selectedHostId || !conversation.activeTurnId) return;
    const controller = selectedController;
    const hostId = selectedHostId;
    updateConversationPanelForHost(hostId, current => ({ ...current, busy: true, error: '' }));
    try {
      const fingerprint = remoteConversationIntentFingerprint(
        hostId,
        'interrupt',
        conversation.conversationId,
        conversation.revision,
        conversation.modelId,
        conversation.activeTurnId,
      );
      const requestId = await requestIdForRemoteConversationIntent(fingerprint);
      const response = await controller.sendConversation('conversations.interrupt', {
        conversationId: conversation.conversationId,
        expectedRevision: conversation.revision,
        expectedTurnId: conversation.activeTurnId,
        requestId,
      });
      if (!response.ok) throw remoteOperationError(response.error);
      if (!('conversation' in response.result)) {
        throw new Error('대화 중단 결과를 확인하지 못했습니다.');
      }
      await clearRemoteConversationIntent(fingerprint, requestId);
      await refreshRemoteConversationList(controller, hostId, conversation.conversationId);
    } catch (conversationError) {
      const mutationError = userFacingError(conversationError);
      updateConversationPanelForHost(hostId, current => ({
        ...current, busy: true, error: mutationError,
      }));
      await refreshRemoteConversationList(
        controller,
        hostId,
        conversation.conversationId,
        conversationPanel.archivedOnly,
      );
    } finally {
      syncHosts();
    }
  };

  const archiveRemoteConversation = async (conversation: RemoteControlConversationSummary) => {
    if (!selectedController || !selectedHostId || conversation.state !== 'idle'
      || !window.confirm(`${conversation.projectLabel}\n\n이 지속형 대화를 보관할까요?`)) return;
    const controller = selectedController;
    const hostId = selectedHostId;
    updateConversationPanelForHost(hostId, current => ({ ...current, busy: true, error: '' }));
    try {
      const fingerprint = remoteConversationIntentFingerprint(
        hostId,
        'archive',
        conversation.conversationId,
        conversation.revision,
        conversation.modelId,
        '',
      );
      const requestId = await requestIdForRemoteConversationIntent(fingerprint);
      const response = await controller.sendConversation('conversations.archive', {
        conversationId: conversation.conversationId,
        expectedRevision: conversation.revision,
        requestId,
      });
      if (!response.ok) throw remoteOperationError(response.error);
      if (!('conversation' in response.result) || response.result.conversation.state !== 'archived') {
        throw new Error('대화 보관 결과를 확인하지 못했습니다.');
      }
      await clearRemoteConversationIntent(fingerprint, requestId);
      updateConversationPanelForHost(hostId, current => ({
        ...current,
        busy: false,
        selectedConversationId: '',
        messages: [],
        historyTruncated: false,
        historyFiltered: false,
        pendingPrompts: current.pendingPrompts.filter(prompt => (
          prompt.conversationId !== conversation.conversationId
        )),
        events: [],
        eventCursor: 0,
        conversations: current.conversations.filter(item => (
          item.conversationId !== conversation.conversationId
        )),
        error: '',
      }));
      if (selectedHostIdRef.current === hostId) {
        setNotice('지속형 대화를 보관했습니다. 모바일의 보관됨 목록에서도 다시 열 수 있습니다.');
      }
    } catch (conversationError) {
      const mutationError = userFacingError(conversationError);
      updateConversationPanelForHost(hostId, current => ({
        ...current, busy: true, error: mutationError,
      }));
      await refreshRemoteConversationList(
        controller,
        hostId,
        conversation.conversationId,
        conversationPanel.archivedOnly,
      );
    } finally {
      syncHosts();
    }
  };

  const unarchiveRemoteConversation = async (conversation: RemoteControlConversationSummary) => {
    if (!selectedController || !selectedHostId || conversation.state !== 'archived') return;
    const controller = selectedController;
    const hostId = selectedHostId;
    updateConversationPanelForHost(hostId, current => ({ ...current, busy: true, error: '' }));
    try {
      const fingerprint = remoteConversationIntentFingerprint(
        hostId,
        'unarchive',
        conversation.conversationId,
        conversation.revision,
        conversation.modelId,
        '',
      );
      const requestId = await requestIdForRemoteConversationIntent(fingerprint);
      const response = await controller.sendConversation('conversations.unarchive', {
        conversationId: conversation.conversationId,
        expectedRevision: conversation.revision,
        requestId,
      });
      if (!response.ok) throw remoteOperationError(response.error);
      if (!('conversation' in response.result) || response.result.conversation.state === 'archived') {
        throw new Error('대화 복원 결과를 확인하지 못했습니다.');
      }
      await clearRemoteConversationIntent(fingerprint, requestId);
      updateConversationPanelForHost(hostId, current => ({
        ...current,
        busy: false,
        selectedConversationId: '',
        messages: [],
        historyTruncated: false,
        historyFiltered: false,
        pendingPrompts: current.pendingPrompts.filter(prompt => (
          prompt.conversationId !== conversation.conversationId
        )),
        events: [],
        eventCursor: 0,
        conversations: current.conversations.filter(item => (
          item.conversationId !== conversation.conversationId
        )),
        error: '',
      }));
      if (selectedHostIdRef.current === hostId) {
        setNotice('지속형 대화를 활성 목록으로 복원했습니다.');
      }
    } catch (conversationError) {
      const mutationError = userFacingError(conversationError);
      updateConversationPanelForHost(hostId, current => ({
        ...current, busy: true, error: mutationError,
      }));
      await refreshRemoteConversationList(
        controller,
        hostId,
        conversation.conversationId,
        conversationPanel.archivedOnly,
      );
    } finally {
      syncHosts();
    }
  };

  const refreshRemoteTaskList = async (
    controller = selectedController,
    hostId = selectedHostId,
    selectedTaskId = taskPanel.selectedTaskId,
  ) => {
    if (!controller || !hostId) return;
    updateTaskPanelForHost(hostId, current => ({ ...current, busy: true, error: '' }));
    try {
      const listed = await controller.sendTask('tasks.list', { cursor: null });
      if (!listed.ok) throw remoteOperationError(listed.error);
      if (!('tasks' in listed.result)) throw new Error('작업 목록 응답을 확인하지 못했습니다.');
      const taskPage = listed.result as RemoteControlTaskListResult;
      const nextSelected = taskPage.tasks.some(task => task.taskId === selectedTaskId)
        ? selectedTaskId
        : taskPage.tasks[0]?.taskId ?? '';
      updateTaskPanelForHost(hostId, current => ({
        ...current,
        busy: false,
        tasks: taskPage.tasks,
        selectedTaskId: nextSelected,
        events: nextSelected === current.selectedTaskId ? current.events : [],
        error: '',
      }));
    } catch (taskError) {
      updateTaskPanelForHost(hostId, current => ({
        ...current,
        busy: false,
        error: userFacingError(taskError),
      }));
    } finally {
      syncHosts();
    }
  };

  const readRemoteTaskEventWindow = async (
    controller: RemoteControlRelayController,
    taskId: string,
    lastSeq: number,
    requestedAfter?: number,
  ): Promise<RemoteControlTaskEvent[]> => {
    if (lastSeq <= 0) return [];
    let after = requestedAfter ?? Math.max(0, lastSeq - REMOTE_TASK_TIMELINE_EVENT_LIMIT);
    if (after > lastSeq) after = Math.max(0, lastSeq - REMOTE_TASK_TIMELINE_EVENT_LIMIT);
    const events: RemoteControlTaskEvent[] = [];
    const visited = new Set<number>();
    for (let page = 0; page < REMOTE_TASK_TIMELINE_EVENT_LIMIT && after < lastSeq; page += 1) {
      if (visited.has(after)) throw new Error('작업 진행 기록 위치가 반복되어 자동 확인을 중단했습니다.');
      visited.add(after);
      const response = await controller.sendTask('tasks.events', { taskId, after });
      if (!response.ok) throw remoteOperationError(response.error);
      if (!('events' in response.result)) throw new Error('작업 진행 기록을 확인하지 못했습니다.');
      const eventPage = response.result as RemoteControlTaskEventsResult;
      events.push(...eventPage.events);
      if (eventPage.nextCursor <= after) break;
      after = eventPage.nextCursor;
    }
    if (after < lastSeq) {
      throw new Error('최근 작업 진행 기록이 너무 커 일부를 불러오지 못했습니다. 다시 새로고침해 주세요.');
    }
    return events.slice(-REMOTE_TASK_TIMELINE_EVENT_LIMIT);
  };

  const openRemoteTaskPanel = async () => {
    if (!selectedController || !selectedHostId) return;
    if (!status.supportedFeatures?.includes(REMOTE_CONTROL_TASK_SCOPE)) return;
    const controller = selectedController;
    const hostId = selectedHostId;
    updateTaskPanelForHost(hostId, current => ({
      ...current, open: true, busy: true, available: null, blocker: null, error: '',
    }));
    try {
      const capabilities = await controller.sendTask('capabilities', {});
      if (!capabilities.ok) throw remoteOperationError(capabilities.error);
      if (!('adapters' in capabilities.result)) throw new Error('Codex 실행기 응답을 확인하지 못했습니다.');
      const codex = capabilities.result.adapters.find(adapter => adapter.adapterId === 'codex');
      if (!codex || codex.availability !== 'available') {
        updateTaskPanelForHost(hostId, current => ({
          ...current,
          busy: false,
          available: false,
          blocker: 'runtime',
          error: '이 Mac에서 Codex 런타임을 사용할 수 없습니다.',
        }));
        return;
      }
      const firstModels = await controller.sendTask('models.list', {
        adapterId: 'codex',
        catalogId: null,
        cursor: null,
      });
      if (!firstModels.ok) throw remoteOperationError(firstModels.error);
      if (!('models' in firstModels.result)) throw new Error('Codex 모델 목록을 확인하지 못했습니다.');
      const firstPage = firstModels.result as RemoteControlTaskModelsResult;
      const modelPages = [firstPage];
      const visitedModelCursors = new Set<string>();
      let nextModelCursor = firstPage.nextCursor;
      while (nextModelCursor !== null) {
        if (modelPages.length >= REMOTE_TASK_MODEL_PAGE_MAX
          || visitedModelCursors.has(nextModelCursor)) {
          throw new Error('Codex 모델 목록 페이지를 안전하게 완료하지 못했습니다.');
        }
        visitedModelCursors.add(nextModelCursor);
        const nextModels = await controller.sendTask('models.list', {
          adapterId: 'codex',
          catalogId: firstPage.catalogId,
          cursor: nextModelCursor,
        });
        if (!nextModels.ok) throw remoteOperationError(nextModels.error);
        if (!('models' in nextModels.result)) throw new Error('Codex 모델 목록을 확인하지 못했습니다.');
        const nextPage = nextModels.result as RemoteControlTaskModelsResult;
        if (nextPage.adapterId !== 'codex' || nextPage.catalogId !== firstPage.catalogId) {
          throw new Error('Codex 모델 목록이 확인 중 변경되었습니다.');
        }
        modelPages.push(nextPage);
        nextModelCursor = nextPage.nextCursor;
      }
      const modelPage = {
        models: modelPages.flatMap(page => page.models),
      };
      if (new Set(modelPage.models.map(model => model.modelId)).size !== modelPage.models.length
        || modelPage.models.length > REMOTE_CONTROL_TASK_MODEL_PAGE_LIMIT * REMOTE_TASK_MODEL_PAGE_MAX) {
        throw new Error('Codex 모델 목록이 중복되거나 허용 범위를 초과했습니다.');
      }
      updateTaskPanelForHost(hostId, current => ({
        ...current,
        busy: false,
        available: true,
        blocker: null,
        models: modelPage.models,
        selectedModelId: current.selectedModelId
          || modelPage.models.find(model => model.isDefault)?.modelId
          || modelPage.models[0]?.modelId
          || '',
        selectedControlId: current.selectedControlId
          || controller.status().projects[0]?.controlId
          || '',
        error: '',
      }));
      await refreshRemoteTaskList(controller, hostId);
    } catch (taskError) {
      updateTaskPanelForHost(hostId, current => ({
        ...current,
        busy: false,
        available: false,
        blocker: remoteFeatureBlocker(taskError, 'REMOTE_CONTROL_TASK_SCOPE_REQUIRED'),
        error: userFacingError(taskError),
      }));
    } finally {
      syncHosts();
    }
  };

  const loadRemoteTaskEvents = async (
    taskId: string,
    controller = selectedController,
    hostId = selectedHostId,
  ) => {
    if (!controller || !hostId || !taskId) return;
    updateTaskPanelForHost(hostId, current => ({
      ...current, selectedTaskId: taskId, busy: true, error: '',
    }));
    try {
      const lastSeq = taskPanelsByHostRef.current.get(hostId)?.tasks
        .find(task => task.taskId === taskId)?.lastSeq ?? 0;
      const events = await readRemoteTaskEventWindow(controller, taskId, lastSeq);
      updateTaskPanelForHost(hostId, current => ({
        ...current, busy: false, selectedTaskId: taskId, events, error: '',
      }));
    } catch (taskError) {
      updateTaskPanelForHost(hostId, current => ({
        ...current, busy: false, error: userFacingError(taskError),
      }));
    } finally {
      syncHosts();
    }
  };

  const startRemoteTask = async () => {
    if (!selectedController || !selectedHostId) return;
    const controller = selectedController;
    const hostId = selectedHostId;
    const prompt = taskPanel.prompt.trim();
    if (!taskPanel.selectedControlId || !taskPanel.selectedModelId || !prompt) {
      updateTaskPanel({ error: '프로젝트·모델·작업 내용을 모두 선택하거나 입력하세요.' });
      return;
    }
    if (new TextEncoder().encode(prompt).byteLength > 4_096) {
      updateTaskPanel({ error: '모바일 원격 작업 내용은 UTF-8 기준 4KB 이하여야 합니다.' });
      return;
    }
    const project = status.projects.find(candidate => candidate.controlId === taskPanel.selectedControlId);
    if (!project || !window.confirm(`${status.hostName ?? '연결된 Mac'} · ${project.name}\n\nCodex가 이 프로젝트에서 workspace-write 모드로 작업을 시작할까요?`)) return;
    updateTaskPanelForHost(hostId, current => ({ ...current, busy: true, error: '' }));
    try {
      const started = await controller.sendTask('tasks.start', {
        controlId: taskPanel.selectedControlId,
        adapterId: 'codex',
        modelId: taskPanel.selectedModelId,
        requestId: crypto.randomUUID(),
        prompt,
      });
      if (!started.ok) throw remoteOperationError(started.error);
      if (!('duplicate' in started.result)) throw new Error('작업 시작 응답을 확인하지 못했습니다.');
      const startResult = started.result as RemoteControlTaskStartResult;
      updateTaskPanelForHost(hostId, current => ({
        ...current,
        busy: false,
        prompt: '',
        selectedTaskId: startResult.task.taskId,
        tasks: [
          startResult.task,
          ...current.tasks.filter(task => task.taskId !== startResult.task.taskId),
        ],
        events: [],
        error: '',
      }));
      if (selectedHostIdRef.current === hostId) {
        setNotice(`${project.name}에서 Codex 작업을 시작했습니다.`);
      }
      await loadRemoteTaskEvents(startResult.task.taskId, controller, hostId);
    } catch (taskError) {
      updateTaskPanelForHost(hostId, current => ({
        ...current, busy: false, error: userFacingError(taskError),
      }));
    } finally {
      syncHosts();
    }
  };

  const cancelRemoteTask = async (task: RemoteControlTaskSummary) => {
    if (!selectedController || !selectedHostId
      || !window.confirm(`${task.projectLabel}\n\n실행 중인 Codex 작업을 취소할까요?`)) return;
    const controller = selectedController;
    const hostId = selectedHostId;
    updateTaskPanelForHost(hostId, current => ({ ...current, busy: true, error: '' }));
    try {
      const cancelled = await controller.sendTask('tasks.cancel', {
        taskId: task.taskId,
        requestId: crypto.randomUUID(),
      });
      if (!cancelled.ok) throw remoteOperationError(cancelled.error);
      if (!('task' in cancelled.result)) throw new Error('작업 취소 응답을 확인하지 못했습니다.');
      const cancelResult = cancelled.result as RemoteControlTaskCancelResult;
      updateTaskPanelForHost(hostId, current => ({
        ...current,
        busy: false,
        tasks: current.tasks.map(candidate => (
          candidate.taskId === task.taskId ? cancelResult.task : candidate
        )),
        error: '',
      }));
      await loadRemoteTaskEvents(task.taskId, controller, hostId);
    } catch (taskError) {
      updateTaskPanelForHost(hostId, current => ({
        ...current, busy: false, error: userFacingError(taskError),
      }));
    } finally {
      syncHosts();
    }
  };

  const selectedTaskStatus = taskPanel.tasks.find(
    task => task.taskId === taskPanel.selectedTaskId,
  )?.status ?? null;
  const selectedConversation = conversationPanel.conversations.find(conversation => (
    conversation.conversationId === conversationPanel.selectedConversationId
  )) ?? null;
  const visibleRemoteConversations = conversationPanel.conversations.filter(conversation => (
    matchesAgentRuntimeConversationSearch(conversation, conversationPanel.query)
  ));
  const selectedPendingPrompts = selectedConversation
    ? conversationPanel.pendingPrompts.filter(prompt => (
        prompt.conversationId === selectedConversation.conversationId
      ))
    : [];
  useEffect(() => {
    const controller = selectedController;
    const hostId = selectedHostId;
    const taskId = taskPanel.selectedTaskId;
    if (!taskPanel.open || !controller || !hostId || !taskId
      || !selectedTaskStatus || !remoteTaskIsActive(selectedTaskStatus)
      || status.state !== 'online') return;
    let cancelled = false;
    let halted = false;
    let inFlight = false;
    const refreshActiveTask = async () => {
      if (cancelled || halted || inFlight || document.hidden || controller.status().busy) return;
      inFlight = true;
      try {
        const listed = await controller.sendTask('tasks.list', { cursor: null });
        if (!listed.ok) throw remoteOperationError(listed.error);
        if (!('tasks' in listed.result)) throw new Error('작업 목록 응답을 확인하지 못했습니다.');
        const taskPage = listed.result as RemoteControlTaskListResult;
        if (cancelled) return;
        const trackedTask = taskPage.tasks.find(task => task.taskId === taskId);
        if (!trackedTask) {
          updateTaskPanelForHost(hostId, current => ({
            ...current,
            tasks: taskPage.tasks,
            error: '',
          }));
          return;
        }

        const existingEvents = taskPanelsByHostRef.current.get(hostId)?.selectedTaskId === taskId
          ? taskPanelsByHostRef.current.get(hostId)?.events ?? []
          : [];
        const lastLoadedSeq = existingEvents.at(-1)?.seq;
        const nextEvents = await readRemoteTaskEventWindow(
          controller,
          taskId,
          trackedTask.lastSeq,
          lastLoadedSeq,
        );
        if (cancelled) return;
        const mergedEvents = [
          ...existingEvents,
          ...nextEvents.filter(event => !existingEvents.some(existing => existing.seq === event.seq)),
        ].slice(-REMOTE_TASK_TIMELINE_EVENT_LIMIT);
        updateTaskPanelForHost(hostId, current => ({
          ...current,
          tasks: taskPage.tasks,
          events: current.selectedTaskId === taskId ? mergedEvents : current.events,
          error: '',
        }));
      } catch (taskError) {
        if (cancelled) return;
        // Keep the local task running. Repeated retries after a network or
        // restart ambiguity could duplicate traffic, so one failure pauses
        // only automatic tracking; the explicit refresh button remains.
        halted = true;
        updateTaskPanelForHost(hostId, current => ({
          ...current,
          error: `자동 진행 확인을 멈췄습니다. 상태 새로고침으로 다시 확인하세요. ${userFacingError(taskError)}`,
        }));
      } finally {
        inFlight = false;
        if (!cancelled) syncHosts();
      }
    };
    const timer = window.setInterval(() => { void refreshActiveTask(); }, REMOTE_TASK_ACTIVE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedController, selectedHostId, selectedTaskStatus, status.state, taskPanel.open, taskPanel.selectedTaskId]);

  useEffect(() => {
    if (!conversationPanel.open || !selectedConversation
      || selectedConversation.state !== 'running'
      || !selectedController || !selectedHostId || status.state !== 'online') return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (cancelled || document.hidden || selectedController.status().busy) return;
      void refreshRemoteConversationList(
        selectedController,
        selectedHostId,
        selectedConversation.conversationId,
      );
    }, REMOTE_TASK_ACTIVE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    conversationPanel.open,
    selectedConversation?.conversationId,
    selectedConversation?.state,
    selectedController,
    selectedHostId,
    status.state,
  ]);

  const openProjectCreator = async () => {
    if (!selectedController || !selectedHostId) return;
    const controller = selectedController;
    const hostId = selectedHostId;
    setCreateProjectOpen(true);
    setError('');
    try {
      await controller.sendAction('workspace-roots.list');
      const next = controller.status();
      syncHosts();
      if (selectedHostIdRef.current === hostId) {
        setWorkspaceRootId(current => current || next.workspaceRoots[0]?.controlId || '');
      }
    } catch (rootError) {
      if (selectedHostIdRef.current === hostId) reportTapError(rootError);
    }
  };

  const changeProjectCreateDraft = (field: 'name' | 'root', value: string) => {
    if (selectedController && projectName.trim() && workspaceRootId) {
      try { createProjectCreationIntentStore(window.localStorage, () => crypto.randomUUID()).discardChangedInput({
        ...selectedController.projectCreationIdentity(), workspaceRootId, projectName: projectName.trim(),
      }); } catch (error) { reportError(error); return; }
    }
    if (field === 'name') setProjectName(value); else setWorkspaceRootId(value);
  };

  const createProject = async () => {
    const name = projectName.trim();
    const root = status.workspaceRoots.find(candidate => candidate.controlId === workspaceRootId);
    if (!selectedController || !selectedHostId || !name || !root) {
      setError('프로젝트 이름과 이 Mac의 작업 루트를 선택하세요.');
      return;
    }
    const controller = selectedController;
    const hostId = selectedHostId;
    if (!window.confirm(`${status.hostName ?? '연결된 Mac'}\n작업 루트 ‘${root.name}’\n\n‘${name}’ 프로젝트를 만들고 Git·장기기억을 초기화할까요?`)) return;
    setError('');
    setNotice('');
    try {
      const intents = createProjectCreationIntentStore(window.localStorage, () => crypto.randomUUID());
      const intent = intents.reserve({...controller.projectCreationIdentity(), workspaceRootId: root.controlId, projectName: name});
      const result = await controller.sendAction('project.create', undefined, undefined, name, root.controlId, intent.actionId);
      if (!result?.ok || !('project' in result) || !result.project) throw new Error('프로젝트 생성 결과를 아직 확인하지 못했습니다. 같은 이름과 작업 루트로 다시 확인하세요.');
      try { intents.complete(intent, result.actionId); } catch { setError('프로젝트는 생성됐지만 브라우저 요청 기록을 정리하지 못했습니다. 이 프로젝트 카드에서 작업을 이어가세요.'); }
      if (selectedHostIdRef.current === hostId && result?.ok && 'project' in result && result.project) {
        setTerminalEntry({nonce:Date.now(),targetId:result.project.controlId});
        setQuery(result.project.name);
        setWorkspaceRootFilter('');
        setWorkspaceTab('projects');
      }
      syncHosts();
      if (selectedHostIdRef.current === hostId) {
        setProjectName('');
        setCreateProjectOpen(false);
        setNotice(`${name} 프로젝트를 만들고 이 Mac의 AgentsToZ에 등록했습니다. 워크룸에서 작업하거나 Mac의 Codex 앱에서 열 수 있습니다.`);
      }
    } catch (createError) {
      if (selectedHostIdRef.current === hostId) reportTapError(createError, '프로젝트 만들기');
    }
  };

  // `automatic` — the one-time read below, which nobody pressed: it must not wipe a message the user is reading
  // (review 2026-10-10: it fired the moment a held request finished and erased that request's outcome).
  const readOpsStatus = async (automatic = false) => {
    if (!selectedController || !selectedHostId) return;
    const controller = selectedController;
    const hostId = selectedHostId;
    if (!automatic) setError('');
    try {
      const result = await controller.sendAction('ops.status');
      if (!result?.ok || !('ops' in result)) throw new Error('OPS 운영기억 상태를 확인하지 못했습니다.');
      opsStatusByHostRef.current.set(hostId, result.ops);
      if (selectedHostIdRef.current === hostId) setOpsStatus(result.ops);
      syncHosts();
    } catch (opsError) {
      if (selectedHostIdRef.current === hostId) reportError(opsError);
    }
  };

  // The status line is a cheap read; show it without a button press, once per connected host.
  const opsStatusRequestedRef = useRef(new Set<string>());
  useEffect(() => {
    if (!selectedHostId || !selectedController || status.state !== 'online' || opsStatus) return;
    if (opsStatusRequestedRef.current.has(selectedHostId)) return;
    opsStatusRequestedRef.current.add(selectedHostId);
    const controller = selectedController, hostId = selectedHostId;
    let timer = 0, stopped = false;
    // Connecting also loads the project list; wait until the controller is free, a few times.
    const attempt = (left: number) => {
      if (stopped) return;
      if (!controller.status().busy) { void readOpsStatus(true); return; }
      if (left > 0) timer = window.setTimeout(() => attempt(left - 1), 2000);
      else opsStatusRequestedRef.current.delete(hostId);
    };
    timer = window.setTimeout(() => attempt(8), 2500);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [selectedHostId, selectedController, status.state, opsStatus]);

  const openOps = async () => {
    const isOps=(candidate:QrRemoteControlProjectCard)=>candidate.kind==='main'&&candidate.role==='ops';
    let project=status.projects.find(isOps);
    // The OPS card can sit on a page that has not been fetched yet. Load the rest before
    // concluding it is missing — "새로고침해 주세요" never fetched later pages.
    if(!project&&selectedController&&selectedController.status().nextPage!==null){
      await loadAllProjects();
      project=selectedController.status().projects.find(isOps);
    }
    if(!project){
      const loaded=selectedController?.status()??status;
      // Refreshing cannot fix this: the Mac did not offer OPS at all. The 2026-09-27 case was a
      // reset Mac device identity (its name turned into an automatic numbered name), which hid 137 of 139 projects.
      setError(`이 Mac이 원격으로 열어 주는 프로젝트 ${loaded.projects.length}개 중에 AgentsToZ OPS 운영 프로젝트가 없습니다. 새로고침으로는 해결되지 않습니다 — Mac 앱에서 OPS 운영 폴더가 등록돼 있는지 확인해 주세요. Mac 이름이 숫자 코드로 된 자동 이름으로 바뀌었다면 Mac의 기기 정보가 초기화된 것입니다.`);
      return;
    }
    // No notice: it outlived the switch, so after picking another project the page still
    // announced the OPS workroom. The workroom's own project selector names the target.
    setError('');setNotice('');openProjectWorkroom(project);
  };

  const readOpsCandidates = async () => {
    if (!selectedController || !selectedHostId) return;
    const controller=selectedController,hostId=selectedHostId;setError('');
    try{
      const result=await controller.sendAction('ops.memory.pending');
      if(!result?.ok||!('opsCandidates' in result))throw new Error('OPS 운영기억 저장 후보를 확인하지 못했습니다.');
      opsCandidatesByHostRef.current.set(hostId,result.opsCandidates);
      if(selectedHostIdRef.current===hostId)setOpsCandidates(result.opsCandidates);
    }catch(candidateError){if(selectedHostIdRef.current===hostId)reportError(candidateError);}
  };

  const reviewOpsCandidate = async (candidateId:string,accept:boolean) => {
    if(!selectedController||!selectedHostId||!opsCandidates)return;
    const controller=selectedController,hostId=selectedHostId,verb=accept?'저장':'거절';
    if(!window.confirm(`이 후보를 ${verb}할까요?\n\n공유 OPS 기억 문서에 대한 사람의 검토 결과로 기록됩니다.`))return;
    setError('');
    try{
      const result=await controller.sendAction('ops.memory.review',undefined,undefined,undefined,undefined,undefined,{candidateId,expectedRevision:opsCandidates.revision,accept});
      if(!result?.ok||!('ops' in result))throw new Error('OPS 운영기억 검토 결과를 확인하지 못했습니다.');
      opsStatusByHostRef.current.set(hostId,result.ops);
      if(selectedHostIdRef.current===hostId){setOpsStatus(result.ops);setNotice(`OPS 운영기억 후보를 ${verb}했습니다.`);await readOpsCandidates();}
      syncHosts();
    }catch(reviewError){if(selectedHostIdRef.current===hostId)reportTapError(reviewError,`OPS 운영기억 ${verb}`);}
  };

  /**
   * Disconnects exactly one Mac. The others keep their approved sessions, so
   * this is also the per-chip remove control — a phone that has met several
   * Macs must be able to drop the one it no longer uses without re-pairing the
   * rest.
   */
  const disconnectHost = async (hostId: string | null, confirmFirst = hosts.length > 1) => {
    if (!hostId) return true;
    const target = hosts.find(host => host.hostId === hostId);
    if (confirmFirst && !window.confirm(
      `${target ? hostLabel(target) : '이 Mac'}\n\n이 Mac 연결만 해제할까요? 다른 Mac 연결은 그대로 유지됩니다.`,
    )) return false;
    setError('');
    setNotice('');
    try {
      const controller=manager.controller(hostId);
      if(!controller)return false;
      await controller.revoke();
      return true;
    } catch (revokeError) {
      reportError(revokeError);
      return false;
    } finally {
      // A relay that refuses the revoke must not leave the Mac in the switcher
      // as if it were still paired; the local keys are already gone.
      manager.forget(hostId);
      await sessionVaultRef.current?.clearHost(hostId).catch(() => undefined);
      await vaultRef.current?.clearHost(hostId).catch(() => undefined);
      loadedPageCountsByHostRef.current.delete(hostId);
      searchSweptHostsRef.current.delete(hostId);
      workspaceRootsRequestedHostsRef.current.delete(hostId);
      taskPanelsByHostRef.current.delete(hostId);
      conversationPanelsByHostRef.current.delete(hostId);
      opsStatusByHostRef.current.delete(hostId);
      opsCandidatesByHostRef.current.delete(hostId);
      setSources(current => current.filter(source => source.hostId !== hostId));
      syncHosts();
    }
  };

  // Fixed native bridge: it can only revoke the selected existing controller.
  // A failed relay acknowledgement is not reported as a confirmed remote revoke.
  useEffect(()=>{
    if(!nativePortalOAuthAvailable())return;
    let pending:Promise<boolean>|null=null;
    const disconnect=()=>pending??(pending=disconnectHost(selectedHostId,false));
    window.agentstozDisconnect=disconnect;
    return()=>{if(window.agentstozDisconnect===disconnect)delete window.agentstozDisconnect;};
  },[selectedHostId,hosts]);

  /**
   * Re-fetch what the user is actually looking at. A page-0 result REPLACES the
   * controller's accumulated list, so refreshing after paging used to collapse
   * a long list back to the first 20 cards — the refresh looked like it had
   * lost projects. Re-request every page that was already loaded instead.
   */
  const manualRefresh = async () => {
    if (!selectedController || !selectedHostId) return;
    const controller = selectedController;
    const hostId = selectedHostId;
    setError('');
    setRefreshing(true);
    try {
      if (controller.status().state !== 'online') {
        await controller.refresh();
        syncHosts();
        return;
      }
      await controller.probeSupportedFeatures(true);
      syncHosts();
      // Pages are byte-bounded, so their size varies — count what was actually
      // loaded rather than dividing by a page size that no longer holds.
      const loadedPages = loadedPageDepthForHost(
        loadedPageCountsByHostRef.current,
        hostId,
      );
      // At least the first page: a connection that never received its list (restored while the
      // Mac was still coming back) has zero loaded pages, and refreshing zero pages did nothing.
      for (let page = 0; page < Math.max(1, loadedPages); page += 1) {
        await controller.sendAction('projects.list', undefined, page);
        syncHosts();
        if (controller.status().nextPage === null) break;
      }
    } catch (refreshError) {
      if (selectedHostIdRef.current === hostId) reportError(refreshError);
    } finally {
      setRefreshing(false);
      syncHosts();
    }
  };

  /**
   * Reload the page itself, bypassing the cached bundle.
   *
   * The Mac app and this portal are deployed separately, so a phone holding an
   * old bundle after a protocol bump sees "지원하지 않는 원격 제어 버전" and has no
   * in-app way out — the instruction was "refresh the page", which is not a
   * thing this screen offered. Sealed sessions live in IndexedDB and survive a
   * reload, so this reconnects rather than starting over.
   */
  const reloadApp = async () => {
    try {
      if (typeof caches !== 'undefined') {
        const keys = await caches.keys();
        await Promise.all(keys.map(key => caches.delete(key)));
      }
    } catch {
      // A blocked cache API must not stop the reload — that is the whole point.
    }
    window.location.reload();
  };

  const loadingMoreProjects = useRef(false);
  // The end-of-list observer can fire several times while one page is on its way; one request at a time.
  const loadMoreProjectsOnce = useCallback(() => {
    if (loadingMoreProjects.current) return;
    loadingMoreProjects.current = true;
    void loadMoreProjects().finally(() => { loadingMoreProjects.current = false; });
  }, [selectedController, selectedHostId, status.nextPage]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadMoreProjects = async () => {
    if (!selectedController || !selectedHostId || status.nextPage === null) return;
    const controller = selectedController;
    const hostId = selectedHostId;
    const nextPage = status.nextPage;
    setError('');
    try {
      await controller.sendAction('projects.list', undefined, nextPage);
      rememberLoadedPageDepth(
        loadedPageCountsByHostRef.current,
        hostId,
        nextPage + 1,
      );
      syncHosts();
    } catch (loadError) {
      if (selectedHostIdRef.current === hostId) reportError(loadError);
    }
  };

  /**
   * The search box filters only what has been loaded, so on a Mac with a
   * hundred registered projects a search for a real project or worktree
   * answered "검색 결과가 없습니다" — the card simply had not been fetched yet.
   * Measured on this Mac: the AgentsToZ_byCS card is #91 of 95, i.e. page 4 of
   * a 20-per-page list, so typing its name found nothing at all. The effect
   * below pulls the remaining pages the first time a query is entered; this
   * function is also the manual escape hatch if that sweep fails.
   */
  const loadAllProjects = async () => {
    if (!selectedController) return;
    const sweepingController = selectedController;
    const sweepingHostId = selectedHostId;
    setLoadingAll(true);
    setError('');
    try {
      let previousPage = -1;
      for (let guard = 0; guard <= REMOTE_CONTROL_PORTAL_MAX_PAGE; guard += 1) {
        const next = progressingRemoteControlPage(
          previousPage,
          sweepingController.status().nextPage,
        );
        if (next === null) return;
        await sweepingController.sendAction('projects.list', undefined, next);
        rememberLoadedPageDepth(
          loadedPageCountsByHostRef.current,
          sweepingHostId,
          next + 1,
        );
        previousPage = next;
        syncHosts();
      }
      if (sweepingController.status().nextPage !== null) {
        throw new Error('프로젝트 목록이 프로토콜 페이지 한도를 초과했습니다. Mac 앱을 업데이트한 뒤 다시 시도하세요.');
      }
    } catch (loadError) {
      if (selectedHostIdRef.current === sweepingHostId) reportTapError(loadError);
    } finally {
      setLoadingAll(false);
      syncHosts();
    }
  };

  // Searching must search the whole list, not the first page. Fires once per
  // host when a query first appears; `loadingAll` and the nextPage check keep it
  // from re-running on every keystroke, and the manual button remains for retry.
  useEffect(() => {
    if ((!query.trim() && !workspaceRootFilter) || !selectedHostId) return;
    if (status.nextPage === null || status.busy || loadingAll) return;
    if (searchSweptHostsRef.current.has(selectedHostId)) return;
    searchSweptHostsRef.current.add(selectedHostId);
    void loadAllProjects();
  }, [query, workspaceRootFilter, selectedHostId, status.nextPage, status.busy, loadingAll]);

  // The workroom's session list names each Mac session by its project. The host
  // lists sessions of every permitted project, but only loaded pages have names
  // (and are selectable as a start or @/# target), so a session of a project on
  // page 4 showed up as a bare "프로젝트 · codex". Load the rest once per host.
  useEffect(() => {
    if (workspaceTab !== 'workroom' || remotePane !== 'workroom' || !terminalOpen || !selectedHostId) return;
    if (status.state !== 'online' || status.nextPage === null || status.busy || loadingAll) return;
    if (searchSweptHostsRef.current.has(selectedHostId)) return;
    searchSweptHostsRef.current.add(selectedHostId);
    void loadAllProjects();
  }, [workspaceTab, remotePane, terminalOpen, selectedHostId, status.state, status.nextPage, status.busy, loadingAll]);

  // A restored connection asks for its first project page only if it is already online. After
  // the Mac restarts it is briefly not, so the list was never requested and the page said
  // "등록 프로젝트가 없습니다" until the app was reinstalled. Ask once whenever this host is
  // online with nothing loaded; `busy` and the per-host guard keep it to one request.
  const initialListRequestedRef = useRef(new Set<string>());
  useEffect(() => {
    if (!selectedHostId || !selectedController || status.state !== 'online') return;
    if (status.projects.length > 0 || status.projectCount > 0) return;
    if (initialListRequestedRef.current.has(selectedHostId)) return;
    initialListRequestedRef.current.add(selectedHostId);
    const controller = selectedController, hostId = selectedHostId;
    let stopped = false, timer = 0;
    // The restore path asks by itself when it is online at once, and the 1s poll holds `busy`
    // briefly; wait for a quiet moment, then ask only if the list is still empty.
    const attempt = async (left: number) => {
      if (stopped) return;
      const now = controller.status();
      if (now.state !== 'online' || now.projects.length > 0 || now.projectCount > 0) return;
      if (now.busy) { if (left > 0) timer = window.setTimeout(() => void attempt(left - 1), 1500); return; }
      try {
        if (now.supportedFeatures === null) await controller.probeSupportedFeatures();
        if (!controller.status().busy) await controller.sendAction('projects.list', undefined, 0);
      } catch (listError) {
        if (errorToken(listError).includes('REMOTE_CONTROL_ACTION_IN_PROGRESS')) {
          if (left > 0 && !stopped) timer = window.setTimeout(() => void attempt(left - 1), 1500);
        } else {
          initialListRequestedRef.current.delete(hostId);
          if (selectedHostIdRef.current === hostId) reportError(listError);
        }
      } finally {
        syncHosts();
      }
    };
    timer = window.setTimeout(() => void attempt(10), 1500);
    return () => { stopped = true; window.clearTimeout(timer); initialListRequestedRef.current.delete(hostId); };
  }, [selectedHostId, selectedController, status.state, status.projects.length, status.projectCount]);

  // Root names are a tiny, path-free registry separate from paged projects.
  // Fetch them once so a root can be selected even when none of its projects
  // happen to be on the first project page.
  useEffect(() => {
    if (!selectedHostId || !selectedController || status.state !== 'online' || status.busy) return;
    if (workspaceRootsRequestedHostsRef.current.has(selectedHostId)) return;
    workspaceRootsRequestedHostsRef.current.add(selectedHostId);
    void selectedController.sendAction('workspace-roots.list')
      .then(() => syncHosts())
      .catch(() => undefined);
  }, [selectedHostId, selectedController, status.state, status.busy]);

  const waiting = !bootstrapChecked || authState === 'checking' || status.state === 'claiming';
  const missingPairing = bootstrapChecked && sources.length === 0 && hosts.length === 0;

  const catalogVisible = workspaceTab === 'bookmarks' || (workspaceTab === 'records' && recordMode==='memories') || workspaceTab === 'projects';
  const acceptPairing = async (pairingUrl: string) => {
    const parsed = parseRemoteControlRelayPairingUrl(pairingUrl);
    // A 「폰 연결 링크」 pinned this app page to one Supabase project; a QR for another project wins,
    // but only the app's own scanner can switch — refuse here with how, rather than fail later.
    const mismatch = PORTAL_IS_BUNDLED ? bundledQrSupabaseMismatch(parsed.bootstrap.supabase?.url, PORTAL_SUPABASE_URL) : null;
    if (mismatch) throw new PortalRemoteQrError('WRONG_PORTAL', mismatch);
    const hostId = parsed.bootstrap.hostId;
    if (manager.controller(hostId)) {
      selectHost(hostId);
      setShowScanner(false);
      navigateWorkspace('workroom');
      setNotice('이미 등록한 기기로 전환했습니다.');
      return;
    }
    if (!vaultRef.current) throw new Error('연결 준비 중입니다. 잠시 후 다시 시도하세요.');
    await vaultRef.current.seal(pairingUrl);
    const source: RemoteHostSource = { hostId, pairingUrl };
    setSources(current => [...current.filter(item => item.hostId !== hostId), source]);
    applySelection(hostId);
    setShowScanner(false);
    navigateWorkspace('workroom');
    if (authState === 'signed-in' && initializedRef.current) await connectHost(source);
  };

  return (
    <ErrorVocProvider value={errorVocHandlers}>
    {vocComposer && <RemoteVocComposer key={vocComposerKey.current} prefill={vocComposer} onClose={() => setVocComposer(null)}
      onDismiss={draft => {
        const id = vocComposer.captureId;
        if (!id) return;
        void captureStore().then(store => store.keep(id, { comment: draft.comment, images: draft.images })).then(() => refreshCaptures())
          .then(() => setNotice('보내지 않은 캡처로 남겼습니다. 「VOC」에서 이어서 보낼 수 있습니다.')).catch(() => {});
      }}
      onSubmit={async (mode, draft, progress) => {
        const outcome = await submitVoc(mode, draft, progress);
        const id = vocComposer.captureId;
        // A held VOC may still expire unsent; keep its capture until the Mac's list shows it arrived.
        if (id && outcome !== 'held') await captureStore().then(store => store.remove(id)).then(() => refreshCaptures()).catch(() => {});
      }} canUseWorkroom={!!selectedController && status.state === 'online'}
      photoNotice={!selectedController || status.state !== 'online' ? '사진은 Mac에 연결된 상태에서 보낼 수 있습니다. 지금은 글만 남길 수 있습니다.'
        : !hostSupportsRemoteVoc(status.supportedFeatures) ? '이 Mac 앱은 사진 VOC를 아직 지원하지 않습니다. Mac 앱을 업데이트하면 사진을 보낼 수 있습니다.' : null} />}
    {vocHub && <RemoteVocHub onClose={() => setVocHub(null)} focusInbox={vocHub.focusInbox}
      onCompose={() => openVocComposer({ source: 'phone', comment: '', screen: screenLabel() })}
      captures={captures} capturesPersistent={capturesPersistent}
      onResumeCapture={id => { void captureStore().then(store => store.get(id)).then(capture => { if (capture) openCaptureComposer(capture); else { setVocHub(null); void refreshCaptures(); } }); }}
      onDeleteCapture={async id => { await (await captureStore()).remove(id); await refreshCaptures(); }}
      inbox={vocInbox} onRefreshInbox={() => void loadVocInbox()}
      onProcessInbox={() => processVocInbox()} onProcessInboxItem={item => processVocInbox(item)}
      canUseWorkroom={!!selectedController && status.state === 'online'} />}
    <main className="remote-shell" data-workspace-tab={workspaceTab} data-remote-pane={remotePane} data-testid="internet-remote-controller">
      <div className="workspace-statusbar" aria-hidden="true" />
      <header className="remote-header">
        <div className="remote-brand">AZ</div>
        <div className="remote-heading">
          <p>내 작업 공간</p>
          <h1>{{home:'AgentsToZ',projects:'프로젝트 현황',workroom:'원격 작업',bookmarks:'북마크',records:'기록'}[workspaceTab]}</h1>
        </div>
        {workspaceTab==='workroom'&&<span className={`remote-state remote-state--${connectionStateTone(status.state, phoneOnline, status.relayUnreachable)}`} data-testid="remote-connection-state">{connectionStateLabel(status.state, phoneOnline, status.relayUnreachable)}</span>}
        <button type="button" className="remote-voc-open" data-testid="remote-voc-open"
          aria-label={`VOC — 새로 쓰기·쌓인 VOC${captures.length ? ` · 보내지 않은 캡처 ${captures.length}개` : ''}`}
          onClick={() => openVocHub(false)}><MessageSquareWarning aria-hidden="true" /><span>VOC</span>
          {captures.length > 0 && <b className="remote-voc-open-badge" data-testid="remote-voc-open-badge">{captures.length}</b>}</button>
        <WorkspaceThemePicker />
      </header>

      {/* Shown from the first Mac on, not only from the second: the chip also
          carries that Mac's connection dot and its remove control, and a row
          that appeared out of nowhere on a second QR would never teach anyone
          that switching Macs exists. */}
      {workspaceTab==='workroom' && hosts.length > 0 && (
        <nav className="remote-host-tabs" data-testid="remote-host-tabs" aria-label="연결된 Mac 전환">
          {hosts.map(host => (
            <div
              className={`remote-host-tab${host.hostId === selectedHostId ? ' remote-host-tab--active' : ''}`}
              key={host.hostId}
            >
              <button
                type="button"
                className="remote-host-tab-select"
                data-testid={`remote-host-tab-${host.hostId}`}
                aria-pressed={host.hostId === selectedHostId}
                title={`${hostLabel(host)} · ${connectionStateLabel(host.status.state, phoneOnline, host.status.relayUnreachable)}`}
                onClick={() => selectHost(host.hostId)}
              >
                <span className={`remote-host-dot remote-host-dot--${connectionStateTone(host.status.state, phoneOnline, host.status.relayUnreachable)}`} aria-hidden="true" />
                <span className="remote-host-tab-name">{hostLabel(host)}</span>
                {/* A closed session stays 「종료됨」 (its title and red dot say so too): the phone already knows that. */}
                {!phoneOnline && host.status.state !== 'closed' ? (
                  <span className="remote-host-tab-state remote-host-tab-state--phone-offline" data-testid="remote-host-tab-phone-offline">{phoneOfflineLabel()}</span>
                ) : host.status.relayUnreachable && host.status.state === 'online' ? (
                  <span className="remote-host-tab-state remote-host-tab-state--phone-offline" data-testid="remote-host-tab-relay-unreachable">{relayUnreachableLabel()}</span>
                ) : host.status.requesting ? (
                  <span className="remote-host-tab-state remote-host-tab-state--busy">요청 중</span>
                ) : host.status.state !== 'online' && (
                  <span className="remote-host-tab-state">{controllerStateLabels[host.status.state]}</span>
                )}
              </button>
              <button
                type="button"
                className="remote-host-tab-remove"
                data-testid={`remote-host-remove-${host.hostId}`}
                aria-label={`${hostLabel(host)} 연결 해제`}
                onClick={() => void disconnectHost(host.hostId, true)}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          ))}
        </nav>
      )}

      <nav className="workspace-navigation" aria-label="작업 메뉴">
        {([['home', '홈', LayoutDashboard], ['projects', '프로젝트', FolderGit2], ['workroom', '원격 작업', MessageSquare], ['bookmarks', '북마크', BookMarked], ['records', '기록', Brain]] as const).map(([tab, label, Icon]) =>
          <button key={tab} type="button" data-workspace-tab={tab} aria-current={workspaceTab === tab ? 'page' : undefined} onClick={() => navigateWorkspace(tab)}><Icon aria-hidden="true" /><span>{label}</span></button>)}
      </nav>
      {/* Prompts feed a workroom; on 프로젝트·북마크·기록 they only pushed the content down (2026-10-02 실기 점검).
          Hidden, not unmounted, so the loaded library survives tab switches. */}
      {supabase && authState === 'signed-in' && <div className="workspace-prompt-guides" hidden={workspaceTab!=='home'&&workspaceTab!=='workroom'}><SharedPromptGuideBar key={email} client={supabase}/></div>}
      <PortalRemoteQrScanner open={showScanner} onClose={() => setShowScanner(false)} onDetected={acceptPairing} />
      {/* While a Mac answers, adding another one is rare: the big button moves into 「연결 정보」. */}
      {(workspaceTab==='home'||workspaceTab==='workroom')&&!anyHostOnline&&<button className="remote-portal-scan" type="button" data-testid="remote-portal-scan" onClick={() => setShowScanner(true)}><ScanLine aria-hidden="true" />작업 기기 연결 · QR 스캔</button>}
      {workspaceTab === 'home' && <section className="remote-panel workspace-home">
        <h2>이어서 작업</h2>
        <p>{status.state === 'online' ? '프로젝트를 선택해 휴대폰에서 작업을 이어가세요.' : '등록한 기기에 연결하면 프로젝트와 진행 중인 작업을 이어갈 수 있습니다.'}</p>
        <div className="workspace-quick-actions">
          <button className="remote-secondary" onClick={() => navigateWorkspace('projects')}>프로젝트 현황</button>
          <button className="remote-secondary" onClick={() => navigateWorkspace('workroom')}>원격 작업 이어가기</button>
          <button className="remote-secondary" onClick={() => navigateWorkspace('records')}>기록 찾기</button>
        </div>
        {status.projects.slice(0, 4).map(project => <button className="workspace-recent-project" key={project.controlId} onClick={() => openProjectWorkroom(project)}><FolderGit2 aria-hidden="true" />{project.name}<span>작업하기</span></button>)}
      </section>}
      {workspaceTab==='workroom'&&<div className="workspace-project-source" role="group" aria-label="원격 작업 화면">
        <button aria-pressed={remotePane==='projects'} onClick={()=>setRemotePane('projects')}>프로젝트 관리</button>
        <button aria-pressed={remotePane==='workroom'} onClick={()=>{setRemotePane('workroom');setTerminalOpen(true)}}>워크룸 이어가기</button>
        <button type="button" className="workspace-pane-extra workspace-pane-voc" data-testid="remote-voc-inbox-entry" title="Mac에 쌓인 VOC를 보고 워크룸으로 처리합니다" onClick={()=>openVocHub(true)}>쌓인 VOC</button>
        <button type="button" className="workspace-pane-extra" data-testid="remote-community-toggle" aria-pressed={remotePane==='community'} title="커뮤니티 · 다른 아젠투지 제어" onClick={()=>setRemotePane(pane=>pane==='community'?'projects':'community')}>커뮤니티</button>
        {/* Duty is an experiment that may be removed; a small toggle at the row's end, off until pressed. */}
        <button type="button" className="workspace-pane-extra" data-testid="remote-duty-toggle" aria-pressed={remotePane==='duty'} title="카카오톡 대직 (실험 중)" onClick={()=>setRemotePane(pane=>pane==='duty'?'projects':'duty')}>대직</button>
      </div>}
      {workspaceTab==='records'&&<div className="workspace-project-source" role="group" aria-label="기록 종류"><button aria-pressed={recordMode==='said'} onClick={()=>setRecordMode('said')}>내가 한 말</button><button aria-pressed={recordMode==='memories'} onClick={()=>{setRecordMode('memories');setCatalogVisited(true);}}>장기기억</button></div>}
      {(['records','manage','duty'] as const).map(mode=>{
        // 「프로젝트 작업 마무리」 is not what 원격 작업 opens on: it appears only when a project was chosen
        // for it (its card's 「기억·정리·테스트」, or the workroom's 「세션 기억하기」) and closes again.
        const visible=mode==='records'?workspaceTab==='records'&&recordMode==='said':workspaceTab==='workroom'&&(mode==='duty'?remotePane==='duty':remotePane==='projects'&&!!managementTarget);
        return <div key={mode} hidden={!visible}><MobileWorkspacePanel key={workspaceConnectionKey} testerAvailable={status.supportedFeatures?.includes('tester-v1')??false} mode={mode} visible={visible} projects={status.projects} available={status.supportedFeatures?.includes(MOBILE_WORKSPACE_FEATURE)??false} online={status.state==='online'} initialTarget={mode==='records'?undefined:managementTarget} onClose={mode==='manage'?()=>setManagementTarget(''):undefined} transport={(request:MobileWorkspaceRequest)=>{if(!selectedController)throw new Error('기기에 연결하세요.');return selectedController.sendTerminal(request)}} onDraft={(targetId,prompt)=>{setTerminalEntry({nonce:Date.now(),targetId,prompt});setRemotePane('workroom');navigateWorkspace('workroom');}} /></div>;
      })}
      {catalogVisited && <section hidden={!catalogVisible} className="workspace-catalog">
        <PortalCatalog tab={catalogTab} visible={catalogVisible} onRemoteWork={project=>{setRemotePane('projects');navigateWorkspace('workroom');setNotice(project?`${project.name}에서 작업하려면 작업 기기와 해당 프로젝트를 선택하세요.`:'작업할 기기와 프로젝트를 선택하세요.')}} />
      </section>}
      <div hidden={workspaceTab!=='workroom'} className="workspace-host-content">
      <details className="workspace-connection-details"><summary>연결 정보</summary>
        {anyHostOnline&&<button className="remote-secondary remote-portal-scan-more" type="button" data-testid="remote-portal-scan-more" onClick={() => setShowScanner(true)}><ScanLine aria-hidden="true" />다른 작업 기기 연결 · QR 스캔</button>}
        <p className="remote-resume-note">등록한 연결은 만료 전까지 복원됩니다. 탭을 이동해도 호스트 작업은 계속됩니다.</p>
        <section className="remote-security-note"><ShieldCheck aria-hidden="true" /><p>승인한 작업과 기록은 암호화된 연결을 통해 이용합니다. 터미널 입력과 출력에는 프로젝트 경로와 계정 정보가 포함될 수 있습니다.</p></section>
      </details>

          {terminalOpen && <div className="remote-panel remote-workroom-content" key={selectedHostId??'none'}>{(()=>{
            // 「기기」 줄은 커뮤니티에 다른 기기가 보일 때만 나온다. 고르면 같은 워크룸 화면이 그 기기의
            // 세션·프로젝트로 바뀐다(`key`로 다시 마운트해 이 Mac의 세션 커서를 섞지 않는다).
            // 기기는 **탭**이다(Mac과 같은 모양) — 한 번 눌러 바뀌고 어느 호가 있는지 한눈에 보인다.
            const chooseDevice=(next:RemoteCommunityDevice|null)=>{
              setCommunityDevice(next);setCommunityProjects(null);setCommunityProjectsError('');setCommunityOpsWanted(0);
              if(next)loadCommunityProjects(next,0);
            };
            const deviceSwitch=communityDevices.length>0?<div className="ai-terminal-field ai-terminal-field--device" data-testid="remote-workroom-device-switch">
              <span className="ai-terminal-label">기기</span>
              <div className="ai-terminal-devices" role="group" aria-label="워크룸 기기" data-testid="remote-workroom-device-tabs">
                <button type="button" className="ai-terminal-device-tab" aria-pressed={!communityDevice} data-testid="remote-workroom-device-tab-local" onClick={()=>chooseDevice(null)}>{status.hostName?`${status.hostName} (연결한 기기)`:'연결한 기기'}</button>
                {communityDevices.map(item=><button key={item.ref} type="button" className="ai-terminal-device-tab"
                  aria-pressed={communityDevice?.ref===item.ref} data-testid={'remote-workroom-device-tab-'+item.ref}
                  onClick={()=>chooseDevice(item)}>{communityDeviceLabel(item.name)}</button>)}
              </div>
              {communityDevice&&communityProjectsError&&<span className="ai-terminal-hint ai-terminal-hint--error" role="alert" data-testid="remote-workroom-device-error">{communityProjectsError} <button type="button" className="ai-terminal-btn" onClick={()=>loadCommunityProjects(communityDevice,0)}>다시 시도</button></span>}
              {communityDevice&&!communityProjectsError&&!communityProjects&&<span className="ai-terminal-hint" data-testid="remote-workroom-device-loading">{communityDeviceLabel(communityDevice.name)}의 프로젝트 목록을 받고 있습니다… (그 Mac이 응답할 때까지 최대 8초)</span>}
              {communityDevice&&!communityProjectsError&&!!communityProjects&&<span className="ai-terminal-hint" data-testid="remote-workroom-device-note">이 화면의 터미널은 {communityDeviceLabel(communityDevice.name)}에서 실행됩니다.{communityProjects.hasMore?' 프로젝트 목록이 더 있습니다.':''}</span>}
              {communityDevice&&communityProjects?.hasMore&&<button type="button" className="ai-terminal-btn" data-testid="remote-workroom-device-more" onClick={()=>loadCommunityProjects(communityDevice,communityProjects.page+1)}>프로젝트 더 불러오기</button>}
            </div>:null;
            const visible=workspaceTab==='workroom'&&remotePane==='workroom'&&status.state==='online';
            // ⚠️ 기기를 고른 직후에는 **프로젝트 목록이 오기 전까지 패널을 돌리지 않는다**(`visible=false`).
            // 그 목록이 사용자가 기다리는 첫 번째 것인데, 패널이 먼저 1초마다 list·read를 보내면 그 요청들이
            // 릴레이를 한 건씩 차지해 목록 요청이 뒤로 밀리고 「대기 중인 원격 입력이 많습니다」가 먼저 떴다
            // (2026-10-05 아이폰 17 실기). 전달 하나는 상대 Mac의 유휴 폴링(3초) 때문에 빠를 수가 없다.
            if(communityDevice)return <AiTerminalPanel key={'community:'+communityDevice.ref} remote slowPolling
              bypassUnavailable={COMMUNITY_BYPASS_UNAVAILABLE} referencesSupported={false} visible={visible&&!!communityProjects} sessionScope={'community:'+communityDevice.ref}
              projects={communityProjects?.projects??[]} opsTargetId={communityProjects?.opsTargetId??undefined}
              deviceName={communityProjects?.deviceName??communityDevice.name}
              entry={communityOpsWanted&&communityProjects?.opsTargetId?{nonce:communityOpsWanted,targetId:communityProjects.opsTargetId}:undefined}
              transport={deviceTerminalTransport} workspaceTransport={deviceWorkroomTransport} deviceSwitch={deviceSwitch} communityMention={communityMention}/>;
            return <AiTerminalPanel remote referencesSupported={!!status.supportedFeatures?.includes(AI_TERMINAL_REFERENCES_FEATURE)} visible={visible} entry={terminalEntry} sessionScope={selectedHostId??'none'} projects={hostMentionProjects} transport={terminalTransport} workspaceTransport={workroomTransport} opsTargetId={opsControlId} deviceName={status.hostName??undefined} deviceSwitch={deviceSwitch} communityMention={communityMention} onWhatISaid={()=>{setRecordMode('said');navigateWorkspace('records')}} onRememberSession={targetId=>{setManagementTarget(targetId);setRemotePane('projects');navigateWorkspace('workroom')}}/>;
          })()}</div>}
          <div hidden={!(workspaceTab==='workroom'&&remotePane==='community')}>
            <RemoteCommunityPanel opsTargetId={opsControlId} visible={workspaceTab==='workroom'&&remotePane==='community'}
              online={status.state==='online'} available={status.supportedFeatures?.includes(MOBILE_WORKSPACE_FEATURE)??false}
              transport={workroomTransport} onDriveDevice={driveCommunityDevice} onDevices={setCommunityDevicesStable}/>
          </div>

      {!phoneOnline && (
        <div className="remote-phone-offline" role="status" data-testid="remote-phone-offline">{phoneOfflineNotice()}</div>
      )}
      {(error || status.error) && !(!phoneOnline && (error
        ? transientErrorRef.current?.kind === 'transient' || transientErrorRef.current?.kind === 'refused'
        : status.relayUnreachable)) && (
        <div className="remote-alert" role="alert">
          <p>{error || status.error}</p>
          {/* Same next step the same-Wi-Fi QR page shows for this code (remoteControlScreenText.ts). */}
          {errorDetail && remoteActionErrorHint(errorDetail) && <p className="remote-alert-hint" data-testid="remote-alert-hint">{remoteActionErrorHint(errorDetail)}</p>}
          {error && errorPaths.length > 0 && <ul className="remote-alert-paths" data-testid="remote-alert-paths">{errorPaths.map(path => <li key={path}>{path}</li>)}</ul>}
          <div className="remote-alert-detail">
            {errorDetail && <code>{errorDetail}</code>}
            <button
              type="button"
              onClick={() => {
                const report = [
                  error || status.error,
                  errorDetail,
                  'state: ' + status.state,
                ].filter(Boolean).join('\n');
                void navigator.clipboard?.writeText(report).then(
                  () => setNotice('오류 정보를 복사했습니다.'),
                  () => setNotice('복사에 실패했습니다. 코드를 직접 적어 주세요.'),
                );
              }}
            >
              오류 정보 복사
            </button>
            {/* Every error offers the same two actions (VOC 작성 · 워크룸으로 VOC 처리). When the Mac
                is unreachable — often the very error shown — the note falls back to the shared error
                table the Mac reads back (portmgr_client_errors), text only. */}
            <ErrorVocActions message={error || status.error} code={errorDetail || 'REMOTE_CONTROL_FAILED'} detail={'state: ' + status.state} surface="remote-control" />
          </div>
        </div>
      )}
      {error && loginRecovery && <div className="portal-login-recovery">
        <button type="button" disabled={loginBusy} onClick={() => void login(loginRecovery.changeAccount)}>로그인 다시 시도</button>
        {canContinuePortalGoogleOAuth(loginRecovery.error) && <button type="button" disabled={loginBusy}
          onClick={() => void login(loginRecovery.changeAccount, true)}>Google 로그인 페이지로 이동</button>}
      </div>}
      {notice && <div className="remote-notice" role="status">{notice}</div>}

      {waiting ? (
        <section className="remote-panel remote-centered" role="status">
          <Loader2 className="remote-spin" aria-hidden="true" />
          <h2>보안 연결을 확인하고 있습니다</h2>
          <p>QR·Google 로그인·암호화 키 상태를 차례로 검사합니다.</p>
        </section>
      ) : authState === 'unavailable' ? (
        <section className="remote-panel remote-centered">
          <LockKeyhole aria-hidden="true" />
          <h2>개인 배포 설정이 필요합니다</h2>
          <p>이 호스팅 환경에 VITE_SUPABASE_URL과 VITE_SUPABASE_ANON_KEY를 설정해 주세요.</p>
        </section>
      ) : missingPairing ? (
        // No Mac paired yet. In the app this is the 「폰 연결 링크」 state (step ①): the data connection
        // exists, control does not — say what works now and how to get control, instead of an error.
        <section className="remote-panel remote-centered" hidden={workspaceTab==='home'} data-testid="remote-view-only">
          <Smartphone aria-hidden="true" />
          <h2>{PORTAL_IS_BUNDLED ? '보기 전용 · Mac 제어는 Mac 앞에서 QR 승인 후' : '작업할 기기를 연결하세요'}</h2>
          <p>프로젝트·북마크·기록(장기기억) 메뉴는 로그인하면 지금 볼 수 있습니다. 여기서 Mac을 제어하려면 한 번 Mac 앞에서 승인해야 합니다.</p>
          <ol className="remote-view-only-steps" data-testid="remote-view-only-steps">
            <li>Mac의 AgentsToZ에서 외부 인터넷 원격제어 QR을 띄웁니다.</li>
            <li>아래 「작업 기기 연결 · QR 스캔」으로 찍습니다.</li>
            <li>휴대폰과 Mac에 뜬 6자리 코드가 같은지 보고 Mac에서 승인합니다.</li>
          </ol>
          <button className="remote-primary" type="button" data-testid="remote-view-only-scan" onClick={() => setShowScanner(true)}><ScanLine aria-hidden="true" />작업 기기 연결 · QR 스캔</button>
        </section>
      ) : authState === 'verification-error' ? (
        <section className="remote-panel remote-centered" data-testid={membershipNetwork ? 'remote-membership-network' : 'remote-membership-error'}>
          <LockKeyhole aria-hidden="true" />
          {/* A phone with no network cannot learn anything about the DB — say the network, not migrations. */}
          <h2>{membershipNetwork ? (phoneOnline ? '서버에 연결하지 못했습니다' : '네트워크 연결을 기다리고 있습니다') : 'DB 회원 권한을 확인하지 못했습니다'}</h2>
          <p>{membershipNetworkSubject ? portalNetworkFailureMessage(membershipNetworkSubject, phoneOnline)
            : membershipError || '최신 Supabase 마이그레이션과 네트워크를 확인해 주세요.'}</p>
          <button className="remote-primary" type="button" onClick={() => { networkRetriesRef.current = 0; setMembershipRetryNonce(value => value + 1); }}>
            <RefreshCw aria-hidden="true" />다시 확인
          </button>
          {/* Clearing the stored login cannot fix a network, and it throws away a session that would come back by itself. */}
          {!membershipNetwork && (
            <button className="remote-secondary" type="button" onClick={resetStoredLogin}>
              이 기기 로그인 초기화
            </button>
          )}
        </section>
      ) : authState === 'denied' ? (
        <section className="remote-panel remote-centered">
          <LockKeyhole aria-hidden="true" />
          <h2>허용되지 않은 계정입니다</h2>
          <p>{membershipError || `${email || '현재 Google 계정'}은 이 개인 배포본의 DB 허용 회원이 아닙니다.`}</p>
          <button className="remote-primary" type="button" disabled={loginBusy} onClick={() => void login(true)}>
            {loginBusy ? <Loader2 className="remote-spin" aria-hidden="true" /> : <LockKeyhole aria-hidden="true" />}
            다른 Google 계정으로 로그인
          </button>
        </section>
      ) : authState === 'signed-out' ? (
        <section className="remote-panel remote-centered">
          <Smartphone aria-hidden="true" />
          {/* The app signs in with an emailed code only: no Google Cloud client to set up.
              The web portal (fallback channel) keeps Google as well. */}
          <h2>{PORTAL_IS_BUNDLED ? '이메일로 로그인' : '내 개인 배포본으로 로그인'}</h2>
          <p>{PORTAL_IS_BUNDLED
            ? 'QR 비밀은 이 기기 안에 암호화해 보관합니다. 계정 이메일로 받은 코드로 본인 계정을 확인합니다.'
            : 'QR 비밀은 이 기기 안에 암호화해 보관한 뒤, Google 또는 이메일 코드 로그인으로 본인 계정을 확인합니다.'}</p>
          {!PORTAL_IS_BUNDLED && <button className="remote-primary" type="button" disabled={loginBusy} onClick={() => void login(false)}>
            {loginBusy ? <Loader2 className="remote-spin" aria-hidden="true" /> : <LockKeyhole aria-hidden="true" />}
            Google 계정으로 계속
          </button>}
          <PortalEmailCodeLogin client={supabase as unknown as PortalEmailCodeClient} disabled={loginBusy} />
        </section>
      ) : status.state === 'approval-required' ? (
        <section className="remote-panel remote-approval" data-testid="internet-remote-approval">
          <div className="remote-icon-circle"><Monitor aria-hidden="true" /></div>
          <p className="remote-eyebrow">MAC APPROVAL REQUIRED</p>
          <h2>Mac에서 같은 6자리인지 확인하세요</h2>
          <div className="remote-sas" aria-label={`연결 확인 코드 ${status.sasCode}`}>{status.sasCode}</div>
          <p>코드가 같을 때만 Mac의 “이 기기 승인”을 누르세요. 스캔만으로 실행 권한이 열리지 않습니다.</p>
        </section>
      ) : status.state === 'connecting' ? (
        <section className="remote-panel remote-centered" role="status">
          <Loader2 className="remote-spin" aria-hidden="true" />
          <h2>Mac이 승인했습니다</h2>
          <p>종단간 암호화 세션과 프로젝트 목록을 여는 중입니다.</p>
        </section>
      ) : status.state === 'online' ? (
        <>
          <section className="remote-toolbar">
            <div data-testid="remote-host-liveness" data-reach={macReach ?? 'checked'}>
              {/* A green check beside 「휴대폰 오프라인」 read as "verified OK". */}
              {macReach ? <WifiOff aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
              {/* The Mac's silence is only evidence when this phone could ask. */}
              <span>{status.hostName} · {macReach ? phoneOfflineHostLine(macReach) : hostLiveness(status.hostLastSeenAt)}</span>
            </div>
            <button
              type="button"
              data-testid="remote-refresh"
              onClick={() => void manualRefresh()}
              disabled={status.busy || refreshing}
            >
              {refreshing
                ? <Loader2 className="remote-spin" aria-hidden="true" />
                : <RefreshCw aria-hidden="true" />}
              {refreshing ? '새로고침 중…' : '새로고침'}
            </button>
          </section>
          {!macReach && hostSilentLong(status.hostLastSeenAt) && (
              <div className="remote-stale-pairing" data-testid="remote-stale-pairing" role="status">
                <p>Mac이 잠자고 있다면 깨우면 이어집니다. <b>Mac이 켜져 있는데도</b> 계속 이렇다면 Mac에서 원격제어를 다시 켜면서 이 폰의 연결이 예전 것으로 남은 경우입니다. 위 탭의 ×로 이 Mac을 지우고 QR을 다시 스캔하세요.</p>
                <button type="button" data-testid="remote-stale-pairing-scan" onClick={() => setShowScanner(true)}>QR 다시 스캔</button>
              </div>
            )}
          {/* Only what no other place offers: the shared operating memory and its pending candidates. Voice and
              「OPS 워크룸 열기」 live in the dock (one entry each, VOC 2026-10-06) — this card used to repeat both.
              With nothing to review and the memory connected, the card stays out of the way. */}
          {(!!opsStatus?.pendingCount || opsCandidates !== null || (opsStatus !== null && opsStatus.state !== 'ready')) &&
          <section className="remote-panel remote-ops-control" data-testid="remote-ops-controls">
            <h2>아젠투지(OPS) 운영기억</h2>
            <p className="remote-ops-status" data-testid="remote-ops-status">{opsStatus
              ? opsStatusText(opsStatus)
              : '운영기억 상태 확인 중…'}</p>
            <div className="workspace-quick-actions">
              {!!opsStatus?.pendingCount && <button type="button" className="remote-secondary" data-testid="remote-ops-review" aria-expanded={opsCandidates!==null} disabled={status.busy} onClick={() => opsCandidates ? setOpsCandidates(null) : void readOpsCandidates()}>{opsCandidates ? '저장 후보 닫기' : `저장 후보 ${opsStatus.pendingCount}개 검토`}</button>}
            </div>
            {opsCandidates && (opsCandidates.candidates.length ? (
              <div className="remote-ops-candidates" data-testid="remote-ops-memory-candidates">
                <p className="remote-ops-hint">저장해야 공유 운영기억에 들어갑니다. 제목을 눌러 내용을 보고 결정하세요.</p>
                {opsCandidates.candidates.map(candidate=><details className="remote-ops-candidate" key={candidate.id}>
                  <summary><span>{candidate.title}</span><small>{new Date(candidate.createdAt).toLocaleDateString()}</small></summary>
                  <p>{plainOpsText(candidate.body)}</p>
                  {candidate.evidence&&<p className="remote-ops-evidence">근거: {plainOpsText(candidate.evidence)}</p>}
                  <div className="workspace-quick-actions">
                    <button type="button" className="remote-primary" disabled={status.busy} onClick={()=>void reviewOpsCandidate(candidate.id,true)}>저장</button>
                    <button type="button" className="remote-secondary" disabled={status.busy} onClick={()=>void reviewOpsCandidate(candidate.id,false)}>거절</button>
                  </div>
                </details>)}
              </div>
            ) : <p className="remote-task-empty">검토할 운영기억 후보가 없습니다.</p>)}
          </section>}
          <section className="remote-task-console remote-conversation-console remote-workroom-content" data-testid="remote-codex-conversation-console">
            <div className="remote-task-console-heading">
              <div>
                <MessageSquare aria-hidden="true" />
                <span><strong>저장된 Codex 대화</strong><small>대화 기록 읽기</small></span>
              </div>
              <button
                type="button"
                disabled={status.busy || conversationPanel.busy || capabilityProbePending || conversationHostUpdateRequired}
                onClick={() => conversationPanel.open
                  ? updateConversationPanel({ open: false })
                  : void openRemoteConversationPanel()}
              >
                {capabilityProbePending
                  ? '호환성 확인 중…'
                  : conversationHostUpdateRequired
                    ? '업데이트 필요'
                    : conversationPanel.open ? '닫기' : '열기'}
              </button>
            </div>
            {capabilityProbePending && (
              <p className="remote-task-empty" role="status" data-testid="remote-conversation-capability-pending">
                이 Mac의 대화 지원 여부를 종단간 암호화된 연결로 확인하고 있습니다. 확인이 끝날 때까지 대화 열기는 잠시 비활성화됩니다.
              </p>
            )}
            {conversationHostUpdateRequired && (
              <p className="remote-task-empty" role="status" data-testid="remote-conversation-host-update-required">
                이 Mac의 AgentsToZ 앱은 지속형 Codex 대화를 지원하지 않는 이전 설치본입니다. Mac 앱을 최신 설치본으로 업데이트하고 완전히 다시 연 뒤 새로고침하세요. 아래 기본 프로젝트 제어는 계속 사용할 수 있습니다.
              </p>
            )}
            {!capabilityProbePending && !conversationHostUpdateRequired && conversationPanel.open && (
              <div className="remote-task-console-body">
                <p className="remote-task-safety">
                  이 화면은 Codex와 대화하는 단일 원격 진입점입니다. 프롬프트와 필터링된 기록은 종단간 암호화되며,
                  프로젝트 파일을 바꾸는 작업 모드는 안전 격리 완료 전까지 제공하지 않습니다. 프로젝트 장기기억에는 대화 원문 전체를 복사하지 않으며, 별도로 켠 What I Said 수집 정책은 그대로 적용됩니다.
                  Mac에서 자동 체크포인트를 켜고 50·75·90% 도달·턴 완료·등록 프로젝트 변경 조건을 모두 충족하면
                  검증된 결정·결과 요약만 장기기억에 저장합니다.
                </p>
                {conversationPanel.busy && (
                  <div className="remote-task-loading" role="status"><Loader2 className="remote-spin" />Mac의 지속형 대화를 확인하는 중…</div>
                )}
                {(conversationPanel.error || conversationPanel.syncError) && (
                  <div className="remote-task-error" role="alert">
                    {conversationPanel.error || conversationPanel.syncError}
                    <ErrorVocActions message={conversationPanel.error || conversationPanel.syncError} surface="remote-conversations" />
                  </div>
                )}
                {conversationPanel.available === false && (
                  <p className="remote-task-empty">
                    {conversationPanel.blocker === 'host-update'
                      ? 'Mac 앱을 최신 설치본으로 업데이트하고 완전히 다시 연 뒤 새로고침하세요. 기존 QR 연결은 유지되며, 업데이트 후 이 기기의 대화 권한만 켜면 됩니다.'
                      : conversationPanel.blocker === 'scope'
                      ? 'Mac 앱의 승인된 모바일 기기에서 이 기기의 “지속형 Codex 대화 및 대화 기록 열람” 권한을 켜세요. QR을 다시 연결할 필요는 없습니다.'
                      : conversationPanel.blocker === 'runtime'
                        ? '권한 문제는 아닙니다. 이 Mac 설치본의 Codex 런타임과 안전성 게이트가 아직 실행 가능 상태가 아닙니다.'
                        : '권한 또는 Mac 런타임 상태를 확정하지 못했습니다. 위 오류와 Mac 연결 상태를 확인하세요.'}
                  </p>
                )}
                {conversationPanel.available === true && (
                  <div className="remote-conversation-layout">
                    <div className="remote-conversation-sidebar" ref={remoteConversationSidebarRef}>
                      <div className="remote-conversation-list-tabs" aria-label="대화 목록 범위">
                        <button
                          type="button"
                          className={!conversationPanel.archivedOnly ? 'is-selected' : ''}
                          disabled={conversationPanel.busy}
                          aria-pressed={!conversationPanel.archivedOnly}
                          onClick={() => void showRemoteConversationArchive(false)}
                        >
                          활성
                        </button>
                        <button
                          type="button"
                          className={conversationPanel.archivedOnly ? 'is-selected' : ''}
                          disabled={conversationPanel.busy}
                          aria-pressed={conversationPanel.archivedOnly}
                          onClick={() => void showRemoteConversationArchive(true)}
                        >
                          보관됨
                        </button>
                      </div>
                      {!conversationPanel.archivedOnly && (
                        <button
                          type="button"
                          className="remote-conversation-new"
                          disabled={conversationPanel.busy}
                          onClick={() => updateConversationPanel({
                            selectedConversationId: '', messages: [], historyTruncated: false,
                            historyFiltered: false, events: [], eventCursor: 0, prompt: '', error: '',
                          })}
                        >
                          + 새 대화
                        </button>
                      )}
                      <label className="remote-conversation-search" htmlFor="remote-conversation-search">
                        <input
                          id="remote-conversation-search"
                          type="search"
                          aria-label="대화 검색"
                          value={conversationPanel.query}
                          disabled={conversationPanel.busy}
                          placeholder="프로젝트·AI·모델·상태 검색"
                          onChange={event => updateConversationPanel({ query: event.target.value })}
                        />
                      </label>
                      <div className="remote-conversation-list">
                        {visibleRemoteConversations.map(conversation => (
                          <button
                            type="button"
                            key={conversation.conversationId}
                            className={conversation.conversationId === conversationPanel.selectedConversationId ? 'is-selected' : ''}
                            disabled={conversationPanel.busy}
                            onClick={() => {
                              void refreshRemoteConversationHistory(conversation);
                              if (window.matchMedia('(max-width: 619px)').matches) {
                                window.requestAnimationFrame(() => (
                                  remoteConversationMainRef.current?.scrollIntoView({
                                    behavior: 'smooth',
                                    block: 'start',
                                  })
                                ));
                              }
                            }}
                          >
                            <strong>{conversation.projectLabel}</strong>
                            <span>{remoteConversationAdapterLabel(conversation.adapterId)} · {remoteConversationStateLabel(conversation.state)} · {conversation.modelId}</span>
                          </button>
                        ))}
                        {conversationPanel.conversations.length === 0 && (
                          <p className="remote-task-empty">
                            {conversationPanel.archivedOnly
                              ? '이 Mac에 보관된 지속형 대화가 없습니다.'
                              : '이 Mac에 저장된 지속형 대화가 아직 없습니다.'}
                          </p>
                        )}
                        {conversationPanel.conversations.length > 0
                          && visibleRemoteConversations.length === 0 && (
                          <p className="remote-task-empty">검색과 일치하는 대화가 없습니다.</p>
                        )}
                      </div>
                    </div>
                    <div className="remote-conversation-main" ref={remoteConversationMainRef}>
                      <button
                        type="button"
                        className="remote-conversation-list-jump"
                        onClick={() => remoteConversationSidebarRef.current?.scrollIntoView({
                          behavior: 'smooth',
                          block: 'start',
                        })}
                      >
                        대화 목록
                      </button>
                      {!selectedConversation && !conversationPanel.archivedOnly && (
                        <div className="remote-task-form-grid remote-conversation-settings">
                          <label htmlFor="remote-conversation-project">프로젝트·워크트리</label>
                          <select
                            id="remote-conversation-project"
                            value={conversationPanel.selectedControlId}
                            disabled={conversationPanel.busy}
                            onChange={event => updateConversationPanel({ selectedControlId: event.target.value })}
                          >
                            {status.projects.map(project => (
                              <option value={project.controlId} key={project.controlId}>
                                {project.kind === 'worktree' ? '↳ ' : ''}{project.name}{project.branch ? ` · ${project.branch}` : ''}
                              </option>
                            ))}
                          </select>
                          <label htmlFor="remote-conversation-model">Codex 모델</label>
                          <select
                            id="remote-conversation-model"
                            value={conversationPanel.selectedModelId}
                            disabled={conversationPanel.busy}
                            onChange={event => updateConversationPanel({ selectedModelId: event.target.value })}
                          >
                            {conversationPanel.models.map(model => (
                              <option value={model.modelId} key={model.modelId}>{model.label}{model.isDefault ? ' · 기본' : ''}</option>
                            ))}
                          </select>
                        </div>
                      )}
                      <div className="remote-conversation-history" aria-live="polite">
                        {selectedConversation?.state === 'unknown' && (
                          <div
                            className="remote-conversation-unknown-boundary"
                            data-testid="remote-conversation-unknown-boundary"
                            role="status"
                          >
                            <strong>자동 재실행을 중단했습니다.</strong>
                            <span>provider 반영 여부를 증명할 수 없어 새 지시·보관·복원을 잠갔습니다. 이 Mac에서 원래 AI 기록을 확인해야 합니다.</span>
                          </div>
                        )}
                        {(conversationPanel.historyFiltered || conversationPanel.historyTruncated) && (
                          <div className="remote-conversation-history-boundary" data-testid="remote-conversation-history-boundary">
                            {conversationPanel.historyFiltered
                              ? '도구 호출·명령·비공개 추론을 제외한 대화만 표시합니다.'
                              : ''}
                            {conversationPanel.historyFiltered && conversationPanel.historyTruncated ? ' ' : ''}
                            {conversationPanel.historyTruncated ? '전송 한도 때문에 최근 기록 일부만 표시합니다.' : ''}
                          </div>
                        )}
                        {conversationPanel.messages.map(message => (
                          <article className={`remote-conversation-message remote-conversation-message--${message.role}`} key={message.messageId}>
                            <span>{message.role === 'user'
                              ? '나'
                              : `${selectedConversation
                                ? remoteConversationAdapterLabel(selectedConversation.adapterId)
                                : '에이전트'}${message.phase === 'commentary' ? ' · 진행' : ''}`}</span>
                            <p>{message.text}</p>
                          </article>
                        ))}
                        {selectedPendingPrompts.map(prompt => (
                          <article
                            className="remote-conversation-message remote-conversation-message--user remote-conversation-message--pending"
                            key={prompt.requestId}
                          >
                            <span>나 · 전송됨</span>
                            <p>{prompt.text}</p>
                          </article>
                        ))}
                        {conversationPanel.events.slice(-12).map(event => (
                          <article
                            className={`remote-conversation-event remote-conversation-event--${event.type === 'conversation.artifact.summary' ? `artifact remote-conversation-event--artifact-${event.payload.kind}` : event.type === 'conversation.progress' ? 'progress' : 'lifecycle'}`}
                            data-kind={event.type === 'conversation.artifact.summary' ? event.payload.kind : undefined}
                            key={event.seq}
                          >
                            {event.type === 'conversation.artifact.summary' && <strong>{event.payload.label}</strong>}
                            <span>{remoteConversationEventText(event)}</span>
                          </article>
                        ))}
                        {selectedConversation && selectedConversation.state !== 'unknown'
                          && conversationPanel.messages.length === 0
                          && selectedPendingPrompts.length === 0
                          && conversationPanel.events.length === 0 && (
                          <p className="remote-task-empty">아직 표시할 대화 내용이 없습니다. 상태를 새로고침해 주세요.</p>
                        )}
                        {!selectedConversation && conversationPanel.archivedOnly && (
                          <p className="remote-task-empty">보관된 대화를 선택하면 필터링된 기록을 확인하고 다시 활성화할 수 있습니다.</p>
                        )}
                      </div>
                      {!conversationPanel.archivedOnly
                        && (!selectedConversation || selectedConversation.state === 'idle' || selectedConversation.state === 'running') && (
                        <label className="remote-conversation-prompt" htmlFor="remote-conversation-prompt">
                          {selectedConversation?.state === 'running' ? '추가 지시' : selectedConversation ? '이 대화에 이어서 말하기' : '새 대화 시작'}
                          <textarea
                            id="remote-conversation-prompt"
                            value={conversationPanel.prompt}
                            disabled={conversationPanel.busy}
                            maxLength={4_096}
                            rows={4}
                            placeholder="예: 현재 구조를 검토하고 다음 구현을 진행해줘"
                            onChange={event => updateConversationPanel({ prompt: event.target.value, error: '' })}
                          />
                        </label>
                      )}
                      <div className="remote-conversation-actions">
                        {!conversationPanel.archivedOnly
                          && (!selectedConversation || selectedConversation.state === 'idle' || selectedConversation.state === 'running') && (
                          <button
                            type="button"
                            className="remote-task-start"
                            disabled={conversationPanel.busy
                              || !conversationPanel.prompt.trim()
                              || (!selectedConversation && (!conversationPanel.selectedControlId || !conversationPanel.selectedModelId))}
                            onClick={() => void submitRemoteConversation()}
                          >
                            <Send aria-hidden="true" />{selectedConversation?.state === 'running' ? '추가 지시 보내기' : selectedConversation ? '계속 대화' : '새 대화 시작'}
                          </button>
                        )}
                        {selectedConversation?.state === 'running' && (
                          <button
                            type="button"
                            className="remote-task-cancel"
                            disabled={conversationPanel.busy}
                            onClick={() => void interruptRemoteConversation(selectedConversation)}
                          >
                            <Square aria-hidden="true" />응답 중지
                          </button>
                        )}
                        {selectedConversation && (selectedConversation.state === 'idle' || selectedConversation.state === 'archived') && (
                          selectedConversation.state === 'archived' ? (
                            <button
                              type="button"
                              disabled={conversationPanel.busy}
                              onClick={() => void unarchiveRemoteConversation(selectedConversation)}
                            >
                              <Archive aria-hidden="true" />대화 다시 활성화
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={conversationPanel.busy}
                              onClick={() => void archiveRemoteConversation(selectedConversation)}
                            >
                              <Archive aria-hidden="true" />대화 보관
                            </button>
                          )
                        )}
                        <button
                          type="button"
                          disabled={conversationPanel.busy}
                          onClick={() => void refreshRemoteConversationList()}
                        >
                          <RefreshCw aria-hidden="true" />대화 새로고침
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
          {AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED && (
          <section className="remote-task-console" data-testid="remote-codex-task-console">
            <div className="remote-task-console-heading">
              <div>
                <Bot aria-hidden="true" />
                <span><strong>Codex 작업</strong><small>이 Mac의 등록 프로젝트·워크트리에서 실행</small></span>
              </div>
              <button
                type="button"
                disabled={status.busy || taskPanel.busy || capabilityProbePending || taskHostUpdateRequired}
                onClick={() => taskPanel.open
                  ? updateTaskPanel({ open: false })
                  : void openRemoteTaskPanel()}
              >
                {capabilityProbePending
                  ? '호환성 확인 중…'
                  : taskHostUpdateRequired
                    ? '업데이트 필요'
                    : taskPanel.open ? '닫기' : '열기'}
              </button>
            </div>
            {capabilityProbePending && (
              <p className="remote-task-empty" role="status" data-testid="remote-task-capability-pending">
                이 Mac의 작업 지원 여부를 종단간 암호화된 연결로 확인하고 있습니다. 확인이 끝날 때까지 작업 열기는 잠시 비활성화됩니다.
              </p>
            )}
            {taskHostUpdateRequired && (
              <p className="remote-task-empty" role="status" data-testid="remote-task-host-update-required">
                이 Mac의 AgentsToZ 앱은 원격 Codex 작업을 지원하지 않는 이전 설치본입니다. Mac 앱을 최신 설치본으로 업데이트하고 완전히 다시 연 뒤 새로고침하세요. 아래 기본 프로젝트 제어는 계속 사용할 수 있습니다.
              </p>
            )}
            {!capabilityProbePending && !taskHostUpdateRequired && taskPanel.open && (
              <div className="remote-task-console-body">
                <p className="remote-task-safety">
                  프롬프트와 진행 결과는 종단간 암호화됩니다. 원격 실행은 workspace-write로 고정되며 위험 권한 우회 모드는 사용할 수 없습니다.
                </p>
                {taskPanel.busy && (
                  <div className="remote-task-loading" role="status"><Loader2 className="remote-spin" />Mac의 Codex 상태를 확인하는 중…</div>
                )}
                {taskPanel.error && <div className="remote-task-error" role="alert">{taskPanel.error}<ErrorVocActions message={taskPanel.error} surface="remote-tasks" /></div>}
                {taskPanel.available === false && (
                  <p className="remote-task-empty">
                    {taskPanel.blocker === 'host-update'
                      ? 'Mac 앱을 최신 설치본으로 업데이트하고 완전히 다시 연 뒤 새로고침하세요. 기존 QR 연결은 유지됩니다. 현재 production에서는 안전 격리가 준비되기 전까지 새 Codex 작업 실행을 제공하지 않습니다.'
                      : taskPanel.blocker === 'scope'
                        ? 'Mac 앱의 승인된 모바일 기기에서 이 기기의 “Codex 작업 권한”을 켜세요. QR을 다시 연결할 필요는 없습니다.'
                        : taskPanel.blocker === 'runtime'
                          ? '권한 문제는 아닙니다. 이 Mac 설치본의 Codex 런타임과 안전성 게이트가 아직 실행 가능 상태가 아닙니다.'
                          : '권한 또는 Mac 런타임 상태를 확정하지 못했습니다. 위 오류와 Mac 연결 상태를 확인하세요.'}
                  </p>
                )}
                {taskPanel.available === true && (
                  <>
                    <div className="remote-task-form-grid">
                      <label htmlFor="remote-task-project">프로젝트·워크트리</label>
                      <select
                        id="remote-task-project"
                        value={taskPanel.selectedControlId}
                        disabled={taskPanel.busy}
                        onChange={event => updateTaskPanel({ selectedControlId: event.target.value })}
                      >
                        {status.projects.map(project => (
                          <option value={project.controlId} key={project.controlId}>
                            {project.kind === 'worktree' ? '↳ ' : ''}{project.name}{project.branch ? ` · ${project.branch}` : ''}
                          </option>
                        ))}
                      </select>
                      <label htmlFor="remote-task-model">Codex 모델</label>
                      <select
                        id="remote-task-model"
                        value={taskPanel.selectedModelId}
                        disabled={taskPanel.busy}
                        onChange={event => updateTaskPanel({ selectedModelId: event.target.value })}
                      >
                        {taskPanel.models.map(model => (
                          <option value={model.modelId} key={model.modelId}>{model.label}{model.isDefault ? ' · 기본' : ''}</option>
                        ))}
                      </select>
                      <label htmlFor="remote-task-prompt">작업 내용</label>
                      <textarea
                        id="remote-task-prompt"
                        value={taskPanel.prompt}
                        disabled={taskPanel.busy}
                        maxLength={4_096}
                        rows={5}
                        placeholder="예: 현재 테스트 실패 원인을 찾아 수정하고 검증해줘"
                        onChange={event => updateTaskPanel({ prompt: event.target.value, error: '' })}
                      />
                    </div>
                    <button
                      type="button"
                      className="remote-task-start"
                      disabled={taskPanel.busy || !taskPanel.selectedControlId || !taskPanel.selectedModelId || !taskPanel.prompt.trim()}
                      onClick={() => void startRemoteTask()}
                    >
                      <Play aria-hidden="true" />Codex 작업 시작
                    </button>
                    <div className="remote-task-list-heading">
                      <span><ListTodo aria-hidden="true" />최근 작업</span>
                      <button type="button" disabled={taskPanel.busy} onClick={() => void refreshRemoteTaskList()}>
                        <RefreshCw aria-hidden="true" />상태 새로고침
                      </button>
                    </div>
                    <div className="remote-task-list">
                      {taskPanel.tasks.map(task => (
                        <article className={`remote-task-item remote-task-item--${task.status}`} key={task.taskId}>
                          <button type="button" className="remote-task-item-main" disabled={taskPanel.busy} onClick={() => void loadRemoteTaskEvents(task.taskId)}>
                            <strong>{task.projectLabel}</strong>
                            <span>{remoteTaskStatusLabel(task.status)} · {task.modelId ?? '기본 모델'}</span>
                          </button>
                          {remoteTaskIsActive(task.status) && (
                            <button type="button" className="remote-task-cancel" disabled={taskPanel.busy} onClick={() => void cancelRemoteTask(task)}>
                              <Square aria-hidden="true" />취소
                            </button>
                          )}
                        </article>
                      ))}
                      {taskPanel.tasks.length === 0 && <p className="remote-task-empty">이 Mac에서 확인할 수 있는 Codex 작업이 아직 없습니다.</p>}
                    </div>
                    {taskPanel.selectedTaskId && (
                      <div className="remote-task-timeline" aria-live="polite">
                        <h3>작업 진행 기록{selectedTaskStatus && remoteTaskIsActive(selectedTaskStatus) ? ' · 자동 확인 중' : ''}</h3>
                        {taskPanel.events.map(event => (
                          <div key={`${event.taskId}-${event.seq}`}>
                            <span>{event.seq}</span><p>{remoteTaskEventText(event)}</p>
                          </div>
                        ))}
                        {taskPanel.events.length === 0 && <p className="remote-task-empty">작업을 선택하면 구조화된 진행 기록을 불러옵니다.</p>}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </section>
          )}
          <section className="remote-project-create">
            <button type="button" className="remote-create-toggle" disabled={status.busy} onClick={() => {
              if (createProjectOpen) setCreateProjectOpen(false);
              else void openProjectCreator();
            }}>
              {createProjectOpen ? '프로젝트 추가 닫기' : '+ 이 Mac에 프로젝트 추가'}
            </button>
            {createProjectOpen && (
              <div className="remote-create-form">
                <p>등록된 작업 루트 아래에 새 폴더·Git 초기 커밋·DEV 장기기억을 만들고 프로젝트 목록에 등록합니다.</p>
                <label htmlFor="remote-project-root">작업 루트</label>
                <select id="remote-project-root" value={workspaceRootId} disabled={status.busy} onChange={event => changeProjectCreateDraft('root', event.target.value)}>
                  {status.workspaceRoots.map(root => <option value={root.controlId} key={root.controlId}>{root.name}</option>)}
                </select>
                <label htmlFor="remote-project-name">프로젝트 이름</label>
                <input id="remote-project-name" value={projectName} maxLength={120} autoComplete="off"
                  disabled={status.busy} onChange={event => changeProjectCreateDraft('name', event.target.value)} placeholder="예: 새로운 서비스" />
                {status.workspaceRoots.length === 0
                  ? <p className="remote-create-empty">사용 가능한 작업 루트가 없습니다. Mac 앱에서 작업 루트를 먼저 등록하세요.</p>
                  : <button type="button" disabled={status.busy || !projectName.trim() || !workspaceRootId} onClick={() => void createProject()}>프로젝트 만들기</button>}
              </div>
            )}
          </section>
          <section className="remote-project-filter">
            <label htmlFor="remote-project-search">이 Mac의 등록 프로젝트 · {status.projects.length}/{status.projectCount}개 불러옴</label>
            <input
              id="remote-project-search"
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="이름 · 별명 · 초성 · 한영 키보드 검색"
              autoComplete="off"
            />
            <label htmlFor="remote-project-root-filter">로컬 작업 루트</label>
            <select
              id="remote-project-root-filter"
              value={workspaceRootFilter}
              onChange={event => setWorkspaceRootFilter(event.target.value)}
            >
              <option value="">모든 작업 루트</option>
              {availableWorkspaceRoots.map(root => (
                <option key={root} value={`${WORKSPACE_ROOT_FILTER_PREFIX}${root}`}>{root}</option>
              ))}
              {status.projects.some(project => project.workspaceRoot === null) && (
                <option value={UNASSIGNED_WORKSPACE_ROOT}>작업 루트 없음</option>
              )}
            </select>
            {(query.trim() !== '' || workspaceRootFilter) && status.nextPage !== null && (
              <p className="remote-filter-partial" data-testid="remote-search-partial">
                {loadingAll
                  ? `전체 ${status.projectCount}개를 불러와 검색·필터링하는 중입니다…`
                  : `아직 ${status.projects.length}/${status.projectCount}개만 불러왔습니다.`}
                {!loadingAll && (
                  <button type="button" disabled={status.busy} onClick={() => void loadAllProjects()}>
                    전체 불러와서 필터링
                  </button>
                )}
              </p>
            )}
          </section>
          <section className="remote-projects" aria-live="polite">
            {/* 워크트리는 호스트가 이미 부모 바로 뒤에 놓아 보내지만, 평평하게
                깔면 어느 프로젝트의 워크트리인지 화면에서 읽히지 않는다.
                묶음 규칙은 src/remoteControlWorktreeGrouping.ts 한 곳이 정본이고
                같은 Wi-Fi QR 페이지도 같은 규칙을 쓴다. */}
            {groupRemoteControlCards(filteredProjects).map(row => (row.type === 'project' ? (
              <RemoteControlProjectCard
                key={row.card.controlId}
                project={row.card}
                busy={status.busy}
                    onWorkroom={openProjectWorkroom} onManage={project=>{setManagementTarget(project.controlId);setRemotePane('projects');navigateWorkspace('workroom');window.scrollTo(0,0)}}
                onAction={(target, action) => { void runProjectAction(target, action); }}
              />
            ) : (
              <section
                className="remote-worktree-group"
                data-testid="remote-worktree-group"
                key={`worktrees-${row.cards[0]?.controlId ?? 'none'}`}
                aria-label={row.parent ? `${row.parent.name} · ${remoteControlWorktreeGroupLabel(row.cards.length)}` : remoteControlWorktreeGroupLabel(row.cards.length)}
              >
                <p className="remote-worktree-group-title">
                  <FolderGit2 aria-hidden="true" />
                  {row.parent ? `${row.parent.name} · ` : ''}{remoteControlWorktreeGroupLabel(row.cards.length)}
                </p>
                {row.cards.map(card => (
                  <RemoteControlProjectCard
                    key={card.controlId}
                    project={card}
                    busy={status.busy}
                    onWorkroom={openProjectWorkroom} onManage={project=>{setManagementTarget(project.controlId);setRemotePane('projects');navigateWorkspace('workroom');window.scrollTo(0,0)}}
                    onAction={(target, action) => { void runProjectAction(target, action); }}
                  />
                ))}
              </section>
            )))}
            {status.projects.length === 0 && <div className="remote-empty">이 Mac에 원격으로 열 수 있는 등록 프로젝트가 없습니다.</div>}
            {status.projects.length > 0 && filteredProjects.length === 0 && status.nextPage === null && <div className="remote-empty">검색·필터 결과가 없습니다.</div>}
          </section>
          {/* Scrolling to the end loads the next 20 (VOC 2026-10-02: 「Mac엔 100개인데 폰엔 몇 개뿐」 — a button under
              the voice dock at the very bottom was easy to miss). The button stays for keyboards and older WebViews. */}
          {status.nextPage !== null && (
            <IncrementalListMore shown={status.projects.length} total={Math.max(status.projectCount, status.projects.length + 1)}
              onMore={loadMoreProjectsOnce} testId="remote-load-more" label="다음 프로젝트 불러오기" />
          )}

          <button type="button" className="remote-disconnect" onClick={() => void disconnectHost(selectedHostId)}>
            <Power aria-hidden="true" />{hosts.length > 1 ? '선택한 Mac 연결 해제' : '이 기기 연결 해제'}
          </button>
        </>
      ) : (
        <section className="remote-panel remote-centered">
          <LockKeyhole aria-hidden="true" />
          <h2>연결이 종료되었습니다</h2>
          <p>안전을 위해 Mac에서 새 일회용 QR을 발급해 다시 연결해 주세요.</p>
          <p className="remote-reload-hint">
            Mac 앱을 업데이트한 뒤라면 이 화면이 오래된 버전일 수 있습니다.
          </p>
        </section>
      )}
      {/* The Mac app and this page ship separately, so a phone can hold a bundle
          older than the Mac after a protocol bump. Previously this was gated on
          `status.state !== 'online'` — exactly backwards: a phone on a stale
          bundle usually connects fine and simply lacks the newest UI, so the
          escape hatch was hidden whenever it was actually needed. Sealed
          sessions live in IndexedDB and survive the reload. */}
      <button type="button" className="remote-reload" data-testid="remote-reload-app" onClick={() => void reloadApp()}>
        <RefreshCw aria-hidden="true" />화면 새로 불러오기
      </button>

      {/* Which bundle is this? The portal deploys to Vercel independently of the
          Mac app, so "the deploy must not be out yet" and "my phone cached the
          old one" look identical without a stamp. The short commit is what makes
          the two distinguishable against the repository. */}
      <p className="remote-build-stamp" data-testid="remote-build-stamp">
        v{BUILD_INFO.buildNumber}
        {BUILD_INFO.sourceCommit ? ` · ${BUILD_INFO.sourceCommit.slice(0, 7)}` : ''}
        {BUILD_INFO.builtAt ? ` · ${formatBuildTime(BUILD_INFO.builtAt)}` : ''}
      </p>
      </div>
      {selectedController&&<React.Fragment key={selectedHostId??'none'}>
        <RemoteOpsVoiceHost projects={voiceProjects} transport={workroomTransport}/>
        <AgentsToZVoiceDock remote transport={opsVoiceTransport} deviceName={status.hostName??undefined}
          onOpenOpsWorkroom={()=>{void openOps();}}
          opsDevices={communityDevices.map(device=>({key:device.ref,name:communityDeviceLabel(device.name)}))}
          onOpenDeviceWorkroom={communityDevices.length?(key:string)=>{const device=communityDevices.find(item=>item.ref===key);if(device)driveCommunityDevice(device,{ops:true});}:undefined} opsMissing={!opsVoiceProject} workroomFallback={workroomVoiceFallback} unavailableStatus={status.state!=='online'?'Mac 연결 끊김':undefined} unavailableReason={status.state!=='online'?'Mac 연결이 끊겼습니다. 다시 연결되면 눌러 주세요.':undefined}/>
      </React.Fragment>}
    </main>
    </ErrorVocProvider>
  );
}

const workspaceWindow = window as Window & { __agentstozWorkspaceRoot?: Root };
const root = workspaceWindow.__agentstozWorkspaceRoot ?? createRoot(document.getElementById('root')!);
workspaceWindow.__agentstozWorkspaceRoot = root;
root.render(FOREIGN_PAIRING
  ? <ForeignPairingPage qrSupabaseUrl={FOREIGN_PAIRING.qrSupabaseUrl} />
  : <RemoteControlPortalApp />);
