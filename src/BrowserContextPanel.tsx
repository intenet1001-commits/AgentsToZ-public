import {useEffect,useRef,useState} from 'react';
import {browserContextText,type Lang} from './i18n';
import {BROWSER_TEXT_LIMIT,browserContextUrl,buildBrowserContextAttachment,browserContextAttachmentBudget,type BrowserContextRequester,type BrowserSession,type BrowserSnapshot} from './browserContextClient';
import './BrowserContextPanel.css';
export interface BrowserContextPanelProps {lang?:Lang;request?:BrowserContextRequester;projects:{id:string;label:string}[];defaultProjectId?:string;onAttach?:(targetId:string,text:string)=>void;onClose:()=>void}
export function BrowserContextPanel({lang='ko',request,projects,defaultProjectId,onAttach,onClose}:BrowserContextPanelProps){
 const m=browserContextText(lang);
 const [target,setTarget]=useState(defaultProjectId&&projects.some(p=>p.id===defaultProjectId)?defaultProjectId:projects[0]?.id??'');
 const [url,setUrl]=useState('');const [available,setAvailable]=useState<boolean|null>(null);const [reason,setReason]=useState('');
 const [session,setSession]=useState<BrowserSession|null>(null);const [snapshot,setSnapshot]=useState<BrowserSnapshot|null>(null);
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');
 const [metadata,setMetadata]=useState(true);const [includeText,setIncludeText]=useState(false);const [text,setText]=useState('');const [links,setLinks]=useState<number[]>([]);const [screenshot,setScreenshot]=useState(false);
 const statusEpoch=useRef(0);
 const epoch=useRef(0),controller=useRef<AbortController|null>(null),owned=useRef<string|null>(null),dialog=useRef<HTMLDivElement>(null),urlInput=useRef<HTMLInputElement>(null),mounted=useRef(true),composing=useRef(false);
 const cleanup=async(id:string)=>{try{const r=await request?.({operation:'close',sessionId:id});if(r&&!r.success&&mounted.current)setError(m.cleanup);}catch{if(mounted.current)setError(m.cleanup);}};
 const cancel=()=>{epoch.current++;controller.current?.abort();controller.current=null;setBusy(false);};
 const clear=()=>{cancel();const id=owned.current;owned.current=null;if(id)void cleanup(id);setSession(null);setSnapshot(null);setText('');setLinks([]);setIncludeText(false);setNotice('');setError('');};
 const check=async()=>{const version=++statusEpoch.current;setAvailable(null);setReason('');if(!request){setAvailable(false);setReason(m.missing);return;}try{const r=await request({operation:'status'});if(!mounted.current||version!==statusEpoch.current)return;if(!r.success){setAvailable(false);setReason(r.error);return;}setAvailable(r.available===true);setReason(r.reason??(r.available?'':m.unavailable));}catch(e){if(mounted.current&&version===statusEpoch.current){setAvailable(false);setReason(String(e instanceof Error?e.message:e));}}};
 useEffect(()=>{mounted.current=true;const previous=document.activeElement as HTMLElement|null;urlInput.current?.focus();void check();return()=>{mounted.current=false;statusEpoch.current++;epoch.current++;controller.current?.abort();const id=owned.current;owned.current=null;if(id)void cleanup(id);previous?.focus();};},[request]);
 useEffect(()=>{if(target&&!projects.some(p=>p.id===target)){clear();setTarget('');}},[projects,target]);
 const perform=async(operation:'open'|'read')=>{
  if(!request||busy||!target)return;
  let validated='';try{if(operation==='open')validated=browserContextUrl(url);}catch{setError(m.policy);urlInput.current?.focus();return;}
  const version=++epoch.current;const c=new AbortController();controller.current=c;setBusy(true);setError('');setNotice('');
  try{
   if(operation==='open'){const old=owned.current;owned.current=null;setSession(null);setSnapshot(null);if(old)await cleanup(old);}
   const r=await request(operation==='open'?{operation:'open',url:validated}:{operation:'read',sessionId:session!.sessionId,screenshot},c.signal);
   if(!mounted.current||version!==epoch.current){if(r.success&&r.session)void cleanup(r.session.sessionId);return;}
   if(!r.success)throw new Error(r.error);
   if(operation==='open'){if(!r.session)throw new Error(lang==='ko'?'브라우저 세션을 찾지 못했습니다. 다시 열어 주세요.':'Missing browser session.');owned.current=r.session.sessionId;setSession(r.session);}
   else{if(!r.snapshot||r.snapshot.sessionId!==session?.sessionId)throw new Error(lang==='ko'?'브라우저 세션이 변경되었습니다. 다시 읽어 주세요.':'Browser session changed.');setSnapshot(r.snapshot);setText(r.snapshot.text);setLinks([]);setMetadata(true);setIncludeText(false);setIncludeText(false);}
  }catch(e){if(mounted.current&&version===epoch.current&&!c.signal.aborted)setError(e instanceof Error?e.message:String(e));}
  finally{if(mounted.current&&version===epoch.current){setBusy(false);controller.current=null;}}
 };
 const attachment=snapshot?buildBrowserContextAttachment(snapshot,{metadata,text:includeText?text:'',links}):'';
 const attachmentBudget=browserContextAttachmentBudget(attachment);
 const copy=async()=>{const version=epoch.current;try{await navigator.clipboard.writeText(attachment);if(mounted.current&&version===epoch.current)setNotice(m.copied);}catch(e){setError(e instanceof Error?e.message:String(e));}};
 return <div className="browser-context-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}>
  <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="browser-context-heading" className="browser-context-panel" data-testid="browser-context-panel" onKeyDown={e=>{
   if(e.key==='Escape'&&!composing.current&&!e.nativeEvent.isComposing){e.stopPropagation();onClose();}
   if(e.key==='Tab'&&!composing.current&&!e.nativeEvent.isComposing&&!e.altKey&&!e.ctrlKey&&!e.metaKey){const nodes=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]')??[]).filter(node=>node.getClientRects().length>0);if(nodes.length){e.preventDefault();const current=nodes.indexOf(document.activeElement as HTMLElement);nodes[(current+(e.shiftKey?-1:1)+nodes.length)%nodes.length]?.focus();}}
  }}>
   <header><h2 id="browser-context-heading">{m.title}</h2><button type="button" onClick={onClose}>{m.close}</button></header>
   <p className="browser-context-warning">{m.notice}</p>
   <label>{m.project}<select aria-label={m.project} value={target} onChange={e=>{clear();setTarget(e.target.value);}}><option value="">—</option>{projects.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
   {!projects.length&&<p role="status">{m.noTarget}</p>}
   <form onSubmit={e=>{e.preventDefault();if(!composing.current)void perform('open');}}>
    <label>{m.url}<input ref={urlInput} aria-label={m.url} value={url} maxLength={2048} placeholder="https://example.com/" onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onKeyDown={e=>{if(e.key==='Enter'&&(e.nativeEvent.isComposing||composing.current||e.keyCode===229))e.preventDefault();}} onChange={e=>{setUrl(e.target.value);if(session||busy)clear();}}/></label>
    <p className="browser-context-muted">{m.policy}</p>
    <div className="browser-context-actions"><button disabled={!available||busy||!target||!url.trim()} type="submit">{m.open}</button>{busy&&<button type="button" onClick={cancel}>{m.cancel}</button>}</div>
   </form>
   <p role="status" aria-live="polite">{busy?m.busy:available===null?m.checking:available?m.ready:`${m.unavailable}: ${reason}`}</p>
   {available===false&&<button type="button" onClick={()=>void check()}>{m.retry}</button>}
   {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
   {session&&<section><h3>{session.title}</h3><p className="browser-context-url">{session.url}</p><label className="browser-context-check"><input type="checkbox" checked={screenshot} onChange={e=>setScreenshot(e.target.checked)}/>{m.screenshot}</label><button type="button" disabled={busy} onClick={()=>void perform('read')}>{m.read}</button></section>}
   {!snapshot?<p className="browser-context-muted">{m.empty}</p>:<section data-testid="browser-context-review"><h3>{m.selection}</h3><p className="browser-context-muted">{m.capture}: {snapshot.capturedAt}</p>{snapshot.truncated&&<p>{m.truncated}</p>}
    <label className="browser-context-check"><input type="checkbox" checked={metadata} onChange={e=>setMetadata(e.target.checked)}/>{m.metadata}</label>
    <label className="browser-context-check"><input type="checkbox" checked={includeText} onChange={e=>setIncludeText(e.target.checked)}/>{m.body}</label>
    <textarea aria-label={m.body} value={text} maxLength={BROWSER_TEXT_LIMIT} onChange={e=>{setText(e.target.value);setNotice('');}}/>
    <span className="browser-context-muted">{text.length} / {BROWSER_TEXT_LIMIT}</span>
    {snapshot.links.length>0&&<fieldset><legend>{m.links}</legend>{snapshot.links.map((link,index)=><label key={index} className="browser-context-check browser-context-link"><input type="checkbox" checked={links.includes(index)} onChange={e=>setLinks(current=>e.target.checked?[...current,index]:current.filter(i=>i!==index))}/><span>{link.text}<small>{link.url}</small></span></label>)}</fieldset>}
    {snapshot.screenshotDataUrl&&<img alt={m.image} src={snapshot.screenshotDataUrl}/>}
    <p className="browser-context-muted" data-testid="browser-context-budget">{attachmentBudget.bytes.toLocaleString()} / {attachmentBudget.limit.toLocaleString()} {lang==='ko'?'바이트 (UTF-8)':'UTF-8 bytes'}{!attachmentBudget.attachable&&attachment?` · ${m.tooLarge}`:""}</p><div className="browser-context-actions"><button type="button" disabled={!attachment||busy} onClick={()=>void copy()}>{m.copy}</button><button type="button" disabled={!attachmentBudget.attachable||busy||!target||!onAttach} onClick={()=>{if(!attachmentBudget.attachable||!projects.some(p=>p.id===target))return;onAttach?.(target,attachment);setNotice(m.attached);}}>{m.attach}</button></div>
   </section>}
  </div>
 </div>;
}
