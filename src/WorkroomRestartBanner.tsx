import React,{useCallback,useEffect,useRef,useState} from 'react';
import {RotateCcw} from 'lucide-react';
import {aiTerminalAgentLabel} from './aiTerminalAgentLabel';
import {workroomRestartRunnable,type WorkroomRestartOffer,type WorkroomRestartRow} from './workroomConversationProtocol';
import {resumeRestartRows} from './workroomRestartBatch';
import {localWorkroomRestart,type WorkroomRestartSource} from './workroomRestartClient';
import {WORKROOM_RESTART_CONFIRM_GUARD_MS,RESTART_AVAILABILITY_PHRASE,RESTART_BYPASS_LINE,RESTART_DISMISS_HINT,RESTART_OFFER_NONE_SENTENCE,RESTART_OFFER_SENTENCE,RESTART_ROW_BYPASS,
  RESTART_SETTLE_DONE,RESTART_SETTLE_WARNING,restartBatchSummary,restartConfirmOneText,restartConfirmText,restartOfferTitle,restartProgressText,restartRowLabeler,restartRowStarted} from './workroomRestartText';
import './WorkroomRestartBanner.css';

interface Props {
  visible:boolean;
  projects?:readonly {targetId:string;label:string}[];
  source?:WorkroomRestartSource;
  /** After any reopen: the directory and the pop-out refresh their own session lists. Nothing opens a window. */
  onResumed?:(sessionIds:string[])=>void;
}
type Armed={kind:'all'}|{kind:'one';row:WorkroomRestartRow}|{kind:'settle';row:WorkroomRestartRow};
/** The button that armed a confirmation, so 「취소」 hands focus back to it (never to whatever now sits where it was). */
const armKey=(armed:Armed)=>armed.kind==='all'?'all':`${armed.kind}:${armed.row.id}`;

/**
 * 「업데이트 전 실행 중이던 작업 세션 N개 이어 열기」 (w14). Explicit: a person presses, and every reopen goes through the
 * existing review → execute → status path one row at a time. Fetched on mount, when the window comes back and after
 * each action — never on a timer. A sidecar that does not know the operation simply shows nothing.
 *
 * Every reopen — the batch and one row — is armed first and confirmed in its own block (500 ms guard). The confirmation
 * and the buttons it replaces are different elements (keyed), so a held or repeated Enter on 「취소」 never lands on the
 * 「닫기」 that takes its place, and focus moves into the confirmation and back to the button that armed it (w14 review).
 */
export function WorkroomRestartBanner({visible,projects=[],source=localWorkroomRestart,onResumed}:Props){
  const [offer,setOffer]=useState<WorkroomRestartOffer|null>(null),[store,setStore]=useState('');
  const [expanded,setExpanded]=useState(false),[armed,setArmed]=useState<Armed|null>(null);
  const [progress,setProgress]=useState<{done:number;total:number}|null>(null);
  const [summary,setSummary]=useState(''),[notice,setNotice]=useState('');
  const busy=useRef(false),armedAt=useRef(0),mounted=useRef(true),generation=useRef(0);
  const confirmText=useRef<HTMLParagraphElement|null>(null),armButtons=useRef(new Map<string,HTMLButtonElement>()),refocus=useRef<string|null>(null);
  const onResumedRef=useRef(onResumed);onResumedRef.current=onResumed;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;};},[]);
  useEffect(()=>{
    if(armed){confirmText.current?.focus();return;}
    const key=refocus.current;refocus.current=null;
    if(key)armButtons.current.get(key)?.focus();
  },[armed]);
  const load=useCallback(async()=>{
    const token=++generation.current;
    try{const listed=await source.list();if(!mounted.current||token!==generation.current)return;setStore(listed.storeInstanceId);setOffer(listed.offer);
      if(!listed.offer)setArmed(null);
      else if(!listed.offer.rows.some(row=>workroomRestartRunnable(row.availability)))setExpanded(true);}
    catch{/* An older sidecar refuses the operation, or the store is unavailable: no banner, no error line. */}
  },[source]);
  useEffect(()=>{
    if(!visible)return;
    void load();
    const again=()=>{if(document.visibilityState!=='hidden')void load();};
    document.addEventListener('visibilitychange',again);window.addEventListener('focus',again);
    return()=>{document.removeEventListener('visibilitychange',again);window.removeEventListener('focus',again);};
  },[visible,load]);
  const rows=offer?.rows??[];
  // A row's header is its name; its start time is on the line under it. Confirmations and summaries name a row alone,
  // so there two of one project and AI carry the time in the name (`label`).
  const name=(row:WorkroomRestartRow)=>row.title||`${projects.find(project=>project.targetId===row.targetId)?.label??'등록 해제된 프로젝트'} · ${aiTerminalAgentLabel(row.agent)}`;
  const label=restartRowLabeler(rows,name);
  const runnable=rows.filter(row=>workroomRestartRunnable(row.availability));
  const arm=(next:Armed)=>{if(busy.current)return;armedAt.current=Date.now();setArmed(next);setNotice('');};
  const cancel=()=>{if(armed)refocus.current=armKey(armed);setArmed(null);};
  const keep=(key:string)=>(element:HTMLButtonElement|null)=>{if(element)armButtons.current.set(key,element);else armButtons.current.delete(key);};
  /** A press on a confirmation armed less than 500 ms ago is the second half of a double click: ignored. */
  const confirmed=()=>Date.now()-armedAt.current>=WORKROOM_RESTART_CONFIRM_GUARD_MS;
  const run=async(chosen:readonly WorkroomRestartRow[])=>{
    if(busy.current||!chosen.length||!store)return;busy.current=true;setArmed(null);setSummary('');setNotice('');setProgress({done:0,total:chosen.length});
    try{
      const result=await resumeRestartRows(chosen,source.batch(store),(done,total)=>{if(mounted.current)setProgress({done,total});});
      if(mounted.current)setSummary(restartBatchSummary(result,label));
      const opened=result.opened.flatMap(item=>item.sessionId?[item.sessionId]:[]);
      if(opened.length||result.opened.length)onResumedRef.current?.(opened);
    }finally{busy.current=false;if(mounted.current){setProgress(null);void load();}}
  };
  const settle=async(row:WorkroomRestartRow)=>{
    if(busy.current||!store)return;busy.current=true;setArmed(null);
    try{await source.settle(store,row);if(mounted.current)setNotice(RESTART_SETTLE_DONE);}
    catch(error){if(mounted.current)setNotice(error instanceof Error?error.message:String(error));}
    finally{busy.current=false;if(mounted.current)void load();}
  };
  const check=async(row:WorkroomRestartRow)=>{
    const receipt=source.pending(store,row.id);if(!receipt||busy.current)return;busy.current=true;
    try{
      const state=await source.status(receipt);
      if(mounted.current)setNotice(state==='completed'?`${label(row)}: 같은 대화를 이어 열었습니다.`:state==='rejected'?`${label(row)}: CLI를 실행하기 전에 중단됐습니다. 다시 이어 열 수 있습니다.`
        :state==='not-recorded'?`${label(row)}: 이 요청의 실행 기록이 없습니다. 목록을 다시 확인하세요.`:`${label(row)}: 결과를 아직 확인하지 못했습니다. 요청을 다시 보내지 않았습니다.`);
      if(state==='completed')onResumedRef.current?.([]);
    }catch(error){if(mounted.current)setNotice(error instanceof Error?error.message:String(error));}
    finally{busy.current=false;if(mounted.current)void load();}
  };
  const dismiss=async()=>{
    if(!offer||busy.current||!store)return;busy.current=true;
    // The answer is what is current afterwards: usually nothing; rows nobody closed (a newer restart) stay listed.
    try{const next=await source.dismiss(store,offer);if(mounted.current){setOffer(next);setArmed(null);setSummary('');}}
    catch(error){if(mounted.current)setNotice(error instanceof Error?error.message:String(error));}
    finally{busy.current=false;}
  };
  if(!offer&&!summary&&!notice)return null;
  const bypassLine=rows.some(row=>row.bypass!==false);
  const openArmed=armed&&armed.kind!=='settle'?armed:null;
  return <section className="workroom-restart-banner" data-testid="workroom-restart-banner" data-help-key="workroom-restart" aria-label="재시작 전 작업 세션 이어 열기">
    {offer&&<>
      <div className="workroom-restart-head"><RotateCcw size={16} aria-hidden="true"/><strong data-testid="workroom-restart-title">{restartOfferTitle(rows.length,offer.update)}</strong></div>
      <p className="workroom-restart-text">{runnable.length?RESTART_OFFER_SENTENCE:RESTART_OFFER_NONE_SENTENCE}{bypassLine&&runnable.length?` ${RESTART_BYPASS_LINE}`:''}{offer.more?' 가장 최근 64개만 보입니다. 나머지는 저장된 대화에서 열 수 있습니다.':''}</p>
      {openArmed
        ?<div key="confirm" className="workroom-restart-confirm" role="group" aria-label="이어 열기 확인" data-testid="workroom-restart-confirm">
          <p ref={element=>{confirmText.current=element;}} tabIndex={-1}>{openArmed.kind==='all'?restartConfirmText(runnable.length):restartConfirmOneText(label(openArmed.row))}</p>
          <button type="button" className="workroom-restart-btn workroom-restart-btn--primary" data-testid="workroom-restart-confirm-open"
            onClick={()=>{if(confirmed())void run(openArmed.kind==='all'?runnable:[openArmed.row]);}}>이 Mac에서 열기</button>
          <button type="button" className="workroom-restart-btn" data-testid="workroom-restart-confirm-cancel" onClick={cancel}>취소</button>
        </div>
        :<div key="actions" className="workroom-restart-actions">
          {runnable.length>0&&<button type="button" ref={keep('all')} className="workroom-restart-btn workroom-restart-btn--primary" data-testid="workroom-restart-open-all" disabled={!!progress} onClick={()=>arm({kind:'all'})}>{runnable.length}개 이어 열기</button>}
          <button type="button" className="workroom-restart-btn" data-testid="workroom-restart-toggle" aria-expanded={expanded} onClick={()=>setExpanded(open=>!open)}>{expanded?'목록 접기':'목록'}</button>
          <button type="button" className="workroom-restart-btn" data-testid="workroom-restart-dismiss" title={RESTART_DISMISS_HINT} disabled={!!progress} onClick={()=>void dismiss()}>닫기</button>
          <span className="workroom-restart-hint">{RESTART_DISMISS_HINT}</span>
        </div>}
      {progress&&<p className="workroom-restart-text" role="status" data-testid="workroom-restart-progress">{restartProgressText(progress.done,progress.total)}</p>}
      {expanded&&<ul className="workroom-restart-rows" data-testid="workroom-restart-rows">{rows.map(row=>{
        const settleArmed=armed?.kind==='settle'&&armed.row.id===row.id,receipt=row.availability==='pending'?source.pending(store,row.id):null;
        const started=restartRowStarted(row.createdAt);
        return <li key={row.id} data-testid="workroom-restart-row" data-conversation-id={row.id} data-availability={row.availability}>
          <div className="workroom-restart-row-text"><strong>{name(row)}</strong>
            <small>{started?`${started} · `:''}{RESTART_AVAILABILITY_PHRASE[row.availability]}{row.bypass?` · ${RESTART_ROW_BYPASS}`:''}</small></div>
          <div className="workroom-restart-row-actions">
            {workroomRestartRunnable(row.availability)&&<button type="button" ref={keep(`one:${row.id}`)} className="workroom-restart-btn" data-testid="workroom-restart-row-open" disabled={!!progress||!!openArmed} onClick={()=>arm({kind:'one',row})}>이어 열기</button>}
            {receipt&&<button type="button" className="workroom-restart-btn" data-testid="workroom-restart-row-check" disabled={!!progress} onClick={()=>void check(row)}>결과 확인</button>}
            {row.availability==='pending'&&!settleArmed&&<button type="button" ref={keep(`settle:${row.id}`)} className="workroom-restart-btn" data-testid="workroom-restart-row-settle" disabled={!!progress} onClick={()=>arm({kind:'settle',row})}>확인했음</button>}
          </div>
          {settleArmed&&<div key="settle-confirm" className="workroom-restart-confirm" role="group" aria-label="열려 있지 않음 확인" data-testid="workroom-restart-settle-confirm">
            <p ref={element=>{confirmText.current=element;}} tabIndex={-1}>{RESTART_SETTLE_WARNING}</p>
            <button type="button" className="workroom-restart-btn workroom-restart-btn--primary" data-testid="workroom-restart-settle-yes" onClick={()=>{if(confirmed())void settle(row);}}>세션 목록에서 열려 있지 않은 것을 확인했음</button>
            <button type="button" className="workroom-restart-btn" data-testid="workroom-restart-settle-cancel" onClick={cancel}>취소</button>
          </div>}
        </li>;})}</ul>}
    </>}
    {summary&&<p className="workroom-restart-text" role="status" data-testid="workroom-restart-summary">{summary}</p>}
    {notice&&<p className="workroom-restart-text" role="status" data-testid="workroom-restart-notice">{notice}</p>}
    {!offer&&<div className="workroom-restart-actions"><button type="button" className="workroom-restart-btn" data-testid="workroom-restart-summary-close" onClick={()=>{setSummary('');setNotice('');}}>알림 닫기</button></div>}
  </section>;
}
