import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Loader2, QrCode, RefreshCw, ShieldCheck, Smartphone, Unplug, X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import {
  formatQrRemoteControlRemaining,
  isQrRemoteControlPairingExpired,
  type QrRemoteControlInterface,
  type QrRemoteControlPairingIssue,
  type QrRemoteControlSession,
  type QrRemoteControlStatus,
} from './qrRemoteControlContract';
import { qrRemoteControlApi, type QrRemoteControlApi } from './qrRemoteControlClient';
// The device cap is the host's, not a number to restate in copy. Import from
// the protocol module: remoteControlCore pulls in node:crypto.
import { REMOTE_CONTROL_MAX_SESSIONS } from './remoteControlProtocol';

export interface QrRemoteControlDialogProps {
  open: boolean;
  onClose: () => void;
  api?: QrRemoteControlApi;
}

type BusyAction = 'refresh' | 'enable' | 'rotate' | 'revoke' | 'disable' | null;
type Notice = { kind: 'success' | 'error'; message: string } | null;

const interactiveSelector = [
  'button:not([disabled])',
  'select:not([disabled])',
  'input:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const readableError = (error: unknown): string => (
  error instanceof Error && error.message.trim()
    ? error.message
    : 'QR 원격제어 요청을 완료하지 못했습니다.'
);

const readableTime = (value: string | null): string => {
  if (!value) return '아직 확인되지 않음';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '확인할 수 없음';
};

export function QrRemoteControlDialog({
  open,
  onClose,
  api = qrRemoteControlApi,
}: QrRemoteControlDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef<BusyAction>(null);
  const managementRevisionRef = useRef(0);
  const [status, setStatus] = useState<QrRemoteControlStatus | null>(null);
  const [interfaces, setInterfaces] = useState<QrRemoteControlInterface[]>([]);
  const [selectedInterface, setSelectedInterface] = useState('');
  const [pairingIssue, setPairingIssue] = useState<QrRemoteControlPairingIssue | null>(null);
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

  const refresh = useCallback(async (showOutcome = false) => {
    setBusy('refresh');
    setNotice(null);
    const results = await Promise.allSettled([api.status(), api.interfaces()]);
    const statusResult = results[0];
    const interfacesResult = results[1];
    if (statusResult.status === 'fulfilled') {
      setStatus(statusResult.value);
      if (!statusResult.value.pairing) setPairingIssue(null);
    }
    if (interfacesResult.status === 'fulfilled') {
      setInterfaces(interfacesResult.value);
      setSelectedInterface(current => (
        interfacesResult.value.some(item => item.address === current)
          ? current
          : interfacesResult.value[0]?.address ?? ''
      ));
    }
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected?.status === 'rejected') {
      setNotice({ kind: 'error', message: readableError(rejected.reason) });
    } else if (showOutcome) {
      setNotice({ kind: 'success', message: '현재 원격제어 상태를 다시 확인했습니다.' });
    }
    setBusy(null);
  }, [api, setBusy]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setInitialLoading(true);
    setStatus(null);
    setInterfaces([]);
    setSelectedInterface('');
    setPairingIssue(null);
    setNotice(null);
    void refresh().finally(() => {
      if (!cancelled) setInitialLoading(false);
    });
    return () => { cancelled = true; };
  }, [open, refresh]);

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
        if (!cancelled && revision === managementRevisionRef.current) {
          setStatus(latest);
          if (!latest.pairing) setPairingIssue(null);
        }
      } catch {
        // Keep the last confirmed state. Manual refresh reports connection errors.
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
  }, [open, api]);

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
      if (focusable.length === 0) {
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

  const effectiveExpiry = pairingIssue?.expiresAt ?? status?.pairing?.expiresAt ?? null;
  useEffect(() => {
    if (!open || !effectiveExpiry) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [open, effectiveExpiry]);

  const pairingExpired = effectiveExpiry
    ? isQrRemoteControlPairingExpired(effectiveExpiry, now)
    : false;
  const pairingRemaining = effectiveExpiry
    ? formatQrRemoteControlRemaining(effectiveExpiry, now)
    : null;
  const visiblePairingUrl = pairingIssue && !pairingExpired ? pairingIssue.pairingUrl : null;

  const listenerLabel = useMemo(() => (
    status?.listener ? `${status.listener.host}:${status.listener.port}` : null
  ), [status?.listener]);

  const handleEnable = async () => {
    if (!selectedInterface || busyRef.current) return;
    setBusy('enable');
    setNotice(null);
    try {
      const enabled = await api.enable(selectedInterface);
      setStatus(enabled);
      try {
        const issued = await api.rotatePairing();
        setPairingIssue(issued);
        const refreshed = await api.status().catch(() => enabled);
        setStatus(refreshed);
        setNotice({ kind: 'success', message: '이 Mac의 QR 원격제어를 켜고 새 QR을 발급했습니다.' });
      } catch (error) {
        setNotice({
          kind: 'error',
          message: `원격제어는 켜졌지만 QR을 발급하지 못했습니다. ${readableError(error)}`,
        });
      }
    } catch (error) {
      setNotice({ kind: 'error', message: readableError(error) });
    } finally {
      setBusy(null);
    }
  };

  const handleRotate = async () => {
    if (busyRef.current) return;
    // No confirmation: minting a QR is not destructive any more. It used to end
    // the connected session, and the warning that said so is precisely why
    // adding a second device read as impossible (VOC 2026-08-31 23:42). The
    // only thing lost is a previously issued QR that nobody has scanned yet.
    setBusy('rotate');
    setNotice(null);
    try {
      const issued = await api.rotatePairing();
      setPairingIssue(issued);
      const refreshed = await api.status().catch(() => status);
      if (refreshed) setStatus(refreshed);
      setNotice({
        kind: 'success',
        message: status?.sessions.length
          ? '새 일회용 QR을 발급했습니다. 연결된 기기는 그대로 유지됩니다.'
          : '이전 QR을 무효화하고 새 일회용 QR을 발급했습니다.',
      });
    } catch (error) {
      setNotice({ kind: 'error', message: readableError(error) });
    } finally {
      setBusy(null);
    }
  };

  const handleCopyLink = async () => {
    if (!visiblePairingUrl) return;
    try {
      await navigator.clipboard.writeText(visiblePairingUrl);
      setNotice({ kind: 'success', message: '일회용 연결 링크를 복사했습니다.' });
    } catch {
      setNotice({ kind: 'error', message: '연결 링크를 복사하지 못했습니다.' });
    }
  };

  const handleRevokeSession = async (session: QrRemoteControlSession) => {
    if (busyRef.current || !window.confirm(`${session.label} 연결을 해제할까요?`)) return;
    setBusy('revoke');
    setNotice(null);
    try {
      setStatus(await api.revokeSession(session.id));
      setNotice({ kind: 'success', message: `${session.label} 연결을 해제했습니다.` });
    } catch (error) {
      setNotice({ kind: 'error', message: readableError(error) });
    } finally {
      setBusy(null);
    }
  };

  const handleRevokeAll = async () => {
    if (busyRef.current || !window.confirm('연결된 휴대폰과 iPad를 모두 해제할까요?')) return;
    setBusy('revoke');
    setNotice(null);
    try {
      setStatus(await api.revokeAllSessions());
      setNotice({ kind: 'success', message: '모든 모바일 연결을 해제했습니다.' });
    } catch (error) {
      setNotice({ kind: 'error', message: readableError(error) });
    } finally {
      setBusy(null);
    }
  };

  const handleDisable = async () => {
    if (busyRef.current || !window.confirm('QR 원격제어를 끄고 모든 연결과 QR을 무효화할까요?')) return;
    setBusy('disable');
    setNotice(null);
    try {
      setStatus(await api.disable());
      setPairingIssue(null);
      setNotice({ kind: 'success', message: '이 Mac의 QR 원격제어를 껐습니다.' });
    } catch (error) {
      setNotice({ kind: 'error', message: readableError(error) });
    } finally {
      setBusy(null);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-[var(--dialog-scrim)] p-3 backdrop-blur-sm sm:p-5"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !busyRef.current) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="qr-remote-control-title"
        aria-describedby="qr-remote-control-description"
        data-testid="qr-remote-control-dialog"
        tabIndex={-1}
        style={{ maxHeight: 'calc(var(--ui-viewport-height, 100dvh) - max(24px, 10dvh))' }}
        className="flex w-full max-w-3xl min-w-0 flex-col overflow-hidden rounded-2xl border border-teal-300/20 bg-[var(--bg-elevated)] shadow-[var(--dialog-shadow)]"
      >
        <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-[rgb(var(--surface-highlight-rgb))]/[0.07] px-4 py-2 sm:px-5">
          <div className="flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-teal-300/15 bg-teal-300/[0.06] text-teal-200">
            <QrCode className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="qr-remote-control-title" className="m-0 text-base font-semibold text-zinc-50">
              QR 원격제어 · 이 Mac
            </h2>
            <p id="qr-remote-control-description" className="m-0 mt-0.5 text-xs text-zinc-400">
              휴대폰이나 iPad에서 등록 프로젝트·워크트리의 프로세스를 제어하고 이 Mac의 허용된 앱으로 엽니다.
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            data-testid="qr-remote-control-close"
            aria-label="QR 원격제어 닫기"
            disabled={busy !== null}
            onClick={onClose}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-xl text-zinc-400 transition-colors hover:bg-[rgb(var(--surface-highlight-rgb))]/5 hover:text-[var(--text-primary)] disabled:cursor-wait disabled:opacity-40"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5 sm:py-5">
          <div className="mb-4 flex items-start gap-3 rounded-xl border border-amber-300/15 bg-amber-300/[0.05] p-3 text-xs leading-5 text-amber-100">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-200" aria-hidden="true" />
            <p className="m-0">
              같은 신뢰할 수 있는 개인 Wi‑Fi에서만 사용하세요. 공용·게스트 Wi‑Fi에서는 켜지 마세요.
              파일 내용·Git 변경·AI 대화·자격증명·장기기억·프롬프트 데이터에는 접근 권한을 주지 않습니다.
            </p>
          </div>

          {notice && (
            <div
              role={notice.kind === 'error' ? 'alert' : 'status'}
              aria-live={notice.kind === 'error' ? 'assertive' : 'polite'}
              aria-atomic="true"
              data-testid="qr-remote-control-notice"
              className={`mb-4 rounded-xl border px-3 py-2.5 text-xs leading-5 ${notice.kind === 'error'
                ? 'border-red-300/20 bg-red-300/[0.06] text-red-100'
                : 'border-teal-300/20 bg-teal-300/[0.06] text-teal-100'}`}
            >
              {notice.message}
            </div>
          )}

          {initialLoading && !status ? (
            <div role="status" aria-live="polite" className="flex min-h-40 items-center justify-center gap-2 text-sm text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              원격제어 상태를 확인하는 중…
            </div>
          ) : !status ? (
            <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/[0.08] bg-[rgb(var(--surface-highlight-rgb))]/[0.02] p-5 text-center">
              <p className="m-0 text-sm text-zinc-300">현재 상태를 확인하지 못했습니다.</p>
              <button
                type="button"
                onClick={() => void refresh(true)}
                disabled={busy !== null}
                className="flex min-h-11 items-center gap-2 rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/10 bg-[rgb(var(--surface-highlight-rgb))]/[0.04] px-4 text-sm text-zinc-100 hover:bg-[rgb(var(--surface-highlight-rgb))]/[0.07] disabled:cursor-wait disabled:opacity-40"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />다시 확인
              </button>
            </div>
          ) : !status.enabled ? (
            <section aria-labelledby="qr-remote-control-off-title" className="rounded-2xl border border-[rgb(var(--surface-highlight-rgb))]/[0.08] bg-[rgb(var(--surface-highlight-rgb))]/[0.02] p-4 sm:p-5">
              <div className="flex items-start gap-3">
                <Smartphone className="mt-0.5 h-5 w-5 shrink-0 text-zinc-300" aria-hidden="true" />
                <div className="min-w-0">
                  <h3 id="qr-remote-control-off-title" className="m-0 text-sm font-semibold text-zinc-100">현재 꺼져 있습니다</h3>
                  <p className="m-0 mt-1 text-xs leading-5 text-zinc-400">
                    사용자가 직접 켜기 전에는 LAN listener가 열리지 않습니다. 켜면 선택한 이 Mac의 사설 주소에서만 기다립니다.
                  </p>
                </div>
              </div>
              <label className="mt-5 block text-xs font-medium text-zinc-300" htmlFor="qr-remote-interface">
                휴대폰과 같은 네트워크 주소
              </label>
              <select
                id="qr-remote-interface"
                data-testid="qr-remote-control-interface"
                value={selectedInterface}
                onChange={event => setSelectedInterface(event.target.value)}
                disabled={busy !== null || interfaces.length === 0}
                className="mt-2 min-h-11 w-full rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/10 bg-[var(--bg-deep)] px-3 text-base text-zinc-100 disabled:opacity-50 sm:text-sm"
              >
                {interfaces.length === 0 && <option value="">사용 가능한 개인 네트워크 없음</option>}
                {interfaces.map(item => (
                  <option key={item.address} value={item.address}>{item.name} · {item.address}</option>
                ))}
              </select>
            </section>
          ) : (
            <div className="space-y-4">
              <section className="rounded-2xl border border-teal-300/15 bg-teal-300/[0.035] p-4 sm:p-5" aria-labelledby="qr-remote-pairing-title">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs font-semibold text-teal-100">
                      <Check className="h-4 w-4" aria-hidden="true" />이 Mac에서 원격제어 켜짐
                    </div>
                    {listenerLabel && <div className="mt-1 break-all font-mono text-[11px] text-zinc-400">{listenerLabel}</div>}
                  </div>
                  <button
                    type="button"
                    onClick={() => void refresh(true)}
                    disabled={busy !== null}
                    className="flex min-h-11 items-center gap-2 rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/10 bg-[rgb(var(--surface-highlight-rgb))]/[0.03] px-3 text-xs text-zinc-200 hover:bg-[rgb(var(--surface-highlight-rgb))]/[0.06] disabled:cursor-wait disabled:opacity-40"
                  >
                    <RefreshCw className={`h-4 w-4 ${busy === 'refresh' ? 'animate-spin' : ''}`} aria-hidden="true" />상태 확인
                  </button>
                </div>

                <div className="grid min-w-0 grid-cols-1 gap-5 md:grid-cols-[minmax(0,1fr)_260px]">
                  <div className="min-w-0">
                    <h3 id="qr-remote-pairing-title" className="m-0 text-sm font-semibold text-zinc-100">휴대폰·iPad 연결</h3>
                    <ol className="mt-2 space-y-1 pl-5 text-xs leading-5 text-zinc-400">
                      <li>휴대폰을 이 Mac과 같은 개인 Wi‑Fi에 연결합니다.</li>
                      <li>카메라로 QR을 찍고 브라우저에서 연결을 승인합니다.</li>
                      <li>QR은 한 번만 쓸 수 있고 30일 뒤 만료됩니다.</li>
                    </ol>
                    {effectiveExpiry && (
                      <p className={`mt-3 text-xs font-medium ${pairingExpired ? 'text-red-200' : 'text-teal-200'}`}>
                        {pairingExpired ? 'QR이 만료되었습니다.' : `QR 남은 시간 ${pairingRemaining}`}
                      </p>
                    )}
                    {status.pairing && !pairingIssue && !pairingExpired && (
                      <p className="mt-3 text-xs leading-5 text-amber-100">
                        기존 QR 원문은 보안상 다시 불러오지 않습니다. 아래에서 새 QR을 발급하세요.
                      </p>
                    )}
                    {status.sessions.length > 0 && (
                      <p className="mt-3 text-xs leading-5 text-teal-100" data-testid="qr-remote-control-add-device-hint">
                        이미 연결된 기기는 그대로 유지됩니다. 다른 휴대폰·iPad를 추가하려면
                        새 QR을 발급해 그 기기에서 찍으세요 (최대 {REMOTE_CONTROL_MAX_SESSIONS}대).
                      </p>
                    )}
                    <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                      <button
                        type="button"
                        data-testid="qr-remote-control-rotate"
                        onClick={() => void handleRotate()}
                        disabled={busy !== null}
                        className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-teal-300/20 bg-teal-300/[0.07] px-4 text-xs font-semibold text-teal-100 hover:bg-teal-300/[0.11] disabled:cursor-wait disabled:opacity-40"
                      >
                        {busy === 'rotate' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <QrCode className="h-4 w-4" aria-hidden="true" />}
                        {status.sessions.length > 0
                          ? '다른 기기 추가 (새 QR)'
                          : pairingIssue || status.pairing ? 'QR 재발급' : '새 QR 발급'}
                      </button>
                      <button
                        type="button"
                        data-testid="qr-remote-control-copy-link"
                        onClick={() => void handleCopyLink()}
                        disabled={busy !== null || !visiblePairingUrl}
                        className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/10 bg-[rgb(var(--surface-highlight-rgb))]/[0.03] px-4 text-xs text-zinc-200 hover:bg-[rgb(var(--surface-highlight-rgb))]/[0.06] disabled:cursor-not-allowed disabled:opacity-35"
                      >
                        <Copy className="h-4 w-4" aria-hidden="true" />연결 링크 복사
                      </button>
                    </div>
                  </div>

                  <div className="flex min-h-[240px] min-w-0 items-center justify-center rounded-2xl border border-[rgb(var(--surface-highlight-rgb))]/[0.08] bg-[var(--bg-deep)] p-3">
                    {visiblePairingUrl ? (
                      <div className="w-full max-w-[240px] rounded-xl bg-white p-2 shadow-lg">
                        <QRCodeSVG
                          value={visiblePairingUrl}
                          title="일회용 QR 원격제어 연결 코드"
                          level="Q"
                          marginSize={4}
                          bgColor="#ffffff"
                          fgColor="#000000"
                          className="h-auto w-full"
                          data-testid="qr-remote-control-code"
                        />
                      </div>
                    ) : (
                      <div className="px-4 text-center text-xs leading-5 text-zinc-500">
                        <QrCode className="mx-auto mb-2 h-8 w-8" aria-hidden="true" />
                        {pairingExpired ? '새 QR을 발급해 주세요.' : 'QR을 발급하면 이곳에 한 번만 표시됩니다.'}
                      </div>
                    )}
                  </div>
                </div>
              </section>

              <section className="rounded-2xl border border-[rgb(var(--surface-highlight-rgb))]/[0.08] bg-[rgb(var(--surface-highlight-rgb))]/[0.02] p-4 sm:p-5" aria-labelledby="qr-remote-sessions-title">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 id="qr-remote-sessions-title" className="m-0 text-sm font-semibold text-zinc-100">
                    연결된 기기 · {status.sessions.length}
                  </h3>
                  {status.sessions.length > 1 && (
                    <button
                      type="button"
                      onClick={() => void handleRevokeAll()}
                      disabled={busy !== null}
                      className="flex min-h-11 items-center gap-2 rounded-xl border border-red-300/15 bg-red-300/[0.04] px-3 text-xs text-red-100 hover:bg-red-300/[0.08] disabled:cursor-wait disabled:opacity-40"
                    >
                      <Unplug className="h-4 w-4" aria-hidden="true" />모두 연결 해제
                    </button>
                  )}
                </div>
                {status.sessions.length === 0 ? (
                  <p className="m-0 mt-3 text-xs leading-5 text-zinc-500">아직 연결된 휴대폰이나 iPad가 없습니다.</p>
                ) : (
                  <ul className="m-0 mt-3 space-y-2 p-0" role="list">
                    {status.sessions.map(session => (
                      <li key={session.id} className="flex min-w-0 flex-col gap-3 rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/[0.07] bg-[rgb(var(--surface-shade-rgb))]/10 p-3 sm:flex-row sm:items-center">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-zinc-200">{session.label}</div>
                          <div className="mt-1 text-[11px] leading-4 text-zinc-400">
                            마지막 확인 {readableTime(session.lastSeenAt)}
                          </div>
                        </div>
                        <button
                          type="button"
                          data-testid="qr-remote-control-revoke-session"
                          onClick={() => void handleRevokeSession(session)}
                          disabled={busy !== null}
                          className="flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl border border-red-300/15 bg-red-300/[0.04] px-3 text-xs text-red-100 hover:bg-red-300/[0.08] disabled:cursor-wait disabled:opacity-40"
                        >
                          <Unplug className="h-4 w-4" aria-hidden="true" />연결 해제
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <button
                type="button"
                data-testid="qr-remote-control-disable"
                onClick={() => void handleDisable()}
                disabled={busy !== null}
                className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-red-300/20 bg-red-300/[0.05] px-4 text-sm font-semibold text-red-100 hover:bg-red-300/[0.09] disabled:cursor-wait disabled:opacity-40"
              >
                {busy === 'disable' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Unplug className="h-4 w-4" aria-hidden="true" />}
                원격제어 전체 끄기
              </button>
            </div>
          )}
        </div>

        {status && !status.enabled && (
          <footer className="shrink-0 border-t border-[rgb(var(--surface-highlight-rgb))]/[0.07] bg-[var(--bg-elevated)] px-4 py-3 sm:px-5">
            <button
              type="button"
              data-testid="qr-remote-control-enable"
              onClick={() => void handleEnable()}
              disabled={busy !== null || !selectedInterface}
              className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-teal-300 px-4 text-sm font-semibold text-[var(--text-on-accent)] transition-colors hover:bg-teal-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === 'enable' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <QrCode className="h-4 w-4" aria-hidden="true" />}
              {busy === 'enable' ? '켜고 QR 발급 중…' : '이 Mac에서 켜고 QR 발급'}
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}

export default QrRemoteControlDialog;
