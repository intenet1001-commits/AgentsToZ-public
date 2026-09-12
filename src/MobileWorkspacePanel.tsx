import {aiInitialPromptDraftError} from './aiInitialPrompt';
import React,{useEffect,useRef,useState} from 'react';
import type {QrRemoteControlProjectCard} from './qrRemoteControlContract';
import {normalizeMobileWorkspaceResult,type MobileWorkspaceRequest,type MobileWorkspaceResult,type MobileWorkspaceDuty} from './mobileWorkspaceProtocol';
export function MobileWorkspacePanel({mode,projects,available,online,transport,onDraft,visible=true,initialTarget}: {
 mode:'records'|'manage';projects:QrRemoteControlProjectCard[];available:boolean;online:boolean;visible?:boolean;initialTarget?:string;
 transport:(r:MobileWorkspaceRequest)=>Promise<MobileWorkspaceResult>;
 onDraft:(targetId:string,text:string)=>void;
}) {
 const [target,setTarget]=useState(initialTarget??'');const [query,setQuery]=useState('');
 const [result,setResult]=useState<MobileWorkspaceResult|null>(null);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 const [review,setReview]=useState<MobileWorkspaceDuty|null>(null);const epoch=useRef(0);const inFlight=useRef(false);
 const pageRequest=useRef<MobileWorkspaceRequest['workspace']>({action:'said.list'});
 const detail=useRef<{id:string;text:string}|null>(null);
 useEffect(()=>{const hide=()=>{if(document.hidden&&mode==='records'){epoch.current++;setResult(null);detail.current=null}};document.addEventListener('visibilitychange',hide);return()=>document.removeEventListener('visibilitychange',hide)},[mode]);
 const transportRef=useRef(transport);transportRef.current=transport;
 useEffect(()=>{epoch.current++;setResult(null);setReview(null);setError('');},[target]);
 useEffect(()=>{if(initialTarget)setTarget(initialTarget)},[initialTarget]);
 useEffect(()=>{if(!online){epoch.current++;setResult(null);setReview(null)}},[online]);
 useEffect(()=>()=>{epoch.current++},[]);
 const selected=projects.find(p=>p.controlId===target);
 const send=async(workspace:MobileWorkspaceRequest['workspace'])=>{
  if(!selected||!available||!online||inFlight.current)return;
  const mine=epoch.current;inFlight.current=true;setBusy(true);setError('');
  try {const next=normalizeMobileWorkspaceResult(await transportRef.current({operation:'workspace',requestId:crypto.randomUUID(),targetId:target,workspace}));if(mine===epoch.current){
    if(workspace.action==='said.list'){pageRequest.current=workspace;detail.current=null;}
    if(workspace.action==='said.read'&&next.records?.[0]){const record=next.records[0];const text=workspace.offset===0?record.text:detail.current?.id===record.id?detail.current.text+record.text:record.text;detail.current={id:record.id,text};next.records=[{...record,text}];}
    setResult(next);setReview(null)}}
  catch(e){if(mine===epoch.current)setError(e instanceof Error?e.message:'작업 결과를 확인하지 못했습니다.')}
  finally{inFlight.current=false;setBusy(false)}
 };
 useEffect(()=>{
  if(!visible||result?.memory?.state!=='saving')return;
  const timer=setInterval(()=>{if(!document.hidden)void send({action:'memory.status'})},3000);
  return()=>clearInterval(timer);
 },[visible,result?.memory?.state,target,online,available]);
 return <section className="remote-panel mobile-workspace-panel">
  <h2>{mode==='records'?'내가 한 말':'프로젝트 작업 마무리·대직'}</h2>
  {!online?<p>등록한 기기에 연결하면 Mac에서 보던 기록과 작업 상태를 확인할 수 있습니다.</p>:!available?<p>연결한 Mac 앱을 업데이트하면 기록 조회·세션 저장·대직 관리를 사용할 수 있습니다.</p>:<>
   <label>프로젝트<select aria-label={mode==='records'?'발언 프로젝트':'관리 프로젝트'} value={target} onChange={e=>setTarget(e.target.value)} disabled={busy}><option value="">프로젝트 선택</option>{projects.map(p=><option key={p.controlId} value={p.controlId}>{p.name}</option>)}</select></label>
   {mode==='records'?<form onSubmit={e=>{e.preventDefault();void send({action:'said.list',query})}}><label>발언 검색<input value={query} maxLength={300} onChange={e=>setQuery(e.target.value)} placeholder="Mac에서 내가 한 말 찾기" /></label><button disabled={!selected||busy}>검색·새로고침</button></form>:<div className="workspace-quick-actions">
    <button disabled={!selected||busy} onClick={()=>void send({action:'memory.status'})}>저장 결과 확인</button>
    <button disabled={!selected||busy||result?.memory?.state==='saving'} onClick={()=>void send({action:'memory.save'})}>지금 세션 기억하기</button>
    <button disabled={!selected||busy} onClick={()=>void send({action:'duty.status'})}>대직 현황</button>
    {selected?.kind==='worktree'&&<button disabled={busy} onClick={()=>void send({action:'worktree.review'})}>워크트리 정리 검토</button>}
   </div>}
   {busy&&<p role="status">확인 중…</p>}
   {error&&<p role="alert">{error}</p>}
   {result?.cleanup&&<section className="workspace-duty-review"><h3>워크트리 정리 · {result.cleanup.branch}</h3><p>{result.cleanup.message}</p>{result.cleanup.token&&<button disabled={busy} onClick={()=>void send({action:'worktree.remove',reviewToken:result.cleanup!.token,consent:true})}>확인하고 폴더 제거</button>}</section>}
   {result?.memory&&<p role="status">{result.memory.message}</p>}
   {result?.records&&<>
    <p>최근 적재순 · {result.source==='supabase'?'동기화된 자료':'Mac 로컬 자료'}{result.captureAt?` · 수집 ${new Date(result.captureAt).toLocaleString('ko-KR')}`:' · 수집 시각 미확인'}</p>
    {result.scanComplete===false&&<p>일부 기록을 아직 검색하지 못했습니다. 다음 페이지와 Mac의 수집 상태를 확인하세요.</p>}
    {result.records.length===0&&<p>이 범위에서 찾은 발언이 없습니다.</p>}
    {result.records.map(record=><article key={record.id} className="workspace-record"><small>{new Date(record.recordedAt).toLocaleString('ko-KR')} · {record.agent} · {record.deviceName??'수집 단말 미상'} · {record.origin}</small><p>{record.text}</p>{record.truncated&&<><p>긴 발언의 일부입니다.</p><button disabled={busy} onClick={()=>void send({...pageRequest.current,action:'said.read',recordId:record.id,textHash:record.textHash,offset:result.action==='said.read'?result.nextOffset??0:0})}>{result.action==='said.read'?'계속 읽기':'전체 발언 읽기'}</button></>}<button disabled={record.truncated||!!aiInitialPromptDraftError(record.text)} onClick={()=>onDraft(target,record.text)}>이 말로 작업하기</button></article>)}
    {result.hasMore&&result.nextBeforeSeq&&<button disabled={busy} onClick={()=>void send({...pageRequest.current,action:'said.list',beforeSeq:result.nextBeforeSeq!})}>다음 발언</button>}
   </>}
   {result?.supported===false&&<p>이 호스트에서는 카카오톡 대직을 지원하지 않습니다.</p>}
   {result?.connections?.length===0&&result.supported&&<p>이 프로젝트에 연결된 대직 방이 없습니다. Mac에서 방과 공유 자료를 설정하세요.</p>}
   {result?.connections?.map(c=><article key={c.id} className="workspace-record"><strong>{c.title} · #{c.alias}</strong><p>{c.state} · 응답 {c.replied}회{c.checkedAt?` · 확인 ${new Date(c.checkedAt).toLocaleTimeString('ko-KR')}`:''}</p><div className="workspace-quick-actions"><button disabled={busy} onClick={()=>setReview(c)}>켜기</button><button disabled={busy} onClick={()=>void send({action:'duty.disable',connectionId:c.id})}>끄기</button><button disabled={busy} onClick={()=>void send({action:'duty.diagnose',connectionId:c.id})}>연결 진단</button></div></article>)}
   {review&&<section className="workspace-duty-review"><h3>대직 켜기 확인</h3><p>{selected?.name} → {review.title}<br/>프로필 {review.profile} · #{review.alias}<br/>승인 자료 버전 {review.knowledgeRevision}</p><p>이 방의 새 질문에 Mac의 카카오톡으로 자동 답변합니다.</p><button disabled={busy} onClick={()=>void send({action:'duty.enable',connectionId:review.id,revision:review.revision,knowledgeRevision:review.knowledgeRevision,consent:true})}>확인하고 켜기</button><button onClick={()=>setReview(null)}>취소</button></section>}
   {result?.checks?.map((c,i)=><p key={i}>{c.ok?'✓':'확인 필요'} {c.name} · {c.detail}</p>)}
  </>}
 </section>;
}
