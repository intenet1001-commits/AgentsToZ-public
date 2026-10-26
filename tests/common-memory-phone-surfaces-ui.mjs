/**
 * The phone's common-memory surfaces on the isolated fixture (real Chromium and WebKit at 390px, real encrypted-RPC chunking):
 * - an unsaved create form or entry draft survives a tab switch, a clean panel still unmounts, and a new connection
 *   (another Mac) starts empty instead of carrying the draft over;
 * - the create form is one flat form (no inner title, close button or '…수정' fold) and names the connected Mac, not '이 Mac';
 * - a saved link change says so beside the button until the next edit; history reads in words, the ID sits under 고급 정보;
 * - with the Mac's OPS project the AI button fills that workroom's composer (the bridge only records the draft here);
 *   without it the button is off and the line says why and where to allow it;
 * - '이전 로컬 기억' with the cloud-tab hint offers no create or import (the Mac would only refuse them);
 * - the create form (no exit of its own) can be left with 「목록으로 돌아가기」 while its inventory still loads.
 */
import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {commonMemoryUiFixture} from './fixtures/common-memory/server.ts';
const NO_OPS='이 연결에는 아젠투지(OPS) 프로젝트가 허용되지 않아 AI 정리를 시작할 수 없습니다. 기억 항목은 직접 작성할 수 있고, AI 정리는 Mac의 원격제어에서 OPS 프로젝트를 허용한 뒤 사용하세요.';
const report=[];
const noScroll=page=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1);
for(const [engineName,engine] of [['chromium',chromium],['webkit',webkit]]){
 const fixture=await commonMemoryUiFixture(),browser=await engine.launch();
 try{
  const open=async path=>{const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
   await page.route('**/*',r=>new URL(r.request().url()).origin===fixture.url?r.continue():r.abort());await page.goto(fixture.url+path);return {page,errors};};
  // With OPS: the create form, its draft across tabs and connections, the saved mark, history words and the AI bridge.
  {const {page,errors}=await open('/?phone=1&ops=1');const phone=page.getByTestId('remote-cloud-common-memory'),panel=phone.getByTestId('common-memory-panel');
   const startCreate=async()=>{await panel.getByRole('button',{name:'공통기억 만들기',exact:true}).first().click();return panel.getByTestId('meta-common-memory-panel');};
   await panel.getByRole('button',{name:'공통기억 만들기',exact:true}).waitFor();
   assert.doesNotMatch(await panel.getByTestId('common-memory-workroom-help').innerText(),/허용되지 않아/);
   assert.equal(await panel.getByRole('button',{name:'AI로 공통기억 추천받기',exact:true}).isDisabled(),false);
   let knowledge=await startCreate();const name=knowledge.getByLabel('공통기억 이름',{exact:true});await name.fill('휴대폰 초안 시험');
   await knowledge.getByText(/^시험 Mac: 등록 A · 기억 1{8}$/).waitFor();
   assert.equal(await knowledge.getByTestId('meta-memory-use-projects').evaluate(e=>getComputedStyle(e).borderLeftWidth),'0px','no browser fieldset box around the link list');assert.equal(await knowledge.getByText(/이 Mac/).count(),0,'the phone names the connected Mac, not "this Mac"');
   assert.equal(await knowledge.getByRole('button',{name:/닫기/}).count(),0);assert.equal(await knowledge.getByText('연결할 장기기억·이름·태그 수정',{exact:true}).count(),0);
   const inputBox=await name.boundingBox(),panelBox=await phone.boundingBox();assert.ok(inputBox.width>=panelBox.width*0.85,`the name field spans the phone (${inputBox.width} of ${panelBox.width})`);
   await page.getByRole('button',{name:'다른 탭',exact:true}).click();assert.equal(await name.isVisible(),false);
   await page.getByRole('button',{name:'공통기억 탭',exact:true}).click();assert.equal(await name.inputValue(),'휴대폰 초안 시험','an unsaved create form survives a tab switch');
   // Another Mac: the panel remounts empty under the new connection key.
   await page.getByRole('button',{name:'다른 Mac 연결',exact:true}).click();await panel.getByRole('button',{name:'공통기억 만들기',exact:true}).waitFor();
   assert.equal(await panel.getByLabel('공통기억 이름',{exact:true}).count(),0,'a draft never follows the phone to another connection');
   knowledge=await startCreate();await knowledge.getByLabel('공통기억 이름',{exact:true}).fill('휴대폰 초안 시험');await knowledge.getByRole('checkbox',{name:/등록 A/}).check();
   await knowledge.getByRole('button',{name:'공통기억 만들기',exact:true}).click();await panel.getByRole('heading',{name:'휴대폰 초안 시험 관리·수정',exact:true}).waitFor();
   // A saved link change is marked beside the button, and the mark goes with the next edit.
   knowledge=panel.getByTestId('meta-common-memory-panel');await knowledge.getByText('연결할 장기기억·이름·태그 수정',{exact:true}).click();
   const linkB=knowledge.getByRole('checkbox',{name:/등록 B/});await linkB.check();assert.equal(await knowledge.getByTestId('meta-memory-links-saved').count(),0);
   await knowledge.getByRole('button',{name:'연결·정보 저장',exact:true}).click();
   const saved=knowledge.getByTestId('meta-memory-links-saved');await saved.waitFor();assert.equal(await saved.innerText(),'저장했습니다 · 연결된 장기기억 2개');
   await linkB.uncheck();await saved.waitFor({state:'detached'});await linkB.check();
   // History in words, the IDs only under 고급 정보.
   await knowledge.getByText('보관·백업·이력',{exact:true}).click();await knowledge.getByText('최근 변경 이력',{exact:true}).click();
   const history=await knowledge.getByText(/번째 · /).allInnerTexts();assert.ok(history.length>0);for(const row of history)assert.doesNotMatch(row,/cloud-update|migration|리비전/,row);
   assert.match(history.join('\n'),/클라우드에서 변경/);
   // Inside the iOS app (a WKWebView with message handlers) a blob download is dropped, so the export is shown to copy.
   await page.evaluate(()=>{window.webkit={messageHandlers:{}};});
   await knowledge.getByRole('button',{name:/^(사본|백업) 내보내기$/}).click();const exportCopy=knowledge.getByTestId('meta-memory-export-copy');await exportCopy.waitFor();
   assert.match(await exportCopy.getByLabel('내보낸 공통기억 내용',{exact:true}).inputValue(),/"format": "agentstoz-meta-common-memory"/);
   await exportCopy.getByRole('button',{name:'닫기',exact:true}).click();await exportCopy.waitFor({state:'detached'});await page.evaluate(()=>{delete window.webkit;});
   assert.equal(await knowledge.getByText(/공통기억 ID /).isVisible(),false);await knowledge.getByText('고급 정보',{exact:true}).click();
   assert.match(await knowledge.getByText(/공통기억 ID /).innerText(),/^공통기억 ID [0-9a-f-]{36} · \d+번째 변경/);
   // An unsent entry draft also survives the tab; once cleared, a tab switch unmounts the panel again.
   await knowledge.getByText('직접 기억 항목 작성·수정',{exact:true}).click();const title=knowledge.getByLabel('공통 항목 제목',{exact:true});await title.fill('휴대폰 항목 초안');
   await page.getByRole('button',{name:'다른 탭',exact:true}).click();await page.getByRole('button',{name:'공통기억 탭',exact:true}).click();
   assert.equal(await title.inputValue(),'휴대폰 항목 초안','an unsaved entry draft survives a tab switch');
   await title.fill('');await page.getByRole('button',{name:'다른 탭',exact:true}).click();
   await panel.getByRole('heading',{name:'휴대폰 초안 시험 관리·수정',exact:true}).waitFor({state:'detached'});
   // The AI button hands the prepared request to the OPS workroom bridge; it runs nothing by itself.
   await page.getByRole('button',{name:'공통기억 탭',exact:true}).click();const back=panel.getByRole('button',{name:'목록으로 돌아가기',exact:true});
   await panel.getByRole('button',{name:/^(목록으로 돌아가기|AI로 공통기억 추천받기)$/}).first().waitFor();if(await back.count())await back.click();
   await panel.getByRole('button',{name:'AI로 공통기억 추천받기',exact:true}).click();
   const draft=page.getByTestId('phone-workroom-draft');await draft.getByRole('heading',{name:'공통기억 추천',exact:true}).waitFor();
   assert.match(await draft.innerText(),/fixture-ops/);
   assert.equal(await noScroll(page),true);assert.deepEqual(errors,[]);await page.close();
   report.push({engine:engineName,width:390,surface:'phone+ops',journeys:['create-draft-survives-tab','draft-does-not-cross-connections','create-form-flat-and-names-mac','links-saved-mark','history-in-words','export-copy-in-app','entry-draft-survives-tab','clean-tab-unmounts','ai-fills-ops-workroom'],errors:0});}
  // A memory row's 「공통기억」 on the phone opens the group that links that long-term memory, as on the Mac: 등록 A was
  // linked to '휴대폰 초안 시험' above; 등록 C is linked nowhere, so creating one opens with it preset.
  {const {page,errors}=await open('/?phone=1&focus-memory=11111111-1111-4111-8111-111111111111');const panel=page.getByTestId('remote-cloud-common-memory').getByTestId('common-memory-panel');
   await panel.getByRole('heading',{name:'휴대폰 초안 시험 관리·수정',exact:true}).waitFor();
   // The heading precedes the child's chunk reads/release. This journey tests the next
   // memory link, so finish those requests before replacing the fixture document.
   await page.waitForLoadState('networkidle');
   await page.goto(fixture.url+'/?phone=1&focus-memory=33333333-3333-4333-8333-333333333333');
   await panel.getByText('이 장기기억을 연결한 공통기억이 없습니다. 새 공통기억을 만들어 연결할 수 있습니다.',{exact:true}).waitFor();
   assert.equal(await panel.getByRole('checkbox',{name:/등록 C/}).isChecked(),true);
   assert.equal(await noScroll(page),true);assert.deepEqual(errors,[]);await page.close();
   report.push({engine:engineName,width:390,surface:'phone-focus-memory',journeys:['memory-row-opens-its-common-memory'],errors:0});}
  // The portal's memory-row jump (here a button that sets the focus and shows the chip): a used jump does not come back when
  // the panel remounts, and with an unsaved draft the jump is refused and said instead of replacing the open form.
  {const {page,errors}=await open('/?phone=1');const panel=page.getByTestId('remote-cloud-common-memory').getByTestId('common-memory-panel');
   const heading=panel.getByRole('heading',{name:'휴대폰 초안 시험 관리·수정',exact:true}),tab=label=>page.getByRole('button',{name:label,exact:true});
   await panel.getByRole('button',{name:/^(목록으로 돌아가기|AI로 공통기억 추천받기)$/}).first().waitFor();
   if(await panel.getByRole('button',{name:'목록으로 돌아가기',exact:true}).count())await panel.getByRole('button',{name:'목록으로 돌아가기',exact:true}).click();
   await tab('등록 A의 공통기억').click();await heading.waitFor();
   await panel.getByRole('button',{name:'목록으로 돌아가기',exact:true}).click();await heading.waitFor({state:'detached'});
   await tab('다른 탭').click();await tab('공통기억 탭').click();await panel.getByRole('button',{name:'AI로 공통기억 추천받기',exact:true}).waitFor();
   await page.waitForTimeout(500);assert.equal(await heading.count(),0,'a used jump does not reopen its group when the panel remounts');
   await panel.getByRole('button',{name:'공통기억 만들기',exact:true}).first().click();const draftName=panel.getByLabel('공통기억 이름',{exact:true});await draftName.fill('바로가기 초안');
   await tab('다른 탭').click();await tab('등록 A의 공통기억').click();await page.getByTestId('common-memory-focus-refused').waitFor();
   assert.equal(await draftName.inputValue(),'바로가기 초안','the jump keeps the unsaved form');assert.equal(await heading.count(),0);
   assert.equal(await noScroll(page),true);assert.deepEqual(errors,[]);await page.close();
   report.push({engine:engineName,width:390,surface:'phone-jump',journeys:['used-jump-not-repeated-on-remount','jump-refused-with-unsaved-draft'],errors:0});}
  // Without OPS: the AI button is off and the line says why.
  {const {page,errors}=await open('/?phone=1');const panel=page.getByTestId('remote-cloud-common-memory').getByTestId('common-memory-panel');
   await panel.getByRole('button',{name:/^(목록으로 돌아가기|AI로 공통기억 추천받기)$/}).first().waitFor();
   assert.equal(await panel.getByTestId('common-memory-workroom-help').innerText(),NO_OPS);
   assert.equal(await panel.getByRole('button',{name:/^AI로 /}).first().isDisabled(),true);
   assert.equal(await noScroll(page),true);assert.deepEqual(errors,[]);await page.close();
   report.push({engine:engineName,width:390,surface:'phone-no-ops',journeys:['ai-off-with-reason'],errors:0});}
  // '이전 로컬 기억' with the cloud-tab hint: no create, no import, the empty line names the Mac.
  {const {page,errors}=await open('/?local-hint=1');await page.getByTestId('meta-common-memory-cloud-hint').waitFor();
   await page.getByText('시험 Mac에 남은 이전 로컬 기억이 없습니다.',{exact:true}).waitFor();
   for(const label of ['공통기억 만들기','백업 가져오기'])assert.equal(await page.getByRole('button',{name:label}).count(),0,label);
   await page.getByRole('heading',{name:'이전 로컬 기억'}).waitFor();
   assert.equal(await noScroll(page),true);assert.deepEqual(errors,[]);await page.close();
   report.push({engine:engineName,width:390,surface:'phone-local-hint',journeys:['no-create-or-import-under-cloud-hint'],errors:0});}
  // The create form has no close button of its own, so 「목록으로 돌아가기」 stays usable while its long-term-memory
  // inventory is still loading (held here until the person has left; on the phone the request is JSON inside the RPC text).
  for(const path of ['/','/?phone=1']){const {page,errors}=await open(path);let hold=null;const held=[];
   await page.route('**/*',async r=>{const body=r.request().postData()??'';if(hold&&/\\?"operation\\?":\\?"projects\\?"/.test(body)){held.push(r);await hold;}try{await r.fallback();}catch{}});
   const panel=page.getByTestId('common-memory-panel'),create=panel.getByRole('button',{name:'공통기억 만들기',exact:true}).first();
   if(path==='/')await panel.getByRole('button',{name:'공통기억 관리',exact:true}).click();await create.waitFor();
   let release;hold=new Promise(r=>release=r);await create.click();
   for(let i=0;i<200&&!held.length;i++)await page.waitForTimeout(50);assert.ok(held.length>0,`${path}: the inventory request is held`);
   assert.equal(await panel.getByRole('checkbox',{name:/등록 A/}).count(),0,'still loading');
   // A moment for the form's blocked report to reach the parent before reading the button.
   const back=panel.getByRole('button',{name:'목록으로 돌아가기',exact:true});await page.waitForTimeout(300);assert.equal(await back.isDisabled(),false,`${path}: the create form can be left while it loads`);
   await back.click();hold=null;release();await create.waitFor();assert.equal(await panel.getByTestId('meta-common-memory-panel').count(),0);
   assert.deepEqual(errors,[]);await page.close();
   report.push({engine:engineName,width:390,surface:path==='/'?'mac-fixture':'phone',journeys:['create-exit-while-loading'],errors:0});}
 }finally{await browser.close();fixture.stop();}
}
console.log(JSON.stringify({fixture:true,physicalDevice:false,report},null,2));
