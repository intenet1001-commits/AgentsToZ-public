import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {portalLocalMetadataFingerprint} from '../src/portalLocalMetadata.ts';
const dist=process.argv[2];if(!dist)throw new Error('Pass an isolated Vite build directory');
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:req=>{const path=new URL(req.url).pathname;return new Response(Bun.file(join(dist,path==='/'?'index.html':path)));}});
let browser, savedPorts=[];
let profile={state:'unprepared',profileId:null,memoryId:null,displayName:'AgentsToZ',aliases:['agentstoz','아젠투지','에이전츠투지'],projectId:null,revision:null,lastSavedAt:null,problem:null,pendingCount:0,backend:null,coordinationPolicy:'agentstoz'};
let proposals=[], profileStatusUnavailable=false, navigation=null;
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
    if(action==='prepare')profile={...profile,state:'ready',profileId:'11111111-1111-4111-8111-111111111111',memoryId:'22222222-2222-4222-8222-222222222222',revision:'revision-1',backend:'app-data'};
    if(action==='policy')profile={...profile,coordinationPolicy:JSON.parse(req.postData()).policy};
    if(action==='review'){proposals=[];profile={...profile,pendingCount:0,lastSavedAt:'2026-09-14T00:00:00Z',revision:'revision-2'};}
    if(action==='open'){
     const body=JSON.parse(req.postData());
     return route.fulfill({status:200,json:{success:true,performed:true,target:'ops',projectId:profile.projectId,
      message:'OPS fixture 열기 요청',warnings:body.bypass?['권한 우회는 앱에 적용되지 않습니다.']:body.surface==='orca-worktree'?['Orca 플로팅 전환: selector_not_found']:[],
      ...(body.action==='start-workroom-session'?{session:{id:'ops-session-1234',targetId:profile.projectId,agent:body.agent}}:{})}});
    }
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,profile,proposals,connections:[{agent:'codex',state:'configured',profiles:1,message:'설정 연결됨'}],controls:[],...(action==='review'?{backup:{backedUp:false,reason:'not-configured'}}:{})})});
   }
   if(u.pathname==='/api/control-center/create'){
    savedPorts=[{id:'control-project-id',name:'AgentsToZ-Control',folderPath:'/fixture/projects/AgentsToZ-Control'}];
    return route.fulfill({status:201,contentType:'application/json',body:JSON.stringify({success:true,performed:true,effect:'created-control-center',project:{projectId:'control-project-id',projectName:'AgentsToZ-Control',memoryId:'11111111-1111-4111-8111-111111111111'}})});
   }
   if(u.pathname==='/api/ports/merge'){savedPorts=JSON.parse(req.postData()).ports;return route.fulfill({status:200,contentType:'application/json',body:'{"success":true}'});}
   const values={
    '/api/onboarding/progress':{success:true,progress:{schemaVersion:1,recipeVersion:1,revision:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',runId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',platform:'mac',steps:[{tool:'codex',state:'configured',checkedAt:new Date().toISOString()}],operation:null,updatedAt:new Date().toISOString()}},
    '/api/ports':savedPorts, '/api/portal':{}, '/api/workspace-roots':[{id:'fixture-root',name:'테스트 작업 폴더',path:'/fixture/projects'}],
    '/api/portal/safety-lease/acquire':{success:true,token:'a'.repeat(64),metadata:{},fingerprint:portalLocalMetadataFingerprint({}),expiresInMs:30000},
    '/api/portal/safety-lease/release':{released:true},
    '/api/health':{status:'ok'}, '/api/onboarding/status':{stage:'fresh'},
    '/api/agentstoz-use/workroom-navigation':{success:true,navigation},
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
 assert.equal(await profileEntry.innerText(),'AgentsToZ OPS · 운영 프로필');
 await profileEntry.click();
 const profilePanel=page.getByTestId('control-profile-panel');await profilePanel.waitFor();
 await profilePanel.getByRole('heading',{name:'AgentsToZ OPS · 운영 프로필',exact:true}).waitFor();
 assert.equal(calls.some(c=>c.path==='/api/control-profile/prepare'),false,'Opening OPS must remain read-only');
 await profilePanel.getByRole('button',{name:'AgentsToZ OPS 닫기',exact:true}).click();
 await profilePanel.waitFor({state:'hidden'});
 await page.getByText('도구 및 설정',{exact:true}).click();
 const shortcut=page.getByTestId('control-center-project-shortcut');
 await shortcut.locator('summary').click();
 await shortcut.getByRole('button',{name:'다른 Mac의 AgentsToZ OPS 복원',exact:true}).click();
 await dialog.waitFor();
 assert.equal(await dialog.getByRole('checkbox',{name:/처음부터 프로젝트 장기기억/}).isChecked(),true);
 assert.equal(await dialog.getByRole('checkbox',{name:/Supabase 백업/}).isChecked(),true);
 assert.equal(calls.some(c=>c.path==='/api/control-center/create'),false,'Choosing restore must not create a new Control');
 await dialog.getByRole('button').first().click();
 await dialog.waitFor({state:'hidden'});
 await page.getByText('도구 및 설정',{exact:true}).click();
 await page.locator('[data-help-key="btn-setup-wizard"]').click();
 await page.getByRole('heading',{name:'내 기기와 연결',exact:true}).waitFor();
 await page.getByRole('button',{name:'첫 워크룸 열기',exact:true}).click();
 await page.getByTestId('ai-terminal-panel').waitFor();
 assert.equal(await page.locator('[data-top-level-tab="terminal"]').getAttribute('aria-selected'),'true');
 assert.equal(calls.some(c=>/agent-runtime.*(?:start|turn)/.test(c.path)),false);
 savedPorts=[];await page.reload();
 assert.equal(await page.getByTestId('onboarding-create-control').innerText(),'내 AgentsToZ OPS 준비');
 await page.getByTestId('onboarding-create-control').click();
 await profilePanel.waitFor();
 await profilePanel.getByRole('heading',{name:'AgentsToZ OPS · 운영 프로필',exact:true}).waitFor();
 assert.equal(calls.some(c=>c.path==='/api/control-center/create'),false);
 await profilePanel.getByRole('button',{name:'OPS 준비·연결 다시 확인',exact:true}).click();
 await profilePanel.getByText('운영 기억 연결됨',{exact:true}).waitFor();assert.equal(savedPorts.length,0,'Global profile must not create a project');
 const prepare=calls.filter(c=>c.path==='/api/control-profile/prepare');
 assert.equal(prepare.length,1);assert.deepEqual(JSON.parse(prepare[0].body),{});
 await profilePanel.getByText(profile.memoryId,{exact:true}).waitFor();
 assert.equal(await profilePanel.getByRole('button',{name:'OPS를 Codex 앱으로 열기',exact:true}).isDisabled(),true);
 await profilePanel.getByText(/로컬 전용 OPS는 패널·기억 호출/).waitFor();
 assert.equal(profile.displayName,'AgentsToZ','Display copy must not rewrite the stored profile identity');
 await profilePanel.getByText('관제 방식: AgentsToZ OPS 기본 운영',{exact:true}).waitFor();
 assert.equal(calls.some(c=>c.path==='/api/control-profile/policy'),false,'OPS display does not offer a CS-CEO policy write');
 proposals=[{id:'candidate-1',title:'프로젝트 운영 결정',body:'각 프로젝트의 구현 기억을 구분한다.',evidence:'사용자 요청',state:'pending',baseRevision:'revision-1'}];
 await profilePanel.getByRole('button',{name:'상태 다시 확인',exact:true}).click();
 await profilePanel.getByText('프로젝트 운영 결정',{exact:true}).waitFor();
 assert.equal(calls.some(c=>c.path==='/api/control-profile/review'),false,'A visible candidate is not a saved memory');
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
 await profilePanel.getByRole('button',{name:'워크룸으로 이동',exact:true}).click();
 await profilePanel.waitFor({state:'hidden'});
 await page.getByTestId('ai-terminal-panel').waitFor();
 await page.locator('[data-top-level-tab="memory"]').click();
 await page.getByRole('button',{name:'AgentsToZ OPS · 운영 기억 확인',exact:true}).click();
 await profilePanel.getByRole('heading',{name:'AgentsToZ OPS · 운영 프로필',exact:true}).waitFor();
 await profilePanel.getByText(profile.memoryId,{exact:true}).waitFor();
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
 for(const [id,role] of [['ops-bound','ops'],['dev-project','dev'],['song-project','managed'],['unknown-project','unknown']]){
  await row(id).locator(`[data-project-role="${role}"]`).waitFor();
 }
 await page.getByTestId('project-role-filter-ops').click();
 await row('ops-bound').click();
 await page.locator('[data-testid="project-memory-role"][data-project-role="ops"]').waitFor();
 assert.equal(await page.getByTestId('sidebar-project-row').count(),1);
 const opsFolder='/fixture/projects/renamed-operations';
 assert.equal(calls.slice(roleCallStart).some(c=>c.path.startsWith('/api/project-memory/')&&c.body?.includes(opsFolder)),false,'OPS must not mount the generic memory editor');
 await page.getByTestId('project-memory-open-ops').click();
 await profilePanel.getByText(profile.memoryId,{exact:true}).waitFor();
 assert.equal(calls.filter(c=>c.path==='/api/control-profile/prepare').length,1,'Role navigation must not initialize or replace OPS');
 await profilePanel.getByRole('button',{name:'AgentsToZ OPS 닫기',exact:true}).click();
 for(const [id,role] of [['dev-project','dev'],['song-project','managed'],['unknown-project','unknown']]){
  await page.getByTestId(`project-role-filter-${role}`).click();
  await row(id).click();
  await page.locator(`[data-testid="project-memory-role"][data-project-role="${role}"]`).waitFor();
  assert.equal(await page.getByTestId('sidebar-project-row').count(),1);
 }
 for(const path of ['/fixture/projects/development','/fixture/projects/song-app']){
  assert.equal(calls.slice(roleCallStart).some(c=>c.path==='/api/project-memory/detect'&&c.body?.includes(path)),true,'DEV and managed must retain project memory: '+path);
 }
 assert.equal(calls.slice(roleCallStart).some(c=>c.path.startsWith('/api/project-memory/')&&c.body?.includes('/fixture/projects/unknown')),false,'Unknown roles must not fall through to project memory');
 assert.equal(JSON.stringify(savedPorts),roleBaseline,'Reading/filtering legacy rows must not migrate stored data');
 assert.equal(calls.slice(roleCallStart).some(c=>/project-memory\/(init|update|push|session-end)|control-profile\/(prepare|review)/.test(c.path)),false,'Role navigation must remain read-only');
 await page.getByTestId('project-role-filter-ops').click();await row('ops-bound').click();
 await page.locator('[data-testid="project-memory-role"][data-project-role="ops"]').waitFor();
 await page.locator('.workspace-project-detail').evaluate(async element=>{
  await Promise.all(element.getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{})));
 });
 await page.screenshot({path:'/tmp/agentstoz-project-roles.png',fullPage:true});
 // An unavailable identity must not quietly turn a renamed OPS folder into DEV.
 profileStatusUnavailable=true;const offlineCalls=calls.length;
 await page.reload();
 await page.getByTestId('project-role-filter-managed').click();
 await row('ops-bound').click();
 await page.locator('[data-testid="project-memory-role"][data-project-role="unknown"]').waitFor();
 assert.equal(calls.slice(offlineCalls).some(c=>c.path.startsWith('/api/project-memory/')&&c.body?.includes(opsFolder)),false);
 profileStatusUnavailable=false;
 await page.getByTestId('project-memory-open-ops').click();
 await profilePanel.getByRole('heading',{name:'AgentsToZ OPS · 운영 프로필',exact:true}).waitFor();
 await profilePanel.getByRole('button',{name:'AgentsToZ OPS 닫기',exact:true}).click();
 // The recovered OPS row no longer belongs to the previously selected managed filter.
 await page.getByTestId('project-role-filter-ops').click();
 await row('ops-bound').click();
 await page.locator('[data-testid="project-memory-role"][data-project-role="ops"]').waitFor();
 // Task C: reuse the navigation endpoint, then launch from the actual OPS panel.
 const launchBaseline=calls.length;
 navigation={nonce:'ops-focus-123',panel:'ops'};
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await profilePanel.waitFor();
 await profilePanel.getByRole('button',{name:'OPS를 Codex 앱으로 열기',exact:true}).waitFor();
 await profilePanel.getByLabel('OPS 실행 권한 우회 요청').check();
 await profilePanel.getByRole('button',{name:'OPS를 Codex 앱으로 열기',exact:true}).click();
 await page.getByText('권한 우회는 앱에 적용되지 않습니다.',{exact:false}).first().waitFor();
 const launchCalls=()=>calls.slice(launchBaseline).filter(c=>c.path==='/api/control-profile/open').map(c=>JSON.parse(c.body));
 assert.deepEqual(launchCalls()[0],{action:'open-code-app',expectedProfileId:profile.profileId,agent:'codex',surface:'app',bypass:true,mode:'reopen'});
 await profilePanel.getByLabel('OPS 실행 권한 우회 요청').uncheck();
 await profilePanel.getByLabel('OPS 실행 표면').selectOption('orca-worktree');
 await profilePanel.getByLabel('OPS 실행 AI').selectOption('agy');
 await profilePanel.getByRole('button',{name:'OPS를 Orca 워크트리로 열기',exact:true}).click();
 await page.getByText('Orca 플로팅 전환: selector_not_found',{exact:false}).first().waitFor();
 assert.deepEqual(launchCalls()[1],{action:'open-code-app',expectedProfileId:profile.profileId,agent:'agy',surface:'orca-worktree',bypass:false});
 await profilePanel.getByLabel('OPS 실행 표면').selectOption('workroom');
 await profilePanel.getByLabel('OPS 실행 AI').selectOption('hermes');
 await profilePanel.getByRole('button',{name:'OPS를 Workroom으로 열기',exact:true}).click();
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
