/** 맥의 커뮤니티 대화창 — 「기기」 줄 아래 접힌 한 줄, 펼친 뒤에만 읽고, 그 자리에서 보낸다.
 * Start isolated Vite on 127.0.0.1:9000, then: node tests/workroom-community-chat.e2e.mjs
 * 관리·제어 경로는 모두 합성이다. 실제 Supabase·다른 Mac·PTY에 닿지 않는다.
 */
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const origin=process.env.WORKROOM_CHAT_ORIGIN||'http://127.0.0.1:9000';
assert.equal(new URL(origin).hostname,'127.0.0.1');
const source=await fetch(`${origin}/src/WorkroomDeviceSwitch.tsx`).then(r=>{assert.equal(r.status,200,'Start isolated Vite first');return r.text();});
const main=await fetch(`${origin}/src/main.tsx`).then(r=>r.text());
const panel=await fetch(`${origin}/src/AiTerminalPanel.tsx`).then(r=>r.text());
const react=(source+panel).match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1];
const reactDom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
assert.ok(react&&reactDom,'Use the actual Vite dependency versions');

const LOCAL=[{targetId:'fixture-local-ops',label:'AgentsToZ-OPS · 총괄'}];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,message,timeout=8000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await sleep(25);}assert.fail(message);}

const html=`<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};
import '/src/index.css';import '/src/workspaceDesign.css';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
document.documentElement.dataset.appTheme='gray';
const {WorkroomDeviceSwitch}=await import('/src/WorkroomDeviceSwitch.tsx');
const LOCAL=${JSON.stringify(LOCAL)};
const session={id:'fixture-session',targetId:LOCAL[0].targetId,agent:'codex',state:'running',createdAt:'2026-10-05T00:00:00Z',exitCode:null,cols:100,rows:28};
const localTransport=async request=>{
  if(request.operation==='list')return {sessions:[session]};
  if(request.operation==='read')return {session,chunks:[],nextCursor:Math.max(1,request.after??0),truncated:false,hasMore:false};
  return {session};
};
ReactDOM.createRoot(document.getElementById('root')).render(
  React.createElement('div',{style:{padding:'16px'}},
    React.createElement(WorkroomDeviceSwitch,{projects:LOCAL,transport:localTransport,deviceName:'아젠투지1호',sessionScope:'chat-fixture'})));
</script>`;

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1100,height:1050},serviceWorkers:'block'});
const manage=[],blocked=[];
let messages=[{seq:1,from:'아젠투지2호 / 아젠투지(OPS)',self:false,kind:'question',text:'빌드 로그 확인했나요?',at:'2026-10-05T01:00:00Z'}];
let unread=1,sendFails=false;
await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin!==origin){blocked.push(url.origin+url.pathname);return route.abort('blockedbyclient');}
  if(url.pathname==='/__community-chat')return route.fulfill({contentType:'text/html',body:html});
  if(!url.pathname.startsWith('/api/'))return route.continue();
  if(url.pathname==='/api/agent-runtime/targets')return route.fulfill({json:{protocolVersion:'agentstoz-tasks-v2',targets:LOCAL,complete:true}});
  if(url.pathname==='/api/agent-runtime/terminals/access')return route.fulfill({json:{connections:[]}});
  if(url.pathname==='/api/agent-dialogue/control'){
    const body=request.postDataJSON();
    if(body?.operation==='devices')return route.fulfill({json:{success:true,inside:true,deviceId:'mac-one',
      unread,lastMessageAt:'2026-10-05T01:00:00Z',
      devices:[{endpointId:'11111111-1111-4111-8111-111111111111',deviceId:'mac-two',displayName:'아젠투지2호 / 아젠투지(OPS)',kind:'ops',lastSeenAt:null}]}});
    if(body?.operation==='call')return route.fulfill({json:{success:true,response:{ok:true,body:{projects:[],opsTargetId:null,deviceName:'아젠투지2호'}}}});
    return route.fulfill({json:{success:true}});
  }
  if(url.pathname==='/api/agent-dialogue/manage'){
    const body=request.postDataJSON();
    manage.push(body);
    if(sendFails&&body?.operation==='community-send'){sendFails=false;return route.fulfill({status:500,json:{success:false,error:'보내지 못했습니다.'}});}
    if(body?.operation==='community-send'){
      messages=[...messages,{seq:messages.length+1,from:'이 Mac',self:true,kind:'question',text:String(body.text),at:'2026-10-05T02:00:00Z'}];
      unread=0;
    }
    if(body?.operation==='community-read')unread=0;
    // ⚠️ 호스트와 **같은 커서 의미**를 흉내 낸다: 커서를 주지 않은 send 는 메시지를 돌려주지 않고,
    // 준 send 는 그 자리 뒤부터 준다(agentDialogueHost 의 `cursorGiven`). 이 규칙이 픽스처에 없어서
    // 「보낸 말이 12초 동안 안 보인다」가 통과했다.
    const cursorGiven=Number.isSafeInteger(body?.afterSeq);
    const visible=body?.operation==='community-send'&&!cursorGiven
      ?[]
      :messages.filter(message=>message.seq>(cursorGiven?Number(body.afterSeq):0)-(body?.operation==='community-send'?1:0));
    // 서버는 `remoteCommunityState()`가 만든 모양을 그대로 내보낸다 — 픽스처도 그 모양이어야 하고,
    // 화면의 정규화기가 모르는 키를 통째로 거절하므로 여기서 키를 늘리면 바로 드러난다.
    return route.fulfill({json:{success:true,community:{inside:true,roomId:'22222222-2222-4222-8222-222222222222',unread,
      members:[{name:'아젠투지2호 / 아젠투지(OPS)',kind:'ops',self:false}],
      devices:[{ref:'aaaaaaaaaaaaaaaa',name:'아젠투지2호',kind:'ops'}],
      messages:visible,nextSeq:messages.length+1}}});
  }
  return route.fulfill({json:{}});
});
const page=await context.newPage();
const errors=[];page.on('pageerror',error=>errors.push(String(error)));
await page.goto(`${origin}/__community-chat`);
await page.waitForSelector('[data-testid="workroom-device-switch"]');
const results=[];
const check=async(name,body)=>{try{await body();results.push(['ok',name]);}catch(error){results.push(['FAIL',name,String(error)]);}};

await check('collapsed, it is one line that names the community and the unread count — and asks nothing',async()=>{
  const toggle=page.locator('[data-testid="workroom-community-toggle"]');
  await until(async()=>await toggle.count()>0,'No community line under the device row');
  const text=await toggle.innerText();
  assert.ok(text.includes('커뮤니티'),text);
  assert.ok(text.includes('함께 있는 대상 1개'),text);
  assert.ok(text.includes('읽지 않음 1개'),text);
  assert.equal(await page.locator('[data-testid="workroom-community-log"]').count(),0,'The log must stay closed');
  // ⚠️ 접힌 동안은 관리 경로를 두드리지 않는다 — 개수는 기기 조회의 덤으로 온다.
  await sleep(600);
  assert.deepEqual(manage,[],`Collapsed must send no manage request, got ${JSON.stringify(manage)}`);
});

await check('expanding reads once and shows what the other AgentsToZ said',async()=>{
  await page.locator('[data-testid="workroom-community-toggle"]').click();
  await until(async()=>await page.locator('[data-testid="workroom-community-log"]').count()>0,'The log did not open');
  await until(async()=>(await page.locator('[data-testid="workroom-community-log"]').innerText()).includes('빌드 로그 확인했나요?'),'The received message never rendered');
  const reads=manage.filter(body=>body.operation==='community-read');
  assert.equal(reads.length,1,`One read per open, got ${reads.length}`);
  assert.equal(reads[0].afterSeq,undefined,'The first read starts from the beginning of what this Mac may see');
  assert.ok((await page.locator('[data-testid="workroom-community-log"]').innerText()).includes('아젠투지2호'),'The sender is not named');
});

await check('sending puts the text on the manage route and shows it as this Mac',async()=>{
  const draft=page.locator('[data-testid="workroom-community-draft"]');
  await draft.fill('빌드 끝났습니다. 612 올렸습니다.');
  await page.locator('[data-testid="workroom-community-send"]').click();
  await until(async()=>manage.some(body=>body.operation==='community-send'),'No send request');
  const sent=manage.find(body=>body.operation==='community-send');
  assert.equal(sent.text,'빌드 끝났습니다. 612 올렸습니다.');
  assert.ok(typeof sent.requestId==='string'&&sent.requestId.length>=8,'A send must carry a request id so a retry is not a second message');
  // 커서를 함께 보내야 호스트가 **자기 줄까지** 돌려준다 — 없으면 12초 뒤에야 보인다.
  assert.ok(Number.isSafeInteger(sent.afterSeq),`A send must carry the read cursor, got ${JSON.stringify(sent.afterSeq)}`);
  await until(async()=>(await page.locator('[data-testid="workroom-community-log"]').innerText()).includes('612 올렸습니다'),'The sent message never appeared');
  assert.ok((await page.locator('[data-testid="workroom-community-log"]').innerText()).includes('이 Mac'));
  assert.equal(await draft.inputValue(),'','The draft must clear after sending');
});

await check('the empty first-request box is folded even with no running session, and opens on demand',async()=>{
  // 다른 아젠투지를 막 고른 직후가 바로 이 화면이다 — 세션이 0개여도 빈 칸이 먼저 보이지 않아야 한다.
  assert.equal(await page.locator('[data-testid="workroom-composer"]').count(),0,'The empty new-task form must start folded');
  const toggle=page.locator('[data-testid="workroom-composer-toggle"]');
  await until(async()=>await toggle.count()>0,'No way to open the new-task form');
  await toggle.click();
  await until(async()=>await page.locator('[data-testid="workroom-composer"]').count()>0,'The form did not open');
  await toggle.click();
  await until(async()=>await page.locator('[data-testid="workroom-composer"]').count()===0,'The form did not fold again');
});

await check('a failed send keeps the draft',async()=>{
  const draft=page.locator('[data-testid="workroom-community-draft"]');
  await draft.fill('실패해도 남아야 한다');
  sendFails=true;
  await page.locator('[data-testid="workroom-community-send"]').click();
  await until(async()=>await page.locator('[data-testid="workroom-community-error"]').count()>0,'No error after a failed send');
  assert.equal(await draft.inputValue(),'실패해도 남아야 한다','The draft must survive a failed send');
  await draft.fill('');
});

await check('polling never touches the typing box, and pauses while Hangul is being composed',async()=>{
  // VOC 2026-10-05 「타이핑이 잘 안 된다」 — 조합 중 입력칸 subtree가 다시 그려지지 않아야 한다.
  // 앞 검사에서 이미 펼쳐 둔 상태를 그대로 쓴다 — 여기서 토글하면 닫혀 버린다.
  const draft=page.locator('[data-testid="workroom-community-draft"]');
  await until(async()=>await draft.count()>0,'The compose box is not open');
  await draft.click();
  // 조합을 시작한 상태로 둔 채 폴링 주기를 지나가게 한다.
  await draft.evaluate(node=>node.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})));
  const before=manage.filter(body=>body.operation==='community-read').length;
  await sleep(600);
  assert.equal(manage.filter(body=>body.operation==='community-read').length,before,'A read must not run while composing');
  await draft.evaluate(node=>node.dispatchEvent(new CompositionEvent('compositionend',{data:'한글',bubbles:true})));
  // 입력칸은 자기 안에서만 값을 들고 있으므로, 바깥 상태가 바뀌어도 쓰던 글이 살아 있다.
  await draft.fill('조합 뒤에도 남는다');
  await page.evaluate(()=>window.dispatchEvent(new Event('resize')));
  await sleep(300);
  assert.equal(await draft.inputValue(),'조합 뒤에도 남는다');
});

await check('collapsing stops the polling',async()=>{
  await page.locator('[data-testid="workroom-community-toggle"]').click();
  await until(async()=>await page.locator('[data-testid="workroom-community-log"]').count()===0,'The log did not close');
  const before=manage.length;
  await sleep(700);
  assert.equal(manage.length,before,'A closed chat must not keep polling');
});

await browser.close();
assert.deepEqual(blocked,[],`No request may leave the fixture origin: ${JSON.stringify(blocked)}`);
const ignorable=errors.filter(text=>!/ResizeObserver|Failed to fetch/.test(text));
for(const [status,name,detail] of results)console.log(`${status==='ok'?'✓':'✗'} ${name}${detail?`\n    ${detail}`:''}`);
if(ignorable.length)console.log('page errors:',ignorable);
const failed=results.filter(([status])=>status!=='ok');
console.log(`${results.length-failed.length}/${results.length} checks passed`);
if(failed.length||ignorable.length)process.exit(1);
