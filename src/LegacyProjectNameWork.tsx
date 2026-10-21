import {useEffect, useState} from 'react';

export interface LegacyProjectNameResult {
  id: string;
  label: string;
  name?: string | null;
  category?: string | null;
}

export interface LegacyProjectNameWorkState {
  id: string;
  kind: 'edit' | 'enrichment';
  title: string;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  state: 'running' | 'completed' | 'failed' | 'stopping' | 'stopped';
  results: LegacyProjectNameResult[];
  error?: string | null;
}

export interface LegacyProjectNameWorkProps {
  work: LegacyProjectNameWorkState;
  onApplyDraft?: () => void;
  onReturn?: () => void;
  onDismiss?: () => void;
  onStopAfterCurrent?: () => void;
}

const PAGE_SIZE = 20;
const statusLabels: Record<LegacyProjectNameWorkState['state'], string> = {
  running: '분석 중',
  completed: '분석 완료',
  failed: '분석 실패',
  stopping: '현재 분석 묶음이 끝나면 중지합니다',
  stopped: '중지됨',
};
const buttonClass = 'rounded-lg border border-[var(--line)] px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40';

/** Displays legacy naming work. The parent owns execution, persistence and draft checks. */
export function LegacyProjectNameWork({
  work, onApplyDraft, onReturn, onDismiss, onStopAfterCurrent,
}: LegacyProjectNameWorkProps) {
  const [page, setPage] = useState(0);
  useEffect(() => {setPage(0);}, [work.id]);
  const pageCount = Math.max(1, Math.ceil(work.results.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const offset = currentPage * PAGE_SIZE;
  const visibleResults = work.results.slice(offset, offset + PAGE_SIZE);
  const isActive = work.state === 'running' || work.state === 'stopping';
  const hasDraft = work.results.some(result => Boolean(result.name?.trim() || result.category?.trim()));
  const canApplyDraft = work.kind === 'edit' && work.state === 'completed' && hasDraft && !!onApplyDraft;
  const progressMax = Math.max(1, work.total);
  const progressValue = Math.max(0, Math.min(work.processed, progressMax));

  return (
    <section
      data-testid="legacy-project-name-work"
      aria-label="프로젝트 별명·카테고리 작업"
      className="min-w-0 max-w-full shrink-0 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 text-[var(--ink)]"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <h2 className="min-w-0 flex-1 break-words text-sm font-bold [overflow-wrap:anywhere]">{work.title}</h2>
        <span data-testid="legacy-project-name-model" className="shrink-0 text-xs text-[var(--ink-3)]">Claude / Haiku</span>
      </div>
      <p className="my-2 text-xs leading-relaxed text-[var(--ink-3)]">
        {work.kind === 'edit'
          ? '프로젝트를 분석해 별명과 카테고리를 제안합니다. 편집에 반영한 뒤 저장 버튼을 눌러 주세요.'
          : '비어 있는 별명과 카테고리를 최대 15개씩 순서대로 보충합니다. 중지하면 현재 묶음까지 저장하고 다음 묶음은 시작하지 않습니다.'}
      </p>

      <div role="status" aria-live="polite" aria-atomic="true" data-testid="legacy-project-name-status" className="my-3 space-y-1 text-sm">
        <p className="font-medium">{statusLabels[work.state]}</p>
        <p className="text-xs text-[var(--ink-3)]">
          전체 {work.total.toLocaleString('ko-KR')}개 · 처리 {work.processed.toLocaleString('ko-KR')}개 · 성공 {work.succeeded.toLocaleString('ko-KR')}개 · 실패 {work.failed.toLocaleString('ko-KR')}개
        </p>
      </div>
      <progress
        aria-label="프로젝트 분석 진행"
        aria-valuetext={`전체 ${work.total}개 중 ${work.processed}개 처리`}
        max={progressMax}
        value={progressValue}
        className="block h-2 w-full max-w-full accent-[var(--accent)]"
      />

      {work.error && (
        <p role="alert" data-testid="legacy-project-name-error" className="my-3 whitespace-pre-wrap break-words text-sm text-red-400 [overflow-wrap:anywhere]">
          {work.error}
        </p>
      )}

      {visibleResults.length > 0 ? (
        <div className="mt-4 min-w-0">
          <div className="max-h-80 overflow-y-auto rounded-lg border border-[var(--line)]">
            <table className="w-full table-fixed text-left text-xs">
              <caption className="sr-only">프로젝트별 별명과 카테고리 제안</caption>
              <thead className="sticky top-0 bg-[var(--surface)] text-[var(--ink-3)]">
                <tr>
                  <th scope="col" className="w-[36%] px-2 py-2 font-medium">프로젝트</th>
                  <th scope="col" className="w-[38%] px-2 py-2 font-medium">별명</th>
                  <th scope="col" className="w-[26%] px-2 py-2 font-medium">카테고리</th>
                </tr>
              </thead>
              <tbody>
                {visibleResults.map(result => (
                  <tr key={result.id} className="border-t border-[var(--line)] align-top">
                    <td className="whitespace-pre-wrap break-words px-2 py-2 [overflow-wrap:anywhere]">{result.label}</td>
                    <td className="whitespace-pre-wrap break-words px-2 py-2 [overflow-wrap:anywhere]">{result.name?.trim() || '—'}</td>
                    <td className="whitespace-pre-wrap break-words px-2 py-2 [overflow-wrap:anywhere]">{result.category?.trim() || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav aria-label="이름 작업 결과 페이지" className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--ink-3)]">
            <span>{offset + 1}–{offset + visibleResults.length} / {work.results.length.toLocaleString('ko-KR')}개 결과</span>
            <div className="flex items-center gap-2">
              <button type="button" aria-label="이전 결과 페이지" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} className="rounded-md border border-[var(--line)] px-2 py-1 disabled:opacity-40">이전</button>
              <span>{currentPage + 1} / {pageCount}</span>
              <button type="button" aria-label="다음 결과 페이지" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)} className="rounded-md border border-[var(--line)] px-2 py-1 disabled:opacity-40">다음</button>
            </div>
          </nav>
        </div>
      ) : (
        <p className="my-4 text-xs text-[var(--ink-3)]">{isActive ? '분석 결과가 도착하면 여기에 표시됩니다.' : '표시할 제안이 없습니다.'}</p>
      )}

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {!isActive && onDismiss && <button type="button" data-testid="legacy-project-name-dismiss" onClick={onDismiss} className={buttonClass}>제안 닫기</button>}
        {onReturn && (
          <button type="button" data-testid="legacy-project-name-return" onClick={onReturn} className={buttonClass}>
            {work.kind === 'edit' ? '편집으로 돌아가기' : '프로젝트 목록으로 돌아가기'}
          </button>
        )}
        {work.kind === 'enrichment' && isActive && (
          <button
            type="button"
            data-testid="legacy-project-name-stop"
            onClick={onStopAfterCurrent}
            disabled={work.state === 'stopping' || !onStopAfterCurrent}
            className={buttonClass}
          >
            {work.state === 'stopping' ? '현재 묶음 후 중지 예정' : '현재 묶음 후 중지'}
          </button>
        )}
        {work.kind === 'edit' && onApplyDraft && (
          <button type="button" data-testid="legacy-project-name-apply" disabled={!canApplyDraft} onClick={onApplyDraft} className={buttonClass}>
            편집에 반영
          </button>
        )}
      </div>
    </section>
  );
}
