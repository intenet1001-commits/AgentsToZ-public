import {afterEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {MemorySaveStore} from '../src/memorySaveStore';
import {MemorySaveAutomaticHost} from '../src/memorySaveAutomaticHost';
import {MemorySessionStore} from '../src/memorySessionStore';
import {MemorySaveDispatcher} from '../src/memorySaveDispatcher';
import {readMemoryObservationSummary} from '../src/memoryObservationStatus';
import {memorySaveFailureCode,memorySaveFailureDescription,parseMemorySaveFailure} from '../src/memorySaveFailure';
import {memorySaveRecoveryDescription} from '../src/memorySaveRecovery';
import {saveDigest} from '../src/memorySaveContract';
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const intent={inputDigest:'a'.repeat(64),beforeHash:'b'.repeat(64),providerBindingDigest:'c'.repeat(64)};
const failure={version:1 as const,stage:'provider-call' as const,code:'UNKNOWN' as const,providerCallPossible:true};
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'memory-failure-'));roots.push(root);
 const store=new MemorySaveStore(join(root,'memory-save-v2.sqlite'),()=>1234);
 const key=store.observe({agent:'codex',instanceId:'fixture',sessionId:'session',turnId:'turn',startByte:0,endByte:100,sourceDigest:'d'.repeat(64),memoryId:'memory',policyEpoch:1,completedAt:1000,coverageKind:'complete-turn'});
 const job=store.reserve('memory',1,[key]);const attempt=store.beginAttempt(job.saveId,job.coverageDigest,intent);
 store.requireRecovery(job.saveId,attempt);
 return {root,store,key,job,attempt};
}
function statusFixture(f:ReturnType<typeof fixture>){
 const project=join(f.root,'project');mkdirSync(project);
 const target={id:'fixture-target',cwd:project,root:project,memoryId:'memory',validate:async()=>true};
 const unavailable=async():Promise<never>=>{throw new Error('No runtime operation is authorized by this status fixture');};
 const sessions=new MemorySessionStore(join(f.root,'sessions.sqlite'));
 const host=new MemorySaveAutomaticHost({enabled:()=>true,store:f.store,sessions,
  appDataRoot:f.root,portalDataFile:join(f.root,'portal.json'),dispatcher:new MemorySaveDispatcher(),identity:()=>{throw new Error('identity called');},
  targets:async()=>[],resolve:async()=>target,discover:unavailable,providerHost:()=>{throw new Error('provider called');},key:()=>{throw new Error('key called');},
  acquireApp:unavailable,acquireWorkspace:unavailable,release:()=>{},preflight:unavailable,disableLegacy:()=>{}});
 return {host,target,sessions,project};
}
test('the first bounded failure survives reopening without changing the job, source fence, quota or consent',()=>{
 const f=fixture(),db=new Database(f.store.path);
 const tables=['save_jobs','save_sources','save_job_sources','save_auto_policy','save_auto_attempts','backup_outbox'];
 const before=tables.map(table=>db.query('SELECT * FROM '+table).all());
 try{
  f.store.recordFailure(f.job.saveId,f.attempt,failure);
  f.store.recordFailure(f.job.saveId,f.attempt,{...failure,stage:'host-commit',code:'POLICY_CHANGED'});
  expect(tables.map(table=>db.query('SELECT * FROM '+table).all())).toEqual(before);
  expect(db.query('SELECT count(*) AS count FROM save_failure_diagnostics').get()).toEqual({count:1});
  const saved=new MemorySaveStore(f.store.path).failure(f.job.saveId);
  expect(saved).toEqual({...failure,recordedAt:1234});
  expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThan(512);
  expect(()=>f.store.beginAttempt(f.job.saveId,f.job.coverageDigest,intent)).toThrow('RECOVERY_REQUIRED');
 }finally{db.close();}
});
test('version seven jobs migrate without inventing causes or changing their recovery fences',()=>{
 const f=fixture(),db=new Database(f.store.path);
 try{
  for(const table of ['save_provider_recovery_reviews','save_provider_recovery_probes','save_provider_recovery_results','save_provider_recovery_clock'])db.run(`DROP TABLE ${table}`);
  db.run('DROP TABLE save_failure_diagnostics');db.run('DROP TABLE save_recovery_approvals');db.run('DROP TABLE save_recovery_decisions');
  db.run('DROP INDEX jobs_open_root');db.run("CREATE UNIQUE INDEX jobs_open_root ON save_jobs(memoryId) WHERE phase<>'local-saved'");db.run('PRAGMA user_version=7');
  const before=db.query('SELECT * FROM save_jobs').all();
  expect(f.store.failure(f.job.saveId)).toBeNull();
  expect(db.query('PRAGMA user_version').get()).toEqual({user_version:10});
  expect(db.query('SELECT * FROM save_jobs').all()).toEqual(before);
  expect(db.query('SELECT * FROM save_failure_diagnostics').all()).toEqual([]);
  const bytes=readFileSync(f.store.path);
  expect(readMemoryObservationSummary(f.store.path,'memory')).toEqual({completedTurns:0,hasMore:false});
  expect(readFileSync(f.store.path)).toEqual(bytes);
  expect(memorySaveFailureDescription(null)).toContain('AI 호출 여부를 확인할 수 없습니다');
 }finally{db.close();}
});
test('diagnostics refuse reassigned attempts and cannot retain arbitrary error properties',()=>{
 const f=fixture();
 expect(()=>f.store.recordFailure(f.job.saveId,'other-attempt',failure)).toThrow('REVISION_CONFLICT');
 expect(()=>f.store.recordFailure(f.job.saveId,f.attempt,{...failure,message:'private raw transcript'} as any)).toThrow('INVALID_INPUT');
 expect(()=>f.store.recordFailure(f.job.saveId,f.attempt,{...failure,stage:'/private/path'} as any)).toThrow('INVALID_INPUT');
 expect(f.store.failure(f.job.saveId)).toBeNull();
 for(const raw of [new Error('/private/path token=SECRET'),{code:'SECRET',message:'secret prompt',stack:'private stack'},{get code(){throw new Error('private getter');}}])expect(memorySaveFailureCode(raw)).toBe('UNKNOWN');
 expect(memorySaveFailureCode({name:'AbortError'})).toBe('ABORTED');
 expect(memorySaveFailureCode({code:'POLICY_CHANGED',message:'secret'})).toBe('POLICY_CHANGED');
 expect(parseMemorySaveFailure({...failure,recordedAt:1234,response:'secret'})).toBeNull();
 expect(memorySaveFailureDescription({...failure,recordedAt:1234,stage:'secret'})).not.toContain('secret');
});
test('status exposes durable causes and old unknown recovery without accessing a provider or key',async()=>{
 const f=fixture(),{host,target}=statusFixture(f);
 expect((await host.status(target)).last).toMatchObject({state:'recovery-required',localSaved:false,failure:null});
 f.store.recordFailure(f.job.saveId,f.attempt,failure);
 expect((await host.status(target)).last).toMatchObject({state:'recovery-required',localSaved:false,failure:{...failure,recordedAt:1234}});
 const corrupt=new Database(f.store.path);try{corrupt.query('UPDATE save_failure_diagnostics SET payload=? WHERE saveId=?').run('{',f.job.saveId);}finally{corrupt.close();}
 expect((await host.status(target)).last).toMatchObject({state:'recovery-required',localSaved:false,failure:null});
});
test('recovery evidence distinguishes absent, unbound, bound and mismatched plans without loading their bodies',async()=>{
 const f=fixture(),{host,target,sessions,project}=statusFixture(f),before=f.store.get(f.job.saveId);
 expect((await host.status(target)).last).toMatchObject({state:'recovery-required',failure:null,recovery:'no-retained-plan'});
 expect(existsSync(sessions.path)).toBe(false);
 sessions.status(project);const db=new Database(sessions.path);
 try{
  db.query('INSERT INTO pending VALUES (?,?,?,?)').run(project,'plan-fixture','document','PRIVATE_FIXTURE_BODY'.repeat(100000));
  sessions.get=()=>{throw new Error('Plan body reads are forbidden');};f.store.hostBinding=()=>{throw new Error('Binding body reads are forbidden');};
  expect((await host.status(target)).last?.recovery).toBe('plan-needs-review');
  f.store.bindHostSession(f.job.saveId,f.attempt,{sessionPlanId:'plan-fixture',planDigest:'d'.repeat(64),rootDigest:saveDigest(project),beforeHash:intent.beforeHash,afterHash:'f'.repeat(64),backupRequested:false});
  const status=await host.status(target);expect(status.last?.recovery).toBe('bound-plan');
  expect(JSON.stringify(status)).not.toContain('PRIVATE_FIXTURE_BODY');expect(JSON.stringify(status)).not.toContain(project);
  db.query('UPDATE pending SET id=?').run('different-plan');expect((await host.status(target)).last?.recovery).toBe('plan-needs-review');
  db.run('DELETE FROM pending');expect((await host.status(target)).last?.recovery).toBe('plan-needs-review');
  expect(f.store.get(f.job.saveId)).toEqual(before);expect(f.store.failure(f.job.saveId)).toBeNull();
  expect(f.store.pending('memory',1).items).toEqual([]);expect(f.store.automaticPolicy().revision).toBe(0);
 }finally{db.close();}
 expect(memorySaveRecoveryDescription({message:'PRIVATE_FIXTURE'})).toBeNull();
 expect(memorySaveRecoveryDescription('future-state')).toBeNull();
});
test('read-only recovery lookup preserves legacy bytes and treats database busy, malformed and future records as unknown',async()=>{
 const f=fixture(),{host,target,sessions,project}=statusFixture(f);sessions.status(project);
 f.store.recordFailure(f.job.saveId,f.attempt,failure);const stored=f.store.failure(f.job.saveId);
 const db=new Database(sessions.path);
 try{
  db.run('PRAGMA user_version=1');const before=readFileSync(sessions.path);
  expect((await host.status(target)).last?.recovery).toBe('no-retained-plan');
  expect(readFileSync(sessions.path)).toEqual(before);expect(db.query('PRAGMA user_version').get()).toEqual({user_version:1});
  db.run('BEGIN EXCLUSIVE');
  try{expect((await host.status(target)).last).toMatchObject({recovery:'unavailable',failure:stored});}finally{db.run('ROLLBACK');}
  db.query('INSERT INTO pending VALUES (?,?,?,?)').run(project,'x'.repeat(129),'document','{}');
  expect((await host.status(target)).last?.recovery).toBe('unavailable');
  db.query('UPDATE pending SET id=?,phase=?').run('valid-id','future-phase');expect((await host.status(target)).last?.recovery).toBe('unavailable');
  db.run('PRAGMA user_version=99');const future=readFileSync(sessions.path);
  expect((await host.status(target)).last?.recovery).toBe('unavailable');expect(readFileSync(sessions.path)).toEqual(future);
  expect(f.store.failure(f.job.saveId)).toEqual(stored);expect(f.store.get(f.job.saveId).attemptId).toBe(f.attempt);
 }finally{db.close();}
});
