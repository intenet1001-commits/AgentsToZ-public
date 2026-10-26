// Real React/USE host/storage; synthetic application adapter. No live app, model, phone or service.
import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {createServer} from 'vite';
import {mkdtempSync,mkdirSync,realpathSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {ServiceUseHost} from '../src/serviceUseHost.ts';
import {ensureServiceMemory,migrateServiceMemoryToProject} from '../src/serviceMemory.ts';
import {WorkroomThreadStore} from '../src/workroomThreadStore.ts';
import {WorkroomThreadService} from '../src/workroomThreadService.ts';
import {normalizeMobileWorkspaceRequest} from '../src/mobileWorkspaceProtocol.ts';
const root=resolve(import.meta.dirname,'..'),scratch=realpathSync(mkdtempSync(join(tmpdir(),'use-screen-')));
for(const key of Object.keys(process.env))if(key.startsWith('VITE_'))delete process.env[key];
process.env.VITE_SUPABASE_URL='https://use-screen-fixture.supabase.co';process.env.VITE_SUPABASE_ANON_KEY='fixture-anon-key';
const projects=new Map(),appCalls=[],requests=[];let devStarts=0,vite,threads,failStatusAfterOff=false;
const keys={read:async()=>Buffer.alloc(32,3),create:async()=>Buffer.alloc(32,3)};
const adapters=[];
for(const engine of ['webkit','chromium']){
 const id='service-use-'+engine,canonicalPath=join(scratch,id);mkdirSync(canonicalPath);
 projects.set(id,{projectId:id,projectName:'ShadowLoop',memoryId:'memory-'+engine,canonicalPath});
 adapters.push({projectId:id,serviceKey:'default',definitionRevision:'synthetic-v1',tools:['materials.generate','materials.reuse','audio.prepare','operation.status','operation.cancel','phone.deliver'],
  scope:async()=>({principalId:'test-user',libraryId:'test-library',deviceId:'test-device',installationId:'test-install',grantRevision:'test-grant'}),
  execute:async(call,requestId,_binding,active)=>{assert.ok(active());appCalls.push({projectId:id,call,requestId});return {state:'completed',message:call.tool==='audio.prepare'?'테스트 음성 준비 확인':'테스트 자료 생성 확인',materialId:'fixture-material',evidence:{generated:true,phoneReceived:false}};}});
}
const host=new ServiceUseHost({appDataDir:scratch,resolve:async id=>{assert.ok(projects.has(id));return projects.get(id);},adapters,receipts:new WorkroomThreadStore(join(scratch,'receipts'),keys)});
try{
 threads=new WorkroomThreadService({store:new WorkroomThreadStore(join(scratch,'threads'),keys),use:host,resolve:async id=>({fingerprint:id}),inspect:()=>({state:'running',inputRevision:0}),start:async()=>{devStarts++;throw Error('unexpected DEV start');},reply:async()=>{throw Error('unexpected DEV input');}});
 vite=await createServer({configFile:join(root,'vite.config.ts'),root,envDir:scratch,cacheDir:join(scratch,'node_modules/.vite'),mode:'maintainer-test',logLevel:'error',plugins:[{name:'use-fixture',configureServer(server){server.middlewares.use(async(req,res,next)=>{
  if(req.url?.startsWith('/api/service-memory/')||req.url==='/__use-thread')try{
   let text='';for await(const chunk of req){text+=chunk;if(text.length>10000)throw Error('request too large');}const body=JSON.parse(text);requests.push({path:req.url,body});
   let result;
   if(req.url==='/__use-thread'){
    const r=normalizeMobileWorkspaceRequest(body);result={kind:'workspace',action:r.workspace.action,threads:await threads.perform(r.workspace.action,r.workspace.thread,r.targetId,r.requestId,{owner:'test-user',active:()=>true,readAll:false})};
   }else{
    const p=projects.get(body.portId);assert.ok(p);
    if(req.url.endsWith('/prepare-use-memory')){assert.equal(body.consent,true);ensureServiceMemory(scratch,{projectId:p.projectId,projectName:p.projectName,projectMemoryId:p.memoryId,canonicalPath:p.canonicalPath,displayName:'ShadowLoop USE'});migrateServiceMemoryToProject(scratch,{projectId:p.projectId,projectMemoryId:p.memoryId});}
    if(req.url.endsWith('/enable-use')){assert.equal(body.consent,true);await host.enable(p.projectId);}
    if(req.url.endsWith('/disable-use')){assert.equal(body.consent,true);await host.disable(p.projectId);}
    if(req.url.endsWith('/use-status')&&failStatusAfterOff&&(await host.status(p.projectId,'test-user')).turnedOff){failStatusAfterOff=false;throw Error('상태를 다시 읽지 못했습니다.');}
    if(req.url.endsWith('/connect-shadowloop')){assert.equal(body.consent,true);if(body.connectionCode!=='fixture-connection-code')throw Error('테스트 연결 코드를 확인하세요.');}
    result={success:true,...await host.status(p.projectId,'test-user')};
   }
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
  }catch(e){res.statusCode=400;res.end(JSON.stringify({success:false,error:e.message}));}
  else if(req.url?.startsWith('/api/')){res.statusCode=503;res.end('Live API blocked');}else next();
 });}}],server:{host:'127.0.0.1',port:0,strictPort:false,fs:{allow:[root,realpathSync(join(root,'node_modules')),scratch]}}});
 await vite.listen();const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
 console.log('USE screen fixture server ready');
 const src=await fetch(origin+'/src/ServiceUseSetupDialog.tsx').then(r=>r.text()),main=await fetch(origin+'/src/main.tsx').then(r=>r.text());
 const react=src.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1],dom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];assert.ok(react&&dom);console.log('USE screen fixture modules ready');
 for(const [engineName,engine] of Object.entries({webkit,chromium})){
  const browser=await engine.launch();try{
   const context=await browser.newContext({viewport:{width:402,height:874},hasTouch:true,isMobile:true,serviceWorkers:'block'});
   try{
    const id='service-use-'+engineName,html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">
    import R from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(dom)};R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;
    import '/src/index.css';const {default:Setup}=await import('/src/ServiceUseSetupDialog.tsx');const {CommunityWorkspace}=await import('/src/CommunityWorkspace.tsx');
    const transport=async r=>{const response=await fetch('/__use-thread',{method:'POST',body:JSON.stringify(r)}),body=await response.json();if(!response.ok)throw Error(body.error);if(window.dropNextCreate&&r.workspace.action==='workroom.threads.create'){window.dropNextCreate=false;throw Error('lost acknowledgement');}return body;};
    function App(){const [setup,setSetup]=React.useState(true);return setup?React.createElement(Setup,{projects:[{id:${JSON.stringify(id)},name:'ShadowLoop',folderPath:'fixture-only'}],onClose:()=>setSetup(false)}):React.createElement(CommunityWorkspace,{channels:[{id:'local',label:'테스트 Mac',projects:async()=>[{targetId:${JSON.stringify(id)},label:'ShadowLoop',useServices:['default']}],transport,usePhones:async()=>[{id:'approved-phone-13',name:'아이폰13'}]}],onOpenWorkroom:()=>{throw Error('unexpected developer workroom');}});}
    const uiRoot=ReactDOM.createRoot(document.getElementById('root'));uiRoot.render(React.createElement(App));
    window.openOpsUse=async(includeUse=true,sessionId='fixture-ops-session')=>{const {AiTerminalPanel}=await import('/src/AiTerminalPanel.tsx');window.terminalCalls=[];
      const session={id:sessionId,targetId:'fixture-ops-project',agent:'claude',state:'running',createdAt:'2026-10-23T00:00:00Z',exitCode:null,cols:80,rows:24};
      const terminalTransport=async request=>{window.terminalCalls.push(request);if(request.operation==='list')return {sessions:[session],features:['terminal-refs-v1']};if(request.operation==='read')return {session,chunks:[],nextCursor:request.after??0,truncated:false,hasMore:false};if(request.operation==='resize')return {session};if(request.operation==='accounts'&&request.accountAction==='list')return {accounts:{agent:request.agent,selectedAccountId:'host-default',items:[{id:'host-default',agent:request.agent,label:'현재 CLI 계정',authState:'unknown',checkedAt:null,loginState:'idle'}]}};throw Error('unexpected DEV mutation: '+request.operation);};
      uiRoot.render(React.createElement(AiTerminalPanel,{remote:true,entry:{nonce:sessionId==='fixture-ops-session'?1:2,targetId:session.targetId,sessionId:session.id,agent:session.agent},projects:[{targetId:session.targetId,label:'AgentsToZ OPS'},{targetId:${JSON.stringify(id)},label:'ShadowLoop',useServices:includeUse?['default']:[]}],transport:terminalTransport,workspaceTransport:transport,sessionScope:'ops-use-'+${JSON.stringify(engineName)}}));};</script>`;
    await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==origin)return route.abort();return u.pathname==='/__use'?route.fulfill({contentType:'text/html',body:html}):route.continue();});
    const page=await context.newPage(),errors=[];page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(45000);page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/__use');
    console.log(engineName+': opening USE setup');await page.getByTestId('service-use-readiness').waitFor();await page.getByRole('button',{name:'프로젝트 USE 운영기억 준비·활성화',exact:true}).click();
    await page.getByRole('button',{name:'USE 활성화됨',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'USE 활성화됨',exact:true}).isEnabled(),false);
    const mutations=requests.filter(r=>r.body.portId===id&&!r.path.endsWith('/use-status'));assert.deepEqual(mutations.map(r=>r.path.split('/').at(-1)),['prepare-use-memory','enable-use']);
    // 「USE 끄기」 asks first in plain words, keeps the memory, and 「USE 다시 켜기」 continues the same USE memory.
    const memoryId=(await host.status(id,'test-user')).serviceMemory.record.serviceMemoryId;
    await page.evaluate(()=>{window.useChanged=0;window.addEventListener('agentstoz:service-use-changed',()=>{window.useChanged++;});});
    await page.getByRole('button',{name:'USE 끄기',exact:true}).click();
    const confirmOff=page.getByRole('alertdialog',{name:'USE 끄기 확인',exact:true});await confirmOff.waitFor();
    await confirmOff.getByText('운영기억·앱 연결·이전 결과는 그대로 남고, 다시 켜면 그대로 이어집니다.',{exact:false}).waitFor();
    await page.keyboard.press('Escape');await confirmOff.waitFor({state:'detached'});
    await page.getByTestId('service-use-setup').waitFor({state:'visible'});
    assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'USE 끄기');
    assert.equal(requests.some(r=>r.body.portId===id&&r.path.endsWith('/disable-use')),false);
    await page.getByRole('button',{name:'USE 끄기',exact:true}).click();await confirmOff.getByRole('button',{name:'끄기',exact:true}).click();
    await page.getByTestId('service-use-readiness').getByText('꺼 둠 · 기억·연결 보존',{exact:true}).waitFor();
    await page.getByRole('button',{name:'USE 다시 켜기',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'USE 다시 켜기');
    assert.equal(await page.getByRole('button',{name:'USE 끄기',exact:true}).count(),0);
    assert.equal(await page.evaluate(()=>window.useChanged),1);
    const off=await host.status(id,'test-user');assert.equal(off.readiness.enabled,false);assert.equal(off.turnedOff,true);assert.equal(off.serviceMemory.record.serviceMemoryId,memoryId);
    await page.getByRole('button',{name:'USE 다시 켜기',exact:true}).click();await page.getByRole('button',{name:'USE 활성화됨',exact:true}).waitFor();
    assert.equal((await host.status(id,'test-user')).serviceMemory.record.serviceMemoryId,memoryId);assert.equal(await page.evaluate(()=>window.useChanged),2);
    assert.deepEqual(requests.filter(r=>r.body.portId===id&&!r.path.endsWith('/use-status')).map(r=>r.path.split('/').at(-1)),['prepare-use-memory','enable-use','disable-use','prepare-use-memory','enable-use']);
    // Off on the server but the refresh after it fails: the dialog stops asking to turn it off and says it is off.
    failStatusAfterOff=true;
    await page.getByRole('button',{name:'USE 끄기',exact:true}).click();await confirmOff.getByRole('button',{name:'끄기',exact:true}).click();
    await page.getByRole('alert').getByText('상태를 다시 읽지 못했습니다.',{exact:true}).waitFor();
    await confirmOff.waitFor({state:'detached'});await page.getByRole('button',{name:'USE 다시 켜기',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'USE 끄기',exact:true}).count(),0);assert.equal(failStatusAfterOff,false);
    await page.getByRole('button',{name:'USE 다시 켜기',exact:true}).click();await page.getByRole('button',{name:'USE 활성화됨',exact:true}).waitFor();
    await page.getByLabel('ShadowLoop 운영 연결 코드').fill('wrong-fixture-code');await page.getByRole('button',{name:'이 Mac에 운영 도구 연결',exact:true}).click();await page.getByRole('region',{name:'ShadowLoop 운영 도구 연결'}).getByRole('alert').getByText('테스트 연결 코드를 확인하세요.',{exact:true}).waitFor();
    await page.getByLabel('ShadowLoop 운영 연결 코드').fill('fixture-connection-code');await page.getByRole('button',{name:'이 Mac에 운영 도구 연결',exact:true}).click();await page.getByRole('button',{name:'USE 준비 닫기',exact:true}).waitFor({state:'visible'});
    await page.waitForFunction(()=>document.querySelector('input[aria-label="ShadowLoop 운영 연결 코드"]').value==='');
    assert.equal(await page.evaluate(()=>Object.values(localStorage).concat(Object.values(sessionStorage)).join('').includes('fixture-connection-code')),false);
    await page.getByRole('button',{name:'USE 준비 닫기',exact:true}).click();await page.getByLabel('프로젝트에 맡길 업무').waitFor();
    await page.getByLabel('프로젝트에 맡길 업무').fill('#Shadow');
    await page.getByRole('button',{name:'#ShadowLoop-USE',exact:true}).click();
    assert.equal(await page.getByLabel('업무 역할').inputValue(),'dev');assert.equal(await page.getByLabel('프로젝트에 맡길 업무').inputValue(),'#ShadowLoop-USE ');
    await page.getByLabel('프로젝트에 맡길 업무').fill('@Shadow');
    await page.getByRole('button',{name:'@ShadowLoop-USE',exact:true}).click();
    await page.getByLabel('USE 운영 도구').waitFor();assert.equal(await page.getByLabel('기준 프로젝트').inputValue(),'use:'+id+':default');
    await page.getByLabel('기준 프로젝트').selectOption(id);
    await page.getByLabel('프로젝트에 맡길 업무').fill('@ShadowLoop USE 짧은 인사 자료를 만들어줘');
    await page.getByLabel('USE 운영 도구').waitFor();assert.equal(await page.getByLabel('업무 역할').inputValue(),'use');assert.equal(await page.getByLabel('업무 AI').count(),0);
    await page.evaluate(()=>{window.dropNextCreate=true;});await page.getByRole('button',{name:'업무 맡기기',exact:true}).click();
    await page.getByRole('button',{name:'전송 결과 확인',exact:true}).click();await threads.idle();await page.getByRole('button',{name:'새로고침',exact:true}).click();await page.getByText('테스트 자료 생성 확인\n자료 ID: fixture-material',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'연결 워크룸 열기',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'세션 기억하기',exact:true}).count(),0);
    await page.getByLabel('USE 운영 도구').selectOption('audio.prepare');assert.equal(await page.getByLabel('USE 자료 ID').inputValue(),'fixture-material');assert.equal(await page.getByText('자료 ID와 요청 ID는 이 스레드의 앞선 결과에 표시됩니다.',{exact:false}).count(),1);await page.getByLabel('USE 메모 (선택)').fill('이 자료의 음성을 준비해줘');await page.getByRole('button',{name:'답변 보내기',exact:true}).click();
    await threads.idle();await page.getByRole('button',{name:'새로고침',exact:true}).click();await page.getByText('테스트 음성 준비 확인\n자료 ID: fixture-material',{exact:true}).waitFor();
    // This Mac's own USE status names the approved phones; the request still carries only the chosen ID.
    await page.getByLabel('USE 운영 도구').selectOption('phone.deliver');await page.getByLabel('USE 승인된 폰').selectOption({label:'아이폰13'});
    assert.equal(await page.getByLabel('USE 승인된 폰').inputValue(),'approved-phone-13');assert.equal(await page.getByLabel('USE 승인된 폰 ID').count(),0);
    assert.equal(await page.getByLabel('USE 자료 ID').evaluate(e=>getComputedStyle(e).fontSize),'16px');assert.notEqual(await page.getByLabel('USE 자료 ID').evaluate(e=>getComputedStyle(e).borderTopWidth),'0px');
    await page.getByLabel('USE 운영 도구').selectOption('audio.prepare');
    assert.equal(appCalls.filter(c=>c.projectId===id&&c.call.tool==='materials.generate').length,1);assert.equal(devStarts,0);assert.deepEqual(errors,[]);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=402));console.log(engineName+': USE preparation, role mention, lost receipt, follow-up and DEV isolation passed (synthetic app only)');
    await page.evaluate(()=>window.openOpsUse());
    const composer=page.getByLabel('워크룸 입력');try{await composer.waitFor();}catch(error){console.error('OPS fixture UI:',await page.locator('body').innerText(),errors);throw error;}await composer.fill('@Shadow');
    await page.getByRole('option',{name:'ShadowLoop-USE USE · 받는 곳',exact:true}).click();
    await composer.fill('A greeting from the OPS Workroom');await page.getByRole('button',{name:'USE 대화 열기',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'ShadowLoop-USE · 제품 운영',exact:true});await dialog.waitFor();
    assert.equal(await dialog.getByLabel('업무 역할').inputValue(),'use');assert.equal(await dialog.getByLabel('업무 역할').isDisabled(),true);
    await dialog.getByLabel('프로젝트에 맡길 업무').fill('@ShadowLoop-USE DEV keep this out of development');
    await dialog.getByRole('button',{name:'업무 맡기기',exact:true}).click();
    await dialog.getByText('본문의 DEV/USE 역할과 선택한 실행 역할을 일치시키세요.',{exact:true}).waitFor();
    assert.equal(await dialog.getByLabel('업무 역할').inputValue(),'use');assert.equal(devStarts,0);
    await dialog.getByLabel('프로젝트에 맡길 업무').fill('Edited USE draft survives closing');
    await dialog.getByRole('button',{name:'USE 대화 닫기',exact:true}).click();
    await page.getByRole('button',{name:'USE 대화 열기',exact:true}).click();
    assert.equal(await dialog.getByLabel('프로젝트에 맡길 업무').inputValue(),'Edited USE draft survives closing');
    await dialog.getByRole('button',{name:'업무 맡기기',exact:true}).click();await threads.idle();
    await dialog.getByRole('button',{name:'새로고침',exact:true}).click();await dialog.getByText('테스트 자료 생성 확인\n자료 ID: fixture-material',{exact:true}).last().waitFor();
    assert.equal(await page.evaluate(()=>window.terminalCalls.filter(r=>r.operation==='start'||r.operation==='input'||r.operation==='submission').length),0);
    await dialog.getByRole('button',{name:'USE 대화 닫기',exact:true}).click();assert.equal(await composer.inputValue(),'');
    assert.equal(appCalls.filter(c=>c.projectId===id&&c.call.tool==='materials.generate').length,2);
    await page.evaluate(()=>window.openOpsUse(false));await page.getByTestId('workroom-use-unavailable').waitFor();
    await composer.fill('Keep this USE request out of DEV');await composer.press('Control+Enter');
    assert.equal(await page.evaluate(()=>window.terminalCalls.filter(r=>r.operation==='start'||r.operation==='input'||r.operation==='submission').length),0);
    assert.equal(await composer.inputValue(),'Keep this USE request out of DEV');
    await composer.fill('');await page.evaluate(()=>window.openOpsUse(true,'fixture-next-session'));
    await page.locator('[role="tab"][data-session-id="fixture-next-session"]').click();
    try{await page.getByRole('button',{name:'현재 세션에 전송',exact:true}).waitFor();}catch(error){console.error('USE switch-session UI:',await page.locator('body').innerText(),await page.evaluate(()=>window.terminalCalls));throw error;}
    assert.equal(await page.getByTestId('workroom-use-unavailable').count(),0);
    assert.equal(await page.getByTestId('workroom-route-chip').count(),0);
    console.log(engineName+': OPS @USE opens the bounded product thread; no DEV start/input/submission');
   }finally{await context.close();}
  }finally{await browser.close();}
 }
}catch(error){console.error(error);throw error;}finally{await threads?.idle();await vite?.close();rmSync(scratch,{recursive:true,force:true});}
