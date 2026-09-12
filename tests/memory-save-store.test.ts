import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MemorySaveStore } from '../src/memorySaveStore';
import { type MemorySaveSource, saveDigest } from '../src/memorySaveContract';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),'memory-save-v2-'));roots.push(root);return {root,store:new MemorySaveStore(join(root,'save.sqlite'))};}
function source(turnId='turn-1',extra:Partial<MemorySaveSource>={}):MemorySaveSource{return {agent:'codex',instanceId:'device-1',sessionId:'session-1',turnId,startByte:100,endByte:200,sourceDigest:saveDigest(turnId),memoryId:'memory-1',policyEpoch:1,completedAt:1,...extra};}
const receipt={manifestDigest:saveDigest('manifest'),beforeHash:saveDigest('before'),afterHash:saveDigest('after'),localRevisionId:'revision-1'};
const intent={inputDigest:saveDigest('input'),beforeHash:saveDigest('before'),providerBindingDigest:saveDigest('provider')};
function reserve(store:MemorySaveStore, sources=[source()]){const keys=sources.map(s=>store.observe(s));return store.reserve('memory-1',1,keys);}

test('conversation-only completion survives restart, without Git fingerprint, body or execution',()=>{
  const {store}=fixture();
  const metadata=source();
  const key=store.observe({...metadata,body:'never-persist-this-private-body',cwd:'/private/source'} as MemorySaveSource);
  const restarted=new MemorySaveStore(store.path);
  expect(restarted.observe(metadata)).toBe(key);
  expect(restarted.pending('memory-1',1).items.map(i=>i.sourceKey)).toEqual([key]);
  expect(restarted.page().items).toHaveLength(0);
  const bytes=readFileSync(store.path).toString();
  expect(bytes).not.toContain('never-persist-this-private-body');
  expect(bytes).not.toContain('/private/source');
  if(process.platform!=='win32')expect(statSync(store.path).mode & 0o777).toBe(0o600);
});

test('all entry points reuse the same exact coverage and cannot reserve a subset or overlap',()=>{
  const {store}=fixture();
  const keys=[store.observe(source('a')),store.observe(source('b'))];
  const first=store.reserve('memory-1',1,keys);
  const other=new MemorySaveStore(store.path);
  expect(other.reserve('memory-1',1,[...keys].reverse()).saveId).toBe(first.saveId);
  expect(()=>other.reserve('memory-1',1,[keys[0]!])).toThrow('COVERAGE_RESERVED');
  const extra=store.observe(source('c'));
  expect(()=>other.reserve('memory-1',1,[keys[0]!,extra])).toThrow('COVERAGE_RESERVED');
  expect(other.pending('memory-1',1).items.map(i=>i.sourceKey)).toEqual([extra]);
  expect(other.page().items).toHaveLength(1);
});

test('source identity, changed digest, owner, epoch and overlapping segmentation fail closed',()=>{
  const {store}=fixture();
  const key=store.observe(source());
  for(const patch of [{sourceDigest:saveDigest('changed')},{memoryId:'memory-2'},{policyEpoch:2},{startByte:150,endByte:250}]){
    expect(()=>store.observe(source('turn-1',patch))).toThrow('SOURCE_CONFLICT');
  }
  expect(()=>store.reserve('memory-2',1,[key])).toThrow('SOURCE_CONFLICT');
  expect(()=>store.reserve('memory-1',2,[key])).toThrow('SOURCE_CONFLICT');
  expect(store.page().items).toHaveLength(0);
});

test('ambiguous attempts cannot execute again after reopening, even for the same request',()=>{
  const {store}=fixture();
  const job=reserve(store);
  const attempt=store.beginAttempt(job.saveId,job.coverageDigest,intent);
  const reopened=new MemorySaveStore(store.path);
  expect(reopened.page().items[0]!.phase).toBe('summarizing');
  expect(()=>reopened.beginAttempt(job.saveId,job.coverageDigest,intent)).toThrow('RECOVERY_REQUIRED');
  reopened.requireRecovery(job.saveId,attempt);
  expect(()=>reopened.beginAttempt(job.saveId,job.coverageDigest,intent)).toThrow('RECOVERY_REQUIRED');
  expect(()=>reopened.requireRecovery(job.saveId,'wrong')).toThrow('REVISION_CONFLICT');
  expect(()=>reopened.commitLocal(job.saveId,'wrong',receipt,true)).toThrow('REVISION_CONFLICT');
  expect(()=>reopened.commitLocal(job.saveId,attempt,{...receipt,beforeHash:saveDigest('another baseline')},true)).toThrow('REVISION_CONFLICT');
  expect(()=>reopened.beginAttempt(job.saveId,job.coverageDigest,{...intent,inputDigest:saveDigest('new input')})).toThrow('RECOVERY_REQUIRED');
});

test('two processes competing for the same coverage receive only one spawn admission',async()=>{
  const {root,store}=fixture();
  const job=reserve(store);
  const script=join(root,'compete.ts');
  writeFileSync(script,`import {MemorySaveStore} from ${JSON.stringify(resolve(import.meta.dir,'../src/memorySaveStore.ts'))};
const store=new MemorySaveStore(${JSON.stringify(store.path)});
try { store.beginAttempt(${JSON.stringify(job.saveId)},${JSON.stringify(job.coverageDigest)},${JSON.stringify(intent)}); }
catch(error) { process.exit(error.code==='RECOVERY_REQUIRED'?3:4); }`);
  const children=[0,1].map(()=>Bun.spawn({cmd:[process.execPath,script],stdout:'ignore',stderr:'ignore'}));
  expect((await Promise.all(children.map(child=>child.exited))).sort()).toEqual([0,3]);
  expect(store.page().items).toHaveLength(1);
  expect(store.page().items[0]!.phase).toBe('summarizing');
});

test('an attempt is not admitted when durable input binding fails',()=>{
  const {store}=fixture();
  const job=reserve(store);
  const db=new Database(store.path);
  db.run("CREATE TRIGGER fail_attempt BEFORE UPDATE OF intent ON save_jobs BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  expect(()=>store.beginAttempt(job.saveId,job.coverageDigest,intent)).toThrow('STORAGE_UNAVAILABLE');
  expect(store.page().items[0]!.phase).toBe('prepared');
  expect(store.page().items[0]!.attemptId).toBeNull();
  db.close();
});

test('process death after the durable attempt fence retains one attempt and permits no replay',()=>{
  const {root,store}=fixture();
  const job=reserve(store);
  const script=join(root,'crash.ts');
  writeFileSync(script,`import {MemorySaveStore} from ${JSON.stringify(resolve(import.meta.dir,'../src/memorySaveStore.ts'))};
const store=new MemorySaveStore(${JSON.stringify(store.path)});
store.beginAttempt(${JSON.stringify(job.saveId)},${JSON.stringify(job.coverageDigest)},${JSON.stringify(intent)});
process.kill(process.pid,'SIGKILL');`);
  const child=Bun.spawnSync({cmd:[process.execPath,script],stdout:'pipe',stderr:'pipe'});
  expect(child.exitCode).not.toBe(0);
  const restarted=new MemorySaveStore(store.path);
  expect(restarted.page().items).toHaveLength(1);
  expect(restarted.page().items[0]!.phase).toBe('summarizing');
  expect(()=>restarted.beginAttempt(job.saveId,job.coverageDigest,intent)).toThrow('RECOVERY_REQUIRED');
});

test('local receipt and backup intent are atomic and late failures cannot downgrade saved coverage',()=>{
  const {store}=fixture();
  const job=reserve(store);
  const attempt=store.beginAttempt(job.saveId,job.coverageDigest,intent);
  const db=new Database(store.path);
  db.run("CREATE TRIGGER fail_backup BEFORE INSERT ON backup_outbox BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  expect(()=>store.commitLocal(job.saveId,attempt,receipt,true)).toThrow('STORAGE_UNAVAILABLE');
  expect(store.page().items[0]!.phase).toBe('summarizing');
  expect(db.query('SELECT * FROM backup_outbox').all()).toHaveLength(0);
  db.run('DROP TRIGGER fail_backup');
  store.requireRecovery(job.saveId,attempt);
  store.commitLocal(job.saveId,attempt,receipt,true);
  store.commitLocal(job.saveId,attempt,receipt,true);
  expect(db.query('SELECT state FROM backup_outbox').all()).toEqual([{state:'pending'}]);
  db.run("UPDATE backup_outbox SET state='backed-up'");
  store.commitLocal(job.saveId,attempt,receipt,true);
  expect(db.query('SELECT state FROM backup_outbox').all()).toEqual([{state:'backed-up'}]);
  db.close();
  expect(()=>store.requireRecovery(job.saveId,attempt)).toThrow('REVISION_CONFLICT');
  expect(()=>store.commitLocal(job.saveId,attempt,{...receipt,afterHash:saveDigest('different')},true)).toThrow('REVISION_CONFLICT');
  expect(store.page().items[0]!.phase).toBe('local-saved');
  expect(reserve(store).saveId).toBe(job.saveId);
  expect(()=>store.beginAttempt(job.saveId,job.coverageDigest,intent)).toThrow('RECOVERY_REQUIRED');
});

test('partial-turn save does not consume adjacent fragments or newly completed turns',()=>{
  const {store}=fixture();
  const first=reserve(store);
  const next=store.observe(source('turn-1',{startByte:200,endByte:300}));
  const newer=store.observe(source('turn-2'));
  const attempt=store.beginAttempt(first.saveId,first.coverageDigest,intent);
  store.commitLocal(first.saveId,attempt,receipt,false);
  expect(store.pending('memory-1',1).items.map(i=>i.sourceKey)).toEqual([next,newer]);
  const second=store.reserve('memory-1',1,[next,newer]);
  expect(second.saveId).not.toBe(first.saveId);
});

test('keyset pages stay bounded and do not skip interleaved observations',()=>{
  const {store}=fixture();
  for(let i=0;i<140;i++)store.observe(source(`turn-${i}`));
  const first=store.pending('memory-1',1);
  expect(first.items).toHaveLength(128);
  expect(first.nextCursor).not.toBeNull();
  store.observe(source('new-turn'));
  const second=store.pending('memory-1',1,first.nextCursor!);
  expect(second.items).toHaveLength(13);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.items,...second.items].map(i=>i.sourceKey)).size).toBe(141);
  expect(()=>store.reserve('memory-1',1,[...first.items,...second.items].map(i=>i.sourceKey))).toThrow('INVALID_INPUT');
  for(const limit of [0,129,NaN,Infinity])expect(()=>store.page(0,limit)).toThrow('INVALID_INPUT');
});

test('large persisted observation history uses bounded keyset reads and retains fences',()=>{
  const {store}=fixture();
  const saved=reserve(store);
  const attempt=store.beginAttempt(saved.saveId,saved.coverageDigest,intent);
  store.commitLocal(saved.saveId,attempt,receipt,false);
  const db=new Database(store.path);
  const insert=db.query(`INSERT INTO save_sources(sourceKey,agent,instanceId,sessionId,turnId,startByte,endByte,memoryId,policyEpoch,payload)
    VALUES (?,'codex','fixture','fixture',?,0,1,'large-history',1,'{}')`);
  db.transaction(()=>{for(let i=0;i<20_000;i++)insert.run(saveDigest(['large',i]),`large-${i}`);})();
  db.close();
  const lastPage=store.pending('large-history',1,19_900);
  expect(lastPage.items).toHaveLength(101);
  expect(lastPage.nextCursor).toBeNull();
  expect(JSON.stringify(lastPage).length).toBeLessThan(16_384);
  expect(reserve(new MemorySaveStore(store.path)).saveId).toBe(saved.saveId);
  expect(()=>store.beginAttempt(saved.saveId,saved.coverageDigest,intent)).toThrow('RECOVERY_REQUIRED');
});

test('job pages use stable cursors across other roots and later inserts',()=>{
  const {store}=fixture();
  for(let i=0;i<130;i++) {
    const memoryId=`memory-${i}`;
    store.reserve(memoryId,1,[store.observe(source(`turn-${i}`,{memoryId}))]);
  }
  const first=store.page();
  expect(first.items).toHaveLength(128);
  const last=store.page(first.nextCursor!);
  expect(last.items).toHaveLength(2);
  expect(last.nextCursor).toBeNull();
  expect(new Set([...first.items,...last.items].map(job=>job.saveId)).size).toBe(130);
});

test('malformed or oversized metadata is rejected before database admission',()=>{
  const {store}=fixture();
  for(const patch of [{startByte:-1},{endByte:100},{endByte:Number.MAX_SAFE_INTEGER+1},
    {completedAt:NaN},{sourceDigest:'invalid'},{sessionId:'x'.repeat(129)},{instanceId:'/private/path'}]) {
    expect(()=>store.observe(source('turn-1',patch))).toThrow('INVALID_INPUT');
  }
  expect(store.pending('memory-1',1).items).toHaveLength(0);
});

test('failed reservation leaves every source unclaimed',()=>{
  const {store}=fixture();
  const keys=[store.observe(source('a')),store.observe(source('b'))];
  const db=new Database(store.path);
  db.run(`CREATE TRIGGER fail_claim BEFORE UPDATE OF saveId ON save_sources
    WHEN NEW.sourceKey='${[...keys].sort()[1]}' BEGIN SELECT RAISE(ABORT,'injected failure'); END`);
  expect(()=>store.reserve('memory-1',1,keys)).toThrow('STORAGE_UNAVAILABLE');
  expect(store.page().items).toHaveLength(0);
  expect(store.pending('memory-1',1).items).toHaveLength(2);
  expect(db.query('SELECT * FROM save_job_sources').all()).toHaveLength(0);
  db.close();
});

test('future schema and database symlinks are rejected without overwriting data',()=>{
  const {root,store}=fixture();
  store.observe(source());
  const db=new Database(store.path);db.run('PRAGMA user_version=99');db.close();
  const before=readFileSync(store.path);
  expect(()=>store.page()).toThrow('UNSUPPORTED_VERSION');
  expect(readFileSync(store.path).equals(before)).toBe(true);
  const linked=join(root,'linked.sqlite');symlinkSync(store.path,linked);
  expect(()=>new MemorySaveStore(linked).page()).toThrow('STORAGE_UNAVAILABLE');
  expect(readFileSync(store.path).equals(before)).toBe(true);
});

test('version-one fragments and active attempt fences survive the complete-turn schema migration',()=>{
  const {store}=fixture();const job=reserve(store);
  store.beginAttempt(job.saveId,job.coverageDigest,intent);
  const db=new Database(store.path);
  for(const table of ['save_provider_recovery_reviews','save_provider_recovery_probes','save_provider_recovery_results','save_provider_recovery_clock'])db.run(`DROP TABLE ${table}`);
  db.run('DROP INDEX sources_complete_turn');
  db.run('ALTER TABLE save_sources DROP COLUMN coverageKind');
  const rows=db.query('SELECT sourceKey,payload FROM save_sources').all() as {sourceKey:string;payload:string}[];
  for(const row of rows){const value=JSON.parse(row.payload);delete value.coverageKind;db.query('UPDATE save_sources SET payload=? WHERE sourceKey=?').run(JSON.stringify(value),row.sourceKey);}
  db.run('DROP TABLE save_host_sessions');db.run('DROP TABLE save_auto_attempts');db.run('DROP TABLE save_auto_policy');db.run('DROP INDEX jobs_active_attempt');
  db.run('DROP TABLE save_provider_binding');db.run('DROP TABLE save_input_bindings');
  db.run('DROP TABLE save_failure_diagnostics');
  db.run('DROP TABLE save_recovery_approvals');db.run('DROP TABLE save_recovery_decisions');
  db.run('DROP INDEX jobs_open_root');db.run("CREATE UNIQUE INDEX jobs_open_root ON save_jobs(memoryId) WHERE phase<>'local-saved'");
  db.run('DROP INDEX backup_outbox_ready');db.run('ALTER TABLE backup_outbox DROP COLUMN attempts');db.run('ALTER TABLE backup_outbox DROP COLUMN retryAt');db.run('DROP INDEX jobs_memory_sequence');db.run('DROP INDEX backup_memory_state');
  db.run('PRAGMA user_version=1');db.close();
  const upgraded=new MemorySaveStore(store.path);
  expect(reserve(upgraded).saveId).toBe(job.saveId);
  expect(upgraded.page().items[0]!.phase).toBe('summarizing');
  expect(()=>upgraded.beginAttempt(job.saveId,job.coverageDigest,intent)).toThrow('RECOVERY_REQUIRED');
});

test('complete-turn identity cannot be shifted, split or replace prior fragments',()=>{
  for(const kind of ['fragment','complete-turn'] as const){
    const {store}=fixture();store.observe(source('turn-1',{coverageKind:kind}));
    expect(()=>store.observe(source('turn-1',{coverageKind:'complete-turn',startByte:1000,endByte:2000}))).toThrow('SOURCE_CONFLICT');
    if(kind==='complete-turn')expect(()=>store.observe(source('turn-1',{startByte:1000,endByte:2000}))).toThrow('SOURCE_CONFLICT');
    expect(store.pending('memory-1',1).items).toHaveLength(1);
  }
});

test('bounded observation batches commit atomically and reject an oversized admission',()=>{
  const {store}=fixture();
  expect(()=>store.observeBatch([source(),source('turn-1',{sourceDigest:saveDigest('conflict')})])).toThrow('SOURCE_CONFLICT');
  expect(store.pending('memory-1',1).items).toHaveLength(0);
  expect(store.observeBatch([source('one'),source('two')])).toHaveLength(2);
  expect(store.pending('memory-1',1).items).toHaveLength(2);
  expect(()=>store.observeBatch(Array.from({length:129},(_,i)=>source(`excess-${i}`)))).toThrow('INVALID_INPUT');
});
