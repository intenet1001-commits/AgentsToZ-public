/** 「현재 세션에 전송」 after a request the host refused, or whose answer was lost (2026-10-30).
 *
 * Installed 1577: Claude stopped taking requests from its second one and Codex from its first, under 「앞서 보낸 요청의 전송
 * 결과를 확인해야 합니다」. The host had refused each request before its write fence and left a `prepared` receipt, and the
 * panel fenced the composer on it for good. Now a refusal is recorded `rejected`: the panel's one read-only status after
 * the failure settles it, the draft and the refusal stay, and the next distinct request goes once. A lost answer still
 * fences the composer and is never re-sent; its manual check settles it. Main window and popout, button and Enter, and
 * a reload all read the same receipt per request id.
 *
 * Start isolated Vite on 127.0.0.1 (any free port), then: WORKROOM_REFUSAL_ORIGIN=http://127.0.0.1:<port> node tests/workroom-submission-refusal.e2e.mjs
 * Every request is synthetic: no PTY, CLI, project or other Mac is touched.
 */
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const origin=process.env.WORKROOM_REFUSAL_ORIGIN||'http://127.0.0.1:9000';
assert.equal(new URL(origin).hostname,'127.0.0.1');
const source=await fetch(`${origin}/src/AiTerminalPanel.tsx`).then(r=>{assert.equal(r.status,200,'Start isolated Vite first');return r.text();});
const main=await fetch(`${origin}/src/main.tsx`).then(r=>r.text());
const react=source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1];
const reactDom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
assert.ok(react&&reactDom,'Use the actual Vite dependency versions');
const PROJECTS=[{targetId:'fixture-target',label:'Fixture'}];
const REFUSAL='CLI의 승인·선택 화면에서는 에포트를 자동 변경하지 않습니다. 원본 워크룸을 확인하세요. 작성한 요청은 유지했습니다.';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,message,timeout=8000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await sleep(25);}assert.fail(message);}

// The host's receipt store lives in this tab's sessionStorage, so a reload asks the same host about the same ids.
const html=popout=>`<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};
import '/src/index.css';import '/src/workspaceDesign.css';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const {AiTerminalPanel}=await import('/src/AiTerminalPanel.tsx');
const PROJECTS=${JSON.stringify(PROJECTS)};
const session={id:'fixture-session-0001',targetId:'fixture-target',agent:'claude',state:'running',createdAt:'2026-10-30T00:00:00Z',exitCode:null,cols:100,rows:28};
const other={...session,id:'fixture-session-0002',createdAt:'2026-10-30T00:00:01Z'};
const sessionOf=id=>id===other.id?other:session;
const KEY='fixture-host-store';
const load=()=>JSON.parse(sessionStorage.getItem(KEY)||'{"receipts":{},"calls":[],"typed":[],"mode":"write"}');
const save=store=>sessionStorage.setItem(KEY,JSON.stringify(store));
window.__host={get:load,set:patch=>{const store=load();Object.assign(store,patch);save(store);},receipt:(id,state)=>{const store=load();store.receipts[id]=state;save(store);}};
const receipt=(id,state)=>({id,storeId:'fixture-store',epoch:'fixture-epoch',revision:0,state});
const decode=data=>new TextDecoder().decode(Uint8Array.from(atob(data),c=>c.charCodeAt(0)));
const transport=async request=>{
  if(request.operation==='list'){if(request.capabilities)window.__probed=true;return {sessions:[session,other],...(request.capabilities?{features:['terminal-submission-v1']}:{})};}
  if(request.operation==='read')return {session:sessionOf(request.sessionId),chunks:[],nextCursor:Math.max(1,request.after??0),truncated:false,hasMore:false};
  if(request.operation!=='submission')return {session:sessionOf(request.sessionId)};
  const store=load(),sub=request.submission;
  store.calls.push({phase:sub.phase,id:sub.id,sessionId:request.sessionId});save(store);
  if(sub.phase==='status'){const state=store.receipts[sub.id];if(!state)throw new Error('같은 호스트 저장소의 제출 기록을 확인하지 못했습니다. 자동 재전송하지 않습니다.');return {submission:receipt(sub.id,state)};}
  if(sub.phase!=='single')throw new Error('fixture: single only');
  if(store.receipts[sub.id])return {submission:receipt(sub.id,store.receipts[sub.id])};
  // refuse: refused before the write fence (a question screen); lose: the host is still on it when the answer is lost.
  // refuse-slow: the refusal comes after the person has moved to another session.
  if(store.mode==='refuse-slow')await new Promise(resolve=>setTimeout(resolve,700));
  if(store.mode==='refuse'||store.mode==='refuse-slow'){store.receipts[sub.id]='rejected';save(store);throw new Error(${JSON.stringify(REFUSAL)});}
  if(store.mode==='lose'){store.receipts[sub.id]='prepared';save(store);throw new Error('The operation timed out.');}
  store.receipts[sub.id]='written';store.typed.push(decode(sub.data));save(store);return {submission:receipt(sub.id,'written')};
};
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(AiTerminalPanel,{projects:PROJECTS,transport,popout:${popout},
  sessionScope:'refusal-fixture',entry:{nonce:1,targetId:'fixture-target',sessionId:session.id}}));
</script>`;

const browser=await chromium.launch({headless:true});
const blocked=[],errors=[],results=[];
const check=async(name,body)=>{try{await body();results.push(['ok',name]);}catch(error){results.push(['FAIL',name,String(error)]);}};

for(const popout of [false,true]){
  const label=popout?'popout':'main window';
  const context=await browser.newContext({viewport:{width:1100,height:900},serviceWorkers:'block'});
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==origin){blocked.push(url.origin+url.pathname);return route.abort('blockedbyclient');}
    if(url.pathname==='/__submission-refusal')return route.fulfill({contentType:'text/html',body:html(popout)});
    if(!url.pathname.startsWith('/api/'))return route.continue();
    if(url.pathname==='/api/agent-runtime/targets')return route.fulfill({json:{protocolVersion:'agentstoz-tasks-v2',targets:PROJECTS,complete:true}});
    if(url.pathname==='/api/agent-runtime/terminals/access')return route.fulfill({json:{connections:[]}});
    return route.fulfill({json:{}});
  });
  const page=await context.newPage();
  page.on('pageerror',error=>errors.push(String(error)));
  const open=async()=>{
    await page.goto(`${origin}/__submission-refusal`);
    await until(async()=>await page.locator('[data-testid="workroom-command-composer"]').count()>0,'The running session composer never appeared');
  };
  await open();
  const composer=page.getByLabel('워크룸 입력');
  const send=page.locator('[data-testid="workroom-command-composer"] .ai-terminal-start');
  const banner=page.locator('[data-testid="workroom-submission-recovery"]');
  const host=()=>page.evaluate(()=>window.__host.get());
  const singles=async()=>(await host()).calls.filter(call=>call.phase==='single');
  const statusReads=async id=>(await host()).calls.filter(call=>call.phase==='status'&&call.id===id).length;
  const alerts=()=>page.locator('[role="alert"]').allInnerTexts();
  // Submissions are on once the first capability probe answered.
  await until(async()=>await page.evaluate(()=>window.__probed===true),'The panel never probed the host');await sleep(150);

  await check(`${label}: a refused request settles at once — the reason and the draft stay, and the next distinct request goes once by Enter`,async()=>{
    await page.evaluate(()=>window.__host.set({mode:'refuse'}));
    await composer.fill('첫 번째 요청');await send.click();
    await until(async()=>(await alerts()).some(text=>text.includes('승인·선택 화면')),'The refusal was not shown');
    // The panel's one read-only status of the same id finds it never ran: the banner goes without a click.
    await until(async()=>(await host()).calls.some(call=>call.phase==='status'),'No read-only status after the refusal');
    await until(async()=>await banner.count()===0,'The banner still fences the composer after a refusal');
    await sleep(200);
    assert.equal(await statusReads((await singles())[0].id),1,'The refused id must be read exactly once');
    assert.equal(await composer.inputValue(),'첫 번째 요청','The draft must stay after a refusal');
    assert.equal(await send.isDisabled(),false,'The send button must work again');
    assert.equal((await singles()).length,1,'The refused request must not be sent again on its own');
    // A distinct request, sent with Enter, is typed exactly once.
    await page.evaluate(()=>window.__host.set({mode:'write'}));
    await composer.fill('두 번째 요청');await composer.press('Enter');
    await until(async()=>(await host()).typed.length===1,'The next request was not typed');
    assert.deepEqual((await host()).typed,['두 번째 요청\r']);
    await until(async()=>await composer.inputValue()==='','The written request stayed in the composer');
    assert.equal(await banner.count(),0);
  });

  await check(`${label}: a lost answer keeps the fence and is never re-sent; the manual check settles it once the host wrote it`,async()=>{
    await page.evaluate(()=>window.__host.set({mode:'lose'}));
    await composer.fill('세 번째 요청');await send.click();
    await until(async()=>await banner.count()===1,'A lost answer must keep the banner');
    // The automatic status says the host is still on it: the banner stays and nothing goes again, by button or Enter.
    await until(async()=>(await host()).calls.filter(call=>call.phase==='status').length>=2,'No read-only status after the lost answer');
    await sleep(200);
    assert.equal(await statusReads((await singles()).at(-1).id),1,'The lost id must be read exactly once before any manual check');
    assert.equal(await banner.count(),1,'A prepared receipt must keep the banner');
    assert.equal(await send.isDisabled(),true,'The send button must stay fenced');
    await composer.press('Enter');await sleep(200);
    const lost=(await singles()).at(-1).id;
    assert.equal((await singles()).filter(call=>call.id===lost).length,1,'The lost request was sent again');
    assert.equal((await singles()).length,3,'Nothing else may be sent while the fence holds');
    // The host finishes it; 「제출 결과 확인」 reads the same id and settles it.
    await page.evaluate(id=>window.__host.receipt(id,'written'),lost);
    await banner.getByRole('button',{name:'제출 결과 확인'}).click();
    await until(async()=>await banner.count()===0,'The written receipt did not settle the banner');
    await until(async()=>await composer.inputValue()==='','The written request stayed in the composer');
    assert.equal((await singles()).length,3);
  });

  await check(`${label}: after a reload the same id's receipt decides — a refusal found later settles without a resend`,async()=>{
    await page.evaluate(()=>window.__host.set({mode:'lose'}));
    await composer.fill('네 번째 요청');await send.click();
    await until(async()=>await banner.count()===1,'A lost answer must keep the banner');
    const lost=(await singles()).at(-1).id;
    // The host refused it after the answer was lost (its readiness check ran out).
    await page.evaluate(id=>window.__host.receipt(id,'rejected'),lost);
    await open();
    await until(async()=>await page.locator('[data-testid="workroom-submission-recovery"]').count()===0,'The reloaded panel kept the fence of a refused request');
    assert.equal((await singles()).filter(call=>call.id===lost).length,1,'The refused request was sent again after the reload');
    // A new draft (the reloaded composer starts empty) can be sent again.
    await page.getByLabel('워크룸 입력').fill('다섯 번째 요청');
    assert.equal(await page.locator('[data-testid="workroom-command-composer"] .ai-terminal-start').isDisabled(),false,'The reloaded composer is still fenced');
  });

  await check(`${label}: a refusal that answers after a switch to another session settles its own session's record, read once`,async()=>{
    const switchTo=async sessionId=>{await page.locator(`[role="tab"][data-session-id="${sessionId}"]`).click();await until(async()=>await page.locator(`[role="tab"][data-session-id="${sessionId}"]`).getAttribute('aria-selected')==='true',`Could not switch to ${sessionId}`);};
    const stored=sessionId=>page.evaluate(key=>sessionStorage.getItem(key),'agentstoz:pending-submission:v1:refusal-fixture:'+sessionId);
    await page.evaluate(()=>window.__host.set({mode:'refuse-slow'}));
    await page.getByLabel('워크룸 입력').fill('여섯 번째 요청');
    await page.locator('[data-testid="workroom-command-composer"] .ai-terminal-start').click();
    await until(async()=>(await singles()).length>=1&&(await host()).calls.at(-1).phase==='single','The request was not sent');
    const refused=(await singles()).at(-1).id;
    assert.equal((await singles()).at(-1).sessionId,'fixture-session-0001');
    await switchTo('fixture-session-0002');
    // The refusal arrives while the other session is shown: the first session's record goes, read once, nothing re-sent.
    await until(async()=>await statusReads(refused)===1,'No read-only status after the late refusal');
    await until(async()=>await stored('fixture-session-0001')===null,'The refused record of the first session still fences it');
    assert.equal(await stored('fixture-session-0002'),null,'The other session must not take the record');
    assert.equal(await page.locator('[data-testid="workroom-submission-recovery"]').count(),0,'The other session is not fenced');
    await switchTo('fixture-session-0001');await sleep(300);
    assert.equal(await page.locator('[data-testid="workroom-submission-recovery"]').count(),0,'The first session is still fenced');
    assert.equal(await statusReads(refused),1,'The refused id must be read exactly once');
    assert.equal((await singles()).filter(call=>call.id===refused).length,1,'The refused request was sent again');
  });
  await context.close();
}

await browser.close();
assert.deepEqual(blocked,[],`No request may leave the fixture origin: ${JSON.stringify(blocked)}`);
const ignorable=errors.filter(text=>!/ResizeObserver|Failed to fetch/.test(text));
for(const [status,name,detail] of results)console.log(`${status==='ok'?'✓':'✗'} ${name}${detail?`\n    ${detail}`:''}`);
if(ignorable.length)console.log('page errors:',ignorable);
const failed=results.filter(([status])=>status!=='ok');
console.log(`${results.length-failed.length}/${results.length} checks passed`);
if(failed.length||ignorable.length)process.exit(1);
