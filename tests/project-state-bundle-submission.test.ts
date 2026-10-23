import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ProjectStateBundleHost} from '../src/projectStateBundleHost';
import {ProjectStateError,type SectionId,type SourceObservation} from '../src/projectStateBundle';
import {WorkroomThreadService,type WorkroomThreadAccess} from '../src/workroomThreadService';
import {WorkroomThreadStore} from '../src/workroomThreadStore';
import type {WorkroomThreadRequest} from '../src/workroomThreadProtocol';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'state-submission-'));roots.push(root);let key:Buffer|null=null,proof='initial',authorized=true,reads=0,inside=0,checks=0;
 const target='project_state_submission',starts:string[]=[],replies:string[]=[];
 const host=new ProjectStateBundleHost({resolve:async(owner,targetId)=>{if(!authorized)throw Error('revoked');return {owner,targetId,projectId:targetId,role:'dev',proof};},readers:Object.fromEntries((['git','workroom','tester'] as SectionId[]).map(id=>[id,{read:async()=>{reads++;return {id,availability:'ready',freshness:'current',observedAt:123,sourceRevision:'v1',summary:['bounded summary'],limits:[]} as SourceObservation;}}]))});
 const bundle=await host.preview('local',{targetId:target}),selected={targetId:target,bundleId:bundle.id,sections:['git'] as SectionId[]},prepared=await host.prepare('local',selected),attachment={bundleId:bundle.id,sections:selected.sections,selectionHash:prepared.selectionHash};
 const store=new WorkroomThreadStore(root,{read:async()=>key?Buffer.from(key):null,create:async()=>{key=Buffer.alloc(32,4);return Buffer.from(key);}});
 const service=new WorkroomThreadService({store,resolve:async()=>({fingerprint:'checkout'}),inspect:()=>({state:'running',inputRevision:0}),start:async(id,targetId,agent,prompt)=>{expect(inside).toBe(1);starts.push(id);return {written:true,session:{id:crypto.randomUUID(),targetId,agent,state:'running',createdAt:new Date().toISOString(),exitCode:null,cols:80,rows:24}};},reply:async(_id,_session,text)=>{expect(inside).toBe(1);replies.push(text);return {written:true};}});
 const accessFor=(input:WorkroomThreadRequest):WorkroomThreadAccess=>({owner:'local',active:()=>true,readAll:true,...(input.projectState?{withInputContext:async<T>(operation:()=>Promise<T>)=>{checks++;return host.withPrepared('local',{targetId:target,...input.projectState!},async prepared=>{if(!input.text!.includes(prepared.text))throw new ProjectStateError('PROJECT_STATE_SELECTION_CHANGED');inside++;try{return await operation();}finally{inside--;}});}}:{})});
 const createInput={agent:'codex' as const,text:'Inspect this project.\n'+prepared.text,projectState:attachment};
 return {host,service,store,target,starts,replies,prepared,createInput,accessFor,reads:()=>reads,checks:()=>checks,revoke:()=>{authorized=false;},change:()=>{proof='changed';}};
}
test('prepared state reaches existing start and reply only inside the revalidated callback; retries read original receipts',async()=>{
 const f=await fixture(),id=crypto.randomUUID();await f.service.perform('workroom.threads.create',f.createInput,f.target,id,f.accessFor(f.createInput));await f.service.idle();expect(f.starts).toEqual([id]);
 const record=(await f.store.get(id))!,replyId=crypto.randomUUID(),reply={threadId:id,expectedRevision:record.revision,text:'Follow up.\n'+f.prepared.text,projectState:f.createInput.projectState};
 await f.service.perform('workroom.threads.reply',reply,f.target,replyId,f.accessFor(reply));expect(f.replies).toEqual([reply.text]);
 const reads=f.reads(),checks=f.checks();f.revoke();f.change();
 const duplicate=await f.service.perform('workroom.threads.create',f.createInput,f.target,id,f.accessFor(f.createInput));expect(duplicate.thread!.id).toBe(id);
 await f.service.perform('workroom.threads.reply',reply,f.target,replyId,f.accessFor(reply));expect(f.reads()).toBe(reads);expect(f.checks()).toBe(checks);expect(f.starts).toHaveLength(1);expect(f.replies).toHaveLength(1);
});
test('a missing exact summary or changed proof creates no new thread intent and never starts a provider',async()=>{
 const f=await fixture(),id=crypto.randomUUID(),tampered={...f.createInput,text:'summary removed'};
 await expect(f.service.perform('workroom.threads.create',tampered,f.target,id,f.accessFor(tampered))).rejects.toThrow();expect(await f.store.get(id)).toBeNull();expect(f.starts).toEqual([]);
 f.change();const next=crypto.randomUUID();await expect(f.service.perform('workroom.threads.create',f.createInput,f.target,next,f.accessFor(f.createInput))).rejects.toThrow();expect(await f.store.get(next)).toBeNull();expect(f.starts).toEqual([]);
});
test('an authority change after durable admission preserves an uncertain receipt without sending',async()=>{
 const f=await fixture(),id=crypto.randomUUID(),access=f.accessFor(f.createInput),original=access.withInputContext!;let calls=0;
 access.withInputContext=async operation=>{if(++calls===2)f.change();return original(operation);};
 await f.service.perform('workroom.threads.create',f.createInput,f.target,id,access);await f.service.idle();expect(f.starts).toEqual([]);
 const record=(await f.store.get(id))!;expect(record.state).toBe('unknown');expect(record.messages[0]!.delivery).toBe('unknown');
 const before=calls;await f.service.perform('workroom.threads.create',f.createInput,f.target,id,access);expect(calls).toBe(before);
});
test('proof-free existing submissions keep their original pipeline',async()=>{
 const f=await fixture();const store=f.store;let starts=0;
 const service=new WorkroomThreadService({store,resolve:async()=>({fingerprint:'old'}),inspect:()=>({state:'running',inputRevision:0}),start:async()=>{starts++;return {written:false};},reply:async()=>({written:false})});
 await service.perform('workroom.threads.create',{agent:'codex',text:'ordinary task'},f.target,crypto.randomUUID(),{owner:'local',active:()=>true,readAll:true});await service.idle();expect(starts).toBe(1);
});
test('remote owners cannot supply a local context hook, and USE/multiple-project proofs are rejected',async()=>{
 const f=await fixture(),id=crypto.randomUUID();
 await expect(f.service.perform('workroom.threads.create',f.createInput,f.target,id,{...f.accessFor(f.createInput),owner:'remote-owner'})).rejects.toThrow();expect(await f.store.get(id)).toBeNull();
 await expect(f.service.perform('workroom.threads.create',{...f.createInput,targetIds:[f.target,'other-project']},f.target,id,f.accessFor(f.createInput))).rejects.toThrow();
 await expect(f.service.perform('workroom.threads.create',{...f.createInput,use:{serviceKey:'default',operation:'status',input:{}} as never},f.target,id,f.accessFor(f.createInput))).rejects.toThrow();expect(f.starts).toEqual([]);
});
