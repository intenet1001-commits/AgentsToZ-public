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
 // 전수 클릭 카드(2026-11-01): 넓은 화면은 포트가 등록된 프로젝트로 켜기 → 기준선 만들기를, 좁은 화면은 포트 없이도 가능한 데스크톱 하네스 구성 안내를 본다.
 const at='2026-11-01T00:00:00.000Z';
 let sweep=width===390?{state:'none',engine:'absent',scopeVersion:2,surfaces:[],enableUrl:null}:{state:'none',engine:'absent',scopeVersion:2,surfaces:[],enableUrl:'http://127.0.0.1:9050/'};
 const sets=()=>({...testerSetsFixture,clickSweep:sweep});
 await page.route('**/*',async route=>{
  const u=new URL(route.request().url());if(u.origin===`http://127.0.0.1:${server.port}`&&!u.pathname.startsWith('/api/'))return route.continue();
  const respond=data=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
  if(u.pathname==='/api/agent-runtime/tester'){
   const request=route.request().postDataJSON();requests.push(request);assert.equal(request.portId,project.id);
   if(request.operation==='sets'){
    const answer=respond({success:true,sets:sets()});
    if(sweep.job?.state==='running')sweep={...sweep,surfaces:[{...sweep.surfaces[0],baselinePresent:true,last:{at,passed:true,state:'passed',completed:true,elements:12,clicked:12,failures:0,updated:true}}],job:{state:'passed',message:'요청한 하네스 실행을 마쳤습니다. 대상별 기준선과 결과 범위를 확인하세요.',at}};
    return answer;
   }
   if(request.operation==='sweep-enable'){assert.equal(sweep.enableUrl,'http://127.0.0.1:9050/','No 켜기 without a registered port');sweep={state:'configured',engine:'present',scopeVersion:2,surfaces:[{id:'web',label:'로컬 웹 화면',kind:'url',target:'web',environment:'browser',baselinePresent:false,last:null}]};return respond({success:true,sets:sets()});}
   if(request.operation==='sweep-baseline'){sweep={...sweep,job:{state:'running',message:'버튼을 하나씩 눌러 첫 기준선을 만드는 중입니다.',at}};return respond({success:true,sets:sets()});}
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
 assert.ok(requests.every(r=>['sets','status'].includes(r.operation)));
 const card=composition.getByTestId('tester-click-sweep-set');await card.scrollIntoViewIfNeeded();
 if(width===390){
  await card.getByText('구성 전',{exact:true}).waitFor();await card.getByText(/데스크톱 앱은 포트 없이 프로젝트 command 하네스로 구성/).waitFor();
  await card.getByTestId('tester-click-sweep-desktop-guide').locator('summary').click();await card.getByText(/실제 앱의 검사 도구·권한·클릭 절차는 프로젝트 하네스/).waitFor();
  assert.equal(await card.getByRole('button').count(),0,'No 켜기 without a port');
 }else{
  await card.getByText('구성 전',{exact:true}).waitFor();
  await card.getByRole('button',{name:'웹 켜기 · 127.0.0.1:9050',exact:true}).click();
  await card.getByText('1개 대상',{exact:true}).waitFor();await card.getByText(/기준선 필요 1개 — 웹 개발 서버를 켜 둔 채 만드세요/).waitFor();
  await card.getByRole('button',{name:'기준선 만들기',exact:true}).click();
  await card.getByRole('button',{name:'기준선 만드는 중…',exact:true}).waitFor();
  await card.getByText(/요청한 하네스 실행을 마쳤습니다/).waitFor({timeout:15000});await card.getByText('기준선 파일 1/1 · 대상별 결과는 아래에 표시합니다',{exact:true}).waitFor();
  assert.equal(await card.getByRole('button',{name:'기준선 만들기',exact:true}).count(),0,'The baseline button leaves once every surface has one');
  assert.deepEqual(requests.filter(r=>r.operation.startsWith('sweep')).map(r=>r.operation),['sweep-enable','sweep-baseline']);
 }
 // A web pass, a desktop fixture report, an unavailable native harness and an old unknown command stay distinct.
 sweep={state:'configured',engine:'present',scopeVersion:2,surfaces:[
  {id:'web',label:'웹 대상',kind:'url',target:'web',environment:'browser',baselinePresent:true,last:{at,passed:true,state:'passed',completed:true,elements:12,clicked:12,failures:0,updated:false}},
  {id:'fixture',label:'모의 데스크톱',kind:'command',target:'desktop',environment:'fixture',platform:'darwin',baselinePresent:true,last:{at,passed:true,state:'passed',completed:true,elements:2,clicked:2,failures:0,updated:false}},
  {id:'native',label:'네이티브 대상',kind:'command',target:'desktop',environment:'native',platform:'darwin',baselinePresent:false,last:{at,passed:false,state:'unavailable',completed:false,elements:0,clicked:0,failures:0,updated:false}},
  {id:'old',label:'옛 desktop 이름',kind:'command',target:'legacy',environment:'unknown',baselinePresent:true,last:{at,passed:true,elements:4,clicked:4,failures:0,updated:false}}
 ]};
 await composition.getByRole('button',{name:'구성 새로고침',exact:true}).click();
 const rows=card.getByTestId('tester-click-sweep-surface');await rows.filter({hasText:'웹 대상'}).getByText(/웹 통과/).waitFor();
 await rows.filter({hasText:'모의 데스크톱'}).getByText(/모의 하네스 통과/).waitFor();await rows.filter({hasText:'모의 데스크톱'}).getByText(/실제 앱 미검증/).waitFor();
 const native=rows.filter({hasText:'네이티브 대상'});await native.getByText(/실행 불가 · 통과 아님/).waitFor();
 assert.equal(await native.getByText(/하네스 보고 통과|웹 통과/).count(),0,'web/fixture results do not certify the native target');
 assert.equal(await native.getByText(/클릭 0회/).count(),0,'an unstarted native harness is not reported as a zero-click completed run');
 await rows.filter({hasText:'옛 desktop 이름'}).getByText(/대상 범위 미지정/).waitFor();
 // A custom/stored summary bypassing the canonical runner must not turn an empty or contradictory report into PASS.
 const validNative={...sweep.surfaces[2].last,passed:true,state:'passed',completed:true,elements:2,clicked:2,failures:0,updated:false};
 for(const [index,invalid] of [{elements:0},{elements:-1},{clicked:undefined},{state:'failed'}].entries()){
  const label=`네이티브 대상 · 손상 사례 ${index+1}`;
  sweep={...sweep,surfaces:sweep.surfaces.map(s=>s.id==='native'?{...s,label,last:{...validNative,...invalid}}:s)};
  await composition.getByRole('button',{name:'구성 새로고침',exact:true}).click();
  await native.getByText(`데스크톱 · ${label}`,{exact:true}).waitFor();
  await native.getByText(/^기록 확인 필요 · 미검증(?: ·|$)/).waitFor();
  assert.equal(await native.getByText(/하네스 보고 통과|대상 \d+개 · 클릭/).count(),0,'invalid completion evidence never displays PASS or normalized zero counts');
 }
 sweep={...sweep,surfaces:sweep.surfaces.map(s=>s.id==='native'?{...s,last:{...validNative,passed:false,state:'unavailable',completed:false,elements:0,clicked:0}}:s)};
 await composition.getByRole('button',{name:'구성 새로고침',exact:true}).click();await native.getByText(/실행 불가 · 통과 아님/).waitFor();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'independent scope rows fit both viewport sizes');
 await card.screenshot({path:join(evidence,`project-click-sweep-set-${width}.png`)});
 assert.deepEqual(errors,[]);
 console.log(`project tester sets production UI ${width}px PASS`);await page.close();
}}finally{await browser.close();server.stop(true);}
