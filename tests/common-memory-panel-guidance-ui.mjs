/**
 * What the cloud common-memory panel tells a person, on the isolated fixture (real Chromium/WebKit; no 3001, no Supabase):
 * - a cloud that is not connected or not migrated says where to go (the Mac's settings button), and a failed list offers a reload;
 * - the first list load is visible, and an empty first visit explains what a common memory is instead of reading as a failed search;
 * - a group made from an intersection topic keeps the previous-model section collapsed, and its card shows pending candidates;
 * - confirmed knowledge that no long-term memory links is called out, with a button that opens the link picker (never pre-checked),
 *   and on the phone's lean read that button loads the picker's list the way opening the disclosure does;
 * - an update draft for a links-only topic gives the AI its linked memories as sources;
 * - list cards follow the panel width, and without OPS the help matches the screen and creation comes first.
 */
import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {commonMemoryUiFixture} from './fixtures/common-memory/server.ts';
const json=async(url,body)=>(await fetch(url,body===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
const until=async(check,label,ms=10000)=>{const end=Date.now()+ms;for(;;){if(await check())return;if(Date.now()>end)throw Error('timed out: '+label);await new Promise(r=>setTimeout(r,50));}};
const B='22222222-2222-4222-8222-222222222222';
const report=[];
for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]){
 const fixture=await commonMemoryUiFixture(),browser=await engine.launch();
 const stats=async()=>(await json(fixture.url+'/fixture/stats')).groups;
 try{
  const page=await browser.newPage({viewport:{width:1000,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
  await page.route('**/*',r=>new URL(r.request().url()).origin===fixture.url?r.continue():r.abort());
  const panel=page.getByTestId('common-memory-panel'),manage=panel.getByRole('button',{name:'공통기억 관리',exact:true}),reload=panel.getByRole('button',{name:'다시 불러오기',exact:true});

  // Cloud not connected / not migrated: the cause, where to go, and a reload.
  for(const [code,text] of [['COMMON_MEMORY_CLOUD_REQUIRED',/장기기억 연결 설정에서 클라우드를 연결한 뒤 「다시 불러오기」/],['COMMON_MEMORY_MIGRATION_REQUIRED',/공통기억 표를 최신으로 맞춰야 합니다/]]){
   await page.route(fixture.url+'/api/common-memory/list',route=>route.fulfill({status:503,json:{success:false,code,error:'클라우드 확인 실패 시험'}}));
   await page.goto(fixture.url);await manage.click();
   const setup=panel.getByTestId('common-memory-cloud-setup');await setup.waitFor();assert.match(await setup.innerText(),text);await reload.waitFor();
   await setup.getByRole('button',{name:'장기기억 연결 설정 열기',exact:true}).click();assert.equal(await page.title(),'opened:cloud-settings');
   await page.unroute(fixture.url+'/api/common-memory/list');
  }
  // Any other list failure: no setup block, the header button reloads.
  await json(fixture.url+'/fixture/fail',{op:'list',on:true});await page.goto(fixture.url);await manage.click();await reload.waitFor();
  assert.equal(await panel.getByTestId('common-memory-cloud-setup').count(),0);await json(fixture.url+'/fixture/fail',{op:'list',on:false});

  // The load is visible; an empty first visit explains itself, while a search that matches nothing still says so.
  await json(fixture.url+'/fixture/delay',{op:'list',ms:1200});await reload.click();
  const opening=panel.getByTestId('common-memory-opening');await opening.waitFor();assert.equal(await opening.innerText(),'공통기억 목록을 불러오는 중…');
  await json(fixture.url+'/fixture/delay',{op:'list',ms:0});
  const empty=panel.getByTestId('common-memory-list-empty');await empty.waitFor();assert.equal(await opening.count(),0);
  assert.match(await empty.innerText(),/아직 공통기억이 없습니다/);assert.match(await empty.innerText(),/프로젝트의 AI가 작업 전에 함께 읽습니다/);assert.doesNotMatch(await empty.innerText(),/불러온 목록|검색어/);
  const search=panel.getByLabel('공통기억 검색',{exact:true});await search.fill('없는 표식');assert.match(await empty.innerText(),/불러온 목록/);await search.fill('');

  // A topic group: the previous-model section stays collapsed, no unread warning before any knowledge exists.
  await panel.getByRole('button',{name:'교집합·카테고리 후보 확인',exact:true}).click();
  const topic=panel.getByTestId('common-memory-cloud-topics').locator('article').filter({hasText:'게임·상호작용'});
  await topic.getByRole('button',{name:'이 주제로 만들고 AI 정리 요청 준비',exact:true}).click();
  const draft=page.getByTestId('common-memory-workroom-draft');await draft.getByRole('heading',{name:'게임·상호작용 · 기억 정리',exact:true}).waitFor();
  await draft.getByRole('button',{name:'공통기억으로 돌아가기',exact:true}).click();await manage.click();await panel.getByRole('heading',{name:'게임·상호작용 관리·수정',exact:true}).waitFor();
  const legacySection=panel.getByTestId('common-memory-legacy');await legacySection.waitFor();assert.equal(await legacySection.evaluate(e=>e.open),false);
  const warning=panel.getByTestId('common-memory-unread-warning');assert.equal(await warning.count(),0);

  // Candidates show on the list card.
  await json(fixture.url+'/fixture/propose-source',{});await panel.getByRole('button',{name:'진행 내용 확인',exact:true}).click();await panel.getByText('공통 게임 입력 검증 · 검토 후보',{exact:true}).waitFor();
  await panel.getByRole('button',{name:'목록으로 돌아가기',exact:true}).click();
  const topicCard=panel.getByRole('button',{name:'게임·상호작용 · 기억 항목 0개 · 검토 후보 2개',exact:true});await topicCard.waitFor();
  assert.equal(await topicCard.getByTestId('common-memory-card-candidates').innerText(),'검토 후보 2개');
  assert.equal(await topicCard.locator('b').first().evaluate(e=>[...e.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('')),'게임·상호작용');
  assert.match(await topicCard.innerText(),/가져올 기억 2개 · 연결된 장기기억 0개/);

  // Confirmed knowledge with no linked memory: warned, and the button opens the picker without choosing for the person.
  await topicCard.click();await panel.getByRole('button',{name:'후보 선택 · 최대 16개',exact:true}).click();await panel.getByRole('button',{name:'선택한 2개 검토 후 확정',exact:true}).click();
  await panel.getByText('공통 게임 입력 검증 · 확정',{exact:true}).waitFor();await warning.waitFor();
  assert.match(await warning.innerText(),/아직 어떤 장기기억에도 연결되지 않아 프로젝트 AI가 이 내용을 읽지 않습니다/);
  assert.equal(await panel.getByText('공통 항목을 연결된 장기기억에서 함께 읽습니다.',{exact:true}).count(),0);
  const picker=panel.getByTestId('meta-memory-use-projects');assert.equal(await picker.isVisible(),false);
  await warning.getByRole('button',{name:'연결할 장기기억 선택',exact:true}).click();
  const linkA=picker.getByRole('checkbox',{name:/등록 A/});await linkA.waitFor();assert.equal(await linkA.isChecked(),false);
  assert.deepEqual((await stats()).find(g=>g.state.name==='게임·상호작용').state.portableKnowledge.current.members,[]);
  await linkA.check();await picker.getByRole('button',{name:'연결·정보 저장',exact:true}).click();
  await warning.waitFor({state:'detached'});await panel.getByText('공통 항목을 연결된 장기기억에서 함께 읽습니다.',{exact:true}).waitFor();

  // A knowledge group created without links is warned at once; once linked, its AI draft reads the linked memory.
  await panel.getByRole('button',{name:'목록으로 돌아가기',exact:true}).click();await panel.getByRole('button',{name:'공통기억 만들기',exact:true}).click();
  const knowledge=panel.getByTestId('meta-common-memory-panel');await knowledge.getByLabel('공통기억 이름',{exact:true}).fill('연결 없는 규칙');await knowledge.getByRole('button',{name:'공통기억 만들기',exact:true}).click();
  await panel.getByRole('heading',{name:'연결 없는 규칙 관리·수정',exact:true}).waitFor();await warning.waitFor();assert.equal(await panel.getByTestId('common-memory-legacy').count(),0);
  await warning.getByRole('button',{name:'연결할 장기기억 선택',exact:true}).click();await picker.getByRole('checkbox',{name:/등록 B/}).check();await picker.getByRole('button',{name:'연결·정보 저장',exact:true}).click();await warning.waitFor({state:'detached'});
  await panel.getByRole('button',{name:'AI로 정리·업데이트',exact:true}).click();await draft.getByRole('heading',{name:'연결 없는 규칙 · 기억 정리',exact:true}).waitFor();
  const linkedDraft=await draft.locator('pre').innerText(),context=JSON.parse(linkedDraft.trim().split('\n').at(-1));
  assert.match(linkedDraft,/연결된 장기기억\(cloudSources\)을 원본으로 읽고/);assert.deepEqual(context.cloudSources.map(s=>s.memoryId),[B]);assert.deepEqual(context.group.sourceMemoryIds,[]);
  assert.deepEqual((await stats()).find(g=>g.state.name==='연결 없는 규칙').state.sourceMemoryIds,[]);
  await draft.getByRole('button',{name:'공통기억으로 돌아가기',exact:true}).click();

  // Cards follow the panel's width: two columns in a wide panel, one in a narrow one at the same window size.
  await manage.click();const back=panel.getByRole('button',{name:'목록으로 돌아가기',exact:true});await back.waitFor();await back.click();
  const cards=[panel.getByRole('button',{name:/^게임·상호작용/}),panel.getByRole('button',{name:/^연결 없는 규칙/})];await cards[1].waitFor();
  const lefts=async()=>new Set(await Promise.all(cards.map(async c=>Math.round((await c.boundingBox()).x))));
  assert.equal((await lefts()).size,2);
  await page.addStyleTag({content:'main{max-width:560px!important}'});await until(async()=>(await lefts()).size===1,'one column in a narrow panel');

  // Without OPS: creation comes first, the help matches what is on screen, and the Mac offers its settings.
  await page.goto(fixture.url+'/?no-ops=1');await manage.click();await panel.getByRole('button',{name:'관리 닫기',exact:true}).waitFor();
  const help=panel.getByTestId('common-memory-workroom-help');assert.match(await help.innerText(),/교집합 후보는 아래에서/);
  const createY=(await panel.getByRole('button',{name:'공통기억 만들기',exact:true}).boundingBox()).y,aiY=(await panel.getByRole('button',{name:'AI로 공통기억 추천받기',exact:true}).boundingBox()).y;assert.ok(createY<aiY,'creation comes before the disabled AI action');
  await panel.getByRole('button',{name:'아젠투지 설정 열기',exact:true}).click();assert.equal(await page.title(),'opened:ops');
  await panel.getByRole('button',{name:/^연결 없는 규칙/}).click();await panel.getByRole('heading',{name:'연결 없는 규칙 관리·수정',exact:true}).waitFor();
  assert.match(await help.innerText(),/기억 항목은 아래에서 직접 작성할 수 있습니다/);assert.doesNotMatch(await help.innerText(),/교집합/);
  // A third, unlinked group for the phone.
  await back.click();await panel.getByRole('button',{name:'공통기억 만들기',exact:true}).click();await knowledge.getByLabel('공통기억 이름',{exact:true}).fill('휴대폰 연결 시험');await knowledge.getByRole('button',{name:'공통기억 만들기',exact:true}).click();await panel.getByRole('heading',{name:'휴대폰 연결 시험 관리·수정',exact:true}).waitFor();
  assert.deepEqual(errors,[]);await page.close();

  // Phone: the relay load is visible, and on the lean read the warning's button loads the picker's list.
  const phonePage=await browser.newPage({viewport:{width:390,height:844}}),phoneErrors=[];phonePage.on('pageerror',e=>phoneErrors.push(e.message));phonePage.setDefaultTimeout(15000);
  await phonePage.route('**/*',r=>new URL(r.request().url()).origin===fixture.url?r.continue():r.abort());
  await json(fixture.url+'/fixture/delay',{op:'list',ms:1500});await phonePage.goto(fixture.url+'/?phone=1');
  const phone=phonePage.getByTestId('remote-cloud-common-memory');
  await phone.getByTestId('common-memory-opening').filter({hasText:'연결한 Mac을 거쳐 공통기억 목록을 불러오는 중…'}).waitFor();await json(fixture.url+'/fixture/delay',{op:'list',ms:0});
  await phone.getByRole('button',{name:/^휴대폰 연결 시험/}).click();await phone.getByRole('heading',{name:'휴대폰 연결 시험 관리·수정',exact:true}).waitFor();
  const phoneWarning=phone.getByTestId('common-memory-unread-warning');await phoneWarning.waitFor();
  await until(async()=>(await phoneWarning.getByRole('button',{name:'연결할 장기기억 선택',exact:true}).isEnabled()),'the knowledge panel finished reading');
  await json(fixture.url+'/fixture/requests/reset',{});await phoneWarning.getByRole('button',{name:'연결할 장기기억 선택',exact:true}).click();
  await until(async()=>(await json(fixture.url+'/fixture/requests'))['knowledge:projects']===1,'the picker loads the deferred project list');
  await phone.getByTestId('meta-memory-use-projects').getByRole('checkbox',{name:/등록 A/}).waitFor();
  assert.equal(await phonePage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);assert.deepEqual(phoneErrors,[]);
  report.push({engine:name,journeys:['cloud-setup-guidance','list-failure-reload','visible-first-load','first-visit-empty-state','topic-legacy-collapsed','card-candidate-count','unread-warning-opens-picker','links-only-draft-sources','panel-width-columns','no-ops-order-and-help','phone-relay-loading','phone-lean-read-picker-load'],errors:0});
 }finally{await browser.close();fixture.stop();}
}
console.log(JSON.stringify({fixture:true,physicalDevice:false,report},null,2));
