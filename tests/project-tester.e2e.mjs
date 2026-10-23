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
const {MemoryTesterUpgrade}=await import('/src/MemoryTesterUpgrade.tsx');
window.fixture={requests:[],sent:[],drafts:[],personas:undefined,legacyPersonaProfile:false,defaultProfile:'quick',installation:'absent',configured:true,environmentReady:true,run:null,fail:false,delayed:null};
const report=()=>({runId:'20260914T010000Z-1234abcd',profile:'quick',state:window.fixture.run?.state??'passed',startedAt:'2026-09-14T01:00:00.250Z',checks:[{id:'core',state:'passed',output:'Core test OK',evidence:'fixture'}]});
const transport=async r=>{const f=window.fixture;f.requests.push(r);
 if(r.operation==='status'){const s={installation:f.installation,availableVersion:'1.1.0',installedVersion:f.installation==='absent'?null:f.installation==='ready'?'1.1.0':'1.0.0',configurationRevision:'a'.repeat(64),projectRevision:'c'.repeat(64),profiles:[{id:'quick',checks:['core'],configured:f.configured},{id:'full',checks:['core'],configured:true},...(f.legacyPersonaProfile?[{id:'persona',checks:['persona-experience'],configured:true}]:[])],defaultProfile:f.defaultProfile,environmentReady:f.environmentReady,problem:f.environmentReady?undefined:'Python 3.9 이상을 준비하세요.',freshness:'current',instructionsConnected:true,memoryLinked:true,limitations:[],targets:[{id:'project-1234',label:'Project'},{id:'worktree-1234',label:'Feature worktree'}],...(f.personas?{personas:f.personas}:{}),latest:f.run?.report??null,latestRun:f.run,active:f.run&&['running','canceling'].includes(f.run.state)?f.run:null};if(f.delayed)await new Promise(resolve=>f.delayed=resolve);return {status:s};}
 if(r.operation==='ensure'){f.installation='ready';return {ensure:{outcome:'installed',installation:'ready'}};}
 if(r.operation==='plan')return {plan:{revision:'b'.repeat(64),files:['scripts/agentstoz-maintainer.py','.agentstoz/maintainer.json','AGENTS.md'],recovering:false}};
 if(r.operation==='apply'){if(f.rejectApply)throw Error('Configuration changed; refresh and retry');f.installation='ready';return {applied:true};}
 if(r.operation==='start'){f.run={id:'20260914T010000Z-1234abcd',state:'running',profileId:r.profileId,createdAt:'2026-09-14T01:00:00Z',origin:'app'};if(f.fail){f.fail=false;throw Error('응답 유실');}return {run:{...f.run}};}
 if(r.operation==='read'){if(f.run.state==='passed')f.run.report=report();return {run:{...f.run}};}
 if(r.operation==='cancel'){f.run.state='interrupted';return {run:{...f.run}};}
 if(r.operation==='handoff'&&r.mode==='explore')return {handoff:'# 페르소나 탐색 브리프 · '+r.personaId+' · 분류: exploratory/observed',exploration:{personaId:r.personaId,class:'exploratory/observed',draftOnly:true,verdict:null}};
 if(r.operation==='handoff')return {handoff:'프로젝트 테스트를 '+r.mode+' 합니다. 기억을 읽고 Python 검사를 실행하세요.'};
};
const root=ReactDOM.createRoot(document.getElementById('root'));window.revealTester=(revealKey=1)=>root.render(React.createElement('div',null,React.createElement('div',{style:{height:1500}}),React.createElement(ProjectTesterPanel,{initialOpen:true,revealKey,portId:'project-1234',projectName:'Project',transport}),React.createElement('div',{style:{height:1000}})));
window.showAutoTester=()=>root.render(React.createElement(ProjectTesterPanel,{autoEnsure:true,portId:'project-1234',projectName:'Project',transport}));
window.showMemoryTester=()=>root.render(React.createElement(MemoryTesterUpgrade,{projects:[{id:'project-1234',name:'Project'},{id:'project-other',name:'Other project'}],transport}));
root.render(React.createElement(ProjectTesterPanel,{portId:'project-1234',projectName:'Project',transport,onSend:async(...args)=>window.fixture.sent.push(args),onDraft:(...args)=>window.fixture.drafts.push(args)}));
</script>`;
for(const [engineName,engine] of [['chromium',chromium],['webkit',webkit]]){
 const browser=await engine.launch({headless:true});
 try{for(const scenario of ['personas','personas-none','auto-ensure','setup-run','lost-response','cancel','configure','missing-python','targets','handoff','stale-status','control-reveal','memory-upgrade','memory-ready-run','memory-conflict','memory-running','memory-switch','memory-failed-apply','memory-absent','memory-unavailable','memory-unsupported']){
  const context=await browser.newContext({viewport:{width:393,height:852},hasTouch:true,serviceWorkers:'block'});
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==origin)return route.abort();if(u.pathname==='/__tester')return route.fulfill({contentType:'text/html',body:html});if(u.pathname.startsWith('/api/'))throw Error('Unexpected live API');return route.continue();});
  await page.goto(origin+'/__tester');const toggle=page.getByRole('button',{name:/테스터 에이전트/});await toggle.waitFor();assert.equal(await page.evaluate(()=>window.fixture.requests.length),0);
  if(scenario==='auto-ensure'){
    await page.evaluate(()=>window.showAutoTester());
    await page.waitForFunction(()=>window.fixture.requests.some(r=>r.operation==='ensure'));
    await toggle.tap();
    await page.getByTestId('tester-installation-status').getByText('최신',{exact:true}).waitFor();
    assert.match(await page.getByTestId('tester-versions').innerText(),/공통 영역 v1.1.0.*앱 제공 v1.1.0/);
    assert.match(await page.getByTestId('tester-project-revision').innerText(),/앱별 영역 rcccccccc.*Git/);
    assert.deepEqual(await page.evaluate(()=>window.fixture.requests.slice(0,3).map(r=>r.operation)),['status','ensure','status']);
    assert.deepEqual(errors,[]);console.log(engineName,scenario,'PASS');await context.close();continue;
  }
  if(scenario.startsWith('memory-')){
    await page.evaluate(scenario=>{
      const f=window.fixture;
      f.installation=scenario==='memory-ready-run'?'ready':scenario==='memory-conflict'?'conflict':scenario==='memory-unsupported'?'unsupported':scenario==='memory-absent'?'absent':scenario==='memory-unavailable'?'unavailable':'needs-update';
      f.environmentReady=scenario!=='memory-unavailable';
      f.rejectApply=scenario==='memory-failed-apply';
      if(scenario==='memory-running')f.run={id:'20260914T010000Z-1234abcd',state:'running',profileId:'quick',createdAt:'2026-09-14T01:00:00Z',origin:'app'};
      if(scenario==='memory-switch')f.delayed=true;
      window.showMemoryTester();
    },scenario);
    const selector=page.getByLabel('테스트 에이전트 관리 프로젝트');await selector.waitFor();
    assert.equal(await page.evaluate(()=>window.fixture.requests.length),0);
    await selector.selectOption('project-1234');
    if(scenario==='memory-switch'){
      await page.waitForFunction(()=>typeof window.fixture.delayed==='function');
      await page.evaluate(()=>{window.oldStatus=window.fixture.delayed;window.fixture.delayed=null;window.fixture.installation='ready';});
      await selector.selectOption('project-other');await page.getByTestId('tester-installation-status').getByText('최신',{exact:true}).waitFor();
      await page.evaluate(()=>window.oldStatus());
      await page.getByRole('button',{name:'상태 다시 확인',exact:true}).tap();
      assert.equal(await page.getByTestId('tester-installation-status').innerText(),'최신');
      assert.equal(await page.getByRole('button',{name:'테스트 에이전트 업그레이드',exact:true}).count(),0);
      assert.equal(await page.evaluate(()=>window.fixture.requests.at(-1).portId),'project-other');
    }else{
      await page.getByTestId('tester-versions').waitFor();
      if(scenario==='memory-ready-run'){
        await page.getByLabel('검사 범위').selectOption('full');
        await page.getByRole('button',{name:'테스트 실행',exact:true}).tap();
        await page.getByTestId('tester-result').waitFor();
        assert.equal(await page.evaluate(()=>window.fixture.requests.find(r=>r.operation==='start')?.profileId),'full');
        assert.deepEqual(errors,[]);console.log(engineName,scenario,'PASS');await context.close();continue;
      }
      assert.equal(await page.getByRole('button',{name:'테스트 실행',exact:true}).count(),0);
      const upgrade=page.getByRole('button',{name:'테스트 에이전트 업그레이드',exact:true});
      if(['memory-conflict','memory-unsupported','memory-unavailable'].includes(scenario)){
        assert.equal(await upgrade.count(),0);
        assert.equal(await page.evaluate(()=>window.fixture.requests.some(r=>['plan','apply','start','handoff'].includes(r.operation))),false);
        if(scenario==='memory-conflict')assert.match(await page.getByTestId('tester-installation-status').innerText(),/직접 수정/);
      }else if(scenario==='memory-running'){
        assert.equal(await upgrade.isDisabled(),true);
        assert.equal(await page.evaluate(()=>window.fixture.requests.some(r=>r.operation==='plan')),false);
      }else{
        if(scenario==='memory-absent')await page.getByRole('button',{name:'테스터 설정하기',exact:true}).tap();
        else {assert.match(await page.getByTestId('tester-versions').innerText(),/v1.0.0.*v1.1.0/);await upgrade.tap();}
        await page.getByText('scripts/agentstoz-maintainer.py',{exact:true}).waitFor();
        assert.equal(await page.evaluate(()=>window.fixture.requests.some(r=>r.operation==='apply')),false);
        await page.getByRole('button',{name:'설정 적용',exact:true}).tap();
        if(scenario==='memory-failed-apply'){
          await page.getByRole('alert').getByText('Configuration changed; refresh and retry',{exact:true}).waitFor();
          assert.equal(await page.getByTestId('tester-installation-status').innerText(),'업데이트 가능');
        }else{
          await page.getByTestId('tester-installation-status').getByText('최신',{exact:true}).waitFor();
          assert.match(await page.getByTestId('tester-versions').innerText(),/v1.1.0.*v1.1.0/);
        }
        const requests=await page.evaluate(()=>window.fixture.requests);
        assert.equal(requests.find(r=>r.operation==='apply').revision,'b'.repeat(64));
        assert.ok(requests.every(r=>r.portId==='project-1234'));
        assert.ok(!requests.some(r=>['start','handoff'].includes(r.operation)));
      }
    }
    assert.deepEqual(errors,[]);console.log(engineName,scenario,'PASS');await context.close();continue;
  }
  if(scenario==='control-reveal'){await page.evaluate(()=>window.revealTester());await page.getByRole('button',{name:'테스터 설정하기',exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('[data-testid=project-tester]').getBoundingClientRect().top<100);await toggle.tap();await page.evaluate(()=>{window.scrollTo(0,0);window.revealTester(2);});await page.getByRole('button',{name:'테스터 설정하기',exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('[data-testid=project-tester]').getBoundingClientRect().top<100);const statusCount=await page.evaluate(()=>window.fixture.requests.filter(r=>r.operation==='status').length);await page.evaluate(()=>{window.scrollTo(0,0);window.revealTester(3);});await page.waitForFunction(count=>window.fixture.requests.filter(r=>r.operation==='status').length>count,statusCount);await page.waitForFunction(()=>document.querySelector('[data-testid=project-tester]').getBoundingClientRect().top<100);assert.deepEqual(errors,[]);console.log(engineName,scenario,'PASS');await context.close();continue;}
  if(scenario==='personas'||scenario==='personas-none'){
    // 탐색은 워크룸 **초안**으로만 나간다(onDraft). 바로 보내는 onSend 는 절대 쓰지 않는다.
    await page.evaluate(scenario=>{const f=window.fixture;f.installation='ready';f.legacyPersonaProfile=true;f.defaultProfile='persona';f.personas=scenario==='personas-none'?{state:'none',catalog:null}:{state:'ready',catalog:'.agentstoz/personas.json',count:2,
      personas:[{id:'newcomer',goal:'처음 연결할 때 실패 원인을 이해한다',contract:1,screen:1,explorable:true,observations:0},{id:'searcher',goal:'프로젝트를 찾는다',contract:1,screen:0,explorable:false,observations:2}],
      latest:{runId:'20260914T010000Z-1234abcd',state:'failed',verdicts:[{id:'newcomer',verdict:'FAIL',contract:1,screen:1},{id:'searcher',verdict:'PASS',contract:1,screen:0}]}};},scenario);
    await toggle.tap();
    const section=page.getByTestId('tester-personas');await section.waitFor();
    if(scenario==='personas-none'){
      await page.getByTestId('tester-personas-none').getByText(/통과도 실패도 아닙니다/).waitFor();
      assert.equal(await page.getByLabel('검사 범위').locator('option[value="persona"]').count(),1,'without a ready catalog, the configured Python profile remains available');
      assert.equal(await page.getByTestId('tester-personas-run').count(),0);assert.equal(await page.getByTestId('tester-persona-explore').count(),0);
      assert.deepEqual(errors,[]);console.log(engineName,scenario,'PASS');await context.close();continue;
    }
    assert.equal(await page.getByLabel('검사 범위').locator('option[value="persona"]').count(),0,'the duplicate Python wrapper is hidden when the verdict-producing persona run is ready');
    assert.equal(await page.getByLabel('검사 범위').inputValue(),'quick','a hidden default profile falls back to a visible test');
    assert.equal(await page.getByTestId('tester-personas-run').count(),1,'the catalog has one canonical run action');
    assert.match(await section.innerText(),/최근 실패/);assert.match(await section.innerText(),/화면 근거 없음/);assert.match(await section.innerText(),/탐색 기록 2건\(판정 아님\)/);
    await page.getByTestId('tester-persona-explore').first().tap();
    await page.getByLabel('페르소나 탐색 초안').waitFor();
    assert.equal(await page.getByRole('button',{name:'워크룸으로 전달',exact:true}).count(),0,'an exploration brief is never sent directly');
    await page.getByTestId('tester-explore-open-draft').tap();
    const handed=await page.evaluate(()=>({drafts:window.fixture.drafts,sent:window.fixture.sent,request:window.fixture.requests.find(r=>r.operation==='handoff')}));
    assert.equal(handed.sent.length,0);assert.equal(handed.drafts.length,1);assert.match(handed.drafts[0][0],/exploratory\/observed/);
    assert.deepEqual([handed.request.mode,handed.request.personaId],['explore','newcomer']);
    const run=page.getByTestId('tester-personas-run');assert.ok((await run.boundingBox()).height>=44);await run.tap();
    await page.getByTestId('tester-result').waitFor();
    assert.equal(await page.evaluate(()=>window.fixture.requests.find(r=>r.operation==='start')?.profileId),'personas');
    assert.deepEqual(errors,[]);console.log(engineName,scenario,'PASS');await context.close();continue;
  }
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
