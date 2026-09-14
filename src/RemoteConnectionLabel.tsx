import React, {useState} from 'react';

/** Display-only notes: never used as a device identity or permission decision. */
export function RemoteConnectionLabel({sessionId, fallback}: {sessionId: string; fallback: string}) {
  const key = `agentstoz.remote-device-label.v1:${sessionId}`;
  const [name, setName] = useState(() => {
    try { return localStorage.getItem(key)?.slice(0, 80) ?? ''; } catch { return ''; }
  });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState('');
  const save = () => {
    const value = draft.trim().slice(0, 80);
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
      setName(value); setEditing(false); setError('');
    } catch { setError('이름을 저장하지 못했습니다. 다시 시도해 주세요.'); }
  };
  return <div>
    <div className="truncate text-xs font-semibold text-zinc-200">{name || fallback}</div>
    <div className="mt-1 text-[10px] text-zinc-500">연결 {sessionId.slice(-8)}{name ? ` · ${fallback}` : ''}</div>
    {editing ? <div className="mt-2 flex flex-wrap gap-2">
      <input aria-label="기기 이름" placeholder="예: 아이폰17 · TestFlight" maxLength={80}
        className="min-h-11 w-full rounded border border-zinc-600 bg-transparent px-2 text-xs"
        value={draft} onChange={event => setDraft(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); save(); } }} />
      <span className="w-full text-[10px] text-zinc-500">이 Mac에 표시할 이름입니다.</span>
      <button type="button" className="min-h-11 px-2 text-xs" onClick={save}>이름 저장</button>
      <button type="button" className="min-h-11 px-2 text-xs" onClick={() => {setEditing(false); setError('');}}>취소</button>
      {error && <span role="alert" className="text-xs text-red-300">{error}</span>}
    </div> : <button type="button" className="min-h-11 text-xs text-teal-200"
      onClick={() => {setDraft(name); setEditing(true);}}>{name ? '기기 이름 수정' : '기기 이름 기록'}</button>}
  </div>;
}
