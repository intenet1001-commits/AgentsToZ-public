/** Real React/xterm on an owned Vite server and synthetic local/community hosts. No CLI, AI or live API. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'vite';
import {chromium} from 'playwright';

const root=resolve(import.meta.dirname,'..'),scratch=await mkdtemp(join(tmpdir(),'agentstoz-session-directory-'));
const shots=process.env.SESSION_DIRECTORY_EVIDENCE_DIR||join(scratch,'evidence');await mkdir(shots,{recursive:true});
for(const key of Object.keys(process.env))if(key.startsWith('VITE_'))delete process.env[key];
process.env.VITE_SUPABASE_URL='https://workspace-fixture.supabase.co';process.env.VITE_SUPABASE_ANON_KEY='fixture-anon-key';
const first='10000000-0000-4000-8000-000000000002',second='10000000-0000-4000-8000-000000000003';
const localProjects=[{targetId:'local-project-001',projectTargetId:'local-project-001',label:'같은 프로젝트',scope:'main'},{targetId:'empty-project-001',label:'빈 프로젝트',scope:'main'}];
const peerProjects=[{targetId:'peer-project-001',projectTargetId:'peer-project-001',label:'같은 프로젝트',scope:'main'}];
const session=(targetId,id='shared-session-001',state='running',createdAt='2026-10-12T01:00:00Z')=>({id,targetId,agent:'codex',state,createdAt,exitCode:state==='running'?null:0,cols:100,rows:28});
let vite,browser;
const results=[];
try{
  vite=await createServer({configFile:join(root,'vite.config.ts'),root,envDir:scratch,cacheDir:join(scratch,'node_modules/.vite'),mode:'maintainer-test',logLevel:'warn',plugins:[{name:'deny-live-api',configureServer(server){server.middlewares.use((request,response,next)=>{if(!request.url?.startsWith('/api/'))return next();response.statusCode=503;response.end('Unmocked fixture API rejected');});}}],server:{host:'127.0.0.1',port:0,strictPort:false,fs:{allow:[root,realpathSync(join(root,'node_modules')),scratch]},watch:{ignored:['**/.agentstoz/**']}}});
  await vite.listen();const address=vite.httpServer.address();assert.ok(address&&typeof address!=='string'&&address.port!==3001);
  const origin=`http://127.0.0.1:${address.port}`;
  const [source,main]=await Promise.all(['/src/AiTerminalPanel.tsx','/src/main.tsx'].map(path=>fetch(origin+path).then(response=>{assert.equal(response.status,200);return response.text();})));
  const react=source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1],reactDom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];assert.ok(react&&reactDom);
  const html=`<!doctype html><html data-app-theme="gray"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:var(--bg);color:var(--ink);font:14px system-ui}#root{min-height:100vh}</style><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};
import '/src/index.css';import '/src/workspaceDesign.css';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const {WorkroomDeviceSwitch}=await import('/src/WorkroomDeviceSwitch.tsx');const {requestWorkroomDevice}=await import('/src/workroomDeviceSelection.ts');
const root=ReactDOM.createRoot(document.getElementById('root'));
window.fixture={visible:true,entry:undefined,consumed:[],mount(){root.render(React.createElement(WorkroomDeviceSwitch,{sessionDirectory:true,visible:this.visible,projects:${JSON.stringify(localProjects)},deviceName:'아젠투지1호',opsTargetId:'local-project-001',entry:this.entry,onEntryConsumed:nonce=>{this.consumed.push(nonce);this.entry=undefined;this.mount();}}));},setVisible(visible){this.visible=visible;this.mount();},incoming(entry){this.entry=entry;this.mount();},draft(){requestWorkroomDevice('');this.incoming({nonce:45,targetId:'local-project-001',prompt:'처음 전달한 요청'});},device:requestWorkroomDevice};fixture.mount();window.open=()=>null;
</script></html>`;
  browser=await chromium.launch({headless:true});
  for(const width of [1280,390]){
    const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'}),requests=[],apiRequests=[],errors=[],external=[];
    const peers=[{endpointId:first,deviceId:'peer-device-two',displayName:'아젠투지2호',kind:'ops',lastSeenAt:'2026-10-12T01:00:00Z'},{endpointId:second,deviceId:'peer-device-three',displayName:'아젠투지3호',kind:'ops',lastSeenAt:new Date().toISOString()}];
    const inventories=new Map([['local',[session('local-project-001')]], [first,[session('peer-project-001')]], [second,[session('peer-project-001'),session('peer-project-001','ended-session-001','exited','2026-10-12T02:00:00Z')]]]);
    const failed=new Set();let deviceFailure=false,historyAvailable=false;
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());if(url.origin!==origin){external.push(url.origin);return route.abort();}
      if(url.pathname==='/__directory-fixture')return route.fulfill({contentType:'text/html',body:html});
      if(!url.pathname.startsWith('/api/'))return route.continue();
      const body=route.request().postDataJSON()??{};
      apiRequests.push({path:url.pathname,body});
      if(url.pathname==='/api/agent-runtime/terminals/history')return historyAvailable?route.fulfill({json:{protocolVersion:'workroom-history-v1',storeInstanceId:'local-history-store-001',records:body.archived?[]:[{id:'local-logical-conversation-001',targetId:'local-project-001',agent:'codex',accountId:'host-default',accountLabel:'현재 CLI 계정',title:'저장한 A 대화 제목',createdAt:'2026-10-12T01:00:00Z',updatedAt:'2026-10-12T01:00:00Z',revision:1,archived:false,state:'running',sessionId:'shared-session-001',binding:'verified'}],nextBefore:null}}):route.fulfill({status:404,json:{error:'구버전 호스트'}});
      if(url.pathname==='/api/agent-dialogue/manage'&&body.operation==='community-read')return route.fulfill({json:{success:true,community:{inside:true,roomId:'10000000-0000-4000-8000-000000000099',unread:0,members:[],messages:[],nextSeq:0,devices:[]}}});
      const terminal=(key,request)=>{
        requests.push({key,...request});
        const sessions=inventories.get(key)??[],selected=sessions.find(session=>session.id===request.sessionId)??sessions[0];
        if(request.operation==='list')return {sessions};
        if(request.operation==='read')return {session:selected,chunks:request.after?[ ]:[{seq:1,text:'Fixture terminal\r\n› '}],nextCursor:1,truncated:false,hasMore:false};
        if(request.operation==='resize'||request.operation==='input')return {session:selected};
        if(request.operation==='accounts'&&request.accountAction==='list'&&['codex','claude'].includes(request.agent)&&[...localProjects,...peerProjects].some(project=>project.targetId===request.targetId))return {accounts:{agent:request.agent,selectedAccountId:'host-default',items:[{id:'host-default',agent:request.agent,label:'현재 CLI 계정',authState:'unknown',checkedAt:null,loginState:'idle'}]}};
        throw Error(`Unexpected terminal mutation ${key}: ${request.operation}`);
      };
      if(url.pathname==='/api/agent-dialogue/control'){
        if(body.operation==='devices')return route.fulfill({status:deviceFailure?503:200,json:deviceFailure?{success:false,error:'기기 목록 일시 장애'}:{success:true,inside:true,deviceId:'local-device-one',devices:peers,unread:0,lastMessageAt:null}});
        if(body.operation==='call'){
          const key=body.targetEndpointId;
          if(body.request.kind==='projects')return route.fulfill({json:{success:true,response:{ok:true,body:{projects:peerProjects,deviceName:peers.find(peer=>peer.endpointId===key)?.displayName,opsTargetId:'peer-project-001'}}}});
          if(body.request.body.operation==='workspace')return route.fulfill({json:{success:true,response:{ok:false,error:'Fixture 저장 상태 조회 없음'}}});
          if(failed.has(key))return route.fulfill({json:{success:true,response:{ok:false,error:'상대 기기 미응답'}}});
          return route.fulfill({json:{success:true,response:{ok:true,body:{result:terminal(key,body.request.body)}}}});
        }
      }
      if(url.pathname==='/api/agent-runtime/terminals'){
        if(body.operation==='workspace')return route.fulfill({status:503,json:{error:'Fixture 저장 상태 조회 없음'}});
        return route.fulfill({json:terminal('local',body)});
      }
      if(url.pathname==='/api/agent-runtime/targets')return route.fulfill({json:{protocolVersion:'agentstoz-tasks-v2',complete:true,targets:localProjects.map(project=>({...project,projectTargetId:project.targetId,scope:'main',branch:null,locked:false,worktreeCapable:false}))}});
      if(url.pathname==='/api/agent-runtime/terminals/access')return route.fulfill({json:{connections:[],workspaceRoots:[]}});
      return route.fulfill({status:503,json:{success:false,error:'Fixture API blocked'}});
    });
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+'/__directory-fixture');
    // Live rows lead each device, ended ones included (no checkbox gate): 1 local + 1 peer + 2 on the third Mac.
    await page.waitForFunction(()=>document.querySelectorAll('[data-testid="session-directory-row"]').length===4);
    assert.deepEqual(requests.filter(request=>request.operation!=='list'),[],'Inventory must not read terminal output or mutate sessions');
    // A Mac past its heartbeats says so here too (2026-10-31 click QA), and stays listed; one that beat just now does not.
    assert.match(await page.locator(`[data-device-key="${first}"] [data-testid="session-directory-device-stale"]`).textContent(),/^응답 없음 · 마지막 \d+일 전$/);
    assert.equal(await page.locator(`[data-device-key="${first}"] [data-testid="session-directory-device-stale-note"]`).count(),1);
    assert.equal(await page.locator(`[data-device-key="${second}"] [data-testid="session-directory-device-stale"]`).count(),0);
    assert.equal(await page.locator(`[data-device-key="local"][data-stale]`).count(),0);
    assert.match(await page.getByLabel('대화 세션 기기').locator(`option[value="${first}"]`).textContent(),/ · 응답 없음$/);
    assert.deepEqual(await page.locator(`[data-device-key="${second}"] [data-testid="session-directory-live-group"]`).evaluateAll(groups=>groups.map(group=>group.dataset.group)),['running','ended'],'Another Mac has no activity: its running rows sit under 실행 중, ended rows last');
    assert.equal(await page.locator(`[data-device-key="${second}"] [data-session-key="${second}:ended-session-001"] [data-testid="session-directory-row-state"]`).textContent(),'종료');
    // Starting a conversation in a project without a session stays folded below the live list.
    assert.equal(await page.locator('[data-device-key="local"] [data-testid="session-directory-start"]').getAttribute('open'),null);
    await page.locator('[data-device-key="local"] [data-testid="session-directory-start"] summary').click();assert.equal(await page.locator('[data-device-key="local"] [data-testid="session-directory-start-project"]').count(),2);await page.locator('[data-device-key="local"] [data-testid="session-directory-start"] summary').click();
    await page.getByLabel('대화 세션 검색').fill('아젠투지2호');assert.equal(await page.getByTestId('session-directory-row').count(),1);await page.getByLabel('대화 세션 검색').fill('');
    await page.getByLabel('대화 세션 기기').selectOption(second);assert.equal(await page.getByTestId('session-directory-device').count(),1);
    await page.locator(`[data-session-key="${second}:shared-session-001"]`).click();const modal=page.getByTestId('session-directory-dialog');await modal.waitFor({state:'visible'});
    await page.waitForFunction(()=>document.querySelector('[data-testid="workroom-readable-screen"]')?.textContent.includes('Fixture terminal'));
    await modal.getByLabel('워크룸 입력').fill('전송하지 않은 요청');
    await modal.getByTestId('session-directory-dialog-close').click();await modal.waitFor({state:'hidden'});
    assert.equal(requests.filter(request=>request.operation==='close').length,0,'Closing the view leaves the host session alive');
    const readAfterClose=requests.filter(request=>request.operation==='read').length;await page.waitForTimeout(width===1280?9000:400);
    assert.equal(requests.filter(request=>request.operation==='read').length,readAfterClose,'A retained closed view stops terminal reads');
    await page.getByTestId('session-directory-resume-view').click();await modal.waitFor({state:'visible'});assert.equal(await modal.getByLabel('워크룸 입력').inputValue(),'전송하지 않은 요청');
    await modal.getByLabel('워크룸 입력').fill('first request');await modal.getByRole('button',{name:'현재 세션에 전송',exact:true}).click();
    await modal.getByLabel('워크룸 입력').fill('second request');await modal.getByRole('button',{name:'현재 세션에 전송',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('[aria-label="워크룸 입력"]').value==='');
    await page.waitForTimeout(600);const inputs=requests.filter(request=>request.operation==='input');
    assert.deepEqual(inputs.map(request=>request.key),[second,second],'Same opaque session id must route to the selected owning Mac');
    assert.deepEqual(inputs.map(request=>request.data),['first request\r','second request\r'],'Typed submissions retain their order');
    await modal.getByTestId('session-directory-dialog-close').click();
    inventories.get(second).push(session('peer-project-001','second-live-session','running','2026-10-12T01:30:00Z'));await page.getByLabel('대화 세션 새로고침').click();
    await page.locator(`[data-session-key="${second}:second-live-session"]`).waitFor();await page.locator(`[data-session-key="${second}:shared-session-001"]`).click();await modal.waitFor({state:'visible'});
    await page.waitForFunction(()=>document.querySelectorAll('dialog[open] [role="tab"]').length===2);
    await modal.getByRole('tab').nth(1).click();await modal.getByLabel('워크룸 입력').fill('내부 B 세션의 초안');await modal.getByTestId('session-directory-dialog-close').click();
    await page.locator(`[data-session-key="${second}:shared-session-001"]`).click();await modal.waitFor({state:'visible'});
    assert.equal(await modal.getByRole('tab').nth(1).getAttribute('aria-selected'),'true','A directory row cannot bypass the actual child B draft');assert.equal(await modal.getByLabel('워크룸 입력').inputValue(),'내부 B 세션의 초안');
    await modal.getByLabel('워크룸 입력').fill('');await modal.getByTestId('session-directory-dialog-close').click();await page.locator(`[data-session-key="${second}:shared-session-001"]`).click();await modal.waitFor({state:'visible'});
    await page.waitForFunction(()=>document.querySelector('dialog[open] [role="tab"]')?.getAttribute('aria-selected')==='true');
    await modal.getByTestId('session-directory-dialog-close').click();inventories.set(second,inventories.get(second).filter(s=>s.id!=='second-live-session'));await page.getByLabel('대화 세션 새로고침').click();
    await page.locator(`[data-session-key="${second}:second-live-session"]`).waitFor({state:'hidden'});await page.locator(`[data-session-key="${second}:shared-session-001"]`).click();await modal.waitFor({state:'visible'});
    // Common-memory/OPS entry must not replace a closed remote view with unsent text.
    await modal.getByLabel('워크룸 입력').fill('REMOTE 남길 요청');await modal.getByTestId('session-directory-dialog-close').click();
    const removedPeer=peers.pop();await page.getByLabel('대화 세션 새로고침').click();
    await page.waitForFunction(()=>document.querySelectorAll('[data-testid="session-directory-device"]').length===2);
    await page.getByTestId('session-directory-resume-view').click();await modal.waitFor({state:'visible'});
    assert.equal(await modal.getByLabel('워크룸 입력').inputValue(),'REMOTE 남길 요청','A removed Mac cannot discard its retained unsent draft');
    assert.equal(await modal.getByLabel('워크룸 입력').isDisabled(),true,'Disconnected view cannot send to another owner');
    assert.match(await modal.textContent(),/작성한 요청은 보존했습니다/);
    await page.waitForTimeout(1000); // Let a transport request already queued before roster loss drain.
    const disconnectedReads=requests.filter(request=>request.key===second&&request.operation==='read').length;await page.waitForTimeout(1400);
    assert.equal(requests.filter(request=>request.key===second&&request.operation==='read').length,disconnectedReads);
    await modal.getByTestId('session-directory-dialog-close').click();peers.push(removedPeer);await page.getByLabel('대화 세션 새로고침').click();
    await page.waitForFunction(()=>document.querySelectorAll('[data-testid="session-directory-device"]').length===3);
    await page.getByTestId('session-directory-resume-view').click();await modal.waitFor({state:'visible'});
    assert.equal(await modal.getByLabel('워크룸 입력').inputValue(),'REMOTE 남길 요청');assert.equal(await modal.getByLabel('워크룸 입력').isDisabled(),false);
    await modal.getByTestId('session-directory-dialog-close').click();
    await page.evaluate(key=>fixture.device(key,{ops:true}),first);await page.getByTestId('session-directory-open-pending').waitFor();
    const originalOwner=peers[0].deviceId;peers[0].deviceId='replacement-device-two';await page.getByLabel('대화 세션 새로고침').click();
    await page.waitForFunction(key=>document.querySelector(`[data-device-key="${key}"]`)?.dataset.deviceOwner==='replacement-device-two',first);
    await page.getByTestId('session-directory-review-draft').click();await modal.getByLabel('워크룸 입력').fill('');await modal.getByTestId('session-directory-dialog-close').click();
    await page.getByTestId('session-directory-open-pending').click();assert.equal(await modal.isVisible(),false);await page.getByTestId('session-directory-notice').getByText('원래 소유자',{exact:false}).waitFor();
    assert.equal(await page.getByTestId('session-directory-open-pending').count(),1,'A queued peer OPS request retains its original device owner');
    peers[0].deviceId=originalOwner;await page.getByLabel('대화 세션 새로고침').click();await page.waitForFunction(key=>document.querySelector(`[data-device-key="${key}"]`)?.dataset.deviceOwner==='peer-device-two',first);
    await page.getByTestId('session-directory-open-pending').click();await modal.waitFor({state:'visible'});await modal.getByTestId('session-directory-dialog-close').click();
    await page.getByLabel('대화 세션 기기').selectOption(second);await page.locator(`[data-session-key="${second}:shared-session-001"]`).click();await modal.waitFor({state:'visible'});await modal.getByLabel('워크룸 입력').fill('REMOTE 남길 요청');await modal.getByTestId('session-directory-dialog-close').click();
    await page.evaluate(()=>fixture.incoming({nonce:41,targetId:'local-project-001',title:'공통 기억 AI로 정리',prompt:'LOCAL OPS 새 요청'}));
    await page.getByTestId('session-directory-pending').waitFor();assert.equal(await modal.isVisible(),false,'Incoming OPS stays queued without replacing the closed remote view');
    assert.equal(await page.getByTestId('session-directory-open-pending').isDisabled(),true);assert.deepEqual(await page.evaluate(()=>fixture.consumed),[41],'Entry is acknowledged only after retaining it in the queue');
    await page.getByTestId('session-directory-review-draft').click();await modal.waitFor({state:'visible'});
    assert.equal(await modal.getByLabel('워크룸 입력').inputValue(),'REMOTE 남길 요청');assert.match(await modal.locator('.workroom-session-dialog-header').textContent(),/아젠투지3호/);
    await modal.getByTestId('session-directory-dialog-close').click();await page.getByLabel('대화 세션 기기').selectOption(first);await page.getByTestId('session-directory-row').click();await modal.waitFor({state:'visible'});
    assert.equal(await modal.getByLabel('워크룸 입력').inputValue(),'REMOTE 남길 요청','Selecting another Mac preserves the unsent remote draft');assert.match(await modal.locator('.workroom-session-dialog-header').textContent(),/아젠투지3호/);
    await modal.getByLabel('워크룸 입력').fill('');await modal.getByTestId('session-directory-dialog-close').click();await page.getByTestId('session-directory-open-pending').click();await modal.waitFor({state:'visible'});
    assert.equal(await modal.getByLabel('터미널에 전달할 작업').inputValue(),'LOCAL OPS 새 요청');assert.match(await modal.locator('.workroom-session-dialog-header').textContent(),/아젠투지1호/);
    // A second local entry also waits; it must not merely relabel a rejected child draft.
    await page.evaluate(()=>fixture.incoming({nonce:42,targetId:'empty-project-001',title:'다른 프로젝트 요청',prompt:'다른 프로젝트 초안'}));
    assert.equal(await modal.getByLabel('터미널에 전달할 작업').inputValue(),'LOCAL OPS 새 요청');assert.match(await modal.locator('.workroom-session-dialog-header').textContent(),/같은 프로젝트/);
    await modal.getByLabel('터미널에 전달할 작업').fill('');await modal.getByTestId('session-directory-dialog-close').click();await page.getByTestId('session-directory-open-pending').click();await modal.waitFor({state:'visible'});
    await page.waitForFunction(text=>document.querySelector('dialog[open] [aria-label="터미널에 전달할 작업"]')?.value===text,'다른 프로젝트 초안');
    assert.equal(await modal.getByLabel('터미널에 전달할 작업').inputValue(),'다른 프로젝트 초안');assert.match(await modal.locator('.workroom-session-dialog-header').textContent(),/빈 프로젝트/);
    await modal.getByLabel('터미널에 전달할 작업').fill('');await modal.getByTestId('session-directory-dialog-close').click();await page.getByLabel('대화 세션 기기').selectOption(second);await page.locator(`[data-session-key="${second}:shared-session-001"]`).click();await modal.waitFor({state:'visible'});
    // The real footer's nested exit dialog yields Escape without dismissing the conversation view.
    await modal.getByRole('button',{name:'세션 종료',exact:true}).click();const nested=page.getByRole('dialog',{name:'세션 종료 전 저장',exact:true});await nested.waitFor({state:'visible'});
    await page.keyboard.press('Escape');await nested.waitFor({state:'hidden'});assert.equal(await modal.isVisible(),true);
    if(width===1280)for(const theme of ['gray','dark']){await page.evaluate(theme=>document.documentElement.dataset.appTheme=theme,theme);await page.evaluate(()=>document.fonts.ready);await modal.screenshot({path:join(shots,`directory-peer-dialog-${theme}.png`)});}
    await page.evaluate(()=>document.documentElement.dataset.appTheme='gray');
    await modal.getByTestId('session-directory-dialog-close').click();
    assert.equal(await page.getByTestId('session-directory-row').count(),2);
    const endedRead=page.waitForResponse(response=>{if(new URL(response.url()).pathname!=='/api/agent-dialogue/control')return false;const request=response.request().postDataJSON();return request?.targetEndpointId===second&&request?.request?.body?.operation==='read'&&request.request.body.sessionId==='ended-session-001';});
    await page.locator(`[data-session-key="${second}:ended-session-001"]`).click();await modal.waitFor({state:'visible'});
    await endedRead;
    await page.waitForFunction(()=>!document.querySelector('dialog[open] [aria-label="워크룸 입력"]'));
    assert.equal(await modal.getByLabel('워크룸 입력').count(),0,'Ended sessions remain read-only');await modal.getByTestId('session-directory-dialog-close').click();
    await page.getByLabel('대화 세션 기기').selectOption('all');failed.add(first);await page.getByLabel('대화 세션 새로고침').click();
    await page.locator(`[data-device-key="${first}"]`).getByText('확인 실패:',{exact:false}).waitFor();
    assert.equal(await page.locator(`[data-device-key="${first}"]`).getByTestId('session-directory-row').count(),1,'An unavailable Mac retains its last inventory');
    deviceFailure=true;await page.getByLabel('대화 세션 새로고침').click();await page.getByText('기기 목록 확인 실패:',{exact:false}).waitFor();
    assert.equal(await page.getByTestId('session-directory-device').count(),3,'Failed discovery must not discard other Macs');deviceFailure=false;failed.clear();
    historyAvailable=true;inventories.get('local').push(session('local-project-001','local-B-session-001'));await page.getByLabel('대화 세션 기기').selectOption('local');
    await page.locator('[data-device-key="local"] [data-testid="session-directory-saved"] summary').click();
    await page.getByTestId('history-row').getByRole('button',{name:'대화 열기',exact:true}).click();await modal.waitFor({state:'visible'});
    await page.waitForFunction(()=>document.querySelector('dialog[open] .workroom-session-dialog-header strong')?.textContent==='저장한 A 대화 제목');
    await page.waitForFunction(()=>document.querySelectorAll('dialog[open] [role="tab"]').length===2);await modal.getByRole('tab').nth(1).click();
    await page.waitForFunction(()=>document.querySelector('dialog[open] .workroom-session-dialog-header strong')?.textContent!=='저장한 A 대화 제목');
    await modal.getByRole('tab').nth(0).click();await page.waitForFunction(()=>document.querySelector('dialog[open] .workroom-session-dialog-header strong')?.textContent==='저장한 A 대화 제목');
    assert.match(await modal.textContent(),/새 창을 열지 못해/,'Blocked local popup has a visible large-dialog fallback');await modal.getByTestId('session-directory-dialog-close').click();
    await page.evaluate(()=>fixture.draft());await modal.waitFor({state:'visible'});await modal.getByLabel('터미널에 전달할 작업').fill('처음 전달한 요청 + 작성 중');
    assert.deepEqual(await page.evaluate(()=>fixture.consumed),[41,42,45]);await modal.getByTestId('session-directory-dialog-close').click();
    await page.getByTestId('session-directory-resume-view').click();await modal.waitFor({state:'visible'});assert.equal(await modal.getByLabel('터미널에 전달할 작업').inputValue(),'처음 전달한 요청 + 작성 중');
    if(width===1280){await modal.getByTestId('session-directory-dialog-close').click();await page.getByTestId('workroom-community-toggle').click();await page.getByTestId('workroom-community-log').waitFor({state:'visible'});await page.getByTestId('workroom-community-draft').fill('보내지 않은 커뮤니티 초안');await page.getByTestId('session-directory-resume-view').click();await modal.waitFor({state:'visible'});}
    // Main-tab hiding leaves this panel mounted, preserving both the entry and typed request.
    await page.waitForFunction(()=>!document.querySelector('[aria-label="대화 세션 새로고침"]')?.textContent.includes('확인 중'));
    await page.waitForTimeout(150);await page.evaluate(()=>fixture.setVisible(false));await modal.waitFor({state:'hidden'});const count=apiRequests.length;await page.waitForTimeout(width===1280?16000:350);assert.equal(apiRequests.length,count,`Hidden directory stops inventory, terminal and expanded community polling beyond their intervals: ${JSON.stringify(apiRequests.slice(count))}`);
    await page.evaluate(()=>fixture.setVisible(true));await modal.waitFor({state:'visible'});assert.equal(await modal.getByLabel('터미널에 전달할 작업').inputValue(),'처음 전달한 요청 + 작성 중');
    if(width===1280)assert.equal(await page.getByTestId('workroom-community-draft').inputValue(),'보내지 않은 커뮤니티 초안');
    await modal.getByTestId('session-directory-dialog-close').click();await page.getByLabel('대화 세션 기기').selectOption('all');
    if(width===1280){
      for(let index=1;index<=8;index++){await page.evaluate(index=>fixture.incoming({nonce:100+index,targetId:'local-project-001',title:'대기 요청 '+index,prompt:'보관한 요청 '+index}),index);await page.waitForFunction(nonce=>fixture.consumed.includes(nonce),100+index);}
      assert.equal(await page.getByTestId('session-directory-open-pending').count(),8);await page.evaluate(()=>fixture.incoming({nonce:109,targetId:'local-project-001',title:'대기 요청 9',prompt:'보관한 요청 9'}));
      await page.getByTestId('session-directory-notice').getByText('대기 요청이 8개입니다.',{exact:false}).waitFor();assert.equal(await page.evaluate(()=>fixture.consumed.includes(109)),false,'A full queue must not acknowledge and lose the ninth entry');
      await page.getByTestId('session-directory-review-draft').click();await modal.getByLabel('터미널에 전달할 작업').fill('');await modal.getByTestId('session-directory-dialog-close').click();await page.getByTestId('session-directory-open-pending').first().click();await modal.waitFor({state:'visible'});
      await page.waitForFunction(()=>fixture.consumed.includes(109));assert.equal(await modal.getByLabel('터미널에 전달할 작업').inputValue(),'보관한 요청 1','A newly opened held draft cannot be overwritten during its first-render dirty callback');await modal.getByTestId('session-directory-dialog-close').click();
    }
    await page.evaluate(()=>document.fonts.ready);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'No horizontal page overflow');
    for(const theme of width===1280?['gray','dark']:['gray']){await page.evaluate(theme=>document.documentElement.dataset.appTheme=theme,theme);await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(shots,`directory-${width}-${theme}.png`),fullPage:true});}
    assert.deepEqual(errors,[],'No React or browser errors');assert.deepEqual(external,[],'No external or installed API access');assert.equal(requests.filter(request=>request.operation==='start'||request.operation==='close').length,0,'Browse/open/close never starts or ends a host session');
    results.push({width,passed:true,checks:['three-device-list','id-collision-owner','live-first-groups','folded-start-projects','search-filter','ordered-peer-input','view-only-close','retained-drafts','disconnected-draft-resume','pending-owner-replacement','actual-child-session-restore','incoming-OPS-queue','dirty-owner-switch-guard','local-header-owner','bounded-pending-queue','nested-dialog-escape','ended-readonly','stale-peer','stale-device-label','discovery-failure','blocked-popup-fallback','saved-title-child-session-binding','entry-consumption','hidden-poll-stop','no-overflow']});await context.close();
  }
  await writeFile(join(shots,'directory-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({passed:results.length,failed:0,results,evidence:shots},null,2));
}catch(error){console.error(error);process.exitCode=1;}
finally{await browser?.close();await vite?.close();await rm(scratch,{recursive:true,force:true});}
