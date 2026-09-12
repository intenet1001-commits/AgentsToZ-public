import { useEffect, useRef, useState } from 'react';
import type { QuickLabel, QuickLabelInput } from './agentRuntimeQuickLabels';
import { terminalLocalRequest } from './aiTerminalClient';
import { QuickProjectNameRun, type QuickNameProgress } from './quickProjectNameRun';

const path = '/api/agent-runtime/quick-labels';
const idle: QuickNameProgress = { phase: 'idle', items: [], results: [], totalBatches: 0, completedBatches: 0, activeJobId: null, error: '' };

export function QuickProjectNames({ items, onApply, onClose, variant = 'dialog' }: {
  items: QuickLabelInput[];
  onApply: (results: QuickLabel[]) => Promise<void>;
  onClose: () => void;
  variant?: 'dialog' | 'embedded';
}) {
  const runner = useRef<QuickProjectNameRun | null>(null);
  const [progress, setProgress] = useState<QuickNameProgress>(idle);
  const [applying, setApplying] = useState(false);
  const applyInFlight = useRef(false);
  const [applyError, setApplyError] = useState('');
  useEffect(() => {
    const owner = new QuickProjectNameRun(request => terminalLocalRequest(path, request), setProgress);
    runner.current = owner;
    return () => { owner.dispose(); if (runner.current === owner) runner.current = null; };
  }, []);
  const active = progress.phase === 'running' || progress.phase === 'cancelling';
  const reviewReady = ['completed', 'failed', 'cancelled'].includes(progress.phase) && progress.results.length > 0;
  const displayItems = progress.items.length ? progress.items : items;
  const names = new Map(displayItems.map(item => [item.id, item.name]));
  const embedded = variant === 'embedded';
  const apply = async () => {
    if (applyInFlight.current) return;
    applyInFlight.current = true;
    setApplying(true); setApplyError('');
    try { await onApply(progress.results); onClose(); }
    catch (error) { setApplyError(error instanceof Error ? error.message : String(error)); }
    finally { applyInFlight.current = false; setApplying(false); }
  };

  return <div className={embedded ? 'min-w-0 max-w-full shrink-0' : 'fixed inset-0 z-[150] flex items-center justify-center bg-black/35 p-4'}
    role={embedded ? undefined : 'dialog'} aria-modal={embedded ? undefined : true} aria-label="AI 이름 추천" data-testid="quick-project-names">
    <section className={`${embedded ? 'w-full' : 'max-h-[85vh] max-w-2xl overflow-auto'} min-w-0 max-w-full rounded-2xl border border-zinc-700 bg-[var(--bg-card)] p-4 sm:p-6`}
      style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
      <h2 className="text-lg font-semibold">AI 이름 추천</h2>
      <p className="my-2 text-sm text-zinc-400">선택한 {displayItems.length}개 프로젝트를 모두 추천합니다. 한 번에 최대 30개씩 순서대로 처리하며, 결과를 확인한 뒤 적용합니다.</p>
      {progress.phase === 'idle' && <ul className="my-4 max-h-52 overflow-y-auto text-sm">{items.map(item => <li className="py-1" key={item.id}>{item.name}</li>)}</ul>}
      {progress.phase !== 'idle' && <p role="status" aria-live="polite" className="my-4 text-sm" data-testid="quick-project-names-progress">
        {progress.results.length} / {displayItems.length}개 제안 확보 · {progress.completedBatches} / {progress.totalBatches}묶음 완료
        {progress.phase === 'running' && ` · ${Math.min(progress.completedBatches + 1, progress.totalBatches)}번째 묶음 추천 중`}
        {progress.phase === 'cancelling' && ' · 취소 확인 중…'}
        {progress.phase === 'completed' && ' · 전체 추천 완료'}
        {progress.phase === 'cancelled' && ' · 취소 완료, 앞서 얻은 제안은 보존했습니다.'}
        {progress.phase === 'failed' && ' · 일부 추천 중단, 앞서 얻은 제안은 보존했습니다.'}
        {progress.phase === 'uncertain' && ' · 작업 상태 확인 필요'}
      </p>}
      {(applyError || progress.error) && <p role="alert" className="my-3 text-sm text-red-300">{applyError || progress.error}</p>}
      {progress.results.length > 0 && <div className="my-4 max-h-96 min-w-0 max-w-full overflow-y-auto">
      <table className="w-full table-fixed text-left text-sm" data-testid="quick-project-names-results">
        <colgroup><col style={{ width: '40%' }} /><col style={{ width: '30%' }} /><col style={{ width: '30%' }} /></colgroup>
        <thead><tr><th className="p-2">프로젝트</th><th className="p-2">추천 별명</th><th className="p-2">카테고리</th></tr></thead>
        <tbody>{progress.results.map(result => <tr className="border-t border-zinc-800" key={result.id}>
          <td className="p-2 align-top">{names.get(result.id)}</td><td className="p-2 align-top">{result.name}</td><td className="p-2 align-top">{result.category}</td>
        </tr>)}</tbody>
      </table></div>}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        {active || (progress.phase === 'uncertain' && progress.activeJobId) ? <button type="button" disabled={progress.phase === 'cancelling'}
          className="rounded-lg border border-zinc-700 px-4 py-2 text-sm disabled:opacity-40" onClick={() => void runner.current?.cancel()}>
          {progress.phase === 'cancelling' ? '취소 확인 중…' : '작업 취소'}
        </button> : <button type="button" className="rounded-lg border border-zinc-700 px-4 py-2 text-sm" disabled={applying} onClick={onClose}>닫기</button>}
        {progress.phase === 'uncertain' && progress.activeJobId && <button type="button" className="rounded-lg border border-zinc-700 px-4 py-2 text-sm"
          onClick={() => void runner.current?.refresh()}>같은 작업 상태 확인</button>}
        {progress.phase === 'idle' && <button type="button" disabled={!items.length}
          className="rounded-lg bg-[var(--text-primary)] px-4 py-2 text-sm text-[var(--bg-base)] disabled:opacity-40"
          onClick={() => void runner.current?.start(items)}>추천 시작</button>}
        {reviewReady && <button type="button" disabled={applying}
          className="rounded-lg bg-[var(--text-primary)] px-4 py-2 text-sm text-[var(--bg-base)] disabled:opacity-40" onClick={() => void apply()}>
          {applying ? '적용 중…' : `${progress.results.length}개 제안 적용`}
        </button>}
      </div>
    </section>
  </div>;
}
