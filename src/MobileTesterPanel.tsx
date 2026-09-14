import React,{useEffect,useRef,useState} from 'react';
import {normalizeMobileWorkspaceResult,type MobileWorkspaceRequest,type MobileWorkspaceResult} from './mobileWorkspaceProtocol';
import {testerActive,testerRequestId} from './testerAgentContract';
import {testerStateLabel,type MobileTesterResult} from './mobileTesterProtocol';

export function MobileTesterPanel({targetId,available,online,visible,transport}:{targetId:string;available:boolean;online:boolean;visible:boolean;transport:(r:MobileWorkspaceRequest)=>Promise<MobileWorkspaceResult>}){
  const [data,setData]=useState<MobileTesterResult|null>(null),[profile,setProfile]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[uncertain,setUncertain]=useState(false);
  const generation=useRef(0),flight=useRef(false),pending=useRef<MobileWorkspaceRequest['workspace']|null>(null),transportRef=useRef(transport);transportRef.current=transport;
  const send=async(workspace:MobileWorkspaceRequest['workspace'])=>{
    if(!targetId||!available||!online||!visible||flight.current)return;
    const mine=generation.current;flight.current=true;setBusy(true);setError('');let completed=false;
    try{
      const reply=normalizeMobileWorkspaceResult(await transportRef.current({operation:'workspace',targetId,requestId:crypto.randomUUID(),workspace}));
      if(reply.action!==workspace.action||!reply.tester)throw Error('요청과 검사 결과가 다릅니다.');
      if(mine!==generation.current)return;
      const next=reply.tester;
      setData(old=>workspace.action==='tester.status'?next:{...old,...next});
      if(next.profiles)setProfile(old=>next.profiles!.some(p=>p.id===old)?old:next.defaultProfile??next.profiles![0]?.id??'');
      if(workspace.action==='tester.start'){pending.current=null;setUncertain(false);}
      completed=workspace.action==='tester.read'&&!!next.run&&!testerActive(next.run.state);
    }catch(e){if(mine===generation.current){setError(e instanceof Error?e.message:'검사 응답을 확인하지 못했습니다.');setUncertain(!!pending.current);}}
    finally{if(mine===generation.current){flight.current=false;setBusy(false);if(completed)void sendRef.current({action:'tester.status'});}}
  };
  const sendRef=useRef(send);sendRef.current=send;
  useEffect(()=>{pending.current=null;setUncertain(false);setProfile('');},[targetId]);
  useEffect(()=>{
    generation.current++;flight.current=false;setBusy(false);setData(null);setError('');
    if(online&&available&&visible&&targetId)void sendRef.current({action:'tester.status'});
    return()=>{generation.current++;};
  },[targetId,online,available,visible]);
  useEffect(()=>{
    if(!online||!visible||!data?.run||!testerActive(data.run.state))return;
    const id=data.run.id,timer=setInterval(()=>{if(!document.hidden)void sendRef.current({action:'tester.read',runId:id});},3000);
    return()=>clearInterval(timer);
  },[data?.run?.id,data?.run?.state,online,visible]);
  const start=()=>{
    if(!pending.current)pending.current={action:'tester.start',profileId:profile,revisionHash:data?.revision,testRequestId:testerRequestId()};
    void send(pending.current);
  };
  const active=!!data?.run&&testerActive(data.run.state);
  return <section className="workspace-tester" data-testid="mobile-tester">
    <h3>프로젝트 테스터</h3>
    {!online?<p>Mac에 다시 연결하면 진행 중인 검사와 결과를 확인합니다.</p>:!available?<p>이 Mac 앱을 업데이트하면 모바일에서 테스트할 수 있습니다.</p>:!targetId?<p>검사할 프로젝트를 선택하세요.</p>:<>
      <p>선택한 Mac에서 준비된 검사를 실행합니다. 화면을 닫거나 통신이 끊겨도 접수한 검사는 계속됩니다.</p>
      {busy&&<p role="status">검사 상태 확인 중…</p>}{error&&<p role="alert">{error}</p>}
      {uncertain&&<p>요청이 전달됐을 수 있습니다. 같은 요청으로 결과를 다시 확인하세요.</p>}
      {data?.installation==='ready'?<><label>모바일 검사 범위<select aria-label="모바일 검사 범위" value={profile} disabled={busy||active||uncertain} onChange={e=>setProfile(e.target.value)}>{data.profiles?.map(p=><option key={p.id} value={p.id}>{p.id==='quick'?'빠른 검사':p.id}</option>)}</select></label>
        {!data.canRun&&<p>조회만 허용됐습니다. Mac 워크룸의 기기 권한에서 테스트 실행을 허용하세요.</p>}
        <button disabled={busy||active||!data.canRun||!profile||!data.revision||!data.environmentReady} onClick={start}>{uncertain?'같은 검사 요청 확인':'테스트 실행'}</button>
      </>:data&&<p>Mac의 프로젝트 → 테스터 에이전트에서 검사 설정과 Python 환경을 먼저 준비하세요.</p>}
      {data?.run&&<div role="status"><strong>{testerStateLabel[data.run.state]}</strong><p>{data.run.profileId} · {new Date(data.run.createdAt).toLocaleString()}</p><p>실행 ID: {data.run.id}</p>
        {(data.freshness==='source-changed'||data.run.sourceUnchanged===false)&&<p>검사 기준 이후 코드가 변경됐습니다. 다시 검사하세요.</p>}
        {data.run.checks.map(c=><p key={c.id}>{c.id} · {testerStateLabel[c.state]}{c.durationSeconds!==undefined?` · ${c.durationSeconds}초`:''}</p>)}
        {data.run.checkCount>data.run.checks.length&&<p>검사 {data.run.checkCount}개 중 {data.run.checks.length}개 표시 · 상세 로그는 Mac에서 확인하세요.</p>}
        {active&&data.canCancel&&<button disabled={busy} onClick={()=>void send({action:'tester.cancel',runId:data.run!.id})}>이 검사 취소</button>}
        <p>선택한 검사 범위의 결과입니다. 실패 원인과 AI 개선은 Mac의 프로젝트 테스터에서 이어갑니다.</p>
      </div>}
      <button disabled={busy} onClick={()=>void send({action:'tester.status'})}>테스트 상태 새로고침</button>
      {uncertain&&!active&&data&&<button disabled={busy} onClick={()=>{pending.current=null;setUncertain(false);void send({action:'tester.status'});}}>이전 요청 보류 해제·설정 다시 확인</button>}
    </>}
  </section>;
}
