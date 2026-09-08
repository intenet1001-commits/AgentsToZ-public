import React, {useEffect, useRef, useState} from 'react';
import {terminalLocalRequest} from './aiTerminalClient';
import {MemorySaveKeySetup} from './MemorySaveKeySetup';
import {MemoryAutomaticSettings} from './MemoryAutomaticSettings';
import {AI_TERMINAL_PREFIX} from './aiTerminalProtocol';
import type {TerminalMemoryState} from './terminalMemoryQueue';
import type {MemoryObservationStatus} from './memoryObservationStatus';

type MemoryJob = {sessionId: string; targetId: string; state: TerminalMemoryState};
const labels: Record<TerminalMemoryState, string> = {
  pending: '종료 후 저장 대기', saving: '세션 기억 저장 중', saved: '세션 기억 저장 완료',
  unchanged: '새로 저장할 활동 없음', unavailable: '장기기억 초기화 필요',
  'backup-pending': '로컬 저장 완료 · 백업 확인 필요', failed: '세션 기억 저장 실패 · 확인 필요',
  retrying: '작업공간 사용 중 · 잠시 후 다시 저장',
  'recovery-required': '이전 작업·저장 결과 확인 후 복구 필요',
};
const needsReview = (job: MemoryJob) => ['failed', 'backup-pending', 'unavailable', 'recovery-required'].includes(job.state);

/** Local queue history is separate from live terminals; never discard a job to tidy the UI. */
export function TerminalMemoryStatus({visible, projects, onReview, onManageProject, observationTargetId}: {
  visible: boolean;
  projects: {targetId: string; label: string; projectTargetId?: string}[];
  onReview: (targetId: string) => void;
  onManageProject?: (targetId: string) => void;
  observationTargetId?: string;
}) {
  const [observation, setObservation] = useState<{targetId:string;value:MemoryObservationStatus|null}|null>(null);
  const observationSupported=useRef(false);
  const [keyManagementSupported,setKeyManagementSupported]=useState(false);
  const [automaticMemorySupported,setAutomaticMemorySupported]=useState(false);
  const requestInFlight=useRef(false);
  const [jobs, setJobs] = useState<MemoryJob[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [attentionLimit, setAttentionLimit] = useState(5);
  const [historyLimit, setHistoryLimit] = useState(20);
  const [offset, setOffset] = useState(0);
  const [pageLoading, setPageLoading] = useState(false);
  const [page, setPage] = useState<{total: number; unresolved: number; nextOffset: number | null} | null>(null);
  useEffect(() => {
    if (!visible) return;
    let stopped = false;
    const refresh = async () => {
      if (requestInFlight.current) return;
      requestInFlight.current = true;
      setPageLoading(true);
      try {
        // Older sidecars reject unknown request fields. Negotiate with the
        // existing offset-only request before sending the optional target.
        const requestedObservation=!!observationTargetId&&observationSupported.current;
        const result = await terminalLocalRequest(AI_TERMINAL_PREFIX + '/memory', {offset,...(requestedObservation?{observationTargetId}:{})});
        if (!Array.isArray(result.jobs)) throw new Error('Invalid memory status');
        if (result.jobs.some((job: MemoryJob) => !job || typeof job.sessionId !== 'string'
          || typeof job.targetId !== 'string' || !Object.hasOwn(labels, job.state))) throw new Error('Invalid memory job');
        // Capability belongs to this host, not the selected project. Preserve
        // negotiation if initial target discovery superseded this response.
        observationSupported.current=result.observationSupported===true;
        if (!stopped) {
          setKeyManagementSupported(result.keyManagementSupported===true);
          setAutomaticMemorySupported(result.automaticMemorySupported===true);
          setJobs(result.jobs); setLoaded(true); setError(false);
          const value=result.observation;
          if(observationTargetId&&!requestedObservation&&observationSupported.current)setObservation(null);
          else if(observationTargetId)setObservation({targetId:observationTargetId,value:value?.version===1&&value.targetId===observationTargetId
            && ['available','inactive','uninitialized','unavailable'].includes(value.state)
            && Number.isSafeInteger(value.completedTurns)&&value.completedTurns>=0&&value.completedTurns<=128
            && typeof value.hasMore==='boolean'&&value.conversationMemory==='not-connected'?value:null});
          setPage(Number.isSafeInteger(result.total) && Number.isSafeInteger(result.unresolved)
            && (result.nextOffset === null || Number.isSafeInteger(result.nextOffset))
            ? {total: result.total, unresolved: result.unresolved, nextOffset: result.nextOffset} : null);
        }
      } catch { if (!stopped) setError(true); }
      finally { requestInFlight.current = false; if (!stopped) setPageLoading(false); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => { stopped = true; clearInterval(timer); };
  }, [visible, reload, offset, observationTargetId]);

  const observationReady=observation?.targetId===observationTargetId;
  const completion=observationReady?observation?.value:null;
  const observationLabel=!observationReady?'완료 대화 확인 중…':!completion?'이 앱에서는 완료 대화 상태를 확인할 수 없습니다.'
    :completion.state==='inactive'?'완료 대화 감지가 실행되지 않는 환경입니다.'
    :completion.state==='uninitialized'?'완료 대화 감지를 위해 프로젝트 장기기억을 초기화하세요.'
    :completion.state==='unavailable'?'완료 대화 상태 확인이 필요합니다. 기록이 없다는 뜻은 아닙니다.'
    :completion.completedTurns?`완료 대화 ${completion.completedTurns}건 확인${completion.hasMore?' · 추가 기록 있음':''}`
    :completion.hasMore?'추가 기록 확인 필요 · 현재 조회 범위에 완료 대화 없음':'아직 완료 대화를 확인하지 못했습니다.';

  const history = jobs.filter(job => job.state === 'saved' || job.state === 'unchanged');
  const attention = jobs.filter(job => job.state !== 'saved' && job.state !== 'unchanged')
    .sort((a, b) => Number(needsReview(b)) - Number(needsReview(a)));
  const row = (job: MemoryJob) => {
    const project = projects.find(project => project.targetId === job.targetId);
    return <li key={job.sessionId} className="ai-terminal-memory-row">
      <span><strong>{project?.label ?? '등록 프로젝트 확인 필요'}</strong><span className="ai-terminal-hint">{labels[job.state]}</span></span>
      {['failed', 'backup-pending', 'recovery-required'].includes(job.state) && <button className="ai-terminal-btn" onClick={() => onReview(job.targetId)}>워크룸에서 이어서 확인</button>}
      {job.state === 'unavailable' && project && onManageProject && <button className="ai-terminal-btn" onClick={() => onManageProject(project.projectTargetId ?? project.targetId)}>장기기억 설정</button>}
    </li>;
  };
  const announcement = Object.entries(labels).map(([state, label]) => {
    const count = jobs.filter(job => job.state === state).length;
    return count ? `${label} ${count}건` : '';
  }).filter(Boolean).join(' · ');
  return <section className="ai-terminal-memory" aria-label="세션 저장">
    <p role="status" aria-label="종료 후 저장 요약" aria-live="polite" aria-atomic="true" className="ai-terminal-sr-only">{loaded ? announcement || '아직 세션 저장 기록이 없습니다.' : ''}</p>
    <div className="ai-terminal-memory-heading">
      <h3>세션 저장</h3>
      <details className="ai-terminal-memory-help"><summary>저장 동작 안내</summary><p className="ai-terminal-hint">자동 세션 기억이 켜져 있으면 세션 종료 시 미저장 활동을 저장합니다. 앱 종료 시 아직 시작하지 않은 저장은 다음 실행에서 이어집니다. 저장 도중 종료됐거나 이전 작업의 잠금이 남으면 결과 확인 후 복구가 필요합니다. 창 숨기기·탭 이동은 세션 종료가 아닙니다.</p></details>
    </div>
    {error && <div className="ai-terminal-memory-error"><p role="alert" className="ai-terminal-error">세션 저장 상태를 확인하지 못했습니다. 기존 기록은 보존되며, 표시된 상태가 최신이 아닐 수 있습니다.</p><button className="ai-terminal-btn" onClick={() => setReload(value => value + 1)}>저장 상태 다시 확인</button></div>}
    {observationTargetId&&<div data-testid="workroom-completion-status">
      <strong>{projects.find(project=>project.targetId===observationTargetId)?.label??'선택한 프로젝트'} · 완료 대화</strong>
      <p className="ai-terminal-hint" role="status" aria-label="완료 대화 확인 상태">{error?'완료 대화 상태를 갱신하지 못했습니다.':observationLabel}</p>
      <p className="ai-terminal-hint">대화 감지는 장기기억 저장·백업 완료를 뜻하지 않습니다. {automaticMemorySupported?'자동 기억 정리는 아래 V2 설정에서 별도로 켜며, 선택 구간의 결과를 확인할 수 있습니다.':'대화 완료에 따른 자동 기억 정리는 아직 연결되지 않았습니다.'} 종료 후 저장 결과는 아래에서 확인하세요. ‘내가 한 말’의 사용자 발화 수집도 별도로 동작합니다.</p>
    </div>}
    {visible&&observationTargetId&&completion?.state==='available'&&keyManagementSupported&&<MemorySaveKeySetup key={observationTargetId} targetId={observationTargetId}/>}
    {visible&&observationTargetId&&completion?.state==='available'&&automaticMemorySupported&&<MemoryAutomaticSettings key={'auto-'+observationTargetId} targetId={observationTargetId}/>}
    {!loaded && !error && <p className="ai-terminal-hint" role="status">세션 저장 상태 확인 중…</p>}
    {!!attention.length && <div data-testid="workroom-memory-attention">
      <p className="ai-terminal-hint">확인·진행 중인 저장 {attention.length}건</p>
      <ul className="ai-terminal-memory-list">{attention.slice(0, attentionLimit).map(row)}</ul>
      {attention.length > attentionLimit && <button className="ai-terminal-btn" onClick={() => setAttentionLimit(value => value + 5)}>확인할 저장 더 보기 ({attention.length - attentionLimit}건)</button>}
    </div>}
    {!!history.length && <details data-testid="workroom-memory-history" className="ai-terminal-memory-history" open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)}>
      <summary>완료된 저장 기록 {history.length}건</summary>
      {historyOpen && <><ul className="ai-terminal-memory-list">{history.slice(0, historyLimit).map(row)}</ul>
        {history.length > historyLimit && <button className="ai-terminal-btn" onClick={() => setHistoryLimit(value => value + 20)}>저장 기록 더 보기 ({history.length - historyLimit}건)</button>}</>}
    </details>}
    {page && (page.total > 128 || offset > 0) && <nav aria-label="세션 저장 기록 페이지" className="ai-terminal-memory-heading">
      <span className="ai-terminal-hint">전체 {page.total}건 · 미해결 {page.unresolved}건 · 현재 페이지 {jobs.length}건 표시</span>
      <button className="ai-terminal-btn" disabled={pageLoading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 128))}>이전 기록</button>
      <button className="ai-terminal-btn" disabled={pageLoading || page.nextOffset === null} onClick={() => {if (page.nextOffset !== null) setOffset(page.nextOffset);}}>다음 기록</button>
    </nav>}
    {loaded && !error && !jobs.length && <p className="ai-terminal-hint">{offset ? '현재 페이지에 기록이 없습니다.' : '아직 세션 저장 기록이 없습니다.'}</p>}
  </section>;
}
