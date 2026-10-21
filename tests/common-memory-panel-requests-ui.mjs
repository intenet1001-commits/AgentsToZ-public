/**
 * Request diet of the shipped cloud common-memory panel, counted per operation by the isolated fixture (real Chromium
 * and WebKit, desktop and 390px). Desktop: a cold open asks list+updates only, a remembered selection is read in
 * parallel with the list, the source catalog and device registration status load only when their sections open, a save
 * re-reads only that group, and an older Mac without a scope in list/updates still gets it from the catalog.
 * Phone (?phone=1, real encrypted-RPC chunking): no updates call without source-tracking groups, and coming back to the
 * tab shows the last list at once while it refreshes in the background.
 */
import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {commonMemoryUiFixture} from './fixtures/common-memory/server.ts';
const report=[];
const GOAL_GROUP='요청 절약 원본 시험';
const json=async(url,body)=>(await fetch(url,body===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
const counts=fixture=>json(fixture.url+'/fixture/requests');
const reset=fixture=>json(fixture.url+'/fixture/requests/reset',{});
const until=async(check,label,ms=10000)=>{const end=Date.now()+ms;for(;;){if(await check())return;if(Date.now()>end)throw Error('timed out: '+label);await new Promise(r=>setTimeout(r,50));}};
// waitForLoadState('networkidle') returns at once after the first idle, so count this page's open requests instead.
const inflight=new WeakMap();
const track=page=>{const state={open:0,last:Date.now()};inflight.set(page,state);page.on('request',()=>{state.open++;state.last=Date.now();});const done=()=>{state.open--;state.last=Date.now();};page.on('requestfinished',done);page.on('requestfailed',done);return page;};
const settle=async page=>{const state=inflight.get(page);await new Promise(r=>setTimeout(r,150));await until(async()=>state.open<=0&&Date.now()-state.last>=400,'page requests to settle');};
async function createKnowledgeGroup(page,name){
 const panel=page.getByTestId('common-memory-panel');
 const back=panel.getByRole('button',{name:'목록으로 돌아가기',exact:true});if(await back.count())await back.click();
 await panel.getByRole('button',{name:'공통기억 만들기',exact:true}).click();const knowledge=panel.getByTestId('meta-common-memory-panel');
 await knowledge.getByLabel('공통기억 이름',{exact:true}).fill(name);await knowledge.getByRole('checkbox',{name:/등록 A/}).check();await knowledge.getByRole('button',{name:'공통기억 만들기',exact:true}).click();
 await panel.getByRole('heading',{name:`${name} 관리·수정`,exact:true}).waitFor();
}
for(const [engineName,engine] of [['chromium',chromium],['webkit',webkit]]){
 for(const width of [1280,390]){
  const fixture=await commonMemoryUiFixture(),browser=await engine.launch();
  try{
   const page=track(await browser.newPage({viewport:{width,height:900}})),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',r=>new URL(r.request().url()).origin===fixture.url?r.continue():r.abort());page.setDefaultTimeout(10000);
   await page.goto(fixture.url);await settle(page);await reset(fixture);
   const panel=page.getByTestId('common-memory-panel');
   // Cold open: exactly list + updates, no catalog, no inspect, no registration status.
   await panel.getByRole('button',{name:'공통기억 관리',exact:true}).click();await panel.getByRole('button',{name:'공통기억 만들기',exact:true}).waitFor();await settle(page);
   assert.deepEqual(await counts(fixture),{list:1,updates:1},'a cold open issues exactly list+updates');
   // A knowledge group created directly needs no catalog either.
   await createKnowledgeGroup(page,'요청 절약 시험');await settle(page);
   let c=await counts(fixture);assert.equal(c.catalog,undefined,'direct writing does not load the source catalog');assert.equal(c.list,1,'creating a group does not re-read the list');assert.equal(c.updates,1);
   // A knowledge-only group has no source picker (that is the previous goal model). Choosing sources for a goal group
   // ('기존 장기기억에서 가져오기') loads the catalog once.
   assert.equal(await panel.getByText('주제·가져올 기억 수정',{exact:true}).count(),0,'a knowledge-only group shows no previous-model source picker');
   await panel.getByRole('button',{name:'목록으로 돌아가기',exact:true}).click();await panel.getByRole('button',{name:'공통기억 만들기',exact:true}).click();await panel.getByText('만들기 방식 변경',{exact:true}).click();await panel.getByRole('radio',{name:'기존 장기기억에서 가져오기',exact:true}).check();
   await panel.getByTestId('common-memory-source-selection').getByRole('checkbox',{name:'원본 C',exact:true}).waitFor();await settle(page);
   assert.equal((await counts(fixture)).catalog,1,'opening the source picker loads the catalog');
   // A save re-reads only that group.
   await reset(fixture);await panel.getByLabel('공통기억 이름',{exact:true}).fill(GOAL_GROUP);await panel.getByTestId('common-memory-source-selection').getByRole('checkbox',{name:'원본 C',exact:true}).check();await panel.getByRole('button',{name:'만들고 원본 항목 검토',exact:true}).click();
   await panel.getByTestId('common-memory-source-context').getByRole('heading',{name:'가져올 기억 · 1개',exact:true}).waitFor();await settle(page);
   c=await counts(fixture);assert.equal(c.manage,1);assert.equal(c.inspect,1,'a save triggers one inspect');assert.equal(c.catalog,undefined,'a save does not reload the catalog');assert.equal(c.updates,undefined,'a save does not reload updates');assert.equal(c.list,undefined,'a save does not reload the list');
   // Common memory consumes long-term memories; Git project import is in project tools.
   await reset(fixture);assert.equal(await panel.getByText('다른 기기에 연결 프로젝트 가져오기',{exact:true}).count(),0);
   assert.equal(await panel.getByTestId('common-memory-projects').count(),0);await settle(page);
   assert.equal((await counts(fixture))['projects-status'],undefined,'memory management never probes project cloning');
   // A remembered selection is read in parallel with the list.
   await page.reload();await settle(page);await reset(fixture);await json(fixture.url+'/fixture/delay',{op:'list',ms:1200});
   const timeline=[];page.on('request',r=>{const op=new URL(r.url()).pathname.split('/').at(-1);if(['list','inspect'].includes(op))timeline.push('request:'+op);});page.on('response',r=>{const op=new URL(r.url()).pathname.split('/').at(-1);if(op==='list')timeline.push('response:list');});
   await panel.getByRole('button',{name:'공통기억 관리',exact:true}).click();await panel.getByRole('heading',{name:`${GOAL_GROUP} 관리·수정`,exact:true}).waitFor();await settle(page);
   assert.ok(timeline.indexOf('request:inspect')>=0&&timeline.indexOf('request:inspect')<timeline.indexOf('response:list'),'the saved selection is read while the list is loading: '+timeline.join(','));
   c=await counts(fixture);assert.equal(c.list,1);assert.equal(c.updates,1);assert.equal(c.inspect,1);assert.equal(c.catalog,undefined);
   await json(fixture.url+'/fixture/delay',{op:'list',ms:0});
   // An older Mac without a scope in list and updates: the catalog supplies it.
   await json(fixture.url+'/fixture/old-mac',{});await page.reload();await settle(page);await reset(fixture);
   await panel.getByRole('button',{name:'공통기억 관리',exact:true}).click();await panel.getByRole('heading',{name:`${GOAL_GROUP} 관리·수정`,exact:true}).waitFor();await settle(page);
   c=await counts(fixture);assert.equal(c.catalog,1,'an old Mac falls back to the catalog for the scope');assert.equal(c.list,1);
   await panel.getByRole('button',{name:'목록으로 돌아가기',exact:true}).click();await panel.getByRole('button',{name:new RegExp(GOAL_GROUP)}).waitFor();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);assert.deepEqual(errors,[]);
   report.push({engine:engineName,width,surface:'mac',journeys:['cold-open-list-and-updates-only','direct-create-without-catalog','source-picker-loads-catalog-once','save-reads-one-group','projects-status-on-open-once','saved-selection-in-parallel-with-list','old-mac-scope-from-catalog'],errors:0});
  }finally{await browser.close();fixture.stop();}
 }
 // Phone: a fresh cloud where groups track no sources, so the open needs no updates call.
 const fixture=await commonMemoryUiFixture(),browser=await engine.launch();
 try{
  const mac=await browser.newPage({viewport:{width:1280,height:900}});await mac.route('**/*',r=>new URL(r.request().url()).origin===fixture.url?r.continue():r.abort());mac.setDefaultTimeout(10000);
  await mac.goto(fixture.url);await mac.getByTestId('common-memory-panel').getByRole('button',{name:'공통기억 관리',exact:true}).click();await createKnowledgeGroup(mac,'휴대폰 캐시 시험');await mac.close();
  const page=track(await browser.newPage({viewport:{width:390,height:844}})),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
  await page.route('**/*',r=>new URL(r.request().url()).origin===fixture.url?r.continue():r.abort());await reset(fixture);
  await page.goto(fixture.url+'/?phone=1');const phone=page.getByTestId('remote-cloud-common-memory');
  await phone.getByRole('button',{name:/휴대폰 캐시 시험/}).waitFor();await settle(page);
  let c=await counts(fixture);assert.equal(c.list,1);assert.equal(c.updates,undefined,'the phone skips updates when no group tracks sources');assert.equal(c.catalog,undefined);assert.equal(c.inspect,undefined);
  await page.getByRole('button',{name:'다른 탭',exact:true}).click();await phone.getByRole('button',{name:/휴대폰 캐시 시험/}).waitFor({state:'detached'});
  await json(fixture.url+'/fixture/delay',{op:'list',ms:4000});await reset(fixture);
  const shownAt=Date.now();await page.getByRole('button',{name:'공통기억 탭',exact:true}).click();await phone.getByRole('button',{name:/휴대폰 캐시 시험/}).waitFor({timeout:1500});
  assert.ok(Date.now()-shownAt<1500,'switching back renders from the cache while the 4 s list refresh is still running');
  await until(async()=>(await counts(fixture)).list===1,'background list refresh',8000);await json(fixture.url+'/fixture/delay',{op:'list',ms:0});
  await reset(fixture);
  await phone.getByRole('button',{name:/휴대폰 캐시 시험/}).click();await phone.getByRole('heading',{name:'휴대폰 캐시 시험 관리·수정',exact:true}).waitFor();await settle(page);
  // A Mac with lean-read: the group open leaves the project inventory out, and the picker loads it when opened.
  c=await counts(fixture);assert.equal(c['knowledge:read-lean'],1);assert.equal(c['knowledge:read'],undefined);assert.equal(c['knowledge:projects'],undefined);
  await phone.getByText('연결할 장기기억·이름·태그 수정',{exact:true}).click();
  await until(async()=>(await counts(fixture))['knowledge:projects']===1,'projects load when the picker opens',8000);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);assert.deepEqual(errors,[]);
  report.push({engine:engineName,width:390,surface:'phone',journeys:['open-without-updates-when-no-source-tracking','tab-return-renders-cached-list-then-refreshes','group-open-lean-read-projects-on-picker-open'],errors:0});
 }finally{await browser.close();fixture.stop();}
}
console.log(JSON.stringify({fixture:true,physicalDevice:false,report},null,2));
