import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {createServer as createHttpServer} from 'node:http';
import {chromium,webkit} from 'playwright';
/** The production browser frame with a scripted built-in Chromium and broker: who a built-in page request belongs to.
 * A request belongs to what was chosen when it started — a saved task, or this Workroom's own profile. Choosing
 * anything else ends it at once in whatever stage it is, and a page connected without a saved task runs in this
 * Workroom's own profile, never in a saved task's profile that happens to be left open. Tauri and the broker are stubs;
 * what is real is the frame, the request stages and every native operation and broker request they send. */
export async function runOwnedRequestScreens(){
 const http=createHttpServer();
 const vite=await createServer({server:{middlewareMode:true,hmr:{server:http}},configFile:new URL('../vite.config.ts',import.meta.url).pathname});
 http.on('request',vite.middlewares);await new Promise((resolve,reject)=>{http.once('error',reject);http.listen(0,'127.0.0.1',resolve);});
 const origin=`http://127.0.0.1:${http.address().port}`,checks=[];
 const source=await fetch(`${origin}/src/WorkroomBrowserFrame.tsx`).then(r=>r.text()),main=await fetch(`${origin}/src/main.tsx`).then(r=>r.text());
 const react=source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1],reactDom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];assert(react&&reactDom);
 const html=`<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
// Native views like native/workroom-browser: one per tab of a Workroom (its first tab keyed by the Workroom itself), all
// tabs of a Workroom in one profile, a Workroom's tab list never showing another Workroom's views. A view's target is
// stable across its navigations. \`holdOpen\` keeps a profile preparing. Like lib.rs, a Workroom holds one profile
// admission while it prepares; a newer request for another profile replaces it.
const views=new Map(),pending=new Map(),native=window.native={ops:[],navigations:[],tabNavigations:[],holdOpen:false,holdClosing:false,holdDocument:false,holdStatus:false,statusWaiters:[],deliveredStatus:0};let targets=0;
const viewKey=(sessionId,tab)=>!tab||tab==='main'?sessionId:sessionId+'~'+tab;
const mine=sessionId=>[...views.values()].filter(v=>v.sessionId===sessionId);
const tabsOf=sessionId=>mine(sessionId).map(v=>({tab:v.tab,targetId:v.targetId,url:v.url,closed:v.closed,closing:!!v.closing,loading:!!v.loading,profileKey:v.profileKey,popupCount:0}));
// \`holdClosing\` keeps a closed view \`closing\` (listed, on its way out) until finishClosing(), like CEF before on_before_close.
const shut=v=>{if(native.holdClosing)v.closing=true;else v.closed=true;};
native.tabs=tabsOf;native.finishClosing=()=>{for(const v of views.values())if(v.closing){v.closing=false;v.closed=true;}};
const status=v=>({available:true,tab:v.tab,tabs:tabsOf(v.sessionId),closed:v.closed,profileKey:v.profileKey,url:v.url,targetId:v.targetId,port:9333,loading:!!v.loading,readiness:{targetProbes:1,targetResults:1,navigations:v.navigations}});
// A cold renderer accepts navigation before its first document commits. Status snapshots can finish later, as with
// the real native bridge; releasing them never re-reads a newer view and accidentally makes the test pass.
native.releaseStatus=()=>{native.holdStatus=false;for(const {reply,resolve} of native.statusWaiters.splice(0))resolve(reply);};
native.commitDocument=(sessionId,url)=>{const v=views.get(sessionId);if(!v)throw new Error('No native document');v.url=url;v.loading=false;};
window.isTauri=true;
window.__TAURI_INTERNALS__={transformCallback:()=>0,invoke:async(cmd,args)=>{
 if(cmd!=='workroom_browser_native')throw new Error('Not in this fixture: '+cmd);
 const {sessionId,operation}=args,tab=args.tab??'main',key=viewKey(sessionId,args.tab);native.ops.push({sessionId,operation,profileKey:args.profileKey,tab:args.tab});
 if(operation==='availability')return {available:true};
 if(operation==='tabs')return {available:true,sessionId,tabs:tabsOf(sessionId)};
 let view=views.get(key);
 if(operation==='open'){
  if(!view||view.closed){
   const sibling=mine(sessionId).find(v=>!v.closed);
   if(sibling){if(sibling.profileKey!==args.profileKey)throw new Error('Close the current browser before restoring another profile.');if(mine(sessionId).filter(v=>!v.closed).length>=6)throw new Error('This Workroom already has 6 tabs.');}
   else{
    for(const [other,profile] of pending)if(other!==sessionId&&profile===args.profileKey)throw new Error('This saved browser profile is preparing in another Workroom.');
    pending.set(sessionId,args.profileKey);if(native.holdOpen)return {available:true,preparing:true};pending.delete(sessionId);}
   views.delete(key);view={sessionId,tab,profileKey:args.profileKey,closed:false,url:'about:blank',navigations:0,targetId:'native_'+args.profileKey+'_'+(++targets)};views.set(key,view);}
  else if(view.profileKey!==args.profileKey)throw new Error('Close the current browser before restoring another profile.');
  return status(view);
 }
 // Without a tab, close and hide act on every tab of the Workroom, like lib.rs.
 if(!args.tab&&(operation==='close'||operation==='hide')){const all=mine(sessionId);if(!all.length)throw new Error('Open the embedded browser first');if(operation==='close')for(const v of all)if(!v.closed)shut(v);return status(views.get(key)??all[0]);}
 if(!view)throw new Error('Open the embedded browser first');
 if(operation==='close')shut(view);
 if(operation==='navigate'){view.navigations++;if(native.holdDocument)view.loading=true;else{view.url=args.url;view.loading=false;}native.navigations.push({sessionId,profileKey:view.profileKey,url:args.url});native.tabNavigations.push({sessionId,tab,url:args.url});if(!native.holdDocument)native.documentCommitted?.(status(view));}
 if(operation==='status'&&native.holdStatus){const reply=status(view);return await new Promise(resolve=>native.statusWaiters.push({reply,resolve})).then(reply=>{native.deliveredStatus++;return reply;});}
 return status(view);}};
// The broker labels a connect the way workroomBrowserHost does: a saved task's profile, else this Workroom's own — or,
// named by the request, the profile this Workroom's connected built-in browser already runs in.
const saved=[{id:'saved_a',sessionId:'prior_session',profileId:'owned:profile_saved',profileName:'Saved A',source:'owned',pageId:null,updatedAt:1792800000000,unknown:0},{id:'saved_b',sessionId:'prior_session',profileId:'owned:profile_saved',profileName:'Saved B',source:'owned',pageId:null,updatedAt:1792800000000,unknown:0}];
const spaces=new Map(),broker=window.broker={connects:[],detaches:[],releases:[],selects:[],hold:null,fail:false,holdSelectPage:null,selectWaiters:[],selectDelivered:0,spaces};
// Hold only a chosen select response after the host applied it. A later select still reaches the host normally.
broker.releaseSelect=()=>{broker.holdSelectPage=null;for(const {reply,resolve} of broker.selectWaiters.splice(0))resolve(reply);};
// Every answer is a copy, like JSON from the real broker.
const copy=w=>w&&{...w,page:w.page&&{...w.page},tabs:w.tabs.map(p=>({...p}))};
const pageOf=id=>{const v=[...views.values()].find(v=>v.targetId===id);return {id,url:v?.url??'',title:''};};
const request=async r=>{
 if(r.operation==='recoveries')return {success:true,recoveries:saved};
 if(r.operation==='connect-owned'){broker.connects.push(r);const n=broker.connects.length;if(broker.hold)await broker.hold;if(broker.fail){broker.fail=false;throw new Error('A browser connection is awaiting approval.');}
  const own=saved.find(s=>s.id===r.recoveryId)?.profileId??'owned:'+r.sessionId,existing=[...spaces.values()].find(w=>w.sessionId===r.sessionId&&w.connection==='connected');
  const profileId=r.profileKey===undefined?own:'owned:'+r.profileKey;
  if(profileId!==own&&!(!r.recoveryId&&existing?.profileId===profileId))throw new Error(existing?'Detach the original browser before changing this Workroom connection.':'A new built-in browser runs in this Workroom own profile or in the chosen saved task.');
  if(existing){
   if(existing.profileId!==profileId)throw new Error('Detach the original browser before changing this Workroom connection.');
   // Another built-in tab of this Workroom joins its tab set and becomes the tab the AI works in.
   if(!existing.tabs.some(p=>p.id===r.pageId)){if(existing.owner!=='human')throw new Error('Take control before choosing another tab.');existing.tabs.push(pageOf(r.pageId));existing.page=existing.tabs.at(-1);}
   return {success:true,workspace:copy(existing)};
  }
  const page=pageOf(r.pageId),workspace={id:'owned_'+n,sessionId:r.sessionId,targetId:r.targetId,profileId,profileName:'Chromium',source:'owned',page,tabs:[page],owner:'human',epoch:1,observation:null,connection:'connected',profileVerification:'user-confirmed'};
  spaces.set(workspace.id,workspace);return {success:true,workspace:copy(workspace)};}
 if(r.operation==='detach'){broker.detaches.push(r.workspaceId);spaces.delete(r.workspaceId);return {success:true};}
 const w=spaces.get(r.workspaceId);
 if(w&&r.operation==='release'){broker.releases.push(r.pageId);if(w.owner!=='human')throw new Error("Take control before changing this Workroom tabs.");w.tabs=w.tabs.filter(p=>p.id!==r.pageId);if(w.page?.id===r.pageId)w.page=w.tabs[0]??null;}
 if(w&&r.operation==='select'){broker.selects.push(r.pageId);if(w.owner!=='human')throw new Error('Take control before choosing another tab.');const known=w.tabs.find(p=>p.id===r.pageId);if(!known)throw new Error('Chrome tab no longer exists.');w.page=known;}
 const reply={success:true,workspace:copy(w)};
 if(r.operation==='select'&&broker.holdSelectPage===r.pageId)return await new Promise(resolve=>broker.selectWaiters.push({reply,resolve})).then(reply=>{broker.selectDelivered++;return reply;});
 return reply;
};
import '/src/index.css';const {WorkroomBrowserFrame}=await import('/src/WorkroomBrowserFrame.tsx');
// Like AiTerminalPanel, the frame is keyed by session: showing another Workroom and coming back remounts it.
function Fixture(){const [session,setSession]=React.useState('session_own');return React.createElement('main',null,
 React.createElement('select',{'aria-label':'Test session',value:session,onChange:e=>setSession(e.target.value)},React.createElement('option',{value:'session_own'},'own'),React.createElement('option',{value:'session_other'},'other')),
 React.createElement(WorkroomBrowserFrame,{key:session,sessionId:session,targetId:'project_own',visible:true,onDraft:()=>{},request},React.createElement('p',null,'Retained terminal fixture')));}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Fixture));
</script>`;
 try{for(const [name,engine] of Object.entries({chromium,webkit})){
  const browser=await engine.launch({headless:true});try{
   const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();if(url.pathname==='/__owned-requests')return route.fulfill({contentType:'text/html',body:html});return route.continue();});
   const state=()=>page.evaluate(()=>({navigations:window.native.navigations,ops:window.native.ops.filter(o=>o.operation==='open'||o.operation==='close'),connects:window.broker.connects.map(({recoveryId,sessionId})=>recoveryId?{sessionId,recoveryId}:{sessionId}),detaches:window.broker.detaches}));
   // Controls are found by data-testid and state is read from data attributes (data-page-url, data-recovery), never by
   // their wording; one smoke assertion below checks that the Korean address label still names the field.
   const stage=()=>page.evaluate(()=>document.querySelector('[data-testid=owned-browser-stage]')?.getAttribute('data-stage')??null);
   const panel=()=>page.getByTestId('workroom-browser-panel');
   const show=async()=>{await page.getByTestId('workroom-browser-toggle').click();await page.getByTestId('owned-workroom-browser').waitFor();await page.waitForFunction(()=>!document.querySelector('[data-testid=owned-browser-open]')?.disabled);};
   const reload=async()=>{await page.goto(`${origin}/__owned-requests`);await show();};
   const openAddress=async address=>{await page.getByTestId('owned-browser-address').fill(address);await page.getByTestId('owned-browser-open').click();};
   // The page the Workroom's browser is connected to, as the panel exposes it.
   const connectedTo=address=>page.waitForFunction(text=>document.querySelector('[data-testid=workroom-browser-panel]')?.getAttribute('data-page-url')===text,address,{timeout:5000});
   const chooseSaved=async id=>{const recover=page.locator(`[data-testid=workroom-browser-recover][data-recovery-id="${id}"]`);await recover.waitFor({state:'attached'});
    if(!await recover.isVisible())await page.getByTestId('workroom-browser-recoveries-toggle').click();
    await recover.click();await page.locator(`[data-testid=workroom-browser-panel][data-recovery="${id}"]`).waitFor();};
   // The stage a request ended in must go away by itself, with the controls usable again.
   const ended=async label=>{await page.waitForFunction(()=>!document.querySelector('[data-testid=owned-browser-stage]'),undefined,{timeout:3000}).catch(async()=>{throw new Error(`${name}: ${label}: the request stayed in stage ${await stage()} with its controls disabled`);});
    assert.equal(await page.getByTestId('owned-browser-address').isEditable(),true,`${name}: ${label}: the address field is usable again`);};
   const switchAway=async()=>{await page.getByLabel('Test session').selectOption('session_other');await page.getByLabel('Test session').selectOption('session_own');await show();};
   const ownProfile=()=>page.getByTestId('workroom-browser-source-owned').click();
   // K1: 브라우저 종료 lives in the bar's ⋯ menu and asks first, inline in the bar, because it closes every tab.
   const closeBrowser=async()=>{await page.getByTestId('workroom-browser-menu').click();await page.getByTestId('owned-browser-close').click();await page.locator('[data-testid=workroom-browser-close-confirm],[data-testid=workroom-browser-close-all-confirm]').click();};
   const terminalView=()=>page.getByTestId('workroom-browser-view-terminal').click();
   const tabCloses=()=>page.getByTestId('owned-browser-tab-close');
   // OWNED_SCENARIOS=2,3 runs only those scenarios (a debugging aid; the check runs all of them).
   const only=process.env.OWNED_SCENARIOS?.split(','),run=n=>!only||only.includes(String(n));let s;
   try{
    // 1. A saved task chosen, then this Workroom's own profile chosen while the first is still preparing. The previous
    //    request in this mount used that same own profile, which must not make the new request look unchanged.
    if(run(1)){
    await reload();
    // Smoke: the Korean label still names the address field the testids find.
    assert.equal(await page.getByLabel('주소 또는 검색어',{exact:true}).getAttribute('data-testid'),'owned-browser-address',`${name}: the address field keeps its Korean label`);
    await openAddress('https://example.com/own-first');await connectedTo('https://example.com/own-first');
    await closeBrowser();await page.waitForFunction(()=>window.native.tabs('session_own').every(t=>t.closed)&&window.broker.spaces.size===0);
    await page.getByTestId('workroom-browser-recoveries').waitFor();
    await chooseSaved('saved_a');await page.evaluate(()=>{window.native.holdOpen=true;});await openAddress('https://example.com/saved');
    await page.waitForFunction(()=>document.querySelector('[data-testid=owned-browser-stage]')?.getAttribute('data-stage')==='profile');
    await ownProfile();const savedOpens=async()=>(await state()).ops.filter(o=>o.operation==='open'&&o.profileKey==='profile_saved').length,openedBefore=await savedOpens();
    await ended('own profile chosen while a saved profile prepares');
    await page.evaluate(()=>{window.native.holdOpen=false;});await page.waitForTimeout(400);
    assert.equal(await savedOpens(),openedBefore,`${name}: the ended request sends no further open for its profile`);
    s=await state();assert.equal(s.navigations.length,1,`${name}: the ended request never navigated`);assert.equal(s.connects.length,1,`${name}: the ended request never connected`);
    await openAddress('https://example.com/own-again');await connectedTo('https://example.com/own-again');
    s=await state();assert.deepEqual(s.navigations.at(-1),{sessionId:'session_own',profileKey:'session_own',url:'https://example.com/own-again'});assert.deepEqual(s.connects.at(-1),{sessionId:'session_own'});
    checks.push(`${name}: choosing this Workroom's own profile while a saved profile prepares ends that request at once; the next request opens the own profile`);
    }

    // 2. A restored saved task, connected: a new address navigates that page and connects nothing new, also after
    //    another Workroom was shown. Detached, the next page without a saved task is this Workroom's own, not the
    //    saved profile left on screen — by the built-in source choice and after another Workroom was shown alike.
    if(run(2)){
    await reload();await chooseSaved('saved_a');await openAddress('https://example.com/saved');await connectedTo('https://example.com/saved');
    s=await state();assert.deepEqual(s.navigations.at(-1),{sessionId:'session_own',profileKey:'profile_saved',url:'https://example.com/saved'});assert.deepEqual(s.connects.at(-1),{sessionId:'session_own',recoveryId:'saved_a'});
    await switchAway();await openAddress('https://example.com/saved-next');await page.waitForFunction(()=>window.native.navigations.length===2);await ended('navigating the connected page');
    s=await state();assert.deepEqual(s.navigations.at(-1),{sessionId:'session_own',profileKey:'profile_saved',url:'https://example.com/saved-next'});assert.equal(s.connects.length,1,`${name}: the connected page navigated without another connect`);
    for(const how of ['the built-in source choice','another Workroom']){
     const detach=async()=>{await page.getByTestId('workroom-browser-detach').click();await page.getByTestId('workroom-browser-recoveries').waitFor();};
     if(how==='another Workroom'){await detach();await chooseSaved('saved_a');await openAddress('https://example.com/saved-again');await connectedTo('https://example.com/saved-again');}
     await detach();
     if(how==='another Workroom')await switchAway();else await ownProfile();
     const address=`https://example.com/own-after-${how==='another Workroom'?'switch':'choice'}`;await openAddress(address);await connectedTo(address);
     s=await state();
     assert.deepEqual(s.navigations.at(-1),{sessionId:'session_own',profileKey:'session_own',url:address},`${name}: after detaching (${how}), a page without a saved task opens in this Workroom's own profile`);
     assert.deepEqual(s.connects.at(-1),{sessionId:'session_own'});assert.deepEqual(s.ops.slice(-2).map(o=>o.operation+':'+o.profileKey),['close:undefined','open:session_own']);
    }
    checks.push(`${name}: a connected saved page keeps its profile for new addresses; once detached, a page without a saved task runs and is connected as this Workroom's own profile`);
    }

    // 3. Two saved tasks of one profile: choosing the second while the first is connecting ends the first request.
    //    Its late connect is detached, never attached under the second task's choice; the second then connects as itself.
    if(run(3)){
    await reload();await chooseSaved('saved_a');await page.evaluate(()=>{window.broker.hold=new Promise(r=>{window.releaseConnect=r;});});
    await openAddress('https://example.com/saved-a');await page.waitForFunction(()=>document.querySelector('[data-testid=owned-browser-stage]')?.getAttribute('data-stage')==='connecting');
    await chooseSaved('saved_b');await ended('another saved task of the same profile chosen while connecting');
    await page.evaluate(()=>{window.broker.hold=null;window.releaseConnect();});await page.waitForFunction(()=>window.broker.detaches.includes('owned_1'));
    assert.equal(await panel().getAttribute('data-page-url'),'',`${name}: the first task's late connect is not attached`);
    await openAddress('https://example.com/saved-b');await connectedTo('https://example.com/saved-b');
    s=await state();assert.deepEqual(s.connects,[{sessionId:'session_own',recoveryId:'saved_a'},{sessionId:'session_own',recoveryId:'saved_b'}]);
    checks.push(`${name}: choosing another saved task of the same profile mid-connect ends that request, detaches its late connect and connects the new choice as itself`);
    }
    // 4. A saved task's connect fails, then this Workroom's own profile is chosen: the failed request's connect is
    //    withdrawn, so no retry is offered and collapsing and expanding the browser connects nothing as the saved task.
    if(run(4)){
    await reload();await chooseSaved('saved_a');await page.evaluate(()=>{window.broker.fail=true;});await openAddress('https://example.com/saved-fail');
    await page.locator('[role=alert][data-failure=connect]').waitFor();await page.getByTestId('owned-browser-retry-connect').waitFor();
    await ownProfile();
    assert.equal(await page.getByTestId('owned-browser-retry-connect').count(),0,`${name}: choosing the own profile withdraws the failed saved task's connect`);
    await terminalView();await page.getByTestId('owned-workroom-browser').waitFor({state:'detached'});await show();await page.waitForTimeout(600);
    s=await state();assert.deepEqual(s.connects,[{sessionId:'session_own',recoveryId:'saved_a'}],`${name}: expanding again connects nothing as the saved task`);
    await openAddress('https://example.com/own-after-failure');await connectedTo('https://example.com/own-after-failure');
    s=await state();assert.deepEqual(s.navigations.at(-1),{sessionId:'session_own',profileKey:'session_own',url:'https://example.com/own-after-failure'});assert.deepEqual(s.connects.at(-1),{sessionId:'session_own'});
    checks.push(`${name}: after a saved task's connect fails, choosing the own profile withdraws it; collapsing and expanding connects nothing as that task`);
    }
    // 5. A Workroom's own tabs. A second tab collapsed mid-connect: its late connect leaves only its own page — the
    //    Workroom's binding and first tab stay — and expanding again finishes only that tab's connect, without navigating
    //    again. The page on screen follows the tab the AI switched to; a person's tab choice and closing a tab go through
    //    the broker, and another Workroom never shows these tabs.
    if(run(5)){
    await reload();await openAddress('https://example.com/tab-main');await connectedTo('https://example.com/tab-main');
    const tabButtons=()=>page.getByTestId('owned-browser-tab');
    const space=()=>page.evaluate(()=>{const w=[...window.broker.spaces.values()][0];return w&&{id:w.id,page:w.page?.id,tabs:w.tabs.map(p=>p.id),owner:w.owner};});
    const shownTab=()=>page.evaluate(()=>document.querySelector('[data-testid=owned-browser-slot]')?.getAttribute('data-tab'));
    const framed=()=>page.evaluate(()=>window.native.ops.filter(o=>o.operation==='frame').at(-1)?.tab??'main');
    const first=await space();assert.equal(first.tabs.length,1);
    await page.getByTestId('owned-browser-new-tab').click();await page.waitForFunction(()=>document.querySelectorAll('[data-testid=owned-browser-tab]').length===2&&document.querySelector('[data-testid=owned-browser-slot]')?.getAttribute('data-tab')!=='main'&&!document.querySelector('[data-testid=owned-browser-stage]'));
    const second=await tabButtons().nth(1).getAttribute('data-tab');assert.notEqual(second,'main');assert.equal(await shownTab(),second,`${name}: the new tab is on screen`);
    await page.evaluate(()=>{window.broker.hold=new Promise(r=>{window.releaseConnect=r;});});
    await openAddress('https://example.com/tab-two');await page.waitForFunction(()=>document.querySelector('[data-testid=owned-browser-stage]')?.getAttribute('data-stage')==='connecting');
    await terminalView();await page.getByTestId('owned-workroom-browser').waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>window.native.tabNavigations.length),2,`${name}: the second tab's navigation was accepted before it collapsed`);
    await page.evaluate(()=>{window.broker.hold=null;window.releaseConnect();});await page.waitForFunction(()=>window.broker.releases.length===1);
    s=await state();assert.deepEqual(s.detaches,[],`${name}: a second tab's late connect never detaches the Workroom's binding`);
    let w=await space();assert.equal(w.id,first.id);assert.deepEqual(w.tabs,[first.page],`${name}: the late connect left only its own page`);
    await show();await page.waitForFunction(id=>[...window.broker.spaces.values()][0]?.tabs.length===2,first.id,{timeout:5000});
    w=await space();const twoTarget=w.page;assert.notEqual(twoTarget,first.page);
    const tabNavigations=await page.evaluate(()=>window.native.tabNavigations);
    assert.deepEqual(tabNavigations.map(n=>n.tab+':'+n.url),['main:https://example.com/tab-main',`${second}:https://example.com/tab-two`],`${name}: expanding again finished only that tab's connect, without navigating again`);
    assert.equal((await state()).connects.length,3);await page.waitForFunction(tab=>document.querySelector('[data-testid=owned-browser-slot]')?.getAttribute('data-tab')===tab,second);
    // The AI switches to the first tab: the page on screen follows, and the person cannot pick tabs while it works.
    await page.evaluate(([id,target])=>{const w=window.broker.spaces.get(id);w.owner='agent';w.page=w.tabs.find(p=>p.id===target);},[first.id,first.page]);
    await page.waitForFunction(()=>document.querySelector('[data-testid=owned-browser-slot]')?.getAttribute('data-tab')==='main',undefined,{timeout:5000});
    await page.waitForFunction(()=>window.native.ops.filter(o=>o.operation==='frame').at(-1)?.tab==='main');assert.equal(await framed(),'main');
    assert.equal(await tabButtons().nth(1).isDisabled(),true,`${name}: tabs cannot be chosen while the AI holds the browser`);
    // Back with the person: choosing the second tab makes it the AI's tab through the broker; closing it releases it first.
    await page.evaluate(id=>{window.broker.spaces.get(id).owner='human';},first.id);await page.waitForFunction(()=>!document.querySelectorAll('[data-testid=owned-browser-tab]')[1]?.disabled,undefined,{timeout:5000});
    await tabButtons().nth(1).click();await page.waitForFunction(()=>window.broker.selects.length===1);
    assert.deepEqual(await page.evaluate(()=>window.broker.selects),[twoTarget]);assert.equal((await space()).page,twoTarget);assert.equal(await shownTab(),second);
    await tabCloses().nth(1).click();await page.waitForFunction(()=>document.querySelectorAll('[data-testid=owned-browser-tab]').length===1);
    w=await space();assert.deepEqual(w.tabs,[first.page]);assert.equal(w.page,first.page);assert.deepEqual(await page.evaluate(()=>window.broker.releases),[twoTarget,twoTarget]);
    assert.deepEqual(await page.evaluate(tab=>window.native.ops.filter(o=>o.operation==='close').map(o=>o.tab??'all'),second),[second],`${name}: only that tab's page closed`);
    assert.equal(await shownTab(),'main');assert.deepEqual((await state()).detaches,[]);
    // Each tab keeps its own pending connect: a third tab's failed connect is still finished on expanding, after the
    // person used the first tab in between.
    await page.getByTestId('owned-browser-new-tab').click();await page.waitForFunction(()=>document.querySelectorAll('[data-testid=owned-browser-tab]').length===2&&document.querySelector('[data-testid=owned-browser-slot]')?.getAttribute('data-tab')!=='main'&&!document.querySelector('[data-testid=owned-browser-stage]'));
    const third=await tabButtons().nth(1).getAttribute('data-tab');await page.evaluate(()=>{window.broker.fail=true;});
    await openAddress('https://example.com/tab-three');await page.getByTestId('workroom-browser-control').locator('[role=alert]').waitFor();await page.getByTestId('owned-browser-retry-connect').waitFor();
    await tabButtons().nth(0).click();assert.equal(await shownTab(),'main');await openAddress('https://example.com/tab-main-again');
    await page.waitForFunction(()=>window.native.tabNavigations.length===4);await ended('navigating the first tab');assert.equal((await space()).tabs.length,1);
    await terminalView();await page.getByTestId('owned-workroom-browser').waitFor({state:'detached'});await show();
    await page.waitForFunction(()=>[...window.broker.spaces.values()][0]?.tabs.length===2,undefined,{timeout:5000}).catch(()=>{throw new Error(`${name}: expanding again did not finish the third tab's connect`);});
    await page.waitForFunction(tab=>document.querySelector('[data-testid=owned-browser-slot]')?.getAttribute('data-tab')===tab,third);
    assert.deepEqual((await page.evaluate(()=>window.native.tabNavigations)).slice(2).map(n=>n.tab+':'+n.url),[`${third}:https://example.com/tab-three`,'main:https://example.com/tab-main-again'],`${name}: finishing the third tab's connect navigated nothing again`);
    assert.deepEqual((await state()).detaches,[]);
    await page.getByLabel('Test session').selectOption('session_other');await show();
    assert.equal(await page.getByTestId('owned-browser-tab').count(),0,`${name}: another Workroom shows none of these tabs`);
    assert.equal(await page.evaluate(()=>window.native.tabs('session_other').filter(t=>!t.closed).length),0,`${name}: another Workroom has no open native page`);
    await page.getByTestId('workroom-browser-recoveries').waitFor();
    checks.push(`${name}: a second built-in tab collapsed mid-connect leaves only its own page and finishes only its own connect when expanded; the screen follows the AI's tab, and choosing or closing a tab goes through the Workroom's own set`);
    }
    // 6. A built-in Workroom restored from a saved task, after another Workroom was shown (the panel forgot the saved-task
    //    choice): a new tab opens in the restored profile and joins the same tab set, connected as that profile.
    if(run(6)){
    await reload();await chooseSaved('saved_a');await openAddress('https://example.com/saved-first');await connectedTo('https://example.com/saved-first');
    await switchAway();
    await page.getByTestId('owned-browser-new-tab').click();await page.waitForFunction(()=>document.querySelectorAll('[data-testid=owned-browser-tab]').length===2&&document.querySelector('[data-testid=owned-browser-slot]')?.getAttribute('data-tab')!=='main'&&!document.querySelector('[data-testid=owned-browser-stage]'));
    await openAddress('https://example.com/saved-second');
    await page.waitForFunction(()=>[...window.broker.spaces.values()][0]?.tabs.length===2,undefined,{timeout:5000}).catch(async()=>{throw new Error(`${name}: the restored Workroom's new tab did not join its set: ${await page.locator('[role=alert]').allTextContents()}`);});
    await ended('a new tab of a restored Workroom');assert.equal(await page.locator('[role=alert]').count(),0,`${name}: no error after the new tab joined`);
    const joined=await page.evaluate(()=>window.broker.connects.at(-1));assert.deepEqual([joined.recoveryId,joined.profileKey],[undefined,'profile_saved'],`${name}: the new tab connects as the restored profile`);
    assert.equal((await state()).ops.filter(o=>o.operation==='open').at(-1).profileKey,'profile_saved');assert.deepEqual((await state()).detaches,[]);
    assert.equal([...await page.evaluate(()=>[...window.broker.spaces.values()].map(w=>w.profileId))].join(),'owned:profile_saved');
    checks.push(`${name}: a new tab of a built-in Workroom restored from a saved task joins its tab set in the restored profile, also after another Workroom was shown`);
    }
    // 7. One tab closed with ×, its native close still finishing, while the person opens an address in another tab: only
    //    the closed tab goes away. The address opens in the tab on screen; the third tab and the connection stay.
    if(run(7)){
    await reload();await openAddress('https://example.com/close-main');await connectedTo('https://example.com/close-main');
    const tabButtons=()=>page.getByTestId('owned-browser-tab');
    const addTab=async address=>{const before=await tabButtons().count();await page.getByTestId('owned-browser-new-tab').click();
     await page.waitForFunction(n=>document.querySelectorAll('[data-testid=owned-browser-tab]').length===n&&!document.querySelector('[data-testid=owned-browser-stage]'),Math.max(2,before+1));
     await openAddress(address);await page.waitForFunction(n=>[...window.broker.spaces.values()][0]?.tabs.length===n,Math.max(2,before+1),{timeout:5000});await ended('opening '+address);};
    await addTab('https://example.com/close-two');await addTab('https://example.com/close-three');
    const [,second,third]=await tabButtons().evaluateAll(els=>els.map(e=>e.getAttribute('data-tab')));
    await page.evaluate(()=>{window.native.holdClosing=true;});const closesBefore=(await state()).ops.filter(o=>o.operation==='close').length;
    await tabCloses().nth(1).click();
    await page.waitForFunction(()=>document.querySelectorAll('[data-testid=owned-browser-tab]').length===2&&!document.querySelector('[data-testid=owned-browser-stage]'));
    assert.equal(await page.evaluate(t=>window.native.tabs('session_own').find(x=>x.tab===t)?.closing,second),true,`${name}: the closed tab is still closing natively`);
    await tabButtons().nth(0).click();await page.waitForFunction(()=>document.querySelector('[data-testid=owned-browser-slot]')?.getAttribute('data-tab')==='main');
    await openAddress('https://example.com/close-main-again');
    await page.waitForFunction(()=>window.native.tabNavigations.some(n=>n.url==='https://example.com/close-main-again'),undefined,{timeout:5000}).catch(async()=>{throw new Error(`${name}: the address never opened while a sibling tab was closing: ${await page.locator('[role=alert]').allTextContents()}`);});
    await ended('opening an address while a sibling tab closes');
    assert.deepEqual((await state()).ops.filter(o=>o.operation==='close').slice(closesBefore).map(o=>o.tab??'all'),[second],`${name}: only the closed tab was closed`);
    assert.deepEqual((await page.evaluate(()=>window.native.tabNavigations.at(-1))),{sessionId:'session_own',tab:'main',url:'https://example.com/close-main-again'});
    const live=await page.evaluate(()=>window.native.tabs('session_own').filter(x=>!x.closed&&!x.closing).map(x=>x.tab));assert.deepEqual(live,['main',third],`${name}: the first and third tabs stay open`);
    assert.equal((await page.evaluate(()=>[...window.broker.spaces.values()][0].tabs.length)),2);assert.deepEqual((await state()).detaches,[]);
    await page.evaluate(()=>{window.native.holdClosing=false;window.native.finishClosing();});
    checks.push(`${name}: opening an address while another tab is still closing closes only that tab; the other tabs and the connection stay`);
    }
    // 8. K1 · the browser bar and its tab strip. One 36px bar row over one 32px tab row with six tabs at 900, 1280 and
    //    1512; no visible address label and no navigation group while native reports no support; the first focus selects
    //    the address and Escape restores it and leaves the field; a tab's close is a lucide X named 「탭 닫기: {name}」 and
    //    never carries data-tab; the ⋯ menu and the close-all question are dismissed without closing anything.
    if(run(8)){
    await reload();
    assert.equal(await page.locator('[data-testid=owned-workroom-browser] label').count(),0,`${name}: the address field has no visible label`);
    assert.equal(await page.getByTestId('owned-browser-address').getAttribute('placeholder'),'주소 입력 또는 검색',`${name}: smoke: the field says what it takes as a placeholder`);
    assert.equal(await page.getByTestId('workroom-browser-back').count(),0,`${name}: no navigation group while native reports no back/forward support`);
    await openAddress('https://example.com/bar-1');await connectedTo('https://example.com/bar-1');
    for(let n=2;n<=6;n++){
     await page.getByTestId('owned-browser-new-tab').click();await page.waitForFunction(n=>document.querySelectorAll('[data-testid=owned-browser-tab]').length===n&&!document.querySelector('[data-testid=owned-browser-stage]'),n);
     await openAddress(`https://example.com/bar-${n}`);await page.waitForFunction(n=>[...window.broker.spaces.values()][0]?.tabs.length===n,n,{timeout:5000});await ended(`opening tab ${n}`);}
    assert.equal(await page.getByTestId('owned-browser-new-tab').isDisabled(),true,`${name}: no seventh tab`);
    const rows=()=>page.evaluate(()=>{const bar=document.querySelector('[data-testid=workroom-browser-bar]'),strip=document.querySelector('[data-testid=owned-browser-tabs]'),b=bar.getBoundingClientRect(),s=strip.getBoundingClientRect();
     // Icons, the owner pill and the address have different heights in the same centred row.
     const rows=list=>[...new Set([...list].map(e=>{const r=e.getBoundingClientRect();return Math.round(r.top+r.height/2);} ))];
     return {bar:b.height,strip:s.height,barRows:rows([...bar.children].filter(e=>getComputedStyle(e).position!=='absolute')),tabRows:rows(strip.querySelectorAll('[role=tab]')),above:s.bottom<=b.top+1};});
    for(const width of [900,1280,1512]){
     await page.setViewportSize({width,height:900});await page.waitForTimeout(100);const m=await rows();
     assert.equal(m.bar,36,`${name}: at ${width}px the bar is 36px (${m.bar})`);assert.equal(m.barRows.length,1,`${name}: at ${width}px the bar is one row (${m.barRows})`);
     assert.equal(m.strip,32,`${name}: at ${width}px the tab strip is 32px (${m.strip})`);assert.equal(m.tabRows.length,1,`${name}: at ${width}px six tabs stay in one row (${m.tabRows})`);
     assert(m.above,`${name}: at ${width}px the tabs sit above the bar`);}
    await page.setViewportSize({width:1280,height:900});
    const address=page.getByTestId('owned-browser-address'),before=await address.inputValue();
    await address.click();assert.deepEqual(await address.evaluate(e=>[e.selectionStart,e.selectionEnd]),[0,before.length],`${name}: the first focus selects the whole address`);
    await page.keyboard.type('typed but never opened');await page.keyboard.press('Escape');
    assert.equal(await address.inputValue(),before,`${name}: Escape restores the address`);assert.equal(await address.evaluate(e=>document.activeElement===e),false,`${name}: Escape leaves the field`);
    assert.equal(await page.getByTestId('workroom-browser-panel').count(),1);
    const tab=page.getByTestId('owned-browser-tab').first(),close=page.getByTestId('owned-browser-tab-close').first(),tabName=(await tab.getAttribute('title')).split('\n')[0];
    assert.equal(await close.getAttribute('aria-label'),`탭 닫기: ${tabName}`,`${name}: the close names its tab`);
    assert.equal(await close.locator('svg.lucide-x').count(),1,`${name}: the close is a lucide X, not a × glyph`);
    assert.equal(await page.locator('[data-testid=owned-browser-tab-close][data-tab]').count(),0,`${name}: no close button carries data-tab`);
    await tab.focus();await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('data-tab')),await page.getByTestId('owned-browser-tab').nth(1).getAttribute('data-tab'),`${name}: arrow keys move between tabs`);
    await page.getByTestId('workroom-browser-menu').click();await page.getByRole('menu').waitFor();await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('menu').count(),0,`${name}: Escape closes the menu`);
    await page.getByTestId('workroom-browser-menu').click();await page.getByTestId('owned-browser-close').click();
    await page.locator('[data-testid=workroom-browser-close-cancel],[data-testid=workroom-browser-close-all-cancel]').click();
    assert.equal(await page.locator('[data-testid=workroom-browser-close-confirm],[data-testid=workroom-browser-close-all-confirm]').count(),0);assert.equal(await page.getByTestId('owned-browser-tab').count(),6,`${name}: cancelling the question closes nothing`);
    assert.deepEqual((await state()).detaches,[]);
    checks.push(`${name}: the browser bar is one 36px row over one 32px row of six tabs at 900, 1280 and 1512; Escape restores the address, the first focus selects it, and closing every tab asks first`);
    }
    // 9. The first accepted navigation is still about:blank in both startup discovery and the address poll. Those
    //    delayed native replies must keep the normalized human address; real document URLs still follow afterwards.
    if(run(9)){
    await reload();await page.evaluate(()=>{window.native.holdDocument=true;window.native.holdStatus=true;});
    const normalized='https://example.com/first-cold',redirected='https://example.com/first-redirected?ready=1';
    await openAddress('example.com/first-cold');
    await page.waitForFunction(()=>window.native.navigations.length===1&&window.native.statusWaiters.length>=2);
    const snapshots=await page.evaluate(()=>window.native.statusWaiters.map(({reply})=>({url:reply.url,loading:reply.loading})));
    assert(snapshots.every(s=>s.url==='about:blank'&&s.loading),`${name}: deferred startup and poll replies precede the first committed document`);
    await page.getByTestId('owned-browser-address').evaluate(e=>e.blur());
    assert.equal(await page.getByTestId('owned-browser-address').evaluate(e=>document.activeElement===e),false,`${name}: this regression exercises the unfocused address sync path`);
    assert.equal(await page.getByTestId('owned-browser-address').inputValue(),normalized,`${name}: acceptance normalizes the first address`);
    await page.evaluate(()=>window.native.releaseStatus());
    await page.waitForFunction(()=>window.native.deliveredStatus>=2&&document.querySelector('[data-testid=owned-browser-stage]')?.getAttribute('data-stage')==='loading');
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.getByTestId('owned-browser-address').inputValue(),normalized,`${name}: late about:blank replies cannot erase the accepted first address`);
    assert.equal((await state()).connects.length,0,`${name}: the blank document has not connected`);
    await page.evaluate(url=>{window.native.holdDocument=false;window.native.commitDocument('session_own',url);},normalized);
    await connectedTo(normalized);await ended('the first document committed after delayed blank status');
    await page.evaluate(url=>window.native.commitDocument('session_own',url),redirected);
    await page.waitForFunction(url=>document.querySelector('[data-testid=owned-browser-address]')?.value===url,redirected,{timeout:5000});
    s=await state();assert.deepEqual(s.navigations,[{sessionId:'session_own',profileKey:'session_own',url:normalized}],`${name}: document completion and redirect never repeat the accepted navigation`);
    assert.equal(s.connects.length,1,`${name}: the first document connects once`);
    checks.push(`${name}: delayed about:blank status preserves the normalized first address while loading; committed documents and redirects still update it without another navigation`);
    }
    // 10. A closed page is no longer an omnibox baseline, nor is it the baseline of a new blank tab. The same URL
    //     must offer Open again. Before a selected tab's next native status arrives, Escape restores that tab's URL.
    if(run(10)){
    await reload();await chooseSaved('saved_a');
    const same='https://example.com/reopen-same',other='https://example.com/other-tab',address=page.getByTestId('owned-browser-address'),tabButtons=()=>page.getByTestId('owned-browser-tab');
    await openAddress(same);await connectedTo(same);await ended('opening the saved page before close');
    await page.evaluate(()=>{window.native.holdClosing=true;});await closeBrowser();
    await page.waitForFunction(()=>window.broker.spaces.size===0&&window.native.tabs('session_own').some(t=>t.closing)&&!document.querySelector('[data-testid=owned-browser-stage]'));
    assert.equal(await address.inputValue(),'',`${name}: closing clears the address of the closed page`);
    await address.fill(same);assert.equal(await page.getByTestId('owned-browser-open').isEnabled(),true,`${name}: the same saved URL offers Open after closing`);
    await page.getByTestId('owned-browser-open').click();
    await page.waitForFunction(()=>document.querySelector('[data-testid=owned-browser-stage]')?.getAttribute('data-stage')==='profile');
    await page.evaluate(()=>{window.native.holdClosing=false;window.native.finishClosing();});await connectedTo(same);await ended('reopening the same saved URL after slow close');
    assert.equal((await state()).navigations.length,2,`${name}: the same saved URL actually navigates again`);
    await page.waitForFunction(url=>document.querySelector('[data-testid=owned-workroom-browser]')?.getAttribute('data-page-url')===url,same,{timeout:5000});
    await page.evaluate(()=>{window.native.holdStatus=true;});await page.getByTestId('owned-browser-new-tab').click();
    await page.waitForFunction(()=>{const tab=document.querySelector('[data-testid=owned-browser-slot]')?.getAttribute('data-tab');return document.querySelectorAll('[data-testid=owned-browser-tab]').length===2&&tab!=='main'&&!document.querySelector('[data-testid=owned-browser-stage]')&&window.native.statusWaiters.some(({reply})=>reply.tab===tab);});
    const second=await tabButtons().nth(1).getAttribute('data-tab');assert.equal(await address.inputValue(),'',`${name}: a new blank tab starts with an empty address`);
    await address.fill(same);assert.equal(await page.getByTestId('owned-browser-open').isEnabled(),true,`${name}: the old tab's URL offers Open in a new blank tab`);
    await page.getByTestId('owned-browser-open').click();await page.waitForFunction(()=>window.native.navigations.length===3);
    await page.evaluate(()=>window.native.releaseStatus());
    await page.waitForFunction(()=>[...window.broker.spaces.values()][0]?.tabs.length===2,undefined,{timeout:5000});await ended('opening the same URL in a new blank tab');
    assert.deepEqual(await page.evaluate(()=>window.native.tabNavigations.at(-1)),{sessionId:'session_own',tab:second,url:same});
    await openAddress(other);await page.waitForFunction(()=>window.native.navigations.length===4);await ended('giving the second tab a different address');
    await page.waitForFunction(url=>document.querySelector('[data-testid=owned-workroom-browser]')?.getAttribute('data-page-url')===url,other,{timeout:5000});
    await page.evaluate(()=>{window.native.holdStatus=true;});
    for(const [index,tab,url] of [[0,'main',same],[1,second,other]]){
     await tabButtons().nth(index).click();
     await page.waitForFunction(tab=>document.querySelector('[data-testid=owned-browser-slot]')?.getAttribute('data-tab')===tab&&window.native.statusWaiters.some(({reply})=>reply.tab===tab),tab);
     await address.fill('edited but never opened');await page.keyboard.press('Escape');
     assert.equal(await address.inputValue(),url,`${name}: Escape immediately after choosing ${tab} restores its own URL before native status returns`);
    }
    await page.evaluate(()=>window.native.releaseStatus());await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await address.inputValue(),other,`${name}: late status from the previous tab cannot change the selected tab's address`);
    s=await state();assert.equal(s.navigations.length,4,`${name}: tab choices and Escape never navigate`);
    assert.deepEqual(s.connects,[{sessionId:'session_own',recoveryId:'saved_a'},{sessionId:'session_own',recoveryId:'saved_a'},{sessionId:'session_own',recoveryId:'saved_a'}],`${name}: reopen and the new tab both keep the saved profile`);
    checks.push(`${name}: a saved URL reopens after slow close and opens in a new blank tab; Escape immediately after a tab choice restores the selected tab's URL despite delayed native status`);
    }
    // 11. A selected tab's host response can arrive after close or after the person chose another tab. Keep both the
    //     native view and the broker on the last choice; an old connected snapshot must not revive a closed Workroom.
    if(run(11)){
    const first='https://example.com/select-first',second='https://example.com/select-second',tabButtons=()=>page.getByTestId('owned-browser-tab');
    const twoTabs=async()=>{
     await reload();await openAddress(first);await connectedTo(first);await ended('opening the first selection tab');
     await page.getByTestId('owned-browser-new-tab').click();await page.waitForFunction(()=>document.querySelectorAll('[data-testid=owned-browser-tab]').length===2&&document.querySelector('[data-testid=owned-browser-slot]')?.getAttribute('data-tab')!=='main'&&!document.querySelector('[data-testid=owned-browser-stage]'));
     await openAddress(second);await page.waitForFunction(()=>[...window.broker.spaces.values()][0]?.tabs.length===2);await ended('opening the second selection tab');
     await tabButtons().first().click();await connectedTo(first);
     return page.evaluate(()=>{const tabs=window.native.tabs('session_own');return {first:tabs.find(t=>t.tab==='main').targetId,second:tabs.find(t=>t.tab!=='main').targetId};});
    };
    let targets=await twoTabs();await page.evaluate(target=>{window.broker.holdSelectPage=target;},targets.second);
    await tabButtons().nth(1).click();await page.waitForFunction(()=>window.broker.selectWaiters.length===1);
    await closeBrowser();await page.waitForFunction(()=>window.broker.spaces.size===0&&window.native.tabs('session_own').every(t=>t.closed)&&document.querySelector('[data-testid=workroom-browser-panel]')?.getAttribute('data-page-url')==='');
    await page.evaluate(()=>window.broker.releaseSelect());await page.waitForFunction(()=>window.broker.selectDelivered===1);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await panel().getAttribute('data-page-url'),'',`${name}: a late selected-tab response cannot revive the closed workspace`);
    assert.equal(await page.getByTestId('workroom-browser-control').count(),0,`${name}: the closed browser has no restored control bar`);
    assert.equal(await tabButtons().count(),0,`${name}: the closed native tabs stay closed after the late response`);
    targets=await twoTabs();await page.evaluate(target=>{window.broker.holdSelectPage=target;},targets.second);
    await tabButtons().nth(1).click();await page.waitForFunction(()=>window.broker.selectWaiters.length===1);
    await tabButtons().first().click();
    await page.waitForFunction(target=>window.broker.selects.at(-1)===target&&[...window.broker.spaces.values()][0]?.page?.id===target,targets.first);
    assert.deepEqual(await page.evaluate(()=>window.broker.selects.slice(-2)),[targets.second,targets.first],`${name}: A is selected on the host even when the previous client snapshot already named A`);
    await connectedTo(first);await page.evaluate(()=>window.broker.releaseSelect());await page.waitForFunction(()=>window.broker.selectDelivered===1);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await panel().getAttribute('data-page-url'),first,`${name}: late B cannot replace the final A selection`);
    assert.equal(await page.getByTestId('owned-browser-slot').getAttribute('data-tab'),'main',`${name}: the native view remains on the final A selection`);
    assert.equal(await page.getByTestId('owned-browser-address').inputValue(),first,`${name}: the final A address stays in the omnibox`);
    assert.equal(await page.evaluate(()=>[...window.broker.spaces.values()][0]?.page?.id),targets.first,`${name}: the broker also remains on A`);
    assert.equal((await state()).navigations.length,2,`${name}: selection races never navigate a page`);
    checks.push(`${name}: late B selection cannot revive a closed workspace; B then A selects A on the host and keeps its native view after B responds late`);
    }
    // 12. Words are submitted through the actual production omnibox form, never an external search page. IME
    //     lifecycle events plus a real Enter verify that confirming composition cannot navigate prematurely.
    if(run(12)){
    const address=page.getByTestId('owned-browser-address');
    // Scenario 12 alone models the real host's CDP document-commit event for an already attached page. Keep the
    // earlier race scenarios' deliberately stale/held snapshots untouched; this hook runs only after native accepts.
    const documentEvents=()=>page.evaluate(()=>{window.native.documentCommitted=reply=>{for(const w of window.broker.spaces.values()){const page=w.tabs.find(p=>p.id===reply.targetId);if(page){page.url=reply.url;w.epoch++;w.observation=null;if(w.page?.id===page.id)w.page=page;}}};});
    for(const {query,method,existing}of[{query:'react hooks',method:'enter',existing:false},{query:'네이버',method:'button',existing:false},{query:'한글 검색',method:'enter',existing:true},{query:'browser search',method:'button',existing:true}]){
     await reload();await documentEvents();if(existing){await openAddress('https://example.com/search-baseline');await connectedTo('https://example.com/search-baseline');await ended('opening the search baseline');}
     const before=(await state()).navigations.length,want='https://www.google.com/search?q='+encodeURIComponent(query);
     await address.fill(query);if(method==='enter')await address.press('Enter');else await page.getByTestId('owned-browser-open').click();
     await page.waitForFunction(want=>window.native.navigations.at(-1)?.url===want&&window.native.tabs('session_own').find(t=>t.tab==='main')?.url===want,want);await connectedTo(want);await ended('searching through '+method);
     assert.equal(await address.inputValue(),want,`${name}: the omnibox retains the normalized submitted search`);
     const sent=(await state()).navigations.slice(before);assert.equal(sent.length,1,`${name}: ${method} sends one search from ${existing?'an existing':'a blank'} page`);assert.equal(sent[0].url,want,`${name}: the native request carries the final Korean/English query`);
    }
    await reload();await documentEvents();await address.fill('日本語 検索');
    await address.evaluate(e=>e.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'日本語'})));
    const beforeIme=(await state()).navigations.length;await address.press('Enter');
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal((await state()).navigations.length,beforeIme,`${name}: Enter inside compositionstart/end confirms the IME without sending a navigation`);
    await address.evaluate(e=>e.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'日本語'})));await address.press('Enter');
    const imeUrl='https://www.google.com/search?q='+encodeURIComponent('日本語 検索');await connectedTo(imeUrl);await ended('search after IME confirmation');
    assert.equal((await state()).navigations.length,beforeIme+1,`${name}: the explicit Enter after composition submits once`);
    checks.push(`${name}: Korean and English searches use Enter and the go button from blank and existing pages; IME confirmation never navigates before the next explicit Enter`);
    }
    assert.deepEqual(errors,[]);
   }catch(e){if(process.env.OWNED_SHOT)await page.screenshot({path:`${process.env.OWNED_SHOT}-${name}.png`}).catch(()=>{});console.error(errors,await state().catch(()=>null));throw e;}
  }finally{await browser.close();}
 }}finally{await vite.close();await new Promise(resolve=>http.close(()=>resolve()));}
 return checks;
}
if(import.meta.main)console.log(JSON.stringify({ok:true,checks:await runOwnedRequestScreens()},null,1));
