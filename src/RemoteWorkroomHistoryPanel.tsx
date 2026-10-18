import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { checkRemoteHistoryResume, listRemoteHistory, remoteHistoryOutcomeMessage, resumeRemoteHistory, type RemoteHistoryTransport } from './remoteWorkroomHistoryClient';
import {
  REMOTE_HISTORY_PENDING_EVENT, REMOTE_HISTORY_PENDING_PER_HOST, announceRemoteHistoryPending, clearPendingRemoteHistoryResume, orphanedRemoteHistoryResumes,
  pendingRemoteHistoryResumes, remoteHistorySentEarlier, type PendingRemoteHistoryResume, type RemoteHistoryRow,
} from './workroomHistoryRemoteProtocol';
import { remoteHistoryWhyPhrase } from './workroomRestartText';
// The portal mounts this beside AiTerminalPanel, not inside it; its layout lives in the same sheet (history section).
import './AiTerminalPanel.css';
import { aiTerminalAgentLabel } from './aiTerminalAgentLabel';
import { phoneDateTime } from './phoneTime';

/**
 * Phone Workroom history (`workroom-history-v1`). Folded, and it asks the Mac only when a person opens it or presses a
 * button — never on a timer. A Mac that does not advertise the feature gets nothing rendered (no error).
 */
const STATE_LABELS: Record<RemoteHistoryRow['state'], string> = { running: '실행 중', ended: '종료됨', detached: '앱 재시작으로 끊김' };
type PanelStorage = Pick<Storage, 'getItem' | 'setItem'>;
type Project = { targetId: string; label: string };
const browserStorage = (): PanelStorage | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };
const readable = (error: unknown) => error instanceof Error && /[가-힣]/.test(error.message) ? error.message : '대화 기록을 확인하지 못했습니다.';

/** Shown before an unsettled request is dropped from this phone. Dropping it changes nothing on the Mac. */
export const REMOTE_HISTORY_DISMISS_WARNING = '이 Mac이 이 대화를 이미 열었을 수 있습니다. 목록에서 지워도 Mac의 대화와 터미널은 그대로이고, 이 휴대폰은 그 결과를 더 이상 확인하지 않습니다. 같은 대화를 다시 열기 전에 워크룸 세션 목록을 먼저 확인하세요.';

/** What a person recognizes an unsettled request by — a loaded conversation's title, else the project it went to.
 *  Never the opaque ids. */
export function pendingResumeLabel(entry: PendingRemoteHistoryResume, rows: readonly RemoteHistoryRow[] | null, projects: readonly Project[]): string {
  const row = rows?.find(r => r.id === entry.conversationId);
  const project = entry.controlId ? projects.find(p => p.targetId === entry.controlId) : undefined;
  const what = row ? (row.title || `${aiTerminalAgentLabel(row.agent)} 대화`) : project ? `${project.label}의 대화` : '목록에 없는 대화 (다른 프로젝트 또는 이전 연결)';
  const at = entry.requestedAt ? phoneDateTime(entry.requestedAt) : '';
  return at ? `${what} · ${at}에 보낸 요청` : what;
}

/** Shown before 「이어 열기」 runs anything: what will open on the Mac. Confirmed on purpose, never by one double tap. */
export const REMOTE_HISTORY_RESUME_CONFIRM = '이 대화를 이 Mac에서 다시 엽니다. 그 AI의 CLI가 Mac에서 실행되고(권한 우회 없음), 열리면 워크룸 세션 목록에 나타납니다.';
/** A confirm tap this soon after arming is the second tap of a double tap on 「이어 열기」, not a decision. */
export const REMOTE_HISTORY_CONFIRM_GUARD_MS = 500;

/** Said instead of a status check for a request sent over an earlier pairing: the Mac keeps receipts by pairing, so no
 *  status through this one can reach it. */
export const REMOTE_HISTORY_EARLIER_PAIRING_HINT = '이전 연결로 보낸 요청 · 지금 연결로는 결과를 확인할 수 없습니다';

/** Every unsettled resume of this Mac, whether or not its conversation is on screen: check the result, or — after a
 *  confirmation that says the Mac may already have opened it — drop it from this phone. `orphans` lists the requests of
 *  Macs this phone no longer holds: they can only be dismissed. */
export function RemoteHistoryPendingList({ entries, rows, projects, pairing, orphans = false, busy, online, canCheck, confirming, onCheck, onAskDismiss, onDismiss, onCancelDismiss }: {
  entries: readonly PendingRemoteHistoryResume[]; rows: readonly RemoteHistoryRow[] | null; projects: readonly Project[];
  pairing?: string | null; orphans?: boolean;
  busy: boolean; online: boolean; canCheck: boolean; confirming: string | null;
  onCheck(entry: PendingRemoteHistoryResume): void; onAskDismiss(entry: PendingRemoteHistoryResume): void;
  onDismiss(entry: PendingRemoteHistoryResume): void; onCancelDismiss(): void;
}) {
  if (!entries.length) return null;
  return (
    <div className="ai-terminal-history-pending" data-testid={orphans ? 'remote-workroom-history-orphans' : 'remote-workroom-history-pending'}>
      {orphans
        ? <div className="ai-terminal-hint">이 휴대폰에 연결되어 있지 않은 Mac에 보낸 요청 {entries.length}건 · 결과를 확인할 수 없어 정리만 할 수 있습니다.</div>
        : <div className="ai-terminal-hint">결과 확인이 필요한 요청 {entries.length}건 · 다시 실행하지 않고 이 Mac의 결과만 확인합니다.</div>}
      {!orphans && entries.length >= REMOTE_HISTORY_PENDING_PER_HOST && <div className="ai-terminal-hint" role="status" data-testid="remote-workroom-history-pending-full">
        새 이어 열기는 이 목록에서 결과를 확인하거나 정리한 뒤에 보낼 수 있습니다.</div>}
      <ul className="ai-terminal-history-list">
        {entries.map(entry => <li key={entry.resumeRequestId} data-testid={orphans ? 'remote-workroom-history-orphan-row' : 'remote-workroom-history-pending-row'}>
          <span className="ai-terminal-history-title">{orphans ? pendingResumeLabel(entry, null, []) : pendingResumeLabel(entry, rows, projects)}</span>{' '}
          {orphans ? null : remoteHistorySentEarlier(entry, pairing)
            ? <span className="ai-terminal-hint" data-testid="remote-workroom-history-pending-earlier">{REMOTE_HISTORY_EARLIER_PAIRING_HINT}</span>
            : <button type="button" className="ai-terminal-btn" disabled={busy || !online || !canCheck} data-testid="remote-workroom-history-pending-check" onClick={() => onCheck(entry)}>결과 확인</button>}{' '}
          {confirming === entry.resumeRequestId
            ? <span className="ai-terminal-history-warning" role="alert" data-testid="remote-workroom-history-pending-dismiss-warning"><span>{REMOTE_HISTORY_DISMISS_WARNING}</span>{' '}
                <button type="button" className="ai-terminal-btn" disabled={busy} data-testid="remote-workroom-history-pending-dismiss-confirm" onClick={() => onDismiss(entry)}>확인하지 않고 지우기</button>{' '}
                <button type="button" className="ai-terminal-btn" onClick={onCancelDismiss}>취소</button>
              </span>
            : <button type="button" className="ai-terminal-btn" disabled={busy} data-testid="remote-workroom-history-pending-dismiss" onClick={() => onAskDismiss(entry)}>목록에서 지우기</button>}
        </li>)}
      </ul>
    </div>
  );
}

export function RemoteWorkroomHistoryPanel({ available, detail = false, visible, online, host, pairing = null, knownHosts, projects, transport, storage: suppliedStorage, onResumed }: {
  available: boolean; visible: boolean; online: boolean; host: string;
  /** The Mac advertises `workroom-restart-v1`: rows then say why they cannot be opened (`why`). Never asked of an older Mac. */
  detail?: boolean;
  /** This phone's current pairing with `host` (`remoteHistoryPairing`); null when it cannot be named. */
  pairing?: string | null;
  /** Every Mac this phone holds. Given, the unsettled requests of any other Mac are listed for a confirmed dismiss. */
  knownHosts?: readonly string[];
  projects: readonly Project[]; transport: RemoteHistoryTransport;
  /** This phone's place for unsettled requests; the browser's localStorage unless given. */
  storage?: PanelStorage | null;
  /** Selects the resumed session in the phone Workroom; answers whether its list held it. */
  onResumed?: (sessionId: string) => Promise<boolean>;
}) {
  const store = suppliedStorage !== undefined ? suppliedStorage : browserStorage();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');
  const [rows, setRows] = useState<RemoteHistoryRow[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  // When 「이어 열기」 armed the confirmation: the second tap of a double tap is ignored (it is not a decision).
  const armedAt = useRef(0);
  // Arming replaces the focused 「이어 열기」, so focus is placed on purpose (w5 review): into the confirmation sentence
  // when it opens, and back to that row's 「이어 열기」 after 「취소」 — never dropped to <body> for keyboard or VoiceOver.
  const warningRef = useRef<HTMLSpanElement | null>(null);
  const resumeButtons = useRef(new Map<string, HTMLButtonElement>());
  const refocusRow = useRef<string | null>(null);
  useEffect(() => {
    if (confirming) { warningRef.current?.focus(); return; }
    const row = refocusRow.current; refocusRow.current = null;
    if (row) resumeButtons.current.get(row)?.focus();
  }, [confirming]);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  // Read at the first render too, so an unsettled request is visible before anything is loaded.
  const [pending, setPending] = useState<PendingRemoteHistoryResume[]>(() => store ? pendingRemoteHistoryResumes(store, host) : []);
  const knownKey = knownHosts ? JSON.stringify([...knownHosts, host]) : null;
  const readOrphans = useCallback(() => store && knownKey ? orphanedRemoteHistoryResumes(store, JSON.parse(knownKey) as string[]) : [], [knownKey, store]);
  const [orphans, setOrphans] = useState<PendingRemoteHistoryResume[]>(readOrphans);
  const controlId = target && projects.some(p => p.targetId === target) ? target : projects[0]?.targetId ?? '';
  const pendingFor = useMemo(() => new Map(pending.map(p => [p.conversationId, p])), [pending]);
  const refreshPending = useCallback(() => { setPending(store ? pendingRemoteHistoryResumes(store, host) : []); setOrphans(readOrphans()); }, [host, readOrphans, store]);
  // Only another Mac resets the loaded list; a Mac joining or leaving this phone re-reads the unsettled requests alone.
  useEffect(() => { setRows(null); setNextBefore(null); setMessage(''); setDismissing(null); setConfirming(null); }, [host]);
  useEffect(() => { refreshPending(); }, [refreshPending]);
  // The restart banner saves and settles requests too (w14): read them again when it says so.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener(REMOTE_HISTORY_PENDING_EVENT, refreshPending);
    return () => window.removeEventListener(REMOTE_HISTORY_PENDING_EVENT, refreshPending);
  }, [refreshPending]);

  const load = useCallback(async (before?: string) => {
    if (!controlId || busy) return;
    // A refreshed list is a new decision: an armed 「이어 열기」 does not survive it.
    setBusy(true); setMessage(''); setConfirming(null);
    try {
      const page = await listRemoteHistory(transport, controlId, before, detail);
      setRows(current => before ? [...(current ?? []), ...page.records] : page.records); setNextBefore(page.nextBefore);
    } catch (error) { setMessage(readable(error)); } finally { setBusy(false); refreshPending(); }
  }, [busy, controlId, detail, refreshPending, transport]);

  const resume = async (row: RemoteHistoryRow) => {
    if (!store) { setMessage('이 브라우저에 요청을 기억할 수 없어 대화를 열지 않았습니다.'); return; }
    setBusy(true); setConfirming(null); setMessage('');
    try { setMessage(await remoteHistoryOutcomeMessage(await resumeRemoteHistory({ transport, storage: store, host, controlId, pairing, row, cols: 100, rows: 30 }), onResumed)); }
    catch (error) { setMessage(readable(error)); }
    finally { setBusy(false); refreshPending(); announceRemoteHistoryPending(); }
  };
  const check = async (entry: PendingRemoteHistoryResume) => {
    if (!store || !controlId) return;
    setBusy(true); setMessage(''); setDismissing(null);
    // Asks the project the request went to (loaded on this page or not); the current project only if the Mac refuses it.
    try { setMessage(await remoteHistoryOutcomeMessage(await checkRemoteHistoryResume({ transport, storage: store, controlId, pairing, pending: entry }), onResumed)); }
    catch (error) { setMessage(readable(error)); }
    finally { setBusy(false); refreshPending(); announceRemoteHistoryPending(); }
  };
  const dismiss = (entry: PendingRemoteHistoryResume) => {
    if (!store) return;
    try { clearPendingRemoteHistoryResume(store, entry); setMessage('이 휴대폰의 목록에서 지웠습니다. Mac에서 이미 열렸다면 워크룸 세션 목록에 있습니다.'); }
    catch { setMessage('이 브라우저의 목록을 고치지 못했습니다. 요청은 그대로 남아 있습니다.'); }
    finally { setDismissing(null); refreshPending(); announceRemoteHistoryPending(); }
  };

  if (!available || !visible) return null;
  return (
    <details className="ai-terminal-history" data-testid="remote-workroom-history" open={open}
      onToggle={event => { const next = (event.currentTarget as HTMLDetailsElement).open; setOpen(next); if (!next) setConfirming(null); if (next && rows === null) void load(); }}>
      <summary>대화 기록 · 지난 워크룸 대화 이어 열기{pending.length ? ` · 결과 확인 필요 ${pending.length}건` : ''}</summary>
      <div className="ai-terminal-hint">이 Mac에 저장된 대화를 권한 우회 없이 다시 엽니다. 결과가 불확실하면 다시 실행하지 않고 「결과 확인」만 보여 줍니다.</div>
      <RemoteHistoryPendingList entries={pending} rows={rows} projects={projects} pairing={pairing} busy={busy} online={online} canCheck={!!controlId && !!store}
        confirming={dismissing} onCheck={entry => void check(entry)} onAskDismiss={entry => setDismissing(entry.resumeRequestId)}
        onDismiss={dismiss} onCancelDismiss={() => setDismissing(null)} />
      <RemoteHistoryPendingList orphans entries={orphans} rows={null} projects={[]} busy={busy} online={online} canCheck={false}
        confirming={dismissing} onCheck={() => {}} onAskDismiss={entry => setDismissing(entry.resumeRequestId)}
        onDismiss={dismiss} onCancelDismiss={() => setDismissing(null)} />
      <div className="ai-terminal-history-controls">
        <label className="ai-terminal-history-field"><span>프로젝트</span>
          <select className="ai-terminal-select" value={controlId} disabled={busy} data-testid="remote-workroom-history-project"
            onChange={event => { setTarget(event.target.value); setRows(null); setNextBefore(null); setConfirming(null); }}>
            {projects.map(project => <option key={project.targetId} value={project.targetId}>{project.label}</option>)}
          </select>
        </label>
        <button type="button" className="ai-terminal-btn" disabled={busy || !online || !controlId} data-testid="remote-workroom-history-load" onClick={() => void load()}>
          {rows === null ? '불러오기' : '새로 고침'}
        </button>
      </div>
      {rows && rows.length === 0 && <div className="ai-terminal-hint">이 프로젝트에 저장된 워크룸 대화가 없습니다.</div>}
      {rows && rows.length > 0 && <ul className="ai-terminal-history-list">
        {rows.map(row => {
          const waiting = pendingFor.get(row.id);
          return <li key={row.id} data-testid="remote-workroom-history-row">
            <span className="ai-terminal-history-title">{row.title || `${aiTerminalAgentLabel(row.agent)} 대화`} · {STATE_LABELS[row.state]} · {phoneDateTime(row.updatedAt)}</span>{' '}
            {waiting
              ? remoteHistorySentEarlier(waiting, pairing)
                ? <span className="ai-terminal-hint">{REMOTE_HISTORY_EARLIER_PAIRING_HINT}</span>
                : <button type="button" className="ai-terminal-btn" disabled={busy || !online} data-testid="remote-workroom-history-check" onClick={() => void check(waiting)}>결과 확인</button>
              : !row.resumable ? <span className="ai-terminal-hint" data-testid="remote-workroom-history-why">{row.why ? remoteHistoryWhyPhrase(row.why) : '이어 열 수 없음'}</span>
              : confirming === row.id
                // Its own block under the title, sentence first: the confirm is never where 「이어 열기」 was.
                ? <span className="ai-terminal-history-warning" role="group" aria-label="이어 열기 확인" data-testid="remote-workroom-history-resume-warning"><span ref={warningRef} tabIndex={-1}>{REMOTE_HISTORY_RESUME_CONFIRM}</span>{' '}
                    <button type="button" className="ai-terminal-btn" disabled={busy || !online} data-testid="remote-workroom-history-confirm"
                      onClick={() => { if (performance.now() - armedAt.current < REMOTE_HISTORY_CONFIRM_GUARD_MS) return; void resume(row); }}>이 Mac에서 열기</button>{' '}
                    <button type="button" className="ai-terminal-btn" data-testid="remote-workroom-history-resume-cancel" onClick={() => { refocusRow.current = row.id; setConfirming(null); }}>취소</button>
                  </span>
                : <button type="button" className="ai-terminal-btn" disabled={busy || !online} data-testid="remote-workroom-history-resume"
                    ref={element => { if (element) resumeButtons.current.set(row.id, element); else resumeButtons.current.delete(row.id); }}
                    onClick={() => { armedAt.current = performance.now(); setConfirming(row.id); }}>이어 열기</button>}
          </li>;
        })}
      </ul>}
      {nextBefore && <button type="button" className="ai-terminal-btn" disabled={busy || !online} onClick={() => void load(nextBefore)}>더 불러오기</button>}
      {message && <div className="ai-terminal-hint ai-terminal-history-message" role="status" data-testid="remote-workroom-history-message">{message}</div>}
    </details>
  );
}
