import {afterEach,expect,test} from 'bun:test';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {resolveAppDataDir} from '../src/appDataDir';
import {startTestApiServer} from './startTestApiServer';

const homes:string[]=[],children:Bun.Subprocess[]=[];
const CAP='c'.repeat(64),PATH='/api/agent-runtime/project-state',TARGET='project_state_fixture_1234';
afterEach(async()=>{for(const child of children.splice(0)){try{child.kill();}catch{}await child.exited.catch(()=>{});}for(const home of homes.splice(0))rmSync(home,{recursive:true,force:true});});
function git(cwd:string,...args:string[]){const result=Bun.spawnSync(['git',...args],{cwd,stdout:'pipe',stderr:'pipe'});if(result.exitCode!==0)throw Error(new TextDecoder().decode(result.stderr));return new TextDecoder().decode(result.stdout).trim();}
async function fixture(options:{threads?:boolean;batchOff?:boolean}={}){
 const home=mkdtempSync(join(tmpdir(),'project-state-api-'));homes.push(home);const root=join(home,'fixture');mkdirSync(root);
 git(root,'init','-q');git(root,'config','user.name','Fixture');git(root,'config','user.email','fixture@example.invalid');writeFileSync(join(root,'README.md'),'fixture\n');git(root,'add','.');git(root,'commit','-qm','fixture');
 const env:Record<string,string|undefined>={...process.env,HOME:home,APPDATA:join(home,'AppData','Roaming'),XDG_CONFIG_HOME:join(home,'.config'),NODE_ENV:'test',PORT:'9000',PORTMGR_ALLOWED_ORIGINS:'',PORTMGR_BUNDLED_SIDECAR:'1',PORTMGR_PARENT_PID:String(process.pid),PORTMGR_AGENT_RUNTIME_CAPABILITY:CAP,PORTMGR_REMOTE_CONTROL_CAPABILITY:'b'.repeat(64),PORTMGR_WHAT_I_SAID_CAPABILITY:'a'.repeat(64),AGENTSTOZ_SKIP_HERMES_SYNC:'1',...(options.batchOff?{AGENTSTOZ_READ_TOOL_BATCH_ENABLED:'0'}:{})};
 env.APP_DATA_DIR=resolveAppDataDir(process.platform,env,home);mkdirSync(env.APP_DATA_DIR,{recursive:true});const ports=join(env.APP_DATA_DIR,'ports.json');
 const rows=[{id:TARGET,name:'Fixture',role:'managed',folderPath:root}];writeFileSync(ports,JSON.stringify(rows));
 let entrypoint:string|undefined;
 if(options.threads){
  // Keep the production API/guard and service pipeline. Replace only provider effects
  // and the Keychain provider, so accepted-submission tests cannot touch real credentials.
  entrypoint=join(home,'thread-api-fixture.ts');
  writeFileSync(entrypoint,`import {WorkroomThreadService} from ${JSON.stringify(pathToFileURL(join(import.meta.dir,'../src/workroomThreadService.ts')).href)};
import {writeFileSync} from 'node:fs';
const original=WorkroomThreadService.prototype.perform;let starts=0,replies=0;
WorkroomThreadService.prototype.perform=async function(...args){
 const deps=(this as any).deps;deps.store.keys={read:async()=>Buffer.alloc(32,5),create:async()=>Buffer.alloc(32,5)};
 deps.inspect=()=>({state:'running',inputRevision:0});
 deps.start=async(id,targetId,agent,prompt)=>{writeFileSync(${JSON.stringify(join(home,'thread-effects.json'))},JSON.stringify({starts:++starts,replies}));return {written:true,session:{id:crypto.randomUUID(),targetId,agent,state:'running',createdAt:new Date().toISOString(),exitCode:null,cols:80,rows:24}};};
 deps.reply=async()=>{writeFileSync(${JSON.stringify(join(home,'thread-effects.json'))},JSON.stringify({starts,replies:++replies}));return {written:true};};
 return original.apply(this,args);
};
await import(${JSON.stringify(pathToFileURL(join(import.meta.dir,'../api-server.ts')).href)});`);
 }
 const {baseUrl,child}=await startTestApiServer({cwd:join(import.meta.dir,'..'),env,entrypoint});children.push(child);
 const call=async(body:unknown,options:{path?:string;method?:string;capability?:string|null;origin?:string;raw?:string;contentType?:string}={})=>{
  const headers:Record<string,string>={Origin:options.origin??'http://tauri.localhost','Content-Type':options.contentType??'application/json'};if(options.capability!==null)headers['X-AgentsToZ-Agent-Runtime-Capability']=options.capability??CAP;
  const method=options.method??'POST';const response=await fetch(baseUrl+(options.path??PATH),{method,headers,...(method==='GET'?{}:{body:options.raw??JSON.stringify(body)})});return {response,body:await response.json() as any};
 };
 return {home,root,ports,rows,appData:env.APP_DATA_DIR,baseUrl,call};
}
test('local production project-state route requires the exact runtime capability, method and origin',async()=>{
 const f=await fixture();const input={operation:'preview',targetId:TARGET};
 for(const capability of [null,'a'.repeat(64),'b'.repeat(64)])expect((await f.call(input,{capability})).response.status).toBe(403);
 expect((await f.call(input,{origin:'https://example.invalid'})).response.status).toBe(403);
 for(const path of [PATH+'?cwd=/tmp',PATH+'?',PATH+'/',PATH+'/preview'])expect((await f.call(input,{path})).response.status).toBeGreaterThanOrEqual(400);
 expect((await f.call(input,{method:'GET'})).response.status).toBe(403);
 const allowed=await f.call(input);expect(allowed.response.status).toBe(200);expect(allowed.body.success).toBe(true);
 expect(allowed.response.headers.get('cache-control')).toBe('private, no-store');expect(JSON.stringify(allowed.body)).not.toContain(f.home);
},30_000);
test('preview/prepare are bounded read-only observations and never accept a caller path or arbitrary operation',async()=>{
 const f=await fixture(),portsBefore=readFileSync(f.ports,'utf8'),gitBefore=git(f.root,'status','--porcelain');
 for(const body of [{operation:'preview',targetId:TARGET,folderPath:f.root},{operation:'preview',targetId:TARGET,owner:'local'},{operation:'execute',targetId:TARGET},{operation:'preview',targetId:TARGET,memoryQuery:''}])expect((await f.call(body)).response.status).toBeGreaterThanOrEqual(400);
 expect((await f.call({}, {raw:'x'.repeat(4097)})).response.status).toBe(413);
 expect((await f.call({}, {raw:'{bad json'})).response.status).toBe(400);
 expect((await f.call({}, {contentType:'text/plain'})).response.status).toBe(415);
 const preview=await f.call({operation:'preview',targetId:TARGET});expect(preview.response.status).toBe(200);
 const b=preview.body.bundle;expect(b.targetId).toBe(TARGET);expect(b.observations.map((o:any)=>o.id)).toEqual(['git','workroom','tester']);
 expect(b.observations.find((o:any)=>o.id==='git').availability).toBe('ready');expect(b.observations.find((o:any)=>o.id==='workroom').summary.join(' ')).toContain('No active Workroom');
 const prepared=await f.call({operation:'prepare',targetId:TARGET,bundleId:b.id,sections:['git']});expect(prepared.response.status).toBe(200);expect(prepared.body.prepared.text).toContain('<untrusted_project_state>');expect(prepared.body.prepared.selectionHash).toMatch(/^[a-f0-9]{64}$/);
 expect(Buffer.byteLength(JSON.stringify(preview.body))).toBeLessThanOrEqual(32768);expect(readFileSync(f.ports,'utf8')).toBe(portsBefore);expect(git(f.root,'status','--porcelain')).toBe(gitBefore);
 expect(existsSync(join(f.root,'.agent-memory'))).toBe(false);expect(existsSync(join(f.root,'.agentstoz'))).toBe(false);
},30_000);
test('fresh registry/role and checkout evidence invalidate a prepared bundle and reject OPS',async()=>{
 const f=await fixture(),preview=await f.call({operation:'preview',targetId:TARGET}),selection={operation:'prepare',targetId:TARGET,bundleId:preview.body.bundle.id,sections:['git']};
 writeFileSync(join(f.root,'README.md'),'changed\n');const stale=await f.call(selection);expect(stale.response.status).toBeGreaterThanOrEqual(400);expect(stale.body.code).toBe('PROJECT_STATE_INVALIDATED');
 writeFileSync(f.ports,JSON.stringify([{...f.rows[0],role:'ops'}]));expect((await f.call({operation:'preview',targetId:TARGET})).response.status).toBeGreaterThanOrEqual(400);
 writeFileSync(f.ports,'[]');expect((await f.call({operation:'preview',targetId:TARGET})).response.status).toBeGreaterThanOrEqual(400);
},30_000);
test('registered worktrees keep the exact checkout and cannot be swapped by a caller path',async()=>{
 const f=await fixture(),linked=join(f.home,'linked');git(f.root,'worktree','add','-q','-b','codex/state-fixture',linked);
 const response=await fetch(f.baseUrl+'/api/agent-runtime/targets',{headers:{Origin:'http://tauri.localhost','X-AgentsToZ-Agent-Runtime-Capability':CAP}});const inventory=await response.json() as any;
 const target=inventory.targets.find((t:any)=>t.scope==='worktree');expect(target).toBeDefined();
 const preview=await f.call({operation:'preview',targetId:target.targetId});expect(preview.response.status).toBe(200);expect(preview.body.bundle.observations[0].summary.join(' ')).toContain('codex/state-fixture');expect(JSON.stringify(preview.body)).not.toContain(linked);
 expect((await f.call({operation:'preview',targetId:target.targetId,rootPath:f.root})).response.status).toBeGreaterThanOrEqual(400);
},30_000);
test('local workspace submission refuses tampered selected text before creating a thread intent',async()=>{
 const f=await fixture(),preview=await f.call({operation:'preview',targetId:TARGET}),selection={targetId:TARGET,bundleId:preview.body.bundle.id,sections:['git']};
 const prepared=await f.call({operation:'prepare',...selection}),id=crypto.randomUUID();
 const result=await f.call({operation:'workspace',requestId:id,targetId:TARGET,workspace:{action:'workroom.threads.create',thread:{agent:'claude',text:'The selected summary was removed.',projectState:{bundleId:selection.bundleId,sections:selection.sections,selectionHash:prepared.body.prepared.selectionHash}}}},{path:'/api/agent-runtime/terminals'});
 expect(result.response.status).toBe(200);expect(result.body.threads.refusal.requestId).toBe(id);expect(result.body.threads.thread).toBeUndefined();expect(JSON.stringify(result.body)).not.toContain(f.root);
 const read=await f.call({operation:'workspace',requestId:crypto.randomUUID(),targetId:TARGET,workspace:{action:'workroom.threads.read',thread:{threadId:id}}},{path:'/api/agent-runtime/terminals'});expect(read.response.status).toBeGreaterThanOrEqual(400);
},30_000);
test('production create/reply use the actual guarded callbacks, refuse before admission and read duplicate receipts after invalidation',async()=>{
 const f=await fixture({threads:true}),preview=await f.call({operation:'preview',targetId:TARGET}),selection={targetId:TARGET,bundleId:preview.body.bundle.id,sections:['git']};
 const prepared=await f.call({operation:'prepare',...selection});expect(prepared.response.status).toBe(200);
 const proof={bundleId:selection.bundleId,sections:selection.sections,selectionHash:prepared.body.prepared.selectionHash},createId=crypto.randomUUID(),create={agent:'codex',text:'Inspect project.\n'+prepared.body.prepared.text,projectState:proof};
 const threadCall=(action:string,thread:unknown,requestId=crypto.randomUUID())=>f.call({operation:'workspace',requestId,targetId:TARGET,workspace:{action,thread}},{path:'/api/agent-runtime/terminals'});
 const created=await threadCall('workroom.threads.create',create,createId);expect(created.response.status).toBe(200);expect(created.body.threads.refusal).toBeUndefined();
 let current=created.body.threads.thread;
 for(let i=0;i<50&&current?.state!=='running';i++){await Bun.sleep(20);current=(await threadCall('workroom.threads.read',{threadId:createId})).body.threads.thread;}
 expect(current.state).toBe('running');
 const refusedId=crypto.randomUUID(),refused=await threadCall('workroom.threads.reply',{threadId:createId,expectedRevision:current.revision,text:'removed summary',projectState:proof},refusedId);
 expect(refused.response.status).toBe(200);expect(refused.body.threads.refusal.requestId).toBe(refusedId);
 const unchanged=(await threadCall('workroom.threads.read',{threadId:createId})).body.threads;expect(unchanged.thread.revision).toBe(current.revision);expect(unchanged.messages.some((m:any)=>m.id===refusedId)).toBe(false);
 const replyId=crypto.randomUUID(),reply={threadId:createId,expectedRevision:current.revision,text:'Follow up.\n'+prepared.body.prepared.text,projectState:proof};
 const replied=await threadCall('workroom.threads.reply',reply,replyId);expect(replied.response.status).toBe(200);expect(replied.body.threads.refusal).toBeUndefined();
 expect(JSON.parse(readFileSync(join(f.home,'thread-effects.json'),'utf8'))).toEqual({starts:1,replies:1});
 writeFileSync(join(f.root,'README.md'),'source changed after accepted sends\n');
 const duplicateCreate=await threadCall('workroom.threads.create',create,createId),duplicateReply=await threadCall('workroom.threads.reply',reply,replyId);
 expect(duplicateCreate.response.status).toBe(200);expect(duplicateCreate.body.threads.thread.id).toBe(createId);expect(duplicateReply.response.status).toBe(200);expect(duplicateReply.body.threads.messages.some((m:any)=>m.id===replyId)).toBe(true);
 expect(JSON.parse(readFileSync(join(f.home,'thread-effects.json'),'utf8'))).toEqual({starts:1,replies:1});
 const staleId=crypto.randomUUID(),stale=await threadCall('workroom.threads.create',create,staleId);expect(stale.response.status).toBe(200);expect(stale.body.threads.refusal.requestId).toBe(staleId);
 const absent=await threadCall('workroom.threads.read',{threadId:staleId});expect(absent.response.status).toBeGreaterThanOrEqual(400);
},45_000);
test('the host kill switch refuses new P2 starts while P1 preview stays available',async()=>{
 const f=await fixture({batchOff:true}),ref={targetId:TARGET,threadId:'no-thread-needed',requestId:'gated-request'};
 const gated=await f.call({operation:'batch.start',...ref,plan:{steps:[{id:'git',input:{operation:'project.git.read'}}]}});
 expect(gated.response.status).toBe(503);expect(gated.body.code).toBe('READ_TOOL_DISABLED');
 expect((await f.call({operation:'preview',targetId:TARGET})).response.status).toBe(200);
},30_000);
test('P2 batch start/read/cancel run on an exact existing DEV thread through the production route',async()=>{
 const f=await fixture({threads:true}),gitBefore=git(f.root,'status','--porcelain'),threadId=crypto.randomUUID();
 const threadCall=(action:string,thread:unknown,requestId=crypto.randomUUID())=>f.call({operation:'workspace',requestId,targetId:TARGET,workspace:{action,thread}},{path:'/api/agent-runtime/terminals'});
 expect((await threadCall('workroom.threads.create',{agent:'codex',text:'Inspect project.'},threadId)).response.status).toBe(200);
 const plan={steps:[{id:'git',input:{operation:'project.git.read'}},{id:'workroom',input:{operation:'workroom.status.read'}}]};
 const ref={targetId:TARGET,threadId,requestId:crypto.randomUUID()};
 const started=await f.call({operation:'batch.start',...ref,plan});
 expect(started.response.status).toBe(200);expect(started.body.success).toBe(true);
 expect(started.body.batch).toMatchObject({threadId,requestId:ref.requestId,targetId:TARGET,owner:'local',payload:'unavailable'});
 expect(started.body.payload).toBe('available');expect(started.body.result.outputs.map((o:any)=>o.stepId).sort()).toEqual(['git','workroom']);
 expect(started.body.result.outputs.find((o:any)=>o.stepId==='git').observation.availability).toBe('ready');
 const wire=JSON.stringify(started.body);expect(wire).not.toContain(f.home);expect(Buffer.byteLength(wire)).toBeLessThanOrEqual(32768);
 // The original request ID reads the same receipt; a duplicate start never replays sources.
 const read=await f.call({operation:'batch.read',...ref});expect(read.response.status).toBe(200);expect(read.body.batch.runId).toBe(started.body.batch.runId);
 const duplicate=await f.call({operation:'batch.start',...ref,plan});expect(duplicate.body.batch.runId).toBe(started.body.batch.runId);expect(duplicate.body.batch.revision).toBe(read.body.batch.revision);
 const changed=await f.call({operation:'batch.start',...ref,plan:{steps:[{id:'git',input:{operation:'project.git.read',pathsLimit:1}}]}});expect(changed.response.status).toBe(409);
 const cancelled=await f.call({operation:'batch.cancel',...ref});expect(cancelled.response.status).toBe(200);expect(cancelled.body.batch.state).toBe(started.body.batch.state);
 for(const body of [{operation:'batch.read',...ref,threadId:'foreign-thread'},{operation:'batch.read',...ref,path:f.root},{operation:'batch.read',...ref,targetId:'other_target_1234'}])expect((await f.call(body)).response.status).toBeGreaterThanOrEqual(400);
 expect(git(f.root,'status','--porcelain')).toBe(gitBefore);expect(existsSync(join(f.root,'.agent-memory'))).toBe(false);expect(existsSync(join(f.root,'.agentstoz'))).toBe(false);
},45_000);
