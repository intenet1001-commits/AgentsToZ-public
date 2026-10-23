import React,{useEffect,useRef,useState} from 'react';
import {isTauri} from '@tauri-apps/api/core';
import {createCommonMemoryClient,commonMemoryHttpTransport,type CommonMemoryClient} from './commonMemoryClient';
import {forgetProjectCommonMemoryLink,readProjectCommonMemoryLinks} from './commonMemoryEntrypoints';
const defaultClient=createCommonMemoryClient(commonMemoryHttpTransport(isTauri()?'http://127.0.0.1:3001/api/common-memory':undefined));
/** memoryId, when known, asks the links by long-term memory; onManage receives the memoryId so the tab opens on its group. */
export function ProjectCommonMemoryLinks({portId,memoryId,projectName,onManage,client=defaultClient}:{portId:string;memoryId?:string;projectName?:string;onManage?:(memoryId?:string)=>void;client?:CommonMemoryClient}){
 const [result,setResult]=useState<any>(null),[error,setError]=useState(''),[reload,setReload]=useState(0);
 const memoryRef=useRef(memoryId);memoryRef.current=memoryId;
 useEffect(()=>{let active=true;setResult(null);setError('');void readProjectCommonMemoryLinks(client.request,{portId,memoryId:memoryRef.current}).then(r=>{if(active)setResult(r);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[portId,client,reload]);
 return <section data-testid="project-common-memory-links" className="mb-3 rounded-xl border border-[var(--line)] p-3 text-sm text-[var(--ink)]"><strong>프로젝트 기억 연결</strong>
 {error?<p role="status">{error}<button className="ml-2 min-h-11 underline" onClick={()=>{forgetProjectCommonMemoryLink(portId);setReload(n=>n+1);}}>다시 확인</button></p>:!result?<p role="status">장기기억 이름과 공통기억 연결 확인 중…</p>:<>
 <p className="my-2">프로젝트·장기기억 이름: <b>{result.name===result.memoryId&&projectName?projectName:result.name}</b></p><p className="break-all text-xs text-[var(--ink-3)]">장기기억 ID: {result.memoryId??'아직 준비되지 않음'}</p>
 <div className="mt-2 grid gap-2">{result.groups.map((g:any)=><article key={g.id} className="rounded-lg bg-[var(--sunken)] p-3"><b>공통기억 · {g.name}</b><p className="my-1">{g.goal}</p><p className="text-xs">{g.status} · 수정 {g.version}{g.knowledgeRevision?` · 항목 수정 ${g.knowledgeRevision}`:''}</p></article>)}</div>
 {!result.groups.length&&<p className="my-2 text-[var(--ink-3)]">연결된 공통기억이 없습니다.</p>}<p className="mt-2 text-xs text-[var(--ink-3)]">폴더 이름·위치는 기기마다 달라도 같은 기억 ID로 연결합니다.</p>
 </>}{onManage&&<button type="button" className="mt-2 min-h-11 rounded-lg border border-[var(--line)] px-3" onClick={()=>onManage(result?.memoryId??memoryId)}>공통기억 연결·관리</button>}</section>;
}
