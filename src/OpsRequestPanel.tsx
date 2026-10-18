import React,{useEffect,useRef,useState} from 'react';
import {communityControlRequest} from './agentDialogueControlClient';
import {normalizeOpsReceipt,opsRequestId,opsRequestText,OPS_REQUEST_MAX_TEXT_BYTES,OPS_STATE_LABELS,type OpsRequestReceipt} from './opsRequestProtocol';
import {openWorkroomPopout} from './workroomPopoutClient';
import {workroomPopoutTitle} from './workroomPopout';
import {isDeployedWeb,isTauri} from './lib/env';
import './OpsRequestPanel.css';

const LAST_REQUEST='agentstoz:ops-request:v1';
function previous(endpointId:string):string|null{try{const r=JSON.parse(localStorage.getItem(LAST_REQUEST)??'null');return r?.endpointId===endpointId?opsRequestId(r.requestId):null;}catch{return null;}}
export async function callOpsFromApp(request:Record<string,unknown>){return communityControlRequest({operation:'ops-action',request});}
/** Main-window receiver: runs even while hidden, because remote calls must bring the receiving OPS forward. */
export function OpsRequestWindows({onError,onOpenInline}:{onError:(error:string)=>void;onOpenInline?:(receipt:OpsRequestReceipt)=>void|Promise<void>}){
  const errorRef=useRef(onError);errorRef.current=onError;
  const inlineRef=useRef(onOpenInline);inlineRef.current=onOpenInline;
  useEffect(()=>{
    if(isDeployedWeb())return;let stopped=false,timer:ReturnType<typeof setTimeout>;
    const opened=new Map<string,boolean>();
    const poll=async()=>{
      let opening=false;
      try{
        const value=await communityControlRequest({operation:'ops-windows'});
        for(const item of value.windows??[]){
          if(stopped)return;
          const r=normalizeOpsReceipt(item.receipt);
          if(!r.sessionId||!r.targetId||!r.agent)continue;
          // On the web a background popup can be blocked. Its failure remains visible and unacknowledged.
          if(!opened.has(r.sessionId)){
            opening=true;
            let inline=false;
            try{await openWorkroomPopout({sessionId:r.sessionId,targetId:r.targetId,agent:r.agent,bypassPermissions:false},workroomPopoutTitle('AgentsToZ OPS',r.agent));}
            catch(e){if(!inlineRef.current)throw e;await inlineRef.current(r);inline=true;errorRef.current('OPS 새 창을 열 수 없어 이 기기의 본창 워크룸에서 엽니다.');}
            opened.set(r.sessionId,inline);if(opened.size>64)opened.delete(opened.keys().next().value!);
          }
          await communityControlRequest({operation:'ops-window-opened',claimId:item.claimId,...(opened.get(r.sessionId)?{inline:true}:{})});
        }
      }catch(e){if(!stopped&&opening)errorRef.current(`상대 기기에서 받은 OPS 창을 확인하세요. ${String(e)}`);}
      if(!stopped)timer=setTimeout(poll,3000);
    };
    void poll();return()=>{stopped=true;clearTimeout(timer);};
  },[]);
  return null;
}

/** Refusals that happen on this Mac before anything is sent: the request certainly never reached the receiver. */
const NOT_SENT_CODES=new Set(['OPS_REQUEST_PERMISSION','OPS_REQUEST_TARGET','AGENT_DIALOGUE_CONTROL_NOT_IN_COMMUNITY','AGENT_DIALOGUE_CONTROL_TARGET_INVALID']);
/**
 * Answers that the receiver holds no task for this ID. The receiver takes control requests in order and admits one
 * request at a time, so a status read sent after a submit attempt sees that admission if it happened. Not-found is
 * still only what its ledger knows under its current OPS binding (a moved OPS folder or lost app data forgets a task
 * that may be running), so the message says what is known and asks to check before sending a new task.
 */
const NOT_ADMITTED_CODES=new Set(['OPS_REQUEST_NOT_FOUND','OPS_HOST_OUTDATED']);
const NOT_FOUND_TEXT='상대 기기에서 이 요청을 찾지 못했습니다. 이미 실행 중이었는지 상대 워크룸에서 확인한 뒤 새 작업으로 보내세요.';
/**
 * A submit failure whose text is the receiver's own definite answer, worth repeating as the reason once not-found
 * follows. Timeouts and unknown outcomes are not reasons: quoted before not-found they contradict it.
 */
const RECEIVER_ANSWER_CODES=new Set(['OPS_REQUEST_FAILED']);
const errorCode=(e:unknown)=>typeof (e as {code?:unknown})?.code==='string'?(e as {code:string}).code:'';
const errorText=(e:unknown)=>e instanceof Error?e.message:String(e);
const byteLength=(value:string)=>new TextEncoder().encode(value).length;

export function OpsRequestPanel({endpointId,deviceName,onClose,onViewWorkroom}:{endpointId:string;deviceName:string;onClose:()=>void;onViewWorkroom:()=>void}){
  const [text,setText]=useState(''),[requestId,setRequestId]=useState<string|null>(()=>previous(endpointId));
  const [receipt,setReceipt]=useState<OpsRequestReceipt|null>(null),[error,setError]=useState(''),[sending,setSending]=useState(false);
  // Set only by a definitive answer for the current ID; then a new task (a new ID) cannot run the same work twice.
  const [notAdmitted,setNotAdmitted]=useState(false),[pollKey,setPollKey]=useState(0);
  const currentRequest=useRef(requestId);currentRequest.current=requestId;
  const sendingRef=useRef(false),submitSeq=useRef(0);
  // The receiver's reason for the last refused submit, kept when a later read proves the ID was never admitted.
  const refusal=useRef('');
  // A restored ID may have been sent by an earlier screen; only a fresh ID starts out certainly unsent.
  const maybeSent=useRef(requestId!==null);
  const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const forget=()=>{refusal.current='';currentRequest.current=null;setRequestId(null);setReceipt(null);setNotAdmitted(false);maybeSent.current=false;try{localStorage.removeItem(LAST_REQUEST);}catch{}};
  const read=async(id:string)=>{
    // A read that started while a submit was in flight cannot prove anything about that submit.
    const seq=submitSeq.current,idle=!sendingRef.current;
    try{
      const value=await callOpsFromApp({operation:'status',endpointId,requestId:id});
      const receipt=normalizeOpsReceipt(value.receipt);if(alive.current&&currentRequest.current===id){setReceipt(receipt);setNotAdmitted(false);setError('');}return receipt;
    }catch(e){
      if(NOT_ADMITTED_CODES.has(errorCode(e))&&idle&&seq===submitSeq.current&&alive.current&&currentRequest.current===id){
        setNotAdmitted(true);
        setError(errorCode(e)==='OPS_HOST_OUTDATED'?errorText(e):`${refusal.current?refusal.current+' ':''}${NOT_FOUND_TEXT}`);
      }
      throw e;
    }
  };
  useEffect(()=>{
    if(!requestId)return;let stopped=false,timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      if(!sendingRef.current){
        try{const r=await read(requestId);if(['completed','failed','unknown'].includes(r.state))return;}
        catch(e){
          if(NOT_ADMITTED_CODES.has(errorCode(e))&&!sendingRef.current)return;
          if(!stopped&&alive.current&&!sendingRef.current)setError(`${errorText(e)} 요청 ID를 유지합니다. 연결 후 같은 작업의 상태를 다시 확인합니다.`);
        }
      }
      if(!stopped)timer=setTimeout(poll,5000);
    };void poll();return()=>{stopped=true;clearTimeout(timer);};
  },[endpointId,requestId,pollKey]);
  const bytes=byteLength(text),tooLong=bytes>OPS_REQUEST_MAX_TEXT_BYTES;
  const send=async()=>{
    if(tooLong){setError(`작업 내용이 너무 깁니다 (${bytes.toLocaleString()} / ${OPS_REQUEST_MAX_TEXT_BYTES.toLocaleString()}바이트). 줄여서 보내세요.`);return;}
    let task:string;try{task=opsRequestText(text);}catch(e){setError(errorText(e));return;}
    const id=requestId??crypto.randomUUID();if(!requestId)maybeSent.current=false;
    sendingRef.current=true;submitSeq.current++;refusal.current='';setSending(true);setError('');setNotAdmitted(false);
    // Only IDs persist in the browser. The request and result are encrypted in the receiving app's ledger.
    try{localStorage.setItem(LAST_REQUEST,JSON.stringify({endpointId,requestId:id}));}catch{/* The visible request ID still permits status lookup. */}
    currentRequest.current=id;setRequestId(id);
    try{const value=await callOpsFromApp({operation:'submit',endpointId,requestId:id,text:task});maybeSent.current=true;if(alive.current&&currentRequest.current===id)setReceipt(normalizeOpsReceipt(value.receipt));}
    catch(e){
      if(alive.current&&currentRequest.current===id){
        if(NOT_SENT_CODES.has(errorCode(e))&&!maybeSent.current){forget();setError(`${errorText(e)} 요청은 보내지 않았습니다.`);}
        // An AgentsToZ without OPS requests certainly admitted nothing: the answer is to update it, not to wait.
        else if(errorCode(e)==='OPS_HOST_OUTDATED'){maybeSent.current=true;setNotAdmitted(true);setError(errorText(e));}
        else{
          maybeSent.current=true;refusal.current=RECEIVER_ANSWER_CODES.has(errorCode(e))?errorText(e):'';
          setError(`${errorText(e)} 접수 여부가 미확정입니다. 새 요청을 만들지 않고 같은 ID로 확인합니다.`);
        }
      }
    }
    finally{sendingRef.current=false;if(alive.current){setSending(false);setPollKey(k=>k+1);}}
  };
  const terminal=receipt&&['completed','failed','unknown'].includes(receipt.state);
  return <dialog className="ops-request-modal" aria-labelledby="ops-request-title" ref={node=>{if(node&&!node.open)node.showModal();}} onCancel={e=>{e.preventDefault();onClose();}}>
    <section className="w-full max-w-xl max-h-[90vh] overflow-auto rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5" data-testid="ops-request-panel">
      <h2 id="ops-request-title" className="text-lg font-semibold">{deviceName} · OPS에 작업 맡기기</h2>
      <p className="my-3 text-sm">상대 기기의 설정된 AI로 OPS 워크룸을 열어 처리하고, 결과를 이곳으로 돌려받습니다.</p>
      {!requestId&&<label className="block">맡길 작업<textarea aria-label="맡길 작업" className="my-2 min-h-28 w-full rounded-lg border border-[var(--line)] bg-transparent p-3" value={text} onChange={e=>setText(e.target.value)}/></label>}
      {/* Bytes, not characters: one Korean character is three bytes, so maxLength would let 3x the limit through. */}
      {!requestId&&bytes>OPS_REQUEST_MAX_TEXT_BYTES*0.8&&<p className="text-xs" data-testid="ops-request-bytes" data-over={tooLong?'true':'false'}>{bytes.toLocaleString()} / {OPS_REQUEST_MAX_TEXT_BYTES.toLocaleString()}바이트{tooLong?' · 너무 깁니다':''}</p>}
      {requestId&&<p className="break-all text-xs">요청 ID: {requestId}</p>}
      {requestId&&text&&<p className="my-3 whitespace-pre-wrap text-sm">맡긴 작업: {text}</p>}
      {receipt&&<div aria-live="polite" className="my-3" data-testid="ops-request-result">
        <p className="font-semibold">{OPS_STATE_LABELS[receipt.state]}{receipt.agent?` · ${receipt.agent}`:''}</p>
        {receipt.sessionId&&<p className="text-sm">상대 OPS 창: {receipt.windowOpened?'새 창 열림 확인':receipt.windowFallback?'본창 워크룸에서 열림':'열기 대기'}</p>}
        {receipt.message&&<p>{receipt.message}</p>}
        {receipt.result&&<p className="whitespace-pre-wrap">{receipt.result}</p>}
        {receipt.evidence&&<p className="mt-3 whitespace-pre-wrap text-sm">수행 근거: {receipt.evidence}</p>}
        {receipt.state==='needs-attention'&&<p>상대 기기의 OPS에서 로그인·신뢰·승인 화면을 확인해 주세요.</p>}
      </div>}
      {error&&<p role="alert" className="my-3 text-sm">{error}</p>}
      <div className="mt-4 flex flex-wrap gap-3">
        {!requestId&&<button type="button" disabled={sending||!text.trim()||tooLong} onClick={()=>void send()}>상대 OPS 열고 작업 보내기</button>}
        {requestId&&<button type="button" disabled={sending} onClick={()=>void read(requestId).catch(e=>{if(!NOT_ADMITTED_CODES.has(errorCode(e)))setError(errorText(e));})}>같은 요청 상태 확인</button>}
        {requestId&&!receipt&&text&&<button type="button" disabled={sending} onClick={()=>void send()}>같은 요청 다시 접수</button>}
        {(terminal||notAdmitted)&&<button type="button" disabled={sending} onClick={()=>{forget();if(terminal)setText('');setError('');}}>새 작업 작성</button>}
        <button type="button" onClick={onViewWorkroom}>상대 워크룸 보기</button>
        <button type="button" onClick={onClose}>닫기</button>
      </div>
    </section>
  </dialog>;
}
