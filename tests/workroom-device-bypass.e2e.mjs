/** 다른 Mac을 모는 워크룸은 권한 우회 없이 시작한다 — 그 Mac이 받지 않기 때문이다(3호 → 1호, 2026-10-07).
 * Start isolated Vite on 127.0.0.1:<port>, then: node tests/workroom-device-bypass.e2e.mjs
 * 모든 요청은 합성이다. 실제 PTY·다른 Mac에 접근하지 않는다.
 */
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const origin=process.env.WORKROOM_BYPASS_ORIGIN||'http://127.0.0.1:9000';
assert.equal(new URL(origin).hostname,'127.0.0.1');
const source=await fetch(`${origin}/src/AiTerminalPanel.tsx`).then(r=>{assert.equal(r.status,200,'Start isolated Vite first');return r.text();});
const main=await fetch(`${origin}/src/main.tsx`).then(r=>r.text());
const react=source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1];
const reactDom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
assert.ok(react&&reactDom,'Use the actual Vite dependency versions');
const PROJECTS=[{targetId:'one-ops',label:'총괄(아젠투지 1호)'}];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,message,timeout=8000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await sleep(25);}assert.fail(message);}

const html=`<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};
import '/src/index.css';import '/src/workspaceDesign.css';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
document.documentElement.dataset.appTheme='gray';
const {AiTerminalPanel}=await import('/src/AiTerminalPanel.tsx');
const {COMMUNITY_BYPASS_UNAVAILABLE}=await import('/src/workroomDeviceLabel.ts');
window.__starts=[];
const session={id:'s-1',targetId:'one-ops',agent:'codex',state:'running',createdAt:'2026-10-07T00:00:00Z',exitCode:null,cols:100,rows:28};
const transport=async request=>{
  if(request.operation==='list')return {sessions:window.__starts.length?[session]:[]};
  if(request.operation==='start'){window.__starts.push(request);return {session};}
  if(request.operation==='read')return {session,chunks:[],nextCursor:Math.max(1,request.after??0),truncated:false,hasMore:false};
  return {session};
};
// 저장된 선택은 「켜짐」이다 — 다른 Mac을 몰 때만 꺼져야 한다.
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(AiTerminalPanel,{remote:true,projects:${JSON.stringify(PROJECTS)},
  transport,deviceName:'아젠투지 1호',sessionScope:'bypass-fixture',bypassPermissions:true,bypassUnavailable:COMMUNITY_BYPASS_UNAVAILABLE}));
</script>`;

const browser=await chromium.launch({headless:true});
try{
  const context=await browser.newContext({viewport:{width:1000,height:900},serviceWorkers:'block'});
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==origin)return route.abort('blockedbyclient');
    if(url.pathname==='/__bypass')return route.fulfill({contentType:'text/html',body:html});
    if(url.pathname.startsWith('/api/'))return route.fulfill({json:{}});
    return route.continue();
  });
  const page=await context.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(String(error)));
  await page.goto(`${origin}/__bypass`);
  await page.waitForSelector('[data-testid="ai-terminal-panel"]');
  const toggle=page.getByTestId('workroom-launch-options');
  assert.equal(await toggle.getAttribute('data-bypass'),'off','A panel driving another Mac must not offer bypass');
  assert.match(await toggle.innerText(),/이 기기에서는 꺼짐/);
  await toggle.click();
  await page.getByTestId('workroom-bypass-unavailable').waitFor();
  assert.equal(await page.locator('.ai-terminal-options-content input[type="checkbox"]').isDisabled(),true);
  await page.getByRole('button',{name:'작업 시작'}).click();
  await until(async()=>(await page.evaluate(()=>window.__starts.length))>0,'No start request was sent');
  const start=await page.evaluate(()=>window.__starts[0]);
  assert.equal(start.bypassPermissions,false,'The start request carried bypass — the other Mac would refuse it');
  assert.deepEqual(errors,[]);
  console.log('device bypass e2e passed: toggle shows why, checkbox disabled, start sent without bypass');
}finally{await browser.close();}
