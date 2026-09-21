/** Real React UI with a bounded synthetic transport; no user's app or AI is invoked. */
import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
const origin=process.env.WORKROOM_TEST_ORIGIN;
assert.equal(new URL(origin).hostname,'127.0.0.1');assert.notEqual(new URL(origin).port,'3001');
const source=await fetch(origin+'/src/ProjectTesterPanel.tsx').then(r=>r.text());
const main=await fetch(origin+'/src/main.tsx').then(r=>r.text());
const react=source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1];
const dom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];assert.ok(react&&dom);
const html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:14px sans-serif;--line:#ddd;--text-primary:#222;--bg-card:white}button,select{max-width:100%}</style><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(dom)};
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const {ProjectTesterPanel}=await import('/src/ProjectTesterPanel.tsx');
window.fixture={requests:[],sent:[],installation:'absent',configured:true,environmentReady:true,run:null,fail:false,delayed:null};
const report=()=>({runId:'20260914T010000Z-1234abcd',profile:'quick',state:window.fixture.run?.state??'passed',startedAt:'2026-09-14T01:00:00.250Z',checks:[{id:'core',state:'passed',output:'Core test OK',evidence:'fixture'}]});
const transport=async r=>{const f=window.fixture;f.requests.push(r);
 if(r.operation==='status'){const s={installation:f.installation,availableVersion:'1.1.0',installedVersion:f.installation==='ready'?'1.1.0':null,configurationRevision:'a'.repeat(64),profiles:[{id:'quick',checks:['core'],configured:f.configured},{id:'full',checks:['core'],configured:true}],defaultProfile:'quick',environmentReady:f.environmentReady,problem:f.environmentReady?undefined:'Python 3.9 이상을 준비하세요.',freshness:'current',instructionsConnected:true,memoryLinked:true,limitations:[],targets:[{id:'project-1234',label:'Project'},{id:'worktree-1234',label:'Feature worktree'}],latest:f.run?.report??null,latestRun:f.run,active:f.run&&['running','canceling'].includes(f.run.state)?f.run:null};if(f.delayed)await new Promise(resolve=>f.delayed=resolve);return {status:s};}
 if(r.operation==='plan')return {plan:{revision:'b'.repeat(64),files:['scripts/agentstoz-maintainer.py','.agentstoz/maintainer.json','AGENTS.md'],recovering:false}};
 if(r.operation==='apply'){f.installation='ready';return {applied:true};}
 if(r.operation==='start'){f.run={id:'20260914T010000Z-1234abcd',state:'running',profileId:r.profileId,createdAt:'2026-09-14T01:00:00Z',origin:'app'};if(f.fail){f.fail=false;throw Error('응답 유실');}return {run:{...f.run}};}
 if(r.operation==='read'){if(f.run.state==='passed')f.run.report=report();return {run:{...f.run}};}
 if(r.operation==='cancel'){f.run.state='interrupted';return {run:{...f.run}};}
 if(r.operation==='handoff')return {handoff:'프로젝트 테스트를 '+r.mode+' 합니다. 기억을 읽고 Python 검사를 실행하세요.'};
};
const root=ReactDOM.createRoot(document.getElementById('root'));window.revealTester=(revealKey=1)=>root.render(React.createElement('div',null,React.createElement('div',{style:{height:1500}}),React.createElement(ProjectTesterPanel,{initialOpen:true,revealKey,portId:'project-1234',projectName:'Project',transport}),React.createElement('div',{style:{height:1000}})));
root.render(React.createElement(ProjectTesterPanel,{portId:'project-1234',projectName:'Project',transport,onSend:async(...args)=>window.fixture.sent.push(args)}));
</script>`;
for(const [engineName,engine] of [['chromium',chromium],['webkit',webkit]]){
 const browser=await engine.launch({headless:true});
 try{for(const scenario of ['setup-run','lost-response','cancel','configure','missing-python','targets','handoff','stale-status','control-reveal']){
  const context=await browser.newContext({viewport:{width:393,height:852},hasTouch:true,serviceWorkers:'block'});
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==origin)return route.abort();if(u.pathname==='/__tester')return route.fulfill({contentType:'text/html',body:html});if(u.pathname.startsWith('/api/'))throw Error('Unexpected live API');return route.continue();});
  await page.goto(origin+'/__tester');const toggle=page.getByRole('button',{name:/테스터 에이전트/});await toggle.waitFor();assert.equal(await page.evaluate(()=>window.fixture.requests.length),0);
  if(scenario==='control-reveal'){await page.evaluate(()=>window.revealTester());await page.getByRole('button',{name:'테스터 설정하기',exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('[data-testid=project-tester]').getBoundingClientRect().top<100);await toggle.tap();await page.evaluate(()=>{window.scrollTo(0,0);window.revealTester(2);});await page.getByRole('button',{name:'테스터 설정하기',exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('[data-testid=project-tester]').getBoundingClientRect().top<100);const statusCount=await page.evaluate(()=>window.fixture.requests.filter(r=>r.operation==='status').length);await page.evaluate(()=>{window.scrollTo(0,0);window.revealTester(3);});await page.waitForFunction(count=>window.fixture.requests.filter(r=>r.operation==='status').length>count,statusCount);await page.waitForFunction(()=>document.querySelector('[data-testid=project-tester]').getBoundingClientRect().top<100);assert.deepEqual(errors,[]);console.log(engineName,scenario,'PASS');await context.close();continue;}
  if(scenario!=='setup-run')await page.evaluate(()=>window.fixture.installation='ready');
  if(scenario==='configure')await page.evaluate(()=>window.fixture.configured=false);
  if(scenario==='missing-python')await page.evaluate(()=>{window.fixture.environmentReady=false;window.fixture.installation='unavailable';});
  if(scenario==='stale-status')await page.evaluate(()=>window.fixture.delayed=true);
  await toggle.tap();
  if(scenario==='stale-status'){
    await page.waitForFunction(()=>typeof window.fixture.delayed==='function');await toggle.tap();await page.evaluate(()=>{window.fixture.installation='absent';window.fixture.delayed();window.fixture.delayed=null;});await toggle.tap();await page.getByRole('button',{name:'테스터 설정하기',exact:true}).waitFor();
  }else if(scenario==='missing-python'){
    await page.getByRole('button',{name:'AI로 실행 환경 준비',exact:true}).tap();await page.getByLabel('테스터 AI 인계문').waitFor();assert.equal(await page.getByRole('button',{name:'테스트 실행',exact:true}).count(),0);
  }else if(scenario==='configure'||scenario==='handoff'){
    await page.getByRole('button',{name:scenario==='configure'?'AI로 테스트 구성':'AI로 개선',exact:true}).tap();await page.getByLabel('테스터 AI 인계문').waitFor();
    if(scenario==='handoff'){await page.getByRole('button',{name:'워크룸으로 전달',exact:true}).tap();await page.getByLabel('테스터 AI 선택').selectOption('hermes');await page.getByRole('button',{name:'인계문 복사·워크룸 열기',exact:true}).tap();const sent=await page.evaluate(()=>window.fixture.sent);assert.equal(sent[0][0],'codex');assert.equal(sent[1][0],'hermes');}
  }else{
    if(scenario==='setup-run'){await page.getByRole('button',{name:'테스터 설정하기',exact:true}).tap();await page.getByRole('button',{name:'설정 적용',exact:true}).tap();}
    if(scenario==='targets'){await page.getByLabel('검사할 작업 폴더').selectOption('worktree-1234');await page.getByLabel('검사 범위').selectOption('full');}
    if(scenario==='lost-response')await page.evaluate(()=>window.fixture.fail=true);
    const start=page.getByRole('button',{name:'테스트 실행',exact:true});await start.waitFor();assert.ok((await start.boundingBox()).height>=44);await start.tap();
    if(scenario==='lost-response'){await page.getByRole('alert').waitFor();await page.getByRole('button',{name:'실행 결과 다시 확인',exact:true}).tap();const requests=await page.evaluate(()=>window.fixture.requests.filter(r=>r.operation==='start'));assert.equal(requests[0].requestId,requests[1].requestId);}
    if(scenario==='cancel'){await page.getByRole('button',{name:'검사 취소',exact:true}).tap();await page.getByTestId('tester-result').getByText('검사 중단',{exact:true}).waitFor();}
    else{await page.evaluate(()=>window.fixture.run.state='passed');await page.getByTestId('tester-result').getByText('선택한 검사 통과',{exact:true}).first().waitFor();await page.getByRole('button',{name:'상태 다시 확인',exact:true}).tap();await page.getByText('core · 선택한 검사 통과',{exact:true}).tap();await page.getByText('Core test OK',{exact:true}).waitFor();assert.match(await page.getByTestId('tester-result').innerText(),/앱 실행/);}
    if(scenario==='targets'){const request=await page.evaluate(()=>window.fixture.requests.find(r=>r.operation==='start'));assert.equal(request.workspaceTargetId,'worktree-1234');assert.equal(request.profileId,'full');}
  }
  assert.deepEqual(errors,[]);console.log(engineName,scenario,'PASS');await context.close();
 }}finally{await browser.close();}
}
