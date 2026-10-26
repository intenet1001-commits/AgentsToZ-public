import {afterEach,expect,test} from 'bun:test';
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ServiceUseHost,SERVICE_USE_OFF_PROBLEM,SERVICE_USE_UNCONNECTED_PROBLEM,publicServiceUseStatus,type ServiceUseAdapter} from '../src/serviceUseHost';
import type {ServiceUseCall} from '../src/serviceUseProtocol';
import {ensureServiceMemory,migrateServiceMemoryToProject} from '../src/serviceMemory';
import {WorkroomThreadStore} from '../src/workroomThreadStore';
import {WorkroomThreadService} from '../src/workroomThreadService';
import {normalizeWorkroomThreadResult} from '../src/workroomThreadProtocol';
import {projectMentionChoices} from '../src/projectUseMention';
import {workroomMentionCandidates} from '../src/workroomProjectMention';

// 「USE 끄기」 is a flag, not a migration rollback: memory, memoryId/serviceKey, the app connection and receipts stay.
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const generate:ServiceUseCall={role:'use',serviceKey:'default',tool:'materials.generate',input:{text:'A short greeting.'}};
const reuse:ServiceUseCall={role:'use',serviceKey:'default',tool:'materials.reuse',input:{materialId:'material-one'}};
async function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'service-use-off-')));chmodSync(root,0o700);roots.push(root);
 const projectPath=join(root,'project');mkdirSync(projectPath);
 const identity={projectId:'project-use-off',projectMemoryId:'dev-memory',serviceKey:'default'};
 ensureServiceMemory(root,{...identity,projectName:'ShadowLoop',canonicalPath:projectPath,displayName:'ShadowLoop USE'});
 migrateServiceMemoryToProject(root,identity);
 const keys={read:async()=>Buffer.alloc(32,8),create:async()=>Buffer.alloc(32,8)};
 const receipts=new WorkroomThreadStore(join(root,'receipts'),keys);
 let calls=0,execute:ServiceUseAdapter['execute']=async()=>{calls++;return {state:'completed',message:'Mac generation verified',materialId:'material-one'};};
 const adapter:ServiceUseAdapter={projectId:identity.projectId,serviceKey:'default',definitionRevision:'fixture-verified-v1',tools:['materials.generate','materials.reuse','audio.prepare','operation.status','operation.cancel','phone.deliver'],
  scope:async()=>({principalId:'user-one',libraryId:'library-one',deviceId:'device-one',installationId:'install-one',grantRevision:'grant-one'}),execute:(...args)=>execute(...args)};
 const resolve=async()=>({projectId:identity.projectId,projectName:'ShadowLoop',memoryId:identity.projectMemoryId,canonicalPath:projectPath});
 const host=()=>new ServiceUseHost({appDataDir:root,resolve,adapters:[adapter],receipts});
 const use=host();await use.enable(identity.projectId);
 const store=new WorkroomThreadStore(join(root,'threads'),keys);let devStarts=0;
 const threads=new WorkroomThreadService({store,use,resolve:async()=>({fingerprint:'dev-folder'}),start:async()=>{devStarts++;throw Error('DEV terminal must not start');},reply:async()=>{throw Error('DEV input must not be written');},inspect:()=>({state:'running' as const,inputRevision:0})});
 const access={owner:'local',active:()=>true,readAll:false};
 const activationFile=join(root,'service-use','activation.v1.json');
 return {root,identity,adapter,receipts,use,host,store,threads,access,activationFile,calls:()=>calls,devStarts:()=>devStarts,setExecute:(fn:typeof execute)=>{execute=fn;}};
}
const offered=async(f:Awaited<ReturnType<typeof fixture>>)=>{
 const services=await f.use.mentionServices(new Set([f.identity.projectId]));
 return [{targetId:f.identity.projectId,label:'ShadowLoop',...(services.get(f.identity.projectId)?.length?{useServices:services.get(f.identity.projectId)}:{})}];
};

test('USE 끄기 keeps the memory, its memoryId and the app connection, and turning it back on continues the same USE',async()=>{
 const f=await fixture();
 const before=await f.use.status(f.identity.projectId,'local');
 expect(before.readiness).toMatchObject({enabled:true,executionReady:true,problem:null});expect(before.turnedOff).toBe(false);
 writeFileSync(before.serviceMemory.record!.sourcePath,'# USE memory\n\nKEEP_THIS_OPERATING_PREFERENCE\n');
 expect((await f.use.execute(f.identity.projectId,'local','before-off',generate,()=>true)).state).toBe('completed');

 expect(await f.use.disable(f.identity.projectId)).toEqual({changed:true});
 expect(await f.use.disable(f.identity.projectId)).toEqual({changed:false});
 const off=await f.host().status(f.identity.projectId,'local');
 // Status stays readable: memory, connection and catalog are all still there, only the flag is off.
 expect(off.readiness).toEqual({enabled:false,memoryReady:true,tools:'verified',environmentReady:true,executionReady:false,problem:SERVICE_USE_OFF_PROBLEM});
 expect(off.turnedOff).toBe(true);expect(off.tools).toContain('materials.generate');
 expect(off.serviceMemory.record).toMatchObject({serviceMemoryId:before.serviceMemory.record!.serviceMemoryId,serviceKey:'default',storage:'project-namespace-v1',sourcePath:before.serviceMemory.record!.sourcePath});
 expect(readFileSync(off.serviceMemory.record!.sourcePath,'utf8')).toContain('KEEP_THIS_OPERATING_PREFERENCE');
 // The reason says how to turn it back on, and the Mac-only flag never reaches a conversational transport.
 expect(SERVICE_USE_OFF_PROBLEM).toContain('USE 다시 켜기');expect(publicServiceUseStatus(off)).not.toHaveProperty('turnedOff');

 expect(await f.use.enable(f.identity.projectId)).toBeUndefined();
 const on=await f.host().status(f.identity.projectId,'local');
 expect(on.readiness).toMatchObject({enabled:true,executionReady:true,problem:null});expect(on.turnedOff).toBe(false);
 expect(on.serviceMemory.record!.serviceMemoryId).toBe(before.serviceMemory.record!.serviceMemoryId);
 expect((await f.use.receipt(f.identity.projectId,'local','before-off',()=>true)).state).toBe('completed');
 expect((await f.use.execute(f.identity.projectId,'local','after-on',generate,()=>true)).state).toBe('completed');expect(f.calls()).toBe(2);
});

test('the activation file keeps an off row out of `services`, so an older reader never sees it as on',async()=>{
 const f=await fixture();await f.use.disable(f.identity.projectId);
 const data=JSON.parse(readFileSync(f.activationFile,'utf8'));
 expect(data.version).toBe(1);expect(data.services).toEqual([]);
 expect(data.off).toEqual([{projectId:f.identity.projectId,serviceKey:'default',serviceMemoryId:(await f.use.status(f.identity.projectId,'local')).serviceMemory.record!.serviceMemoryId,enabled:false}]);
 await f.use.enable(f.identity.projectId);
 const back=JSON.parse(readFileSync(f.activationFile,'utf8'));expect(back.services).toHaveLength(1);expect(back.off).toBeUndefined();
 // A file written before 「USE 끄기」 existed still reads; a malformed one fails closed instead of guessing.
 const row=back.services[0];
 for(const broken of [{version:1,services:[{...row,enabled:false}]},{version:1,services:[],off:[{...row,enabled:true}]},{version:1,services:[row],off:[{...row,enabled:false}]},{version:1,services:[],off:{}}]){
  writeFileSync(f.activationFile,JSON.stringify(broken));
  await expect(f.use.status(f.identity.projectId,'local')).rejects.toThrow('USE 활성화 설정을 검증하지 못했습니다.');
 }
 writeFileSync(f.activationFile,JSON.stringify({version:1,services:[row]}));
 expect((await f.use.status(f.identity.projectId,'local')).readiness.enabled).toBe(true);
});

test('while off, @ and # do not offer the USE and a new execution is refused with how to turn it back on',async()=>{
 const f=await fixture();
 expect(projectMentionChoices(await offered(f)).map(p=>p.label)).toEqual(['ShadowLoop','ShadowLoop-USE']);
 await f.use.disable(f.identity.projectId);
 expect(await f.use.mentionServices(new Set([f.identity.projectId]))).toEqual(new Map());
 expect(projectMentionChoices(await offered(f)).map(p=>p.label)).toEqual(['ShadowLoop']);
 for(const marker of ['@','#'])expect(workroomMentionCandidates(marker+'Shadow',await offered(f)).map(p=>p.label)).toEqual(['ShadowLoop']);
 await expect(f.use.reference(f.identity.projectId)).rejects.toThrow(SERVICE_USE_OFF_PROBLEM);
 await expect(f.use.execute(f.identity.projectId,'local','while-off',generate,()=>true)).rejects.toThrow(SERVICE_USE_OFF_PROBLEM);
 await expect(f.use.bind(f.identity.projectId,'local',generate,()=>true)).rejects.toThrow(SERVICE_USE_OFF_PROBLEM);
 expect(f.calls()).toBe(0);expect(await f.receipts.get('while-off')).toBeNull();
});

test('an earlier request\'s receipt still answers while off, reaching the app without replaying the work',async()=>{
 const f=await fixture();let executions=0,lookups=0;
 f.setExecute(async(_call,requestId)=>{executions++;return {state:'running',message:'앱에서 준비 중입니다.',operationId:requestId};});
 f.adapter.receipt=async()=>{lookups++;return {state:'completed',message:'실제 앱 작업을 마쳤습니다.',materialId:'material-one'};};
 expect((await f.use.execute(f.identity.projectId,'local','running-before-off',generate,()=>true)).state).toBe('running');
 await f.use.disable(f.identity.projectId);
 expect(await f.host().receipt(f.identity.projectId,'local','running-before-off',()=>true)).toMatchObject({state:'completed',materialId:'material-one'});
 expect((await f.receipts.get('running-before-off'))!.serviceExecution!.outcome!.state).toBe('completed');
 expect(executions).toBe(1);expect(lookups).toBe(1);
 // Other owners and a revoked caller stay refused exactly as before.
 await expect(f.use.receipt(f.identity.projectId,'other-user','running-before-off',()=>true)).rejects.toThrow('접근');
 await expect(f.use.receipt(f.identity.projectId,'local','running-before-off',()=>false)).rejects.toThrow('접근');
});

test('sending an admitted request ID again while off answers with its stored result, never a refusal or a second run',async()=>{
 const f=await fixture();
 const first=await f.use.execute(f.identity.projectId,'local','admitted-before-off',generate,()=>true);
 expect(first).toMatchObject({state:'completed',materialId:'material-one'});
 await f.use.disable(f.identity.projectId);
 expect(await f.host().execute(f.identity.projectId,'local','admitted-before-off',generate,()=>true)).toEqual(first);
 expect(f.calls()).toBe(1);
 // A different input under the same ID, another owner's ID and a brand-new ID are still refused while off.
 await expect(f.use.execute(f.identity.projectId,'local','admitted-before-off',reuse,()=>true)).rejects.toThrow('다릅니다');
 await expect(f.use.execute(f.identity.projectId,'other-user','admitted-before-off',generate,()=>true)).rejects.toThrow(SERVICE_USE_OFF_PROBLEM);
 await expect(f.use.execute(f.identity.projectId,'local','new-while-off',generate,()=>true)).rejects.toThrow(SERVICE_USE_OFF_PROBLEM);
 expect(f.calls()).toBe(1);expect(await f.receipts.get('new-while-off')).toBeNull();
});

test('while off, a missing app connection is reported, not claimed to be kept',async()=>{
 const f=await fixture();await f.use.disable(f.identity.projectId);
 const resolve=async()=>({projectId:f.identity.projectId,projectName:'Report Desk',memoryId:f.identity.projectMemoryId,canonicalPath:join(f.root,'project')});
 const disconnected=await new ServiceUseHost({appDataDir:f.root,resolve,receipts:f.receipts}).status(f.identity.projectId,'local');
 expect(disconnected.turnedOff).toBe(true);expect(disconnected.readiness.tools).toBe('unavailable');
 expect(disconnected.readiness.problem).not.toBe(SERVICE_USE_OFF_PROBLEM);
 expect(disconnected.readiness.problem).not.toContain('앱 연결·');
 expect(disconnected.readiness.problem).toContain(SERVICE_USE_UNCONNECTED_PROBLEM);
});

test('a USE thread keeps its result readable while off, and refuses new work without admitting anything',async()=>{
 const f=await fixture(),id='thread-before-off';
 const perform=(action:Parameters<typeof f.threads.perform>[0],body:Parameters<typeof f.threads.perform>[1],requestId:string)=>f.threads.perform(action,body,f.identity.projectId,requestId,f.access);
 await perform('workroom.threads.create',{agent:'codex',text:'Generate a greeting',use:generate},id);await f.threads.idle();
 const done=await perform('workroom.threads.read',{threadId:id},'read-before-off');
 await perform('workroom.threads.reply',{threadId:id,expectedRevision:done.thread!.revision,text:'Reuse it',use:reuse},'reply-before-off');await f.threads.idle();
 expect(f.calls()).toBe(2);
 await f.use.disable(f.identity.projectId);

 const listed=normalizeWorkroomThreadResult(await perform('workroom.threads.list',{},'list-off'),'workroom.threads.list');
 expect(listed.threads!.map(t=>t.id)).toEqual([id]);
 const read=normalizeWorkroomThreadResult(await perform('workroom.threads.read',{threadId:id},'read-off'),'workroom.threads.read');
 expect(read.messages!.filter(m=>m.role==='assistant').map(m=>m.text)).toEqual(['Mac generation verified\n자료 ID: material-one','Mac generation verified\n자료 ID: material-one']);
 expect(read.messages!.some(m=>m.role==='system')).toBe(false);

 const catalog=await perform('workroom.threads.catalog',{serviceKey:'default'},'catalog-off');
 expect(catalog.catalog).toMatchObject({executionReady:false,problem:SERVICE_USE_OFF_PROBLEM});
 const refused=normalizeWorkroomThreadResult(await perform('workroom.threads.reply',{threadId:id,expectedRevision:read.thread!.revision,text:'Reuse again',use:reuse},'reply-off'),'workroom.threads.reply');
 expect(refused.refusal).toEqual({requestId:'reply-off',message:SERVICE_USE_OFF_PROBLEM});
 expect((await f.store.get(id))!.messages.some(m=>m.id==='reply-off')).toBe(false);
 const created=await perform('workroom.threads.create',{agent:'codex',text:'Another greeting',use:generate},'create-off');
 expect(created.refusal).toEqual({requestId:'create-off',message:SERVICE_USE_OFF_PROBLEM});expect(await f.store.get('create-off')).toBeNull();
 // Retrying requests admitted before 「USE 끄기」 returns their thread, never a refusal or another app run.
 const retriedReply=await perform('workroom.threads.reply',{threadId:id,expectedRevision:done.thread!.revision,text:'Reuse it',use:reuse},'reply-before-off');
 expect(retriedReply.refusal).toBeUndefined();expect(retriedReply.thread!.id).toBe(id);
 const retriedCreate=await perform('workroom.threads.create',{agent:'codex',text:'Generate a greeting',use:generate},id);
 expect(retriedCreate.refusal).toBeUndefined();expect(retriedCreate.thread!.id).toBe(id);
 await f.threads.idle();expect(f.calls()).toBe(2);expect(f.devStarts()).toBe(0);

 await f.use.enable(f.identity.projectId);
 const latest=(await f.store.get(id))!;
 await perform('workroom.threads.reply',{threadId:id,expectedRevision:latest.revision,text:'Reuse again',use:reuse},'reply-on-again');await f.threads.idle();
 expect(f.calls()).toBe(3);
});

test('turning off needs no readable memory or app, and leaves other services and projects on',async()=>{
 const f=await fixture(),other={projectId:'project-still-on',projectMemoryId:'dev-memory-two',serviceKey:'default'};
 const otherPath=join(f.root,'other');mkdirSync(otherPath);
 ensureServiceMemory(f.root,{...other,projectName:'Report Desk',canonicalPath:otherPath,displayName:'Report Desk USE'});migrateServiceMemoryToProject(f.root,other);
 const projects:Record<string,{projectId:string;projectName:string;memoryId:string;canonicalPath:string}>={
  [f.identity.projectId]:{projectId:f.identity.projectId,projectName:'ShadowLoop',memoryId:f.identity.projectMemoryId,canonicalPath:join(f.root,'project')},
  [other.projectId]:{projectId:other.projectId,projectName:'Report Desk',memoryId:other.projectMemoryId,canonicalPath:otherPath},
 };
 const both=new ServiceUseHost({appDataDir:f.root,resolve:async id=>projects[id]!});await both.enable(other.projectId);
 const unreachable=new ServiceUseHost({appDataDir:f.root,resolve:async()=>{throw Error('project registry is unavailable');}});
 expect(await unreachable.disable(f.identity.projectId)).toEqual({changed:true});
 expect(await both.mentionServices(new Set([f.identity.projectId,other.projectId]))).toEqual(new Map([[other.projectId,['default']]]));
 expect((await both.status(other.projectId,'local')).readiness.enabled).toBe(true);
});
