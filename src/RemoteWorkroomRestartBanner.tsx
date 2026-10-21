import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { aiTerminalAgentLabel } from './aiTerminalAgentLabel';
import { checkRemoteHistoryResume, remoteHistoryOutcomeMessage, type RemoteHistoryTransport } from './remoteWorkroomHistoryClient';
import {
  dismissRemoteRestart, hideRemoteRestartOffer, listRemoteRestart, remoteRestartBatchSummary, remoteRestartOfferHidden, remoteRestartRunnableRows, resumeRemoteRestartRows,
} from './remoteWorkroomRestartClient';
import {
  REMOTE_HISTORY_PENDING_EVENT, announceRemoteHistoryPending, pendingRemoteHistoryResumes, remoteRestartRunnable,
  type RemoteRestartOffer, type RemoteRestartRow,
} from './workroomHistoryRemoteProtocol';
import {
  REMOTE_RESTART_AVAILABILITY_PHRASE, REMOTE_RESTART_DISMISS_HINT, REMOTE_RESTART_GRANT_SENTENCE, REMOTE_RESTART_HIDE_HINT, REMOTE_RESTART_MORE_HINT,
  REMOTE_RESTART_NONE_REASON, REMOTE_RESTART_OFFER_NONE_SENTENCE, REMOTE_RESTART_OFFER_SENTENCE, REMOTE_RESTART_READ_SENTENCE, RESTART_BYPASS_LINE, RESTART_ROW_BYPASS, WORKROOM_RESTART_CONFIRM_GUARD_MS,
  remoteRestartCollapsedLabel, restartConfirmOneText, restartConfirmText, restartProgressText, restartRowLabeler, restartRowStarted,
} from './workroomRestartText';
import './WorkroomRestartBanner.css';

type BannerStorage = Pick<Storage, 'getItem' | 'setItem'>;
type Armed = { kind: 'all' } | { kind: 'one'; rowId: string };
const browserStorage = (): BannerStorage | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };
const readable = (error: unknown) => error instanceof Error && /[가-힣]/.test(error.message) ? error.message : '이어 열기 안내를 처리하지 못했습니다.';

export interface RemoteRestartBannerViewProps {
  offer: RemoteRestartOffer;
  expanded: boolean; armed: Armed | null; progress: { done: number; total: number } | null;
  summary: string; notice: string;
  /** Conversations this phone sent and has not settled: 「결과 확인」, never 「이어 열기」. */
  pendingIds: ReadonlySet<string>;
  online: boolean;
  /** A row's name alone (its header); its start time is on the line under it. */
  name?(row: RemoteRestartRow): string;
  /** A row named alone (a confirmation, a summary): two of one project and AI carry their start time. */
  label(row: RemoteRestartRow): string;
  onToggle(): void; onArm(armed: Armed): void; onConfirm(): void; onCancel(): void; onDismiss(): void; onHide(): void; onCheck(row: RemoteRestartRow): void;
  /** Focus goes into the confirmation sentence when it opens (keyboard, VoiceOver). */
  confirmRef?: (element: HTMLParagraphElement | null) => void;
  armRef?: (key: string, element: HTMLButtonElement | null) => void;
}

/**
 * 「업데이트 전 실행 중이던 작업 세션 N개 이어 열기」 on the phone (w14, Build B) — presentation only. Folded it is one 44px
 * button; open, each row says in one phrase whether it can be opened. 「N개 이어 열기」 and a row's 「이어 열기」 arm a
 * confirmation in its own block (never where the button was). 「닫기」 closes it for every window only when this phone sees
 * every row and may resume; otherwise 「이 휴대폰에서 숨기기」.
 */
export function RemoteRestartBannerView(props: RemoteRestartBannerViewProps) {
  const { offer, expanded, armed, progress, summary, notice, pendingIds, online, label } = props;
  const runnable = offer.rows.filter(row => remoteRestartRunnable(row.availability) && !pendingIds.has(row.id));
  // The Mac marks a row `grant` when this phone may not resume it: the sentence says why. Whether this phone may close the
  // offer for everyone is the Mac's own answer (`closable`), never inferred from the rows (w14 review).
  const noResume = offer.rows.some(row => row.availability === 'grant');
  const closable = offer.closable;
  // A phone that may not read history is told how many, never which: no rows, one sentence, 「이 휴대폰에서 숨기기」.
  const countOnly = !offer.rows.length && offer.unlisted > 0;
  const count = countOnly ? offer.unlisted : offer.rows.length;
  const bypass = offer.rows.some(row => row.bypass !== false);
  const busy = !!progress;
  const armedRow = armed?.kind === 'one' ? offer.rows.find(row => row.id === armed.rowId) : undefined;
  return <section className="workroom-restart-banner workroom-restart-banner--phone" data-testid="remote-workroom-restart" data-help-key="workroom-restart"
    aria-label="재시작 전 작업 세션 이어 열기">
    <button type="button" className="workroom-restart-collapsed" data-testid="remote-workroom-restart-toggle" aria-expanded={expanded} onClick={props.onToggle}>
      <RotateCcw size={18} aria-hidden="true"/>
      <span>{remoteRestartCollapsedLabel(count, offer.update, runnable.length > 0)}</span>
      {expanded ? <ChevronDown size={18} className="workroom-restart-chevron" aria-hidden="true"/> : <ChevronRight size={18} className="workroom-restart-chevron" aria-hidden="true"/>}
    </button>
    {expanded && <div className="workroom-restart-body" data-testid="remote-workroom-restart-body">
      {/* The folded button already names it (「업데이트 전 작업 세션 N개」): the body starts with what it is. */}
      {/* What it does only when something opens from here; otherwise what it is, and the sentence below says why. */}
      <p className="workroom-restart-text">{runnable.length ? REMOTE_RESTART_OFFER_SENTENCE + (bypass ? ` ${RESTART_BYPASS_LINE}` : '')
        : REMOTE_RESTART_OFFER_NONE_SENTENCE + (countOnly || noResume || pendingIds.size ? '' : ` ${REMOTE_RESTART_NONE_REASON}`)}</p>
      {offer.more && <p className="workroom-restart-text" data-testid="remote-workroom-restart-more">{REMOTE_RESTART_MORE_HINT}</p>}
      {countOnly && <p className="workroom-restart-text workroom-restart-text--strong" role="status" data-testid="remote-workroom-restart-read">{REMOTE_RESTART_READ_SENTENCE}</p>}
      {noResume && <p className="workroom-restart-text workroom-restart-text--strong" role="status" data-testid="remote-workroom-restart-grant">{REMOTE_RESTART_GRANT_SENTENCE}</p>}
      {!countOnly && <ul className="workroom-restart-rows">{offer.rows.map(row => {
        const pending = pendingIds.has(row.id), open = remoteRestartRunnable(row.availability) && !pending;
        const phrase = pending ? '이어 열기 결과 확인 필요' : REMOTE_RESTART_AVAILABILITY_PHRASE[row.availability], started = restartRowStarted(row.createdAt);
        return <li key={row.id} data-testid="remote-workroom-restart-row" data-conversation-id={row.id} data-availability={pending ? 'pending' : row.availability}>
          <div className="workroom-restart-row-text"><strong>{(props.name ?? label)(row)}</strong>
            <small>{started ? `${started} · ` : ''}{phrase}{row.bypass ? ` · ${RESTART_ROW_BYPASS}` : ''}</small></div>
          {(pending || open) && <div className="workroom-restart-row-actions">
            {pending && <button type="button" className="workroom-restart-btn" data-testid="remote-workroom-restart-row-check" disabled={busy || !online} onClick={() => props.onCheck(row)}>결과 확인</button>}
            {open && <button type="button" className="workroom-restart-btn" data-testid="remote-workroom-restart-row-open" disabled={busy || !online}
              ref={element => props.armRef?.(row.id, element)} onClick={() => props.onArm({ kind: 'one', rowId: row.id })}>이어 열기</button>}
          </div>}
        </li>;
      })}</ul>}
      {armed
        ? <div key="confirm" className="workroom-restart-confirm" role="group" aria-label="이어 열기 확인" data-testid="remote-workroom-restart-confirm">
            <p ref={props.confirmRef} tabIndex={-1}>{armed.kind === 'all' ? restartConfirmText(runnable.length) : restartConfirmOneText(armedRow ? label(armedRow) : '')}</p>
            <button type="button" className="workroom-restart-btn workroom-restart-btn--primary" data-testid="remote-workroom-restart-confirm-open" disabled={busy || !online} onClick={props.onConfirm}>이 Mac에서 열기</button>
            <button type="button" className="workroom-restart-btn" data-testid="remote-workroom-restart-confirm-cancel" onClick={props.onCancel}>취소</button>
          </div>
        : <div key="actions" className="workroom-restart-actions">
            {runnable.length > 0 && <button type="button" className="workroom-restart-btn workroom-restart-btn--primary" data-testid="remote-workroom-restart-open-all" disabled={busy || !online}
              ref={element => props.armRef?.('all', element)} onClick={() => props.onArm({ kind: 'all' })}>{runnable.length}개 이어 열기</button>}
            {closable
              ? <button type="button" className="workroom-restart-btn" data-testid="remote-workroom-restart-dismiss" disabled={busy || !online} onClick={props.onDismiss}>닫기</button>
              : <button type="button" className="workroom-restart-btn" data-testid="remote-workroom-restart-hide" disabled={busy} onClick={props.onHide}>이 휴대폰에서 숨기기</button>}
            <span className="workroom-restart-hint">{closable ? REMOTE_RESTART_DISMISS_HINT : REMOTE_RESTART_HIDE_HINT}</span>
          </div>}
      {progress && <p className="workroom-restart-text" role="status" data-testid="remote-workroom-restart-progress">{restartProgressText(progress.done, progress.total)}</p>}
    </div>}
    {summary && <p className="workroom-restart-text" role="status" data-testid="remote-workroom-restart-summary">{summary}</p>}
    {notice && <p className="workroom-restart-text" role="status" data-testid="remote-workroom-restart-notice">{notice}</p>}
  </section>;
}

/**
 * The phone's restart banner for the connected Mac (`workroom-restart-v1`). It asks the Mac when the Workroom shows with
 * the Mac online, when the phone comes back online and after each action — never on a timer. A Mac without the feature
 * gets nothing rendered and no request. Every reopen is the existing per-row path (`resumeRemoteHistory`), one at a time.
 */
export function RemoteWorkroomRestartBanner({ available, visible, online, host, pairing = null, controlId, projects, transport, storage: suppliedStorage, onResumed }: {
  available: boolean; visible: boolean; online: boolean; host: string;
  /** This phone's current pairing with `host` (`remoteHistoryPairing`); null when it cannot be named. */
  pairing?: string | null;
  /** The project the offer is asked through (any of this phone's: the Mac answers for all of them). */
  controlId: string;
  projects: readonly { targetId: string; label: string }[];
  transport: RemoteHistoryTransport;
  storage?: BannerStorage | null;
  /** After a reopen: the opened session ids, and whether a person confirmed one row's 「이어 열기」 (the portal then selects
   *  it like 「대화 기록」 does; after 「N개 이어 열기」 it only refreshes the session list — no view opens by itself). */
  onResumed?: (sessionIds: string[], one: boolean) => void;
}) {
  const store = suppliedStorage !== undefined ? suppliedStorage : browserStorage();
  const [offer, setOffer] = useState<RemoteRestartOffer | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [armed, setArmed] = useState<Armed | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [summary, setSummary] = useState(''), [notice, setNotice] = useState('');
  const [tick, setTick] = useState(0);
  const busy = useRef(false), armedAt = useRef(0), mounted = useRef(false), generation = useRef(0);
  const confirmText = useRef<HTMLParagraphElement | null>(null), armButtons = useRef(new Map<string, HTMLButtonElement>()), refocus = useRef<string | null>(null);
  const onResumedRef = useRef(onResumed); onResumedRef.current = onResumed;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  // Focus is placed on purpose: into the confirmation when it opens, back to the button that armed it after 「취소」.
  useEffect(() => {
    if (armed) { confirmText.current?.focus(); return; }
    const key = refocus.current; refocus.current = null;
    if (key) armButtons.current.get(key)?.focus();
  }, [armed]);
  const load = useCallback(async () => {
    if (!available || !controlId) return;
    const token = ++generation.current;
    try {
      const next = await listRemoteRestart(transport, controlId);
      if (!mounted.current || token !== generation.current) return;
      setOffer(next);
      if (!next) setArmed(null);
    } catch { /* The Mac refused (no history grant) or could not answer: no banner, no error line. */ }
  }, [available, controlId, transport]);
  useEffect(() => { if (available && visible && online) void load(); }, [available, visible, online, load]);
  useEffect(() => {
    if (!available || !visible) return;
    const again = () => { void load(); };
    const pending = () => setTick(value => value + 1);
    window.addEventListener('online', again); window.addEventListener(REMOTE_HISTORY_PENDING_EVENT, pending);
    return () => { window.removeEventListener('online', again); window.removeEventListener(REMOTE_HISTORY_PENDING_EVENT, pending); };
  }, [available, visible, load]);
  // `tick` re-reads the phone's own unsettled requests and its hide list after a change on this page.
  const pending = useMemo(() => { void tick; try { return store ? pendingRemoteHistoryResumes(store, host) : []; } catch { return []; } }, [store, host, tick, offer]);
  const pendingIds = useMemo(() => new Set(pending.map(entry => entry.conversationId)), [pending]);
  const hidden = useMemo(() => { void tick; return !!offer && !!store && remoteRestartOfferHidden(store, host, offer); }, [store, host, offer, tick]);
  const name = useCallback((row: RemoteRestartRow) => row.title || `${projects.find(project => project.targetId === row.project)?.label ?? '프로젝트'} · ${aiTerminalAgentLabel(row.agent)}`, [projects]);
  const label = useMemo(() => restartRowLabeler(offer?.rows ?? [], name), [name, offer]);

  const arm = (next: Armed) => { if (busy.current) return; armedAt.current = performance.now(); setArmed(next); setNotice(''); };
  const cancel = () => { refocus.current = armed?.kind === 'one' ? armed.rowId : 'all'; setArmed(null); };
  const run = async (rows: RemoteRestartRow[], one = false) => {
    if (busy.current || !rows.length || !offer) return;
    if (!store) { setArmed(null); setNotice('이 브라우저에 요청을 기억할 수 없어 대화를 열지 않았습니다.'); return; }
    busy.current = true; setArmed(null); setSummary(''); setNotice(''); setProgress({ done: 0, total: rows.length });
    try {
      const result = await resumeRemoteRestartRows({ transport, storage: store, host, pairing, rows, cols: 100, height: 30,
        onProgress: (done, total) => { if (mounted.current) setProgress({ done, total }); } });
      if (mounted.current) setSummary(remoteRestartBatchSummary(result, label));
      if (result.opened.length) onResumedRef.current?.(result.opened.flatMap(item => item.sessionId ? [item.sessionId] : []), one);
    } catch (error) { if (mounted.current) setNotice(readable(error)); }
    finally {
      busy.current = false; announceRemoteHistoryPending();
      if (mounted.current) { setProgress(null); setTick(value => value + 1); void load(); }
    }
  };
  const confirm = () => {
    // A press this soon after arming is the second tap of a double tap on the button that armed it, not a decision.
    if (!armed || !offer || performance.now() - armedAt.current < WORKROOM_RESTART_CONFIRM_GUARD_MS) return;
    const rows = armed.kind === 'all' ? remoteRestartRunnableRows(offer, pending) : offer.rows.filter(row => row.id === armed.rowId && !pendingIds.has(row.id));
    void run(rows, armed.kind === 'one');
  };
  const check = async (row: RemoteRestartRow) => {
    const entry = pending.find(item => item.conversationId === row.id);
    if (!entry || !store || busy.current) return;
    busy.current = true; setNotice('');
    try { setNotice(await remoteHistoryOutcomeMessage(await checkRemoteHistoryResume({ transport, storage: store, controlId: entry.controlId ?? row.project, pairing, pending: entry }))); }
    catch (error) { if (mounted.current) setNotice(readable(error)); }
    finally { busy.current = false; announceRemoteHistoryPending(); if (mounted.current) { setTick(value => value + 1); void load(); } }
  };
  const dismiss = async () => {
    if (!offer || busy.current) return;
    busy.current = true; setArmed(null);
    try { const next = await dismissRemoteRestart(transport, controlId, offer); if (mounted.current) { setOffer(next); setSummary(''); setExpanded(false); } }
    // Refused (a newer revision, a permission that changed): say why and show what is current now.
    catch (error) { if (mounted.current) { setNotice(readable(error)); void load(); } }
    finally { busy.current = false; }
  };
  const hide = () => { if (!offer || !store) return; hideRemoteRestartOffer(store, host, offer); setArmed(null); setExpanded(false); setTick(value => value + 1); };

  if (!available) return null;
  if (!offer || hidden) {
    if (!summary && !notice) return null;
    return <section className="workroom-restart-banner workroom-restart-banner--phone" data-testid="remote-workroom-restart" aria-label="재시작 전 작업 세션 이어 열기">
      {summary && <p className="workroom-restart-text" role="status" data-testid="remote-workroom-restart-summary">{summary}</p>}
      {notice && <p className="workroom-restart-text" role="status" data-testid="remote-workroom-restart-notice">{notice}</p>}
      <div className="workroom-restart-actions"><button type="button" className="workroom-restart-btn" data-testid="remote-workroom-restart-summary-close" onClick={() => { setSummary(''); setNotice(''); }}>알림 닫기</button></div>
    </section>;
  }
  return <RemoteRestartBannerView offer={offer} expanded={expanded} armed={armed} progress={progress} summary={summary} notice={notice} pendingIds={pendingIds}
    online={online} name={name} label={label} onToggle={() => { setExpanded(open => !open); setArmed(null); }} onArm={arm} onConfirm={confirm} onCancel={cancel}
    onDismiss={() => void dismiss()} onHide={hide} onCheck={row => void check(row)}
    confirmRef={element => { confirmText.current = element; }}
    armRef={(key, element) => { if (element) armButtons.current.set(key, element); else armButtons.current.delete(key); }}/>;
}
