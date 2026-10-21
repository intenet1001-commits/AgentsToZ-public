/** Workroom attachments (S3, 2026-10-16) on the app paths, in Chromium with a stand-in for the Tauri bridge.
 * Start an isolated Vite first, then: node tests/workroom-attachments-tauri.e2e.mjs http://127.0.0.1:<port>
 *
 * `window.__TAURI_INTERNALS__` is replaced by a recorder: `agent_runtime_request` goes to the same mocked routes,
 * the window/event plugins answer like a Retina Mac at a chosen app zoom, and the two new commands
 * (`workroom_pick_attachments`, `workroom_take_drop`) answer from the test. Nothing native runs — this proves the
 * page side (router, arbiter, zoom conversion with a real elementFromPoint, FolderDropZone deferral, pop-out take),
 * not a real Finder drop.
 */
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const origin=process.argv[2]||process.env.WORKROOM_ORIGIN||'http://127.0.0.1:9000';
assert.equal(new URL(origin).hostname,'127.0.0.1');
const source=await fetch(`${origin}/src/AiTerminalPanel.tsx`).then(r=>{assert.equal(r.status,200,'Start isolated Vite first');return r.text();});
const main=await fetch(`${origin}/src/main.tsx`).then(r=>r.text());
const react=source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1];
const reactDom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
assert.ok(react&&reactDom,'Use the actual Vite dependency versions');
const A='fixture-project-alpha',SA='fixture-session-alpha';
const projects=[{targetId:A,projectTargetId:A,label:'첨부테스트',scope:'main',branch:'main',locked:false,worktreeCapable:false}];
const session=(id)=>({id,targetId:A,agent:'codex',state:'running',createdAt:'2026-10-16T00:46:40Z',exitCode:null,cols:100,rows:28});
const APP='/Users/fixture/Library/Application Support/com.portmanager.portmanager';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,message,timeout=6000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await sleep(15);}assert.fail(message);}

/** Installed before any page script: a Tauri bridge that records and answers. */
const bridge=({label,zoom,scale})=>{
  const callbacks=new Map();let next=1;const listeners=[];
  window.__bridge={commands:[],unmocked:[],listeners,callbacks,picks:[],drops:[]};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
  window.__TAURI_INTERNALS__={
    metadata:{currentWindow:{label},currentWebview:{windowLabel:label,label}},
    transformCallback(callback){const id=next++;callbacks.set(id,callback);return id;},
    unregisterCallback(id){callbacks.delete(id);},
    convertFileSrc(path){return path;},
    async invoke(cmd,args){
      window.__bridge.commands.push(cmd);
      if(cmd==='agent_runtime_request'){
        const response=await fetch(args.path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args.body)});
        return {status:response.status,body:await response.json()};
      }
      if(cmd==='plugin:event|listen'){listeners.push({event:args.event,handler:args.handler});return listeners.length;}
      if(cmd==='plugin:event|unlisten')return null;
      if(cmd==='plugin:window|inner_size')return {width:Math.round(window.innerWidth*zoom*scale),height:Math.round(window.innerHeight*zoom*scale)};
      if(cmd==='plugin:window|scale_factor')return scale;
      if(cmd==='workroom_pick_attachments'){window.__bridge.picks.push(args.kind);return window.__bridge.pickAnswer??[];}
      if(cmd==='workroom_take_drop'){const answer=window.__bridge.drops.shift()??{paths:[],total:0};return answer;}
      window.__bridge.unmocked.push(cmd);throw new Error(`unmocked command ${cmd}`);
    },
  };
};
const html=options=>`<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};
import '/src/index.css';import '/src/workspaceDesign.css';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
document.documentElement.dataset.appTheme='gray';
const {AiTerminalPanel}=await import('/src/AiTerminalPanel.tsx');
const {FolderDropZone}=await import('/src/FolderDropZone.tsx');
window.__folderDrops=[];
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement('main',{style:{padding:'16px'}},
  React.createElement(AiTerminalPanel,{projects:${JSON.stringify(projects)},visible:true,popout:${options.label!=='main'},sessionScope:${JSON.stringify(options.label==='main'?'local':'popout')},entry:{nonce:1,targetId:${JSON.stringify(A)},sessionId:${JSON.stringify(SA)}},workspaceTransport:request=>fetch('/api/agent-runtime/terminals',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)}).then(r=>r.json())}),
  ${options.label==='main'?`React.createElement('div',{style:{marginTop:'16px'}},React.createElement(FolderDropZone,{testId:'fixture-folder-drop',onFolderPath:path=>{window.__folderDrops.push(path);}}))`:'null'}));
window.__voc=await import('/src/voc/vocDropCapture.ts');
</script>`;
const browser=await chromium.launch({headless:true}),results=[];
async function fixture(options){
  // deviceScaleFactor 2 is a Retina display: devicePixelRatio is 2 while macOS drag positions stay in view points.
  const context=await browser.newContext({viewport:{width:1100,height:1300},serviceWorkers:'block',deviceScaleFactor:options.dpr??1});
  await context.addInitScript(bridge,{label:options.label,zoom:options.zoom??1,scale:options.scale??2});
  const state={sessions:[session(SA)],requests:[],errors:[],blocked:[]};
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    // In app mode the usage panel asks the sidecar directly; it is aborted here and never reaches a real 3001.
    if(url.origin!==origin){if(url.pathname!=='/api/ai-usage/codex')state.blocked.push(url.origin+url.pathname);return route.abort('blockedbyclient');}
    if(url.pathname==='/__workroom-attachments-tauri')return route.fulfill({contentType:'text/html',body:html(options)});
    if(!url.pathname.startsWith('/api/'))return route.continue();
    const body=request.postDataJSON?.()??null;state.requests.push({path:url.pathname,...(body??{})});
    const respond=(json,status=200)=>route.fulfill({json,status}).catch(()=>{});
    if(url.pathname==='/api/agent-runtime/targets')return respond({protocolVersion:'agentstoz-tasks-v2',targets:projects,complete:true});
    if(url.pathname==='/api/ai-usage/codex')return respond({rateLimits:null});
    if(url.pathname==='/api/agent-runtime/terminals/access')return respond({connections:[]});
    if(url.pathname==='/api/agent-runtime/terminals/memory')return respond({jobs:[]});
    if(url.pathname==='/api/agent-runtime/terminals/images'){
      if(body.operation==='import')return respond({attachments:body.paths.map(path=>path.endsWith('.png')
        ?{path:`${APP}/workroom-images/2026-10-16/101010-aaaaaaaa.png`,name:path.split('/').pop(),bytes:10}
        :{kind:'file',path,name:path.split('/').pop(),bytes:10}),refused:[]});
      if(body.operation==='type-paths')return options.awaiting===false?respond({typed:body.paths.length}):options.awaiting?respond({error:'AI가 답을 기다리는 화면이라 경로를 입력하지 않았습니다 — 먼저 질문에 답한 뒤 다시 끌어 놓거나, 입력칸에 놓아 첨부하세요.',code:'WORKROOM_TERMINAL_AWAITS_ANSWER'},400):respond({typed:body.paths.length});
    }
    if(url.pathname==='/api/agent-runtime/terminals'){
      if(body.operation==='workspace')return respond({kind:'workspace',action:'workroom.status',workroom:{sessionId:body.workspace.sessionId,initialized:true,lastSavedAt:null,context:{usedPercent:null,observedAt:null,source:'unavailable'},save:{requestId:null,state:'idle',localSaved:false,backupSaved:false,message:''}}});
      if(body.operation==='list')return respond({sessions:state.sessions});
      if(body.operation==='accounts')return respond({accounts:{agent:body.agent,selectedAccountId:'host-default',items:[{id:'host-default',agent:body.agent,label:'현재 CLI 계정',authState:'unknown',checkedAt:null,loginState:'idle'}]}});
      const selected=state.sessions.find(current=>current.id===body.sessionId);
      if(!selected){state.blocked.push('terminal '+JSON.stringify(body).slice(0,160));return respond({error:'unknown'},400);}
      if(body.operation==='read')return respond({session:selected,chunks:body.after<1?[{seq:1,text:'> 준비됨\r\n'}]:[],nextCursor:Math.max(1,body.after),truncated:false,hasMore:false});
      if(['input','resize'].includes(body.operation))return respond({session:selected});
    }
    state.blocked.push(`${request.method()} ${url.pathname}`);return respond({error:'Unmocked API is forbidden'},503);
  });
  const page=await context.newPage();page.on('pageerror',error=>state.errors.push(error.message));
  page.on('dialog',dialog=>void dialog.accept());
  await page.goto(`${origin}/__workroom-attachments-tauri`);const panel=page.getByTestId('ai-terminal-panel');await panel.waitFor({timeout:10000});
  await until(()=>state.requests.some(r=>r.operation==='read'),'The fixture session must be read');
  await panel.getByTestId('workroom-attach-file').waitFor();
  return{context,page,panel,state};
}
async function run(name,body,options){
  const f=await fixture(options);
  try{await body(f);assert.deepEqual(f.state.errors,[],'No page errors');assert.deepEqual(f.state.blocked,[],'No unmocked request');results.push({name,status:'passed'});console.log('✓',name);}
  catch(error){results.push({name,status:'failed',error:String(error?.stack??error)});console.error('✗',name,error);}
  finally{await f.context.close();}
}
const imports=state=>state.requests.filter(r=>r.operation==='import');
/** The CSS centre of an element, as a macOS drop position (points = CSS × zoom). */
const pointsOf=async(locator,zoom)=>{const box=await locator.boundingBox();return {x:(box.x+box.width/2)*zoom,y:(box.y+box.height/2)*zoom};};
/** Delivers a main-window drag the way @tauri-apps/api hands it to onDragDropEvent listeners. */
async function tauriDrag(page,type,position,paths=[]){
  await page.evaluate(({type,position,paths})=>{
    const event={enter:'tauri://drag-enter',over:'tauri://drag-over',drop:'tauri://drag-drop',leave:'tauri://drag-leave'}[type];
    for(const listener of window.__bridge.listeners.filter(item=>item.event===event)){
      const callback=window.__bridge.callbacks.get(listener.handler);
      callback?.({event,id:listener.handler,payload:type==='leave'?null:{paths:type==='over'?undefined:paths,position}});
    }
  },{type,position,paths});
}

try{
  for(const zoom of [0.9,1,1.25]){
    await run(`main window at app zoom ${zoom}: a Finder drop on the composer attaches there only (overlay first)`,async({page,panel,state})=>{
      await until(()=>page.evaluate(()=>window.__bridge.listeners.filter(item=>item.event==='tauri://drag-drop').length>=2),'The Workroom and FolderDropZone both listen');
      const at=await pointsOf(panel.getByLabel('워크룸 입력'),zoom);
      await tauriDrag(page,'enter',at,['/Users/fixture/보고서.pdf','/Users/fixture/shot.png']);await sleep(80);
      await tauriDrag(page,'over',at);
      await panel.getByTestId('workroom-drop-overlay').waitFor();
      await tauriDrag(page,'drop',at,['/Users/fixture/보고서.pdf','/Users/fixture/shot.png']);
      await panel.getByTestId('workroom-file-chip').getByText('보고서.pdf').waitFor();
      await panel.getByTestId('workroom-image-chip').getByText('shot.png').waitFor();
      assert.deepEqual(imports(state).map(r=>r.paths),[['/Users/fixture/보고서.pdf','/Users/fixture/shot.png']]);
      assert.deepEqual(await page.evaluate(()=>window.__folderDrops),[],'No project was added for the same drop');
      assert.equal(await panel.getByTestId('workroom-drop-overlay').count(),0);
    },{label:'main',zoom});
  }
  // Review 2026-10-16: FolderDropZone divided macOS view points by devicePixelRatio, so on a Retina display (DPR 2)
  // a drop on it landed at half its place and added no project. It now uses the arbiter's conversion.
  for(const [dpr,zoom] of [[2,1],[2,1.25]])await run(`main window on a Retina display (DPR ${dpr}) at app zoom ${zoom}: a drop on FolderDropZone outside the Workroom adds the project`,async({page})=>{
    await until(()=>page.evaluate(()=>window.__bridge.listeners.filter(item=>item.event==='tauri://drag-drop').length>=2),'listeners');
    const zone=page.getByTestId('fixture-folder-drop');await zone.scrollIntoViewIfNeeded();
    await sleep(100);// the window geometry (scale, zoom) is measured asynchronously
    const at=await pointsOf(zone,zoom);
    await tauriDrag(page,'enter',at,['/Users/fixture/project']);await tauriDrag(page,'drop',at,['/Users/fixture/project']);
    await until(()=>page.evaluate(()=>window.__folderDrops.length===1),'FolderDropZone takes a drop on itself on Retina');
  },{label:'main',zoom,dpr});
  await run('main window: outside the Workroom FolderDropZone takes it; a modal over the Workroom or VOC on keeps the Workroom out',async({page,panel,state})=>{
    await until(()=>page.evaluate(()=>window.__bridge.listeners.filter(item=>item.event==='tauri://drag-drop').length>=2),'listeners');
    const zone=page.getByTestId('fixture-folder-drop');await zone.scrollIntoViewIfNeeded();
    await tauriDrag(page,'drop',await pointsOf(zone,1),['/Users/fixture/project']);
    await until(()=>page.evaluate(()=>window.__folderDrops.length===1),'FolderDropZone takes a drop outside the Workroom');
    assert.equal(imports(state).length,0);
    const composer=panel.getByLabel('워크룸 입력');await composer.scrollIntoViewIfNeeded();
    await page.evaluate(()=>{const modal=document.createElement('div');modal.id='fixture-modal';Object.assign(modal.style,{position:'fixed',inset:'0',zIndex:'9500',background:'rgb(0 0 0 / .2)'});document.body.append(modal);});
    await tauriDrag(page,'drop',await pointsOf(composer,1),['/Users/fixture/a.pdf']);await sleep(150);
    assert.equal(imports(state).length,0,'A modal above the Workroom keeps the drop out of it');
    await page.evaluate(()=>document.getElementById('fixture-modal').remove());
    const release=await page.evaluateHandle(()=>window.__voc.beginVocDropCapture());
    await tauriDrag(page,'drop',await pointsOf(composer,1),['/Users/fixture/a.pdf']);await sleep(150);
    assert.equal(imports(state).length,0,'VOC capture owns drops');
    await release.evaluate(stop=>stop());
    assert.equal(await page.evaluate(()=>window.__folderDrops.length),1);
  },{label:'main',zoom:1});
  await run('main window: a FolderDropZone whose box lies under the Workroom still does not add a project for a Workroom drop',async({page,panel,state})=>{
    await until(()=>page.evaluate(()=>window.__bridge.listeners.filter(item=>item.event==='tauri://drag-drop').length>=2),'listeners');
    const composer=panel.getByLabel('워크룸 입력');await composer.scrollIntoViewIfNeeded();
    const box=await composer.boundingBox();
    // Put the folder zone's box exactly under the composer (behind it), so its own inside test would say yes.
    await page.getByTestId('fixture-folder-drop').evaluate((element,box)=>{Object.assign(element.style,{position:'fixed',left:box.x+'px',top:box.y+'px',width:box.width+'px',height:box.height+'px',zIndex:'-1'});},box);
    await tauriDrag(page,'drop',await pointsOf(composer,1),['/Users/fixture/a.pdf']);
    await panel.getByTestId('workroom-file-chip').getByText('a.pdf').waitFor();
    await sleep(100);
    assert.deepEqual(await page.evaluate(()=>window.__folderDrops),[],'Exactly one owner: the Workroom');
  },{label:'main',zoom:1});
  // Review 2026-10-16: Tauri takes every drag over the webview, including text, a thumbnail or a link dragged inside
  // the page. Those carry no path and must neither show the attach overlay nor end in a 「save it as a file」 error.
  await run('main window: dragging text inside the page shows no overlay and says nothing',async({page,panel,state})=>{
    await until(()=>page.evaluate(()=>window.__bridge.listeners.some(item=>item.event==='tauri://drag-drop')),'listener');
    const composer=panel.getByLabel('워크룸 입력');await composer.fill('옮길 글');
    const at=await pointsOf(composer,1);
    await composer.evaluate(element=>element.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:new DataTransfer()})));
    await tauriDrag(page,'enter',at,[]);await tauriDrag(page,'over',at);await sleep(150);
    assert.equal(await panel.getByTestId('workroom-drop-overlay').count(),0,'No attach overlay for a text drag');
    await tauriDrag(page,'drop',at,[]);await sleep(150);
    assert.equal(await panel.getByRole('alert').count(),0,'No error for moving text');
    assert.equal(imports(state).length,0);
  },{label:'main',zoom:1});
  await run('main window: a pathless drag from another app shows no overlay and, dropped, says it had no path without assuming a file',async({page,panel,state})=>{
    await until(()=>page.evaluate(()=>window.__bridge.listeners.some(item=>item.event==='tauri://drag-drop')),'listener');
    const at=await pointsOf(panel.getByLabel('워크룸 입력'),1);
    await tauriDrag(page,'enter',at,[]);await tauriDrag(page,'over',at);await sleep(150);
    assert.equal(await panel.getByTestId('workroom-drop-overlay').count(),0,'No attach overlay without a path');
    await tauriDrag(page,'drop',at,[]);
    await panel.getByRole('alert').getByText('끌어 놓은 항목에 파일 경로가 없어 첨부하지 않았습니다',{exact:false}).waitFor();
    assert.equal(imports(state).length,0);
  },{label:'main',zoom:1});
  // Review 2026-10-16: the 세션 종료 dialog is a DOM child of the Workroom panel; a drop on its backdrop hit-tested
  // as the panel and attached to the hidden composer instead of reaching the FolderDropZone the person saw.
  await run('main window: while the Workroom\'s own modal dialog is open, a drop on its backdrop does not attach to the composer behind it',async({page,panel,state})=>{
    await until(()=>page.evaluate(()=>window.__bridge.listeners.filter(item=>item.event==='tauri://drag-drop').length>=2),'listeners');
    const zone=page.getByTestId('fixture-folder-drop');await zone.scrollIntoViewIfNeeded();
    const folderAt=await pointsOf(zone,1),composerAt=await pointsOf(panel.getByLabel('워크룸 입력'),1);
    await panel.getByRole('button',{name:'세션 종료'}).click();
    await page.locator('dialog.workroom-exit-dialog[open]').waitFor();
    await tauriDrag(page,'enter',composerAt,['/Users/fixture/a.pdf']);await tauriDrag(page,'over',composerAt);await sleep(150);
    assert.equal(await panel.getByTestId('workroom-drop-overlay').count(),0,'No overlay behind the modal');
    await tauriDrag(page,'drop',composerAt,['/Users/fixture/a.pdf']);
    await tauriDrag(page,'enter',folderAt,['/Users/fixture/project']);await tauriDrag(page,'drop',folderAt,['/Users/fixture/project']);await sleep(200);
    assert.equal(imports(state).length,0,'Nothing attached to the session being closed');
    assert.equal(await panel.getByTestId('workroom-file-chip').count(),0);
  },{label:'main',zoom:1});
  await run('direct terminal input: a drop on the terminal types the paths; a question on screen is refused with its reason',async({page,panel,state})=>{
    await until(()=>page.evaluate(()=>window.__bridge.listeners.some(item=>item.event==='tauri://drag-drop')),'listener');
    await panel.getByRole('button',{name:'터미널 직접 입력'}).click();
    const at=await pointsOf(panel.locator('.ai-terminal-surface'),1);
    await tauriDrag(page,'enter',at,['/Users/fixture/a b.txt']);await tauriDrag(page,'over',at);
    await panel.getByTestId('workroom-drop-overlay').getByText('터미널에 경로를 입력합니다').waitFor();
    await tauriDrag(page,'drop',at,['/Users/fixture/a b.txt']);
    await until(()=>state.requests.some(r=>r.operation==='type-paths'),'type-paths sent');
    const typed=state.requests.find(r=>r.operation==='type-paths');
    assert.deepEqual({sessionId:typed.sessionId,targetId:typed.targetId,paths:typed.paths},{sessionId:SA,targetId:A,paths:['/Users/fixture/a b.txt']});
    assert.equal(imports(state).length,0,'Typed, not attached');
    await panel.getByRole('alert').getByText('답을 기다리는 화면',{exact:false}).waitFor();
  },{label:'main',zoom:1,awaiting:true});
  await run('「파일 첨부」·「사진 첨부」 in the app use the native picker from Rust and reference the picked paths',async({page,panel,state})=>{
    await page.evaluate(()=>{window.__bridge.pickAnswer=['/Users/fixture/설계.pdf'];});
    let chooser=false;page.on('filechooser',()=>{chooser=true;});
    await panel.getByTestId('workroom-attach-file').click();
    await panel.getByTestId('workroom-file-chip').getByText('설계.pdf').waitFor();
    await page.evaluate(()=>{window.__bridge.pickAnswer=[];});
    await panel.getByTestId('workroom-attach-photo').click();await sleep(150);
    assert.deepEqual(await page.evaluate(()=>window.__bridge.picks),['file','image']);
    assert.equal(chooser,false,'No webview file panel in the app');
    assert.deepEqual(imports(state).map(r=>r.paths),[['/Users/fixture/설계.pdf']],'A cancelled pick imports nothing');
    // Review 2026-10-16: Rust keeps at most 16 picked paths; the rest must be said, not dropped silently.
    await page.evaluate(()=>{window.__bridge.pickAnswer={paths:Array.from({length:16},(_,i)=>`/Users/fixture/${i}.png`),total:20};});
    await panel.getByTestId('workroom-attach-photo').click();
    await panel.getByRole('alert').getByText('4개는 경로가 없거나 너무 많아 넣지 않았습니다',{exact:false}).waitFor();
  },{label:'main',zoom:1});
  await run('pop-out: coordinates come by CustomEvent, the paths by one workroom_take_drop',async({page,panel,state})=>{
    const box=await panel.getByLabel('워크룸 입력').boundingBox();
    const width=await page.evaluate(()=>window.innerWidth);
    const at={x:box.x+box.width/2,y:box.y+box.height/2,width};
    await page.evaluate(at=>window.dispatchEvent(new CustomEvent('agentstoz-drag',{detail:{...at,type:'enter',count:3}})),at);
    await page.evaluate(at=>window.dispatchEvent(new CustomEvent('agentstoz-drag',{detail:{...at,type:'over'}})),at);
    await panel.getByTestId('workroom-drop-overlay').waitFor();
    await page.evaluate(()=>{window.__bridge.drops.push({paths:['/Users/fixture/메모.md'],total:3});});
    await page.evaluate(at=>window.dispatchEvent(new CustomEvent('agentstoz-drop',{detail:{...at,count:3}})),at);
    await panel.getByTestId('workroom-file-chip').getByText('메모.md').waitFor();
    assert.equal(await page.evaluate(()=>window.__bridge.commands.filter(c=>c==='workroom_take_drop').length),1);
    await panel.getByRole('alert').getByText('2개는 경로가 없거나 너무 많아',{exact:false}).waitFor();
    assert.deepEqual(imports(state).map(r=>r.paths),[['/Users/fixture/메모.md']]);
    assert.equal(await page.evaluate(()=>window.__bridge.commands.some(c=>c.startsWith('plugin:event'))),false,'A pop-out never asks for Tauri events');
  },{label:'workroom-1',zoom:1});
  await run('pop-out: a text drag inside the page (enter count 0) shows no overlay and says nothing',async({page,panel,state})=>{
    const composer=panel.getByLabel('워크룸 입력');await composer.fill('옮길 글');
    const box=await composer.boundingBox();const at={x:box.x+box.width/2,y:box.y+box.height/2,width:await page.evaluate(()=>window.innerWidth)};
    await composer.evaluate(element=>element.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:new DataTransfer()})));
    await page.evaluate(at=>window.dispatchEvent(new CustomEvent('agentstoz-drag',{detail:{...at,type:'enter',count:0}})),at);
    await page.evaluate(at=>window.dispatchEvent(new CustomEvent('agentstoz-drag',{detail:{...at,type:'over'}})),at);await sleep(150);
    assert.equal(await panel.getByTestId('workroom-drop-overlay').count(),0,'No attach overlay for a text drag');
    await page.evaluate(at=>window.dispatchEvent(new CustomEvent('agentstoz-drop',{detail:{...at,count:0}})),at);await sleep(200);
    assert.equal(await panel.getByRole('alert').count(),0,'No error for moving text');
    assert.equal(imports(state).length,0);
  },{label:'workroom-1',zoom:1});
  // Review 2026-10-16: a typed-path drop that could not carry every item said nothing about the rest.
  await run('pop-out, direct terminal input: items the drop could not carry are named after the typed paths',async({page,panel,state})=>{
    await panel.getByRole('button',{name:'터미널 직접 입력'}).click();
    const box=await panel.locator('.ai-terminal-surface').boundingBox();const at={x:box.x+box.width/2,y:box.y+box.height/2,width:await page.evaluate(()=>window.innerWidth)};
    await page.evaluate(at=>window.dispatchEvent(new CustomEvent('agentstoz-drag',{detail:{...at,type:'enter',count:3}})),at);
    await page.evaluate(()=>{window.__bridge.drops.push({paths:['/Users/fixture/a.txt'],total:3});});
    await page.evaluate(at=>window.dispatchEvent(new CustomEvent('agentstoz-drop',{detail:{...at,count:3}})),at);
    await until(()=>state.requests.some(r=>r.operation==='type-paths'),'type-paths sent');
    await panel.getByRole('alert').getByText('2개는 경로가 없거나 너무 많아 입력하지 않았습니다',{exact:false}).waitFor();
  },{label:'workroom-1',zoom:1,awaiting:false});
}finally{await browser.close();}
console.log(`${results.filter(result=>result.status==='passed').length}/${results.length} app-path attachment groups passed`);
if(results.some(result=>result.status==='failed'))process.exitCode=1;
