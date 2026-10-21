/** Real Chromium/WebKit rendering of shipped cloud panels with owned Git clones and an isolated cloud. */
import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {commonMemoryUiFixture} from './fixtures/common-memory/server.ts';
const report=[];
for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]){
 const fixture=await commonMemoryUiFixture(),browser=await engine.launch();
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.clock.install();
  await page.route('**/*',r=>new URL(r.request().url()).origin===fixture.url?r.continue():r.abort());await page.goto(fixture.url);page.setDefaultTimeout(10000);
  const panel=page.getByTestId('common-memory-panel');await panel.getByRole('button',{name:'공통기억 관리',exact:true}).click();
  await panel.getByRole('button',{name:'공통기억 만들기',exact:true}).waitFor();assert.equal(await panel.getByRole('button',{name:'공통기억 만들기',exact:true}).count(),1);assert.equal(await panel.getByLabel('공통기억 이름',{exact:true}).count(),0);
  const startCreate=async()=>{await panel.getByRole('button',{name:'관리 닫기',exact:true}).waitFor();const back=panel.getByRole('button',{name:'목록으로 돌아가기',exact:true});if(await back.count())await back.click();await panel.getByRole('button',{name:'공통기억 만들기',exact:true}).click();await panel.getByText('만들기 방식 변경',{exact:true}).click();await panel.getByRole('radio',{name:'기존 장기기억에서 가져오기',exact:true}).check();assert.equal(await panel.getByLabel('공통기억 검색',{exact:true}).count(),0);};
  const create=async(title,goal,members,source,reason)=>{
   await startCreate();
   await panel.getByLabel('공통기억 이름',{exact:true}).fill(title);await panel.getByText('주제 설명·세부 설정',{exact:true}).click();await panel.getByLabel('공통기억의 목표',{exact:true}).fill(goal);
   for(const m of members)await panel.getByRole('checkbox',{name:m,exact:true}).check();
   await panel.getByRole('button',{name:'만들고 원본 항목 검토',exact:true}).click();
   // A goal group carries only the previous model: its fenced section is shown and open by default.
   const legacySection=panel.getByTestId('common-memory-legacy');await legacySection.waitFor();assert.match(await legacySection.locator('summary').first().innerText(),/^이전 방식/);assert.equal(await legacySection.evaluate(e=>e.open),true);
   await panel.getByText('출처 검토·게시 관리',{exact:true}).click();await panel.getByRole('button',{name:'검토한 항목 게시',exact:true}).waitFor();
   assert.equal(await panel.getByRole('button',{name:'검토한 항목 게시',exact:true}).isDisabled(),true);
   await panel.getByText(/^원본에서 직접 항목 선택/).click();await panel.getByRole('button',{name:new RegExp('^'+source)}).click();await panel.getByLabel('이 목표에 필요한 이유',{exact:true}).fill(reason);
   await panel.getByRole('button',{name:'관련성 검토를 저장',exact:true}).click();await panel.getByRole('button',{name:'검토한 항목 게시',exact:true}).click();await panel.getByText(/게시됨 · 새 작업에 사용 가능/).waitFor();
  };
  await create('운전게임','운전게임 조작 검증',['원본 A','원본 B'],'게임 조작','운전 조작은 프레임 속도와 독립적이어야 하기 때문');
  await create('아이폰 네이티브 앱','SwiftUI 아이폰 네이티브 앱',['원본 B','원본 C'],'iOS 생명주기','아이폰 앱의 복귀 후 연결 검증이 필요하기 때문');
  await page.screenshot({path:`/tmp/common-memory-context-${name}.png`,fullPage:true});
  const contextBefore=await panel.getByTestId('common-memory-context').innerText();
  const cloudBefore=JSON.stringify((await (await fetch(fixture.url+'/fixture/stats')).json()).groups);
  assert.equal(await panel.getByLabel('공통기억의 목표',{exact:true}).isVisible(),false);
  await panel.getByRole('button',{name:'AI로 정리·업데이트',exact:true}).click();
  const workroom=page.getByTestId('common-memory-workroom-draft');await workroom.getByRole('heading',{name:'아이폰 네이티브 앱 · 기억 정리',exact:true}).waitFor();assert.match(await workroom.innerText(),/propose-source-entry/);
  await workroom.getByRole('button',{name:'공통기억으로 돌아가기',exact:true}).click();await panel.getByRole('button',{name:'공통기억 관리',exact:true}).click();
  await panel.getByTestId('common-memory-context').waitFor();assert.equal(await panel.getByTestId('common-memory-context').innerText(),contextBefore);
  assert.equal(JSON.stringify((await (await fetch(fixture.url+'/fixture/stats')).json()).groups),cloudBefore);
  const stats=await (await fetch(fixture.url+'/fixture/stats')).json();assert.equal(stats.groups.length,2);const game=stats.groups.find(g=>g.state.name==='운전게임'),ios=stats.groups.find(g=>g.state.name==='아이폰 네이티브 앱');
  assert.deepEqual(game.state.sourceMemoryIds.filter(id=>ios.state.sourceMemoryIds.includes(id)),['22222222-2222-4222-8222-222222222222']);assert.match(game.state.items[0].rule,/시간에 독립/);assert.match(ios.state.items[0].rule,/백그라운드/);assert.doesNotMatch(ios.state.items[0].rule,/운전게임/);
  await page.getByLabel('무엇을 만들까요?',{exact:true}).fill('SwiftUI 아이폰 앱');await page.getByRole('button',{name:'목표에 맞는 공통기억 추천',exact:true}).click();await page.getByTestId('project-common-memory-choice').getByRole('checkbox').first().check();assert.match(await page.getByTestId('selection-count').innerText(),/1/);
  await page.getByLabel('무엇을 만들까요?',{exact:true}).fill('새 웹 서비스');assert.match(await page.getByTestId('selection-count').innerText(),/0/);
  assert.equal(await panel.getByText('다른 기기에 연결 프로젝트 가져오기',{exact:true}).count(),0);assert.equal(await panel.getByTestId('common-memory-projects').count(),0);const projectsGroup=(await (await fetch(fixture.url+'/fixture/stats')).json()).groups.find(g=>g.state.name==='운전게임').state.id;await page.goto(fixture.url+'/?project-tools='+projectsGroup);const collection=page.getByTestId('common-memory-projects');await collection.getByRole('button',{name:'이 기기의 누락 프로젝트 확인',exact:true}).click();await collection.getByLabel('공통기억 프로젝트 작업 루트',{exact:true}).selectOption('root_fixture');await collection.getByRole('button',{name:'등록 상태·추가 계획 확인',exact:true}).click();await collection.getByText(/추가 가능 2/).waitFor();await fetch(fixture.url+'/fixture/restore-failure',{method:'POST'});await collection.getByRole('button',{name:'추가 가능한 프로젝트 모두 가져오기',exact:true}).click();await collection.getByText('추가를 완료하지 못했습니다. 같은 요청으로 결과를 확인하세요.',{exact:true}).waitFor();const partialStats=await (await fetch(fixture.url+'/fixture/stats')).json();if(partialStats.clones!==1)console.error('partial failure UI',await collection.innerText());assert.equal(partialStats.clones,1);await collection.getByRole('button',{name:'같은 프로젝트 추가 결과 확인',exact:true}).click();await collection.getByRole('button',{name:'추가 가능한 프로젝트 모두 가져오기',exact:true}).click();await collection.getByText(/추가 가능한 프로젝트의 처리가 끝났습니다/).waitFor();
  const clones=await (await fetch(fixture.url+'/fixture/stats')).json();assert.equal(clones.clones,2);assert.equal(new Set(clones.registered).size,2);await page.goto(fixture.url);await panel.getByRole('button',{name:'공통기억 관리',exact:true}).click();
  await startCreate();await panel.getByLabel('공통기억 이름',{exact:true}).fill('응답 유실 복구');await panel.getByText('주제 설명·세부 설정',{exact:true}).click();await panel.getByLabel('공통기억의 목표',{exact:true}).fill('아이폰 복구 검증');await panel.getByRole('checkbox',{name:'원본 A',exact:true}).check();await fetch(fixture.url+'/fixture/loss',{method:'POST'});await panel.getByRole('button',{name:'만들고 원본 항목 검토',exact:true}).click();await panel.getByText('저장은 완료됐지만 응답이 유실된 시험입니다.',{exact:true}).waitFor();await panel.getByRole('button',{name:'같은 요청으로 결과 확인',exact:true}).waitFor();
  await page.reload();await panel.getByRole('button',{name:'공통기억 관리',exact:true}).click();await panel.getByRole('button',{name:'이전 저장 영수증 확인',exact:true}).click();await panel.getByText('이전 요청의 저장을 확인했습니다.',{exact:true}).waitFor();assert.equal((await (await fetch(fixture.url+'/fixture/stats')).json()).groups.length,3);
  await startCreate();await panel.getByRole('radio',{name:'직접 작성하기',exact:true}).check();const knowledge=panel.getByTestId('meta-common-memory-panel');await knowledge.getByLabel('공통기억 이름',{exact:true}).fill('NHCS 시험 공통기억');await knowledge.getByText('설명·태그',{exact:true}).click();await knowledge.getByLabel('설명',{exact:true}).fill('공통 연동·검증 규칙');await knowledge.getByRole('checkbox',{name:/등록 A/}).check();await knowledge.getByRole('checkbox',{name:/등록 B/}).check();await fetch(fixture.url+'/fixture/loss',{method:'POST'});await knowledge.getByRole('button',{name:'공통기억 만들기',exact:true}).click();await knowledge.getByText('저장은 완료됐지만 응답이 유실된 시험입니다.',{exact:true}).waitFor();assert.equal(await panel.getByRole('button',{name:'목록으로 돌아가기',exact:true}).isDisabled(),true);await knowledge.getByRole('button',{name:'같은 요청 다시 확인',exact:true}).click();await panel.getByText('직접 기억 항목 작성·수정',{exact:true}).click();await panel.getByTestId('meta-common-memory-panel').getByLabel('공통 항목 제목',{exact:true}).fill('NHCS 호환');await panel.getByTestId('meta-common-memory-panel').getByLabel('공통 항목 내용',{exact:true}).fill('선택한 두 프로젝트가 실제 연동 계약을 검사한다.');await panel.getByTestId('meta-common-memory-panel').getByRole('button',{name:'공통 항목 저장',exact:true}).click();await panel.getByTestId('meta-common-memory-panel').getByText('NHCS 호환 · 확정',{exact:true}).waitFor();
  // A knowledge-only group shows no previous-model (goal/source review/publish) UI at all.
  for(const control of [panel.getByTestId('common-memory-legacy'),panel.getByText('주제·가져올 기억 수정',{exact:true}),panel.getByText('출처 검토·게시 관리',{exact:true}),panel.getByLabel('공통기억의 목표',{exact:true}),panel.getByRole('heading',{name:/목표에 맞춰 검토한 항목/})])assert.equal(await control.count(),0);
  const sourceContext=panel.getByTestId('common-memory-source-context'),useContext=panel.getByTestId('common-memory-use-context');
  assert.equal(await sourceContext.count(),0);assert.match(await useContext.innerText(),/직접 선택 2개/);assert.match(await useContext.innerText(),/등록 A · 등록 B/);
  let linked=(await (await fetch(fixture.url+'/fixture/stats')).json()).groups.find(g=>g.state.name==='NHCS 시험 공통기억').state;
  assert.deepEqual(linked.sourceMemoryIds,[]);assert.deepEqual(linked.portableKnowledge.current.members.filter(m=>m.mode==='include').map(m=>m.memoryId).sort(),['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222']);
  await panel.getByText('연결할 장기기억·이름·태그 수정',{exact:true}).click();const useSelection=panel.getByTestId('meta-memory-use-projects');await useSelection.getByRole('checkbox',{name:/등록 A/}).uncheck();await useSelection.getByRole('button',{name:'연결·정보 저장',exact:true}).click();await useContext.getByRole('heading',{name:'연결된 장기기억 · 직접 선택 1개',exact:true}).waitFor();
  linked=(await (await fetch(fixture.url+'/fixture/stats')).json()).groups.find(g=>g.state.name==='NHCS 시험 공통기억').state;
  assert.deepEqual(linked.sourceMemoryIds,[]);assert.deepEqual(linked.portableKnowledge.current.members.filter(m=>m.mode==='include').map(m=>m.memoryId),['22222222-2222-4222-8222-222222222222']);
  await page.screenshot({path:`/tmp/common-memory-relationships-${name}.png`,fullPage:true});
  await panel.getByRole('button',{name:'목록으로 돌아가기',exact:true}).click();
  await panel.getByText('목록 관리·휴지통',{exact:true}).click();const sharedChoice=panel.getByRole('checkbox',{name:'NHCS 시험 공통기억 선택',exact:true});const hitArea=await sharedChoice.boundingBox();assert.ok(hitArea.width>=44&&hitArea.height>=44);await sharedChoice.check();assert.equal(await sharedChoice.isChecked(),true);await sharedChoice.uncheck();
  await panel.getByLabel('공통기억 검색',{exact:true}).fill('NHCS');assert.equal(await panel.getByRole('button',{name:/^운전게임$/}).count(),0);await panel.getByRole('button',{name:'검색 결과 모두 선택',exact:true}).click();await panel.getByRole('button',{name:'선택한 1개 휴지통으로 이동',exact:true}).click();await panel.getByLabel('휴지통·보관된 공통기억 보기',{exact:true}).check();await panel.getByRole('button',{name:/NHCS 시험 공통기억 · 보관됨/}).waitFor();await panel.getByRole('button',{name:'검색 결과 모두 선택',exact:true}).click();await panel.getByRole('button',{name:'선택한 1개 복원',exact:true}).click();await panel.getByLabel('휴지통·보관된 공통기억 보기',{exact:true}).uncheck();await panel.getByRole('button',{name:/NHCS 시험 공통기억 · 기억 항목 1개/}).click();await panel.getByText('NHCS 호환 · 확정',{exact:true}).waitFor();
  // An archived goal group stays readable (rules shown) with no editing or publishing, and is restored from its view.
  await panel.getByRole('button',{name:'목록으로 돌아가기',exact:true}).click();await panel.getByText('목록 관리·휴지통',{exact:true}).click();await panel.getByLabel('공통기억 검색',{exact:true}).fill('운전게임');
  await panel.getByRole('button',{name:'검색 결과 모두 선택',exact:true}).click();await panel.getByRole('button',{name:'선택한 1개 휴지통으로 이동',exact:true}).click();await panel.getByLabel('휴지통·보관된 공통기억 보기',{exact:true}).check();
  await panel.getByRole('button',{name:/^운전게임 · 보관됨/}).click();const archivedLegacy=panel.getByTestId('common-memory-legacy');await archivedLegacy.getByTestId('common-memory-legacy-readonly').waitFor();
  assert.match(await archivedLegacy.innerText(),/시간에 독립/);for(const name of ['검토한 항목 게시','관련성 검토를 저장','규칙 수정·재검토','주제·가져올 기억 저장','새 원본 반영·재검토'])assert.equal(await panel.getByRole('button',{name,exact:true}).count(),0);
  assert.equal(await panel.getByRole('button',{name:'AI로 정리·업데이트',exact:true}).isDisabled(),true);
  await panel.getByRole('button',{name:'보관 해제 후 검토',exact:true}).click();await panel.getByText('출처 검토·게시 관리',{exact:true}).waitFor();assert.equal(await archivedLegacy.getByTestId('common-memory-legacy-readonly').count(),0);
  fixture.cloud.tables.portmgr_project_memory_labels.push({memory_id:'22222222-2222-4222-8222-222222222222',display_name:'동명 원본'},{memory_id:'33333333-3333-4333-8333-333333333333',display_name:'동명 원본'});
  await page.reload();await panel.getByRole('button',{name:'공통기억 관리',exact:true}).click();await startCreate();await panel.getByRole('checkbox',{name:'동명 원본 · 기억 22222222',exact:true}).waitFor();
  const sourceSearch=panel.getByLabel('원본 장기기억 검색',{exact:true});await sourceSearch.fill('example/22222222');await panel.getByRole('checkbox',{name:'동명 원본 · 기억 22222222',exact:true}).check();assert.equal(await panel.getByRole('checkbox',{name:'동명 원본 · 기억 33333333',exact:true}).count(),0);
  await sourceSearch.fill('33333333-3333');await panel.getByRole('checkbox',{name:'동명 원본 · 기억 33333333',exact:true}).check();await sourceSearch.fill('동명 원본');assert.equal(await panel.getByRole('checkbox',{name:/동명 원본 · 기억/}).count(),2);assert.equal(await panel.getByRole('checkbox',{name:'동명 원본 · 기억 22222222',exact:true}).isChecked(),true);assert.equal(await panel.getByRole('checkbox',{name:'동명 원본 · 기억 33333333',exact:true}).isChecked(),true);
  const controlSizes=await panel.locator('input:not([type=checkbox]):not([type=radio]),textarea,select').evaluateAll(es=>es.filter(e=>e.getClientRects().length).map(e=>Number.parseFloat(getComputedStyle(e).fontSize)));assert.ok(controlSizes.every(n=>n>=16));
  const methodTargets=await panel.getByRole('radio').evaluateAll(es=>es.map(e=>e.closest('label').getBoundingClientRect().height));assert.ok(methodTargets.every(h=>h>=44));
  const buttons=await panel.locator('button').evaluateAll(es=>es.filter(e=>e.getClientRects().length).map(e=>e.getBoundingClientRect().height));assert.ok(buttons.every(h=>h>=43.5));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  const savedBeforeRecommendation=JSON.stringify((await (await fetch(fixture.url+'/fixture/stats')).json()).groups);
  await fetch(fixture.url+'/fixture/accumulate',{method:'POST'});await page.clock.fastForward(300000);
  const notice=page.getByTestId('common-memory-followup-notice');await notice.getByRole('button',{name:'추천 업데이트 보기',exact:true}).waitFor();
  assert.equal(JSON.stringify((await (await fetch(fixture.url+'/fixture/stats')).json()).groups),savedBeforeRecommendation);
  await notice.getByRole('button',{name:'추천 업데이트 보기',exact:true}).click();await panel.getByTestId('common-memory-context').waitFor();
  assert.match(await panel.getByTestId('common-memory-context').innerText(),/원본 [12]개가 바뀌었습니다|처음 정리/);
  await panel.getByRole('button',{name:'목록으로 돌아가기',exact:true}).click();
  await panel.getByRole('button',{name:'AI로 공통기억 추천받기',exact:true}).click();
  const recommendation=page.getByTestId('common-memory-workroom-draft');await recommendation.getByRole('heading',{name:'공통기억 추천',exact:true}).waitFor();
  const recommendationText=await recommendation.innerText();
  assert.match(recommendationText,/클라우드의 장기기억을 기기과 무관하게/);assert.match(recommendationText,/"cloudSources":\[/);assert.match(recommendationText,/read_cloud_common_memory_source/);assert.doesNotMatch(recommendationText,/"projects":|"portId":/);assert.match(recommendationText,/사용자 선택을 기다리세요/);
  assert.equal(JSON.stringify((await (await fetch(fixture.url+'/fixture/stats')).json()).groups),savedBeforeRecommendation);
  // Jumps from a project's memory tab: a group id opens that group; a memoryId opens the group that links it, or
  // knowledge creation with it preset when no group does.
  const focusStats=await (await fetch(fixture.url+'/fixture/stats')).json(),gameId=focusStats.groups.find(g=>g.state.name==='운전게임').state.id;
  await page.goto(fixture.url+'/?focus-group='+gameId);await panel.getByRole('heading',{name:'운전게임 관리·수정',exact:true}).waitFor();
  await page.goto(fixture.url+'/?focus-memory=22222222-2222-4222-8222-222222222222');await panel.getByRole('heading',{name:'NHCS 시험 공통기억 관리·수정',exact:true}).waitFor();
  await page.goto(fixture.url+'/?focus-memory=11111111-1111-4111-8111-111111111111');const preset=panel.getByTestId('meta-common-memory-panel');await panel.getByText('이 장기기억을 연결한 공통기억이 없습니다. 새 공통기억을 만들어 연결할 수 있습니다.',{exact:true}).waitFor();
  await preset.getByRole('checkbox',{name:/등록 B/}).waitFor();assert.equal(await preset.getByRole('checkbox',{name:/등록 A/}).isChecked(),true);assert.equal(await preset.getByRole('checkbox',{name:/등록 B/}).isChecked(),false);
  // A failing memory lookup still opens the panel on the group list, with the reason; closing and reopening does too.
  await fetch(fixture.url+'/fixture/fail',{method:'POST',body:JSON.stringify({op:'project-links',on:true})});
  await page.goto(fixture.url+'/?focus-memory=22222222-2222-4222-8222-222222222222');
  await panel.getByRole('alert').filter({hasText:'이 장기기억을 연결한 공통기억을 확인하지 못했습니다. 목록에서 선택하세요.'}).waitFor();
  await panel.getByRole('button',{name:'관리 닫기',exact:true}).waitFor();await panel.getByText('운전게임',{exact:true}).first().waitFor();
  await panel.getByRole('button',{name:'관리 닫기',exact:true}).click();await panel.getByRole('button',{name:'공통기억 관리',exact:true}).click();
  await panel.getByRole('button',{name:'관리 닫기',exact:true}).waitFor();await panel.getByRole('alert').filter({hasText:'목록에서 선택하세요.'}).waitFor();
  await fetch(fixture.url+'/fixture/fail',{method:'POST',body:JSON.stringify({op:'project-links',on:false})});
  assert.deepEqual(errors,[]);report.push({engine:name,width:390,journeys:['goal-group-shows-open-previous-model-section','knowledge-only-group-hides-previous-model-ui','archived-goal-group-read-only-then-restored','focus-group-and-focus-memory-jumps','focus-memory-without-group-presets-creation','focus-memory-lookup-failure-still-opens-list','periodic-recommendation-and-context-navigation-without-AI-or-writes','recent-project-recommendation-workroom-draft','workroom-context-return-without-memory-mutation','primary-view-hides-advanced-fields','separate-list-create-and-edit-with-single-memory-name','direct-write-unknown-result-blocks-navigation-and-replays-once','first-use','A+B/B+C-goal-selection','goal-change-clears-pins','missing-project-bulk-clone','partial-clone-failure-resume-without-duplicate','unknown-response-reload-receipt','use-projects-save-leaves-sources-untouched','portable-knowledge-create-and-exact-members','unified-search-multiselect-trash-restore','duplicate-source-repository-id-search-preserves-selection','16px-input-44px-touch-no-overflow'],groups:4,clones:2,errors:0});
 }finally{await browser.close();fixture.stop();}
}
console.log(JSON.stringify({fixture:true,physicalDevice:false,report},null,2));
