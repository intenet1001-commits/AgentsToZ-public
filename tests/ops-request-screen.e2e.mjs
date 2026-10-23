/** Real OPS request composer on the owned loopback fixture (tests/fixtures/ops-request-screen.ts).
 * Starts that fixture itself, refuses every request that is not its origin, and stops only what it started.
 * No installed app, API 3001, provider, credentials or remote device is contacted.
 *
 *   bun tests/ops-request-screen.e2e.mjs
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';

const root=new URL('../',import.meta.url);
const fixture=spawn(process.execPath,['tests/fixtures/ops-request-screen.ts'],{cwd:root,stdio:['ignore','pipe','pipe']});
let output='',origin='';
fixture.stdout.on('data',chunk=>{output=(output+chunk).slice(-4000);origin||=output.match(/OPS_SCREEN_ORIGIN=(\S+)/)?.[1]?.replace(/\/$/,'')??'';});
fixture.stderr.on('data',chunk=>{output=(output+chunk).slice(-4000);});
const control=async path=>(await fetch(origin+path)).json();

let browser;
async function open(){
  const context=await browser.newContext({viewport:{width:1000,height:900},serviceWorkers:'block'});
  const state={blocked:[],errors:[]};
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin!==origin){state.blocked.push(url.origin+url.pathname);return route.abort('blockedbyclient');}
    return route.continue();
  });
  const page=await context.newPage();page.on('pageerror',error=>state.errors.push(error.message));
  await page.clock.install();
  await page.goto(`${origin}/ops-request-fixture`);
  const panel=page.getByTestId('ops-request-panel');await panel.waitFor();
  return {context,page,panel,state,
    task:page.getByLabel('맡길 작업',{exact:true}),
    button:name=>panel.getByRole('button',{name,exact:true}),
    alert:panel.getByRole('alert'),
    requestId:async()=>(await panel.getByText(/^요청 ID:/).textContent()).replace('요청 ID:','').trim(),
    // The composer polls every 5 s; run the page clock instead of waiting in real time.
    poll:async()=>{await page.clock.runFor(5_500);await delay(150);}};
}
async function run(name,fn){
  await control('/fixture/reset');
  const f=await open();
  try{await fn(f);assert.deepEqual(f.state.blocked,[]);assert.deepEqual(f.state.errors,[]);console.log('PASS '+name);}
  finally{await f.context.close();}
}

try{
  for(let i=0;i<300&&!origin;i++){if(fixture.exitCode!==null)throw new Error(output||'Fixture exited');await delay(100);}
  assert.ok(origin,'The owned fixture must print its origin');
  browser=await chromium.launch();

  await run('a submitted task shows running, then the result and evidence, then offers a new task',async f=>{
    await f.task.fill('2호의 등록 프로젝트 상태를 확인해줘.');
    await f.button('상대 OPS 열고 작업 보내기').click();
    await f.panel.getByTestId('ops-request-result').getByText('처리 중').waitFor();
    await control('/fixture/finish');await f.poll();
    await f.panel.getByText('상대 기기에서 프로젝트 3개의 상태를 확인했습니다.').waitFor();
    await f.panel.getByText(/수행 근거:/).waitFor();
    await f.button('새 작업 작성').waitFor();
    assert.equal((await control('/fixture/state')).submissions,1);
  });

  await run('a refusal before admission is not a dead end: not-found offers a new task with a new request ID',async f=>{
    await control('/fixture/reject');
    await f.task.fill('2호에서 빌드 상태를 확인해줘.');
    await f.button('상대 OPS 열고 작업 보내기').click();
    // A refusal alone is not proof: the composer looks the same ID up, and only not-found offers a new task.
    // That read is sent after the refused submit was answered, and the receiver takes requests in order.
    // Not-found is what is known, not proof of non-admission (the receiver's ledger is per OPS binding): say so.
    await f.alert.getByText('대기 중인 작업이 너무 많습니다. 상대 기기에서 이 요청을 찾지 못했습니다. 이미 실행 중이었는지 상대 워크룸에서 확인한 뒤 새 작업으로 보내세요.',{exact:true}).waitFor();
    const first=await f.requestId();
    await f.button('새 작업 작성').click();
    assert.equal(await f.task.inputValue(),'2호에서 빌드 상태를 확인해줘.');
    await f.button('상대 OPS 열고 작업 보내기').click();
    await f.panel.getByTestId('ops-request-result').getByText('처리 중').waitFor();
    const second=await f.requestId();
    assert.notEqual(second,first);
    const state=await control('/fixture/state');
    assert.deepEqual(state.attempts,[first,second]);assert.equal(state.receipt.requestId,second);assert.equal(state.submissions,1);
  });

  await run('reopening a refused request finds it was never admitted and offers a new task',async f=>{
    await control('/fixture/reject');
    await f.task.fill('다시 열어도 막히지 않아야 한다.');
    await f.button('상대 OPS 열고 작업 보내기').click();
    await f.alert.getByText(/이 요청을 찾지 못했습니다/).waitFor();
    const first=await f.requestId();
    await f.button('닫기').click();await f.panel.waitFor({state:'detached'});
    await f.page.getByRole('button',{name:'2호 OPS 부르기'}).click();await f.panel.waitFor();
    // The text never persists; only the ID does. Without the fix this screen had only 「같은 요청 상태 확인」.
    assert.equal(await f.requestId(),first);
    assert.equal(await f.task.count(),0);
    await f.button('새 작업 작성').click();
    await f.task.fill('새로 쓴 작업');
    await f.button('상대 OPS 열고 작업 보내기').click();
    await f.panel.getByTestId('ops-request-result').getByText('처리 중').waitFor();
    assert.notEqual(await f.requestId(),first);
  });

  await run('a timed-out submit is not a reason: a later not-found says only what is known',async f=>{
    await control('/fixture/timeout');
    await f.task.fill('2호가 잠든 사이에 보낸 작업');
    await f.button('상대 OPS 열고 작업 보내기').click();
    // The timeout says the outcome is unknown; the not-found read that follows must not quote it as a reason.
    await f.alert.getByText('상대 기기에서 이 요청을 찾지 못했습니다. 이미 실행 중이었는지 상대 워크룸에서 확인한 뒤 새 작업으로 보내세요.',{exact:true}).waitFor();
    await f.button('새 작업 작성').waitFor();
  });

  await run('an outdated receiver asks for an update at once, never "admission unknown"',async f=>{
    await control('/fixture/outdated');
    await f.task.fill('업데이트 전 2호에게 보낸 작업');
    await f.button('상대 OPS 열고 작업 보내기').click();
    // Read before the delayed status answer arrives: the submit's own answer already settles it.
    await f.alert.waitFor();
    const shown=await f.alert.textContent();
    assert.match(shown,/업데이트하세요/);assert.doesNotMatch(shown,/미확정/);
    await f.button('새 작업 작성').waitFor();
    assert.equal((await control('/fixture/state')).attempts.length,1);
  });

  await run('a refusal on this Mac before sending returns to the composer with the text kept',async f=>{
    await control('/fixture/outside');
    await f.task.fill('커뮤니티 밖에서 보낸 작업');
    await f.button('상대 OPS 열고 작업 보내기').click();
    await f.alert.getByText('기기 간 대화의 커뮤니티에 입장하세요. 요청은 보내지 않았습니다.').waitFor();
    assert.equal(await f.task.inputValue(),'커뮤니티 밖에서 보낸 작업');
    await f.button('상대 OPS 열고 작업 보내기').click();
    await f.panel.getByTestId('ops-request-result').getByText('처리 중').waitFor();
    assert.equal((await control('/fixture/state')).attempts.length,2);
  });

  await run('a lost answer keeps the same request ID and never submits a second task',async f=>{
    await control('/fixture/lost');
    await f.task.fill('응답이 사라져도 한 번만 실행');
    await f.button('상대 OPS 열고 작업 보내기').click();
    // The submit's answer was lost after admission; the next read of the same ID finds the task.
    await f.panel.getByTestId('ops-request-result').getByText('처리 중').waitFor();
    const first=await f.requestId();
    assert.equal(await f.requestId(),first);
    assert.equal(await f.button('새 작업 작성').count(),0);
    const state=await control('/fixture/state');
    assert.equal(state.submissions,1);assert.deepEqual(state.attempts,[first]);
  });

  await run('the limit is bytes, not characters: 4,000 Korean characters are blocked before sending',async f=>{
    await f.task.fill('한'.repeat(3_000));
    const counter=f.panel.getByTestId('ops-request-bytes');
    assert.equal(await counter.getAttribute('data-over'),'false');
    assert.equal(await f.button('상대 OPS 열고 작업 보내기').isEnabled(),true);
    await f.task.fill('한'.repeat(4_000));
    assert.equal(await f.task.inputValue(),'한'.repeat(4_000));
    assert.equal(await counter.getAttribute('data-over'),'true');
    assert.match(await counter.textContent(),/12,000 \/ 10,000바이트/);
    assert.equal(await f.button('상대 OPS 열고 작업 보내기').isDisabled(),true);
    assert.deepEqual((await control('/fixture/state')).attempts,[]);
  });
}finally{
  await browser?.close();
  if(fixture.exitCode===null){fixture.kill('SIGTERM');for(let i=0;i<50&&fixture.exitCode===null;i++)await delay(100);}
}
