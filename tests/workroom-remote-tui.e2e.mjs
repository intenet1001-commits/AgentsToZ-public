/** Real production remote Workroom/readable CSS, synthetic CEF-free terminal bytes, no provider or personal session. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {chromium,webkit} from 'playwright';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import {workroomBackgroundResponse} from './fixtures/workroom-runtime-background-mocks.mjs';

export async function runRemoteTuiScreen(origin){
 assert.equal(new URL(origin).hostname,'127.0.0.1');
 const source=await fetch(`${origin}/src/AiTerminalPanel.tsx`).then(r=>{assert.equal(r.status,200);return r.text();}),main=await fetch(`${origin}/src/main.tsx`).then(r=>r.text());
 const dependency=name=>source.match(new RegExp(`"([^"\\n]*/node_modules/\\.vite/deps/${name}[^"\\n]*)"`))?.[1];
 const react=dependency('react\\.js'),xterm=dependency('@xterm_xterm\\.js'),reactDom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];assert(react&&xterm&&reactDom);
 const session={id:'synthetic-hermes-ipad-session',targetId:'synthetic-hermes-ipad-project',agent:'hermes',state:'running',createdAt:'2026-10-25T00:00:00Z',exitCode:null,cols:100,rows:28};
 const top='╭'+'─'.repeat(98)+'╮',bottom='╰'+'─'.repeat(98)+'╯';
 const drawing=`\x1b[H\x1b[2J${top}\x1b[2;1H│ Session: synthetic-bcda00b8\x1b[2;62H21 tools · 238 skills · 4 MCP\x1b[2;100H│\x1b[3;1H│ /help for commands\x1b[3;100H│\x1b[4;1H${bottom}\x1b[8;1Hready | opus 5 high\x1b[10;1H› Try "write a test for..."\x1b[12;1H${'─'.repeat(100)}\x1b[14;1H[OMH] v2.0.4 | ready | yolo mode: on\x1b[10;28H`;
 // Use the same real xterm serializer as AiTerminalScreen. The service's private grid/wire projection is covered by
 // workroom-readable-screen.test.ts; this Node-compatible runner drives its bytes through the actual DOM component.
 const host=new headless.Terminal({cols:session.cols,rows:session.rows,scrollback:0,allowProposedApi:true}),serializer=new serialize.SerializeAddon();let snapshot,expectedRows;
 try{host.loadAddon(serializer);await new Promise(resolve=>host.write(drawing,resolve));const text=serializer.serialize({scrollback:0});assert(text.length<=1024);snapshot={chunks:[{seq:100,text}],nextCursor:100};expectedRows=Array.from({length:host.rows},(_,row)=>host.buffer.active.getLine(host.buffer.active.baseY+row)?.translateToString(true)??'');}finally{host.dispose();}
 const plain='\x1b[?1049l\x1b[H\x1b[2JPLAIN_FLOW\r\n'+'가나다라마바사'.repeat(70)+'\r\nplain output remains complete';
 const alternate='\x1b[?1049h\x1b[H\x1b[2JALTERNATE_MENU\x1b[3;1H1. Inspect\x1b[3;90H2. Continue';
 const output=resolve(fileURLToPath(new URL('../output/playwright/',import.meta.url)));await mkdir(output,{recursive:true});
 const results=[];
 for(const [name,engine]of Object.entries({chromium,webkit})){
  const browser=await engine.launch({headless:true});
  try{for(const viewport of [{width:744,height:1133},{width:1133,height:744},{width:390,height:844}]){
   const context=await browser.newContext({viewport,serviceWorkers:'block'}),page=await context.newPage(),errors=[],requests=[];let next=null;
   try{
    page.on('pageerror',error=>errors.push(error.message));
    await context.route('**/*',async route=>{
     const request=route.request(),url=new URL(request.url());if(url.origin!==origin)return route.abort('blockedbyclient');
     if(url.pathname==='/__remote-tui-fixture')return route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};import {Terminal} from ${JSON.stringify(xterm)};
import '/src/index.css';import '/src/workspaceDesign.css';import '/src/remote-control-portal.css';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;document.documentElement.dataset.appTheme='gray';
const open=Terminal.prototype.open;Terminal.prototype.open=function(...args){if(this.options.scrollback===0)window.__reading=this;return open.apply(this,args)};
const {AiTerminalPanel}=await import('/src/AiTerminalPanel.tsx');
const transport=async body=>{const response=await fetch('/api/agent-runtime/terminals',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error);return result;};
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement('main',{className:'remote-panel remote-workroom-content'},React.createElement(AiTerminalPanel,{remote:true,sessionFullscreen:true,visible:true,deviceName:'합성 Mac',projects:[{targetId:${JSON.stringify(session.targetId)},label:'AgentsToZ_byCS'}],entry:{nonce:1,targetId:${JSON.stringify(session.targetId)},sessionId:${JSON.stringify(session.id)}},transport,workspaceTransport:transport,sessionScope:'synthetic-ipad-tui'})));
</script>`});
     if(!url.pathname.startsWith('/api/'))return route.continue();
     const body=request.method()==='POST'?request.postDataJSON():null,background=workroomBackgroundResponse(url.pathname,request.method(),body);if(background)return route.fulfill({json:background});
     if(url.pathname==='/api/agent-runtime/targets')return route.fulfill({json:{targets:[{targetId:session.targetId,label:'AgentsToZ_byCS'}],complete:true,protocolVersion:'agentstoz-tasks-v2'}});
     if(url.pathname==='/api/agent-runtime/voice-settings')return route.fulfill({json:{supported:false,configured:false,model:'fixture',checkedAt:null,checkedModel:null}});
     assert.equal(url.pathname,'/api/agent-runtime/terminals');requests.push(body);
     if(body.operation==='list')return route.fulfill({json:{sessions:[session]}});
     if(body.operation==='workspace')return route.fulfill(body.workspace?.action==='workroom.effort'?{status:400,json:{error:'모바일 작업 요청 형식이 올바르지 않습니다.'}}:{json:{kind:'workspace',action:'workroom.status',workroom:{sessionId:session.id,initialized:true,lastSavedAt:null,context:{usedPercent:null,observedAt:null,source:'unavailable'},save:{requestId:null,state:'idle',localSaved:false,backupSaved:false,message:''}}}});
     if(body.operation==='read'){
      if(body.after===0)return route.fulfill({json:{session,chunks:snapshot.chunks,nextCursor:snapshot.nextCursor,hasMore:false,truncated:true}});
      if(next&&body.after<next.seq){const chunk=next;return route.fulfill({json:{session,chunks:[chunk],nextCursor:chunk.seq,hasMore:false,truncated:false}});}
      return route.fulfill({json:{session,chunks:[],nextCursor:body.after,hasMore:false,truncated:false}});
     }
     throw Error(`Unmocked remote terminal operation: ${body.operation}`);
    });
    await page.goto(`${origin}/__remote-tui-fixture`);
    const readable=page.getByTestId('workroom-readable-screen');await readable.waitFor();await readable.filter({hasText:'opus 5 high'}).waitFor();
    assert.equal(await page.getByTestId('workroom-readable-toggle').textContent(),'원본 터미널','the photographed surface is the default readable view');
    assert.equal(await readable.getAttribute('data-layout'),'grid');
    const grid=await readable.evaluate(node=>{const s=getComputedStyle(node),r=node.getBoundingClientRect(),range=document.createRange();range.setStart(node.firstChild,0);range.setEnd(node.firstChild,100);const top=range.getBoundingClientRect();return {text:node.textContent,whiteSpace:s.whiteSpace,overflowX:s.overflowX,clientWidth:node.clientWidth,scrollWidth:node.scrollWidth,x:r.x,right:r.right,viewport:innerWidth,fontSize:parseFloat(s.fontSize),pageWidth:document.documentElement.scrollWidth,firstRowTop:top.top,regionTop:r.top,regionBottom:r.bottom};});
    assert.equal(grid.text,expectedRows.join('\n'),'every host row and column, including blank rows, reaches the readable surface unchanged');assert(grid.text.includes('21 tools · 238 skills · 4 MCP'));assert(grid.text.includes(bottom));assert(grid.text.includes('[OMH] v2.0.4'));
    assert.equal(grid.whiteSpace,'pre');assert.equal(grid.overflowX,'auto');if(viewport.width<=744)assert(grid.scrollWidth>grid.clientWidth,`100-column TUI can be panned inside the narrow region: ${JSON.stringify({viewport,grid})}`);assert(grid.x>=0&&grid.right<=grid.viewport+1);assert(grid.pageWidth<=grid.viewport+1,'the entire page must not overflow');
    assert(grid.firstRowTop>=grid.regionTop&&grid.firstRowTop<grid.regionBottom,'trailing blank host rows must not scroll the entire TUI header out of view');
    assert(grid.fontSize>=(viewport.width<=640?12:16));assert.equal(await readable.evaluate(node=>node.scrollLeft),0,'the first view starts at the left edge');
    await page.screenshot({path:resolve(output,`remote-hermes-tui-${name}-${viewport.width}x${viewport.height}.png`),animations:'disabled'});
    if(viewport.width===744){
     await page.setViewportSize({width:1133,height:744});assert.equal(await readable.textContent(),expectedRows.join('\n'),'rotation preserves the exact parsed host grid');
     assert(await readable.evaluate(node=>node.getBoundingClientRect().right<=innerWidth+1));
     await page.setViewportSize(viewport);assert.equal(await readable.getAttribute('data-layout'),'grid');
    }
    if(grid.scrollWidth>grid.clientWidth){await readable.hover();await page.mouse.wheel(300,0);await page.waitForFunction(()=>document.querySelector('[data-testid=workroom-readable-screen]').scrollLeft>0,null,{timeout:5000});await readable.evaluate(node=>{node.scrollLeft=node.scrollWidth;});assert(await readable.evaluate(node=>node.scrollLeft>0));await page.screenshot({path:resolve(output,`remote-hermes-tui-${name}-${viewport.width}x${viewport.height}-pan-right.png`),animations:'disabled'});}
    next={seq:101,text:plain};await readable.filter({hasText:'PLAIN_FLOW'}).waitFor({timeout:12000});assert.equal(await readable.getAttribute('data-layout'),'flow');
    const flow=await readable.evaluate(node=>{const text=node.textContent,start=text.indexOf('plain output remains complete'),range=document.createRange(),region=node.getBoundingClientRect();range.setStart(node.firstChild,start);range.setEnd(node.firstChild,start+28);const tail=range.getBoundingClientRect();return {width:node.clientWidth,scroll:node.scrollWidth,whiteSpace:getComputedStyle(node).whiteSpace,text,tailBottom:tail.bottom,tailTop:tail.top,top:region.top,bottom:region.bottom};});assert.equal(flow.whiteSpace,'pre-wrap');assert(flow.scroll<=flow.width+1);assert(flow.text.includes('plain output remains complete'));assert(flow.text.includes('가나다라마바사'));assert(flow.tailTop>=flow.top&&flow.tailBottom<=flow.bottom,'last real text remains in view despite retained blank terminal rows');
    next={seq:102,text:alternate};await readable.filter({hasText:'ALTERNATE_MENU'}).waitFor({timeout:12000});assert.equal(await readable.getAttribute('data-layout'),'grid','alternate-screen menus preserve columns even without box glyphs');
    assert.equal(requests.filter(request=>request.operation==='resize'||request.operation==='input').length,0,'viewing, fitting and panning must not resize or write to the shared PTY');assert.deepEqual(errors,[]);
    results.push({engine:name,...viewport,passed:true,grid:{rows:grid.text.split('\n').length,clientWidth:grid.clientWidth,scrollWidth:grid.scrollWidth,fontSize:grid.fontSize,firstRowTop:grid.firstRowTop,regionTop:grid.regionTop,regionBottom:grid.regionBottom},flow:{tailTop:flow.tailTop,tailBottom:flow.tailBottom,regionTop:flow.top,regionBottom:flow.bottom},pageWidth:grid.pageWidth});
   }finally{await context.close();}
  }}finally{await browser.close();}
 }
 await writeFile(resolve(output,'workroom-remote-tui-results.json'),JSON.stringify({remoteTui:true,results},null,2));
 console.log(JSON.stringify({remoteTui:true,results}));return results;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 let server;try{
  let origin=process.env.WORKROOM_TEST_ORIGIN;
  if(!origin){const {createServer}=await import('vite');server=await createServer({mode:'maintainer-test',server:{host:'127.0.0.1',port:0,proxy:{}},clearScreen:false});await server.listen();origin=server.resolvedUrls.local[0].replace(/\/$/,'');}
  await runRemoteTuiScreen(origin);
 }finally{await server?.close();}
}
