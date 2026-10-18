/** Workroom attachments (S3, 2026-10-16) in the real React+xterm panel, web build (no Tauri).
 * Start an isolated Vite first, then: node tests/workroom-attachments.e2e.mjs http://127.0.0.1:<port>
 * Every API is mocked; nothing is saved, captured or typed into a real CLI.
 * Covers: buttons in the main window and a pop-out, one file input, photo/file picking, pasting a PDF, an empty
 * paste, a DOM drop (with its overlay), both request blocks on send, an older Mac without save-file, the phone.
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
const session=(id,state='running',agent='codex')=>({id,targetId:A,agent,state,createdAt:'2026-10-16T00:46:40Z',exitCode:state==='running'?null:0,cols:100,rows:28});
const APP='/Users/fixture/Library/Application Support/com.portmanager.portmanager';
const IMAGE_PATH=`${APP}/workroom-images/2026-10-16/153012-aaaaaaaa.png`;
const FILE_DIR=`${APP}/workroom-files/2026-10-16`;
const THUMB='data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
const PNG=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,13]);
const PDF=Buffer.from('%PDF-1.7\n1 0 obj\n');
const EMPTY_PASTE='붙여 넣을 수 있는 글·이미지·파일이 없습니다. 클립보드를 확인하세요.';
const LEGACY='이 Mac의 앱이 아직 파일 첨부를 지원하지 않습니다. 앱을 업데이트하세요 — 이미지 붙여넣기와 화면 캡처는 그대로 쓸 수 있습니다.';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,message,timeout=6000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await sleep(15);}assert.fail(message);}
const html=options=>`<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};
import '/src/index.css';import '/src/workspaceDesign.css';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
document.documentElement.dataset.appTheme='gray';
const {AiTerminalPanel}=await import('/src/AiTerminalPanel.tsx');
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement('main',{style:{padding:'16px'}},React.createElement(AiTerminalPanel,{projects:${JSON.stringify(projects)},visible:true,remote:${!!options.remote},popout:${!!options.popout},sessionScope:${JSON.stringify(options.popout?'popout':'local')},entry:{nonce:1,targetId:${JSON.stringify(A)},sessionId:${JSON.stringify(SA)}},workspaceTransport:request=>fetch('/api/agent-runtime/terminals',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)}).then(r=>r.json())})));
</script>`;
const browser=await chromium.launch({headless:true}),results=[];
async function fixture(options={}){
  const context=await browser.newContext({viewport:{width:1100,height:1000},serviceWorkers:'block'});
  if(options.windows)await context.addInitScript(()=>{Object.defineProperty(Navigator.prototype,'platform',{get:()=>'Win32'});});
  const state={sessions:[session(SA)],requests:[],errors:[],blocked:[]};
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==origin){state.blocked.push(url.origin+url.pathname);return route.abort('blockedbyclient');}
    if(url.pathname==='/__workroom-attachments')return route.fulfill({contentType:'text/html',body:html(options)});
    if(!url.pathname.startsWith('/api/'))return route.continue();
    const body=request.postDataJSON?.()??null;state.requests.push({path:url.pathname,...(body??{})});
    const respond=(json,status=200)=>route.fulfill({json,status}).catch(()=>{});
    if(url.pathname==='/api/agent-runtime/targets')return respond({protocolVersion:'agentstoz-tasks-v2',targets:projects,complete:true});
    if(url.pathname==='/api/ai-usage/codex')return respond({rateLimits:null});
    if(url.pathname==='/api/agent-runtime/terminals/access')return respond({connections:[]});
    if(url.pathname==='/api/agent-runtime/terminals/memory')return respond({jobs:[]});
    if(url.pathname==='/api/agent-runtime/terminals/images'){
      if(body.operation==='save'){if(!(typeof body.data==='string'&&body.data.length>8))state.blocked.push('save '+JSON.stringify(body).slice(0,120));return respond({path:IMAGE_PATH,name:'153012-aaaaaaaa.png',bytes:2048,thumbnail:THUMB});}
      if(body.operation==='save-file'){
        if(options.legacy)return respond({error:'이미지 요청이 올바르지 않습니다.'},400);
        if(Object.keys(body).sort().join(',')!=='data,name,operation'||!(body.data.length>0))state.blocked.push('save-file '+JSON.stringify(body).slice(0,120));
        return respond({kind:'file',path:`${FILE_DIR}/153013-bbbbbbbb-${body.name}`,name:body.name,bytes:Buffer.from(body.data,'base64').length});
      }
      if(body.operation==='capture')return respond({cancelled:true});
    }
    if(url.pathname==='/api/agent-runtime/terminals'){
      if(body.operation==='workspace')return respond({kind:'workspace',action:'workroom.status',workroom:{sessionId:body.workspace.sessionId,initialized:true,lastSavedAt:null,context:{usedPercent:null,observedAt:null,source:'unavailable'},save:{requestId:null,state:'idle',localSaved:false,backupSaved:false,message:''}}});
      if(body.operation==='list')return respond({sessions:state.sessions});
      if(body.operation==='accounts')return respond({accounts:{agent:body.agent,selectedAccountId:'host-default',items:[{id:'host-default',agent:body.agent,label:'현재 CLI 계정',authState:'unknown',checkedAt:null,loginState:'idle'}]}});
      const selected=state.sessions.find(current=>current.id===body.sessionId);if(!selected){state.blocked.push('terminal '+JSON.stringify(body).slice(0,200));return respond({error:'Unknown fixture terminal'},400);}
      if(body.operation==='read')return respond({session:selected,chunks:body.after<1?[{seq:1,text:'> 준비됨\r\n'}]:[],nextCursor:Math.max(1,body.after),truncated:false,hasMore:false});
      if(['input','resize'].includes(body.operation))return respond({session:selected});
    }
    state.blocked.push(`${request.method()} ${url.pathname}`);return respond({error:'Unmocked API is forbidden'},503);
  });
  const page=await context.newPage();page.on('pageerror',error=>state.errors.push(error.message));
  page.on('dialog',dialog=>void dialog.accept());
  await page.goto(`${origin}/__workroom-attachments`);const panel=page.getByTestId('ai-terminal-panel');await panel.waitFor({timeout:10000});
  await until(()=>state.requests.some(r=>r.operation==='read'),'The fixture session must be read');
  return{context,page,panel,state};
}
async function run(name,body,options){
  const f=await fixture(options);
  try{await body(f);assert.deepEqual(f.state.errors,[],'No page errors');assert.deepEqual(f.state.blocked,[],'No unmocked request');results.push({name,status:'passed'});console.log('✓',name);}
  catch(error){results.push({name,status:'failed',error:String(error?.stack??error)});console.error('✗',name,error);}
  finally{await f.context.close();}
}
const inputs=state=>state.requests.filter(r=>r.operation==='input').map(r=>r.data).join('');
const saves=(state,operation)=>state.requests.filter(r=>r.operation===operation);
/** A file drag over an element, as the browser delivers it (web build: File objects, no path). */
async function drag(locator,files,{drop=true}={}){
  await locator.evaluate((element,{files,drop})=>{
    const data=new DataTransfer();
    for(const f of files)data.items.add(new File([new Uint8Array(f.bytes)],f.name,{type:f.type}));
    const rect=element.getBoundingClientRect(),at={clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2,bubbles:true,cancelable:true,dataTransfer:data};
    element.dispatchEvent(new DragEvent('dragenter',at));element.dispatchEvent(new DragEvent('dragover',at));
    if(drop)element.dispatchEvent(new DragEvent('drop',at));
  },{files:files.map(f=>({name:f.name,type:f.type,bytes:[...f.bytes]})),drop});
}
const shots=process.env.WORKROOM_SHOT;

try{
  for(const popout of [false,true]){
    await run(`${popout?'pop-out':'main window'}: 「사진 첨부」·「파일 첨부」·「화면 캡처 ▾」 are visible, with exactly one file input`,async({page,panel})=>{
      for(const id of ['workroom-attach-photo','workroom-attach-file','workroom-capture-menu'])assert.ok(await panel.getByTestId(id).isVisible(),id);
      assert.equal(await panel.locator('input[type=file]').count(),1);
      assert.equal(await panel.getByTestId('workroom-capture-region').count(),0,'Capture modes stay in the menu until it opens');
      await panel.getByTestId('workroom-capture-menu').click();
      for(const mode of ['region','window','screen'])assert.ok(await panel.getByTestId(`workroom-capture-${mode}`).isVisible(),mode);
      if(shots)await page.screenshot({path:shots.replace('.png',`-${popout?'popout':'main'}-menu.png`)});
      await page.keyboard.press('Escape');await until(async()=>await panel.getByTestId('workroom-capture-region').count()===0,'Esc closes the capture menu');
    },{popout});
  }
  await run('picking a PNG gives an image chip; picking a PDF gives a file chip; sending appends both blocks',async({page,panel,state})=>{
    const [photo]=await Promise.all([page.waitForEvent('filechooser'),panel.getByTestId('workroom-attach-photo').click()]);
    assert.equal(await panel.locator('input[type=file]').getAttribute('accept'),'image/*','The photo picker filters images');
    await photo.setFiles({name:'화면.png',mimeType:'image/png',buffer:PNG});
    await panel.getByTestId('workroom-image-chip').getByText('화면.png').waitFor();
    const [file]=await Promise.all([page.waitForEvent('filechooser'),panel.getByTestId('workroom-attach-file').click()]);
    assert.equal(await panel.locator('input[type=file]').getAttribute('accept'),'','The file picker takes any file');
    await file.setFiles({name:'보고서.pdf',mimeType:'application/pdf',buffer:PDF});
    await panel.getByTestId('workroom-file-chip').getByText('보고서.pdf').waitFor();
    assert.equal(saves(state,'save').length,1);assert.equal(saves(state,'save-file').length,1);
    assert.equal(saves(state,'save-file')[0].name,'보고서.pdf');
    if(shots)await page.screenshot({path:shots.replace('.png','-chips.png'),fullPage:true});
    const composer=panel.getByLabel('워크룸 입력');await composer.fill('이 둘 검토해줘');
    await panel.getByRole('button',{name:'현재 세션에 전송'}).click();
    await until(()=>inputs(state).includes('[첨부 파일 1개'),'The file block reaches the CLI');
    const sent=inputs(state);
    assert.ok(sent.includes(`이 둘 검토해줘\n\n[첨부 이미지 1개 — 각 파일을 열어 확인하세요]\n${IMAGE_PATH}\n\n[첨부 파일 1개 — 각 파일을 열어 확인하세요]\n${FILE_DIR}/153013-bbbbbbbb-보고서.pdf`)||sent.replace(/\r/g,'\n').includes(`[첨부 파일 1개 — 각 파일을 열어 확인하세요]\n${FILE_DIR}/153013-bbbbbbbb-보고서.pdf`),`both blocks in order: ${JSON.stringify(sent)}`);
    assert.ok(sent.indexOf('[첨부 이미지 1개')<sent.indexOf('[첨부 파일 1개'),'Images first, then files');
    await until(async()=>await panel.getByTestId('workroom-file-chip').count()===0&&await panel.getByTestId('workroom-image-chip').count()===0,'Sent attachments leave the composer');
  });
  await run('pasting a PDF gives a file chip without typing its name; an empty paste says so',async({panel,state})=>{
    const composer=panel.getByLabel('워크룸 입력');await composer.click();
    await composer.evaluate((element,bytes)=>{
      const data=new DataTransfer();data.setData('text/plain','계약서.pdf');data.items.add(new File([new Uint8Array(bytes)],'계약서.pdf',{type:'application/pdf'}));
      const event=new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true});element.dispatchEvent(event);element.dataset.prevented=String(event.defaultPrevented);
    },[...PDF]);
    await panel.getByTestId('workroom-file-chip').getByText('계약서.pdf').waitFor();
    assert.equal(await composer.getAttribute('data-prevented'),'true','A Finder copy does not also type the file name');
    assert.equal(await composer.inputValue(),'');
    assert.equal(saves(state,'save-file').length,1);
    await composer.evaluate(element=>{const event=new ClipboardEvent('paste',{clipboardData:new DataTransfer(),bubbles:true,cancelable:true});element.dispatchEvent(event);});
    await panel.getByRole('alert').getByText(EMPTY_PASTE).waitFor();
  });
  await run('web build: a drop shows the overlay, then the dropped files become chips (composer and terminal)',async({page,panel,state})=>{
    await drag(panel.getByTestId('workroom-command-composer'),[{name:'메모.txt',type:'text/plain',bytes:Buffer.from('hello')}],{drop:false});
    const overlay=panel.getByTestId('workroom-drop-overlay');await overlay.waitFor();
    assert.match(await overlay.innerText(),/여기에 놓으면 첨부합니다/);
    if(shots)await page.screenshot({path:shots.replace('.png','-overlay.png'),fullPage:true});
    await drag(panel.getByTestId('workroom-command-composer'),[{name:'메모.txt',type:'text/plain',bytes:Buffer.from('hello')},{name:'shot.png',type:'image/png',bytes:PNG}]);
    await panel.getByTestId('workroom-file-chip').getByText('메모.txt').waitFor();
    await panel.getByTestId('workroom-image-chip').waitFor();
    assert.equal(await overlay.count(),0,'The overlay leaves after the drop');
    await drag(panel.locator('.ai-terminal-surface'),[{name:'로그.txt',type:'text/plain',bytes:Buffer.from('x')}]);
    await panel.getByTestId('workroom-file-chip').getByText('로그.txt').waitFor();
    assert.equal(saves(state,'save-file').length,2);
    // A drag without Files (selected text) is left to the browser.
    await panel.locator('.ai-terminal-surface').evaluate(element=>{const data=new DataTransfer();data.setData('text/plain','hi');const e=new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:data});element.dispatchEvent(e);element.dataset.prevented=String(e.defaultPrevented);});
    assert.equal(await panel.locator('.ai-terminal-surface').getAttribute('data-prevented'),'false');
  });
  await run('an older Mac without save-file says to update the app, and keeps the composer usable',async({page,panel})=>{
    const [file]=await Promise.all([page.waitForEvent('filechooser'),panel.getByTestId('workroom-attach-file').click()]);
    await file.setFiles({name:'a.pdf',mimeType:'application/pdf',buffer:PDF});
    await panel.getByRole('alert').getByText(LEGACY,{exact:false}).waitFor();
    assert.equal(await panel.getByTestId('workroom-file-chip').count(),0);
    assert.ok(await panel.getByLabel('워크룸 입력').isEnabled());
  },{legacy:true});
  await run('a phone gets no attachment buttons',async({panel})=>{
    assert.equal(await panel.getByTestId('workroom-images').count(),0);
    assert.equal(await panel.getByTestId('workroom-attach-photo').count(),0);
  },{remote:true});
  // Review 2026-10-16 (keyboard): the capture menu was role=menu without the menu's keys, and Esc on it also went to
  // the CLI as ESC when the composer had focus.
  await run('capture menu: focus moves into it, arrows move, Esc closes it to its button and never reaches the CLI',async({page,panel,state})=>{
    const trigger=panel.getByTestId('workroom-capture-menu');
    await trigger.focus();await page.keyboard.press('Enter');
    await until(()=>page.evaluate(()=>document.activeElement?.dataset?.testid==='workroom-capture-region'),'Opening moves focus to the first item');
    await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement?.dataset?.testid),'workroom-capture-window');
    await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement?.dataset?.testid),'workroom-capture-screen');
    await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement?.dataset?.testid),'workroom-capture-region','wraps');
    await page.keyboard.press('ArrowUp');assert.equal(await page.evaluate(()=>document.activeElement?.dataset?.testid),'workroom-capture-screen');
    await page.keyboard.press('Home');assert.equal(await page.evaluate(()=>document.activeElement?.dataset?.testid),'workroom-capture-region');
    await page.keyboard.press('Escape');
    await until(async()=>await panel.getByTestId('workroom-capture-region').count()===0,'Esc closes the menu');
    assert.equal(await page.evaluate(()=>document.activeElement?.dataset?.testid),'workroom-capture-menu','Focus returns to 화면 캡처');
    // Open with the mouse, then reach the composer: the menu closes when focus leaves it, and an Esc while it is
    // open is the menu's own.
    await trigger.click();await panel.getByTestId('workroom-capture-region').waitFor();
    await page.keyboard.press('Escape');await sleep(150);
    await panel.getByLabel('워크룸 입력').focus();
    await trigger.click();await panel.getByTestId('workroom-capture-region').waitFor();
    await panel.getByLabel('워크룸 입력').focus();
    await until(async()=>await panel.getByTestId('workroom-capture-region').count()===0,'Focus leaving the menu closes it');
    await sleep(150);
    assert.ok(!inputs(state).includes('\u001b'),`No ESC reached the CLI: ${JSON.stringify(inputs(state))}`);
  });
  await run('capture menu open: an Esc that the composer would receive closes the menu and sends no ESC to the CLI',async({page,panel,state})=>{
    await panel.getByTestId('workroom-capture-menu').click();await panel.getByTestId('workroom-capture-region').waitFor();
    // The composer's own Esc handler (Esc always goes to the AI) sits under the menu's; the menu takes it first.
    await panel.getByLabel('워크룸 입력').evaluate(element=>element.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true,cancelable:true})));
    await until(async()=>await panel.getByTestId('workroom-capture-region').count()===0,'Esc closes the menu');
    await sleep(200);
    assert.ok(!inputs(state).includes('\u001b'),`No ESC reached the CLI: ${JSON.stringify(inputs(state))}`);
  });
  // Review 2026-10-16: removing a chip by keyboard dropped focus to <body>; picking in the web build too.
  await run('removing a chip by keyboard keeps focus on the next chip, then the composer; a web pick focuses the composer',async({page,panel})=>{
    const [file]=await Promise.all([page.waitForEvent('filechooser'),panel.getByTestId('workroom-attach-file').click()]);
    await file.setFiles([{name:'a.pdf',mimeType:'application/pdf',buffer:PDF},{name:'b.pdf',mimeType:'application/pdf',buffer:PDF}]);
    await panel.getByTestId('workroom-file-chip').getByText('b.pdf').waitFor();
    await until(()=>page.evaluate(()=>document.activeElement?.getAttribute('aria-label')==='워크룸 입력'),'A pick ends in the composer');
    await panel.getByRole('button',{name:'a.pdf 빼기'}).focus();await page.keyboard.press('Enter');
    await until(()=>page.evaluate(()=>document.activeElement?.getAttribute('aria-label')==='b.pdf 빼기'),'Focus moves to the next chip');
    await page.keyboard.press('Enter');
    await until(()=>page.evaluate(()=>document.activeElement?.getAttribute('aria-label')==='워크룸 입력'),'The last chip leaves focus in the composer');
  });
  // Review 2026-10-16: Windows showed ⌘V and 「이 Mac」.
  await run('on Windows the copy says Ctrl+V and 이 PC, and the capture menu stays hidden',async({panel})=>{
    assert.equal(await panel.getByTestId('workroom-capture-menu').count(),0);
    const bar=await panel.getByTestId('workroom-images').innerText();
    assert.ok(bar.includes('Ctrl+V')&&!bar.includes('⌘'),bar);
    assert.ok(!(await panel.getByTestId('workroom-attach-photo').getAttribute('title')).includes('⌘'));
    assert.ok((await panel.getByTestId('workroom-attach-file').getAttribute('title')).includes('이 PC에 있는 파일'));
    const placeholder=await panel.getByLabel('워크룸 입력').getAttribute('placeholder');
    assert.ok(!placeholder.includes('⌘'),placeholder);
    const hints=(await panel.locator('.ai-terminal-hint').allInnerTexts()).join(' ');
    assert.ok(!hints.includes('이 Mac'),hints);
  },{windows:true});
  await run('on Windows an older app without save-file names 이 PC',async({page,panel})=>{
    const [file]=await Promise.all([page.waitForEvent('filechooser'),panel.getByTestId('workroom-attach-file').click()]);
    await file.setFiles({name:'a.pdf',mimeType:'application/pdf',buffer:PDF});
    await panel.getByRole('alert').getByText('이 PC의 앱이 아직 파일 첨부를 지원하지 않습니다',{exact:false}).waitFor();
  },{windows:true,legacy:true});
}finally{await browser.close();}
console.log(`${results.filter(result=>result.status==='passed').length}/${results.length} attachment groups passed`);
if(results.some(result=>result.status==='failed'))process.exitCode=1;
