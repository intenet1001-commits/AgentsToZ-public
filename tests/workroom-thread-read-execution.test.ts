import {afterEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {chmodSync,existsSync,mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorkroomThreadStore,type StoredWorkroomThread} from '../src/workroomThreadStore';
import {WorkroomThreadReadExecutionRepository,type ReadToolBatchAdmission,type ReadToolBatch} from '../src/workroomThreadReadExecution';

const clean:string[]=[];afterEach(()=>{for(const root of clean.splice(0))rmSync(root,{recursive:true,force:true});});
const active=()=>true;
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'read-executions-'));clean.push(root);chmodSync(root,0o700);
 let reads=0,creates=0;
 const keys={read:async()=>{reads++;return Buffer.alloc(32,19);},create:async()=>{creates++;return Buffer.alloc(32,19);}};
 const store=new WorkroomThreadStore(root,keys),repo=new WorkroomThreadReadExecutionRepository(store,{bootId:'boot-one',now:()=>1000});
 const record:StoredWorkroomThread={id:'thread-one',targetId:'target-one',owner:'owner-one',fingerprint:'checkout-proof',bootId:'original-cli-boot',intentHash:'original-intent',title:'Original task',agent:'codex',sessionId:'session-one',state:'running',revision:3,createdAt:'2026-10-24T00:00:00Z',updatedAt:'2026-10-24T00:00:00Z',messages:[]};
 const input:ReadToolBatchAdmission={threadId:record.id,requestId:'request-one',owner:record.owner,binding:{role:'dev',targetId:record.targetId,projectId:'project-one',owner:record.owner,proof:'bound-checkout'},plan:{steps:[{id:'git',input:{operation:'project.git.read'}},{id:'tester',input:{operation:'tester.status.read'}}]}};
 return {root,keys,store,repo,record,input,counts:()=>({reads,creates}),seed:()=>store.mutate(record.id,active,()=>({record:structuredClone(record),value:null})),version:()=>{const db=new Database(store.file);try{return (db.query('SELECT version FROM thread_meta').get() as {version:number}).version;}finally{db.close();}}};
}
function change(batch:ReadToolBatch,index:number,state:'running'|'completed',extra:Record<string,unknown>={}):ReadToolBatch {
 const next=structuredClone(batch);Object.assign(next.stages[index]!,{state,...extra});return next;
}

test('T14 existing exact thread admission is append-only and duplicates never create work',async()=>{
 const f=fixture();await f.seed();const before=await f.store.get(f.record.id);
 const admitted=await f.repo.admit(f.input,active);expect(admitted.created).toBe(true);expect(f.version()).toBe(4);
 expect(await f.repo.admit(f.input,active)).toEqual({batch:admitted.batch,created:false});
 const after=await f.store.get(f.record.id),{readExecutions,...original}=after!;
 expect(original).toEqual(before!);expect(readExecutions).toHaveLength(1);expect(f.counts().creates).toBe(0);
 expect(await f.repo.read(f.record.id,f.input.requestId,f.record.owner,active)).toEqual(admitted.batch);
 await expect(f.repo.admit({...f.input,plan:{steps:[{id:'changed',input:{operation:'project.git.read'}}]}},active)).rejects.toThrow('READ_EXECUTION_CONFLICT');
 expect((await f.store.get(f.record.id))!.readExecutions).toHaveLength(1);
});

test('owner, exact target, DEV role, missing thread and revoked access fail closed before migration',async()=>{
 const f=fixture();await f.seed();
 for(const input of [
  {...f.input,owner:'foreign'}, {...f.input,threadId:'missing-thread'},
  {...f.input,binding:{...f.input.binding,targetId:'foreign'}},
  {...f.input,binding:{...f.input.binding,owner:'foreign'}},
  {...f.input,binding:{...f.input.binding,role:'use'}},
 ])await expect(f.repo.admit(input as ReadToolBatchAdmission,active)).rejects.toThrow();
 await expect(f.repo.admit(f.input,()=>false)).rejects.toThrow();expect(f.version()).toBe(1);
 expect(readdirSync(f.root).filter(n=>n.includes('pre-v4'))).toEqual([]);
 await f.repo.admit(f.input,active);
 await expect(f.repo.read(f.record.id,f.input.requestId,'foreign',active)).rejects.toThrow();
 await expect(f.repo.read(f.record.id,f.input.requestId,f.record.owner,()=>false)).rejects.toThrow();
});

test('CAS merges disjoint stages with concurrent CLI writes and preserves completed evidence',async()=>{
 const f=fixture();await f.seed();const {batch}=await f.repo.admit(f.input,active);
 await f.store.mutate(f.record.id,active,r=>{r!.messages.push({id:'cli-msg',seq:1,role:'assistant',kind:'progress',text:'CLI progress',at:'now',delivery:'recorded'});r!.revision++;return {record:r!,value:null};});
 const first=await f.repo.compareAndSet(batch.threadId,batch.requestId,batch.owner,batch.revision,change(batch,0,'completed',{outputDigest:'a'.repeat(64),observedAt:900,freshness:'current'}),active);
 const merged=await f.repo.compareAndSet(batch.threadId,batch.requestId,batch.owner,batch.revision,change(batch,1,'completed'),active);
 expect(first.stages[0]!.outputDigest).toBe('a'.repeat(64));expect(merged.stages.map(s=>s.state)).toEqual(['completed','completed']);
 expect(merged.state).toBe('completed');expect(merged.revision).toBe(3);
 const stale=await f.repo.compareAndSet(batch.threadId,batch.requestId,batch.owner,batch.revision,change(batch,0,'completed',{outputDigest:'b'.repeat(64)}),active);
 expect(stale.stages[0]!.outputDigest).toBe('a'.repeat(64));
 const record=(await f.store.get(f.record.id))!;expect(record.messages[0]!.text).toBe('CLI progress');expect(record.state).toBe('running');expect(record.revision).toBe(4);
});

test('restart receipt becomes unknown without recollection and cancel preserves completed stages',async()=>{
 const f=fixture();await f.seed();const {batch}=await f.repo.admit(f.input,active);
 const running=await f.repo.compareAndSet(batch.threadId,batch.requestId,batch.owner,1,change(batch,0,'running'),active);
 const restarted=new WorkroomThreadReadExecutionRepository(f.store,{bootId:'boot-two',now:()=>2000});
 const recovered=(await restarted.read(batch.threadId,batch.requestId,batch.owner,active))!;
 expect(recovered.state).toBe('unknown');expect(recovered.stages.map(s=>s.state)).toEqual(['unknown','unknown']);expect(recovered.payload).toBe('unavailable');
 expect(await restarted.read(batch.threadId,batch.requestId,batch.owner,active)).toEqual(recovered);
 expect((await restarted.admit(f.input,active)).created).toBe(false);
 const fresh=await restarted.admit({...f.input,requestId:'new-request'},active);expect(fresh.created).toBe(true);expect((await restarted.read(batch.threadId,batch.requestId,batch.owner,active))!.state).toBe('unknown');
 const g=fixture();await g.seed();const b=(await g.repo.admit(g.input,active)).batch;
 const done=await g.repo.compareAndSet(b.threadId,b.requestId,b.owner,1,change(b,0,'completed'),active);
 const cancelled=await g.repo.cancel(b.threadId,b.requestId,b.owner,active);
 expect(cancelled.stages.map(s=>s.state)).toEqual(['completed','cancelled']);expect(cancelled.cancelRequestedAt).toBe(1000);
 expect((await g.store.get(g.record.id))!.state).toBe('running');
 expect(running.revision).toBe(2);expect(done.revision).toBe(2);
});

test('T20 closed encrypted pre-v4 backup precedes first metadata write and USE never downgrades v4',async()=>{
 const f=fixture();await f.seed();await f.repo.admit(f.input,active);
 const backups=readdirSync(f.root).filter(n=>n.includes('pre-v4'));expect(backups).toHaveLength(1);
 const backup=join(f.root,backups[0]!);expect(readFileSync(backup).includes(Buffer.alloc(32,19))).toBe(false);
 expect(readFileSync(backup).includes(Buffer.from('Original task'))).toBe(false);
 const db=new Database(backup,{readonly:true});try{
  expect((db.query('SELECT version FROM thread_meta').get() as any).version).toBe(1);
  expect((db.query('SELECT COUNT(*) n FROM threads').get() as any).n).toBe(1);
 }finally{db.close();}
 await f.store.mutate('use-thread',active,()=>({record:{...f.record,id:'use-thread',serviceExecution:{binding:{} as any,call:{} as any}},value:null}));expect(f.version()).toBe(4);
 await f.store.mutate(f.record.id,active,r=>({record:r!,value:null}));expect(f.version()).toBe(4);
 expect(readdirSync(f.root).filter(n=>n.includes('pre-v4'))).toHaveLength(1);
});

test('future storage version fails closed without modifying original bytes or reading keys',async()=>{
 const f=fixture();await f.seed();const db=new Database(f.store.file);db.exec('UPDATE thread_meta SET version=5');db.close();
 const original=readFileSync(f.store.file),counts=f.counts();
 await expect(f.store.get(f.record.id)).rejects.toThrow();
 await expect(f.repo.admit(f.input,active)).rejects.toThrow();
 expect(readFileSync(f.store.file)).toEqual(original);expect(f.counts()).toEqual(counts);
});

test('metadata rejects raw payloads and immutable identity changes without overwriting original receipt',async()=>{
 const f=fixture();await f.seed();const {batch}=await f.repo.admit(f.input,active);
 for(const patch of [
  {targetId:'other'}, {bindingHash:'b'.repeat(64)}, {intentHash:'b'.repeat(64)},
  {rawPayload:'secret source text'}, {payload:'available'},
  {stages:[{...batch.stages[0]!,output:'raw diff'},batch.stages[1]!]},
  {stages:[{...batch.stages[0]!,sourceRevision:'/absolute/path'},batch.stages[1]!]},
  {stages:[{...batch.stages[0]!,errorCode:'token=secret'},batch.stages[1]!]},
  {revision:100},
 ])await expect(f.repo.compareAndSet(batch.threadId,batch.requestId,batch.owner,1,{...batch,...patch} as ReadToolBatch,active)).rejects.toThrow();
 expect(await f.repo.read(batch.threadId,batch.requestId,batch.owner,active)).toEqual(batch);
 await expect(f.store.mutate(f.record.id,active,r=>{delete r!.readExecutions;return {record:r!,value:null};})).rejects.toThrow();
 await expect(f.store.mutateReadExecutions(f.record.id,active,()=>({readExecutions:[],value:null}))).rejects.toThrow();
});

test('concurrent duplicate admission commits one receipt and rejects changed binding intent',async()=>{
 const f=fixture();await f.seed();const results=await Promise.all(Array.from({length:5},()=>f.repo.admit(f.input,active)));
 expect(results.filter(r=>r.created)).toHaveLength(1);expect(new Set(results.map(r=>r.batch.runId)).size).toBe(1);
 await expect(f.repo.admit({...f.input,binding:{...f.input.binding,proof:'changed-grant'}},active)).rejects.toThrow('READ_EXECUTION_CONFLICT');
 await expect(f.repo.admit({...f.input,requestId:'another-request'},active)).rejects.toThrow('READ_EXECUTION_BUSY');
});

test('completed receipts remain append-only when a new explicitly requested observation is admitted',async()=>{
 const f=fixture();await f.seed();const original=(await f.repo.admit(f.input,active)).batch;
 let next=change(original,0,'completed');next=change(next,1,'completed');
 const complete=await f.repo.compareAndSet(original.threadId,original.requestId,original.owner,1,next,active);
 const second=await f.repo.admit({...f.input,requestId:'second-request'},active);
 expect(second.created).toBe(true);expect(second.batch.runId).not.toBe(original.runId);
 expect(await f.repo.admit(f.input,active)).toEqual({created:false,batch:complete});
 expect((await f.store.get(f.record.id))!.readExecutions!.map(b=>b.runId)).toEqual([original.runId,second.batch.runId]);
});

test('record budget rejection preserves the original thread and pre-v4 version',async()=>{
 const f=fixture();await f.seed();
 // The original record fits; adding even metadata exceeds the existing 512 KiB row cap.
 await f.store.mutate(f.record.id,active,r=>{const base=Buffer.byteLength(JSON.stringify(r));r!.messages=[{id:'large',seq:1,role:'assistant',kind:'result',text:'',at:'now',delivery:'recorded'}];const overhead=Buffer.byteLength(JSON.stringify(r))-base;r!.messages[0]!.text='x'.repeat(512*1024-base-overhead-10);return {record:r!,value:null};});
 const before=await f.store.get(f.record.id);
 await expect(f.repo.admit(f.input,active)).rejects.toThrow('한도');
 expect(await f.store.get(f.record.id)).toEqual(before);expect(f.version()).toBe(1);expect(readdirSync(f.root).filter(n=>n.includes('pre-v4'))).toEqual([]);
});

test('host total-byte budget includes nested receipts and retains existing rows on refusal',async()=>{
 const f=fixture();await f.seed();
 // Aggregate accounting is public SQLite metadata; no unrelated encrypted JSON row is scanned.
 const db=new Database(f.store.file);db.query('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)').run('budget-row','foreign','foreign','closed','now','',100*1024*1024-100,Buffer.alloc(12),Buffer.alloc(0),Buffer.alloc(16));db.close();
 await expect(f.repo.admit(f.input,active)).rejects.toThrow('한도');
 expect(f.version()).toBe(1);expect((await f.store.get(f.record.id))!.readExecutions).toBeUndefined();
 const inspect=new Database(f.store.file);try{expect((inspect.query('SELECT COUNT(*) n FROM threads').get() as any).n).toBe(2);}finally{inspect.close();}
});

test('plain DEV preview/read never migrates; versions 1, 2 and 3 reopen and USE first write remains v3',async()=>{
 for(const version of [1,2,3]){
  const f=fixture();await f.seed();const db=new Database(f.store.file);db.query('UPDATE thread_meta SET version=?').run(version);db.close();
  expect(await f.repo.read(f.record.id,'absent-request',f.record.owner,active)).toBeNull();expect(f.version()).toBe(version);
  expect(readdirSync(f.root).filter(n=>n.includes('pre-v4'))).toEqual([]);
  await f.repo.admit(f.input,active);expect(f.version()).toBe(4);
 }
 const f=fixture();await f.seed();await f.store.mutate('use-thread',active,()=>({record:{...f.record,id:'use-thread',serviceExecution:{binding:{} as any,call:{} as any}},value:null}));
 expect(f.version()).toBe(3);await expect(f.repo.admit({...f.input,threadId:'use-thread'},active)).rejects.toThrow();expect(f.version()).toBe(3);
});

test('old version guard refuses v4 before decrypting or changing records',async()=>{
 const f=fixture();await f.seed();await f.repo.admit(f.input,active);const bytes=readFileSync(f.store.file);
 // This is the actual pre-v4 guard predicate, exercised against the new on-disk database.
 const db=new Database(f.store.file,{readonly:true});try{
  const rows=db.query('SELECT * FROM thread_meta LIMIT 2').all() as {version:number}[];
  expect(()=>{if(rows.length>1||rows[0]&&![1,2,3].includes(rows[0].version))throw Error('old-host-version-refused');}).toThrow('old-host-version-refused');
 }finally{db.close();}
 expect(readFileSync(f.store.file)).toEqual(bytes);expect((await f.store.get(f.record.id))!.readExecutions).toHaveLength(1);
});

test('cancelling running work records unknown and late completion cannot overwrite uncertainty',async()=>{
 const f=fixture();await f.seed();const {batch}=await f.repo.admit(f.input,active);
 const running=await f.repo.compareAndSet(batch.threadId,batch.requestId,batch.owner,1,change(batch,0,'running'),active);
 const cancelled=await f.repo.cancel(batch.threadId,batch.requestId,batch.owner,active);
 expect(cancelled.state).toBe('unknown');expect(cancelled.stages.map(s=>s.state)).toEqual(['unknown','cancelled']);
 const late=await f.repo.compareAndSet(batch.threadId,batch.requestId,batch.owner,running.revision,change(running,0,'completed'),active);
 expect(late).toEqual(cancelled);expect(await f.repo.cancel(batch.threadId,batch.requestId,batch.owner,active)).toEqual(cancelled);
});

test('metadata byte limit and exact stage structure reject before any receipt mutation',async()=>{
 const f=fixture();await f.seed();const {batch}=await f.repo.admit(f.input,active);
 await expect(f.repo.compareAndSet(batch.threadId,batch.requestId,batch.owner,1,{...batch,extra:'x'.repeat(16*1024)} as ReadToolBatch,active)).rejects.toMatchObject({code:'READ_TOOL_LIMIT'});
 await expect(f.repo.compareAndSet(batch.threadId,batch.requestId,batch.owner,1,{...batch,stages:[...batch.stages,...batch.stages]} as ReadToolBatch,active)).rejects.toThrow();
 expect(await f.repo.read(batch.threadId,batch.requestId,batch.owner,active)).toEqual(batch);
});

test('v4 backup and reopen stay under the owned writer lock with no key export',async()=>{
 const f=fixture();await f.seed();let inspected=false;
 const originalRead=f.keys.read;
 f.keys.read=async()=>{
  if(readdirSync(f.root).some(n=>n.includes('pre-v4'))){
   inspected=true;expect(readdirSync(f.root)).toContain('workroom-threads.v1.lock');
   const backup=join(f.root,readdirSync(f.root).find(n=>n.includes('pre-v4'))!);
   // A closed/checkpointed standalone SQLite backup can be opened without journal sidecars.
   const db=new Database(backup,{readonly:true});try{expect((db.query('PRAGMA integrity_check').get() as any).integrity_check).toBe('ok');}finally{db.close();}
   expect(readdirSync(f.root).filter(n=>/key|dpapi|wal|journal/.test(n))).toEqual([]);
  }
  return originalRead();
 };
 await f.repo.admit(f.input,active);expect(inspected).toBe(true);
});

test('revocation during v4 reopen prevents migration and retains old encrypted records',async()=>{
 const f=fixture();await f.seed();let granted=true;const originalRead=f.keys.read;
 f.keys.read=async()=>{if(readdirSync(f.root).some(n=>n.includes('pre-v4')))granted=false;return originalRead();};
 const before=await f.store.get(f.record.id);
 await expect(f.repo.admit(f.input,()=>granted)).rejects.toThrow();
 expect(f.version()).toBe(1);expect(await f.store.get(f.record.id)).toEqual(before);
});

test('concurrent store writers preserve new CLI state during first v4 metadata admission',async()=>{
 const f=fixture();await f.seed();
 const [admission]=await Promise.all([
  f.repo.admit(f.input,active),
  f.store.mutate(f.record.id,active,r=>{r!.state='needs-answer';r!.revision=4;r!.title='CLI changed title';return {record:r!,value:null};}),
 ]);
 const current=(await f.store.get(f.record.id))!;
 expect(current.readExecutions![0]).toEqual(admission.batch);expect(current.title).toBe('CLI changed title');expect(current.state).toBe('needs-answer');expect(current.revision).toBe(4);
});

test('1000-row budget rejects metadata admission without scanning unrelated encrypted records',async()=>{
 const f=fixture();await f.seed();const db=new Database(f.store.file);
 db.exec("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000) INSERT INTO threads SELECT 'budget-'||x,'foreign','foreign','closed','now','',0,zeroblob(12),zeroblob(0),zeroblob(16) FROM n");db.close();
 await expect(f.repo.admit(f.input,active)).rejects.toThrow('한도');
 expect(f.version()).toBe(1);expect((await f.store.get(f.record.id))!.readExecutions).toBeUndefined();
 expect(readdirSync(f.root).filter(n=>n.includes('pre-v4'))).toEqual([]);
});

test('missing thread and malformed DAG cannot initialize a store or key',async()=>{
 const f=fixture();await expect(f.repo.admit(f.input,active)).rejects.toThrow();
 await expect(f.repo.admit({...f.input,plan:{steps:[{id:'bad',dependsOn:['bad'],input:{operation:'tester.status.read'}}]}},active)).rejects.toThrow();
 expect(existsSync(f.store.file)).toBe(false);expect(f.counts()).toEqual({reads:0,creates:0});
});

test('missing original key blocks nested reads and writes while retaining original ciphertext',async()=>{
 const f=fixture();await f.seed();const {batch}=await f.repo.admit(f.input,active);const original=readFileSync(f.store.file);
 f.keys.read=async()=>null as any;
 await expect(f.repo.read(batch.threadId,batch.requestId,batch.owner,active)).rejects.toThrow('키');
 await expect(f.repo.admit(f.input,active)).rejects.toThrow('키');
 expect(readFileSync(f.store.file)).toEqual(original);expect(f.counts().creates).toBe(0);
});
