import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {portalLocalMetadataFingerprint} from '../src/portalLocalMetadata.ts';
const dist=process.argv[2];if(!dist)throw new Error('Pass an isolated Vite build directory');
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:req=>{const path=new URL(req.url).pathname;return new Response(Bun.file(join(dist,path==='/'?'index.html':path)));}});
let browser, savedPorts=[];
let profile={state:'unprepared',profileId:null,memoryId:null,displayName:'AgentsToZ',aliases:['agentstoz','아젠투지','에이전츠투지'],projectId:null,revision:null,lastSavedAt:null,problem:null,pendingCount:0,backend:null,coordinationPolicy:'agentstoz'};
let proposals=[];
try{
 browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1100,height:850}}),errors=[],calls=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const req=route.request(),u=new URL(req.url());
  if(u.pathname.startsWith('/api/')||u.hostname!=='127.0.0.1'){
   calls.push({path:u.pathname,method:req.method(),body:req.postData()});
   if(u.pathname.startsWith('/api/control-profile/')){
    const action=u.pathname.split('/').at(-1);
    if(action==='prepare')profile={...profile,state:'ready',profileId:'11111111-1111-4111-8111-111111111111',memoryId:'22222222-2222-4222-8222-222222222222',revision:'revision-1',backend:'app-data'};
    if(action==='policy')profile={...profile,coordinationPolicy:JSON.parse(req.postData()).policy};
    if(action==='review'){proposals=[];profile={...profile,pendingCount:0,lastSavedAt:'2026-09-14T00:00:00Z',revision:'revision-2'};}
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
 const shortcut=page.getByTestId('control-center-project-shortcut');
 await shortcut.locator('summary').click();
 await shortcut.getByRole('button',{name:'다른 Mac의 Control 복원',exact:true}).click();
 await dialog.waitFor();
 assert.equal(await dialog.getByRole('checkbox',{name:/처음부터 프로젝트 장기기억/}).isChecked(),true);
 assert.equal(await dialog.getByRole('checkbox',{name:/Supabase 백업/}).isChecked(),true);
 assert.equal(calls.some(c=>c.path==='/api/control-center/create'),false,'Choosing restore must not create a new Control');
 await dialog.getByRole('button').first().click();
 await dialog.waitFor({state:'hidden'});
 await page.getByText('도구 및 설정',{exact:true}).click();
 await page.locator('[data-help-key="btn-setup-wizard"]').click();
 await page.getByRole('heading',{name:'내 기기와 연결',exact:true}).waitFor();
 await page.getByRole('button',{name:'첫 AI 작업 열기',exact:true}).click();
 await page.getByText('Codex 첫 응답 확인',{exact:true}).waitFor();
 assert.equal(await page.getByRole('tab',{name:'대화',exact:true}).getAttribute('aria-selected'),'true');
 assert.equal(calls.some(c=>/agent-runtime.*(?:start|turn)/.test(c.path)),false);
 savedPorts=[];await page.reload();
 await page.getByRole('button',{name:'내 운영 프로필 준비',exact:true}).click();
 const profilePanel=page.getByTestId('control-profile-panel');await profilePanel.waitFor();
 assert.equal(calls.some(c=>c.path==='/api/control-center/create'),false);
 await profilePanel.getByRole('button',{name:'프로필 준비·연결 다시 확인',exact:true}).click();
 await profilePanel.getByText('운영 기억 연결됨',{exact:true}).waitFor();assert.equal(savedPorts.length,0,'Global profile must not create a project');
 await profilePanel.getByLabel('관제 방식').selectOption('cs-ceo');
 await page.waitForFunction(()=>document.querySelector('[aria-labelledby="control-profile-title"] select')?.value==='cs-ceo');
 proposals=[{id:'candidate-1',title:'프로젝트 운영 결정',body:'각 프로젝트의 구현 기억을 구분한다.',evidence:'사용자 요청',state:'pending',baseRevision:'revision-1'}];
 await profilePanel.getByRole('button',{name:'상태 다시 확인',exact:true}).click();
 await profilePanel.getByText('프로젝트 운영 결정',{exact:true}).waitFor();
 await profilePanel.getByRole('button',{name:'운영 기억에 저장',exact:true}).click();
 await profilePanel.getByText('운영 기억은 로컬에 저장했습니다. 원격 백업 상태는 별도 확인이 필요합니다.',{exact:true}).waitFor();
 assert.equal(calls.filter(c=>c.path==='/api/control-profile/review').length,1);
 await page.screenshot({path:'/tmp/control-profile-panel.png',fullPage:true});
 await profilePanel.getByRole('button',{name:'AI 작업으로 이동',exact:true}).click();
 await profilePanel.waitFor({state:'hidden'});
 await page.getByText('AgentsToZ · 나의 관제',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);
 await page.screenshot({path:'/tmp/onboarding-first-project-app.png',fullPage:true});
 console.log('PASS: actual App → onboarding project flow and rootless operating profile preparation, policy and memory review; Git readback and first-task navigation remain safe');
}finally{await browser?.close();server.stop(true);}
