import React,{useEffect,useRef,useState} from 'react';
import {commonMemoryUuid as requestUuid} from './commonMemoryCrypto';
import type {WorkroomTransport} from './WorkroomSessionFooter';
import type {WorkroomSessionStatus} from './workroomSessionStatus';

/** The same memory dispatcher and receipts as the Workroom footer; thread completion never implies memory success. */
export function CommunityThreadMemory({scope,targetId,sessionId,transport,visible}:{scope:string;targetId:string;sessionId:string;transport:WorkroomTransport;visible:boolean}){
 const key='agentstoz:thread-memory:'+scope;
 const [saveId,setSaveId]=useState(()=>{try{return sessionStorage.getItem(key)??'';}catch{return '';}});
 const [status,setStatus]=useState<WorkroomSessionStatus|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const alive=useRef(true),flight=useRef(false),latest=useRef(transport);latest.current=transport;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const read=async()=>{if(flight.current)return;flight.current=true;try{
  const r=await latest.current({operation:'workspace',requestId:requestUuid(),targetId,workspace:{action:'workroom.status',sessionId,...(saveId?{saveRequestId:saveId}:{})}});
  if(!r.workroom||r.workroom.sessionId!==sessionId)throw Error('연결 워크룸의 기억 저장 상태를 확인하지 못했습니다.');
  if(alive.current){setStatus(r.workroom);setError('');}
 }catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e));}finally{flight.current=false;}};
 const reader=useRef(read);reader.current=read;
 useEffect(()=>{if(!visible)return;void reader.current();const timer=setInterval(()=>{if(!document.hidden)void reader.current();},15000);return()=>clearInterval(timer);},[visible,saveId,sessionId]);
 const uncertain=!!saveId&&(!status||status.save.requestId!==saveId&&status.save.state!=='not-admitted'||['saving','unconfirmed','recovery-required'].includes(status.save.state));
 const save=async()=>{
  if(busy||flight.current||uncertain||!status?.initialized)return;setBusy(true);setError('');
  const id=status.save.state==='not-admitted'&&saveId?saveId:requestUuid();try{sessionStorage.setItem(key,id);}catch{/* Current view keeps its ID. */}setSaveId(id);
  try{const r=await latest.current({operation:'workspace',requestId:id,targetId,workspace:{action:'workroom.save',sessionId}});
   if(!r.workroom||r.workroom.sessionId!==sessionId)throw Error('저장 응답을 확인하지 못했습니다.');if(alive.current)setStatus(r.workroom);
  }catch(e){if(alive.current)setError((e instanceof Error?e.message:String(e))+' 저장 결과를 먼저 확인하세요.');}
  finally{if(alive.current)setBusy(false);}
 };
 return <div className="community-thread-memory" data-testid="community-thread-memory">
  <span role="status">{status?.save.localSaved?'기억 저장 완료'+(status.save.backupSaved?' · 백업 완료':' · 백업 별도'):status?.initialized===false?'프로젝트 기억 설정 필요':uncertain?'기억 저장 결과 확인 필요':status?'아직 저장한 기록이 없습니다.':'기억 저장 상태를 확인하고 있습니다…'}</span>
  {error&&<small role="status">{error}</small>}
  <button type="button" disabled={busy||uncertain||!status?.initialized} onClick={()=>void save()}>{busy?'저장 요청 중…':'세션 기억하기'}</button>
  <button type="button" disabled={busy} onClick={()=>void read()}>저장 상태 확인</button>
 </div>;
}
