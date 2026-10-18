import React,{useEffect,useRef,useState} from 'react';
import {useAppLanguage} from './useAppLanguage';
import {t} from './i18n';
import type {MetaMemoryRequester} from './metaCommonMemoryClient';
interface View {profileId:string;deviceId:string;memoryId:string;name:string;revision:string|null;prepared:boolean;savedAt:string|null;entries:{entryId:string;title:string;body:string}[];total:number;nextOffset:number|null;offset:number}
/** One visible device, explicit writes, and an exact retained request after a lost receipt or failed cloud backup. */
export function DeviceOperatingMemoryPanel({request,visible=true}:{request:MetaMemoryRequester;visible?:boolean}){
 const [lang]=useAppLanguage(),[memory,setMemory]=useState<View|null>(null),[title,setTitle]=useState(''),[body,setBody]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [pending,setPending]=useState<Record<string,unknown>|null>(null),[legacy,setLegacy]=useState<{id:string;name:string}[]|null>(null),[legacyNext,setLegacyNext]=useState<number|null>(null),[source,setSource]=useState<{id:string;name:string;entries:{id:string;title:string}[]}|null>(null),[plan,setPlan]=useState<any>(null);
 const [legacyAllowed,setLegacyAllowed]=useState(false);
 const serial=useRef(0),alive=useRef(true),lock=useRef(false);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;serial.current++;};},[]);
 const refresh=async(offset=0)=>{const seq=++serial.current;const r=await request({operation:'read',offset});if(alive.current&&seq===serial.current){setMemory(r.memory);setLegacyAllowed(r.legacyAvailable!==false);}};
 useEffect(()=>{if(!visible)return;const ctl=new AbortController(),seq=++serial.current;void request({operation:'read'},ctl.signal).then(r=>{if(!ctl.signal.aborted&&seq===serial.current){setMemory(r.memory);setLegacyAllowed(r.legacyAvailable!==false);}}).catch(e=>{if(!ctl.signal.aborted)setError(e.message);});return()=>ctl.abort();},[request,visible]);
 const operate=async(run:()=>Promise<void>)=>{if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await run();}catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e));}finally{lock.current=false;if(alive.current)setBusy(false);}};
 const save=()=>operate(async()=>{
  if(!memory)return;
  const payload=pending??(plan?{operation:'import-execute',plan,confirmed:true,requestId:crypto.randomUUID()}:{operation:'save',profileId:memory.profileId,deviceId:memory.deviceId,memoryId:memory.memoryId,expectedRevision:memory.revision,title,body,requestId:crypto.randomUUID()});
  setPending(payload);
  const result=await request(payload);
  if(!alive.current)return;
  setMemory(result.memory);setNotice(t(lang,result.backup?.backedUp?'savedCloud':'savedLocal'));
  if(result.backup?.backedUp){setPending(null);setTitle('');setBody('');setPlan(null);setSource(null);}
  if(result.sourceState==='retained-needs-review')setError('새 기억은 백업됐지만 이전 항목이 바뀌어 적용을 중지하지 않았습니다. 이전 로컬 기억을 검토하세요.');
 });
 const loadLegacy=(offset=0)=>operate(async()=>{const r=await request({operation:'legacy-list',offset});setLegacy(v=>offset?[...(v??[]),...r.memories]:r.memories);setLegacyNext(r.nextOffset);});
 const button={minHeight:44,padding:'8px 12px',border:'1px solid var(--line, #647480)',borderRadius:10,background:'var(--surface, transparent)',color:'inherit',cursor:'pointer'};
 return <section hidden={!visible} data-testid="device-operating-memory" style={{marginTop:20,padding:16,border:'1px solid var(--line, #647480)',borderRadius:16}}>
  <h3 style={{fontWeight:700}}>{t(lang,'deviceMemory')}{memory?.name?` · ${memory.name}`:''}</h3><p style={{fontSize:13,margin:'8px 0'}}>{t(lang,'deviceMemoryHelp')}</p>
  <div style={{display:'flex',flexWrap:'wrap',gap:8}}><button style={button} disabled={busy} onClick={()=>void operate(()=>refresh())}>{t(lang,'refresh')}</button><button style={button} disabled={busy||!memory?.prepared||!!pending} onClick={()=>void operate(async()=>{const r=await request({operation:'sync'});setMemory(r.memory);setNotice(r.current?t(lang,'savedCloud'):r.reason);})}>{t(lang,'syncMemory')}</button></div>
  {!memory?<p>{t(lang,'loading')}</p>:<>
   {memory.entries.length===0&&<p style={{marginTop:12}}>{t(lang,'emptyMemory')}</p>}
   {memory.entries.map(entry=><article key={entry.entryId} style={{marginTop:12,padding:12,border:'1px solid var(--line, #647480)',borderRadius:10}}><strong>{entry.title}</strong><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',marginTop:6}}>{entry.body}</p></article>)}
   <div style={{display:'flex',gap:8,marginTop:10}}>{memory.offset>0&&<button style={button} disabled={busy} onClick={()=>void operate(()=>refresh(Math.max(0,memory.offset-8)))}>←</button>}{memory.nextOffset!==null&&<button style={button} disabled={busy} onClick={()=>void operate(()=>refresh(memory.nextOffset!))}>{t(lang,'more')}</button>}</div>
   {!plan&&<fieldset disabled={busy||!!pending} style={{border:0,padding:0,marginTop:16,display:'grid',gap:8}}><label>{t(lang,'title')}<input aria-label={t(lang,'title')} maxLength={200} value={title} onChange={e=>setTitle(e.target.value)} style={{display:'block',width:'100%',padding:10,fontSize:16,color:'inherit',background:'transparent',border:'1px solid var(--line, #647480)',borderRadius:10}}/></label><label>{t(lang,'body')}<textarea aria-label={t(lang,'body')} maxLength={12000} rows={4} value={body} onChange={e=>setBody(e.target.value)} style={{display:'block',width:'100%',padding:10,fontSize:16,color:'inherit',background:'transparent',border:'1px solid var(--line, #647480)',borderRadius:10}}/></label></fieldset>}
   {!plan&&(pending||title.trim()&&body.trim())&&<button style={{...button,marginTop:10}} disabled={busy} onClick={()=>void save()}>{busy?t(lang,'loading'):pending?t(lang,'retry'):plan?t(lang,'confirmImport'):t(lang,'save')}</button>}
  </>}
  {legacyAllowed&&<details style={{marginTop:16}} onToggle={e=>{if(e.currentTarget.open&&legacy===null)void loadLegacy();}}><summary>{t(lang,'legacyMemory')}</summary><p style={{fontSize:13,margin:'8px 0'}}>{t(lang,'legacyHelp')}</p>
   {legacy?.length===0&&<p>이관할 이전 로컬 항목 없음</p>}
   {legacy?.map(group=><button key={group.id} style={button} disabled={busy||!!pending} onClick={()=>void operate(async()=>{const r=await request({operation:'legacy-read',groupId:group.id});setSource(r.memory);setPlan(null);})}>{group.name}</button>)}
   {legacyNext!==null&&<button style={button} disabled={busy} onClick={()=>void loadLegacy(legacyNext)}>{t(lang,'more')}</button>}
   {source?.entries.map(entry=><div key={entry.id} style={{marginTop:8}}><span>{entry.title}</span> <button style={button} disabled={busy||!!pending} onClick={()=>void operate(async()=>setPlan((await request({operation:'import-preview',groupId:source.id,entryId:entry.id})).plan))}>{t(lang,'preview')}</button></div>)}
   {plan&&<article style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',padding:12}}><strong>{plan.source.title} → {plan.target.name}</strong><p>{plan.source.body}</p><button style={button} disabled={busy} onClick={()=>void save()}>{busy?t(lang,'loading'):pending?t(lang,'retry'):t(lang,'confirmImport')}</button> <button style={button} disabled={!!pending} onClick={()=>setPlan(null)}>{t(lang,'cancel')}</button></article>}
  </details>}
  {notice&&<p role="status" style={{marginTop:12}}>{notice}</p>}{error&&<p role="alert" style={{marginTop:12,color:'var(--danger, #df8d75)'}}>{error}</p>}
 </section>;
}
