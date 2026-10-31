import React,{useCallback,useEffect,useRef,useState} from 'react';
import {RefreshCw} from 'lucide-react';
import {terminalLocalRequest} from '../aiTerminalClient';
import {WEEKLY_USAGE_PATH,normalizeWeeklyUsageItems,weeklyUsageState,type WeeklyUsage} from '../weeklyUsage';
import {weeklyLimitResetLabel} from '../workroomWeeklyLimit';
import {codexWeeklyUsageNoDataState,weeklyUsageCheckedAgo} from '../weeklyUsageDisplay';
import {WEEKLY_USAGE_PUSH_COPY,normalizeWeeklyUsagePushStatus,weeklyUsagePushNote,type WeeklyUsagePushStatus} from '../weeklyUsagePush';
const names={claude:'Claude',codex:'Codex',agy:'Antigravity'};
export function DockWeeklyUsageFigure({row,provider,itemsLoaded,now=Date.now()}:{row:WeeklyUsage|undefined;provider:WeeklyUsage['provider'];itemsLoaded:boolean;now?:number}){
 const state=row?weeklyUsageState(row,now):'unavailable',known=row&&['ready','stale'].includes(state),remaining=known?Math.min(...row.buckets.map(b=>b.remainingPercent)):null;
 const noDataState=row?codexWeeklyUsageNoDataState(row,now):null;
 return <span className={remaining!==null&&remaining<15?'az-weekly__low':''}>{remaining!==null?`${row!.buckets.length>1?'최소 ':''}${remaining}%`:noDataState?'주간 자료 없음':row?.connected&&provider!=='codex'?(state==='waiting'?'활동 대기':'주간 자료 없음'):(itemsLoaded?'확인 안 됨':'확인 중…')}{noDataState&&<small> · {noDataState==='stale'?'이전 확인 · ':''}{weeklyUsageCheckedAgo(row!.checkedAt,now)} 확인</small>}{state==='stale'&&<small> 이전 값</small>}</span>;
}
export function DockWeeklyUsage(){
 const [items,setItems]=useState<WeeklyUsage[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);const flight=useRef(false),alive=useRef(true);
 // 「휴대폰 알림」: null while unknown or on a Mac app that does not offer it (then no switch is shown at all).
 const [push,setPush]=useState<WeeklyUsagePushStatus|null>(null),[pushBusy,setPushBusy]=useState(false),pushRevision=useRef(0);
 const load=useCallback(async()=>{if(flight.current)return;flight.current=true;
  try{const r=await terminalLocalRequest(WEEKLY_USAGE_PATH,{operation:'status'});if(alive.current){setItems(normalizeWeeklyUsageItems(r.items));setError('');}}
  catch{if(alive.current)setError('사용량을 확인하지 못했습니다.');}
  // A read that crossed a switch is older than the switch's own answer; a failed read keeps what is shown.
  const revision=pushRevision.current;
  try{const r=await terminalLocalRequest(WEEKLY_USAGE_PATH,{operation:'alerts'});if(alive.current&&revision===pushRevision.current)setPush(normalizeWeeklyUsagePushStatus(r));}
  catch{/* An older Mac app refuses the operation: the switch stays hidden. */}finally{flight.current=false;}
 },[]);
 useEffect(()=>{alive.current=true;const read=()=>{if(!document.hidden)void load();};read();const timer=setInterval(read,60_000);document.addEventListener('visibilitychange',read);return()=>{alive.current=false;clearInterval(timer);document.removeEventListener('visibilitychange',read);};},[load]);
 const switchPush=async(enabled:boolean)=>{if(pushBusy)return;setPushBusy(true);pushRevision.current++;
  try{const r=normalizeWeeklyUsagePushStatus(await terminalLocalRequest(WEEKLY_USAGE_PATH,{operation:'alerts',enabled}));if(!r)throw Error(WEEKLY_USAGE_PUSH_COPY.failed);if(alive.current){setPush(r);setError('');}}
  catch(e){if(alive.current)setError(e instanceof Error?e.message:WEEKLY_USAGE_PUSH_COPY.failed);}finally{if(alive.current)setPushBusy(false);}
 };
 const connect=async(row:WeeklyUsage,operation:'connect'|'disconnect')=>{if(busy)return;setBusy(true);try{await terminalLocalRequest(WEEKLY_USAGE_PATH,{operation,provider:row.provider});await load();}catch(e){setError(e instanceof Error?e.message:'사용량을 연결하지 못했습니다.');}finally{setBusy(false);}};
 return <section className="az-weekly" aria-label="에이전트별 주간 잔여 사용량" data-testid="dock-weekly-usage">
  <div className="az-weekly__head"><span>주간 잔여 <small>최근 CLI 기준</small></span><button type="button" className="az-sessions__icon" aria-label="주간 사용량 새로고침" onClick={()=>void load()} disabled={busy}><RefreshCw size={11}/></button></div>
  <div className="az-weekly__grid">{(['claude','codex','agy'] as const).map(provider=>{
   const row=items.find(i=>i.provider===provider),state=row?weeklyUsageState(row):'unavailable',displayState=row&&codexWeeklyUsageNoDataState(row)==='stale'?'stale':state;
   const detail=row?.buckets.map(b=>`${b.label}: ${b.remainingPercent}% 남음 · ${weeklyLimitResetLabel(b.resetsAt)||'초기화 시각 미제공'}`).join('\n')??'';
   return <div className="az-weekly__item" data-provider={provider} data-state={displayState} key={provider} title={[detail,row?.checkedAt?`확인: ${new Date(row.checkedAt).toLocaleString()}`:'',provider!=='codex'?'CLI 상태줄에서 사용량만 읽습니다. 기존 상태줄 출력은 유지합니다. 연결 후 다음 CLI 활동부터 갱신됩니다.':'이 기기의 Codex CLI 계정 한도입니다. 열린 세션의 계정과 다를 수 있습니다.'].filter(Boolean).join('\n')}>
    <strong>{names[provider]}</strong><DockWeeklyUsageFigure row={row} provider={provider} itemsLoaded={items.length>0}/>
    {provider!=='codex'&&row&&(row.connected?<button type="button" disabled={busy} onClick={()=>void connect(row,'disconnect')}>연결 해제</button>:row.canConnect?<button type="button" disabled={busy} onClick={()=>void connect(row,'connect')}>사용량 연결</button>:<small>연결 미지원</small>)}
   </div>;
  })}</div>
  {push&&<div className="az-weekly__push" data-testid="dock-weekly-push" data-enabled={push.enabled?'true':'false'}>
   <label title={`${WEEKLY_USAGE_PUSH_COPY.explain}\n${WEEKLY_USAGE_PUSH_COPY.requirement}`}>
    <input type="checkbox" checked={push.enabled} disabled={pushBusy} aria-describedby="az-weekly-push-shared" data-testid="dock-weekly-push-toggle"
     onChange={event=>void switchPush(event.currentTarget.checked)}/>
    <span>{WEEKLY_USAGE_PUSH_COPY.label} <small>{WEEKLY_USAGE_PUSH_COPY.short}</small></span>
   </label>
   {push.enabled&&<small data-testid="dock-weekly-push-note">{weeklyUsagePushNote(push)}</small>}
   <small id="az-weekly-push-shared">{WEEKLY_USAGE_PUSH_COPY.shared}</small>
  </div>}
  {error&&<small role="status" className="az-sessions__error">{error}</small>}
 </section>;
}
