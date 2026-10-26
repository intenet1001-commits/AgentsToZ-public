import React,{useEffect,useRef,useState} from 'react';
import {isTauri} from '@tauri-apps/api/core';
import {createCommonMemoryClient,commonMemoryHttpTransport,type CommonMemoryClient} from './commonMemoryClient';
import {forgetProjectCommonMemoryLink,readProjectCommonMemoryLinks} from './commonMemoryEntrypoints';
const defaultClient=createCommonMemoryClient(commonMemoryHttpTransport(isTauri()?'http://127.0.0.1:3001/api/common-memory':undefined));
/** One project-links answer. The memory ID and the version counters are support detail: the ID sits under 「고급 정보」
 *  (it backs the cross-Mac explanation), and a group's goal shows only when it says more than its name.
 *  With onOpenGroup each group opens by itself, so the third group is not reached through the list. */
export function ProjectCommonMemoryLinksView({result,projectName,onOpenGroup}:{result:any;projectName?:string;onOpenGroup?:(groupId:string)=>void}){
 return <>
 <p className="my-2">프로젝트·장기기억 이름: <b>{result.name===result.memoryId&&projectName?projectName:result.name}</b></p>
 {result.warning&&<p role="status" className="my-2 text-[var(--ink-3)]">{result.warning}</p>}
 {result.groups.length>0&&<p className="m-0 text-xs text-[var(--ink-3)]">연결된 공통기억 {result.groups.length}개</p>}
 <div className="mt-2 grid gap-2">{result.groups.map((g:any)=><article key={g.id} className="flex items-start justify-between gap-2 rounded-lg bg-[var(--sunken)] p-3"><div className="min-w-0"><b className="break-words">{g.name}</b>{typeof g.goal==='string'&&g.goal.trim()&&g.goal.trim()!==String(g.name??'').trim()&&<p className="my-1 break-words">{g.goal}</p>}<p className="m-0 mt-1 text-xs">{g.status}</p></div>{onOpenGroup&&typeof g.id==='string'&&<button type="button" data-testid="project-common-memory-open-group" aria-label={`공통기억 「${g.name}」 열기`} className="min-h-11 shrink-0 rounded-lg border border-[var(--line)] px-3" onClick={()=>onOpenGroup(g.id)}>열기</button>}</article>)}</div>
 {!result.groups.length&&<p className="my-2 text-[var(--ink-3)]">연결된 공통기억이 없습니다.</p>}
 <details className="mt-2 text-xs text-[var(--ink-3)]"><summary className="flex min-h-11 cursor-pointer items-center">고급 정보</summary><p className="m-0 break-all">장기기억 ID: {result.memoryId??'아직 준비되지 않음'}</p><p className="m-0 mt-1">폴더 이름·위치는 기기마다 달라도 같은 기억 ID로 연결합니다.</p></details>
 </>;
}
/** memoryId, when known, asks the links by long-term memory; onManage receives the memoryId so the tab opens on its group,
 *  and a group's own 「열기」 adds that group's ID so the tab opens on exactly it. */
export function ProjectCommonMemoryLinks({portId,memoryId,projectName,onManage,client=defaultClient}:{portId:string;memoryId?:string;projectName?:string;onManage?:(memoryId?:string,groupId?:string)=>void;client?:CommonMemoryClient}){
 const [result,setResult]=useState<any>(null),[error,setError]=useState(''),[reload,setReload]=useState(0);
 const memoryRef=useRef(memoryId);memoryRef.current=memoryId;
 useEffect(()=>{let active=true;setResult(null);setError('');void readProjectCommonMemoryLinks(client.request,{portId,memoryId:memoryRef.current}).then(r=>{if(active)setResult(r);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[portId,client,reload]);
 return <section data-testid="project-common-memory-links" className="mb-3 rounded-xl border border-[var(--line)] p-3 text-sm text-[var(--ink)]"><strong>프로젝트 기억 연결</strong>
 {error?<p role="status">{error}<button className="ml-2 min-h-11 underline" onClick={()=>{forgetProjectCommonMemoryLink(portId);setReload(n=>n+1);}}>다시 확인</button></p>:!result?<p role="status">장기기억 이름과 공통기억 연결 확인 중…</p>:<ProjectCommonMemoryLinksView result={result} projectName={projectName} onOpenGroup={onManage&&(groupId=>onManage(result?.memoryId??memoryId,groupId))}/>}
 {onManage&&<button type="button" className="mt-2 min-h-11 rounded-lg border border-[var(--line)] px-3" onClick={()=>onManage(result?.memoryId??memoryId)}>공통기억 연결·관리</button>}</section>;
}
