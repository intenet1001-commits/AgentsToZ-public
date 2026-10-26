import {useCallback,useEffect,useState} from 'react';
import {AlertCircle,CheckCircle2,Loader2,Save,ShieldCheck,X} from 'lucide-react';
import {isTauri} from './lib/env';
import {phoneDateTime} from './phoneTime';
import {automaticSaveNotices,type AutomaticSaveNotice as Notice} from './automaticSaveNotices';
import {clearSaveRun,saveTargets,unsavedNoticeId,useUnsavedSessionMemory,type SaveItem,type SaveRun,type UnsavedProject} from './unsavedSessionMemory';
import './AutomaticSaveNotice.css';

/**
 * Confirmed automatic saves as a notification stack above 「아젠투지 호출」 (VOC 2026-10-24).
 *
 * They used to be a full-width banner on top of every page; now they float right above the dock, newest
 * nearest to it, like a desktop notification stack. Dismissals are kept in localStorage so the voice window
 * and the main window (separate webviews, separate sessionStorage) agree on what was closed.
 */
const storageKey='agentstoz:automatic-save-notices:dismissed:v2';
const DISMISSED_LIMIT=96;
const SHOWN=3;
const readDismissed=():string[]=>{try{const v=JSON.parse(localStorage.getItem(storageKey)??'[]');return Array.isArray(v)?v.filter(id=>typeof id==='string'&&id.length<=512).slice(-DISMISSED_LIMIT):[];}catch{return [];}};

export function useAutomaticSaveNotices(){
  const [notices,setNotices]=useState<Notice[]>([]),[dismissed,setDismissed]=useState<string[]>(readDismissed);
  useEffect(()=>{
    let stopped=false,flight=false;const abort=new AbortController();
    const read=async()=>{
      if(stopped||flight||document.hidden)return;flight=true;
      try{const r=await fetch(`${isTauri()?'http://127.0.0.1:3001':''}/api/project-memory/auto-checkpoint/status`,{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10_000)])});if(!r.ok)throw Error();const v=await r.json();if(!Array.isArray(v.sessions))throw Error();if(!stopped)setNotices(automaticSaveNotices(v));}
      catch{/* Existing dated receipts remain historical evidence; no fabricated fresh result. */}
      finally{flight=false;}
    };
    void read();const timer=setInterval(()=>void read(),15_000);const visible=()=>void read();document.addEventListener('visibilitychange',visible);
    // Another window (voice window ↔ main window) closed a notice.
    const synced=(event:StorageEvent)=>{if(event.key===storageKey)setDismissed(readDismissed());};
    window.addEventListener('storage',synced);
    return()=>{stopped=true;abort.abort();clearInterval(timer);document.removeEventListener('visibilitychange',visible);window.removeEventListener('storage',synced);};
  },[]);
  const dismiss=useCallback((ids:readonly string[])=>{
    setDismissed(current=>{const next=[...current.filter(id=>!ids.includes(id)),...ids].slice(-DISMISSED_LIMIT);try{localStorage.setItem(storageKey,JSON.stringify(next));}catch{/* per-device convenience only */}return next;});
  },[]);
  return {notices:notices.filter(n=>!dismissed.includes(n.id)),dismiss,dismissed};
}

const noticeSummary=(n:Notice)=>n.kind==='memory'?`컨텍스트 ${n.threshold}% · 자동 세션 기억 저장`:'복구 조각 암호화 저장';
/** Beside the title like a desktop notification: today only the time, otherwise the date too. */
export function noticeTime(savedAt:string,now=Date.now()){
  const at=new Date(savedAt),today=new Date(now);if(Number.isNaN(at.getTime()))return '';
  const sameDay=at.getFullYear()===today.getFullYear()&&at.getMonth()===today.getMonth()&&at.getDate()===today.getDate();
  return sameDay?`${String(at.getHours()).padStart(2,'0')}:${String(at.getMinutes()).padStart(2,'0')}`:phoneDateTime(at,now);
}
const noticeDetail=(n:Notice)=>n.kind==='memory'
  ?`${phoneDateTime(n.savedAt)}에 로컬 장기기억에 저장했습니다. 이후 변경은 별도입니다. 저장 내용을 확인한 뒤 필요하면 직접 압축·초기화하세요.`
  :`${phoneDateTime(n.savedAt)}에 압축·완료 턴의 복구 조각을 이 Mac에 암호화해 저장했습니다. 전체 대화·장기기억 저장과 별도입니다.${n.expiresAt?` ${phoneDateTime(n.expiresAt)}까지 보관합니다.`:''}`;

/**
 * `dock`: inside the 「아젠투지 호출」 dock (main window in the browser, the voice window in the app).
 * `floating`: on its own at the bottom right — the main window while the voice window is closed.
 */
export function AutomaticSaveNotice({placement='floating'}:{placement?:'dock'|'floating'}){
  const {notices,dismiss,dismissed}=useAutomaticSaveNotices();
  const {unsaved,run}=useUnsavedSessionMemory({check:true});
  const [expanded,setExpanded]=useState(false),[open,setOpen]=useState<string|null>(null);
  const unsavedId=unsaved.length?unsavedNoticeId(unsaved):null;
  // A run (going or finished) always shows; the reminder alone can be put away until the unsaved set changes.
  const unsavedCard=run?'run':unsavedId&&!dismissed.includes(unsavedId)?'unsaved':null;
  if(!notices.length&&!unsavedCard)return null;
  const shown=notices.slice(0,expanded?8:SHOWN),hidden=notices.length-shown.length;
  const clearable=[...notices.map(n=>n.id),...(unsavedCard==='unsaved'&&unsavedId?[unsavedId]:[])];
  // Newest sits nearest the dock (at the bottom), the way a notification stack grows upward.
  return <section className={`az-notices az-notices--${placement}`} aria-label="기억 저장 알림" data-testid="dock-notices">
    {(hidden>0||expanded&&notices.length>SHOWN)&&<div className="az-notices__bar">
      {hidden>0&&<button type="button" data-testid="dock-notices-more" onClick={()=>setExpanded(true)}>알림 {hidden}개 더 보기</button>}
      {expanded&&notices.length>SHOWN&&<button type="button" onClick={()=>setExpanded(false)}>접기</button>}
    </div>}
    <ol aria-live="polite">
      {[...shown].reverse().map(n=>{const isOpen=open===n.id;return <li key={n.id} className="az-notice" data-kind={n.kind} data-testid="dock-notice">
        <button type="button" className="az-notice__body" aria-expanded={isOpen} title={isOpen?'접기':'자세히 보기'} onClick={()=>setOpen(isOpen?null:n.id)}>
          <span className="az-notice__icon" aria-hidden="true">{n.kind==='memory'?<CheckCircle2 size={16}/>:<ShieldCheck size={16}/>}</span>
          <span className="az-notice__text" role="status">
            <span className="az-notice__head"><strong>{n.project} · {n.agent}</strong><time dateTime={n.savedAt} title={phoneDateTime(n.savedAt)}>{noticeTime(n.savedAt)}</time></span>
            <small>{noticeSummary(n)}</small>
            {isOpen&&<span className="az-notice__detail">{noticeDetail(n)}</span>}
          </span>
        </button>
        <button type="button" className="az-notice__close" aria-label={`${n.project} ${n.agent} 저장 안내 닫기`} title="닫기" onClick={()=>dismiss([n.id])}><X size={13}/></button>
      </li>;})}
      {unsavedCard==='run'&&run&&<SaveRunCard run={run} open={open==='run'} onToggle={()=>setOpen(open==='run'?null:'run')}/>}
      {unsavedCard==='unsaved'&&unsavedId&&<UnsavedCard unsaved={unsaved} open={open==='unsaved'} onToggle={()=>setOpen(open==='unsaved'?null:'unsaved')} onDismiss={()=>dismiss([unsavedId])}/>}
    </ol>
    {clearable.length>1&&<button type="button" className="az-notices__clear" data-testid="dock-notices-clear" onClick={()=>dismiss(clearable)}>알림 모두 지우기</button>}
  </section>;
}

/** Open sessions with work that no save has covered yet — the reminder and its one-click save. */
function UnsavedCard({unsaved,open,onToggle,onDismiss}:{unsaved:UnsavedProject[];open:boolean;onToggle:()=>void;onDismiss:()=>void}){
  const names=unsaved.map(u=>u.name).join(' · ');
  return <li className="az-notice" data-kind="unsaved" data-testid="dock-unsaved-notice">
    <button type="button" className="az-notice__body" aria-expanded={open} title={open?'접기':'자세히 보기'} onClick={onToggle}>
      <span className="az-notice__icon" aria-hidden="true"><Save size={16}/></span>
      <span className="az-notice__text" role="status">
        <span className="az-notice__head"><strong>저장 안 된 작업 · 프로젝트 {unsaved.length}개</strong></span>
        <small title={names}>{names}</small>
        {open&&<span className="az-notice__detail">
          자동 저장은 컨텍스트 기준에 닿을 때만 돕니다. 지금 저장하면 프로젝트마다 가장 최근 세션의 AI가 장기기억을 정리하고, 하나씩 차례로 저장합니다(프로젝트마다 몇십 초에서 몇 분).
          <span className="az-notice__items">{unsaved.map(u=><span key={u.folder} title={u.folder}>{u.name} · {u.agent==='claude'?'Claude':'Codex'}</span>)}</span>
        </span>}
      </span>
    </button>
    <button type="button" className="az-notice__close" aria-label="저장 안 된 작업 안내 닫기" title="닫기 · 저장할 프로젝트가 바뀌면 다시 알립니다" onClick={onDismiss}><X size={13}/></button>
    <div className="az-notice__actions">
      <button type="button" className="az-notice__primary" data-testid="dock-unsaved-save-all" title="프로젝트마다 가장 최근 세션의 AI로 장기기억을 저장합니다" onClick={()=>void saveTargets(unsaved.map(({folder,name,agent})=>({folder,name,agent})))}><Save size={12}/>{unsaved.length>1?`모두 저장 (${unsaved.length})`:'지금 저장'}</button>
    </div>
  </li>;
}

const itemLine:Record<SaveItem['status'],string>={pending:'대기',saving:'저장 중…',saved:'저장됨',skipped:'건너뜀',failed:'실패',unknown:'결과 확인 필요',stopped:'시작 안 함'};
/** A save run from the dock card or the session list, while it goes and after it ends. */
function SaveRunCard({run,open,onToggle}:{run:SaveRun;open:boolean;onToggle:()=>void}){
  const count=(...statuses:SaveItem['status'][])=>run.items.filter(i=>statuses.includes(i.status)).length;
  const done=count('saved','skipped','failed','unknown','stopped'),current=run.items.find(i=>i.status==='saving');
  const trouble=count('failed','unknown');
  const summary=run.running?`${current?.name??''} 저장 중…`:[`저장 ${count('saved')}`,count('skipped')?`건너뜀 ${count('skipped')}`:'',trouble?`확인 필요 ${trouble}`:'',count('stopped')?`시작 안 함 ${count('stopped')}`:''].filter(Boolean).join(' · ');
  return <li className="az-notice" data-kind="save-run" data-state={run.running?'running':trouble?'trouble':'done'} data-testid="dock-save-run">
    <button type="button" className="az-notice__body" aria-expanded={open} title={open?'접기':'자세히 보기'} onClick={onToggle}>
      <span className="az-notice__icon" aria-hidden="true">{run.running?<Loader2 size={16} className="az-notice__spin"/>:trouble?<AlertCircle size={16}/>:<CheckCircle2 size={16}/>}</span>
      <span className="az-notice__text" role="status">
        <span className="az-notice__head"><strong>{run.running?`기억 저장 중 · ${done}/${run.items.length}`:'기억 저장 끝'}</strong></span>
        <small>{summary}</small>
        {(open||!run.running&&trouble>0)&&<span className="az-notice__items">{run.items.map(i=><span key={i.folder} data-status={i.status} title={i.message}>{i.name} · {itemLine[i.status]}{i.message&&i.status!=='saved'&&i.status!=='saving'?` — ${i.message}`:''}</span>)}</span>}
      </span>
    </button>
    {!run.running&&<button type="button" className="az-notice__close" aria-label="기억 저장 결과 닫기" title="닫기" onClick={clearSaveRun}><X size={13}/></button>}
  </li>;
}
