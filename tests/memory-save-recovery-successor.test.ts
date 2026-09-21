import {afterEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {chmodSync,existsSync,mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {MemorySaveStore} from '../src/memorySaveStore';
import {MEMORY_SAVE_RECOVERY_REVIEW_TTL,MEMORY_SAVE_SCHEMA_VERSION,saveDigest,type MemorySaveRecoveryBinding,type MemorySaveSource} from '../src/memorySaveContract';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const oldIntent={inputDigest:saveDigest('original prompt'),beforeHash:saveDigest('unchanged memory'),providerBindingDigest:saveDigest('same provider')};
const receipt={manifestDigest:saveDigest('manifest'),beforeHash:oldIntent.beforeHash,afterHash:saveDigest('saved memory'),localRevisionId:'revision'};
function fixture(count=2){
 const root=mkdtempSync(join(tmpdir(),'save-successor-'));roots.push(root);let clock=10_000;
 const store=new MemorySaveStore(join(root,'save.sqlite'),()=>clock);
 const policy=store.setAutomaticPolicy(0,{enabled:true,consentVersion:1,providerBindingDigest:oldIntent.providerBindingDigest,scopeMemoryId:'memory',scopeTargetId:'target'});
 clock++;
 const sources=Array.from({length:count},(_,i):MemorySaveSource=>({agent:i%2?'claude':'codex',instanceId:'device',sessionId:'session',turnId:`turn-${i}`,startByte:100+i*100,endByte:200+i*100,sourceDigest:saveDigest(`source-${i}`),memoryId:'memory',policyEpoch:1,completedAt:clock,coverageKind:'complete-turn'}));
 const keys=store.observeBatch(sources),job=store.reserve('memory',1,keys);
 store.bindInput(job.saveId,{saveId:job.saveId,memoryId:'memory',policyEpoch:1,coverageDigest:job.coverageDigest,...oldIntent});
 const attempt=store.beginAutomaticAttempt(job.saveId,job.coverageDigest,policy.revision,oldIntent);store.requireRecovery(job.saveId,attempt);
 store.recordFailure(job.saveId,attempt,{version:1,stage:'provider-call',code:'UNAVAILABLE',providerCallPossible:true});
 clock+=30*60*1000;
 const binding:MemorySaveRecoveryBinding={parentSaveId:job.saveId,parentAttemptId:attempt,memoryId:'memory',policyEpoch:1,coverageDigest:job.coverageDigest,originalIntentDigest:saveDigest(oldIntent),
  inputDigest:saveDigest('reviewed new prompt'),beforeHash:oldIntent.beforeHash,providerBindingDigest:oldIntent.providerBindingDigest,policyRevision:policy.revision,targetId:'target',rootDigest:saveDigest('canonical root'),registrationDigest:saveDigest('registered target root cwd')};
 return {root,store,job,attempt,sources,keys,binding,get now(){return clock;},advance:(n:number)=>clock+=n};
}
function prepare(f:ReturnType<typeof fixture>){const a=f.store.prepareRecoveryApproval(f.binding);return {approvalId:a.approvalId,reviewDigest:a.reviewDigest,explicitConsent:true as const,binding:f.binding};}
function dbRead<T>(path:string,read:(db:Database)=>T){const db=new Database(path);try{return read(db);}finally{db.close();}}
function rows(path:string,table:string){return dbRead(path,db=>db.query(`SELECT * FROM ${table} ORDER BY rowid`).all());}
function immutable(f:ReturnType<typeof fixture>){return {sources:rows(f.store.path,'save_sources'),links:rows(f.store.path,'save_job_sources'),input:rows(f.store.path,'save_input_bindings'),failure:rows(f.store.path,'save_failure_diagnostics'),auto:rows(f.store.path,'save_auto_attempts')};}

test('current migration preserves v8 jobs, attempts, sources, input expiry and failure history',()=>{
 const f=fixture();
 dbRead(f.store.path,db=>{for(const table of ['save_provider_recovery_reviews','save_provider_recovery_probes','save_provider_recovery_results','save_provider_recovery_clock'])db.run(`DROP TABLE ${table}`);db.run('DROP TABLE save_recovery_approvals');db.run('DROP TABLE save_recovery_decisions');db.run('DROP INDEX jobs_open_root');db.run("CREATE UNIQUE INDEX jobs_open_root ON save_jobs(memoryId) WHERE phase<>'local-saved'");db.run('PRAGMA user_version=8');db.run('UPDATE save_input_bindings SET expired=1');});
 const before=immutable(f),oldJob=rows(f.store.path,'save_jobs');chmodSync(f.store.path,0o640);const bytes=readFileSync(f.store.path);
 expect(f.store.recoveryCandidate(f.job.saveId)?.sources).toHaveLength(2);expect(readFileSync(f.store.path)).toEqual(bytes);expect(statSync(f.store.path).mode&0o777).toBe(0o640);
 expect(f.store.recoveryApproval('not-issued')).toBeNull();expect(readFileSync(f.store.path)).toEqual(bytes);
 f.store.prepareRecoveryApproval(f.binding);
 expect(dbRead(f.store.path,db=>db.query('PRAGMA user_version').get())).toEqual({user_version:MEMORY_SAVE_SCHEMA_VERSION});expect(MEMORY_SAVE_SCHEMA_VERSION).toBe(10);
 expect(immutable(f)).toEqual(before);expect(rows(f.store.path,'save_jobs')).toEqual(oldJob);
});

test('review is bounded, non-executing, replaces only its unconsumed approval and needs exact explicit consent',()=>{
 const f=fixture(),before=immutable(f),first=prepare(f),second=prepare(f);
 expect(rows(f.store.path,'save_recovery_approvals')).toHaveLength(1);expect(rows(f.store.path,'save_recovery_decisions')).toHaveLength(0);
 expect(immutable(f)).toEqual(before);expect(f.store.get(f.job.saveId).phase).toBe('recovery-required');
 expect(f.store.recoveryApproval(first.approvalId)).toBeNull();expect(()=>f.store.admitRecoverySuccessor(first)).toThrow('REVISION_CONFLICT');
 for(const consent of [false,undefined,'true',1])expect(()=>f.store.admitRecoverySuccessor({...second,explicitConsent:consent} as any)).toThrow('INVALID_INPUT');
 for(const patch of [{beforeHash:saveDigest('changed')},{inputDigest:saveDigest('changed')},{rootDigest:saveDigest('moved')},{registrationDigest:saveDigest('new cwd')},{targetId:'other'}])expect(()=>f.store.admitRecoverySuccessor({...second,binding:{...second.binding,...patch}})).toThrow('REVISION_CONFLICT');
 expect(immutable(f)).toEqual(before);expect(rows(f.store.path,'save_recovery_decisions')).toHaveLength(0);
 f.store.prepareRecoveryApproval({...f.binding,rawPrompt:'PRIVATE_FIXTURE_PROMPT',path:'/PRIVATE_FIXTURE_PATH',reply:'PRIVATE_FIXTURE_REPLY'} as MemorySaveRecoveryBinding);
 const stored=readFileSync(f.store.path).toString();expect(stored).not.toContain('PRIVATE_FIXTURE_PROMPT');expect(stored).not.toContain('PRIVATE_FIXTURE_PATH');expect(stored).not.toContain('PRIVATE_FIXTURE_REPLY');
});

test('one transaction admits exactly one successor, keeps source ownership and original intent, and duplicate HTTP cannot spawn',()=>{
 const f=fixture(),before=immutable(f),oldJob=rows(f.store.path,'save_jobs')[0] as Record<string,unknown>,request=prepare(f);
 const admitted=f.store.admitRecoverySuccessor(request);
 expect(admitted.created).toBe(true);expect(admitted.job).toMatchObject({phase:'summarizing',memoryId:'memory',coverageDigest:f.job.coverageDigest,attemptId:admitted.attemptId});
 expect(admitted.decision).toMatchObject({reason:'response-unconfirmed',parentSaveId:f.job.saveId,parentAttemptId:f.attempt,coverageOwnerSaveId:f.job.saveId,successorSaveId:admitted.job.saveId});
 expect(rows(f.store.path,'save_jobs')[0]).toEqual({...oldJob,phase:'superseded-unknown'});
 expect(rows(f.store.path,'save_sources')).toEqual(before.sources);expect(rows(f.store.path,'save_job_sources')).toEqual(before.links);expect(rows(f.store.path,'save_failure_diagnostics')).toEqual(before.failure);
 expect(rows(f.store.path,'save_input_bindings')[0]).toEqual(before.input[0]);expect(rows(f.store.path,'save_auto_attempts')[0]).toEqual(before.auto[0]);
 expect(rows(f.store.path,'save_auto_attempts')).toHaveLength(2);expect(rows(f.store.path,'save_input_bindings')).toHaveLength(2);
 expect(f.store.inputBinding(admitted.job.saveId)).toMatchObject({saveId:admitted.job.saveId,coverageDigest:f.job.coverageDigest,inputDigest:f.binding.inputDigest});
 expect(f.store.openJob('memory')?.saveId).toBe(admitted.job.saveId);expect(f.store.pending('memory',1).items).toHaveLength(0);
 expect(f.store.reserve('memory',1,f.keys).saveId).toBe(f.job.saveId);
 f.advance(MEMORY_SAVE_RECOVERY_REVIEW_TTL*2);
 const repeated=new MemorySaveStore(f.store.path,()=>f.now).admitRecoverySuccessor(request);
 expect(repeated).toEqual({...admitted,created:false});expect(rows(f.store.path,'save_recovery_decisions')).toHaveLength(1);expect(rows(f.store.path,'save_auto_attempts')).toHaveLength(2);
 expect(()=>f.store.prepareRecoveryApproval(f.binding)).toThrow('RECOVERY_REQUIRED');
 expect(()=>f.store.recoveryCandidate(admitted.job.saveId)).toThrow('RECOVERY_REQUIRED');
 dbRead(f.store.path,db=>{
  expect(()=>db.run("UPDATE save_recovery_decisions SET payload='{}'")).toThrow();expect(()=>db.run('DELETE FROM save_recovery_decisions')).toThrow();
  expect(()=>db.run('UPDATE save_recovery_approvals SET consumedAt=NULL')).toThrow();expect(()=>db.run('DELETE FROM save_recovery_approvals')).toThrow();
 });
});

test('same-memory worktree recovery uses exact review binding rather than the main-project scheduling hint',()=>{
 const f=fixture(),before=immutable(f);
 f.binding={...f.binding,targetId:'registered-worktree',registrationDigest:saveDigest('same memory root, registered worktree cwd')};
 const approval=f.store.prepareRecoveryApproval(f.binding);
 const request={approvalId:approval.approvalId,reviewDigest:approval.reviewDigest,explicitConsent:true as const,binding:f.binding};
 for(const patch of [{targetId:'target'},{memoryId:'other-memory'},{registrationDigest:saveDigest('different cwd')}])
  expect(()=>f.store.admitRecoverySuccessor({...request,binding:{...f.binding,...patch}})).toThrow('REVISION_CONFLICT');
 const admitted=f.store.admitRecoverySuccessor(request);
 expect(admitted.created).toBe(true);expect(admitted.decision.binding.targetId).toBe('registered-worktree');
 expect(f.store.automaticPolicy()).toMatchObject({scopeMemoryId:'memory',scopeTargetId:'target'});
 expect(rows(f.store.path,'save_sources')).toEqual(before.sources);expect(rows(f.store.path,'save_job_sources')).toEqual(before.links);
});

test('old delayed callbacks are rejected and successor failure still owns the global fence',()=>{
 const f=fixture(),request=prepare(f),next=f.store.admitRecoverySuccessor(request),before=immutable(f);
 const binding={sessionPlanId:'late-plan',planDigest:receipt.manifestDigest,rootDigest:f.binding.rootDigest,beforeHash:receipt.beforeHash,afterHash:receipt.afterHash,backupRequested:false};
 expect(()=>f.store.bindHostSession(f.job.saveId,f.attempt,binding)).toThrow('REVISION_CONFLICT');
 expect(()=>f.store.commitLocal(f.job.saveId,f.attempt,receipt,false)).toThrow('REVISION_CONFLICT');
 expect(()=>f.store.requireRecovery(f.job.saveId,f.attempt)).toThrow('REVISION_CONFLICT');
 expect(()=>f.store.recordFailure(f.job.saveId,f.attempt,{version:1,stage:'host-bind',code:'UNAVAILABLE',providerCallPossible:true})).toThrow('REVISION_CONFLICT');
 expect(()=>f.store.beginAutomaticAttempt(f.job.saveId,f.job.coverageDigest,f.binding.policyRevision,oldIntent)).toThrow('RECOVERY_REQUIRED');
 expect(immutable(f)).toEqual(before);expect(rows(f.store.path,'save_host_sessions')).toHaveLength(0);expect(rows(f.store.path,'backup_outbox')).toHaveLength(0);
 f.store.requireRecovery(next.job.saveId,next.attemptId);
 expect(()=>f.store.recoveryCandidate(next.job.saveId)).toThrow('RECOVERY_REQUIRED');
 f.advance(30*60*1000);
 const key=f.store.observe({...f.sources[0]!,turnId:'next-turn',completedAt:f.now});
 expect(()=>f.store.checkAutomaticSources('memory',1,[key],f.binding.policyRevision,oldIntent.providerBindingDigest)).toThrow('EXECUTION_BUSY');
 expect(f.store.openJob('memory')?.saveId).toBe(next.job.saveId);
});

test('successor receipt consumes no new source and releases only its own active fence',()=>{
 const f=fixture(),next=f.store.admitRecoverySuccessor(prepare(f));
 f.store.commitLocal(next.job.saveId,next.attemptId,receipt,true);
 expect(f.store.get(f.job.saveId).phase).toBe('superseded-unknown');expect(f.store.get(next.job.saveId).phase).toBe('local-saved');expect(f.store.openJob('memory')).toBeNull();
 expect(rows(f.store.path,'save_auto_attempts')).toHaveLength(2);expect(rows(f.store.path,'save_job_sources')).toHaveLength(2);expect(rows(f.store.path,'backup_outbox')).toHaveLength(1);
 f.advance(30*60*1000);const key=f.store.observe({...f.sources[0]!,turnId:'later',completedAt:f.now});const job=f.store.reserve('memory',1,[key]);
 expect(f.store.beginAutomaticAttempt(job.saveId,job.coverageDigest,f.binding.policyRevision,oldIntent)).toBeString();
});

test('fresh successor input metadata never renews or clears the expired original input binding',()=>{
 const f=fixture();dbRead(f.store.path,db=>db.query('UPDATE save_input_bindings SET expired=1,createdAt=1 WHERE saveId=?').run(f.job.saveId));
 const original=rows(f.store.path,'save_input_bindings')[0],next=f.store.admitRecoverySuccessor(prepare(f));
 expect(rows(f.store.path,'save_input_bindings')[0]).toEqual(original);
 expect(rows(f.store.path,'save_input_bindings')[1]).toMatchObject({saveId:next.job.saveId,createdAt:f.now,expired:0});
 expect(f.store.inputBinding(f.job.saveId)).toMatchObject({inputDigest:oldIntent.inputDigest,beforeHash:oldIntent.beforeHash});
 expect(f.store.inputBinding(next.job.saveId)).toMatchObject({inputDigest:f.binding.inputDigest,beforeHash:oldIntent.beforeHash});
});

test('expiry, clock rollback, policy changes, exclusions, provider drift and quota never consume approval',()=>{
 for(const change of ['expiry','clock','policy','exclude','provider','interval','daily','target'] as const){
  const f=fixture(),request=prepare(f),priorJobs=rows(f.store.path,'save_jobs');
  if(change==='expiry')f.advance(MEMORY_SAVE_RECOVERY_REVIEW_TTL);
  if(change==='clock')f.advance(-1);
  if(change==='policy')f.store.setAutomaticPolicy(1,{enabled:false});
  if(change==='exclude')f.store.setAutomaticPolicy(1,{enabled:true,consentVersion:1,providerBindingDigest:oldIntent.providerBindingDigest,excludedMemoryIds:['memory']});
  if(change==='provider')f.store.setAutomaticPolicy(1,{enabled:true,consentVersion:1,providerBindingDigest:saveDigest('changed provider')});
  if(change==='target')request.binding={...request.binding,targetId:'different'};
  if(change==='interval')dbRead(f.store.path,db=>db.query('UPDATE save_auto_attempts SET startedAt=?').run(f.now-100));
  if(change==='daily')dbRead(f.store.path,db=>{for(let i=0;i<7;i++)db.query('INSERT INTO save_auto_attempts VALUES (?,?,?,?,?)').run(`other-${i}`,`attempt-${i}`,'other',1,f.now-100);});
  expect(()=>f.store.admitRecoverySuccessor(request)).toThrow();expect(rows(f.store.path,'save_jobs')).toEqual(priorJobs);expect(rows(f.store.path,'save_recovery_decisions')).toHaveLength(0);
  expect((rows(f.store.path,'save_recovery_approvals')[0] as {consumedAt:unknown}).consumedAt).toBeNull();
 }
});

test('all admission failure boundaries roll back original phase, quota, input, approval and decision atomically',()=>{
 for(const [table,event,condition] of [['save_auto_attempts','INSERT',''],['save_jobs','UPDATE',"WHEN NEW.phase='superseded-unknown'"],['save_jobs','INSERT',''],['save_input_bindings','INSERT',''],['save_recovery_approvals','UPDATE',''],['save_recovery_decisions','INSERT','']] as const){
  const f=fixture(),request=prepare(f),before=immutable(f),jobs=rows(f.store.path,'save_jobs'),approvals=rows(f.store.path,'save_recovery_approvals'),policy=f.store.automaticPolicy();
  dbRead(f.store.path,db=>db.run(`CREATE TRIGGER fail_admission BEFORE ${event} ON ${table} ${condition} BEGIN SELECT RAISE(ABORT,'fixture interruption'); END`));
  expect(()=>f.store.admitRecoverySuccessor(request)).toThrow('STORAGE_UNAVAILABLE');expect(immutable(f)).toEqual(before);expect(rows(f.store.path,'save_jobs')).toEqual(jobs);
  expect(rows(f.store.path,'save_recovery_approvals')).toEqual(approvals);expect(rows(f.store.path,'save_recovery_decisions')).toHaveLength(0);expect(f.store.automaticPolicy()).toEqual(policy);
  expect(f.store.openJob('memory')?.saveId).toBe(f.job.saveId);
  dbRead(f.store.path,db=>db.run('DROP TRIGGER fail_admission'));expect(f.store.admitRecoverySuccessor(request).created).toBe(true);
 }
});

test('two processes race one approval and only one receives a new execution admission',async()=>{
 const f=fixture(),request=prepare(f),script=join(f.root,'race.ts');
 writeFileSync(script,`import {MemorySaveStore} from ${JSON.stringify(resolve(import.meta.dir,'../src/memorySaveStore.ts'))};
 const store=new MemorySaveStore(${JSON.stringify(f.store.path)},()=>${f.now});
 try { const r=store.admitRecoverySuccessor(${JSON.stringify(request)});process.exit(r.created?0:3); }catch(e){process.exit(e.code==='STORAGE_UNAVAILABLE'?4:5);}`);
 const children=[0,1].map(()=>Bun.spawn({cmd:[process.execPath,script],stdout:'ignore',stderr:'ignore'}));
 expect((await Promise.all(children.map(p=>p.exited))).sort()).toEqual([0,3]);expect(rows(f.store.path,'save_jobs')).toHaveLength(2);expect(rows(f.store.path,'save_auto_attempts')).toHaveLength(2);
 expect(rows(f.store.path,'save_recovery_decisions')).toHaveLength(1);
});

test('process death after admission cannot replay a successor and leaves its durable attempt intact',()=>{
 const f=fixture(),request=prepare(f),script=join(f.root,'die.ts');
 writeFileSync(script,`import {MemorySaveStore} from ${JSON.stringify(resolve(import.meta.dir,'../src/memorySaveStore.ts'))};
 new MemorySaveStore(${JSON.stringify(f.store.path)},()=>${f.now}).admitRecoverySuccessor(${JSON.stringify(request)});process.kill(process.pid,'SIGKILL');`);
 expect(Bun.spawnSync({cmd:[process.execPath,script],stdout:'ignore',stderr:'ignore'}).exitCode).not.toBe(0);
 const repeated=f.store.admitRecoverySuccessor(request);expect(repeated.created).toBe(false);expect(repeated.job.phase).toBe('summarizing');
 expect(()=>f.store.beginAutomaticAttempt(repeated.job.saveId,repeated.job.coverageDigest,1,f.binding)).toThrow('RECOVERY_REQUIRED');
 expect(rows(f.store.path,'save_auto_attempts')).toHaveLength(2);expect(rows(f.store.path,'save_sources')).toHaveLength(2);
});

test('read-only candidate has no filesystem side effects and damaged/oversized or nonoriginal coverage cannot become eligible',()=>{
 const root=mkdtempSync(join(tmpdir(),'save-successor-absent-'));roots.push(root);const path=join(root,'absent','save.sqlite');
 const absent=new MemorySaveStore(path);expect(absent.recoveryCandidate('job')).toBeNull();expect(absent.recoveryApproval('approval')).toBeNull();expect(existsSync(join(root,'absent'))).toBe(false);
 for(const mutation of ['source','owner','partial','intent','bound','receipt','summarizing','legacy','extra'] as const){
  const f=fixture();dbRead(f.store.path,db=>{
   if(mutation==='source')db.query('UPDATE save_sources SET payload=? WHERE sourceKey=?').run('x'.repeat(5000),f.keys[0]!);
   if(mutation==='owner')db.query('UPDATE save_sources SET saveId=NULL WHERE sourceKey=?').run(f.keys[0]!);
   if(mutation==='partial')db.query('DELETE FROM save_job_sources WHERE sourceKey=?').run(f.keys[0]!);
   if(mutation==='intent')db.query('UPDATE save_jobs SET intent=? WHERE saveId=?').run('{}',f.job.saveId);
   if(mutation==='bound')db.query('INSERT INTO save_host_sessions VALUES (?,?,?)').run(f.job.saveId,'plan','{}');
   if(mutation==='receipt')db.query('UPDATE save_jobs SET receipt=? WHERE saveId=?').run('{}',f.job.saveId);
   if(mutation==='summarizing')db.query("UPDATE save_jobs SET phase='summarizing' WHERE saveId=?").run(f.job.saveId);
   if(mutation==='legacy')db.query('DELETE FROM save_auto_attempts WHERE saveId=?').run(f.job.saveId);
   if(mutation==='extra')db.query('UPDATE save_sources SET payload=? WHERE sourceKey=?').run(JSON.stringify({...f.sources[0]!,sourceDigest:saveDigest('changed')}),f.keys[0]!);
  });
  const bytes=readFileSync(f.store.path);expect(()=>f.store.recoveryCandidate(f.job.saveId)).toThrow();expect(readFileSync(f.store.path)).toEqual(bytes);
 }
 const many=fixture(9);expect(()=>many.store.recoveryCandidate(many.job.saveId)).toThrow('SOURCES_INELIGIBLE');
 const f=fixture();dbRead(f.store.path,db=>db.run('PRAGMA user_version=99'));const bytes=readFileSync(f.store.path);expect(()=>f.store.recoveryCandidate(f.job.saveId)).toThrow('UNSUPPORTED_VERSION');expect(readFileSync(f.store.path)).toEqual(bytes);
});
