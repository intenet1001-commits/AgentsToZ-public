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
// 4호·5호는 전체 요청 제출(terminal-submission-v1)을 광고한다. 4호는 결과를 확정하지 못하고(unknown), 5호의 경로는
// 제출을 실행 전에 거절한다(v791까지의 커뮤니티 실행기). 둘 다 자기 워크룸 화면의 sessionScope를 알린다.
const FOUR=[{targetId:'four-api',label:'API'}],FIVE=[{targetId:'five-web',label:'웹'}],SIX=[{targetId:'six-docs',label:'문서'}],SEVEN=[{targetId:'seven-notes',label:'노트'}];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,message,timeout=8000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await sleep(25);}assert.fail(message);}

const html=`<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};
import '/src/index.css';import '/src/workspaceDesign.css';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
document.documentElement.dataset.appTheme='gray';
const {AiTerminalPanel}=await import('/src/AiTerminalPanel.tsx');
const {COMMUNITY_CONTROL_TERMINAL_ONLY_ERROR}=await import('/src/agentDialogueControl.ts');
const LOCAL=${JSON.stringify(LOCAL)},TWO=${JSON.stringify(TWO)},THREE=${JSON.stringify(THREE)},FOUR=${JSON.stringify(FOUR)},FIVE=${JSON.stringify(FIVE)},SIX=${JSON.stringify(SIX)},SEVEN=${JSON.stringify(SEVEN)};
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
const fourSession={id:'four-session',targetId:'four-api',agent:'codex',state:'running',createdAt:'2026-10-05T02:00:00Z',exitCode:null,cols:100,rows:28};
const fiveSession={id:'five-session',targetId:'five-web',agent:'codex',state:'running',createdAt:'2026-10-05T03:00:00Z',exitCode:null,cols:100,rows:28};
const deviceSession={'ep-2':twoSession,'ep-4':fourSession,'ep-5':fiveSession};
const submits=deviceId=>deviceId==='ep-4'||deviceId==='ep-5'||deviceId==='ep-6';
const sixLaunched=[];
const requester=deviceId=>{
  if(made.has(deviceId))return made.get(deviceId);
  const session=deviceSession[deviceId]??twoSession;
  const fn=async request=>{
    window.__calls.device.push({deviceId,operation:request.operation,phase:request.submission?.phase});
    // 7호도 launch 영수증을 광고한다. 이 브라우저의 저장소가 막혀 있을 때 그 기기로 가는 새 세션은 일반 시작이어야 한다.
    if(deviceId==='ep-7'){
      if(request.operation==='list')return {sessions:[],...(request.capabilities?{features:['terminal-submission-v1','terminal-start-submission-v1']}:{})};
      if(request.operation==='submission')throw new Error('fixture: 7호 launch must not be used without storage');
      if(request.operation==='start'){window.__sevenStart=request.prompt??'';return {session:{id:'seven-started-1',targetId:request.targetId,agent:request.agent,state:'running',createdAt:'2026-10-15T00:00:00Z',exitCode:null,cols:100,rows:28}};}
      return {session:{id:'seven-started-1',targetId:'seven-notes',agent:'claude',state:'running',createdAt:'2026-10-15T00:00:00Z',exitCode:null,cols:100,rows:28},chunks:[],nextCursor:1,truncated:false,hasMore:false};
    }
    if(request.operation==='list'){
      if(deviceId==='ep-6')return {sessions:[...sixLaunched],...(request.capabilities?{features:['terminal-submission-v1','terminal-start-submission-v1']}:{})};
      return {sessions:deviceSession[deviceId]?[session]:[],...(submits(deviceId)&&request.capabilities?{features:['terminal-submission-v1']}:{})};
    }
    // 6호는 새 세션의 첫 요청을 launch 영수증으로 받는다(terminal-start-submission-v1). 영수증이 그 세션을 말한다.
    if(deviceId==='ep-6'&&request.operation==='submission'){
      const sub=request.submission;
      if(sub.phase==='recent')return {submissions:[]};
      if(request.sessionId!==undefined||!sub.launch)throw new Error('fixture: only launches here');
      const created={id:'six-launched-1',targetId:sub.launch.targetId,agent:sub.launch.agent,state:'running',createdAt:'2026-10-15T00:00:00Z',exitCode:null,cols:100,rows:28};
      sixLaunched.push(created);window.__sixLaunch=atob(sub.data);
      return {submission:{id:sub.id,storeId:'store-six-0001',epoch:'epoch-six-0001',revision:0,state:'written',sessionId:created.id,targetId:created.targetId,agent:created.agent},session:created};
    }
    if(request.operation==='read')return {session,chunks:[],nextCursor:Math.max(1,request.after??0),truncated:false,hasMore:false};
    if(request.operation==='submission'){
      if(deviceId==='ep-5')throw new Error(COMMUNITY_CONTROL_TERMINAL_ONLY_ERROR);
      const phase=request.submission.phase;
      if(phase==='recent')return {submissions:[]};
      // 4호는 받았지만 결과를 확정하지 못한다 — 그 상태 그대로 status에도 답한다.
      const id=request.submission.id;
      if(phase==='single'||phase==='begin')window.__fourSubmissionId=id;
      return {submission:{id,storeId:'store-four-0001',epoch:'epoch-four-0001',revision:3,state:phase==='single'||phase==='status'?'unknown':'prepared'}};
    }
    if(request.operation==='input'){const key=deviceId==='ep-5'?'__handoff5':'__handoff';window[key]=(window[key]??'')+request.data;}
    return {session};
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
    {deviceId:'ep-4',label:'아젠투지4호',projects:FOUR,sessionScope:'device-ep-4'},
    {deviceId:'ep-5',label:'아젠투지5호',projects:FIVE,sessionScope:'device-ep-5'},
    {deviceId:'ep-6',label:'아젠투지6호',projects:SIX,sessionScope:'device-ep-6'},
    {deviceId:'ep-7',label:'아젠투지7호',projects:SEVEN,sessionScope:'device-ep-7'},
  ],[three]);
  // 받는 기기의 워크룸 탭(그 기기의 sessionScope로 연 패널)을 나중에 띄워, 미확정 기록이 그 탭에 보이는지 본다.
  const [receiverTab,setReceiverTab]=React.useState(false);
  React.useEffect(()=>{window.__openReceiverTab=()=>setReceiverTab(true);window.__closeReceiverTab=()=>setReceiverTab(false);},[]);
  const communityMention=React.useMemo(()=>({devices,requestProjects,requester}),[devices,requestProjects]);
  return React.createElement('div',{style:{display:'grid',gridTemplateColumns:'264px minmax(0,1fr)',minHeight:'100vh'}},
    React.createElement('aside',{style:{borderRight:'1px solid var(--line)',padding:'16px'}},'AgentsToZ · Fixture'),
    React.createElement('main',{style:{padding:'16px',minWidth:0}},
      React.createElement(AiTerminalPanel,{projects:LOCAL,transport:localTransport,deviceName:'아젠투지1호',
        sessionScope:'community-mention-fixture',communityMention,
        entry:{nonce:1,targetId:LOCAL[0].targetId,sessionId:localSession.id}}),
      receiverTab&&React.createElement('section',{'data-testid':'fixture-receiver-tab'},
        React.createElement(AiTerminalPanel,{projects:FOUR,transport:requester('ep-4'),remote:true,deviceName:'아젠투지4호',
          sessionScope:'device-ep-4',entry:{nonce:1,targetId:'four-api',sessionId:fourSession.id}}))));
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
  // A pasted file is saved by its bytes (web build); this Mac's path is what a route to another Mac must not carry.
  if(url.pathname==='/api/agent-runtime/terminals/images'){const body=request.postDataJSON();if(body?.operation==='save-file')return route.fulfill({json:{kind:'file',path:`/Users/fixture/Library/Application Support/com.portmanager.portmanager/workroom-files/2026-10-16/101010-cccccccc-${body.name}`,name:body.name,bytes:10}});}
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

// w2-followups #2: a destination that advertises terminal-submission-v1 gets the handoff as one submission.
const pickDevice=async(prefix,label)=>{
  if(await page.locator('[data-testid="workroom-route-chip"]').count())await page.locator('[data-testid="workroom-route-chip"]').click();
  await composer.fill('');await composer.type(prefix);
  await until(async()=>(await page.locator('[data-testid="workroom-mention-menu"] [role="option"]').allInnerTexts()).some(text=>text.includes(label)),`No ${label} candidate`);
  await page.locator('[data-testid="workroom-mention-menu"] [role="option"]').filter({hasText:label}).first().click();
  await until(async()=>await page.locator('[data-testid="workroom-route-plan"][data-route-plan="deliver"]').count()>0,'The preview did not resolve to deliver');
};

await check('an uncertain submission keeps the draft, says so, and leaves the record where the receiver tab reads it',async()=>{
  await pickDevice('4호 @AP','API');
  await composer.type('테스트 돌려 줘');
  await send.click();
  await until(async()=>await page.locator('[data-testid="workroom-route-receipt"]').count()>0,'No receipt after the uncertain delivery');
  const receipt=await page.locator('[data-testid="workroom-route-receipt"]').innerText();
  assert.ok(receipt.includes('전달 결과 미확정'),receipt);
  assert.ok(receipt.includes('작성 중인 내용은 유지했습니다'),receipt);
  assert.equal(await composer.inputValue(),'테스트 돌려 줘','An uncertain delivery must keep the draft');
  const typed=await page.evaluate(()=>window.__calls.device.filter(call=>call.deviceId==='ep-4'&&call.operation==='input').length);
  assert.equal(typed,0,'An uncertain submission must never fall back to raw input');
  const submissions=await page.evaluate(()=>window.__calls.device.filter(call=>call.deviceId==='ep-4'&&call.operation==='submission'&&call.phase==='single').length);
  assert.equal(submissions,1,`Exactly one submission, never retried (was ${submissions})`);
  const stored=await page.evaluate(()=>sessionStorage.getItem('agentstoz:pending-submission:v1:device-ep-4:four-session'));
  assert.ok(stored&&JSON.parse(stored).id===await page.evaluate(()=>window.__fourSubmissionId),`The pending record is not under the receiver's scope: ${stored}`);
  // A second send to that receiver is refused while the record is unsettled — never a second submission.
  await send.click();
  await until(async()=>(await page.locator('[role="alert"]').allInnerTexts()).some(text=>text.includes('미확정')),'A second send to the unsettled receiver was not refused');
  assert.equal(await page.evaluate(()=>window.__calls.device.filter(call=>call.deviceId==='ep-4'&&call.operation==='submission'&&call.phase==='single').length),1);
  // The receiver's own tab shows the recovery banner.
  await page.evaluate(()=>window.__openReceiverTab());
  await until(async()=>await page.locator('[data-testid="fixture-receiver-tab"] [data-testid="workroom-submission-recovery"]').count()>0,'The receiver tab does not show the unsettled submission');
  await page.evaluate(()=>window.__closeReceiverTab());
  await until(async()=>await page.locator('[data-testid="fixture-receiver-tab"]').count()===0,'The receiver tab did not close');
});

await check('a receiver whose path refuses submission is marked legacy and the next send is typed the old way',async()=>{
  await pickDevice('5호 @웹','웹');
  await composer.type('빌드 확인');
  await send.click();
  await until(async()=>(await page.locator('[role="alert"]').allInnerTexts()).some(text=>text.includes('전체 요청 제출을 아직 받지 않습니다')),'The unsupported notice never appeared');
  assert.equal(await page.evaluate(()=>window.__handoff5??''),'','Nothing may be typed on the refusal itself');
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('agentstoz:pending-submission:v1:device-ep-5:five-session')),null,'A refused submission leaves no record');
  assert.equal(await composer.inputValue(),'빌드 확인','The draft stays for the user’s next click');
  await send.click();
  await until(async()=>(await page.evaluate(()=>window.__handoff5??'')).includes('빌드 확인'),'The next send was not typed into the receiver');
  const submissions=await page.evaluate(()=>window.__calls.device.filter(call=>call.deviceId==='ep-5'&&call.operation==='submission').length);
  assert.equal(submissions,1,`A legacy destination must not get another submission (was ${submissions})`);
});

await check('a new session on a device that takes launch receipts gets the handoff as one launch, never a plain start',async()=>{
  if(await page.locator('[data-testid="workroom-route-chip"]').count())await page.locator('[data-testid="workroom-route-chip"]').click();
  await composer.fill('');await composer.type('6호 @문');
  await until(async()=>(await page.locator('[data-testid="workroom-mention-menu"] [role="option"]').allInnerTexts()).some(text=>text.includes('문서')),'No 문서 candidate');
  await page.locator('[data-testid="workroom-mention-menu"] [role="option"]').filter({hasText:'문서'}).first().click();
  await until(async()=>await page.locator('[data-testid="workroom-route-plan"][data-route-plan="start"]').count()>0,'The preview did not resolve to a new session');
  await composer.type('목차 정리해 줘');
  await send.click();
  await until(async()=>await page.locator('[data-testid="workroom-route-receipt"]').count()>0,'No receipt after the launch');
  const receipt=await page.locator('[data-testid="workroom-route-receipt"]').innerText();
  assert.ok(receipt.includes('첫 요청으로 전달했습니다'),receipt);
  const ops=await page.evaluate(()=>window.__calls.device.filter(call=>call.deviceId==='ep-6').map(call=>call.operation+(call.phase?':'+call.phase:'')));
  assert.ok(!ops.includes('start')&&!ops.includes('input'),JSON.stringify(ops));
  assert.equal(ops.filter(op=>op==='submission:single').length,1,JSON.stringify(ops));
  const launched=await page.evaluate(()=>new TextDecoder().decode(Uint8Array.from(window.__sixLaunch??'',c=>c.charCodeAt(0))));
  assert.ok(launched.includes('목차 정리해 줘')&&launched.includes('보낸 기기: 아젠투지1호')&&launched.endsWith('\r'),launched);
  assert.equal(await composer.inputValue(),'');
});

// Review 2026-10-15 (finding 3): with site data blocked, the sessionStorage getter throws. A device route's launch
// record could not be kept or read there, so the route used to be refused as «unsettled» forever; it now takes a plain start.
await check('with blocked site data an @ route to a launch-capable device opens the session with a plain start',async()=>{
  if(await page.locator('[data-testid="workroom-route-chip"]').count())await page.locator('[data-testid="workroom-route-chip"]').click();
  await composer.fill('');await composer.type('7호 @노');
  await until(async()=>(await page.locator('[data-testid="workroom-mention-menu"] [role="option"]').allInnerTexts()).some(text=>text.includes('노트')),'No 노트 candidate');
  await page.locator('[data-testid="workroom-mention-menu"] [role="option"]').filter({hasText:'노트'}).first().click();
  await until(async()=>await page.locator('[data-testid="workroom-route-plan"][data-route-plan="start"]').count()>0,'The preview did not resolve to a new session');
  await composer.type('회의록 정리해 줘');
  await page.evaluate(()=>{Object.defineProperty(window,'sessionStorage',{configurable:true,get(){throw new DOMException('blocked','SecurityError');}});});
  try{
    await send.click();
    await until(async()=>await page.locator('[data-testid="workroom-route-receipt"]').count()>0||(await page.locator('[role="alert"]').allInnerTexts()).some(text=>text.includes('미확정')),'The route settled neither way');
    const alerts=await page.locator('[role="alert"]').allInnerTexts();
    assert.ok(!alerts.some(text=>text.includes('미확정')),`Refused as unsettled: ${alerts.join(' | ')}`);
    const ops=await page.evaluate(()=>window.__calls.device.filter(call=>call.deviceId==='ep-7').map(call=>call.operation));
    assert.ok(!ops.includes('submission'),JSON.stringify(ops));
    assert.ok((await page.evaluate(()=>window.__sevenStart??'')).includes('회의록 정리해 줘'),'The plain start carries the handoff');
  }finally{await page.evaluate(()=>{delete window.sessionStorage;});}
});

// S3 review (2026-10-16): an attachment names a file on this Mac by path. Another AgentsToZ would open whatever
// sits at that path there, so a route to another device is refused before anything is sent, and the draft stays.
await check('an @ route to another AgentsToZ with an attached file is refused and sends nothing',async()=>{
  if(await page.locator('[data-testid="workroom-route-chip"]').count())await page.locator('[data-testid="workroom-route-chip"]').click();
  await composer.fill('');
  await composer.evaluate(element=>{const data=new DataTransfer();data.items.add(new File([new TextEncoder().encode('# notes')],'notes.md',{type:'text/markdown'}));element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});
  await until(async()=>await page.getByTestId('workroom-file-chip').count()===1,'The pasted file never became a chip');
  await composer.type('2호 @블로');
  await until(async()=>await page.locator('[data-testid="workroom-mention-menu"] [role="option"]').count()>0,'No 블로그 candidate');
  await page.locator('[data-testid="workroom-mention-menu"] [role="option"]').first().click();
  await composer.type('이 노트 반영해 줘');
  await until(async()=>(await send.innerText()).includes('아젠투지2호에 전달'),'The send button never named the device');
  const before=await page.evaluate(()=>window.__calls.device.filter(call=>call.deviceId==='ep-2'&&['input','start','submission'].includes(call.operation)).length);
  // An earlier check accepts every dialog; this one only records whether a confirmation was even asked.
  const dialogs=[];const onDialog=dialog=>{dialogs.push(dialog.message());};page.on('dialog',onDialog);
  try{
    await send.click();
    await until(async()=>(await page.locator('[role="alert"]').allInnerTexts()).some(text=>text.includes('다른 아젠투지로 보낼 수 없습니다')),'No refusal for the attached file');
    await sleep(300);
    const after=await page.evaluate(()=>window.__calls.device.filter(call=>call.deviceId==='ep-2'&&['input','start','submission'].includes(call.operation)).length);
    assert.equal(after,before,'Nothing reaches the other device');
    assert.deepEqual(dialogs,[],'Refused before the confirmation');
    assert.equal(await composer.inputValue(),'이 노트 반영해 줘','The draft stays');
    assert.equal(await page.getByTestId('workroom-file-chip').count(),1,'The attachment stays');
  }finally{page.off('dialog',onDialog);}
  await page.getByRole('button',{name:'notes.md 빼기'}).click();
  if(await page.locator('[data-testid="workroom-route-chip"]').count())await page.locator('[data-testid="workroom-route-chip"]').click();
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
