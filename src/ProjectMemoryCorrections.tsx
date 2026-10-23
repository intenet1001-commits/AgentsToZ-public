import React, { useEffect, useRef, useState } from 'react';
import type { CorrectionOutcomeSummary } from './projectMemoryCorrectionOutcome';
import { CORRECTION_OUTCOME_BIND_CHECK_LIMIT, type CorrectionOutcomeListRow, type CorrectionOutcomeRequest, type CorrectionOutcomeResult, type CorrectionOutcomeVerdict } from './correctionOutcomeWire';

export interface CorrectionEntry {
  entryKey: string;
  contentVersionHash: string;
  title: string;
  identitySource?: string;
  body?: string;
  reports?: { evidence: string }[];
}
export interface CorrectionSearch { hits: CorrectionEntry[]; corrections?: CorrectionEntry[]; correctionSearch?: {complete: boolean; warning?: string} }
export interface CorrectionOverview {
  correctionReview: {pendingEntries: number; changedVersionEntries: number; unboundReports: number};
  hourlyCheckedAt: number | null;
  hourlyReview?:{state:string;dueAt:number|null;efficacyVerified:false}|null;
  hourlyQueue?:{due:number;overdue:number;failed:number;unavailable:number};
  correctionTasks?:{delivered:number;uncertain:number;withheld:number;awaitingIndependentOutcome:number;truncated:boolean;efficacyVerified:false}|null;
  /** Present only when the (off-by-default) outcome pipeline is enabled on this Mac. Counts only. */
  correctionOutcomes?:CorrectionOutcomeSummary|null;
}

/** Outcome counts with the coverage note: results describe composer and voice requests and @ handoffs sent as one submission. */
export function CorrectionOutcomeLine({summary}:{summary:CorrectionOutcomeSummary|null|undefined}) {
  if (!summary) return null;
  const excluded = Object.values(summary.excluded).reduce((n, v) => n + v, 0);
  return <p data-testid="project-memory-correction-outcomes" style={{fontSize: 12}}>
    교정 결과({summary.protocolStatus === 'confirmed' ? `사전 등록 기준 v${summary.protocolVersion}` : '시험 중 · 제안된 기준'}): 반복 {summary.finalized.repeated} · 피함 {summary.finalized.avoided} · 알 수 없음 {summary.finalized.unknown} · 대기 {summary.pending} · 제외 {excluded}.
    {' '}결과는 작성칸·음성 요청과 요청 전체로 입력된 @ 전달만 반영합니다(MCP 지시·새 세션 첫 요청·나눠 입력된 @ 전달은 교정을 받지 않습니다). 반복 실패 감소 효과는 별도 결과 확인이 필요합니다.
  </p>;
}
export interface ProjectMemoryCorrectionClient {
  review?(folderPath: string): Promise<CorrectionOverview>;
  recall(folderPath: string, query: string): Promise<CorrectionSearch>;
  correct(input: {folderPath: string; entryKey: string; contentVersionHash: string; kind: 'corrected'; evidence: string}): Promise<{success: boolean; appended: boolean}>;
  /** The Mac-only attestation/check-binding route. Absent on surfaces that cannot reach it. */
  outcomes?(request: CorrectionOutcomeRequest): Promise<CorrectionOutcomeResult>;
}

const VERDICTS: {verdict: CorrectionOutcomeVerdict; label: string}[] = [
  {verdict: 'avoided', label: '피했다'}, {verdict: 'repeated', label: '반복됐다'}, {verdict: 'unsure', label: '모르겠다'},
];
const VERDICT_LABEL: Record<CorrectionOutcomeVerdict, string> = {avoided: '피했다', repeated: '반복됐다', unsure: '모르겠다'};
const OUTCOME_LABEL: Record<string, string> = {avoided: '피함', repeated: '반복', unknown: '알 수 없음', excluded: '제외', pending: '대기'};
const newRequestId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

/**
 * A person says, for one delivered correction, whether the same failure was avoided or repeated (S4-05), or ties its
 * scope to tester checks (S4-06). Collapsed and silent until opened. Only titles are shown — never task or evidence text.
 */
export function CorrectionOutcomeAttestation({folderPath, client}: {folderPath: string; client: Required<Pick<ProjectMemoryCorrectionClient, 'outcomes'>>}) {
  const [rows, setRows] = useState<CorrectionOutcomeListRow[] | null>(null), [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const epoch = useRef(0), pending = useRef(new Map<string, string>());
  useEffect(() => { epoch.current++; setRows(null); setTruncated(false); setBusy(false); setNotice(''); setChosen({}); pending.current.clear(); return () => { epoch.current++; }; }, [folderPath]);
  /** `quiet`: a refresh after a refused write keeps that write's message instead of replacing it with a list error. */
  async function load(generation = ++epoch.current, quiet = false) {
    setBusy(true);
    try {
      const result = await client.outcomes({operation: 'list', folderPath, requestId: newRequestId()});
      if (generation !== epoch.current) return;
      if (result.operation !== 'list') throw new Error('교정 결과 목록을 확인하지 못했습니다.');
      setRows(result.units); setTruncated(result.truncated);
    } catch (error) { if (generation === epoch.current && !quiet) setNotice(error instanceof Error ? error.message : '교정 결과 목록을 불러오지 못했습니다.'); }
    finally { if (generation === epoch.current) setBusy(false); }
  }
  /** One requestId per intent until it succeeds, so a retry after a lost reply is recorded once. */
  async function write(key: string, request: (requestId: string) => CorrectionOutcomeRequest, done: string) {
    const generation = ++epoch.current, requestId = pending.current.get(key) ?? newRequestId();
    pending.current.set(key, requestId);
    setBusy(true); setNotice('');
    try {
      const result = await client.outcomes(request(requestId));
      if (generation !== epoch.current) return;
      pending.current.delete(key);
      setNotice(done + ('conflict' in result && result.conflict ? ' 서로 다른 결과가 남아 있어 이 요청은 「알 수 없음」으로 확정됩니다.' : ''));
      await load(generation);
    } catch (error) {
      if (generation !== epoch.current) return;
      setNotice(error instanceof Error ? error.message : '결과를 남기지 못했습니다.');
      // A refusal can mean the row itself changed — finalized while this was being written, or its window closed — so
      // show the rows as they now are instead of leaving buttons for a result that can no longer be left (S4-05).
      await load(generation, true);
    }
  }
  const button: React.CSSProperties = {minHeight: 44, minWidth: 44, fontSize: 16, padding: '6px 12px', border: '1px solid var(--line)', borderRadius: 7, background: 'var(--surface)', color: 'var(--ink)'};
  return <details data-testid="project-memory-correction-attest" style={{marginTop: 8}} onToggle={event => {
    event.stopPropagation();
    if (event.currentTarget.open && rows === null && !busy) void load();
  }}>
    <summary style={{cursor: 'pointer', minHeight: 44}}>요청 결과 직접 확인하기</summary>
    <p style={{fontSize: 12}}>교정이 전달된 최근 요청에서 같은 실패를 피했는지 직접 남기세요. 관찰 기간 안의 요청만 남길 수 있고, 서로 다른 결과가 남으면 「알 수 없음」이 됩니다.</p>
    {rows?.length === 0 && <p style={{fontSize: 12}}>결과를 남길 수 있는 요청이 아직 없습니다.</p>}
    {rows?.map(row => {
      const picked = chosen[row.unitId] ?? [];
      return <div key={row.unitId} data-testid="correction-attest-row" style={{borderTop: '1px solid var(--line)', padding: '8px 0', overflowWrap: 'anywhere'}}>
        <div style={{fontSize: 13}}>{row.conversationTitle ?? '제목 없는 대화'} · {row.entryTitle ?? '현재 기억에 없는 항목'}{row.entryCurrent ? '' : ' (본문 바뀜)'}</div>
        <div style={{fontSize: 12}}>전달 {new Date(row.writtenAt).toLocaleString()} · {row.windowOpen ? `관찰 중 · ${new Date(row.windowClosesAt).toLocaleString()}까지` : '관찰 끝'}{row.outcome ? ` · 확정: ${OUTCOME_LABEL[row.outcome] ?? row.outcome}` : ''}</div>
        {row.attestations.length > 0 && <div style={{fontSize: 12}}>남긴 결과: {row.attestations.map(v => VERDICT_LABEL[v]).join(' · ')}</div>}
        {row.boundChecks.length > 0 && <div style={{fontSize: 12}}>연결된 검사: {row.boundChecks.join(', ')}</div>}
        {row.attestable && <div style={{display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6}}>
          {VERDICTS.map(({verdict, label}) => <button key={verdict} type="button" style={button} disabled={busy}
            onClick={() => void write(`attest:${row.unitId}:${verdict}`, requestId => ({operation: 'attest', unitId: row.unitId, verdict, requestId}), '결과를 남겼습니다.')}>{label}</button>)}
        </div>}
        {row.attestable && row.availableChecks.length > 0 && <fieldset style={{border: 0, padding: 0, margin: '6px 0 0'}}>
          <legend style={{fontSize: 12}}>이 교정을 확인할 테스터 검사 (최대 {CORRECTION_OUTCOME_BIND_CHECK_LIMIT}개)</legend>
          {row.availableChecks.map(id => <label key={id} style={{display: 'inline-flex', alignItems: 'center', gap: 4, minHeight: 44, marginRight: 10, fontSize: 13}}>
            <input type="checkbox" aria-label={id} style={{fontSize: 16, width: 20, height: 20}} checked={picked.includes(id)} disabled={busy || (!picked.includes(id) && picked.length >= CORRECTION_OUTCOME_BIND_CHECK_LIMIT)}
              onChange={event => setChosen(current => ({...current, [row.unitId]: event.target.checked ? [...picked, id] : picked.filter(value => value !== id)}))}/>{id}</label>)}
          <button type="button" style={button} disabled={busy || picked.length === 0}
            onClick={() => void write(`bind:${row.unitId}:${[...picked].sort().join(',')}`, requestId => ({operation: 'bind', unitId: row.unitId, checkIds: picked, requestId}), '검사를 연결했습니다. 연결 이후의 테스터 실행만 결과에 반영됩니다.')}>검사 연결</button>
        </fieldset>}
      </div>;
    })}
    {truncated && <p style={{fontSize: 12}}>최근 요청 일부만 보여 줍니다.</p>}
    <div data-testid="correction-attest-notice" role="status" aria-live="polite" style={{fontSize: 12, overflowWrap: 'anywhere'}}>{notice}</div>
  </details>;
}

export function ProjectMemoryCorrections({folderPath, client}: {folderPath: string; client: ProjectMemoryCorrectionClient}) {
  const [query, setQuery] = useState(''), [entries, setEntries] = useState<CorrectionEntry[]>([]);
  const [selected, setSelected] = useState<CorrectionEntry | null>(null);
  const [cause, setCause] = useState(''), [next, setNext] = useState('');
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [overview, setOverview] = useState<CorrectionOverview | null>(null);
  const epoch = useRef(0);
  useEffect(() => { epoch.current++; setQuery(''); setEntries([]); setSelected(null); setCause(''); setNext(''); setBusy(false); setNotice(''); setOverview(null); return () => { epoch.current++; }; }, [folderPath]);
  async function search() {
    const generation = ++epoch.current;
    setBusy(true); setNotice(''); setSelected(null); setEntries([]);
    try {
      const result = await client.recall(folderPath, query.trim());
      if (generation !== epoch.current) return;
      if (result.correctionSearch?.complete === false) throw new Error(result.correctionSearch.warning ?? '교정 기록을 복구한 뒤 다시 검색하세요.');
      if (!Array.isArray(result.corrections)) throw new Error('교정 기능을 사용하려면 로컬 서비스를 업데이트하세요.');
      const found = [...result.hits.filter(entry => entry.identitySource === 'explicit'), ...result.corrections];
      setEntries(found);
      if (!found.length) setNotice('교정할 기억 항목을 찾지 못했습니다. 제목이나 관련 단어로 다시 검색하세요.');
    } catch (error) { if (generation === epoch.current) setNotice(error instanceof Error ? error.message : '검색하지 못했습니다.'); }
    finally { if (generation === epoch.current) setBusy(false); }
  }
  async function save() {
    if (!selected || !cause.trim() || !next.trim()) return;
    const generation = ++epoch.current;
    setBusy(true); setNotice('');
    try {
      const result = await client.correct({folderPath, entryKey: selected.entryKey, contentVersionHash: selected.contentVersionHash,
        kind: 'corrected', evidence: `실패 원인: ${cause.trim()} 다음 처리: ${next.trim()}`});
      if (generation !== epoch.current) return;
      if (!result.success) throw new Error('저장 결과를 확인하지 못했습니다. 같은 내용을 다시 저장하여 영수증을 확인하세요.');
      setOverview(null);
      setNotice('교정을 저장했습니다. 다음 회상부터 이 본문 버전의 지침을 제외하고 실패 원인을 보여줍니다.');
      setSelected(null); setEntries([]); setCause(''); setNext('');
    } catch (error) { if (generation === epoch.current) setNotice(error instanceof Error ? error.message : '저장하지 못했습니다.'); }
    finally { if (generation === epoch.current) setBusy(false); }
  }
  const control: React.CSSProperties = {width: '100%', minHeight: 44, fontSize: 16, padding: 8, border: '1px solid var(--line)', borderRadius: 7, background: 'var(--surface)', color: 'var(--ink)', boxSizing: 'border-box'};
  return <details data-testid="project-memory-corrections" style={{marginBottom: 12, color: 'var(--ink-2)'}} onToggle={event => {
    if (event.target !== event.currentTarget || !event.currentTarget.open || !client.review) return;
    const generation = epoch.current;
    void client.review(folderPath).then(result => {if (generation === epoch.current) setOverview(result);}).catch(() => {});
  }}>
    <summary style={{cursor: 'pointer', minHeight: 44}}>교정·실패 기억하기</summary>
    <p style={{fontSize: 12}}>기억 항목을 고르고 실패 원인과 다음 처리 방법을 남기세요. 교정은 즉시 회상에 반영되며, 앱 실행 중 매시간 기존 기록을 점검합니다.</p>
    {overview?.correctionReview && <p style={{fontSize: 12}}>재사용 보류 {overview.correctionReview.pendingEntries}개 · 본문 변경 후 검증 필요 {overview.correctionReview.changedVersionEntries}개 · 정기 점검 {overview.hourlyCheckedAt == null ? '대기 중' : new Date(overview.hourlyCheckedAt).toLocaleString()}</p>}
    {overview?.hourlyReview&&<p style={{fontSize:12}}>점검 상태: {({current:'최근 점검됨',due:'점검 대기',overdue:'점검 지연',failed:'점검 실패',unavailable:'기록 또는 목록 확인 필요','not-applicable':'장기기억이 없어 점검 대상 아님',excluded:'운영 폴더라 점검 대상 아님',disabled:'점검 중지','not-tracked':'아직 점검 목록에 없음'} as Record<string,string>)[overview.hourlyReview.state]??'확인 필요'}{overview.hourlyQueue?` · 전체 지연 ${overview.hourlyQueue.overdue}개 · 실패 ${overview.hourlyQueue.failed}개`:''}. 반복 실패 감소 효과는 별도 결과 확인이 필요합니다.</p>}
    <CorrectionOutcomeLine summary={overview?.correctionOutcomes}/>
    {overview?.correctionTasks&&<p style={{fontSize:12}}>최근 요청에 관련 교정 전달 {overview.correctionTasks.delivered}건 · 전달 미확정 {overview.correctionTasks.uncertain}건 · 민감 원문 보류 {overview.correctionTasks.withheld}건 · 실제 반복 방지 결과 확인 대기 {overview.correctionTasks.awaitingIndependentOutcome}건{overview.correctionTasks.truncated?' (최근 기록 일부)':''}</p>}
    <form onSubmit={event => {event.preventDefault(); void search();}}>
      <label>교정할 기억 검색<input aria-label="교정할 기억 검색" value={query} disabled={busy} maxLength={200} style={control} onChange={event => {setQuery(event.target.value); setEntries([]); setSelected(null);}}/></label>
      <button type="submit" disabled={busy || !query.trim()} style={control}>기억 검색</button>
    </form>
    {entries.map(entry => <button type="button" key={entry.entryKey + entry.contentVersionHash} disabled={busy} style={{...control, textAlign: 'left', overflowWrap: 'anywhere'}} onClick={() => {setSelected(entry); setCause(''); setNext(''); setNotice('');}}>{entry.title}{entry.reports ? ' · 교정 기록 있음' : ''}</button>)}
    {selected && <form onSubmit={event => {event.preventDefault(); void save();}}>
      <p style={{whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12}}>{selected.body?.slice(0, 1200) ?? selected.reports?.map(report => report.evidence).join('\n')}</p>
      <label>실패 원인<textarea aria-label="실패 원인" style={control} maxLength={200} disabled={busy} value={cause} onChange={event => setCause(event.target.value)}/></label>
      <label>다음 처리 방법<textarea aria-label="다음 처리 방법" style={control} maxLength={200} disabled={busy} value={next} onChange={event => setNext(event.target.value)}/></label>
      <button type="submit" style={control} disabled={busy || !cause.trim() || !next.trim()}>교정 저장</button>
    </form>}
    <div role="status" aria-live="polite" style={{fontSize: 12, overflowWrap: 'anywhere'}}>{notice}</div>
    {client.outcomes && <CorrectionOutcomeAttestation key={folderPath} folderPath={folderPath} client={{outcomes: client.outcomes}}/>}
  </details>;
}
