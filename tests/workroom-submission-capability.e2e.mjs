/** W1 probe: a capability probe in flight must not undo the legacy fallback of a refused submission.
 *
 * A receiver that advertises terminal-submission-v1 but whose path refuses `submission` before anything runs (a
 * community executor up to v791 answers with the terminal-only sentence) sends the panel back to raw input: the next
 * click types the draft the old way. The panel's own `list` carries `capabilities:true` every poll. If one is in flight
 * when the refusal lands, its answer — which still lists the feature — used to switch submissions back on, so the next
 * click hit the same refusal again instead of the raw path the notice promised.
 *
 * Start isolated Vite on 127.0.0.1 (any free port), then: WORKROOM_CAPABILITY_ORIGIN=http://127.0.0.1:<port> node tests/workroom-submission-capability.e2e.mjs
 * Every request is synthetic: no PTY, project or other Mac is touched.
 */
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const origin=process.env.WORKROOM_CAPABILITY_ORIGIN||'http://127.0.0.1:9000';
assert.equal(new URL(origin).hostname,'127.0.0.1');
const source=await fetch(`${origin}/src/AiTerminalPanel.tsx`).then(r=>{assert.equal(r.status,200,'Start isolated Vite first');return r.text();});
const main=await fetch(`${origin}/src/main.tsx`).then(r=>r.text());
const react=source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1];
const reactDom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
assert.ok(react&&reactDom,'Use the actual Vite dependency versions');
const PROJECTS=[{targetId:'fixture-target',label:'Fixture'}];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,message,timeout=8000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await sleep(25);}assert.fail(message);}

const html=`<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};
import '/src/index.css';import '/src/workspaceDesign.css';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const {AiTerminalPanel}=await import('/src/AiTerminalPanel.tsx');
const {COMMUNITY_CONTROL_TERMINAL_ONLY_ERROR}=await import('/src/agentDialogueControl.ts');
const PROJECTS=${JSON.stringify(PROJECTS)};
const session={id:'fixture-session-0001',targetId:'fixture-target',agent:'codex',state:'running',createdAt:'2026-10-15T00:00:00Z',exitCode:null,cols:100,rows:28};
window.__calls=[];window.__held=null;window.__holdNextList=false;
const transport=async request=>{
  window.__calls.push({operation:request.operation,capabilities:!!request.capabilities,phase:request.submission?.phase});
  if(request.operation==='list'){
    const answer={sessions:[session],...(request.capabilities?{features:['terminal-submission-v1']}:{})};
    if(window.__holdNextList){window.__holdNextList=false;return new Promise(resolve=>{window.__held=()=>resolve(answer);});}
    return answer;
  }
  if(request.operation==='read')return {session,chunks:[],nextCursor:Math.max(1,request.after??0),truncated:false,hasMore:false};
  // The receiver's path refuses a submission before anything runs, as a community executor up to v791 does.
  if(request.operation==='submission')throw new Error(COMMUNITY_CONTROL_TERMINAL_ONLY_ERROR);
  return {session};
};
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(AiTerminalPanel,{projects:PROJECTS,transport,
  sessionScope:'capability-fixture',entry:{nonce:1,targetId:'fixture-target',sessionId:session.id}}));
</script>`;

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1100,height:900},serviceWorkers:'block'});
const blocked=[];
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin!==origin){blocked.push(url.origin+url.pathname);return route.abort('blockedbyclient');}
  if(url.pathname==='/__submission-capability')return route.fulfill({contentType:'text/html',body:html});
  if(!url.pathname.startsWith('/api/'))return route.continue();
  if(url.pathname==='/api/agent-runtime/targets')return route.fulfill({json:{protocolVersion:'agentstoz-tasks-v2',targets:PROJECTS,complete:true}});
  if(url.pathname==='/api/agent-runtime/terminals/access')return route.fulfill({json:{connections:[]}});
  return route.fulfill({json:{}});
});
const page=await context.newPage();
const errors=[];page.on('pageerror',error=>errors.push(String(error)));
await page.goto(`${origin}/__submission-capability`);
await until(async()=>await page.locator('[data-testid="workroom-command-composer"]').count()>0,'The running session composer never appeared');
const composer=page.getByLabel('워크룸 입력');
const send=page.locator('[data-testid="workroom-command-composer"] .ai-terminal-start');
const calls=()=>page.evaluate(()=>window.__calls);
const results=[];
const check=async(name,body)=>{try{await body();results.push(['ok',name]);}catch(error){results.push(['FAIL',name,String(error)]);}};

await check('a refused submission falls back to raw input even when a capability probe was in flight',async()=>{
  // The first list advertised the feature: submissions are on.
  await until(async()=>(await calls()).some(call=>call.operation==='list'&&call.capabilities),'No capability probe');
  // Hold the next poll's capability probe, so it is in flight when the refusal arrives.
  await page.evaluate(()=>{window.__holdNextList=true;});
  await until(async()=>await page.evaluate(()=>typeof window.__held==='function'),'The next list never started',6000);
  await composer.fill('첫 요청');await send.click();
  await until(async()=>(await calls()).some(call=>call.operation==='submission'),'No submission was sent');
  await until(async()=>(await page.locator('[role="alert"]').allInnerTexts()).some(text=>text.includes('전체 요청 제출을 아직 받지 않습니다')),'The unsupported notice never appeared');
  // The probe that was in flight answers now, still listing the feature.
  await page.evaluate(()=>window.__held());
  await sleep(300);
  assert.equal(await composer.inputValue(),'첫 요청','The draft must stay after a refused submission');
  const before=(await calls()).filter(call=>call.operation==='submission').length;
  await send.click();
  await until(async()=>(await calls()).some(call=>call.operation==='input'),'The next click did not type the draft the old way').catch(async error=>{throw new Error(error.message+': '+JSON.stringify((await calls()).filter(call=>call.operation!=='read')));});
  const after=(await calls()).filter(call=>call.operation==='submission').length;
  assert.equal(after,before,`The next click tried a submission again (${after-before} more) instead of the raw path`);
});

await browser.close();
assert.deepEqual(blocked,[],`No request may leave the fixture origin: ${JSON.stringify(blocked)}`);
const ignorable=errors.filter(text=>!/ResizeObserver|Failed to fetch/.test(text));
for(const [status,name,detail] of results)console.log(`${status==='ok'?'✓':'✗'} ${name}${detail?`\n    ${detail}`:''}`);
if(ignorable.length)console.log('page errors:',ignorable);
const failed=results.filter(([status])=>status!=='ok');
console.log(`${results.length-failed.length}/${results.length} checks passed`);
if(failed.length||ignorable.length)process.exit(1);
