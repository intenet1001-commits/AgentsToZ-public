import {afterEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {MemorySaveStore} from '../src/memorySaveStore';
import {MemorySaveAutomaticHost} from '../src/memorySaveAutomaticHost';
import {MemorySessionStore} from '../src/memorySessionStore';
import {MemorySaveDispatcher} from '../src/memorySaveDispatcher';
import {saveDigest} from '../src/memorySaveContract';
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const intent={inputDigest:'a'.repeat(64),beforeHash:'b'.repeat(64),providerBindingDigest:'c'.repeat(64)};
function setup(create=false){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'memory-status-readonly-')));roots.push(root);
 const app=join(root,'missing-parent','app'),project=join(root,'project');mkdirSync(project);
 const store=new MemorySaveStore(join(app,'memory-save-v2.sqlite'),()=>1234),sessions=new MemorySessionStore(join(app,'sessions.sqlite'));
 const target={id:'fixture-target',cwd:project,root:project,memoryId:'memory',validate:async()=>true};
 const forbidden=():never=>{throw new Error('Status may not invoke a runtime, key, identity, lease or writer');};
 const unavailable=async():Promise<never>=>forbidden();
 const host=new MemorySaveAutomaticHost({enabled:()=>true,store,sessions,appDataRoot:app,portalDataFile:join(app,'portal.json'),
  dispatcher:new MemorySaveDispatcher(),identity:forbidden,targets:async()=>[],resolve:async()=>target,discover:unavailable,providerHost:forbidden,key:forbidden,
  acquireApp:unavailable,acquireWorkspace:unavailable,release:forbidden,preflight:unavailable,disableLegacy:forbidden});
 if(create)mkdirSync(app,{recursive:true});
 return {root,app,project,store,sessions,target,host};
}
function jobFixture(){
 const f=setup(true);const key=f.store.observe({agent:'codex',instanceId:'fixture',sessionId:'session',turnId:'turn',startByte:0,endByte:100,
  sourceDigest:'d'.repeat(64),memoryId:'memory',policyEpoch:1,completedAt:1000,coverageKind:'complete-turn'});
 const job=f.store.reserve('memory',1,[key]),attempt=f.store.beginAttempt(job.saveId,job.coverageDigest,intent);f.store.requireRecovery(job.saveId,attempt);
 return {...f,key,job,attempt};
}
function readDb<T>(path:string,read:(db:Database)=>T):T{const db=new Database(path,{readonly:true});try{return read(db);}finally{db.close();}}
function forbidLegacyReaders(f:ReturnType<typeof setup>){
 for(const method of ['automaticPolicy','providerBinding','latestJob','hostBinding','hostSessionId','failure','backupSummary'] as const)
  (f.store as any)[method]=()=>{throw new Error('Legacy writer-backed reader called: '+method);};
 f.sessions.get=()=>{throw new Error('Plan bodies are outside status scope');};
}
function boundSavedFixture(pendingId='plan-fixture'){
 const f=jobFixture();const binding={sessionPlanId:'plan-fixture',planDigest:'d'.repeat(64),rootDigest:saveDigest(f.project),beforeHash:intent.beforeHash,afterHash:'f'.repeat(64),backupRequested:false};
 f.store.bindHostSession(f.job.saveId,f.attempt,binding);
 f.store.commitLocal(f.job.saveId,f.attempt,{manifestDigest:binding.planDigest,beforeHash:binding.beforeHash,afterHash:binding.afterHash,localRevisionId:binding.sessionPlanId},false);
 f.sessions.status(f.project);const db=new Database(f.sessions.path);try{db.query('INSERT INTO pending VALUES (?,?,?,?)').run(f.project,pendingId,'outcome','UNREAD_PLAN_BODY'.repeat(100000));}finally{db.close();}
 return f;
}
test('status and management status create neither a missing app-data parent nor any database',async()=>{
 const f=setup();forbidLegacyReaders(f);
 expect(existsSync(join(f.root,'missing-parent'))).toBe(false);
 expect(await f.host.status(f.target)).toMatchObject({enabled:false,revision:0,provider:null,last:null,backup:{pending:0,blocked:0,hasMore:false}});
 expect(await f.host.manage({automaticOperation:'status',observationTargetId:f.target.id})).toMatchObject({enabled:false,revision:0,last:null});
 expect(existsSync(join(f.root,'missing-parent'))).toBe(false);expect(readdirSync(f.root)).toEqual(['project']);
});
test('schema seven status preserves database bytes, version and permissions while exposing legacy unknown recovery and backup counts',async()=>{
 const f=jobFixture();const db=new Database(f.store.path);
 try{
  db.run('DROP TABLE save_failure_diagnostics');db.run('PRAGMA user_version=7');
  db.query('INSERT INTO backup_outbox(saveId,memoryId,localRevisionId,destination,state) VALUES (?,?,?,?,?)').run('backup-pending','memory','revision-a','supabase','pending');
  db.query('INSERT INTO backup_outbox(saveId,memoryId,localRevisionId,destination,state) VALUES (?,?,?,?,?)').run('backup-blocked','memory','revision-b','supabase','blocked');
 }finally{db.close();}
 chmodSync(f.store.path,0o640);chmodSync(f.app,0o750);
 const before=readFileSync(f.store.path),mode=statSync(f.store.path).mode,parentMode=statSync(f.app).mode,names=readdirSync(f.app);
 forbidLegacyReaders(f);const status=await f.host.status(f.target);
 expect(status).toMatchObject({enabled:false,revision:0,provider:null,last:{state:'recovery-required',localSaved:false,failure:null,recovery:'no-retained-plan'},backup:{pending:1,blocked:1,hasMore:false}});
 expect(readFileSync(f.store.path)).toEqual(before);expect(statSync(f.store.path).mode).toBe(mode);expect(statSync(f.app).mode).toBe(parentMode);
 expect(readdirSync(f.app)).toEqual(names);expect(existsSync(f.sessions.path)).toBe(false);
 expect(readDb(f.store.path,db=>db.query('PRAGMA user_version').get())).toEqual({user_version:7});
 expect(readDb(f.store.path,db=>db.query("SELECT name FROM sqlite_master WHERE name='save_failure_diagnostics'").all())).toEqual([]);
});
test('save-store exclusive lock cannot masquerade as missing or disabled state',async()=>{
 const f=jobFixture(),db=new Database(f.store.path);const before=readFileSync(f.store.path);
 try{db.run('BEGIN EXCLUSIVE');await expect(f.host.status(f.target)).rejects.toThrow();}
 finally{db.run('ROLLBACK');db.close();}
 expect(readFileSync(f.store.path)).toEqual(before);expect(existsSync(f.sessions.path)).toBe(false);
 expect((await f.host.status(f.target)).last).toMatchObject({state:'recovery-required',recovery:'no-retained-plan'});
});
test('future save-store schema remains unreadable rather than absent and is not migrated or chmodded',async()=>{
 const f=jobFixture(),db=new Database(f.store.path);try{db.run('PRAGMA user_version=99');}finally{db.close();}
 chmodSync(f.store.path,0o640);const before=readFileSync(f.store.path),mode=statSync(f.store.path).mode;
 await expect(f.host.status(f.target)).rejects.toThrow();
 expect(readFileSync(f.store.path)).toEqual(before);expect(statSync(f.store.path).mode).toBe(mode);
 expect(readDb(f.store.path,db=>db.query('PRAGMA user_version').get())).toEqual({user_version:99});expect(existsSync(f.sessions.path)).toBe(false);
});
test('a saved exact-root plan uses bounded binding metadata without reading the large pending plan body',async()=>{
 const f=boundSavedFixture();
 const before=readFileSync(f.store.path),sessionBefore=readFileSync(f.sessions.path);forbidLegacyReaders(f);
 const status=await f.host.status(f.target);
 expect(status.last).toMatchObject({state:'recovery-required',localSaved:true,recovery:'saved-plan',failure:null});
 expect(JSON.stringify(status)).not.toContain('UNREAD_PLAN_BODY');
 expect(readFileSync(f.store.path)).toEqual(before);expect(readFileSync(f.sessions.path)).toEqual(sessionBefore);
});
test('oversized binding bodies remain unknown instead of authenticating a pending plan through its ID alone',async()=>{
 const f=boundSavedFixture();const db=new Database(f.store.path);try{db.query('UPDATE save_host_sessions SET payload=? WHERE saveId=?').run('UNREAD_BINDING_BODY'.repeat(100000),f.job.saveId);}finally{db.close();}
 const before=readFileSync(f.store.path),sessionBefore=readFileSync(f.sessions.path);forbidLegacyReaders(f);
 const status=await f.host.status(f.target);
 expect(status.last).toMatchObject({state:'recovery-required',localSaved:false,recovery:'unavailable'});
 expect(JSON.stringify(status)).not.toContain('UNREAD_BINDING_BODY');expect(JSON.stringify(status)).not.toContain('UNREAD_PLAN_BODY');
 expect(readFileSync(f.store.path)).toEqual(before);expect(readFileSync(f.sessions.path)).toEqual(sessionBefore);
});
test('a historical saved receipt is not attributed to a reassigned canonical root while worktree cwd still shares the same root',async()=>{
 const f=boundSavedFixture();forbidLegacyReaders(f);
 const otherRoot=join(f.root,'other-project');mkdirSync(otherRoot);
 const moved=await f.host.status({...f.target,root:otherRoot,cwd:otherRoot});
 expect(moved.last).toMatchObject({state:'recovery-required',localSaved:false,historicalReceipt:true,recovery:'plan-needs-review'});
 const worktree=await f.host.status({...f.target,cwd:join(f.project,'other-worktree')});
 expect(worktree.last).toMatchObject({state:'recovery-required',localSaved:true,recovery:'saved-plan'});
});
test('an unrelated pending plan cannot inherit an older receipt when host plan metadata is missing or corrupt',async()=>{
 for(const corruption of ['missing','oversized','invalid']){
  const f=boundSavedFixture('different-plan'),db=new Database(f.store.path);
  try{if(corruption==='missing')db.query('DELETE FROM save_host_sessions WHERE saveId=?').run(f.job.saveId);
   else db.query('UPDATE save_host_sessions SET sessionPlanId=? WHERE saveId=?').run(corruption==='oversized'?'x'.repeat(129):'invalid/plan',f.job.saveId);
  }finally{db.close();}
  const before=readFileSync(f.store.path),sessionBefore=readFileSync(f.sessions.path);forbidLegacyReaders(f);
  const status=await f.host.status(f.target);
  expect(status.last).toMatchObject({state:'recovery-required',localSaved:false,recovery:corruption==='missing'?'plan-needs-review':'unavailable'});
  expect(readFileSync(f.store.path)).toEqual(before);expect(readFileSync(f.sessions.path)).toEqual(sessionBefore);
 }
});
test('status preserves the original diagnostic, attempt, source ownership and receipt without invoking legacy writer-backed getters',async()=>{
 const f=jobFixture();f.store.recordFailure(f.job.saveId,f.attempt,{version:1,stage:'provider-call',code:'UNKNOWN',providerCallPossible:true});
 const tables=['save_jobs','save_sources','save_job_sources','save_auto_policy','save_auto_attempts','save_failure_diagnostics','save_host_sessions'];
 const before=readDb(f.store.path,db=>tables.map(table=>db.query('SELECT * FROM '+table).all()));forbidLegacyReaders(f);
 expect((await f.host.status(f.target)).last).toMatchObject({state:'recovery-required',localSaved:false,failure:{version:1,stage:'provider-call',code:'UNKNOWN',recordedAt:1234,providerCallPossible:true}});
 expect(readDb(f.store.path,db=>tables.map(table=>db.query('SELECT * FROM '+table).all()))).toEqual(before);
});
