import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,chmodSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ProjectStateBundleHost,type ProjectStateClock} from '../src/projectStateBundleHost';
import {ReadToolBatchHost} from '../src/readToolBatchHost';
import {WorkroomThreadStore,type StoredWorkroomThread} from '../src/workroomThreadStore';
import {WorkroomThreadReadExecutionRepository} from '../src/workroomThreadReadExecution';
import type {ReadToolSourceAdapters,SourceObservation,SectionId} from '../src/projectStateBundle';

const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
async function flush(){for(let i=0;i<50;i++)await Promise.resolve();}
class Clock implements ProjectStateClock{
 value=1000;next=0;timers=new Map<number,{at:number;fn:()=>void}>();now=()=>this.value;
 setTimeout=(fn:()=>void,ms:number)=>{const id=++this.next;this.timers.set(id,{at:this.value+ms,fn});return id;};clearTimeout=(id:unknown)=>{this.timers.delete(id as number);};
 async advance(ms:number){this.value+=ms;for(const [id,t] of [...this.timers])if(t.at<=this.value){this.timers.delete(id);t.fn();}await flush();}
}
const obs=(id:SectionId,patch:Partial<SourceObservation>={}):SourceObservation=>({id,availability:'ready',freshness:'current',observedAt:1000,sourceRevision:'v1',summary:[`${id} safe summary`],limits:[],...patch});
const runId='20261024T100000Z-abcdef12';
const plan={steps:[{id:'status',input:{operation:'tester.status.read'}},{id:'report',input:{operation:'tester.report.read',runId:{stepId:'status',field:'latest.runId'}},dependsOn:['status'],condition:'on-report-present'},{id:'git',input:{operation:'project.git.read'}}]};
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'read-batch-host-'));roots.push(root);chmodSync(root,0o700);const clock=new Clock();let proof='proof-v1',allowed=true;const calls:string[]=[];
 const store=new WorkroomThreadStore(root,{read:async()=>Buffer.alloc(32,11),create:async()=>{throw Error('must not create key');}});
 const thread:StoredWorkroomThread={id:'thread-one',owner:'local',targetId:'target',fingerprint:'original',bootId:'cli-boot',intentHash:'original',title:'Existing task',agent:'codex',sessionId:'session-one',state:'running',revision:1,createdAt:'now',updatedAt:'now',messages:[]};
 await store.mutate(thread.id,()=>true,()=>({record:thread,value:null}));
 const operations:ReadToolSourceAdapters={
  'project.git.read':{async read(){calls.push('git');return {observation:obs('git')};}},
  'tester.status.read':{async read(){calls.push('status');return {observation:obs('tester'),latestRunId:runId};}},
  'tester.report.read':{async read(_binding,input){expect(input.operation).toBe('tester.report.read');if(input.operation==='tester.report.read')expect(input.runId).toBe(runId);calls.push('report');return {observation:obs('tester'),reportRunId:runId};}},
  'workroom.status.read':{async read(){calls.push('workroom');return {observation:obs('workroom')};}},
  'memory.reference.read':{async read(){calls.push('memory');return {observation:obs('memory')};}},
 };
 const executor=new ProjectStateBundleHost({clock,resolve:async(owner,targetId)=>({owner,targetId,projectId:targetId,role:'dev',proof}),authorize:async()=>{if(!allowed)throw Error('revoked');},readers:{git:{async read(){calls.push('preview-git');return obs('git');}},workroom:{async read(){return obs('workroom');}},tester:{async read(){return obs('tester');}}},operations});
 const repository=new WorkroomThreadReadExecutionRepository(store,{bootId:'batch-boot',now:clock.now});
 const host=new ReadToolBatchHost({executor,repository,active:()=>allowed});
 return {host,executor,repository,store,clock,operations,calls,thread,setProof:(v:string)=>{proof=v;},revoke:()=>{allowed=false;},request:{targetId:'target',threadId:thread.id,requestId:'request-one',plan},ref:{targetId:'target',threadId:thread.id,requestId:'request-one'}};
}
test('T10 typed plan resolves dependencies and references while preserving the existing thread',async()=>{
 const f=await fixture(),before=await f.store.get(f.thread.id),result=await f.host.start('local',f.request);
 expect(result.batch.state).toBe('completed');expect(result.payload).toBe('available');expect(f.calls.indexOf('report')).toBeGreaterThan(f.calls.indexOf('status'));
 expect(result.result!.outputs.find(v=>v.stepId==='report')!.reportRunId).toBe(runId);
 const {readExecutions,...after}=(await f.store.get(f.thread.id))!;expect(after).toEqual(before!);expect(readExecutions).toHaveLength(1);
 expect(JSON.stringify(readExecutions)).not.toContain('safe summary');expect(JSON.stringify(readExecutions)).not.toContain('latest.runId');
});
test('T14 duplicate intent returns the original receipt with zero source replay; changed plan conflicts',async()=>{
 const f=await fixture(),first=await f.host.start('local',f.request),calls=f.calls.length;
 expect((await f.host.start('local',f.request)).batch).toEqual(first.batch);expect(f.calls).toHaveLength(calls);
 await expect(f.host.start('local',{...f.request,plan:{steps:[{id:'git',input:{operation:'project.git.read',pathsLimit:0}}]}})).rejects.toThrow();expect(f.calls).toHaveLength(calls);
 await f.clock.advance(300001);expect((await f.host.read('local',f.ref)).payload).toBe('unavailable');expect(f.calls).toHaveLength(calls);
});
test('T10 unavailable status skips its dependent report and keeps independent Git output',async()=>{
 const f=await fixture();f.operations['tester.status.read']={async read(){f.calls.push('status');return {observation:obs('tester',{availability:'unconfigured',freshness:'unknown'})};}};
 const result=await f.host.start('local',f.request);expect(result.batch.stages.find(v=>v.id==='report')!.state).toBe('skipped');expect(f.calls).not.toContain('report');expect(f.calls).toContain('git');expect(result.batch.state).toBe('partial');
});
test('P1 previews and P2 reads share active target and real unsettled source slots',async()=>{
 const f=await fixture(),pending=deferred<{observation:SourceObservation}>();f.operations['project.git.read']={async read(){return pending.promise;}};
 const running=f.host.start('local',{...f.request,plan:{steps:[{id:'git',input:{operation:'project.git.read'}}]}});
 for(let i=0;i<100&&f.executor.diagnostics().activeSources!==1;i++)await Bun.sleep(2);
 expect(f.executor.diagnostics().activeSources).toBe(1);await expect(f.executor.preview('local',{targetId:'target'})).rejects.toThrow();
 await f.clock.advance(3001);const result=await running;expect(result.batch.state).toBe('unknown');expect(f.executor.diagnostics().activeSources).toBe(1);
 await expect(f.executor.preview('local',{targetId:'target'})).rejects.toThrow();pending.resolve({observation:obs('git')});await flush();expect(f.executor.diagnostics().activeSources).toBe(0);
 expect((await f.host.read('local',f.ref)).batch.state).toBe('unknown');
});
test('cancel keeps unknown receipt and never appends a late successful source result',async()=>{
 const f=await fixture(),pending=deferred<{observation:SourceObservation}>();f.operations['project.git.read']={async read(){return pending.promise;}};
 const running=f.host.start('local',{...f.request,plan:{steps:[{id:'git',input:{operation:'project.git.read'}}]}});
 for(let i=0;i<100&&f.executor.diagnostics().activeSources!==1;i++)await Bun.sleep(2);
 const cancelled=await f.host.cancel('local',f.ref);expect(cancelled.batch.state).toBe('unknown');await running;const before=(await f.host.read('local',f.ref)).batch;
 pending.resolve({observation:obs('git')});await flush();expect((await f.host.read('local',f.ref)).batch).toEqual(before);expect(f.executor.diagnostics().activeSources).toBe(0);
});
test('P2 selected step attachment uses the existing prepared pipeline and exact source revalidation',async()=>{
 const f=await fixture(),result=await f.host.start('local',f.request);
 const selection=await f.host.prepare('local',{targetId:'target',threadId:f.thread.id,requestId:f.request.requestId,resultId:result.result!.id,stepIds:['git','report']});
 expect(selection.prepared.text).toContain('git');let sends=0;
 await f.executor.withPrepared('local',{targetId:'target',...selection.projectState},async()=>{sends++;});expect(sends).toBe(1);
 f.operations['project.git.read']={async read(){return {observation:obs('git',{sourceRevision:'v2',summary:['changed']})};}};
 await expect(f.executor.withPrepared('local',{targetId:'target',...selection.projectState},async()=>{sends++;})).rejects.toThrow();expect(sends).toBe(1);
});
test('unknown keys, foreign thread and revoked authority fail before source execution',async()=>{
 const f=await fixture();await expect(f.host.start('local',{...f.request,path:'/tmp'})).rejects.toThrow();await expect(f.host.start('foreign',f.request)).rejects.toThrow();expect(f.calls).toEqual([]);
 f.revoke();await expect(f.host.start('local',f.request)).rejects.toThrow();expect(f.calls).toEqual([]);
});
