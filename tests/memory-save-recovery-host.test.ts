import {afterEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeProjectMemory,prepareProjectMemoryUpdate,readMemoryDocument,readProjectMemoryJournal} from '../project-memory-server';
import {MemorySaveAutomaticHost,type AutomaticMemoryTarget} from '../src/memorySaveAutomaticHost';
import {MemorySaveStore} from '../src/memorySaveStore';
import {MemorySessionStore} from '../src/memorySessionStore';
import {MemorySaveDispatcher} from '../src/memorySaveDispatcher';
import {CompletedMemoryTurnReader} from '../src/memorySaveObservation';
import {acquireWorkspaceDirectoryLease} from '../src/workspaceLease';
import type {reviewAmbiguousMemorySave} from '../src/memorySaveRecoveryExecutor';
import type {reviewRecoveryProvider} from '../src/memorySaveProviderTransitionExecutor';

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();});

/** Real host, dispatcher, leases and SQLite stores; only the provider and
 * registered targets are fixtures. No production paths or remote calls. */
async function fixture(){
 const base=realpathSync(mkdtempSync(join(tmpdir(),'memory-recovery-host-')));
 const app=join(base,'app'),root=join(base,'project'),otherRoot=join(base,'other-project'),transcripts=join(base,'transcripts');
 for(const path of [app,root,otherRoot,transcripts])mkdirSync(path);
 const initialized=initializeProjectMemory({folderPath:root,autoBackup:false}),memoryId=initialized.config!.memoryId;
 const bin=join(base,'fixture-cli');writeFileSync(bin,'fixture');chmodSync(bin,0o700);
 const transcript=join(transcripts,'session.jsonl');
 let now=Date.now()-1000,registrationValid=true,failProposal=true,failProbe=false;
 const counts={proposals:0,connectionTests:0,authReads:0,keys:0,resolve:0,discover:0,appLeases:0,workspaceLeases:0,ordinaryPreflight:0,recoveryPreflight:0};
 const store=new MemorySaveStore(join(app,'memory-save-v2.sqlite'),()=>now);
 const sessions=new MemorySessionStore(join(app,'memory-session-recovery.sqlite')),dispatcher=new MemorySaveDispatcher();
 cleanups.push(async()=>{await dispatcher.shutdown();rmSync(base,{recursive:true,force:true});});
 const originalTarget:AutomaticMemoryTarget={id:'fixture-target',cwd:root,root,memoryId,validate:async()=>registrationValid};
 let resolvedTarget=originalTarget;
 const dependencies:ConstructorParameters<typeof MemorySaveAutomaticHost>[0]={
  enabled:()=>true,store,sessions,appDataRoot:app,portalDataFile:join(app,'portal.json'),dispatcher,
  identity:create=>{expect(create).toBeBoolean();return 'fixture-install';},
  targets:async()=>[{id:resolvedTarget.id}],
  resolve:async id=>{counts.resolve++;return id===resolvedTarget.id?resolvedTarget:null;},
  discover:async()=>{counts.discover++;return [{key:'fixture',stamp:`${statSync(transcript).size}:${statSync(transcript).mtimeMs}`,agent:'codex',path:transcript,transcriptRoot:transcripts,sessionId:'session'}];},
  key:()=>({load:async()=>{counts.keys++;return Buffer.alloc(32,7);}}),
  providerHost:id=>({appDataRoot:app,installationId:id,executable:()=>bin,run:async(_args,_cwd,input)=>{
   if(input===undefined){counts.authReads++;return {exitCode:0,stderr:'',stdout:JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',email:'fixture@example.invalid',orgId:'fixture-org'})};}
   let result='MEMORY_SAVE_READY';
   if(input==='Return only MEMORY_SAVE_READY with no punctuation or other text.'){counts.connectionTests++;if(failProbe)throw new Error('Fixture probe response missing');}
   else{
    counts.proposals++;
    if(failProposal)throw new Error('unconfirmed fixture provider response');
    const prepared=prepareProjectMemoryUpdate({folderPath:root},{text:'',stats:{excerpts:0,claudeConsidered:0,claudeMatched:0,claudeUnreadable:0,claudeOwnershipRejected:0,codexConsidered:0,codexMatched:0,codexUnreadable:0,codexOwnedUnreadable:0}});
    result=prepared.targetedSection!.text+'\n### Checked recovery\nRetain verified completed evidence after explicit recovery.\n';
   }
   return {exitCode:0,stderr:'',stdout:JSON.stringify({type:'result',subtype:'success',is_error:false,result,modelUsage:{'claude-fixture-1':{}},permission_denials:[]})};
  }}),
  acquireApp:()=>{counts.appLeases++;return acquireWorkspaceDirectoryLease({workspacePath:app,appDataDir:app,attempts:1});},
  acquireWorkspace:path=>{counts.workspaceLeases++;return acquireWorkspaceDirectoryLease({workspacePath:path,appDataDir:app,attempts:1});},
  release:lease=>{lease.release();},preflight:async()=>{counts.ordinaryPreflight++;},
  recoveryPreflight:async()=>{counts.recoveryPreflight++;},disableLegacy:()=>{},
 };
 const host=new MemorySaveAutomaticHost(dependencies);
 const request=(operation:string,extra:Record<string,unknown>={},selectedHost=host)=>selectedHost.manage({automaticOperation:operation,observationTargetId:resolvedTarget.id,...extra});
 const prepared=await request('prepare-provider',{model:'claude-fixture-1',effort:'low'});
 await request('enable',{expectedRevision:0,configurationId:prepared.provider!.configurationId,consentVersion:1,scope:'project'});
 now=Date.now();const timestamp=new Date(now).toISOString();
 const rows=[{type:'session_meta',payload:{id:'session',cwd:root,source:'cli'}},
  {type:'event_msg',timestamp,payload:{type:'task_started',turn_id:'turn'}},
  {type:'turn_context',payload:{cwd:root,turn_id:'turn'}},
  {type:'event_msg',timestamp,payload:{type:'user_message',message:'Retain only checked fixture evidence.'}},
  {type:'event_msg',timestamp,payload:{type:'task_complete',turn_id:'turn'}}].map(row=>Buffer.from(JSON.stringify(row)+'\n'));
 writeFileSync(transcript,Buffer.concat(rows));
 const reader=new CompletedMemoryTurnReader({agent:'codex',instanceId:'fixture-install',sessionId:'session',cwd:root,memoryId,policyEpoch:1});
 let offset=0;for(const row of rows){reader.record(row,offset);offset+=row.length;}
 expect(reader.sources).toHaveLength(1);store.observeBatch(reader.sources);
 expect(await host.run(originalTarget.id,true)).toMatchObject({state:'recovery-required',localSaved:false});
 const parent=store.latestJob(memoryId)!;
 expect(parent.phase).toBe('recovery-required');expect(counts.proposals).toBe(1);
 expect(sessions.status(root,{readOnly:true})).toBeNull();
 now+=31*60*1000;failProposal=false;
 const snapshot=()=>{
  const db=new Database(store.path,{readonly:true});
  try{return {
   jobs:db.query('SELECT * FROM save_jobs ORDER BY sequence').all(),
   attempts:db.query('SELECT * FROM save_auto_attempts ORDER BY saveId').all(),
   sources:db.query('SELECT * FROM save_sources ORDER BY sequence').all(),
   approvals:db.query('SELECT * FROM save_recovery_approvals ORDER BY parentSaveId').all(),
   decisions:db.query('SELECT * FROM save_recovery_decisions ORDER BY parentSaveId').all(),
  };}finally{db.close();}
 };
 const review=async()=>{
  const result=await request('review-recovery');
  if(!('recoveryReview' in result))throw new Error('missing recovery review');
  return result.recoveryReview as Awaited<ReturnType<typeof reviewAmbiguousMemorySave>>&{model:string;effort:'low'|'medium'};
 };
 return {host,dependencies,request,review,store,sessions,parent,counts,root,otherRoot,memoryId,originalTarget,snapshot,bin,
  failProbe:()=>{failProbe=true;},allowProbe:()=>{failProbe=false;},advance:(ms:number)=>{now+=ms;},
  memoryPath:initialized.memoryPath!,changeTarget:(patch:Partial<AutomaticMemoryTarget>)=>{resolvedTarget={...originalTarget,...patch};},
  invalidate:()=>{registrationValid=false;},validate:()=>{registrationValid=true;}};
}

test('host.manage reviews without inference, executes one successor and returns durable success after host restart/replay',async()=>{
 const f=await fixture(),before=f.snapshot(),document=readMemoryDocument(f.root,f.memoryPath),journal=readProjectMemoryJournal(f.root);
 const ordinaryPreflight=f.counts.ordinaryPreflight,review=await f.review();
 expect(review).toMatchObject({version:1,targetId:f.originalTarget.id,parentSaveId:f.parent.saveId,parentAttemptId:f.parent.attemptId,
  sourceCount:1,additionalCalls:1,model:'claude-fixture-1',effort:'low'});
 expect(review.inputBytes).toBeGreaterThan(0);expect(review.expiresAt).toBeGreaterThan(0);
 expect(f.counts.proposals).toBe(1);expect(f.counts.connectionTests).toBe(1);
 expect(f.counts.ordinaryPreflight).toBe(ordinaryPreflight);expect(f.counts.recoveryPreflight).toBeGreaterThan(0);
 expect(f.snapshot()).toMatchObject({jobs:before.jobs,attempts:before.attempts,sources:before.sources,decisions:[]});
 expect(readMemoryDocument(f.root,f.memoryPath)).toBe(document);expect(readProjectMemoryJournal(f.root)).toEqual(journal);
 const confirmation={approvalId:review.approvalId,reviewDigest:review.reviewDigest,explicitConsent:true};
 expect(await f.request('execute-recovery',confirmation)).toMatchObject({targetId:f.originalTarget.id,last:{state:'saved',localSaved:true,failure:null}});
 expect(f.counts.proposals).toBe(2);expect(f.counts.connectionTests).toBe(1);
 expect(f.store.get(f.parent.saveId)).toMatchObject({...f.parent,phase:'superseded-unknown'});
 expect(f.store.latestJob(f.memoryId)).toMatchObject({phase:'local-saved',coverageDigest:f.parent.coverageDigest});
 expect(f.store.latestJob(f.memoryId)!.saveId).not.toBe(f.parent.saveId);
 const saved=f.snapshot();expect(saved.attempts).toHaveLength(2);expect(saved.decisions).toHaveLength(1);
 expect(saved.sources).toEqual(before.sources);expect(saved.jobs[0]).toMatchObject({receipt:null});
 expect(saved.approvals[0]).toMatchObject({approvalId:review.approvalId,consumedAt:expect.any(Number)});
 expect(readProjectMemoryJournal(f.root)).toHaveLength(journal.length+1);
 expect(readMemoryDocument(f.root,f.memoryPath)).toContain('Retain verified completed evidence after explicit recovery.');
 expect(f.sessions.status(f.root,{readOnly:true})).toBeNull();
 const restarted=new MemorySaveAutomaticHost({...f.dependencies,store:new MemorySaveStore(f.store.path),sessions:new MemorySessionStore(f.sessions.path)});
 expect(await f.request('execute-recovery',confirmation,restarted)).toMatchObject({last:{state:'saved',localSaved:true,failure:null}});
 expect(f.counts.proposals).toBe(2);expect(f.snapshot()).toEqual(saved);
 expect(readProjectMemoryJournal(f.root)).toHaveLength(journal.length+1);
});

for(const change of ['id','cwd','root','memoryId','unregistered'] as const)
test(`host.manage rejects changed ${change} before consuming a reviewed approval or calling the provider`,async()=>{
  const f=await fixture(),review=await f.review(),before=f.snapshot(),document=readFileSync(f.memoryPath);
  if(change==='id')f.changeTarget({id:'different-target'});
  if(change==='cwd')f.changeTarget({cwd:f.otherRoot});
  if(change==='root')f.changeTarget({root:f.otherRoot});
  if(change==='memoryId')f.changeTarget({memoryId:'different-memory'});
  if(change==='unregistered')f.invalidate();
  const error=change==='unregistered'?'SOURCE_CONFLICT':change==='memoryId'?'POLICY_CHANGED':'REVISION_CONFLICT';
  await expect(f.request('execute-recovery',{approvalId:review.approvalId,reviewDigest:review.reviewDigest,explicitConsent:true})).rejects.toThrow(error);
  expect(f.counts.proposals).toBe(1);expect(f.snapshot()).toEqual(before);expect(readFileSync(f.memoryPath)).toEqual(document);
  expect(f.sessions.status(f.root,{readOnly:true})).toBeNull();
});

test('host.manage forbids unknown and cross-operation fields; strict consent validation cannot consume an approval',async()=>{
 const f=await fixture(),review=await f.review(),before=f.snapshot();
 const confirmation={approvalId:review.approvalId,reviewDigest:review.reviewDigest,explicitConsent:true};
 for(const operation of ['review-recovery','execute-recovery'])for(const extra of [{folderPath:f.root},{parentSaveId:f.parent.saveId},{model:'claude-fixture-1'},{scope:'all'},{expectedRevision:1}]){
  const counts={...f.counts};
  await expect(f.request(operation,{...(operation==='execute-recovery'?confirmation:{}),...extra})).rejects.toThrow('INVALID_INPUT');
  expect(f.counts).toEqual(counts); // Rejected before resolving targets or taking a lease.
 }
 for(const patch of [{explicitConsent:false},{explicitConsent:'true'},{explicitConsent:undefined},{approvalId:null},{reviewDigest:42}]){
  const beforeLeases=f.counts.workspaceLeases;
  await expect(f.request('execute-recovery',{...confirmation,...patch})).rejects.toThrow('INVALID_INPUT');
  expect(f.counts.workspaceLeases).toBe(beforeLeases);
 }
 expect(f.counts.proposals).toBe(1);expect(f.snapshot()).toEqual(before);
 // Invalid input leaves the exact review usable, rather than silently consuming it.
 expect(await f.request('execute-recovery',confirmation)).toMatchObject({last:{state:'saved',localSaved:true}});
 expect(f.counts.proposals).toBe(2);
});

test('host.manage requires the separate read-only recovery preflight and never falls back to ordinary preflight',async()=>{
 const f=await fixture(),before=f.snapshot(),counts={...f.counts};
 const host=new MemorySaveAutomaticHost({...f.dependencies,recoveryPreflight:undefined});
 await expect(f.request('review-recovery',{},host)).rejects.toThrow('STORAGE_UNAVAILABLE');
 expect(f.counts.ordinaryPreflight).toBe(counts.ordinaryPreflight);expect(f.counts.recoveryPreflight).toBe(0);
 expect(f.counts.workspaceLeases).toBe(counts.workspaceLeases);expect(f.counts.proposals).toBe(1);
 expect(f.snapshot()).toEqual(before);
});

test('host renews only the reviewed CLI proof then atomically commits the separately approved successor',async()=>{
 const f=await fixture(),before=f.snapshot(),prior=f.store.providerBinding()!,policy=f.store.automaticPolicy();
 writeFileSync(f.bin,'updated fixture CLI');
 await expect(f.review()).rejects.toThrow('POLICY_CHANGED');
 const result=await f.request('review-recovery-provider');
 if(!('providerRecoveryReview' in result))throw new Error('missing provider review');
 const review=result.providerRecoveryReview as Awaited<ReturnType<typeof reviewRecoveryProvider>>;
 expect(review).toMatchObject({targetId:f.originalTarget.id,parentSaveId:f.parent.saveId,binaryChanged:true,additionalCalls:1});
 expect(f.counts.connectionTests).toBe(1);expect(f.counts.proposals).toBe(1);
 expect(f.snapshot()).toEqual(before);expect(f.store.automaticPolicy()).toEqual(policy);expect(f.store.providerBinding()).toEqual(prior);
 const request={approvalId:review.approvalId,reviewDigest:review.reviewDigest,explicitConsent:true};
 const competing=await Promise.allSettled([f.request('verify-recovery-provider',request),f.request('verify-recovery-provider',request)]);
 expect(competing.filter(result=>result.status==='fulfilled')).toHaveLength(1);
 expect(competing.find(result=>result.status==='rejected')).toMatchObject({reason:{code:'MEMORY_SAVE_BUSY'}});
 await f.request('verify-recovery-provider',request);
 expect(f.counts.connectionTests).toBe(2);expect(f.counts.proposals).toBe(1);expect(f.snapshot()).toEqual(before);
 expect(f.store.automaticPolicy()).toEqual(policy);expect(f.store.providerBinding()).toEqual(prior);
 expect(f.store.readyRecoveryProviderTransition(f.parent.saveId)?.state).toBe('ready');
 const restarted=new MemorySaveAutomaticHost({...f.dependencies,store:new MemorySaveStore(f.store.path),sessions:new MemorySessionStore(f.sessions.path)});
 const authReads=f.counts.authReads;await f.request('verify-recovery-provider',request,restarted);
 expect(f.counts.connectionTests).toBe(2);expect(f.counts.authReads).toBe(authReads);
 const summary=await f.review();expect(f.counts.connectionTests).toBe(2);expect(f.counts.proposals).toBe(1);
 const execution={approvalId:summary.approvalId,reviewDigest:summary.reviewDigest,explicitConsent:true};
 expect(await f.request('execute-recovery',execution)).toMatchObject({last:{state:'saved',localSaved:true}});
 expect(f.counts.connectionTests).toBe(2);expect(f.counts.proposals).toBe(2);
 expect(f.store.automaticPolicy()).toEqual({...policy,revision:policy.revision+1,providerBindingDigest:expect.any(String)});
 expect(f.store.providerBinding()).toMatchObject({model:prior.model,effort:prior.effort,accountFingerprint:prior.accountFingerprint,installationFingerprint:prior.installationFingerprint});
 expect(f.store.providerBinding()!.binaryFingerprint).not.toBe(prior.binaryFingerprint);
 const after=f.snapshot();expect(after.sources).toEqual(before.sources);
 expect(after.jobs[0]).toEqual({...before.jobs[0]!,phase:'superseded-unknown'});expect(after.attempts).toHaveLength(2);
 expect(after.decisions).toHaveLength(1);expect(f.store.latestJob(f.memoryId)?.phase).toBe('local-saved');
 await f.request('execute-recovery',execution,restarted);await f.request('verify-recovery-provider',request,restarted);
 expect(f.counts.connectionTests).toBe(2);expect(f.counts.proposals).toBe(2);expect(f.snapshot()).toEqual(after);
});

test('host provider recovery rejects extra authority, missing consent and changed target before inference',async()=>{
 const f=await fixture();writeFileSync(f.bin,'updated fixture CLI');
 for(const operation of ['review-recovery-provider','verify-recovery-provider'])for(const patch of [{folderPath:f.root},{model:'claude-other-1'},{binding:{}},{parentSaveId:f.parent.saveId},{expectedRevision:1}]){
  const counts={...f.counts};await expect(f.request(operation,patch)).rejects.toThrow('INVALID_INPUT');expect(f.counts).toEqual(counts);
 }
 const result=await f.request('review-recovery-provider');if(!('providerRecoveryReview' in result))throw new Error('missing review');
 const review=result.providerRecoveryReview as Awaited<ReturnType<typeof reviewRecoveryProvider>>,request={approvalId:review.approvalId,reviewDigest:review.reviewDigest,explicitConsent:true};
 for(const explicitConsent of [false,undefined,'true']){
  const leases=f.counts.workspaceLeases;await expect(f.request('verify-recovery-provider',{...request,explicitConsent})).rejects.toThrow('INVALID_INPUT');expect(f.counts.workspaceLeases).toBe(leases);
 }
 const before=f.snapshot();f.changeTarget({cwd:f.otherRoot});
 await expect(f.request('verify-recovery-provider',request)).rejects.toThrow('REVISION_CONFLICT');
 expect(f.counts.connectionTests).toBe(1);expect(f.snapshot()).toEqual(before);expect(f.store.latestRecoveryProviderTransition(f.parent.saveId)).toBeNull();
});

test('host keeps an uncertain provider probe durable and replay never calls authentication or inference again',async()=>{
 const f=await fixture(),before=f.snapshot(),binding=f.store.providerBinding(),policy=f.store.automaticPolicy();writeFileSync(f.bin,'updated fixture CLI');
 const result=await f.request('review-recovery-provider');if(!('providerRecoveryReview' in result))throw new Error('missing review');
 const review=result.providerRecoveryReview as Awaited<ReturnType<typeof reviewRecoveryProvider>>,request={approvalId:review.approvalId,reviewDigest:review.reviewDigest,explicitConsent:true};
 f.failProbe();await expect(f.request('verify-recovery-provider',request)).rejects.toThrow('Fixture probe response missing');
 expect(f.store.latestRecoveryProviderTransition(f.parent.saveId)?.state).toBe('unknown');expect(f.store.readyRecoveryProviderTransition(f.parent.saveId)).toBeNull();
 const count=f.counts.authReads;f.allowProbe();writeFileSync(f.bin,'another CLI update after unknown');
 const restarted=new MemorySaveAutomaticHost({...f.dependencies,store:new MemorySaveStore(f.store.path),sessions:new MemorySessionStore(f.sessions.path)});
 expect(await f.request('verify-recovery-provider',request,restarted)).toMatchObject({recoveryProvider:{state:'unknown'}});
 expect(f.counts.authReads).toBe(count);expect(f.counts.connectionTests).toBe(2);expect(f.counts.proposals).toBe(1);
 expect(f.snapshot()).toEqual(before);expect(f.store.providerBinding()).toEqual(binding);expect(f.store.automaticPolicy()).toEqual(policy);
});

test('host refuses executable drift after provider review without reserving a probe',async()=>{
 const f=await fixture();writeFileSync(f.bin,'first CLI update');
 const result=await f.request('review-recovery-provider');if(!('providerRecoveryReview' in result))throw new Error('missing review');
 const review=result.providerRecoveryReview as Awaited<ReturnType<typeof reviewRecoveryProvider>>,before=f.snapshot();writeFileSync(f.bin,'second CLI update');
 await expect(f.request('verify-recovery-provider',{approvalId:review.approvalId,reviewDigest:review.reviewDigest,explicitConsent:true})).rejects.toThrow('POLICY_CHANGED');
 expect(f.counts.connectionTests).toBe(1);expect(f.snapshot()).toEqual(before);expect(f.store.latestRecoveryProviderTransition(f.parent.saveId)).toBeNull();
});
