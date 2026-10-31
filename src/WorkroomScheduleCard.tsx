import {useCallback,useEffect,useRef,useState} from 'react';
import {requestWorkroomSchedule,type WorkroomScheduleRequester,type WorkroomScheduleResult} from './workroomScheduleClient';
import type {WorkroomScheduleRequest,WorkroomScheduleState,WorkroomScheduleRunState} from './workroomScheduleProtocol';
const stateNames:Record<WorkroomScheduleState,string>={active:'예약 켜짐',paused:'일시정지',stopped:'종료',expired:'기한 만료',finished:'횟수 완료', 'needs-human':'확인 필요'};
const runNames:Record<WorkroomScheduleRunState,string>={dispatching:'전송 준비',submitted:'AI 결과 대기',completed:'응답 완료',unknown:'결과 확인 필요',failed:'실행 종료',reviewed:'사용자 확인 완료'};
const date=(t:number)=>new Date(t).toLocaleString();
const localDate=(t:number)=>{const d=new Date(t);return new Date(t-d.getTimezoneOffset()*60_000).toISOString().slice(0,16);};
const button='min-h-11 rounded-lg border border-[var(--line)] px-3 text-sm';
const field='mt-1 min-h-11 w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-base';
export function WorkroomScheduleCard({sessionId,visible,onOpen,request=requestWorkroomSchedule}:{sessionId:string;visible:boolean;onOpen:(id:string)=>void;request?:WorkroomScheduleRequester}){
  const [state,setState]=useState<WorkroomScheduleResult|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[open,setOpen]=useState(false);
  const [title,setTitle]=useState(''),[prompt,setPrompt]=useState(''),[mode,setMode]=useState<'continue'|'new-conversation'>('continue');
  const [next,setNext]=useState(()=>localDate(Date.now()+3600_000)),[end,setEnd]=useState(()=>localDate(Date.now()+86400_000));
  const [minutes,setMinutes]=useState('0'),[limit,setLimit]=useState('1'),[consent,setConsent]=useState(false),[autoRestore,setAutoRestore]=useState(false),[review,setReview]=useState('');
  const epoch=useRef(0),pending=useRef(false),createId=useRef(crypto.randomUUID());
  const refresh=useCallback(async()=>{
    if(pending.current||!visible||document.visibilityState==='hidden')return;const generation=epoch.current;pending.current=true;
    try{const value=await request({operation:'list',sessionId});if(generation===epoch.current){setState(value);setError('');}}
    catch(e){if(generation===epoch.current)setError(e instanceof Error?e.message:'예약을 확인하지 못했습니다.');}
    finally{if(generation===epoch.current)pending.current=false;}
  },[sessionId,visible,request]);
  useEffect(()=>{epoch.current++;pending.current=false;setState(null);setError('');setBusy(false);setOpen(false);setConsent(false);setAutoRestore(false);createId.current=crypto.randomUUID();void refresh();return()=>{epoch.current++;};},[refresh]);
  useEffect(()=>{if(autoRestore&&(!state?.snapshot?.canRestore||mode!=='continue')){setAutoRestore(false);createId.current=crypto.randomUUID();}},[autoRestore,mode,state?.snapshot?.canRestore]);
  const hasActive=state?.schedules?.some(s=>s.state==='active')||state?.runs?.some(r=>r.state==='submitted'||r.state==='dispatching');
  useEffect(()=>{if(!visible||!hasActive)return;const timer=setInterval(()=>{void refresh();},15000);const wake=()=>{void refresh();};document.addEventListener('visibilitychange',wake);return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',wake);};},[visible,hasActive,refresh]);
  const run=async(body:WorkroomScheduleRequest)=>{
    if(pending.current||busy)return;const generation=epoch.current;pending.current=true;setBusy(true);setError('');
    try{await request(body);if(generation!==epoch.current)return;if(body.operation==='create'){setOpen(false);setConsent(false);setAutoRestore(false);createId.current=crypto.randomUUID();}if(body.operation==='review')setReview('');}
    catch(e){if(generation===epoch.current)setError(e instanceof Error?e.message:'예약 요청 결과를 확인하세요. 같은 실행은 자동으로 다시 보내지 않습니다.');}
    finally{if(generation===epoch.current){pending.current=false;setBusy(false);void refresh();}}
  };
  return <section data-testid="workroom-schedule-card" className="my-2 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-3 text-[var(--ink)]" aria-label="워크룸 예약 재개">
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-semibold">예약 재개{state?.schedules?.length?` · ${state.schedules.length}개`:''}</span><div className="flex gap-2"><button type="button" className={button} onClick={()=>void refresh()} disabled={busy}>새로 고침</button><button type="button" className={button} aria-expanded={open} disabled={busy||!state?.enabled||!state.snapshot} onClick={()=>setOpen(v=>!v)}>예약 만들기</button></div></div>
    {(open||!!state?.schedules?.length)&&<p className="mt-2 text-sm text-[var(--text-muted)]">이 Mac과 AgentsToZ가 켜져 있어야 실행됩니다. 작업·입력·승인 대기 중에는 보내지 않습니다. 일시정지·종료는 진행 중인 AI 작업을 취소하지 않습니다.</p>}
    {state?.problem&&<p className="mt-2 text-sm" role="status">{state.problem}</p>}{state&&!state.enabled&&<p className="mt-2 text-sm">설치된 실행 호스트에서 예약을 켤 수 있습니다.</p>}
    {error&&<p className="mt-2 text-sm" role="alert">{error}</p>}
    {open&&state?.snapshot&&<form className="mt-3 grid gap-3" onSubmit={event=>{event.preventDefault();void run({operation:'create',id:createId.current,sessionId,title,prompt,mode,nextAt:new Date(next).getTime(),intervalMs:Number(minutes)*60000,expiresAt:new Date(end).getTime(),maxRuns:Number(minutes)===0?1:Number(limit),consent:true,...(autoRestore&&mode==='continue'&&state.snapshot?.canRestore?{autoRestore:true as const}:{})});}}>
      <p className="text-sm">대상: {state.snapshot.binding.agent} · {state.snapshot.binding.model||'모델 확인 필요'} · {state.snapshot.binding.accountId} · {state.snapshot.binding.bypass?'기존 워크룸은 승인 우회 모드':'일반 승인 모드'}</p>
      <label className="text-sm">예약 이름<input className={field} value={title} onChange={e=>{setTitle(e.target.value);createId.current=crypto.randomUUID();}} required maxLength={100}/></label>
      <label className="text-sm">예약할 작업<textarea className={field} rows={3} value={prompt} onChange={e=>{setPrompt(e.target.value);createId.current=crypto.randomUUID();}} required/></label>
      <label className="text-sm">실행 위치<select className={field} value={mode} onChange={e=>{setMode(e.target.value as typeof mode);setAutoRestore(false);createId.current=crypto.randomUUID();}}><option value="continue">이 대화 이어가기</option><option value="new-conversation" disabled={!state.snapshot.canStartNew}>매번 별도 새 대화 · 일반 승인 모드</option></select></label>
      {mode==='continue'&&state.snapshot.canRestore&&<div><label className="flex min-h-11 items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={autoRestore} onChange={e=>{setAutoRestore(e.target.checked);createId.current=crypto.randomUUID();}}/>종료된 이 대화의 자동 복원을 허용합니다.</label><p className="text-sm text-[var(--text-muted)]">호스트를 다시 시작한 뒤 원래 대화를 증명할 수 없으면 예약이 중단될 수 있습니다.</p></div>}
      <div className="grid gap-3 sm:grid-cols-2"><label className="min-w-0 text-sm">다음 실행<input type="datetime-local" className={field} value={next} onChange={e=>{setNext(e.target.value);createId.current=crypto.randomUUID();}} required/></label><label className="min-w-0 text-sm">종료 시각<input type="datetime-local" className={field} value={end} onChange={e=>{setEnd(e.target.value);createId.current=crypto.randomUUID();}} required/></label></div>
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">반복 간격(분, 0이면 한 번)<input type="number" min="0" max="10080" className={field} value={minutes} onChange={e=>{setMinutes(e.target.value);createId.current=crypto.randomUUID();}} required/></label>{Number(minutes)>0&&<label className="text-sm">최대 실행 횟수<input type="number" min="1" max="100" className={field} value={limit} onChange={e=>{setLimit(e.target.value);createId.current=crypto.randomUUID();}} required/></label>}</div>
      <p className="text-sm text-[var(--text-muted)]">최대 30일, 예약별 24시간에 8회까지 실행합니다. Mac이 잠들어 놓친 실행은 한 번으로 합칩니다. 터미널·계정·모델이 바뀌면 다시 확인해야 합니다.</p>
      <label className="flex min-h-11 items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={consent} onChange={e=>setConsent(e.target.checked)}/>이 대상과 작업을 지정한 시각·횟수 안에서 실행하도록 허용합니다.</label>
      <button type="submit" className={button} disabled={busy||!consent||!state.snapshot.binding.model}>예약 켜기</button>
    </form>}
    <div className="mt-3 space-y-2">{state?.schedules?.map(s=><details key={s.id} className="rounded-lg border border-[var(--line)] p-3"><summary className="cursor-pointer text-sm"><strong>{s.title}</strong> · {stateNames[s.state]} · {s.runCount}/{s.maxRuns}회{s.state==='active'?` · 다음 ${date(s.nextAt)}`:''}</summary>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm">{s.prompt}</p><p className="mt-2 text-sm" role="status">{s.reason}</p>
      <p className="mt-1 text-xs text-[var(--text-muted)]">{s.mode==='continue'?'같은 대화':'별도 새 대화'}{s.autoRestore?' · 종료된 대화 자동 복원 허용':''} · 종료 {date(s.expiresAt)}</p>
      <div className="mt-2 flex flex-wrap gap-2"><button type="button" className={button} onClick={()=>onOpen(s.currentSessionId||s.binding.sessionId)}>대화 열기</button>
        {s.state==='active'?<><button type="button" className={button} disabled={busy} onClick={()=>void run({operation:'run-now',id:s.id,expectedRevision:s.revision,requestId:crypto.randomUUID()})}>지금 실행</button><button type="button" className={button} disabled={busy} onClick={()=>void run({operation:'pause',id:s.id,expectedRevision:s.revision})}>일시정지</button></>:['paused','needs-human'].includes(s.state)&&<button type="button" className={button} disabled={busy} onClick={()=>void run({operation:'resume',id:s.id,expectedRevision:s.revision,consent:true})}>확인 후 다시 켜기</button>}
        {!['stopped','expired','finished'].includes(s.state)&&<button type="button" className={button} disabled={busy} onClick={()=>void run({operation:'stop',id:s.id,expectedRevision:s.revision})}>예약 종료</button>}
      </div>
      <ol className="mt-3 space-y-2 text-sm" aria-label={`${s.title} 실행 기록`}>{state.runs?.filter(r=>r.scheduleId===s.id).map(r=><li key={r.id} className="rounded-lg border border-[var(--line)] p-2"><p>{date(r.startedAt)} · {runNames[r.state]}</p><p>{r.reason}</p><button type="button" className={button+' mt-2'} onClick={()=>onOpen(r.sessionId)}>실행 대화 열기</button>{r.state==='unknown'&&<div className="mt-2"><label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={review===r.id} onChange={e=>setReview(e.target.checked?r.id:'')}/>실제 작업 결과를 확인했습니다. 이 실행은 다시 보내지 않습니다.</label><button type="button" className={button} disabled={busy||review!==r.id} onClick={()=>void run({operation:'review',runId:r.id,confirmed:true})}>결과 확인 완료</button></div>}</li>)}</ol>
    </details>)}</div>
  </section>;
}
