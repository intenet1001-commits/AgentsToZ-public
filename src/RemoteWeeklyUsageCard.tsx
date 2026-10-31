import {useEffect, useRef, useState} from 'react';
import {RefreshCw} from 'lucide-react';
import type {MobileWorkspaceRequest, MobileWorkspaceResult} from './mobileWorkspaceProtocol';
import {phoneDateTime} from './phoneTime';
import type {WeeklyProvider} from './weeklyUsage';
import {codexWeeklyUsageNoDataState, weeklyUsageCheckedAgo} from './weeklyUsageDisplay';
import {
  WEEKLY_USAGE_REMOTE_PROVIDERS, readRemoteWeeklyUsage, remoteWeeklyUsageMinimum, remoteWeeklyUsageState, weeklyUsageUnsupported,
  type RemoteWeeklyUsageRow, type RemoteWeeklyUsageState,
} from './weeklyUsageRemote';

/**
 * 「주간 잔여」 at the end of the phone's Home tab: the selected Mac's weekly allowance per CLI, the same figure as that Mac's
 * dock (the lowest bucket). Read only, through `usage.weekly` (src/weeklyUsageRemote.ts): on mount, when the page comes back
 * into view, when the Mac or its first project changes, when the phone or the Mac comes back, and on 「새로고침」 — never on a
 * polling timer (the `workroom.effort` precedent; the Mac answers from a snapshot anyway). A local one-shot timer only updates
 * the age label when a Codex response without weekly data becomes stale. An older Mac's refusal hides the card for
 * that Mac for the rest of this page. Strings stay here, not in src/i18n.ts, like the rest of the Home section.
 */
const NAMES: Record<WeeklyProvider, string> = {claude: 'Claude', codex: 'Codex', agy: 'Antigravity'};
export const WEEKLY_USAGE_CONNECT_HINT = 'Mac 호출창 → 열린 세션에서 「사용량 연결」';
export const WEEKLY_USAGE_ACCOUNT_NOTE = '이 Mac의 CLI 계정 기준 · 열린 세션과 다를 수 있음';
/** An automatic read (mount, return, reconnect) within this long of the last answer for that Mac is skipped; 「새로고침」 is not. */
export const WEEKLY_USAGE_AUTO_READ_GAP_MS = 10_000;

export function remoteWeeklyUsageAgo(checkedAt: string | null, now: number): string {
  return weeklyUsageCheckedAgo(checkedAt, now);
}

export interface WeeklyUsageCardLine {provider: WeeklyProvider; name: string; state: RemoteWeeklyUsageState; figure: string; detail: string; low: boolean}
/** One line per CLI, always in claude/codex/agy order: a figure, or why there is none and what would give one. */
export function weeklyUsageCardLines(rows: readonly RemoteWeeklyUsageRow[], now: number): WeeklyUsageCardLine[] {
  return WEEKLY_USAGE_REMOTE_PROVIDERS.map(provider => {
    const row = rows.find(r => r.provider === provider), name = NAMES[provider];
    if (!row) return {provider, name, state: 'unavailable', figure: '확인 안 됨', detail: '', low: false};
    const state = remoteWeeklyUsageState(row, now), lowest = remoteWeeklyUsageMinimum(row);
    if ((state === 'ready' || state === 'stale') && lowest) {
      const several = row.buckets.length > 1;
      const resetPassed = row.buckets.some(b => b.resetsAt !== null && b.resetsAt * 1000 <= now);
      const when = state === 'stale' ? `이전 값 · ${remoteWeeklyUsageAgo(row.checkedAt, now)}${resetPassed ? ' · 초기화 시각 지남' : ''}`
        : lowest.resetsAt !== null ? `${phoneDateTime(lowest.resetsAt * 1000, now)} 초기화` : '초기화 시각 미제공';
      const detail = [...(several ? [row.buckets.map(b => `${b.label} ${b.remainingPercent}%`).join(' · ')] : []), when].join(' · ');
      return {provider, name, state, figure: `${several ? '최소 ' : ''}${lowest.remainingPercent}% 남음`, detail, low: lowest.remainingPercent < 15};
    }
    const noDataState = codexWeeklyUsageNoDataState(row, now);
    if (noDataState) return {provider, name, state: noDataState === 'stale' ? 'stale' : state, figure: '주간 자료 없음', detail: `Codex 응답에 주간 자료가 없습니다 · ${noDataState === 'stale' ? '이전 확인 · ' : ''}${remoteWeeklyUsageAgo(row.checkedAt, now)} 확인`, low: false};
    // A Codex read failure is separate from a live response with no weekly data.
    if (provider === 'codex') return {provider, name, state: 'unavailable', figure: '확인 안 됨', detail: 'Mac의 Codex 로그인·네트워크를 확인하세요', low: false};
    if (!row.connected) return {provider, name, state, figure: '연결 안 됨', detail: WEEKLY_USAGE_CONNECT_HINT, low: false};
    if (state === 'waiting') return {provider, name, state, figure: '활동 대기', detail: '연결됨 · 다음 CLI 활동부터 표시됩니다', low: false};
    return {provider, name, state, figure: '주간 자료 없음', detail: 'CLI 상태줄에 주간 한도가 아직 없습니다', low: false};
  });
}

export interface RemoteWeeklyUsageViewProps {
  hostName: string;
  /** null: nothing answered for this Mac yet; []: the Mac has not finished its first read. */
  rows: readonly RemoteWeeklyUsageRow[] | null;
  readAt: number | null; busy: boolean; error: string;
  phoneOnline: boolean; macOnline: boolean; now: number;
  onRefresh(): void;
}

/** Presentation only. What is shown while offline is the last answer, said as such — never as current. */
export function RemoteWeeklyUsageView({hostName, rows, readAt, busy, error, phoneOnline, macOnline, now, onRefresh}: RemoteWeeklyUsageViewProps) {
  const reach = !phoneOnline ? 'phone' : !macOnline ? 'mac' : null;
  const received = readAt !== null ? phoneDateTime(readAt, now) : '';
  const reachLine = reach === 'phone' ? '휴대폰이 오프라인입니다' : reach === 'mac' ? 'Mac이 응답하지 않습니다' : '';
  return <div className="workspace-weekly" data-testid="remote-weekly-usage" role="group" aria-label="주간 잔여 사용량">
    <div className="workspace-weekly-head">
      <h3>주간 잔여 <span>· {hostName || '연결한 Mac'}</span></h3>
      <button type="button" className="workspace-weekly-refresh" data-testid="remote-weekly-usage-refresh" aria-label="주간 잔여 새로고침" title="주간 잔여 새로고침"
        disabled={busy || !!reach} onClick={onRefresh}><RefreshCw aria-hidden="true"/></button>
    </div>
    {reach && <p className="workspace-weekly-reach" role="status" data-testid="remote-weekly-usage-offline">
      {rows?.length ? `${reachLine} · 아래는 ${received}에 받은 값입니다.` : `${reachLine} · 주간 잔여를 확인하지 못했습니다.`}</p>}
    {rows === null ? (!reach && !error && <p className="workspace-weekly-empty" role="status">Mac에서 주간 잔여를 확인하는 중입니다…</p>)
      : !rows.length ? <p className="workspace-weekly-empty" role="status" data-testid="remote-weekly-usage-pending">Mac이 아직 사용량을 읽는 중입니다. 잠시 후 새로고침하세요.</p>
      : <ul className="workspace-weekly-rows">{weeklyUsageCardLines(rows, now).map(line =>
          <li key={line.provider} className="workspace-weekly-row" data-provider={line.provider} data-state={line.state} data-low={line.low ? 'true' : undefined}>
            <strong>{line.name}</strong><span className="workspace-weekly-figure">{line.figure}</span>
            {line.detail && <small>{line.detail}</small>}
          </li>)}</ul>}
    {error && <p className="workspace-weekly-error" role="status" data-testid="remote-weekly-usage-error">{error}</p>}
    <p className="workspace-weekly-note">{WEEKLY_USAGE_ACCOUNT_NOTE}{received && !reach ? ` · ${received} 확인` : ''}</p>
  </div>;
}

export interface RemoteWeeklyUsageCardState {host: string; rows: RemoteWeeklyUsageRow[] | null; readAt: number | null; busy: boolean; error: string; unsupported: boolean}
export const REMOTE_WEEKLY_USAGE_INITIAL: RemoteWeeklyUsageCardState = {host: '', rows: null, readAt: null, busy: false, error: '', unsupported: false};
/** What this page remembers per Mac: the last answer (shown again while a new one is read) and which Macs refused. */
export interface RemoteWeeklyUsageMemory {answers: Map<string, {rows: RemoteWeeklyUsageRow[]; readAt: number}>; refused: Set<string>}
const PAGE_MEMORY: RemoteWeeklyUsageMemory = {answers: new Map(), refused: new Set()};
const readable = (error: unknown) => error instanceof Error && /[가-힣]/.test(error.message) ? error.message : '주간 잔여를 확인하지 못했습니다.';

/**
 * The reader behind the card, without React: one read at a time (a read asked meanwhile runs once after it, and an automatic
 * one for the Mac just answered is dropped), answers kept per Mac, an answer for a Mac the card has left only remembered.
 * A failure keeps what is shown; only an older Mac's refusal is final for that Mac.
 */
export function createRemoteWeeklyUsageReader(request: (controlId: string) => Promise<RemoteWeeklyUsageRow[]>, publish: (state: RemoteWeeklyUsageCardState) => void,
  options: {memory?: RemoteWeeklyUsageMemory; now?: () => number} = {}) {
  const memory = options.memory ?? PAGE_MEMORY, now = options.now ?? Date.now;
  let state: RemoteWeeklyUsageCardState = {...REMOTE_WEEKLY_USAGE_INITIAL};
  let target: {host: string; controlId: string} | null = null, inFlight = false, queued: {host: string; manual: boolean} | null = null, disposed = false;
  const emit = (next: Partial<RemoteWeeklyUsageCardState>) => { if (disposed) return; state = {...state, ...next}; publish(state); };
  const remembered = (host: string): Partial<RemoteWeeklyUsageCardState> => {
    const answer = memory.answers.get(host);
    return {host, rows: answer?.rows ?? null, readAt: answer?.readAt ?? null, unsupported: memory.refused.has(host)};
  };
  const read = async (manual = false): Promise<void> => {
    if (disposed || !target || memory.refused.has(target.host)) return;
    if (inFlight) { queued = {host: target.host, manual: manual || queued?.host === target.host && queued.manual}; return; }
    const asked = target, last = memory.answers.get(asked.host);
    if (!manual && last && now() - last.readAt < WEEKLY_USAGE_AUTO_READ_GAP_MS) return;
    inFlight = true;
    emit({busy: true, error: ''});
    try {
      const rows = await request(asked.controlId);
      memory.answers.set(asked.host, {rows, readAt: now()});
      if (target?.host === asked.host) emit({...remembered(asked.host), error: ''});
    } catch (error) {
      if (weeklyUsageUnsupported(error)) {
        memory.refused.add(asked.host); memory.answers.delete(asked.host);
        if (target?.host === asked.host) emit({...remembered(asked.host), error: ''});
      } else if (target?.host === asked.host) emit({error: readable(error)});
    } finally {
      inFlight = false;
      emit({busy: false});
      const next = queued; queued = null;
      if (!disposed && next && target?.host === next.host && (next.manual || next.host !== asked.host)) await read(next.manual);
    }
  };
  return {
    state: () => state,
    dispose() { disposed = true; queued = null; target = null; },
    /** The Mac to read, and the project (any one this phone was shown there) the read is carried by. */
    point(next: {host: string; controlId: string} | null) {
      if (disposed || target?.host === next?.host && target?.controlId === next?.controlId) return;
      target = next;
      emit(next ? {...remembered(next.host), error: ''} : {...REMOTE_WEEKLY_USAGE_INITIAL, busy: inFlight});
    },
    read,
  };
}

export function RemoteWeeklyUsageCard({available, macOnline, phoneOnline, host, hostName, controlId, transport}: {
  /** The Mac answers workspace requests at all (`workspace-v1`). */
  available: boolean;
  macOnline: boolean; phoneOnline: boolean;
  /** The selected Mac's relay host id; '' when none. */
  host: string; hostName: string;
  /** The first project shown for that Mac — a string, never the projects array (it is a new array every status poll). */
  controlId: string;
  transport: (request: MobileWorkspaceRequest) => Promise<MobileWorkspaceResult>;
}) {
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const [state, setState] = useState<RemoteWeeklyUsageCardState>(REMOTE_WEEKLY_USAGE_INITIAL);
  const [, setAgeRevision] = useState(0);
  const reader = useRef<ReturnType<typeof createRemoteWeeklyUsageReader> | null>(null);
  useEffect(() => {
    const created = createRemoteWeeklyUsageReader(id => readRemoteWeeklyUsage(request => transportRef.current(request), id), setState);
    reader.current = created;
    return () => { created.dispose(); if (reader.current === created) reader.current = null; };
  }, []);
  useEffect(() => { reader.current?.point(host && controlId ? {host, controlId} : null); }, [host, controlId]);
  const ready = available && macOnline && phoneOnline && !!host && !!controlId;
  useEffect(() => { if (ready) void reader.current?.read(); }, [ready, host, controlId]);
  useEffect(() => {
    const codex = state.rows?.find(row => row.provider === 'codex');
    const now = Date.now();
    if (!codex || codexWeeklyUsageNoDataState(codex, now) !== 'current') return;
    const delay = Date.parse(codex.checkedAt!) + 15 * 60_000 + 1 - now;
    const timer = setTimeout(() => setAgeRevision(revision => revision + 1), delay);
    return () => clearTimeout(timer);
  }, [state.rows, state.host]);
  useEffect(() => {
    if (!ready) return;
    const back = () => { if (document.visibilityState === 'visible') void reader.current?.read(); };
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, [ready]);
  if (!available || !host || state.unsupported || state.host !== host) return null;
  return <RemoteWeeklyUsageView hostName={hostName} rows={state.rows} readAt={state.readAt} busy={state.busy} error={state.error}
    phoneOnline={phoneOnline} macOnline={macOnline} now={Date.now()} onRefresh={() => void reader.current?.read(true)}/>;
}
