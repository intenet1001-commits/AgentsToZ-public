import {WorkroomBrowserError,type BrowserErrorCode} from './workroomBrowserErrorCodes';
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import type {BrowserRecovery,WorkroomBrowserRecovery} from './workroomBrowserRecovery';
import {discoverChromeProfiles} from './browserProfilesServer';
import {chromeDebugEndpoint,WorkroomCdpTransport,type BrowserCdp} from './workroomCdpTransport';
import {BROWSER_TAB_LIMIT,parseBrowserAgentRequest,parseWorkroomBrowserRequest,workroomBrowserUrl,type BrowserAgentRequest,type BrowserElement,type BrowserFrameSummary,type BrowserPage,type BrowserScreenshot,type BrowserScroll,type BrowserUnobservable,type BrowserWorkspace,type WorkroomBrowserRequest,type WorkroomBrowserResult,type BrowserActionState,type BrowserReceipt} from './workroomBrowserProtocol';

/** One frame of the attached page, as the observation that named it saw it. Its isolated world is the only place its
 * element references live. `stale` turns true when that frame navigates, loses its world or detaches. */
type FrameRef={session:string;frameId:string;context:number;stale:boolean};
/** One attached tab of the Workroom's own set: its CDP session, main-frame isolated world, and the cross-origin iframe
 * sessions that Chrome auto-attached under it (child session -> parent session). Nothing else in the browser is ever
 * attached. Its target probe (`discovery`), worlds and navigation count belong to this tab alone. */
type Tab={page:BrowserPage;session:string;frame?:string;context?:number;children:Map<string,string>;armed:Set<string>;navigations:number;discovery:boolean;arming?:boolean};
/** `tabs` is the Workroom's own tab set and `tab` its active tab (`state.page` is that tab's page). `allowed` limits a
 * built-in browser to the native pages this Workroom itself opened. */
type Binding={state:BrowserWorkspace;recoveryId?:string;cdp:BrowserCdp;endpoint:string;allowed?:Set<string>;tab?:Tab;tabs:Map<string,Tab>;frames:Map<string,FrameRef>;grant?:string;tail:Promise<unknown>;queued:number;receipts:Map<string,{fingerprint:string;state:BrowserActionState}>;off?:()=>void};
type Deps={runningSession:(id:string)=>{targetId:string}|null;profiles?:typeof discoverChromeProfiles;endpoint?:()=>Promise<string>;connect?:(endpoint:string)=>Promise<BrowserCdp>;recovery?:WorkroomBrowserRecovery;sleep?:(ms:number)=>Promise<void>;now?:()=>number};
/** Observation budgets. The main document keeps its original 80 elements and 12,000 characters; each child frame adds
 * at most 16 elements and 1,500 characters, for at most 6 frames. */
const MAIN_ELEMENTS=80,MAIN_TEXT=12000,FRAME_ELEMENTS=16,FRAME_TEXT=1500,MAX_FRAMES=6,MAX_CHILD_SESSIONS=16,SHADOW_CHECKS=8;
/** Screenshot bounds: the visible viewport (or one observed element) scaled to at most 1280px on its longer edge and
 * at most 360,000 base64 characters. */
const SHOT_EDGE=1280,SHOT_CHARS=360000,READ_MS=5000,WAIT_POLL_MS=150;
/** A list shows at most this many options, each value and label cut at this many characters (said, never silent). */
const OPTIONS=12,OPTION_TEXT=60;
/** A wait selector names only what an observation could show: tag, #id and .class parts joined by spaces or `>`. No
 * attribute, pseudo-class, :has/:not or sibling test, so a wait is no oracle over values the observation leaves out
 * (a password or hidden field's value, a token in an attribute). */
const WAIT_PART=/^(?:[a-z][a-z0-9-]*|\*)?(?:[#.][a-z_-][\w-]*)*$/i;
function waitSelector(raw:string){const s=raw.trim(),parts=s.split(/\s*>\s*|\s+/);return s&&parts.length<=16&&parts.every(p=>p&&WAIT_PART.test(p))?s:null;}
const LISTENER=`if(!globalThis.__atzHumanListener){globalThis.__atzHumanListener=true;globalThis.__atzHumanTouched=false;for(const type of ['pointerdown','keydown','wheel'])addEventListener(type,e=>{if(e.isTrusted){globalThis.__atzHumanTouched=true;globalThis.__atzHumanTakeover('take');}},{capture:true,passive:true});}`;
// The element registry lives in a CDP isolated world, inaccessible to page scripts. Actions use observed node identities.
// Open shadow roots are walked (their keys join host and inner paths with ' >>> '); a closed root is null in every world,
// so its host is collected as a candidate for the host's describeNode check instead.
const SNAPSHOT=`((maxElements,maxText,frame)=>{const SEL='a,button,input,textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=option],[role=combobox]';
const BOX=new Set(['article','aside','blockquote','div','footer','header','main','nav','p','section','span']);
const elements=[],map=new Map(),texts=[],custom=[],plain=[];let left=maxText,more=false,textMore=false,customCount=0,iframes=0;globalThis.__atzElements=map;
const nth=e=>{let p=e;const parts=[];while(p&&p.nodeType===1){let n=1,s=p;while(s=s.previousElementSibling)if(s.tagName===p.tagName)n++;parts.unshift(p.tagName.toLowerCase()+':nth-of-type('+n+')');p=p.parentElement;}return parts.join('>');};
const path=e=>e.id?'#'+CSS.escape(e.id):nth(e);
const text=t=>{t=(t||'').trim();if(!t)return;if(left<=0){textMore=true;return;}const s=t.slice(0,left);texts.push(s);left-=s.length;if(s.length<t.length)textMore=true;};
const name=e=>(e.getAttribute('aria-label')||e.getAttribute('placeholder')||e.labels?.[0]?.textContent||e.innerText||'').trim().slice(0,160);
const walk=(root,prefix)=>{for(const e of root.querySelectorAll('*')){if(e.localName==='iframe'||e.localName==='frame')iframes++;
 if(e.matches(SEL)&&!e.matches('input[type=password],input[type=file]')&&e.getClientRects().length){if(elements.length>=maxElements)more=true;else{let key=prefix+path(e);if(map.has(key))key=prefix+nth(e);if(key.length<=(prefix?1024:512)&&!map.has(key)){map.set(key,e);const item={selector:key,role:e.getAttribute('role')||e.tagName.toLowerCase(),name:name(e)};if(frame!=='main')item.frame=frame;if(prefix)item.shadow=true;if(e instanceof HTMLSelectElement){const all=[...e.options];item.options=all.slice(0,${OPTIONS}).map(o=>{const v=o.value,l=(o.label||o.textContent||'').trim();return Object.assign({value:v.slice(0,${OPTION_TEXT}),label:l.slice(0,${OPTION_TEXT})},o.selected?{selected:true}:{},v.length>${OPTION_TEXT}||l.length>${OPTION_TEXT}?{truncated:true}:{});});if(all.length>${OPTIONS})item.moreOptions=all.length-${OPTIONS};}elements.push(item);}}}
 if(e.shadowRoot){for(const c of e.shadowRoot.children)if(!['STYLE','SCRIPT','TEMPLATE','LINK'].includes(c.tagName))text(c.innerText);walk(e.shadowRoot,prefix+path(e)+' >>> ');}
 else if(e.localName.includes('-')){customCount++;if(custom.length<${SHADOW_CHECKS})custom.push([e,prefix+path(e)]);}
 else if(plain.length<${SHADOW_CHECKS}&&BOX.has(e.localName)&&!e.firstChild&&e.getClientRects().length){const b=e.getBoundingClientRect();if(b.width*b.height>=400)plain.push([e,prefix+path(e)]);}
}};
text(document.body?.innerText||'');walk(document,'');
const hosts=custom.concat(plain).slice(0,${SHADOW_CHECKS});globalThis.__atzShadowHosts=hosts.map(h=>h[0]);
const root=document.scrollingElement||document.documentElement;
return JSON.stringify({url:location.href,title:document.title,text:texts.join('\\n'),elements,more,textMore,iframes,hostKeys:hosts.map(h=>h[1]),uncheckedHosts:Math.max(0,customCount-${SHADOW_CHECKS}),scroll:{x:Math.round(scrollX),y:Math.round(scrollY),width:root?root.scrollWidth:0,height:root?root.scrollHeight:0,viewportWidth:innerWidth,viewportHeight:innerHeight}});})`;
function fail(code:BrowserErrorCode,message:string):never {throw new WorkroomBrowserError(code,message);}
const originOf=(raw:string)=>{try{return new URL(raw).origin;}catch{return '';}};
/** A frame's address without query or fragment: tokens in an embedded frame's URL are never echoed. */
const frameAddress=(raw:string)=>{try{const u=new URL(raw);return ['http:','https:'].includes(u.protocol)?(u.origin+u.pathname).slice(0,500):u.protocol+(u.pathname==='srcdoc'||u.pathname==='blank'?u.pathname:'');}catch{return '';}};
const number=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?Math.round(v):0;
/** No settings, profile launch, browser-wide methods, cookies, network bodies or arbitrary JS reach agents. */
export class WorkroomBrowserHost {
 private spaces=new Map<string,Binding>();private opening=false;
 constructor(private deps:Deps){}
 private invalidate(b:Binding,owner:BrowserWorkspace['owner']='human'){b.state.epoch++;b.state.owner=owner;b.state.observation=null;delete b.state.waiting;b.frames.clear();b.grant=undefined;}
 private bound(id:string,requireRunning=true){const b=this.spaces.get(id);if(!b)fail('workspace-not-found','Browser workspace not found.');const s=this.deps.runningSession(b.state.sessionId);if(!s||s.targetId!==b.state.targetId){this.disconnect(b);if(requireRunning)fail('session-ended','The original Workroom session is no longer running.');}return b;}
 private connected(b:Binding){if(b.state.connection!=='connected')fail('chrome-disconnected','Chrome disconnected. Reconnect and select the page again.');}
 /** A lost connection has no tab set: nothing is attached any more, so no tab, closed or not, is reported as in it. */
 private lose(b:Binding){this.invalidate(b,'disconnected');b.state.connection='disconnected';b.tabs.clear();b.tab=undefined;b.state.page=null;}
 private disconnect(b:Binding){if(b.state.connection==='disconnected')return;this.lose(b);b.off?.();b.cdp.close();}
 /** The recovery record names the tab the task works in now. Each receipt also keeps the tab it ran in. */
 private remember(b:Binding,page:BrowserPage|null=b.state.page){if(b.recoveryId&&page)this.deps.recovery!.save({...b.state,page},b.recoveryId);}
 /** A receipt's display detail lives only in this binding's bounded activity, never in the durable ledger. */
 private receipt(b:Binding,id:string,state:BrowserActionState):BrowserReceipt{const detail=b.state.activity?.find(r=>r.id===id);if(detail)detail.state=state;return {...detail,id,state};}
 private result(b:Binding):Extract<WorkroomBrowserResult,{success:true}>{const workspace=structuredClone(b.state),unknown=[...b.receipts].find(([,r])=>r.state==='unknown');if(unknown)workspace.receipt={...workspace.activity?.find(r=>r.id===unknown[0]),id:unknown[0],state:'unknown'};if(b.tabs.size)workspace.tabs=[...b.tabs.values()].map(t=>({...t.page}));return {success:true,workspace};}
 private queue<T>(b:Binding,fn:()=>Promise<T>):Promise<T>{if(b.queued>=8)fail('queue-full','Browser command queue is full. Wait for the current operation.');b.queued++;const run=b.tail.then(fn,fn).finally(()=>{b.queued--;});b.tail=run.catch(()=>{});return run;}
 private sleep(ms:number){return (this.deps.sleep??(t=>new Promise<void>(r=>setTimeout(r,t))))(ms);}
 private now(){return (this.deps.now??Date.now)();}
 /** The human-takeover listener in one isolated world: any trusted pointer, key or wheel input in that frame revokes. */
 private async arm(b:Binding,tab:Tab,session:string,context:number){
  const key=`${session}|${context}`;if(tab.armed.has(key))return;
  await b.cdp.send('Runtime.addBinding',{name:'__atzHumanTakeover',executionContextId:context},session);
  await b.cdp.send('Runtime.evaluate',{expression:LISTENER,contextId:context,returnByValue:true},session);tab.armed.add(key);
 }
 private async prepareContext(b:Binding,tab:Tab){
  const tree=await b.cdp.send('Page.getFrameTree',{},tab.session);tab.frame=tree.frameTree.frame.id;
  const world=await b.cdp.send('Page.createIsolatedWorld',{frameId:tab.frame,worldName:`agentstoz-${b.state.id}`,grantUniveralAccess:false},tab.session);tab.context=world.executionContextId;
  await this.arm(b,tab,tab.session,tab.context!);
 }
 /** Cross-origin iframes run in their own renderer and appear only as auto-attached iframe targets of this page (or of
 * its own iframes). Anything else auto-attached — a worker — is let go at once. */
 private async autoAttach(b:Binding,session:string){
  try{await b.cdp.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true,filter:[{type:'iframe'}]},session);return true;}catch{/* An engine without target filters. */}
  try{await b.cdp.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true},session);return true;}catch{return false;}
 }
 private async adoptChild(b:Binding,tab:Tab,session:string){
  try{await b.cdp.send('Runtime.enable',{},session);await b.cdp.send('Page.enable',{},session);await this.autoAttach(b,session);}catch{/* It may have detached already; its frames are then reported as unavailable. */}
 }
 private dropChild(b:Binding,tab:Tab,session:string){
  if(!tab.children.delete(session))return;
  for(const ref of b.frames.values())if(ref.session===session)ref.stale=true;
  for(const key of [...tab.armed])if(key.startsWith(session+'|'))tab.armed.delete(key);
  for(const [child,parent] of [...tab.children])if(parent===session)this.dropChild(b,tab,child);
 }
 private stale(b:Binding,tab:Tab,session:string,test:(ref:FrameRef)=>boolean){for(const ref of b.frames.values())if(ref.session===session&&test(ref))ref.stale=true;}
 /** The set tab a CDP session belongs to: its page session or one of its auto-attached frame sessions. */
 private tabOf(b:Binding,sid:string){for(const tab of b.tabs.values())if(tab.session===sid||tab.children.has(sid))return tab;return undefined;}
 /** A tab left the set (closed or detached). Only the active tab's departure ends the agent's lease; like a release,
 * the next tab of the set becomes the active one and the person hands it over again. */
 private dropTab(b:Binding,tab:Tab,destroyed=false){
  if(b.tabs.get(tab.page.id)!==tab)return;b.tabs.delete(tab.page.id);if(destroyed)b.allowed?.delete(tab.page.id);
  if(b.tab===tab){this.invalidate(b);const next=[...b.tabs.values()][0];b.tab=next;b.state.page=next?.page??null;try{this.remember(b);}catch{/* Receipts still name their own tabs. */}}
 }
 private forgetWorlds(tab:Tab,session:string){for(const key of [...tab.armed])if(key.startsWith(session+'|'))tab.armed.delete(key);}
 private onEvent(b:Binding,method:string,p:any,sid?:string){
  if(method==='Target.detachedFromTarget'){
   for(const tab of b.tabs.values()){if(tab.session===p.sessionId){this.dropTab(b,tab);return;}if(tab.children.has(p.sessionId)){this.dropChild(b,tab,p.sessionId);return;}}
  }
  if(method==='Target.targetDestroyed'){const gone=b.tabs.get(p.targetId);if(gone){this.dropTab(b,gone,true);return;}}
  if(!sid)return;const tab=this.tabOf(b,sid);if(!tab)return;
  if(method==='Target.attachedToTarget'){
   const child=String(p.sessionId??'');if(!child)return;
   // Only this page's own frames: anything else, or a frame past the bound, is detached and never observed.
   if(p.targetInfo?.type!=='iframe'||tab.children.size>=MAX_CHILD_SESSIONS){void b.cdp.send('Target.detachFromTarget',{sessionId:child},sid).catch(()=>{});return;}
   tab.children.set(child,sid);void this.adoptChild(b,tab,child);return;
  }
  // Trusted human input in any tab of the set revokes, not only in the active one.
  if(method==='Runtime.bindingCalled'&&p.name==='__atzHumanTakeover'&&tab.armed.has(`${sid}|${p.executionContextId}`)&&['agent','observing'].includes(b.state.owner)){this.invalidate(b);return;}
  if(method==='Runtime.executionContextDestroyed'){tab.armed.delete(`${sid}|${p.executionContextId}`);this.stale(b,tab,sid,ref=>ref.context===p.executionContextId);}
  const own=sid===tab.session,active=tab===b.tab;
  if(!own){
   if(method==='Runtime.executionContextsCleared'||method==='Page.frameNavigated'&&!p.frame?.parentId){this.forgetWorlds(tab,sid);this.stale(b,tab,sid,()=>true);}
   if(method==='Page.frameNavigated'&&p.frame?.parentId)this.stale(b,tab,sid,ref=>ref.frameId===p.frame.id);
   return;
  }
  if(method==='Page.frameNavigated'&&p.frame?.parentId)this.stale(b,tab,sid,ref=>ref.frameId===p.frame.id);
  // One closed tab is one tab leaving the set; only the last tab's departure ends the connection.
  if(method==='Inspector.detached'){if(active&&b.tabs.size<=1)this.disconnect(b);else this.dropTab(b,tab);return;}
  if(active){
   // The active tab: a navigation ends the lease, as it always has.
   if(method==='Page.frameNavigated'&&!p.frame?.parentId){this.invalidate(b);tab.navigations++;tab.frame=p.frame.id;tab.context=undefined;tab.page.url=p.frame.url;}
   if(method==='Page.navigatedWithinDocument'&&p.frameId===tab.frame){this.invalidate(b);tab.navigations++;tab.page.url=p.url;}
   if(method==='Runtime.executionContextsCleared'){this.invalidate(b);tab.context=undefined;tab.armed.clear();}
   return;
  }
  // Another tab of the set: nobody acts on it until it is switched to and observed afresh, so its navigation only
  // resets its worlds. Its new document is watched for human input again as soon as it exists.
  if(method==='Page.frameNavigated'&&!p.frame?.parentId){tab.navigations++;tab.frame=p.frame.id;tab.context=undefined;tab.page.url=p.frame.url;}
  if(method==='Page.navigatedWithinDocument'&&p.frameId===tab.frame){tab.navigations++;tab.page.url=p.url;}
  if(method==='Runtime.executionContextsCleared'){tab.context=undefined;this.forgetWorlds(tab,sid);}
  if(method==='Runtime.executionContextCreated'&&p.context?.auxData?.isDefault===true&&p.context.auxData.frameId===tab.frame&&!tab.context&&!tab.arming){
   tab.arming=true;void this.prepareContext(b,tab).catch(()=>{}).finally(()=>{tab.arming=false;});
  }
 }
 private async pages(b:Binding):Promise<BrowserPage[]>{this.connected(b);const {targetInfos}=await b.cdp.send('Target.getTargets');return (targetInfos??[]).filter((t:any)=>t.type==='page'&&(!b.allowed||b.allowed.has(t.targetId))).flatMap((t:any)=>{try{workroomBrowserUrl(t.url);return [{id:String(t.targetId).slice(0,180),title:String(t.title??'').slice(0,200),url:t.url}];}catch{return [];}}).slice(0,40);}
 /** One frame's bounded snapshot in its own isolated world, plus the closed-shadow check of its candidate hosts. */
 private async snapshot(b:Binding,session:string,context:number,frame:string,maxElements:number,maxText:number){
  const r=await b.cdp.send('Runtime.evaluate',{expression:`${SNAPSHOT}(${maxElements},${maxText},${JSON.stringify(frame)})`,contextId:context,returnByValue:true,timeout:3000},session);
  if(r.exceptionDetails||typeof r.result?.value!=='string'||r.result.value.length>240000)fail('observe-failed','Could not observe this page.');
  const value=JSON.parse(r.result.value);
  const elements:BrowserElement[]=(Array.isArray(value.elements)?value.elements:[]).slice(0,maxElements).filter((e:any)=>e&&typeof e==='object'&&typeof e.selector==='string'&&e.selector.length<=1024&&typeof e.role==='string'&&e.role.length<=100&&typeof e.name==='string'&&e.name.length<=160&&(frame==='main'?e.frame===undefined:e.frame===frame)).map((e:any)=>{
   const item:BrowserElement={selector:e.selector,role:e.role,name:e.name};if(e.frame)item.frame=frame;if(e.shadow===true)item.shadow=true;
   if(Array.isArray(e.options))item.options=e.options.slice(0,OPTIONS).filter((o:any)=>o&&typeof o.value==='string'&&typeof o.label==='string').map((o:any)=>({value:o.value.slice(0,OPTION_TEXT),label:o.label.slice(0,OPTION_TEXT),...(o.selected===true?{selected:true as const}:{}),...(o.truncated===true?{truncated:true as const}:{})}));
   if(Number.isSafeInteger(e.moreOptions)&&e.moreOptions>0&&e.moreOptions<=100000)item.moreOptions=e.moreOptions;
   return item;});
  const s=value.scroll??{},scroll:BrowserScroll={x:number(s.x),y:number(s.y),width:number(s.width),height:number(s.height),viewportWidth:number(s.viewportWidth),viewportHeight:number(s.viewportHeight)};
  const closed=await this.closedShadow(b,session,context,frame,Array.isArray(value.hostKeys)?value.hostKeys.slice(0,SHADOW_CHECKS):[],number(value.uncheckedHosts));
  return {url:String(value.url),title:String(value.title??'').slice(0,500),text:String(value.text??'').slice(0,maxText),elements,closed,scroll,iframes:number(value.iframes),more:value.more===true,textMore:value.textMore===true};
 }
 /** A closed shadow root cannot be read from any world; only DevTools can say it exists. Its host is reported. */
 private async closedShadow(b:Binding,session:string,context:number,frame:string,keys:unknown[],unchecked:number):Promise<BrowserUnobservable[]>{
  const out:BrowserUnobservable[]=[];
  if(keys.length)try{
   const list=await b.cdp.send('Runtime.evaluate',{expression:'globalThis.__atzShadowHosts',contextId:context,objectGroup:'atz-shadow'},session);
   if(list.result?.objectId){
    const props=await b.cdp.send('Runtime.getProperties',{objectId:list.result.objectId,ownProperties:true},session);
    for(const p of props.result??[]){
     const index=/^\d+$/.test(String(p.name))?Number(p.name):-1;if(index<0||index>=keys.length||!p.value?.objectId)continue;
     const d=await b.cdp.send('DOM.describeNode',{objectId:p.value.objectId,depth:0},session);
     if((d.node?.shadowRoots??[]).some((root:any)=>root.shadowRootType==='closed'))out.push({kind:'closed-shadow-root',frame,selector:String(keys[index]).slice(0,1024)});
    }
   }
  }catch{unchecked+=keys.length;}finally{await b.cdp.send('Runtime.releaseObjectGroup',{objectGroup:'atz-shadow'},session).catch(()=>{});}
  if(unchecked>0)out.push({kind:'shadow-check-limit',frame,count:unchecked});
  return out;
 }
 /** Same-origin frames from the page's frame tree, then each auto-attached cross-origin iframe and its own subtree. */
 private async frameCandidates(b:Binding,tab:Tab){
  const out:{session:string;frameId:string;url:string}[]=[];
  const walk=(node:any,session:string)=>{for(const c of node?.childFrames??[]){if(c?.frame?.id)out.push({session,frameId:String(c.frame.id),url:String(c.frame.url??'')});walk(c,session);}};
  walk((await b.cdp.send('Page.getFrameTree',{},tab.session)).frameTree,tab.session);
  for(const child of [...tab.children.keys()]){try{const t=(await b.cdp.send('Page.getFrameTree',{},child)).frameTree;if(t?.frame?.id)out.push({session:child,frameId:String(t.frame.id),url:String(t.frame.url??'')});walk(t,child);}catch{/* Detached meanwhile. */}}
  return out;
 }
 private async observe(b:Binding,epoch:number){
  this.connected(b);const tab=b.tab;if(!tab?.context||!b.state.page)fail('profile-mismatch','Select a Chrome page first.');
  const main=await this.snapshot(b,tab.session,tab.context,'main',MAIN_ELEMENTS,MAIN_TEXT);workroomBrowserUrl(main.url);
  const changed=()=>b.state.epoch!==epoch||b.state.connection!=='connected'||main.url!==b.state.page?.url;
  if(changed())fail('stale-observation','Page changed. Select and observe the page again.');
  const frames=new Map<string,FrameRef>([['main',{session:tab.session,frameId:tab.frame!,context:tab.context,stale:false}]]);
  const summaries:BrowserFrameSummary[]=[],unobservable:BrowserUnobservable[]=[...main.closed],elements=[...main.elements];
  // Without target discovery a cross-origin frame cannot even be listed; say so rather than leave it silently out.
  if(!tab.discovery&&main.iframes>0)unobservable.push({kind:'frame-unavailable',frame:'main',count:main.iframes});
  let candidates:{session:string;frameId:string;url:string}[]=[];try{candidates=await this.frameCandidates(b,tab);}catch{/* The main document is still observed. */}
  for(const [i,c] of candidates.entries()){
   if(i>=MAX_FRAMES){unobservable.push({kind:'frame-limit',frame:'main',count:candidates.length-MAX_FRAMES});break;}
   const ref=`f${i+1}`;
   try{
    const {executionContextId:context}=await b.cdp.send('Page.createIsolatedWorld',{frameId:c.frameId,worldName:`agentstoz-${b.state.id}`,grantUniveralAccess:false},c.session);
    await this.arm(b,tab,c.session,context);
    const s=await this.snapshot(b,c.session,context,ref,FRAME_ELEMENTS,FRAME_TEXT);
    frames.set(ref,{session:c.session,frameId:c.frameId,context,stale:false});elements.push(...s.elements);unobservable.push(...s.closed);
    summaries.push({ref,url:frameAddress(s.url),title:s.title.slice(0,200),text:s.text,crossOrigin:originOf(s.url)!==originOf(main.url),elements:s.elements.length,...(s.more||s.textMore?{truncated:true as const}:{})});
   }catch{unobservable.push({kind:'frame-unavailable',frame:ref,url:frameAddress(c.url)});}
   if(changed())fail('stale-observation','Page changed. Select and observe the page again.');
  }
  const observation={id:randomUUID(),url:main.url,title:main.title,text:main.text,elements,...(summaries.length?{frames:summaries}:{}),...(unobservable.length?{unobservable:unobservable.slice(0,24)}:{}),scroll:main.scroll,...(main.more||main.textMore?{truncated:{...(main.more?{elements:true as const}:{}),...(main.textMore?{text:true as const}:{})}}:{}),capturedAt:new Date().toISOString(),untrusted:true as const};
  b.frames=frames;b.state.observation=observation;return observation;
 }
 /** The frame an agent names, as its latest observation saw it. A frame that navigated or detached since is refused
 * before anything is sent, so no receipt is opened for it. */
 private frameRef(b:Binding,frame:string|undefined):FrameRef{const ref=b.frames.get(frame??'main');if(!ref||ref.stale)fail('stale-observation','Frame changed. Observe again before acting.');return ref;}
 /** The native profile a built-in page runs in, as the person's request names it: the chosen saved task's, this
 * Workroom's own, or the profile this Workroom's built-in browser already runs in — another tab of a Workroom restored
 * from a saved task, after the panel has forgotten that choice. Any other profile is refused. */
 private ownedProfile(r:Extract<WorkroomBrowserRequest,{operation:'connect-owned'}>,saved:BrowserRecovery|undefined,existing:Binding|undefined){
  const own=saved?.profileId??`owned:${r.sessionId}`,named=r.profileKey===undefined?own:`owned:${r.profileKey}`;
  if(named!==own&&!(!saved&&existing?.state.source==='owned'&&existing.state.profileId===named&&existing.endpoint.startsWith(`ws://127.0.0.1:${r.port}/devtools/browser/`)))
   fail('profile-mismatch',saved?'Recovery record does not belong to this project and profile.':existing?'Detach the original browser before changing this Workroom connection.':'A new built-in browser runs in this Workroom\'s own profile or in the chosen saved task\'s.');
  return {id:named,profileName:'Chromium'};
 }
 /** Another saved task's unknown action in this tab, in any project: it is reviewed in that task before this Workroom
 * may hold the tab for an agent. No later record of the same tab hides it. */
 private unresolved(b:Binding,pageId:string){return this.deps.recovery?.unresolved(b.state.profileId,pageId,b.recoveryId);}
 async perform(value:unknown):Promise<WorkroomBrowserResult>{
  const r=parseWorkroomBrowserRequest(value);
  if(r.operation==='profiles')return {success:true,profiles:(this.deps.profiles??discoverChromeProfiles)().slice(0,100).map(({id,profileName,accountLabel})=>({id,profileName:profileName.slice(0,200),accountLabel:accountLabel?.slice(0,256)??null}))};
  if(r.operation==='recoveries'){
   if(this.deps.runningSession(r.sessionId)?.targetId!==r.targetId)fail('session-ended','Running local Workroom required.');
   return {success:true,recoveries:(this.deps.recovery?.list(r.targetId)??[]).map(({targetId:_,...record})=>record)};
  }
  if(r.operation==='connect'||r.operation==='connect-owned'){
   const session=this.deps.runningSession(r.sessionId);if(!session||session.targetId!==r.targetId)fail('session-ended','Running local Workroom required.');
   const saved=r.recoveryId?this.deps.recovery?.get(r.recoveryId):undefined;
   if(r.recoveryId&&(!saved||saved.targetId!==r.targetId||saved.source!==(r.operation==='connect-owned'?'owned':'chrome')||r.operation==='connect'&&saved.profileId!==r.profileId))fail('profile-mismatch','Recovery record does not belong to this project and profile.');
   if(saved&&[...this.spaces.values()].some(b=>b.recoveryId===saved.id&&b.state.connection==='connected'&&b.state.sessionId!==r.sessionId))fail('profile-in-use','The original browser task is still connected.');
   const existing=[...this.spaces.values()].find(b=>b.state.connection==='connected'&&b.state.sessionId===r.sessionId);
   const profile=r.operation==='connect-owned'?this.ownedProfile(r,saved,existing):(this.deps.profiles??discoverChromeProfiles)().find(p=>p.id===r.profileId);if(!profile)fail('profile-mismatch','Chrome profile no longer exists.');
   if(existing){
    if(existing.state.profileId!==profile.id)fail('workspace-changed','Detach the original browser before changing this Workroom connection.');
    if(r.operation==='connect-owned'&&!existing.allowed?.has(r.pageId)){
     // Another built-in tab of this same Workroom: the same native browser (port) and the same saved task. It joins
     // the Workroom's own tab set as a person's choice, so only while the person holds control.
     if(existing.state.source!=='owned'||!existing.endpoint.startsWith(`ws://127.0.0.1:${r.port}/devtools/browser/`)||r.recoveryId!==undefined&&r.recoveryId!==existing.recoveryId)fail('workspace-changed','Detach the original browser before changing this Workroom connection.');
     existing.allowed!.add(r.pageId);
     try{return await this.perform({operation:'select',workspaceId:existing.state.id,pageId:r.pageId,confirmProfile:true,add:true});}
     catch(e){if(!existing.tabs.has(r.pageId))existing.allowed!.delete(r.pageId);throw e;}
    }
    return this.result(existing);
   }
   if(this.opening)fail('approval-pending','A browser connection is awaiting approval.');
   if(this.spaces.size>=8)fail('workroom-limit','Browser workspace limit reached. Detach unused workspaces.');this.opening=true;
   let cdp:BrowserCdp|undefined,created:string|undefined;
   try{
    let endpoint:string;
    if(r.operation==='connect-owned'){
     const response=await fetch(`http://127.0.0.1:${r.port}/json/version`,{redirect:'error',signal:AbortSignal.timeout(3000)});
     const raw=await response.text();if(raw.length>8192)fail('target-lost','Native browser discovery failed.');const version=JSON.parse(raw);endpoint=version.webSocketDebuggerUrl;
     if(typeof endpoint!=='string'||!endpoint.startsWith(`ws://127.0.0.1:${r.port}/devtools/browser/`))fail('target-lost','Native browser discovery failed.');
    }else endpoint=await (this.deps.endpoint??chromeDebugEndpoint)();
    cdp=await (this.deps.connect??WorkroomCdpTransport.connect)(endpoint);
    if(this.deps.runningSession(r.sessionId)?.targetId!==r.targetId)fail('session-ended','Workroom changed during Chrome approval.');
    const id=randomUUID(),b:Binding={state:{id,sessionId:r.sessionId,targetId:r.targetId,profileId:profile.id,profileName:profile.profileName,source:r.operation==='connect-owned'?'owned':'chrome',page:null,owner:'human',epoch:1,observation:null,connection:'connected',profileVerification:'unverified'},cdp,endpoint,tabs:new Map(),frames:new Map(),tail:Promise.resolve(),queued:0,receipts:new Map()};
    cdp.onClose(()=>{if(b.state.connection!=='disconnected')this.lose(b);});
    b.recoveryId=saved?.id??(this.deps.recovery?id:undefined);
    if(b.recoveryId){if(saved)this.deps.recovery!.save(b.state,b.recoveryId);b.receipts=new Map(this.deps.recovery!.receipts(b.recoveryId).map(({id,...receipt})=>[id,receipt]));}
    b.off=cdp.onEvent((method,p,sid)=>this.onEvent(b,method,p,sid));this.spaces.set(id,b);created=id;
    if(r.operation==='connect-owned'){b.allowed=new Set([r.pageId]);return await this.perform({operation:'select',workspaceId:id,pageId:r.pageId,confirmProfile:true});}
    return this.result(b);
   }catch(e){cdp?.close();if(created)this.spaces.delete(created);throw e;}finally{this.opening=false;}
  }
  // The ended-session reaper may already have released this transport. Cleanup
  // stays idempotent so a human can still close the native view; agent access
  // continues to require an existing live binding below.
  if(r.operation==='detach'&&!this.spaces.has(r.workspaceId))return {success:true};
  const b=this.bound(r.workspaceId,!['status','detach','take','settle'].includes(r.operation));
  if(r.operation==='detach'){this.disconnect(b);this.spaces.delete(b.state.id);return this.result(b);}
  if(r.operation==='status')return this.result(b);
  if(r.operation==='take'){
   // Invalidate before waiting for already sent commands. No new agent action can enter the queue.
   this.invalidate(b,'taking');await b.tail;b.state.owner=b.state.connection==='connected'?'human':'disconnected';
   // Only an explicit human takeover may bring the original Chrome tab forward. Agent operations never focus windows.
   if(b.state.owner==='human'&&b.state.source==='chrome'&&b.state.page)await b.cdp.send('Target.activateTarget',{targetId:b.state.page.id});
   return this.result(b);
  }
  return this.queue(b,async()=>{
   if(r.operation==='settle'){
    if(!['human','disconnected'].includes(b.state.owner))fail('take-control-first','Take control and inspect the page before reviewing an unknown result.');const receipt=b.receipts.get(r.requestId);if(!receipt||receipt.state!=='unknown')fail('generic','Unknown receipt not found.');if(b.recoveryId)this.deps.recovery!.record(b.recoveryId,{id:r.requestId,fingerprint:receipt.fingerprint,state:'reviewed'});receipt.state='reviewed';b.state.receipt=this.receipt(b,r.requestId,'reviewed');return this.result(b);
   }
   this.connected(b);
   if(r.operation==='pages')return {...this.result(b),pages:await this.pages(b)};
   if(r.operation==='select'){
    if(b.state.owner!=='human')fail('take-control-first','Take control before choosing another tab.');
    const known=b.tabs.get(r.pageId);
    if(known){
     // Another tab of this Workroom's own set becomes the active tab; nothing is attached or detached.
     this.invalidate(b);b.tab=known;b.state.page=known.page;if(!known.context)await this.prepareContext(b,known);
     b.state.profileVerification='user-confirmed';this.remember(b);return this.result(b);
    }
    if(r.add&&b.tabs.size>=BROWSER_TAB_LIMIT)fail('tab-limit',`This Workroom already has ${BROWSER_TAB_LIMIT} tabs. Release one before adding another.`);
    const page=(await this.pages(b)).find(p=>p.id===r.pageId);if(!page)fail('target-lost','Chrome tab no longer exists.');
    if([...this.spaces.values()].some(other=>other!==b&&other.endpoint===b.endpoint&&other.tabs.has(page.id)&&other.state.connection==='connected'))fail('profile-in-use','This Chrome tab is already attached to another Workroom.');
    // An added tab joins the current task and never takes over another task's record of it. Only choosing a tab alone
    // (replacing the set) continues another saved task of this project — always the one whose unknown action in this
    // tab still awaits review, so the review comes first.
    const previousRecovery=b.recoveryId;
    const blocking=this.unresolved(b,page.id);
    if(blocking){
     if(blocking.targetId!==b.state.targetId)fail('take-control-first','This tab has an unresolved action in another project. Review the original task first.');
     if(r.add)fail('take-control-first','This tab has an unresolved action in another task. Choose it alone to continue that task and review the result first.');
     b.recoveryId=blocking.id;
    }else if(!r.add){const prior=this.deps.recovery?.matching(b.state.profileId,page.id);if(prior&&prior.id!==b.recoveryId&&prior.targetId===b.state.targetId)b.recoveryId=prior.id;}
    if(b.recoveryId&&b.recoveryId!==previousRecovery){delete b.state.activity;delete b.state.receipt;}
    if(b.recoveryId)b.receipts=new Map(this.deps.recovery!.receipts(b.recoveryId).map(({id,...receipt})=>[id,receipt]));
    this.invalidate(b);const previous=b.tab,confirmed=b.state.profileVerification;b.state.profileVerification='unverified';
    if(!r.add){const before=[...b.tabs.values()];b.tabs.clear();b.tab=undefined;b.state.page=null;for(const t of before)await b.cdp.send('Target.detachFromTarget',{sessionId:t.session}).catch(()=>{/* Already gone; the attach below still decides. */});}
    const {sessionId}=await b.cdp.send('Target.attachToTarget',{targetId:page.id,flatten:true});const tab:Tab={page,session:sessionId,children:new Map(),armed:new Set(),navigations:0,discovery:false};b.tabs.set(page.id,tab);
    try{
     await b.cdp.send('Page.enable',{},sessionId);await b.cdp.send('Runtime.enable',{},sessionId);tab.discovery=await this.autoAttach(b,sessionId);
     await this.prepareContext(b,tab);
    }catch(e){
     // A tab that could not be prepared never stays in the set; an added one leaves the previous active tab as it was.
     b.tabs.delete(page.id);await b.cdp.send('Target.detachFromTarget',{sessionId}).catch(()=>{});
     if(r.add&&previous&&b.tabs.get(previous.page.id)===previous){b.tab=previous;b.state.page=previous.page;b.state.profileVerification=confirmed;}
     throw e;
    }
    b.tab=tab;b.state.page=page;b.state.profileVerification='user-confirmed';this.remember(b);return this.result(b);
   }
   if(r.operation==='release'){
    // Leaving the set never closes the tab: it is only detached, like a whole-workspace detach.
    if(b.state.owner!=='human')fail('take-control-first','Take control before changing this Workroom\'s tabs.');
    const tab=b.tabs.get(r.pageId);if(!tab)fail('tab-not-in-set','That tab is not in this Workroom.');
    b.tabs.delete(r.pageId);b.allowed?.delete(r.pageId);
    if(b.tab===tab){this.invalidate(b);const next=[...b.tabs.values()][0];b.tab=next;b.state.page=next?.page??null;}
    await b.cdp.send('Target.detachFromTarget',{sessionId:tab.session}).catch(()=>{});
    this.remember(b);return this.result(b);
   }
   if(r.operation==='resume'){
    if([...b.receipts.values()].some(receipt=>receipt.state==='unknown'))fail('take-control-first','Review the unknown action result before returning control.');
    // However a tab came into the set, an agent never gets a tab another task left with an unknown action.
    for(const t of b.tabs.values())if(this.unresolved(b,t.page.id))fail('take-control-first','A tab of this Workroom has an unresolved action in another task. Review that task first, or release the tab.');
    if(b.state.owner!=='human'||!b.state.page||b.state.profileVerification!=='user-confirmed'||!b.tab)fail('profile-mismatch','Confirm the Chrome profile and tab first.');
    const tab=b.tab;if(!tab.context)await this.prepareContext(b,tab);
    // Every tab of the set is watched for the person's input; one that cannot be watched is not handed over silently.
    for(const other of b.tabs.values())if(!other.context)await this.prepareContext(b,other).catch(()=>fail('observe-failed','Another tab of this Workroom is not ready. Wait for it to load, or release it, before returning control.'));
    this.invalidate(b,'observing');const epoch=b.state.epoch;
    try{
     // Every armed world forgets the human input it saw while the human held control; a frame keeps none of it.
     for(const t of b.tabs.values())for(const key of [...t.armed]){const [session,context]=key.split('|');await b.cdp.send('Runtime.evaluate',{expression:'globalThis.__atzHumanTouched=false',contextId:Number(context),returnByValue:true},session).catch(e=>{if(session===t.session&&Number(context)===t.context)throw e;t.armed.delete(key);});}
     await this.observe(b,epoch);if(b.state.epoch!==epoch)fail('workspace-changed','Control changed.');b.state.owner='agent';
    }catch(e){if(b.state.epoch===epoch)this.invalidate(b);throw e;}return this.result(b);
   }
   if(r.operation==='grant'){
    if(b.state.owner!=='agent'||!b.state.observation)fail('grant-unavailable','Return control and observe before granting agent access.');
    b.grant=randomBytes(32).toString('hex');return {...this.result(b),grant:b.grant};
   }
   return fail('generic','Unsupported operation.');
  });
 }
 /** The richer receipt/activity contract belongs to the local UI, not the agent tool surface. */
 async agent(value:unknown):Promise<WorkroomBrowserResult>{
  const result=await this.agentResult(value);
  if(result.success&&result.workspace){const w=result.workspace;delete w.activity;delete w.waiting;if(w.receipt)w.receipt={id:w.receipt.id,state:w.receipt.state};}
  return result;
 }
 private async agentResult(value:unknown):Promise<WorkroomBrowserResult>{
  const r=parseBrowserAgentRequest(value);
  const b=this.bound(r.workspaceId);const grant=b.grant;
  if(!grant||!/^[a-f0-9]{64}$/.test(r.grant)||!timingSafeEqual(Buffer.from(grant),Buffer.from(r.grant)))fail('grant-unavailable','Browser grant revoked or unavailable.');
  return this.queue(b,async()=>{
   // Recheck after queueing; takeover revokes immediately.
   if(b.grant!==grant||b.state.owner!=='agent'||b.state.epoch!==r.epoch)fail('grant-unavailable','Stale browser control lease.');this.connected(b);
   if(r.operation==='request-human'){
    // No CDP call, observation, receipt or durable write: only the person may open a requested address.
    b.state.waiting??={reason:r.reason!,...(r.note!==undefined?{note:r.note}:{}),...(r.url!==undefined?{url:r.url}:{}),at:this.now()};
    return this.result(b);
   }
   if(r.operation==='receipt'){const receipt=b.receipts.get(r.requestId??'');if(!receipt)fail('generic','Receipt not found; do not automatically retry.');b.state.receipt=this.receipt(b,r.requestId!,receipt.state);return this.result(b);}
   if(r.operation==='observe'){await this.observe(b,r.epoch);return this.result(b);}
   if(r.operation==='screenshot')return {...this.result(b),screenshot:await this.screenshot(b,r)};
   if(r.operation==='wait')return await this.wait(b,r,grant);
   if(r.operation==='scroll'){await this.scroll(b,r);b.state.observation=null;b.frames.clear();if(b.state.epoch===r.epoch)await this.observe(b,r.epoch);return this.result(b);}
   // Only this Workroom's own set is ever read: each tab is asked about by its own id, never through a browser-wide list.
   if(r.operation==='tabs'){for(const tab of [...b.tabs.values()])await this.refreshTab(b,tab);return this.result(b);}
   if(r.operation==='switch-tab'){
    const tab=typeof r.tab==='string'?b.tabs.get(r.tab):undefined;if(!tab)fail('tab-not-in-set','That tab is not one of this Workroom\'s tabs. List them with tabs.');
    // The record names the tab the agent works in before anything can act there; a failed save switches nothing.
    if(tab!==b.tab)this.remember(b,tab.page);
    b.state.observation=null;b.frames.clear();b.tab=tab;b.state.page=tab.page;
    await this.refreshTab(b,tab);if(!tab.context)await this.prepareContext(b,tab);
    if(b.state.epoch===r.epoch)await this.observe(b,r.epoch);return this.result(b);
   }
   if(typeof r.requestId!=='string'||!/^[-\w]{8,128}$/.test(r.requestId)||typeof r.selector!=='string'||!r.selector||r.operation==='fill'&&typeof r.text!=='string'||r.operation==='select'&&typeof r.value!=='string')fail('generic','Invalid bounded action.');
   // The original click/fill fingerprint is unchanged for the main document, so durable receipts keep deduplicating.
   const input=[r.operation,r.selector,r.operation==='select'?r.value:r.text];if(r.frame&&r.frame!=='main')input.push(r.frame);
   const fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');const existing=b.receipts.get(r.requestId);
   if(existing){if(existing.fingerprint!==fingerprint)fail('generic','Request ID reused with different input.');b.state.receipt=this.receipt(b,r.requestId,existing.state);return this.result(b);}
   if([...b.receipts.values()].some(receipt=>receipt.state==='unknown'))fail('take-control-first','An earlier action has an unknown outcome. Take control and review its result first.');
   if(!b.state.observation||r.observationId!==b.state.observation.id)fail('stale-observation','Observe again before acting.');
   const ref=this.frameRef(b,r.frame);
   if(b.receipts.size>=128)fail('queue-full','Action receipt limit reached. Detach after reviewing results.');
   // The durable receipt names the tab it is dispatched in, so the tab itself finds this task again.
   const receipt={fingerprint,state:'unknown' as BrowserActionState},pageId=b.state.page?.id??null;if(b.recoveryId)this.deps.recovery!.record(b.recoveryId,{id:r.requestId,...receipt},pageId);b.receipts.set(r.requestId,receipt);
   const element=b.state.observation.elements.find(e=>e.selector===r.selector&&(e.frame??'main')===(r.frame??'main'));
   const detail={id:r.requestId,action:r.operation,...(element?{target:{role:element.role,name:element.name.slice(0,80)}}:{}),state:receipt.state,at:this.now()};
   b.state.activity=[...(b.state.activity??[]),detail].slice(-12);b.state.receipt=this.receipt(b,r.requestId,'unknown');
   try{
    // Fixed isolated-world function; caller strings are serialized as data. Page globals cannot authorize a lease.
    // Text shown for a cut-off option may also be another option's whole value or label: then it names neither.
    const selector=JSON.stringify(r.selector),text=JSON.stringify(r.text??''),choice=JSON.stringify(r.value??'');
    const expression=r.operation==='fill'?`(()=>{const e=globalThis.__atzElements?.get(${selector});if(!e?.isConnected||!(e instanceof HTMLInputElement||e instanceof HTMLTextAreaElement)||e.type==='password'||e.type==='file'||e.disabled||e.readOnly)throw Error('Observed field unavailable');const setter=Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set;setter.call(e,${text});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`
     :r.operation==='select'?`(()=>{const e=globalThis.__atzElements?.get(${selector});if(!e?.isConnected||!(e instanceof HTMLSelectElement)||e.disabled)throw Error('Observed list unavailable');const v=${choice},all=[...e.options],label=o=>(o.label||o.textContent||'').trim(),cut=v.length>=${OPTION_TEXT}?all.filter(o=>o.value.startsWith(v)||label(o).startsWith(v)):[],o=cut.length>1?undefined:all.find(o=>o.value===v)||all.find(o=>label(o)===v)||cut[0];if(!o||o.disabled)throw Error('Option unavailable');for(const other of all)other.selected=other===o;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`
     :`(()=>{const e=globalThis.__atzElements?.get(${selector});if(!e?.isConnected||!(e instanceof HTMLElement)||e.matches('input[type=file],input[type=password]'))throw Error('Observed element unavailable');e.click();return true;})()`;
    const result=await b.cdp.send('Runtime.evaluate',{expression:`if(globalThis.__atzHumanTouched)throw Error('Human takeover');${expression}`,contextId:ref.context,returnByValue:true,timeout:3000},ref.session);
    if(result.exceptionDetails)fail('take-control-first','Page action failed; inspect its effect before retrying.');
    if(b.recoveryId)this.deps.recovery!.record(b.recoveryId,{id:r.requestId,fingerprint,state:'completed'},pageId);receipt.state='completed';b.state.receipt=this.receipt(b,r.requestId,'completed');
    // Every action consumes its observation, including an action that navigated away.
    b.state.observation=null;b.frames.clear();if(b.state.epoch===r.epoch)await this.observe(b,r.epoch);
    return this.result(b);
   }catch(e){b.state.receipt=this.receipt(b,r.requestId,receipt.state);b.state.observation=null;b.frames.clear();throw e;}
  });
 }
 /** Scrolling changes only what is on screen: no receipt, but an element is still named by the latest observation. */
 private async scroll(b:Binding,r:BrowserAgentRequest){
  const element=typeof r.selector==='string'&&!!r.selector;
  if(element&&(!b.state.observation||r.observationId!==b.state.observation.id))fail('stale-observation','Observe again before acting.');
  if(!element&&r.to===undefined&&r.deltaX===undefined&&r.deltaY===undefined)fail('generic','Name an observed element, a direction (to) or a distance (deltaX/deltaY).');
  const ref=element||r.frame&&r.frame!=='main'?this.frameRef(b,r.frame):this.mainRef(b);
  const expression=element?`(()=>{const e=globalThis.__atzElements?.get(${JSON.stringify(r.selector)});if(!e?.isConnected)throw Error('Observed element unavailable');e.scrollIntoView({block:'center',inline:'nearest'});return true;})()`
   :r.to?`(()=>{const root=document.scrollingElement||document.documentElement;scrollTo(scrollX,${r.to==='top'?'0':'root.scrollHeight'});return true;})()`:`(()=>{scrollBy(${r.deltaX??0},${r.deltaY??0});return true;})()`;
  const result=await b.cdp.send('Runtime.evaluate',{expression,contextId:ref.context,returnByValue:true,timeout:3000},ref.session);
  if(result.exceptionDetails)fail('observe-failed','Could not scroll there. Observe again.');
 }
 /** One set tab's current title and address, asked for by its own target id. A tab that left HTTP(S) keeps its last
 * address (observing it is refused anyway). */
 private async refreshTab(b:Binding,tab:Tab){
  const info=(await b.cdp.send('Target.getTargetInfo',{targetId:tab.page.id},undefined,{read:{timeoutMs:READ_MS}})).targetInfo;
  if(!info||info.targetId!==tab.page.id)return;
  tab.page.title=String(info.title??'').slice(0,200);try{workroomBrowserUrl(String(info.url));tab.page.url=String(info.url);}catch{/* Not an HTTP(S) document now. */}
 }
 private mainRef(b:Binding):FrameRef{const tab=b.tab;if(!tab?.context||!b.state.page)fail('profile-mismatch','Select a Chrome page first.');return {session:tab.session,frameId:tab.frame??'',context:tab.context,stale:false};}
 /** A bounded wait polls a fixed read-only check in the named frame's isolated world. It never holds control past a
 * takeover: each poll first checks the lease. A navigation ends the lease as always, and is the success of until=navigation. */
 private async wait(b:Binding,r:BrowserAgentRequest,grant:string):Promise<WorkroomBrowserResult>{
  const until=r.until;if(!until)fail('generic','Say what to wait for: selector, text or navigation.');
  if(until==='selector'&&(typeof r.selector!=='string'||!r.selector||r.selector.length>512)||until==='text'&&(typeof r.text!=='string'||!r.text||r.text.length>500))fail('generic','Invalid bounded wait.');
  const selector=until==='selector'?waitSelector(r.selector!):null;if(until==='selector'&&!selector)fail('generic','A wait selector takes tag, #id and .class parts joined by spaces or >, with no attribute or state test.');
  const tab=b.tab;if(!tab)fail('profile-mismatch','Select a Chrome page first.');
  const ref=until==='navigation'?undefined:r.frame&&r.frame!=='main'?this.frameRef(b,r.frame):this.mainRef(b);
  // Met by a displayed element only, never by a password, hidden or file field: what an observation could show.
  const expression=until==='selector'?`((s)=>{const ok=e=>!e.matches('input[type=password],input[type=hidden],input[type=file]')&&e.getClientRects().length>0;const q=root=>{for(const e of root.querySelectorAll(s))if(ok(e))return true;for(const e of root.querySelectorAll('*'))if(e.shadowRoot&&q(e.shadowRoot))return true;return false;};return q(document);})(${JSON.stringify(selector)})`
   :`((t)=>{if((document.body?.innerText||'').includes(t))return true;const q=root=>{for(const e of root.querySelectorAll('*'))if(e.shadowRoot){for(const c of e.shadowRoot.children)if((c.innerText||'').includes(t))return true;if(q(e.shadowRoot))return true;}return false;};return q(document);})(${JSON.stringify(r.text??'')})`;
  const start=this.now(),timeout=r.timeoutMs??5000,navigations=tab.navigations;
  for(;;){
   const elapsedMs=Math.max(0,this.now()-start);
   if(until==='navigation'&&tab.navigations!==navigations)return {...this.result(b),waited:{until,satisfied:true,elapsedMs}};
   if(b.grant!==grant||b.state.owner!=='agent'||b.state.epoch!==r.epoch)fail('grant-unavailable','Stale browser control lease.');
   if(ref){
    if(ref.stale)fail('stale-observation','Frame changed. Observe again before acting.');
    const hit=await b.cdp.send('Runtime.evaluate',{expression,contextId:ref.context,returnByValue:true,timeout:1000},ref.session,{read:{timeoutMs:2000}});
    if(hit.exceptionDetails)fail('observe-failed',until==='selector'?'Invalid selector.':'Could not read this page.');
    if(b.grant!==grant||b.state.owner!=='agent'||b.state.epoch!==r.epoch)fail('grant-unavailable','Stale browser control lease.');
    if(hit.result?.value===true){b.state.observation=null;b.frames.clear();await this.observe(b,r.epoch);return {...this.result(b),waited:{until,satisfied:true,elapsedMs:Math.max(0,this.now()-start)}};}
   }
   if(elapsedMs>=timeout)return {...this.result(b),waited:{until,satisfied:false,elapsedMs}};
   await this.sleep(WAIT_POLL_MS);
  }
 }
 /** The attached page's own viewport (or one observed main-document element), never another tab or window. It is
 * returned to the caller and kept nowhere. A page that is not on screen is refused rather than waited for. */
 private async screenshot(b:Binding,r:BrowserAgentRequest):Promise<BrowserScreenshot>{
  const main=this.mainRef(b),read={read:{timeoutMs:READ_MS}};
  if(r.selector&&(r.frame&&r.frame!=='main'))fail('generic','An element screenshot covers the main document; capture the whole page for a frame.');
  if(r.selector&&(!b.state.observation||r.observationId!==b.state.observation.id))fail('stale-observation','Observe again before acting.');
  const visible=await b.cdp.send('Runtime.evaluate',{expression:'document.visibilityState',contextId:main.context,returnByValue:true},main.session,read);
  if(visible.result?.value!=='visible')fail('generic','This page is not on screen, so it cannot be captured. Ask the person to show it.');
  const metrics=await b.cdp.send('Page.getLayoutMetrics',{},main.session,read),view=metrics.cssVisualViewport??metrics.visualViewport??{};
  const vx=number(view.pageX),vy=number(view.pageY),vw=Number(view.clientWidth)||0,vh=Number(view.clientHeight)||0;
  let clip={x:vx,y:vy,width:vw,height:vh};
  if(r.selector){
   const box=await b.cdp.send('Runtime.evaluate',{expression:`(()=>{const e=globalThis.__atzElements?.get(${JSON.stringify(r.selector)});if(!e?.isConnected)return null;const r=e.getBoundingClientRect();return [r.left,r.top,r.width,r.height];})()`,contextId:main.context,returnByValue:true},main.session,read);
   const v=box.result?.value;if(!Array.isArray(v)||v.length!==4||v.some(n=>typeof n!=='number'||!Number.isFinite(n)))fail('stale-observation','Observed element unavailable');
   const left=Math.max(0,v[0]),top=Math.max(0,v[1]),right=Math.min(vw,v[0]+v[2]),bottom=Math.min(vh,v[1]+v[3]);
   clip={x:vx+left,y:vy+top,width:right-left,height:bottom-top};
  }
  if(!(clip.width>=1&&clip.height>=1))fail('generic','Nothing of it is on screen. Scroll it into view first.');
  const scale=Math.min(1,SHOT_EDGE/Math.max(clip.width,clip.height));
  for(const quality of [70,40]){
   const shot=await b.cdp.send('Page.captureScreenshot',{format:'jpeg',quality,clip:{...clip,scale},captureBeyondViewport:false},main.session,read);
   const data=typeof shot.data==='string'?shot.data:'';if(!data||!/^[A-Za-z0-9+/]+={0,2}$/.test(data))fail('observe-failed','Screenshot unavailable.');
   if(data.length<=SHOT_CHARS)return {mimeType:'image/jpeg',data,width:Math.max(1,Math.round(clip.width*scale)),height:Math.max(1,Math.round(clip.height*scale))};
  }
  return fail('observe-failed','Screenshot too large. Capture one observed element instead.');
 }
 reap(){for(const b of this.spaces.values())if(this.deps.runningSession(b.state.sessionId)?.targetId!==b.state.targetId){this.disconnect(b);this.spaces.delete(b.state.id);}}
 dispose(){for(const b of this.spaces.values())this.disconnect(b);this.spaces.clear();}
}
