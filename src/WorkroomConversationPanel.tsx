import React,{useCallback,useEffect,useRef,useState} from 'react';
import type {AiTerminalSummary} from './aiTerminalProtocol';
import {requestWorkroomHistory,pendingWorkroomResumes,savePendingWorkroomResume,clearPendingWorkroomResume,type PendingWorkroomResume} from './workroomConversationClient';
import {WORKROOM_HISTORY_VERSION,WORKROOM_RESUME_UNSETTLED_REASON,type WorkroomConversation,type WorkroomHistoryResult,type WorkroomRestartAvailability} from './workroomConversationProtocol';
import {RESTART_AVAILABILITY_PHRASE,RESTART_SETTLE_DONE,RESTART_SETTLE_WARNING,WORKROOM_RESTART_CONFIRM_GUARD_MS} from './workroomRestartText';

/** What this Mac already knows cannot be opened (w14 review): said in one phrase instead of an 「이어 열기」 that only fails. */
const NOT_OPENABLE:ReadonlySet<WorkroomRestartAvailability>=new Set(['unsupported','unsaved','ambiguous','legacy','project-changed','account-changed','unprepared','open-elsewhere','in-flight']);

interface Props {
  visible:boolean;
  query:string;
  projects:{targetId:string;label:string}[];
  sessions:AiTerminalSummary[];
  onOpen:(session:AiTerminalSummary,title?:string)=>void|Promise<void>;
  /** The collapsed 「저장된 대화 N개」 line: this page's count, whether more pages exist, receipts awaiting a check. */
  onSummary?:(summary:{count:number;more:boolean;pending:number;loaded:boolean})=>void;
}
/** Local-only metadata. Listing never starts a CLI; a user's resume click reviews before executing. */
export function WorkroomConversationPanel(props:Props){
  const [records,setRecords]=useState<WorkroomConversation[]>([]),[store,setStore]=useState('');
  const [archived,setArchived]=useState(false),[before,setBefore]=useState<string|undefined>(),[cursors,setCursors]=useState<(string|undefined)[]>([]),[next,setNext]=useState<string|null>(null);
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[loaded,setLoaded]=useState(false);
  const [editing,setEditing]=useState(''),[title,setTitle]=useState('');
  const [review,setReview]=useState<{record:WorkroomConversation;value:NonNullable<WorkroomHistoryResult['review']>}|null>(null);
  const [receipts,setReceipts]=useState<PendingWorkroomResume[]>([]),[unrecorded,setUnrecorded]=useState('');
  const [settleArmed,setSettleArmed]=useState(0);
  const [availability,setAvailability]=useState<Record<string,WorkroomRestartAvailability>>({});
  const mounted=useRef(false),action=useRef(false),loading=useRef(false),generation=useRef(0),detailRefused=useRef(false);
  const propsRef=useRef(props);propsRef.current=props;
  useEffect(()=>{mounted.current=true;try{setReceipts(pendingWorkroomResumes(sessionStorage));}catch(e){setError(String(e));}return()=>{mounted.current=false;generation.current++;};},[]);
  const reload=useCallback(async()=>{
    if(loading.current)return;loading.current=true;const token=generation.current;
    const ask=(detail:boolean)=>requestWorkroomHistory({protocolVersion:WORKROOM_HISTORY_VERSION,operation:'list',archived,...(before?{before}:{}),...(detail?{detail:true as const}:{})});
    try{
      // `detail` (w14): rows say why they cannot be opened. An older sidecar refuses the flag: asked once, then plainly.
      let result:WorkroomHistoryResult;
      if(detailRefused.current)result=await ask(false);
      else try{result=await ask(true);}catch{result=await ask(false);detailRefused.current=true;}
      if(!result.records)throw new Error('대화 기록 목록을 확인하지 못했습니다.');
      if(mounted.current&&generation.current===token){setRecords(result.records);setAvailability(result.availability??{});setStore(result.storeInstanceId);setNext(result.nextBefore??null);setLoaded(true);setError('');}
    }catch(e){if(mounted.current&&generation.current===token)setError(e instanceof Error?e.message:String(e));}
    finally{loading.current=false;}
  },[archived,before]);
  useEffect(()=>{generation.current++;if(!props.visible)return;void reload();const timer=setInterval(()=>void reload(),15000);return()=>{clearInterval(timer);generation.current++;};},[props.visible,reload]);
  const run=async(id:string,job:()=>Promise<void>)=>{
    if(action.current)return;action.current=true;setBusy(id);setNotice('');
    try{await job();}catch(e){if(mounted.current)setNotice(e instanceof Error?e.message:String(e));}
    finally{action.current=false;if(mounted.current){setBusy('');void reload();}}
  };
  const drop=(receipt:PendingWorkroomResume)=>{clearPendingWorkroomResume(sessionStorage,receipt);if(mounted.current)setReceipts(pendingWorkroomResumes(sessionStorage));};
  const result=async(receipt:PendingWorkroomResume,value:WorkroomHistoryResult)=>{
    if(value.storeInstanceId!==receipt.storeInstanceId||!value.resume)throw new Error('원래 기기의 재개 결과를 확인하지 못했습니다. 요청을 다시 보내지 않았습니다.');
    if(!mounted.current)return;
    const state=value.resume.state;
    if(state==='completed'){
      drop(receipt);setUnrecorded('');setReview(null);
      if(value.resume.session){setNotice('같은 대화를 이어 열었습니다.');await propsRef.current.onOpen(value.resume.session,records.find(r=>r.id===receipt.conversationId)?.title);}
      else setNotice('이 요청은 이미 실행됐습니다. 현재 터미널이 종료되어 저장된 대화 목록을 다시 확인합니다.');
    }else if(state==='rejected'){drop(receipt);setReview(null);setNotice('CLI를 실행하기 전에 재개가 중단됐습니다. 목록에서 다시 검토할 수 있습니다.');}
    else if(state==='not-recorded'){setUnrecorded(receipt.conversationId);setNotice('이 요청의 실행 영수증이 없습니다. 다시 검토하면 이전 검토를 무효화하고 현재 상태를 확인합니다.');}
    else setNotice('재개 결과를 확인해야 합니다. 요청을 다시 보내지 않았습니다. 현재 터미널을 확인한 뒤 결과를 다시 조회하세요.');
  };
  const check=(receipt:PendingWorkroomResume)=>run(receipt.conversationId,async()=>result(receipt,await requestWorkroomHistory({protocolVersion:WORKROOM_HISTORY_VERSION,operation:'resume.status',storeInstanceId:receipt.storeInstanceId,requestId:receipt.requestId})));
  const inspect=(record:WorkroomConversation)=>run(record.id,async()=>{
    const response=await requestWorkroomHistory({protocolVersion:WORKROOM_HISTORY_VERSION,operation:'resume.review',storeInstanceId:store,conversationId:record.id,expectedRevision:record.revision});
    if(!response.review||response.storeInstanceId!==store)throw new Error('대화 재개 검토를 확인하지 못했습니다.');
    if(mounted.current){setUnrecorded('');if(response.review.available)await execute(record,response.review);else setReview({record,value:response.review});}
  });
  const execute=async(record:WorkroomConversation,checked:NonNullable<WorkroomHistoryResult['review']>)=>{
      if(!checked.available||checked.expiresAt<=Date.now())throw new Error('재개 검토가 만료됐습니다. 다시 검토하세요.');
      const receipt={storeInstanceId:store,conversationId:record.id,requestId:crypto.randomUUID()};
      // Retain the receipt before sending. On any transport/parse failure, only status is offered.
      savePendingWorkroomResume(sessionStorage,receipt);if(mounted.current){setReceipts(pendingWorkroomResumes(sessionStorage));setReview(null);}
      // The review's revision: a review may have bound a Codex thread it derived, which moves the row by one (w14).
      try{await result(receipt,await requestWorkroomHistory({protocolVersion:WORKROOM_HISTORY_VERSION,operation:'resume.execute',...receipt,expectedRevision:checked.revision,reviewId:checked.id,cols:100,rows:30}));}
      catch{if(mounted.current)setNotice('재개 응답을 받지 못했습니다. 결과 확인 버튼으로 같은 요청의 영수증을 조회하세요. 요청은 자동 재전송하지 않습니다.');}
  };
  // An earlier resume's outcome is unknown (the app restarted while it ran): a person checks the session list and says
  // the conversation is not open, which clears the hold. The warning says what pressing it wrongly would do (w14, R4).
  const settle=(record:WorkroomConversation,revision:number)=>run(record.id,async()=>{
    if(Date.now()-settleArmed<WORKROOM_RESTART_CONFIRM_GUARD_MS)return;
    const response=await requestWorkroomHistory({protocolVersion:WORKROOM_HISTORY_VERSION,operation:'resume.settle',storeInstanceId:store,conversationId:record.id,expectedRevision:revision,requestId:crypto.randomUUID()});
    if(!response.record||response.storeInstanceId!==store)throw new Error('확인 결과를 받지 못했습니다. 목록을 다시 확인하세요.');
    for(const receipt of receipts.filter(r=>r.conversationId===record.id&&r.storeInstanceId===store))drop(receipt);
    if(mounted.current){setReview(null);setSettleArmed(0);setNotice(RESTART_SETTLE_DONE);}
  });
  const mutation=(record:WorkroomConversation,operation:'rename'|'archive'|'unarchive')=>run(record.id,async()=>{
    const response=await requestWorkroomHistory({protocolVersion:WORKROOM_HISTORY_VERSION,operation,storeInstanceId:store,conversationId:record.id,expectedRevision:record.revision,requestId:crypto.randomUUID(),...(operation==='rename'?{title:title.trim()}:{})});
    if(!response.record||response.storeInstanceId!==store)throw new Error('대화 변경 결과를 확인하지 못했습니다. 목록을 다시 확인하세요.');
    if(mounted.current){setEditing('');setReview(null);setNotice(operation==='rename'?'대화 제목을 저장했습니다.':operation==='archive'?'대화를 보관했습니다. 실행 중인 터미널은 계속됩니다.':'대화를 목록으로 복원했습니다.');}
  });
  const onSummary=props.onSummary;
  useEffect(()=>{if(!archived)onSummary?.({count:records.length,more:!!next||cursors.length>0,pending:receipts.length,loaded});},[onSummary,archived,records.length,next,cursors.length,receipts.length,loaded]);
  const shown=records.filter(r=>[r.title,r.agent,r.accountLabel,props.projects.find(p=>p.targetId===r.targetId)?.label??'등록 해제된 프로젝트'].join(' ').toLowerCase().includes(props.query.trim().toLowerCase()));
  const pending=receipts.filter(r=>r.storeInstanceId===store);
  return <section className="workroom-history" data-testid="workroom-history" aria-label="저장된 대화">
    <header><h4>저장된 대화</h4><label><input type="checkbox" aria-label="보관한 대화 보기" checked={archived} disabled={!!busy} onChange={e=>{setRecords([]);setLoaded(false);setArchived(e.target.checked);setBefore(undefined);setCursors([]);setReview(null);}}/>보관함</label><button type="button" className="session-directory-button" onClick={()=>void reload()}>기록 새로고침</button></header>
    <p className="session-directory-footnote">이 기기의 대화 제목과 연결 기록을 보존합니다. 앱을 다시 열어도 AI는 자동 실행되지 않습니다. 검색은 현재 기록 페이지에 적용됩니다.</p>
    {error&&<p className="session-directory-notice" role="status">저장된 대화 확인: {error} 현재 터미널 목록은 아래에서 사용할 수 있습니다.</p>}
    {notice&&<p className="session-directory-notice" role="status" data-testid="history-notice">{notice}</p>}
    {receipts.length>0&&<div className="workroom-history-pending" aria-label="재개 결과 확인"><strong>결과 확인이 필요한 재개 요청 {receipts.length}개</strong>{receipts.map(receipt=><div key={receipt.requestId}>{store&&receipt.storeInstanceId!==store&&<p>이전 저장소의 요청입니다. 현재 저장소의 빈 결과로 실행 여부를 판단하지 않습니다.</p>}<button type="button" className="session-directory-button" disabled={!!busy} onClick={()=>void check(receipt)}>재개 결과 확인</button>{receipt.storeInstanceId===store&&unrecorded===receipt.conversationId&&records.find(r=>r.id===receipt.conversationId)&&<button type="button" className="session-directory-button" disabled={!!busy} onClick={()=>void inspect(records.find(r=>r.id===receipt.conversationId)!)}>다시 검토</button>}</div>)}</div>}
    {loaded&&!shown.length&&<p>{props.query?'현재 페이지에 검색 결과가 없습니다.':archived?'보관한 대화가 없습니다.':'저장된 대화가 없습니다.'}</p>}
    <ul>{shown.map(record=>{
      const project=props.projects.find(p=>p.targetId===record.targetId),live=props.sessions.find(s=>s.id===record.sessionId&&s.targetId===record.targetId&&s.agent===record.agent);
      const waiting=pending.some(r=>r.conversationId===record.id),known=availability[record.id],blocked=record.state!=='running'&&!!known&&NOT_OPENABLE.has(known);
      return <li key={record.id} data-testid="history-row" data-conversation-id={record.id} data-availability={known}>
        <div><strong>{record.title||`${project?.label??'등록 해제된 프로젝트'} · ${record.agent}`}</strong><small>{project?.label??'등록 해제된 프로젝트'} · {record.accountLabel} · {new Date(record.createdAt).toLocaleString('ko-KR')} · {record.state==='running'?'실행 중':record.state==='detached'?'앱 재시작으로 끊김':'종료'}{blocked?` · ${RESTART_AVAILABILITY_PHRASE[known!]}`:''}</small></div>
        {editing===record.id?<form onSubmit={e=>{e.preventDefault();void mutation(record,'rename');}}><input aria-label="대화 제목" maxLength={192} value={title} onChange={e=>setTitle(e.target.value)} autoFocus/><button type="submit" className="session-directory-button" disabled={!!busy}>제목 저장</button><button type="button" className="session-directory-button" onClick={()=>setEditing('')}>취소</button></form>:<div className="workroom-history-actions">
          {live&&<button type="button" className="session-directory-button" disabled={!!busy} onClick={()=>void props.onOpen(live,record.title)}>{live.state==='running'?'대화 열기':'종료 출력 보기'}</button>}
          {record.state!=='running'&&!blocked&&<button type="button" className="session-directory-button" data-testid="history-resume" disabled={!!busy||waiting||!project} onClick={()=>void inspect(record)}>이어 열기</button>}
          <button type="button" className="session-directory-button" disabled={!!busy||waiting} onClick={()=>{setEditing(record.id);setTitle(record.title);}}>제목 변경</button>
          <button type="button" className="session-directory-button" disabled={!!busy||waiting} onClick={()=>void mutation(record,archived?'unarchive':'archive')}>{archived?'목록으로 복원':'보관'}</button>
        </div>}
      </li>;
    })}</ul>
    {review&&<div className="workroom-history-review" role="region" aria-label="대화 연결 확인" data-testid="history-review"><strong>{review.record.title||'저장된 대화'} · 연결 확인</strong><p>{review.value.reason}</p>
      {review.value.reason===WORKROOM_RESUME_UNSETTLED_REASON&&(settleArmed
        ?<><p>{RESTART_SETTLE_WARNING}</p><button type="button" className="session-directory-button" data-testid="history-settle-yes" disabled={!!busy} onClick={()=>void settle(review.record,review.value.revision)}>세션 목록에서 열려 있지 않은 것을 확인했음</button><button type="button" className="session-directory-button" disabled={!!busy} onClick={()=>setSettleArmed(0)}>취소</button></>
        :<button type="button" className="session-directory-button" data-testid="history-settle" disabled={!!busy} onClick={()=>setSettleArmed(Date.now())}>확인했음</button>)}
      <button type="button" className="session-directory-button" disabled={!!busy} onClick={()=>{setReview(null);setSettleArmed(0);}}>닫기</button></div>}
    {(cursors.length>0||next)&&<nav aria-label="저장된 대화 페이지"><button type="button" className="session-directory-button" disabled={!cursors.length||!!busy} onClick={()=>{setRecords([]);setLoaded(false);setBefore(cursors.at(-1));setCursors(cursors.slice(0,-1));setReview(null);}}>이전 기록 페이지</button><span>{cursors.length+1}페이지</span><button type="button" className="session-directory-button" disabled={!next||!!busy} onClick={()=>{setRecords([]);setLoaded(false);setCursors([...cursors,before]);setBefore(next!);setReview(null);}}>다음 기록 페이지</button></nav>}
  </section>;
}
