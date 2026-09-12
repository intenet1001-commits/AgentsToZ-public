/** Run against an isolated Vite server; fixture refuses all actual transport. */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const base=process.env.TARGET??'http://127.0.0.1:9421';
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error('Local fixture URL required');
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1000,height:1050}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{const u=new URL(route.request().url());return u.origin===base?route.continue():route.abort();});
 await page.goto(base+'/tests/fixtures/cs-duty.html');
 await page.getByRole('button',{name:'CS 대직 · 질문 응답 설정',exact:true}).click();
 for(const provider of ['claude','codex','agy']){await page.getByLabel('답변 담당 AI',{exact:true}).selectOption(provider);assert((await page.getByLabel('세부 모델',{exact:true}).locator('option').count())>1);}
 await page.getByLabel('답변 담당 AI',{exact:true}).selectOption('claude');
 await page.getByLabel('대직용 카카오톡 프로필 이름').fill('테스트 봇');
 await page.getByRole('button',{name:'카카오톡 채팅방 목록 확인',exact:true}).click();
 await page.getByLabel('응대할 채팅방').selectOption('chat_fixture');
 await page.getByLabel('공유 안내 자료').fill('문의 시간은 평일 9시부터 17시입니다.');
 // The knowledge box is the only thing the model sees, so importing must land visibly in it
 // and must never let a picked path escape the project root.
 await page.getByRole('button',{name:'프로젝트 문서 불러오기',exact:true}).click();
 await page.locator('[data-testid="cs-duty-documents"] input[type=checkbox]').first().check();
 await page.getByRole('button',{name:/자료에 넣기$/}).click();
 await page.getByLabel('공유 안내 자료').filter({hasText:''}).waitFor();
 assert((await page.getByLabel('공유 안내 자료').inputValue()).includes('# README.md'),'imported document text must appear in the knowledge box');
 await page.getByRole('button',{name:'FAQ 추가',exact:true}).click();
 await page.getByLabel('FAQ 질문 1',{exact:true}).fill('문의 시간?');
 await page.getByLabel('FAQ 답변 1',{exact:true}).fill('평일 9~17시');
 await page.getByRole('button',{name:'설정 저장',exact:true}).click();
 const enable=page.getByRole('button',{name:'대직 ON · 자동 답변 허용',exact:true});
 assert.equal(await enable.isDisabled(),true);
 await page.getByRole('checkbox',{name:/이 Mac의 프로필과 채팅방을 확인했고/}).check();
 await enable.click();
 await page.getByRole('status').filter({hasText:'ON · 새 질문 대기'}).waitFor();
 // ON must say what it will not answer; the baseline rule was invisible before.
 await page.locator('[data-testid="cs-duty-waiting"]').filter({hasText:'3건은 기준점'}).waitFor();
 // A failed check has to name the step and the remedy, not collapse into one sentence.
 await page.locator('[data-testid="cs-duty-diagnose"]').click();
 await page.locator('[data-testid="cs-duty-check-window"]').filter({hasText:'별도 창으로 열어'}).waitFor();
 assert.equal(await page.locator('[data-testid="cs-duty-checks"] li').count(),3);
 await page.getByRole('button',{name:'대직 OFF',exact:true}).click();
 await page.getByRole('status').filter({hasText:'OFF'}).waitFor();
 for(const zoom of [1,1.25,1.5]){
  // Native webview zoom reduces the logical viewport; CSS zoom is not used by this app.
  await page.setViewportSize({width:Math.floor(1000/zoom),height:Math.floor(1050/zoom)});
  assert.equal(await page.locator('dialog').evaluate(d=>d.scrollWidth<=d.clientWidth+1),true,'No horizontal dialog overflow at '+zoom);
  assert.equal(await page.locator('dialog').evaluate(d=>{const r=d.getBoundingClientRect();return r.top>=0&&r.left>=0&&r.bottom<=innerHeight+1&&r.right<=innerWidth+1;}),true,'Dialog must remain fully inside logical viewport');
  await page.locator('dialog').evaluate(d=>d.scrollTop=0);
  await page.screenshot({path:'/tmp/cs-duty-ui-'+zoom+'.png'});
  await page.getByRole('button',{name:'대직 OFF',exact:true}).scrollIntoViewIfNeeded();
 }
 await page.setViewportSize({width:390,height:844});
 await page.evaluate(()=>document.documentElement.style.zoom='1');
 assert.equal(await page.locator('dialog').evaluate(d=>d.scrollWidth<=d.clientWidth+1),true,'No horizontal overflow on narrow screen');
 await page.screenshot({path:process.env.DUTY_SCREENSHOT_PATH??'/tmp/cs-duty-ui.png',fullPage:true});
 assert.deepEqual(errors,[]);
 const ops=await page.evaluate(()=>window.fixtureRequests);assert(ops.includes('save')&&ops.includes('enable')&&ops.includes('disable')&&ops.includes('diagnose'));
 console.log('CS duty UI passed: save, consent, ON/OFF, diagnosis checklist, baseline notice, 100/125/150%, narrow viewport; no real transport');
}finally{await browser.close();}
