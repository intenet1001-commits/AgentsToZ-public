import {useEffect,useState} from 'react';
import {isTauri} from './lib/env';
import {automaticSaveNotices,type AutomaticSaveNotice as Notice} from './automaticSaveNotices';
const storageKey='agentstoz:automatic-save-notices:dismissed';
export function AutomaticSaveNotice(){
  const [notices,setNotices]=useState<Notice[]>([]),[dismissed,setDismissed]=useState<string[]>(()=>{try{const v=JSON.parse(sessionStorage.getItem(storageKey)??'[]');return Array.isArray(v)?v.filter(id=>typeof id==='string'&&id.length<=512).slice(-48):[];}catch{return [];}});
  useEffect(()=>{
    let stopped=false,flight=false;const abort=new AbortController();
    const read=async()=>{
      if(stopped||flight||document.hidden)return;flight=true;
      try{const r=await fetch(`${isTauri()?'http://127.0.0.1:3001':''}/api/project-memory/auto-checkpoint/status`,{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10_000)])});if(!r.ok)throw Error();const v=await r.json();if(!Array.isArray(v.sessions))throw Error();if(!stopped)setNotices(automaticSaveNotices(v));}
      catch{/* Existing dated receipts remain historical evidence; no fabricated fresh result. */}
      finally{flight=false;}
    };
    void read();const timer=setInterval(()=>void read(),15_000);const visible=()=>void read();document.addEventListener('visibilitychange',visible);
    return()=>{stopped=true;abort.abort();clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
  },[]);
  const visible=notices.filter(n=>!dismissed.includes(n.id)).slice(0,2);
  if(!visible.length)return null;
  return <aside aria-label="확인된 자동 저장" className="border-b border-[var(--line)] bg-[var(--accent-soft)] px-3 py-2 text-sm space-y-2">
    {visible.map(n=><div key={n.id} className="flex items-start justify-between gap-2"><p role="status"><strong>{n.project} · {n.agent}</strong>{' · '}{n.kind==='memory'?`컨텍스트 ${n.threshold}% 기준 자동 세션 기억을 로컬에 저장했습니다.`:'압축·완료 턴의 복구 조각을 이 Mac에 암호화해 저장했습니다. 전체 대화·장기기억 저장과 별도입니다.'}{' '}{new Date(n.savedAt).toLocaleString('ko-KR')}{n.expiresAt?` · ${new Date(n.expiresAt).toLocaleString('ko-KR')}까지 보관`:''}{' · 이후 변경은 별도입니다. 저장 내용을 확인한 뒤 필요하면 직접 압축·초기화하세요.'}</p><button type="button" className="min-h-11 shrink-0 px-3" aria-label={`${n.project} ${n.agent} 저장 안내 닫기`} onClick={()=>{const next=[...dismissed,n.id].slice(-48);setDismissed(next);try{sessionStorage.setItem(storageKey,JSON.stringify(next));}catch{}}}>닫기</button></div>)}
  </aside>;
}
