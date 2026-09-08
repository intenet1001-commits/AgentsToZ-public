import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Cloud,
  Globe2,
  KeyRound,
  Loader2,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Unplug,
  X,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import {
  formatInternetRemoteControlRemaining,
  isInternetRemoteControlExpired,
  normalizeInternetRemoteControllerOrigin,
  type InternetRemoteControlPairingIssue,
  type InternetRemoteControlSession,
  type InternetRemoteControlState,
  type InternetRemoteControlStatus,
} from './internetRemoteControlContract';
import { isInternetRemotePairingClaimed } from './internetRemoteControlPairingState';
import { REMOTE_CONTROL_MAX_SESSIONS } from './remoteControlProtocol';
import { AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED } from './agentRuntimeProtocol';
import { parseRemoteControlRelayPairingUrl } from './remoteControlRelayContract';
import {
  internetRemoteControlApi,
  type InternetRemoteControlApi,
} from './internetRemoteControlClient';

export interface InternetQrRemoteControlDialogProps {
  open: boolean;
  onClose: () => void;
  api?: InternetRemoteControlApi;
  /** Previously verified personal Vercel origin. Never persisted by this dialog. */
  defaultControllerOrigin?: string | null;
}

type BusyAction = 'refresh' | 'enable' | 'issue' | 'approve' | 'scopes' | 'revoke' | 'disable' | null;
type Notice = { kind: 'success' | 'error'; message: string } | null;
type SessionScopeDraft = { task: boolean; conversation: boolean };

const interactiveSelector = [
  'button:not([disabled])',
  'input:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const readableError = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return '외부 인터넷 원격제어 요청을 완료하지 못했습니다.';
};

const readableTime = (value: string | null): string => {
  if (!value) return '아직 확인되지 않음';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '확인할 수 없음';
};

const stateLabels: Record<InternetRemoteControlState, string> = {
  disabled: '꺼짐',
  pairing: 'QR 연결 대기',
  'approval-required': 'Mac 승인 필요',
  online: '외부 인터넷 연결됨',
  degraded: '릴레이 연결 불안정',
  offline: '연결 대기',
};

const stateClasses: Record<InternetRemoteControlState, string> = {
  disabled: 'border-zinc-700 bg-zinc-900 text-zinc-400',
  pairing: 'border-sky-400/30 bg-sky-400/10 text-sky-200',
  'approval-required': 'border-amber-300/35 bg-amber-300/10 text-amber-100',
  online: 'border-teal-300/35 bg-teal-300/10 text-teal-100',
  degraded: 'border-red-300/35 bg-red-300/10 text-red-100',
  offline: 'border-zinc-600 bg-zinc-800/70 text-zinc-300',
};

function controllerOriginFromStatus(status: InternetRemoteControlStatus): string {
  if (!status.controllerUrl) return '';
  try {
    return new URL(status.controllerUrl).origin;
  } catch {
    return '';
  }
}

export function InternetQrRemoteControlDialog({
  open,
  onClose,
  api = internetRemoteControlApi,
  defaultControllerOrigin = null,
}: InternetQrRemoteControlDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef<BusyAction>(null);
  const managementRevisionRef = useRef(0);
  const [status, setStatus] = useState<InternetRemoteControlStatus | null>(null);
  const [controllerOrigin, setControllerOrigin] = useState('');
  const [pairing, setPairing] = useState<InternetRemoteControlPairingIssue | null>(null);
  // The URL fragment stays only in React memory. Its opaque pairing id lets a
  // status poll prove THIS QR was claimed; existing sessions and another still-
  // valid QR must not clear the newly issued one.
  const visiblePairingIdRef = useRef<string | null>(null);
  const [approvalCodes, setApprovalCodes] = useState<Record<string, string>>({});
  const [taskScopeApprovals, setTaskScopeApprovals] = useState<Record<string, boolean>>({});
  const [conversationScopeApprovals, setConversationScopeApprovals] = useState<Record<string, boolean>>({});
  const [sessionScopeDrafts, setSessionScopeDrafts] = useState<Record<string, SessionScopeDraft>>({});
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);
  const [busy, setBusyState] = useState<BusyAction>(null);
  const [initialLoading, setInitialLoading] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [now, setNow] = useState(() => Date.now());

  const setBusy = useCallback((value: BusyAction) => {
    if (value) managementRevisionRef.current += 1;
    busyRef.current = value;
    setBusyState(value);
  }, []);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const applyStatus = useCallback((next: InternetRemoteControlStatus) => {
    setStatus(next);
    if (next.enabled) {
      const activeOrigin = controllerOriginFromStatus(next);
      if (activeOrigin) setControllerOrigin(activeOrigin);
    }
    if (!next.enabled) {
      setPairing(null);
      visiblePairingIdRef.current = null;
    } else if (isInternetRemotePairingClaimed(visiblePairingIdRef.current, next.sessions)) {
      setPairing(null);
      visiblePairingIdRef.current = null;
    }
  }, []);

  const refresh = useCallback(async (showOutcome = false) => {
    setBusy('refresh');
    setNotice(null);
    try {
      applyStatus((await api.status()).status);
      if (showOutcome) setNotice({ kind: 'success', message: '외부 인터넷 연결 상태를 다시 확인했습니다.' });
    } catch (error) {
      setNotice({ kind: 'error', message: readableError(error) });
    } finally {
      setBusy(null);
    }
  }, [api, applyStatus, setBusy]);

  useEffect(() => {
    if (!open) {
      // In particular, never retain the fragment-bearing pairing URL while the
      // dialog is closed. It is never written to persistent browser storage.
      setPairing(null);
      visiblePairingIdRef.current = null;
      setApprovalCodes({});
      setTaskScopeApprovals({});
      setConversationScopeApprovals({});
      setSessionScopeDrafts({});
      setControllerOrigin('');
      setRiskAcknowledged(false);
      setNotice(null);
      return;
    }
    let cancelled = false;
    setInitialLoading(true);
    setStatus(null);
    setPairing(null);
    visiblePairingIdRef.current = null;
    setApprovalCodes({});
    setTaskScopeApprovals({});
    setConversationScopeApprovals({});
    setSessionScopeDrafts({});
    setNotice(null);
    try {
      setControllerOrigin(defaultControllerOrigin
        ? normalizeInternetRemoteControllerOrigin(defaultControllerOrigin)
        : '');
    } catch {
      // App.tsx passes only a normalizeVercelPortalDeployUrl-verified value.
      // Fail closed if another caller supplies anything else.
      setControllerOrigin('');
    }
    void api.status()
      .then(latest => {
        if (cancelled) return;
        applyStatus(latest.status);
        // Only fill a blank field. Anything the user has already typed, or a
        // value seeded from the portal deploy setting, stays as it is.
        if (!latest.status.enabled && latest.suggestedControllerOrigin) {
          setControllerOrigin(current => current || latest.suggestedControllerOrigin!);
        }
      })
      .catch(error => { if (!cancelled) setNotice({ kind: 'error', message: readableError(error) }); })
      .finally(() => { if (!cancelled) setInitialLoading(false); });
    return () => { cancelled = true; };
  }, [open, api, applyStatus, defaultControllerOrigin]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let pollInFlight = false;
    const pollStatus = async () => {
      if (cancelled || document.hidden || busyRef.current || pollInFlight) return;
      pollInFlight = true;
      const revision = managementRevisionRef.current;
      try {
        const latest = await api.status();
        if (!cancelled && revision === managementRevisionRef.current) applyStatus(latest.status);
      } catch {
        // Keep the last confirmed state. Manual refresh exposes the error.
      } finally {
        pollInFlight = false;
      }
    };
    const timer = window.setInterval(() => { void pollStatus(); }, 3_000);
    const handleVisibilityChange = () => {
      if (!document.hidden) void pollStatus();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [open, api, applyStatus]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (busyRef.current) return;
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(interactiveSelector) ?? [],
      ).filter(element => element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !pairing) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [open, pairing]);

  const pairingExpired = pairing ? isInternetRemoteControlExpired(pairing.expiresAt, now) : false;
  const visiblePairing = pairing && !pairingExpired ? pairing : null;
  const pendingSessions = useMemo(
    () => status?.sessions.filter(session => session.approvalState === 'pending') ?? [],
    [status?.sessions],
  );
  const connectedSessions = useMemo(
    () => status?.sessions.filter(session => session.approvalState === 'approved') ?? [],
    [status?.sessions],
  );

  const handleEnable = async () => {
    if (busyRef.current) return;
    if (!riskAcknowledged) {
      setNotice({ kind: 'error', message: '베타 기능의 권한과 연결 제한을 먼저 확인해 주세요.' });
      return;
    }
    let normalizedOrigin: string;
    try {
      normalizedOrigin = normalizeInternetRemoteControllerOrigin(controllerOrigin);
    } catch (error) {
      setNotice({ kind: 'error', message: readableError(error) });
      return;
    }
    setBusy('enable');
    setNotice(null);
    try {
      const result = await api.enable(normalizedOrigin);
      setStatus(result.status);
      setControllerOrigin(normalizedOrigin);
      setPairing(result.pairing);
      visiblePairingIdRef.current = result.pairing
        ? parseRemoteControlRelayPairingUrl(result.pairing.pairingUrl).bootstrap.pairingId
        : null;
      setNotice(result.pairing
        ? { kind: 'success', message: '외부 인터넷 QR을 발급했습니다. QR은 30일 안에 한 번만 쓸 수 있고, 승인된 연결도 최대 30일 유지됩니다.' }
        : { kind: 'error', message: '기능은 켜졌지만 QR 원문을 받지 못했습니다. 전체 끄기 후 다시 시도해 주세요.' });
    } catch (error) {
      setPairing(null);
      visiblePairingIdRef.current = null;
      setNotice({ kind: 'error', message: readableError(error) });
    } finally {
      setBusy(null);
    }
  };

  /**
   * Mint one more QR without disabling the host. The relay binds a pairing to a
   * single controller key, so a second phone needs its own QR; before this the
   * dialog told the user to turn the whole feature off and back on, which
   * revoked the device already connected (VOC 2026-08-31 23:42).
   */
  const handleIssuePairing = async () => {
    if (busyRef.current) return;
    setBusy('issue');
    setNotice(null);
    try {
      const result = await api.issuePairing();
      setStatus(result.status);
      setPairing(result.pairing);
      visiblePairingIdRef.current = result.pairing
        ? parseRemoteControlRelayPairingUrl(result.pairing.pairingUrl).bootstrap.pairingId
        : null;
      setNotice(result.pairing
        ? { kind: 'success', message: `새 QR을 발급했습니다. 연결된 기기는 그대로 유지됩니다. 미사용 QR은 최대 ${REMOTE_CONTROL_MAX_SESSIONS}개이며, 초과 발급 시 가장 오래된 QR이 자동 폐기됩니다.` }
        : { kind: 'error', message: 'QR 원문을 받지 못했습니다. 잠시 후 다시 시도해 주세요.' });
    } catch (error) {
      setNotice({ kind: 'error', message: readableError(error) });
    } finally {
      setBusy(null);
    }
  };

  const handleApprove = async (session: InternetRemoteControlSession) => {
    if (busyRef.current || !session.sasCode) return;
    const entered = approvalCodes[session.sessionId] ?? '';
    if (entered !== session.sasCode) {
      setNotice({ kind: 'error', message: '휴대폰과 Mac에 보이는 6자리 코드를 확인한 뒤 정확히 입력해 주세요.' });
      return;
    }
    setBusy('approve');
    setNotice(null);
    try {
      const grantTaskScope = AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED
        && taskScopeApprovals[session.sessionId] === true;
      const grantConversationScope = conversationScopeApprovals[session.sessionId] === true;
      applyStatus(await api.approveSession(
        session.sessionId,
        entered,
        grantTaskScope,
        grantConversationScope,
      ));
      setApprovalCodes(current => {
        const next = { ...current };
        delete next[session.sessionId];
        return next;
      });
      setTaskScopeApprovals(current => {
        const next = { ...current };
        delete next[session.sessionId];
        return next;
      });
      setConversationScopeApprovals(current => {
        const next = { ...current };
        delete next[session.sessionId];
        return next;
      });
      setNotice({ kind: 'success', message: `${session.controllerName} 연결을 이 Mac에서 승인했습니다.` });
    } catch (error) {
      setNotice({ kind: 'error', message: readableError(error) });
    } finally {
      setBusy(null);
    }
  };

  const handleRevoke = async (session: InternetRemoteControlSession) => {
    if (busyRef.current
      || !window.confirm(`${session.controllerName}의 외부 인터넷 원격제어 권한을 해제할까요?`)) return;
    setBusy('revoke');
    setNotice(null);
    try {
      applyStatus(await api.revokeSession(session.sessionId));
      setNotice({ kind: 'success', message: `${session.controllerName} 연결을 해제했습니다.` });
    } catch (error) {
      setNotice({ kind: 'error', message: readableError(error) });
    } finally {
      setBusy(null);
    }
  };

  const handleUpdateScopes = async (session: InternetRemoteControlSession) => {
    if (busyRef.current) return;
    const draft = sessionScopeDrafts[session.sessionId];
    if (!draft) return;
    // A closed production containment gate may revoke an old grant, but it
    // must never mint a new task-execution authority from this UI.
    const nextTaskScope = AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED
      ? draft.task
      : session.taskScopeGranted && draft.task;
    if (nextTaskScope === session.taskScopeGranted
      && draft.conversation === session.conversationScopeGranted) return;
    const addsAuthority = (!session.taskScopeGranted && nextTaskScope)
      || (!session.conversationScopeGranted && draft.conversation);
    if (addsAuthority && !window.confirm(
      `${session.controllerName}에 선택한 Codex 런타임 권한을 추가할까요? 원격에서는 위험 권한 우회 실행이 허용되지 않습니다.`,
    )) return;
    setBusy('scopes');
    setNotice(null);
    try {
      applyStatus(await api.updateSessionScopes(
        session.sessionId,
        nextTaskScope,
        draft.conversation,
      ));
      setSessionScopeDrafts(current => {
        const next = { ...current };
        delete next[session.sessionId];
        return next;
      });
      setNotice({
        kind: 'success',
        message: `${session.controllerName}의 Codex 권한을 저장했습니다. QR 재연결 없이 바로 적용됩니다.`,
      });
    } catch (error) {
      setNotice({ kind: 'error', message: readableError(error) });
    } finally {
      setBusy(null);
    }
  };

  const handleDisable = async () => {
    if (busyRef.current
      || !window.confirm('이 Mac의 외부 인터넷 원격제어를 끄고 모든 QR·연결·승인을 차단할까요? 릴레이 항목은 즉시 정리되거나 자동 만료됩니다.')) return;
    setBusy('disable');
    setNotice(null);
    try {
      applyStatus(await api.disable());
      setPairing(null);
      visiblePairingIdRef.current = null;
      setApprovalCodes({});
      setSessionScopeDrafts({});
      setNotice({ kind: 'success', message: '이 Mac의 외부 인터넷 원격제어 권한을 모두 차단했습니다. 릴레이에 남은 항목은 사용할 수 없고 자동 만료됩니다.' });
    } catch (error) {
      setNotice({ kind: 'error', message: readableError(error) });
    } finally {
      setBusy(null);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[125] flex items-center justify-center bg-[var(--dialog-scrim)] p-3 backdrop-blur-sm sm:p-5"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !busyRef.current) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="internet-qr-remote-title"
        aria-describedby="internet-qr-remote-description"
        data-testid="internet-qr-remote-control-dialog"
        tabIndex={-1}
        style={{ maxHeight: 'calc(var(--ui-viewport-height, 100dvh) - max(24px, 10dvh))' }}
        className="flex w-full max-w-4xl min-w-0 flex-col overflow-hidden rounded-2xl border border-sky-300/20 bg-[var(--bg-elevated)] shadow-[var(--dialog-shadow)]"
      >
        <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-[rgb(var(--surface-highlight-rgb))]/[0.07] px-4 py-2 sm:px-5">
          <div className="flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-sky-300/20 bg-sky-300/[0.07] text-sky-200">
            <Globe2 className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="internet-qr-remote-title" className="m-0 text-base font-semibold text-zinc-50">
              외부 인터넷 QR 원격제어 · 베타
            </h2>
            <p id="internet-qr-remote-description" className="m-0 mt-0.5 text-xs text-zinc-400">
              같은 Wi‑Fi가 아니어도 개인 HTTPS 컨트롤러를 통해 이 Mac의 제한된 프로젝트 동작만 제어합니다.
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="외부 인터넷 QR 원격제어 닫기"
            disabled={busy !== null}
            onClick={onClose}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-xl text-zinc-400 transition-colors hover:bg-[rgb(var(--surface-highlight-rgb))]/5 hover:text-[var(--text-primary)] disabled:cursor-wait disabled:opacity-40"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5 sm:py-5">
          <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
            <div className="rounded-xl border border-sky-300/15 bg-sky-300/[0.05] p-3 text-xs leading-5 text-sky-100">
              <div className="mb-1 flex items-center gap-2 font-semibold"><Cloud className="h-4 w-4" /> 호스팅 독립</div>
              현재 구성은 Vercel에서 검증합니다. 정적 /remote 파일·Supabase 환경값·보안 헤더를 제공하는 HTTPS 호스트가 필요합니다.
            </div>
            <div className="rounded-xl border border-amber-300/15 bg-amber-300/[0.05] p-3 text-xs leading-5 text-amber-100">
              <div className="mb-1 flex items-center gap-2 font-semibold"><KeyRound className="h-4 w-4" /> 직접 승인</div>
              QR은 <strong className="text-[var(--text-primary)]">30일·1회용</strong> 초대장입니다. 유효기간이 길어도
              휴대폰과 Mac의 6자리 코드가 정확히 같을 때만 승인되며, 승인된 연결도 최대 30일 유지됩니다.
            </div>
            <div className="rounded-xl border border-teal-300/15 bg-teal-300/[0.05] p-3 text-xs leading-5 text-teal-100">
              <div className="mb-1 flex items-center gap-2 font-semibold"><ShieldCheck className="h-4 w-4" /> 제한된 권한</div>
              승인된 연결은 최대 30일 유지됩니다. 등록 프로젝트·워크트리 제어, 프로젝트·AgentsToZ/Orca 워크트리 생성,
              안전한 Codex 첫 대화 생성과 공식 Claude Code 원격 대화 시작,
              확인된 Git Commit·안전 Pull·Push·기본 브랜치 Merge와 허용된 앱 열기만 제공합니다.
            </div>
          </div>

          <div className="mb-4 rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/[0.08] bg-[rgb(var(--surface-shade-rgb))]/20 p-3 text-xs leading-5 text-zinc-300">
            휴대폰에서 QR을 연 뒤 개인 배포의 <strong className="text-[var(--text-primary)]">Google 로그인</strong>을 완료해야 합니다.
            임의 파일 읽기·쓰기, 임의 명령, 워크트리 삭제, AI 대화·자격증명·장기기억·What I Said·프롬프트 원문에는 접근 권한을 주지 않습니다.
            Git 작업은 등록 프로젝트에서 휴대폰 확인 후 정해진 안전 동작만 실행하며,
            이 Mac은 외부에 로컬 포트를 열지 않고 암호화된 릴레이를 확인합니다.
          </div>

          {notice && (
            <div
              role={notice.kind === 'error' ? 'alert' : 'status'}
              aria-live={notice.kind === 'error' ? 'assertive' : 'polite'}
              aria-atomic="true"
              className={`mb-4 rounded-xl border px-3 py-2 text-xs ${notice.kind === 'error'
                ? 'border-red-300/25 bg-red-300/[0.07] text-red-100'
                : 'border-teal-300/25 bg-teal-300/[0.07] text-teal-100'}`}
            >
              {notice.message}
            </div>
          )}

          {initialLoading || !status ? (
            <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" /> 외부 인터넷 원격제어 상태 확인 중…
            </div>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${stateClasses[status.state]}`}>
                  {stateLabels[status.state]}
                </span>
                {status.lastRelayContactAt && (
                  <span className="text-[11px] text-zinc-500">마지막 릴레이 확인 {readableTime(status.lastRelayContactAt)}</span>
                )}
                <button
                  type="button"
                  onClick={() => void refresh(true)}
                  disabled={busy !== null}
                  className="ml-auto flex min-h-11 items-center gap-1.5 rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/10 px-3 text-xs text-zinc-300 hover:bg-[rgb(var(--surface-highlight-rgb))]/5 disabled:opacity-40"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${busy === 'refresh' ? 'animate-spin' : ''}`} /> 상태 새로고침
                </button>
              </div>

              {!status.enabled ? (
                <section className="rounded-2xl border border-[rgb(var(--surface-highlight-rgb))]/[0.08] bg-[rgb(var(--surface-highlight-rgb))]/[0.025] p-4">
                  <h3 className="m-0 text-sm font-semibold text-zinc-100">개인 웹 컨트롤러 연결</h3>
                  <p className="mb-3 mt-1 text-xs leading-5 text-zinc-500">
                    특정 업체에 종속되지 않지만 호스트별 실측이 필요합니다. ChatGPT Sites는 배포·보안 헤더 호환성을 확인한 뒤 대체 후보로 사용할 수 있습니다.
                  </p>
                  <label className="block text-xs font-medium text-zinc-300" htmlFor="internet-remote-controller-origin">
                    휴대폰에서 열 주소 — 내가 배포한 포털의 HTTPS 주소
                  </label>
                  <input
                    id="internet-remote-controller-origin"
                    data-testid="internet-remote-controller-origin"
                    type="url"
                    inputMode="url"
                    autoComplete="url"
                    spellCheck={false}
                    value={controllerOrigin}
                    onChange={event => setControllerOrigin(event.target.value)}
                    placeholder="https://your-controller.example"
                    disabled={busy !== null}
                    className="mt-1 min-h-11 w-full rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/10 bg-[rgb(var(--surface-shade-rgb))]/30 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-700 focus:border-sky-300/50 disabled:opacity-50"
                  />
                  <p className="mb-0 mt-1 text-[11px] leading-5 text-zinc-500">
                    경로, query, fragment, ID·토큰·키를 넣을 수 없습니다. 이 주소의 /remote 코드 자체가
                    허용된 프로젝트 열기·프로세스 제어 요청을 만들 수 있으므로, 본인이 배포하고 신뢰하는 HTTPS 주소만 입력하세요.
                  </p>
                  {!controllerOrigin.trim() && (
                    // The address lives nowhere in the app, so a blank field is a dead end
                    // unless we say where it comes from. Filled automatically from then on.
                    <p
                      data-testid="internet-remote-origin-hint"
                      className="mb-0 mt-1 text-[11px] leading-5 text-amber-100"
                    >
                      이 저장소를 Vercel 등에 배포한 주소입니다(예: https://내포털.vercel.app).
                      한 번 연결하면 다음부터는 이 칸이 자동으로 채워집니다.
                    </p>
                  )}

                  <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-amber-300/15 bg-amber-300/[0.04] p-3 text-xs leading-5 text-zinc-300">
                    <input
                      type="checkbox"
                      checked={riskAcknowledged}
                      onChange={event => setRiskAcknowledged(event.target.checked)}
                      disabled={busy !== null}
                      className="mt-1 h-4 w-4 accent-teal-300"
                    />
                    <span>베타 기능이며, 신뢰하는 개인 배포 주소·30일 1회용 QR·6자리 직접 승인·최대 30일 연결·제한된 프로젝트 제어만 허용된다는 점을 확인했습니다.</span>
                  </label>

                  <button
                    type="button"
                    data-testid="enable-internet-qr-remote-control"
                    onClick={() => void handleEnable()}
                    disabled={busy !== null || !riskAcknowledged || !controllerOrigin.trim()}
                    className="mt-4 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-sky-200/30 bg-sky-300 px-4 text-sm font-semibold text-slate-950 transition-colors hover:bg-sky-200 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busy === 'enable' ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
                    외부 인터넷 원격제어 켜고 QR 발급
                  </button>
                </section>
              ) : (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_280px]">
                  <div className="min-w-0 space-y-4">
                    <section className="rounded-2xl border border-[rgb(var(--surface-highlight-rgb))]/[0.08] bg-[rgb(var(--surface-highlight-rgb))]/[0.025] p-4">
                      <h3 className="m-0 text-sm font-semibold text-zinc-100">연결 중인 개인 컨트롤러</h3>
                      <code className="mt-2 block break-all rounded-lg bg-[rgb(var(--surface-shade-rgb))]/30 p-2 text-[11px] text-sky-200">
                        {status.controllerUrl}
                      </code>
                      <div className="mt-2 grid grid-cols-1 gap-1 text-[11px] text-zinc-500 sm:grid-cols-2">
                        <span>이 Mac 등록 만료 {readableTime(status.hostExpiresAt)}</span>
                        <span>QR 유효 {readableTime(status.pairingExpiresAt)}</span>
                      </div>
                      {status.error && (
                        <p className="mb-0 mt-2 rounded-lg border border-red-300/20 bg-red-300/[0.05] p-2 text-xs text-red-100">{status.error}</p>
                      )}
                    </section>

                    {pendingSessions.map(session => {
                      const entered = approvalCodes[session.sessionId] ?? '';
                      const exactMatch = Boolean(session.sasCode && entered === session.sasCode);
                      return (
                        <section key={session.sessionId} data-testid="internet-remote-sas-approval" className="rounded-2xl border border-amber-300/25 bg-amber-300/[0.055] p-4">
                          <div className="flex items-start gap-3">
                            <Smartphone className="mt-0.5 h-5 w-5 shrink-0 text-amber-200" />
                            <div className="min-w-0 flex-1">
                              <h3 className="m-0 text-sm font-semibold text-amber-50">{session.controllerName} 승인 대기</h3>
                              <p className="mb-0 mt-1 text-xs leading-5 text-amber-100/75">
                                휴대폰 화면의 코드와 아래 Mac 코드가 정확히 같은지 사람 눈으로 확인하세요.
                              </p>
                            </div>
                          </div>
                          <div aria-label="Mac의 6자리 연결 확인 코드" className="my-3 rounded-xl border border-amber-200/25 bg-[rgb(var(--surface-shade-rgb))]/25 py-3 text-center font-mono text-3xl font-bold tracking-[0.28em] text-amber-100">
                            {session.sasCode ? `${session.sasCode.slice(0, 3)} ${session.sasCode.slice(3)}` : '확인 불가'}
                          </div>
                          <label className="block text-xs font-medium text-zinc-300" htmlFor={`sas-${session.sessionId}`}>
                            휴대폰과 일치한 6자리 코드를 직접 입력
                          </label>
                          <div className="mt-1 flex flex-col gap-2 sm:flex-row">
                            <input
                              id={`sas-${session.sessionId}`}
                              data-testid="internet-remote-sas-input"
                              type="text"
                              inputMode="numeric"
                              autoComplete="one-time-code"
                              pattern="[0-9]{6}"
                              maxLength={6}
                              value={entered}
                              onChange={event => setApprovalCodes(current => ({
                                ...current,
                                [session.sessionId]: event.target.value.replace(/\D/g, '').slice(0, 6),
                              }))}
                              disabled={busy !== null || !session.sasCode}
                              className="min-h-11 min-w-0 flex-1 rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/10 bg-[rgb(var(--surface-shade-rgb))]/30 px-3 text-center font-mono text-lg tracking-[0.2em] text-zinc-100 outline-none focus:border-amber-200/50 disabled:opacity-40"
                            />
                            <button
                              type="button"
                              data-testid="approve-internet-remote-session"
                              onClick={() => void handleApprove(session)}
                              disabled={busy !== null || !exactMatch}
                              className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-amber-200/30 bg-amber-200 px-4 text-xs font-semibold text-slate-950 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {busy === 'approve' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                              정확히 일치 — 승인
                            </button>
                          </div>
                          <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-xl border border-sky-300/15 bg-sky-300/[0.04] p-3 text-xs leading-5 text-zinc-300">
                            <input
                              type="checkbox"
                              data-testid="grant-internet-remote-task-scope"
                              checked={AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED
                                && taskScopeApprovals[session.sessionId] === true}
                              onChange={event => setTaskScopeApprovals(current => ({
                                ...current,
                                [session.sessionId]: event.target.checked,
                              }))}
                              disabled={busy !== null || !AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED}
                              className="mt-1 h-4 w-4 shrink-0 accent-sky-300"
                            />
                            <span>
                              이 모바일 기기에서 Codex 작업 시작·상태 확인·취소 허용
                              <span className="block text-[10px] text-zinc-500">
                                {AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED
                                  ? '선택하지 않으면 기존 프로젝트 원격제어만 허용됩니다. 위험 권한 우회 실행은 원격에서 허용되지 않습니다.'
                                  : '현재 production은 하위 프로세스까지 강제 회수하는 안전 격리가 준비되지 않아 새 Codex 작업 권한을 켤 수 없습니다.'}
                              </span>
                            </span>
                          </label>
                          <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-xl border border-violet-300/15 bg-violet-300/[0.04] p-3 text-xs leading-5 text-zinc-300">
                            <input
                              type="checkbox"
                              data-testid="grant-internet-remote-conversation-scope"
                              checked={conversationScopeApprovals[session.sessionId] === true}
                              onChange={event => setConversationScopeApprovals(current => ({
                                ...current,
                                [session.sessionId]: event.target.checked,
                              }))}
                              disabled={busy !== null}
                              className="mt-1 h-4 w-4 shrink-0 accent-violet-300"
                            />
                            <span>
                              이 모바일 기기에서 지속형 Codex 대화 및 대화 기록 열람 허용
                              <span className="block text-[10px] text-zinc-500">작업 실행 권한과 별개입니다. 선택한 프로젝트의 필터링된 대화 기록이 종단간 암호화되어 전송됩니다.</span>
                            </span>
                          </label>
                        </section>
                      );
                    })}

                    <section className="rounded-2xl border border-[rgb(var(--surface-highlight-rgb))]/[0.08] bg-[rgb(var(--surface-highlight-rgb))]/[0.025] p-4">
                      <h3 className="m-0 text-sm font-semibold text-zinc-100">승인된 모바일 기기</h3>
                      {connectedSessions.length ? (
                        <div className="mt-3 space-y-2">
                          {connectedSessions.map(session => {
                            const draft = sessionScopeDrafts[session.sessionId] ?? {
                              task: session.taskScopeGranted,
                              conversation: session.conversationScopeGranted,
                            };
                            const scopeChanged = draft.task !== session.taskScopeGranted
                              || draft.conversation !== session.conversationScopeGranted;
                            const canEditTaskScope = AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED
                              || draft.task;
                            const updateDraft = (change: Partial<SessionScopeDraft>) => {
                              setSessionScopeDrafts(current => ({
                                ...current,
                                [session.sessionId]: {
                                  ...(current[session.sessionId] ?? {
                                    task: session.taskScopeGranted,
                                    conversation: session.conversationScopeGranted,
                                  }),
                                  ...change,
                                },
                              }));
                            };
                            return (
                              <div key={session.sessionId} className="min-w-0 rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/[0.07] bg-[rgb(var(--surface-shade-rgb))]/20 p-3">
                                <div className="flex min-w-0 items-center gap-3">
                                  <Smartphone className="h-4 w-4 shrink-0 text-teal-200" />
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-xs font-semibold text-zinc-200">{session.controllerName}</div>
                                    <div className="mt-0.5 text-[10px] text-zinc-600">승인 후 최대 30일 · {readableTime(session.expiresAt)} 만료</div>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => void handleRevoke(session)}
                                    disabled={busy !== null}
                                    className="min-h-11 shrink-0 rounded-xl border border-red-300/20 px-3 text-xs text-red-200 hover:bg-red-300/[0.06] disabled:opacity-40"
                                  >
                                    연결 해제
                                  </button>
                                </div>
                                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                                  <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-sky-300/15 bg-sky-300/[0.04] px-3 text-xs text-zinc-300">
                                    <input
                                      type="checkbox"
                                      data-testid="update-internet-remote-task-scope"
                                      checked={draft.task}
                                      onChange={event => updateDraft({ task: event.target.checked })}
                                      disabled={busy !== null || !canEditTaskScope}
                                      className="h-4 w-4 shrink-0 accent-sky-300"
                                    />
                                    <span>
                                      Codex 작업
                                      {!AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED && (
                                        <span className="block text-[10px] text-zinc-500">
                                          {draft.task
                                            ? '과거 승인 권한 · 현재 실행 불가 · 해제만 가능'
                                            : '안전 격리 준비 중'}
                                        </span>
                                      )}
                                    </span>
                                  </label>
                                  <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-violet-300/15 bg-violet-300/[0.04] px-3 text-xs text-zinc-300">
                                    <input
                                      type="checkbox"
                                      data-testid="update-internet-remote-conversation-scope"
                                      checked={draft.conversation}
                                      onChange={event => updateDraft({ conversation: event.target.checked })}
                                      disabled={busy !== null}
                                      className="h-4 w-4 shrink-0 accent-violet-300"
                                    />
                                    지속형 대화·기록
                                  </label>
                                </div>
                                <div className="mt-2 flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
                                  <p className="m-0 text-[10px] leading-4 text-zinc-500">기존 프로젝트 제어는 유지됩니다. 위험 권한 우회는 원격에서 항상 차단됩니다.</p>
                                  <button
                                    type="button"
                                    data-testid="save-internet-remote-session-scopes"
                                    onClick={() => void handleUpdateScopes(session)}
                                    disabled={busy !== null || !scopeChanged}
                                    className="min-h-11 shrink-0 rounded-xl border border-teal-300/25 bg-teal-300/[0.07] px-3 text-xs font-semibold text-teal-100 hover:bg-teal-300/[0.12] disabled:cursor-not-allowed disabled:opacity-40"
                                  >
                                    {busy === 'scopes' ? '저장 중…' : '권한 저장'}
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="mb-0 mt-2 text-xs text-zinc-600">아직 이 Mac에서 승인한 모바일 기기가 없습니다.</p>
                      )}
                    </section>
                  </div>

                  <aside className="min-w-0">
                    {visiblePairing ? (
                      <div data-testid="internet-remote-pairing-qr" className="rounded-2xl border border-sky-300/20 bg-sky-300/[0.04] p-4 text-center">
                        <div className="mx-auto w-fit rounded-2xl bg-white p-2 shadow-xl shadow-black/40">
                          <QRCodeSVG
                            value={visiblePairing.pairingUrl}
                            size={220}
                            level="Q"
                            marginSize={4}
                            bgColor="#ffffff"
                            fgColor="#000000"
                            title="30일 일회용 외부 인터넷 원격제어 QR"
                          />
                        </div>
                        <div className="mt-3 text-xs font-semibold text-sky-100">30일·1회용 QR</div>
                        <div className="mt-1 font-mono text-lg text-[var(--text-primary)]">
                          {formatInternetRemoteControlRemaining(visiblePairing.expiresAt, now)}
                        </div>
                        <p className="mb-0 mt-2 text-[11px] leading-5 text-zinc-500">
                          QR 링크 자체는 브라우저 저장소·클립보드에 기록하지 않습니다. 스캔되거나 이 창을 닫으면 화면 메모리에서 제거합니다.
                          이 Mac은 재시작 후 기존 연결을 복원하려고 QR 연결 식별자·비밀값과 호스트 키를 앱 데이터 폴더의 이 계정 전용 파일(권한 0600)에 저장합니다.
                        </p>
                      </div>
                    ) : (
                      <div className="rounded-2xl border border-[rgb(var(--surface-highlight-rgb))]/[0.08] bg-[rgb(var(--surface-highlight-rgb))]/[0.025] p-4 text-xs leading-5 text-zinc-500">
                        <QrCode className="mb-2 h-5 w-5 text-zinc-600" />
                        일회용 QR 원문은 보안상 상태 조회에서 다시 불러오지 않습니다.
                        QR 하나는 기기 한 대만 연결할 수 있으니, 다른 기기를 추가하려면
                        아래에서 새 QR을 발급하세요. 연결된 기기는 그대로 유지됩니다.
                        미사용 QR은 최대 {REMOTE_CONTROL_MAX_SESSIONS}개이며, 초과 발급 시 가장 오래된 미사용 QR이 자동 폐기됩니다.
                      </div>
                    )}

                    <button
                      type="button"
                      data-testid="issue-internet-qr-remote-control-pairing"
                      onClick={() => void handleIssuePairing()}
                      disabled={busy !== null}
                      className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-teal-300/25 bg-teal-300/[0.07] px-3 text-xs font-semibold text-teal-100 hover:bg-teal-300/[0.11] disabled:cursor-wait disabled:opacity-40"
                    >
                      {busy === 'issue'
                        ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        : <QrCode className="h-4 w-4" aria-hidden="true" />}
                      다른 기기 추가 (새 QR)
                    </button>
                    <button
                      type="button"
                      data-testid="disable-internet-qr-remote-control"
                      onClick={() => void handleDisable()}
                      disabled={busy !== null}
                      className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-red-300/25 px-3 text-xs font-semibold text-red-200 hover:bg-red-300/[0.06] disabled:opacity-40"
                    >
                      {busy === 'disable' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unplug className="h-4 w-4" />}
                      외부 인터넷 원격제어 전체 끄기
                    </button>
                  </aside>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
