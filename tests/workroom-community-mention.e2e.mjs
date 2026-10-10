/** 커뮤니티 차원의 `@`·`#` — 실제 AiTerminalPanel을 띄워 기기 이름 접두가 후보·전달 대상을 바꾸는지 본다.
 * Start isolated Vite on 127.0.0.1:9000, then: node tests/workroom-community-mention.e2e.mjs
 * 모든 API와 기기 요청은 합성이다. 실제 PTY·프로젝트·다른 Mac에 접근하지 않는다.
 */
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const origin=process.env.WORKROOM_MENTION_ORIGIN||'http://127.0.0.1:9000';
assert.equal(new URL(origin).hostname,'127.0.0.1');
const source=await fetch(`${origin}/src/AiTerminalPanel.tsx`).then(r=>{assert.equal(r.status,200,'Start isolated Vite first');return r.text();});
const main=await fetch(`${origin}/src/main.tsx`).then(r=>r.text());
const react=source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1];
const reactDom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
assert.ok(react&&reactDom,'Use the actual Vite dependency versions');

const LOCAL=[{targetId:'fixture-local-ops',label:'AgentsToZ-OPS · 총괄'},{targetId:'fixture-local-shadow',label:'ShadowLoop'}];
const TWO=[{targetId:'two-ops',label:'총괄(아젠투지2호)'},{targetId:'two-blog',label:'블로그'}];
const THREE=[{targetId:'three-ops',label:'총괄(아젠투지3호)'}];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,message,timeout=8000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await sleep(25);}assert.fail(message);}

const html=`<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};
import '/src/index.css';import '/src/workspaceDesign.css';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
document.documentElement.dataset.appTheme='gray';
const {AiTerminalPanel}=await import('/src/AiTerminalPanel.tsx');
const LOCAL=${JSON.stringify(LOCAL)},TWO=${JSON.stringify(TWO)},THREE=${JSON.stringify(THREE)};
// 합성 로그: 기기별 요청과 목록 요청 횟수를 그대로 본다.
window.__calls={device:[],projectRequests:[],local:[]};
const localSession={id:'fixture-session-local',targetId:LOCAL[0].targetId,agent:'claude',state:'running',createdAt:'2026-10-05T00:00:00Z',exitCode:null,cols:100,rows:28};
const localTransport=async request=>{
  window.__calls.local.push(request);
  if(request.operation==='list')return {sessions:[localSession]};
  if(request.operation==='read')return {session:localSession,chunks:[],nextCursor:Math.max(1,request.after??0),truncated:false,hasMore:false};
  return {session:localSession};
};
// 기기 요청 함수는 **기기마다 한 번만** 만든다 — 패널이 렌더마다 새로 만들지 않는지 보는 것이 이 fixture의 목적 중 하나다.
const made=new Map(),twoSession={id:'two-session',targetId:'two-blog',agent:'codex',state:'running',createdAt:'2026-10-05T01:00:00Z',exitCode:null,cols:100,rows:28};
const requester=deviceId=>{
  if(made.has(deviceId))return made.get(deviceId);
  const fn=async request=>{
    window.__calls.device.push({deviceId,operation:request.operation});
    if(request.operation==='list')return {sessions:deviceId==='ep-2'?[twoSession]:[]};
    if(request.operation==='read')return {session:twoSession,chunks:[],nextCursor:Math.max(1,request.after??0),truncated:false,hasMore:false};
    if(request.operation==='input')window.__handoff=(window.__handoff??'')+request.data;
    return {session:twoSession};
  };
  made.set(deviceId,fn);return fn;
};
function Harness(){
  const [three,setThree]=React.useState(null);
  const requestProjects=React.useCallback(deviceId=>{
    window.__calls.projectRequests.push(deviceId);
    // 3호는 나중에 도착한다 — 「받고 있습니다」를 거쳐 후보가 되는지 본다.
    if(deviceId==='ep-3')setTimeout(()=>setThree(THREE),400);
  },[]);
  const devices=React.useMemo(()=>[
    {deviceId:'ep-2',label:'아젠투지2호',projects:TWO},
    {deviceId:'ep-3',label:'아젠투지3호',...(three?{projects:three}:{})},
  ],[three]);
  const communityMention=React.useMemo(()=>({devices,requestProjects,requester}),[devices,requestProjects]);
  return React.createElement('div',{style:{display:'grid',gridTemplateColumns:'264px minmax(0,1fr)',minHeight:'100vh'}},
    React.createElement('aside',{style:{borderRight:'1px solid var(--line)',padding:'16px'}},'AgentsToZ · Fixture'),
    React.createElement('main',{style:{padding:'16px',minWidth:0}},
      React.createElement(AiTerminalPanel,{projects:LOCAL,transport:localTransport,deviceName:'아젠투지1호',
        sessionScope:'community-mention-fixture',communityMention,
        entry:{nonce:1,targetId:LOCAL[0].targetId,sessionId:localSession.id}})));
}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
</script>`;

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1100,height:1050},serviceWorkers:'block'});
const blocked=[];
await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin!==origin){blocked.push(url.origin+url.pathname);return route.abort('blockedbyclient');}
  if(url.pathname==='/__community-mention')return route.fulfill({contentType:'text/html',body:html});
  if(!url.pathname.startsWith('/api/'))return route.continue();
  if(url.pathname==='/api/agent-runtime/targets')return route.fulfill({json:{protocolVersion:'agentstoz-tasks-v2',targets:LOCAL,complete:true}});
  if(url.pathname==='/api/agent-runtime/terminals/access')return route.fulfill({json:{connections:[]}});
  if(url.pathname==='/api/ai-usage/codex')return route.fulfill({json:{rateLimits:{primary:null,secondary:null},source:'fixture'}});
  return route.fulfill({json:{}});
});
const page=await context.newPage();
const errors=[];page.on('pageerror',error=>errors.push(String(error)));
await page.goto(`${origin}/__community-mention`);
await page.waitForSelector('[data-testid="ai-terminal-panel"]');
// 실행 중인 세션이 하나 있는 화면에서 시작한다(입력칸이 있어야 `@`를 쓸 수 있다).
await until(async()=>await page.locator('[data-testid="workroom-command-composer"]').count()>0,'The running session composer never appeared');
const composer=page.getByLabel('워크룸 입력');
const results=[];
const check=async(name,body)=>{try{await body();results.push(['ok',name]);}catch(error){results.push(['FAIL',name,String(error)]);}};
const send=page.locator('[data-testid="workroom-command-composer"] .ai-terminal-start');

await check('a device name before @ swaps the candidates for that device’s projects',async()=>{
  await composer.fill('');await composer.type('2호 @블');
  await until(async()=>await page.locator('[data-testid="workroom-mention-device"]').count()>0,'No device row in the mention menu');
  assert.equal((await page.locator('[data-testid="workroom-mention-device"]').innerText()).trim(),'아젠투지2호의 프로젝트');
  const options=await page.locator('[data-testid="workroom-mention-menu"] [role="option"]').allInnerTexts();
  assert.equal(options.length,1,`Expected only 블로그, got ${JSON.stringify(options)}`);
  assert.ok(options[0].includes('블로그'),JSON.stringify(options));
  assert.ok(!options.join(' ').includes('ShadowLoop'),'Local projects must not be offered under a device name');
});

await check('a list that has not arrived says so, and is asked for exactly once',async()=>{
  await composer.fill('');await composer.type('3호 @');
  await until(async()=>await page.locator('[data-testid="workroom-mention-loading"]').count()>0,'No loading row for a device with no list yet');
  await until(async()=>(await page.locator('[data-testid="workroom-mention-menu"] [role="option"]').allInnerTexts()).some(text=>text.includes('총괄(아젠투지3호)')),'The arrived list never became candidates');
  const asked=await page.evaluate(()=>window.__calls.projectRequests.filter(id=>id==='ep-3').length);
  assert.equal(asked,1,`requestProjects should be asked once per device, was ${asked}`);
});

await check('picking @ names the device in the chip, the send button and reads its sessions once',async()=>{
  await composer.fill('');await composer.type('아젠투지2호 @블로');
  await until(async()=>await page.locator('[data-testid="workroom-mention-menu"] [role="option"]').count()>0,'No candidate to pick');
  await page.locator('[data-testid="workroom-mention-menu"] [role="option"]').first().click();
  await until(async()=>await page.locator('[data-testid="workroom-route-chip"]').count()>0,'No route chip after picking');
  const chip=await page.locator('[data-testid="workroom-route-chip"]').innerText();
  assert.ok(chip.includes('아젠투지2호 · 블로그'),chip);
  // 기기 이름까지 함께 지워진다 — 남은 글이 그대로 요청이 된다.
  assert.equal(await composer.inputValue(),'');
  await until(async()=>(await send.innerText()).includes('아젠투지2호에 전달'),'The send button never named the device');
  await composer.type('배포 로그 확인해 줘');
  await sleep(600);
  const lists=await page.evaluate(()=>window.__calls.device.filter(call=>call.deviceId==='ep-2'&&call.operation==='list').length);
  assert.equal(lists,1,`The receiving device’s sessions must be read once, not per render (was ${lists})`);
  // 그 기기에서 실행 중인 세션이 있으므로 「전달」이라고 말한다.
  await until(async()=>await page.locator('[data-testid="workroom-route-plan"][data-route-plan="deliver"]').count()>0,'The preview did not resolve to deliver');
  assert.ok((await page.locator('[data-testid="workroom-route-plan"]').innerText()).includes('아젠투지2호 · 블로그'));
});

await check('delivering types the handoff into that device\u2019s session with the sending device named',async()=>{
  const dialogs=[];page.on('dialog',dialog=>{dialogs.push(dialog.message());void dialog.accept();});
  await send.click();
  await until(async()=>await page.locator('[data-testid="workroom-route-receipt"]').count()>0,'No receipt after delivering');
  assert.ok(dialogs.some(message=>message.includes('아젠투지2호 · 블로그')),JSON.stringify(dialogs));
  const typedText=await page.evaluate(()=>window.__calls.device.filter(call=>call.deviceId==='ep-2'&&call.operation==='input').length);
  assert.ok(typedText>0,'The handoff was never typed into the other device');
  const handoff=await page.evaluate(()=>window.__handoff??'');
  assert.ok(handoff.includes('보낸 기기: 아젠투지1호'),handoff);
  assert.ok(handoff.includes('받는 프로젝트: 아젠투지2호 · 블로그'),handoff);
  // 전달 뒤 보내는 쪽은 자기 세션에 남고, 다른 기기의 세션으로는 이 화면에서 이동하지 않는다.
  assert.equal(await page.locator('[data-testid="workroom-route-jump"]').count(),0,'A cross-device receipt must not offer a jump in this screen');
  assert.equal(await composer.inputValue(),'');
});

await check('# under a device name keeps a readable token and a chip that names the device',async()=>{
  if(await page.locator('[data-testid="workroom-route-chip"]').count())await page.locator('[data-testid="workroom-route-chip"]').click();
  await composer.fill('');await composer.type('2호 #블로');
  await until(async()=>await page.locator('[data-testid="workroom-mention-menu"] [role="option"]').count()>0,'No reference candidate');
  await page.locator('[data-testid="workroom-mention-menu"] [role="option"]').first().click();
  await until(async()=>(await composer.inputValue()).includes('#아젠투지2호/블로그'),'The reference token is not in the draft');
  const chip=await page.locator('[data-testid="workroom-reference-chip"]').innerText();
  assert.ok(chip.includes('아젠투지2호 · 블로그'),chip);
});

await check('the new-window row lets you pick which of the four CLIs opens, and can still unfold the full launch controls',async()=>{
  // 전용 창에서는 실행 칸이 접혀 있고 이 줄이 유일한 실행 컨트롤이다 — AI를 여기서 고를 수 있어야 한다.
  const row=page.locator('[data-testid="workroom-new-window"]');
  await until(async()=>await row.count()>0,'The new-window button is missing');
  assert.equal((await row.innerText()).trim(),'작업 하나 더 · 새 창');
  const picker=page.locator('[data-testid="workroom-new-window-agent"]');
  assert.equal(await picker.count(),1,'No AI picker beside the new-window button');
  const options=await picker.locator('option').allInnerTexts();
  assert.equal(options.length,4,`All four CLIs must be offered, got ${JSON.stringify(options)}`);
  await picker.selectOption('claude');
  assert.equal(await picker.inputValue(),'claude');
  // 프로젝트까지 바꾸려면 접힌 실행 칸을 펼쳐야 하고, 그 길이 이 줄에 남아 있어야 한다.
  const toggle=page.locator('[data-testid="workroom-composer-toggle"]');
  assert.equal(await toggle.count(),1,'The unfold path disappeared from the new-window row');
  await toggle.click();
  await until(async()=>await page.getByLabel('터미널 프로젝트').count()>0,'Unfolding did not reveal the project select');
  await until(async()=>await page.getByLabel('터미널 AI').count()>0,'Unfolding did not reveal the AI select');
  // 펼친 칸의 AI 선택과 같은 상태다 — 두 칸이 다른 값을 들고 있으면 어느 쪽이 열릴지 알 수 없다.
  assert.equal(await page.getByLabel('터미널 AI').inputValue(),'claude');
  await page.locator('[data-testid="workroom-composer-toggle"]').click();
});

await check('a plain @ still offers this device’s own projects',async()=>{
  await composer.fill('');await composer.type('@Shadow');
  await until(async()=>(await page.locator('[data-testid="workroom-mention-menu"] [role="option"]').allInnerTexts()).some(text=>text.includes('ShadowLoop')),'Local mentions regressed');
  assert.equal(await page.locator('[data-testid="workroom-mention-device"]').count(),0,'A local mention must not claim a device');
});

await browser.close();
assert.deepEqual(blocked,[],`No request may leave the fixture origin: ${JSON.stringify(blocked)}`);
const ignorable=errors.filter(text=>!/ResizeObserver|Failed to fetch/.test(text));
for(const [status,name,detail] of results)console.log(`${status==='ok'?'✓':'✗'} ${name}${detail?`\n    ${detail}`:''}`);
if(ignorable.length)console.log('page errors:',ignorable);
const failed=results.filter(([status])=>status!=='ok');
console.log(`${results.length-failed.length}/${results.length} checks passed`);
if(failed.length||ignorable.length)process.exit(1);
