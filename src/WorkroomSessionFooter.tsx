import React,{useEffect,useRef,useState} from 'react';
import {ErrorVocActions} from './RemoteVocComposer';
import type {AiTerminalSummary} from './aiTerminalProtocol';
import {normalizeMobileWorkspaceResult,type MobileWorkspaceRequest,type MobileWorkspaceResult} from './mobileWorkspaceProtocol';
import type {WorkroomSessionStatus} from './workroomSessionStatus';
import type {WorkroomCliInfo} from './workroomCliCommands';
import {pickWeeklyLimit,weeklyLimitResetLabel,type WorkroomWeeklyLimit} from './workroomWeeklyLimit';
import {isTauri} from './lib/env';
export type WorkroomTransport=(request:MobileWorkspaceRequest)=>Promise<MobileWorkspaceResult>;
export function WorkroomSessionFooter({session,visible,transport,contextUsed,scope,onClose,onPause,onReturnFocus,cliInfo={},modelCommands=[],onCommand,usageReadable=false}:{usageReadable?:boolean;session:AiTerminalSummary;visible:boolean;transport:WorkroomTransport;contextUsed:number|null;scope:string;cliInfo?:WorkroomCliInfo;modelCommands?:readonly {command:string;label:string}[];onCommand?:(command:string)=>void;onReturnFocus?:()=>void;onClose:(policy:'skip'|'saved',requestId?:string)=>Promise<void>;onPause:(paused:boolean)=>void}) {
 const key='agentstoz-workroom-save:'+scope+':'+session.id;
 const [receipt,setReceipt]=useState<string>(()=>{try{return sessionStorage.getItem(key)??''}catch{return ''}});
 const [status,setStatus]=useState<WorkroomSessionStatus|null>(null),[error,setError]=useState(''),[dialog,setDialog]=useState(false),[busy,setBusy]=useState(false);
 const [closeError,setCloseError]=useState(''),[contextOpen,setContextOpen]=useState(false),[checkNotice,setCheckNotice]=useState('');
 const modal=useRef<HTMLDialogElement>(null);
 // Codex's weekly allowance from the Mac's own account endpoint (server-cached). Claude's
 // `/usage` launches a CLI per read, so it is not polled here. A phone cannot reach this API.
 const [weekly,setWeekly]=useState<WorkroomWeeklyLimit|null>(null);
 useEffect(()=>{
  if(!visible||!usageReadable||session.agent!=='codex')return;let stopped=false;
  const read=()=>fetch(`${isTauri()?'http://127.0.0.1:3001':''}/api/ai-usage/codex`).then(r=>r.ok?r.json():null).then(j=>{if(!stopped)setWeekly(pickWeeklyLimit(j?.rateLimits))}).catch(()=>{});
  void read();const timer=setInterval(()=>{if(!document.hidden)void read()},5*60_000);
  return()=>{stopped=true;clearInterval(timer)};
 },[visible,usageReadable,session.agent]);
 useEffect(()=>{if(dialog&&!modal.current?.open)modal.current?.showModal()},[dialog]);
 const alive=useRef(true),flight=useRef(false),intent=useRef(false),closing=useRef(false),saveFlight=useRef(false);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;intent.current=false;onPause(false)}},[onPause]);
 const accept=(r:MobileWorkspaceResult)=>{
  const result=normalizeMobileWorkspaceResult(r).workroom;
  if(!result||result.sessionId!==session.id)throw new Error('현재 세션의 저장 상태를 확인하지 못했습니다.');
  if(alive.current){setStatus(result);setError('');}return result;
 };
 const finish=async(s:WorkroomSessionStatus,id:string)=>{
  if(!alive.current||!intent.current||closing.current)return;
  if(s.save.requestId!==id||!s.save.localSaved)return;
  closing.current=true;intent.current=false;
  try{await onClose('saved',id)}catch(e){if(alive.current)setCloseError(e instanceof Error?e.message:String(e))}
  finally{closing.current=false;if(alive.current){setBusy(false);onPause(false)}}
 };
 const refresh=async()=>{
  if(flight.current||saveFlight.current)return;flight.current=true;
  try{
   const r=await transport({operation:'workspace',requestId:crypto.randomUUID(),targetId:session.targetId,workspace:{action:'workroom.status',sessionId:session.id,...(receipt?{saveRequestId:receipt}:{})}});
   const s=accept(r);if(receipt)await finish(s,receipt);
   if(s.save.state!=='saving'&&!s.save.localSaved&&intent.current){intent.current=false;setBusy(false);onPause(false);}
  }catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e))}finally{flight.current=false;if(alive.current)setCheckNotice('')}
 };
 // `refresh` returns early while a request is in flight, so the button looked dead exactly when
 // someone presses it — during a save. Say what it is waiting for instead of doing nothing.
 const checkStatus=()=>{
  if(flight.current||saveFlight.current){setCheckNotice('저장 요청이 진행 중입니다. 결과가 오면 이 자리에 표시됩니다.');return;}
  setCheckNotice('');void refresh();
 };
 useEffect(()=>{if(!visible)return;void refresh();const timer=setInterval(()=>void refresh(),receipt&&(!status||status.save.requestId!==receipt||status.save.state==='saving'||status.save.state==='unconfirmed')?3000:15000);return()=>clearInterval(timer)},[visible,receipt,transport,status?.save.state]);
 const save=async(exit:boolean)=>{
  if(saveFlight.current||busy)return;
  // Never issue another attempt while an earlier request is uncertain.
  const retryUnadmitted=!!receipt&&status?.save.state==='not-admitted'&&status.save.requestId===null;
  if(receipt&&!retryUnadmitted&&(!status||status.save.requestId!==receipt||status.save.state==='saving'||status.save.state==='unconfirmed'||status.save.state==='recovery-required')){setError('이전 저장 결과를 먼저 확인하세요.');return;}
  // A missing host admission is safe to retry only with the original ID. If the
  // first request arrives late, the durable job ledger deduplicates both calls.
  const id=retryUnadmitted?receipt:crypto.randomUUID();saveFlight.current=true;setBusy(true);intent.current=exit;if(exit)onPause(true);setError('');setCloseError('');
  try{sessionStorage.setItem(key,id)}catch{/* The live component still fences retries. */}
  setReceipt(id);
  try{
   const s=accept(await transport({operation:'workspace',requestId:id,targetId:session.targetId,workspace:{action:'workroom.save',sessionId:session.id}}));
   await finish(s,id);
   if(s.save.state!=='saving'&&!s.save.localSaved){intent.current=false;onPause(false);}
  }catch(e){if(alive.current)setError((e instanceof Error?e.message:String(e))+' 저장 상태를 확인하기 전 다시 실행하지 않습니다.');}
  finally{saveFlight.current=false;if(alive.current)setBusy(false)}
 };
 const cancel=()=>{intent.current=false;setDialog(false);onPause(false)};
 const unavailable=!!error||!status?.initialized;
 const waiting=busy||!!receipt&&(!status||status.save.requestId!==receipt&&status.save.state!=='not-admitted'||['saving','unconfirmed','recovery-required'].includes(status.save.state));
 const percent=session.agent==='codex'?contextUsed:status?.context.usedPercent??null;
 const rounded=percent===null?null:Math.round(percent*10)/10;
 const level=percent===null?'unknown':percent>=90?'danger':percent>=70?'warn':'ok';
 const contextDetail=percent!==null
  ?`사용 ${rounded}% · 남음 ${Math.round((100-percent)*10)/10}% · ${session.agent==='codex'?'Codex CLI 하단 Context 표시를 읽은 값':`Claude statusline 측정${status?.context.observedAt?' · '+new Date(status.context.observedAt).toLocaleTimeString():''}`}${level==='danger'?' · 곧 가득 찹니다. 지금 저장 후 새 세션을 권합니다.':level==='warn'?' · 여유가 줄고 있습니다.':''}`
  :session.agent==='codex'?'Codex CLI 하단의 Context 표시를 아직 읽지 못했습니다. 첫 응답 뒤 표시됩니다.'
  :session.agent==='claude'?'이 세션의 Claude statusline 측정이 아직 없습니다. 첫 응답 뒤 표시되며, AI 사용량의 컨텍스트 캡처가 설치되어 있어야 합니다.'
  :`${session.agent==='hermes'?'Hermes':'Antigravity'}는 컨텍스트 사용량을 밖으로 내보내지 않아 추정하지 않습니다.`;
 return <footer className="workroom-session-footer" data-testid="workroom-session-footer">
  <div className="workroom-session-metrics"><button type="button" className="workroom-context-usage" data-testid="workroom-context-usage" data-level={level} aria-expanded={contextOpen} onClick={()=>{setContextOpen(open=>!open);onReturnFocus?.()}}><span>컨텍스트 {percent===null?'확인 불가':`${rounded}% 사용`}</span>{percent!==null&&<span className="workroom-context-meter" aria-hidden="true"><span style={{width:`${Math.min(100,percent)}%`}}/></span>}</button>{weekly&&<span className="workroom-weekly-limit" data-testid="workroom-weekly-limit" data-level={weekly.usedPercent>=90?'danger':weekly.usedPercent>=70?'warn':'ok'} title={`Codex 구독 주간 한도 · 사용 ${weekly.usedPercent}%${weeklyLimitResetLabel(weekly.resetsAt)?' · '+weeklyLimitResetLabel(weekly.resetsAt):''}`}>주간 한도 <strong>{weekly.remainingPercent}% 남음</strong></span>}{(cliInfo.model||cliInfo.effort)&&<span className="workroom-cli-info" data-testid="workroom-cli-info" title="터미널 화면에 표시된 값입니다.">{cliInfo.model&&<>모델 <strong>{cliInfo.model}</strong></>}{cliInfo.model&&cliInfo.effort&&' · '}{cliInfo.effort&&<>에포트 <strong>{cliInfo.effort}</strong></>}</span>}{session.state==='running'&&onCommand&&modelCommands.map(c=><button type="button" key={c.command} className="ai-terminal-btn workroom-model-command" data-testid={`workroom-model-command-${c.command.slice(1)}`} title={`${c.command} 선택 화면을 엽니다. ←/→·↑/↓·번호로 고른 뒤 Enter(기본값으로 저장) 또는 s(이 세션만), 취소는 Esc. AI가 작업 중이면 그 작업이 끝난 뒤 열립니다.`} onClick={()=>onCommand(c.command)}>{c.label}</button>)}<span>마지막 기억 저장 {status?.lastSavedAt?new Date(status.lastSavedAt).toLocaleString():'확인된 기록 없음'}</span></div>
  {contextOpen&&<p className="workroom-context-details" data-testid="workroom-context-details">{contextDetail}</p>}
  {status?.save.message&&<p role="status">{status.save.message}</p>}
  {checkNotice&&<p role="status" data-testid="workroom-save-check-notice">{checkNotice}</p>}
  {(error||closeError)&&!dialog&&<p role="alert">{closeError||error}<ErrorVocActions message={closeError||error} surface="workroom-session"/></p>}
  {status&&!status.initialized&&<p>프로젝트의 장기기억을 먼저 초기화하세요.</p>}
  <div className="workroom-session-actions"><button className="ai-terminal-btn" disabled={unavailable||waiting} onClick={()=>{void save(false);onReturnFocus?.()}}>{status?.save.state==='not-admitted'?'같은 요청으로 저장 재시도':'지금 저장'}</button><button className="ai-terminal-btn" data-testid="workroom-save-check" onClick={()=>{checkStatus();onReturnFocus?.()}}>저장 상태 확인</button><button className="ai-terminal-btn ai-terminal-btn--danger" disabled={session.state!=='running'||busy} onClick={()=>setDialog(true)}>세션 종료</button></div>
  {dialog&&<dialog ref={modal} aria-label="세션 종료 전 저장" className="workroom-exit-dialog" onCancel={cancel}><h3>세션을 기억하고 종료할까요?</h3><p>저장 완료를 확인한 뒤 CLI를 종료합니다. 진행 중인 AI 작업은 먼저 완료한 뒤 저장하세요. 백업 결과는 로컬 저장과 별도로 표시됩니다.</p>{status?.save.message&&<p role="status">{status.save.message}</p>}{(error||closeError)&&<p role="alert">{closeError||error}<ErrorVocActions message={closeError||error} surface="workroom-session"/></p>}{waiting&&<p>요청한 저장은 취소하거나 화면을 이동해도 계속됩니다.</p>}<div className="workroom-session-actions"><button autoFocus className="ai-terminal-btn" disabled={unavailable||waiting} onClick={()=>void save(true)}>저장하고 종료</button><button className="ai-terminal-btn" disabled={busy||closing.current} onClick={async()=>{if(closing.current)return;closing.current=true;intent.current=false;setBusy(true);try{await onClose('skip')}catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e))}finally{closing.current=false;if(alive.current)setBusy(false)}}}>저장 없이 종료</button><button className="ai-terminal-btn" onClick={cancel}>취소</button></div></dialog>}
 </footer>;
}
