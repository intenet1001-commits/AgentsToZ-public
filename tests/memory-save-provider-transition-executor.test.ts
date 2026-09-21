import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Database} from 'bun:sqlite';
import {detectProjectMemoryIdentity,initializeProjectMemory,prepareProjectMemoryUpdate,readMemoryDocument,readProjectMemoryJournal} from '../project-memory-server';
import {MemorySaveStore} from '../src/memorySaveStore';
import {MemorySessionStore} from '../src/memorySessionStore';
import {MemoryEmergencyReserve} from '../src/memoryEmergencyReserve';
import {CompletedMemoryTurnReader} from '../src/memorySaveObservation';
import {executeAutomaticMemorySave,type MemorySaveExecution} from '../src/memorySaveExecutor';
import {prepareMemoryProvider,memorySaveTextProvider,type MemoryProviderHost} from '../src/memorySaveProvider';
import {reviewRecoveryProvider,verifyRecoveryProvider} from '../src/memorySaveProviderTransitionExecutor';
import {reviewAmbiguousMemorySave,executeAmbiguousMemorySave,type MemoryRecoveryExecution} from '../src/memorySaveRecoveryExecutor';
import {acquireWorkspaceDirectoryLease,type WorkspaceLease} from '../src/workspaceLease';
import {saveDigest} from '../src/memorySaveContract';

const roots:string[]=[],leases:WorkspaceLease[]=[];
afterEach(()=>{for(const lease of leases.splice(0))lease.release();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const request=(review:{approvalId:string;reviewDigest:string})=>({approvalId:review.approvalId,reviewDigest:review.reviewDigest,explicitConsent:true as const});
async function fixture(options:{linkedWorktree?:boolean}={}){
 const base=realpathSync(mkdtempSync(join(tmpdir(),'memory-transition-executor-')));roots.push(base);
 const root=join(base,'project'),app=join(base,'app'),transcriptRoot=join(base,'transcripts');for(const path of [root,app,transcriptRoot])mkdirSync(path);
 let cwd=root;
 if(options.linkedWorktree){
  // This private Git family exercises the production main-memory resolution;
  // no user repository, signing setup, hooks or provider process is involved.
  const git=(args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false',...args],{
   cwd:root,stdio:'ignore',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},
  });
  git(['init','-q','-b','main']);
  git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-q','--allow-empty','--no-gpg-sign','-m','fixture']);
  cwd=join(base,'linked-worktree');git(['worktree','add','-q','-b','fixture-linked',cwd]);
 }
 const status=initializeProjectMemory({folderPath:root,autoBackup:false}),memoryId=status.config!.memoryId;
 const before=readMemoryDocument(root,status.memoryPath!),bin=join(base,'fixture-cli');writeFileSync(bin,'original executable');chmodSync(bin,0o700);
 const workspaceLease=await acquireWorkspaceDirectoryLease({workspacePath:root,appDataDir:app,attempts:1,deadOwnerRecoveryClass:'manual'});leases.push(workspaceLease);
 const stagingLease=await acquireWorkspaceDirectoryLease({workspacePath:app,appDataDir:app,attempts:1,deadOwnerRecoveryClass:'manual'});leases.push(stagingLease);
 await new MemoryEmergencyReserve(app,stagingLease).ensure();
 let now=Date.now()-2000,account='fixture',unknown=true,probes=0,summaries=0,auth=0;
 const saves=new MemorySaveStore(join(app,'memory-save-v2.sqlite'),()=>now),sessions=new MemorySessionStore(join(app,'memory-session-recovery.sqlite'));
 const host:MemoryProviderHost={appDataRoot:app,installationId:'fixture-install',executable:()=>bin,now:()=>now,run:async(_argv,_cwd,input)=>{
  if(input===undefined){auth++;return {exitCode:0,stderr:'',stdout:JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',email:account+'@example.invalid',orgId:'fixture-org'})};}
  const canary=input==='Return only MEMORY_SAVE_READY with no punctuation or other text.';
  if(canary)probes++;else{summaries++;if(unknown)throw new Error('fixture original response unknown');}
  const prepared=canary?null:prepareProjectMemoryUpdate({folderPath:root},{text:'',stats:{excerpts:0,claudeConsidered:0,claudeMatched:0,claudeUnreadable:0,claudeOwnershipRejected:0,codexConsidered:0,codexMatched:0,codexUnreadable:0,codexOwnedUnreadable:0}},{requireInitialized:true});
  const result=canary?'MEMORY_SAVE_READY':prepared!.targetedSection?`SESSION: Verified evidence remains retained.\n${prepared!.targetedSection.text}\n### Verified recovery\nPreserve the original attempt history.\n`:before;
  return {exitCode:0,stderr:'',stdout:JSON.stringify({type:'result',subtype:'success',is_error:false,result,modelUsage:{'claude-fixture-1':{inputTokens:1}},permission_denials:[]})};
 }};
 const prior=await prepareMemoryProvider(host,'claude-fixture-1','low');probes=0;auth=0;saves.setProviderBinding(prior);
 saves.setAutomaticPolicy(0,{enabled:true,consentVersion:1,providerBindingDigest:saveDigest(prior),scopeMemoryId:memoryId,scopeTargetId:'fixture-project'});now+=1000;
 const binding={agent:'codex' as const,instanceId:'fixture',sessionId:'session',cwd,memoryId,policyEpoch:1};
 const path=join(transcriptRoot,'session.jsonl'),timestamp=new Date(now).toISOString();
 const rows=[{type:'session_meta',payload:{id:'session',cwd,source:'cli'}},{type:'event_msg',timestamp,payload:{type:'task_started',turn_id:'turn'}},
  {type:'turn_context',payload:{cwd,turn_id:'turn'}},{type:'event_msg',timestamp,payload:{type:'user_message',message:'Preserve verified project decisions.'}},
  {type:'event_msg',timestamp,payload:{type:'agent_message',message:'Confirmed.'}},{type:'event_msg',timestamp,payload:{type:'task_complete',turn_id:'turn'}}];
 const bytes=rows.map(row=>Buffer.from(JSON.stringify(row)+'\n'));writeFileSync(path,Buffer.concat(bytes));
 const reader=new CompletedMemoryTurnReader(binding);let offset=0;for(const bytesRow of bytes){reader.record(bytesRow,offset);offset+=bytesRow.length;}saves.observeBatch(reader.sources);
 const validateRegistration=async()=>{
  if(options.linkedWorktree){const current=await detectProjectMemoryIdentity(cwd);if(current.projectRoot!==root||current.config?.memoryId!==memoryId)return null;}
  return {memoryId,canonicalRoot:root};
 };
 const original:MemorySaveExecution={root,appDataRoot:app,workspaceLease,stagingLease,saves,sessions,sources:[{source:reader.sources[0]!,binding,path,transcriptRoot}],provider:memorySaveTextProvider(host,prior),readKey:async()=>randomBytes(32),validateRegistration,preflight:async()=>{}};
 await expect(executeAutomaticMemorySave(original)).rejects.toThrow('fixture original response unknown');
 const parent=saves.openJob(memoryId)!;now+=31*60*1000;unknown=false;writeFileSync(bin,'CLI updated after ambiguous original execution');
 const c:MemoryRecoveryExecution={...original,targetId:options.linkedWorktree?'fixture-linked-target':'fixture-project',cwd,instanceId:'fixture',providerHost:host,candidates:[{key:'fixture',stamp:'1',agent:'codex',sessionId:'session',path,transcriptRoot}]};
 const counts=()=>({probes,summaries,auth});
 const history=()=>{const db=new Database(saves.path,{readonly:true});try{return {parent:db.query('SELECT * FROM save_jobs WHERE saveId=?').get(parent.saveId),
  sources:db.query('SELECT * FROM save_sources ORDER BY sourceKey').all(),attempts:db.query('SELECT * FROM save_auto_attempts ORDER BY startedAt').all(),policy:JSON.parse((db.query('SELECT payload FROM save_auto_policy').get() as {payload:string}).payload)};}finally{db.close();}};
 return {c,host,bin,prior,parent,before,counts,history,advance:(ms:number)=>{now+=ms;},setAccount:(value:string)=>{account=value;}};
}

test('explicit CLI verification and successor admission are separate, preserving original history and exact new policy',async()=>{
 const f=await fixture(),before=f.history(),journal=readProjectMemoryJournal(f.c.root).length;
 await expect(reviewAmbiguousMemorySave(f.c,f.parent.saveId)).rejects.toThrow('POLICY_CHANGED');
 const review=await reviewRecoveryProvider(f.c);expect(review.binaryChanged).toBe(true);expect(f.counts().probes).toBe(0);
 expect(await verifyRecoveryProvider(f.c,request(review))).toEqual({dispatched:true,state:'ready'});
 const afterProbe=f.history();expect(afterProbe).toEqual(before);expect(f.c.saves.providerBinding()).toEqual(f.prior);
 const calls=f.counts();expect(await verifyRecoveryProvider({...f.c,saves:new MemorySaveStore(f.c.saves.path)},request(review))).toEqual({dispatched:false,state:'ready'});expect(f.counts()).toEqual(calls);
 f.advance(6*60*1000); // Completed proof remains usable only while the current identity still matches.
 const saveReview=await reviewAmbiguousMemorySave(f.c,f.parent.saveId);expect(f.counts().probes).toBe(1);expect(f.counts().summaries).toBe(1);
 expect(await executeAmbiguousMemorySave(f.c,request(saveReview))).toMatchObject({dispatched:true,localSaved:true});
 const after=f.history(),ready=f.c.saves.readyRecoveryProviderTransition(f.parent.saveId)!;
 expect(after.parent).toEqual({...before.parent as object,phase:'superseded-unknown'});expect(after.sources).toEqual(before.sources);
 expect(after.attempts).toHaveLength(2);expect(after.attempts[0]).toEqual(before.attempts[0]);
 expect(after.policy).toEqual({...before.policy,revision:before.policy.revision+1,providerBindingDigest:saveDigest(ready.readyBinding),lastClock:after.policy.lastClock});
 expect(f.c.saves.providerBinding()).toEqual(ready.readyBinding);expect(readProjectMemoryJournal(f.c.root)).toHaveLength(journal+1);
 expect(f.counts().probes).toBe(1);expect(f.counts().summaries).toBe(2);
 const afterCalls=f.counts();expect(await executeAmbiguousMemorySave(f.c,request(saveReview))).toMatchObject({dispatched:false});expect(f.counts()).toEqual(afterCalls);
});

test('a main-project opt-in recovers its linked worktree without allowing another target to reuse either approval',async()=>{
 const f=await fixture({linkedWorktree:true}),before=f.history(),journal=readProjectMemoryJournal(f.c.root).length;
 const identity=await detectProjectMemoryIdentity(f.c.cwd);
 expect(f.c.cwd).not.toBe(f.c.root);expect(identity.projectRoot).toBe(f.c.root);expect(identity.config!.memoryId).toBe(f.parent.memoryId);
 expect(f.c.saves.automaticPolicy().scopeTargetId).toBe('fixture-project');expect(f.c.targetId).toBe('fixture-linked-target');
 // The original automatic save already admitted the linked-worktree evidence.
 expect(f.parent.phase).toBe('recovery-required');expect(f.counts()).toMatchObject({probes:0,summaries:1});
 const main:MemoryRecoveryExecution={...f.c,targetId:'fixture-project',cwd:f.c.root,validateRegistration:async()=>{
  const current=await detectProjectMemoryIdentity(f.c.root);
  return current.config?.memoryId===f.parent.memoryId?{memoryId:f.parent.memoryId,canonicalRoot:current.projectRoot}:null;
 }};
 const providerReview=await reviewRecoveryProvider(f.c);
 expect(providerReview.targetId).toBe(f.c.targetId);expect(f.counts()).toMatchObject({probes:0,summaries:1});
 const beforeOtherProbe=f.counts();
 await expect(verifyRecoveryProvider(main,request(providerReview))).rejects.toThrow('REVISION_CONFLICT');
 expect(f.counts()).toEqual(beforeOtherProbe);expect(f.history()).toEqual(before);
 expect(await verifyRecoveryProvider(f.c,request(providerReview))).toEqual({dispatched:true,state:'ready'});
 expect(f.counts()).toMatchObject({probes:1,summaries:1});expect(f.history()).toEqual(before);expect(f.c.saves.providerBinding()).toEqual(f.prior);
 const afterProbe=f.counts();
 await expect(verifyRecoveryProvider(main,request(providerReview))).rejects.toThrow('REVISION_CONFLICT');
 expect(f.counts()).toEqual(afterProbe);
 const saveReview=await reviewAmbiguousMemorySave(f.c,f.parent.saveId);
 expect(saveReview.targetId).toBe(f.c.targetId);expect(f.counts()).toMatchObject({probes:1,summaries:1});
 const beforeOtherSave=f.counts();
 await expect(executeAmbiguousMemorySave(main,request(saveReview))).rejects.toThrow('REVISION_CONFLICT');
 expect(f.counts()).toEqual(beforeOtherSave);expect(f.history()).toEqual(before);
 expect(await executeAmbiguousMemorySave(f.c,request(saveReview))).toMatchObject({dispatched:true,localSaved:true});
 const after=f.history(),ready=f.c.saves.readyRecoveryProviderTransition(f.parent.saveId)!;
 expect(after.parent).toEqual({...before.parent as object,phase:'superseded-unknown'});expect(after.sources).toEqual(before.sources);
 expect(after.attempts).toHaveLength(2);expect(after.attempts[0]).toEqual(before.attempts[0]);
 expect(after.policy).toEqual({...before.policy,revision:before.policy.revision+1,providerBindingDigest:saveDigest(ready.readyBinding),lastClock:after.policy.lastClock});
 expect(after.policy.scopeTargetId).toBe('fixture-project');expect(f.c.saves.providerBinding()).toEqual(ready.readyBinding);
 expect(readProjectMemoryJournal(f.c.root)).toHaveLength(journal+1);expect(f.counts()).toMatchObject({probes:1,summaries:2});
 const completed=f.counts(),restarted={...f.c,saves:new MemorySaveStore(f.c.saves.path)};
 expect(await verifyRecoveryProvider(restarted,request(providerReview))).toEqual({dispatched:false,state:'ready'});
 expect(await executeAmbiguousMemorySave(restarted,request(saveReview))).toMatchObject({dispatched:false});
 expect(f.counts()).toEqual(completed);expect(f.history()).toEqual(after);
});

test('expired or changed provider reviews never claim a probe or modify the original parent',async()=>{
 for(const change of ['expired','binary','account','registration','consent']){
  const f=await fixture(),before=f.history(),review=await reviewRecoveryProvider(f.c);
  if(change==='expired')f.advance(5*60*1000);
  if(change==='binary')writeFileSync(f.bin,'changed after provider review');
  if(change==='account')f.setAccount('new-account');
  if(change==='registration')f.c.validateRegistration=async()=>null;
  const input=change==='consent'?{...request(review),explicitConsent:false as any}:request(review);
  await expect(verifyRecoveryProvider(f.c,input)).rejects.toThrow();
  expect(f.counts().probes).toBe(0);expect(f.history()).toEqual(before);expect(f.c.saves.latestRecoveryProviderTransition(f.parent.saveId)).toBeNull();
 }
},15_000);

test('a timed-out probe is durable unknown and replay after restart or a new review never calls it again',async()=>{
 const f=await fixture(),review=await reviewRecoveryProvider(f.c),run=f.host.run!;let dispatched=0;
 f.host.probeTimeoutMs=30;f.host.run=async(...args)=>{
  if(args[2]===undefined)return run(...args);dispatched++;
  return new Promise((_,reject)=>{const abort=()=>reject(new Error('fixture canary aborted'));args[4]!.addEventListener('abort',abort,{once:true});if(args[4]!.aborted)abort();});
 };
 await expect(verifyRecoveryProvider(f.c,request(review))).rejects.toMatchObject({code:'PROVIDER_PROBE_UNCONFIRMED'});
 expect(f.c.saves.latestRecoveryProviderTransition(f.parent.saveId)?.state).toBe('unknown');expect(f.c.saves.providerBinding()).toEqual(f.prior);
 const originalProbe=f.c.saves.latestRecoveryProviderTransition(f.parent.saveId)!;
 f.host.run=run;const nextReview=await reviewRecoveryProvider(f.c),calls=f.counts();
 expect(await verifyRecoveryProvider({...f.c,saves:new MemorySaveStore(f.c.saves.path)},request(review))).toEqual({dispatched:false,state:'unknown'});
 expect(f.counts()).toEqual(calls);expect(dispatched).toBe(1);
 expect(f.c.saves.get(f.parent.saveId).phase).toBe('recovery-required');
 // A fresh, explicitly consented review may spend its own one-call budget.
 expect(await verifyRecoveryProvider(f.c,request(nextReview))).toEqual({dispatched:true,state:'ready'});
 expect(f.counts().probes).toBe(1);expect(f.c.saves.recoveryProviderTransition(originalProbe.transitionId)).toEqual(originalProbe);
 expect(f.c.saves.providerBinding()).toEqual(f.prior);
});

test('in-flight duplicate and lease loss cannot publish a proof or repeat its canary',async()=>{
 const f=await fixture(),review=await reviewRecoveryProvider(f.c),run=f.host.run!;
 let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 f.host.run=async(...args)=>{if(args[2]!==undefined){entered();await gate;}return run(...args);};
 const first=verifyRecoveryProvider(f.c,request(review));await waiting;
 await expect(verifyRecoveryProvider(f.c,request(review))).rejects.toThrow('EXECUTION_BUSY');
 f.c.stagingLease.release();release();
 await expect(first).rejects.toThrow('POLICY_CHANGED');
 const nextLease=await acquireWorkspaceDirectoryLease({workspacePath:f.c.appDataRoot,appDataDir:f.c.appDataRoot,attempts:1,deadOwnerRecoveryClass:'manual'});leases.push(nextLease);f.c.stagingLease=nextLease;
 expect(f.c.saves.latestRecoveryProviderTransition(f.parent.saveId)?.state).toBe('unknown');expect(f.counts().probes).toBe(1);
 expect(await verifyRecoveryProvider(f.c,request(review))).toEqual({dispatched:false,state:'unknown'});expect(f.counts().probes).toBe(1);
});

test('new binary drift after summary review leaves global binding and original quota untouched',async()=>{
 const f=await fixture(),before=f.history(),review=await reviewRecoveryProvider(f.c);
 await verifyRecoveryProvider(f.c,request(review));const saveReview=await reviewAmbiguousMemorySave(f.c,f.parent.saveId);
 writeFileSync(f.bin,'new drift after final save review');
 await expect(executeAmbiguousMemorySave(f.c,request(saveReview))).rejects.toThrow('POLICY_CHANGED');
 expect(f.history()).toEqual(before);expect(f.c.saves.providerBinding()).toEqual(f.prior);expect(f.counts().summaries).toBe(1);
});
