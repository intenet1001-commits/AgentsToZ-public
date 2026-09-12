import {afterEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {chmodSync,existsSync,mkdtempSync,readFileSync,rmSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {MemorySaveStore} from '../src/memorySaveStore';
import {MEMORY_SAVE_SCHEMA_VERSION,saveDigest,type MemorySaveRecoveryBinding,type MemorySaveSource} from '../src/memorySaveContract';
import {canonicalMemoryProviderBinding,type MemoryProviderBinding} from '../src/memorySaveProviderContract';
import {MEMORY_PROVIDER_RECOVERY_REVIEW_TTL,type MemoryProviderRecoveryBinding,type MemoryProviderRecoveryProbe} from '../src/memorySaveProviderTransitionContract';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function dbRead<T>(path:string,run:(db:Database)=>T){const db=new Database(path);try{return run(db);}finally{db.close();}}
function rows(path:string,table:string){return dbRead(path,db=>db.query(`SELECT * FROM ${table} ORDER BY rowid`).all());}
const transitionTables=['save_provider_recovery_reviews','save_provider_recovery_probes','save_provider_recovery_results','save_provider_recovery_clock'];
function fixture(targetId='target'){
 const root=mkdtempSync(join(tmpdir(),'provider-transition-'));roots.push(root);let now=1000;
 const store=new MemorySaveStore(join(root,'save.sqlite'),()=>now);
 const prior:MemoryProviderBinding=canonicalMemoryProviderBinding({version:1,agent:'claude',model:'claude-fixture-1',effort:'low',preparedAt:now,
  binaryFingerprint:saveDigest('old binary'),accountFingerprint:saveDigest('same account'),installationFingerprint:saveDigest('same installation')});
 store.setProviderBinding(prior);store.setAutomaticPolicy(0,{enabled:true,consentVersion:1,providerBindingDigest:saveDigest(prior),scopeMemoryId:'memory',scopeTargetId:'target'});
 now++;
 const source:MemorySaveSource={agent:'codex',instanceId:'device',sessionId:'session',turnId:'turn',startByte:10,endByte:100,
  sourceDigest:saveDigest('source'),memoryId:'memory',policyEpoch:1,coverageKind:'complete-turn',completedAt:now};
 const key=store.observe(source),job=store.reserve('memory',1,[key]);
 const originalIntent={inputDigest:saveDigest('original input'),beforeHash:saveDigest('unchanged document'),providerBindingDigest:saveDigest(prior)};
 store.bindInput(job.saveId,{saveId:job.saveId,memoryId:'memory',policyEpoch:1,coverageDigest:job.coverageDigest,...originalIntent});
 const attempt=store.beginAutomaticAttempt(job.saveId,job.coverageDigest,1,originalIntent);store.requireRecovery(job.saveId,attempt);
 store.recordFailure(job.saveId,attempt,{version:1,stage:'provider-call',code:'UNAVAILABLE',providerCallPossible:true});
 now+=30*60*1000;
 const observed:MemoryProviderBinding={...prior,binaryFingerprint:saveDigest('new binary'),preparedAt:now};
 const binding:MemoryProviderRecoveryBinding={parentSaveId:job.saveId,parentAttemptId:attempt,memoryId:'memory',coverageDigest:job.coverageDigest,
  originalIntentDigest:saveDigest(originalIntent),beforeHash:originalIntent.beforeHash,targetId,rootDigest:saveDigest('root'),registrationDigest:saveDigest(['registration',targetId]),
  policyRevision:1,priorBinding:prior,observedBinding:observed};
 const immutable=()=>Object.fromEntries(['save_sources','save_job_sources','save_jobs','save_input_bindings','save_failure_diagnostics','save_auto_attempts','save_auto_policy','save_provider_binding'].map(table=>[table,rows(store.path,table)]));
 const review=()=>{const a=store.prepareRecoveryProviderApproval(binding);return {approvalId:a.approvalId,reviewDigest:a.reviewDigest,explicitConsent:true as const,binding};};
 const ready=()=>{const request=review(),claim=store.claimRecoveryProviderProbe(request);expect(claim.created).toBe(true);
  const probe=store.finishRecoveryProviderProbe(claim.probe.transitionId,{state:'ready',binding:{...observed,preparedAt:now}});return {request,probe};};
 function summary(probe:MemoryProviderRecoveryProbe){
  const b:MemorySaveRecoveryBinding={parentSaveId:job.saveId,parentAttemptId:attempt,memoryId:'memory',policyEpoch:1,coverageDigest:job.coverageDigest,
   originalIntentDigest:binding.originalIntentDigest,inputDigest:saveDigest('reviewed successor input'),beforeHash:originalIntent.beforeHash,providerBindingDigest:saveDigest(probe.readyBinding),
   policyRevision:1,targetId:binding.targetId,rootDigest:binding.rootDigest,registrationDigest:binding.registrationDigest,
   transitionId:probe.transitionId,proofDigest:probe.proofDigest!,originalProviderBindingDigest:saveDigest(prior)};
  const a=store.prepareRecoveryApproval(b);return {approvalId:a.approvalId,reviewDigest:a.reviewDigest,explicitConsent:true as const,binding:b};
 }
 return {root,store,prior,observed,binding,job,attempt,key,source,originalIntent,immutable,review,ready,summary,get now(){return now;},advance:(amount:number)=>{now+=amount;}};
}

test('probe review/claim/proof preserve the original save and global provider/policy; a proof can be reviewed again without expiry',()=>{
 const f=fixture(),before=f.immutable(),request=f.review();
 expect(f.store.recoveryProviderApproval(request.approvalId)).toMatchObject({binding:f.binding,expiresAt:f.now+MEMORY_PROVIDER_RECOVERY_REVIEW_TTL});
 expect(f.immutable()).toEqual(before);
 const claim=f.store.claimRecoveryProviderProbe(request);expect(claim.created).toBe(true);expect(claim.probe.state).toBe('claimed');
 expect(f.store.latestRecoveryProviderTransition(f.job.saveId)).toEqual(claim.probe);expect(f.store.readyRecoveryProviderTransition(f.job.saveId)).toBeNull();
 const proof=f.store.finishRecoveryProviderProbe(claim.probe.transitionId,{state:'ready',binding:f.observed});
 expect(proof).toMatchObject({state:'ready',readyBinding:f.observed});expect(proof.proofDigest).toMatch(/^[a-f0-9]{64}$/);
 expect(f.immutable()).toEqual(before);expect(f.store.readyRecoveryProviderTransition(f.job.saveId)).toEqual(proof);
 expect(f.store.finishRecoveryProviderProbe(proof.transitionId,{state:'ready',binding:f.observed})).toEqual(proof);
 f.advance(30*24*60*60*1000);
 expect(f.summary(proof).binding.transitionId).toBe(proof.transitionId);
 expect(f.immutable()).toEqual(before);expect(rows(f.store.path,'save_provider_recovery_probes')).toHaveLength(1);
});

test('old tokens remain non-dispatching after a new review, expiry, restart and terminal completion',()=>{
 const f=fixture(),first=f.review(),claim=f.store.claimRecoveryProviderProbe(first),next=f.review();
 expect(f.store.recoveryProviderApproval(first.approvalId)).toBeNull();
 expect(f.store.recoveryProviderProbeForApproval(first.approvalId)).toEqual(claim.probe);
 expect(f.store.claimRecoveryProviderProbe(first)).toEqual({...claim,created:false});
 expect(f.store.finishRecoveryProviderProbe(claim.probe.transitionId,{state:'unknown'})).toMatchObject({state:'unknown'});
 expect(()=>f.store.finishRecoveryProviderProbe(claim.probe.transitionId,{state:'ready',binding:f.observed})).toThrow('REVISION_CONFLICT');
 const second=f.store.claimRecoveryProviderProbe(next);expect(second.created).toBe(true);
 expect(second.probe.transitionId).not.toBe(claim.probe.transitionId);
 f.advance(MEMORY_PROVIDER_RECOVERY_REVIEW_TTL+1);
 const restarted=new MemorySaveStore(f.store.path,()=>f.now);
 expect(restarted.claimRecoveryProviderProbe(first)).toMatchObject({created:false,probe:{state:'unknown'}});
 expect(restarted.claimRecoveryProviderProbe(next)).toMatchObject({created:false,probe:{state:'claimed'}});
 expect(rows(f.store.path,'save_provider_recovery_probes')).toHaveLength(2);expect(rows(f.store.path,'save_auto_attempts')).toHaveLength(1);
});

test('strict probe input, consent, exact reviewed context, expiry and identity changes cannot claim or complete a call',()=>{
 const f=fixture(),request=f.review(),before=f.immutable();
 for(const consent of [undefined,false,'true',1])expect(()=>f.store.claimRecoveryProviderProbe({...request,explicitConsent:consent} as any)).toThrow('INVALID_INPUT');
 for(const patch of [{extra:'private'},{binding:{...f.binding,path:'/private'}},{binding:{...f.binding,observedBinding:{...f.observed,token:'private'}}}])
  expect(()=>f.store.claimRecoveryProviderProbe({...request,...patch} as any)).toThrow('INVALID_INPUT');
 for(const patch of [{parentAttemptId:'other'},{beforeHash:saveDigest('other')},{targetId:'other'},{policyRevision:2}])
  expect(()=>f.store.claimRecoveryProviderProbe({...request,binding:{...f.binding,...patch}})).toThrow('REVISION_CONFLICT');
 for(const patch of [{accountFingerprint:saveDigest('other')},{model:'claude-fixture-2'},{effort:'medium' as const},{installationFingerprint:saveDigest('other')},{preparedAt:0}])
  expect(()=>f.store.prepareRecoveryProviderApproval({...f.binding,observedBinding:{...f.observed,...patch}})).toThrow('POLICY_CHANGED');
 expect(f.immutable()).toEqual(before);expect(rows(f.store.path,'save_provider_recovery_probes')).toHaveLength(0);
 const claim=f.store.claimRecoveryProviderProbe(request);
 expect(()=>f.store.finishRecoveryProviderProbe(claim.probe.transitionId,{state:'ready',binding:{...f.observed,binaryFingerprint:saveDigest('changed again')}})).toThrow('POLICY_CHANGED');
 expect(()=>f.store.finishRecoveryProviderProbe(claim.probe.transitionId,{state:'ready',binding:f.observed,extra:'private'} as any)).toThrow('INVALID_INPUT');
 expect(f.store.recoveryProviderTransition(claim.probe.transitionId)?.state).toBe('claimed');
 const failed=f.store.finishRecoveryProviderProbe(claim.probe.transitionId,{state:'failed'});
 expect(()=>f.store.finishRecoveryProviderProbe(failed.transitionId,{state:'unknown'})).toThrow('REVISION_CONFLICT');
 const expired=f.review();f.advance(MEMORY_PROVIDER_RECOVERY_REVIEW_TTL);
 expect(()=>f.store.claimRecoveryProviderProbe(expired)).toThrow('POLICY_CHANGED');expect(f.immutable()).toEqual(before);
});

test('probe quota counts claimed, failed and unknown calls separately, never resets summary quota, and rejects clock rollback',()=>{
 const f=fixture(),before=f.immutable();
 for(let i=0;i<8;i++){
  const claim=f.store.claimRecoveryProviderProbe(f.review());
  if(i%3!==0)f.store.finishRecoveryProviderProbe(claim.probe.transitionId,{state:i%3===1?'failed':'unknown'});
 }
 const rejected=f.review();expect(()=>f.store.claimRecoveryProviderProbe(rejected)).toThrow('BUDGET_PAUSED');
 expect(rows(f.store.path,'save_provider_recovery_probes')).toHaveLength(8);expect(f.immutable()).toEqual(before);
 f.advance(-1);expect(()=>f.review()).toThrow('CLOCK_ROLLBACK');
 f.advance(1+24*60*60*1000);expect(f.store.claimRecoveryProviderProbe(f.review()).created).toBe(true);
 expect(f.immutable()).toEqual(before);
});

test('provider transition and successor admit in one transaction; old intent/source/quota remain and duplicate cannot transition twice',()=>{
 const f=fixture(),before=f.immutable(),{probe}=f.ready(),request=f.summary(probe),oldPolicy=f.store.automaticPolicy();
 expect(()=>f.store.assertProviderRevalidation(1,saveDigest(f.prior))).toThrow('RECOVERY_REQUIRED');
 const result=f.store.admitRecoverySuccessor(request);
 expect(result).toMatchObject({created:true,executionPolicyRevision:2,job:{phase:'summarizing'}});
 expect(f.store.providerBinding()).toEqual(probe.readyBinding);
 expect(f.store.automaticPolicy()).toEqual({...oldPolicy,revision:2,providerBindingDigest:saveDigest(probe.readyBinding)});
 expect(rows(f.store.path,'save_jobs')[0]).toEqual({...before.save_jobs![0] as object,phase:'superseded-unknown'});
 for(const table of ['save_sources','save_job_sources','save_failure_diagnostics'])expect(rows(f.store.path,table)).toEqual(before[table]!);
 expect(rows(f.store.path,'save_auto_attempts')[0]).toEqual(before.save_auto_attempts![0]);
 expect(rows(f.store.path,'save_auto_attempts')[1]).toMatchObject({saveId:result.job.saveId,policyRevision:2});
 expect(rows(f.store.path,'save_input_bindings')[0]).toEqual(before.save_input_bindings![0]);
 expect(f.store.inputBinding(result.job.saveId)).toMatchObject({providerBindingDigest:saveDigest(probe.readyBinding)});
 const repeated=new MemorySaveStore(f.store.path,()=>f.now+10*60*1000).admitRecoverySuccessor(request);
 expect(repeated).toEqual({...result,created:false});expect(f.store.automaticPolicy().revision).toBe(2);
 expect(()=>f.store.requireRecovery(f.job.saveId,f.attempt)).toThrow('REVISION_CONFLICT');
});

test('a registered worktree shares its memory policy while the project scheduling hint never replaces exact reviewed authority',()=>{
 const f=fixture('worktree-target'),before=f.immutable(),{probe}=f.ready(),request=f.summary(probe);
 expect(f.store.automaticPolicy()).toMatchObject({scopeMemoryId:'memory',scopeTargetId:'target'});
 expect(probe.binding.targetId).toBe('worktree-target');
 for(const patch of [{targetId:'target'},{memoryId:'other-memory'},{rootDigest:saveDigest('other root')},{registrationDigest:saveDigest('other worktree')}]){
  expect(()=>f.store.admitRecoverySuccessor({...request,binding:{...request.binding,...patch}})).toThrow('REVISION_CONFLICT');
  expect(f.immutable()).toEqual(before);
 }
 const admitted=f.store.admitRecoverySuccessor(request);expect(admitted.executionPolicyRevision).toBe(2);
 expect(f.store.automaticPolicy()).toMatchObject({scopeMemoryId:'memory',scopeTargetId:'target'});
 expect(admitted.decision.binding.targetId).toBe('worktree-target');
 expect(rows(f.store.path,'save_sources')).toEqual(before.save_sources!);
});

test('a worktree scheduling hint exception does not permit a different or excluded memory scope',()=>{
 for(const kind of ['different','excluded'] as const){
  const f=fixture('worktree-target');
  if(kind==='excluded'){
   f.store.setAutomaticPolicy(1,{enabled:true,consentVersion:1,providerBindingDigest:saveDigest(f.prior),excludedMemoryIds:['memory']});
   f.binding.policyRevision=2;
  }else{
   f.store.setAutomaticPolicy(1,{enabled:false});
   f.store.setAutomaticPolicy(2,{enabled:true,consentVersion:1,providerBindingDigest:saveDigest(f.prior),scopeMemoryId:'other-memory',scopeTargetId:'other-target'});
   f.binding.policyRevision=3;
  }
  const before=f.immutable();expect(()=>f.review()).toThrow('POLICY_CHANGED');expect(f.immutable()).toEqual(before);
  expect(rows(f.store.path,'save_provider_recovery_probes')).toHaveLength(0);
 }
});

test('a wrong transition, partial optional fields, policy drift, clock rollback and another prepared job cannot bypass original binding guards',()=>{
 for(const change of ['proof','transition','old-binding','policy','scope','clock','other-job'] as const){
  const f=fixture(),{probe}=f.ready(),request=f.summary(probe);
  if(change==='proof')request.binding.proofDigest=saveDigest('wrong');
  if(change==='transition')request.binding.transitionId='not-a-proof';
  if(change==='old-binding')request.binding.originalProviderBindingDigest=saveDigest('wrong');
  if(change==='policy')f.store.setAutomaticPolicy(1,{enabled:false});
  if(change==='scope')f.store.setAutomaticPolicy(1,{enabled:true,consentVersion:1,providerBindingDigest:saveDigest(f.prior),excludedMemoryIds:['memory']});
  if(change==='clock')f.advance(-1);
  if(change==='other-job'){
   const key=f.store.observe({...f.source,memoryId:'other',turnId:'other-turn'});f.store.reserve('other',1,[key]);
  }
  const before=f.immutable();expect(()=>f.store.admitRecoverySuccessor(request)).toThrow();expect(f.immutable()).toEqual(before);
  expect(rows(f.store.path,'save_recovery_decisions')).toHaveLength(0);
 }
 const f=fixture(),{probe}=f.ready(),request=f.summary(probe);
 for(const field of ['transitionId','proofDigest','originalProviderBindingDigest'] as const){
  const binding={...request.binding};delete binding[field];expect(()=>f.store.prepareRecoveryApproval(binding)).toThrow('INVALID_INPUT');
 }
});

test('all provider transition admission boundaries roll back provider, policy, original phase, quota and approval together',()=>{
 for(const [table,event,when] of [['save_auto_policy','UPDATE',''],['save_provider_binding','UPDATE',''],['save_auto_attempts','INSERT',''],
  ['save_jobs','UPDATE',"WHEN NEW.phase='superseded-unknown'"],['save_jobs','INSERT',''],['save_input_bindings','INSERT',''],['save_recovery_approvals','UPDATE',''],['save_recovery_decisions','INSERT','']] as const){
  const f=fixture(),{probe}=f.ready(),request=f.summary(probe),before=f.immutable(),approvals=rows(f.store.path,'save_recovery_approvals');
  dbRead(f.store.path,db=>db.run(`CREATE TRIGGER fixture_fail BEFORE ${event} ON ${table} ${when} BEGIN SELECT RAISE(ABORT,'fixture interruption'); END`));
  expect(()=>f.store.admitRecoverySuccessor(request)).toThrow('STORAGE_UNAVAILABLE');expect(f.immutable()).toEqual(before);
  expect(rows(f.store.path,'save_recovery_approvals')).toEqual(approvals);expect(rows(f.store.path,'save_recovery_decisions')).toHaveLength(0);
  dbRead(f.store.path,db=>db.run('DROP TRIGGER fixture_fail'));expect(f.store.admitRecoverySuccessor(request).executionPolicyRevision).toBe(2);
 }
});

test('probe claim and terminal evidence are transactional and old delayed outcomes cannot overwrite a terminal result',()=>{
 for(const table of ['save_provider_recovery_probes','save_provider_recovery_clock'] as const){
  const f=fixture(),request=f.review(),before=transitionTables.map(t=>rows(f.store.path,t));
  dbRead(f.store.path,db=>db.run(`CREATE TRIGGER fixture_fail BEFORE ${table.endsWith('clock')?'UPDATE':'INSERT'} ON ${table} BEGIN SELECT RAISE(ABORT,'fixture interruption'); END`));
  expect(()=>f.store.claimRecoveryProviderProbe(request)).toThrow('STORAGE_UNAVAILABLE');expect(transitionTables.map(t=>rows(f.store.path,t))).toEqual(before);
 }
 const f=fixture(),claim=f.store.claimRecoveryProviderProbe(f.review());
 dbRead(f.store.path,db=>db.run("CREATE TRIGGER fixture_fail BEFORE UPDATE ON save_provider_recovery_clock BEGIN SELECT RAISE(ABORT,'fixture interruption'); END"));
 expect(()=>f.store.finishRecoveryProviderProbe(claim.probe.transitionId,{state:'ready',binding:f.observed})).toThrow('STORAGE_UNAVAILABLE');
 expect(f.store.recoveryProviderTransition(claim.probe.transitionId)?.state).toBe('claimed');
 dbRead(f.store.path,db=>db.run('DROP TRIGGER fixture_fail'));
 f.store.finishRecoveryProviderProbe(claim.probe.transitionId,{state:'unknown'});
 expect(()=>f.store.finishRecoveryProviderProbe(claim.probe.transitionId,{state:'ready',binding:f.observed})).toThrow('REVISION_CONFLICT');
 dbRead(f.store.path,db=>{for(const table of ['save_provider_recovery_probes','save_provider_recovery_results']){
  expect(()=>db.run(`DELETE FROM ${table}`)).toThrow();expect(()=>db.run(`UPDATE ${table} SET payload='{}'`)).toThrow();
 }});
});

test('two processes claiming one probe approval authorize one call; process death never grants replay authority',async()=>{
 const f=fixture(),request=f.review(),script=join(f.root,'race.ts');
 writeFileSync(script,`import {MemorySaveStore} from ${JSON.stringify(resolve(import.meta.dir,'../src/memorySaveStore.ts'))};
 try{const r=new MemorySaveStore(${JSON.stringify(f.store.path)},()=>${f.now}).claimRecoveryProviderProbe(${JSON.stringify(request)});process.exit(r.created?0:3);}catch(e){process.exit(8);}`);
 const processes=[0,1].map(()=>Bun.spawn({cmd:[process.execPath,script],stdout:'ignore',stderr:'ignore'}));
 expect((await Promise.all(processes.map(p=>p.exited))).sort()).toEqual([0,3]);
 expect(rows(f.store.path,'save_provider_recovery_probes')).toHaveLength(1);
 const next=f.review();writeFileSync(script,`import {MemorySaveStore} from ${JSON.stringify(resolve(import.meta.dir,'../src/memorySaveStore.ts'))};
 new MemorySaveStore(${JSON.stringify(f.store.path)},()=>${f.now}).claimRecoveryProviderProbe(${JSON.stringify(next)});process.kill(process.pid,'SIGKILL');`);
 expect(Bun.spawnSync({cmd:[process.execPath,script],stdout:'ignore',stderr:'ignore'}).exitCode).not.toBe(0);
 expect(new MemorySaveStore(f.store.path,()=>f.now).claimRecoveryProviderProbe(next)).toMatchObject({created:false,probe:{state:'claimed'}});
 expect(rows(f.store.path,'save_provider_recovery_probes')).toHaveLength(2);expect(rows(f.store.path,'save_auto_attempts')).toHaveLength(1);
});

test('two processes racing one transition approval advance the global policy and create its successor only once',async()=>{
 const f=fixture(),{probe}=f.ready(),request=f.summary(probe),script=join(f.root,'transition-race.ts');
 writeFileSync(script,`import {MemorySaveStore} from ${JSON.stringify(resolve(import.meta.dir,'../src/memorySaveStore.ts'))};
 try{const r=new MemorySaveStore(${JSON.stringify(f.store.path)},()=>${f.now}).admitRecoverySuccessor(${JSON.stringify(request)});process.exit(r.created?0:3);}catch(e){process.exit(8);}`);
 const processes=[0,1].map(()=>Bun.spawn({cmd:[process.execPath,script],stdout:'ignore',stderr:'ignore'}));
 expect((await Promise.all(processes.map(p=>p.exited))).sort()).toEqual([0,3]);
 expect(f.store.automaticPolicy().revision).toBe(2);expect(f.store.providerBinding()).toEqual(probe.readyBinding);
 expect(rows(f.store.path,'save_auto_attempts')).toHaveLength(2);expect(rows(f.store.path,'save_recovery_decisions')).toHaveLength(1);
 expect(rows(f.store.path,'save_provider_recovery_probes')).toHaveLength(1);
});

test('corrupt, oversized, unsupported and busy transition reads fail closed without changing database bytes or mode',()=>{
 for(const kind of ['approval-version','probe-oversized','result-digest','result-extra'] as const){
  const f=fixture(),{request,probe}=f.ready();
  dbRead(f.store.path,db=>{
   if(kind==='approval-version'){
    const row=db.query('SELECT payload FROM save_provider_recovery_reviews WHERE approvalId=?').get(request.approvalId) as {payload:string};
    db.query('UPDATE save_provider_recovery_reviews SET payload=? WHERE approvalId=?').run(JSON.stringify({...JSON.parse(row.payload),version:2}),request.approvalId);
   }else if(kind==='probe-oversized'){
    db.run('DROP TRIGGER save_provider_recovery_probes_no_update');db.run('PRAGMA ignore_check_constraints=ON');
    db.query('UPDATE save_provider_recovery_probes SET payload=? WHERE transitionId=?').run('x'.repeat(9000),probe.transitionId);
   }else{
    db.run('DROP TRIGGER save_provider_recovery_results_no_update');
    const row=db.query('SELECT payload FROM save_provider_recovery_results WHERE transitionId=?').get(probe.transitionId) as {payload:string};
    db.query('UPDATE save_provider_recovery_results SET payload=? WHERE transitionId=?').run(JSON.stringify({...JSON.parse(row.payload),...(kind==='result-digest'?{proofDigest:saveDigest('corrupt')}:{unexpected:'fixture'})}),probe.transitionId);
   }
  });
  chmodSync(f.store.path,0o640);const before=readFileSync(f.store.path);
  if(kind==='approval-version')expect(()=>f.store.recoveryProviderApproval(request.approvalId)).toThrow();
  else{
   expect(()=>f.store.recoveryProviderTransition(probe.transitionId)).toThrow();
   expect(()=>f.store.latestRecoveryProviderTransition(f.job.saveId)).toThrow();
   expect(()=>f.store.readyRecoveryProviderTransition(f.job.saveId)).toThrow();
  }
  expect(readFileSync(f.store.path)).toEqual(before);expect(statSync(f.store.path).mode&0o777).toBe(0o640);
 }
 const f=fixture(),{probe}=f.ready(),alias=join(f.root,'alias.sqlite');symlinkSync(f.store.path,alias);
 expect(()=>new MemorySaveStore(alias).recoveryProviderTransition(probe.transitionId)).toThrow('STORAGE_UNAVAILABLE');
 const lock=new Database(f.store.path);lock.run('BEGIN EXCLUSIVE');
 try{expect(()=>f.store.latestRecoveryProviderTransition(f.job.saveId)).toThrow('STORAGE_UNAVAILABLE');}finally{lock.run('ROLLBACK');lock.close();}
});

test('schema 10 upgrades preserve v9 state, while all transition reads preserve old bytes/mode and reject future or corrupt data',()=>{
 const f=fixture();
 dbRead(f.store.path,db=>{for(const table of transitionTables)db.run(`DROP TABLE ${table}`);db.run('PRAGMA user_version=9');});
 chmodSync(f.store.path,0o640);const before=f.immutable(),bytes=readFileSync(f.store.path);
 expect(f.store.recoveryProviderApproval('absent')).toBeNull();expect(f.store.recoveryProviderProbeForApproval('absent')).toBeNull();
 expect(f.store.recoveryProviderTransition('absent')).toBeNull();expect(f.store.latestRecoveryProviderTransition(f.job.saveId)).toBeNull();expect(f.store.readyRecoveryProviderTransition(f.job.saveId)).toBeNull();
 expect(f.store.statusSnapshot('memory')?.job?.phase).toBe('recovery-required');expect(readFileSync(f.store.path)).toEqual(bytes);expect(statSync(f.store.path).mode&0o777).toBe(0o640);
 const {probe}=f.ready();expect(MEMORY_SAVE_SCHEMA_VERSION).toBe(10);expect(f.immutable()).toEqual(before);
 expect(dbRead(f.store.path,db=>db.query('PRAGMA user_version').get())).toEqual({user_version:10});
 expect(f.store.readyRecoveryProviderTransition(f.job.saveId)).toEqual(probe);
 dbRead(f.store.path,db=>db.run('PRAGMA user_version=99'));const future=readFileSync(f.store.path);
 expect(()=>f.store.recoveryProviderTransition(probe.transitionId)).toThrow('UNSUPPORTED_VERSION');expect(readFileSync(f.store.path)).toEqual(future);
 const absentPath=join(f.root,'missing','save.sqlite'),absent=new MemorySaveStore(absentPath);
 expect(absent.recoveryProviderApproval('absent')).toBeNull();expect(absent.recoveryProviderProbeForApproval('absent')).toBeNull();
 expect(absent.recoveryProviderTransition('absent')).toBeNull();expect(absent.readyRecoveryProviderTransition('parent')).toBeNull();expect(existsSync(join(f.root,'missing'))).toBe(false);
});
