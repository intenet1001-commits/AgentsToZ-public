/**
 * The knowledge link picker of the shipped cloud common-memory panel links long-term memories (memoryId), counted per
 * operation by the isolated fixture (real Chromium and WebKit, desktop and 390px):
 * - opening a group asks the knowledge read + history only (no knowledge list, no separate projects call, no catalog);
 * - opening the picker loads the cloud catalog, and a memory no project on this Mac uses is linked as {memoryId, mode}
 *   with no portId; the own save re-reads history only (no second read when the group version moves);
 * - an older Mac (no capabilities in list, no memberForm in read) keeps this Mac's rows and the project-card form
 *   {portId, expectedMemoryId, mode}; project ids differ from memoryIds throughout.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chromium,webkit} from 'playwright';
import {commonMemoryUiFixture,CLOUD_ONLY,PORT_IDS} from './fixtures/common-memory/server.ts';
import {B} from './fixtures/common-memory/cloud.ts';
const report=[];
const json=async(url,body)=>(await fetch(url,body===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
const counts=fixture=>json(fixture.url+'/fixture/requests');
const reset=fixture=>json(fixture.url+'/fixture/requests/reset',{});
const until=async(check,label,ms=10000)=>{const end=Date.now()+ms;for(;;){if(await check())return;if(Date.now()>end)throw Error('timed out: '+label);await new Promise(r=>setTimeout(r,50));}};
const inflight=new WeakMap();
const track=page=>{const state={open:0,last:Date.now()};inflight.set(page,state);page.on('request',()=>{state.open++;state.last=Date.now();});const done=()=>{state.open--;state.last=Date.now();};page.on('requestfinished',done);page.on('requestfailed',done);return page;};
const settle=async page=>{const state=inflight.get(page);await new Promise(r=>setTimeout(r,150));await until(async()=>state.open<=0&&Date.now()-state.last>=400,'page requests to settle');};
const knowledgeSave=page=>page.waitForRequest(r=>r.url().endsWith('/api/common-memory/knowledge')&&JSON.parse(r.postData()??'{}').request?.operation==='save');
const GROUP='장기기억 연결 시험';
for(const [engineName,engine] of [['chromium',chromium],['webkit',webkit]]){
 for(const width of [1280,390]){
  const fixture=await commonMemoryUiFixture(),browser=await engine.launch();
  try{
   const page=track(await browser.newPage({viewport:{width,height:900}})),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',r=>new URL(r.request().url()).origin===fixture.url?r.continue():r.abort());page.setDefaultTimeout(10000);
   await page.addInitScript(()=>{Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true});Object.defineProperty(crypto,'subtle',{value:undefined,configurable:true});});
   await page.goto(fixture.url);const panel=page.getByTestId('common-memory-panel');
   await panel.getByRole('button',{name:'공통기억 관리',exact:true}).click();await panel.getByRole('button',{name:'공통기억 만들기',exact:true}).click();
   let knowledge=panel.getByTestId('meta-common-memory-panel');await knowledge.getByLabel('공통기억 이름',{exact:true}).fill(GROUP);
   assert.equal(await knowledge.getByLabel(/카테고리로 자동 적용/).count(),0,'a new group offers no category rule');
   await knowledge.getByRole('checkbox',{name:/이 Mac: 등록 A/}).check();await knowledge.getByRole('button',{name:'공통기억 만들기',exact:true}).click();
   await panel.getByRole('heading',{name:`${GROUP} 관리·수정`,exact:true}).waitFor();
   await json(fixture.url+'/fixture/cloud-only',{});
   // Reopening the group: knowledge read + history only.
   await page.reload();await settle(page);await reset(fixture);
   await panel.getByRole('button',{name:'공통기억 관리',exact:true}).click();await panel.getByRole('heading',{name:`${GROUP} 관리·수정`,exact:true}).waitFor();
   knowledge=panel.getByTestId('meta-common-memory-panel');await knowledge.getByText('연결할 장기기억·이름·태그 수정',{exact:true}).waitFor();await settle(page);
   let c=await counts(fixture);
   assert.equal(c['knowledge:read'],1);assert.equal(c['knowledge:history'],1);assert.equal(c.knowledge,2,'opening a group issues read+history only: '+JSON.stringify(c));
   assert.equal(c['knowledge:list'],undefined);assert.equal(c['knowledge:projects'],undefined);assert.equal(c.catalog,undefined,'the catalog waits for the picker');
   // Opening the picker loads the cloud catalog once; a cloud-only memory is linked by memoryId.
   await reset(fixture);await knowledge.getByText('연결할 장기기억·이름·태그 수정',{exact:true}).click();
   const picker=knowledge.getByTestId('meta-memory-link-targets');const cloudOnly=picker.getByRole('checkbox',{name:/44444444/});await cloudOnly.waitFor();
   assert.match(await picker.innerText(),/이 Mac에 없음 · 클라우드 장기기억/);assert.match(await picker.innerText(),/이 Mac: 등록 A/);
   assert.equal((await counts(fixture)).catalog,1,'opening the picker loads the catalog');
   await knowledge.getByLabel('연결할 장기기억 검색',{exact:true}).fill('example/4444');assert.equal(await picker.getByRole('checkbox').count(),1,'search covers the GitHub address');
   await cloudOnly.check();const sent=knowledgeSave(page);await knowledge.getByRole('button',{name:'연결·정보 저장',exact:true}).click();
   const body=JSON.parse((await sent).postData());assert.deepEqual(body.request.assignments,[{memoryId:CLOUD_ONLY,mode:'include'}]);assert.doesNotMatch(JSON.stringify(body),/portId/);
   await panel.getByTestId('common-memory-use-context').getByRole('heading',{name:'연결된 장기기억 · 직접 선택 2개',exact:true}).waitFor();await settle(page);
   c=await counts(fixture);assert.equal(c['knowledge:save'],1);assert.equal(c['knowledge:history'],1,'the own save reads history');assert.equal(c['knowledge:read'],undefined,'the own save needs no second read: '+JSON.stringify(c));assert.equal(c.inspect,1);
   const stored=(await json(fixture.url+'/fixture/stats')).groups.find(g=>g.state.name===GROUP).state.portableKnowledge.current.members;
   assert.ok(stored.some(m=>m.memoryId===CLOUD_ONLY&&m.mode==='include'),'the cloud-only memory is a member');
   // An older Mac: this Mac's rows and the project-card form.
   await json(fixture.url+'/fixture/old-mac',{});await page.reload();await settle(page);
   await panel.getByRole('button',{name:'공통기억 관리',exact:true}).click();await panel.getByRole('heading',{name:`${GROUP} 관리·수정`,exact:true}).waitFor();await settle(page);
   knowledge=panel.getByTestId('meta-common-memory-panel');const catalogBefore=(await counts(fixture)).catalog??0;
   await knowledge.getByText('연결할 장기기억·이름·태그 수정',{exact:true}).click();await knowledge.getByRole('checkbox',{name:/등록 B/}).waitFor();await settle(page);
   assert.equal((await counts(fixture)).catalog??0,catalogBefore,'an older Mac does not load the catalog for the picker');assert.equal(await knowledge.getByTestId('meta-memory-catalog-more').count(),0);
   assert.match(await knowledge.innerText(),/이 기기에서 조회되지 않는 장기기억 연결도 보존합니다/);
   await knowledge.getByRole('checkbox',{name:/등록 B/}).check();const oldSent=knowledgeSave(page);await knowledge.getByRole('button',{name:'연결·정보 저장',exact:true}).click();
   assert.deepEqual(JSON.parse((await oldSent).postData()).request.assignments,[{portId:PORT_IDS[1],expectedMemoryId:B,mode:'include'}]);
   await panel.getByTestId('common-memory-use-context').getByRole('heading',{name:'연결된 장기기억 · 직접 선택 3개',exact:true}).waitFor();
   await settle(page);
   const snapshot=(await json(fixture.url+'/fixture/stats')).groups.find(g=>g.state.name===GROUP).state.portableKnowledge.current;
   const beforeBackup=JSON.stringify((await json(fixture.url+'/fixture/stats')).groups);
   const backup={format:'agentstoz-meta-common-memory',schemaVersion:1,snapshot,checksum:'0'.repeat(64)};
   const upload=async()=>knowledge.locator('input[type=file]').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
   await upload();await knowledge.getByRole('alert').filter({hasText:'백업 내용의 검증 값이 일치하지 않습니다.'}).waitFor();
   backup.checksum=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');await upload();await knowledge.getByRole('alert').filter({hasText:'이미 있는 공통 기억입니다. 현재 내용과 백업을 비교한 뒤 항목을 편집하세요.'}).waitFor();
   assert.equal(JSON.stringify((await json(fixture.url+'/fixture/stats')).groups),beforeBackup,'backup review never overwrites an existing memory');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);assert.deepEqual(errors,[]);
   report.push({engine:engineName,width,journeys:['open-group-read-and-history-only','picker-loads-catalog-once','cloud-only-memory-linked-by-memoryId','own-save-history-only','old-mac-device-rows-port-form'],errors:0});
  }finally{await browser.close();fixture.stop();}
 }
}
console.log(JSON.stringify({fixture:true,physicalDevice:false,report},null,2));
