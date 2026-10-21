/** 「에포트 자동」 on the Workroom screens (w16 Build B): the Mac panel (main window and pop-out use the same panel), the phone's
 * 「새 작업」 sheet and full-screen session view, an older Mac, and a panel driving another community Mac.
 * Run: node tests/workroom-effort-auto.e2e.mjs (owns an isolated Vite server; no installed app or live API).
 * Every request is synthetic; no PTY, no sidecar, no other Mac.
 */
import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {mkdtemp,rm} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'vite';
const root=resolve(import.meta.dirname,'..'),scratch=await mkdtemp(join(tmpdir(),'agentstoz-effort-screen-'));
for(const key of Object.keys(process.env))if(key.startsWith('VITE_'))delete process.env[key];
process.env.VITE_SUPABASE_URL='https://workspace-fixture.supabase.co';process.env.VITE_SUPABASE_ANON_KEY='fixture-anon-key';
let vite;
try {
  vite=await createServer({configFile:join(root,'vite.config.ts'),root,envDir:scratch,cacheDir:join(scratch,'node_modules/.vite'),mode:'maintainer-test',logLevel:'warn',
    plugins:[{name:'deny-live-api',configureServer(server){server.middlewares.use((request,response,next)=>{if(!request.url?.startsWith('/api/'))return next();response.statusCode=503;response.end('Unmocked fixture API rejected');});}}],
    server:{host:'127.0.0.1',port:0,strictPort:false,fs:{allow:[root,realpathSync(join(root,'node_modules')),scratch]},watch:{ignored:['**/.agentstoz/**']}}});
  await vite.listen();
  const address=vite.httpServer.address();assert.ok(address&&typeof address!=='string'&&address.port!==3001);
  const origin=`http://127.0.0.1:${address.port}`;
// Optional: a folder for screenshots of each state (EFFORT_E2E_SHOTS=<dir>).
const shots=process.env.EFFORT_E2E_SHOTS||'';
const shot=async(p,name)=>{if(shots)await p.screenshot({path:`${shots}/${p.context().browser().browserType().name()}-${name}.png`,fullPage:false});};
assert.equal(new URL(origin).hostname,'127.0.0.1');
const source=await fetch(`${origin}/src/AiTerminalPanel.tsx`).then(r=>{assert.equal(r.status,200,'Start isolated Vite first');return r.text();});
assert.ok(source.includes('useWorkroomEffort'),'Vite serves an older AiTerminalPanel — restart it (linked worktrees are not watched)');
const main=await fetch(`${origin}/src/main.tsx`).then(r=>r.text());
const react=source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1];
const reactDom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
assert.ok(react&&reactDom,'Use the actual Vite dependency versions');
const TARGET='project-effort-aaaa';
const PROJECTS=[{targetId:TARGET,label:'블로그 앱'}];
const SESSION={id:'session-effort-0001',targetId:TARGET,agent:'claude',state:'running',createdAt:'2026-10-16T05:00:00Z',exitCode:null,cols:100,rows:28};
const RECORD={agent:'claude',tier:'medium',reason:'standard',level:'medium',origin:'launch',manual:false,advice:{tier:'high',reason:'design-review'}};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,message,timeout=8000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await sleep(40);}assert.fail(message);}

const page=(mode)=>`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};
import '/src/index.css';import '/src/workspaceDesign.css';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
document.documentElement.dataset.appTheme='gray';
const {AiTerminalPanel}=await import('/src/AiTerminalPanel.tsx');
const {WORKROOM_EFFORT_ELSEWHERE}=await import('/src/workroomEffortView.ts');
const {useWorkroomEffort}=await import('/src/WorkroomEffortControls.tsx');
const mode=${JSON.stringify(mode)};
window.__effort=[];window.__auto=true;window.__effortMode="auto";
const session=${JSON.stringify(SESSION)};
const transport=async request=>{
  if(request.operation==='list')return {sessions:[session],...(request.capabilities?{features:[]}:{})};
  if(request.operation==='read')return {session,chunks:[],nextCursor:Math.max(1,request.after??0),truncated:false,hasMore:false};
  if(request.operation==='accounts')throw new Error('fixture: no accounts');
  return {session};
};
const workspaceTransport=async request=>{
  const w=request.workspace;
  if(w.action==='workroom.status')return {kind:'workspace',action:'workroom.status',workroom:{sessionId:w.sessionId,initialized:true,lastSavedAt:null,context:{usedPercent:null,observedAt:null,source:'unavailable'},save:{requestId:null,state:'idle',localSaved:false,backupSaved:false,message:''}}};
  if(w.action==='workroom.effort'){
    window.__effort.push({targetId:request.targetId,...w});
    if(mode==='old')throw new Error('모바일 작업 요청 형식이 올바르지 않습니다.');
    if(w.set!==undefined){window.__auto=w.set;window.__effortMode=w.set?"auto":"off";}
    if(w.mode!==undefined){window.__effortMode=w.mode;window.__auto=w.mode==="auto";}
    return {kind:'workspace',action:'workroom.effort',effort:{auto:window.__auto,...(w.effortModes?{mode:window.__effortMode}:{}),...(w.sessionId?{session:{...${JSON.stringify(RECORD)},...(w.effortModes?{mode:window.__effortMode}:{})}}:{})}};
  }
  throw new Error('fixture: unexpected workspace '+w.action);
};
const remote=mode==='phone'||mode==='community';
const props={projects:${JSON.stringify(PROJECTS)},transport,workspaceTransport,sessionScope:'effort-'+mode,deviceName:'MacBook Pro',
  entry:{nonce:1,targetId:${JSON.stringify(TARGET)},sessionId:session.id},remote,
  ...(mode==='phone'?{sessionFullscreen:true,onScreen:true}:{}),
  ...(mode==='community'?{effortReadOnly:WORKROOM_EFFORT_ELSEWHERE,bypassUnavailable:'다른 Mac'}:{})};
const root=ReactDOM.createRoot(document.getElementById('root'));
if(mode==='launch-tools'){
  const {LaunchEffortControls}=await import('/src/LaunchEffortControls.tsx');
  const {WorkspaceTools}=await import('/src/components/WorkspaceTools.tsx');
  window.__launchCalls=[];window.__launchFail=false;window.__desktopMode='recommend';window.__desktopFail=false;
  const request=async next=>{window.__launchCalls.push(next??null);if(window.__launchFail)throw Error('저장 실패');if(next)window.__effortMode=next;return window.__effortMode;};
  const requestDesktop=async next=>{if(window.__desktopFail)throw Error('앱 추천 저장 실패');if(next)window.__desktopMode=next;return window.__desktopMode;};
  const render=()=>root.render(React.createElement(React.StrictMode,null,React.createElement('div',{className:'workspace-shell','data-mobile':String(innerWidth<600),style:{height:880}},React.createElement('header',{'data-testid':'project-main-header',style:{position:'relative',width:'100%',alignSelf:'flex-start',whiteSpace:'nowrap'}},React.createElement('div',{'data-testid':'project-main-actions'},React.createElement(WorkspaceTools,{label:'실행 도구'},React.createElement('div',{className:'workspace-launch-group','data-testid':'launch-options-group'},React.createElement(LaunchEffortControls,{request,requestDesktop}))))))));
  window.__remountLaunch=()=>{root.render(null);setTimeout(render,50);};render();
}else if(mode==='reader-switch'){
  window.__oldReplies=[];
  const oldTransport=async()=>new Promise(resolve=>window.__oldReplies.push(()=>resolve({kind:'workspace',action:'workroom.effort',effort:{auto:true}})));
  const newTransport=async()=>({kind:'workspace',action:'workroom.effort',effort:{auto:false}});
  function Harness(){
    const [current,setCurrent]=React.useState(false);window.__switchMac=()=>setCurrent(true);
    const {state}=useWorkroomEffort({transport:current?newTransport:oldTransport,targetId:'project-effort-aaaa',visible:true,readOnly:false});
    return React.createElement('output',{'data-testid':'effort-reader'},JSON.stringify(state));
  }
  root.render(React.createElement(React.StrictMode,null,React.createElement(Harness)));
}else root.render(React.createElement(AiTerminalPanel,props));
</script>`;

for(const [engineName,engine] of Object.entries({chromium,webkit})){
const browser=await engine.launch({headless:true});
const results=[];
async function run(name,mode,viewport,body){
  const context=await browser.newContext({viewport,serviceWorkers:'block',...(mode==='phone'?{hasTouch:true,isMobile:true}:{})});
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==origin)return route.abort('blockedbyclient');
    if(url.pathname==='/__effort')return route.fulfill({contentType:'text/html',body:page(mode)});
    if(url.pathname.startsWith('/api/'))return route.fulfill({status:404,json:{error:'fixture: not here'}});
    return route.continue();
  });
  const p=await context.newPage();
  const errors=[];p.on('pageerror',error=>errors.push(String(error)));
  try{
    await p.goto(`${origin}/__effort`);
    await p.waitForSelector(mode==='launch-tools'?'.workspace-tools':mode==='reader-switch'?'[data-testid="effort-reader"]':'[data-testid="ai-terminal-panel"]');
    await body(p);
    assert.deepEqual(errors,[]);
    results.push(`${name}: ok`);
  }finally{await context.close();}
}
const effortCalls=p=>p.evaluate(()=>window.__effort);
const reads=async p=>(await effortCalls(p)).filter(c=>c.set===undefined&&c.mode===undefined).length;

try{
  await run('mac-option-default-on-badge-advice-and-one-change','mac',{width:1000,height:900},async p=>{
    const badge=p.getByTestId('workroom-effort-badge');
    await badge.waitFor();
    assert.equal(await badge.innerText(),'에포트 자동 · 보통');
    assert.equal(await badge.getAttribute('data-help-key'),'workroom-effort-badge');
    assert.equal(await p.getByTestId('workroom-effort-advice').innerText(),'이번 요청은 높음이 맞아 보입니다 (설계·리뷰) · 지금 보통 · 바꾸려면 「에포트 변경」');
    // A read names the project, and — once the session is listed and selected — that session.
    assert.ok((await effortCalls(p)).some(c=>c.targetId==='project-effort-aaaa'&&c.sessionId==='session-effort-0001'&&c.set===undefined));
    assert.ok((await reads(p))<=3,'A handful of reads on load, not a stream');
    const options=p.getByTestId('workroom-launch-options');
    await until(async()=>(await options.getAttribute('data-effort-auto'))==='on','The options button says auto is on once the Mac answered');
    assert.match(await options.innerText(),/승인 없이 실행/);
    await p.getByTestId('workroom-settings').locator('summary').click();
    const box=p.getByTestId('workroom-effort-mode');
    await box.waitFor();assert.equal(await box.inputValue(),'auto');
    assert.deepEqual(await box.locator('option').allTextContents(),['자동선택 (기본)','추천제공','미선택']);
    await shot(p,'mac-settings-and-footer');
    for(const value of ['off','recommend','auto']){
      await box.selectOption(value);await until(async()=>(await box.inputValue())===value&&await box.isEnabled(),'The shared mode is saved');
    }
    const sets=(await effortCalls(p)).filter(c=>c.mode!==undefined);
    assert.deepEqual(sets,['off','recommend','auto'].map(mode=>({effortModes:true,targetId:'project-effort-aaaa',action:'workroom.effort',sessionId:'session-effort-0001',mode})),'Exactly one request per mode');
    await p.keyboard.press('Escape');assert.equal(await p.getByTestId('workroom-settings').getAttribute('open'),null);
    // No timer: an idle panel asks nothing more; a window coming back asks once.
    const before=await reads(p);
    await sleep(2500);
    assert.equal(await reads(p),before,'No polling while idle');
    await p.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await until(async()=>(await reads(p))===before+1,'A window coming back asks once');
  });

  await run('older-mac-hides-option-and-receipt-and-never-asks-again','old',{width:1000,height:900},async p=>{
    await until(async()=>(await reads(p))>=1,'The panel asked once');
    await sleep(400);
    assert.equal(await p.getByTestId('workroom-effort-badge').count(),0);
    assert.equal(await p.getByTestId('workroom-effort-advice').count(),0);
    const options=p.getByTestId('workroom-launch-options');
    assert.equal(await options.getAttribute('data-effort-auto'),null);
    assert.doesNotMatch(await options.innerText(),/에포트/);
    await options.click();
    await sleep(300);
    assert.equal(await p.getByTestId('workroom-effort-mode').count(),0);
    const after=await reads(p);
    for(let i=0;i<4;i++){await p.evaluate(()=>window.dispatchEvent(new Event('focus')));await sleep(100);}
    assert.equal(await reads(p),after,'An older Mac is not asked again');
    assert.equal(await reads(p),1);
  });

  for(const width of [320,390]){
    await run(`phone-${width}-session-view-receipt-and-sheet-option`,'phone',{width,height:844},async p=>{
      // The entry names the session, so the phone opens it over the whole screen: the receipt is in its footer.
      const view=p.getByTestId('workroom-session-view');
      await view.waitFor();
      const badge=view.getByTestId('workroom-effort-badge');
      await badge.waitFor({state:'attached'});
      assert.equal(await badge.innerText(),'에포트 자동 · 보통');
      assert.match(await view.getByTestId('workroom-effort-advice').innerText(),/이번 요청은 높음이 맞아 보입니다/);
      assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
      await badge.scrollIntoViewIfNeeded();await shot(p,`phone-${width}-session-view`);
      await p.getByTestId('workroom-session-view-back').click();
      await view.waitFor({state:'detached'});
      // The 「새 작업」 sheet carries the option beside bypass.
      await p.getByTestId('workroom-new-task').click();
      const sheet=p.getByTestId('workroom-new-task-sheet');
      await sheet.waitFor();
      await sheet.getByTestId('workroom-settings').locator('summary').click();
      const box=sheet.getByTestId('workroom-effort-mode');
      await box.waitFor();assert.equal(await box.inputValue(),'auto');
      const geometry=await box.evaluate(node=>{const r=node.getBoundingClientRect();return {height:r.height,fits:r.left>=0&&r.right<=innerWidth+1,overflow:document.documentElement.scrollWidth>innerWidth+1};});
      assert.ok(geometry.height>=44&&geometry.fits&&!geometry.overflow,JSON.stringify(geometry));
      assert.match(await sheet.innerText(),/MacBook Pro의 프로젝트 워크룸과 연동된 외부 CLI에 공통으로 적용됩니다/);
      await shot(p,`phone-${width}-shared-workroom-settings`);
      await box.selectOption('recommend');await until(async()=>(await box.inputValue())==='recommend'&&await box.isEnabled(),'Phone saved recommendations');
      assert.equal((await effortCalls(p)).filter(c=>c.mode==='recommend').length,1);

    });
  }

  await run('community-device-panel-reads-but-never-changes','community',{width:1000,height:900},async p=>{
    const options=p.getByTestId('workroom-launch-options');
    await until(async()=>(await options.getAttribute('data-effort-auto'))==='on','The other Mac answered');
    await p.getByTestId('workroom-settings').locator('summary').click();
    const line=p.getByTestId('workroom-effort-auto-readonly');
    await line.waitFor();
    assert.match(await line.innerText(),/에포트 자동선택 — 다른 Mac의 설정입니다/);
    assert.equal(await p.getByTestId('workroom-effort-mode').count(),0);
    assert.deepEqual((await effortCalls(p)).filter(c=>c.set!==undefined||c.mode!==undefined),[]);
  });
  await run('strict-mode-and-a-late-old-mac-response','reader-switch',{width:1000,height:900},async p=>{
    await until(()=>p.evaluate(()=>window.__oldReplies.length===2),'StrictMode starts a fresh reader after cleanup');
    await p.evaluate(()=>window.__switchMac());
    const value=()=>p.getByTestId('effort-reader').innerText().then(JSON.parse);
    await until(async()=>(await value()).auto===false,'The new Mac answers off');
    await p.evaluate(()=>window.__oldReplies.forEach(reply=>reply()));
    await sleep(100);
    assert.equal((await value()).auto,false,'Late responses from both retired readers cannot overwrite the new Mac');
  });
  for(const width of [390,1000])await run('launch-tools-'+width,'launch-tools',{width,height:900},async p=>{
    await p.locator('summary').click();
    const toggle=p.getByTestId('launch-effort-toggle');
    await until(async()=>await toggle.getAttribute('aria-checked')==='true','Auto is the host default');
    const desktop=p.getByTestId('desktop-effort-controls');
    assert.equal(await desktop.getByRole('radio').count(),2,'Desktop apps have exactly two choices');
    await until(async()=>await p.getByTestId('desktop-effort-recommend').getAttribute('aria-checked')==='true','Desktop defaults to recommendations');
    await p.getByTestId('desktop-effort-off').click();
    await until(async()=>await p.getByTestId('desktop-effort-off').getAttribute('aria-checked')==='true','Desktop off is confirmed');
    assert.equal(await toggle.getAttribute('aria-checked'),'true','Desktop off never turns CLI auto off');
    await p.evaluate(()=>{window.__desktopFail=true;});
    await p.getByTestId('desktop-effort-recommend').click();
    await desktop.getByRole('alert').waitFor();
    assert.equal(await p.getByTestId('desktop-effort-off').getAttribute('aria-checked'),'true','Rejected desktop writes preserve confirmed choice');
    await p.evaluate(()=>{window.__desktopFail=false;});
    await p.getByTestId('desktop-effort-recommend').click();
    await until(async()=>await p.getByTestId('desktop-effort-recommend').getAttribute('aria-checked')==='true','Desktop advice restores independently');
    await toggle.click();
    await until(async()=>await toggle.getAttribute('aria-checked')==='false','Off is confirmed by the host');
    assert.equal(await p.evaluate(()=>window.__effortMode),'off');
    await p.evaluate(()=>window.__remountLaunch());
    await p.locator('summary').click();
    await until(async()=>await toggle.innerText()==='자동 OFF','Off survives reopening');
    await p.evaluate(()=>{window.__launchFail=true;});
    await toggle.click();
    await p.getByRole('alert').waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'),'false','A rejected write never shows ON');
    await p.evaluate(()=>{window.__launchFail=false;});
    await toggle.click();
    await until(async()=>await toggle.getAttribute('aria-checked')==='true','Auto can be enabled again');
    await p.getByRole('button',{name:'추천만 받기',exact:true}).click();
    await until(async()=>await toggle.innerText()==='자동 OFF · 추천만','Advice is distinct from auto');
    const box=await toggle.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width);
    const overflow=await p.getByTestId('launch-effort-controls').evaluate(node=>[...node.querySelectorAll('p')].map(p=>({content:p.scrollWidth,available:p.clientWidth})));
    assert.ok(overflow.every(p=>p.content<=p.available+1),'Effort help wraps inside the real toolbar even when its header inherits nowrap');
    await shot(p,'launch-tools-'+width);
  });
  console.log(`${engineName} workroom effort auto e2e passed: ${results.join(' · ')}`);
}finally{await browser.close();}
}

} finally { await vite?.close(); await rm(scratch,{recursive:true,force:true}); }
