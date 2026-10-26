import {invoke,isTauri} from '@tauri-apps/api/core';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {WorkroomBrowserFrameToolbar,type WorkroomBrowserPhase} from './WorkroomBrowserFrameToolbar';
import {WorkroomBrowserFrameTabStrip} from './WorkroomBrowserFrameTabStrip';
import {UnavailableState,PageErrorCard,PagePlaceholder} from './WorkroomBrowserFrameStates';
import {workroomBrowserUiCopy} from './workroomBrowserUiCopy';
import {classifyWorkroomBrowserError,type BrowserErrorCode} from './workroomBrowserErrorCodes';
import {workroomBrowserErrorCopy} from './workroomBrowserErrorCopy';
import {nativeNav,pageStateFrom,canRunNav,canReplaceLoadingRequest,canStopNav,type NativeNavFields,type NativeNavOperation} from './workroomBrowserNativeNav';
import {browserShortcut} from './workroomBrowserShortcuts';
import {BROWSER_TAB_LIMIT,type BrowserWorkspace,type BrowserRecoverySummary} from './workroomBrowserProtocol';
import type {Lang} from './i18n';
import {workroomBrowserStageCopy} from './workroomBrowserStageCopy';
import {workroomBrowserTabsCopy} from './workroomBrowserTabsCopy';
import type {WorkroomBrowserRequester} from './workroomBrowserClient';
import {claimOwnedConnect,forgetOwnedConnect,forgetOwnedConnects,normalizeOwnedBrowserAddress,ownedRequestIntent,ownedViewKey,pendingOwnedConnect,rememberOwnedConnect,startOwnedBrowser,type NativeReadiness,type OwnedBrowserStage,type OwnedRequestIntent,type OwnedStartupFailure} from './workroomBrowserNavigation';
/** One native tab of this Workroom, as native/workroom-browser lists them (oldest first). */
export type NativeTab={tab:string;targetId?:string|null;url?:string|null;title?:string;closed?:boolean;closing?:boolean;loading?:boolean;profileKey?:string;popupCount?:number};
export type NativeStatus={available:boolean;preparing?:boolean;sessionId?:string;targetId?:string;port?:number;human?:boolean;url?:string;closed?:boolean;closing?:boolean;popupCount?:number;notice?:string;profileKey?:string;loading?:boolean;readiness?:NativeReadiness;tab?:string;tabs?:NativeTab[]}&NativeNavFields;
/** The built-in page's state, as WorkroomBrowserFrame keeps it (`onPageState`): the request stage and its failure, the
 *  error shown, open login popups, a pending file notice, this Workroom's native tabs, the tab on screen and its status. */
export type WorkroomBrowserPageState={available?:boolean|null;opened?:boolean;phase:WorkroomBrowserPhase;failure:OwnedStartupFailure|null;error:string;errorCode?:BrowserErrorCode|null;popups:number;notice:string|null;tabs:NativeTab[];active:string;native:NativeStatus|null};
export type OwnedBrowserControls={retryConnect:()=>void;reconnect:()=>void;closePopups:()=>void;focusAddress:()=>void;openAddress:(url:string)=>void;close:()=>void};
export function ownedBrowserAction(sessionId:string,operation:string,extra:Record<string,unknown>={}){return invoke<NativeStatus>('workroom_browser_native',{sessionId,operation,...extra});}
/** A Workroom's first tab. Its native view keeps the Workroom's own key, so a caller that names no tab still reaches it. */
const MAIN='main';
/** The tabs not closed yet (a closing one still counts until it is gone). A native layer without a tab list has one page. */
function openTabs(s:NativeStatus):NativeTab[]{return Array.isArray(s.tabs)?s.tabs.filter(t=>!t.closed):s.available&&!s.closed&&!s.preparing?[{tab:MAIN,targetId:s.targetId,url:s.url,closing:s.closing,profileKey:s.profileKey}]:[];}
let tabSerial=0;
/** 1–16 lowercase letters and digits, as the native layer requires. */
const newTabName=()=>`t${Date.now().toString(36)}${(tabSerial++%36).toString(36)}`;
const pageAddress=(url?:string|null)=>url&&url!=='about:blank'?url:'';
const hostOf=(url?:string|null)=>{try{return url&&/^https?:/.test(url)?new URL(url).host:'';}catch{return '';}};
export function OwnedWorkroomBrowser({sessionId,targetId,visible,request,onConnected,workspace,recovery,lang,onClosed,onPageState,startCard,onChooseChrome,onControls,onRequestCloseBrowser}:{sessionId:string;targetId:string;visible:boolean;request:WorkroomBrowserRequester;onConnected:(w:BrowserWorkspace)=>void;workspace:BrowserWorkspace|null;recovery:BrowserRecoverySummary|null;lang:Lang;onClosed:()=>void;
 /** The page state as it changes, and null once this browser is gone; the frame decides what to show from it. */
 onPageState?:(state:WorkroomBrowserPageState|null)=>void;startCard?:ReactNode;onChooseChrome?:()=>void;onControls?:(controls:OwnedBrowserControls|null)=>void;onRequestCloseBrowser?:()=>void}){
 const [available,setAvailable]=useState<boolean|null>(null),[opened,setOpened]=useState(false),[url,setUrl]=useState(''),[error,setError]=useState(''),[failureCode,setFailureCode]=useState<BrowserErrorCode|null>(null);
 const captureError=(value:unknown)=>{setFailureCode(classifyWorkroomBrowserError(value));setError(value instanceof Error?value.message:String(value));};
 const addressInput=useRef<HTMLInputElement>(null),urlRef=useRef(url),lastPageUrl=useRef(''),fastUntil=useRef(0);urlRef.current=url;
 const stage=workroomBrowserStageCopy(lang),t=workroomBrowserTabsCopy(lang),[nativeStatus,setNativeStatus]=useState<NativeStatus|null>(null);
 // Separate start stages; a slow document is `loading`, never an error. `closing` covers an explicit close.
 const [phase,setPhaseState]=useState<WorkroomBrowserPhase>(null),[failure,setFailure]=useState<OwnedStartupFailure|null>(null);
 // This Workroom's native tabs and the one on screen. `multi` once the native layer reports a tab list at all.
 const [tabs,setTabsState]=useState<NativeTab[]>([]),[active,setActiveState]=useState(MAIN),[multi,setMulti]=useState(false);
 const tabsRef=useRef<NativeTab[]>([]),activeRef=useRef(MAIN),followed=useRef<string|undefined>(undefined),selection=useRef(0),selectionPending=useRef(false);
 const applyTabs=(s:NativeStatus)=>{if(!Array.isArray(s.tabs))return;setMulti(true);const next=openTabs(s);if(JSON.stringify(next)===JSON.stringify(tabsRef.current))return;tabsRef.current=next;setTabsState(next);};
 const setActive=(tab:string)=>{if(tab!==activeRef.current)setNativeStatus(null);activeRef.current=tab;setActiveState(tab);};
 useEffect(()=>{if(!opened||!visible)return;let alive=true,pending=false,timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{if(!alive||pending)return;pending=true;let loading=false;
   const tab=activeRef.current,generation=epoch.current,version=versions.current.get(tab)??0;
   try{const s=await ownedBrowserAction(sessionId,'status',{tab});if(alive&&epoch.current===generation&&activeRef.current===tab&&(versions.current.get(tab)??0)===version){
    setNativeStatus(s);applyTabs(s);loading=!!s.loading;
    const next=pageAddress(s.url),prior=lastPageUrl.current,dirty=urlRef.current!==prior,focused=document.activeElement===addressInput.current;
    // A cold renderer reports about:blank before accepting the requested document. Keep that person's address.
    if(!(phaseRef.current&&!next)){if(urlRef.current===next)lastPageUrl.current=next;else if(next!==prior&&!dirty&&!focused){lastPageUrl.current=next;setUrl(next);}}
   }}catch{/* A closed view is handled on open. */}finally{pending=false;if(alive)timer=setTimeout(()=>void poll(),loading||Date.now()<fastUntil.current?500:2000);}};
  void poll();return()=>{alive=false;clearTimeout(timer);};},[opened,visible,sessionId,active]);
 useEffect(()=>{if(recovery)setUrl('');},[recovery?.id]);
 const slot=useRef<HTMLDivElement>(null),mounted=useRef(true),epoch=useRef(0),versions=useRef(new Map<string,number>()),lastFrame=useRef('');
 // Every request owns one generation of its tab, the only thing that decides whether it is still current. Closing the
 // browser, unmounting, another Workroom or another choice ends every tab's (`epoch`); closing one tab ends only that
 // tab's. Whatever arrives afterwards finishes in that generation and is never attached here.
 const recoveryRef=useRef(recovery),workspaceRef=useRef(workspace),phaseRef=useRef<typeof phase>(null),flight=useRef<{intent:OwnedRequestIntent;tab:string}|null>(null);recoveryRef.current=recovery;workspaceRef.current=workspace;
 const stopFlight=useRef<{tab:string;version:number;epoch:number}|null>(null);
 const setPhase=(next:typeof phase)=>{phaseRef.current=next;setPhaseState(next);};
 /** A new generation of `tab` for `intent`, recorded before anything is awaited: from its first stage on, a changed
  * choice is measured against this request, never against an earlier one. */
 const begin=(intent:OwnedRequestIntent,first:OwnedBrowserStage,tab:string)=>{selection.current++;selectionPending.current=false;flight.current={intent,tab};setError('');setFailure(null);setPhase(first);const all=epoch.current,mine=(versions.current.get(tab)??0)+1;versions.current.set(tab,mine);return ()=>mounted.current&&all===epoch.current&&versions.current.get(tab)===mine;};
 // Choosing another saved task (or none) ends the request in whatever stage it is, and withdraws every tab's pending connect.
 useEffect(()=>{if(!phaseRef.current||phaseRef.current==='closing'||flight.current?.intent.recoveryId===recovery?.id)return;epoch.current++;forgetOwnedConnects(sessionId);setPhase(null);},[recovery?.id]);
 /** Whether a page is in this Workroom's own tab set: the pages its AI may use. */
 const inSet=(pageId:string)=>{const w=workspaceRef.current;return !!w&&(w.tabs??(w.page?[w.page]:[])).some(p=>p.id===pageId);};
 /** Navigation (only with `navigation`), target, document and broker connect of one tab for this generation. */
 const start=async(current:()=>boolean,intent:OwnedRequestIntent,tab:string,navigation?:{address:string;claim:number})=>{
  const {profileKey,recoveryId}=intent,key=ownedViewKey(sessionId,tab);
  // A page already in this Workroom's tab set only navigates; another tab of this Workroom connects and joins the set.
  const result=await startOwnedBrowser({action:(operation,extra)=>ownedBrowserAction(sessionId,operation,{...extra,tab}),request,current,sessionId,targetId,profileKey,recoveryId,url:navigation?.address,connect:pageId=>!inSet(pageId),onStage:next=>{if(current())setPhase(next);},onAccepted:()=>{if(navigation)rememberOwnedConnect(key,intent,navigation.claim);}});
  if(!current())return;
  if(result.kind==='connected'){forgetOwnedConnect(key);onConnected(result.workspace);return;}
  if(result.kind!=='failed'){forgetOwnedConnect(key);return;}
  // A failure after acceptance keeps its request so the connect alone can be retried; the page stays as it is.
  if(result.failure==='renderer-timeout'||result.failure==='no-document')forgetOwnedConnect(key);
  setFailureCode(result.failure==='target-lost'?'target-lost':classifyWorkroomBrowserError(result.error));setFailure(result.failure);setError(result.failure==='target-lost'?stage.targetLost:result.failure==='no-document'?stage.noDocument:String(result.error));
 };
 /** Finish only the connect of an accepted request of `tab`, as the saved task it was started for. A lost target reply
  * re-arms that tab's native probe; nothing navigates. Once another saved task is chosen, the request is no longer this one's. */
 const finish=async(intent:OwnedRequestIntent,retarget:boolean,tab:string)=>{
  const chosen=recoveryRef.current;if(phaseRef.current||chosen&&chosen.id!==intent.recoveryId)return;
  const current=begin(intent,'target',tab);
  try{if(retarget)await ownedBrowserAction(sessionId,'retarget',{tab});await start(current,intent,tab);}
  catch(e){if(current())captureError(e);}finally{if(current())setPhase(null);}
 };
 useEffect(()=>{mounted.current=true;setFailure(null);if(!isTauri()){setAvailable(false);return;}void ownedBrowserAction(sessionId,'availability').then(async r=>{if(!mounted.current)return;setAvailable(r.available);if(r.available){try{const listed=await ownedBrowserAction(sessionId,'tabs'),live=openTabs(listed);if(mounted.current&&live.length){applyTabs(listed);setOpened(true);
   // Shown again: the tab the Workroom works in, else its first tab.
   const shown=live.find(x=>!!x.targetId&&x.targetId===workspaceRef.current?.page?.id)??live.find(x=>x.tab===MAIN)??live[0]!;setActive(shown.tab);if(pageAddress(shown.url)){lastPageUrl.current=shown.url!;setUrl(shown.url!);}
   // Reopened (collapsed, another Workroom shown) while a tab's accepted request was still connecting: finish that connect.
   for(const x of live){const intent=pendingOwnedConnect(ownedViewKey(sessionId,x.tab));if(intent&&intent.profileKey===x.profileKey&&!(x.targetId&&inSet(x.targetId))){void finish(intent,false,x.tab);break;}}}}catch{/* No page yet. */}}}).catch(()=>setAvailable(false));return()=>{mounted.current=false;epoch.current++;phaseRef.current=null;void ownedBrowserAction(sessionId,'hide').catch(()=>{});};},[sessionId]);
 // The tab the AI works in is the one on screen: when it changes (an agent's switch-tab, a person's choice), follow it once.
 useEffect(()=>{const id=workspace?.page?.id;if(!id||followed.current===id)return;const match=tabs.find(x=>x.targetId===id);if(!match)return;followed.current=id;if(match.tab!==activeRef.current){setActive(match.tab);lastPageUrl.current=pageAddress(match.url);setUrl(lastPageUrl.current);}},[workspace?.page?.id,tabs]);
 useEffect(()=>{
  if(!opened||!available)return;
  const pageError=failure==='no-document'||!!pageStateFrom(nativeStatus).loadError;
  const tab=active;let disposed=false,raf=0;
  const update=()=>{raf=0;if(disposed)return;const r=slot.current?.getBoundingClientRect();
   // The Workroom itself is a modal dialog. Only another overlay (or the split divider's drag shield) hides its CEF sibling.
   const blocked=[...document.querySelectorAll('dialog[open],[aria-modal="true"],[role="menu"],[data-native-browser-shield]')].some(overlay=>!overlay.contains(slot.current));
   const show=visible&&!pageError&&document.visibilityState!=='hidden'&&!blocked&&r&&r.width>1&&r.height>1&&r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth;
   const frame=show?JSON.stringify([r.x,r.y,r.width,r.height]):'hide';if(frame===lastFrame.current)return;lastFrame.current=frame;
   void ownedBrowserAction(sessionId,show?'frame':'hide',show?{rect:[r.x,r.y,r.width,r.height],tab}:{tab}).catch(e=>{if(!disposed)captureError(e);});
  };
  const schedule=()=>{if(!raf)raf=requestAnimationFrame(update);};const observer=new ResizeObserver(schedule);if(slot.current)observer.observe(slot.current);
  const mutation=new MutationObserver(schedule);mutation.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['open','aria-modal','hidden','class','style']});
  addEventListener('resize',schedule);addEventListener('scroll',schedule,true);document.addEventListener('visibilitychange',schedule);schedule();
  // Only the tab on screen is framed; showing another tab hides this one first.
  return()=>{disposed=true;cancelAnimationFrame(raf);observer.disconnect();mutation.disconnect();removeEventListener('resize',schedule);removeEventListener('scroll',schedule,true);document.removeEventListener('visibilitychange',schedule);lastFrame.current='';void ownedBrowserAction(sessionId,'hide',{tab}).catch(()=>{});};
 },[opened,available,visible,sessionId,active,failure,!!nativeStatus?.loadError]);
 const open=async(addressOverride?:string)=>{
  const w=workspaceRef.current;if((phaseRef.current&&!canReplaceLoadingRequest(w?.owner??'human',phaseRef.current))||(w&&(w.connection!=='connected'||w.owner!=='human')))return;
  // A malformed replacement must not end the accepted request already loading in this tab.
  let address:string;try{address=normalizeOwnedBrowserAddress(addressOverride??urlRef.current);}catch(e){captureError(e);return;}
  fastUntil.current=Date.now()+5000;
  // A new human request for the tab on screen: it starts that tab's own generation.
  const tab=activeRef.current,key=ownedViewKey(sessionId,tab),intent=ownedRequestIntent({sessionId,recovery:recoveryRef.current,workspace:workspaceRef.current}),{profileKey}=intent,current=begin(intent,'profile',tab),claim=claimOwnedConnect(key);
  try{
   lastPageUrl.current=address;setUrl(address);
   // Every tab of a Workroom runs in one profile: an open tab of another profile closes them all. A browser still closing
   // (closed and reopened at once) finishes closing first, so the reopen gets a fresh page. One tab closed with × is
   // waited for only when it is this tab or of another profile; the other open tabs are never closed for it.
   const before=openTabs(await ownedBrowserAction(sessionId,'tabs'));if(!current())return;
   const live=before.filter(x=>!x.closing),closeAll=live.some(x=>x.profileKey!==profileKey);
   const gone=closeAll||!live.length?before:before.filter(x=>x.closing&&(x.tab===tab||x.profileKey!==profileKey));
   if(gone.length){if(closeAll)await ownedBrowserAction(sessionId,'close');const names=new Set(gone.map(x=>x.tab));for(let i=0;;i++){if(!current())return;if(!openTabs(await ownedBrowserAction(sessionId,'tabs')).some(x=>names.has(x.tab)))break;if(i===99)throw Error('Browser is still closing.');await new Promise(r=>setTimeout(r,50));}}
   // An ended request sends no further `open`: it would admit its profile after the next request has begun.
   for(let i=0;i<100;i++){if(!current())return;const opening=await ownedBrowserAction(sessionId,'open',{profileKey,tab});if(!opening.preparing){applyTabs(opening);break;}if(!current())return;await new Promise(r=>setTimeout(r,100));if(i===99)throw new Error('Chromium profile initialization timed out.');}
   if(!current())return;
   // Show the slot while the cold renderer prepares; a hidden 1px view may defer it.
   setOpened(true);
   await start(current,intent,tab,{address,claim});
  }catch(e){if(current())captureError(e);}finally{if(current())setPhase(null);}
 };
 /** Another tab of this Workroom, in the profile its connected page runs in. It joins the tab set once a page opens in it. */
 const addTab=async()=>{
  const w=workspaceRef.current;if(phaseRef.current||!w||w.connection!=='connected'||w.owner!=='human'||tabsRef.current.filter(x=>!x.closing).length>=BROWSER_TAB_LIMIT)return;
  const tab=newTabName(),intent=ownedRequestIntent({sessionId,recovery:recoveryRef.current,workspace:w}),current=begin(intent,'profile',tab);
  try{
   for(let i=0;i<100;i++){if(!current())return;const opening=await ownedBrowserAction(sessionId,'open',{profileKey:intent.profileKey,tab});if(!opening.preparing){applyTabs(opening);break;}if(!current())return;await new Promise(r=>setTimeout(r,100));if(i===99)throw new Error('Chromium profile initialization timed out.');}
   if(!current())return;setActive(tab);lastPageUrl.current='';setUrl('');
  }catch(e){if(current())captureError(e);}finally{if(current())setPhase(null);}
 };
 /** A person shows another tab. A tab in the set becomes the one the AI works in; a tab not connected yet is only shown. */
 const showTab=async(tab:string)=>{
  if(phaseRef.current||tab===activeRef.current&&!selectionPending.current)return;
  const currentWorkspace=workspaceRef.current;if(currentWorkspace&&(currentWorkspace.owner!=='human'||currentWorkspace.connection!=='connected'))return;
  const entry=tabsRef.current.find(x=>x.tab===tab);if(!entry)return;
  const selected=++selection.current,generation=epoch.current,version=versions.current.get(tab);selectionPending.current=false;
  setActive(tab);setError('');setFailure(null);lastPageUrl.current=pageAddress(entry.url);setUrl(lastPageUrl.current);fastUntil.current=Date.now()+5000;
  const w=workspaceRef.current;if(!w||!entry.targetId||!inSet(entry.targetId))return;
  // Even when the last host snapshot still names this page, an earlier select may be on its way to another one.
  selectionPending.current=true;
  const current=()=>mounted.current&&epoch.current===generation&&selection.current===selected&&versions.current.get(tab)===version&&workspaceRef.current?.id===w.id&&workspaceRef.current.owner==='human'&&workspaceRef.current.connection==='connected';
  try{const r=await request({operation:'select',workspaceId:w.id,pageId:entry.targetId,confirmProfile:true});if(current()&&r.workspace?.id===w.id&&r.workspace.page?.id===entry.targetId)onConnected(r.workspace);}catch(e){if(current())captureError(e);}finally{if(selection.current===selected)selectionPending.current=false;}
 };
 /** Close one tab: it leaves this Workroom's set first (never handed to anyone), then its page closes. Only that tab's request ends. */
 const closeTab=async(tab:string)=>{
  const wNow=workspaceRef.current;if(wNow&&(wNow.owner!=='human'||wNow.connection!=='connected'))return;
  const shown=tabsRef.current.filter(x=>!x.closing),entry=shown.find(x=>x.tab===tab);if(phaseRef.current||shown.length<2||!entry)return;
  selection.current++;selectionPending.current=false;
  versions.current.set(tab,(versions.current.get(tab)??0)+1);forgetOwnedConnect(ownedViewKey(sessionId,tab));
  const all=epoch.current,still=()=>mounted.current&&all===epoch.current;setPhase('closing');setError('');setFailure(null);
  try{
   if(tab===activeRef.current){const next=shown.find(x=>x.tab!==tab)!;setActive(next.tab);lastPageUrl.current=pageAddress(next.url);setUrl(lastPageUrl.current);}
   const w=workspaceRef.current;
   if(w&&w.connection==='connected'&&entry.targetId&&inSet(entry.targetId)){const r=await request({operation:'release',workspaceId:w.id,pageId:entry.targetId});if(r.workspace&&still())onConnected(r.workspace);}
   const closed=await ownedBrowserAction(sessionId,'close',{tab});if(still())applyTabs(closed);
  }catch(e){if(still())captureError(e);}finally{if(still())setPhase(null);}
 };
 const close=async()=>{
  const w=workspaceRef.current;if(w&&(w.owner!=='human'||w.connection!=='connected'))return;
  if(phaseRef.current==='closing'||phaseRef.current==='profile')return;
  // Closing ends every tab's request still loading or connecting; a late result is detached, never attached here.
  const token=++epoch.current;selection.current++;selectionPending.current=false;forgetOwnedConnects(sessionId);setPhase('closing');setError('');setFailure(null);
  try{if(w)await request({operation:'detach',workspaceId:w.id});await ownedBrowserAction(sessionId,'close');if(mounted.current&&epoch.current===token){setOpened(false);setNativeStatus(null);tabsRef.current=[];setTabsState([]);setActive(MAIN);lastPageUrl.current='';setUrl('');followed.current=undefined;onClosed();}}catch(e){if(mounted.current&&epoch.current===token)captureError(e);}finally{if(mounted.current&&epoch.current===token)setPhase(null);}
 };
 // The retry finishes the pending request only as its own saved task; another saved task chosen since is not offered it.
 const failedTab=flight.current?.tab??MAIN,pending=failure==='target-lost'||failure==='connect'?pendingOwnedConnect(ownedViewKey(sessionId,failedTab)):undefined,intent=pending&&(!recovery||recovery.id===pending.recoveryId)?pending:undefined;
 const phaseText=phase==='profile'?stage.preparing:phase==='navigating'?stage.navigating:phase==='target'?stage.target:phase==='loading'?stage.loading:phase==='connecting'?stage.connecting:'';
 const shownTabs=tabs.filter(x=>!x.closing),heldByAgent=!!workspace&&workspace.connection==='connected'&&workspace.owner!=='human';
 const canAdd=multi&&!!workspace&&workspace.source==='owned'&&workspace.connection==='connected'&&workspace.owner==='human';
 const popups=Math.max(multi?shownTabs.reduce((n,x)=>n+(x.popupCount??0),0):0,nativeStatus?.popupCount??0);
 const tabName=(x:NativeTab)=>workspace?.tabs?.find(p=>p.id===x.targetId)?.title||hostOf(x.url)||t.newTab;
 const notice=nativeStatus?.notice??null,reportPage=useRef(onPageState);reportPage.current=onPageState;
 useEffect(()=>{reportPage.current?.({available,opened,phase,failure,error,errorCode:failureCode,popups,notice,tabs,active,native:nativeStatus});},[available,opened,phase,failure,error,failureCode,popups,notice,tabs,active,nativeStatus]);
 useEffect(()=>()=>reportPage.current?.(null),[]);
 const aiHolds=!!workspace&&workspace.connection==='connected'&&(workspace.owner==='agent'||workspace.owner==='observing'||workspace.owner==='taking');
 const nativePage=pageStateFrom(nativeStatus),ui=workroomBrowserUiCopy(lang);
 const errorCode:BrowserErrorCode|null=error?(failure==='target-lost'?'target-lost':failureCode??classifyWorkroomBrowserError(error)):null;
 const errorSentence=errorCode?workroomBrowserErrorCopy(lang)[errorCode]:'';
 const pageFailed=failure==='no-document'||!!nativePage.loadError;
 const netCode=nativePage.loadError?.code;
 const loadCode:BrowserErrorCode=netCode===-102?'load-refused':netCode===-105?'load-name-not-resolved':netCode===-106?'load-offline':netCode===-7||netCode===-118?'load-timeout':netCode!==undefined&&netCode<=-200&&netCode>=-299?'load-certificate':'generic';
 const controlsEnabled=!workspace||(workspace.owner==='human'&&workspace.connection==='connected');
 const navigate=async(operation:NativeNavOperation)=>{
  const w=workspaceRef.current,owner=w?.owner??'human';if(!(operation==='stop'?canStopNav(owner,phaseRef.current):canRunNav(owner,phaseRef.current))||w&&w.connection!=='connected')return;
  const tab=activeRef.current;
  if(operation==='stop'&&stopFlight.current?.tab===tab&&stopFlight.current.version===(versions.current.get(tab)??0)&&stopFlight.current.epoch===epoch.current)return;
  if(operation==='stop'&&canReplaceLoadingRequest(owner,phaseRef.current)){
   // End only this tab's accepted request before awaiting Stop. A late status or acceptance cannot connect it;
   // another tab's work and any later explicit address request keep their own generation.
   versions.current.set(tab,(versions.current.get(tab)??0)+1);forgetOwnedConnect(ownedViewKey(sessionId,tab));flight.current=null;setPhase(null);
  }
  fastUntil.current=Date.now()+5000;setError('');setFailure(null);
  const version=versions.current.get(tab)??0,generation=epoch.current,stopToken={tab,version,epoch:generation};
  if(operation==='stop')stopFlight.current=stopToken;
  const current=()=>mounted.current&&epoch.current===generation&&activeRef.current===tab&&(versions.current.get(tab)??0)===version;
  try{const status=await nativeNav(sessionId,tab,operation);if(current()){setNativeStatus(status);applyTabs(status);}}catch(e){if(current())captureError(e);}finally{if(stopFlight.current===stopToken)stopFlight.current=null;}
 };
 const focusAddress=()=>{addressInput.current?.focus();addressInput.current?.select();};
 const handlers=useRef<OwnedBrowserControls|null>(null);handlers.current={retryConnect:()=>{if(intent&&!phaseRef.current)void finish(intent,failure==='target-lost',failedTab);},reconnect:()=>{const chosen=ownedRequestIntent({sessionId,recovery:recoveryRef.current,workspace:workspaceRef.current});void finish(chosen,true,activeRef.current);},closePopups:()=>{void ownedBrowserAction(sessionId,'close-popups').catch(e=>captureError(e));},focusAddress,openAddress:value=>void open(value),close:()=>void close()};
 const controlsCallback=useRef(onControls);controlsCallback.current=onControls;
 useEffect(()=>{const proxy:OwnedBrowserControls={retryConnect:()=>handlers.current?.retryConnect(),reconnect:()=>handlers.current?.reconnect(),closePopups:()=>handlers.current?.closePopups(),focusAddress:()=>handlers.current?.focusAddress(),openAddress:value=>handlers.current?.openAddress(value),close:()=>handlers.current?.close()};controlsCallback.current?.(proxy);return()=>controlsCallback.current?.(null);},[sessionId]);
 const shortcut=useRef<(event:KeyboardEvent,fromNative?:boolean)=>void>(()=>{});shortcut.current=(event,fromNative=false)=>{
  if(event.defaultPrevented||event.isComposing||!visible)return;
  if(!fromNative){const target=event.target as Element|null;if(target?.closest('.xterm,.workroom-browser-terminal'))return;
   const within=target?.closest('[data-testid=workroom-browser-panel],[data-testid=workroom-browser-frame]');if(!within&&!nativePage.focused)return;}
  const decision=browserShortcut(event,{owner:workspace?.owner??'human',connection:workspace?.connection??'connected',navSupported:nativePage.supported,canGoBack:nativePage.canBack,canGoForward:nativePage.canForward,tabCount:shownTabs.length,hasPage:opened});
  if(decision.outcome==='ignore')return;event.preventDefault();event.stopPropagation();if(decision.outcome==='blocked')return;
  const action=decision.action;if(action.kind==='focus-omnibox'){focusAddress();return;}if(phaseRef.current)return;
  if(action.kind==='new-tab')void addTab();else if(action.kind==='select-tab'){const tab=shownTabs[action.index];if(tab)void showTab(tab.tab);}else void navigate(action.kind);
 };
 const nativeShortcut=useRef<(detail:unknown)=>void>(()=>{});nativeShortcut.current=value=>{
  if(!value||typeof value!=='object'||!visible||!opened)return;
  const detail=value as Record<string,unknown>;
  if(detail.source!=='cef'||detail.sessionId!==sessionId||detail.tab!==activeRef.current||typeof detail.key!=='string'||!/^[lr\[\]t1-6]$/.test(detail.key))return;
  if(detail.targetId!==null&&typeof detail.targetId!=='string')return;
  const target=tabsRef.current.find(tab=>tab.tab===activeRef.current)?.targetId;if(detail.targetId&&target&&detail.targetId!==target)return;
  shortcut.current(new KeyboardEvent('keydown',{key:detail.key,metaKey:true,cancelable:true}),true);
 };
 useEffect(()=>{const handle=(event:KeyboardEvent)=>shortcut.current(event),native=(event:Event)=>nativeShortcut.current((event as CustomEvent).detail);document.addEventListener('keydown',handle);document.addEventListener('agentstoz-native-browser-shortcut',native);return()=>{document.removeEventListener('keydown',handle);document.removeEventListener('agentstoz-native-browser-shortcut',native);};},[]);
 return <div className="owned-workroom-browser" data-testid="owned-workroom-browser" data-page-url={nativePage.url}>
  <div className="workroom-browser-tab-row">
   {opened&&multi&&<WorkroomBrowserFrameTabStrip lang={lang} source="owned" tabs={shownTabs.map(x=>({key:x.tab,title:x.title||tabName(x),host:hostOf(x.url),url:x.url,loading:!!x.loading,aiActive:aiHolds&&!!x.targetId&&x.targetId===workspace?.page?.id}))} activeKey={active} onSelect={tab=>void showTab(tab)} onClose={tab=>void closeTab(tab)} onAdd={()=>void addTab()} disabled={!!phase||!controlsEnabled} addDisabled={!!phase||!canAdd||shownTabs.length>=BROWSER_TAB_LIMIT}/>}
  </div>
  <WorkroomBrowserFrameToolbar lang={lang} url={url} pageUrl={pageAddress(nativePage.url)||lastPageUrl.current} inputRef={addressInput} onUrlChange={setUrl} onSubmit={value=>void open(value)} phase={phase} disabled={!!phase} canReplaceLoad={controlsEnabled&&canReplaceLoadingRequest(workspace?.owner??'human',phase)} readOnly={!controlsEnabled} openDisabled={available!==true}
   nav={{supported:nativePage.supported,canBack:nativePage.canBack,canForward:nativePage.canForward,loading:nativePage.loading||canReplaceLoadingRequest(workspace?.owner??'human',phase),disabled:!!phase||!controlsEnabled,stopDisabled:!controlsEnabled||!canStopNav(workspace?.owner??'human',phase),onBack:()=>void navigate('back'),onForward:()=>void navigate('forward'),onReload:()=>void navigate('reload'),onStop:()=>void navigate('stop')}}
   progress={{active:!!phase&&phase!=='closing'||nativePage.loading,value:nativePage.loading?nativePage.progress:null}}
   ownerPill={workspace?{owner:workspace.owner,label:workspace.connection==='disconnected'?ui.owner.disconnectedOwned:ui.owner[workspace.owner==='human'?'human':workspace.owner==='agent'?'agent':workspace.owner==='taking'?'taking':'observing'],pending:workspace.owner==='taking'||workspace.owner==='observing'}:undefined}
   menu={opened?{onCloseBrowser:()=>void close(),closeDisabled:phase==='profile'||phase==='closing'||!controlsEnabled,tabCount:shownTabs.length,...(workspace&&onRequestCloseBrowser?{onRequestCloseBrowser}:{})}:undefined}/>
  <div className="workroom-browser-stage" data-testid="workroom-browser-stage" data-ai={aiHolds?'':undefined}>
   <div className="owned-workroom-browser-slot" ref={slot} data-testid="owned-browser-slot" data-tab={active}>
    {pageFailed?<PageErrorCard lang={lang} host={hostOf(nativePage.loadError?.url||url)} code={loadCode} onRetry={()=>{if(nativePage.supported&&workspace)void navigate('reload');else void open();}} onEditAddress={focusAddress}/>
     :opened?<PagePlaceholder lang={lang} title={nativePage.title||workspace?.page?.title} host={hostOf(nativePage.url||workspace?.page?.url)} loading={!!phase||nativePage.loading}/>
     :available===false?<UnavailableState lang={lang} onConnectChrome={onChooseChrome}/>:startCard}
   </div>
  </div>
  {/* Fixed-height messages never move the page. A failed connection keeps the loaded native page intact. */}
  <div className="workroom-browser-page-message" data-connected={workspace?'':undefined} aria-hidden={workspace?true:undefined}>
   {error&&!workspace&&!pageFailed&&<div role="alert" data-testid="owned-browser-error" data-error-code={errorCode??'generic'} data-failure={failure??undefined}>{errorSentence}{intent&&!phase&&<button type="button" className="wb-text-btn" data-testid="owned-browser-retry-connect" onClick={()=>handlers.current?.retryConnect()}>{ui.owner.retryConnect}</button>}</div>}
   {!error&&phaseText&&<span role="status" data-testid="owned-browser-stage" data-stage={phase} title={phaseText}>{phase==='connecting'?ui.owner.stageConnecting:phase==='loading'?ui.owner.stageLoading:ui.owner.stageOpening}</span>}
   {!error&&!phase&&popups>0&&<span role="status" data-testid="owned-browser-popups">{stage.popup}<button type="button" className="wb-text-btn" data-testid="workroom-browser-popups-close" onClick={()=>handlers.current?.closePopups()}>{stage.closePopups}</button></span>}
   {!error&&!phase&&!popups&&notice&&<span role="status" data-testid="owned-browser-file-notice">{stage.file}</span>}
  </div>
 </div>;
}
