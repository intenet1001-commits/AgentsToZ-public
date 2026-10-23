/**
 * P2 조회 묶음 화면 (격리 fixture, 가짜 호스트). 3001·실제 스레드 저장소에 닿지 않는다.
 * 실행, 결과·복사, 다시 열면 같은 요청 번호로 읽기만, 응답 유실 뒤 재실행 없이 확인, 꺼진 호스트, 좁은 화면.
 * 사용: bun tests/read-tool-batch-ui.mjs
 */
import {chromium,webkit} from 'playwright';
import assert from 'node:assert/strict';
const built=await Bun.build({entrypoints:['tests/fixtures/read-tool-batch/panel.tsx'],target:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'}});
if(!built.success)throw Error(built.logs.join('\n'));
const js=built.outputs.find(f=>f.path.endsWith('.js')),css=built.outputs.find(f=>f.path.endsWith('.css'));
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:r=>{
 const p=new URL(r.url).pathname;
 return p==='/app.js'?new Response(js,{headers:{'Content-Type':'text/javascript'}}):p==='/app.css'?new Response(css,{headers:{'Content-Type':'text/css'}}):new Response('<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;--bg:#131211;--surface:#1d1c19;--raised:#24221e;--ink:#f4efe3;--ink-3:#a8a29e;--accent:#ef995e;--danger:#f87171;--line-2:#383630;--scrim:#0008;font-family:system-ui}</style><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/app.js"></script>',{headers:{'Content-Type':'text/html'}});
}});
const calls=page=>page.evaluate(()=>window.calls);
try{for(const [name,engine] of Object.entries({chromium,webkit})){
 const browser=await engine.launch();try{
  const page=await browser.newPage({viewport:{width:1000,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(server.url.toString());
  await page.getByTestId('read-batch-open').click();
  const dialog=page.getByRole('dialog',{name:'조회 묶음 실행'});await dialog.waitFor();
  // A memory read needs a query before anything is sent.
  await dialog.getByRole('checkbox',{name:'관련 기억'}).check();await page.getByTestId('read-batch-run').click();
  await dialog.getByRole('alert').waitFor();assert.equal((await calls(page)).length,0,'no request without a memory query');
  await dialog.getByRole('checkbox',{name:'관련 기억'}).uncheck();
  // The report depends on the status step and cannot be chosen alone.
  await dialog.getByRole('checkbox',{name:'최근 검사 상태'}).uncheck();
  assert.equal(await dialog.getByRole('checkbox',{name:'최근 검사 보고서 (있을 때)'}).isChecked(),false);
  assert.equal(await dialog.getByRole('checkbox',{name:'최근 검사 보고서 (있을 때)'}).isDisabled(),true);
  await dialog.getByRole('checkbox',{name:'최근 검사 상태'}).check();await dialog.getByRole('checkbox',{name:'최근 검사 보고서 (있을 때)'}).check();
  await page.getByTestId('read-batch-run').click();await page.getByTestId('read-batch-result').waitFor();
  const [start]=await calls(page);assert.equal(start.operation,'batch.start');assert.equal(start.threadId,'thread-one');
  assert.deepEqual(start.plan.steps.map(s=>s.id),['git','workroom','tester','report']);
  assert.deepEqual(start.plan.steps.at(-1).dependsOn,['tester']);assert.equal(start.plan.steps.at(-1).condition,'on-report-present');
  assert.equal(await page.locator('.read-batch-stages>li').count(),4);
  await page.getByTestId('read-batch-copy').click();await dialog.getByText('선택한 결과를 복사했습니다.',{exact:false}).waitFor();
  const copied=(await page.evaluate(()=>window.copied)).at(-1);assert.match(copied,/<untrusted_read_tool_result>/);assert.match(copied,/git fixture summary/);
  // A finished ordinary batch can be saved as a work pack on a standard command (saving is the review).
  const saveBox=page.getByTestId('read-batch-pack-save');await saveBox.waitFor();
  await saveBox.getByRole('button',{name:'작업 팩 저장',exact:true}).click();await dialog.getByText('작업 팩으로 저장했습니다.',{exact:true}).waitFor();
  const saved=(await page.evaluate(()=>window.packSaves)).at(-1);assert.equal(saved.guideId,'cmd-status');assert.deepEqual(saved.plan.steps.map(s=>s.id),['git','workroom','tester','report']);
  // Reopening reads the same request ID; it never starts again.
  await dialog.getByRole('button',{name:'닫기',exact:true}).last().click();await page.getByTestId('read-batch-open').click();
  await page.getByTestId('read-batch-result').waitFor();
  const reopened=(await calls(page)).at(-1);assert.equal(reopened.operation,'batch.read');assert.equal(reopened.requestId,start.requestId);
  // A lost start response keeps its request ID and is checked, never replayed.
  await page.evaluate(()=>{window.mode='lost';});await dialog.getByRole('button',{name:'새 조회',exact:true}).click();
  await page.getByTestId('read-batch-run').click();await dialog.getByRole('alert').filter({hasText:'같은 요청 번호로 결과를 확인'}).waitFor();
  const lost=(await calls(page)).at(-1);assert.equal(lost.operation,'batch.start');assert.equal(await page.getByTestId('read-batch-run').count(),0,'no rerun while unconfirmed');
  await page.evaluate(()=>{window.mode='ok';});await dialog.getByRole('button',{name:'결과 다시 확인',exact:true}).click();await page.getByTestId('read-batch-result').waitFor();
  const checked=(await calls(page)).at(-1);assert.equal(checked.operation,'batch.read');assert.equal(checked.requestId,lost.requestId);
  assert.equal((await calls(page)).filter(c=>c.operation==='batch.start').length,2,'one start per explicit run');
  // The saved pack runs as an ordinary receipt with its read completion; a stale pack cannot be chosen.
  await dialog.getByRole('button',{name:'새 조회',exact:true}).click();
  const packSelect=page.getByTestId('read-batch-pack');await packSelect.waitFor();
  assert.equal(await packSelect.locator('option[value="stale-cmd"]').evaluate(n=>n.disabled),true,'a stale pack is not runnable');
  assert.equal(await packSelect.inputValue(),'cmd-status');
  await page.getByTestId('read-batch-pack-run').click();await page.getByTestId('read-batch-completion').waitFor();
  const packRun=(await calls(page)).at(-1);assert.equal(packRun.operation,'pack.run');assert.equal(packRun.guideId,'cmd-status');assert.deepEqual(packRun.values,{});
  assert.equal(await page.getByTestId('read-batch-completion').getAttribute('data-complete'),'true');
  assert.equal(await page.getByTestId('read-batch-pack-save').count(),0,'a pack run is not offered as a new pack');
  // A host with the feature off refuses the start; nothing durable remains, so the picker returns.
  await page.evaluate(()=>{window.mode='disabled';});await dialog.getByRole('button',{name:'새 조회',exact:true}).click();
  await page.getByTestId('read-batch-run').click();await dialog.getByRole('alert').filter({hasText:'아직 켜지지 않았습니다'}).waitFor();
  await page.getByTestId('read-batch-run').waitFor();
  // Narrow window: the dialog stays inside the viewport with no horizontal page scroll.
  await page.evaluate(()=>{window.mode='ok';});await page.getByTestId('read-batch-run').click();await page.getByTestId('read-batch-result').waitFor();
  for(const width of [390,800]){
   await page.setViewportSize({width,height:800});
   const box=await dialog.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width,`dialog fits ${width}px`);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`no horizontal overflow at ${width}px`);
  }
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('dialog[open]'));
  assert.equal(await page.getByTestId('read-batch-open').evaluate(n=>n===document.activeElement),true,'focus returns to the opener');
  assert.deepEqual(errors,[]);
  console.log(`${name}: run, dependency picker, copy, save-as-pack, pack run, reopen-read, lost-response check, disabled host, narrow layout, focus passed`);
 }finally{await browser.close();}
}}finally{server.stop(true);}
