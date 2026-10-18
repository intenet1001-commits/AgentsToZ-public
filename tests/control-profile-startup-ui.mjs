/** Actual App cold start with an owned sidecar fixture. No live API, cloud, AI or profile writes. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import {portalLocalMetadataFingerprint} from '../src/portalLocalMetadata.ts';

const root=resolve(import.meta.dirname,'..'),scratch=await mkdtemp(join(tmpdir(),'agentstoz-profile-startup-'));
const ops={id:'fixture-bound-ops',name:'운영 폴더',folderPath:'/fixture/projects/renamed-operations',isRunning:false};
const managed={id:'fixture-managed',name:'일반 프로젝트',folderPath:'/fixture/projects/managed',role:'managed',isRunning:false};
const ports=[ops,managed],calls=[];
let sidecarReady=false,releasePorts;
const portsReady=new Promise(resolve=>{releasePorts=()=>{sidecarReady=true;resolve();};});
for(const key of Object.keys(process.env))if(key.startsWith('VITE_'))delete process.env[key];
process.env.VITE_SUPABASE_URL='https://workspace-fixture.supabase.co';
process.env.VITE_SUPABASE_ANON_KEY='fixture-anon-key';
let vite,browser;
try{
  vite=await createServer({configFile:join(root,'vite.config.ts'),root,envDir:scratch,cacheDir:join(scratch,'node_modules/.vite'),mode:'maintainer-test',logLevel:'warn',plugins:[{name:'owned-startup-api',configureServer(server){server.middlewares.use(async(req,res,next)=>{
    const path=new URL(req.url,'http://fixture').pathname;if(!path.startsWith('/api/'))return next();
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):undefined;
    calls.push({path,method:req.method,body,ready:sidecarReady});
    const send=(value,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
    if(path==='/api/ports'){await portsReady;return send(ports);}
    if(path==='/api/control-profile/status')return sidecarReady
      ?send({success:true,profile:{state:'ready',projectId:ops.id,profileId:'11111111-1111-4111-8111-111111111111',memoryId:'22222222-2222-4222-8222-222222222222',backend:'control-folder'}})
      :send({success:false,error:'fixture sidecar not ready'},503);
    if(path==='/api/common-memory/list')return send({success:true,groups:[],legacyPending:[],nextOffset:null});
    if(path==='/api/common-memory/catalog')return send({success:true,scopeId:'fixture-cloud-scope',sources:[],nextAfter:null});
    if(path==='/api/common-memory/updates')return send({success:true,scopeId:'fixture-cloud-scope',updates:[],nextOffset:null});
    const values={
      '/api/portal':{},'/api/workspace-roots':[{id:'fixture-root',name:'테스트 작업 폴더',path:'/fixture/projects'}],
      '/api/portal/safety-lease/acquire':{success:true,token:'a'.repeat(64),metadata:{},fingerprint:portalLocalMetadataFingerprint({}),expiresInMs:30000},
      '/api/portal/safety-lease/release':{released:true},'/api/health':{status:'ok'},'/api/onboarding/status':{stage:'ready'},
      '/api/ports/merge':{success:true},'/api/agentstoz-use/workroom-navigation':{success:true,navigation:null},
      '/api/sdk-project/catalog':{success:true,projects:[]},'/api/common-memory/project-names':{success:true,projects:[]},
      '/api/code-app-launch-options':{success:true,options:[]},
    };
    return Object.hasOwn(values,path)?send(values[path]):send({success:false,error:'Fixture API blocked'},503);
  });}}],server:{host:'127.0.0.1',port:0,strictPort:false,fs:{allow:[root,realpathSync(join(root,'node_modules')),scratch]},watch:{ignored:['**/.agentstoz/**']}}});
  await vite.listen();const address=vite.httpServer.address();assert.ok(address&&typeof address!=='string'&&address.port!==3001);
  const origin=`http://127.0.0.1:${address.port}`;
  browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'}),external=[],errors=[];
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==origin){external.push(url.origin);return route.abort();}return route.continue();});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/');await page.locator('[data-top-level-tab="ports"]').waitFor();
  await page.waitForTimeout(150); // React mounted while every ports read is still held.
  assert.ok(calls.some(call=>call.path==='/api/ports'),'The real App is waiting on its initial project read');
  releasePorts();
  const row=id=>page.locator(`[data-testid="sidebar-project-row"][data-project-id="${id}"]`);
  await row(ops.id).waitFor({timeout:15000});
  await row(ops.id).locator('[data-project-role="ops"]').waitFor({timeout:5000}).catch(error=>{
    throw new Error(`Cold start never bound the existing OPS after the sidecar became ready: ${JSON.stringify(calls.filter(call=>call.path==='/api/control-profile/status'))}`,{cause:error});
  });
  // The row also contains the new test-set button. Select the project label,
  // whose click opens this project, rather than the row's changing centre.
  await row(managed.id).getByText(managed.name,{exact:true}).first().click();
  await page.locator('[data-testid="project-memory-role"][data-project-role="managed"]').waitFor({timeout:5000});
  await page.locator('[data-top-level-tab="common-memory"]').click();
  const common=page.getByTestId('common-memory-panel');
  const recommend=common.getByRole('button',{name:'AI로 공통기억 추천받기',exact:true});await recommend.waitFor({timeout:5000});
  assert.equal(await recommend.isEnabled(),true,'The recovered existing OPS enables the common-memory draft entry');
  await common.getByTestId('common-memory-workroom-help').getByText('클라우드 원본을 주제별로 정리할 요청을 OPS 대화에 준비합니다.',{exact:false}).waitFor();
  const profileCalls=calls.filter(call=>call.path==='/api/control-profile/status');
  assert.equal(profileCalls.length,1,'Startup uses one status read after project readiness, without polling');
  assert.equal(profileCalls[0].ready,true,'Profile identity is not requested while the sidecar is starting');
  assert.equal(calls.some(call=>/^\/api\/control-profile\/(prepare|attach|review)|^\/api\/control-center\/create|^\/api\/project-memory\/(init|update|push|session-end)|^\/api\/agent-runtime\/terminals\/start|^\/api\/common-memory\/(manage|prepare-workroom)/.test(call.path)),false,'Cold start and UI inspection remain read-only');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log(JSON.stringify({passed:1,failed:0,surface:'actual App cold start',fixture:true,realAI:false,checks:['delayed-ports-readiness','existing-OPS-role-bound','managed-memory-editor-enabled','common-memory-OPS-entry-enabled','one-profile-read-no-polling','no-profile-creation-or-memory-write','no-external-traffic']},null,2));
}catch(error){console.error(error);process.exitCode=1;}
finally{releasePorts?.();await browser?.close();await vite?.close();await rm(scratch,{recursive:true,force:true});}
