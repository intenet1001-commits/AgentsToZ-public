/** Real React composer, synthetic inventory + intercepted CLI transport only.
 * Runs its own Vite (never API 3001), refuses external/unmocked API requests,
 * and stops only that owned server. No CLI, app data or project is accessed.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
const origin=process.env.AI_WORK_REQUEST_ORIGIN||'http://127.0.0.1:9147';
assert.equal(new URL(origin).hostname,'127.0.0.1');
const server=process.env.AI_WORK_REQUEST_ORIGIN?null:spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','9147','--strictPort'],{cwd:new URL('../',import.meta.url),stdio:'pipe'});
let serverError='';server?.stderr.on('data',chunk=>{serverError=(serverError+chunk).slice(-2000)});
server?.stdout.resume();
const A='fixture_project_alpha',B='fixture_worktree_bravo',CONTROL='fixture_control';
const projects=[{targetId:A,projectTargetId:A,label:'프로젝트 A · 긴 이름이 있는 기본 프로젝트',scope:'main',branch:'main',locked:false,worktreeCapable:true},
 {targetId:B,projectTargetId:A,label:'프로젝트 B · codex/긴-워크트리-이름',scope:'worktree',branch:'codex/work',locked:false,worktreeCapable:true},
 {targetId:CONTROL,projectTargetId:CONTROL,label:'AgentsToZ-Control · main',scope:'main',branch:'main',locked:false,worktreeCapable:true}];
const entry=(nonce,targetId,prompt)=>({nonce,targetId,title:`요청 ${nonce}`,prompt});
let browser,react,reactDom;
const html=options=>`<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};
import '/src/index.css';import '/src/workspaceDesign.css';import {applyZoomToDocument} from '/src/uiZoom.ts';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
applyZoomToDocument(document,1.25);document.documentElement.dataset.appTheme='gray';
const projects=${JSON.stringify(projects)};
const state=window.__work={targetCalls:[],targetModes:${JSON.stringify(options.targetModes??[])},resolvers:[],started:[],opened:0};
let hidden=false;Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});
window.__hidden=value=>{hidden=value;document.dispatchEvent(new Event('visibilitychange'))};
const {AgentRuntimeClient}=await import('/src/agentRuntimeClient.ts');
AgentRuntimeClient.prototype.targets=async({signal}={})=>{
 const call={aborted:false};state.targetCalls.push(call);signal?.addEventListener('abort',()=>{call.aborted=true},{once:true});
 const mode=state.targetModes.shift();
 if(mode==='pending')return new Promise((resolve,reject)=>state.resolvers.push({resolve,reject}));
 if(mode==='error')throw new Error('Fixture target inventory failed');
 return mode??{targets:projects,complete:true};
};
const {AiWorkRequestPanel}=await import('/src/AiWorkRequestPanel.tsx');
function Harness(){const [visible,setVisible]=React.useState(true),[entry,setEntry]=React.useState(${JSON.stringify(options.entry??entry(1,A,'요청 A의 보존할 초안'))}),[supplied,setSupplied]=React.useState(projects),[tick,setTick]=React.useState(0);
 window.__visible=setVisible;window.__entry=setEntry;window.__projects=setSupplied;window.__rerender=()=>setTick(value=>value+1);
 return React.createElement('div',{style:{display:'grid',gridTemplateColumns:'264px minmax(0,1fr)',minHeight:'var(--ui-viewport-height)'}},
 React.createElement('aside',{'data-testid':'fixture-sidebar'},'AgentsToZ · Fixture'),
 React.createElement('main',{style:{padding:16,minWidth:0},hidden:!visible},React.createElement(AiWorkRequestPanel,{visible,projects:supplied.map(value=>({...value})),entry,onStarted:session=>state.started.push(session),onOpenWorkroom:()=>state.opened++})));}
const root=ReactDOM.createRoot(document.getElementById('root'));window.__unmount=()=>root.unmount();root.render(React.createElement(Harness));
</script>`;
async function fixture(options={}){
 const context=await browser.newContext({viewport:{width:1000,height:1050},serviceWorkers:'block'});
 const state={starts:[],sessions:new Map(),hold:!!options.hold,fail:!!options.fail,pending:[],blocked:[],errors:[]};
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin!==origin){state.blocked.push(url.origin+url.pathname);return route.abort('blockedbyclient');}
  if(url.pathname==='/__ai-work-request')return route.fulfill({contentType:'text/html',body:html(options)});
  if(!url.pathname.startsWith('/api/'))return route.continue();
  if(url.pathname!=='/api/agent-runtime/terminals'){state.blocked.push(url.pathname);return route.abort('blockedbyclient');}
  const body=request.postDataJSON();assert.equal(body.operation,'start');assert.ok([A,B,CONTROL].includes(body.targetId));state.starts.push(body);
  let session=state.sessions.get(body.requestId);
  if(!session){session={id:`fixture_session_${state.sessions.size}`,targetId:body.targetId,agent:body.agent,state:'running',createdAt:'2026-09-09T00:00:00Z',exitCode:null,cols:100,rows:28};state.sessions.set(body.requestId,session);}
  const finish=async(fail=state.fail)=>route.fulfill(fail?{status:503,json:{error:'Fixture response lost; retry the same request'}}:{json:{session}});
  if(state.hold){await new Promise(resolve=>state.pending.push(async fail=>{await finish(fail);resolve()}));return;}
  return finish();
 });
 const page=await context.newPage();page.on('pageerror',error=>state.errors.push(error.message));await page.clock.install();
 await page.goto(`${origin}/__ai-work-request`);const panel=page.getByTestId('ai-work-request');await panel.waitFor();
 await page.waitForFunction(()=>window.__work.targetCalls.length>0);
 return {context,page,panel,state,prompt:page.getByLabel('AI 작업 요청',{exact:true}),start:page.getByTestId('ai-work-request-start')};
}
async function until(fn,message){for(let i=0;i<300;i++){if(await fn())return;await delay(10);}assert.fail(message);}
async function run(name,fn,options){const f=await fixture(options);try{await fn(f);assert.deepEqual(f.state.blocked,[]);assert.deepEqual(f.state.errors,[]);console.log('PASS '+name);}finally{for(const finish of f.state.pending.splice(0))await finish(true).catch(()=>{});await f.context.close();}}
try{
 let source;
 for(let attempt=0;attempt<100;attempt++){
  if(server?.exitCode!==null&&server?.exitCode!==undefined)throw new Error(serverError||'Owned Vite exited');
  try{const response=await fetch(`${origin}/src/AiWorkRequestPanel.tsx`);if(response.ok){source=await response.text();break}}catch{}
  await delay(100);
 }
 assert.ok(source,'Isolated Vite must start');
 react=source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1];
 const main=await fetch(`${origin}/src/main.tsx`).then(response=>response.text());
 reactDom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
 assert.ok(react&&reactDom);
 browser=await chromium.launch({headless:true});
 await run('late success preserves newer routed draft and requires explicit navigation',async({page,prompt,start,state})=>{
  await start.evaluate(button=>{button.click();button.click()});await until(()=>state.pending.length===1,'Exactly one held start');
  await page.evaluate(value=>window.__entry(value),entry(2,B,'새 요청 B의 초안'));await until(async()=>await prompt.inputValue()==='새 요청 B의 초안','B receives focus/draft');
  await state.pending.shift()(false);await page.getByTestId('ai-work-previous-receipt').waitFor();
  assert.equal(state.starts.length,1);assert.equal(await prompt.inputValue(),'새 요청 B의 초안');assert.equal(await page.getByLabel('AI 작업 프로젝트').inputValue(),B);
  assert.equal(await prompt.evaluate(node=>node===document.activeElement),true,'The new draft receives focus after the older start settles');
  assert.equal(await page.evaluate(()=>window.__work.started.length),0);
  await page.getByRole('button',{name:'이전 요청 워크룸 열기'}).click();
  assert.equal(await page.evaluate(()=>window.__work.started[0].targetId),A);assert.equal(await prompt.inputValue(),'새 요청 B의 초안');
 },{hold:true});
 await run('late failure never replaces the newer draft or its error state',async({page,prompt,start,state})=>{
  await start.click();await until(()=>state.pending.length===1,'Held start');
  await page.evaluate(value=>window.__entry(value),entry(2,B,'새 요청 B의 초안'));await until(async()=>await prompt.inputValue()==='새 요청 B의 초안','B draft');
  await state.pending.shift()(true);await page.getByTestId('ai-work-previous-receipt').waitFor();
  assert.equal(await prompt.inputValue(),'새 요청 B의 초안');assert.equal(await page.getByRole('alert').count(),0);assert.equal(await page.evaluate(()=>window.__work.started.length),0);
  await page.getByRole('button',{name:'이전 요청 워크룸 열기'}).click();assert.equal(await page.evaluate(()=>window.__work.opened),1);
 },{hold:true});
 await run('uncertain retry retains request ID and never duplicates a created session',async({page,prompt,start,state})=>{
  await start.click();await page.getByRole('alert').filter({hasText:'Fixture response lost'}).waitFor();
  assert.equal(await prompt.inputValue(),'요청 A의 보존할 초안');state.fail=false;await start.click();
  await page.waitForFunction(()=>window.__work.started.length===1);
  assert.equal(state.starts.length,2);assert.equal(state.starts[0].requestId,state.starts[1].requestId);assert.equal(state.sessions.size,1);assert.equal(await prompt.inputValue(),'');
 },{fail:true});
 await run('a completion after switching tabs cannot navigate the user',async({page,start,state})=>{
  await start.click();await until(()=>state.pending.length===1,'Held start');await page.evaluate(()=>window.__visible(false));
  await state.pending.shift()(false);await page.waitForFunction(()=>document.querySelector('[data-testid="ai-work-previous-receipt"]'));
  assert.equal(await page.evaluate(()=>window.__work.started.length),0);await page.evaluate(()=>window.__visible(true));await page.getByTestId('ai-work-previous-receipt').waitFor();
 },{hold:true});
 await run('partial inventory preserves selection; complete removal requires an explicit new choice',async({page,prompt,start})=>{
  await until(async()=>await page.getByRole('status').count()===1,'Partial inventory is explained');
  assert.equal(await page.getByLabel('AI 작업 프로젝트').inputValue(),B);assert.equal(await start.isEnabled(),true);
  await page.evaluate(value=>window.__work.targetModes.push({targets:[value],complete:true}),projects[0]);await page.getByTestId('ai-work-targets-refresh').click();
  await until(async()=>await start.isDisabled(),'Removed selected target must disable start');assert.equal(await page.getByLabel('AI 작업 프로젝트').inputValue(),B);assert.equal(await prompt.inputValue(),'B draft');
  await page.evaluate(()=>window.__work.targetModes.push('error'));await page.getByTestId('ai-work-targets-refresh').click();await page.getByRole('alert').waitFor();
  assert.equal(await start.isDisabled(),true);await page.getByTestId('ai-work-targets-refresh').click();await until(async()=>await start.isEnabled(),'Manual retry recovers authoritative inventory');assert.equal(await page.getByRole('alert').count(),0);
 },{entry:entry(1,B,'B draft'),targetModes:[{targets:[projects[0]],complete:false}]});
 await run('target observation aborts while hidden, ignores stale responses and does not poll',async({page,prompt})=>{
  await page.evaluate(()=>window.__visible(false));await page.waitForFunction(()=>window.__work.targetCalls[0].aborted);
  await page.evaluate(()=>window.__work.resolvers.shift().resolve({targets:[],complete:true}));
  await page.clock.runFor(60000);assert.equal(await page.evaluate(()=>window.__work.targetCalls.length),1);
  await page.evaluate(()=>window.__visible(true));await page.waitForFunction(()=>window.__work.targetCalls.length===2);
  assert.equal(await prompt.inputValue(),'요청 A의 보존할 초안');
  await page.evaluate(()=>{window.__rerender();window.__rerender()});await page.clock.runFor(1000);assert.equal(await page.evaluate(()=>window.__work.targetCalls.length),2,'Unchanged parent arrays do not reload');
  await page.evaluate(()=>window.__work.targetModes.push('pending'));await page.getByTestId('ai-work-targets-refresh').click();
  await page.waitForFunction(()=>window.__work.resolvers.length===1);await page.evaluate(()=>window.__hidden(true));await page.waitForFunction(()=>window.__work.targetCalls[2].aborted);
  await page.evaluate(()=>window.__work.resolvers.shift().reject(new Error('stale fixture failure')));await page.clock.runFor(60000);
  assert.equal(await page.getByRole('alert').count(),0);assert.equal(await page.evaluate(()=>window.__work.targetCalls.length),3);
  await page.evaluate(()=>window.__hidden(false));await page.waitForFunction(()=>window.__work.targetCalls.length===4);
  await page.evaluate(()=>window.__unmount());await page.clock.runFor(60000);assert.equal(await page.evaluate(()=>window.__work.targetCalls.length),4);
 },{targetModes:['pending']});
 await run('invalid requests remain editable; the separate draft budget prevents unbounded retention',async({page,prompt,start,state})=>{
  await prompt.fill('기존 초안');await prompt.fill('한'.repeat(8000)+'a');
  await page.getByRole('alert').filter({hasText:'24,000바이트'}).waitFor();assert.equal(await prompt.inputValue(),'한'.repeat(8000)+'a');assert.equal(await start.isDisabled(),true);assert.equal(state.starts.length,0);
  await prompt.fill('😀'.repeat(6000));assert.equal(await start.isEnabled(),true);assert.ok((await page.getByTestId('ai-work-request').innerText()).includes('24,000 / 24,000바이트'));
  await page.evaluate(value=>window.__entry(value),entry(2,B,'bad\0transfer'));await page.getByRole('alert').filter({hasText:'NUL'}).waitFor();
  assert.equal(await prompt.inputValue(),'bad\0transfer');assert.equal(await page.getByLabel('AI 작업 프로젝트').inputValue(),B);assert.equal(await start.isDisabled(),true);assert.equal(state.starts.length,0);
  await prompt.fill('유효한 새 요청');assert.equal(await start.isEnabled(),true);
  await prompt.fill('a'.repeat(1024*1024+1));await page.getByRole('alert').filter({hasText:'1MiB'}).waitFor();assert.equal(await prompt.inputValue(),'유효한 새 요청');assert.equal(await start.isDisabled(),true);assert.equal(state.starts.length,0);
  await prompt.fill('수정한 초안');assert.equal(await start.isEnabled(),true);
 });
 await run('mission mode launches a visible Control coordinator with four selectable workers',async({page,prompt,start,state})=>{
  await page.getByLabel('AI 작업 실행 방식').selectOption('mission');
  await page.getByLabel('AI 작업 관제 전략').selectOption('cs-ceo');
  assert.equal(await page.getByRole('checkbox').count(),4);
  await page.getByLabel('AI 작업 프로젝트').selectOption(A);
  await prompt.fill('네 CLI에게 분배하고 검증해');
  assert.ok(await start.isEnabled());await start.click();
  await page.waitForFunction(()=>window.__work.started.length===1);
  assert.equal(state.starts.length,1);assert.equal(state.starts[0].targetId,CONTROL);assert.equal(state.starts[0].agent,'codex');
  assert.match(state.starts[0].prompt,/AgentsToZ 관제 에이전트/);assert.match(state.starts[0].prompt,/cs-ceo의 Goal Gate/);
  assert.match(state.starts[0].prompt,/“프로젝트 A”/);assert.match(state.starts[0].prompt,/codex, claude, hermes, agy/);
 },{entry:entry(1,A,'네 CLI에게 분배하고 검증해')});
 await run('1000px at 125% keeps controls within the workspace and keyboard reaches start',async({page,panel,prompt})=>{
  const geometry=await panel.evaluate(node=>{const bounds=node.getBoundingClientRect();return{right:bounds.right,width:bounds.width,viewport:innerWidth,scroll:document.documentElement.scrollWidth,zoom:document.querySelector('#root').style.transform,overflow:[...node.querySelectorAll('select,textarea,button')].some(control=>{const b=control.getBoundingClientRect();return b.right>bounds.right+1||b.left<bounds.left-1})}});
  assert.equal(geometry.zoom,'scale(1.25)');assert.ok(geometry.scroll<=geometry.viewport+2&&geometry.right<=geometry.viewport+2&&!geometry.overflow,JSON.stringify(geometry));
  await prompt.focus();await page.keyboard.press('Tab');assert.equal(await page.getByTestId('ai-work-request-start').evaluate(node=>node===document.activeElement),true);
 });
}finally{
 await browser?.close();
 if(server&&server.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(resolve=>server.once('exit',resolve)),delay(5000)]);if(server.exitCode===null)server.kill('SIGKILL');}
}
