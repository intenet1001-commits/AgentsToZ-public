import {afterEach,expect,test} from 'bun:test';
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ServiceUseHost,SERVICE_USE_ENVIRONMENT_PROBLEM,serviceUseConnectProblem,serviceUseEnvironmentProblem,type ServiceUseAdapter} from '../src/serviceUseHost';
import {normalizeServiceUseCall,parseServiceUseRequest,type ServiceUseCall,type ServiceUseOutcome} from '../src/serviceUseProtocol';
import {ensureServiceMemory,migrateServiceMemoryToProject} from '../src/serviceMemory';
import {WorkroomThreadStore} from '../src/workroomThreadStore';
import {USE_CHANGED_REPLY_TEXT,USE_UNKNOWN_RESULT_TEXT,WorkroomThreadService,useResultText} from '../src/workroomThreadService';
import {localUsePhones,localUsePhonesFor,serviceUseConnectRoute} from '../src/serviceUseLocalClient';
import {localWorkroomTransport} from '../src/aiTerminalClient';
import {serviceUseRequestText} from '../src/ServiceUseOperationFields';
import {normalizeWorkroomThreadResult} from '../src/workroomThreadProtocol';

const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const generate:ServiceUseCall={role:'use',serviceKey:'default',tool:'materials.generate',input:{text:'A short greeting.'}};
async function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'service-use-')));chmodSync(root,0o700);roots.push(root);
 const projectPath=join(root,'project');mkdirSync(projectPath);
 const identity={projectId:'project-use-fixture',projectMemoryId:'dev-memory',serviceKey:'default'};
 ensureServiceMemory(root,{...identity,projectName:'ShadowLoop',canonicalPath:projectPath,displayName:'ShadowLoop USE'});
 migrateServiceMemoryToProject(root,identity);
 const keys={read:async()=>Buffer.alloc(32,8),create:async()=>Buffer.alloc(32,8)};
 const receipts=new WorkroomThreadStore(join(root,'receipts'),keys);
 let active=true,calls=0,scope={principalId:'user-one',libraryId:'library-one',deviceId:'device-one',installationId:'install-one',grantRevision:'grant-one'};
 let execute:ServiceUseAdapter['execute']=async(_call,_id,_binding,isActive)=>{if(!isActive())throw Error('revoked');calls++;return {state:'completed',message:'Mac generation verified',materialId:'material-one',evidence:{generated:true,transferred:false,phoneReceived:false}};};
 const adapter:ServiceUseAdapter={projectId:identity.projectId,serviceKey:'default',definitionRevision:'fixture-verified-v1',tools:['materials.generate','materials.reuse','audio.prepare','operation.status','operation.cancel','phone.deliver'],scope:async()=>({...scope}),execute:(...args)=>execute(...args)};
 const resolve=async()=>({projectId:identity.projectId,projectName:'ShadowLoop',memoryId:identity.projectMemoryId,canonicalPath:projectPath});
 const host=()=>new ServiceUseHost({appDataDir:root,resolve,adapters:[adapter],receipts});
 const use=host();await use.enable(identity.projectId);
 const store=new WorkroomThreadStore(join(root,'threads'),keys);let devStarts=0,devWrites=0;
 const threadDeps={store,use,resolve:async()=>({fingerprint:'dev-folder'}),start:async()=>{devStarts++;throw Error('DEV terminal must not start');},reply:async()=>{devWrites++;return {written:true};},inspect:()=>({state:'running' as const,inputRevision:0})};
 const access={owner:'local',active:()=>active,readAll:false};const threads=new WorkroomThreadService(threadDeps);
 return {root,identity,adapter,receipts,use,host,store,threads,threadDeps,access,active:()=>active,calls:()=>calls,devStarts:()=>devStarts,devWrites:()=>devWrites,
  changeScope:(patch:Partial<typeof scope>)=>{scope={...scope,...patch};},revoke:()=>{active=false;},setExecute:(fn:typeof execute)=>{execute=fn;},resolve};
}
test('typed USE calls refuse shell, paths, extra fields and wrong operation schemas',()=>{
 expect(()=>normalizeServiceUseCall({...generate,tool:'shell'})).toThrow('DEV');
 expect(()=>normalizeServiceUseCall({...generate,input:{text:'hello',path:'/tmp/source'}})).toThrow();
 expect(()=>parseServiceUseRequest({operation:'receipt',requestId:'valid-request',call:generate})).toThrow();
 expect(()=>parseServiceUseRequest({operation:'execute',requestId:'valid-request',call:{...generate,role:'dev'}})).toThrow();
 expect(parseServiceUseRequest({operation:'status'})).toEqual({operation:'status',serviceKey:'default'});
});
test('mention discovery is read-only, requires activation, and never probes or executes the app',async()=>{
 const f=await fixture();f.adapter.scope=async()=>{throw Error('app must not be queried by mention discovery');};
 expect(await f.use.mentionServices(new Set([f.identity.projectId]))).toEqual(new Map([[f.identity.projectId,['default']]]));
 expect(await f.use.mentionServices(new Set(['another-project']))).toEqual(new Map());
 const reference=await f.use.reference(f.identity.projectId);
 expect(reference.sourcePath).toContain(join('project','.agent-memory-use','default'));
 writeFileSync(reference.sourcePath,'# USE memory\n\nREFERENCE_ONLY_USE is an operating preference.\n');
 const recalled=await f.use.recallReference(f.identity.projectId,'default','REFERENCE_ONLY_USE');
 expect(recalled.hits[0]?.body).toContain('REFERENCE_ONLY_USE');expect(recalled.memoryId).toBe(reference.memoryId);
 expect(f.calls()).toBe(0);expect(f.devStarts()).toBe(0);
 rmSync(join(f.root,'service-use','activation.v1.json'));
 expect(await f.use.mentionServices(new Set([f.identity.projectId]))).toEqual(new Map());
 await expect(f.use.reference(f.identity.projectId)).rejects.toThrow('활성화');
});
test('activation and memory do not make a ShadowLoop tool draft executable',async()=>{
 const f=await fixture(),draft=new ServiceUseHost({appDataDir:f.root,resolve:f.resolve});
 expect((await draft.status(f.identity.projectId,'local')).readiness).toMatchObject({enabled:true,memoryReady:true,tools:'draft',environmentReady:false,executionReady:false});
 await expect(draft.execute(f.identity.projectId,'local','draft-request',generate,f.active)).rejects.toThrow();expect(f.calls()).toBe(0);
});
test('status exposes scoped approved phone names without making a phone list part of execution identity',async()=>{
 const f=await fixture(),original=await f.use.bind(f.identity.projectId,'local',generate,f.active);
 f.adapter.phoneTargets=async owner=>{expect(owner).toBe('local');return [{id:'phone-13',name:'아이폰13'},{id:'phone-17',name:'아이폰17프로'}];};
 expect((await f.use.status(f.identity.projectId,'local')).phones).toEqual([{id:'phone-13',name:'아이폰13'},{id:'phone-17',name:'아이폰17프로'}]);
 expect(await f.use.bind(f.identity.projectId,'local',generate,f.active)).toEqual(original);
 f.adapter.phoneTargets=async()=>[{id:'phone-13',name:'아이폰13'},{id:'phone-13',name:'duplicate'}];
 expect((await f.use.status(f.identity.projectId,'local')).readiness.executionReady).toBe(false);
});
test('durable USE request admission coalesces duplicate callers and survives a host restart',async()=>{
 const f=await fixture(),id='generate-request';
 const outcomes=await Promise.all([f.use.execute(f.identity.projectId,'local',id,generate,f.active),f.use.execute(f.identity.projectId,'local',id,generate,f.active)]);
 expect(f.calls()).toBe(1);expect(outcomes.some(o=>o.evidence?.generated)).toBe(true);
 expect(await f.host().execute(f.identity.projectId,'local',id,generate,f.active)).toMatchObject({state:'completed',evidence:{generated:true,phoneReceived:false}});
 expect(f.calls()).toBe(1);
 await expect(f.use.execute(f.identity.projectId,'local',id,{...generate,input:{text:'different'}},f.active)).rejects.toThrow('입력');
 expect(readFileSync(f.receipts.file).includes(Buffer.from('A short greeting'))).toBe(false);
});
test('uncertain application outcomes are retained and never automatically replayed after restart',async()=>{
 const f=await fixture();let calls=0;f.setExecute(async()=>{calls++;throw Error('connection lost after app write');});
 expect(await f.use.execute(f.identity.projectId,'local','unknown-request',generate,f.active)).toMatchObject({state:'unknown'});
 expect(await f.host().execute(f.identity.projectId,'local','unknown-request',generate,f.active)).toMatchObject({state:'unknown'});
 expect(await f.host().receipt(f.identity.projectId,'local','unknown-request',f.active)).toMatchObject({state:'unknown'});expect(calls).toBe(1);
});
for(const field of ['principalId','libraryId','deviceId','installationId','grantRevision'] as const)test(`USE expected binding rejects changed ${field} before an app write`,async()=>{
 const f=await fixture(),binding=await f.use.bind(f.identity.projectId,'local',generate,f.active);
 f.changeScope({[field]:'changed'});
 await expect(f.use.execute(f.identity.projectId,'local','binding-request',generate,f.active,binding)).rejects.toThrow('문맥');expect(f.calls()).toBe(0);
});
test('revoked USE authority and a different owner cannot query an execution receipt',async()=>{
 const f=await fixture();await f.use.execute(f.identity.projectId,'local','owned-request',generate,f.active);
 await expect(f.use.receipt(f.identity.projectId,'other-user','owned-request',f.active)).rejects.toThrow('접근');
 f.revoke();await expect(f.use.receipt(f.identity.projectId,'local','owned-request',f.active)).rejects.toThrow('접근');
});
test('USE thread follow-ups keep the original role and never send input to DEV',async()=>{
 const f=await fixture(),id='use-thread-request';
 const perform=(action:Parameters<typeof f.threads.perform>[0],body:Parameters<typeof f.threads.perform>[1],requestId=id)=>f.threads.perform(action,body,f.identity.projectId,requestId,f.access);
 await perform('workroom.threads.create',{agent:'codex',text:'Generate a greeting',use:generate});await f.threads.idle();
 let result=await perform('workroom.threads.read',{threadId:id});normalizeWorkroomThreadResult(result);
 expect(result.thread).toMatchObject({state:'completed',sessionId:null,execution:{role:'use',serviceKey:'default'}});
 expect((await perform('workroom.threads.reply',{threadId:id,expectedRevision:result.thread!.revision,text:'edit the app source'},'wrong-role-request')).refusal).toBeDefined();
 const reuse:ServiceUseCall={role:'use',serviceKey:'default',tool:'materials.reuse',input:{materialId:'material-one'}};
 await perform('workroom.threads.reply',{threadId:id,expectedRevision:result.thread!.revision,text:'Reuse it',use:reuse},'reuse-request');await f.threads.idle();
 result=await perform('workroom.threads.read',{threadId:id});expect(result.thread!.execution?.role).toBe('use');expect(f.calls()).toBe(2);expect(f.devStarts()).toBe(0);expect(f.devWrites()).toBe(0);
});
test('an interrupted USE thread reads its receipt after restart instead of opening a terminal',async()=>{
 const f=await fixture(),id='interrupted-thread';
 await f.threads.perform('workroom.threads.create',{agent:'codex',text:'Generate',use:generate},f.identity.projectId,id,f.access);await f.threads.idle();
 await f.store.mutate(id,()=>true,r=>{r!.serviceExecution!.outcome=undefined;r!.state='running';r!.messages=r!.messages.filter(m=>m.role==='user');return {record:r!,value:null};});
 const restarted=new WorkroomThreadService(f.threadDeps);
 const result=await restarted.perform('workroom.threads.read',{threadId:id},f.identity.projectId,'read-restart',f.access);
 expect(result.thread!.state).toBe('completed');expect(f.calls()).toBe(1);expect(f.devStarts()).toBe(0);
});

test('a running app receipt completes the same USE thread without another app execution',async()=>{
 const f=await fixture(),id='async-use-thread';let executions=0,completed=false,lookups=0;
 f.setExecute(async()=>{executions++;return {state:'running',message:'앱에서 준비 중입니다.',operationId:id};});
 f.adapter.receipt=async(requestId)=>{expect(requestId).toBe(id);lookups++;return completed?{state:'completed',message:'실제 앱 작업을 마쳤습니다.',materialId:'material-one'}:{state:'running',message:'앱에서 준비 중입니다.',operationId:id};};
 await f.threads.perform('workroom.threads.create',{agent:'codex',text:'Generate',use:generate},f.identity.projectId,id,f.access);await f.threads.idle();
 const pending=await f.threads.perform('workroom.threads.read',{threadId:id},f.identity.projectId,'read-pending',f.access);expect(pending.thread!.state).toBe('running');
 completed=true;const finished=await f.threads.perform('workroom.threads.read',{threadId:id},f.identity.projectId,'read-complete',f.access);
 expect(finished.thread!.state).toBe('completed');expect(finished.thread!.revision).toBeGreaterThan(pending.thread!.revision);
 expect(finished.messages!.filter(m=>m.role==='assistant')).toHaveLength(1);expect(finished.messages!.at(-1)!.text).toBe('실제 앱 작업을 마쳤습니다.\n자료 ID: material-one');expect(executions).toBe(1);expect(lookups).toBe(2);expect(f.devStarts()).toBe(0);
});

test('an unknown app response recovers by original receipt without replaying its operation',async()=>{
 const f=await fixture();let executions=0;f.setExecute(async()=>{executions++;throw Error('response lost after actual write');});
 f.adapter.receipt=async()=>({state:'completed',message:'Recovered original application result',materialId:'material-one'});
 expect((await f.use.execute(f.identity.projectId,'local','recover-app-result',generate,f.active)).state).toBe('unknown');
 expect((await f.host().receipt(f.identity.projectId,'local','recover-app-result',f.active)).state).toBe('completed');expect(executions).toBe(1);
});

test('a delayed running receipt cannot regress a completed receipt or thread, and unchanged polls keep revisions',async()=>{
 const f=await fixture(),id='concurrent-receipts';let release!:(o:ServiceUseOutcome)=>void,entered!:()=>void,lookups=0;
 const delayed=new Promise<ServiceUseOutcome>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
 const running:ServiceUseOutcome={state:'running',message:'Still preparing',operationId:id};
 f.setExecute(async()=>running);
 f.adapter.receipt=async()=>{lookups++;if(lookups===2){entered();return delayed;}return lookups>2?{state:'completed',message:'Verified finished'}:running;};
 await f.threads.perform('workroom.threads.create',{agent:'codex',text:'Generate',use:generate},f.identity.projectId,id,f.access);await f.threads.idle();
 const initialThread=(await f.store.get(id))!.revision,initialReceipt=(await f.receipts.get(id))!.revision;
 await f.threads.perform('workroom.threads.read',{threadId:id},f.identity.projectId,'unchanged-poll',f.access);
 expect((await f.store.get(id))!.revision).toBe(initialThread);expect((await f.receipts.get(id))!.revision).toBe(initialReceipt);
 const late=f.threads.perform('workroom.threads.read',{threadId:id},f.identity.projectId,'delayed-poll',f.access);await started;
 const latest=await f.threads.perform('workroom.threads.read',{threadId:id},f.identity.projectId,'completed-poll',f.access);
 release(running);const stale=await late;
 expect(stale.thread!.state).toBe('completed');expect(stale.thread!.revision).toBe(latest.thread!.revision);
 expect((await f.receipts.get(id))!.serviceExecution!.outcome!.state).toBe('completed');expect(stale.messages!.filter(m=>m.role==='assistant')).toHaveLength(1);
});

test('a delayed application admission reply returns the newer persisted receipt without overwriting it',async()=>{
 const f=await fixture(),id='late-admission-reply';let release!:()=>void,entered!:()=>void;
 const delayed=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
 f.setExecute(async()=>{entered();await delayed;return {state:'running',message:'Admitted'};});
 f.adapter.receipt=async()=>({state:'completed',message:'Actually completed'});
 const execution=f.use.execute(f.identity.projectId,'local',id,generate,f.active);await started;
 expect((await f.host().receipt(f.identity.projectId,'local',id,f.active)).state).toBe('completed');
 release();expect((await execution).state).toBe('completed');expect((await f.receipts.get(id))!.serviceExecution!.outcome!.state).toBe('completed');
});

test('thread receipt fencing rejects stale app snapshots even when a replacement host supplied them',async()=>{
 const f=await fixture(),id='thread-receipt-fence';let release!:(o:ServiceUseOutcome)=>void,entered!:()=>void,calls=0;
 const delayed=new Promise<ServiceUseOutcome>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
 f.setExecute(async()=>({state:'running',message:'Preparing'}));
 await f.threads.perform('workroom.threads.create',{agent:'codex',text:'Generate',use:generate},f.identity.projectId,id,f.access);await f.threads.idle();
 const restarted=new WorkroomThreadService({...f.threadDeps,use:{bind:f.use.bind.bind(f.use),execute:f.use.execute.bind(f.use),receipt:async()=>{if(++calls===1){entered();return delayed;}return {state:'completed',message:'Finished by app'};}}});
 const late=restarted.perform('workroom.threads.read',{threadId:id},f.identity.projectId,'stale-thread-poll',f.access);await started;
 const latest=await restarted.perform('workroom.threads.read',{threadId:id},f.identity.projectId,'fresh-thread-poll',f.access);
 release({state:'running',message:'Older snapshot'});const stale=await late;
 expect(stale.thread!.state).toBe('completed');expect(stale.thread!.revision).toBe(latest.thread!.revision);expect(stale.messages!.at(-1)!.text).toBe('Finished by app');
});

test('retrying an earlier USE follow-up after a later operation never replays or changes its intent',async()=>{
 const f=await fixture(),id='use-followup-history';
 const perform=(body:Parameters<typeof f.threads.perform>[1],requestId:string)=>f.threads.perform('workroom.threads.reply',body,f.identity.projectId,requestId,f.access);
 await f.threads.perform('workroom.threads.create',{agent:'codex',text:'Generate',use:generate},f.identity.projectId,id,f.access);await f.threads.idle();
 const first={threadId:id,text:'Reuse',use:{role:'use' as const,serviceKey:'default',tool:'materials.reuse' as const,input:{materialId:'material-one'}},expectedRevision:(await f.store.get(id))!.revision};
 await perform(first,'first-followup');await f.threads.idle();
 await perform({threadId:id,text:'Prepare audio',use:{role:'use',serviceKey:'default',tool:'audio.prepare',input:{materialId:'material-one'}},expectedRevision:(await f.store.get(id))!.revision},'second-followup');await f.threads.idle();
 await perform(first,'first-followup');expect(f.calls()).toBe(3);
 await expect(perform({...first,use:{...first.use,input:{materialId:'different-material'}}},'first-followup')).rejects.toThrow('입력');
});

test('a late original result cannot overwrite a newer USE status after a host replacement',async()=>{
 const f=await fixture(),id='use-late-result';let release!:()=>void,entered=false;
 const pending=new Promise<void>(r=>{release=r;});
 f.setExecute(async(call)=>{
  if(call.tool==='materials.generate'){entered=true;await pending;return {state:'completed',message:'Earlier generation result'};}
  return {state:'failed',message:'Newer status: application failure'};
 });
 await f.threads.perform('workroom.threads.create',{agent:'codex',text:'Generate',use:generate},f.identity.projectId,id,f.access);
 for(let i=0;i<30&&!entered;i++)await Bun.sleep(1);expect(entered).toBe(true);
 const restarted=new WorkroomThreadService(f.threadDeps);
 await restarted.perform('workroom.threads.reply',{threadId:id,text:'Query the original operation',expectedRevision:(await f.store.get(id))!.revision,use:{role:'use',serviceKey:'default',tool:'operation.status',input:{operationId:'original-operation'}}},f.identity.projectId,'query-latest-status',f.access);
 await restarted.idle();release();await f.threads.idle();
 const latest=await f.store.get(id);expect(latest!.state).toBe('failed');expect(latest!.serviceExecution!.outcome!.message).toBe('Newer status: application failure');
});

test('status names the next step only for known connector failures and never echoes other error text',async()=>{
 const f=await fixture();
 f.adapter.scope=async()=>{throw Error('앱의 USE 연결 응답을 확인하지 못했습니다. 앱을 열고 원래 요청 ID로 결과를 확인하세요.');};
 let status=await f.use.status(f.identity.projectId,'local');
 expect(status.readiness).toMatchObject({tools:'verified',environmentReady:false,executionReady:false,problem:'ShadowLoop 앱이 응답하지 않습니다. 이 Mac에서 앱이 실행 중인지 확인한 뒤 다시 확인하세요.'});
 f.adapter.scope=async()=>{throw Error('앱의 사용자·자료·동작 권한이 변경되었습니다. USE 연결을 다시 확인하세요.');};
 expect((await f.use.status(f.identity.projectId,'local')).readiness.problem).toContain('앱에서 연결 코드를 다시 발급');
 f.adapter.scope=async owner=>{if(owner!=='local')throw Error('이 ShadowLoop 연결은 이 Mac의 로컬 사용자 전용입니다.');return {principalId:'p',libraryId:'l',deviceId:'d',installationId:'i',grantRevision:'g'};};
 expect((await f.use.status(f.identity.projectId,'device:host:controller')).readiness.problem).toBe('USE 실행은 지금 이 Mac에서만 할 수 있습니다. Mac의 작업 세션이나 커뮤니티에서 요청하세요.');
 f.adapter.scope=async()=>{throw Error('EACCES: /Users/someone/Library/private/vault.sqlite');};
 status=await f.use.status(f.identity.projectId,'local');
 expect(status.readiness.problem).toBe(SERVICE_USE_ENVIRONMENT_PROBLEM);expect(JSON.stringify(status.readiness)).not.toContain('/Users/');
 // The local-only text is not a reason for the local owner; it stays generic there.
 expect(serviceUseEnvironmentProblem(Error('이 앱 USE 연결은 이 기기의 로컬 사용자 전용입니다.'),'App','local')).toBe(SERVICE_USE_ENVIRONMENT_PROBLEM);
 const unconnected=new ServiceUseHost({appDataDir:f.root,resolve:async()=>({...(await f.resolve()),projectName:'Report Desk'})});
 expect((await unconnected.status(f.identity.projectId,'local')).readiness).toMatchObject({tools:'unavailable',problem:expect.stringContaining('USE 준비에서 앱 연결 코드를 입력')});
});
test('connect failures say what to do at connection time, without request IDs',()=>{
 expect(serviceUseConnectProblem(Error('앱의 USE 연결 응답을 확인하지 못했습니다. 앱을 열고 원래 요청 ID로 결과를 확인하세요.'),'Report Desk')).toBe('코드를 발급한 앱이 이 Mac에서 실행 중인지 확인한 뒤 다시 연결하세요.');
 expect(serviceUseConnectProblem(Error('ShadowLoop 운영 연결·현재 프로필·원래 작업 ID를 확인하세요.'),'Family')).toBe('ShadowLoop 앱이 이 코드를 받지 않았습니다. 코드가 만료·해제됐거나 잘못 입력됐을 수 있으니 앱에서 새 코드를 발급하세요.');
 expect(serviceUseConnectProblem(Error('이 프로젝트의 앱 USE 연결 계약을 확인하세요.'),'Report Desk')).toContain('선택한 프로젝트와 맞지 않습니다');
 for(const message of ['앱의 USE 연결 응답을 확인하지 못했습니다. 앱을 열고 원래 요청 ID로 결과를 확인하세요.','앱의 USE 운영 권한과 원래 요청 ID를 확인하세요.'])expect(serviceUseConnectProblem(Error(message),'Report Desk')).not.toContain('요청 ID');
 expect(serviceUseConnectProblem(Error('앱에서 발급한 USE 연결 코드를 확인하세요.'),'Report Desk')).toBe('앱에서 발급한 USE 연결 코드를 확인하세요.');
});
test('approved phone names are offered only on this Mac\'s own Workroom transport (OPS @USE included)',()=>{
 expect(localUsePhonesFor(localWorkroomTransport)).toBe(localUsePhones);
 expect(localUsePhonesFor(async()=>({}))).toBeUndefined();expect(localUsePhonesFor(undefined)).toBeUndefined();
});
test('the connect route follows the code prefix, not the project display name',()=>{
 expect(serviceUseConnectRoute(' SLUSE1.a.b.c','Renamed family app')).toBe('connect-shadowloop');
 expect(serviceUseConnectRoute('ATZUSE1.x.y','ShadowLoop')).toBe('connect-app');
 expect(serviceUseConnectRoute('typo','ShadowLoop')).toBe('connect-shadowloop');expect(serviceUseConnectRoute('typo','Report Desk')).toBe('connect-app');
});
test('USE threads stay listed while the app cannot be verified, without app text, and never query or reply',async()=>{
 const f=await fixture(),id='kept-use-thread';let lookups=0,executions=0;
 f.adapter.receipt=async()=>{lookups++;return {state:'completed',message:'Secret app result for profile one',materialId:'material-one'};};
 f.setExecute(async()=>{executions++;return {state:'completed',message:'Secret app result for profile one',materialId:'material-one'};});
 await f.threads.perform('workroom.threads.create',{agent:'codex',text:'Make a greeting',use:generate},f.identity.projectId,id,f.access);await f.threads.idle();
 const scope=f.adapter.scope;
 f.adapter.scope=async()=>{throw Error('앱의 USE 연결 응답을 확인하지 못했습니다. 앱을 열고 원래 요청 ID로 결과를 확인하세요.');};
 const listed=normalizeWorkroomThreadResult(await f.threads.perform('workroom.threads.list',{},f.identity.projectId,'list-app-down',f.access),'workroom.threads.list');
 expect(listed.threads!.map(t=>t.id)).toEqual([id]);expect(listed.threads![0]).toMatchObject({state:'completed',execution:{role:'use',serviceKey:'default'}});
 const read=normalizeWorkroomThreadResult(await f.threads.perform('workroom.threads.read',{threadId:id},f.identity.projectId,'read-app-down',f.access),'workroom.threads.read');
 expect(JSON.stringify(read)).not.toContain('Secret app result');expect(read.messages!.map(m=>m.role)).toEqual(['user','system']);expect(read.messages!.at(-1)!.text).toContain('지금 앱 연결을 확인할 수 없어');
 // Nothing is admitted: a refusal the composer can show, never an uncertain send it would have to re-check forever.
 const reuse={role:'use' as const,serviceKey:'default',tool:'materials.reuse' as const,input:{materialId:'material-one'}};
 const refused=normalizeWorkroomThreadResult(await f.threads.perform('workroom.threads.reply',{threadId:id,expectedRevision:read.thread!.revision,text:'Reuse',use:reuse},f.identity.projectId,'reply-app-down',f.access),'workroom.threads.reply');
 expect(refused.refusal).toEqual({requestId:'reply-app-down',message:expect.stringContaining('앱이 응답하지 않습니다')});
 expect(JSON.stringify(refused)).not.toContain('Secret app result');expect((await f.store.get(id))!.messages.some(m=>m.id==='reply-app-down')).toBe(false);
 // A reissued code or another app user: same AgentsToZ owner, different binding. Titles and state only.
 f.adapter.scope=scope;f.changeScope({principalId:'profile-two'});
 const changed=await f.threads.perform('workroom.threads.read',{threadId:id},f.identity.projectId,'read-changed',f.access);
 expect(JSON.stringify(changed)).not.toContain('Secret app result');expect(changed.messages!.at(-1)!.text).toContain('이전 연결의 앱 결과는 표시하지 않습니다');
 const changedReply=await f.threads.perform('workroom.threads.reply',{threadId:id,expectedRevision:changed.thread!.revision,text:'Reuse',use:reuse},f.identity.projectId,'reply-changed',f.access);
 expect(changedReply.refusal).toEqual({requestId:'reply-changed',message:USE_CHANGED_REPLY_TEXT});expect(JSON.stringify(changedReply)).not.toContain('Secret app result');
 const closed=await f.threads.perform('workroom.threads.close',{threadId:id,expectedRevision:changed.thread!.revision,consent:true},f.identity.projectId,'close-changed',f.access);
 expect(closed.thread!.state).toBe('closed');expect(JSON.stringify(closed)).not.toContain('Secret app result');
 expect(lookups).toBe(0);expect(executions).toBe(1);expect(f.devStarts()).toBe(0);
 // Another AgentsToZ owner still cannot see the row at all.
 expect((await f.threads.perform('workroom.threads.list',{},f.identity.projectId,'list-other-owner',{...f.access,owner:'device:other:controller'})).threads).toEqual([]);
});
test('an unknown USE result is shown in Korean with the IDs a follow-up needs, and the app text is kept in the receipt',async()=>{
 const f=await fixture(),id='english-unknown';
 f.setExecute(async(_call,requestId)=>({state:'unknown',message:'Check the original request receipt; do not replay.',operationId:requestId}));
 f.adapter.receipt=async(requestId)=>({state:'unknown',message:'Check the original request receipt; do not replay.',operationId:requestId});
 await f.threads.perform('workroom.threads.create',{agent:'codex',text:'Generate',use:generate},f.identity.projectId,id,f.access);await f.threads.idle();
 const read=await f.threads.perform('workroom.threads.read',{threadId:id},f.identity.projectId,'read-unknown',f.access);
 expect(read.thread!.state).toBe('unknown');expect(read.messages!.at(-1)!.text).toBe(USE_UNKNOWN_RESULT_TEXT+'\n요청 ID: '+id);
 expect((await f.store.get(id))!.serviceExecution!.outcome!.message).toBe('Check the original request receipt; do not replay.');
 expect(useResultText(['app.invoke'],{state:'completed',message:'Done',materialId:'m-1',operationId:'op-1'})).toBe('Done');
 expect(useResultText(['materials.generate','phone.deliver'],{state:'completed',message:'Done',materialId:'m-1',operationId:'op-1'})).toBe('Done\n자료 ID: m-1');
});
test('a USE request without a memo records the action label deterministically; generation still needs text',()=>{
 const catalog={tools:['app.invoke' as const],actions:[{id:'report.create',label:'보고서 만들기',effect:'write' as const,fields:[]}],executionReady:true,problem:null};
 const fields={tool:'app.invoke' as const,actionId:'report.create',arguments:{},materialId:'',operationId:'',phoneId:''};
 expect(serviceUseRequestText(fields,'',catalog)).toBe('보고서 만들기');expect(serviceUseRequestText(fields,'  ',catalog)).toBe('보고서 만들기');
 expect(serviceUseRequestText(fields,'주간 보고',catalog)).toBe('주간 보고');
 expect(serviceUseRequestText({...fields,tool:'phone.deliver'},'',catalog)).toBe('승인된 폰에 전달');
 expect(serviceUseRequestText({...fields,tool:'materials.generate'},'',catalog)).toBe('');
});
