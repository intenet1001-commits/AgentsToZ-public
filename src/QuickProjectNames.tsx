import {useEffect,useState} from 'react';
import type {QuickLabel,QuickLabelInput,QuickLabelJob} from './agentRuntimeQuickLabels';
import {terminalLocalRequest} from './aiTerminalClient';
const path='/api/agent-runtime/quick-labels';
export function QuickProjectNames({items,onApply,onClose}:{items:QuickLabelInput[];onApply:(results:QuickLabel[])=>Promise<void>;onClose:()=>void}) {
 const [job,setJob]=useState<QuickLabelJob|null>(null);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
 useEffect(()=>{if(job?.state!=='running')return;let active=true;const timer=setInterval(()=>{void terminalLocalRequest(path,{operation:'read',id:job.id}).then(r=>{if(active)setJob(r)}).catch(e=>{if(active)setError(e.message)});},1000);return()=>{active=false;clearInterval(timer)};},[job?.id,job?.state]);
 const start=async()=>{setBusy(true);setError('');try{setJob(await terminalLocalRequest(path,{operation:'start',items}));}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false)}};
 return <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/35 p-4" role="dialog" aria-modal="true" aria-label="AI 이름 추천">
  <section className="max-h-[85vh] w-full max-w-xl overflow-auto rounded-2xl border border-zinc-700 bg-[var(--bg-card)] p-6 shadow-xl">
   <h2 className="text-lg font-semibold">AI 이름 추천</h2><p className="my-2 text-sm text-zinc-400">AI 작업 SDK가 선택된 {items.length}개 프로젝트의 이름과 설명으로 별명·카테고리를 추천합니다. 결과를 확인하고 적용하세요.</p>
   {!job&&<ul className="my-4 max-h-52 overflow-auto text-sm">{items.map(i=><li className="py-1" key={i.id}>{i.name}</li>)}</ul>}
   {job?.state==='running'&&<p role="status" className="my-5 text-sm">이름을 추천하고 있습니다…</p>}
   {(error||job?.error)&&<p role="alert" className="my-3 text-sm text-red-300">{error||job?.error}</p>}
   {job?.state==='completed'&&<table className="my-4 w-full text-left text-sm"><thead><tr><th>프로젝트</th><th>추천 별명</th><th>카테고리</th></tr></thead><tbody>{job.results.map(r=><tr className="border-t border-zinc-800" key={r.id}><td className="py-3">{items.find(i=>i.id===r.id)?.name}</td><td>{r.name}</td><td>{r.category}</td></tr>)}</tbody></table>}
   <div className="mt-5 flex justify-end gap-2">
    {job?.state==='running'?<button className="rounded-lg border border-zinc-700 px-4 py-2 text-sm" onClick={()=>void terminalLocalRequest(path,{operation:'cancel',id:job.id}).then(setJob).catch(e=>setError(e.message))}>작업 취소</button>:<button className="rounded-lg border border-zinc-700 px-4 py-2 text-sm" disabled={busy} onClick={onClose}>닫기</button>}
    {job?.state!=='running'&&<button disabled={busy||!items.length} className="rounded-lg bg-[var(--text-primary)] px-4 py-2 text-sm text-[var(--bg-base)] disabled:opacity-40" onClick={()=>{if(job?.state==='completed'){setBusy(true);void onApply(job.results).then(onClose).catch(e=>setError(e.message)).finally(()=>setBusy(false));}else void start();}}>{busy?'처리 중…':job?.state==='completed'?'추천 적용':'추천 시작'}</button>}
   </div>
  </section>
 </div>;
}
