import React,{useEffect,useRef,useState} from 'react';
import type {AiTerminalSummary} from './aiTerminalProtocol';
import {normalizeMobileWorkspaceResult,type MobileWorkspaceRequest,type MobileWorkspaceResult} from './mobileWorkspaceProtocol';
import type {WorkroomSessionStatus} from './workroomSessionStatus';
export type WorkroomTransport=(request:MobileWorkspaceRequest)=>Promise<MobileWorkspaceResult>;
export function WorkroomSessionFooter({session,visible,transport,contextUsed,scope,onClose,onPause}:{session:AiTerminalSummary;visible:boolean;transport:WorkroomTransport;contextUsed:number|null;scope:string;onClose:(policy:'skip'|'saved',requestId?:string)=>Promise<void>;onPause:(paused:boolean)=>void}) {
 const key='agentstoz-workroom-save:'+scope+':'+session.id;
 const [receipt,setReceipt]=useState<string>(()=>{try{return sessionStorage.getItem(key)??''}catch{return ''}});
 const [status,setStatus]=useState<WorkroomSessionStatus|null>(null),[error,setError]=useState(''),[dialog,setDialog]=useState(false),[busy,setBusy]=useState(false);
 const [closeError,setCloseError]=useState('');
 const modal=useRef<HTMLDialogElement>(null);
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
  }catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e))}finally{flight.current=false}
 };
 useEffect(()=>{if(!visible)return;void refresh();const timer=setInterval(()=>void refresh(),receipt&&(!status||status.save.requestId!==receipt||status.save.state==='saving'||status.save.state==='unconfirmed')?3000:15000);return()=>clearInterval(timer)},[visible,receipt,transport,status?.save.state]);
 const save=async(exit:boolean)=>{
  if(saveFlight.current||busy)return;
  // Never issue another attempt while an earlier request is uncertain.
  if(receipt&&(!status||status.save.requestId!==receipt||status.save.state==='saving'||status.save.state==='unconfirmed'||status.save.state==='recovery-required')){setError('이전 저장 결과를 먼저 확인하세요.');return;}
  const id=crypto.randomUUID();saveFlight.current=true;setBusy(true);intent.current=exit;if(exit)onPause(true);setError('');setCloseError('');
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
 const waiting=busy||!!receipt&&(!status||status.save.requestId!==receipt||['saving','unconfirmed','recovery-required'].includes(status.save.state));
 const percent=session.agent==='codex'?contextUsed:status?.context.usedPercent??null;
 return <footer className="workroom-session-footer" data-testid="workroom-session-footer">
  <div className="workroom-session-metrics"><span>컨텍스트 사용 {percent===null?'확인 불가':`${Math.round(percent*10)/10}%`}{session.agent==='codex'&&percent!==null?' · CLI 표시':''}</span><span>마지막 기억 저장 {status?.lastSavedAt?new Date(status.lastSavedAt).toLocaleString():'확인된 기록 없음'}</span></div>
  {status?.save.message&&<p role="status">{status.save.message}</p>}
  {(error||closeError)&&!dialog&&<p role="alert">{closeError||error}</p>}
  {status&&!status.initialized&&<p>프로젝트의 장기기억을 먼저 초기화하세요.</p>}
  <div className="workroom-session-actions"><button className="ai-terminal-btn" disabled={unavailable||waiting} onClick={()=>void save(false)}>지금 저장</button><button className="ai-terminal-btn" onClick={()=>void refresh()}>저장 상태 확인</button><button className="ai-terminal-btn ai-terminal-btn--danger" disabled={session.state!=='running'||busy} onClick={()=>setDialog(true)}>세션 종료</button></div>
  {dialog&&<dialog ref={modal} aria-label="세션 종료 전 저장" className="workroom-exit-dialog" onCancel={cancel}><h3>세션을 기억하고 종료할까요?</h3><p>저장 완료를 확인한 뒤 CLI를 종료합니다. 진행 중인 AI 작업은 먼저 완료한 뒤 저장하세요. 백업 결과는 로컬 저장과 별도로 표시됩니다.</p>{status?.save.message&&<p role="status">{status.save.message}</p>}{(error||closeError)&&<p role="alert">{closeError||error}</p>}{waiting&&<p>요청한 저장은 취소하거나 화면을 이동해도 계속됩니다.</p>}<div className="workroom-session-actions"><button autoFocus className="ai-terminal-btn" disabled={unavailable||waiting} onClick={()=>void save(true)}>저장하고 종료</button><button className="ai-terminal-btn" disabled={busy||closing.current} onClick={async()=>{if(closing.current)return;closing.current=true;intent.current=false;setBusy(true);try{await onClose('skip')}catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e))}finally{closing.current=false;if(alive.current)setBusy(false)}}}>저장 없이 종료</button><button className="ai-terminal-btn" onClick={cancel}>취소</button></div></dialog>}
 </footer>;
}
