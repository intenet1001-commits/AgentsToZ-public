import {test,expect} from 'bun:test';import {mkdtempSync,realpathSync,rmSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {MemorySaveStore,MEMORY_INPUT_EXPIRY_PAGE_SQL,MEMORY_INPUT_EXPIRY_TIE_SQL} from '../src/memorySaveStore';import {MemorySaveInputStore,MEMORY_INPUT_TTL} from '../src/memorySaveInputStore';
import {MemorySaveMaintenance} from '../src/memorySaveMaintenance';import {acquireWorkspaceDirectoryLease} from '../src/workspaceLease';
import {saveDigest} from '../src/memorySaveContract';
test('expired input is authenticated once and backup retries preserve the exact guard without another AI attempt',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'memory-maintenance-')));let now=Date.now()-8*86400_000,reads=0,backups=0;
 const store=new MemorySaveStore(join(root,'memory-save-v2.sqlite'),()=>now),key=Buffer.alloc(32,9),content=Buffer.from('selected fixture prompt');
 const sourceKey=store.observe({agent:'codex',instanceId:'fixture',sessionId:'session',turnId:'turn',startByte:0,endByte:20,sourceDigest:'a'.repeat(64),memoryId:'memory',policyEpoch:1,completedAt:now,coverageKind:'complete-turn'});
 const job=store.reserve('memory',1,[sourceKey]);
 const binding={saveId:job.saveId,memoryId:'memory',policyEpoch:1,coverageDigest:job.coverageDigest,inputDigest:createHash('sha256').update(content).digest('hex'),beforeHash:'b'.repeat(64),providerBindingDigest:'c'.repeat(64)};
 const acquire=()=>acquireWorkspaceDirectoryLease({workspacePath:root,appDataDir:root,attempts:1});
 try{
  store.bindInput(job.saveId,binding);const lease=await acquire();try{await new MemorySaveInputStore(root,lease,()=>now).stage(binding,content,key);}finally{lease.release();}
  const attempt=store.beginAttempt(job.saveId,job.coverageDigest,binding);
  const guard={memoryId:'memory',contentHash:'d'.repeat(64),destinationHash:'e'.repeat(64),parentRevisionId:'original-parent'};
  store.bindHostSession(job.saveId,attempt,{sessionPlanId:'plan',planDigest:'f'.repeat(64),rootDigest:'a'.repeat(64),beforeHash:binding.beforeHash,afterHash:guard.contentHash,backupRequested:true,backup:guard});
  store.commitLocal(job.saveId,attempt,{manifestDigest:'f'.repeat(64),beforeHash:binding.beforeHash,afterHash:guard.contentHash,localRevisionId:'plan'},true);
  now=Date.now();
  const maintenance=new MemorySaveMaintenance({enabled:()=>true,store,appDataRoot:root,acquireApp:acquire,release:l=>{l.release();},readKey:async()=>{reads++;return Buffer.from(key);},backup:async(id,saved)=>{backups++;expect(id).toBe('memory');expect(saved).toEqual(guard);return backups===1?'retry':'complete';}});
  await maintenance.tick();expect(reads).toBe(1);expect(backups).toBe(1);
  expect(readdirSync(join(root,'memory-save-inputs')).filter(n=>n.endsWith('.enc'))).toHaveLength(0);
  expect(store.expiryPage().items).toHaveLength(0);expect(store.backupSummary('memory').pending).toBe(1);
  await maintenance.tick();expect(reads).toBe(1);expect(backups).toBe(1);
  now+=30_000;await maintenance.tick();expect(backups).toBe(2);expect(store.backupSummary('memory').pending).toBe(0);
  expect(store.get(job.saveId).phase).toBe('local-saved');expect(()=>store.beginAttempt(job.saveId,job.coverageDigest,binding)).toThrow('RECOVERY_REQUIRED');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('expiry jumps past 4992 recent inputs and completed backups do not hide pending work',async()=>{
 const {Database}=await import('bun:sqlite');
 const root=realpathSync(mkdtempSync(join(tmpdir(),'memory-maintenance-page-'))),now=Date.now();
 const store=new MemorySaveStore(join(root,'memory-save-v2.sqlite'),()=>now);
 try{
  store.automaticPolicy();const db=new Database(store.path);
  try{
   db.transaction(()=>{
    const insert=db.query('INSERT INTO save_input_bindings(saveId,payload,createdAt) VALUES (?,?,?)');
    for(let i=0;i<5000;i++)insert.run('fixture-input-'+i,'{}',i<4992?now:now-8*86400_000);
    const outbox=db.query("INSERT INTO backup_outbox(saveId,memoryId,localRevisionId,destination,state) VALUES (?,'memory',?,'supabase',?)");
    for(let i=0;i<1000;i++)outbox.run('fixture-backup-'+i,'revision-'+i,i===999?'pending':'complete');
   })();
   const first=store.expiryPage();expect(first.items).toHaveLength(8);expect(first.nextCursor).toBeNull();
   const plan=JSON.stringify(db.query('EXPLAIN QUERY PLAN '+MEMORY_INPUT_EXPIRY_PAGE_SQL).all(-1,now-MEMORY_INPUT_TTL,9));
   expect(plan).toContain('inputs_expiry');expect(plan).not.toContain('TEMP B-TREE');
   const ties=JSON.stringify(db.query('EXPLAIN QUERY PLAN '+MEMORY_INPUT_EXPIRY_TIE_SQL).all(now-MEMORY_INPUT_TTL,4992));
   expect(ties).toContain('inputs_expiry');expect(ties).toMatch(/sequence>\?|rowid>\?/);expect(ties).not.toContain('TEMP B-TREE');
   const backupPlan=JSON.stringify(db.query("EXPLAIN QUERY PLAN SELECT saveId,memoryId,localRevisionId,attempts FROM backup_outbox WHERE state='pending' AND retryAt<=? ORDER BY retryAt,saveId LIMIT 1").all(now));
   expect(backupPlan).toContain('backup_outbox_ready');expect(backupPlan).not.toContain('TEMP B-TREE');
   expect(store.backupSummary('memory')).toEqual({pending:1,blocked:0,hasMore:false});
  }finally{db.close();}
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('deadline pagination preserves tied, failed and newly due rows across cycles and clock rollback',async()=>{
 const {Database}=await import('bun:sqlite');
 const root=realpathSync(mkdtempSync(join(tmpdir(),'memory-expiry-cursor-')));let now=10*MEMORY_INPUT_TTL;
 const store=new MemorySaveStore(join(root,'memory-save-v2.sqlite'),()=>now);
 try{
  store.automaticPolicy();const db=new Database(store.path);
  try{
   const insert=db.query('INSERT INTO save_input_bindings(saveId,payload,createdAt) VALUES (?,?,?)');
   db.transaction(()=>{for(let i=0;i<20;i++)insert.run('tied-'+i,'{}',now-MEMORY_INPUT_TTL);})();
   const first=store.expiryPage();expect(first.items).toHaveLength(8);expect(first.nextCursor).not.toBeNull();
   // Leave the first page unresolved: it must not hide the remaining rows.
   const second=store.expiryPage(first.nextCursor);expect(second.items).toHaveLength(8);
   const last=store.expiryPage(second.nextCursor);expect(last.items).toHaveLength(4);expect(last.nextCursor).toBeNull();
   expect(new Set([...first.items,...second.items,...last.items].map(r=>r.saveId)).size).toBe(20);
   insert.run('late-observation','{}',now-MEMORY_INPUT_TTL-1000);
   expect(store.expiryPage().items[0]!.saveId).toBe('late-observation');
   now-=MEMORY_INPUT_TTL;expect(store.expiryPage(first.nextCursor).items).toHaveLength(0);
   now+=MEMORY_INPUT_TTL;expect(store.expiryPage().items).toHaveLength(8);
   expect(()=>store.expiryPage({createdAt:NaN,sequence:1})).toThrow('INVALID_INPUT');
   now=NaN;expect(()=>store.expiryPage()).toThrow('INVALID_INPUT');
  }finally{db.close();}
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('v5 maintenance indexes migrate without changing pending input, backup or attempt evidence',async()=>{
 const {Database}=await import('bun:sqlite');
 const {readMemoryObservationSummary}=await import('../src/memoryObservationStatus');
 const root=realpathSync(mkdtempSync(join(tmpdir(),'memory-maintenance-migration-'))),now=Date.now();
 const store=new MemorySaveStore(join(root,'memory-save-v2.sqlite'),()=>now);
 try{
  const source=store.observe({agent:'codex',instanceId:'fixture',sessionId:'session',turnId:'turn',startByte:0,endByte:20,sourceDigest:'a'.repeat(64),memoryId:'memory',policyEpoch:1,completedAt:now,coverageKind:'complete-turn'});
  const job=store.reserve('memory',1,[source]);
  const binding={saveId:job.saveId,memoryId:'memory',policyEpoch:1,coverageDigest:job.coverageDigest,inputDigest:'b'.repeat(64),beforeHash:'c'.repeat(64),providerBindingDigest:'d'.repeat(64)};
  store.bindInput(job.saveId,binding);const attempt=store.beginAttempt(job.saveId,job.coverageDigest,binding);
  const db=new Database(store.path);
  const tables=['save_sources','save_jobs','save_input_bindings','backup_outbox','save_auto_policy'];
  try{
   db.run('DROP INDEX inputs_expiry');db.run('CREATE INDEX inputs_expiry ON save_input_bindings(expired,sequence)');
   db.run('DROP INDEX backup_outbox_ready');db.run('CREATE INDEX backup_outbox_ready ON backup_outbox(state,retryAt)');
   db.run('PRAGMA user_version=5');
   const before=tables.map(t=>db.query('SELECT * FROM '+t).all());
   expect(readMemoryObservationSummary(store.path,'memory').completedTurns).toBe(0);
   expect(db.query('PRAGMA user_version').get()).toEqual({user_version:5});
   const reopened=new MemorySaveStore(store.path,()=>now);reopened.expiryPage();
   expect(db.query('PRAGMA user_version').get()).toEqual({user_version:7});
   expect(tables.map(t=>db.query('SELECT * FROM '+t).all())).toEqual(before);
   expect(reopened.get(job.saveId).attemptId).toBe(attempt);
   expect(()=>reopened.beginAttempt(job.saveId,job.coverageDigest,binding)).toThrow('RECOVERY_REQUIRED');
   expect(readMemoryObservationSummary(store.path,'memory').completedTurns).toBe(0);
  }finally{db.close();}
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('one corrupt input keeps its warning across later healthy pages until a complete repaired sweep',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'memory-expiry-warning-')));let now=Date.now()-8*86400_000;
 const store=new MemorySaveStore(join(root,'memory-save-v2.sqlite'),()=>now),key=Buffer.alloc(32,4),input=Buffer.from('bounded maintenance fixture');
 const acquire=()=>acquireWorkspaceDirectoryLease({workspacePath:root,appDataDir:root,attempts:1});
 try{
  let damagedPath='',original=Buffer.alloc(0);
  const lease=await acquire();
  try{
   const inputs=new MemorySaveInputStore(root,lease,()=>now);
   for(let i=0;i<9;i++){
    const memoryId='memory-'+i;
    const source=store.observe({agent:'codex',instanceId:'fixture',sessionId:'session-'+i,turnId:'turn',startByte:0,endByte:20,sourceDigest:'a'.repeat(64),memoryId,policyEpoch:1,completedAt:now,coverageKind:'complete-turn'});
    const job=store.reserve(memoryId,1,[source]);
    const binding={saveId:job.saveId,memoryId,policyEpoch:1,coverageDigest:job.coverageDigest,inputDigest:createHash('sha256').update(input).digest('hex'),beforeHash:'b'.repeat(64),providerBindingDigest:'c'.repeat(64)};
    store.bindInput(job.saveId,binding);await inputs.stage(binding,input,key);
    if(i===0){damagedPath=join(root,'memory-save-inputs',saveDigest(job.saveId)+'.enc');original=readFileSync(damagedPath);}
   }
  }finally{lease.release();}
  writeFileSync(damagedPath,'corrupt fixture');now=Date.now();
  const maintenance=new MemorySaveMaintenance({enabled:()=>true,store,appDataRoot:root,acquireApp:acquire,release:l=>{l.release();},readKey:async()=>Buffer.from(key),backup:async()=>{throw new Error('no backup is due');}});
  await maintenance.tick();expect(maintenance.status().expiry).toBe('needs-attention');
  await maintenance.tick();expect(maintenance.status().expiry).toBe('needs-attention');
  expect(readFileSync(damagedPath,'utf8')).toBe('corrupt fixture');
  writeFileSync(damagedPath,original);await maintenance.tick();
  expect(maintenance.status().expiry).toBe('checked');expect(store.expiryPage().items).toHaveLength(0);
 }finally{rmSync(root,{recursive:true,force:true});}
});
