import {afterEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,mkdirSync,openSync,closeSync,writeSync,fsyncSync,fstatSync,writeFileSync,readFileSync,rmSync,truncateSync,symlinkSync,linkSync,existsSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomFillSync,randomUUID} from 'node:crypto';
import {checkMemorySaveDiskAdmission,beginDiskCheckedAutomaticMemoryAttempt,MEMORY_DISK_LIMITS,type MemoryDiskScope} from '../src/memorySaveDiskAdmission';
import {MemorySaveStore} from '../src/memorySaveStore';
import {saveDigest} from '../src/memorySaveContract';
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),'memory-disk-'));roots.push(root);const appDataRoot=join(root,'app'),memoryRoot=join(root,'memory');mkdirSync(appDataRoot);mkdirSync(memoryRoot);return {root,appDataRoot,memoryRoot,plannedInputBytes:48000,plannedManifestBytes:100000} satisfies MemoryDiskScope&{root:string};}
const enough=async()=>10n*1024n*1024n*1024n;
function reserve(root:string,sparse=false){
 const path=join(root,'memory-emergency-reserve.bin');const fd=openSync(path,'wx',0o600);
 try{if(!sparse){const chunk=randomFillSync(Buffer.alloc(64*1024));for(let i=0;i<512;i++)writeSync(fd,chunk);fsyncSync(fd);}}finally{closeSync(fd);}
 if(sparse)truncateSync(path,Number(MEMORY_DISK_LIMITS.reserve));
 const read=openSync(path,'r');let st;try{st=fstatSync(read,{bigint:true});}finally{closeSync(read);}
 const proof={schemaVersion:1,state:'ready',generation:randomUUID(),dev:String(st.dev),ino:String(st.ino),size:String(st.size)};
 writeFileSync(join(root,'memory-emergency-reserve.json'),JSON.stringify(proof),{mode:0o600});return proof;
}
function sized(path:string,size:bigint){writeFileSync(path,'');truncateSync(path,Number(size));}

test('preflight is read-only, counts actual bytes, and requires a physically allocated matching reserve',async()=>{
 const f=fixture();expect((await checkMemorySaveDiskAdmission(f,enough)).reason).toBe('reserve-unavailable');expect(existsSync(join(f.appDataRoot,'memory-emergency-reserve.bin'))).toBe(false);
 reserve(f.appDataRoot);mkdirSync(join(f.appDataRoot,'memory-save-inputs'));writeFileSync(join(f.appDataRoot,'memory-save-inputs/input.enc'),'fixture');
 const proof=readFileSync(join(f.appDataRoot,'memory-emergency-reserve.json'));
 const result=await checkMemorySaveDiskAdmission(f,enough);expect(result.allowed).toBe(true);expect(result.usage?.inputBytes).toBe('7');
 expect(readFileSync(join(f.appDataRoot,'memory-emergency-reserve.json'))).toEqual(proof);expect(JSON.stringify(result)).not.toContain(f.root);
 const real=await checkMemorySaveDiskAdmission(f);expect(['ready','free-space-low']).toContain(real.reason);expect(real.usage?.appFreeBytes).toMatch(/^\d+$/);
});

test('DB, journal/WAL, and planned staging budgets reject new work without pruning old files',async()=>{
 const f=fixture();const db=join(f.appDataRoot,'memory-save-v2.sqlite');sized(db,MEMORY_DISK_LIMITS.receipts);
 expect((await checkMemorySaveDiskAdmission(f,enough)).reason).toBe('receipts-full');truncateSync(db,0);
 const wal=db+'-wal';sized(wal,MEMORY_DISK_LIMITS.wal+1n);expect((await checkMemorySaveDiskAdmission(f,enough)).reason).toBe('wal-full');rmSync(wal);
 const inputs=join(f.appDataRoot,'memory-save-inputs');mkdirSync(inputs);const pending=join(inputs,'pending.enc');sized(pending,MEMORY_DISK_LIMITS.inputs);
 expect((await checkMemorySaveDiskAdmission(f,enough)).reason).toBe('inputs-full');expect(existsSync(pending)).toBe(true);
 rmSync(pending);const manifests=join(f.appDataRoot,'memory-save-manifests');mkdirSync(manifests);const unresolved=join(manifests,'unresolved.backup');sized(unresolved,MEMORY_DISK_LIMITS.manifests+1n);
 expect((await checkMemorySaveDiskAdmission(f,enough)).reason).toBe('manifests-full');expect(existsSync(unresolved)).toBe(true);
});

test('the minimum free budget includes expected writes and unavailable measurements cannot permit admission',async()=>{
 const f=fixture();const required=MEMORY_DISK_LIMITS.free+BigInt(f.plannedInputBytes+f.plannedManifestBytes);
 expect((await checkMemorySaveDiskAdmission(f,async()=>required-1n)).reason).toBe('free-space-low');
 expect((await checkMemorySaveDiskAdmission(f,async()=>{throw new Error('/private/filesystem');})).reason).toBe('unavailable');
 expect((await checkMemorySaveDiskAdmission({...f,plannedInputBytes:70001},enough)).reason).toBe('invalid-input');
 expect((await checkMemorySaveDiskAdmission({...f,appDataRoot:'relative'},enough)).reason).toBe('invalid-input');
});

test('durable host proposals and their journal count toward the manifest budget without pruning',async()=>{
 const f=fixture();const db=join(f.appDataRoot,'memory-session-recovery.sqlite');
 sized(db,MEMORY_DISK_LIMITS.manifests-100000n);sized(db+'-journal',1n);
 expect((await checkMemorySaveDiskAdmission(f,enough)).reason).toBe('manifests-full');
 expect(existsSync(db)).toBe(true);expect(existsSync(db+'-journal')).toBe(true);
});

test('sparse, consumed, swapped, malformed, and symlink reserves never advertise readiness',async()=>{
 for(const kind of ['sparse','consumed','swapped','malformed','symlink']){
  const f=fixture();const proof=reserve(f.appDataRoot,kind==='sparse');const meta=join(f.appDataRoot,'memory-emergency-reserve.json'),bin=join(f.appDataRoot,'memory-emergency-reserve.bin');
  if(kind==='consumed')writeFileSync(meta,JSON.stringify({...proof,state:'consumed'}));
  if(kind==='swapped')writeFileSync(meta,JSON.stringify({...proof,ino:'0'}));
  if(kind==='malformed')writeFileSync(meta,'invalid');
  if(kind==='symlink'){rmSync(meta);symlinkSync(bin,meta);}
  expect((await checkMemorySaveDiskAdmission(f,enough)).reason).toBe('reserve-unavailable');expect(existsSync(bin)).toBe(true);
 }
});

test('special files, linked trees, and excessive inventory stop bounded scanning without changing the source',async()=>{
 const f=fixture();const staging=join(f.appDataRoot,'memory-save-inputs');mkdirSync(staging);const outside=join(f.root,'outside');writeFileSync(outside,'preserve');
 const link=join(staging,'link');symlinkSync(outside,link);expect((await checkMemorySaveDiskAdmission(f,enough)).reason).toBe('inventory-incomplete');rmSync(link);
 linkSync(outside,link);expect((await checkMemorySaveDiskAdmission(f,enough)).reason).toBe('inventory-incomplete');rmSync(link);
 for(let i=0;i<4097;i++)writeFileSync(join(staging,`${i}`),'');
 expect((await checkMemorySaveDiskAdmission(f,enough)).reason).toBe('inventory-incomplete');expect(readFileSync(outside,'utf8')).toBe('preserve');
});

test('disk and lease denial preserve prepared intent and quota; fresh success composes with durable policy admission',async()=>{
 const f=fixture();reserve(f.appDataRoot);let now=1000,valid=true,clock=0;
 const store=new MemorySaveStore(join(f.appDataRoot,'memory-save-v2.sqlite'),()=>now);
 const intent={inputDigest:saveDigest('input'),beforeHash:saveDigest('before'),providerBindingDigest:saveDigest('provider')};
 store.setAutomaticPolicy(0,{enabled:true,consentVersion:1,providerBindingDigest:intent.providerBindingDigest});now++;
 const key=store.observe({agent:'codex',instanceId:'instance',sessionId:'session',turnId:'turn',startByte:0,endByte:1,sourceDigest:saveDigest('source'),memoryId:'memory',policyEpoch:1,completedAt:now,coverageKind:'complete-turn'});
 const job=store.reserve('memory',1,[key]);
 const options={store,saveId:job.saveId,coverageDigest:job.coverageDigest,policyRevision:1,intent,scope:f,validateLeaseAndRegistration:async()=>valid};
 await expect(beginDiskCheckedAutomaticMemoryAttempt(options,async()=>0n)).rejects.toThrow('free-space-low');
 valid=false;await expect(beginDiskCheckedAutomaticMemoryAttempt(options,enough)).rejects.toThrow('scope-changed');valid=true;
 let checks=0;await expect(beginDiskCheckedAutomaticMemoryAttempt({...options,validateLeaseAndRegistration:async()=>++checks===1},enough)).rejects.toThrow('scope-changed');
 await expect(beginDiskCheckedAutomaticMemoryAttempt({...options,validateLeaseAndRegistration:async()=>{clock+=6000;return true;}},enough,()=>clock)).rejects.toThrow('unavailable');
 expect(store.page().items[0]?.phase).toBe('prepared');const db=new Database(store.path);expect(db.query('SELECT * FROM save_auto_attempts').all()).toHaveLength(0);db.close();
 const attempt=await beginDiskCheckedAutomaticMemoryAttempt(options,enough);expect(store.page().items[0]?.attemptId).toBe(attempt);
 await expect(beginDiskCheckedAutomaticMemoryAttempt(options,enough)).rejects.toThrow('RECOVERY_REQUIRED');
});


test('warning threshold preserves admission and directory replacement invalidates the measured scope',async()=>{
 const f=fixture();reserve(f.appDataRoot);sized(join(f.appDataRoot,'memory-save-v2.sqlite'),MEMORY_DISK_LIMITS.receiptsWarning);
 const warning=await checkMemorySaveDiskAdmission(f,enough);expect(warning.allowed).toBe(true);expect(warning.warning).toBe(true);
 let changed=false;const result=await checkMemorySaveDiskAdmission(f,async()=>{if(!changed){changed=true;renameSync(f.memoryRoot,f.memoryRoot+'-old');mkdirSync(f.memoryRoot);}return enough();});
 expect(result.reason).toBe('scope-changed');expect(result.usage).toBeNull();
});

test('deep directory trees stop scanning before inspecting an unbounded subtree',async()=>{
 const f=fixture();let path=join(f.appDataRoot,'memory-save-manifests');mkdirSync(path);
 for(let i=0;i<10;i++){path=join(path,'nested');mkdirSync(path);}
 const marker=join(path,'unresolved');writeFileSync(marker,'preserve');
 expect((await checkMemorySaveDiskAdmission(f,enough)).reason).toBe('inventory-incomplete');expect(readFileSync(marker,'utf8')).toBe('preserve');
});
