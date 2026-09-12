import {afterEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemorySaveStore} from '../src/memorySaveStore';
import {saveDigest,type MemorySaveSource,type MemorySaveJob} from '../src/memorySaveContract';
const roots:string[]=[];afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
const intent={inputDigest:saveDigest('input'),beforeHash:saveDigest('before'),providerBindingDigest:saveDigest('provider-model-reasoning')};
const consent={enabled:true,consentVersion:1,providerBindingDigest:intent.providerBindingDigest};
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'auto-admission-'));roots.push(root);let now=1000000,seq=0;
 const store=new MemorySaveStore(join(root,'save.sqlite'),()=>now);
 return {root,store,get now(){return now;},set now(v:number){now=v;},
  enable:()=>store.setAutomaticPolicy(store.automaticPolicy().revision,consent),
  job:(memoryId='memory-a',extra:Partial<MemorySaveSource>={})=>{
   now++;const source:MemorySaveSource={agent:'codex',instanceId:'device',sessionId:'session',turnId:`turn-${++seq}`,startByte:100*seq,endByte:100*seq+50,sourceDigest:saveDigest(seq),completedAt:now,memoryId,policyEpoch:1,coverageKind:'complete-turn',...extra};
   const key=store.observe(source);return store.reserve(memoryId,1,[key]);
  }};
}
function begin(f:ReturnType<typeof fixture>,job:MemorySaveJob,revision=f.store.automaticPolicy().revision){return f.store.beginAutomaticAttempt(job.saveId,job.coverageDigest,revision,intent);}
function complete(f:ReturnType<typeof fixture>,job:MemorySaveJob,attempt:string){f.store.commitLocal(job.saveId,attempt,{manifestDigest:saveDigest('manifest'),beforeHash:intent.beforeHash,afterHash:saveDigest('after'),localRevisionId:job.saveId},false);}
function usage(store:MemorySaveStore){const db=new Database(store.path);try{return db.query('SELECT * FROM save_auto_attempts').all();}finally{db.close();}}

test('V2 defaults off and requires versioned explicit consent, policy CAS and verified provider binding',()=>{
 const f=fixture();expect(f.store.automaticPolicy()).toEqual({revision:0,enabled:false,enabledAt:null,providerBindingDigest:null,excludedMemoryIds:[],scopeMemoryId:null,scopeTargetId:null});
 const job=f.job();expect(()=>begin(f,job)).toThrow('POLICY_DISABLED');
 expect(()=>f.store.setAutomaticPolicy(0,{enabled:true})).toThrow('INVALID_INPUT');
 expect(()=>f.store.setAutomaticPolicy(0,{...consent,consentVersion:0})).toThrow('INVALID_INPUT');
 f.enable();expect(()=>f.store.setAutomaticPolicy(0,consent)).toThrow('POLICY_CHANGED');
 expect(()=>f.store.beginAutomaticAttempt(job.saveId,job.coverageDigest,undefined as any,intent)).toThrow('INVALID_INPUT');
 expect(()=>f.store.beginAutomaticAttempt(job.saveId,job.coverageDigest,1,{...intent,providerBindingDigest:saveDigest('different')})).toThrow('POLICY_CHANGED');
 expect(()=>begin(f,job)).toThrow('SOURCES_INELIGIBLE');expect(usage(f.store)).toHaveLength(0);
});

test('consent watermark rejects older receipts even with future timestamps, fragments, and excluded projects',()=>{
 const f=fixture();const old=f.job('old',{completedAt:f.now+10000});f.enable();f.now+=10000;
 expect(()=>begin(f,old)).toThrow('SOURCES_INELIGIBLE');
 const fragment=f.job('fragment',{coverageKind:'fragment'});expect(()=>begin(f,fragment)).toThrow('SOURCES_INELIGIBLE');
 const backdated=f.job('backdated',{completedAt:1});expect(()=>begin(f,backdated)).toThrow('SOURCES_INELIGIBLE');
 const future=f.job('future',{completedAt:f.now+1000});expect(()=>begin(f,future)).toThrow('SOURCES_INELIGIBLE');
 const current=f.job('excluded');const prior=f.store.automaticPolicy().revision;
 f.store.setAutomaticPolicy(prior,{...consent,excludedMemoryIds:['excluded']});
 expect(()=>begin(f,current,prior)).toThrow('POLICY_CHANGED');expect(()=>begin(f,current)).toThrow('POLICY_DISABLED');expect(usage(f.store)).toHaveLength(0);
});

test('rolling eight-call quota survives restart and disable/re-enable without a midnight reset',()=>{
 const f=fixture();f.enable();let first=0;
 for(let i=0;i<8;i++){const job=f.job(`memory-${i}`);if(!i)first=f.now;complete(f,job,begin(f,job));}
 expect(usage(f.store)).toHaveLength(8);const denied=f.job('denied');expect(()=>begin(f,denied)).toThrow('BUDGET_PAUSED');
 const reopened=new MemorySaveStore(f.store.path,()=>f.now);expect(()=>reopened.beginAutomaticAttempt(denied.saveId,denied.coverageDigest,1,intent)).toThrow('BUDGET_PAUSED');
 f.store.setAutomaticPolicy(1,{enabled:false});f.enable();const after=f.job('after-enable');expect(()=>begin(f,after)).toThrow('BUDGET_PAUSED');
 f.now=first+24*60*60*1000;const next=f.job('next-day');complete(f,next,begin(f,next));expect(usage(f.store)).toHaveLength(9);
});

test('project cooldown is independent of global budget and clock rollback cannot refill either',()=>{
 const f=fixture();f.enable();const a=f.job();const started=f.now;complete(f,a,begin(f,a));
 const b=f.job();expect(()=>begin(f,b)).toThrow('BUDGET_PAUSED');f.now=started-1;expect(()=>begin(f,b)).toThrow('CLOCK_ROLLBACK');
 f.now=started+30*60*1000;complete(f,b,begin(f,b));expect(usage(f.store)).toHaveLength(2);
 f.now=1;f.store.setAutomaticPolicy(1,{enabled:false});expect(f.store.automaticPolicy().enabled).toBe(false);
 expect(()=>f.enable()).toThrow('CLOCK_ROLLBACK');expect(usage(f.store)).toHaveLength(2);
});

test('one global attempt blocks other roots and legacy bypass, including ambiguity after restart and opt-out',()=>{
 const f=fixture();f.enable();const a=f.job('a'),b=f.job('b');const attempt=begin(f,a);
 expect(()=>begin(f,b)).toThrow('EXECUTION_BUSY');expect(()=>f.store.beginAttempt(b.saveId,b.coverageDigest,intent)).toThrow('AUTOMATIC_ONLY');
 f.store.requireRecovery(a.saveId,attempt);f.store.setAutomaticPolicy(1,{enabled:false});
 const restarted=new MemorySaveStore(f.store.path,()=>f.now);expect(()=>restarted.beginAttempt(b.saveId,b.coverageDigest,intent)).toThrow('AUTOMATIC_ONLY');
 expect(()=>restarted.beginAutomaticAttempt(a.saveId,a.coverageDigest,2,intent)).toThrow('RECOVERY_REQUIRED');
 complete(f,a,attempt);expect(usage(f.store)).toHaveLength(1);
});

test('pre-existing legacy attempts also fence automatic concurrency when the new policy is enabled',()=>{
 const f=fixture();const legacy=f.job('legacy');f.store.beginAttempt(legacy.saveId,legacy.coverageDigest,intent);f.enable();
 const automatic=f.job('automatic');expect(()=>begin(f,automatic)).toThrow('EXECUTION_BUSY');expect(usage(f.store)).toHaveLength(0);
});

test('quota, clock, intent, and phase commit together; injected I/O failure cannot consume a partial reservation',()=>{
 const f=fixture();f.enable();const job=f.job();const db=new Database(f.store.path);
 db.run("CREATE TRIGGER deny_phase BEFORE UPDATE OF phase ON save_jobs BEGIN SELECT RAISE(ABORT,'fixture failure'); END");db.close();
 expect(()=>begin(f,job)).toThrow('STORAGE_UNAVAILABLE');expect(usage(f.store)).toHaveLength(0);expect(f.store.page().items[0]?.phase).toBe('prepared');
 const repair=new Database(f.store.path);repair.run('DROP TRIGGER deny_phase');repair.close();const attempt=begin(f,job);expect(usage(f.store)).toHaveLength(1);
 expect(()=>begin(f,job)).toThrow('RECOVERY_REQUIRED');complete(f,job,attempt);
});

test('schema two upgrades with existing sources and ambiguous attempts intact and policy disabled',()=>{
 const f=fixture();const job=f.job();const attempt=f.store.beginAttempt(job.saveId,job.coverageDigest,intent);
 {const db=new Database(f.store.path);for(const table of ['save_provider_recovery_reviews','save_provider_recovery_probes','save_provider_recovery_results','save_provider_recovery_clock'])db.run(`DROP TABLE ${table}`);db.close();}
 const db=new Database(f.store.path);db.run('DROP TABLE save_host_sessions');db.run('DROP TABLE save_auto_attempts');db.run('DROP TABLE save_auto_policy');db.run('DROP INDEX jobs_active_attempt');db.run('DROP TABLE save_provider_binding');db.run('DROP TABLE save_input_bindings');db.run('DROP INDEX backup_outbox_ready');db.run('DROP INDEX backup_memory_state');db.run('DROP INDEX jobs_memory_sequence');db.run('ALTER TABLE backup_outbox DROP COLUMN attempts');db.run('ALTER TABLE backup_outbox DROP COLUMN retryAt');db.run('DROP TABLE save_failure_diagnostics');db.run('DROP TABLE save_recovery_approvals');db.run('DROP TABLE save_recovery_decisions');db.run('DROP INDEX jobs_open_root');db.run("CREATE UNIQUE INDEX jobs_open_root ON save_jobs(memoryId) WHERE phase<>'local-saved'");db.run('PRAGMA user_version=2');db.close();
 const reopened=new MemorySaveStore(f.store.path);expect(reopened.automaticPolicy().enabled).toBe(false);expect(reopened.page().items[0]?.attemptId).toBe(attempt);
 expect(()=>reopened.beginAttempt(job.saveId,job.coverageDigest,intent)).toThrow('RECOVERY_REQUIRED');expect(usage(reopened)).toHaveLength(0);
});

test('separate processes compete for the same global slot; SIGKILL never refunds the admitted intent',async()=>{
 const f=fixture();f.enable();const jobs=[f.job('a'),f.job('b')];
 const modulePath=join(import.meta.dir,'../src/memorySaveStore.ts');
 const workers=jobs.map(job=>Bun.spawn([process.execPath,'-e',`import {MemorySaveStore} from ${JSON.stringify(modulePath)};const s=new MemorySaveStore(${JSON.stringify(f.store.path)},()=>${f.now});try{s.beginAutomaticAttempt(${JSON.stringify(job.saveId)},${JSON.stringify(job.coverageDigest)},1,${JSON.stringify(intent)});process.kill(process.pid,'SIGKILL');}catch(e){console.log(e.code);}`],{stdout:'pipe',stderr:'pipe'}));
 const results=await Promise.all(workers.map(async w=>({code:await w.exited,output:await new Response(w.stdout).text(),error:await new Response(w.stderr).text()})));
 expect(results.filter(r=>r.code!==0)).toHaveLength(1);expect(results.find(r=>r.code===0)?.output.trim()).toBe('EXECUTION_BUSY');
 expect(results.every(r=>!r.error)).toBe(true);expect(usage(f.store)).toHaveLength(1);
 const active=f.store.page().items.find(j=>j.phase==='summarizing')!;expect(()=>begin(f,active)).toThrow('RECOVERY_REQUIRED');
},10000);

test('project scope survives restart, rejects other/new roots, and leaves unrelated legacy work available',()=>{
 const f=fixture();f.store.setAutomaticPolicy(0,{...consent,scopeMemoryId:'pilot'});
 const pilot=f.job('pilot'),other=f.job('other');
 expect(()=>begin(f,other)).toThrow('POLICY_DISABLED');
 expect(()=>f.store.beginAttempt(pilot.saveId,pilot.coverageDigest,intent)).toThrow('AUTOMATIC_ONLY');
 const reopened=new MemorySaveStore(f.store.path,()=>f.now);
 expect(reopened.automaticPolicy().scopeMemoryId).toBe('pilot');
 expect(()=>reopened.setAutomaticPolicy(1,{...consent,scopeMemoryId:null})).toThrow('POLICY_CHANGED');
 const legacy=reopened.beginAttempt(other.saveId,other.coverageDigest,intent);complete(f,other,legacy);
 complete(f,pilot,begin(f,pilot));
 const future=f.job('registered-later');expect(()=>begin(f,future)).toThrow('POLICY_DISABLED');
 expect(usage(f.store)).toHaveLength(1);
});

test('schema six migrates global consent without expanding or resetting history, and schema seven rejects missing scope',()=>{
 const f=fixture();f.enable();const job=f.job();complete(f,job,begin(f,job));
 const db=new Database(f.store.path);const payload=JSON.parse((db.query('SELECT payload FROM save_auto_policy').get() as {payload:string}).payload);
 for(const table of ['save_provider_recovery_reviews','save_provider_recovery_probes','save_provider_recovery_results','save_provider_recovery_clock'])db.run(`DROP TABLE ${table}`);
 delete payload.scopeMemoryId;delete payload.scopeTargetId;db.query('UPDATE save_auto_policy SET payload=?').run(JSON.stringify(payload));db.run('DROP TABLE save_failure_diagnostics');db.run('DROP TABLE save_recovery_approvals');db.run('DROP TABLE save_recovery_decisions');db.run('DROP INDEX jobs_open_root');db.run("CREATE UNIQUE INDEX jobs_open_root ON save_jobs(memoryId) WHERE phase<>'local-saved'");db.run('PRAGMA user_version=6');db.close();
 expect(f.store.automaticPolicy()).toMatchObject({enabled:true,revision:1,scopeMemoryId:null});expect(usage(f.store)).toHaveLength(1);
 const broken=new Database(f.store.path);expect(broken.query('PRAGMA user_version').get()).toEqual({user_version:10});
 broken.query('UPDATE save_auto_policy SET payload=?').run(JSON.stringify(payload));broken.close();
 expect(()=>f.store.automaticPolicy()).toThrow('STORAGE_UNAVAILABLE');
});
