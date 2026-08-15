import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, FolderOpen, Gauge, Loader2, RefreshCw, X } from 'lucide-react';
import { isTauri } from '../lib/env';
import { projectMemoryApi } from '../ProjectMemoryPanel';
import type { ProjectMemoryRemoteState } from '../projectMemorySyncState';
import {
  contextSessionActivityColor,
  contextSessionActivityLabel,
  contextSurfacePresenceBadge,
  hiddenUnverifiedContextSurfaceCount,
  visibleContextSessions,
} from '../contextSessionVisibility';
import type { ContextSurfacePresence } from '../contextSessionVisibility';
import {
  CONTEXT_API_SCHEMA_VERSION,
  classifyContextApiVersion,
  contextApiOutdatedMessage,
  type ContextApiVersionReport,
} from '../contextApiVersion';
import type { ContextProjectNavigationCandidate } from '../contextProjectNavigation';
import { resolveContextSessionProjectBinding } from '../contextSessionProject';
import type { ContextSessionProjectHint } from '../contextSessionMetadata';
import type { ProjectCodexVoiceBindingState } from '../projectCodexVoice';
import {
  PROJECT_ROOT_MISSING,
  sessionMemoryAction,
  type SessionMemoryStatusState,
} from './aiUsageMemoryState';

/**
 * Shows Claude and Codex usage side by side.
 *
 * The two sources are not equivalent, and the UI says so rather than implying
 * they are the same measurement:
 *  - Claude runs `claude -p "/usage"`, i.e. the same report the interactive
 *    `/usage` command prints. Live, takes a few seconds.
 *  - Codex is queried through its read-only app-server account endpoint.  If the
 *    local CLI is offline or too old, the panel falls back to its latest session
 *    rollout snapshot and makes that lower-freshness source explicit.
 */

const apiBase = () => (isTauri() ? 'http://127.0.0.1:3001' : '');

interface CodexRateLimits {
  primary?: { used_percent?: number; window_minutes?: number; resets_at?: number } | null;
  secondary?: { used_percent?: number; window_minutes?: number; resets_at?: number } | null;
  credits?: { has_credits?: boolean; unlimited?: boolean; balance?: string | null } | null;
  plan_type?: string | null;
}

type CodexUsageSource = 'live-app-server' | 'session-log';

const formatWindow = (minutes?: number) => {
  if (!minutes) return '';
  if (minutes % 10080 === 0) return `${minutes / 10080}주`;
  if (minutes % 1440 === 0) return `${minutes / 1440}일`;
  if (minutes % 60 === 0) return `${minutes / 60}시간`;
  return `${minutes}분`;
};

const rateLimitLabel = (minutes: number | null | undefined, fallback: string) => {
  if (!minutes) return fallback;
  if (minutes === 10080) return '주간 한도';
  if (minutes === 300) return '5시간 한도';
  if (minutes % 1440 === 0) return `${minutes / 1440}일 한도`;
  if (minutes % 60 === 0) return `${minutes / 60}시간 한도`;
  return `${minutes}분 한도`;
};

const formatReset = (epochSeconds?: number) => {
  if (!epochSeconds) return '';
  const d = new Date(epochSeconds * 1000);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())} 초기화`;
};

function UsageBar({ percent }: { percent: number | null }) {
  if (typeof percent !== 'number') {
    return (
      <div title="이 Voice 대화에는 컨텍스트 사용량 기록이 없습니다." style={{ height: 6, background: 'rgba(255,255,255,0.07)', borderRadius: 3 }} />
    );
  }
  const pct = Math.max(0, Math.min(100, percent));
  const color = pct >= 90 ? '#f87171' : pct >= 70 ? '#fbbf24' : '#5eead4';
  return (
    <div style={{ height: 6, background: 'rgba(255,255,255,0.07)', borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3, transition: 'width 0.3s' }} />
    </div>
  );
}

interface ContextSession {
  sessionId: string;
  sourceAgent: 'claude' | 'codex';
  cwd: string | null;
  /** Original cwd from the session record, retained so a completed move can
   * be explained without treating its old scratch directory as a project. */
  initialCwd?: string | null;
  projectDir?: string | null;
  threadSource?: string | null;
  threadTitle?: string | null;
  projectHint?: ContextSessionProjectHint | null;
  modelId: string | null;
  modelName: string | null;
  windowSize: number | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  usedTokens: number | null;
  costUsd: number | null;
  ageMs: number;
  state: 'active' | 'idle' | 'stale';
  clientLabel: string;
  surfaceKind: string;
  surfaceLabel: string;
  surfaceDetail: string | null;
  /** Runtime presence for integrations such as Orca and cmux.  Snapshot
   * freshness is intentionally a separate field (`state`). */
  surfacePresence?: ContextSurfacePresence | null;
  /** Project binding for a ChatGPT Desktop `realtime_voice` rollout. This is
   * independent of whether the Voice rollout emitted a token-count event. */
  voiceBindingState?: ProjectCodexVoiceBindingState;
  navigation?: {
    available: boolean;
    kind: string | null;
    exact: boolean;
    actionLabel: string | null;
    detail: string;
  };
}

/** A Voice row may show a remembered project assignment before it is safe to
 * use that project's durable memory. Only an applied assignment with either a
 * confirmed project execution or no turn yet is allowed to reach the memory
 * API. This fails closed when an older sidecar cannot supply binding state. */
const voiceProjectMemoryIsBlocked = (session: ContextSession): boolean => (
  session.sourceAgent === 'codex'
  && session.threadSource === 'realtime_voice'
  && !!session.projectHint
  && session.voiceBindingState !== 'execution-confirmed'
  && session.voiceBindingState !== 'assigned-awaiting-execution'
);

const contextPathLeaf = (folderPath: string | null | undefined, fallback: string): string => (
  folderPath?.replace(/[/\\]+$/, '').split(/[/\\]/).filter(Boolean).pop() || fallback
);

/** The currently assigned project can differ from the rollout cwd while the
 * ChatGPT desktop client applies a project move. */
const contextSessionProjectPath = (session: ContextSession): string | null => (
  session.projectHint?.path ?? session.projectDir ?? session.cwd
);

/** Voice project moves must fail closed: a scratch/subfolder can resolve back
 * to a main worktree's memory root, so do not even probe memory until the
 * Voice binding is verified. Non-Voice relocation keeps its existing cwd
 * behavior. */
const contextSessionMemoryPath = (session: ContextSession): string | null => (
  voiceProjectMemoryIsBlocked(session)
    ? null
    : session.projectHint?.moveState === 'pending'
    || session.voiceBindingState === 'move-pending'
    || session.voiceBindingState === 'scope-conflict'
      ? session.cwd
      : contextSessionProjectPath(session)
);

const contextPathsDiffer = (left: string | null | undefined, right: string | null | undefined): boolean => {
  const normalize = (value: string | null | undefined) => value?.replace(/\\/g, '/').replace(/\/+$/, '') || null;
  const a = normalize(left);
  const b = normalize(right);
  return !!a && !!b && a !== b;
};

/** Past this much of the window, compaction is close enough to be worth acting on. */
const REMEMBER_THRESHOLD = 75;

const compactTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);

const formatAge = (ms: number) => {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  return `${Math.floor(m / 60)}시간 전`;
};

const voiceBindingBadge = (state: ProjectCodexVoiceBindingState | undefined): {
  label: string;
  title: string;
  tone: string;
} | null => {
  switch (state) {
    case 'execution-confirmed':
      return { label: '프로젝트 실행 확인', title: '최근 Voice 실행 경로와 프로젝트 배정이 모두 이 프로젝트로 확인되었습니다. 마이크 활성 상태는 별도로 확인해야 합니다.', tone: '#99f6e4' };
    case 'assigned-awaiting-execution':
      return { label: '프로젝트 배정됨', title: 'Voice 대화는 프로젝트에 배정되었지만, 실제 실행 경로가 담긴 Voice turn은 아직 기록되지 않았습니다.', tone: '#bfdbfe' };
    case 'move-pending':
      return { label: '이동 적용 대기', title: '프로젝트 이동 요청은 기록됐지만 Voice의 실제 작업 폴더는 아직 바뀌지 않았습니다.', tone: '#fde68a' };
    case 'scope-conflict':
      return { label: '실행 경로 불일치', title: 'Voice 대화의 프로젝트 배정과 최근 실행 경로가 다릅니다. 대상 프로젝트 장기기억으로 연결하지 않습니다.', tone: '#fca5a5' };
    case 'not-associated':
      return { label: '프로젝트 미연결', title: '이 Voice 대화의 로컬 Codex 프로젝트 배정 기록을 찾지 못했습니다.', tone: '#a1a1aa' };
    case 'unverifiable':
      return { label: '연결 확인 불가', title: 'ChatGPT Desktop의 로컬 프로젝트 또는 Voice 기록을 읽을 수 없어 연결 여부를 판단하지 않았습니다.', tone: '#a1a1aa' };
    default:
      return null;
  }
};

interface AiUsagePanelProps {
  onClose: () => void;
  /** Opens the registered project that owns a context-session cwd. */
  onOpenProject?: (folderPath: string) => void;
  canOpenProject?: (folderPath: string) => boolean;
  /** Registered project and worktree roots, with their display names. */
  contextProjectCandidates?: readonly ContextProjectNavigationCandidate[];
  /** Opens Claude's Agent View, the only place a background agent can be
   * reached. Handled by the app rather than the API because the terminal
   * surface is a header setting the server does not see. */
  onOpenAgentView?: (folderPath: string | null) => Promise<string>;
}

export function AiUsagePanel({
  onClose,
  onOpenProject,
  canOpenProject,
  contextProjectCandidates = [],
  onOpenAgentView,
}: AiUsagePanelProps) {
  const [claude, setClaude] = useState<{ loading: boolean; report?: string; error?: string }>({ loading: true });
  const [codex, setCodex] = useState<{
    loading: boolean;
    data?: CodexRateLimits;
    checkedAt?: string;
    source?: CodexUsageSource;
    error?: string;
  }>({ loading: true });

  const loadClaude = useCallback(async () => {
    setClaude({ loading: true });
    try {
      const res = await fetch(`${apiBase()}/api/ai-usage/claude`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `요청 실패 (${res.status})`);
      setClaude({ loading: false, report: json.report });
    } catch (e: any) {
      setClaude({ loading: false, error: e?.message || String(e) });
    }
  }, []);

  const loadCodex = useCallback(async (fresh = false) => {
    setCodex({ loading: true });
    try {
      const res = await fetch(`${apiBase()}/api/ai-usage/codex${fresh ? '?fresh=1' : ''}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `요청 실패 (${res.status})`);
      setCodex({
        loading: false,
        data: json.rateLimits,
        checkedAt: json.checkedAt ?? json.recordedAt,
        source: json.source === 'session-log' ? 'session-log' : 'live-app-server',
      });
    } catch (e: any) {
      setCodex({ loading: false, error: e?.message || String(e) });
    }
  }, []);

  const [ctx, setCtx] = useState<{ loading: boolean; sessions?: ContextSession[]; installed?: boolean; error?: string }>({ loading: true });
  const [focusingSessionId, setFocusingSessionId] = useState<string | null>(null);
  const [focusResult, setFocusResult] = useState<{ sessionId: string; success: boolean; message: string } | null>(null);
  const [rememberingSessionId, setRememberingSessionId] = useState<string | null>(null);
  const [rememberResult, setRememberResult] = useState<{ sessionId: string; success: boolean; message: string } | null>(null);
  const [memoryStatusByPath, setMemoryStatusByPath] = useState<Record<string, SessionMemoryStatusState>>({});
  // The probe effect needs the newest statuses to honour the 30s cache, but it
  // must not re-run when they change — that re-entry is what broke the queue.
  // A ref gives it fresh reads without becoming a dependency.
  const memoryStatusRef = useRef(memoryStatusByPath);
  memoryStatusRef.current = memoryStatusByPath;
  const inFlightMemoryProbes = useRef<Set<string>>(new Set());
  // Runtime surface probes can take a few seconds.  Keep the five-second poll
  // from queuing overlapping context-usage requests when a prior probe is slow.
  const contextRequestRef = useRef<Promise<void> | null>(null);
  const loadCtx = useCallback((): Promise<void> => {
    if (contextRequestRef.current) return contextRequestRef.current;
    const request = (async () => {
      try {
        const res = await fetch(`${apiBase()}/api/context-usage`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || `요청 실패 (${res.status})`);
        setCtx({ loading: false, sessions: json.sessions ?? [], installed: json.captureInstalled });
      } catch (e: any) {
        setCtx({ loading: false, error: e?.message || String(e) });
      }
    })();
    contextRequestRef.current = request;
    void request.finally(() => {
      if (contextRequestRef.current === request) contextRequestRef.current = null;
    });
    return request;
  }, []);

  useEffect(() => { void loadClaude(); void loadCodex(); void loadCtx(); }, [loadClaude, loadCodex, loadCtx]);

  // The status line rewrites the snapshot every turn, so polling keeps this live
  // without any refresh action from the user.
  useEffect(() => {
    const id = setInterval(() => { void loadCtx(); }, 5000);
    return () => clearInterval(id);
  }, [loadCtx]);

  const setMemoryStatus = useCallback((folderPath: string, state: SessionMemoryStatusState) => {
    setMemoryStatusByPath(previous => {
      const next = { ...previous, [folderPath]: state };
      // A linked worktree can resolve to a shared project root.  Remember the
      // canonical path too, while still keeping the caller's path addressable.
      if (state.kind === 'ready' && state.status.projectRoot) {
        next[state.status.projectRoot] = state;
      }
      return next;
    });
  }, []);

  const refreshMemoryStatus = useCallback(async (folderPath: string): Promise<SessionMemoryStatusState | null> => {
    setMemoryStatus(folderPath, { kind: 'checking' });
    try {
      // Reuse the project panel client: it retries only transient Tauri
      // sidecar startup failures and preserves useful server error details.
      const status = await projectMemoryApi.detect(folderPath);
      let remote: ProjectMemoryRemoteState = { kind: 'not-required' };
      if (status.exists && status.config?.autoBackup !== false) {
        try {
          const remoteStatus = await projectMemoryApi.remoteStatus({ folderPath });
          remote = {
            kind: 'ready',
            status: {
              exists: remoteStatus.exists === true,
              createdAt: typeof remoteStatus.createdAt === 'string' ? remoteStatus.createdAt : null,
              contentHash: typeof remoteStatus.contentHash === 'string' ? remoteStatus.contentHash : null,
              inSync: remoteStatus.inSync === true,
            },
          };
        } catch (remoteError: any) {
          remote = { kind: 'error', message: remoteError?.message || String(remoteError) };
        }
      }
      const next: SessionMemoryStatusState = { kind: 'ready', status, remote, checkedAt: Date.now() };
      setMemoryStatus(folderPath, next);
      return next;
    } catch (error: any) {
      const next: SessionMemoryStatusState = {
        kind: 'error',
        message: error?.message || String(error),
        code: typeof error?.code === 'string' ? error.code : undefined,
        checkedAt: Date.now(),
      };
      setMemoryStatus(folderPath, next);
      return null;
    }
  }, [setMemoryStatus]);

  useEffect(() => {
    const visibleProjectFolders = new Set(
      (ctx.sessions ?? [])
        .flatMap(session => {
          const folderPath = contextSessionMemoryPath(session);
          const retainedProjectVoice = session.state === 'stale'
            && session.sourceAgent === 'codex'
            && session.threadSource === 'realtime_voice'
            && !!session.projectHint
            && !voiceProjectMemoryIsBlocked(session);
          return (session.state !== 'stale' || retainedProjectVoice) && !!folderPath ? [folderPath] : [];
        }),
    );
    const due: string[] = [];
    for (const folderPath of visibleProjectFolders) {
      const cached = memoryStatusRef.current[folderPath];
      // A folder that no longer exists cannot come back under the same path,
      // so stop re-probing it instead of failing every 30s for the session's life.
      if (cached?.kind === 'error' && cached.code === PROJECT_ROOT_MISSING) continue;
      const checkedAt = cached?.kind === 'ready' || cached?.kind === 'error' ? cached.checkedAt : 0;
      if (!cached || (cached.kind !== 'checking' && Date.now() - checkedAt >= 30_000)) {
        due.push(folderPath);
      }
    }
    // Opening the panel used to fire one probe per row at once. Each probe does
    // blocking filesystem and git work in the local API, and under that burst
    // one request's body would fail to parse — leaving a random row showing
    // "다시 확인하세요" for no reason the user could see. A small queue removes
    // the burst; the probes are cached for 30s, so the wait is invisible.
    //
    // The queue only actually holds because in-flight paths live in a ref.
    // While memoryStatusByPath was a dependency, refreshMemoryStatus's first
    // act — a synchronous setMemoryStatus(..., 'checking') — re-ran this effect
    // before the first await, tearing down the loop and starting a new one. The
    // 'checking' guard hid it for the folder already claimed, but every later
    // folder in `due` was restarted from scratch, so the burst came back on any
    // panel with more than one row.
    const pending = due.filter(folderPath => !inFlightMemoryProbes.current.has(folderPath));
    if (pending.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const folderPath of pending) {
        if (cancelled) return;
        inFlightMemoryProbes.current.add(folderPath);
        try {
          await refreshMemoryStatus(folderPath);
        } finally {
          inFlightMemoryProbes.current.delete(folderPath);
        }
      }
    })();
    return () => { cancelled = true; };
    // memoryStatusByPath is read through memoryStatusRef above and must not be a
    // dependency: it changes on every probe, which is what re-entered. The 5s
    // context poll refreshes ctx.sessions, so expired 30s entries still get
    // re-probed without it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.sessions, refreshMemoryStatus]);

  const focusContextSession = useCallback(async (session: ContextSession) => {
    if (!session.navigation?.available || focusingSessionId) return;
    setFocusingSessionId(session.sessionId);
    setFocusResult(null);
    try {
      // A background agent has no window to focus, so this is a launch on the
      // selected terminal surface rather than a server-side navigation.
      if (session.navigation.kind === 'claude-agent-view') {
        if (!onOpenAgentView) throw new Error('이 화면에서는 Agent View를 열 수 없습니다.');
        const message = await onOpenAgentView(session.cwd);
        setFocusResult({ sessionId: session.sessionId, success: true, message: message || 'Agent View를 열었습니다.' });
        return;
      }
      const res = await fetch(`${apiBase()}/api/context-sessions/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The server resolves the target again from this ID. Do not send cwd,
        // terminal handles, deep links, or raw surface identifiers from the UI.
        body: JSON.stringify({ sessionId: session.sessionId, sourceAgent: session.sourceAgent }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `이동 요청 실패 (${res.status})`);
      setFocusResult({ sessionId: session.sessionId, success: true, message: json.message || '해당 창으로 이동했습니다.' });
      void loadCtx();
    } catch (e: any) {
      setFocusResult({ sessionId: session.sessionId, success: false, message: e?.message || String(e) });
    } finally {
      setFocusingSessionId(null);
    }
  }, [focusingSessionId, loadCtx, onOpenAgentView]);

  const rememberContextSession = useCallback(async (
    session: ContextSession,
    projectName: string,
    folderPath: string,
  ) => {
    if (rememberingSessionId) return;
    setRememberingSessionId(session.sessionId);
    setRememberResult(null);
    try {
      // Always re-check at click time.  A previous save from the project panel
      // or another session must not launch a second costly CLI consolidation.
      const memoryState = await refreshMemoryStatus(folderPath);
      if (!memoryState || memoryState.kind !== 'ready') {
        throw new Error('기억 상태를 확인하지 못했습니다. 잠시 후 다시 시도하세요.');
      }
      const action = sessionMemoryAction(folderPath, memoryState);
      if (action === 'saved') {
        setRememberResult({
          sessionId: session.sessionId,
          success: true,
          message: '이미 최신 장기기억입니다. 컨텍스트 수치는 저장만으로 줄어들지 않습니다.',
        });
        return;
      }
      if (action === 'push' || action === 'pull' || action === 'conflict') {
        const label = action === 'push' ? 'Supabase Push' : action === 'pull' ? 'Supabase Pull' : '동기화 확인';
        setRememberResult({
          sessionId: session.sessionId,
          success: false,
          message: `로컬 장기기억은 최신이지만 ${label}이 필요합니다. 프로젝트 영역에서 안전하게 처리하세요.`,
        });
        return;
      }
      if (action !== 'start' && action !== 'remember') {
        throw new Error('동기화 상태를 확인하지 못했습니다. 잠시 후 다시 시도하세요.');
      }

      const status = memoryState.status;

      // The card represents one concrete session, so it should never turn a
      // Codex session into a slow Claude run merely because the project panel
      // has Claude selected as its default.  Keep that manual preference intact
      // for the project panel itself.
      const agent = session.sourceAgent;
      const autoBackup = typeof status.config?.autoBackup === 'boolean' ? status.config.autoBackup : true;
      const result = await projectMemoryApi.sessionEnd({
        folderPath,
        projectName,
        agent,
        autoBackup,
        preservePreferredAgent: true,
      });
      if (result.success === false) {
        throw new Error(result.backupError || result.error || '세션 기억 요청 실패');
      }

      const message = result.remoteBackedUp
        ? '세션 기억 완료 · 프로젝트 장기기억과 Supabase 백업을 갱신했습니다.'
        : result.backupSkipped
          ? '세션 기억 완료 · 자동 백업이 꺼져 있어 로컬에만 저장했습니다.'
          : result.backupError
            ? `세션 기억 완료 · 로컬 저장됨 (Supabase 백업 재시도 필요: ${result.backupError})`
            : '세션 기억 완료 · 로컬 기억을 갱신했습니다.';
      setRememberResult({ sessionId: session.sessionId, success: true, message });
      // The response only includes the local state. Re-read the remote status too
      // so a backup failure never turns into a premature “complete” indicator.
      await refreshMemoryStatus(folderPath);
      void loadCtx();
    } catch (e: any) {
      setRememberResult({ sessionId: session.sessionId, success: false, message: e?.message || String(e) });
    } finally {
      setRememberingSessionId(null);
    }
  }, [rememberingSessionId, loadCtx, refreshMemoryStatus]);

  const cardStyle: React.CSSProperties = {
    border: '1px solid rgba(255,255,255,0.08)',
    background: 'rgba(10,10,11,0.6)',
    borderRadius: 8,
    padding: 12,
  };
  const headStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 6, marginBottom: 9,
    fontSize: 12, fontWeight: 600, color: '#d4d4d8',
  };
  const refreshBtn: React.CSSProperties = {
    marginLeft: 'auto', background: 'transparent', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 5, color: '#a1a1aa', cursor: 'pointer', padding: '2px 6px',
    display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontFamily: 'inherit',
  };

  const codexRows = [
    { label: rateLimitLabel(codex.data?.primary?.window_minutes, '기본 한도'), limit: codex.data?.primary },
    { label: rateLimitLabel(codex.data?.secondary?.window_minutes, '보조 한도'), limit: codex.data?.secondary },
  ].filter(r => r.limit && typeof r.limit.used_percent === 'number');
  // Checked once per open: the app adopts whatever local API already answers on
  // its port, so a sidecar from an earlier version can serve this panel and make
  // the session list look wrong for a reason nothing on screen explains.
  const [apiVersion, setApiVersion] = useState<ContextApiVersionReport>(
    { state: 'unknown', detected: null, required: CONTEXT_API_SCHEMA_VERSION },
  );
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${apiBase()}/api/health`);
        const json = await res.json();
        if (!cancelled) setApiVersion(classifyContextApiVersion(json));
      } catch {
        // Unreachable is not evidence of an old version; stay silent.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const visibleSessions = visibleContextSessions(ctx.sessions);
  // AI usage normally hides stale context snapshots. A project-bound Codex
  // Voice chat is also the bridge to that project's durable memory, though, so
  // retain a bounded history row for it instead of making a moved Voice vanish
  // merely because ChatGPT stopped emitting usage counters.
  const projectVoiceHistory = (ctx.sessions ?? [])
    .filter((session) => (
      session.state === 'stale'
      && session.sourceAgent === 'codex'
      && session.threadSource === 'realtime_voice'
      && !!session.projectHint
    ))
    .slice(0, 12);
  const displayedSessions = [...visibleSessions, ...projectVoiceHistory];
  const hiddenUnverifiedSurfaceCount = hiddenUnverifiedContextSurfaceCount(ctx.sessions);

  const originBadge = (background: string, color: string): React.CSSProperties => ({
    fontSize: 9.5,
    lineHeight: 1.35,
    padding: '1px 5px',
    borderRadius: 4,
    background,
    color,
    whiteSpace: 'nowrap',
  });

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 9500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#09090b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12,
          width: '100%', maxWidth: 560, maxHeight: '82vh', display: 'flex', flexDirection: 'column',
          boxShadow: '0 24px 60px rgba(0,0,0,0.6)', fontFamily: 'Inter Tight, system-ui, sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <Gauge style={{ width: 15, height: 15, color: '#5eead4' }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: '#f4f4f5' }}>AI 사용량</span>
          <button onClick={onClose} aria-label="닫기" style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#71717a', cursor: 'pointer', display: 'flex', padding: 2 }}>
            <X style={{ width: 15, height: 15 }} />
          </button>
        </div>

        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>
          {/* Recent context snapshots; runtime-backed surfaces carry a presence badge. */}
          <div style={cardStyle}>
            <div style={headStyle}>
              <span style={{ color: '#5eead4' }}>최근 AI 세션 컨텍스트</span>
              <span style={{ fontSize: 10, color: '#71717a', fontWeight: 400 }}>Claude statusLine · Codex/Voice 세션 기록 · Voice는 토큰 수치 없이도 표시 · Orca/cmux 표면은 런타임 확인</span>
            </div>
            {apiVersion.state === 'outdated' && (
              <div
                data-testid="context-api-outdated"
                role="status"
                style={{
                  fontSize: 10.5, color: '#fdba74', lineHeight: 1.5,
                  background: 'rgba(251,146,60,0.09)', borderRadius: 6, padding: '6px 8px',
                }}
              >
                {contextApiOutdatedMessage(apiVersion)}
              </div>
            )}
            {hiddenUnverifiedSurfaceCount > 0 && (
              <div style={{ fontSize: 10.5, color: '#fbbf24', lineHeight: 1.45 }}>
                Orca/cmux 세션 {hiddenUnverifiedSurfaceCount}개는 실행 표면을 확인할 수 없어 목록에서 제외했습니다.
              </div>
            )}
            {ctx.loading ? (
              <div style={{ fontSize: 11.5, color: '#a1a1aa' }}>조회 중…</div>
            ) : ctx.error ? (
              <div style={{ fontSize: 11.5, color: '#fca5a5' }}>{ctx.error}</div>
            ) : displayedSessions.length === 0 ? (
              <div style={{ fontSize: 11, color: '#71717a', lineHeight: 1.6 }}>
                표시할 최근 AI 세션이 없습니다. 닫혔거나 확인할 수 없는 Orca/cmux 표면은 목록에서 자동으로 제외합니다.
                Claude는 statusLine이 한 번 이상 렌더돼야 하고, Codex는 세션 기록이 생성돼야 표시됩니다.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {projectVoiceHistory.length > 0 && (
                  <div style={{ fontSize: 10.5, color: '#99f6e4', lineHeight: 1.45 }}>
                    프로젝트에 연결된 이전 Codex Voice 기록도 장기기억 연결을 위해 함께 표시합니다.
                  </div>
                )}
                {displayedSessions.map(s => {
                  const projectPath = contextSessionProjectPath(s);
                  const memoryFolderPath = contextSessionMemoryPath(s);
                  const projectBinding = resolveContextSessionProjectBinding(contextProjectCandidates, projectPath);
                  const fallbackConversationName = contextPathLeaf(s.cwd, s.sessionId.slice(0, 8));
                  const conversationName = s.threadTitle || fallbackConversationName;
                  const projectDisplayName = s.projectHint?.name
                    ?? projectBinding.projectName
                    ?? (projectBinding.relation === 'ephemeral' ? '프로젝트 연결 안 됨' : '등록되지 않은 프로젝트');
                  const projectMovePending = s.projectHint?.moveState === 'pending'
                    || s.voiceBindingState === 'move-pending'
                    || s.voiceBindingState === 'scope-conflict';
                  const projectMoveConfirmed = !projectMovePending && (
                    s.projectHint?.moveState === 'relocated'
                    || contextPathsDiffer(s.initialCwd, s.cwd)
                    || s.voiceBindingState === 'execution-confirmed'
                  );
                  const isVoiceChat = s.sourceAgent === 'codex' && s.threadSource === 'realtime_voice';
                  const voiceBinding = isVoiceChat ? voiceBindingBadge(s.voiceBindingState) : null;
                  const voiceMemoryBlocked = voiceProjectMemoryIsBlocked(s);
                  const warn = (s.usedPercent ?? 0) >= REMEMBER_THRESHOLD;
                  const memoryState = memoryFolderPath ? memoryStatusByPath[memoryFolderPath] : undefined;
                  const memoryAction = voiceMemoryBlocked
                    ? 'unavailable'
                    : sessionMemoryAction(memoryFolderPath, memoryState);
                  const savedMemory = memoryAction === 'saved';
                  const syncNeedsAttention = memoryAction === 'push' || memoryAction === 'pull' || memoryAction === 'conflict';
                  const memoryTone = voiceMemoryBlocked
                    ? s.voiceBindingState === 'scope-conflict'
                      ? '#fca5a5'
                      : '#fde68a'
                    : savedMemory
                    ? '#99f6e4'
                    : memoryAction === 'conflict' || memoryAction === 'retry'
                      ? '#fca5a5'
                      : memoryAction === 'pull'
                        ? '#bfdbfe'
                        // Nothing to do here — an amber nudge would read as a task.
                        : memoryAction === 'ephemeral'
                          ? '#a1a1aa'
                          : '#fbbf24';
                  // A tint with no outline. The session card owns the only drawn
                  // edge on the row; a bordered box inside it competed with that
                  // boundary and read as the start of the next session.
                  const memoryBackground = voiceMemoryBlocked
                    ? s.voiceBindingState === 'scope-conflict'
                      ? 'rgba(248,113,113,0.09)'
                      : 'rgba(251,191,36,0.09)'
                    : savedMemory
                    ? 'rgba(94,234,212,0.08)'
                    : memoryAction === 'conflict' || memoryAction === 'retry'
                      ? 'rgba(248,113,113,0.09)'
                      : memoryAction === 'pull'
                        ? 'rgba(96,165,250,0.09)'
                        : memoryAction === 'ephemeral'
                          ? 'rgba(255,255,255,0.05)'
                          : 'rgba(251,191,36,0.09)';
                  const configuredMemoryAgent = memoryState?.kind === 'ready'
                    && (memoryState.status.config?.agent === 'claude' || memoryState.status.config?.agent === 'codex')
                    ? memoryState.status.config.agent
                    : s.sourceAgent;
                  const sessionMemoryAgent = s.sourceAgent;
                  const navigation = s.navigation;
                  const surfaceBadge = contextSurfacePresenceBadge(s.surfacePresence);
                  const projectAvailable = !!projectPath && !!onOpenProject && (canOpenProject?.(projectPath) ?? true);
                  const isFocusing = focusingSessionId === s.sessionId;
                  const rowFocusResult = focusResult?.sessionId === s.sessionId ? focusResult : null;
                  const isRemembering = rememberingSessionId === s.sessionId;
                  const rowRememberResult = rememberResult?.sessionId === s.sessionId ? rememberResult : null;
                  return (
                    // One card per session. Without an outer boundary the rows ran
                    // together, and the memory notice — the loudest element on the
                    // row — read as the start of the next session rather than as
                    // part of this one.
                    <div
                      key={s.sessionId}
                      data-testid={`context-session-card-${s.sessionId}`}
                      style={{
                        // Separation comes from surface and a hairline, not from a
                        // coloured bar down the edge. The agent already has a voice
                        // on this row — its badge — and repeating it as a stripe
                        // only adds a decorative edge that carries no extra meaning.
                        background: 'rgba(255,255,255,0.032)',
                        border: '1px solid rgba(255,255,255,0.075)',
                        borderRadius: 10,
                        padding: '9px 11px',
                      }}
                    >
                      {/* Project identity and the actual chat/window title stay
                          separate. A Codex voice-chat scratch cwd must never be
                          mistaken for the project name. */}
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                        <span
                          data-testid={`context-session-project-name-${s.sessionId}`}
                          title={projectPath ?? '연결된 프로젝트 경로를 찾지 못했습니다.'}
                          style={{ minWidth: 0, flex: 1, fontSize: 12.5, color: '#fafafa', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        >
                          프로젝트: {projectDisplayName}
                        </span>
                        <span style={{ fontSize: 10, color: contextSessionActivityColor(s), whiteSpace: 'nowrap' }}>
                          {contextSessionActivityLabel(s, formatAge(s.ageMs))}
                        </span>
                        <span style={{
                          marginLeft: 'auto', fontSize: 13, fontWeight: 700,
                          color: warn ? '#fbbf24' : '#f4f4f5', fontFamily: "'JetBrains Mono', monospace",
                        }}>
                          {typeof s.usedPercent === 'number' ? `${s.usedPercent}%` : '—'}
                        </span>
                      </div>
                      <div
                        data-testid={`context-session-thread-title-${s.sessionId}`}
                        title={s.threadTitle ? 'ChatGPT/Claude가 저장한 대화 또는 창 제목' : '대화 제목을 찾지 못해 현재 작업 폴더 이름을 표시합니다.'}
                        style={{ marginTop: 2, fontSize: 10.5, color: '#a1a1aa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      >
                        대화/창: {conversationName}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 4, marginBottom: 5, flexWrap: 'wrap' }}>
                        <span style={originBadge(
                          s.sourceAgent === 'claude' ? 'rgba(196,181,253,0.12)' : 'rgba(147,197,253,0.12)',
                          s.sourceAgent === 'claude' ? '#c4b5fd' : '#93c5fd',
                        )}>
                          {s.clientLabel}
                        </span>
                        <span
                          title={s.surfaceDetail ? `${s.surfaceLabel} · ${s.surfaceDetail}` : s.surfaceLabel}
                          style={originBadge('rgba(255,255,255,0.06)', '#a1a1aa')}
                        >
                          {s.surfaceLabel}
                        </span>
                        {isVoiceChat && (
                          <span title="ChatGPT Codex 보이스 채팅에서 시작한 세션" style={originBadge('rgba(94,234,212,0.1)', '#99f6e4')}>
                            Codex 보이스 채팅
                          </span>
                        )}
                        {voiceBinding && (
                          <span
                            data-testid={`context-session-voice-binding-${s.sessionId}`}
                            title={voiceBinding.title}
                            style={originBadge('rgba(94,234,212,0.08)', voiceBinding.tone)}
                          >
                            {voiceBinding.label}
                          </span>
                        )}
                        {surfaceBadge && (
                          <span title={surfaceBadge.title} style={originBadge('rgba(94,234,212,0.08)', surfaceBadge.tone)}>
                            {surfaceBadge.label}
                          </span>
                        )}
                        <span style={{ marginLeft: 'auto', fontSize: 10, color: '#71717a', whiteSpace: 'nowrap' }}>
                          {s.modelName}
                          {s.usedTokens && s.windowSize
                            ? ` · ${compactTokens(s.usedTokens)}/${compactTokens(s.windowSize)}`
                            : typeof s.usedPercent !== 'number'
                              ? ' · 컨텍스트 수치 없음'
                              : ''}
                        </span>
                      </div>
                      <UsageBar percent={s.usedPercent} />
                      {projectMovePending && (
                        <div
                          data-testid={`context-session-project-pending-${s.sessionId}`}
                          title={[s.projectHint?.appliedPath, s.projectHint?.pendingPath].filter(Boolean).join(' → ')}
                          style={{ marginTop: 6, fontSize: 10, lineHeight: 1.45, color: '#fde68a', background: 'rgba(120,53,15,0.22)', borderRadius: 5, padding: '5px 7px' }}
                        >
                          {s.voiceBindingState === 'scope-conflict'
                            ? 'Voice 실행 경로 불일치 · 대상 프로젝트 장기기억에 연결하지 않음'
                            : `프로젝트 변경 적용 대기 · 대상: ${projectDisplayName}`}
                          {s.cwd ? ` · 현재 실행: ${contextPathLeaf(s.cwd, '임시 폴더')}` : ''}
                        </div>
                      )}
                      {!projectMovePending && projectMoveConfirmed && (
                        <div
                          data-testid={`context-session-project-moved-${s.sessionId}`}
                          title={projectPath ?? undefined}
                          style={{ marginTop: 6, fontSize: 10, lineHeight: 1.45, color: '#bfdbfe', background: 'rgba(96,165,250,0.09)', borderRadius: 5, padding: '5px 7px' }}
                        >
                          프로젝트 이동 감지 · 현재 연결: {projectDisplayName}
                        </div>
                      )}
                      <div style={{ marginTop: 5, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 6, minHeight: 21, flexWrap: 'wrap' }}>
                        {projectAvailable && (
                          <button
                            type="button"
                            data-testid={`context-session-open-project-${s.sessionId}`}
                            aria-label={`${projectDisplayName} 프로젝트 영역으로 이동`}
                            title="이 세션의 프로젝트 상세와 장기기억 상태를 엽니다."
                            onClick={() => onOpenProject?.(projectPath!)}
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: 5,
                              border: '1px solid rgba(147,197,253,0.3)', background: 'rgba(147,197,253,0.08)',
                              color: '#bfdbfe', fontSize: 10, fontFamily: 'inherit', padding: '3px 7px', cursor: 'pointer',
                            }}
                          >
                            <FolderOpen style={{ width: 11, height: 11 }} />
                            {projectDisplayName}로 이동
                          </button>
                        )}
                        {navigation?.available ? (
                          <button
                            type="button"
                            data-testid={`context-session-focus-${s.sessionId}`}
                            title={navigation.detail}
                            aria-label={`${conversationName} ${navigation.actionLabel ?? '창으로 이동'}`}
                            disabled={isFocusing}
                            onClick={() => { void focusContextSession(s); }}
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: 5,
                              border: '1px solid rgba(94,234,212,0.28)', background: 'rgba(94,234,212,0.08)',
                              color: '#99f6e4', fontSize: 10, fontFamily: 'inherit', padding: '3px 7px',
                              cursor: isFocusing ? 'wait' : 'pointer', opacity: isFocusing ? 0.72 : 1,
                            }}
                          >
                            {isFocusing
                              ? <Loader2 style={{ width: 11, height: 11, animation: 'spin 0.9s linear infinite' }} />
                              : <ArrowUpRight style={{ width: 11, height: 11 }} />}
                            {isFocusing ? '이동 중…' : navigation.actionLabel}
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled
                            data-testid={`context-session-unsupported-${s.sessionId}`}
                            title={navigation?.detail ?? '이 세션의 창 식별자를 확인하지 못했습니다.'}
                            aria-label={`${conversationName} 창 이동 미지원`}
                            style={{
                              border: 0,
                              background: 'transparent',
                              padding: 0,
                              fontSize: 9.5,
                              color: '#71717a',
                              cursor: 'not-allowed',
                            }}
                          >
                            이동 미지원
                          </button>
                        )}
                      </div>
                      {rowFocusResult && (
                        <div style={{
                          marginTop: 4, fontSize: 10, lineHeight: 1.45,
                          color: rowFocusResult.success ? '#99f6e4' : '#fca5a5',
                        }} role="status">
                          {rowFocusResult.message}
                        </div>
                      )}
                      {(voiceMemoryBlocked || warn || memoryAction !== 'unavailable') && (
                        <div style={{
                          marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                          fontSize: 10, color: memoryTone, lineHeight: 1.5,
                          background: memoryBackground,
                          borderRadius: 5, padding: '5px 7px',
                        }}>
                          <span>
                            {voiceMemoryBlocked
                              ? s.voiceBindingState === 'scope-conflict'
                                ? 'Voice 실행 경로가 대상 프로젝트 범위와 달라 장기기억을 조회하거나 저장하지 않습니다.'
                                : s.voiceBindingState === 'move-pending'
                                  ? 'Voice 프로젝트 이동이 적용될 때까지 대상 프로젝트 장기기억을 조회하거나 저장하지 않습니다.'
                                  : 'Voice 프로젝트 연결을 다시 확인할 때까지 장기기억을 조회하거나 저장하지 않습니다.'
                              : savedMemory
                              ? '컨텍스트는 높지만 이 프로젝트의 장기기억은 최신입니다. 저장해도 현재 대화의 컨텍스트 수치는 줄어들지 않습니다.'
                              : memoryAction === 'push'
                                ? '로컬 장기기억은 최신이지만 Supabase Push가 필요합니다. 프로젝트 영역에서 Push하면 동기화가 완료됩니다.'
                                : memoryAction === 'pull'
                                  ? 'Supabase 장기기억이 더 최신입니다. 프로젝트 영역에서 Pull 내용을 확인하세요.'
                                  : memoryAction === 'conflict'
                                    ? '로컬과 Supabase 장기기억이 모두 변경되었습니다. 프로젝트 영역에서 Push 또는 Pull 방향을 확인하세요.'
                                    : memoryAction === 'checking'
                                      ? '프로젝트 장기기억과 Supabase 동기화 상태를 확인하고 있습니다.'
                                      : memoryAction === 'missing'
                                        ? '이 세션이 사용하던 폴더가 더 이상 없습니다. 삭제된 워크트리로 보이며, 장기기억을 확인하거나 저장할 수 없습니다.'
                                        : memoryAction === 'retry'
                                        ? '장기기억 또는 Supabase 동기화 상태를 확인하지 못했습니다. 다시 확인하세요.'
                                    : warn
                                      ? '컨텍스트가 곧 찹니다. 프로젝트 장기기억은 저장할 수 있지만, 현재 대화를 압축하거나 수치를 낮추지는 않습니다.'
                                      : memoryAction === 'ephemeral'
                                        ? 'ChatGPT 앱이 이 대화용으로 만든 임시 폴더에서 실행된 세션입니다. 장기기억은 작업을 옮겨 둔 실제 프로젝트 폴더에서 시작하세요.'
                                        : memoryAction === 'start'
                                          ? '이 프로젝트에는 장기기억이 아직 없습니다. 지금 초기화하고 이후 세션의 결정과 교훈을 이어갈 수 있습니다.'
                                          : '프로젝트 변경이 감지되었습니다. 컨텍스트 사용률과 관계없이 지금 세션 기억을 갱신할 수 있습니다.'}
                          </span>
                          {voiceMemoryBlocked ? (
                            <span
                              data-testid={`context-session-memory-blocked-${s.sessionId}`}
                              title="Voice의 프로젝트 배정과 실행 경로가 확인된 뒤에만 장기기억을 연결합니다."
                              style={{ fontSize: 10, color: memoryTone, fontWeight: 600 }}
                            >
                              장기기억 연결 대기
                            </span>
                          ) : memoryAction === 'checking' ? (
                            <span style={{ fontSize: 10, color: '#a1a1aa' }}>기억 상태 확인 중…</span>
                          ) : memoryAction === 'missing' ? (
                            <span
                              data-testid={`context-session-memory-missing-${s.sessionId}`}
                              title={memoryState?.kind === 'error' ? memoryState.message : '폴더를 찾을 수 없습니다.'}
                              style={{ fontSize: 10, color: '#a1a1aa', fontWeight: 600 }}
                            >
                              폴더 없음
                            </span>
                          ) : memoryAction === 'retry' && memoryFolderPath ? (
                            <button
                              type="button"
                              data-testid={`context-session-memory-retry-${s.sessionId}`}
                              onClick={() => { void refreshMemoryStatus(memoryFolderPath); }}
                              title={memoryState?.kind === 'error' ? memoryState.message : '기억 상태를 다시 확인합니다.'}
                              style={{
                                display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 7px', borderRadius: 5,
                                border: '1px solid rgba(248,113,113,0.5)', background: 'rgba(127,29,29,0.18)',
                                color: '#fecaca', fontSize: 10, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
                              }}
                            >
                              기억 상태 다시 확인
                            </button>
                          ) : memoryAction === 'ephemeral' ? (
                            <span
                              data-testid={`context-session-memory-ephemeral-${s.sessionId}`}
                              title={`${memoryFolderPath ?? ''}\nChatGPT 앱이 대화마다 만드는 작업 폴더라 장기기억을 두면 다시 열리지 않습니다.`}
                              style={{ fontSize: 10, color: '#a1a1aa', fontWeight: 600 }}
                            >
                              임시 작업 폴더
                            </span>
                          ) : memoryAction === 'saved' ? (
                            <span
                              data-testid={`context-session-memory-saved-${s.sessionId}`}
                              title={memoryState?.kind === 'ready' && memoryState.status.activity.lastRememberedAt
                                ? `마지막 기억 저장: ${new Date(memoryState.status.activity.lastRememberedAt).toLocaleString('ko-KR')}`
                                : '프로젝트 영역과 같은 최신 장기기억 상태입니다.'}
                              style={{ fontSize: 10, color: '#99f6e4', fontWeight: 600 }}
                            >
                              세션 기억 완료
                            </span>
                          ) : syncNeedsAttention ? (
                            <span
                              data-testid={`context-session-memory-sync-${s.sessionId}`}
                              title="프로젝트 영역으로 이동해 Push 또는 Pull을 안전하게 처리하세요."
                              style={{ fontSize: 10, color: memoryTone, fontWeight: 600 }}
                            >
                              {memoryAction === 'push' ? 'Supabase Push 필요' : memoryAction === 'pull' ? 'Supabase Pull 검토' : '동기화 확인 필요'}
                            </span>
                          ) : memoryFolderPath ? (
                            <button
                              type="button"
                              data-testid={`context-session-remember-${s.sessionId}`}
                              aria-label={`${projectDisplayName} ${memoryAction === 'start' ? '장기기억 시작하기' : '세션 기억하기 필요'}`}
                              disabled={isRemembering}
                              onClick={() => { void rememberContextSession(s, projectDisplayName, memoryFolderPath); }}
                              title={`${sessionMemoryAgent === 'claude' ? 'Claude' : 'Codex'} 세션으로 프로젝트의 파일·Git 활동을 장기기억으로 정리합니다. 프로젝트 영역의 기본 에이전트(${configuredMemoryAgent === 'claude' ? 'Claude' : 'Codex'}) 설정은 바꾸지 않습니다. 현재 AI 대화 원문을 읽거나 압축하지 않으며, 최대 5분 걸릴 수 있습니다.`}
                              style={{
                                display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 7px', borderRadius: 5,
                                border: '1px solid rgba(251,191,36,0.65)', background: 'rgba(120,53,15,0.24)',
                                color: '#fde68a', fontSize: 10, fontWeight: 600, fontFamily: 'inherit',
                                cursor: isRemembering ? 'wait' : 'pointer', opacity: isRemembering ? 0.72 : 1,
                              }}
                            >
                              {isRemembering && <Loader2 style={{ width: 10, height: 10, animation: 'spin 0.9s linear infinite' }} />}
                              {isRemembering
                                ? `${sessionMemoryAgent === 'claude' ? 'Claude' : 'Codex'}로 저장 중…`
                                : memoryAction === 'start'
                                  ? '장기기억 시작하기'
                                  : '세션 기억하기 필요'}
                            </button>
                          ) : (
                            <span style={{ fontSize: 10, color: '#a1a1aa' }}>프로젝트 경로 없음</span>
                          )}
                        </div>
                      )}
                      {rowRememberResult && (
                        <div
                          data-testid={`context-session-remember-result-${s.sessionId}`}
                          style={{
                            marginTop: 4, fontSize: 10, lineHeight: 1.45,
                            color: rowRememberResult.success ? '#99f6e4' : '#fca5a5',
                          }}
                          role="status"
                        >
                          {rowRememberResult.message}
                        </div>
                      )}
                    </div>
                  );
                })}
                <div style={{ fontSize: 10, color: '#71717a', lineHeight: 1.5, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 7 }}>
                  ChatGPT Codex·cmux는 확인된 세션 식별자로만 이동합니다. Orca 플로팅은 안전하게 작업공간만 열고,
                  위치 정보가 없는 외부 CLI 세션은 추측하지 않습니다. 5초마다 자동 갱신.
                </div>
              </div>
            )}
          </div>

          {/* Claude */}
          <div style={cardStyle}>
            <div style={headStyle}>
              <span style={{ color: '#5eead4' }}>Claude</span>
              <span style={{ fontSize: 10, color: '#71717a', fontWeight: 400 }}>claude -p "/usage" · 실시간</span>
              <button style={refreshBtn} onClick={() => void loadClaude()} disabled={claude.loading}>
                <RefreshCw style={{ width: 9, height: 9 }} /> 새로고침
              </button>
            </div>
            {claude.loading ? (
              <div style={{ fontSize: 11.5, color: '#a1a1aa' }}>조회 중… (몇 초 걸립니다)</div>
            ) : claude.error ? (
              <div style={{ fontSize: 11.5, color: '#fca5a5', whiteSpace: 'pre-wrap' }}>{claude.error}</div>
            ) : (
              <pre style={{
                margin: 0, fontSize: 11, lineHeight: 1.6, color: '#c8d2d0', whiteSpace: 'pre-wrap',
                fontFamily: "'JetBrains Mono', ui-monospace, monospace", maxHeight: 300, overflowY: 'auto',
              }}>{claude.report}</pre>
            )}
          </div>

          {/* Codex */}
          <div style={cardStyle}>
            <div style={headStyle}>
              <span style={{ color: '#93c5fd' }}>Codex</span>
              <span style={{ fontSize: 10, color: '#71717a', fontWeight: 400 }}>
                {codex.source === 'session-log' ? '세션 기록 fallback' : '실시간 계정 한도'}
              </span>
              <button style={refreshBtn} onClick={() => void loadCodex(true)} disabled={codex.loading}>
                <RefreshCw style={{ width: 9, height: 9 }} /> 실시간 새로고침
              </button>
            </div>
            {codex.loading ? (
              <div style={{ fontSize: 11.5, color: '#a1a1aa' }}>조회 중…</div>
            ) : codex.error ? (
              <div style={{ fontSize: 11.5, color: '#fca5a5', whiteSpace: 'pre-wrap' }}>{codex.error}</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {codexRows.length === 0 && (
                  <div style={{ fontSize: 11.5, color: '#a1a1aa' }}>사용량 항목이 기록되지 않았습니다.</div>
                )}
                {codexRows.map(({ label, limit }) => (
                  <div key={label}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
                      <span style={{ fontSize: 11.5, color: '#d4d4d8' }}>{label}</span>
                      <span style={{ fontSize: 10, color: '#71717a' }}>
                        {formatWindow(limit!.window_minutes)} 창 · {formatReset(limit!.resets_at)}
                      </span>
                      <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: '#f4f4f5', fontFamily: "'JetBrains Mono', monospace" }}>
                        {Math.round(limit!.used_percent!)}% 사용 · {Math.max(0, Math.round(100 - limit!.used_percent!))}% 남음
                      </span>
                    </div>
                    <UsageBar percent={limit!.used_percent!} />
                  </div>
                ))}
                <div style={{ fontSize: 10, color: '#71717a', lineHeight: 1.5 }}>
                  {codex.data?.plan_type && <>플랜 {codex.data.plan_type} · </>}
                  {codex.data?.credits && !codex.data.credits.unlimited && <>크레딧 {codex.data.credits.balance ?? '0'} · </>}
                  {codex.source === 'session-log' ? '마지막 Codex 세션 기준' : 'Codex 계정 실시간 조회'}
                  {codex.checkedAt ? ` (${new Date(codex.checkedAt).toLocaleString('ko-KR')})` : ''}
                </div>
                <div style={{ fontSize: 10, color: '#71717a', lineHeight: 1.5, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 7 }}>
                  Codex 앱서버의 읽기 전용 계정 한도 조회를 사용합니다. CLI가 오프라인이거나 지원하지 않으면
                  마지막 세션 기록으로 자동 전환하며, 그 경우 위에 fallback으로 표시됩니다.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
