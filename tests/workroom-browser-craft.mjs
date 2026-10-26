/** Production browser frame in the real Workroom dialog/flex hierarchy. Native
 * Chromium and the broker are deterministic local stubs; no installed app,
 * account, external page or AI provider is used. The native rectangle, rendered
 * controls, keyboard events and computed styles are real browser observations.
 * CRAFT_SHOTS=/tmp/atz-browser-craft saves optional comparison screenshots.
 * CRAFT_EXTENDED_LANG=1 adds 72 representative split-view language cases by
 * reusing each engine's last connected page. Normal profile counts stay fixed.
 */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {createServer as createHttpServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium,webkit} from 'playwright';

const viewports=[{width:800,height:814},{width:1280,height:860},{width:1512,height:982}];
const owners=['human','observing','agent','taking','disconnected'];
const themes=['dark','gray'];

export async function runBrowserCraftScreens(){
 const root=fileURLToPath(new URL('..',import.meta.url));
 const scratch=await mkdtemp(join(tmpdir(),'atz-browser-craft-'));
 const shots=process.env.CRAFT_SHOTS?resolve(process.env.CRAFT_SHOTS):null;
 const extendedLanguage=process.env.CRAFT_EXTENDED_LANG==='1';
 if(shots){assert(shots!==root&&!shots.startsWith(root+sep),'CRAFT_SHOTS must be outside the repository');await mkdir(shots,{recursive:true});}
 const http=createHttpServer();let vite;
 const checks=[];let matrixCases=0,localeCases=0,extendedLocaleCases=0,screenshotsWritten=0;
 const capture=async(page,name)=>{if(shots){await page.screenshot({path:join(shots,name),animations:'disabled'});screenshotsWritten++;}};
 try{
  vite=await createServer({root,envDir:scratch,mode:'maintainer-test',cacheDir:join(scratch,'node_modules/.vite'),
   server:{middlewareMode:true,hmr:{server:http}},configFile:join(root,'vite.config.ts'),logLevel:'warn',
   plugins:[{name:'craft-deny-live-api',configureServer(server){server.middlewares.use((req,res,next)=>{
    if(!req.url?.startsWith('/api/'))return next();res.statusCode=503;res.end('Unmocked fixture API rejected');
   });}}]});
  http.on('request',vite.middlewares);
  await new Promise((yes,no)=>{http.once('error',no);http.listen(0,'127.0.0.1',yes);});
  const address=http.address();assert(address&&typeof address!=='string'&&address.port!==3001);
  const origin=`http://127.0.0.1:${address.port}`;
  const [source,main]=await Promise.all(['/src/WorkroomBrowserFrame.tsx','/src/main.tsx'].map(path=>fetch(origin+path).then(r=>{assert.equal(r.status,200);return r.text();})));
  const react=source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1];
  const reactDom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];assert(react&&reactDom);
  const html=`<!doctype html><html lang="ko"><meta charset="utf-8"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
import '/src/index.css';import '/src/workspaceDesign.css';import '/src/AiTerminalPanel.css';import '/src/WorkroomSessionDirectory.css';
const {WorkroomBrowserFrame}=await import('/src/WorkroomBrowserFrame.tsx');
const {WorkroomBrowserError}=await import('/src/workroomBrowserErrorCodes.ts');
const {workroomBrowserUiCopy}=await import('/src/workroomBrowserUiCopy.ts');
const {readAppLanguage,writeAppLanguage}=await import('/src/i18n.ts');
const copy=value=>structuredClone(value),sessionId='craft_workroom',targetId='craft_project',url='https://example.test/one';
const pages=Array.from({length:6},(_,i)=>({id:'craft_page_'+i,title:'비교 자료 '+(i+1)+' · 충분히 긴 페이지 제목',url:'https://example.test/'+(i+1)}));
pages[0].url=url;
const observation=()=>({id:'craft_observation',url,title:'비교 자료',text:'사람이 확인할 합성 페이지',elements:[],capturedAt:'2026-10-25T00:00:00Z',untrusted:true});
const f=window.craft={workspace:null,requests:[],nativeOps:[],handoffs:[],drafts:[],ui:workroomBrowserUiCopy(readAppLanguage()),cancelled:0,opened:false,available:!new URL(location.href).searchParams.has('unavailable'),refresh:()=>{},failNext:null,
 native:{human:true,loading:false,progress:1,loadError:null,notice:null,popupCount:0,blockedInputs:0,focused:false},
 set(patch){Object.assign(this.workspace,patch);this.workspace.connection=this.workspace.owner==='disconnected'?'disconnected':'connected';this.refresh();},
 setNative(patch){Object.assign(this.native,patch);this.refresh();},
 language(lang){const saved=writeAppLanguage(lang);this.ui=workroomBrowserUiCopy(lang);return saved;},
 lastView(){return this.nativeOps.filter(x=>x.operation==='frame'||x.operation==='hide').at(-1);}};
// Seed six prior native views for the layout matrix. Native tab names are
// 1..16 lowercase letters/digits, and the first view keeps the name main.
const indexOfTab=tab=>tab==='main'?0:Number(tab.slice(1));
const tabPages=()=>pages.map((page,i)=>({tab:i?'t'+i:'main',targetId:page.id,title:page.title,url:page.url,loading:f.native.loading,closed:false,closing:false,profileKey:sessionId,popupCount:i?0:f.native.popupCount}));
const status=tab=>{const page=pages[indexOfTab(tab)];return {available:true,sessionId,closed:!f.opened,preparing:false,tab,tabs:f.opened?tabPages():[],profileKey:sessionId,
 url:page.url,title:page.title,targetId:page.id,port:9333,canGoBack:true,canGoForward:true,consoleErrors:0,...f.native,
 popupCount:tab==='main'?f.native.popupCount:0,
 readiness:{targetProbes:1,targetResults:1,navigations:1}};};
window.isTauri=true;window.__TAURI_INTERNALS__={transformCallback:()=>0,invoke:async(command,args)=>{
 if(command!=='workroom_browser_native')throw Error('Unexpected native command: '+command);
 f.nativeOps.push(copy(args));const tab=args.tab??'main',op=args.operation;
 if(args.sessionId!==sessionId||args.profileKey!==undefined&&args.profileKey!==sessionId)throw Error('Foreign native Workroom/profile binding');
 if(!/^(main|t[1-5])$/.test(tab))throw Error('Invalid browser tab.');
 if(!['availability','tabs','open','navigate','status','retarget','frame','hide','lock','unlock','close-popups','close','back','forward','reload','stop'].includes(op))throw Error('Unknown native browser operation');
 if(op==='availability')return {available:f.available};
 if(!f.available)throw Error('This app was built without embedded Chromium.');
 if(op==='tabs')return {available:true,sessionId,port:9333,tabs:f.opened?tabPages():[]};
 if(op==='open')f.opened=true;
 if(!f.opened)throw Error('Open the embedded browser first');
 if(op==='lock'){if(f.native.popupCount)throw Error('Close the login popup before handing control to AI.');f.native.human=false;}
 if(op==='unlock'){f.native.human=true;f.native.notice=null;}
 if(['navigate','back','forward','reload','stop'].includes(op)&&!f.native.human)throw Error('Take control before navigating.');
 if(op==='navigate'){const address=new URL(args.url);if(!['https:','http:'].includes(address.protocol))throw Error('HTTP(S) URL required');pages[indexOfTab(tab)].url=args.url;}
 if(op==='frame'&&(!Array.isArray(args.rect)||args.rect.length!==4||args.rect.some(n=>!Number.isFinite(n)||n<0||n>20000)))throw Error('Invalid browser rectangle');
 if(op==='close-popups')f.native.popupCount=0;
 if(op==='close')f.opened=false;
 return status(tab);
}};
const broker=async request=>{
 f.requests.push(copy(request));
 if(f.failNext===request.operation){f.failNext=null;throw new WorkroomBrowserError('workspace-not-found','Browser workspace not found.');}
 if(request.operation==='profiles')return {success:true,profiles:[{id:'craft_chrome_profile',profileName:'시험 Chrome 프로필',accountLabel:null}]};
 if(request.operation==='recoveries'){if(request.sessionId!==sessionId||request.targetId!==targetId)throw Error('Foreign recovery binding');return {success:true,recoveries:[]};}
 if(request.operation==='connect-owned'){
  const page=pages.find(page=>page.id===request.pageId);
  if(request.sessionId!==sessionId||request.targetId!==targetId||request.port!==9333||request.profileKey!==sessionId||!page)throw Error('Foreign owned browser target binding');
  f.workspace={id:'craft_workspace',sessionId,targetId,profileId:'owned:'+sessionId,profileName:'이 작업용 브라우저',source:'owned',page:copy(page),tabs:copy(pages),owner:'human',epoch:(f.workspace?.epoch??0)+1,observation:null,connection:'connected',profileVerification:'user-confirmed'};
 }else if(!f.workspace||request.workspaceId!==f.workspace.id)throw Error('Foreign broker workspace binding');
 else if(request.operation==='take'){
  f.workspace.owner=f.workspace.connection==='connected'?'human':'disconnected';f.workspace.epoch++;f.workspace.observation=null;delete f.workspace.waiting;
 }else if(request.operation==='resume'){
  if(f.workspace.connection!=='connected'||f.workspace.owner!=='human'||f.workspace.receipt?.state==='unknown'||f.workspace.activity?.some(item=>item.state==='unknown'))throw Error('Unreviewed handoff refused by fixture');
  f.workspace.owner='agent';f.workspace.epoch++;f.workspace.observation=observation();
 }else if(request.operation==='grant'){
  assertGrant();return {success:true,workspace:copy(f.workspace),grant:'a'.repeat(64)};
 }else if(request.operation==='settle'){
  if(!['human','disconnected'].includes(f.workspace.owner)||request.requestId!==f.workspace.receipt?.id||f.workspace.receipt.state!=='unknown')throw Error('Wrong receipt reviewed');
  f.workspace.receipt.state='reviewed';f.workspace.activity=f.workspace.activity?.map(item=>item.id===request.requestId?{...item,state:'reviewed'}:item);
 }else if(request.operation==='select'){
  const page=pages.find(p=>p.id===request.pageId);if(f.workspace.owner!=='human'||request.confirmProfile!==true||!page)throw Error('Foreign selected tab binding');
  f.workspace.page=copy(page);f.workspace.epoch++;f.workspace.observation=null;
 }else if(request.operation!=='status')throw Error('Unexpected broker operation: '+request.operation);
 return {success:true,workspace:copy(f.workspace)};
};
function assertGrant(){if(f.workspace.connection!=='connected'||f.workspace.owner!=='agent'||!f.workspace.observation)throw Error('Grant before the fresh observation');}
function Fixture(){
 const [revision,setRevision]=React.useState(0),dialog=React.useRef(null);
 React.useEffect(()=>{f.refresh=()=>setRevision(value=>value+1);dialog.current.showModal();return()=>{f.refresh=()=>{};};},[]);
 const request=React.useCallback(broker,[revision]);
 const terminal=React.createElement(React.Fragment,null,
  React.createElement('div',{className:'ai-terminal-surface','data-testid':'craft-retained-terminal'},'실제 프레임 안에 유지되는 합성 터미널'),
  React.createElement('div',{'data-testid':'workroom-command-composer'},React.createElement('textarea',{'aria-label':'워크룸 입력',defaultValue:'검토할 초안'})));
 return React.createElement('dialog',{ref:dialog,className:'workroom-session-dialog','data-testid':'craft-dialog',onCancel:()=>f.cancelled++},
  React.createElement('header',{className:'workroom-session-dialog-header'},React.createElement('strong',null,'브라우저 작업')),
  React.createElement('div',{className:'workroom-session-dialog-content'},React.createElement('fieldset',{className:'session-directory-view-controls'},
   React.createElement('section',{className:'ai-terminal-panel'},React.createElement('div',{className:'ai-terminal-workspace'},React.createElement('div',{className:'ai-terminal-body'},
    React.createElement(WorkroomBrowserFrame,{sessionId,targetId,visible:true,request,onDraft:text=>f.drafts.push(text),onHandoff:grant=>f.handoffs.push(grant)},terminal)))))));
}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Fixture));
</script></html>`;

  const geometry=page=>page.evaluate(()=>{
   const get=id=>document.querySelector('[data-testid="'+id+'"]'),box=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right};};
   const panel=get('workroom-browser-panel'),slot=get('owned-browser-slot'),stage=get('workroom-browser-stage');
   const primary=[...panel.querySelectorAll('button[data-action]')].filter(e=>!e.closest('[hidden]')&&e.getClientRects().length&&['ai','human','danger','warn'].includes(e.dataset.variant));
   const hit=e=>{const r=e.getBoundingClientRect(),target=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return !!target&&e.contains(target);};
   const visible=e=>e&&getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden'&&e.getClientRects().length;
   const selected=[...document.querySelectorAll('.workroom-browser-tabs button')].find(e=>e.getAttribute('aria-pressed')==='true'),other=[...document.querySelectorAll('.workroom-browser-tabs button')].find(e=>e.getAttribute('aria-pressed')==='false');
   const paint=e=>{const s=getComputedStyle(e);return [s.backgroundColor,s.borderTopColor,s.color].join('|');};
   const probe=document.createElement('span');probe.style.color='var(--violet)';document.body.append(probe);const violet=getComputedStyle(probe).color;probe.remove();
   const bar=get('workroom-browser-bar'),toolbarParts=['.wb-nav','[data-testid=workroom-browser-omnibox]','[data-testid=workroom-browser-owner-pill]','[data-testid=workroom-browser-menu]']
    .map(selector=>({selector,element:bar.querySelector(selector)})).filter(item=>visible(item.element)).map(item=>({selector:item.selector,...box(item.element)}));
   return {slot:box(slot),panel:box(panel),stage:box(stage),viewport:[innerWidth,innerHeight],wide:document.documentElement.scrollWidth-innerWidth,
    panelScroll:panel.scrollHeight-panel.clientHeight,primary:primary.map(e=>({id:e.dataset.testid,hit:hit(e),disabled:e.disabled})),
    selectedPaint:paint(selected),otherPaint:paint(other),outline:getComputedStyle(stage).outlineColor,violet,
    tabs:panel.querySelectorAll('[data-testid=owned-browser-tab]').length,text:panel.innerText,shown:visible(panel),bar:box(bar),toolbarParts,last:window.craft.lastView()};
  });
  const settled=async page=>{await page.waitForFunction(()=>{
   const r=document.querySelector('[data-testid=owned-browser-slot]')?.getBoundingClientRect(),last=window.craft.lastView();
   return last?.operation==='frame'&&r&&[r.x,r.y,r.width,r.height].every((value,i)=>Math.abs(value-last.rect[i])<1);
  },undefined,{timeout:8000});return geometry(page);};
  const cleanText=text=>assert.doesNotMatch(text,/\bError:|\bunknown\b|\bowned\b|req_[0-9a-f]|grant=|epoch=/,'No raw exception, internal state, request ID or access token in the visible panel');
  const change=async(page,patch)=>{await page.evaluate(patch=>window.craft.set(patch),patch);await page.waitForFunction(owner=>document.querySelector('[data-testid=workroom-browser-panel]')?.dataset.owner===owner,patch.owner);};
  const pageBounds=(m,label,viewport)=>{
   assert(m.slot.height>=200,`${label}: page height ${m.slot.height}px must be at least 200px`);
   assert(m.slot.height>=m.panel.height*.65,`${label}: page share ${Math.round(m.slot.height/m.panel.height*100)}% must be at least 65%`);
   assert(m.slot.x>=0&&m.slot.y>=0&&m.slot.right<=viewport.width+1&&m.slot.bottom<=viewport.height+1,`${label}: entire native slot stays inside the viewport`);
   assert(m.wide<=1&&m.panelScroll<=2,`${label}: no document sideways scroll or scrolling browser panel`);
  };
  // Both language passes exercise the same production frame, broker and measurement path. The optional pass only
  // resizes/rethemes this connected page; it adds no duplicated fixture, context, API or handoff implementation.
  const languageScreens=async(page,{engineName,viewport,theme,prefix=''})=>{
   const label=`${engineName} ${viewport.width}x${viewport.height} ${theme}`;let count=0,top;
   for(const lang of ['en','de','ja']){
    assert.equal(await page.evaluate(lang=>window.craft.language(lang),lang),true,`${label}: the real app-language write succeeds for ${lang}`);
    for(const owner of ['human','agent']){
     await change(page,{owner,receipt:null,activity:[],waiting:null});
     const id=owner==='human'?'workroom-browser-handoff':'workroom-browser-take';
     const expected=await page.evaluate(owner=>window.craft.ui.owner[owner==='human'?'handToAi':'takeOver'],owner);
     await page.waitForFunction(({id,expected})=>document.querySelector('[data-testid="'+id+'"]')?.textContent?.includes(expected),{id,expected});
     const m=await settled(page),caseLabel=`${label} ${lang} ${owner}`;pageBounds(m,caseLabel,viewport);
     assert.equal(m.tabs,6,`${caseLabel}: all six Workroom tabs remain in the strip`);
     assert.equal(m.primary.length,1,`${caseLabel}: one translated primary verb`);
     assert(m.primary[0].hit&&!m.primary[0].disabled,`${caseLabel}: the translated primary is enabled and uncovered`);
     top??=m.slot.y;assert(Math.abs(m.slot.y-top)<=1,`${caseLabel}: language and ownership never move the page top`);
     for(let i=0;i<m.toolbarParts.length;i++){
      const part=m.toolbarParts[i];assert(part.x>=m.bar.x-1&&part.right<=m.bar.right+1&&part.y>=m.bar.y-1&&part.bottom<=m.bar.bottom+1,`${caseLabel}: ${part.selector} stays inside the toolbar`);
      for(const next of m.toolbarParts.slice(i+1)){
       const x=Math.min(part.right,next.right)-Math.max(part.x,next.x),y=Math.min(part.bottom,next.bottom)-Math.max(part.y,next.y);
       assert(x<=1||y<=1,`${caseLabel}: ${part.selector} never overlaps ${next.selector}`);
      }
     }
     cleanText(m.text);count++;
     await capture(page,`${prefix}${engineName}-${viewport.width}x${viewport.height}-${theme}-${lang}-split-${owner}.png`);
    }
   }
   return count;
  };
  for(const [engineName,engine] of Object.entries({chromium,webkit})){
   const browser=await engine.launch({headless:true});
   try{for(const viewport of viewports)for(const theme of themes){
    const context=await browser.newContext({viewport,serviceWorkers:'block'});
    // The matrix measures the default >=65% page share. Manual height resizing has its separate >=200px layout
    // regression; never let a saved height silently turn these default matrix screenshots into manual-size cases.
    await context.addInitScript(()=>{if(!/^https?:$/.test(location.protocol))return;localStorage.removeItem('agentstoz.workroomBrowserHeight');localStorage.removeItem('agentstoz.workroomBrowserSplit');});
    const page=await context.newPage(),errors=[],unexpected=[];
    page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000);
    await page.route('**/*',route=>{const req=route.request(),url=new URL(req.url());
     if(url.origin!==origin){unexpected.push(req.method()+' '+url.origin+url.pathname);return route.abort();}
     if(url.pathname==='/__craft')return route.fulfill({contentType:'text/html',body:html});
     if(url.pathname.startsWith('/api/')){unexpected.push(req.method()+' '+url.pathname);return route.fulfill({status:503,json:{error:'Unmocked fixture API rejected'}});}
     return route.continue();});
    const label=`${engineName} ${viewport.width}x${viewport.height} ${theme}`;
    try{
     await page.goto(origin+'/__craft');await page.evaluate(theme=>document.documentElement.dataset.appTheme=theme,theme);
     await page.getByTestId('workroom-browser-toggle').click();
     await page.getByTestId('owned-browser-address').fill('https://example.test/one');await page.getByTestId('owned-browser-open').click();
     await page.locator('[data-testid=workroom-browser-panel][data-owner=human]').waitFor();
     const tops={};
     for(const view of ['split','browser']){
      await page.getByTestId(view==='split'?'workroom-browser-toggle':'workroom-browser-only').click();
      for(const owner of owners){
       await change(page,{owner,receipt:null,activity:[],waiting:null});const m=await settled(page);
       assert.equal(m.tabs,6,`${label} ${view} ${owner}: all six Workroom tabs remain in the strip`);
       pageBounds(m,`${label} ${view} ${owner}`,viewport);
       assert.equal(m.primary.length,1,`${label} ${view} ${owner}: exactly one filled primary verb`);
       assert(m.primary[0].hit,`${label} ${view} ${owner}: the primary verb is uncovered and inside the viewport`);
       assert.notEqual(m.selectedPaint,m.otherPaint,`${label}: the selected view has a computed visual distinction`);
       tops[view]??=m.slot.y;assert(Math.abs(m.slot.y-tops[view])<=1,`${label} ${view}: ownership never moves the page top`);
       if(['agent','taking','observing'].includes(owner)){
        // The normal-motion outline changes colour over 160ms. Wait for its
        // observable final colour instead of asserting a timing-dependent blend.
        await page.waitForFunction(color=>getComputedStyle(document.querySelector('[data-testid=workroom-browser-stage]')).outlineColor===color,m.violet);
        assert.equal((await geometry(page)).outline,m.violet,`${label} ${view} ${owner}: AI ownership has the violet ring outside the native slot`);
       }
       assert.equal(await page.getByTestId('owned-browser-address').isEditable(),owner==='human',`${label} ${view} ${owner}: only a connected person edits the address`);
       cleanText(m.text);matrixCases++;
       await capture(page,`${engineName}-${viewport.width}x${viewport.height}-${theme}-ko-${view}-${owner}.png`);
      }
     }
     await change(page,{owner:'human',receipt:null,activity:[]});
     await page.getByTestId('workroom-browser-toggle').click();const baseline=await settled(page);
     // The native page may load, show a popup or file notice, or the broker may
     // refuse a command. Those messages take space below the page, never above it.
     await page.evaluate(()=>window.craft.setNative({loading:true,progress:.4}));
     await page.getByRole('progressbar').waitFor();assert(Math.abs((await settled(page)).slot.y-baseline.slot.y)<=1,`${label}: loading never moves the page top`);
     await page.evaluate(()=>window.craft.setNative({loading:false,progress:1,popupCount:1}));
     const popup=page.locator('[data-testid=workroom-browser-control][data-kind=popup]');await popup.waitFor();
     const popupCopy=await page.evaluate(()=>[window.craft.ui.owner.popupOpenGeneric,window.craft.ui.owner.popupOpen.replace('{host}',new URL(window.craft.workspace.page.url).host)]);
     const popupText=await popup.innerText();assert(popupCopy.some(text=>popupText.includes(text)),`${label}: the control bar names the open login window`);
     assert(Math.abs((await settled(page)).slot.y-baseline.slot.y)<=1,`${label}: a login popup notice never moves the page top`);
     await page.evaluate(()=>window.craft.setNative({popupCount:0,notice:'download-needs-human'}));
     const file=page.locator('[data-testid=workroom-browser-control][data-kind=notice]');await file.waitFor();
     assert((await file.innerText()).includes(await page.evaluate(()=>window.craft.ui.owner.fileNotice)),`${label}: the control bar explains the human file action`);
     assert(Math.abs((await settled(page)).slot.y-baseline.slot.y)<=1,`${label}: a file notice never moves the page top`);
     await page.evaluate(()=>window.craft.setNative({notice:null}));
     await change(page,{owner:'agent'});await page.evaluate(()=>{window.craft.failNext='take';});await page.getByTestId('workroom-browser-take').click();
     await page.locator('[data-testid=workroom-browser-owner][data-error-code=workspace-not-found]').waitFor();
     const refused=await settled(page);assert(Math.abs(refused.slot.y-baseline.slot.y)<=1,`${label}: a broker refusal keeps the loaded page top`);cleanText(refused.text);
     await page.getByTestId('workroom-browser-dismiss').click();
     // An unknown result is checked and settled explicitly. The fixture logs
     // every request, so a hidden replay cannot pass by merely changing copy.
     const receipt={id:'req_deadbeef',state:'unknown',action:'click',target:{role:'button',name:'신청'},at:1792886400000};
     await change(page,{owner:'agent',receipt,activity:[receipt]});
     const beforeUnknown=await page.evaluate(()=>window.craft.requests.length);
     // A newly unknown receipt opens its activity automatically. Wait for that
     // observable effect; toggling here could close a drawer that just opened.
     const review=page.getByTestId('workroom-browser-check');await review.waitFor({state:'visible'});
     const unknown=await settled(page);assert(Math.abs(unknown.slot.y-baseline.slot.y)<=1,`${label}: opening the unknown-result activity keeps the page top`);cleanText(unknown.text);
     await review.click();await page.locator('[data-testid=workroom-browser-panel][data-owner=human]').waitFor();
     await page.waitForFunction(()=>document.querySelector('[data-testid=workroom-browser-handoff]')?.disabled);
     await page.getByTestId('workroom-browser-settle').click();await page.waitForFunction(()=>window.craft.workspace.receipt.state==='reviewed');
     const reviewed=await page.evaluate(start=>window.craft.requests.slice(start).filter(r=>r.operation!=='status').map(r=>r.operation),beforeUnknown);
     assert.deepEqual(reviewed,['take','settle'],`${label}: an unknown action has no replay, resume or grant`);
     const toggle=page.getByTestId('workroom-browser-activity-toggle');if(await toggle.getAttribute('aria-expanded')==='true')await toggle.click();
     await change(page,{owner:'human',receipt:null,activity:[]});
     // One primary handoff observes first and places one grant into the trusted
     // handoff callback; no machine block leaks into visible text or the draft.
     const beforeHandoff=await page.evaluate(()=>window.craft.requests.length);
     await page.getByTestId('workroom-browser-handoff').click();await page.waitForFunction(()=>window.craft.handoffs.length===1);
     const handoff=await page.evaluate(start=>({ops:window.craft.requests.slice(start).filter(r=>r.operation!=='status').map(r=>r.operation),handoffs:window.craft.handoffs.length,drafts:window.craft.drafts.length}),beforeHandoff);
     assert.deepEqual(handoff,{ops:['resume','grant'],handoffs:1,drafts:0},`${label}: one handoff is one resume, fresh observation and grant`);cleanText((await geometry(page)).text);
     await change(page,{owner:'human',receipt:null,activity:[]});
     // The dialog has no test-only Escape guard: an unhandled Escape really
     // closes it. Production omnibox/menu handling must keep it open.
     const input=page.getByTestId('owned-browser-address');await input.focus();await input.fill('https://example.test/uncommitted');await page.keyboard.press('Escape');
     assert.equal(await page.getByTestId('craft-dialog').evaluate(e=>e.open),true,`${label}: Escape in the address keeps the Workroom open`);
     assert.equal(await input.inputValue(),'https://example.test/one',`${label}: Escape restores the committed address`);
     await page.getByTestId('workroom-browser-menu').click();await page.keyboard.press('Escape');
     assert.equal(await page.getByTestId('craft-dialog').evaluate(e=>e.open),true,`${label}: Escape in the menu keeps the Workroom open`);
     const beforeClose=await page.evaluate(()=>({cancelled:window.craft.cancelled,closes:window.craft.nativeOps.filter(op=>op.operation==='close').length,detaches:window.craft.requests.filter(op=>op.operation==='detach').length}));
     await page.getByTestId('workroom-browser-menu').click();await page.getByTestId('owned-browser-close').click();
     await page.waitForFunction(()=>document.activeElement?.getAttribute('data-testid')==='workroom-browser-close-all-cancel');
     assert.equal(await page.getByTestId('workroom-browser-close-all-cancel').evaluate(e=>e===document.activeElement),true,`${label}: close-all confirmation focuses Cancel`);
     await page.keyboard.press('Escape');
     await page.locator('[data-testid=workroom-browser-control][data-kind=confirm]').waitFor({state:'detached'});
     assert.equal(await page.getByTestId('craft-dialog').evaluate(e=>e.open),true,`${label}: Escape cancels close-all without closing the Workroom`);
     assert.deepEqual(await page.evaluate(()=>({cancelled:window.craft.cancelled,closes:window.craft.nativeOps.filter(op=>op.operation==='close').length,detaches:window.craft.requests.filter(op=>op.operation==='detach').length})),beforeClose,`${label}: cancelling close-all sends no detach or native close and never reaches dialog cancel`);
     assert.equal(await page.evaluate(()=>window.craft.opened),true,`${label}: cancelling close-all preserves the native page`);
     const viewButton=page.getByTestId('workroom-browser-toggle');await viewButton.focus();let reached=false;
     for(let count=0;count<3;count++){await page.keyboard.press('Tab');reached=await page.evaluate(()=>!!document.activeElement?.closest('[data-testid=workroom-browser-panel]'));if(reached)break;}
     assert(reached,`${label}: the browser is reached within three Tab presses from the view switch`);
     await input.focus();await page.keyboard.press('Meta+l');assert.equal(await input.evaluate(e=>[e.selectionStart,e.selectionEnd].join(':')),`0:${(await input.inputValue()).length}`,`${label}: Command-L selects the address`);
     const tabs=page.getByTestId('owned-browser-tab');await tabs.first().focus();await page.keyboard.press('ArrowRight');
     assert.equal(await tabs.nth(1).evaluate(e=>e===document.activeElement),true,`${label}: arrow keys reach the next Workroom tab`);
     await page.emulateMedia({reducedMotion:'reduce'});
     const motion=await page.evaluate(()=>[...document.querySelectorAll('[data-testid=workroom-browser-stage],.wb-progress-fill,.wb-spin')].map(e=>{const s=getComputedStyle(e);return {transition:s.transitionDuration,animation:s.animationName};}));
     assert(motion.every(s=>s.transition.split(',').every(v=>parseFloat(v)===0)&&s.animation==='none'),`${label}: reduced motion disables page-ring transitions and busy animation`);
     // Reuse the connected page for a bounded visual-language pass. Titles are
     // page content; only application UI changes language through its real API.
     if(viewport.width===1280&&theme==='gray'){
      await page.emulateMedia({reducedMotion:'no-preference'});await page.getByTestId('workroom-browser-toggle').click();
      localeCases+=await languageScreens(page,{engineName,viewport,theme});
      checks.push(`${label}: English, German and Japanese each retain the human/AI primary hit target and non-overlapping toolbar`);
     }
     if(viewport.width===800&&theme==='dark'){
      await page.goto(origin+'/__craft?unavailable=1');await page.getByTestId('workroom-browser-toggle').click();
      await page.getByTestId('owned-browser-unavailable').waitFor();
      assert.equal(await page.getByTestId('workroom-browser-connect-chrome').isVisible(),true,`${label}: an unavailable native build offers My Chrome`);
      await page.getByTestId('workroom-browser-connect-chrome').click();await page.getByTestId('workroom-browser-chrome-setup').waitFor();
      assert.equal(await page.getByTestId('workroom-browser-source-owned').count(),0,`${label}: the unavailable native source is absent after entering My Chrome`);
      cleanText(await page.getByTestId('workroom-browser-panel').innerText());
      await capture(page,`${engineName}-${viewport.width}x${viewport.height}-${theme}-ko-unavailable-chrome.png`);
     }
     if(extendedLanguage&&viewport.width===1512&&theme==='gray'){
      await page.emulateMedia({reducedMotion:'no-preference'});await page.getByTestId('workroom-browser-toggle').click();
      // 900px is intentionally absent from the normal matrix. Existing large sizes keep their usual heights.
      for(const extendedViewport of [{width:900,height:814},...viewports.filter(size=>size.width>=1280)])for(const extendedTheme of themes){
       await page.setViewportSize(extendedViewport);await page.evaluate(theme=>document.documentElement.dataset.appTheme=theme,extendedTheme);
       extendedLocaleCases+=await languageScreens(page,{engineName,viewport:extendedViewport,theme:extendedTheme,prefix:'extended-'});
       checks.push(`${engineName} ${extendedViewport.width}x${extendedViewport.height} ${extendedTheme}: extended English, German and Japanese split views retain primary hit targets, toolbar separation and page bounds`);
      }
     }
     assert.deepEqual(errors,[],`${label}: no browser runtime errors`);assert.deepEqual(unexpected,[],`${label}: no live API or external origin`);
     checks.push(`${label}: owner/view matrix, six tabs, page share and stable top; unknown review, single handoff, keyboard, Escape and reduced motion`);
    }finally{await context.close();}
   }}finally{await browser.close();}
  }
  if(extendedLanguage)assert.equal(extendedLocaleCases,72,'The optional language matrix includes every requested engine, width, theme, language and owner once');
  return {passed:true,matrixCases,localeCases,...(extendedLanguage?{extendedLocaleCases}:{}),engines:['chromium','webkit'],checks,fixtureOnly:true,installedAppChanged:false,realAccounts:0,screenshots:shots,screenshotsWritten};
 }finally{
  await vite?.close();await new Promise(yes=>http.close(yes));await rm(scratch,{recursive:true,force:true});
 }
}

if(import.meta.main)console.log(JSON.stringify(await runBrowserCraftScreens()));
