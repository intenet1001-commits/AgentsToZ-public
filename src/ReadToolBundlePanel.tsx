import React,{useEffect,useId,useRef,useState} from 'react';
import {readToolBatchCopy} from './i18n';
import {useAppLanguage} from './useAppLanguage';
import {readToolBatchSelectionText,type ReadToolBatchRequester,type ReadToolBatchResponse} from './readToolBatchClient';
import type {Lang} from './i18n';
import type {ReadToolOperation} from './readToolBundle';
import type {WorkPackClient,WorkPackList} from './workPackClient';
import './ReadToolBundlePanel.css';

type Copy=ReturnType<typeof readToolBatchCopy>;
/** Either an ordinary plan or a work pack run; both keep their original request ID. */
interface PendingBatch {requestId:string;plan?:unknown;pack?:{guideId:string;values:Record<string,string>}}
type Choice='git'|'workroom'|'tester'|'report'|'memory';
const storageKey=(targetId:string,threadId:string)=>`agentstoz:read-batch:v1:${targetId}:${threadId}`;
/** The original request ID survives reloads so an uncertain start is read, never replayed. */
function loadPending(key:string):PendingBatch|null {
 try{const raw=JSON.parse(sessionStorage.getItem(key)??'null');if(!raw||typeof raw.requestId!=='string')return null;
  if(raw.plan&&typeof raw.plan==='object')return {requestId:raw.requestId,plan:raw.plan};
  if(raw.pack&&typeof raw.pack.guideId==='string'&&raw.pack.values&&typeof raw.pack.values==='object')return {requestId:raw.requestId,pack:{guideId:raw.pack.guideId,values:raw.pack.values}};
  return null;}catch{return null;}
}
function savePending(key:string,value:PendingBatch|null){try{if(value)sessionStorage.setItem(key,JSON.stringify(value));else sessionStorage.removeItem(key);}catch{/* The in-memory record still holds the request ID for this page. */}}
function planFor(choices:readonly Choice[],query:string){
 const steps:unknown[]=[];
 if(choices.includes('git'))steps.push({id:'git',input:{operation:'project.git.read'}});
 if(choices.includes('workroom'))steps.push({id:'workroom',input:{operation:'workroom.status.read'}});
 if(choices.includes('tester'))steps.push({id:'tester',input:{operation:'tester.status.read'}});
 if(choices.includes('tester')&&choices.includes('report'))steps.push({id:'report',input:{operation:'tester.report.read',runId:{stepId:'tester',field:'latest.runId'}},dependsOn:['tester'],condition:'on-report-present'});
 if(choices.includes('memory'))steps.push({id:'memory',input:{operation:'memory.reference.read',role:'dev',query:query.trim()}});
 return {steps};
}
const errorCode=(e:unknown)=>e&&typeof e==='object'&&'code'in e&&typeof e.code==='string'?e.code:e instanceof Error?e.message:'';
const serverRejected=(e:unknown)=>!!e&&typeof e==='object'&&(e as {serverRejected?:unknown}).serverRejected===true;
function message(copy:Copy,e:unknown):string {
 const code=errorCode(e);
 if(code==='READ_TOOL_DISABLED')return copy.disabled;
 if(/BUSY/.test(code))return copy.busy;
 if(/CONFLICT/.test(code))return copy.conflict;
 if(/READ_TOOL_QUERY/.test(code))return copy.queryInvalid;
 if(/BATCH_UNAVAILABLE|READ_EXECUTION_MISSING/.test(code))return copy.missing;
 if(/EXPIRED/.test(code))return copy.expired;
 if(/INVALIDATED|CHANGED|TARGET/.test(code))return copy.invalid;
 if(!serverRejected(e))return copy.uncertain;
 return copy.failed;
}
const settled=(state:string)=>!['pending','running'].includes(state);

/** Receipt and accepted outputs of one batch. Rendering grants no execution or send authority. */
export function ReadToolBatchResultView({value,language='ko',busy=false,onRefresh,onCancel}:{value:ReadToolBatchResponse;language?:Lang;busy?:boolean;onRefresh?:()=>void;onCancel?:()=>void}){
 const copy=readToolBatchCopy(language),[selected,setSelected]=useState<string[]>([]),[notice,setNotice]=useState(''),[error,setError]=useState('');
 const outputs=value.result?.outputs??[];
 useEffect(()=>{setSelected(value.result?.outputs.map(o=>o.stepId)??[]);setNotice('');setError('');},[value.batch.runId,value.result?.id]);
 const time=(at:number)=>new Date(at).toLocaleString(language==='ko'?'ko-KR':'en-US');
 const copySelection=async()=>{
  setNotice('');setError('');if(!selected.length){setError(copy.selectResult);return;}
  let text:string;try{text=readToolBatchSelectionText(value,selected);}catch(e){const code=errorCode(e);setError(/EXPIRED|PAYLOAD/.test(code)?copy.expired:/INVALIDATED/.test(code)?copy.invalid:copy.failed);return;}
  try{await navigator.clipboard.writeText(text);setNotice(copy.copied);}catch{setError(copy.copyFailed);}
 };
 return <div className="read-batch-result" data-testid="read-batch-result" data-state={value.batch.state}>
  <p role="status" aria-live="polite"><strong>{copy.states[value.batch.state]}</strong> · {copy.request} <code>{value.batch.requestId}</code></p>
  {value.batch.state==='unknown'&&<p className="read-batch-note">{copy.uncertain}</p>}
  {value.payload==='unavailable'&&<p className="read-batch-note">{copy.payloadGone}</p>}
  {value.completion&&<p className="read-batch-completion" data-testid="read-batch-completion" data-complete={value.completion.complete}><strong>{copy.completion}</strong> · {value.completion.complete?copy.complete:copy.incomplete}</p>}
  <ol className="read-batch-stages">{value.batch.stages.map(stage=>{
   const output=outputs.find(o=>o.stepId===stage.id);
   return <li key={stage.id} data-stage={stage.id} data-state={stage.state}>
    <div className="read-batch-stage-head">
     {output?<label><input type="checkbox" checked={selected.includes(stage.id)} disabled={busy} onChange={e=>setSelected(prior=>e.target.checked?[...prior,stage.id]:prior.filter(id=>id!==stage.id))}/>{copy[stageLabel(stage.operation)]}</label>:<span>{copy[stageLabel(stage.operation)]}</span>}
     <span className="read-batch-state">{copy.states[stage.state]}</span>
    </div>
    <dl>
     {stage.availability&&<div><dt>{copy.availability}</dt><dd>{copy.availabilities[stage.availability]}</dd></div>}
     {stage.freshness&&<div><dt>{copy.freshness}</dt><dd>{copy.freshnesses[stage.freshness]}</dd></div>}
     {stage.observedAt!==undefined&&<div><dt>{copy.observed}</dt><dd><time dateTime={new Date(stage.observedAt).toISOString()}>{time(stage.observedAt)}</time></dd></div>}
     {stage.errorCode&&<div><dt>{copy.error}</dt><dd><code>{stage.errorCode}</code></dd></div>}
    </dl>
    {output&&output.observation.summary.length>0&&<ul>{output.observation.summary.map((line,index)=><li key={index}>{line}</li>)}</ul>}
    {output&&output.observation.limits.length>0&&<ul className="read-batch-limits">{output.observation.limits.map((line,index)=><li key={index}>{line}</li>)}</ul>}
   </li>;
  })}</ol>
  {error&&<p role="alert" className="read-batch-error">{error}</p>}
  {notice&&<p role="status" aria-live="polite">{notice}</p>}
  <div className="read-batch-actions">
   {onRefresh&&<button type="button" disabled={busy} onClick={onRefresh}>{copy.refresh}</button>}
   {onCancel&&!settled(value.batch.state)&&<button type="button" disabled={busy} onClick={onCancel}>{copy.cancel}</button>}
   {outputs.length>0&&<button type="button" data-testid="read-batch-copy" disabled={busy||!selected.length} onClick={()=>void copySelection()}>{copy.copy}</button>}
  </div>
 </div>;
}
const OPERATION_LABEL:Record<ReadToolOperation,Choice>={'project.git.read':'git','workroom.status.read':'workroom','tester.status.read':'tester','tester.report.read':'report','memory.reference.read':'memory'};
const stageLabel=(operation:ReadToolOperation):Choice=>OPERATION_LABEL[operation];

/** Phase 2 entry on an exact existing local DEV thread. The host owns admission, budgets and receipts. */
export function ReadToolBundlePanel({targetId,threadId,visible,supported,request,packs,disabled=false}:{targetId:string;threadId?:string;visible:boolean;supported:boolean;request?:ReadToolBatchRequester;packs?:WorkPackClient;disabled?:boolean}){
 const [language]=useAppLanguage(),copy=readToolBatchCopy(language),id=useId();
 const key=threadId?storageKey(targetId,threadId):'';
 const [open,setOpen]=useState(false),[activity,setActivity]=useState<'start'|'read'|'cancel'|null>(null),[error,setError]=useState('');
 const busy=activity!==null;
 const [value,setValue]=useState<ReadToolBatchResponse|null>(null),[pending,setPending]=useState<PendingBatch|null>(null);
 const [choices,setChoices]=useState<Choice[]>(['git','workroom','tester','report']),[query,setQuery]=useState('');
 const [packList,setPackList]=useState<WorkPackList|null>(null),[packId,setPackId]=useState(''),[packQuery,setPackQuery]=useState(''),[notice,setNotice]=useState('');
 const [saveCommand,setSaveCommand]=useState(''),[saveQuery,setSaveQuery]=useState(false),[packBusy,setPackBusy]=useState(false);
 const dialog=useRef<HTMLDialogElement>(null),button=useRef<HTMLButtonElement>(null),controller=useRef<AbortController|null>(null),generation=useRef(0),live=useRef(true);
 const latest=useRef({key,visible,supported});latest.current={key,visible,supported};
 const ready=!!request&&supported&&!!threadId;
 const stop=()=>{generation.current++;controller.current?.abort();setActivity(null);};
 const close=()=>{stop();setOpen(false);};
 useEffect(()=>{live.current=true;return()=>{live.current=false;generation.current++;controller.current?.abort();};},[]);
 useEffect(()=>{close();setValue(null);setError('');setPending(key?loadPending(key):null);},[key,visible,supported]);
 useEffect(()=>{if(open)dialog.current?.showModal();else if(dialog.current?.open){dialog.current.close();if(button.current?.isConnected)button.current.focus();}},[open]);
 const call=async(operation:'batch.start'|'batch.read'|'batch.cancel',record:PendingBatch)=>{
  if(!request||!threadId||!ready)return;
  controller.current?.abort();const abort=new AbortController();controller.current=abort;const mine=++generation.current,origin=key;setActivity(operation==='batch.start'?'start':operation==='batch.read'?'read':'cancel');setError('');setNotice('');
  const current=()=>live.current&&!abort.signal.aborted&&mine===generation.current&&latest.current.key===origin&&latest.current.visible&&latest.current.supported;
  const ref={targetId,threadId,requestId:record.requestId};
  try{
   const pack=record.pack;
   const result=await request(operation==='batch.cancel'?{operation,...ref}:pack?(operation==='batch.start'?{operation:'pack.run',...ref,guideId:pack.guideId,values:pack.values}:{operation:'pack.read',...ref,guideId:pack.guideId})
    :operation==='batch.start'?{operation,...ref,plan:record.plan}:{operation,...ref},abort.signal);
   if(!current())return;setValue(result);
  }catch(e){
   if(!current())return;const code=errorCode(e);
   // Nothing durable exists for a refused start or a missing receipt; keep the ID for anything uncertain.
   if(serverRejected(e)&&(operation==='batch.start'&&/^(?:READ_TOOL_DISABLED|READ_TOOL_[A-Z_]*INPUT|READ_TOOL_QUERY|READ_TOOL_STAGES|READ_TOOL_DEPENDENCY|PROJECT_STATE_BUSY|READ_EXECUTION_BUSY|WORK_PACKS?_[A-Z_]+)$/.test(code)||/BATCH_UNAVAILABLE|READ_EXECUTION_MISSING/.test(code))){savePending(origin,null);setPending(null);setValue(null);}
   setError(message(copy,e));
  }finally{if(current())setActivity(null);}
 };
 const loadPacks=async()=>{
  if(!packs)return;
  try{const list=await packs.list();if(!live.current)return;setPackList(list);
   setPackId(prior=>list.packs.some(p=>p.guideId===prior&&p.state==='reviewed')?prior:list.packs.find(p=>p.state==='reviewed')?.guideId??'');
   setSaveCommand(prior=>list.commands.some(c=>c.guideId===prior)?prior:list.commands[0]?.guideId??'');}
  catch{if(live.current)setError(copy.packLoadFailed);}
 };
 const show=()=>{setOpen(true);setError('');setNotice('');const record=key?loadPending(key):null;setPending(record);if(record)void call('batch.read',record);void loadPacks();};
 const chosenPack=packList?.packs.find(p=>p.guideId===packId);
 useEffect(()=>{setPackQuery(chosenPack?.query?.default??'');},[packId,chosenPack?.definitionRevision]);
 const runPack=()=>{
  if(busy||!ready||!chosenPack||chosenPack.state!=='reviewed')return;
  const values:Record<string,string>=chosenPack.query&&packQuery.trim()?{query:packQuery.trim()}:{};
  const record={requestId:crypto.randomUUID(),pack:{guideId:chosenPack.guideId,values}};
  savePending(key,record);setPending(record);setValue(null);void call('batch.start',record);
 };
 const savePack=async()=>{
  if(!packs||!packList||!pending?.plan||!saveCommand||packBusy)return;
  setPackBusy(true);setError('');setNotice('');
  try{const list=await packs.save({expectedRevision:packList.revision,guideId:saveCommand,plan:pending.plan,...(saveQuery?{queryInput:true}:{})});if(!live.current)return;setPackList(list);setPackId(saveCommand);setNotice(copy.packSaved);}
  catch(e){if(!live.current)return;setError(/CONFLICT/.test(errorCode(e))?copy.packConflict:message(copy,e));void loadPacks();}
  finally{if(live.current)setPackBusy(false);}
 };
 const disablePack=async()=>{
  if(!packs||!packList||!chosenPack||packBusy)return;
  setPackBusy(true);setError('');setNotice('');
  try{const list=await packs.disable({expectedRevision:packList.revision,guideId:chosenPack.guideId});if(!live.current)return;setPackList(list);setNotice(copy.packDisabled);}
  catch(e){if(!live.current)return;setError(/CONFLICT/.test(errorCode(e))?copy.packConflict:message(copy,e));void loadPacks();}
  finally{if(live.current)setPackBusy(false);}
 };
 const planHasMemory=!!(pending?.plan as {steps?:{input?:{operation?:string}}[]}|undefined)?.steps?.some(step=>step.input?.operation==='memory.reference.read');
 const run=()=>{
  if(busy||!ready)return;
  if(!choices.length){setError(copy.selectStep);return;}
  if(choices.includes('memory')&&!query.trim()){setError(copy.queryHint);return;}
  const record={requestId:crypto.randomUUID(),plan:planFor(choices,query)};
  savePending(key,record);setPending(record);setValue(null);void call('batch.start',record);
 };
 const fresh=()=>{stop();savePending(key,null);setPending(null);setValue(null);setError('');};
 const toggle=(choice:Choice,on:boolean)=>setChoices(prior=>on?[...prior,choice]:prior.filter(c=>c!==choice&&(choice!=='tester'||c!=='report')));
 const option=(choice:Choice,extra?:boolean)=><label key={choice}><input type="checkbox" checked={choices.includes(choice)} disabled={busy||extra===false} onChange={e=>toggle(choice,e.target.checked)}/>{copy[choice]}</label>;
 return <div className="read-batch-tools" data-testid="read-batch-tools">
  <button ref={button} type="button" data-testid="read-batch-open" disabled={disabled||!ready} title={!ready?copy.unsupported:undefined} onClick={show}>{copy.title}</button>
  <dialog ref={dialog} className="read-batch-dialog" aria-labelledby={id+'-title'} onCancel={event=>{event.preventDefault();close();}} onClose={()=>{if(open)close();}}>
   <header><h3 id={id+'-title'}>{copy.heading}</h3><button type="button" autoFocus aria-label={copy.close} onClick={close}>×</button></header>
   <p>{copy.intro}</p>
   {!pending&&packs&&<fieldset className="read-batch-packs" disabled={busy||packBusy}><legend>{copy.packs}</legend>
    <small>{copy.packHint}</small>
    {packList&&!packList.packs.length&&<p className="read-batch-note">{copy.packNone}</p>}
    {packList&&packList.packs.length>0&&<>
     <label>{copy.packChoose}<select data-testid="read-batch-pack" value={packId} onChange={e=>setPackId(e.target.value)}>
      {packList.packs.map(p=><option key={p.guideId} value={p.guideId} disabled={p.state!=='reviewed'}>{(p.title||p.guideId)+(p.state==='reviewed'?'':` · ${copy.packStates[p.state]}`)}</option>)}
     </select></label>
     {chosenPack?.query&&<label className="read-batch-query">{copy.query}<input type="text" value={packQuery} maxLength={300} onChange={e=>setPackQuery(e.target.value)}/></label>}
     <div className="read-batch-actions"><button type="button" data-testid="read-batch-pack-run" disabled={!chosenPack||chosenPack.state!=='reviewed'} onClick={runPack}>{copy.packRun}</button>
      {chosenPack&&chosenPack.state!=='disabled'&&chosenPack.state!=='orphan'&&<button type="button" onClick={()=>void disablePack()}>{copy.packDisable}</button>}</div>
    </>}
   </fieldset>}
   {!pending&&<fieldset disabled={busy}><legend>{copy.steps}</legend>
    {option('git')}{option('workroom')}{option('tester')}{option('report',choices.includes('tester'))}{option('memory')}
    {choices.includes('memory')&&<label className="read-batch-query">{copy.query}<input type="text" value={query} maxLength={300} aria-describedby={id+'-query-hint'} onChange={e=>setQuery(e.target.value)}/><small id={id+'-query-hint'}>{copy.queryHint}</small></label>}
   </fieldset>}
   {busy&&<p role="status" aria-live="polite">{activity==='start'?copy.running:copy.reading}</p>}
   {error&&<p role="alert" className="read-batch-error">{error}</p>}
   {pending&&!value&&!busy&&<p className="read-batch-note">{copy.request} <code>{pending.requestId}</code></p>}
   {value&&<ReadToolBatchResultView value={value} language={language} busy={busy} onRefresh={pending?()=>void call('batch.read',pending):undefined} onCancel={pending?()=>void call('batch.cancel',pending):undefined}/>}
   {notice&&<p role="status" aria-live="polite">{notice}</p>}
   {packs&&packList&&value&&!!pending?.plan&&settled(value.batch.state)&&<fieldset className="read-batch-packs" data-testid="read-batch-pack-save" disabled={packBusy}><legend>{copy.packSave}</legend>
    <small>{copy.packSaveHint}</small>
    {!packList.commands.length?<p className="read-batch-note">{copy.noCommands}</p>:<>
     <label>{copy.packCommand}<select value={saveCommand} onChange={e=>setSaveCommand(e.target.value)}>{packList.commands.map(c=><option key={c.guideId} value={c.guideId}>{c.title||c.guideId}</option>)}</select></label>
     {planHasMemory&&<label><input type="checkbox" checked={saveQuery} onChange={e=>setSaveQuery(e.target.checked)}/>{copy.packQueryInput}</label>}
     <div className="read-batch-actions"><button type="button" onClick={()=>void savePack()}>{copy.packSaveButton}</button></div>
    </>}
   </fieldset>}
   <footer>
    {pending&&!value&&<button type="button" disabled={busy} onClick={()=>void call('batch.read',pending)}>{copy.refresh}</button>}
    {/* An unconfirmed start keeps its request ID: check it first instead of discarding it. */}
    {pending&&value&&<button type="button" disabled={busy||!settled(value.batch.state)} onClick={fresh}>{copy.newRun}</button>}
    {!pending&&<button type="button" data-testid="read-batch-run" disabled={busy||!choices.length} onClick={run}>{copy.run}</button>}
    <button type="button" onClick={close}>{copy.close}</button>
   </footer>
  </dialog>
 </div>;
}
