/**
 * Session directory, live first (S1): four activity states read as four labels, the first live row sits above the
 * fold even with 50 saved conversations, and the window keeps at most one activity request in flight.
 * Real React on an owned Vite server with a synthetic host. No CLI, AI, port 3001 or installed app.
 *
 *   bun tests/workroom-session-directory-activity.e2e.mjs
 *   ACTIVITY_EVIDENCE_DIR=<dir> keeps the screenshots.
 */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'vite';
import {chromium} from 'playwright';

const root=resolve(import.meta.dirname,'..'),scratch=await mkdtemp(join(tmpdir(),'agentstoz-directory-activity-'));
const shots=process.env.ACTIVITY_EVIDENCE_DIR||join(scratch,'evidence');await mkdir(shots,{recursive:true});
for(const key of Object.keys(process.env))if(key.startsWith('VITE_'))delete process.env[key];
process.env.VITE_SUPABASE_URL='https://workspace-fixture.supabase.co';process.env.VITE_SUPABASE_ANON_KEY='fixture-anon-key';
const projects=[['proj-alpha-001','알파 서비스'],['proj-bravo-001','브라보 앱'],['proj-charlie-01','찰리 문서'],['proj-delta-0001','델타 실험']].map(([targetId,label])=>({targetId,projectTargetId:targetId,label,scope:'main'}));
const at='2026-10-16T01:00:00.000Z',now=Date.parse('2026-10-16T01:10:00.000Z');
const session=(id,targetId,state='running',exitCode=null)=>({id,targetId,agent:'codex',state,createdAt:at,exitCode,cols:100,rows:28});
const sessions=[session('session-asking-01','proj-alpha-001'),session('session-working1','proj-bravo-001'),session('session-finished','proj-charlie-01'),session('session-exited01','proj-delta-0001','exited',2)];
const activity=[
  {sessionId:'session-asking-01',targetId:'proj-alpha-001',agent:'codex',state:'needs-answer',since:now-30_000,turn:3,source:'screen',exact:false,lastOutputAt:now-30_000},
  {sessionId:'session-working1',targetId:'proj-bravo-001',agent:'codex',state:'working',since:now-5_000,turn:1,source:'screen',exact:true,lastOutputAt:now-1_000},
  {sessionId:'session-finished',targetId:'proj-charlie-01',agent:'codex',state:'turn-finished',since:now-120_000,turn:2,source:'transcript',exact:true,lastOutputAt:now-120_000},
  {sessionId:'session-exited01',targetId:'proj-delta-0001',agent:'codex',state:'exited',since:now-600_000,turn:4,source:'exit',exact:true,exitCode:2,cause:'exit',lastOutputAt:now-600_000},
];
const saved=Array.from({length:50},(_,index)=>({id:`saved-conversation-${String(index).padStart(3,'0')}`,targetId:projects[index%4].targetId,agent:'codex',accountId:'host-default',accountLabel:'현재 CLI 계정',title:`저장된 대화 제목 ${index+1}`,createdAt:at,updatedAt:at,revision:1,archived:false,state:'ended',sessionId:`old-session-${String(index).padStart(3,'0')}`,binding:'verified'}));
const bootId='00000000-0000-4000-8000-0000000000b1';
let vite,browser;
const results=[];
try{
  vite=await createServer({configFile:join(root,'vite.config.ts'),root,envDir:scratch,cacheDir:join(scratch,'node_modules/.vite'),mode:'maintainer-test',logLevel:'warn',plugins:[{name:'deny-live-api',configureServer(server){server.middlewares.use((request,response,next)=>{if(!request.url?.startsWith('/api/'))return next();response.statusCode=503;response.end('Unmocked fixture API rejected');});}}],server:{host:'127.0.0.1',port:0,strictPort:false,fs:{allow:[root,realpathSync(join(root,'node_modules')),scratch]},watch:{ignored:['**/.agentstoz/**']}}});
  await vite.listen();const address=vite.httpServer.address();assert.ok(address&&typeof address!=='string'&&address.port!==3001);
  const origin=`http://127.0.0.1:${address.port}`;
  const [source,main]=await Promise.all(['/src/AiTerminalPanel.tsx','/src/main.tsx'].map(path=>fetch(origin+path).then(response=>{assert.equal(response.status,200);return response.text();})));
  const react=source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1],reactDom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];assert.ok(react&&reactDom);
  const html=`<!doctype html><html data-app-theme="gray"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:var(--bg);color:var(--ink);font:14px system-ui}#root{min-height:100vh}</style><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};
import '/src/index.css';import '/src/workspaceDesign.css';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const {WorkroomDeviceSwitch}=await import('/src/WorkroomDeviceSwitch.tsx');const {useWorkroomActivity}=await import('/src/useWorkroomActivity.ts');
Date.now=()=>${now};
// The App owns the window's one activity subscription; this stands in for it.
function Shell(){useWorkroomActivity();return React.createElement(WorkroomDeviceSwitch,{sessionDirectory:true,visible:true,projects:${JSON.stringify(projects)},deviceName:'아젠투지1호'});}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Shell));window.open=()=>null;
</script></html>`;
  browser=await chromium.launch({headless:true});
  for(const viewport of [{width:800,height:700},{width:1280,height:800}]){
    const context=await browser.newContext({viewport,serviceWorkers:'block'}),errors=[],external=[],unexpected=[];
    const state={inFlight:0,maxInFlight:0,activity:0,seen:[],hidden:false};
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());if(url.origin!==origin){external.push(url.origin);return route.abort();}
      if(url.pathname==='/__activity-fixture')return route.fulfill({contentType:'text/html',body:html});
      if(!url.pathname.startsWith('/api/'))return route.continue();
      const body=route.request().postDataJSON()??{};
      if(url.pathname==='/api/agent-runtime/terminals/history')return route.fulfill({json:{protocolVersion:'workroom-history-v1',storeInstanceId:'local-history-store-001',records:body.archived?[]:saved,nextBefore:null}});
      if(url.pathname==='/api/agent-runtime/targets')return route.fulfill({json:{protocolVersion:'agentstoz-tasks-v2',complete:true,targets:projects.map(project=>({...project,branch:null,locked:false,worktreeCapable:false}))}});
      if(url.pathname==='/api/agent-dialogue/control')return route.fulfill({json:{success:true,inside:false,deviceId:'local-device-one',devices:[],unread:0,lastMessageAt:null}});
      if(url.pathname==='/api/agent-runtime/terminals/access')return route.fulfill({json:{connections:[],workspaceRoots:[]}});
      if(url.pathname==='/api/agent-runtime/terminals/memory')return route.fulfill({json:{jobs:[]}});
      if(url.pathname==='/api/ai-usage/codex')return route.fulfill({json:{rateLimits:null}});
      if(url.pathname!=='/api/agent-runtime/terminals'){unexpected.push(url.pathname);return route.fulfill({status:503,json:{error:'Fixture API blocked'}});}
      if(body.operation==='activity'){
        state.activity++;state.inFlight++;state.maxInFlight=Math.max(state.maxInFlight,state.inFlight);
        // The browser build never asks the host to hold (six connections per host — review 2026-10-16).
        if(body.waitMs!==0)state.held=(state.held??0)+1;
        if(body.after)await new Promise(done=>setTimeout(done,700)); // a held long-poll that answers with nothing new
        state.inFlight--;
        return route.fulfill({json:{activity:{bootId,cursor:4,reset:!body.after,sessions:activity,events:[]}}});
      }
      if(body.operation==='seen'){state.seen.push(body.sessionId);return route.fulfill({json:{seen:true}});}
      if(body.operation==='list')return route.fulfill({json:{sessions}});
      if(body.operation==='workspace')return route.fulfill({status:503,json:{error:'Fixture 저장 상태 조회 없음'}});
      const selected=sessions.find(item=>item.id===body.sessionId);
      if(body.operation==='read'&&selected)return route.fulfill({json:{session:selected,chunks:body.after?[]:[{seq:1,text:'Fixture terminal\r\n› '}],nextCursor:1,truncated:false,hasMore:false}});
      if((body.operation==='resize'||body.operation==='input')&&selected)return route.fulfill({json:{session:selected}});
      if(body.operation==='accounts'&&body.accountAction==='list')return route.fulfill({json:{accounts:{agent:body.agent,selectedAccountId:'host-default',items:[{id:'host-default',agent:body.agent,label:'현재 CLI 계정',authState:'unknown',checkedAt:null,loginState:'idle'}]}}});
      unexpected.push(`terminal ${body.operation}`);return route.fulfill({status:400,json:{error:'Unexpected terminal request'}});
    });
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+'/__activity-fixture');
    await page.waitForFunction(()=>document.querySelectorAll('[data-testid="session-directory-row"][data-activity]').length===4&&!!document.querySelector('[data-activity="needs-answer"]'),undefined,{timeout:20_000})
      .catch(async error=>{throw new Error(`${error.message}\nerrors=${JSON.stringify(errors)} unexpected=${JSON.stringify(unexpected)} activity=${state.activity}\n${(await page.locator('body').innerText()).slice(0,1500)}`);});
    // Four states, four distinct labels, in attention order.
    const labels=await page.locator('[data-testid="session-directory-row-state"]').allTextContents();
    assert.deepEqual(labels,['응답 필요','작업 중','완료','종료(코드 2)']);
    assert.equal(new Set(labels).size,4);
    assert.deepEqual(await page.locator('[data-testid="session-directory-live-group"]').evaluateAll(groups=>groups.map(group=>group.dataset.group)),['needs-answer','working','finished','ended']);
    assert.match(await page.getByTestId('session-directory-summary').textContent(),/확인할 세션 2개/);
    // Saved conversations fold below; 50 of them never push the first live row below the fold.
    await page.waitForFunction(()=>/저장된 대화 50개/.test(document.querySelector('[data-testid="session-directory-saved"] summary')?.textContent??''),undefined,{timeout:15_000})
      .catch(async error=>{throw new Error(`${error.message} summary=${await page.locator('[data-testid="session-directory-saved"] summary').textContent().catch(()=>'none')}`);});
    const top=await page.locator('[data-testid="session-directory-row"]').first().evaluate(row=>row.getBoundingClientRect().top);
    assert.ok(top<viewport.height,`first live row top ${top} must be above the fold (${viewport.height})`);
    const savedTop=await page.getByTestId('session-directory-saved').evaluate(element=>element.getBoundingClientRect().top);
    assert.ok(savedTop>top,'saved conversations sit below the live list');
    // One long-poll in flight at most, across several answered rounds.
    const before=state.activity;await page.waitForTimeout(2500);
    assert.ok(state.activity>before,'the long-poll keeps asking');
    assert.equal(state.maxInFlight,1,'at most one activity request in flight');
    assert.equal(state.held??0,0,'the web build asks without a long-poll hold');
    // A visible, focused view of a finished session marks it seen.
    await page.bringToFront();
    await page.locator('[data-session-key="local:session-finished"]').click();
    await page.getByTestId('session-directory-dialog').waitFor({state:'visible'});
    await page.waitForFunction(()=>document.querySelector('[data-testid="workroom-readable-screen"]')?.textContent.includes('Fixture terminal')??true);
    await page.waitForTimeout(1800);
    assert.ok(state.seen.includes('session-finished'),`seen was sent for the shown finished session: ${JSON.stringify(state.seen)}`);
    assert.ok(!state.seen.includes('session-asking-01'),'a session not shown is never marked seen');
    await page.getByTestId('session-directory-dialog-close').click();
    // A hidden document stops asking once the request in flight answers.
    await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{value:'hidden',configurable:true});document.dispatchEvent(new Event('visibilitychange'));});
    await page.waitForTimeout(1200);const hiddenCount=state.activity;await page.waitForTimeout(2500);
    assert.equal(state.activity,hiddenCount,'no activity requests while the window is hidden');
    await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{value:'visible',configurable:true});document.dispatchEvent(new Event('visibilitychange'));});
    await page.waitForTimeout(1200);
    assert.ok(state.activity>hiddenCount,'showing the window resumes the long-poll');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'No horizontal page overflow');
    for(const theme of ['gray','dark']){await page.evaluate(theme=>document.documentElement.dataset.appTheme=theme,theme);await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(shots,`directory-activity-${viewport.width}-${theme}.png`)});}
    assert.deepEqual(errors,[],'No React or browser errors');assert.deepEqual(external,[],'No external access');assert.deepEqual(unexpected,[],'Every API request is mocked');
    results.push({viewport,passed:true,firstRowTop:top,maxInFlight:state.maxInFlight,activityRequests:state.activity,checks:['four-distinct-labels','attention-order','summary-attention','live-above-fold-with-50-saved','single-in-flight','seen-on-shown','hidden-pause','resume']});
    await context.close();
  }
  {
    // A pop-out's OS title carries its session's state; a focused pop-out showing a finished turn marks it seen.
    const context=await browser.newContext({viewport:{width:1000,height:760},serviceWorkers:'block'}),errors=[],external=[],seen=[];
    const live=activity.map(entry=>({...entry}));let inFlight=0,maxInFlight=0;
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());if(url.origin!==origin){external.push(url.origin);return route.abort();}
      if(!url.pathname.startsWith('/api/'))return route.continue();
      const body=route.request().postDataJSON()??{};
      if(url.pathname==='/api/ports')return route.fulfill({json:projects.map((project,index)=>({id:project.targetId,name:project.label,folderPath:'/Users/fixture/project-'+index}))});
      if(url.pathname==='/api/agent-runtime/targets')return route.fulfill({json:{protocolVersion:'agentstoz-tasks-v2',complete:true,targets:projects.map(project=>({...project,branch:null,locked:false,worktreeCapable:false}))}});
      if(url.pathname==='/api/agent-dialogue/control')return route.fulfill({json:{success:true,inside:false,deviceId:'local-device-one',devices:[],unread:0,lastMessageAt:null}});
      if(url.pathname==='/api/agent-runtime/terminals'){
        if(body.operation==='activity'){inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);if(body.after)await new Promise(done=>setTimeout(done,500));inFlight--;return route.fulfill({json:{activity:{bootId,cursor:4,reset:!body.after,sessions:live,events:[]}}});}
        if(body.operation==='seen'){seen.push(body.sessionId);return route.fulfill({json:{seen:true}});}
        if(body.operation==='list')return route.fulfill({json:{sessions}});
        const selected=sessions.find(item=>item.id===body.sessionId);
        if(body.operation==='read'&&selected)return route.fulfill({json:{session:selected,chunks:body.after?[]:[{seq:1,text:'Fixture terminal\r\n› '}],nextCursor:1,truncated:false,hasMore:false}});
        if(selected)return route.fulfill({json:{session:selected}});
        if(body.operation==='accounts')return route.fulfill({json:{accounts:{agent:body.agent,selectedAccountId:'host-default',items:[{id:'host-default',agent:body.agent,label:'현재 CLI 계정',authState:'unknown',checkedAt:null,loginState:'idle'}]}}});
      }
      // Footer, VOC and memory reads are not under test here.
      return route.fulfill({status:503,json:{error:'Fixture API blocked'}});
    });
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+'/?workroom-popout=1&session=session-asking-01&target=proj-alpha-001&agent=codex&bypass=0');
    await page.waitForFunction(()=>document.title.startsWith('● 응답 필요 · ')&&document.title.includes('알파 서비스'),undefined,{timeout:20_000})
      .catch(async error=>{throw new Error(`${error.message} title=${await page.title()} errors=${JSON.stringify(errors)}`);});
    assert.equal(seen.length,0,'a question is never marked seen');
    live[0]={...live[0],state:'turn-finished',exact:true,source:'transcript'};
    await page.bringToFront();
    await page.waitForFunction(()=>document.title.startsWith('✓ 완료 · '),undefined,{timeout:10_000});
    for(const deadline=Date.now()+4000;Date.now()<deadline&&!seen.length;)await new Promise(done=>setTimeout(done,100));
    assert.deepEqual([...new Set(seen)],['session-asking-01'],'the focused pop-out marks its finished session seen');
    live[0]={...live[0],state:'turn-finished',exact:false,source:'screen'};
    await page.waitForFunction(()=>document.title.startsWith('◦ 응답 멈춤 · '),undefined,{timeout:10_000});
    assert.equal(maxInFlight,1,'the pop-out window keeps one activity request in flight');
    assert.deepEqual(external,[],'No external access');
    assert.deepEqual(errors,[],'No React or browser errors');
    results.push({popout:true,passed:true,checks:['title-needs-answer','title-finished-exact','title-heuristic','seen-on-focused-popout','single-in-flight']});
    await context.close();
  }
  await writeFile(join(shots,'directory-activity-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({passed:results.length,failed:0,results,evidence:shots},null,2));
}catch(error){console.error(error);process.exitCode=1;}
finally{await browser?.close();await vite?.close();await rm(scratch,{recursive:true,force:true});}
