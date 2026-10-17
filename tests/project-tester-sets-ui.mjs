/** Production project/folder page: both sets are visible, bounded reads only, desktop and mobile. */
import {chromium} from 'playwright';import assert from 'node:assert/strict';
import {join} from 'node:path';import {mkdirSync} from 'node:fs';
import {testerSetsFixture} from './fixtures/tester-sets.ts';import {portalLocalMetadataFingerprint} from '../src/portalLocalMetadata.ts';
const dist=process.argv[2];assert.ok(dist,'Pass an isolated Vite build directory');
const evidence=join(process.cwd(),'.agentstoz/maintainer/ui-evidence');mkdirSync(evidence,{recursive:true});
const project={id:'fixture-sets-project',name:'프로젝트 역할 구성',folderPath:'/fixture/projects/sets',role:'managed',isRunning:false};
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:req=>new Response(Bun.file(join(dist,new URL(req.url).pathname==='/'?'index.html':new URL(req.url).pathname)))});
const browser=await chromium.launch();
try{for(const width of [1440,390]){
 const page=await browser.newPage({viewport:{width,height:900},hasTouch:width===390});const requests=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const u=new URL(route.request().url());if(u.origin===`http://127.0.0.1:${server.port}`&&!u.pathname.startsWith('/api/'))return route.continue();
  const respond=data=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
  if(u.pathname==='/api/agent-runtime/tester'){
   const request=route.request().postDataJSON();requests.push(request);assert.equal(request.portId,project.id);
   if(request.operation==='sets')return respond({success:true,sets:testerSetsFixture});
   if(request.operation==='status')return respond({success:true,status:{installation:'ready',installedVersion:'1.7.0',availableVersion:'1.7.0',configurationRevision:'a'.repeat(64),projectRevision:'b'.repeat(64),profiles:[{id:'quick',checks:['permissions','journey'],configured:true}],defaultProfile:'quick',environmentReady:true,latest:null,active:null,freshness:'unknown',instructionsConnected:true,memoryLinked:false,limitations:[],targets:[{id:project.id,label:project.name}]}});
   throw Error('Viewing composition must not execute: '+request.operation);
  }
  const values={'/api/ports':[project],'/api/portal':{},'/api/workspace-roots':[],
   '/api/portal/safety-lease/acquire':{success:true,token:'a'.repeat(64),metadata:{},fingerprint:portalLocalMetadataFingerprint({}),expiresInMs:30000},'/api/portal/safety-lease/release':{released:true},
   '/api/control-profile/status':{success:true,profile:{state:'ready',projectId:'fixture-ops'}},'/api/onboarding/status':{stage:'ready'},'/api/health':{status:'ok'},'/api/check-port-status':{isRunning:false}};
  if(Object.hasOwn(values,u.pathname))return respond(values[u.pathname]);return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'fixture blocked'})});
 });
 await page.goto(`http://127.0.0.1:${server.port}`);
 const row=page.getByTestId('sidebar-project-row').filter({hasText:project.name});await row.waitFor({timeout:20000});
 await row.getByTestId('project-tester-sets-summary').getByRole('button',{name:/일반 2개 · 페르소나 2역할/}).waitFor();
 assert.ok(requests.every(r=>r.operation==='sets'));const before=requests.filter(r=>r.operation==='sets').length;
 // Click the row itself so mobile navigation is the same as ordinary project selection.
 await row.getByText(project.name,{exact:true}).click();
 const composition=page.getByTestId('project-tester-sets');await composition.waitFor();await composition.scrollIntoViewIfNeeded();await composition.getByTestId('tester-general-set').getByText('2개 검사',{exact:true}).waitFor();
 await composition.getByTestId('tester-persona-set').getByText('검사 구현 필요 1개',{exact:true}).waitFor();
 await composition.getByTestId('tester-sets-details').locator('summary').first().click();
 await composition.getByTestId('tester-set-role').filter({hasText:'증권사 직원'}).getByText('허용된 업무만 표시한다',{exact:false}).waitFor();
 await composition.scrollIntoViewIfNeeded();const box=await composition.boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=width+1,'Configuration cards fit viewport');
 assert.ok(requests.filter(r=>r.operation==='sets').length<=before+1,'Sidebar and detail reuse one read');
 await composition.getByTestId('tester-general-set').screenshot({path:join(evidence,`project-general-set-${width}.png`)});
 await composition.getByTestId('tester-persona-set').screenshot({path:join(evidence,`project-persona-set-${width}.png`)});
 await page.screenshot({path:join(evidence,`project-tester-sets-${width}.png`)});
 await composition.getByRole('button',{name:'구성 새로고침',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-testid="tester-general-set"]')?.textContent.includes('2개 검사'));
 assert.ok(requests.every(r=>['sets','status'].includes(r.operation)));assert.deepEqual(errors,[]);
 console.log(`project tester sets production UI ${width}px PASS`);await page.close();
}}finally{await browser.close();server.stop(true);}
