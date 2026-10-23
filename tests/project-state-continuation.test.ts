import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,chmodSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorkroomThreadStore} from '../src/workroomThreadStore';
import {WorkroomThreadService,type WorkroomThreadAccess,type WorkroomThreadDependencies} from '../src/workroomThreadService';
import {ProjectStateBundleHost} from '../src/projectStateBundleHost';
import {createProjectStateBundleSources} from '../src/projectStateBundleSources';
import type {SectionId,SourceObservation} from '../src/projectStateBundle';
import type {WorkroomActivityEntry} from '../src/aiTerminalActivity';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
/** Real encrypted thread store + service + state host + production Workroom projection.
 * Only CLI opening/writing and the activity snapshot are synthetic; no AI or Keychain. */
async function fixture(mode:'resume'|'fresh',otherChanges=false,passExclusion=true){
 const root=mkdtempSync(join(tmpdir(),'state-continuation-'));chmodSync(root,0o700);roots.push(root);
 const targetId='continuation-project',oldId=crypto.randomUUID(),newId=crypto.randomUUID(),at=1_790_000_000_000;
 const activity=(sessionId:string,state:WorkroomActivityEntry['state'],time=at):WorkroomActivityEntry=>({sessionId,targetId,agent:'codex',state,since:time,turn:0,source:'transcript',exact:true,lastOutputAt:time});
 const rows:WorkroomActivityEntry[]=[activity(oldId,'working'),activity('unrelated-existing-session','idle')];
 const store=new WorkroomThreadStore(root,{read:async()=>Buffer.alloc(32,19),create:async()=>Buffer.alloc(32,19)});
 const opens:string[]=[],writes:string[]=[],contexts:(string|undefined)[]=[];let service:WorkroomThreadService;
 const deps:WorkroomThreadDependencies={store,resolve:async()=>({fingerprint:'stable-checkout'}),inspect:()=>({state:'running',inputRevision:0}),
  start:async(_id,targetId,agent)=>({written:true,session:{id:oldId,targetId,agent,state:'running',createdAt:new Date(at).toISOString(),exitCode:null,cols:100,rows:28}}),
  open:async(_id,record)=>{opens.push(record.continuation!.mode);rows.push(activity(newId,'starting',at+1000));if(otherChanges){rows[1]!.state='working';rows[1]!.lastOutputAt=at+2000;}return {id:newId,targetId,agent:'codex',state:'running',createdAt:new Date(at+1000).toISOString(),exitCode:null,cols:100,rows:28};},
  reply:async(_id,sessionId,text)=>{expect(sessionId).toBe(newId);writes.push(text);return {written:true};}};
 service=new WorkroomThreadService(deps);
 const plainAccess:WorkroomThreadAccess={owner:'local',active:()=>true,readAll:false},threadId=crypto.randomUUID();
 await service.perform('workroom.threads.create',{agent:'codex',text:'Existing DEV task'},targetId,threadId,plainAccess);await service.idle();
 rows[0]!.state='exited';await service.ended(oldId);
 if(mode==='fresh')await store.mutate(threadId,()=>true,r=>{r!.continuation={sessionId:oldId,mode:'fresh'};return {record:r!,value:null};});
 const workroom=createProjectStateBundleSources({workroom:()=>rows}).workroom;
 const git:SourceObservation={id:'git',availability:'ready',freshness:'current',observedAt:at,sourceRevision:'git-v1',summary:['stable branch and source'],limits:[]};
 const host=new ProjectStateBundleHost({resolve:async(owner,id)=>({targetId:id,projectId:id,owner,role:'dev',proof:'stable-proof',sourceProofComplete:true}),readers:{workroom,git:{read:async(_b,input)=>{expect(input.excludeWorkroomSessionId).toBeUndefined();return git;}}}});
 const bundle=await host.preview('local',{targetId}),selection={targetId,bundleId:bundle.id,sections:['git','workroom'] as SectionId[]},prepared=await host.prepare('local',selection),sendInput={...selection,selectionHash:prepared.selectionHash};
 const text='Continue the existing task.\n\n'+prepared.text;
 const access:WorkroomThreadAccess={...plainAccess,async withInputContext<T>(operation:()=>Promise<T>,context?:{excludeWorkroomSessionId:string}):Promise<T>{contexts.push(context?.excludeWorkroomSessionId);return host.withPrepared('local',sendInput,async current=>{expect(text.includes(current.text)).toBe(true);return operation();},undefined,passExclusion?context:undefined);}};
 const before=(await store.get(threadId))!,id=crypto.randomUUID(),body={threadId,text,expectedRevision:before.revision,projectState:{bundleId:prepared.bundleId,sections:selection.sections,selectionHash:prepared.selectionHash}};
 const reply=()=>service.perform('workroom.threads.reply',body,targetId,id,access);
 return {service,store,host,rows,threadId,id,newId,reply,opens,writes,contexts,text};
}
for(const mode of ['resume','fresh'] as const){
 test(`${mode}: selected Workroom state does not invalidate its own replacement session and the original request writes once`,async()=>{
  const f=await fixture(mode);const result=await f.reply();
  expect(result.thread!.state).toBe('running');expect(result.thread!.sessionId).toBe(f.newId);expect(f.opens).toEqual([mode]);expect(f.writes).toHaveLength(1);expect(f.writes[0]).toContain(f.text);expect(f.contexts).toEqual([undefined,f.newId]);
  const record=(await f.store.get(f.threadId))!;expect(record.messages.find(m=>m.id===f.id)!.delivery).toBe('written');expect(record.previousSessions).toHaveLength(1);
  await f.reply();expect(f.opens).toEqual([mode]);expect(f.writes).toHaveLength(1);expect(f.host.diagnostics().activePreviews).toBe(0);
 });
 test(`${mode}: excluding its replacement never masks another session changing during open`,async()=>{
  const f=await fixture(mode,true);const result=await f.reply();
  expect(result.thread!.state).toBe('unknown');expect(f.contexts).toEqual([undefined,f.newId]);expect(f.opens).toEqual([mode]);expect(f.writes).toEqual([]);expect((await f.store.get(f.threadId))!.messages.find(m=>m.id===f.id)!.delivery).toBe('unknown');
  await f.reply();expect(f.opens).toEqual([mode]);expect(f.writes).toEqual([]);expect(f.host.diagnostics().activePreviews).toBe(0);
 });
}
test('without the trusted replacement exclusion the same continuation self-invalidates before any PTY write',async()=>{
 const f=await fixture('resume',false,false);const result=await f.reply();expect(result.thread!.state).toBe('unknown');expect(f.opens).toEqual(['resume']);expect(f.writes).toEqual([]);expect(f.contexts).toEqual([undefined,f.newId]);
});
