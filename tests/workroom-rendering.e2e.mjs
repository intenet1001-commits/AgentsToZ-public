/** Actual production CSS and xterm rendering in Chromium and WebKit.
 * Run Vite on loopback first. All API requests are isolated fixtures.
 * Do not give the terminal a test-only height: that can hide native blank screens.
 */
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {chromium, webkit} from 'playwright';
const origin = process.env.WORKROOM_TEST_ORIGIN || 'http://127.0.0.1:9000';
assert.equal(new URL(origin).hostname, '127.0.0.1');
const source = await fetch(`${origin}/src/AiTerminalPanel.tsx`).then(r => { assert.equal(r.status, 200); return r.text(); });
const main = await fetch(`${origin}/src/main.tsx`).then(r => r.text());
const dependency = name => source.match(new RegExp(`"([^"\\n]*/node_modules/\\.vite/deps/${name}[^"\\n]*)"`))?.[1];
const react = dependency('react\\.js'), xterm = dependency('@xterm_xterm\\.js');
const reactDom = main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
assert.ok(react && reactDom && xterm);
const session = {id:'render-fixture-session',targetId:'render-fixture-project',agent:'codex',state:'running',createdAt:'2026-09-13T00:00:00Z',exitCode:null,cols:100,rows:28};
const projects = [{targetId:session.targetId,label:'화면 검증 프로젝트'}];
// Multiple response pages with cursor motion and synchronized TUI frames.
const stream = '\x1b[?2026h\x1b[H\x1b[2J진행 중: 화면 제어 신호 검증\r\n\x1b[?2026l'.repeat(150)
 + '\x1b[?2026h\x1b[H\x1b[2JVISIBLE_TERMINAL_742\r\n실제 출력 확인\r\n\x1b[?2026l';
const marker = 'VISIBLE_TERMINAL_742';
const chunks = Array.from({length:Math.ceil(stream.length/1024)},(_,i)=>({seq:i+1,text:stream.slice(i*1024,(i+1)*1024)}));
const output = new URL('../output/playwright/', import.meta.url); await mkdir(output,{recursive:true});
const results = [];
for (const [name, engine] of Object.entries({chromium,webkit})) {
 const browser = await engine.launch({headless:true});
 try {
  for (const remote of [false,true]) {
   const context = await browser.newContext({viewport:{width:remote?390:1000,height:1050},serviceWorkers:'block'});
   try {
    const page = await context.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    const scenarioChunks=[...chunks];
    await context.route('**/*',async route=>{
     const request=route.request(),url=new URL(request.url());
     if(url.origin!==origin)return route.abort('blockedbyclient');
     if(url.pathname==='/__render-fixture')return route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};import {Terminal} from ${JSON.stringify(xterm)};
import '/src/index.css';import '/src/workspaceDesign.css';import {applyZoomToDocument} from '/src/uiZoom.ts';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
document.documentElement.dataset.appTheme='gray';applyZoomToDocument(document,${remote?1:1.25});
const open=Terminal.prototype.open;Terminal.prototype.open=function(...args){window.__terminal=this;return open.apply(this,args)};
const {AiTerminalPanel}=await import('/src/AiTerminalPanel.tsx');
function Harness(){const [visible,setVisible]=React.useState(true);window.__visible=setVisible;
const panel=React.createElement(AiTerminalPanel,{visible,remote:${remote},projects:${JSON.stringify(projects)},entry:{nonce:1,targetId:${JSON.stringify(session.targetId)},sessionId:${JSON.stringify(session.id)}},${remote?"transport:request=>fetch('/api/agent-runtime/terminals',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)}).then(r=>r.json()),":''}sessionScope:'render-fixture'});
return ${remote?"React.createElement('main',{className:'remote-panel'},panel)":"React.createElement('div',{className:'h-screen flex flex-col overflow-hidden'},React.createElement('div',{className:'workspace-shell flex-1 min-h-0','data-mobile':'false'},React.createElement('aside',{'data-testid':'top-toolbar',className:'shrink-0'},'AgentsToZ fixture'),React.createElement('div',{className:'workspace-content'},React.createElement('div',{id:'top-level-terminal-panel',role:'tabpanel',className:'flex-1 min-h-0 overflow-auto flex flex-col'},panel))))"};}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));</script>`});
     if(!url.pathname.startsWith('/api/'))return route.continue();
     if(url.pathname.endsWith('/targets'))return route.fulfill({json:{targets:projects,complete:true,protocolVersion:'agentstoz-tasks-v2'}});
     if(url.pathname.endsWith('/access'))return route.fulfill({json:{connections:[]}});
     if(url.pathname.endsWith('/memory'))return route.fulfill({json:{jobs:[]}});
     assert.equal(url.pathname,'/api/agent-runtime/terminals');
     const body=request.postDataJSON();
     if(body.operation==='list')return route.fulfill({json:{sessions:[session]}});
     if(body.operation==='read'){const page=scenarioChunks.filter(c=>c.seq>body.after).slice(0,4);const next=page.at(-1)?.seq??body.after;return route.fulfill({json:{session,chunks:page,nextCursor:next,hasMore:next<scenarioChunks.length,truncated:false}});}
     assert.equal(body.operation,'resize');return route.fulfill({json:{session}});
    });
    await page.goto(`${origin}/__render-fixture`);
    const waitForOutput=()=>page.waitForFunction(marker=>document.querySelector('.xterm-rows')?.textContent?.includes(marker),marker,{timeout:8000});
    await waitForOutput();
    const measure=()=>page.evaluate(()=>{
     const host=document.querySelector('.ai-terminal-screen'),rows=document.querySelector('.xterm-rows'),first=rows.firstElementChild;
     const h=host.getBoundingClientRect(),r=first.getBoundingClientRect();
     return {hostHeight:h.height,rowHeight:r.height,rowTop:r.top,hostTop:h.top,hostBottom:h.bottom,cols:window.__terminal.cols,rows:window.__terminal.rows,text:first.textContent};
    });
    const before=await measure();
    await page.locator('.ai-terminal-surface').scrollIntoViewIfNeeded();
    await page.screenshot({path:new URL(`workroom-render-${name}-${remote?'mobile':'desktop'}.png`,output).pathname});
    console.log(JSON.stringify({name,remote,...before,errors}));
    assert.ok(before.hostHeight>=100,`${name}: terminal host must have usable height`);
    assert.ok(before.rowHeight>0 && before.rowTop>=before.hostTop-1 && before.rowTop+before.rowHeight<=before.hostBottom+1,`${name}: output must be inside its visible host`);
    assert.ok(before.cols>=20 && before.rows>=5,`${name}: terminal has usable dimensions`);
    await page.evaluate(()=>window.__visible(false)); await page.waitForTimeout(50); await page.evaluate(()=>window.__visible(true));
    await waitForOutput();
    assert.ok((await measure()).hostHeight>=100); assert.deepEqual(errors,[]);
    // Occlusion keeps the same terminal alive while output and scrollback
    // advance. Remount-only checks do not exercise its paused renderer.
    await page.evaluate(()=>{window.__retainedTerminal=window.__terminal;document.querySelector('.ai-terminal-screen').style.display='none';});
    await page.waitForFunction(()=>window.__terminal._core._renderService._isPaused);
    const restored='RESTORED_TERMINAL_455';
    const hiddenOutput='background line\r\n'.repeat(150)+'\x1b[H\x1b[2J'+restored+'\r\n숨김 후 복원\r\n';
    const base=scenarioChunks.length;
    for(let i=0;i<hiddenOutput.length;i+=1024)scenarioChunks.push({seq:base+Math.floor(i/1024)+1,text:hiddenOutput.slice(i,i+1024)});
    await page.waitForFunction(marker=>{const t=window.__terminal;return Array.from({length:t.buffer.active.length},(_,i)=>t.buffer.active.getLine(i)?.translateToString(true)).some(line=>line?.includes(marker));},restored,{timeout:12000});
    await page.evaluate(()=>document.querySelector('.ai-terminal-screen').style.removeProperty('display'));
    await page.waitForFunction(marker=>document.querySelector('.xterm-rows')?.textContent?.includes(marker),restored,{timeout:8000});
    assert.equal(await page.evaluate(()=>window.__terminal===window.__retainedTerminal),true,'hidden output must restore without replacing the terminal');
    assert.ok((await measure()).hostHeight>=100);
    await page.setViewportSize({width:remote?360:800,height:780});
    await page.locator('.ai-terminal-surface').scrollIntoViewIfNeeded();
    await page.waitForFunction(marker=>document.querySelector('.xterm-rows')?.textContent?.includes(marker),restored,{timeout:8000});
    assert.ok((await measure()).hostHeight>=100);
    results.push({engine:name,remote,passed:true});
   } finally {await context.close();}
  }
 } finally {await browser.close();}
}
await writeFile(new URL('workroom-rendering-results.json',output),JSON.stringify(results,null,2));
console.log(`${results.length}/4 rendering checks passed`);
