import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkPackStore} from '../src/workPackStore';
import {createLocalWorkPackSourceReader,commandSourceRevision} from '../src/workPackGuideSource';
import {WorkPackHost} from '../src/workPackHost';
import type {PromptGuideKeyProvider} from '../src/promptGuideKeyProvider';
import type {PromptGuideEntry,PromptGuideSnapshot} from '../src/promptGuideStore';
import type {ReadToolBatchResult} from '../src/readToolBatchHost';

const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const command=(patch:Partial<PromptGuideEntry>={}):PromptGuideEntry=>({id:'cmd-status',title:'개발 현황 조회',body:'Summarise the project state.',pinned:false,updatedAt:'2026-10-24T00:00:00Z',kind:'command',...patch});
const plan={steps:[{id:'git',input:{operation:'project.git.read'}},{id:'tester',input:{operation:'tester.status.read'}},
 {id:'report',input:{operation:'tester.report.read',runId:{stepId:'tester',field:'latest.runId'}},dependsOn:['tester'],condition:'on-report-present'},
 {id:'memory',input:{operation:'memory.reference.read',role:'dev',query:'release checklist'}}]};
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'work-pack-host-'));roots.push(root);
 let key:Buffer|null=null;const keyProvider:PromptGuideKeyProvider={async read(){return key?Buffer.from(key):null;},async create(){key??=Buffer.alloc(32,9);return Buffer.from(key);}};
 let guides:PromptGuideSnapshot={revision:'lib-1',entries:[command(),{...command({id:'simple-one',title:'Plain prompt'}),kind:undefined}]};
 const source={read:async()=>structuredClone(guides)},reader=createLocalWorkPackSourceReader(source);
 const store=new WorkPackStore({appDataDir:join(root,'app-data'),keyProvider,sourceReader:reader});
 const starts:any[]=[],reads:any[]=[];const receipts=new Map<string,ReadToolBatchResult>();
 const batch={
  async start(_owner:string,input:any){starts.push(structuredClone(input));
   const stages=input.plan.steps.map((s:any)=>({id:s.id,operation:s.input.operation,state:s.condition==='on-report-present'?'skipped':'completed',availability:'ready',freshness:'current'}));
   const result={batch:{runId:'run-'+starts.length,threadId:input.threadId,requestId:input.requestId,owner:'local',targetId:input.targetId,bindingHash:'b'.repeat(64),intentHash:'c'.repeat(64),bootId:'boot',revision:2,createdAt:1,updatedAt:2,state:'partial',stages,payload:'unavailable'},payload:'unavailable'} as unknown as ReadToolBatchResult;
   receipts.set(input.requestId,result);return result;},
  async read(_owner:string,input:any){reads.push(input);const found=receipts.get(input.requestId);if(!found)throw Object.assign(new Error('missing'),{code:'PROJECT_STATE_BATCH_UNAVAILABLE'});return found;},
 };
 const host=new WorkPackHost({store,guides:source,reader,batch});
 return {host,starts,reads,setGuides:(next:PromptGuideSnapshot)=>{guides=next;},guides:()=>guides,run:(requestId:string,values?:unknown)=>host.run('local',{targetId:'project-a',threadId:'thread-1',requestId,guideId:'cmd-status',...(values===undefined?{}:{values})})};
}

test('saving is the review: a pack binds to the command body and lists only commands as sources',async()=>{
 const f=fixture(),empty=await f.host.list();
 expect(empty.commands).toEqual([{guideId:'cmd-status',title:'개발 현황 조회'}]);expect(empty.packs).toEqual([]);
 const saved=await f.host.save({expectedRevision:empty.revision,guideId:'cmd-status',plan,queryInput:true});
 expect(saved.packs).toHaveLength(1);
 expect(saved.packs[0]).toMatchObject({guideId:'cmd-status',title:'개발 현황 조회',state:'reviewed',query:{default:'release checklist'}});
 expect(saved.packs[0]!.steps.map(s=>s.id)).toEqual(['git','tester','report','memory']);
 await expect(f.host.save({expectedRevision:saved.revision,guideId:'simple-one',plan})).rejects.toThrow();
 await expect(f.host.save({expectedRevision:'stale-revision',guideId:'cmd-status',plan})).rejects.toThrow();
});

test('a pin or reorder keeps the review; a changed body stales it and a deleted command orphans it',async()=>{
 const f=fixture(),saved=await f.host.save({expectedRevision:(await f.host.list()).revision,guideId:'cmd-status',plan});
 f.setGuides({...f.guides(),revision:'lib-2',entries:f.guides().entries.map(e=>({...e,pinned:true}))});
 expect((await f.host.list()).packs[0]!.state).toBe('reviewed');
 f.setGuides({...f.guides(),revision:'lib-3',entries:[command({body:'A different instruction.'})]});
 expect((await f.host.list()).packs[0]!.state).toBe('stale');
 await expect(f.run('request-stale')).rejects.toThrow();expect(f.starts).toHaveLength(0);
 // Re-saving reviews the pack against the current body.
 const again=await f.host.save({expectedRevision:saved.revision,guideId:'cmd-status',plan});expect(again.packs[0]!.state).toBe('reviewed');
 f.setGuides({revision:'lib-4',entries:[]});expect((await f.host.list()).packs[0]!.state).toBe('orphan');
 expect(commandSourceRevision(command())).not.toBe(commandSourceRevision(command({body:'A different instruction.'})));
});

test('run prepares the reviewed plan with the query value and a known request ID never starts again',async()=>{
 const f=fixture();await f.host.save({expectedRevision:(await f.host.list()).revision,guideId:'cmd-status',plan,queryInput:true});
 const first=await f.run('request-1',{query:'deployment notes'});
 expect(f.starts).toHaveLength(1);expect(f.starts[0].plan.steps.find((s:any)=>s.id==='memory').input.query).toBe('deployment notes');
 expect(f.starts[0]).toMatchObject({targetId:'project-a',threadId:'thread-1',requestId:'request-1'});
 // Conditional report is not required for completion; every always-step completed.
 expect(first.completion).toMatchObject({complete:true,meaning:'read-completion-only'});
 const retried=await f.run('request-1',{query:'something else'});expect(f.starts).toHaveLength(1);expect(retried.batch.runId).toBe(first.batch.runId);
 const read=await f.host.read('local',{targetId:'project-a',threadId:'thread-1',requestId:'request-1',guideId:'cmd-status'});expect(read.completion?.complete).toBe(true);
 await expect(f.run('request-2',{query:'/etc/passwd'})).rejects.toThrow();await expect(f.run('request-3',{other:'x'})).rejects.toThrow();expect(f.starts).toHaveLength(1);
});

test('a disabled pack is kept but never runs',async()=>{
 const f=fixture(),saved=await f.host.save({expectedRevision:(await f.host.list()).revision,guideId:'cmd-status',plan});
 const disabled=await f.host.disable({expectedRevision:saved.revision,guideId:'cmd-status'});expect(disabled.packs[0]!.state).toBe('disabled');
 await expect(f.run('request-off')).rejects.toThrow();expect(f.starts).toHaveLength(0);
});
