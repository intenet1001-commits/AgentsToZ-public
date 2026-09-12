import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {portalLocalMetadataFingerprint} from '../src/portalLocalMetadata.ts';
const dist=process.argv[2];if(!dist)throw new Error('Pass an isolated Vite build directory');
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:req=>{const path=new URL(req.url).pathname;return new Response(Bun.file(join(dist,path==='/'?'index.html':path)));}});
let browser, savedPorts=[];
try{
 browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1100,height:850}}),errors=[],calls=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const req=route.request(),u=new URL(req.url());
  if(u.pathname.startsWith('/api/')||u.hostname!=='127.0.0.1'){
   calls.push({path:u.pathname,method:req.method(),body:req.postData()});
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
 await page.locator('[data-help-key="btn-setup-wizard"]').click();
 await page.getByRole('button',{name:'AI 연결 준비하기',exact:true}).click();
 await page.getByRole('button',{name:'첫 AI 작업 열기',exact:true}).click();
 await page.getByText('Codex 첫 응답 확인',{exact:true}).waitFor();
 assert.equal(await page.getByRole('tab',{name:'대화',exact:true}).getAttribute('aria-selected'),'true');
 assert.equal(calls.some(c=>/agent-runtime.*(?:start|turn)/.test(c.path)),false);
 savedPorts=[];await page.reload();
 await page.getByRole('button',{name:'내 Control 자동 만들기',exact:true}).click();
 await page.getByText('AgentsToZ-Control',{exact:true}).first().waitFor();
 const controlCreate=calls.find(c=>c.path==='/api/control-center/create'&&c.method==='POST');
 assert.deepEqual(JSON.parse(controlCreate?.body??'{}'),{workspaceRootId:'fixture-root'});
 assert.deepEqual(errors,[]);
 await page.screenshot({path:'/tmp/onboarding-first-project-app.png',fullPage:true});
 console.log('PASS: actual App → onboarding project flow and one-click Control creation; Git readback and first-task navigation remain safe');
}finally{await browser?.close();server.stop(true);}
