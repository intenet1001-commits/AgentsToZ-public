import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {createServer as createHttpServer} from 'node:http';
import {chromium,webkit} from 'playwright';
import {workroomBackgroundResponse} from './fixtures/workroom-runtime-background-mocks.mjs';
/** Production Workroom, real xterm and real CDP host; terminal output is an explicit fixture. */
/** `tabs` (optional) opens, checks and closes one more real Chrome tab for the Workroom's own tab set. */
/**
 * H1: a person has to be able to hit the control they mean. Inside one card, two controls that share a row stay at
 * least 6px apart — the audit found button groups at 2px, which reads as one smeared control and mis-taps on a laptop
 * trackpad. Measured from the real layout, so a changed gap token fails here instead of on someone's screen.
 */
const assertGaps=async(page,testid)=>{
 const tight=await page.getByTestId(testid).evaluate(card=>{
  const boxes=[...card.querySelectorAll('button,input,code')].filter(el=>el.offsetParent!==null)
   .map(el=>({name:el.dataset.testid||el.getAttribute('type')||el.tagName.toLowerCase(),r:el.getBoundingClientRect()}))
   .filter(x=>x.r.width>0&&x.r.height>0);
  const bad=[];
  for(const a of boxes)for(const b of boxes){
   if(a===b)continue;
   const sameRow=a.r.top<b.r.bottom-2&&b.r.top<a.r.bottom-2,gap=b.r.left-a.r.right;
   if(sameRow&&gap>=0&&gap<6)bad.push(`${a.name}→${b.name}: ${gap.toFixed(1)}px`);
  }
  return bad;
 });
 assert.deepEqual(tight,[],`${testid}: adjacent controls closer than 6px`);
};
// A web build has no embedded browser. Its designed unavailable card leads into the same explicit Chrome setup.
const chooseChrome=async page=>{
 const unavailable=page.getByTestId('owned-browser-unavailable');
 if(await unavailable.isVisible())await unavailable.getByTestId('workroom-browser-connect-chrome').click();
 else await page.getByTestId('workroom-browser-source-chrome').click();
};
const detachChrome=async page=>{
 const direct=page.getByTestId('workroom-browser-detach');
 if(await direct.isVisible())return direct.click();
 await page.getByTestId('workroom-browser-menu').click();
 await page.getByTestId('workroom-browser-menu-detach').click();
};
export async function runWorkroomBrowserScreens({host,profile,tabs}){
 // Vite treats port=0 as its default 5173. Own an actual OS-assigned listener
 // instead, so another project's dev server is never a test dependency.
 const http=createHttpServer();
 const vite=await createServer({server:{middlewareMode:true,hmr:{server:http}},configFile:new URL('../vite.config.ts',import.meta.url).pathname});
 http.on('request',vite.middlewares);await new Promise((resolve,reject)=>{http.once('error',reject);http.listen(0,'127.0.0.1',resolve);});
 const origin=`http://127.0.0.1:${http.address().port}`;
 const source=await fetch(`${origin}/src/AiTerminalPanel.tsx`).then(r=>r.text()),main=await fetch(`${origin}/src/main.tsx`).then(r=>r.text());
 const react=source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1],reactDom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];assert(react&&reactDom);
 const session={id:'session_test',targetId:'project_test',agent:'codex',state:'running',createdAt:'2026-10-24T00:00:00Z',exitCode:null,cols:100,rows:28};
 try{for(const [name,engine] of Object.entries({chromium,webkit})){
  const browser=await engine.launch({headless:true});try{
   const page=await browser.newPage({viewport:{width:1280,height:1050}}),errors=[],browserRequests=[],terminalRequests=[],issuedGrants=[],unmocked=[];
   page.on('pageerror',e=>errors.push(e.message));
   const actualSubmits=()=>terminalRequests.filter(r=>r.operation==='input'||r.operation==='start'||r.operation==='submission'&&!['inspect','recent'].includes(r.submission?.phase));
   await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();
    if(url.pathname==='/__browser-workroom')return route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
import '/src/index.css';import '/src/workspaceDesign.css';
const {AiTerminalPanel}=await import('/src/AiTerminalPanel.tsx');
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(AiTerminalPanel,{projects:[{targetId:'project_test',label:'브라우저 검증'}],entry:{nonce:1,targetId:'project_test',sessionId:'session_test'},sessionScope:'browser-test'}));
</script>`});
    if(url.pathname==='/__browser-view-cache')return route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
import '/src/index.css';const {WorkroomBrowserFrame}=await import('/src/WorkroomBrowserFrame.tsx');
const spaces=new Map();const request=async r=>{if(r.operation==='profiles')return {success:true,profiles:[{id:'chrome:fixture',profileName:'Cache profile',accountLabel:null}]};if(r.operation==='recoveries')return {success:true,recoveries:[{id:'saved_browser_task',sessionId:'prior_session',profileId:'chrome:fixture',profileName:'Saved profile',source:'chrome',pageId:null,updatedAt:1792800000000,unknown:0}]};if(r.operation==='connect'){const workspace={id:'cache_'+r.sessionId,sessionId:r.sessionId,targetId:r.targetId,profileId:r.profileId,profileName:'Cache profile',source:'chrome',page:null,owner:'human',epoch:1,observation:null,connection:'connected',profileVerification:'unverified'};spaces.set(workspace.id,workspace);return {success:true,workspace};}return {success:true,workspace:spaces.get(r.workspaceId)};};
function Fixture(){const [index,setIndex]=React.useState(0);return React.createElement('main',null,React.createElement('select',{'aria-label':'Test session',value:index,onChange:e=>setIndex(Number(e.target.value))},...Array.from({length:10},(_,i)=>React.createElement('option',{key:i,value:i},i))),React.createElement(WorkroomBrowserFrame,{sessionId:'cache_session_'+index,targetId:'project_test',visible:true,onDraft:()=>{},request},React.createElement('p',null,'Retained terminal fixture')));}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Fixture));</script>`});
    if(!url.pathname.startsWith('/api/'))return route.continue();
    const body=req.postDataJSON(),background=workroomBackgroundResponse(url.pathname,req.method(),body);
    if(background!==null)return route.fulfill({json:background});
    if(url.pathname==='/api/agent-runtime/workroom-browser'){
     assert.equal(req.method(),'POST');
     assert.ok(body&&typeof body==='object'&&!Array.isArray(body));
     if(['resume','status','grant','take','detach'].includes(body.operation)){
      assert.deepEqual(Object.keys(body).sort(),['operation','workspaceId']);
      assert.equal(typeof body.workspaceId,'string');
     }
     browserRequests.push(body);
     try{
      const result=await host.perform(body);
      if(body.operation==='grant'){
       assert.equal(typeof result.grant,'string');assert.ok(result.grant);
       assert.equal(result.workspace.id,body.workspaceId);
       issuedGrants.push({workspaceId:result.workspace.id,grant:result.grant,epoch:result.workspace.epoch});
      }
      return route.fulfill({json:result});
     }catch(e){return route.fulfill({status:400,json:{success:false,code:'fixture-refused',error:e.message}});}
    }
    if(url.pathname==='/api/agent-runtime/targets')return route.fulfill({json:{targets:[{targetId:'project_test',label:'브라우저 검증'}],complete:true,protocolVersion:'agentstoz-tasks-v2'}});
    if(url.pathname==='/api/agent-runtime/voice-settings'){
     assert.equal(req.method(),'POST');assert.deepEqual(body,{operation:'status'});
     return route.fulfill({json:{supported:true,configured:false,model:'gemini-3.8-live',checkedAt:null,checkedModel:null}});
    }
    if(url.pathname==='/api/agent-runtime/terminals/access'){
     assert.equal(req.method(),'POST');assert.deepEqual(body,{});return route.fulfill({json:{connections:[]}});
    }
    if(url.pathname==='/api/agent-runtime/terminals/memory'){
     assert.equal(req.method(),'POST');assert.ok(Object.keys(body).every(key=>['offset','observationTargetId'].includes(key)));
     assert.equal(body.offset,0);return route.fulfill({json:{jobs:[]}});
    }
    if(url.pathname==='/api/ai-usage/codex'){
     assert.equal(req.method(),'GET');return route.fulfill({json:{rateLimits:null}});
    }
    if(url.pathname==='/api/agent-runtime/terminals'){const r=body;
     assert.equal(req.method(),'POST');terminalRequests.push(r);
     if(r.operation==='list')return route.fulfill({json:{sessions:[session]}});
     if(r.operation==='read')return route.fulfill({json:{session,chunks:r.after===0?[{seq:1,text:'\x1b[H\x1b[2JWORKROOM_BROWSER_TERMINAL_OK\r\n'}]:[],nextCursor:1,hasMore:false,truncated:false}});
     if(r.operation==='accounts')return route.fulfill({json:{accounts:{agent:'codex',selectedAccountId:'host-default',items:[{id:'host-default',agent:'codex',label:'Test CLI',authState:'unknown',checkedAt:null,loginState:'idle'}]}}});
     if(r.operation==='workspace'){
      assert.ok(['workroom.status','workroom.effort'].includes(r.workspace?.action));
      return route.fulfill({status:400,json:{error:'Fixture workspace unsupported'}});
     }
     if(r.operation==='resize')return route.fulfill({json:{session}});
     unmocked.push(`terminal operation ${r.operation}`);
     return route.fulfill({status:400,json:{error:'Unexpected terminal mutation in read-only browser journey'}});
    }
    unmocked.push(`${req.method()} ${url.pathname}`);
    return route.fulfill({status:500,json:{error:'Unmocked API in browser screen fixture'}});
   });
   await page.goto(`${origin}/__browser-workroom`);await page.waitForFunction(()=>document.querySelector('.xterm-rows')?.textContent?.includes('WORKROOM_BROWSER_TERMINAL_OK'));
   // Controls are found by data-testid and state is read from the panel's data attributes (data-owner, data-source), never
   // by their wording; one smoke assertion below checks that the Korean 터미널 label still names the terminal view.
   await page.getByTestId('workroom-browser-toggle').click();await page.getByTestId('owned-browser-unavailable').waitFor();await chooseChrome(page);
   // H1: My Chrome is a guided card in the page area — three numbered steps, the address to open as a mono chip with its
   // own copy button, and the profiles as rows a person can hit. No native select anywhere in this flow.
   const setup=page.getByTestId('workroom-browser-chrome-setup');await setup.waitFor();
   assert.equal(await setup.locator('.wb-chrome-steps>li').count(),3,'the setup card guides with three numbered steps');
   assert.equal(await page.getByTestId('workroom-browser-chrome-address').textContent(),'chrome://inspect/#remote-debugging');
   assert.equal(await page.getByTestId('workroom-browser-chrome-address').evaluate(el=>/mono/i.test(getComputedStyle(el).fontFamily)),true,'the address reads as something to type');
   await page.getByTestId('workroom-browser-copy-address').click();// clipboard or text selection; neither may throw
   assert.equal(await page.getByTestId('workroom-browser-connect').isDisabled(),true,'연결 waits for a chosen profile');
   assert.equal(await page.locator('[data-testid=workroom-browser-chrome-setup] select, [data-testid=workroom-browser-chrome-picker] select').count(),0,'the guided flow uses rows, not a native select');
   const profileRow=page.locator(`[data-testid=workroom-browser-chrome-profile] [data-profile-id="${profile.id}"]`);
   assert.equal(await profileRow.evaluate(el=>Math.round(el.getBoundingClientRect().height)>=44),true,'a profile row is at least 44px tall');
   await profileRow.click();assert.equal(await page.locator(`[data-testid=workroom-browser-chrome-profile] input[value="${profile.id}"]`).isChecked(),true);
   await assertGaps(page,'workroom-browser-chrome-setup');
   await page.getByTestId('workroom-browser-connect').click();
   await page.getByTestId('workroom-browser-refresh-tabs').click();await page.waitForFunction(()=>[...document.querySelectorAll('[data-testid=workroom-browser-chrome-tab] [data-page-id]')].some(x=>x.textContent.includes('127.0.0.1:')));const rows=await page.locator('[data-testid=workroom-browser-chrome-tab] [data-page-id]').evaluateAll(items=>items.map(x=>x.dataset.pageId));assert.equal(rows.length,1);
   const firstRow=page.locator(`[data-testid=workroom-browser-chrome-tab] [data-page-id="${rows[0]}"]`);
   assert.equal(await firstRow.evaluate(el=>Math.round(el.getBoundingClientRect().height)>=44&&!!el.querySelector('.wb-chrome-mono')),true,'a tab row is a 44px row with its monogram');
   await firstRow.click();assert.equal(await page.getByTestId('workroom-browser-select-tab').isDisabled(),true);
   await assertGaps(page,'workroom-browser-chrome-picker');
   await page.getByTestId('workroom-browser-confirm').check();await page.getByTestId('workroom-browser-select-tab').click();
   if(tabs){
    // A second real tab joins this Workroom's own set, the first is shown again, and the second leaves the task still open in Chrome.
    const second=await tabs.open();try{
     // H1: My Chrome's tabs live in the shared strip — the tab itself shows it, its × takes it out of the task.
     const set=page.locator('[data-testid=workroom-browser-tab-set][role=tablist]');const strip=set.getByTestId('workroom-browser-tab-show');
     await strip.first().waitFor();assert.equal(await strip.count(),1);assert.equal(await set.getAttribute('role'),'tablist','the Chrome tab set is the shared strip');
     await page.getByTestId('workroom-browser-refresh-tabs').click();await page.waitForFunction(id=>[...document.querySelectorAll('[data-testid=workroom-browser-chrome-tab] [data-page-id]')].some(x=>x.dataset.pageId===id),second);
     await page.locator(`[data-testid=workroom-browser-chrome-tab] [data-page-id="${second}"]`).click();assert.equal(await page.getByTestId('workroom-browser-add-tab').isDisabled(),true);
     await page.getByTestId('workroom-browser-confirm').check();await page.getByTestId('workroom-browser-add-tab').click();
     await page.waitForFunction(()=>document.querySelectorAll('[data-testid=workroom-browser-tab-set] [data-testid=workroom-browser-tab-show]').length===2);
     assert.equal(await set.locator('[data-testid=workroom-browser-tab-show][aria-selected=true]').textContent().then(t=>t.includes(tabs.title)),true,'the added tab is the one shown');
     await strip.first().click();await page.waitForFunction(()=>document.querySelector('[data-testid=workroom-browser-tab-set] [data-testid=workroom-browser-tab-show]')?.getAttribute('aria-selected')==='true');
     await set.getByTestId('workroom-browser-tab-item').nth(1).getByTestId('workroom-browser-tab-release').click();await page.waitForFunction(()=>document.querySelectorAll('[data-testid=workroom-browser-tab-set] [data-testid=workroom-browser-tab-show]').length===1);
     assert.equal(await tabs.exists(second),true,'removing a tab from the task must not close it');
    }finally{await tabs.close(second);}
   }
   // One person's click must produce the old two steps' exact authority, kept only in the ephemeral composer chip.
   assert.equal(browserRequests.filter(r=>r.operation==='resume').length,0);
   assert.equal(browserRequests.filter(r=>r.operation==='grant').length,0);
   const draft=page.getByRole('textbox',{name:'워크룸 입력',exact:true}),draftBefore=await draft.inputValue();
   await page.getByTestId('workroom-browser-handoff').click();
   await page.locator('[data-testid=workroom-browser-panel][data-owner=agent]').waitFor();
   await page.getByTestId('workroom-browser-observation').waitFor({state:'attached'});
   const chip=page.getByTestId('workroom-browser-handoff-chip');await chip.waitFor();
   assert.equal(await chip.getAttribute('data-state'),'ready');
   assert.equal(browserRequests.filter(r=>r.operation==='resume').length,1,'single handoff resumes once');
   assert.equal(browserRequests.filter(r=>r.operation==='grant').length,1,'single handoff grants once');
   assert.equal(issuedGrants.length,1);
   const access=issuedGrants[0];
   assert.equal((await host.agent({...access,operation:'observe'})).success,true,'the one-step handoff grants the same real host access');
   assert.equal(await page.getByTestId('workroom-browser-grant').count(),0,'no second grant button remains');
   assert.equal(await draft.inputValue(),draftBefore,'browser access never appends a machine block to the textarea');
   const textareaValues=await page.locator('textarea').evaluateAll(items=>items.map(item=>item.value));
   for(const value of textareaValues){assert.ok(!value.includes(access.grant));assert.ok(!value.includes(access.workspaceId));assert.doesNotMatch(value,/workspaceId\s*=|grant\s*=|epoch\s*=|agentstoz_use_workroom_browser/);}
   const chipHtml=await chip.evaluate(el=>el.outerHTML);assert.ok(!chipHtml.includes(access.grant));assert.ok(!chipHtml.includes(access.workspaceId));
   const stored=await page.evaluate(()=>JSON.stringify({local:Object.fromEntries(Object.entries(localStorage)),session:Object.fromEntries(Object.entries(sessionStorage))}));
   assert.ok(!stored.includes(access.grant),'the grant remains outside local and session storage');
   assert.equal(actualSubmits().length,0,'preparing a browser handoff never submits or types to the CLI');
   assert.equal(await page.getByTestId('workroom-browser-observation-details').evaluate(el=>el.open),false,'AI observation stays behind the closed disclosure');
   const terminal=await page.locator('.xterm').evaluate(el=>{el.dataset.browserTestIdentity='retained';return true;});assert(terminal);
   assert.equal(await page.getByRole('button',{name:'터미널',exact:true}).getAttribute('data-testid'),'workroom-browser-view-terminal','smoke: the terminal view keeps its Korean label');
   await page.getByTestId('workroom-browser-view-terminal').click();assert.equal(await page.locator('.xterm[data-browser-test-identity=retained]').count(),1);assert.equal(await draft.inputValue(),draftBefore);assert.equal(await chip.getAttribute('data-state'),'ready');
   await page.getByTestId('workroom-browser-toggle').click();await page.getByTestId('workroom-browser-take').click();await page.locator('[data-testid=workroom-browser-panel][data-owner=human]').waitFor();
   await page.locator('[data-testid=workroom-browser-handoff-chip][data-state=expired]').waitFor();
   await page.getByTestId('workroom-browser-handoff-expired').waitFor();
   await assert.rejects(host.agent({...access,operation:'observe'}),'human takeover revokes the access issued by the single handoff');
   assert.equal(await page.getByRole('button',{name:'현재 세션에 전송',exact:true}).isDisabled(),true,'expired browser access cannot be sent');
   assert.equal(browserRequests.filter(r=>r.operation==='resume').length,1);assert.equal(browserRequests.filter(r=>r.operation==='grant').length,1,'takeover does not automatically re-grant');
   assert.equal(actualSubmits().length,0);assert.equal(await draft.inputValue(),draftBefore);
   await page.setViewportSize({width:800,height:900});await page.evaluate(()=>document.documentElement.dataset.appTheme='dark');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await detachChrome(page);assert.equal(await page.locator('.xterm[data-browser-test-identity=retained]').count(),1);assert.equal(await draft.inputValue(),draftBefore);assert.equal(actualSubmits().length,0);assert.deepEqual(unmocked,[]);assert.deepEqual(errors,[]);
   await page.goto(`${origin}/__browser-view-cache`);await page.getByTestId('workroom-browser-toggle').click();await page.getByTestId('owned-browser-unavailable').waitFor();await chooseChrome(page);
   const history=page.getByTestId('workroom-browser-recoveries');await page.getByTestId('workroom-browser-recoveries-toggle').click();await history.locator('[data-testid=workroom-browser-recover][data-recovery-id=saved_browser_task]').click();assert.equal(await history.evaluate(el=>el.open),false,'Choosing a saved task must collapse its history so the native viewport can become visible');await page.locator('[data-testid=workroom-browser-panel][data-source=chrome][data-recovery=saved_browser_task]').waitFor();await page.waitForFunction(()=>document.querySelector('[data-testid=workroom-browser-chrome-profile] input[value="chrome:fixture"]')?.checked===true);assert.equal(await page.locator('[data-testid=workroom-browser-chrome-profile] input[value="chrome:fixture"]').isChecked(),true);
   for(let n=0;n<10;n++){
    if(n){
     await page.getByLabel('Test session').selectOption(String(n));
     await page.locator('[data-testid=workroom-browser-panel][data-source=owned]').waitFor();
     await page.getByTestId('owned-browser-unavailable').waitFor();await chooseChrome(page);
    }
    await page.locator('[data-testid=workroom-browser-chrome-profile] [data-profile-id="chrome:fixture"]').click();await page.getByTestId('workroom-browser-connect').click();await page.locator('[data-testid=workroom-browser-panel][data-source=chrome][data-owner=human]').waitFor();
   }
   await page.getByLabel('Test session').selectOption('8');const stage=page.locator('[data-testid=workroom-browser-panel][data-source=chrome][data-owner=human] [data-testid=workroom-browser-chrome-elsewhere]');await stage.waitFor();assert.equal(await page.getByTestId('owned-workroom-browser').count(),0);
   // H1: the shared-login fact is one info line, not the two paragraphs the audit found above the slot.
   assert.equal(await stage.getByTestId('workroom-browser-chrome-warning').count(),1);
   assert.equal(await stage.locator('.wb-chrome-card__body').evaluate(el=>Math.round(el.getBoundingClientRect().height/parseFloat(getComputedStyle(el).lineHeight))<=2),true,'the stage card says where the page is in at most two lines');
   assert.equal(await stage.getByTestId('workroom-browser-chrome-warning').evaluate(el=>el.getAttribute('role')),'status');
   await page.getByLabel('Test session').selectOption('0');await page.getByTestId('workroom-browser-connect').waitFor({state:'hidden'});await page.locator('[data-testid=workroom-browser-panel][data-source=owned]').waitFor();await page.getByTestId('owned-browser-unavailable').waitFor();assert.equal(await page.locator('[data-testid=workroom-browser-panel][data-owner=""]').count(),1);assert.equal(await page.getByTestId('workroom-browser-owner').count(),0);
   assert.deepEqual(unmocked,[]);assert.deepEqual(errors,[]);assert.equal(actualSubmits().length,0);
   console.log(`${name}: actual Workroom/xterm retention, explicit profile/tab confirmation, single handoff with secret-free chip, revoked access after takeover, no automatic submission, collapse and narrow dark layout passed`);await page.close();
  }finally{await browser.close();}
 }}finally{await vite.close();await new Promise((resolve,reject)=>http.close(error=>error?reject(error):resolve()));}
}
