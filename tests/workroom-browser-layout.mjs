import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {createServer as createHttpServer} from 'node:http';
import {realpathSync} from 'node:fs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium,webkit} from 'playwright';
/** The production Workroom in its session dialog with the embedded browser opened beside the terminal. Tauri and the
 * workroom APIs are stubs; what is real is the layout, the native-view rectangle the page sends, and the divider.
 * The user's complaint (2026-10-24): a short terminal beside a tall panel, a small page under its controls, and a
 * dialog that scrolls — which also made the native page vanish whenever part of its slot left the window. */
const http=createHttpServer();
// Managed worktrees may link node_modules from the primary checkout. Only the two actual font package roots
// need asset access outside this fixture's repository; never allow the entire primary checkout or filesystem.
const fontPackages=['@fontsource-variable/manrope','@fontsource-variable/jetbrains-mono'];
const fontRoots=fontPackages.map(name=>realpathSync(dirname(fileURLToPath(import.meta.resolve(`${name}/package.json`)))));
const vite=await createServer({server:{middlewareMode:true,hmr:{server:http},fs:{strict:true,allow:[realpathSync(fileURLToPath(new URL('..',import.meta.url))),...fontRoots]}},configFile:new URL('../vite.config.ts',import.meta.url).pathname});
http.on('request',vite.middlewares);await new Promise((resolve,reject)=>{http.once('error',reject);http.listen(0,'127.0.0.1',resolve);});
const origin=`http://127.0.0.1:${http.address().port}`,checks=[];
const source=await fetch(`${origin}/src/AiTerminalPanel.tsx`).then(r=>r.text()),main=await fetch(`${origin}/src/main.tsx`).then(r=>r.text());
const react=source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1],reactDom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];assert(react&&reactDom);
const session={id:'session_layout',targetId:'project_layout',agent:'codex',state:'running',createdAt:'2026-10-24T00:00:00Z',exitCode:null,cols:100,rows:28};
const page_html=(popout=false)=>`<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
// Tauri: runtime requests go to the stubbed routes below; the embedded browser opens at once and records every
// rectangle and hide the page asks for.
window.nativeOps=[];window.isTauri=true;window.layoutPopout=${popout};window.nativeOpened=false;
// What the page last asked the native view to do; status reads in between do not count.
window.lastView=()=>window.nativeOps.filter(o=>o.operation==='frame'||o.operation==='hide').at(-1);
window.__TAURI_INTERNALS__={transformCallback:()=>0,invoke:async(cmd,args)=>{
 if(cmd==='load_ports')return [{id:'project_layout',name:'배치 검증',folderPath:'/tmp/workroom-layout-fixture'}];
 if(cmd==='load_portal')return {};
 if(cmd==='agent_runtime_request'){const r=await fetch(args.path,{method:args.method,headers:{'Content-Type':'application/json'},body:args.body==null?undefined:JSON.stringify(args.body)});return {status:r.status,body:await r.json().catch(()=>null)};}
 if(cmd!=='workroom_browser_native')throw new Error('Not in this fixture: '+cmd);
 window.nativeOps.push({operation:args.operation,rect:args.rect});
 if(args.operation==='open')window.nativeOpened=true;
 if(window.layoutPopout&&!window.nativeOpened&&args.operation!=='availability')return {available:true,closed:true,preparing:false,url:'',profileKey:args.sessionId};
 const page={available:true,closed:false,preparing:false,url:'https://www.example.com/',targetId:'native_page',port:9333,profileKey:args.sessionId};
 return args.operation==='availability'?{available:true}:page;}};
import '/src/index.css';import '/src/workspaceDesign.css';import '/src/WorkroomSessionDirectory.css';
const {AiTerminalPanel}=await import('/src/AiTerminalPanel.tsx');
function Dialog(){const ref=React.useRef(null);React.useEffect(()=>{ref.current.showModal();},[]);
 return React.createElement('dialog',{ref,className:'workroom-session-dialog','aria-label':'워크룸'},
  React.createElement('header',{className:'workroom-session-dialog-header'},'이렇게만들었어요 · codex'),
  // The same wrapper as WorkroomSessionDirectory and the native QA: the panel is not the content's direct child.
  React.createElement('div',{className:'workroom-session-dialog-content'},React.createElement('fieldset',{className:'session-directory-view-controls'},
   React.createElement(AiTerminalPanel,{popout:true,projects:[{targetId:'project_layout',label:'배치 검증'}],entry:{nonce:1,targetId:'project_layout',sessionId:'session_layout'},sessionScope:'browser-layout'}))));}
${popout?`const {WorkroomPopoutApp}=await import('/src/WorkroomPopoutApp.tsx');
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(WorkroomPopoutApp,{route:{sessionId:'session_layout',targetId:'project_layout',agent:'codex',bypassPermissions:false}}));`
:`ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Dialog));`}
</script>`;
let workspace={id:'owned_layout',sessionId:session.id,targetId:session.targetId,profileId:'owned:session_layout',profileName:'Chromium',source:'owned',page:{id:'native_page',url:'https://www.example.com/',title:'Example'},owner:'human',epoch:1,observation:null,connection:'connected',profileVerification:'verified'};
// Everything about the layout a person sees, measured in one go.
const measure=page=>page.evaluate(()=>{
 const box=s=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height};};
 const content=document.querySelector('.workroom-session-dialog-content'),panel=document.querySelector('.workroom-session-dialog-content .ai-terminal-panel');
 const overflow=[content,panel].filter(Boolean).map(e=>e.scrollHeight-e.clientHeight);
 return {overflow:Math.max(0,...overflow),wide:document.documentElement.scrollWidth-innerWidth,viewport:innerHeight,
  surface:box('.workroom-browser-terminal .ai-terminal-surface'),stack:box('.workroom-browser-terminal'),browser:box('[data-testid=workroom-browser-panel]'),column:box('.workroom-browser-column'),slot:box('[data-testid=owned-browser-slot]'),
  panes:box('.workroom-browser-panes'),composer:box('[data-testid=workroom-command-composer]'),divider:box('[data-testid=workroom-browser-divider]'),
  share:Number(document.querySelector('[data-testid=workroom-browser-divider]')?.getAttribute('aria-valuenow')),
  views:[...document.querySelectorAll('.workroom-browser-tabs button')].map(b=>b.getAttribute('data-testid')),
  viewLabels:[...document.querySelectorAll('.workroom-browser-tabs button')].map(b=>b.textContent),last:window.lastView()};});
// The native view follows its slot a frame or more after a layout change; measure once it has caught up (it must).
const settled=async page=>{await page.waitForFunction(()=>{const l=window.lastView(),r=document.querySelector('[data-testid=owned-browser-slot]')?.getBoundingClientRect();
 return l?.operation==='frame'&&r&&[r.x,r.y,r.width,r.height].every((n,i)=>Math.abs(n-l.rect[i])<1);},undefined,{timeout:5000});return measure(page);};
const fontsLoaded=async page=>assert.deepEqual(await page.evaluate(async()=>Promise.all(['Manrope Variable','JetBrains Mono Variable'].map(async family=>{
 const faces=await document.fonts.load(`13px "${family}"`,'WORKROOM_LAYOUT_TERMINAL_OK');return faces.length>0&&faces.every(face=>face.status==='loaded');
}))),[true,true],'the actual packaged sans and mono fonts load before measuring layout');
try{for(const [name,engine] of Object.entries({chromium,webkit})){
 const browser=await engine.launch({headless:true});try{
  const page=await browser.newPage({viewport:{width:1512,height:982}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();
   if(url.pathname==='/__layout')return route.fulfill({contentType:'text/html',body:page_html(url.searchParams.get('shell')==='popout')});
   if(!url.pathname.startsWith('/api/'))return route.continue();
   if(url.pathname==='/api/ports')return route.fulfill({json:[]});
   if(url.pathname==='/api/agent-dialogue/control')return route.fulfill({json:{success:true,inside:false,deviceId:'layout-device',devices:[],unread:0,lastMessageAt:null}});
   if(url.pathname==='/api/agent-runtime/terminals/history')return route.fulfill({json:{protocolVersion:'workroom-history-v1',storeInstanceId:'layout-history-store-001',restart:null}});
   if(url.pathname==='/api/agent-runtime/workroom-browser'){const r=req.postDataJSON();
    if(r.operation==='recoveries')return route.fulfill({json:{success:true,recoveries:[]}});
    if(r.operation==='resume')workspace={...workspace,owner:'agent',observation:{id:'obs_layout',text:Array.from({length:60},(_,i)=>`[${i}] textbox draft`).join('\n')}};
    if(r.operation==='grant')return route.fulfill({json:{success:true,grant:'grant_layout',workspace}});
    return route.fulfill({json:{success:true,workspace}});}
   if(url.pathname.endsWith('/targets'))return route.fulfill({json:{targets:[{targetId:'project_layout',label:'배치 검증'}],complete:true,protocolVersion:'agentstoz-tasks-v2'}});
   if(url.pathname.endsWith('/terminals')){const r=req.postDataJSON();
    if(r.operation==='activity'){await new Promise(resolve=>setTimeout(resolve,300));return route.fulfill({json:{activity:{bootId:'00000000-0000-4000-8000-000000000001',cursor:1,reset:!r.after,sessions:[],events:[]}}});}
    if(r.operation==='list')return route.fulfill({json:{sessions:[session]}});
    if(r.operation==='read')return route.fulfill({json:{session,chunks:r.after===0?[{seq:1,text:'\x1b[H\x1b[2JWORKROOM_LAYOUT_TERMINAL_OK\r\n'}]:[],nextCursor:1,hasMore:false,truncated:false}});
    if(r.operation==='accounts')return route.fulfill({json:{accounts:{agent:'codex',selectedAccountId:'host-default',items:[{id:'host-default',agent:'codex',label:'Test CLI',authState:'unknown',checkedAt:null,loginState:'idle'}]}}});
    if(r.operation==='workspace')return route.fulfill({status:400,json:{error:'Fixture workspace unsupported'}});
    return route.fulfill({json:{session}});}
   return route.fulfill({json:{connections:[],jobs:[],rateLimits:null}});
  });
  try{
  await page.goto(`${origin}/__layout`);await page.waitForFunction(()=>document.querySelector('.xterm-rows')?.textContent?.includes('WORKROOM_LAYOUT_TERMINAL_OK'));
  await fontsLoaded(page);
  const base=await measure(page);
  // Controls are found by data-testid and state is read from data attributes; the Korean view labels get one smoke check.
  await page.getByTestId('workroom-browser-toggle').click();await page.getByTestId('owned-browser-address').fill('https://www.example.com/');await page.getByTestId('owned-browser-address').press('Enter');
  // A workspace is attached (any owner: the second engine starts from the first one's last, AI-held workspace).
  await page.locator('[data-testid=workroom-browser-panel]:not([data-owner=""])').waitFor();
  let m=await settled(page);
  assert.deepEqual(m.views,['workroom-browser-view-terminal','workroom-browser-toggle','workroom-browser-only'],'one switch, no duplicate browser view and no separate collapse');
  assert.deepEqual(m.viewLabels,['터미널','나란히','브라우저'],'smoke: the three views keep their Korean labels');
  // A short window already scrolls for the terminal's key rows; the browser must not add to it.
  assert(m.overflow<=base.overflow+2,`${name}: the split view scrolls no further than the terminal view (${m.overflow}px, terminal ${base.overflow}px)`);
  assert(m.slot.top>=0&&m.slot.bottom<=m.viewport,`${name}: the whole page slot is on screen, so the native page shows`);
  assert(Math.abs(m.stack.top-m.browser.top)<=2&&Math.abs(m.stack.bottom-m.column.bottom)<=2&&m.surface.height>=160,`${name}: the page column including its height handle stands beside the whole terminal stack (terminal ${Math.round(m.surface.height)}px, stack ${Math.round(m.stack.top)}–${Math.round(m.stack.bottom)}, column ${Math.round(m.column.top)}–${Math.round(m.column.bottom)})`);
  assert(m.composer.left<m.browser.left&&m.composer.right<=m.browser.left,`${name}: the composer sits in the terminal column`);
  assert(m.slot.height>=m.browser.height*0.5,`${name}: the page gets most of the panel (page ${Math.round(m.slot.height)} of ${Math.round(m.browser.height)}px)`);
  assert(m.composer.top+120<=m.viewport,`${name}: the composer's input stays on screen`);
  assert.deepEqual(m.last.rect.map(Math.round),[m.slot.left,m.slot.top,m.slot.width,m.slot.height].map(Math.round),`${name}: the native page is placed exactly on its slot`);
  const split=m;
  const assertDividerRange=async(handle,label)=>{
   const values=await handle.evaluate(node=>['aria-valuemin','aria-valuenow','aria-valuemax'].map(key=>Number(node.getAttribute(key))));
   assert(values.every(Number.isFinite)&&values[0]<=values[1]&&values[1]<=values[2],`${name}: ${label} exposes a current value within its accessible range (${values.join(', ')})`);
  };
  checks.push(`${name}: split view fits the dialog, terminal ${Math.round(m.surface.height)}px beside a ${Math.round(m.slot.height)}px page, composer visible`);
  // The divider: the native page hides while dragging (it would take the pointer) and returns on its new slot.
  const divider=await page.getByTestId('workroom-browser-divider').boundingBox(),y=divider.y+divider.height/2;
  await page.mouse.move(divider.x+divider.width/2,y);await page.mouse.down();await page.mouse.move(m.panes.left+m.panes.width*0.35,y,{steps:6});
  await page.waitForFunction(()=>window.lastView()?.operation==='hide');
  await page.mouse.up();
  const dragged=await settled(page),share=dragged.stack.width/dragged.panes.width;
  assert(share>0.3&&share<0.4,`${name}: dragging the divider gives the terminal about 35% (got ${Math.round(share*100)}%)`);
  const middle=box=>box.left+box.width/2,pointer=m.panes.left+m.panes.width*0.35;
  assert(Math.abs(middle(dragged.divider)-pointer)<=2,`${name}: the divider stays under the pointer (divider ${Math.round(middle(dragged.divider))}px, pointer ${Math.round(pointer)}px)`);
  assert.deepEqual(dragged.last.rect.map(Math.round),[dragged.slot.left,dragged.slot.top,dragged.slot.width,dragged.slot.height].map(Math.round));
  assert.equal(Math.round(await page.evaluate(()=>JSON.parse(localStorage.getItem('agentstoz.workroomBrowserSplit')??'{}').session_layout)),dragged.share,`${name}: the width is remembered`);
  // Either side can be dragged down to its floor (terminal min(160px,25%), page min(220px,30%)), and no further: the
  // divider stops where the columns stop instead of running ahead of them, and its value is the width shown.
  const drag=async x=>{const d=await page.getByTestId('workroom-browser-divider').boundingBox();await page.mouse.move(middle({left:d.x,width:d.width}),y);await page.mouse.down();await page.mouse.move(x,y,{steps:6});await page.mouse.up();return settled(page);};
  const narrow=await drag(m.panes.left+10),terminalFloor=Math.max(narrow.panes.width*.15,Math.min(160,narrow.panes.width*0.25));
  assert(Math.abs(narrow.stack.width-terminalFloor)<=2,`${name}: dragged far left, the terminal shrinks to its ${Math.round(terminalFloor)}px floor (got ${Math.round(narrow.stack.width)}px)`);
  assert(Math.abs(narrow.share-narrow.stack.width/narrow.panes.width*100)<=1,`${name}: the divider's value is the terminal's real share (${narrow.share}%)`);
  const wide=await drag(m.panes.right-10),pageFloor=Math.min(220,wide.panes.width*0.3);
  assert(Math.abs(wide.browser.width-pageFloor)<=2,`${name}: dragged far right, the page shrinks to its ${Math.round(pageFloor)}px floor (got ${Math.round(wide.browser.width)}px)`);
  assert(Math.abs(wide.share-wide.stack.width/wide.panes.width*100)<=1&&middle(wide.divider)<wide.browser.left,`${name}: the divider stops at the page's floor (${wide.share}%)`);
  assert.deepEqual(wide.last.rect.map(Math.round),[wide.slot.left,wide.slot.top,wide.slot.width,wide.slot.height].map(Math.round),`${name}: the native page follows the narrowest page`);
  await page.getByTestId('workroom-browser-divider').focus();await page.keyboard.press('Home');
  assert.equal(await page.getByTestId('workroom-browser-divider').getAttribute('aria-valuenow'),String(narrow.share),`${name}: Home gives the terminal its narrowest width`);
  await assertDividerRange(page.getByTestId('workroom-browser-divider'),'width Home');
  await page.keyboard.press('End');
  assert.equal(await page.getByTestId('workroom-browser-divider').getAttribute('aria-valuenow'),String(wide.share),`${name}: End gives the page its narrowest width`);
  await assertDividerRange(page.getByTestId('workroom-browser-divider'),'width End');
  await page.getByTestId('workroom-browser-divider').dblclick();assert.equal(await page.getByTestId('workroom-browser-divider').getAttribute('aria-valuenow'),'50');
  checks.push(`${name}: the divider follows the pointer to each side's floor (terminal ${Math.round(narrow.stack.width)}px, page ${Math.round(wide.browser.width)}px), hides the native page while dragging and remembers the width`);
  // Resizing the window keeps the chosen share, and the native page follows its slot to the new size.
  for(const viewport of [{width:1180,height:760},{width:1512,height:982}]){
   await page.setViewportSize(viewport);
   const resized=await settled(page);
   assert(Math.abs(resized.stack.width/resized.panes.width-0.5)<=0.01,`${name}: at ${viewport.width}x${viewport.height} the split stays half and half`);
   assert(resized.slot.top>=0&&resized.slot.bottom<=resized.viewport&&resized.slot.right<=viewport.width,`${name}: at ${viewport.width}x${viewport.height} the whole page is on screen`);
   assert.deepEqual(resized.last.rect.map(Math.round),[resized.slot.left,resized.slot.top,resized.slot.width,resized.slot.height].map(Math.round),`${name}: at ${viewport.width}x${viewport.height} the native page sits on its slot`);
  }
  checks.push(`${name}: resizing the window keeps the split and moves the native page with its slot`);
  await page.getByTestId('workroom-browser-only').click();await page.waitForFunction(()=>window.lastView()?.operation==='frame'&&window.lastView().rect[2]>900);
  m=await settled(page);
  assert(m.overflow<=base.overflow+2&&m.composer.top<m.viewport,`${name}: the browser view scrolls no further than the terminal view (${m.overflow}px)`);
  assert(m.slot.width>=split.slot.width*1.8&&m.slot.top>=0&&m.slot.bottom<=m.viewport,`${name}: the browser view gives the page the full width, all of it on screen (${Math.round(m.slot.width)}px wide)`);
  assert(m.composer.top>=m.browser.bottom&&m.composer.top+120<=m.viewport,`${name}: the composer stays under the page`);
  assert(m.slot.height>=m.browser.height*0.5,`${name}: the browser view gives the page most of the panel (page ${Math.round(m.slot.height)} of ${Math.round(m.browser.height)}px)`);
  assert.equal(await page.locator('.xterm').count(),1,'the hidden terminal stays mounted');
  await page.setViewportSize({width:1180,height:760});m=await settled(page);
  assert(m.slot.top>=0&&m.slot.bottom<=m.viewport&&m.slot.width>=m.panes.width*0.9,`${name}: a smaller window still gives the browser view the full width, on screen (${Math.round(m.slot.width)}px)`);
  await page.setViewportSize({width:1512,height:982});await settled(page);
  checks.push(`${name}: browser-only view fills the dialog with the terminal still mounted, and follows a window resize`);
  await page.setViewportSize({width:800,height:900});await page.getByTestId('workroom-browser-toggle').click();await page.waitForTimeout(300);
  m=await measure(page);assert(m.wide<=0,`${name}: no sideways page scroll at 800px (${m.wide}px)`);
  checks.push(`${name}: no sideways page scroll at 800px`);
  // The actual 800px user complaint: both axes must move by a useful amount, not a ~22px range. Pointer input goes
  // through the real browser; synthetic dispatch cannot establish pointer capture or prove native-view shielding.
  const smallStart=await settled(page),dragSmall=async x=>{const d=await page.getByTestId('workroom-browser-divider').boundingBox();await page.mouse.move(d.x+d.width/2,d.y+d.height/2);await page.mouse.down();await page.mouse.move(x,d.y+d.height/2,{steps:6});await page.mouse.up();return settled(page);};
  const smallLeft=await dragSmall(smallStart.panes.left+50),smallRight=await dragSmall(smallStart.panes.right-50);
  assert(smallRight.divider.left-smallLeft.divider.left>=80,`${name}: at 800px horizontal drag travels at least 80px, not a nearly fixed split`);
  await page.getByTestId('workroom-browser-divider').dblclick();await settled(page);
  const heightHandle=page.getByTestId('workroom-browser-height-divider');await heightHandle.waitFor();
  const beforeHeight=await settled(page),h=await heightHandle.boundingBox();
  await page.mouse.move(h.x+h.width/2,h.y+h.height/2);await page.mouse.down();await page.mouse.move(h.x+h.width/2,h.y-120,{steps:6});
  await page.waitForFunction(()=>window.lastView()?.operation==='hide');await page.mouse.up();
  const manualHeight=await settled(page);assert(beforeHeight.slot.height-manualHeight.slot.height>=60,`${name}: vertical drag visibly shortens the page by at least 60px`);
  assert(manualHeight.slot.height>=200&&manualHeight.slot.bottom<=manualHeight.viewport,`${name}: manually resized page stays at least 200px and inside the window`);
  assert.deepEqual(manualHeight.last.rect.map(Math.round),[manualHeight.slot.left,manualHeight.slot.top,manualHeight.slot.width,manualHeight.slot.height].map(Math.round),`${name}: the native rectangle follows manual height`);
  await page.getByTestId('workroom-browser-view-terminal').click();await page.getByTestId('owned-browser-slot').waitFor({state:'detached'});await page.getByTestId('workroom-browser-toggle').click();
  assert(Math.abs((await settled(page)).slot.height-manualHeight.slot.height)<=2,`${name}: collapsing and reopening preserves the chosen browser height`);
  for(const key of ['Home','End']){await heightHandle.focus();await page.keyboard.press(key);await settled(page);await assertDividerRange(heightHandle,`height ${key}`);}
  await heightHandle.dblclick();const automatic=await settled(page);assert(Math.abs(automatic.slot.height-beforeHeight.slot.height)<=2,`${name}: double-click restores the default page height`);
  assert.equal(await page.locator('.xterm').count(),1,`${name}: two-axis resize never remounts the retained terminal`);
  checks.push(`${name}: an 800px window supports useful horizontal and vertical pointer resize, preserves manual height across collapse and restores automatic sizing`);
  // K1: Escape in the address field belongs to the field. It restores the address and leaves, and the Workroom dialog
  // around it stays open.
  {const address=page.getByTestId('owned-browser-address'),before=await address.inputValue();
   await address.click();if(await address.isEditable())await page.keyboard.type('never opened');await page.keyboard.press('Escape');await page.waitForTimeout(100);
   assert.equal(await page.locator('dialog.workroom-session-dialog[open]').count(),1,`${name}: Escape in the address field leaves the Workroom dialog open`);
   assert.equal(await address.inputValue(),before,`${name}: Escape restores the address`);
   assert.equal(await address.evaluate(e=>document.activeElement===e),false,`${name}: Escape leaves the address field`);}
  checks.push(`${name}: Escape in the address field restores it and leaves the Workroom dialog open`);
  // The native QA's calibrated 800x814 CSS viewport: AI control with a page observation and the access grant added
  // to the composer. The composer grows; the page must stay whole on screen rather than stretch with the stack.
  await page.setViewportSize({width:800,height:814});await page.evaluate(()=>localStorage.setItem('portmanager-workroom-font-size','16'));
  workspace={...workspace,owner:'human',observation:null};
  await page.getByTestId('workroom-browser-handoff').waitFor();await page.getByTestId('workroom-browser-handoff').click();
  await page.getByTestId('workroom-browser-handoff-chip').waitFor();
  assert.equal(await page.locator('textarea').evaluateAll(nodes=>nodes.some(node=>/grant=|workspaceId=/.test(node.value))),false,`${name}: access remains in the composer chip`);
  await page.getByTestId('workroom-command-composer').locator('textarea').fill(Array.from({length:30},()=> '화면을 확인한 뒤 변경 내용을 설명해 주세요.').join('\n'));
  m=await settled(page).catch(()=>measure(page));
  // Not by luck of where the draft scrolled the Workroom: the Workroom does not scroll at all, the terminal column does.
  assert(m.overflow<=2,`${name}: the Workroom itself does not scroll in the native QA window (${m.overflow}px)`);
  assert(m.slot.top>=0&&m.slot.bottom<=m.viewport,`${name}: with AI control, an observation and the grant draft, the whole slot stays on screen (slot ${Math.round(m.slot.top)}–${Math.round(m.slot.bottom)} of ${m.viewport})`);
  assert(m.composer.top>=m.stack.top-1&&m.slot.height>=200,`${name}: the page keeps a usable height (${Math.round(m.slot.height)}px)`);
  assert(m.last.operation==='frame',`${name}: the native page is shown, not hidden`);
  assert.deepEqual(m.last.rect.map(Math.round),[m.slot.left,m.slot.top,m.slot.width,m.slot.height].map(Math.round),`${name}: the native page is placed exactly on its slot`);
  checks.push(`${name}: in the native QA window the page stays whole on screen through AI control and a long draft (${Math.round(m.slot.height)}px page)`);
  if(process.env.LAYOUT_DEBUG)console.error(name,JSON.stringify({slot:m.slot,panes:m.panes,stack:m.stack,browser:m.browser,composer:m.composer,overflow:m.overflow,viewport:m.viewport,scroll:await page.evaluate(()=>document.querySelector('.workroom-session-dialog-content').scrollTop),frameTop:await page.evaluate(()=>document.querySelector('.workroom-browser-frame').getBoundingClientRect().top),body:await page.evaluate(()=>[...document.querySelector('.ai-terminal-body').children].map(e=>e.className+':'+Math.round(e.getBoundingClientRect().height))),chain:await page.evaluate(()=>{const out=[];for(let e=document.querySelector('.workroom-browser-frame');e;e=e.parentElement){const r=e.getBoundingClientRect();out.push(`${e.tagName}.${String(e.className).split(' ')[0]} top=${Math.round(r.top)} h=${Math.round(r.height)} sh=${e.scrollHeight} ch=${e.clientHeight} st=${e.scrollTop}`);}return out;})}));
  // Installed standalone windows use WorkroomPopoutApp -> WorkroomDeviceSwitch -> its visible content div -> panel.
  // A direct dialog/fieldset panel cannot catch a missing flex-height link in this actual production wrapper stack.
  await page.setViewportSize({width:1120,height:780});
  await page.evaluate(()=>{localStorage.removeItem('agentstoz.workroomBrowserHeight');localStorage.removeItem('agentstoz.workroomBrowserSplit');});
  workspace={...workspace,owner:'human',observation:null};
  await page.goto(`${origin}/__layout?shell=popout`);
  await page.waitForFunction(()=>document.querySelector('.xterm-rows')?.textContent?.includes('WORKROOM_LAYOUT_TERMINAL_OK'));
  await fontsLoaded(page);
  const inspectPopout=()=>page.evaluate(()=>{
   const rect=selector=>{const node=document.querySelector(selector),r=node?.getBoundingClientRect();return r?{top:r.top,bottom:r.bottom,width:r.width,height:r.height}:null;};
   const shell=document.querySelector('[data-testid=workroom-popout-window]'),wrapper=shell?.querySelector(':scope > .workroom-device-content:not([hidden])'),panel=wrapper?.querySelector(':scope > .ai-terminal-panel');
   const maxOverflow=Math.max(0,document.documentElement.scrollHeight-innerHeight,...[shell,wrapper,panel].filter(Boolean).map(node=>node.scrollHeight-node.clientHeight));
   return {viewport:innerHeight,shell:rect('[data-testid=workroom-popout-window]'),wrapper:rect('.workroom-popout > .workroom-device-content:not([hidden])'),panel:rect('.workroom-popout > .workroom-device-content:not([hidden]) > .ai-terminal-panel'),
    slot:rect('[data-testid=owned-browser-slot]'),composer:rect('[data-testid=workroom-command-composer]'),overflow:maxOverflow,
    hiddenBranch:!!shell?.querySelector(':scope > .workroom-device-content[hidden]')&&getComputedStyle(shell.querySelector(':scope > .workroom-device-content[hidden]')).display==='none',
    height:document.querySelector('[data-testid=workroom-browser-height-divider]')?.getAttribute('aria-disabled')};
  });
  const assertPopout=async(label)=>{
   const layout=await inspectPopout();
   assert(layout.wrapper&&layout.panel&&layout.hiddenBranch,`${name}: ${label} uses the real visible DeviceSwitch wrapper and keeps the other branch hidden`);
   assert(layout.shell.height===layout.viewport&&layout.wrapper.height>=layout.shell.height-18&&Math.abs(layout.panel.height-layout.wrapper.height)<=1,`${name}: ${label} passes the viewport height through every standalone wrapper ${JSON.stringify(layout)}`);
   assert(layout.overflow<=2,`${name}: ${label} has no outer/panel scroll that could hide the composer or native page ${JSON.stringify(layout)}`);
   assert(layout.slot.height>=200&&layout.slot.top>=0&&layout.slot.bottom<=layout.viewport,`${name}: ${label} preserves the 200px page floor fully inside the window ${JSON.stringify(layout)}`);
   assert(layout.composer.top>=layout.slot.bottom&&layout.composer.bottom<=layout.viewport,`${name}: ${label} keeps the whole composer below the page and on screen ${JSON.stringify(layout)}`);
   return layout;
  };
  await page.getByTestId('workroom-browser-only').click();await page.getByTestId('owned-browser-slot').waitFor();
  // No existing page: even the address/empty state must fill the bounded standalone layout, not an intrinsic 200px block.
  await page.waitForFunction(()=>document.querySelector('[data-testid=workroom-browser-height-divider]')?.hasAttribute('aria-valuemax'));
  await assertPopout('1120x780 empty browser');
  checks.push(`${name}: actual standalone popout wrapper stack fits the empty browser and whole composer at 1120x780`);
  await page.getByTestId('owned-browser-address').fill('https://www.example.com/');await page.getByTestId('owned-browser-address').press('Enter');
  await settled(page);const laptopPopout=await assertPopout('1120x780 connected browser');
  await page.setViewportSize({width:3440,height:1440});await settled(page);
  const largePopout=await assertPopout('3440x1440 connected browser');
  assert(largePopout.slot.height>=laptopPopout.slot.height+300,`${name}: enlarging the actual popout grows page height, not just width (${laptopPopout.slot.height} -> ${largePopout.slot.height})`);
  // An enabled separator omits aria-disabled; only an exhausted range emits aria-disabled="true".
  assert([null,'false'].includes(largePopout.height),`${name}: the enlarged standalone popout does not disable vertical resizing`);
  const popoutHandle=page.getByTestId('workroom-browser-height-divider'),handleBox=await popoutHandle.boundingBox();
  await popoutHandle.focus();assert.equal(await popoutHandle.evaluate(node=>document.activeElement===node),true,`${name}: the enabled standalone height separator receives focus`);
  await assertDividerRange(popoutHandle,'standalone height');
  await page.mouse.move(handleBox.x+handleBox.width/2,handleBox.y+handleBox.height/2);await page.mouse.down();await page.mouse.move(handleBox.x+handleBox.width/2,handleBox.y-100,{steps:6});await page.mouse.up();await settled(page);
  const resizedPopout=await assertPopout('manually resized standalone browser');
  assert(largePopout.slot.height-resizedPopout.slot.height>=60,`${name}: the actual standalone height handle visibly resizes the page`);
  await popoutHandle.dblclick();await settled(page);
  assert(Math.abs((await assertPopout('restored automatic standalone browser')).slot.height-largePopout.slot.height)<=2,`${name}: double-click restores automatic height in the actual popout`);
  await page.setViewportSize({width:1120,height:780});await settled(page);await assertPopout('restored laptop standalone browser');
  assert.equal(await page.locator('.xterm').count(),1,`${name}: standalone window and browser resize keep one terminal mounted`);
  checks.push(`${name}: actual standalone popout grows vertically from laptop to 3440x1440, supports height drag/reset and returns with its native slot/composer on screen`);
  assert.deepEqual(errors,[]);
  }catch(e){if(process.env.LAYOUT_SHOT)await page.screenshot({path:`${process.env.LAYOUT_SHOT}-${name}.png`}).catch(()=>{});console.error(errors,await page.evaluate(()=>window.nativeOps?.slice(-5)).catch(()=>null));throw e;}
 }finally{await browser.close();}
}}finally{await vite.close();http.close();}
console.log(JSON.stringify({ok:true,checks},null,1));
