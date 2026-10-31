import React,{useEffect,useRef} from 'react';import{createRoot}from'react-dom/client';import{invoke}from'@tauri-apps/api/core';
import{getCurrentWindow,LogicalSize}from'@tauri-apps/api/window';
import{AiTerminalPanel}from'../../src/AiTerminalPanel';import'../../src/index.css';import'../../src/workspaceDesign.css';
// This fixture mirrors the directory's fieldset wrapper as well as its dialog.
// Load its actual sizing rules, rather than a test-only terminal height.
import'../../src/WorkroomSessionDirectory.css';
import{readAppLanguage}from'../../src/i18n';import{workroomBrowserUiCopy}from'../../src/workroomBrowserUiCopy';import{workroomBrowserPageErrorCopy}from'../../src/workroomBrowserErrorCopy';
const ctx=await invoke<{session:{id:string;targetId:string};sibling:{id:string;targetId:string};fixtureUrl:string;refusedUrl:string;restoreOnly?:boolean;mode?:'main'|'cold'|'slow'|'lost';restoreDelayMs?:number;restoreProfileKey?:string}>('qa_context');
// One animation frame, or false when WKWebView withholds them: an occluded or hidden window suspends them.
const nextFrame=(ms:number)=>new Promise<boolean>(resolve=>{const timer=setTimeout(()=>resolve(false),ms);requestAnimationFrame(()=>{clearTimeout(timer);resolve(true);});});
// Waits for animation frames, asking the host to raise its window (qa_raise) whenever they stall, within one budget.
// A raise floats the window above every other one; once frames return it is lowered to a normal window (qa_lower).
const lower=()=>invoke('qa_lower').catch(()=>{});
const frames=async(count:number,stage:string,budgetMs=5000)=>{
 const deadline=Date.now()+budgetMs;let seen=0,raised:unknown=null;
 while(seen<count){const left=deadline-Date.now();
  if(left<=0)throw Error(`Native QA viewport animation frames were suspended: ${JSON.stringify({stage,visibilityState:document.visibilityState,hasFocus:document.hasFocus(),raised})}`);
  if(await nextFrame(Math.min(1000,left)))seen++;else raised=await invoke('qa_raise').catch(String);}
 if(raised!==null)await lower();
};
// Layout has settled when the same geometry repeats over three consecutive animation frames; no fixed sleep stands in.
const settle=async(label:string,signature:()=>string,budgetMs=5000)=>{
 const deadline=Date.now()+budgetMs;let previous=signature(),repeats=0;
 while(repeats<2){
  if(Date.now()>=deadline)throw Error(`${label}: layout did not settle within ${budgetMs}ms: ${JSON.stringify({last:previous,visibilityState:document.visibilityState,hasFocus:document.hasFocus()})}`);
  await frames(1,label,Math.max(1,deadline-Date.now()));const now=signature();repeats=now===previous?repeats+1:0;previous=now;
 }
};
// A small physical display exercises the same CSS baseline as the original large-screen native QA.
// Measure each bounded correction instead of assuming a titlebar size or fractional native size rounding.
try{
 const baselineWindow=getCurrentWindow(),scale=await baselineWindow.scaleFactor();
 for(let attempt=0;attempt<3&&(innerWidth!==800||innerHeight!==814);attempt++){
  const physical=await baselineWindow.innerSize(),logical=physical.toLogical(scale),measured={width:innerWidth,height:innerHeight},logicalPerCssPixel=logical.width/measured.width;
  if(!Number.isFinite(logicalPerCssPixel)||logicalPerCssPixel<=0)throw Error('Invalid measured native QA viewport scale');
  await baselineWindow.setSize(new LogicalSize(logical.width+(800-measured.width)*logicalPerCssPixel,logical.height+(814-measured.height)*logicalPerCssPixel));
  await frames(2,'qa-viewport-calibration');
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 if(innerWidth!==800||innerHeight!==814)throw Error(`Native QA could not establish its 800x814 CSS baseline: ${JSON.stringify({after:{width:innerWidth,height:innerHeight},physical:await baselineWindow.innerSize(),scale})}`);
 // The host floats the window from launch for this calibration; with frames flowing it stays in front as a normal window.
 await frames(1,'qa-viewport-calibration');await lower();
}catch(error){await invoke('qa_finish',{report:{passed:false,checks:[],error:String(error),stage:'qa-viewport-calibration'}});throw error;}
localStorage.setItem('portmanager-workroom-font-size','16');
function InstalledWorkroom(){const dialog=useRef<HTMLDialogElement>(null);useEffect(()=>{dialog.current?.showModal();},[]);return <dialog ref={dialog} className="workroom-session-dialog" aria-label="설치 앱 대화 창"><header className="workroom-session-dialog-header">실제 설치 창의 브라우저 검증</header><div className="workroom-session-dialog-content"><fieldset className="session-directory-view-controls"><AiTerminalPanel popout projects={[{targetId:ctx.session.targetId,label:'임시 실제 PTY 워크룸'}]} entry={{nonce:1,targetId:ctx.session.targetId,sessionId:ctx.session.id}} sessionScope="native-browser-qa"/></fieldset></div></dialog>;}
createRoot(document.getElementById('root')!).render(<InstalledWorkroom/>);
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const wait=async<T,>(fn:()=>T):Promise<NonNullable<T>>=>{for(let i=0;i<300;i++){const r=fn();if(r)return r as NonNullable<T>;await delay(100);}throw Error('Native Workroom QA wait timed out.');};
const visible=(el:HTMLElement|null):el is HTMLElement=>!!el&&el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden';
/** K0 hooks survive toolbar copy/layout changes. K1 may move Close into the overflow menu. */
const button=async(testId:string,root:ParentNode=document)=>{
 let openedMenu=false;
 const el=await wait(()=>{
  const target=root.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if(visible(target)&&!target.disabled)return target;
  if(testId==='owned-browser-close'&&!visible(target)&&!openedMenu){
   const menu=root.querySelector<HTMLButtonElement>('[data-testid="workroom-browser-menu"]');
   if(visible(menu)&&!menu.disabled){openedMenu=true;menu.click();}
  }
  return null;
 });
 el.click();await delay(100);
 if(testId==='owned-browser-close'){
  const confirm=root.querySelector<HTMLButtonElement>('[data-testid="workroom-browser-close-confirm"],[data-testid="workroom-browser-close-all-confirm"]');
  if(visible(confirm)){const ready=await wait(()=>!confirm.disabled&&visible(confirm)?confirm:null);ready.click();await delay(100);}
 }
};
const pageUrl=()=>document.querySelector('aside[data-testid="workroom-browser-panel"][data-page-url]')?.getAttribute('data-page-url')??'';
const ask=async(path:string,body:unknown)=>{const r=await invoke<{status:number;body:any}>('agent_runtime_request',{path,method:'POST',body});if(r.status!==200||r.body.success===false)throw Error(r.body.error);return r.body;};
type BrowserAccess={workspaceId:string;grant:string;epoch:number};
type QaBrowserState={connected:boolean;resume:number;grant:number;access?:BrowserAccess|null};
const browserState=async(access=false):Promise<QaBrowserState>=>ask('/qa-human',{operation:access?'browser-access':'browser-state',sessionId:ctx.session.id});
// QA-only module locals. Neither these values nor the host's observed response are put on window, DOM or storage.
const privateGrants=new Set<string>();
const redact=(value:unknown)=>String(value).replace(/\b[a-f0-9]{64}\b/gi,'[redacted browser grant]');
const assertPrivateAccess=()=>{
 const text=[document.documentElement.outerHTML,...[...document.querySelectorAll<HTMLInputElement|HTMLTextAreaElement>('input,textarea')].map(e=>e.value),...[localStorage,sessionStorage].flatMap(store=>Object.keys(store).map(key=>store.getItem(key)??''))].join('\n');
 if([...privateGrants].some(grant=>text.includes(grant)))throw Error('Browser access leaked into visible markup, form values or persistent storage');
 if([...document.querySelectorAll<HTMLTextAreaElement>('textarea')].some(e=>/workspaceId=|grant=|agentstoz_use_workroom_browser/.test(e.value)))throw Error('A machine access block replaced the person\'s composer draft');
};
const handoff=async():Promise<BrowserAccess>=>{
 const before=await browserState();await button('workroom-browser-handoff');
 await wait(()=>{const chip=document.querySelector<HTMLElement>('[data-testid=workroom-browser-handoff-chip][data-state=ready]');return visible(chip)?chip:null;});
 const after=await browserState(true),access=after.access;
 if(after.resume!==before.resume+1||after.grant!==before.grant+1||!access||!access.workspaceId||!/^[a-f0-9]{64}$/.test(access.grant)||!Number.isInteger(access.epoch))throw Error('One UI handoff did not issue exactly one resume and one actual grant response');
 privateGrants.add(access.grant);assertPrivateAccess();return access;
};
/** A closed browser keeps its start slot. Prove actual native cleanup and broker detach instead of DOM removal. */
const closedToStart=async()=>{
 for(let i=0;i<300;i++){
  const native=await invoke<{tabs?:{closed:boolean}[]}>('workroom_browser_native',{sessionId:ctx.session.id,operation:'tabs'}),state=await browserState();
  if(Array.isArray(native.tabs)&&native.tabs.length>0&&native.tabs.every(tab=>tab.closed)&&!state.connected&&!pageUrl()&&visible(document.querySelector<HTMLElement>('[data-testid=workroom-browser-empty]'))&&visible(document.querySelector<HTMLElement>('[data-testid=workroom-browser-recoveries]'))){assertPrivateAccess();return;}
  await delay(100);
 }
 throw Error('Closing did not end every native tab, detach its workspace and return to the saved-task start card');
};
const checks:string[]=[];
// Snapshot while the app is still alive. Runner totals can also include normal renderer teardown after qa_finish.
let topLevelNavigation:{idleMs:number;inspectorDetached:number;rendererGone:number;targetClosed:number;otherInspectorDetached:number;cdpClosed:number}|undefined;
// Geometry only: no text, form values, workspace access or storage belongs in a layout failure report or probe.
const nodeName=(e:Element)=>`${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]}`;
// The native page cannot scroll with the Workroom: each part must lie inside the viewport and the padding box of every
// ancestor that clips or scrolls it (the panel's overflow:auto, the dialog's overflow:hidden, ...).
const clipBoxes=(node:Element)=>{const boxes=[{name:'viewport',top:0,left:0,bottom:innerHeight,right:innerWidth}];
 for(let e=node.parentElement;e;e=e.parentElement){const s=getComputedStyle(e);if(s.display==='contents'||(s.overflowX==='visible'&&s.overflowY==='visible'))continue;const b=e.getBoundingClientRect(),top=b.top+e.clientTop,left=b.left+e.clientLeft;boxes.push({name:nodeName(e),top,left,bottom:top+e.clientHeight,right:left+e.clientWidth});}
 return boxes;};
const trustedParts={frame:'[data-testid=workroom-browser-frame]',panel:'[data-testid=workroom-browser-panel]',slot:'[data-testid=owned-browser-slot]',heightHandle:'[data-testid=workroom-browser-height-divider]'};
const clippedParts=()=>{const out:string[]=[];
 for(const [part,selector] of Object.entries(trustedParts)){const node=document.querySelector(selector);if(!node){out.push(`${part} missing`);continue;}const r=node.getBoundingClientRect();
  for(const c of clipBoxes(node))if(r.top<c.top-.5||r.left<c.left-.5||r.bottom>c.bottom+.5||r.right>c.right+.5)out.push(`${part} ${JSON.stringify([r.left,r.top,r.right,r.bottom])} outside ${c.name} ${JSON.stringify([c.left,c.top,c.right,c.bottom])}`);}
 return out;};
const ancestorChain=()=>{const out:Array<Record<string,unknown>>=[];for(let e=document.querySelector(trustedParts.frame);e&&e!==document.body;e=e.parentElement){const r=e.getBoundingClientRect();out.push({node:nodeName(e),top:r.top,bottom:r.bottom,scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,overflow:getComputedStyle(e).overflow});}return out;};
const childBoxes=(selector:string)=>[...(document.querySelector(selector)?.children??[])].map(e=>{const r=e.getBoundingClientRect();return {node:nodeName(e),top:r.top,height:r.height};});
const layoutSignature=()=>JSON.stringify([innerWidth,innerHeight,...Object.values(trustedParts).map(selector=>{const r=document.querySelector(selector)?.getBoundingClientRect();return r?[r.x,r.y,r.width,r.height].map(n=>Math.round(n*2)/2):null;}),...ancestorChain().map(a=>a.scrollTop)]);
// One bounded geometry line per stage through qa_log; the runner copies them into report.json on success and failure.
const probe=(stage:string)=>invoke('qa_log',{line:JSON.stringify({stage,viewport:[innerWidth,innerHeight],
 parts:Object.fromEntries(Object.entries(trustedParts).map(([part,selector])=>{const r=document.querySelector(selector)?.getBoundingClientRect();return [part,r?[r.x,r.y,r.width,r.height]:null];})),
 ranges:['workroom-browser-divider','workroom-browser-height-divider'].map(id=>{const e=document.querySelector(`[data-testid=${id}]`);return e?['aria-valuemin','aria-valuenow','aria-valuemax','aria-disabled'].map(a=>e.getAttribute(a)):null;}),
 outside:clippedParts(),ancestors:ancestorChain(),body:childBoxes('.ai-terminal-body'),visibilityState:document.visibilityState,hasFocus:document.hasFocus()})}).catch(()=>{});
const layoutDiagnostics=()=>{
 const number=(value:string)=>parseFloat(value)||0;
 const inspect=(e:Element|null)=>{if(!e)return null;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {rect:{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right},clientHeight:e.clientHeight,scrollHeight:e.scrollHeight,style:Object.fromEntries(['display','height','minHeight','maxHeight','width','padding','paddingTop','paddingBottom','margin','marginTop','marginBottom','gap','rowGap','columnGap','borderTopWidth','borderBottomWidth','boxSizing','flex','flexBasis','flexGrow','flexShrink','gridTemplateRows','overflow'].map(key=>[key,s[key as keyof CSSStyleDeclaration]]))};};
 const selectors={frame:'[data-testid=workroom-browser-frame]',panes:'.workroom-browser-panes',column:'.workroom-browser-column',panel:'[data-testid=workroom-browser-panel]',stage:'[data-testid=workroom-browser-stage]',slot:'[data-testid=owned-browser-slot]',heightHandle:'[data-testid=workroom-browser-height-divider]'};
 const frame=document.querySelector(selectors.frame),parent=frame?.parentElement;let parentAvailable=null;
 if(parent){const style=getComputedStyle(parent),visible=[...parent.children].filter(e=>getComputedStyle(e).display!=='none'),siblings=visible.filter(e=>e!==frame),padding=number(style.paddingTop)+number(style.paddingBottom),occupied=siblings.reduce((sum,e)=>{const s=getComputedStyle(e);return sum+e.getBoundingClientRect().height+number(s.marginTop)+number(s.marginBottom);},0),gaps=number(style.rowGap)*Math.max(0,visible.length-1);parentAvailable={clientHeight:parent.clientHeight,padding,occupiedBySiblings:occupied,gaps,availableForFrame:parent.clientHeight-padding-occupied-gaps,parent:inspect(parent),siblings:siblings.map(e=>({tag:e.tagName,className:String(e.className),...inspect(e)}))};}
 const column=document.querySelector(selectors.column),panel=document.querySelector(selectors.panel),handle=document.querySelector(selectors.heightHandle),columnStyle=column&&getComputedStyle(column),handleStyle=handle&&getComputedStyle(handle),panelRect=panel?.getBoundingClientRect(),slotRect=document.querySelector(selectors.slot)?.getBoundingClientRect();
 const columnAvailable=column&&columnStyle&&handle&&handleStyle?{contentHeight:column.clientHeight-number(columnStyle.paddingTop)-number(columnStyle.paddingBottom),handleOuterHeight:handle.getBoundingClientRect().height+number(handleStyle.marginTop)+number(handleStyle.marginBottom),gap:number(columnStyle.rowGap),availablePanelHeight:column.clientHeight-number(columnStyle.paddingTop)-number(columnStyle.paddingBottom)-handle.getBoundingClientRect().height-number(handleStyle.marginTop)-number(handleStyle.marginBottom)-number(columnStyle.rowGap),panelHeightFor200pxPage:panelRect&&slotRect?panelRect.height+200-slotRect.height:null}:null;
 return {nodes:Object.fromEntries(Object.entries(selectors).map(([name,selector])=>[name,inspect(document.querySelector(selector))])),frameParent:parentAvailable,columnAvailable,frameChildren:frame?[...frame.children].map(e=>({tag:e.tagName,className:String(e.className),...inspect(e)})):[],
  outside:clippedParts(),ancestors:ancestorChain(),bodyChildren:childBoxes('.ai-terminal-body'),panelChildren:childBoxes('.ai-terminal-panel')};
};
try{
 // Exercise both K0's direct Close and K1's planned menu-only Close in the real
 // trusted webview. No production component or native scenario is replaced.
 if(!ctx.restoreOnly){
  const host=document.createElement('div');document.body.append(host);
  try{
   let closed=0,opened=0;
   const close=document.createElement('button');close.dataset.testid='owned-browser-close';close.textContent='Direct fixture close';close.onclick=()=>{closed++;};host.append(close);
   await button('owned-browser-close',host);if(closed!==1)throw Error('Direct close hook did not run exactly once');close.remove();
   const menu=document.createElement('button');menu.dataset.testid='workroom-browser-menu';menu.textContent='Fixture menu';
   menu.onclick=()=>{opened++;host.append(close);};host.append(menu);
   await button('owned-browser-close',host);if(Number(opened)!==1||Number(closed)!==2)throw Error('Menu close hook did not open once and close once');
   close.remove();close.onclick=()=>{const confirm=document.createElement('button');confirm.dataset.testid='workroom-browser-close-confirm';confirm.textContent='Confirm fixture close';confirm.onclick=()=>{closed++;confirm.remove();};host.append(confirm);};
   await button('owned-browser-close',host);if(Number(opened)!==2||Number(closed)!==3)throw Error('Menu close confirmation did not run exactly once');
  }finally{host.remove();}
 }
 if(ctx.restoreOnly){
  type Native={port:number;targetId:string|null;profileKey:string;visible:boolean;closed:boolean;url:string|null;loading:boolean;rect:number[];readiness:{navigations:number;targetProbes:number;targetResults:number}&Record<string,unknown>};
  const restoreUrl=new URL('/restore',ctx.fixtureUrl).href,mine=()=>invoke<Native>('workroom_browser_native',{sessionId:ctx.session.id,operation:'status'});
  const stats=async()=>(await ask('/qa-human',{operation:'stats'})) as {restoreHits:number;connects:number};
  const until=async(label:string,fn:()=>Promise<boolean>)=>{for(let i=0;i<300;i++){if(await fn())return;await delay(100);}throw Error(label);};
  const stage=()=>document.querySelector('[data-testid=owned-browser-stage]')?.getAttribute('data-stage');
  const alert=()=>document.querySelector('[data-testid=owned-browser-error]');
  const slot=()=>document.querySelector('[data-testid=owned-browser-slot]');
  const connected=()=>pageUrl()===restoreUrl;
  const toggle=async()=>(await wait(()=>document.querySelector<HTMLButtonElement>('[data-testid=workroom-browser-toggle]'))).click();
  // The browser frame is keyed by session: wait until the chosen session's frame replaced the previous one.
  const showSession=async(id:string)=>{(await wait(()=>document.querySelector<HTMLButtonElement>(`[data-session-id="${id}"]`))).click();await wait(()=>document.querySelector(`[data-session-id="${id}"][aria-selected=true]`));await delay(300);};
  // Broker connection precedes the ResizeObserver/native-layout effects. Await their bounded
  // completion, then assert the same window bounds; never reopen or navigate to make them fit.
  const inView=async(label:string)=>{
   let previous:number[]|null=null,last:unknown;
   const aligned=(r:DOMRect,n:Native)=>n.visible&&n.profileKey===ctx.restoreProfileKey&&n.rect.length===4&&[r.x,r.y,r.width,r.height].every((value,index)=>Number.isFinite(n.rect[index])&&Math.abs(value-n.rect[index]!)<=1);
   try{await until(`${label}: the native page never settled inside its trusted slot`,async()=>{
    const r=slot()?.getBoundingClientRect(),n=await mine();last={slot:r&&[r.x,r.y,r.width,r.height],native:n.rect,visible:n.visible,profile:n.profileKey,viewport:[innerWidth,innerHeight]};
    if(!r||r.width<=1||r.height<200||r.top<0||r.left<0||r.bottom>innerHeight||r.right>innerWidth||!aligned(r,n)){previous=null;return false;}
    const current=[r.x,r.y,r.width,r.height],stable=previous?.every((value,index)=>Math.abs(value-current[index]!)<=1);previous=current;return !!stable;
   });}catch(error){throw Error(`${String(error)}: ${JSON.stringify(last)}`);}
   const r=(await wait(slot)).getBoundingClientRect(),n=await mine();
   if(r.width<=1||r.height<200||r.top<0||r.left<0||r.bottom>innerHeight||r.right>innerWidth||!aligned(r,n))throw Error(`${label}: the page slot or native view left its settled bounds ${JSON.stringify({slot:[r.x,r.y,r.width,r.height],native:n.rect,visible:n.visible,viewport:[innerWidth,innerHeight]})}`);
  };
  const expectCounts=async(label:string,want:{restoreHits:number;connects:number;navigations:number})=>{const [s,n]=await Promise.all([stats(),mine()]);const got={restoreHits:s.restoreHits,connects:s.connects,navigations:n.readiness.navigations};if(JSON.stringify(got)!==JSON.stringify(want))throw Error(`${label}: ${JSON.stringify({want,got})}`);};
  const chooseSaved=async()=>{
   const history=await wait(()=>document.querySelector<HTMLDetailsElement>('[data-testid=workroom-browser-recoveries]'));history.open=true;
   (await wait(()=>history.querySelector<HTMLButtonElement>('[data-testid=workroom-browser-recover]'))).click();if(history.open)throw Error('Cold recovery history did not collapse');
   const input=await wait(()=>document.querySelector<HTMLInputElement>('[data-testid=owned-browser-address]'));
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,restoreUrl.replace(/^http:\/\//,''));input.dispatchEvent(new Event('input',{bubbles:true}));
   await button('owned-browser-open');
  };
  // Samples each 100ms poll until connected: a slow document must show `loading` and never an error.
  const watchUntilConnected=async(label:string)=>{let loading=false;await wait(()=>{if(stage()==='loading')loading=true;if(alert())throw Error(`${label}: ${alert()!.textContent}`);return connected();});return loading;};
  await wait(()=>document.querySelector('.xterm-rows')?.textContent?.includes('REAL_PTY_READY'));await toggle();await chooseSaved();
  if(ctx.mode==='cold'){
   const sawLoading=await watchUntilConnected('Cold recovery failed');
   // Broker attachment can precede the layout effect that shows the native view.
   // Wait for the same profile, target and visibility that we assert below.
   await until('Cold recovery never showed its exact saved native profile',async()=>{const s=await mine();return s.profileKey===ctx.restoreProfileKey&&s.visible&&!!s.targetId;});
   const s=await mine();
   if(s.profileKey!==ctx.restoreProfileKey||!s.visible||!s.targetId)throw Error('Cold recovery selected the wrong profile or hid the native view');
   const state=JSON.parse((await ask('/qa-human',{operation:'state',port:s.port,pageId:s.targetId})).value);
   if(!state.cookie.includes('atz-role=one')||state.storage!=='one')throw Error('Cold Chromium restart lost the saved profile');checks.push('a fresh app uses the production saved-task UI to restore the exact profile, visible native view, cookies and storage on the first attempt without reseeding');
   if((ctx.restoreDelayMs??0)>=1000&&!sawLoading)throw Error('A slow first document never showed its loading stage');
   await expectCounts('Cold recovery repeated a request',{restoreHits:1,connects:1,navigations:1});await inView('Cold recovery');
   checks.push(`the first document is requested once and connected once${ctx.restoreDelayMs?` after a ${ctx.restoreDelayMs}ms response shown as loading, never as an error,`:''} with the native view fully inside the window`);
   await invoke('qa_finish',{report:{passed:true,checks,realAccounts:0,personalProfileAccess:false,coldRestart:true,restoreDelayMs:ctx.restoreDelayMs,readiness:s.readiness}});
  }else if(ctx.mode==='slow'){
   await wait(()=>stage()==='loading');
   // Another dialog only hides the page while it is open; the same request keeps loading.
   const overlay=document.createElement('dialog');overlay.textContent='Unrelated trusted confirmation';document.body.append(overlay);overlay.showModal();
   await until('Another dialog did not hide the loading page',async()=>!(await mine()).visible);overlay.close();overlay.remove();await until('The loading page did not return after the dialog',async()=>(await mine()).visible);
   if(stage()!=='loading'||alert())throw Error('Another dialog interrupted the loading request');
   // Another Workroom is shown while the document is still on its way; it arrives late and must not attach anywhere.
   await showSession(ctx.sibling.id);await wait(()=>!slot());
   await until('The late document never loaded',async()=>(await mine()).url===restoreUrl);await delay(500);
   if((await stats()).connects!==0||pageUrl())throw Error('A late document attached while another Workroom was shown');
   await showSession(ctx.session.id);await toggle();
   await watchUntilConnected('Returning to the original Workroom failed');await expectCounts('Returning re-navigated',{restoreHits:1,connects:1,navigations:1});await inView('After the late document');
   checks.push('another dialog and a Workroom switch during a slow first load neither fail nor navigate again; the late document connects only to its own Workroom once it is shown again');
   // Close the connected page, reopen the saved profile and collapse the browser while that document loads.
   await button('owned-browser-close');await closedToStart();await chooseSaved();await wait(()=>stage()==='loading');
   await button('workroom-browser-view-terminal');await wait(()=>!slot());await until('The collapsed document never loaded',async()=>(await mine()).url===restoreUrl);await delay(500);
   if((await stats()).connects!==1)throw Error('A collapsed browser connected while hidden');
   await toggle();await watchUntilConnected('Expanding after a collapsed load failed');await expectCounts('Expanding re-navigated',{restoreHits:2,connects:2,navigations:1});await inView('After expanding');
   checks.push('closing a connected page and reopening its saved profile navigates once; collapsing during the slow load and expanding again finishes only the connect');
   // Close while the document is loading, then reopen at once: only the reopened request may connect.
   await button('owned-browser-close');await closedToStart();await chooseSaved();await wait(()=>stage()==='loading');
   await button('owned-browser-close');await closedToStart();const afterClose=await stats();
   await chooseSaved();await watchUntilConnected('Reopening after closing during a load failed');
   await delay(ctx.restoreDelayMs??0);const final=await stats();
   if(afterClose.connects!==2||final.connects!==3||final.restoreHits!==4||(await mine()).readiness.navigations!==1)throw Error(`Closing during a load leaked a connect or a navigation: ${JSON.stringify({afterClose,final})}`);
   await inView('After reopening');
   checks.push('closing during a slow load ends that request without a connect; only the reopened request connects');
   let conflict='';try{await invoke('workroom_browser_native',{sessionId:ctx.sibling.id,operation:'open',profileKey:ctx.restoreProfileKey});}catch(e){conflict=String(e);}
   if(!conflict.includes('already open in another Workroom'))throw Error(`A second Workroom opened the same saved profile: ${conflict}`);
   if(!connected())throw Error('The refused second open disturbed the first Workroom');await inView('After a refused second open');
   checks.push('a second Workroom cannot open a saved profile that is already open, and the first page stays connected and visible');
   await invoke('qa_finish',{report:{passed:true,checks,realAccounts:0,personalProfileAccess:false,coldRestart:true}});
  }else{
   // Every target discovery reply is dropped: after the bounded probes this is a lost reply, not a slow page.
   const failed=await wait(()=>document.querySelector('[data-testid=owned-browser-error][data-failure="target-lost"]'));
   const lost=await mine();if(lost.targetId||lost.readiness.targetResults!==0||lost.readiness.targetProbes!==16||lost.url!==restoreUrl)throw Error(`Unexpected lost-target state: ${JSON.stringify(lost.readiness)}`);
   await expectCounts('A lost target reply re-sent work',{restoreHits:1,connects:0,navigations:1});await inView('After the lost-target error');
   checks.push('a lost target reply is reported after the bounded probes while the loaded page stays visible inside the window');
   await invoke('workroom_browser_native',{sessionId:ctx.session.id,operation:'qa-keep-target-replies'});
   (await wait(()=>failed.querySelector<HTMLButtonElement>('[data-testid=owned-browser-retry-connect]'))).click();await wait(()=>!alert());
   await watchUntilConnected('Retrying the connect failed');await expectCounts('Retrying re-navigated',{restoreHits:1,connects:1,navigations:1});await inView('After retrying');
   checks.push('retrying re-arms only target discovery and connects without navigating again');
   await invoke('qa_finish',{report:{passed:true,checks,realAccounts:0,personalProfileAccess:false,coldRestart:true}});
  }
 }else{
 await wait(()=>document.querySelector('.xterm-rows')?.textContent?.includes('REAL_PTY_READY'));checks.push('production Workroom renders output from an actual isolated PTY');
 (await wait(()=>document.querySelector<HTMLButtonElement>('[data-testid=workroom-browser-toggle]'))).click();
 const input=await wait(()=>document.querySelector<HTMLInputElement>('[data-testid=owned-browser-address]'));const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!;setter.call(input,ctx.fixtureUrl.replace(/^http:\/\//,''));input.dispatchEvent(new Event('input',{bubbles:true}));
 await button('owned-browser-open');await wait(()=>document.querySelector('[data-testid=owned-browser-slot]'));
 const draft=await wait(()=>document.querySelector<HTMLTextAreaElement>('[data-testid=workroom-command-composer] textarea')),personDraft='이 페이지에서 확인한 내용을 정리해 주세요. 아직 보내지 않은 사람의 초안';
 Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(draft,personDraft);draft.dispatchEvent(new Event('input',{bubbles:true}));await delay(100);
 const base=await handoff(),workspaceId=base.workspaceId;await wait(()=>document.querySelector('[data-testid=workroom-browser-observation]')?.textContent?.includes('NO_TAURI_IPC'));if(input.value!==ctx.fixtureUrl)throw Error('Human address input did not retain the normalized local origin');if(draft.value!==personDraft)throw Error('Handoff changed the person\'s unsent draft');checks.push('a scheme-less human address opens the exact local origin in real CEF without Tauri IPC; one handoff resumes and grants once through the production composer chip while preserving the person\'s draft');
 let r=await ask('/qa-agent',{...base,operation:'observe'});
 for(let i=0;i<100;i++){const opening=await invoke<{preparing?:boolean}>('workroom_browser_native',{sessionId:ctx.sibling.id,operation:'open'});if(!opening.preparing)break;await delay(100);}await invoke('workroom_browser_native',{sessionId:ctx.sibling.id,operation:'navigate',url:ctx.fixtureUrl+'?role=two'});await delay(500);
 r=await ask('/qa-agent',{...base,operation:'observe'});if(!r.workspace.observation.text.includes('cookie=atz-role=one storage=one'))throw Error('Native request contexts share cookies or storage');checks.push('separate Workroom Chromium profiles isolate same-origin cookies and storage');
 const ownedPages=await ask('/api/agent-runtime/workroom-browser',{operation:'pages',workspaceId});if(ownedPages.pages.length!==1)throw Error('Another Workroom native tab was exposed');checks.push('owned adapter exposes only the exact native target, excluding other Workroom pages');
 r=await ask('/qa-agent',{...base,operation:'fill',selector:'#draft',text:'native agent 한글',requestId:'native_fill_001',observationId:r.workspace.observation.id});
 if(!r.workspace.observation.text.includes('native agent 한글'))throw Error('Native CEF fill missing');checks.push('bounded agent input reaches the embedded Chromium renderer');
 // P1: the same page's cross-origin frame (its own iframe target) and open shadow root, a frame fill, and a capture.
 r=await ask('/qa-agent',{...base,operation:'observe'});const frame=r.workspace.observation.frames?.find((f:any)=>f.crossOrigin&&f.text.includes('Native cross frame'));
 if(!frame||!r.workspace.observation.elements.some((e:any)=>e.selector==='#frame-field'&&e.frame===frame.ref))throw Error(`Native CEF cross-origin frame not observed: ${JSON.stringify({frames:r.workspace.observation.frames,unobservable:r.workspace.observation.unobservable})}`);
 if(!r.workspace.observation.elements.some((e:any)=>e.shadow&&e.selector.endsWith('>>> #shadow-field')))throw Error('Native CEF open shadow root not observed');
 r=await ask('/qa-agent',{...base,operation:'fill',selector:'#frame-field',frame:frame.ref,text:'native frame 한글',requestId:'native_frame_fill_001',observationId:r.workspace.observation.id});
 if(!r.workspace.observation.frames?.some((f:any)=>f.text.includes('frame:native frame 한글')))throw Error('Native CEF frame fill missing');
 const shot=await ask('/qa-agent',{...base,operation:'screenshot'});if(shot.screenshot?.mimeType!=='image/jpeg'||!(shot.screenshot.width>0)||!(shot.screenshot.data.length>100))throw Error(`Native CEF screenshot missing: ${JSON.stringify(shot).slice(0,300)}`);
 checks.push('real CEF observes a cross-origin frame and an open shadow root, a frame fill reaches its renderer and the visible page is captured');
 const native=await invoke<{human:boolean;visible:boolean;rect:number[];windowRect:number[]}>('workroom_browser_native',{sessionId:ctx.session.id,operation:'status'});if(native.human)throw Error('Native page accepts human input during agent ownership');if(!native.visible)throw Error('Native CEF view is hidden despite its visible Workroom slot');
 const beforeLostTarget=await invoke<{targetId:string;url:string}>('workroom_browser_native',{sessionId:ctx.session.id,operation:'status'});await invoke('workroom_browser_native',{sessionId:ctx.session.id,operation:'qa-forget-target'});let targetRecovered=false;for(let i=0;i<30;i++){const probe=await invoke<{targetId:string;url:string}>('workroom_browser_native',{sessionId:ctx.session.id,operation:'status'});if(probe.targetId===beforeLostTarget.targetId&&probe.url===beforeLostTarget.url){targetRecovered=true;break;}await delay(100);}if(!targetRecovered)throw Error('Lost native target discovery reply never recovered');checks.push('a lost native target discovery reply recovers the exact page without replaying navigation');
 const expected=document.querySelector('[data-testid=owned-browser-slot]')!.getBoundingClientRect();if(native.rect.length!==4||[expected.x,expected.y,expected.width,expected.height].some((n,i)=>{const actual=native.rect[i];return actual===undefined||!Number.isFinite(actual)||Math.abs(n-actual)>1;}))throw Error(`Native pane does not align with the trusted slot: ${JSON.stringify({expected:[expected.x,expected.y,expected.width,expected.height],actual:native.rect})}`);
 const zoom=native.windowRect[4];if(native.windowRect.length!==5||zoom===undefined||!Number.isFinite(zoom)||zoom<=0||[expected.x,expected.y,expected.width,expected.height].some((n,i)=>{const actual=native.windowRect[i];return actual===undefined||!Number.isFinite(actual)||Math.abs(n*zoom-actual)>1;}))throw Error(`Native pane overlaps trusted UI in window coordinates: ${JSON.stringify({expected:[expected.x,expected.y,expected.width,expected.height],window:native.windowRect})}`);
 const expectVisibility=async(visible:boolean)=>{for(let i=0;i<60;i++){if((await invoke<{visible:boolean}>('workroom_browser_native',{sessionId:ctx.session.id,operation:'status'})).visible===visible)return;await delay(50);}throw Error('Native modal visibility barrier did not settle');};
 const overlay=document.createElement('dialog');overlay.textContent='Unrelated trusted confirmation';document.body.append(overlay);overlay.showModal();await expectVisibility(false);overlay.close();overlay.remove();await expectVisibility(true);
 // DOM keyboard events exercise the production separators; the resulting rectangle and visibility come from real
 // CEF. Actual pointer capture/drag is covered separately by the browser layout regression, never faked here.
 const slotBox=()=>document.querySelector<HTMLElement>('[data-testid=owned-browser-slot]')!.getBoundingClientRect();
 const widthHandle=await wait(()=>document.querySelector<HTMLElement>('[data-testid=workroom-browser-divider]')),heightHandle=await wait(()=>document.querySelector<HTMLElement>('[data-testid=workroom-browser-height-divider]'));
 const resizeState=()=>{const r=slotBox(),p=document.querySelector<HTMLElement>('[data-testid=workroom-browser-panel]')!.getBoundingClientRect(),range=(el:HTMLElement)=>({low:Number(el.getAttribute('aria-valuemin')),high:Number(el.getAttribute('aria-valuemax')),current:Number(el.getAttribute('aria-valuenow')),disabled:el.getAttribute('aria-disabled')==='true'});return {slot:{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom},panel:{width:p.width,height:p.height},width:range(widthHandle),height:range(heightHandle),viewport:[innerWidth,innerHeight],layout:layoutDiagnostics()};};
 await settle('Native default size',layoutSignature);const originalSize=resizeState();
 const assertFloorInView=(label:string)=>{const state=resizeState(),outside=clippedParts();if(state.slot.height<200||outside.length)throw Error(`${label}: the native page is not above its 200px floor with its trusted frame fully in view inside every clipping box: ${JSON.stringify({outside,baseline:originalSize,changed:state})}`);};
 await probe('default');assertFloorInView('Native default size');
 const resizeWait=async(label:string,before:ReturnType<typeof resizeState>,fn:()=>boolean)=>{for(let i=0;i<100;i++){if(fn())return;await delay(50);}throw Error(`${label}: ${JSON.stringify({baseline:before,changed:resizeState()})}`);};
 const key=(el:HTMLElement,key:string)=>{el.focus();el.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));};
 const realFrame=async()=>{let native:unknown;for(let i=0;i<100;i++){const s=await invoke<{visible:boolean;rect:number[]}>('workroom_browser_native',{sessionId:ctx.session.id,operation:'status'}),r=slotBox();native=s;if(s.visible&&s.rect.length===4&&[r.x,r.y,r.width,r.height].every((n,j)=>Math.abs(n-s.rect[j]!)<1))return;await delay(50);}throw Error(`Real CEF did not follow keyboard resize: ${JSON.stringify({baseline:originalSize,changed:resizeState(),native})}`);};
 await realFrame();
 // The original 800px viewport can use all available height for the protected 200px page. A zero range must
 // disable the handle and preserve its size; it is not evidence that a 40px resize should be possible here.
 if(originalSize.height.high<=originalSize.height.low){
  if(!originalSize.height.disabled)throw Error(`A native height handle with no range stayed enabled: ${JSON.stringify(originalSize)}`);
  key(heightHandle,'Home');key(heightHandle,'End');await delay(100);
  if(Math.abs(slotBox().height-originalSize.slot.height)>1)throw Error(`A disabled native height handle changed its page: ${JSON.stringify({baseline:originalSize,changed:resizeState()})}`);await realFrame();
 }else if(originalSize.height.disabled)throw Error(`A native height handle with an available range stayed disabled: ${JSON.stringify(originalSize)}`);
 // Prove both real CEF axes with enough space, independently of the original window's minimum. Native window
 // units differ from CSS pixels at QA's zoom: preserve its actual logical width and restore PhysicalSize.
 const qaWindow=getCurrentWindow(),originalWindowSize=await qaWindow.innerSize(),scale=await qaWindow.scaleFactor(),logical=originalWindowSize.toLogical(scale);
 try{
  await qaWindow.setSize(new LogicalSize(logical.width,logical.height+400));
  await resizeWait('The QA window did not expose additional CSS height',originalSize,()=>innerHeight>=originalSize.viewport[1]!+200);await settle('Expanded native default size',layoutSignature);await realFrame();await probe('expanded');assertFloorInView('Expanded native default size');
  const expandedSize=resizeState();key(widthHandle,'Home');await resizeWait('Horizontal keyboard resize did not move 40px',expandedSize,()=>slotBox().width-expandedSize.slot.width>=40);await realFrame();
  // Width changes can shorten the trusted controls; wait for their actual reflow before measuring height.
  await settle('Horizontal keyboard resize',layoutSignature);
  const heightBefore=resizeState(),available=heightBefore.height.high-heightBefore.height.low;
  if(!Number.isFinite(available)||available<40||heightBefore.height.disabled)throw Error(`The expanded native window has no 40px height range: ${JSON.stringify({baseline:expandedSize,changed:heightBefore,available,required:40})}`);
  key(heightHandle,'Home');await resizeWait('Height Home did not reach its minimum panel height',heightBefore,()=>Math.abs(resizeState().panel.height-resizeState().height.low)<=2);await settle('Minimum manual native height',layoutSignature);await probe('minimum-manual');assertFloorInView('Minimum manual native height');await realFrame();
  const minimumHeight=resizeState();key(heightHandle,'End');await resizeWait('Height End did not reach its maximum panel height',minimumHeight,()=>Math.abs(resizeState().panel.height-resizeState().height.high)<=2);await realFrame();
  await settle('Maximum manual native height',layoutSignature);await probe('maximum-manual');const maximumHeight=resizeState();if(maximumHeight.slot.height-minimumHeight.slot.height<40)throw Error(`Native vertical change did not move 40px: ${JSON.stringify({baseline:heightBefore,minimum:minimumHeight,changed:maximumHeight,available,required:40})}`);assertFloorInView('Maximum manual native height');
 }finally{
  widthHandle.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));heightHandle.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
  await qaWindow.setSize(originalWindowSize);
  await resizeWait('Original QA viewport and default size were not restored',originalSize,()=>innerWidth===originalSize.viewport[0]&&innerHeight===originalSize.viewport[1]&&Math.abs(slotBox().width-originalSize.slot.width)<=2&&Math.abs(slotBox().height-originalSize.slot.height)<=2);await settle('Restored native default size',layoutSignature);await realFrame();await probe('restored');assertFloorInView('Restored native default size');
 }
 checks.push('native view stays visible in the actual Workroom modal, hides behind another dialog, locks human input during agent ownership and follows both keyboard resize axes before restoring its default size');
 await button('workroom-browser-view-terminal');await wait(()=>!document.querySelector('[data-testid=owned-browser-slot]'));r=await ask('/qa-agent',{...base,operation:'observe'});if(!r.workspace.observation.text.includes('native agent 한글'))throw Error('Hidden page lost state');checks.push('hiding the browser preserves the document and agent work');
 (await wait(()=>document.querySelector<HTMLButtonElement>('[data-testid=workroom-browser-toggle]'))).click();await button('workroom-browser-take');
 let refused=false;try{await ask('/qa-agent',{...base,operation:'observe'});}catch{refused=true;}if(!refused)throw Error('Old grant survived takeover');checks.push('human takeover revokes the old agent grant');
 const unlocked=await invoke<{human:boolean}>('workroom_browser_native',{sessionId:ctx.session.id,operation:'status'});if(!unlocked.human)throw Error('Native page still locked after takeover');checks.push('native input unlock happens after broker takeover settles');
 // P1 step 2: this Workroom's own tabs. The person opens a second built-in tab and a page in it; it joins the Workroom's
 // set. The AI lists exactly these two tabs (never the sibling Workroom's page), switches to the first and the screen
 // follows. Closing the second tab takes it out of the set before its page closes.
 type NativeTabs={tabs:{tab:string;targetId:string|null;closed:boolean;visible:boolean}[]};
 const nativeTabs=async()=>(await invoke<NativeTabs>('workroom_browser_native',{sessionId:ctx.session.id,operation:'tabs'})).tabs.filter(t=>!t.closed);
 const hostState=async()=>(await ask('/api/agent-runtime/workroom-browser',{operation:'status',workspaceId})).workspace;
 const siblingTarget=(await invoke<{targetId:string}>('workroom_browser_native',{sessionId:ctx.sibling.id,operation:'status'})).targetId;
 // The new tab is on screen and ready for an address once its request has finished (a status poll may list it sooner).
 // The browser was collapsed and shown again above, so its address field is a new element.
 await button('owned-browser-new-tab');const address=await wait(()=>{const field=document.querySelector<HTMLInputElement>('[data-testid=owned-browser-address]');return document.querySelectorAll('[data-testid=owned-browser-tabs] button[data-tab]').length===2&&document.querySelector('[data-testid=owned-browser-slot]')?.getAttribute('data-tab')!=='main'&&!document.querySelector('[data-testid=owned-browser-stage]')&&field&&!field.disabled?field:null;});
 setter.call(address,new URL('/native-tab',ctx.fixtureUrl).href);address.dispatchEvent(new Event('input',{bubbles:true}));await button('owned-browser-open');
 for(let i=0;i<100&&(await hostState()).tabs?.length!==2;i++)await delay(100);
 const joined=await hostState(),own=await nativeTabs(),second=own.find(t=>t.tab!=='main'),first=own.find(t=>t.tab==='main');
 if(joined.tabs?.length!==2||own.length!==2||!second||!first||!own.every(t=>joined.tabs.some((p:any)=>p.id===t.targetId))||joined.page?.id!==second.targetId)throw Error(`The second built-in tab did not join this Workroom's set: ${JSON.stringify({joined:joined.tabs,own})}`);
 checks.push("a second built-in tab the person opens joins only this Workroom's own tab set once its page loads");
 const tabAccess=await handoff();await wait(()=>document.querySelector('[data-testid=workroom-browser-observation]')?.textContent?.includes('Native tab two'));
 if(tabAccess.workspaceId!==workspaceId)throw Error('The second handoff escaped its original Workroom workspace');
 const listed=await ask('/qa-agent',{...tabAccess,operation:'tabs'}),ids=(listed.workspace.tabs??[]).map((p:any)=>p.id).sort();
 if(JSON.stringify(ids)!==JSON.stringify(own.map(t=>t.targetId).sort())||!siblingTarget||ids.includes(siblingTarget))throw Error(`Agent tabs are not exactly this Workroom's own: ${JSON.stringify({ids,own,siblingTarget})}`);
 let crossed=false;try{await ask('/qa-agent',{...tabAccess,operation:'switch-tab',tab:siblingTarget});}catch{crossed=true;}if(!crossed)throw Error("An agent switched to another Workroom's native tab");
 r=await ask('/qa-agent',{...tabAccess,operation:'switch-tab',tab:first.targetId});if(r.workspace.page?.id!==first.targetId||!r.workspace.observation?.text.includes('Native Workroom'))throw Error('Agent switch-tab did not observe the first tab');
 for(let i=0;;i++){const now=await nativeTabs();if(document.querySelector('[data-testid=owned-browser-slot]')?.getAttribute('data-tab')==='main'&&now.find(t=>t.tab==='main')?.visible&&!now.find(t=>t.tab===second.tab)?.visible)break;if(i===100)throw Error(`The page on screen did not follow the agent's tab: ${JSON.stringify(now)}`);await delay(100);}
 checks.push("the AI lists exactly this Workroom's two tabs, cannot name another Workroom's page, and the page on screen follows its switch-tab");
 await button('workroom-browser-take');
 const closeSecond=await wait(()=>{
  const tab=document.querySelector(`[data-testid=owned-browser-tab][data-tab="${second.tab}"]`);
  const item=document.querySelector(`[data-testid=owned-browser-tab-item][data-tab-key="${second.tab}"]`)??tab?.parentElement;
  return item?.querySelector<HTMLButtonElement>('[data-testid=owned-browser-tab-close]:not(:disabled)');
 });closeSecond.click();
 for(let i=0;;i++){const now=await nativeTabs(),w=await hostState();if(now.length===1&&now[0]?.tab==='main'&&w.tabs?.length===1&&w.page?.id===first.targetId)break;if(i===100)throw Error(`Closing the second tab did not leave the set: ${JSON.stringify({now,tabs:w.tabs})}`);await delay(100);}
 if(!(await invoke<{human:boolean}>('workroom_browser_native',{sessionId:ctx.session.id,operation:'status'})).human)throw Error('Native page locked after the person closed a tab');
 checks.push("closing the second tab takes it out of this Workroom's set and closes only that native page");
 if(!document.querySelector('.xterm-rows')?.textContent?.includes('REAL_PTY_READY'))throw Error('Terminal lost');if(document.querySelector<HTMLTextAreaElement>('[data-testid=workroom-command-composer] textarea')?.value!==personDraft)throw Error('Person draft lost');await wait(()=>document.querySelector('[data-testid=workroom-browser-handoff-chip][data-state=expired]'));const issued=await browserState();if(issued.resume!==2||issued.grant!==2)throw Error('A handoff was automatically replayed');assertPrivateAccess();checks.push('the real terminal and unsent person draft remain mounted; takeover expires the actual C4 composer chip without persisting or exposing access');
 const status=()=>invoke<{port:number;targetId:string;human:boolean;popupCount:number;downloads:number;uploads:number;closed:boolean}>('workroom_browser_native',{sessionId:ctx.session.id,operation:'status'});
 const human=async(operation:string,native?:Awaited<ReturnType<typeof status>>)=>{const selected=native??await status();return ask('/qa-human',{operation,port:selected.port,pageId:selected.targetId});};
 const until=async(fn:()=>Promise<boolean>)=>{for(let i=0;i<100;i++){if(await fn())return;await delay(100);}throw Error('Native popup/file journey timed out');};
 await human('popup');await until(async()=> (await status()).popupCount===1);await until(async()=>JSON.parse((await human('state')).value).popup==='popup-login-ok');checks.push('human login popup retains opener messaging and the original profile cookies');
 let handoffBlocked=false;try{await invoke('workroom_browser_native',{sessionId:ctx.session.id,operation:'lock'});}catch{handoffBlocked=true;}if(!handoffBlocked)throw Error('AI took over with a human login popup open');checks.push('an open login popup blocks AI takeover');
 await invoke('workroom_browser_native',{sessionId:ctx.session.id,operation:'close-popups'});await until(async()=> (await status()).popupCount===0);
 await human('upload');await until(async()=>JSON.parse((await human('state')).value).upload==='disposable-upload-proof');checks.push('the CEF file chooser callback transfers only the disposable fixture file');
 await human('download');await until(async()=>!!(await ask('/qa-human',{operation:'download-status'})).ready);checks.push('a human-owned CEF download writes the exact disposable file contents');
 const before=await status();await invoke('workroom_browser_native',{sessionId:ctx.session.id,operation:'lock'});await human('popup');await human('upload');await human('download');await delay(300);const after=await status();if(after.popupCount!==0||after.uploads!==before.uploads||after.downloads!==before.downloads)throw Error('A page bypassed human-only popup or file handling');await invoke('workroom_browser_native',{sessionId:ctx.session.id,operation:'unlock'});checks.push('page-created popup, upload and download requests are denied while AI owns the browser');
 // Native operations retain the C2b contracts; visible errors, blocked input and Command-L also use the real K3 UI.
 type PageState={title:string;progress:number;loadError:null|{code:number;text:string;url:string};canGoBack:boolean;canGoForward:boolean;loading:boolean;blockedInputs:number;focused:boolean;consoleErrors:number;url:string;readiness:{navigations:number};tabs:{tab:string;title:string;loading:boolean}[]};
 const nav=(operation:string,url?:string)=>invoke<PageState>('workroom_browser_native',{sessionId:ctx.session.id,tab:'main',operation,...(url?{url}:{})});
 const settled=async(url:string)=>{await until(async()=>{const s=await nav('status');return s.url===url&&!s.loading;});};
 const a=new URL('/nav-a',ctx.fixtureUrl).href,b=new URL('/nav-b',ctx.fixtureUrl).href;
 await nav('navigate',a);await settled(a);await nav('navigate',b);await settled(b);
 if(!(await nav('status')).canGoBack)throw Error('Missing back history');await nav('back');await settled(a);
 if(!(await nav('status')).canGoForward)throw Error('Missing forward history');await nav('forward');await settled(b);
 const countsBefore=await ask('/qa-human',{operation:'stats'}),navBefore=(await nav('status')).readiness.navigations;
 await nav('reload');await until(async()=>(await ask('/qa-human',{operation:'stats'})).navHits===countsBefore.navHits+1);await settled(b);await delay(400);
 if((await ask('/qa-human',{operation:'stats'})).navHits!==countsBefore.navHits+1||(await nav('status')).readiness.navigations!==navBefore+1)throw Error('Accepted reload replayed');
 checks.push('an accepted navigation increments the navigation counter once and is never replayed');
 const page=await nav('status');if(page.title!=='/nav-b'||page.progress!==1||!page.tabs.some(t=>t.tab==='main'&&t.title==='/nav-b'&&!t.loading))throw Error(`Missing title/progress/tab state: ${JSON.stringify(page)}`);
 checks.push('native title, determinate progress and each tab title/loading reflect the loaded page');
 await nav('navigate',new URL('/nav-slow',ctx.fixtureUrl).href);await until(async()=>(await nav('status')).loading);await nav('stop');await until(async()=>!(await nav('status')).loading);if((await nav('status')).loadError)throw Error('ERR_ABORTED became a load error');
 await nav('navigate',a);await settled(a);
 checks.push('human back, forward, reload and stop visit exact fixture history entries and cancel a slow load without reporting ERR_ABORTED');
 // Regression hypothesis only: the installed disconnect did not establish an Inspector.detached cause.
 // Use the real human omnibox, CEF and broker to exercise top-level site/COOP changes without external accounts.
 // Do not reconnect, hand off, synthesize a detach, or replace the production navigation result in this journey.
 const navigationBefore=await ask('/qa-human',{operation:'stats'}),handoffBefore=await browserState();
 type LiveNavigation=PageState&{targetId:string;profileKey:string;human:boolean;visible:boolean;closed:boolean};
 const navigationStatus=()=>invoke<LiveNavigation>('workroom_browser_native',{sessionId:ctx.session.id,tab:'main',operation:'status'});
 const navigationBinding={targetId:first.targetId,profileKey:ctx.session.id};
 const navigationEvidence=async()=>{const [native,workspace,stats]=await Promise.all([navigationStatus(),hostState(),ask('/qa-human',{operation:'stats'})]),field=document.querySelector<HTMLInputElement>('[data-testid=owned-browser-address]');return {native:{targetId:native.targetId,profileKey:native.profileKey,url:native.url,title:native.title,tabs:native.tabs,loading:native.loading,closed:native.closed,visible:native.visible,human:native.human},workspace:{id:workspace.id,page:workspace.page,connection:workspace.connection,owner:workspace.owner,tabs:workspace.tabs},ui:{pageUrl:pageUrl(),address:field?.value,readOnly:field?.readOnly,ariaReadOnly:field?.getAttribute('aria-readonly')},stats};};
 const requireNavigationBinding=async(url:string,title:string)=>{
  const [native,workspace]=await Promise.all([navigationStatus(),hostState()]);
  if(workspace.id!==workspaceId||workspace.connection!=='connected'||workspace.owner!=='human'||workspace.page?.id!==navigationBinding.targetId||native.targetId!==navigationBinding.targetId||native.profileKey!==navigationBinding.profileKey||!native.human||native.closed)throw Error(`Human top-level navigation lost its original live binding: ${JSON.stringify(await navigationEvidence())}`);
  const field=document.querySelector<HTMLInputElement>('[data-testid=owned-browser-address]');
  // A clean loaded URL hides the Go button by design. The input's real readOnly state proves editability here;
  // humanNavigate below types a different URL and then requires/clicks the actual production submit button.
  return native.url===url&&native.title===title&&!native.loading&&native.tabs.some(tab=>tab.tab==='main'&&tab.title===title&&!tab.loading)&&native.visible&&workspace.page.url===url&&pageUrl()===url&&visible(field)&&field.value===url&&!field.disabled&&!field.readOnly&&field.getAttribute('aria-readonly')!=='true';
 };
 const humanNavigate=async(url:string,title:string)=>{
  const field=await wait(()=>{const input=document.querySelector<HTMLInputElement>('[data-testid=owned-browser-address]');return visible(input)&&!input.disabled&&!input.readOnly?input:null;});
  setter.call(field,url);field.dispatchEvent(new Event('input',{bubbles:true}));await button('owned-browser-open');
  let ready=false;for(let i=0;i<100;i++){if(await requireNavigationBinding(url,title)){ready=true;break;}await delay(100);}
  if(!ready)throw Error(`Human top-level navigation never became usable: ${JSON.stringify(await navigationEvidence())}`);
  // This asks the real browser-level CDP transport. A cached status alone cannot prove a live connection.
  const listed=await ask('/api/agent-runtime/workroom-browser',{operation:'pages',workspaceId});
  if(listed.workspace?.id!==workspaceId||listed.pages?.length!==1||listed.pages[0].id!==navigationBinding.targetId||listed.pages[0].url!==url||listed.pages[0].title!==title||listed.pages.some((page:{id:string})=>page.id===siblingTarget))throw Error(`Top-level navigation exposed a foreign target or stale CDP page: ${JSON.stringify({pages:listed.pages,evidence:await navigationEvidence()})}`);
  await expectVisibility(true);assertPrivateAccess();
 };
 const crossOrigin=new URL('/nav-cross-origin',ctx.fixtureUrl);crossOrigin.hostname='localhost';
 await humanNavigate(crossOrigin.href,'Native cross-origin fixture');
 checks.push('a human top-level 127.0.0.1 to localhost navigation preserves the original live broker, native target/profile, visible page, exact title/address and editable omnibox while excluding the sibling Workroom target');
 const coop=new URL('/nav-coop',ctx.fixtureUrl).href;
 await humanNavigate(coop,'Native COOP fixture');
 // An idle connection failure can arrive after the page visibly loads. Cover the transport's 8s command timeout
 // and the UI's 2s status poll; never repair/retry the connection to make the assertion pass.
 for(let i=0;i<12;i++){await delay(1000);if(!await requireNavigationBinding(coop,'Native COOP fixture'))throw Error(`The COOP document lost its usable binding during idle: ${JSON.stringify(await navigationEvidence())}`);}
 await humanNavigate(a,'/nav-a');
 const siblingAfterNavigation=await invoke<Awaited<ReturnType<typeof status>>>('workroom_browser_native',{sessionId:ctx.sibling.id,operation:'status'});
 if(siblingAfterNavigation.targetId!==siblingTarget||siblingAfterNavigation.closed)throw Error('Top-level navigation closed or replaced the sibling Workroom target');
 const [ownProfile,siblingProfile,afterNavigation,afterHandoff]=await Promise.all([human('state'),human('state',siblingAfterNavigation),ask('/qa-human',{operation:'stats'}),browserState()]);
 const ownContents=JSON.parse(ownProfile.value),siblingContents=JSON.parse(siblingProfile.value);
 if(!ownContents.cookie.includes('atz-role=one')||ownContents.cookie.includes('atz-role=two')||ownContents.storage!=='one'||!siblingContents.cookie.includes('atz-role=two')||siblingContents.cookie.includes('atz-role=one')||siblingContents.storage!=='two')throw Error('Top-level site/COOP navigation crossed the two disposable Workroom profile stores');
 if(afterNavigation.connects!==navigationBefore.connects||afterNavigation.crossOriginHits!==navigationBefore.crossOriginHits+1||afterNavigation.coopHits!==navigationBefore.coopHits+1||afterHandoff.resume!==handoffBefore.resume||afterHandoff.grant!==handoffBefore.grant)throw Error(`Top-level navigation was repaired, replayed or handed over: ${JSON.stringify({before:navigationBefore,after:afterNavigation,resume:[handoffBefore.resume,afterHandoff.resume],grantCount:[handoffBefore.grant,afterHandoff.grant]})}`);
 topLevelNavigation={idleMs:12000,inspectorDetached:afterNavigation.inspectorDetached-navigationBefore.inspectorDetached,rendererGone:afterNavigation.rendererGone-navigationBefore.rendererGone,targetClosed:afterNavigation.targetClosed-navigationBefore.targetClosed,otherInspectorDetached:afterNavigation.otherInspectorDetached-navigationBefore.otherInspectorDetached,cdpClosed:afterNavigation.cdpClosed-navigationBefore.cdpClosed};
 checks.push('a real COOP same-origin response remains connected and human-editable through 12s idle and the next exact GET without reconnect/replay or another handoff, while both Workroom cookie/storage profiles remain isolated');
 await nav('navigate',ctx.refusedUrl);await until(async()=>!!(await nav('status')).loadError);const failed=await nav('status');if(failed.loadError?.code!==-102||failed.loadError.url!==ctx.refusedUrl)throw Error('Main-frame refused-port load error missing');
 const errorCopy=workroomBrowserPageErrorCopy(readAppLanguage()),refusedHost=new URL(ctx.refusedUrl).host;
 const refusedCard=await wait(()=>{const card=document.querySelector<HTMLElement>('[data-testid=workroom-browser-page-error][data-error-code=load-refused]');return visible(card)?card:null;});
 if(!refusedCard.textContent?.includes(errorCopy.cards['load-refused'].cause.replaceAll('{host}',refusedHost)))throw Error('The visible refused-address card did not name the host and localized cause');
 for(const [id,label]of[['workroom-browser-page-retry',errorCopy.retry],['workroom-browser-page-edit',errorCopy.editAddress]]){const action=refusedCard.querySelector<HTMLButtonElement>(`[data-testid=${id}]`);if(!visible(action)||action.disabled||!action.textContent?.includes(label!))throw Error('The refused-address card did not offer a visible enabled localized next step');}
 await expectVisibility(false);
 await nav('navigate',a);await settled(a);if((await nav('status')).loadError)throw Error('Next main-frame load retained the old error');
 // Native state settles before the 2s UI poll. A pointer probe must hit the re-shown page, never its old error card.
 await wait(()=>!document.querySelector('[data-testid=workroom-browser-page-error]'));await expectVisibility(true);
 checks.push('a refused port publishes a main-frame loadError and a localized host-specific error card with next steps; the next load clears it and restores the native page');
 // A real third handoff gives the broker and visible UI the same agent owner. Do not simulate ownership with native
 // lock alone, which could pass while the UI still claimed that the person controlled the page.
 const blockedAccess=await handoff();await button('workroom-browser-dismiss');const blockedBefore=(await nav('status')).blockedInputs;
 for(const op of ['back','forward','reload','stop']){let denied=false;try{await nav(op);}catch{denied=true;}if(!denied)throw Error(`AI-owned ${op} admitted`);}
 const clicked=await nav('qa-click'),scrolled=await nav('qa-scroll');if((await nav('status')).blockedInputs!==blockedBefore+2)throw Error(`Locked click/scroll counter did not increment: ${JSON.stringify({blockedBefore,click:clicked.blockedInputs,scroll:scrolled.blockedInputs})}`);
 const blocked=await wait(()=>{const control=document.querySelector<HTMLElement>('[data-testid=workroom-browser-control][data-kind=blocked]');return visible(control)&&control.textContent?.includes(workroomBrowserUiCopy(readAppLanguage()).owner.blockedClick)?control:null;});
 if(!document.querySelector('[data-testid=workroom-browser-panel][data-owner=agent]')||!visible(blocked.querySelector<HTMLButtonElement>('[data-testid=workroom-browser-take]')))throw Error('Blocked native input did not explain AI ownership and offer takeover');
 await button('workroom-browser-take');let blockedRevoked=false;try{await ask('/qa-agent',{...blockedAccess,operation:'observe'});}catch{blockedRevoked=true;}if(!blockedRevoked||!(await status()).human)throw Error('UI takeover after blocked input did not revoke access and unlock native input');assertPrivateAccess();
 checks.push('all four navigation ops refuse AI ownership; blocked native clicks and scrolls increment the counter and explain the owner in the real UI until explicit takeover');
 await human('popup');await until(async()=>(await status()).popupCount===1);const {geometry:g}=await invoke<{geometry:[number,number,number,number,number,number,number,number,number,number]}>('workroom_browser_native',{sessionId:ctx.session.id,operation:'qa-popup-geometry'});
 if(!g[8]||!g[9]||g[0]<g[4]||g[1]<g[5]||g[0]+g[2]>g[4]+g[6]+1||g[1]+g[3]>g[5]+g[7]+1||Math.abs(g[0]+g[2]/2-g[4]-g[6]/2)>1||Math.abs(g[1]+g[3]/2-g[5]-g[7]/2)>1)throw Error(`Popup is not a centred host-titled Workroom child: ${g}`);
 await nav('close-popups');await until(async()=>(await status()).popupCount===0);
 checks.push('login popup is a centred host-titled child inside its owning Workroom');
 const omnibox=await wait(()=>document.querySelector<HTMLInputElement>('[data-testid=owned-browser-address]'));
 const otherFocus=await wait(()=>document.querySelector<HTMLTextAreaElement>('[data-testid=workroom-command-composer] textarea')),composerBeforeShortcut=otherFocus.value,shortcutTarget=(await status()).targetId;
 otherFocus.focus();if(document.activeElement!==otherFocus||document.activeElement===omnibox)throw Error('Command-L did not begin with the actual terminal composer focused');
 const shortcutName='agentstoz-native-browser-shortcut',delivered:unknown[]=[],focusTrace:unknown[]=[];let focused=0,rawShortcuts=0,terminalKeydowns=0,shortcutStage='before-qa-focus';
 const focusNode=(target:EventTarget|null)=>target instanceof Element?{tag:target.tagName,testId:target.getAttribute('data-testid'),className:target.getAttribute('class')}:null;
 const trace=(kind:string,event?:FocusEvent)=>{if(focusTrace.length<96)focusTrace.push({kind,stage:shortcutStage,time:Math.round(performance.now()*10)/10,focused,delivered:delivered.length,target:focusNode(event?.target??null),related:focusNode(event?.relatedTarget??null),active:focusNode(document.activeElement),documentFocused:document.hasFocus(),trusted:event?.isTrusted??null});};
 const shortcutDiagnostics=()=>({stage:shortcutStage,delivered,focused,target:shortcutTarget,focusTrace,matchingOwnedCount:document.querySelectorAll('[data-testid=owned-workroom-browser]').length,visibleOwnedCount:[...document.querySelectorAll<HTMLElement>('[data-testid=owned-workroom-browser]')].filter(visible).length,omniboxCount:document.querySelectorAll('[data-testid=owned-browser-address]').length,active:focusNode(document.activeElement),documentFocused:document.hasFocus(),selected:document.activeElement===omnibox&&omnibox.selectionStart===0&&omnibox.selectionEnd===omnibox.value.length,rawShortcuts,terminalKeydowns,draftPreserved:otherFocus.value===composerBeforeShortcut});
 // Passive observers never focus/select, consume a key or synthesize delivery. Only the real CEF -> trusted WK
 // bridge can produce the observed event; the production listener must bind it and perform the focus itself.
 const shortcut=(e:Event)=>{delivered.push((e as CustomEvent).detail);shortcutStage='native-event-received';trace('native-event');},focus=(e:FocusEvent)=>{focused++;trace('omnibox-focus',e);},blur=(e:FocusEvent)=>trace('omnibox-blur',e),rawKey=(e:KeyboardEvent)=>{if(e.target===otherFocus)terminalKeydowns++;if(e.metaKey&&(e.key.toLowerCase()==='l'||e.key==='ㅣ'||e.code==='KeyL'))rawShortcuts++;};
 document.addEventListener(shortcutName,shortcut,{capture:true,passive:true});document.addEventListener('keydown',rawKey,{capture:true,passive:true});omnibox.addEventListener('focus',focus,{passive:true});omnibox.addEventListener('blur',blur,{passive:true});trace('before-qa-focus');
 try{
  for(const [input,operation]of[['English','qa-shortcut'],['Korean IME','qa-shortcut-korean'],['Caps Lock','qa-shortcut-caps']] as const){
   otherFocus.focus();if(document.activeElement!==otherFocus)throw Error(`${input} Command-L did not begin in the terminal composer`);
   const receivedBefore=delivered.length,focusedBefore=focused;
   shortcutStage=`${input}:before-qa-focus`;await nav('qa-focus');await until(async()=>(await nav('status')).focused);shortcutStage=`${input}:cef-focused`;trace('cef-focused');if(document.activeElement===omnibox)throw Error(`${input}: native focus unexpectedly focused the omnibox before Command-L`);
   trace('before-qa-shortcut');await nav(operation);await wait(()=>delivered.length===receivedBefore+1&&focused===focusedBefore+1&&document.activeElement===omnibox&&omnibox.selectionStart===0&&omnibox.selectionEnd===omnibox.value.length);await delay(200);
   const detail=delivered[receivedBefore] as Record<string,unknown>|null;
   if(delivered.length!==receivedBefore+1||focused!==focusedBefore+1||!detail||Object.keys(detail).sort().join(',')!=='key,sessionId,source,tab,targetId'||detail.source!=='cef'||detail.sessionId!==ctx.session.id||detail.tab!=='main'||!shortcutTarget||detail.targetId!==shortcutTarget||detail.key!=='l')throw Error(`${input}: native Command-L delivery was not bound exactly once to its current CEF page: ${JSON.stringify(shortcutDiagnostics())}`);
   if(rawShortcuts!==0||terminalKeydowns!==0||otherFocus.value!==composerBeforeShortcut)throw Error(`${input}: native Command-L injected terminal keys or changed its draft: ${JSON.stringify({rawShortcuts,terminalKeydowns,draftPreserved:otherFocus.value===composerBeforeShortcut})}`);
  }
 }catch(error){throw Error(`${redact(error)}; shortcut diagnostics: ${JSON.stringify(shortcutDiagnostics())}`);}finally{document.removeEventListener(shortcutName,shortcut,true);document.removeEventListener('keydown',rawKey,true);omnibox.removeEventListener('focus',focus);omnibox.removeEventListener('blur',blur);}
 checks.push('English, Korean IME and Caps Lock Command-L each reach the bound trusted CEF event once, focus and select the omnibox once, and preserve the terminal draft without DOM key injection');
 await human('post');const post=new URL('/nav-post',ctx.fixtureUrl).href;await settled(post);const postBefore=(await ask('/qa-human',{operation:'stats'})).postHits;
 let postRefused=false;try{await nav('reload');}catch(e){postRefused=String(e).includes('reload-would-resubmit');}if(!postRefused)throw Error('POST reload was not refused');
 await nav('back');await settled(a);let forwardPostRefused=false;try{await nav('forward');}catch(e){forwardPostRefused=String(e).includes('reload-would-resubmit');}if(!forwardPostRefused)throw Error('Forward to POST was not refused');
 await human('post');await settled(post);await nav('navigate',b);await settled(b);let backPostRefused=false;try{await nav('back');}catch(e){backPostRefused=String(e).includes('reload-would-resubmit');}if(!backPostRefused)throw Error('Back to POST was not refused');
 // Restore the GET fixture for the subsequent existing recovery scenarios.
 await nav('navigate',ctx.fixtureUrl);await settled(ctx.fixtureUrl);await delay(200);if((await ask('/qa-human',{operation:'stats'})).postHits!==postBefore+1)throw Error('POST was resubmitted');
 checks.push('reload of a POST result and back/forward to POST entries refuse reload-would-resubmit without resubmitting');
 await ask('/qa-end-workroom',{});await wait(()=>document.querySelector('[data-error-code=workspace-not-found]'));
 {const r=document.querySelector('[data-testid=owned-browser-slot]')!.getBoundingClientRect();if(r.top<0||r.bottom>innerHeight||r.left<0||r.right>innerWidth)throw Error('The reaped-workspace error pushed the page out of the window');await expectVisibility(true);}
 await button('owned-browser-close');await closedToStart();if(document.querySelector('[data-error-code=workspace-not-found]'))throw Error('Closed native browser retained a stale reaped-workspace error');checks.push('a human closes every native tab after its Workroom was ended and reaped, detaches the workspace and returns to the saved-task start card without a stale error');const recovered=ctx.session.id+'_recovered';
 for(let i=0;i<100;i++){const opened=await invoke<{preparing?:boolean}>('workroom_browser_native',{sessionId:recovered,operation:'open',profileKey:ctx.session.id});if(!opened.preparing)break;await delay(100);}
 await invoke('workroom_browser_native',{sessionId:recovered,operation:'navigate',url:new URL('/restore',ctx.fixtureUrl).href});await delay(300);const restored=await invoke<any>('workroom_browser_native',{sessionId:recovered,operation:'status'});const contents=JSON.parse((await human('state',restored)).value);if(!contents.cookie.includes('atz-role=one')||contents.storage!=='one')throw Error('Recovered Chromium profile lost cookies or storage');checks.push('a new Workroom view can reopen the saved browser profile without copying cookies');
 await invoke('qa_finish',{report:{passed:true,checks,realAccounts:0,personalProfileAccess:false,topLevelNavigation}});
 }
}catch(e){const native=await invoke('workroom_browser_native',{sessionId:ctx.session.id,operation:'status'}).catch(String);const r=document.querySelector('[data-testid=owned-browser-slot]')?.getBoundingClientRect();await invoke('qa_finish',{report:{passed:false,checks,error:redact(e),native,slot:r?{x:r.x,y:r.y,width:r.width,height:r.height,viewport:innerHeight}:null,scroll:Object.fromEntries(['.ai-terminal-panel','.workroom-session-dialog-content','.ai-terminal-workspace','.ai-terminal-body','.workroom-browser-panel'].map(s=>{const e=document.querySelector(s);return [s,e?{scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight}:null];})),layout:(()=>{try{return layoutDiagnostics();}catch{return null;}})(),screen:redact(document.body.innerText).slice(-8000)}});}
