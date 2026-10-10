import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,readFileSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Database} from 'bun:sqlite';
import {initializeProjectMemory,detectProjectMemory,readMemoryDocument,writeMemoryDocument,readProjectMemoryJournal,prepareProjectMemoryUpdate} from '../project-memory-server';
import {MemorySaveStore} from '../src/memorySaveStore';
import {MemorySessionStore} from '../src/memorySessionStore';
import {MemoryEmergencyReserve} from '../src/memoryEmergencyReserve';
import {CompletedMemoryTurnReader} from '../src/memorySaveObservation';
import {executeAutomaticMemorySave,commitAutomaticMemoryProposal,type MemorySaveExecution} from '../src/memorySaveExecutor';
import {acquireWorkspaceDirectoryLease,type WorkspaceLease} from '../src/workspaceLease';
import {saveDigest} from '../src/memorySaveContract';
import {reviewAmbiguousMemorySave,executeAmbiguousMemorySave,type MemoryRecoveryExecution} from '../src/memorySaveRecoveryExecutor';
const roots:string[]=[],leases:WorkspaceLease[]=[];
afterEach(()=>{for(const lease of leases.splice(0))lease.release();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
async function fixture(){
 const base=realpathSync(mkdtempSync(join(tmpdir(),'memory-executor-')));roots.push(base);
 const root=join(base,'project'),app=join(base,'app'),transcriptRoot=join(base,'transcripts');for(const path of [root,app,transcriptRoot])mkdirSync(path);
 const status=initializeProjectMemory({folderPath:root,autoBackup:false});
 const memoryId=status.config!.memoryId,before=readMemoryDocument(root,status.memoryPath!);
 const workspaceLease=await acquireWorkspaceDirectoryLease({workspacePath:root,appDataDir:app,attempts:1,deadOwnerRecoveryClass:'manual'});leases.push(workspaceLease);
 const stagingLease=await acquireWorkspaceDirectoryLease({workspacePath:app,appDataDir:app,attempts:1,deadOwnerRecoveryClass:'manual'});leases.push(stagingLease);
 await new MemoryEmergencyReserve(app,stagingLease).ensure();
 let now=Date.now()-2000;const saves=new MemorySaveStore(join(app,'memory-save-v2.sqlite'),()=>now),sessions=new MemorySessionStore(join(app,'memory-session-recovery.sqlite'));
 const bindingDigest=saveDigest('verified text provider');saves.setAutomaticPolicy(0,{enabled:true,consentVersion:1,providerBindingDigest:bindingDigest});now+=1000;
 const binding={agent:'codex' as const,instanceId:'fixture',sessionId:'session',cwd:root,memoryId,policyEpoch:1};
 const timestamp=new Date(now).toISOString(),path=join(transcriptRoot,'session.jsonl');
 const rows=[{type:'session_meta',payload:{id:'session',cwd:root,source:'cli'}},
  {type:'event_msg',timestamp,payload:{type:'task_started',turn_id:'turn'}},
  {type:'turn_context',payload:{cwd:root,turn_id:'turn'}},
  {type:'event_msg',timestamp,payload:{type:'user_message',message:'Prefer verified project evidence.'}},
  {type:'event_msg',timestamp,payload:{type:'agent_message',message:'Confirmed.'}},
  {type:'event_msg',timestamp,payload:{type:'task_complete',turn_id:'turn'}}];
 const bytes=rows.map(row=>Buffer.from(JSON.stringify(row)+'\n'));writeFileSync(path,Buffer.concat(bytes));
 const reader=new CompletedMemoryTurnReader(binding);let offset=0;for(const b of bytes){reader.record(b,offset);offset+=b.length;}
 expect(reader.sources).toHaveLength(1);saves.observeBatch(reader.sources);
 const c:MemorySaveExecution={root,appDataRoot:app,workspaceLease,stagingLease,saves,sessions,sources:[{source:reader.sources[0]!,binding,path,transcriptRoot}],
  provider:{agent:'claude',bindingDigest,ready:async()=>true,propose:async()=>{throw new Error('missing fixture proposal');}},readKey:async()=>randomBytes(32),
  validateRegistration:async()=>({memoryId,canonicalRoot:root}),preflight:async()=>{}};
 let calls=0,input:Buffer|undefined,originalInput='';
 c.provider.propose=async b=>{calls++;input=b;originalInput=b.toString();
  const prepared=prepareProjectMemoryUpdate({folderPath:root},{text:'',stats:{excerpts:0,claudeConsidered:0,claudeMatched:0,claudeUnreadable:0,claudeOwnershipRejected:0,codexConsidered:0,codexMatched:0,codexUnreadable:0,codexOwnedUnreadable:0}});
  return prepared.targetedSection?`SESSION: Verified project evidence was retained.\n${prepared.targetedSection.text}\n### Save evidence\nUse checked project evidence.\n`:before;
 };
 return {c,before,path,root,memoryId,journalCount:readProjectMemoryJournal(root).length,calls:()=>calls,input:()=>input,originalInput:()=>originalInput,now:(value:number)=>{now=value;}};
}


async function recoveryFixture(){
 const f=await fixture(),propose=f.c.provider.propose;
 f.c.provider.propose=async()=>{throw new Error('ambiguous original response');};
 await expect(executeAutomaticMemorySave(f.c)).rejects.toThrow('ambiguous original');
 const parent=f.c.saves.openJob(f.memoryId)!;f.now(Date.now()+31*60*1000);f.c.provider.propose=propose;
 const c:MemoryRecoveryExecution={...f.c,targetId:'fixture-project',cwd:f.root,instanceId:'fixture',
  candidates:[{key:'fixture',stamp:'1',agent:'codex',sessionId:'session',path:f.path,transcriptRoot:f.c.sources[0]!.transcriptRoot}]};
 return {...f,c,parent,originalExecution:f.c};
}

test('review preserves parent and memory; one consent makes a successor receipt and duplicate never calls AI',async()=>{
 const f=await recoveryFixture();
 const before=JSON.stringify(f.c.saves.recoveryCandidate(f.parent.saveId));
 const review=await reviewAmbiguousMemorySave(f.c,f.parent.saveId);
 expect(f.calls()).toBe(0);expect(review.sourceCount).toBe(1);
 expect(JSON.stringify(f.c.saves.recoveryCandidate(f.parent.saveId))).toBe(before);
 expect(readMemoryDocument(f.root,join(f.root,'.agent-memory/CORE.md'))).toBe(f.before);
 const request={approvalId:review.approvalId,reviewDigest:review.reviewDigest,explicitConsent:true as const};
 const result=await executeAmbiguousMemorySave(f.c,request);
 expect(result).toMatchObject({dispatched:true,localSaved:true});expect(f.calls()).toBe(1);
 expect(f.c.saves.get(f.parent.saveId).phase).toBe('superseded-unknown');
 expect(f.c.saves.latestJob(f.memoryId)?.phase).toBe('local-saved');
 expect(readProjectMemoryJournal(f.root)).toHaveLength(f.journalCount+1);
 expect(await executeAmbiguousMemorySave(f.c,request)).toMatchObject({dispatched:false});expect(f.calls()).toBe(1);
 const db=new Database(f.c.saves.path,{readonly:true});try{
  expect(db.query('SELECT count(*) AS n FROM save_auto_attempts').get()).toEqual({n:2});
  expect(db.query('SELECT saveId FROM save_sources').get()).toEqual({saveId:f.parent.saveId});
  expect(db.query('SELECT receipt FROM save_jobs WHERE saveId=?').get(f.parent.saveId)).toEqual({receipt:null});
 }finally{db.close();}
});

test('changed source, memory, registration, model or remote preflight never admits a successor',async()=>{
 for(const kind of ['source','memory','registration','provider','remote','key']){
  const f=await recoveryFixture(),review=await reviewAmbiguousMemorySave(f.c,f.parent.saveId);
  if(kind==='source')writeFileSync(f.path,'invalid source');
  if(kind==='memory')writeMemoryDocument(f.root,join(f.root,'.agent-memory/CORE.md'),f.before+'\nNew durable decision.\n');
  if(kind==='registration')f.c.validateRegistration=async()=>null;
  if(kind==='provider')f.c.provider.ready=async()=>false;
  if(kind==='remote')f.c.preflight=async()=>{throw new Error('changed remote head');};
  if(kind==='key')f.c.readKey=async()=>{throw new Error('missing key');};
  await expect(executeAmbiguousMemorySave(f.c,{approvalId:review.approvalId,reviewDigest:review.reviewDigest,explicitConsent:true})).rejects.toThrow();
  expect(f.calls()).toBe(0);expect(f.c.saves.get(f.parent.saveId).phase).toBe('recovery-required');
  const db=new Database(f.c.saves.path,{readonly:true});try{expect(db.query('SELECT count(*) AS n FROM save_auto_attempts').get()).toEqual({n:1});}finally{db.close();}
 }
},15_000);

test('unapproved and expired reviews do not dispatch',async()=>{
 const f=await recoveryFixture(),review=await reviewAmbiguousMemorySave(f.c,f.parent.saveId);
 const request={approvalId:review.approvalId,reviewDigest:review.reviewDigest,explicitConsent:true as const};
 await expect(executeAmbiguousMemorySave(f.c,{...request,explicitConsent:false as any})).rejects.toThrow();
 f.now(review.expiresAt);
 await expect(executeAmbiguousMemorySave(f.c,request)).rejects.toThrow();expect(f.calls()).toBe(0);
 expect(f.c.saves.get(f.parent.saveId).phase).toBe('recovery-required');
});

test('failed successor remains fenced and cannot be turned into another automatic retry',async()=>{
 const f=await recoveryFixture(),review=await reviewAmbiguousMemorySave(f.c,f.parent.saveId);let calls=0;
 f.c.provider.propose=async()=>{calls++;throw new Error('second response unknown');};
 const request={approvalId:review.approvalId,reviewDigest:review.reviewDigest,explicitConsent:true as const};
 await expect(executeAmbiguousMemorySave(f.c,request)).rejects.toThrow('second response unknown');
 expect(f.c.saves.latestJob(f.memoryId)?.phase).toBe('recovery-required');expect(calls).toBe(1);
 expect(await executeAmbiguousMemorySave(f.c,request)).toMatchObject({dispatched:false});
 await expect(reviewAmbiguousMemorySave(f.c,f.c.saves.latestJob(f.memoryId)!.saveId)).rejects.toThrow();
 expect(calls).toBe(1);expect(readMemoryDocument(f.root,join(f.root,'.agent-memory/CORE.md'))).toBe(f.before);
});


test('late parent proposal cannot leave an obsolete host plan after successor admission',async()=>{
 const f=await recoveryFixture(),review=await reviewAmbiguousMemorySave(f.c,f.parent.saveId),approval=f.c.saves.recoveryApproval(review.approvalId)!;
 f.c.saves.admitRecoverySuccessor({approvalId:review.approvalId,reviewDigest:review.reviewDigest,explicitConsent:true,binding:approval.binding});
 const prepared=prepareProjectMemoryUpdate({folderPath:f.root},{text:'',stats:{excerpts:0,claudeConsidered:0,claudeMatched:0,claudeUnreadable:0,claudeOwnershipRejected:0,codexConsidered:0,codexMatched:0,codexUnreadable:0,codexOwnedUnreadable:0}});
 const raw='SESSION: Retain the original decision.\n'+prepared.targetedSection!.text;
 await expect(commitAutomaticMemoryProposal(f.originalExecution,prepared,raw,{saveId:f.parent.saveId,attemptId:f.parent.attemptId!},async()=>true,()=>{})).rejects.toThrow('REVISION_CONFLICT');
 expect(f.c.sessions.status(f.root,{readOnly:true})).toBeNull();expect(f.calls()).toBe(0);
 expect(readMemoryDocument(f.root,join(f.root,'.agent-memory/CORE.md'))).toBe(f.before);
});

test('project prompt changes after review require a new approval without altering the old attempt',async()=>{
 const f=await recoveryFixture(),review=await reviewAmbiguousMemorySave(f.c,f.parent.saveId);
 execFileSync('git',['init','-q'],{cwd:f.root});
 writeFileSync(join(f.root,'package.json'),JSON.stringify({name:'changed-context',scripts:{test:'bun test'}}));
 await expect(executeAmbiguousMemorySave(f.c,{approvalId:review.approvalId,reviewDigest:review.reviewDigest,explicitConsent:true})).rejects.toThrow('REVISION_CONFLICT');
 expect(f.calls()).toBe(0);expect(f.c.saves.get(f.parent.saveId).phase).toBe('recovery-required');
});
