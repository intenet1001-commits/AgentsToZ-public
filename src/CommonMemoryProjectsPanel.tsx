import {readCommonMemoryIntents,retainCommonMemoryIntent,forgetCommonMemoryIntent,commonMemoryIntentPayload,type CommonMemoryIntent} from './commonMemoryIntent';
import React,{useEffect,useRef,useState} from 'react';
import {createCommonMemoryClient,commonMemoryHttpTransport,type CommonMemoryClient} from './commonMemoryClient';
import {isTauri} from '@tauri-apps/api/core';
import type {CommonMemoryProjectPlan} from './commonMemoryProjects';
const defaultClient=createCommonMemoryClient(commonMemoryHttpTransport(isTauri()?'http://127.0.0.1:3001/api/common-memory':undefined));
const button='min-h-11 rounded-lg border border-[var(--line)] px-3 py-2 text-sm disabled:opacity-40';
export function CommonMemoryProjectsPanel({client=defaultClient,groupId,onChanged}:{client?:CommonMemoryClient;groupId?:string;onChanged?:()=>void}){
  const [open,setOpen]=useState(false),[roots,setRoots]=useState<any[]>([]),[groups,setGroups]=useState<any[]>([]),[root,setRoot]=useState(''),[group,setGroup]=useState(groupId??''),[plan,setPlan]=useState<CommonMemoryProjectPlan|null>(null),[outcomes,setOutcomes]=useState<any[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [pending,setPending]=useState<{plan:CommonMemoryProjectPlan;requestId:string;memoryId:string}|null>(null);const running=useRef(false);const [intents,setIntents]=useState<CommonMemoryIntent[]>([]);
  useEffect(()=>{setPlan(null);setOutcomes([]);setGroup(groupId??'');},[groupId,client]);
  const run=async(fn:()=>Promise<void>)=>{if(running.current)return;running.current=true;setBusy(true);setError('');try{await fn();}catch(e){setError(e instanceof Error?e.message:'프로젝트 추가 정보를 확인하세요.');}finally{running.current=false;setBusy(false);}};
  const preview=async(g=group,r=root)=>{const result=await client.projectsPlan(g,r);setPlan(result.plan);setOutcomes([]);};
  const send=async(intent:NonNullable<typeof pending>)=>{
    await retainCommonMemoryIntent({operation:'projects-add',input:intent},intent.plan.scopeId,intent.plan.groupId,intent.requestId);
    const refreshIntents=()=>setIntents(readCommonMemoryIntents().filter(i=>i.kind==='projects-add'&&i.scopeId===intent.plan.scopeId));
    refreshIntents();setPending(intent);
    try{
      const result=await client.projectsAdd(intent.plan,intent.requestId,intent.memoryId);
      setOutcomes(result.outcomes);
      if(result.outcomes.some((o:any)=>o.memoryId===intent.memoryId&&o.state==='failed'))return result;
      setPending(null);forgetCommonMemoryIntent(intent.requestId);refreshIntents();onChanged?.();return result;
    }catch(e){
      if(!(e as any)?.uncertain&&!(e as any)?.unknownOutcome){
        const status=await client.projectAddStatus(intent.requestId).catch(()=>null);
        if(status?.state==='registered'||status?.found===false){setPending(null);forgetCommonMemoryIntent(intent.requestId);refreshIntents();}
      }
      throw e;
    }
  };
  const next=plan?.members.find(m=>m.status==='missing'&&!outcomes.some(o=>o.memoryId===m.memoryId&&['added','present'].includes(o.state)));
  return <section className="grid gap-3 rounded-xl border border-[var(--line)] p-3" data-testid="common-memory-projects">
    <h3 className="m-0 text-base">연결된 장기기억의 프로젝트 가져오기</h3>
    <p className="m-0 text-sm">선택한 기억에 연결된 GitHub 프로젝트를 이 기기에 가져옵니다. 이미 등록된 프로젝트는 유지합니다. 장기기억 내용을 공통기억에 가져오려면 공통기억의 ‘가져올 기억’에서 선택하세요.</p>
    {!open&&<button className={button} disabled={busy} onClick={()=>void run(async()=>{const [r,g]=await Promise.all([client.roots(),groupId?Promise.resolve({groups:[]}):client.list()]);setRoots(r.roots);setGroups(g.groups);setIntents(readCommonMemoryIntents().filter(i=>i.kind==='projects-add'&&i.scopeId===r.scopeId));setOpen(true);})}>이 기기의 누락 프로젝트 확인</button>}
    {open&&<fieldset className="grid gap-3" disabled={busy||!!pending||intents.length>0}>
      {!groupId&&<label>공통기억<select aria-label="프로젝트를 가져올 공통기억" className="min-h-11 w-full rounded-lg bg-[var(--surface)] p-2 text-base" value={group} onChange={e=>{setGroup(e.target.value);setPlan(null);}}><option value="">선택하세요</option>{groups.filter(g=>!g.state.archived).map(g=><option key={g.state.id} value={g.state.id}>{g.state.name}</option>)}</select></label>}
      <label>가져올 작업 루트<select aria-label="공통기억 프로젝트 작업 루트" className="min-h-11 w-full rounded-lg bg-[var(--surface)] p-2 text-base" value={root} onChange={e=>{setRoot(e.target.value);setPlan(null);}}><option value="">선택하세요</option>{roots.map(r=><option key={r.workspaceRootId} value={r.workspaceRootId}>{r.name}</option>)}</select></label>
      {!roots.length&&<p role="status">Mac 앱에서 작업 루트를 먼저 등록하세요.</p>}
      <button className={button} disabled={!root||!group} onClick={()=>void run(()=>preview())}>등록 상태·추가 계획 확인</button>
      {plan&&<><p role="status">등록됨 {plan.members.filter(m=>m.status==='present').length} · 추가 가능 {plan.members.filter(m=>m.status==='missing').length} · 확인 필요 {plan.members.filter(m=>!['present','missing'].includes(m.status)).length}</p>{plan.members.map(m=><article key={m.memoryId} className="rounded-lg border border-[var(--line)] p-3"><b>{m.name}</b><p className="m-0 text-sm">{outcomes.find(o=>o.memoryId===m.memoryId)?.message??m.message}</p>{m.githubUrl&&<p className="m-0 break-all text-xs">{m.githubUrl}</p>}</article>)}{next&&<><button className={button} onClick={()=>void run(()=>send({plan,requestId:commonMemoryUuid(),memoryId:next.memoryId}))}> {next.name} 추가 · Clone·기억 복원</button><button className={button} onClick={()=>void run(async()=>{for(const member of plan.members.filter(m=>m.status==='missing'&&!outcomes.some(o=>o.memoryId===m.memoryId&&['added','present'].includes(o.state)))){const r=await send({plan,requestId:commonMemoryUuid(),memoryId:member.memoryId});if(!r.outcomes.some((o:any)=>o.memoryId===member.memoryId&&['added','present'].includes(o.state)))break;}})}>추가 가능한 프로젝트 모두 가져오기</button></>}{!next&&<p role="status">추가 가능한 프로젝트의 처리가 끝났습니다. 확인이 필요한 항목은 기존 등록·GitHub 주소를 확인하세요.</p>}</>}
    </fieldset>}
    {intents.filter(i=>i.requestId!==pending?.requestId).map(i=><div key={i.requestId} role="status"><p>이전 프로젝트 추가 결과를 확인해야 합니다.</p><button className={button} disabled={busy} onClick={()=>void run(async()=>{const r=await client.projectAddStatus(i.requestId);if(r.state==='registered'){forgetCommonMemoryIntent(i.requestId);setIntents(old=>old.filter(v=>v.requestId!==i.requestId));onChanged?.();}else{const p=commonMemoryIntentPayload(i.requestId);if(p)setPending(p.input);setError('프로젝트 등록은 아직 미확정입니다. 원래 추가 요청의 결과를 확인하세요.');}})}>이전 추가 영수증 확인</button></div>)}
    {pending&&<><p role="status">{busy?'프로젝트 추가를 처리하고 있습니다. 결과를 기다려주세요.':`${plan?.members.find(m=>m.memoryId===pending.memoryId)?.name??'프로젝트'}의 추가를 완료하지 못했거나 결과가 미확정입니다. 같은 요청만 확인하며 다른 프로젝트는 추가하지 않습니다.`}</p><button className={button} disabled={busy} onClick={()=>void run(()=>send(pending))}>같은 프로젝트 추가 결과 확인</button></>}
    {error&&<p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
  </section>;
}
import {commonMemoryUuid} from './commonMemoryCrypto';
