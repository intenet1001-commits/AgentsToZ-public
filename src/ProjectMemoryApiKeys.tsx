import React, { useId, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ClipboardCopyButton } from './ClipboardCopyButton';

type FeedKey = { id: string; label: string; token: string; memoryIds: string[]; expiresAt: string; lastUsedAt: string | null };
type MemoryChoice = { memoryId: string; name: string };

// 장기기억 목록 앞에 항상 보이는 연결 카드. 제목·설명과 관리 버튼을 먼저 보여 주고,
// 키 관리 본문은 같은 카드 안에서 펼친다.
const COPY_LABELS = { copiedLabel: '복사됨', copyingLabel: '복사 중…', errorMessage: '복사하지 못했습니다. 다시 시도해 주세요.' };
const MONO = 'font-[family-name:var(--font-mono)]';
const BTN_ROW = 'inline-flex h-[30px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border border-[color:var(--line)] bg-[var(--bg)] px-[11px] text-xs font-semibold text-[color:var(--ink)] transition-colors hover:border-[color:var(--line-2)] disabled:cursor-not-allowed disabled:opacity-40';
const BTN_SM = 'inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-[7px] border border-[color:var(--line)] bg-[var(--surface)] px-2.5 text-[11.5px] font-semibold text-[color:var(--ink-2)] transition-colors hover:border-[color:var(--line-2)] hover:text-[color:var(--ink)] disabled:cursor-not-allowed disabled:opacity-40';
const BTN_PRIMARY = 'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border-0 bg-[var(--ink)] px-3.5 text-xs font-bold text-[color:var(--bg)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40';
const INPUT = 'h-8 w-full rounded-lg border border-[color:var(--line)] bg-[var(--bg)] px-3 text-xs text-[color:var(--ink)] outline-none transition-[border-color,box-shadow] placeholder:text-[color:var(--ink-3)] focus:border-[color:var(--accent-line)] focus:shadow-[0_0_0_3px_var(--accent-soft)]';
const FIELD_LABEL = 'mb-1 block text-[11.5px] font-semibold text-[color:var(--ink-2)]';

export function ProjectMemoryApiKeys({ client, supabaseUrl, memories }: {
  client: () => SupabaseClient; supabaseUrl: string; memories: MemoryChoice[];
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [keys, setKeys] = useState<FeedKey[]>([]);
  const [label, setLabel] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState('');
  const [revealed, setRevealed] = useState<string | null>(null);
  const selectableIds = [...new Set(memories.map(memory => memory.memoryId))].slice(0, 100);
  const allSelected = selectableIds.length > 0 && selectableIds.every(memoryId => selected.includes(memoryId));
  const endpoint = `${supabaseUrl.replace(/\/$/, '')}/functions/v1/project-memory-feed`;
  const manage = async (action: 'list' | 'issue' | 'rotate' | 'revoke', key?: FeedKey) => {
    if (busy) return;
    if (key && !window.confirm(action === 'revoke'
      ? `‘${key.label}’의 장기기억 연결을 해제할까요? 이 키로 더 이상 읽을 수 없습니다.`
      : `‘${key.label}’의 키를 재발급할까요? 기존 키는 즉시 무효화됩니다.`)) return;
    setBusy(true); setMessage(''); setRevealed(null);
    if (action === 'list') setLoaded(false);
    try {
      const token = action === 'issue' || action === 'rotate'
        ? Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('') : null;
      const { data, error } = await client().rpc('portmgr_project_memory_feed_keys_manage', {
        p_action: action, p_key_id: key?.id ?? null, p_label: label.trim() || null,
        p_token: token, p_memory_ids: action === 'issue' ? selected : null,
      });
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error('키 목록 응답을 확인하지 못했습니다.');
      setKeys(data); setLoaded(true);
      if (action === 'issue') { setLabel(''); setSelected([]); }
      if (action !== 'list') setMessage(action === 'revoke' ? '연결을 해제했습니다.' : '키를 발급했습니다. 연결 안내를 복사해 외부 앱에 전달하세요.');
    } catch (error: any) {
      setMessage(`완료하지 못했습니다. ${error?.message ?? 'Supabase 연결을 확인하세요.'}`);
    } finally { setBusy(false); }
  };
  return <section aria-labelledby={`${id}-title`} className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2.5 rounded-xl border border-[color:var(--line)] bg-[var(--surface)] px-4 py-3.5" data-testid="project-memory-api-keys">
    <div className="min-w-0 flex-1 basis-[280px]">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`${id}-title`} className="m-0 text-[13px] font-bold text-[color:var(--ink)]">외부 앱 연결 키</h3>
        <span className="inline-flex min-h-[18px] items-center rounded px-1.5 text-[10.5px] font-bold bg-[var(--info-soft)] text-[color:var(--info)]">장기기억 본문 · 읽기 전용</span>
      </div>
      <p className="mb-0 mt-[3px] text-xs text-[color:var(--ink-2)]">선택한 장기기억의 최신 Supabase 백업 본문을 외부 앱에서 읽습니다. 키는 90일간 유효하며 앱별로 회수할 수 있습니다.</p>
    </div>
    <div className="ml-auto flex flex-wrap justify-end gap-1.5">
      <button type="button" aria-expanded={open} aria-controls={`${id}-content`} onClick={() => {
        setOpen(!open); setRevealed(null); if (!open) void manage('list');
      }} className={BTN_ROW}>연결 키 관리{open ? ' 접기' : ''}</button>
    </div>
    <div id={`${id}-content`} role="region" aria-labelledby={`${id}-content-title`} hidden={!open} className="min-w-0 basis-full space-y-3 border-t border-[color:var(--line)] pt-3">
      {open && <>
      <h4 id={`${id}-content-title`} className="m-0 text-xs font-bold text-[color:var(--ink)]">연결 키 관리</h4>
      <p className="m-0 text-xs text-[color:var(--ink-3)]">기억 수정·삭제 권한은 제공하지 않습니다. 합병한 기억은 새 ID를 선택해 연결을 새로 만드세요.</p>
      <form className="space-y-3" onSubmit={e => { e.preventDefault(); void manage('issue'); }}>
        <label className="block">
          <span className={FIELD_LABEL}>연결할 앱 이름</span>
          <input value={label} onChange={e => setLabel(e.target.value)} maxLength={120} required
            className={INPUT} placeholder="예: 나의 업무 도우미" />
        </label>
        <div className="flex flex-wrap items-center gap-2" data-testid="project-memory-selection-controls">
          <button type="button" className={BTN_SM} disabled={busy || !selectableIds.length || allSelected}
            onClick={() => setSelected(selectableIds)}>{memories.length > 100 ? '최대 100개 선택' : '전체선택'}</button>
          <button type="button" className={BTN_SM} disabled={busy || !selected.length}
            onClick={() => setSelected([])}>전체해제</button>
          <span role="status" className="text-xs text-[color:var(--ink-2)]">{selected.length} / {memories.length}개 선택</span>
          {memories.length > 100 && <span className="text-xs text-[color:var(--ink-3)]">한 키에 최대 100개까지 선택할 수 있습니다.</span>}
        </div>
        <fieldset disabled={busy} className="m-0 min-w-0 max-h-40 overflow-auto rounded-lg border border-[color:var(--line)] bg-[var(--bg)] px-3 py-2">
          <legend className="px-1 text-[11.5px] font-semibold text-[color:var(--ink-2)]">읽기를 허용할 장기기억 (최대 100개)</legend>
          {memories.map(memory => <label key={memory.memoryId} className="flex items-center gap-2 py-1 text-xs text-[color:var(--ink)]">
            <input type="checkbox" className="shrink-0 accent-[var(--accent)]" checked={selected.includes(memory.memoryId)} disabled={!selected.includes(memory.memoryId) && selected.length >= 100} onChange={e => setSelected(current => e.target.checked
              ? [...current, memory.memoryId] : current.filter(id => id !== memory.memoryId))} /><span className="min-w-0 break-words">{memory.name}</span>
          </label>)}
          {!memories.length && <p className="m-0 py-1 text-xs text-[color:var(--ink-3)]">먼저 장기기억을 Supabase에 백업하세요.</p>}
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <button disabled={busy || !loaded || !label.trim() || !selected.length || selected.length > 100}
            className={BTN_PRIMARY}>키 발급</button>
          <button type="button" disabled={busy} onClick={() => void manage('list')} className="text-xs font-semibold text-[color:var(--ink-3)] underline underline-offset-2 transition-colors hover:text-[color:var(--ink)] disabled:opacity-40">{busy ? '처리 중…' : '목록 새로고침'}</button>
        </div>
      </form>
      {keys.length > 0 && <div className="grid min-w-0 gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))' }}>
      {keys.map(key => <div key={key.id} className="flex min-w-0 flex-col gap-2 rounded-xl border border-[color:var(--line)] bg-[var(--bg)] p-4 text-xs text-[color:var(--ink-2)]">
        <p className="m-0 break-words text-[13px] font-bold text-[color:var(--ink)]">{key.label} <span className="font-normal text-[color:var(--ink-3)]">· 장기기억 {key.memoryIds.length}개</span></p>
        <p className={`${MONO} m-0 text-[11px] text-[color:var(--ink-3)]`}>만료: {new Date(key.expiresAt).toLocaleDateString()} · 최근 사용: {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : '아직 없음'}</p>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className={BTN_SM} disabled={busy} onClick={() => setRevealed(revealed === key.id ? null : key.id)}>{revealed === key.id ? '키 숨기기' : '키 보기'}</button>
          <ClipboardCopyButton {...COPY_LABELS} className={BTN_SM} disabled={busy} value={key.token}
            label="키 복사" successMessage="인증 키를 복사했습니다." testId="project-memory-copy-key" />
          <ClipboardCopyButton {...COPY_LABELS} className={BTN_SM} disabled={busy || !key.token} value={`장기기억 읽기 API\nGET ${endpoint}?limit=10\nAuthorization: Bearer ${key.token}\n\nitems: memoryId, revisionId, projectName, content, contentHash, updatedAt, truncated\nhasMore가 true이면 nextCursor를 URL 인코딩해 after에 넣어 다음 페이지를 읽으세요. 새로 동기화할 때는 after 없이 처음부터 읽고 revisionId로 변경을 확인하세요. 이 API는 최신 백업 목록이며 실시간 변경 스트림이 아닙니다. truncated=true이면 본문은 일부입니다.\n키는 서버 비밀 설정에 보관하세요. 브라우저 공개 코드나 URL에 넣지 마세요.`}
            label="연결 안내 복사" successMessage="연결 안내를 복사했습니다." testId="project-memory-copy-guide" />
          <button type="button" className={BTN_SM} disabled={busy} onClick={() => void manage('rotate', key)}>재발급</button>
          <button type="button" className={`${BTN_SM} ml-auto border-0 text-[color:var(--danger)] hover:bg-[var(--danger-soft)]`} disabled={busy} onClick={() => void manage('revoke', key)}>연결 해제</button>
        </div>
        {revealed === key.id && <code className={`${MONO} block select-all break-all rounded-lg bg-[var(--sunken)] px-2.5 py-2 text-[11px] text-[color:var(--ink)]`}>{key.token}</code>}
      </div>)}
      </div>}
      {loaded && !keys.length && <p className="m-0 rounded-xl border border-dashed border-[color:var(--line-2)] py-6 text-center text-[12.5px] text-[color:var(--ink-3)]">발급한 키가 없습니다.</p>}
      <p className="m-0 text-[11.5px] text-[color:var(--ink-3)]">API 주소: <span className={`${MONO} select-all break-all text-[color:var(--ink-2)]`}>{endpoint}</span></p>
      <ClipboardCopyButton {...COPY_LABELS} className={BTN_SM} value={endpoint} disabled={!supabaseUrl}
        label="주소 복사" successMessage="API 주소를 복사했습니다." testId="project-memory-copy-address" />
      <p className="m-0 text-[11.5px] text-[color:var(--ink-3)]">서버에 장기기억 API 마이그레이션과 project-memory-feed 함수가 배포되어 있어야 연결됩니다.</p>
      </>}
    </div>
    {message && <p role="status" className="m-0 min-w-0 basis-full break-words text-xs text-[color:var(--ink)]">{message}</p>}
  </section>;
}
