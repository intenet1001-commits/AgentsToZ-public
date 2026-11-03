import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {chromium,webkit} from 'playwright';

export async function checkCommunityDeviceRegistration(){
 const built=await Bun.build({entrypoints:['tests/fixtures/community-registration-entry/screen.tsx'],target:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"','import.meta.env':JSON.stringify({DEV:false,VITE_SUPABASE_URL:'https://fixture.invalid',VITE_SUPABASE_ANON_KEY:'fixture-public'})}});
 if(!built.success)throw Error(built.logs.join('\n'));
 const js=built.outputs.find(o=>o.path.endsWith('.js')),css=built.outputs.find(o=>o.path.endsWith('.css'));
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:r=>{
  const path=new URL(r.url).pathname;
  if(path==='/app.js')return new Response(js,{headers:{'Content-Type':'text/javascript'}});
  if(path==='/app.css')return new Response(css,{headers:{'Content-Type':'text/css'}});
  return new Response('<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:12px;box-sizing:border-box;font-family:system-ui;--ink:#f1eee8;--ink-2:#bbb5aa;--surface:#211f1a;--accent:#ef995e;--line:#625b50;background:#151411;color:var(--ink)}button{font:inherit}*,*:before,*:after{box-sizing:border-box}</style><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/app.js"></script>',{headers:{'Content-Type':'text/html'}});
 }});
 const origin=server.url.origin;mkdirSync('.agentstoz/maintainer/community-registration-entry',{recursive:true});
 try{for(const [name,engine] of Object.entries({chromium,webkit})){
  const browser=await engine.launch();try{
   const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
   await page.goto(origin+'/?native=0');
   await page.waitForFunction(()=>typeof setSurface==='function');
   assert.equal(await page.getByTestId('community-device-registration').count(),0,'The desktop entry stays absent from browser and mobile workspaces');
   assert.equal(await page.evaluate(()=>calls.length),0,'A browser never asks for native state or opens an app');
   await page.goto(origin+'/?native=1');
   const entry=page.getByTestId('community-device-registration'),button=entry.getByRole('button',{name:'등록·승인 안내 열기',exact:true});
   await button.waitFor();await button.waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('.community-device-registration__open').disabled);
   assert.match(await entry.innerText(),/「커뮤니티 기기 등록·승인…」/);
   await button.click();
   assert.deepEqual(await page.evaluate(()=>calls.filter(x=>x.command==='open_viewer_helper')),[{command:'open_viewer_helper',args:{}}],'The existing no-argument Viewer open is the only action');
   assert.equal(await entry.getByText(/등록 완료|승인 완료|연결 완료/).count(),0,'A verified app open never claims enrollment or session success');
   // A state change between display and click still reaches the native fresh refusal; no retry or alternate API.
   await page.evaluate(()=>setStatus({otherInstanceRunning:true}));await button.click();await entry.getByRole('alert').waitFor();
   assert.equal(await entry.getByText(/native fresh negative guard/).count(),0,'Internal command diagnostics are not product instructions');
   await page.evaluate(()=>tick());await entry.locator('[data-entry-state="other-instance"]').waitFor();assert.equal(await button.isDisabled(),true);
   await page.evaluate(()=>{setStatus({otherInstanceRunning:false,instanceStatusUnknown:true});tick();});await entry.locator('[data-entry-state="unknown"]').waitFor();assert.equal(await button.isDisabled(),true);
   await page.evaluate(()=>{setStatus({instanceStatusUnknown:false});tick();});await page.waitForFunction(()=>!document.querySelector('.community-device-registration__open').disabled);
   // A late successful status must not undo the newer unknown result.
   await page.evaluate(()=>{holdNextStatus=true;tick();});await page.waitForFunction(()=>heldCount()===1);
   await page.evaluate(()=>{setStatus({instanceStatusUnknown:true});tick();});await entry.locator('[data-entry-state="unknown"]').waitFor();
   await page.evaluate(()=>releaseOldStatus(true));assert.equal(await button.isDisabled(),true);
   await page.evaluate(()=>{setStatus({instanceStatusUnknown:false,running:true,updatePending:true});tick();});await entry.locator('[data-entry-state="update-waiting"]').waitFor();assert.equal(await button.isDisabled(),true);
   await page.evaluate(()=>{setStatus({running:false});tick();});await page.waitForFunction(()=>!document.querySelector('.community-device-registration__open').disabled);
   await page.evaluate(()=>{setStatus({updatePending:false,supported:false});tick();});await entry.locator('[data-entry-state="unsupported"]').waitFor();assert.equal(await entry.getByRole('button').count(),0);
   await page.evaluate(()=>{setStatus({supported:true});tick();});await button.waitFor();
   const beforeHidden=await page.evaluate(()=>calls.length);await page.evaluate(()=>{setHidden(true);tick();});assert.equal(await page.evaluate(()=>calls.length),beforeHidden,'Hidden document makes no state query');
   await page.evaluate(()=>setHidden(false));
   await page.evaluate(()=>setVisible(false));await entry.waitFor({state:'detached'});assert.equal(await page.evaluate(()=>timerCount()),0,'Invisible entry unmounts its status hook');
   const beforeUnmount=await page.evaluate(()=>calls.length);await page.evaluate(()=>tick());assert.equal(await page.evaluate(()=>calls.length),beforeUnmount);
   await page.evaluate(()=>{setVisible(true);setSurface('empty');});await page.getByText('연결된 아젠투지가 없습니다.').waitFor();await entry.waitFor();await button.waitFor();
   await page.evaluate(()=>setSurface('dialogue'));const community=page.getByTestId('agent-dialogue-community');await community.getByText('위에서 공개할 대상을 먼저 켜세요.').waitFor();await community.getByTestId('community-device-registration').waitFor();
   // The actual Workspace composer and IME state are not remounted by native status updates or opening the guide.
   await page.evaluate(()=>setSurface('workspace'));await page.getByRole('button',{name:'새 업무',exact:true}).click();
   const draft=page.getByRole('textbox',{name:'프로젝트에 맡길 업무',exact:true});await draft.fill('보관할 커뮤니티 초안');
   await draft.evaluate(el=>{window.savedDraftNode=el;el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'한'}));});
   await page.evaluate(()=>tick());await page.getByTestId('community-device-registration').getByRole('button',{name:'등록·승인 안내 열기',exact:true}).click();
   assert.equal(await draft.inputValue(),'보관할 커뮤니티 초안');assert.equal(await draft.evaluate(el=>el===window.savedDraftNode),true);
   assert.equal(await page.evaluate(()=>workspaceCalls.some(x=>x.workspace?.action==='workroom.threads.create')),false);
   await draft.evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'한'})));
   assert.equal(await page.evaluate(()=>calls.some(x=>!['get_viewer_helper','open_viewer_helper','agent_dialogue_management_request'].includes(x.command))),false);
   for(const width of [320,940]){await page.setViewportSize({width,height:900});assert.equal(await entry.evaluate(el=>el.scrollWidth>el.clientWidth),false);}
   await entry.screenshot({path:`.agentstoz/maintainer/community-registration-entry/${name}.png`});
   assert.deepEqual(errors,[]);console.log(`community registration entry ${name}: native guards, visibility, empty targets and IME draft PASS`);
  }finally{await browser.close();}
 }}finally{server.stop(true);}
}
if(import.meta.main)await checkCommunityDeviceRegistration();
