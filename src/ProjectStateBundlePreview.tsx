import React,{useEffect,useId,useRef,useState} from 'react';
import {projectStateCopy} from './i18n';
import {useAppLanguage} from './useAppLanguage';
import type {ProjectStatePrepared,ProjectStatePreviewBundle,ProjectStateRequester,ProjectStateSectionId} from './projectStateBundleClient';
import './ProjectStateBundlePreview.css';

export function ProjectStateBundlePreview({targetId,contextKey,visible,supported,request,onAttach,disabled=false}:{targetId:string;contextKey:string;visible:boolean;supported:boolean;request?:ProjectStateRequester;onAttach:(prepared:ProjectStatePrepared,sections:ProjectStateSectionId[])=>void;disabled?:boolean}){
 const [language]=useAppLanguage(),copy=projectStateCopy(language),id=useId();
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[bundle,setBundle]=useState<ProjectStatePreviewBundle|null>(null),[error,setError]=useState('');
 const [memory,setMemory]=useState(false),[query,setQuery]=useState(''),[selected,setSelected]=useState<ProjectStateSectionId[]>(['git','workroom','tester']);
 const dialog=useRef<HTMLDialogElement>(null),button=useRef<HTMLButtonElement>(null),controller=useRef<AbortController|null>(null),generation=useRef(0),active=useRef(false),live=useRef(true);
 const latest=useRef({targetId,contextKey,visible,supported,request});latest.current={targetId,contextKey,visible,supported,request};
 const close=()=>{active.current=false;generation.current++;controller.current?.abort();setOpen(false);setBusy(false);};
 useEffect(()=>{live.current=true;return()=>{live.current=false;active.current=false;generation.current++;controller.current?.abort();};},[]);
 useEffect(()=>{close();setBundle(null);setError('');},[targetId,contextKey,visible,supported]);
 useEffect(()=>{const changed=()=>{if(document.hidden)close();};document.addEventListener('visibilitychange',changed);return()=>document.removeEventListener('visibilitychange',changed);},[]);
 useEffect(()=>{if(open){dialog.current?.showModal();}else if(dialog.current?.open){dialog.current.close();if(button.current?.isConnected)button.current.focus();}},[open]);
 const message=(e:unknown)=>{const code=e&&typeof e==='object'&&'code'in e&&typeof e.code==='string'?e.code:e instanceof Error?e.message:'';return /INPUT_LIMIT|TOO_LARGE/.test(code)?copy.limit:code==='PROJECT_STATE_BUSY'?copy.busy:code==='PROJECT_STATE_TIMEOUT'?copy.timeout:/EXPIRED/.test(code)?copy.expired:/INVALIDATED|CHANGED|STALE/i.test(code)?copy.invalid:copy.failed;};
 const run=async(operation:'preview'|'prepare')=>{
  if(!request||!supported||busy||!visible||document.hidden)return;
  if(operation==='preview'&&memory&&!query.trim()){setError(copy.queryHint);return;}
  if(operation==='prepare'&&(!bundle||!selected.length)){setError(copy.selectOne);return;}
  if(operation==='prepare'&&bundle&&Date.now()>=bundle.expiresAt){setError(copy.expired);return;}
  controller.current?.abort();const abort=new AbortController();controller.current=abort;const mine=++generation.current,origin=contextKey;setBusy(true);setError('');
  const current=()=>live.current&&active.current&&!abort.signal.aborted&&mine===generation.current&&latest.current.contextKey===origin&&latest.current.targetId===targetId&&latest.current.visible&&latest.current.supported&&!document.hidden;
  try{
   const result=await request(operation==='preview'?{operation,targetId,...(memory?{memoryQuery:query.trim()}:{})}:{operation,targetId,bundleId:bundle!.id,sections:selected},abort.signal);
   if(!current())return;
   if('bundle'in result){setBundle(result.bundle);setSelected(result.bundle.observations.filter(o=>o.id!=='memory'||memory).map(o=>o.id));}
   else{onAttach(result.prepared,[...selected]);close();}
  }catch(e){if(current())setError(message(e));}finally{if(current())setBusy(false);}
 };
 const show=()=>{active.current=true;setOpen(true);setBundle(null);setError('');void run('preview');};
 const sourceName=(s:ProjectStateSectionId)=>s==='memory'?copy.memoryLabel:copy[s];
 const time=(value:number)=>new Date(value).toLocaleString(language==='ko'?'ko-KR':'en-US');
 return <div className="project-state-tools" data-testid="project-state-tools">
  <button ref={button} type="button" disabled={disabled||!supported||!request} title={!supported||!request?copy.unsupported:undefined} onClick={show}>{copy.title}</button>
  {(!supported||!request)&&<small>{copy.unsupported}</small>}
  <dialog ref={dialog} className="project-state-preview" aria-labelledby={id+'-title'} onCancel={event=>{event.preventDefault();close();}} onClose={()=>{if(active.current)close();}}>
   <header><h3 id={id+'-title'}>{copy.preview}</h3><button type="button" autoFocus aria-label={copy.close} onClick={close}>×</button></header>
   <p>{copy.readOnly}</p>
   <label className="project-state-memory"><input type="checkbox" checked={memory} disabled={busy} onChange={e=>{setMemory(e.target.checked);setBundle(null);}}/>{copy.memory}</label>
   {memory&&<label>{copy.query}<input type="text" aria-label={copy.query} value={query} maxLength={300} aria-describedby={id+'-memory-hint'} onChange={e=>{setQuery(e.target.value);setBundle(null);}} disabled={busy}/><small id={id+'-memory-hint'}>{copy.queryHint}</small></label>}
   <button type="button" disabled={busy||memory&&!query.trim()} onClick={()=>void run('preview')}>{copy.collect}</button>
   {busy&&<p role="status" aria-live="polite">{bundle?copy.preparing:copy.collecting}</p>}
   {error&&<p role="alert" className="project-state-error">{error}</p>}
   {bundle&&<div data-testid="project-state-result"><p role="status" data-state={bundle.state}>{copy[bundle.state]} · {time(bundle.collectedAt)}</p>
    <fieldset disabled={busy}><legend>{copy.selection}</legend>{bundle.observations.map(observation=><section key={observation.id} className="project-state-source" data-source={observation.id}>
     <label><input type="checkbox" checked={selected.includes(observation.id)} onChange={e=>setSelected(prior=>e.target.checked?[...prior,observation.id]:prior.filter(s=>s!==observation.id))}/>{sourceName(observation.id)}</label>
     <dl><div><dt>{copy.availability}</dt><dd>{copy[observation.availability]}</dd></div><div><dt>{copy.freshness}</dt><dd>{copy[observation.freshness]}</dd></div><div><dt>{copy.observed}</dt><dd><time dateTime={new Date(observation.observedAt).toISOString()}>{time(observation.observedAt)}</time></dd></div>{observation.sourceProducedAt!==undefined&&<div><dt>{copy.produced}</dt><dd>{time(observation.sourceProducedAt)}</dd></div>}</dl>
     {observation.summary.length>0&&<ul>{observation.summary.map((line,index)=><li key={index}>{line}</li>)}</ul>}
     {observation.limits.length>0&&<div><strong>{copy.limitations}</strong><ul>{observation.limits.map((line,index)=><li key={index}>{line}</li>)}</ul></div>}
    </section>)}</fieldset>
   </div>}
   <footer><button type="button" onClick={close}>{copy.cancel}</button><button type="button" disabled={busy||!bundle||bundle.state==='invalidated'||!selected.length} onClick={()=>void run('prepare')}>{copy.add}</button></footer>
  </dialog>
 </div>;
}
