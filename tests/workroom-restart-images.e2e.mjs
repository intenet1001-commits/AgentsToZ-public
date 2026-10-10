/** Workroom 「다시 시작」 and image attachments (VOC 2026-10-02) in the real React+xterm panel.
 * Start an isolated Vite first, then: node tests/workroom-restart-images.e2e.mjs http://127.0.0.1:<port>
 * Every API is mocked; no PTY, project, screen capture or saved file is touched.
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
const projects=[{targetId:A,projectTargetId:A,label:'금소메뉴개편',scope:'main',branch:'main',locked:false,worktreeCapable:false}];
const session=(id,state='running',agent='codex')=>({id,targetId:A,agent,state,createdAt:'2026-10-02T00:46:40Z',exitCode:state==='running'?null:0,cols:100,rows:28});
const IMAGE_PATH='/Users/fixture/Library/Application Support/com.portmanager.portmanager/workroom-images/2026-10-02/153012-aaaaaaaa.png';
const THUMB='data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,message,timeout=6000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await sleep(15);}assert.fail(message);}
const html=options=>`<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};
import '/src/index.css';import '/src/workspaceDesign.css';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
document.documentElement.dataset.appTheme='gray';
const {AiTerminalPanel}=await import('/src/AiTerminalPanel.tsx');
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement('main',{style:{padding:'16px'}},React.createElement(AiTerminalPanel,{projects:${JSON.stringify(projects)},visible:true,remote:${!!options.remote},entry:{nonce:1,targetId:${JSON.stringify(A)},sessionId:${JSON.stringify(SA)}},workspaceTransport:request=>fetch('/api/agent-runtime/terminals',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)}).then(r=>r.json())})));
</script>`;
const browser=await chromium.launch({headless:true}),results=[];
async function fixture(options={}){
  const context=await browser.newContext({viewport:{width:1100,height:1000},serviceWorkers:'block'});
  const state={sessions:[session(SA,options.ended?'exited':'running',options.agent??'codex')],requests:[],errors:[],blocked:[],dialogs:[]};
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==origin){state.blocked.push(url.origin+url.pathname);return route.abort('blockedbyclient');}
    if(url.pathname==='/__workroom-restart')return route.fulfill({contentType:'text/html',body:html(options)});
    if(!url.pathname.startsWith('/api/'))return route.continue();
    const body=request.postDataJSON?.()??null;state.requests.push({path:url.pathname,...(body??{})});
    const respond=(json,status=200)=>route.fulfill({json,status}).catch(()=>{});
    if(url.pathname==='/api/agent-runtime/targets')return respond({protocolVersion:'agentstoz-tasks-v2',targets:projects,complete:true});
    if(url.pathname==='/api/ai-usage/codex')return respond({rateLimits:null});
    if(url.pathname==='/api/agent-runtime/terminals/access')return respond({connections:[]});
    if(url.pathname==='/api/agent-runtime/terminals/memory')return respond({jobs:[]});
    if(url.pathname==='/api/agent-runtime/terminals/images'){
      if(body.operation==='capture')return respond(options.captureCancelled?{cancelled:true}:{path:IMAGE_PATH.replace('aaaaaaaa','cccccccc'),name:'153012-cccccccc.png',bytes:4096,thumbnail:THUMB});
      assert.equal(body.operation,'save');assert.ok(body.data.length>8,'The pasted bytes travel as base64');
      return respond({path:IMAGE_PATH,name:'153012-aaaaaaaa.png',bytes:2048,thumbnail:THUMB});
    }
    if(url.pathname==='/api/agent-runtime/terminals'){
      if(body.operation==='workspace')return respond({kind:'workspace',action:'workroom.status',workroom:{sessionId:body.workspace.sessionId,initialized:true,lastSavedAt:null,context:{usedPercent:null,observedAt:null,source:'unavailable'},save:{requestId:null,state:'idle',localSaved:false,backupSaved:false,message:''}}});
      if(body.operation==='list')return respond({sessions:state.sessions});
      if(body.operation==='start'){
        if(body.resumeFrom&&options.legacy)return respond({error:'허용되지 않은 터미널 요청입니다.'},400);
        const created=session(`fixture-restarted-${state.sessions.length}`,'running',body.agent);
        if(body.resumeFrom){const old=state.sessions.find(s=>s.id===body.resumeFrom);old.state='exited';old.exitCode=143;}
        state.sessions.push(created);
        return respond({session:created,...(body.resumeFrom?{resumed:!options.fresh}:{})});
      }
      const selected=state.sessions.find(current=>current.id===body.sessionId);assert.ok(selected,'Unknown fixture terminal');
      if(body.operation==='read')return respond({session:selected,chunks:body.after<1?[{seq:1,text:`${selected.id} 화면\r\n`}]:[],nextCursor:Math.max(1,body.after),truncated:false,hasMore:false});
      if(body.operation==='close'){selected.state='exited';selected.exitCode=143;return respond({session:selected});}
      if(['input','resize'].includes(body.operation))return respond({session:selected});
    }
    state.blocked.push(`${request.method()} ${url.pathname}`);return respond({error:'Unmocked API is forbidden'},503);
  });
  const page=await context.newPage();page.on('pageerror',error=>state.errors.push(error.message));
  page.on('dialog',dialog=>{state.dialogs.push(dialog.message());void dialog.accept();});
  await page.goto(`${origin}/__workroom-restart`);const panel=page.getByTestId('ai-terminal-panel');await panel.waitFor({timeout:10000});
  await until(()=>state.requests.some(r=>r.operation==='read'),'The fixture session must be read');
  return{context,page,panel,state};
}
async function run(name,body,options){
  const f=await fixture(options);
  try{await body(f);assert.deepEqual(f.state.errors,[],'No page errors');assert.deepEqual(f.state.blocked,[],'No unmocked request');results.push({name,status:'passed'});console.log('✓',name);}
  catch(error){results.push({name,status:'failed',error:String(error?.stack??error)});console.error('✗',name,error);}
  finally{await f.context.close();}
}
const starts=state=>state.requests.filter(r=>r.path==='/api/agent-runtime/terminals'&&r.operation==='start');
const inputs=state=>state.requests.filter(r=>r.operation==='input').map(r=>r.data).join('');

try{
  await run('running session: one confirmed request, the new session replaces the old, the notice says it continued',async({panel,state})=>{
    await panel.getByTestId('workroom-restart').click();
    await until(()=>starts(state).length===1,'Restart sends one start');
    const start=starts(state)[0];
    assert.equal(start.resumeFrom,SA);assert.equal(start.agent,'codex');assert.equal(start.targetId,A);
    assert.equal('bypassPermissions' in start,false,'The Mac keeps the old permission mode');
    assert.ok(start.cols>=20&&start.rows>=5&&!(start.cols===100&&start.rows===28),`Starts at the fitted size, not 100x28 (${start.cols}x${start.rows})`);
    assert.equal(state.dialogs.length,1);assert.match(state.dialogs[0],/이전 대화를 이어서/);
    await panel.getByTestId('workroom-restart-notice').getByText('이전 대화를 이어서 다시 시작했습니다.').waitFor();
    if(process.env.WORKROOM_SHOT)await panel.page().screenshot({path:process.env.WORKROOM_SHOT.replace('.png','-restart.png')});
    await panel.getByRole('tab',{selected:true}).getByText('실행 중').waitFor();
    assert.equal(state.requests.filter(r=>r.operation==='close').length,0,'The Mac ends the old CLI itself');
    // The replaced session does not linger in the ended list.
    assert.equal(await panel.getByRole('button',{name:/종료된 세션 보기/}).count(),0);
  });
  await run('an ended session restarts without a confirmation; nothing saved means a fresh conversation',async({panel,state})=>{
    await panel.getByTestId('workroom-exited-hint').getByText(/「다시 시작」/).waitFor();
    await panel.getByTestId('workroom-restart').click();
    await until(()=>starts(state).length===1,'Restart sends one start');
    assert.equal(state.dialogs.length,0);
    await panel.getByTestId('workroom-restart-notice').getByText(/\/resume/).waitFor();
  },{ended:true,fresh:true});
  await run('an older Mac server: close, then a plain start in this window\'s mode, and the notice says so',async({panel,state})=>{
    await panel.getByTestId('workroom-restart').click();
    await until(()=>starts(state).length===2,'Falls back to a plain start');
    const [first,second]=starts(state);
    assert.equal(first.resumeFrom,SA);assert.equal(second.resumeFrom,undefined);assert.equal(typeof second.bypassPermissions,'boolean');
    assert.equal(state.requests.filter(r=>r.operation==='close'&&r.sessionId===SA).length,1);
    await panel.getByTestId('workroom-restart-notice').getByText(/이전 버전/).waitFor();
  },{legacy:true});
  await run('a pasted image becomes a chip and its path travels with the request',async({page,panel,state})=>{
    const composer=panel.getByLabel('워크룸 입력');await composer.click();await composer.fill('이 화면 버그 고쳐줘');
    await composer.evaluate(element=>{
      const bytes=new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,13]);
      const data=new DataTransfer();data.items.add(new File([bytes],'shot.png',{type:'image/png'}));
      element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
    });
    await panel.getByTestId('workroom-image-chip').getByText('153012-aaaaaaaa.png').waitFor();
    if(process.env.WORKROOM_SHOT)await page.screenshot({path:process.env.WORKROOM_SHOT,fullPage:true});
    assert.equal(await composer.inputValue(),'이 화면 버그 고쳐줘','The paste does not put text into the box');
    // A rich copy (text + image): the text pastes as usual and the image is attached too.
    await composer.evaluate(element=>{
      const data=new DataTransfer();data.setData('text/plain',' 그리고 이것도');
      data.items.add(new File([new Uint8Array([0xff,0xd8,0xff,0xe0,0,16,0x4a,0x46,0x49,0x46,0,1])],'copy.jpg',{type:'image/jpeg'}));
      const event=new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true});element.dispatchEvent(event);
      element.dataset.pasteDefaultPrevented=String(event.defaultPrevented);
    });
    assert.equal(await composer.getAttribute('data-paste-default-prevented'),'false');
    await until(()=>state.requests.filter(r=>r.operation==='save').length===2,'The second image is saved too');
    await panel.getByRole('button',{name:'현재 세션에 전송'}).click();
    await until(()=>inputs(state).includes(IMAGE_PATH),'The image path reaches the CLI');
    assert.match(inputs(state),/이 화면 버그 고쳐줘\n\n\[첨부 이미지 1개 — 각 파일을 열어 확인하세요\]\n/);
    await until(async()=>await panel.getByTestId('workroom-image-chip').count()===0,'Sent images leave the composer');
    void page;
  });
  await run('capture buttons and ⌥⌘4: a cancelled capture adds nothing and says nothing',async({page,panel,state})=>{
    await panel.getByTestId('workroom-capture-window').click();
    await until(()=>state.requests.some(r=>r.operation==='capture'&&r.mode==='window'),'Window capture requested');
    await panel.getByLabel('워크룸 입력').click();await page.keyboard.press('Meta+Alt+Digit4');
    await until(()=>state.requests.some(r=>r.operation==='capture'&&r.mode==='region'),'⌥⌘4 requests a region capture');
    await sleep(200);
    assert.equal(await panel.getByTestId('workroom-image-chip').count(),0);
    assert.equal(await panel.getByRole('alert').count(),0,'A cancel is not an error');
  },{captureCancelled:true});
  await run('a capture can be sent alone and removed before sending',async({panel,state})=>{
    await panel.getByTestId('workroom-capture-screen').click();
    const chip=panel.getByTestId('workroom-image-chip');await chip.waitFor();
    assert.equal(await chip.locator('img').count(),1,'The chip shows the thumbnail');
    await chip.getByRole('button',{name:/빼기/}).click();await until(async()=>await chip.count()===0,'× removes the image');
    await panel.getByTestId('workroom-capture-region').click();await chip.waitFor();
    await panel.getByRole('button',{name:'현재 세션에 전송'}).click();
    await until(()=>inputs(state).startsWith('[첨부 이미지 1개'),'An image alone is a request');
  });
  await run('keys typed in an empty input box reach the CLI; with text they edit the box',async({page,panel,state})=>{
    const composer=panel.getByLabel('워크룸 입력');await composer.click();
    const before=state.requests.filter(r=>r.operation==='input').length;
    for(const key of ['ArrowDown','ArrowUp','Tab','Shift+Tab','Enter','Backspace'])await page.keyboard.press(key);
    await until(()=>state.requests.filter(r=>r.operation==='input').length>=before+6,'Each key is one input');
    assert.deepEqual(state.requests.filter(r=>r.operation==='input').slice(before).map(r=>r.data),['\x1b[B','\x1b[A','\t','\x1b[Z','\r','\x7f']);
    assert.equal(await composer.evaluate(element=>document.activeElement===element),true,'Tab stays in the box');
    await composer.fill('메뉴 고르기');const typed=state.requests.filter(r=>r.operation==='input').length;
    await page.keyboard.press('ArrowLeft');await page.keyboard.press('Home');await sleep(150);
    assert.equal(state.requests.filter(r=>r.operation==='input').length,typed,'With text, arrows move the box cursor');
    assert.equal(await composer.evaluate(element=>element.selectionStart),0);
    await page.keyboard.press('Escape');await page.keyboard.press('Control+c');
    await until(()=>state.requests.filter(r=>r.operation==='input').length===typed+2,'Esc and Ctrl+C always go');
    assert.deepEqual(state.requests.filter(r=>r.operation==='input').slice(typed).map(r=>r.data),['\x1b','\x03']);
    assert.equal(await composer.inputValue(),'메뉴 고르기','The text stays');
    await page.keyboard.press('End');await page.keyboard.type(' @금');await sleep(100);
    await panel.getByRole('listbox',{name:/호출할 프로젝트/}).waitFor();
    const listed=state.requests.filter(r=>r.operation==='input').length;await page.keyboard.press('Escape');await sleep(150);
    assert.equal(state.requests.filter(r=>r.operation==='input').length,listed,'Esc over an open suggestion list does not interrupt the AI');
  });
  await run('a phone gets neither restart nor image buttons',async({panel})=>{
    assert.equal(await panel.getByTestId('workroom-restart').count(),0);
    assert.equal(await panel.getByTestId('workroom-images').count(),0);
  },{remote:true});
}finally{await browser.close();}
console.log(`${results.filter(result=>result.status==='passed').length}/${results.length} restart/image groups passed`);
if(results.some(result=>result.status==='failed'))process.exitCode=1;
