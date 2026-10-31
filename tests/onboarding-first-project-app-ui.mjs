import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {portalLocalMetadataFingerprint} from '../src/portalLocalMetadata.ts';
const dist=process.argv[2];if(!dist)throw new Error('Pass an isolated Vite build directory');
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:req=>{const path=new URL(req.url).pathname;return new Response(Bun.file(join(dist,path==='/'?'index.html':path)));}});
let browser, savedPorts=[];
let profile={state:'unprepared',profileId:null,memoryId:null,displayName:'AgentsToZ',aliases:['agentstoz','아젠투지','에이전츠투지'],projectId:null,revision:null,lastSavedAt:null,problem:null,pendingCount:0,backend:null,coordinationPolicy:'agentstoz'};
let proposals=[], profileStatusUnavailable=false, navigation=null, entryBodyFailures=1;
const savedEntry={entryId:'a1'.repeat(12),section:'AgentsToZ 운영 결정',title:'프로젝트 별칭 규칙'};
// The OPS memory ID sits in the collapsed 「고급 정보」 since the 2026-09 glossary pass.
const openAdvanced=async panel=>{const d=panel.locator('details').filter({has:panel.page().getByText('고급 정보',{exact:true})}).first();if(await d.count()&&!(await d.evaluate(e=>e.open)))await d.locator('summary').click();};
try{
 browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1100,height:850}}),errors=[],calls=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const req=route.request(),u=new URL(req.url());
  if(u.pathname.startsWith('/api/')||u.hostname!=='127.0.0.1'){
   calls.push({path:u.pathname,method:req.method(),body:req.postData()});
   if(u.pathname.startsWith('/api/control-profile/')){
    const action=u.pathname.split('/').at(-1);
    if(action==='status'&&profileStatusUnavailable)return route.fulfill({status:503,json:{success:false,error:'fixture profile unavailable'}});
    if(action==='entries'){
     const entryId=u.searchParams.get('entryId');
     // The first body read fails like a dropped request; the second press must read it again, not fold it away.
     if(entryId===savedEntry.entryId&&entryBodyFailures>0){entryBodyFailures--;return route.fulfill({status:503,json:{success:false,error:'fixture body unavailable'}});}
     if(entryId)return route.fulfill({json:entryId===savedEntry.entryId?{success:true,entry:{...savedEntry,revision:profile.revision,body:'song-app은 노래 앱 프로젝트를 가리킨다.',truncated:false}}:{success:false,error:'운영 기억이 바뀌었습니다.'},status:entryId===savedEntry.entryId?200:404});
     return route.fulfill({json:{success:true,memory:profile.state==='ready'?{ready:true,revision:profile.revision,total:1,entries:[savedEntry]}:{ready:false,problem:'먼저 준비하세요.',total:0,entries:[]}}});
    }
    if(action==='prepare')profile={...profile,state:'ready',profileId:'11111111-1111-4111-8111-111111111111',memoryId:'22222222-2222-4222-8222-222222222222',revision:'revision-1',backend:'app-data'};
    if(action==='policy')profile={...profile,coordinationPolicy:JSON.parse(req.postData()).policy};
    if(action==='review'){proposals=[];profile={...profile,pendingCount:0,lastSavedAt:'2026-09-14T00:00:00Z',revision:'revision-2'};}
    if(action==='open'){
     const body=JSON.parse(req.postData());
     return route.fulfill({status:200,json:{success:true,performed:true,target:'ops',projectId:profile.projectId,
      message:'OPS fixture 열기 요청',warnings:body.surface==='app'&&body.bypass?['권한 우회는 앱에 적용되지 않습니다.']:body.surface==='orca-worktree'?['Orca 플로팅 전환: selector_not_found']:[],
      ...(body.action==='start-workroom-session'?{session:{id:'ops-session-1234',targetId:profile.projectId,agent:body.agent}}:{})}});
    }
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,profile,proposals,connections:[{agent:'codex',state:'configured',profiles:1,message:'설정 연결됨'}],controls:[],...(action==='review'?{backup:{backedUp:false,reason:'not-configured'}}:{})})});
   }
   if(u.pathname==='/api/control-center/create'){
    savedPorts=[{id:'control-project-id',name:'AgentsToZ-Control',folderPath:'/fixture/projects/AgentsToZ-Control'}];
    return route.fulfill({status:201,contentType:'application/json',body:JSON.stringify({success:true,performed:true,effect:'created-control-center',project:{projectId:'control-project-id',projectName:'AgentsToZ-Control',memoryId:'11111111-1111-4111-8111-111111111111'}})});
   }
   if(u.pathname==='/api/ports/merge'){savedPorts=JSON.parse(req.postData()).ports;return route.fulfill({status:200,contentType:'application/json',body:'{"success":true}'});}
   if(u.pathname==='/api/agent-runtime/terminals'&&JSON.parse(req.postData()??'{}').operation==='list')return route.fulfill({json:{sessions:[]}});
   const values={
    '/api/onboarding/progress':{success:true,progress:{schemaVersion:1,recipeVersion:1,revision:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',runId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',platform:'mac',steps:[{tool:'codex',state:'configured',checkedAt:new Date().toISOString()}],operation:null,updatedAt:new Date().toISOString()}},
    '/api/ports':savedPorts, '/api/portal':{}, '/api/workspace-roots':[{id:'fixture-root',name:'테스트 작업 폴더',path:'/fixture/projects'}],
    '/api/portal/safety-lease/acquire':{success:true,token:'a'.repeat(64),metadata:{},fingerprint:portalLocalMetadataFingerprint({}),expiresInMs:30000},
    '/api/portal/safety-lease/release':{released:true},
    '/api/health':{status:'ok'}, '/api/onboarding/status':{stage:'fresh'},
    '/api/agentstoz-use/workroom-navigation':{success:true,navigation},
    '/api/agent-dialogue/control':{success:true,inside:false,deviceId:'fixture-device',devices:[],unread:0,lastMessageAt:null},
    '/api/agent-runtime/targets':{protocolVersion:'agentstoz-tasks-v2',complete:true,targets:savedPorts.map(p=>({targetId:p.id,projectTargetId:p.id,label:p.name,scope:'main',branch:null,locked:false,worktreeCapable:false}))},
    '/api/git-init':{success:true,alreadyGit:false},
   };
   return route.fulfill({status:Object.hasOwn(values,u.pathname)?200:503,contentType:'application/json',body:JSON.stringify(values[u.pathname]??{error:'fixture blocked'})});
  }return route.continue();
 });
 await page.goto(`http://127.0.0.1:${server.port}`);
 await page.getByRole('button',{name:'새 프로젝트 만들기',exact:true}).waitFor({timeout:15000});
 await page.getByRole('button',{name:'새 프로젝트 만들기',exact:true}).click();
 const dialog=page.getByTestId('new-project-dialog');await dialog.waitFor();
 assert.equal(await dialog.getByRole('checkbox',{name:/Git 저장소 만들기/}).isChecked(),false);
 const checks=await dialog.getByRole('checkbox').all();for(const box of checks){
  const label=await box.evaluate(e=>e.closest('label')?.textContent??'');
  if(/장기기억|완료 후|생성 후/.test(label))assert.equal(await box.isChecked(),false,label);
 }
 await dialog.getByRole('button',{name:'기존 폴더 등록',exact:true}).click();
 const input=dialog.getByPlaceholder(/폴더.*경로|프로젝트.*경로|Users/).first();
 await input.fill('/fixture/existing');
 await dialog.getByText('Git 없이 폴더만 프로젝트로 등록합니다.',{exact:true}).waitFor();
 assert.equal(await dialog.getByText('Git 없이 폴더만 프로젝트로 등록합니다.',{exact:true}).count(),1);
 assert.equal(calls.some(c=>/create-folder|project-memory\/(init|update)|execute-command/.test(c.path)),false);
 assert.equal(calls.filter(c=>c.path==='/api/git-init').every(c=>JSON.parse(c.body??'{}').checkOnly===true),true);
 await dialog.getByRole('button',{name:'등록',exact:true}).click();
 await dialog.waitFor({state:'hidden'});
 assert.equal(savedPorts.length,1);assert.equal(savedPorts[0].folderPath,'/fixture/existing');
 const projectId=savedPorts[0].id;
 await page.reload();await page.getByText('existing',{exact:true}).first().waitFor({timeout:10000});
 assert.equal(savedPorts.length,1);assert.equal(savedPorts[0].id,projectId);
 assert.equal(await page.getByRole('button',{name:'새 프로젝트 만들기',exact:true}).count(),0);
 await page.getByText('도구 및 설정',{exact:true}).click();
 const profileEntry=page.getByTestId('control-profile-open');
 assert.equal(await profileEntry.innerText(),'아젠투지 설정');
 await profileEntry.click();
 const profilePanel=page.getByTestId('control-profile-panel');await profilePanel.waitFor();
 await profilePanel.getByRole('heading',{name:'아젠투지 설정',exact:true}).waitFor();
 assert.equal(calls.some(c=>c.path==='/api/control-profile/prepare'),false,'Opening OPS must remain read-only');
 // UX audit 2026-10-25: opened from 도구 및 설정, focus stayed on the button outside, so Escape closed the popover behind
 // the panel and left the panel open. Now the panel takes focus, Escape closes it, and focus goes back to the opener.
 await page.waitForFunction(()=>document.querySelector('[data-testid="control-profile-panel"]')?.contains(document.activeElement),null,{timeout:5000}).catch(()=>{throw new Error('The panel takes focus when it opens');});
 await page.keyboard.press('Escape');
 await profilePanel.waitFor({state:'hidden'});
 await page.waitForFunction(()=>document.activeElement?.getAttribute('data-testid')==='control-profile-open',null,{timeout:5000}).catch(()=>{throw new Error('Escape returns focus to 아젠투지 설정');});
 await page.keyboard.press('Escape');
 assert.equal(await profileEntry.isVisible(),false,'The next Escape closes the tools popover, one layer at a time');
 await page.getByText('도구 및 설정',{exact:true}).click();
 await profileEntry.click();await profilePanel.waitFor();
 await profilePanel.getByRole('button',{name:'아젠투지 설정 닫기',exact:true}).click();
 await profilePanel.waitFor({state:'hidden'});
 // Since d23b8bdc a press inside a dialog the tools popover opened no longer counts as an outside click, so closing the
 // panel with its own button leaves 도구 및 설정 open. Clicking the toggle again here would close it.
 assert.equal(await profileEntry.isVisible(),true,'Closing the panel keeps the tools popover that opened it');
 const shortcut=page.getByTestId('control-center-project-shortcut');
 await shortcut.locator('summary').click();
 await shortcut.getByRole('button',{name:'다른 Mac의 아젠투지 복원',exact:true}).click();
 await dialog.waitFor();
 assert.equal(await dialog.getByRole('checkbox',{name:/처음부터 프로젝트 장기기억/}).isChecked(),true);
 assert.equal(await dialog.getByRole('checkbox',{name:/Supabase 백업/}).isChecked(),true);
 assert.equal(calls.some(c=>c.path==='/api/control-center/create'),false,'Choosing restore must not create a new Control');
 await dialog.getByRole('button').first().click();
 await dialog.waitFor({state:'hidden'});
 if(!(await profileEntry.isVisible())) await page.getByText('도구 및 설정',{exact:true}).click();
 await page.locator('[data-help-key="btn-setup-wizard"]').click();
 await page.getByRole('heading',{name:'내 기기와 연결',exact:true}).waitFor();
 await page.getByRole('button',{name:'첫 워크룸 열기',exact:true}).click();
 const directory=page.getByTestId('session-directory');await directory.waitFor();
 await directory.getByRole('heading',{name:'작업 세션',exact:true}).waitFor();
 const local=directory.locator('[data-testid="session-directory-device"][data-device-key="local"]');
 await local.getByTestId('session-directory-start').locator('summary').click();
 await local.getByTestId('session-directory-start-project').filter({hasText:'existing'}).waitFor();
 assert.equal(await page.locator('[data-top-level-tab="terminal"]').getAttribute('aria-selected'),'true');
 assert.equal(calls.some(c=>/agent-runtime.*(?:start|turn)/.test(c.path)),false);
 savedPorts=[];await page.reload();
 await page.getByTestId('onboarding-control-center').locator('summary').click();
 assert.equal(await page.getByTestId('onboarding-create-control').innerText(),'내 아젠투지 준비');
 await page.getByTestId('onboarding-create-control').click();
 await profilePanel.waitFor();
 await profilePanel.getByRole('heading',{name:'아젠투지 설정',exact:true}).waitFor();
 assert.equal(calls.some(c=>c.path==='/api/control-center/create'),false);
 await profilePanel.getByRole('button',{name:'아젠투지 준비·연결 다시 확인',exact:true}).click();
 // An app-data profile lives on this Mac only; the headline no longer reads like a shared memory (UX audit 2026-10-25).
 await profilePanel.getByText('운영 기억 준비됨 · 이 Mac 전용',{exact:true}).waitFor();assert.equal(savedPorts.length,0,'Global profile must not create a project');
 // What 아젠투지 already remembers is listed read-only: titles first, the body only when opened.
 const saved=profilePanel.getByTestId('control-profile-saved-memory');
 await saved.getByRole('heading',{name:'저장된 운영 기억 · 1',exact:true}).waitFor();
 assert.equal(await saved.getByText('song-app은 노래 앱 프로젝트를 가리킨다.',{exact:true}).count(),0,'Bodies are not loaded with the list');
 // 2026-10-26: the titles fold under the heading that carries the count; opening it reads nothing more.
 await saved.getByRole('button',{name:'저장된 운영 기억 · 1',exact:true}).click();
 await saved.getByRole('button',{name:/프로젝트 별칭 규칙/}).click();
 // Review 2026-10-25: the failure line said 「다시 눌러 보세요」 but the next press folded the item away instead of reading again.
 await saved.getByRole('alert').filter({hasText:'내용을 읽지 못했습니다. 다시 눌러 보세요.'}).waitFor();
 await saved.getByRole('button',{name:/프로젝트 별칭 규칙/}).click();
 await saved.getByText('song-app은 노래 앱 프로젝트를 가리킨다.',{exact:true}).waitFor();
 assert.equal(await saved.getByRole('button',{name:/프로젝트 별칭 규칙/}).getAttribute('aria-expanded'),'true');
 assert.deepEqual(calls.filter(c=>c.path==='/api/control-profile/entries').map(c=>c.method),['GET','GET','GET'],'The saved memory list only reads');
 assert.equal(await saved.getByText(/고치려면|후보로 남겨/).count(),0,'No correction promise: saving a candidate only appends');
 const prepare=calls.filter(c=>c.path==='/api/control-profile/prepare');
 assert.equal(prepare.length,1);assert.deepEqual(JSON.parse(prepare[0].body),{});
 await openAdvanced(profilePanel);await profilePanel.getByText(profile.memoryId,{exact:true}).waitFor();
 assert.equal(await profilePanel.getByRole('button',{name:'아젠투지를 Codex 앱으로 열기',exact:true}).isDisabled(),true);
 assert.equal(await profilePanel.getByRole('button',{name:'아젠투지 채팅·워크룸 열기',exact:true}).isDisabled(),true,'A local-only OPS profile has no Workroom target');
 await profilePanel.getByText(/로컬 전용 OPS는 패널·기억 호출/).waitFor();
 assert.equal(profile.displayName,'AgentsToZ','Display copy must not rewrite the stored profile identity');
 // The static «관제 방식: … 기본 운영» line never changed and was removed as noise (ui-glossary).
 assert.equal(await profilePanel.getByText(/관제 방식/).count(),0);
 assert.equal(calls.some(c=>c.path==='/api/control-profile/policy'),false,'OPS display does not offer a CS-CEO policy write');
 proposals=[{id:'candidate-1',title:'프로젝트 운영 결정',body:'각 프로젝트의 구현 기억을 구분한다.',evidence:'사용자 요청',state:'pending',baseRevision:'revision-1'}];
 await profilePanel.getByRole('button',{name:'상태 다시 확인',exact:true}).click();
 await profilePanel.getByText('프로젝트 운영 결정',{exact:true}).waitFor();
 assert.equal(calls.some(c=>c.path==='/api/control-profile/review'),false,'A visible candidate is not a saved memory');
 // The one item waiting for the user sits under the status, before the launch options and the saved list (UX audit 2026-10-25).
 const layout=await profilePanel.evaluate(panel=>{panel.scrollTop=0;const pending=panel.querySelector('[data-testid="control-profile-pending"]');
  const after=[panel.querySelector('fieldset'),panel.querySelector('[data-testid="control-profile-saved-memory"]'),panel.querySelector('[data-testid="device-operating-memory"]')];
  return {first:after.every(node=>node&&(pending.compareDocumentPosition(node)&Node.DOCUMENT_POSITION_FOLLOWING)),visible:pending.querySelector('h3').getBoundingClientRect().bottom<=panel.getBoundingClientRect().bottom,heading:pending.querySelector('h3').textContent};});
 assert.deepEqual(layout,{first:true,visible:true,heading:'운영 기억 저장 후보 · 1'});
 // A candidate that is waiting keeps the instruction to save it here, even on a local-only memory.
 assert.match(await profilePanel.getByTestId('control-profile-pending').innerText(),/여기서 저장합니다/);
 await profilePanel.getByRole('button',{name:'운영 기억에 저장',exact:true}).click();
 await profilePanel.getByText('운영 기억은 로컬에 저장했습니다. 원격 백업 상태는 별도 확인이 필요합니다.',{exact:true}).waitFor();
 assert.equal(calls.filter(c=>c.path==='/api/control-profile/review').length,1);
 assert.deepEqual(JSON.parse(calls.find(c=>c.path==='/api/control-profile/review').body),{id:'candidate-1',accept:true,expectedRevision:'revision-1'});
 proposals=[{id:'candidate-2',title:'제외할 후보',body:'저장하지 않는다.',evidence:'테스트',state:'pending',baseRevision:'revision-2'}];
 await profilePanel.getByRole('button',{name:'상태 다시 확인',exact:true}).click();
 await profilePanel.getByText('제외할 후보',{exact:true}).waitFor();
 await profilePanel.getByRole('button',{name:'제외',exact:true}).click();
 await profilePanel.getByText('제외할 후보',{exact:true}).waitFor({state:'hidden'});
 assert.deepEqual(calls.filter(c=>c.path==='/api/control-profile/review').map(c=>JSON.parse(c.body)),[
  {id:'candidate-1',accept:true,expectedRevision:'revision-1'},
  {id:'candidate-2',accept:false,expectedRevision:'revision-2'},
 ]);
 await page.screenshot({path:'/tmp/control-profile-panel.png',fullPage:true});
 await profilePanel.getByRole('button',{name:'아젠투지 설정 닫기',exact:true}).click();
 await profilePanel.waitFor({state:'hidden'});
 await page.locator('[data-top-level-tab="common-memory"]').click();
 await page.getByTestId('top-level-common-memory-view').waitFor();
 assert.equal(await page.locator('[data-top-level-tab]').count(),6,'Common memory is a peer navigation tab');
 await page.locator('[data-top-level-tab="common-memory"]').press('ArrowLeft');
 assert.equal(await page.locator('[data-top-level-tab="memory"]').getAttribute('aria-selected'),'true');
 await page.locator('[data-top-level-tab="memory"]').press('ArrowRight');
 assert.equal(await page.locator('[data-top-level-tab="common-memory"]').getAttribute('aria-selected'),'true');
 await page.locator('[data-top-level-tab="common-memory"]').press('End');
 assert.equal(await page.locator('[data-top-level-tab="what-i-said"]').getAttribute('aria-selected'),'true');
 await page.locator('[data-top-level-tab="what-i-said"]').press('Home');
 assert.equal(await page.locator('[data-top-level-tab="ports"]').getAttribute('aria-selected'),'true');
 await page.locator('[data-top-level-tab="memory"]').click();
 await page.getByRole('button',{name:'아젠투지 설정 열기',exact:true}).click();
 await profilePanel.getByRole('heading',{name:'아젠투지 설정',exact:true}).waitFor();
 await openAdvanced(profilePanel);await profilePanel.getByText(profile.memoryId,{exact:true}).waitFor();
 assert.equal(calls.filter(c=>c.path==='/api/control-profile/prepare').length,1,'Reopening OPS must not prepare a replacement profile');
 assert.equal(calls.some(c=>c.path.startsWith('/api/ops/')),false);
 // Task B: the real App must wire roles to the sidebar AND memory editor.
 // A renamed, role-less legacy OPS row is identified by the existing binding.
 savedPorts=[
  {id:'ops-bound',name:'운영 폴더',folderPath:'/fixture/projects/renamed-operations',isRunning:false},
  {id:'dev-project',name:'개발 프로젝트',folderPath:'/fixture/projects/development',role:'dev',isRunning:false},
  {id:'song-project',name:'song-app',folderPath:'/fixture/projects/song-app',isRunning:false},
  {id:'unknown-project',name:'미지원 역할',folderPath:'/fixture/projects/unknown',role:'future',isRunning:false},
 ];
 profile={...profile,projectId:'ops-bound',backend:'control-folder'};
 const roleBaseline=JSON.stringify(savedPorts), roleCallStart=calls.length;
 await page.reload();
 await page.getByTestId('project-role-filter-ops').waitFor();
 const row=id=>page.locator(`[data-testid="sidebar-project-row"][data-project-id="${id}"]`);
 const selectRow=id=>row(id).getByText(savedPorts.find(project=>project.id===id).name,{exact:true}).first().click();
 for(const [id,role] of [['ops-bound','ops'],['dev-project','dev'],['song-project','managed'],['unknown-project','unknown']]){
  await row(id).locator(`[data-project-role="${role}"]`).waitFor();
 }
 await page.getByTestId('project-role-filter-ops').click();
 await selectRow('ops-bound');
 await page.locator('[data-testid="project-memory-role"][data-project-role="ops"]').waitFor();
 assert.equal(await page.getByTestId('sidebar-project-row').count(),1);
 const opsFolder='/fixture/projects/renamed-operations';
 assert.equal(calls.slice(roleCallStart).some(c=>c.path.startsWith('/api/project-memory/')&&c.body?.includes(opsFolder)),false,'OPS must not mount the generic memory editor');
 await page.getByTestId('project-memory-open-ops').click();
 await openAdvanced(profilePanel);await profilePanel.getByText(profile.memoryId,{exact:true}).waitFor();
 assert.equal(calls.filter(c=>c.path==='/api/control-profile/prepare').length,1,'Role navigation must not initialize or replace OPS');
 await profilePanel.getByRole('button',{name:'아젠투지 설정 닫기',exact:true}).click();
 // VOC 2026-09-24: a one-project chip opens that project; the open OPS detail must not go blank.
 await page.getByTestId('project-role-filter-dev').click();
 await page.locator('[data-testid="project-memory-role"][data-project-role="dev"]').waitFor();
 await page.getByTestId('project-role-filter-ops').click();
 await page.locator('[data-testid="project-memory-role"][data-project-role="ops"]').waitFor();
 await page.getByTestId('project-role-filter-ops').click();
 for(const [id,role] of [['dev-project','dev'],['song-project','managed'],['unknown-project','unknown']]){
  await page.getByTestId(`project-role-filter-${role}`).click();
  await selectRow(id);
  console.log('First-project role check: '+role);
  await page.locator(`[data-testid="project-memory-role"][data-project-role="${role}"]`).waitFor();
  // The memory panel defers its first status read by 300 ms so fast switching sends nothing wasted;
  // wait past it so both the "queries memory" and "unknown never queries" checks below mean something.
  await page.waitForTimeout(450);
  assert.equal(await page.getByTestId('sidebar-project-row').count(),1);
 }
 for(const path of ['/fixture/projects/development','/fixture/projects/song-app']){
  assert.equal(calls.slice(roleCallStart).some(c=>(c.path==='/api/project-memory/detect'||c.path==='/api/project-memory/panel-status')&&c.body?.includes(path)),true,'DEV and managed must retain project memory: '+path);
 }
 assert.equal(calls.slice(roleCallStart).some(c=>c.path.startsWith('/api/project-memory/')&&c.body?.includes('/fixture/projects/unknown')),false,'Unknown roles must not fall through to project memory');
 assert.equal(JSON.stringify(savedPorts),roleBaseline,'Reading/filtering legacy rows must not migrate stored data');
 assert.equal(calls.slice(roleCallStart).some(c=>/project-memory\/(init|update|push|session-end)|control-profile\/(prepare|review)/.test(c.path)),false,'Role navigation must remain read-only');
 await page.getByTestId('project-role-filter-ops').click();await selectRow('ops-bound');
 await page.locator('[data-testid="project-memory-role"][data-project-role="ops"]').waitFor();
 await page.locator('.workspace-project-detail').evaluate(async element=>{
  await Promise.all(element.getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{})));
 });
 await page.screenshot({path:'/tmp/agentstoz-project-roles.png',fullPage:true});
 // An unavailable identity must not quietly turn a renamed OPS folder into DEV.
 console.log('First-project offline OPS identity check');
 profileStatusUnavailable=true;const offlineCalls=calls.length;
 await page.reload();
 await page.getByTestId('project-role-filter-managed').click();
 await selectRow('ops-bound');
 await page.locator('[data-testid="project-memory-role"][data-project-role="unknown"]').waitFor();
 assert.equal(calls.slice(offlineCalls).some(c=>c.path.startsWith('/api/project-memory/')&&c.body?.includes(opsFolder)),false);
 // A status read that fails is said as such — it used to show 「프로필 준비 필요」 like an unprepared profile (UX audit 2026-10-25).
 await page.getByTestId('project-memory-open-ops').click();
 await profilePanel.getByRole('heading',{name:'아젠투지 설정',exact:true}).waitFor();
 await profilePanel.getByRole('status').filter({hasText:'아젠투지 상태를 읽지 못했습니다. 잠시 뒤 「상태 다시 확인」을 누르세요.'}).waitFor();
 assert.equal(await profilePanel.getByText(/준비 필요/).count(),0,'A failed read is not an unprepared profile');
 profileStatusUnavailable=false;
 await profilePanel.getByRole('button',{name:'상태 다시 확인',exact:true}).click();
 await profilePanel.getByText('운영 기억 연결됨',{exact:true}).waitFor();
 await profilePanel.getByRole('button',{name:'아젠투지 설정 닫기',exact:true}).click();
 // The recovered OPS row no longer belongs to the previously selected managed filter.
 await page.getByTestId('project-role-filter-ops').click();
 await selectRow('ops-bound');
 await page.locator('[data-testid="project-memory-role"][data-project-role="ops"]').waitFor();
 // Task C: reuse the navigation endpoint, then launch from the actual OPS panel.
 const launchBaseline=calls.length;
 navigation={nonce:'ops-focus-123',panel:'ops'};
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await profilePanel.waitFor();
 await profilePanel.getByRole('button',{name:'아젠투지를 Codex 앱으로 열기',exact:true}).waitFor();
 assert.equal(await profilePanel.getByLabel('OPS 승인 없이 실행',{exact:true}).count(),0,'Codex app does not support a bypass preference');
 await profilePanel.getByRole('button',{name:'아젠투지를 Codex 앱으로 열기',exact:true}).click();
 await page.getByText('OPS fixture 열기 요청',{exact:false}).first().waitFor();
 const launchCalls=()=>calls.slice(launchBaseline).filter(c=>c.path==='/api/control-profile/open').map(c=>JSON.parse(c.body));
 assert.deepEqual(launchCalls()[0],{action:'open-code-app',expectedProfileId:profile.profileId,agent:'codex',surface:'app',bypass:false,mode:'reopen'});
 // 2026-10-26: the surface/AI options fold under 「아젠투지 열기 방식」; the main open button stays in the status card.
 await profilePanel.getByRole('button',{name:'열기 방식 바꾸기',exact:true}).click();
 await profilePanel.getByLabel('OPS 실행 표면').selectOption('orca-worktree');
 await profilePanel.getByLabel('OPS 실행 AI').selectOption('agy');
 await profilePanel.getByLabel('OPS 승인 없이 실행',{exact:true}).check();
 await profilePanel.getByRole('button',{name:'아젠투지를 Orca 워크트리로 열기',exact:true}).click();
 await page.getByText('Orca 플로팅 전환: selector_not_found',{exact:false}).first().waitFor();
 assert.deepEqual(launchCalls()[1],{action:'open-code-app',expectedProfileId:profile.profileId,agent:'agy',surface:'orca-worktree',bypass:true});
 await profilePanel.getByLabel('OPS 실행 표면').selectOption('workroom');
 await profilePanel.getByLabel('OPS 실행 AI').selectOption('hermes');
 await profilePanel.getByRole('button',{name:'아젠투지를 워크룸으로 열기',exact:true}).click();
 await profilePanel.waitFor({state:'hidden'});
 assert.equal(launchCalls()[2].action,'start-workroom-session');assert.equal(launchCalls()[2].agent,'hermes');
 assert.match(launchCalls()[2].requestId,/^ops_[a-f0-9-]{36}$/);
 assert.equal(await page.locator('[data-top-level-tab="terminal"]').getAttribute('aria-selected'),'true');
 assert.equal(launchCalls().every(c=>!Object.hasOwn(c,'folderPath')&&!Object.hasOwn(c,'portId')),true);
 assert.equal(calls.slice(launchBaseline).some(c=>/control-profile\/(prepare|review)|project-memory\/(init|update|push)/.test(c.path)),false);
 assert.deepEqual(errors,[]);
 await page.screenshot({path:'/tmp/onboarding-first-project-app.png',fullPage:true});
 console.log('PASS: OPS labels across tools/onboarding/AI work open the same profile; unchanged prepare/policy/review contracts, candidate-before-save and rejection; no project or identity replacement');
 console.log('PASS: role filters, bound renamed OPS routing, DEV/managed memory, unknown-role fail-closed, no stored-row migration or automatic save');
 console.log('PASS: existing dashboard navigation focuses OPS; actual OPS panel forwards bounded app/Orca/Workroom launches, discloses bypass/fallback and blocks app-data launches');
}finally{await browser?.close();server.stop(true);}
