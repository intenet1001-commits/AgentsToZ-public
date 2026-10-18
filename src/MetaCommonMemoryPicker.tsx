import React, { useEffect, useState } from 'react';
import type { MetaMemorySummary } from './metaCommonMemoryContract';
import { metaMemoryRequest } from './metaCommonMemoryClient';
export default function MetaCommonMemoryPicker({ selected, onChange }: { selected: string[]; onChange: (ids: string[]) => void }) {
  const [memories, setMemories] = useState<MetaMemorySummary[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => { const controller = new AbortController(); setLoading(true); metaMemoryRequest({ operation: 'list' }, controller.signal).then(r => { setMemories(r.memories); setNext(r.nextOffset); }).catch(e => { if (!controller.signal.aborted) setError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }); return () => controller.abort(); }, []);
  const more = async () => { setLoading(true); try { const r = await metaMemoryRequest({ operation: 'list', offset: next }); setMemories(previous => [...previous, ...r.memories]); setNext(r.nextOffset); } catch (e) { setError((e as Error).message); } finally { setLoading(false); } };
  return <div className="space-y-2 pl-5 text-xs" data-testid="new-project-meta-memory-picker"><p>공통 기억 연결 · 선택 ({selected.length}개)</p><p className="text-[var(--ink-3)]">새 프로젝트의 전용 기억과 함께 사용할 클라우드 공통기억을 선택하세요.</p>{loading && <p>공통 기억 조회 중…</p>}{error && <p role="status" className="text-[var(--ink-3)]">{error}</p>}<div className="max-h-40 space-y-1 overflow-auto">{memories.filter(m => !m.archived).map(m => <label key={m.id} className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={selected.includes(m.id)} disabled={!selected.includes(m.id) && selected.length >= 32} onChange={e => onChange(e.target.checked ? [...selected, m.id] : selected.filter(id => id !== m.id))} />{m.name}<span className="text-[var(--ink-3)]">{m.tags.join(' · ')}</span></label>)}</div>{next !== null && <button type="button" disabled={loading} onClick={() => void more()} className="min-h-11 rounded border border-[var(--line)] px-3">공통 기억 더 보기</button>}</div>;
}
