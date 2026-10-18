import {chromium,webkit} from 'playwright';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {TesterAgentHost} from '../src/testerAgentHost';import {resolveSystemPython} from '../src/pythonExecutable';
const temp=mkdtempSync(join(tmpdir(),'agentstoz-persona-ui-'));let host,server;
const built=await Bun.build({entrypoints:['tests/fixtures/persona-evolution/panel.tsx'],target:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'}});if(!built.success)throw Error(built.logs.join('\n'));
const js=built.outputs.find(x=>x.path.endsWith('.js')),css=built.outputs.find(x=>x.path.endsWith('.css'));
const output=resolve('.agentstoz/maintainer/rebuild-20261014/persona-ui');mkdirSync(output,{recursive:true});
try{for(const [name,engine] of Object.entries({chromium,webkit})){
 const root=join(temp,name);mkdirSync(root);mkdirSync(join(root,'tests'));mkdirSync(join(root,'src'));
 writeFileSync(join(root,'tests/test_core.py'),'import unittest\nclass Core(unittest.TestCase):\n def test_ok(self): self.assertEqual(2+2,4)\n');
 for(const args of [['init','-q'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','Fixture']])assert.equal(Bun.spawnSync(['git','-C',root,...args]).exitCode,0);
 host=new TesterAgentHost({directory:join(temp,name+'-data'),runner:resolve('scripts/agentstoz-maintainer.py'),python:resolveSystemPython,resolve:async request=>{assert.equal(request.portId,'fixture-project');return {root,label:'시험 프로젝트',targets:[{id:'fixture-project',label:'시험 프로젝트'}]};},lease:async()=>({release(){}})});
 const plan=(await host.perform({operation:'plan',portId:'fixture-project'})).plan;await host.perform({operation:'apply',portId:'fixture-project',revision:plan.revision});
 const marker=join(root,'ran');writeFileSync(join(root,'.gitignore'),'.agentstoz/maintainer/\nran\n');writeFileSync(join(root,'src/feature.ts'),'new search feature');
 writeFileSync(join(root,'.agentstoz/maintainer.json'),JSON.stringify({schemaVersion:1,profiles:{quick:['search']},checks:[{id:'search',argv:['{python}','-c',`from pathlib import Path;Path(${JSON.stringify(marker)}).write_text('ran')`],covers:['프로젝트 목록에서 검색하기'],paths:['src/feature.ts'],evidence:'python-behavioral-tests'}]}));
 writeFileSync(join(root,'README.md'),'이 프로젝트에는 게임 초보자의 첫 사용 여정이 있다.');
 const roleContext=(await host.perform({operation:'persona-review',portId:'fixture-project'})).personaEvolution;
 await host.perform({operation:'persona-propose',portId:'fixture-project',revision:roleContext.context.revision,role:'게임 초보자',reason:'README의 첫 사용 여정',goal:'도움말로 첫 기능을 이해한다',situation:'용어를 모른다',journey:['도움말을 읽는다','기능을 선택한다'],successCriteria:['다음 행동을 이해한다'],sourcePaths:['README.md'],checkIds:[]});
 let requests=[],loseCreateResponse=true;
 server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async request=>{const path=new URL(request.url).pathname;
  if(path==='/change'){writeFileSync(join(root,'src/feature.ts'),'another search feature');return new Response('changed');}
  if(path==='/template-change'){const templatePath=join(root,'.agentstoz/personas/common/first-time-user.json'),template=JSON.parse(readFileSync(templatePath,'utf8'));template.perspective+=' 새로운 공통 관점';writeFileSync(templatePath,JSON.stringify(template));return new Response('changed');}
  if(path==='/tester'){const body=await request.json();requests.push(body);try{const result=await host.perform(body);if(body.operation==='persona-create'&&loseCreateResponse){loseCreateResponse=false;return Response.json({success:false,error:'등록 응답 유실 시험'},{status:500});}return Response.json({success:true,...result});}catch(e){return Response.json({success:false,error:e.message},{status:409});}}
  if(path==='/app.js')return new Response(js,{headers:{'Content-Type':'text/javascript'}});if(path==='/app.css')return new Response(css,{headers:{'Content-Type':'text/css'}});
  return new Response('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/app.js"></script>',{headers:{'Content-Type':'text/html'}});
 }});
 const browser=await engine.launch();try{
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(server.url.toString());
  await page.getByText('개발 맥락에 맞는 페르소나 확장',{exact:true}).click();await page.getByRole('button',{name:'맥락에서 후보 제안',exact:true}).click();
  await page.getByRole('button',{name:/^게임 초보자 ·/}).click();
  await page.getByTestId('tester-contextual-candidate').getByText('필요 이유 · README의 첫 사용 여정',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'검토한 목표·검사 연결 적용',exact:true}).isDisabled(),true);
  assert.equal(existsSync(marker),false);assert.equal(existsSync(join(root,'.agentstoz/personas.json')),false);
  await page.getByRole('button',{name:/^사용자가 프로젝트 목록에서 검색하기/}).click();assert.equal(existsSync(marker),false);assert.equal(existsSync(join(root,'.agentstoz/personas.json')),false);
  await page.getByRole('button',{name:'AI로 맥락 검토 준비',exact:true}).click();await page.getByTestId('tester-explore-open-draft').click();await page.getByTestId('prepared-draft').filter({hasText:'카탈로그를 직접 덮어쓰거나'}).waitFor();assert.equal(existsSync(marker),false);
  const goal=page.getByLabel('페르소나의 사용자 목표',{exact:true});await goal.fill('키보드로 프로젝트를 찾는 사용자');await fetch(server.url+'change');
  await page.getByRole('button',{name:'검토한 목표·검사 연결 적용',exact:true}).click();await page.getByRole('alert').filter({hasText:'context changed'}).waitFor();assert.equal(existsSync(join(root,'.agentstoz/personas.json')),false);
  await page.getByRole('button',{name:'맥락에서 후보 제안',exact:true}).click();assert.equal(await goal.inputValue(),'키보드로 프로젝트를 찾는 사용자');
  await page.getByRole('button',{name:'검토한 목표·검사 연결 적용',exact:true}).click();await page.getByText('페르소나를 등록했습니다. 실제 페르소나 검사를 실행해야 결과를 확인할 수 있습니다.',{exact:true}).waitFor();
  const catalog=JSON.parse(readFileSync(join(root,'.agentstoz/personas.json'),'utf8'));assert.equal(catalog.personas.length,1);assert.deepEqual(catalog.personas[0].tests,[{check:'search',kind:'contract'}]);assert.equal(existsSync(marker),false);
  await page.getByTestId('tester-personas-run').click();await page.getByTestId('tester-result').getByText('선택한 검사 통과',{exact:true}).first().waitFor();assert.equal(existsSync(marker),true);
  const shared=page.getByTestId('tester-common-personas');await shared.getByRole('button',{name:/처음 사용자/}).click();
  const projectGoal='새 Mac에서 첫 프로젝트를 찾는 사용자';await shared.getByLabel('프로젝트 사용자 목표',{exact:true}).fill(projectGoal);
  await shared.getByLabel('페르소나 시작 상황',{exact:true}).fill('처음 설치한 Mac에서 프로젝트 이름만 알고 있다');
  await shared.getByLabel('페르소나 사용자 여정',{exact:true}).fill('프로젝트 목록을 연다\n이름을 검색한다\n프로젝트를 연다');
  await shared.getByLabel('페르소나 성공 기준',{exact:true}).fill('검색한 프로젝트를 구분하고 열 수 있다');
  await shared.getByRole('checkbox').first().check();const runRequests=requests.filter(r=>r.operation==='start').length;
  await shared.getByRole('button',{name:'프로젝트 페르소나 만들기',exact:true}).click();await page.getByRole('alert').filter({hasText:'등록 응답 유실 시험'}).waitFor();
  await shared.getByRole('button',{name:'같은 등록 요청 다시 확인',exact:true}).click();await shared.getByRole('status').filter({hasText:'프로젝트 페르소나를 등록했습니다'}).waitFor();
  const extended=JSON.parse(readFileSync(join(root,'.agentstoz/personas.json'),'utf8'));assert.equal(extended.personas.length,2);
  const projectPersona=extended.personas.find(p=>p.extends==='first-time-user');assert.equal(projectPersona.goal,projectGoal);assert.deepEqual(projectPersona.journey,['프로젝트 목록을 연다','이름을 검색한다','프로젝트를 연다']);
  assert.equal(requests.filter(r=>r.operation==='start').length,runRequests,'creation never runs tests');
  const retries=requests.filter(r=>r.operation==='persona-create');assert.equal(retries.length,2);assert.deepEqual(retries[0],retries[1],'a lost response retries the exact reviewed request');
  await page.getByTestId('tester-persona').filter({hasText:projectGoal}).waitFor();
  await page.getByTestId('tester-personas-run').click();await page.getByTestId('tester-persona').filter({hasText:projectGoal}).filter({hasText:'최근 통과'}).waitFor();
  await fetch(server.url+'template-change');await page.getByRole('button',{name:'상태 다시 확인',exact:true}).click();
  await page.getByTestId('tester-persona').filter({hasText:projectGoal}).filter({hasText:'정의 변경 · 재검사 필요'}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.deepEqual(errors,[]);
  await page.screenshot({path:join(output,name+'.png'),fullPage:true});console.log(name+': real Python discovery, preserved project journeys, shared templates, exact lost-response retry and stale verdict display passed');
 }finally{await browser.close();}
 await host.shutdown();host.store.close();host=undefined;server.stop(true);server=undefined;
}}finally{await host?.shutdown();host?.store.close();server?.stop(true);rmSync(temp,{recursive:true,force:true});}
