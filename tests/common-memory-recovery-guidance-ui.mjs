/** Recovery from an empty search and an honest cloud export, with no imported/overwritten memory. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {chromium,webkit} from 'playwright';
import {commonMemoryUiFixture} from './fixtures/common-memory/server.ts';

const report=[];
for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]){
 const fixture=await commonMemoryUiFixture(),browser=await engine.launch();
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).origin===fixture.url?r.continue():r.abort());
  await page.goto(fixture.url);page.setDefaultTimeout(5000);
  const panel=page.getByTestId('common-memory-panel');
  await panel.getByRole('button',{name:'공통기억 관리',exact:true}).click();
  const search=panel.getByLabel('공통기억 검색',{exact:true}),empty=panel.getByTestId('common-memory-list-empty');
  await search.fill('찾을 수 없는 QA 표식');
  await empty.waitFor();
  assert.match(await empty.innerText(),/불러온 목록/);
  await empty.getByRole('button',{name:'검색어 지우기',exact:true}).click();
  assert.equal(await search.inputValue(),'');
  assert.equal(await search.evaluate(e=>document.activeElement===e),true);
  await search.fill('   ');await empty.getByRole('button',{name:'검색어 지우기',exact:true}).click();
  assert.equal(await search.inputValue(),'');
  await panel.getByText('목록 관리·휴지통',{exact:true}).click();
  await panel.getByLabel('휴지통·보관된 공통기억 보기',{exact:true}).check();
  await empty.getByText(/보관된 공통기억 보기를 해제/).waitFor();
  await panel.getByLabel('휴지통·보관된 공통기억 보기',{exact:true}).uncheck();
  // Creating an unlinked metadata-only group makes the recovery result observable.
  await panel.getByRole('button',{name:'공통기억 만들기',exact:true}).click();
  await panel.getByLabel('공통기억 이름',{exact:true}).fill('QA 사본 안내');
  await panel.getByTestId('meta-common-memory-panel').getByRole('button',{name:'공통기억 만들기',exact:true}).click();
  const knowledge=panel.getByTestId('meta-common-memory-panel');
  await panel.getByRole('heading',{name:'QA 사본 안내 관리·수정',exact:true}).waitFor();
  await knowledge.getByText('보관·백업·이력',{exact:true}).click();
  const guidance=knowledge.getByTestId('cloud-common-memory-export-guidance');
  await guidance.waitFor();
  assert.match(await guidance.innerText(),/내용 확인용 사본/);
  assert.match(await guidance.innerText(),/파일을 가져와 복원할 수 없습니다/);
  assert.match(await guidance.innerText(),/목록 관리·휴지통/);
  assert.equal(await knowledge.getByRole('button',{name:'백업 가져오기',exact:true}).count(),0);
  const before=(await (await fetch(fixture.url+'/fixture/stats')).json()).groups;
  const downloadPromise=page.waitForEvent('download');
  await knowledge.getByRole('button',{name:'사본 내보내기',exact:true}).click();
  const download=await downloadPromise,data=JSON.parse(await readFile(await download.path(),'utf8'));
  assert.equal(data.format,'agentstoz-meta-common-memory');
  assert.equal(data.snapshot.name,'QA 사본 안내');
  assert.deepEqual(data.snapshot.members,[]);assert.deepEqual(data.snapshot.entries,[]);
  assert.equal(createHash('sha256').update(JSON.stringify(data.snapshot)).digest('hex'),data.checksum);
  assert.deepEqual((await (await fetch(fixture.url+'/fixture/stats')).json()).groups,before);
  await panel.getByRole('button',{name:'목록으로 돌아가기',exact:true}).click();
  await search.fill('불일치 검색어');await empty.waitFor();
  await empty.getByRole('button',{name:'검색어 지우기',exact:true}).click();
  await panel.getByRole('button',{name:'QA 사본 안내 · 기억 항목 0개',exact:true}).waitFor();
  assert.equal(await empty.count(),0);
  assert.deepEqual((await (await fetch(fixture.url+'/fixture/stats')).json()).groups,before);
  // A partial catalog must explain its loaded scope and keep the next-page action available.
  let paginatedReads=0;
  await page.route(fixture.url+'/api/common-memory/list',async route=>{
   const response=await route.fetch(),data=await response.json();
   paginatedReads++;data.nextOffset=1;
   await route.fulfill({response,json:data});
  });
  await page.reload();await panel.getByRole('button',{name:'공통기억 관리',exact:true}).click();
  await search.fill('남은 목록의 QA 표식');await empty.waitFor();
  assert.match(await empty.innerText(),/불러온 목록/);
  assert.match(await empty.innerText(),/공통기억 더 보기/);
  await panel.getByRole('button',{name:'공통기억 더 보기',exact:true}).waitFor();
  assert.ok(paginatedReads>0);
  assert.deepEqual((await (await fetch(fixture.url+'/fixture/stats')).json()).groups,before);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  assert.deepEqual(errors,[]);
  report.push({engine:name,emptySearchRecovery:true,archiveFilterGuidance:true,partialCatalogGuidance:true,cloudExportChecksum:true,exportChanges:0,linkedMemories:0,importOrOverwrite:0});
 }finally{await browser.close();fixture.stop();}
}
console.log(JSON.stringify({fixture:true,physicalDevice:false,report},null,2));
