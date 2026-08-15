import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, FolderOpen, Search, X } from 'lucide-react';
import { isTauri } from '../lib/env';
import type { MemoryArchiveMeta } from '../memoryArchive';

const apiBase = () => (isTauri() ? 'http://127.0.0.1:3001' : '');

/**
 * 장기기억 아카이브 대시보드.
 *
 * 프로젝트를 지운 뒤에도 남는 유일한 창구다. 그래서 **읽는 것**이 전부다 — 목록에서
 * 고르고, 본문을 보고, 필요하면 복사한다. 여기서 지우는 기능은 두지 않는다:
 * 애초에 "지워도 노하우는 남기려고" 만든 곳인데 그 안에 삭제 버튼을 두면 같은 실수를
 * 한 단계 뒤로 미루는 것뿐이다. 정말 지우려면 Finder에서 폴더를 열어 지운다.
 */
export function MemoryArchivePanel({ onClose, onOpenFolder, onToast }: {
  onClose: () => void;
  onOpenFolder: (path: string) => void;
  onToast: (message: string, type: 'success' | 'error') => void;
}) {
  const [items, setItems] = useState<MemoryArchiveMeta[] | null>(null);
  const [dir, setDir] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<MemoryArchiveMeta | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${apiBase()}/api/memory-archive`);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(data.error || '목록을 읽지 못했습니다');
        setItems(data.items ?? []);
        setDir(data.dir ?? '');
      } catch (e) {
        if (!cancelled) { setItems([]); setError(e instanceof Error ? e.message : String(e)); }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const open = useCallback(async (meta: MemoryArchiveMeta) => {
    setSelected(meta);
    setContent(null);
    try {
      const res = await fetch(`${apiBase()}/api/memory-archive?file=${encodeURIComponent(meta.file)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '본문을 읽지 못했습니다');
      setContent(data.content ?? '');
    } catch (e) {
      setContent(`읽기 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !items) return items ?? [];
    // 이름·코드·요약·원본 경로 전부에서 찾는다 — 몇 달 뒤에는 이름이 기억 안 나고
    // "그 결제 붙이던 프로젝트" 같은 단서만 남는다.
    return items.filter(item => [item.projectName, item.projectCode, item.summary, item.sourcePath]
      .some(field => (field ?? '').toLowerCase().includes(q)));
  }, [items, query]);

  return (
    <div
      data-testid="memory-archive-panel"
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 9600, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#111113', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 12,
          width: 'min(920px, 94vw)', height: 'min(660px, 88vh)', display: 'flex', flexDirection: 'column',
          fontFamily: 'Inter Tight, system-ui, sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <Archive style={{ width: 15, height: 15, color: '#5eead4' }} />
          <span style={{ fontSize: 14.5, fontWeight: 600, color: '#f4f4f5' }}>장기기억 아카이브</span>
          <span data-testid="memory-archive-count" style={{ fontSize: 11, color: '#71717a' }}>{items ? `${items.length}건` : '읽는 중…'}</span>
          <span style={{ flex: 1 }} />
          {dir && (
            <button
              data-testid="memory-archive-open-folder"
              onClick={() => onOpenFolder(dir)}
              title={dir}
              style={{ padding: '4px 9px', background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 5, color: '#a1a1aa', cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'inherit' }}
            ><FolderOpen style={{ width: 11, height: 11 }} />폴더 열기</button>
          )}
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#71717a', padding: 4 }}>
            <X style={{ width: 16, height: 16 }} />
          </button>
        </div>

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <div style={{ width: 320, borderRight: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ padding: 10, borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Search style={{ width: 12, height: 12, color: '#52525b' }} />
              <input
                data-testid="memory-archive-search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="이름·코드·내용으로 찾기"
                style={{ flex: 1, background: 'transparent', border: 'none', color: '#e4e4e7', fontSize: 12, outline: 'none', fontFamily: 'inherit' }}
              />
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
              {items === null && <div style={{ padding: 16, color: '#71717a', fontSize: 12 }}>읽는 중…</div>}
              {items !== null && filtered.length === 0 && (
                <div data-testid="memory-archive-empty" style={{ padding: 16, color: '#71717a', fontSize: 12, lineHeight: 1.6 }}>
                  {error
                    ? `목록을 읽지 못했습니다: ${error}`
                    : items.length === 0
                      ? '보관된 장기기억이 없습니다. 정리 검토에서 프로젝트를 삭제하면 그 기억이 여기에 남습니다.'
                      : '검색 결과가 없습니다.'}
                </div>
              )}
              {filtered.map(item => (
                <button
                  key={item.file}
                  data-testid="memory-archive-item"
                  onClick={() => void open(item)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', marginBottom: 4, padding: '8px 9px',
                    background: selected?.file === item.file ? 'rgba(94,234,212,0.09)' : 'transparent',
                    border: '1px solid', borderColor: selected?.file === item.file ? 'rgba(94,234,212,0.32)' : 'rgba(255,255,255,0.07)',
                    borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  <div style={{ fontSize: 12, color: '#f4f4f5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.projectName}</div>
                  <div style={{ fontSize: 9.5, color: '#52525b', marginTop: 2 }}>
                    {(item.archivedAt ?? '').slice(0, 10)} · {item.projectCode || '코드 없음'} · {Math.max(1, Math.round((item.bytes ?? 0) / 1024))}KB
                  </div>
                  {item.summary && (
                    <div style={{ fontSize: 10, color: '#71717a', marginTop: 3, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                      {item.summary}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            {!selected ? (
              <div style={{ margin: 'auto', color: '#52525b', fontSize: 12, textAlign: 'center', lineHeight: 1.7, padding: 24 }}>
                왼쪽에서 아카이브를 고르세요.<br />
                <span style={{ fontSize: 11 }}>프로젝트를 지워도 여기 남은 노하우는 다음 프로젝트에서 그대로 씁니다.</span>
              </div>
            ) : (
              <>
                <div style={{ padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                  <div style={{ fontSize: 13, color: '#f4f4f5', fontWeight: 600 }}>{selected.projectName}</div>
                  <div style={{ fontSize: 10, color: '#52525b', marginTop: 3, wordBreak: 'break-all' }}>{selected.sourcePath}</div>
                </div>
                <pre
                  data-testid="memory-archive-content"
                  style={{
                    flex: 1, overflow: 'auto', margin: 0, padding: 14, fontSize: 11.5, lineHeight: 1.65,
                    color: '#d4d4d8', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  }}
                >{content ?? '읽는 중…'}</pre>
                <div style={{ padding: '8px 14px', borderTop: '1px solid rgba(255,255,255,0.07)', display: 'flex', gap: 6 }}>
                  <button
                    data-testid="memory-archive-copy"
                    onClick={() => {
                      if (!content) return;
                      void navigator.clipboard.writeText(content)
                        .then(() => onToast('아카이브 내용을 복사했습니다', 'success'))
                        .catch(() => onToast('복사 실패', 'error'));
                    }}
                    style={{ padding: '4px 10px', background: 'rgba(94,234,212,0.1)', border: '1px solid rgba(94,234,212,0.3)', borderRadius: 5, color: '#5eead4', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}
                  >전체 복사</button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
