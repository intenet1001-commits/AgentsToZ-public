import {afterEach,expect,test} from 'bun:test';
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ServiceUseHost,type ServiceUseAdapter} from '../src/serviceUseHost';
import {normalizeServiceUseCall,parseServiceUseRequest,type ServiceUseCall,type ServiceUseOutcome} from '../src/serviceUseProtocol';
import {ensureServiceMemory,migrateServiceMemoryToProject} from '../src/serviceMemory';
import {WorkroomThreadStore} from '../src/workroomThreadStore';
import {WorkroomThreadService} from '../src/workroomThreadService';
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
 expect(finished.messages!.filter(m=>m.role==='assistant')).toHaveLength(1);expect(finished.messages!.at(-1)!.text).toBe('실제 앱 작업을 마쳤습니다.');expect(executions).toBe(1);expect(lookups).toBe(2);expect(f.devStarts()).toBe(0);
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
