import {AiTerminalPanel} from './AiTerminalPanel';
import type {AiTerminalRequest} from './aiTerminalProtocol';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Archive, BookMarked, Bot, Brain, CheckCircle2, FolderGit2, LayoutDashboard, ListTodo, Loader2,
  LockKeyhole, MessageSquare, Monitor, Play, Power, RefreshCw, ScanLine, Send,
  ShieldCheck, Smartphone, Square, X,
} from 'lucide-react';
import { getAuthenticatedSupabaseClient } from './lib/supabaseClient';
import { RemoteControlRelayBootstrapVault } from './remoteControlRelayBootstrapVault';
import {
  REMOTE_CONTROL_HOST_SILENT_MS,
  REMOTE_CONTROL_HOST_UPDATE_REQUIRED,
  REMOTE_CONTROL_SELECTED_HOST_POLL_MS,
  RemoteControlRelayController,
  RemoteControlRelayControllerManager,
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
import { RemoteControlProjectCard, remoteControlActionLabel } from './RemoteControlProjectCard';
import { groupRemoteControlCards, remoteControlWorktreeGroupLabel } from './remoteControlWorktreeGrouping';
import {
  REMOTE_CONTROL_PORTAL_MAX_PAGE,
  loadedPageDepthForHost,
  progressingRemoteControlPage,
  rememberLoadedPageDepth,
} from './remoteControlPortalPagination';
import { normalizeSearchText } from './searchText';
import { buildClientErrorReport } from './clientErrorReport';
import { BUILD_INFO, formatBuildTime } from './buildInfo';
import {
  portalMembershipFailureMessage,
  verifyPortalMembership,
  type PortalMembershipRpcClient,
} from './portalMembership';
import {
  clearStoredPortalAuth,
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
  }
}

// `remote/index.html` removes the fragment before this module and its imports
// execute. Take the in-memory copy once, then erase the global reference.
const capturedPairingFragment = window.__agentstozRemotePairingFragment ?? '';
try { delete window.__agentstozRemotePairingFragment; } catch { window.__agentstozRemotePairingFragment = ''; }

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() ?? '';
const SUPABASE_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() ?? '';
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
  busy: false,
  error: null,
  hostLastSeenAt: null,
};

function controllerPairingUrl(fragment: string): string | null {
  if (!fragment) return null;
  const url = `${window.location.origin}/remote/#${fragment}`;
  const parsed = parseRemoteControlRelayPairingUrl(url);
  return new URL(parsed.controllerUrl).origin === window.location.origin ? url : null;
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

function userFacingError(value: unknown): string {
  const token = errorToken(value);
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

const controllerStateLabels: Record<RemoteControlRelayControllerStatus['state'], string> = {
  idle: '연결 준비',
  claiming: '보안 확인',
  'approval-required': 'Mac 승인 대기',
  connecting: '연결 중',
  online: '연결됨',
  closed: '종료됨',
  error: '연결 오류',
};

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
  const [error, setErrorMessage] = useState('');
  // The token behind `error`, kept separate so the human sentence stays clean
  // while the code remains visible and copyable. Cleared whenever error is.
  const [errorDetail, setErrorDetail] = useState('');
  // Plain-text errors carry no token; clearing the detail here keeps a stale
  // code from being shown under an unrelated message.
  const setError = useCallback((message: string) => {
    setErrorMessage(message);
    setErrorDetail('');
  }, []);
  // A thrown failure: show the sentence, keep the code beside it.
  const reportError = useCallback((value: unknown) => {
    setErrorMessage(userFacingError(value));
    setErrorDetail(remoteControlErrorDetail(value));
  }, []);
  const [reportSending, setReportSending] = useState(false);
  const [notice, setNotice] = useState('');
  const [terminalOpen,setTerminalOpen]=useState(false);
  const [query, setQuery] = useState('');
  const [workspaceRootFilter, setWorkspaceRootFilter] = useState('');
  const [loadingAll, setLoadingAll] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // How many pages each host has served so far. This is per Mac: switching
  // A -> B -> A must restore A's depth instead of inheriting or resetting it.
  const loadedPageCountsByHostRef = useRef(new Map<string, number>());
  const searchSweptHostsRef = useRef(new Set<string>());
  const workspaceRootsRequestedHostsRef = useRef(new Set<string>());
  const [loginBusy, setLoginBusy] = useState(false);
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
  const selectedController = manager.controller(selectedHostId);
  const terminalTransport=useCallback((request:AiTerminalRequest)=>{
    if(!selectedController)throw new Error('연결된 Mac이 없습니다.');
    return selectedController.sendTerminal(request);
  },[selectedController]);
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
    // 데스크톱과 같은 정규화를 쓴다(`normalizeSearchText`, NFKC). raw
    // toLocaleLowerCase 만 쓰면 macOS 파일명에서 흔한 분해형(NFD) 한글이
    // IME 로 친 완성형(NFC) 질의와 매칭되지 않아, 로컬에서는 찾아지는 이름이
    // 휴대폰에서만 검색되지 않는다 (데스크톱은 VOC 2026-08-24-1402 로 이미 고쳤다).
    const normalized = normalizeSearchText(query.trim());
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
      normalizeSearchText(project.name).includes(normalized)
      || normalizeSearchText(project.alias ?? '').includes(normalized)
      || normalizeSearchText(project.branch ?? '').includes(normalized)
    ));
  }, [query, workspaceRootFilter, status.projects]);

  const syncHosts = () => setHosts(manager.statuses());

  const applySelection = (hostId: string | null) => {
    selectedHostIdRef.current = hostId;
    setSelectedHostId(hostId);
    writeSelectedHostId(hostId);
    setTaskPanelState(hostId
      ? taskPanelsByHostRef.current.get(hostId) ?? { ...EMPTY_TASK_PANEL }
      : { ...EMPTY_TASK_PANEL });
    setConversationPanelState(hostId
      ? conversationPanelsByHostRef.current.get(hostId) ?? { ...EMPTY_CONVERSATION_PANEL }
      : { ...EMPTY_CONVERSATION_PANEL });
  };

  const selectHost = (hostId: string | null) => {
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
    let stalled = false;
    let revision = 0;
    const verifySession = async (sessionEmail: string, expectedRevision: number) => {
      const membership = await verifyPortalMembership(supabase as unknown as PortalMembershipRpcClient);
      if (cancelled || expectedRevision !== revision) return;
      setLoginBusy(false);
      if (membership.state === 'member') {
        setMembershipError('');
        setEmail(sessionEmail);
        setAuthState('signed-in');
        // OAuth's temporary `code` is no longer needed after the SDK creates a
        // session. The QR bootstrap was never stored in this query.
        window.history.replaceState(null, '', '/remote/');
        return;
      }
      setEmail(sessionEmail);
      setMembershipError(portalMembershipFailureMessage(membership, sessionEmail));
      setAuthState(membership.state === 'denied' ? 'denied' : 'verification-error');
    };
    const observeSession = (sessionEmail: string) => {
      if (stalled) return;
      const expectedRevision = ++revision;
      if (!sessionEmail) {
        setEmail('');
        setMembershipError('');
        setLoginBusy(false);
        setAuthState('signed-out');
        return;
      }
      setEmail(sessionEmail);
      setAuthState('checking');
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
          stalled = true;
          setLoginBusy(false);
          setMembershipError(`Google 로그인 상태를 확인하지 못했습니다. (${portalAuthErrorMessage(sessionError)})`);
          setAuthState('verification-error');
          return;
        }
        observeSession(data.session?.user?.email ?? '');
      } catch (sessionError) {
        if (cancelled) return;
        stalled = true;
        setLoginBusy(false);
        setMembershipError(
          `저장된 Google 로그인 상태 확인이 끝나지 않았습니다. 다시 확인하거나 이 기기의 로그인만 초기화해 주세요. (${portalAuthErrorMessage(sessionError)})`,
        );
        setAuthState('verification-error');
      }
    })();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled || stalled) return;
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
      controllerName: '휴대폰·iPad 웹',
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
            if (!cancelled && hostId === selected) reportError(refreshError);
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
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [authState, livePollTargets]);

  const login = async (changeAccount = false) => {
    if (!supabase || sources.length === 0) return;
    setLoginBusy(true);
    setError('');
    try {
      // Keep every one-use QR bootstrap sealed across the full-page OAuth
      // redirect, including an explicit switch away from a denied account.
      for (const source of sources) {
        const pairingUrl = source.pairingUrl;
        if (pairingUrl) await vaultRef.current?.seal(pairingUrl);
      }
      // Prove that Auth and the Google provider answer before discarding a
      // denied account or leaving this recoverable page for `/authorize`.
      await preflightPortalGoogleOAuth({
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
      const authorizeUrl = await createPortalGoogleOAuthUrl({
        client: supabase,
        supabaseUrl: SUPABASE_URL,
        redirectTo: `${window.location.origin}/remote/`,
      });
      window.location.assign(authorizeUrl);
    } catch (loginError) {
      const message = portalOAuthStartErrorMessage(loginError);
      setErrorMessage(message);
      setErrorDetail(errorToken(loginError).slice(0, 240) || 'PORTAL_AUTH_OAUTH_FAILED');
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
          ? `${host} · ${project.name}: 새 Codex 대화를 만들고 검증했습니다. ChatGPT Codex 앱에 그 대화를 여는 요청도 전달했습니다.`
          : action === 'app.hermes'
            ? `${host} · ${project.name}: 최근 Hermes 대화 열기 요청을 Mac에 전달했습니다. 실제 대화 선택은 Mac의 Hermes Desktop에서 확인하세요.`
            : `${host} · ${project.name}: ${remoteControlActionLabel(action)} 요청을 완료했습니다.`);
      }
    } catch (actionError) {
      // Leaving the "기다리는 중" line up next to a failure reads as if the work
      // were still going.
      if (selectedHostIdRef.current === hostId) {
        setNotice('');
        reportError(actionError);
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
      if (selectedHostIdRef.current === hostId) reportError(rootError);
    }
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
      await controller.sendAction('project.create', undefined, undefined, name, root.controlId);
      syncHosts();
      if (selectedHostIdRef.current === hostId) {
        setProjectName('');
        setCreateProjectOpen(false);
        setNotice(`${name} 프로젝트를 만들고 이 Mac의 AgentsToZ에 등록했습니다. 새 Codex 대화가 필요하면 새 카드의 “새 Codex 대화 만들기”를 사용하세요.`);
      }
    } catch (createError) {
      if (selectedHostIdRef.current === hostId) reportError(createError);
    }
  };

  /**
   * Disconnects exactly one Mac. The others keep their approved sessions, so
   * this is also the per-chip remove control — a phone that has met several
   * Macs must be able to drop the one it no longer uses without re-pairing the
   * rest.
   */
  const disconnectHost = async (hostId: string | null, confirmFirst = hosts.length > 1) => {
    if (!hostId) return;
    const target = hosts.find(host => host.hostId === hostId);
    if (confirmFirst && !window.confirm(
      `${target ? hostLabel(target) : '이 Mac'}\n\n이 Mac 연결만 해제할까요? 다른 Mac 연결은 그대로 유지됩니다.`,
    )) return;
    setError('');
    setNotice('');
    try {
      await manager.controller(hostId)?.revoke();
    } catch (revokeError) {
      reportError(revokeError);
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
      setSources(current => current.filter(source => source.hostId !== hostId));
      syncHosts();
    }
  };

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
      for (let page = 0; page < loadedPages; page += 1) {
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
      if (selectedHostIdRef.current === sweepingHostId) reportError(loadError);
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

  return (
    <main className="remote-shell" data-testid="internet-remote-controller">
      <header className="remote-header">
        <div className="remote-brand">AZ</div>
        <div className="remote-heading">
          <p>EXTERNAL INTERNET · E2E</p>
          <h1>{status.hostName ?? 'AgentsToZ 원격제어'}</h1>
        </div>
        <span className={`remote-state remote-state--${status.state}`}>{controllerStateLabels[status.state]}</span>
      </header>

      {/* Shown from the first Mac on, not only from the second: the chip also
          carries that Mac's connection dot and its remove control, and a row
          that appeared out of nowhere on a second QR would never teach anyone
          that switching Macs exists. */}
      {hosts.length > 0 && (
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
                title={`${hostLabel(host)} · ${controllerStateLabels[host.status.state]}`}
                onClick={() => selectHost(host.hostId)}
              >
                <span className={`remote-host-dot remote-host-dot--${host.status.state}`} aria-hidden="true" />
                <span className="remote-host-tab-name">{hostLabel(host)}</span>
                {host.status.busy ? (
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

      <nav className="remote-portal-nav" aria-label="AgentsToZ 포털 이동">
        <a href="/"><LayoutDashboard aria-hidden="true" />포털 홈</a>
        <a href="/?tab=ports"><FolderGit2 aria-hidden="true" />프로젝트</a>
        <a href="/?tab=bookmarks"><BookMarked aria-hidden="true" />북마크</a>
        <a href="/?tab=memories"><Brain aria-hidden="true" />장기기억</a>
      </nav>

      {/* The resume note below tells the user to scan a new QR to add another
          Mac, but the scanner lived only in the portal header — a different
          screen. Put the entry point where the instruction is. */}
      <a className="remote-portal-scan" href="/?scan=remote" data-testid="remote-portal-scan">
        <ScanLine aria-hidden="true" />
        <span>다른 Mac 추가 · QR 스캔</span>
      </a>

      {(status.state === 'approval-required' || status.state === 'connecting' || status.state === 'online') && (
        <p className="remote-resume-note" role="status">
          이 연결은 이 기기에 암호화해 보관됩니다. 포털의 다른 화면으로 이동하거나 홈 화면 앱을 닫아도 만료 전에는 원격제어로 돌아와 이어갈 수 있습니다. 다른 Mac을 추가하려면 그 Mac의 AgentsToZ에서 외부 인터넷 QR을 새로 발급해 스캔하세요. 지금 연결은 그대로 유지됩니다.
        </p>
      )}

      <section className="remote-security-note">
        <ShieldCheck aria-hidden="true" />
        <p>기본 제어는 암호화된 등록 ID를 사용합니다. 별도 승인한 AI 작업·대화는 프롬프트와 결과를, AI 터미널은 CLI 입력과 화면 출력을 종단간 암호화해 전달합니다. 터미널에 표시되는 경로·계정 정보도 포함될 수 있습니다.</p>
      </section>

      {(error || status.error) && (
        <div className="remote-alert" role="alert">
          <p>{error || status.error}</p>
          {errorDetail && (
            <div className="remote-alert-detail">
              <code>{errorDetail}</code>
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
              {/* The phone cannot reach the Mac's localhost VOC endpoint, so the
                  report goes to the shared database and the desktop app reads it
                  back under 장기기억·VOC. Failing to send must not replace the
                  error the user is already looking at. */}
              <button
                type="button"
                data-testid="remote-report-error"
                disabled={!supabase || reportSending}
                onClick={() => {
                  if (!supabase) return;
                  setReportSending(true);
                  const row = buildClientErrorReport({
                    deviceId: selectedHostId,
                    deviceName: status.hostName,
                    surface: 'remote-control',
                    code: errorDetail || 'REMOTE_CONTROL_FAILED',
                    message: error || status.error || '',
                    detail: 'state: ' + status.state,
                    appVersion: null,
                  });
                  void supabase.from('portmgr_client_errors').insert(row).then(
                    ({ error: insertError }: { error: { message?: string } | null }) => {
                      setReportSending(false);
                      setNotice(insertError
                        ? `오류 보고를 저장하지 못했습니다. (${insertError.message ?? '알 수 없음'})`
                        : 'Mac의 AgentsToZ 앱에서 이 오류를 확인할 수 있습니다.');
                    },
                    () => {
                      setReportSending(false);
                      setNotice('오류 보고를 저장하지 못했습니다.');
                    },
                  );
                }}
              >
                {reportSending ? '보내는 중…' : 'Mac으로 오류 보내기'}
              </button>
            </div>
          )}
        </div>
      )}
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
        <section className="remote-panel remote-centered">
          <Smartphone aria-hidden="true" />
          <h2>새 QR이 필요합니다</h2>
          <p>Mac의 AgentsToZ에서 외부 인터넷 QR을 새로 발급한 뒤 다시 스캔해 주세요.</p>
        </section>
      ) : authState === 'verification-error' ? (
        <section className="remote-panel remote-centered">
          <LockKeyhole aria-hidden="true" />
          <h2>DB 회원 권한을 확인하지 못했습니다</h2>
          <p>{membershipError || '최신 Supabase 마이그레이션과 네트워크를 확인해 주세요.'}</p>
          <button className="remote-primary" type="button" onClick={() => setMembershipRetryNonce(value => value + 1)}>
            <RefreshCw aria-hidden="true" />다시 확인
          </button>
          <button className="remote-secondary" type="button" onClick={resetStoredLogin}>
            이 기기 로그인 초기화
          </button>
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
          <h2>내 개인 배포본으로 로그인</h2>
          <p>QR 비밀은 이 브라우저 안에 암호화해 보관한 뒤 Google 로그인으로 본인 계정을 확인합니다.</p>
          <button className="remote-primary" type="button" disabled={sources.length === 0 || loginBusy} onClick={() => void login(false)}>
            {loginBusy ? <Loader2 className="remote-spin" aria-hidden="true" /> : <LockKeyhole aria-hidden="true" />}
            Google 계정으로 계속
          </button>
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
            <div data-testid="remote-host-liveness">
              <CheckCircle2 aria-hidden="true" />
              <span>{status.hostName} · {hostLiveness(status.hostLastSeenAt)}</span>
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
          <section className="remote-task-console remote-conversation-console" data-testid="remote-codex-conversation-console">
            <div className="remote-task-console-heading">
              <div>
                <MessageSquare aria-hidden="true" />
                <span><strong>Codex</strong><small>원격 대화 · 현재는 읽기 전용</small></span>
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
                {taskPanel.error && <div className="remote-task-error" role="alert">{taskPanel.error}</div>}
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
                <select id="remote-project-root" value={workspaceRootId} onChange={event => setWorkspaceRootId(event.target.value)}>
                  {status.workspaceRoots.map(root => <option value={root.controlId} key={root.controlId}>{root.name}</option>)}
                </select>
                <label htmlFor="remote-project-name">프로젝트 이름</label>
                <input id="remote-project-name" value={projectName} maxLength={120} autoComplete="off"
                  onChange={event => setProjectName(event.target.value)} placeholder="예: 새로운 서비스" />
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
              placeholder="이름 · 별명 · 브랜치로 검색"
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
                    onAction={(target, action) => { void runProjectAction(target, action); }}
                  />
                ))}
              </section>
            )))}
            {status.projects.length === 0 && <div className="remote-empty">이 Mac에 원격으로 열 수 있는 등록 프로젝트가 없습니다.</div>}
            {status.projects.length > 0 && filteredProjects.length === 0 && status.nextPage === null && <div className="remote-empty">검색·필터 결과가 없습니다.</div>}
          </section>
          {status.nextPage !== null && (
            <button type="button" className="remote-load-more" disabled={status.busy} onClick={() => void loadMoreProjects()}>
              다음 프로젝트 불러오기
            </button>
          )}
          <button type="button" className="remote-disconnect" onClick={()=>setTerminalOpen(v=>!v)}>워크룸 · AI 터미널 {terminalOpen?'닫기':'열기'}</button>
          {terminalOpen && <div className="remote-panel" key={selectedHostId??'none'}><AiTerminalPanel remote sessionScope={selectedHostId??'none'} projects={status.projects.map(p=>({targetId:p.controlId,label:p.name}))} transport={terminalTransport}/></div>}
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
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<RemoteControlPortalApp />);
