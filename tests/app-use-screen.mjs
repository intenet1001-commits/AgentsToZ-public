// Real directory/setup/USE forms, host and encrypted receipts; synthetic product operations only.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'vite';
import {chromium,webkit} from 'playwright';
import {ServiceUseHost} from '../src/serviceUseHost.ts';
import {WorkroomThreadStore} from '../src/workroomThreadStore.ts';
import {WorkroomThreadService} from '../src/workroomThreadService.ts';
import {ensureServiceMemory,migrateServiceMemoryToProject} from '../src/serviceMemory.ts';
import {prepareServiceUseWorkroom} from '../src/serviceUsePreparation.ts';
const root=resolve(import.meta.dirname,'..'),scratch=realpathSync(mkdtempSync(join(tmpdir(),'generic-use-screen-')));
for(const key of Object.keys(process.env))if(key.startsWith('VITE_'))delete process.env[key];
process.env.VITE_SUPABASE_URL='https://app-use-fixture.supabase.co';process.env.VITE_SUPABASE_ANON_KEY='fixture-anon-key';
const keys={read:async()=>Buffer.alloc(32,4),create:async()=>Buffer.alloc(32,4)};
const projects=new Map(),connected=new Set(),effects=[],requests=[];let terminalStarts=0,vite,threads;
for(const engine of ['webkit','chromium'])for(const kind of ['reports','bookings']){
 const id=engine+'-'+kind+'-project',canonicalPath=join(scratch,id);mkdirSync(canonicalPath);
 projects.set(id,{projectId:id,projectName:kind==='reports'?'Report Desk':'Booking Desk',memoryId:'dev-'+id,canonicalPath});
}
const host=new ServiceUseHost({appDataDir:scratch,receipts:new WorkroomThreadStore(join(scratch,'receipts'),keys),resolve:async id=>{assert.ok(projects.has(id));return projects.get(id);},adapter:async id=>{
 if(!connected.has(id))return undefined;
 return {projectId:id,serviceKey:'default',definitionRevision:'fixture-app-v1',tools:['app.invoke'],actions:[{id:id.includes('reports')?'report.create':'booking.lookup',label:id.includes('reports')?'보고서 만들기':'예약 확인',effect:id.includes('reports')?'write':'read',fields:[{key:'subject',label:'주제',type:'string',required:true}]}],
 scope:async()=>({principalId:'fixture-user',libraryId:id,deviceId:'fixture-device',installationId:'fixture-install',grantRevision:'fixture-grant'}),
 execute:async(call,requestId)=>{effects.push({id,call,requestId});return {state:'completed',message:'선택한 앱의 실제 테스트 동작 완료',operationId:requestId};}};
}});
try{
 threads=new WorkroomThreadService({store:new WorkroomThreadStore(join(scratch,'threads'),keys),use:host,resolve:async id=>({fingerprint:id}),inspect:()=>({state:'running',inputRevision:0}),start:async()=>{terminalStarts++;throw Error('Unexpected DEV start');},reply:async()=>{throw Error('Unexpected DEV instruction');}});
 vite=await createServer({configFile:join(root,'vite.config.ts'),root,envDir:scratch,cacheDir:join(scratch,'node_modules/.vite'),mode:'maintainer-test',logLevel:'error',plugins:[{name:'app-use-fixture',configureServer(server){server.middlewares.use(async(req,res,next)=>{
 if(!req.url?.startsWith('/api/')&&req.url!=='/__threads')return next();
 try{
 let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};requests.push({path:req.url,body});let result;
 if(req.url==='/__threads')result={kind:'workspace',action:body.workspace.action,threads:await threads.perform(body.workspace.action,body.workspace.thread,body.targetId,body.requestId,{owner:'local',active:()=>true,readAll:false})};
 else if(req.url.startsWith('/api/service-memory/')){
 const p=projects.get(body.portId);assert.ok(p);
 if(req.url.endsWith('/prepare-workroom'))result={success:true,...prepareServiceUseWorkroom(p,body.goal)};
 else{
 if(req.url.endsWith('/connect-app')){assert.equal(body.consent,true);if(body.connectionCode!=='ATZUSE1.fixture-code')throw Error('앱 연결 코드를 확인하세요.');connected.add(p.projectId);}
 if(req.url.endsWith('/prepare-use-memory')){assert.equal(body.consent,true);ensureServiceMemory(scratch,{projectId:p.projectId,projectName:p.projectName,projectMemoryId:p.memoryId,canonicalPath:p.canonicalPath,displayName:p.projectName});migrateServiceMemoryToProject(scratch,{projectId:p.projectId,projectMemoryId:p.memoryId});}
 if(req.url.endsWith('/enable-use'))await host.enable(p.projectId);
 result={success:true,...await host.status(p.projectId,'local')};
 }
 }else if(req.url==='/api/agent-runtime/terminals'){assert.equal(body.operation,'list');result={sessions:[]};}
 else if(req.url.startsWith('/api/agent-runtime/targets'))result={protocolVersion:'agentstoz-tasks-v2',complete:true,targets:[...projects.values()].map(p=>({targetId:p.projectId,projectTargetId:p.projectId,label:p.projectName,scope:'main',branch:null,locked:false,worktreeCapable:false}))};
 else if(req.url==='/api/agent-dialogue/control'&&body.operation==='devices')result={success:true,inside:true,deviceId:'fixture-device',devices:[],unread:0,lastMessageAt:null};
 else throw Error('Unmocked live API blocked');
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
 }catch(e){res.statusCode=400;res.end(JSON.stringify({success:false,error:e.message}));}
 });}}],server:{host:'127.0.0.1',port:0,strictPort:false,fs:{allow:[root,realpathSync(join(root,'node_modules')),scratch]},watch:{ignored:['**/.agentstoz/**']}}});
 await vite.listen();const origin='http://127.0.0.1:'+vite.httpServer.address().port;
 const setup=await fetch(origin+'/src/ServiceUseSetupDialog.tsx').then(r=>r.text()),main=await fetch(origin+'/src/main.tsx').then(r=>r.text());
 const react=setup.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1],dom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];assert.ok(react&&dom);
 for(const [engineName,engine] of Object.entries({webkit,chromium})){
 const browser=await engine.launch();try{
 const context=await browser.newContext({viewport:{width:402,height:874},isMobile:true,hasTouch:true,serviceWorkers:'block'});try{
 const id=engineName+'-reports-project',other=engineName+'-bookings-project';
 const html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">
 import R from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(dom)};R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;
 import '/src/index.css';const {default:Setup}=await import('/src/ServiceUseSetupDialog.tsx');const {WorkroomSessionDirectory}=await import('/src/WorkroomSessionDirectory.tsx');const {CommunityWorkspace}=await import('/src/CommunityWorkspace.tsx');
 const projects=[{id:${JSON.stringify(id)},name:'Report Desk',folderPath:'fixture'},{id:${JSON.stringify(other)},name:'Booking Desk',folderPath:'fixture'}];
 const transport=async r=>{const reply=await fetch('/__threads',{method:'POST',body:JSON.stringify(r)});const value=await reply.json();if(!reply.ok)throw Error(value.error);return value;};
 function App(){const [open,setOpen]=React.useState(false),[prepared,setPrepared]=React.useState(false),[use,setUse]=React.useState(false);return use?React.createElement(CommunityWorkspace,{channels:[{id:'local',label:'테스트 Mac',projects:async()=>projects.map(p=>({targetId:p.id,label:p.name,useServices:['default']})),transport}],onOpenWorkroom:()=>{throw Error('Unexpected DEV open');}}):React.createElement(React.Fragment,null,
 React.createElement(WorkroomSessionDirectory,{projects:projects.map(p=>({targetId:p.id,label:p.name})),onPrepareUse:()=>setOpen(true),visible:true}),prepared&&React.createElement('p',{role:'status'},'워크룸 준비 요청 확인'),prepared&&React.createElement('button',{onClick:()=>setUse(true)},'앱 기능 사용'),open&&React.createElement(Setup,{projects,initialProjectId:${JSON.stringify(id)},onWorkroom:(targetId,title,prompt)=>{window.prepared={targetId,title,prompt};setPrepared(true);},onClose:()=>setOpen(false)}));}
 const root=ReactDOM.createRoot(document.getElementById('root'));root.render(React.createElement(App));
 // A phone or another Mac's channel: USE runs only for this Mac's local owner, so it is not offered there.
 window.renderPeerChannel=()=>root.render(React.createElement(CommunityWorkspace,{channels:[{id:'peer',label:'다른 기기',productUse:false,projects:async()=>projects.map(p=>({targetId:p.id,label:p.name,useServices:['default']})),transport}],onOpenWorkroom:()=>{}}));</script>`;
 await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();return url.pathname==='/__app-use'?route.fulfill({contentType:'text/html',body:html}):route.continue();});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(20000);await page.goto(origin+'/__app-use');
 await page.getByRole('button',{name:'USE 준비',exact:true}).click();await page.getByTestId('service-use-readiness').waitFor();
 await page.getByLabel('USE로 할 일').fill('주간 보고서를 만들어 사용할 수 있게 연결');await page.getByRole('button',{name:'워크룸에서 USE 연결 준비',exact:true}).click();
 await page.getByText('워크룸 준비 요청 확인',{exact:true}).waitFor();const prepared=await page.evaluate(()=>window.prepared);assert.equal(prepared.targetId,id);assert.ok(prepared.prompt.includes('주간 보고서'));assert.equal(terminalStarts,0);assert.equal((await host.status(id,'local')).readiness.enabled,false);
 await page.getByRole('button',{name:'USE 준비',exact:true}).click();await page.getByTestId('service-use-readiness').waitFor();await page.getByLabel('Report Desk 운영 연결 코드').fill('ATZUSE1.fixture-code');await page.getByRole('button',{name:'이 Mac에 운영 도구 연결',exact:true}).click();await page.waitForFunction(()=>document.querySelector('input[aria-label="Report Desk 운영 연결 코드"]').value==='');
 await page.getByRole('button',{name:'프로젝트 USE 운영기억 준비·활성화',exact:true}).click();await page.getByRole('button',{name:'USE 활성화됨',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>Object.values(localStorage).concat(Object.values(sessionStorage)).join('').includes('ATZUSE1.fixture-code')),false);
 await page.getByRole('button',{name:'USE 준비 닫기',exact:true}).click();await page.getByRole('button',{name:'앱 기능 사용',exact:true}).click();
 await page.getByLabel('기준 프로젝트').selectOption('use:'+id+':default');await page.getByLabel('USE 앱 동작').waitFor();assert.equal(await page.getByLabel('USE 운영 도구').locator('option').count(),1);assert.equal(await page.getByLabel('USE 앱 동작').inputValue(),'report.create');assert.equal(await page.getByText('승인된 폰에 전달',{exact:true}).count(),0);
 assert.equal(await page.getByTestId('project-state-tools').count(),0);
 // A generic app action has no material or request IDs, so the form does not point at them.
 assert.equal(await page.getByText('자료 ID와 요청 ID는',{exact:false}).count(),0);
 // The action's own fields carry the request; the memo is optional and an empty one records the action label.
 await page.getByLabel('USE 주제').fill('이번 주 학습 결과');assert.equal(await page.getByLabel('USE 메모 (선택)').inputValue(),'');assert.ok(await page.getByRole('button',{name:'업무 맡기기',exact:true}).isEnabled());
 await page.getByRole('button',{name:'업무 맡기기',exact:true}).click();await threads.idle();await page.getByRole('button',{name:'새로고침',exact:true}).click();await page.getByText('선택한 앱의 실제 테스트 동작 완료',{exact:true}).waitFor();
 assert.equal(await page.getByRole('heading',{name:'보고서 만들기',exact:true}).count(),1);
 await page.evaluate(()=>window.renderPeerChannel());await page.getByLabel('기준 프로젝트').waitFor();await page.getByLabel('프로젝트에 맡길 업무').waitFor();
 assert.deepEqual(await page.getByLabel('기준 프로젝트').locator('option').evaluateAll(o=>o.map(e=>e.value).filter(v=>v.startsWith('use:'))),[]);assert.equal(await page.getByLabel('업무 역할').count(),0);
 assert.equal(effects.filter(e=>e.id===id).length,1);assert.equal(effects.filter(e=>e.id===other).length,0);assert.equal(terminalStarts,0);assert.deepEqual(errors,[]);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=402));
 console.log(engineName+': Workroom USE preparation, generic connection and app-specific form passed; no live CLI or app');
 }finally{await context.close();}}finally{await browser.close();}
 }
}finally{await threads?.idle();await vite?.close();rmSync(scratch,{recursive:true,force:true});}
