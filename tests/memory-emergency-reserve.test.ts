import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync,statSync,symlinkSync,existsSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MemoryEmergencyReserve,MEMORY_RESERVE_FILES} from '../src/memoryEmergencyReserve';
import {acquireWorkspaceDirectoryLease,type WorkspaceLease} from '../src/workspaceLease';
import {checkMemorySaveDiskAdmission,MEMORY_DISK_LIMITS} from '../src/memorySaveDiskAdmission';
const roots:string[]=[],leases:WorkspaceLease[]=[];
afterEach(()=>{for(const l of leases.splice(0))l.release();for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
const freeBytes=async()=>10n*1024n*1024n*1024n;
async function fixture(){const root=realpathSync(mkdtempSync(join(tmpdir(),'emergency-reserve-')));roots.push(root);const lease=await acquireWorkspaceDirectoryLease({workspacePath:root,appDataDir:root,attempts:1,retryMs:1,deadOwnerRecoveryClass:'manual'});leases.push(lease);return {root,lease,reserve:new MemoryEmergencyReserve(root,lease,{freeBytes}),data:join(root,MEMORY_RESERVE_FILES.data),receipt:join(root,MEMORY_RESERVE_FILES.receipt),pending:join(root,MEMORY_RESERVE_FILES.pending)};}
const ready=(root:string)=>checkMemorySaveDiskAdmission({appDataRoot:root,memoryRoot:root,plannedInputBytes:0,plannedManifestBytes:0},freeBytes);

test('fresh allocation is durable, private, physically backed and idempotent across handles',async()=>{
 const f=await fixture();const first=await f.reserve.ensure();const before=statSync(f.data);const proof=readFileSync(f.receipt);
 expect(before.size).toBe(Number(MEMORY_DISK_LIMITS.reserve));expect(before.blocks*512).toBeGreaterThanOrEqual(before.size);
 expect(before.mode&0o777).toBe(0o600);expect((await ready(f.root)).allowed).toBe(true);
 expect(await new MemoryEmergencyReserve(f.root,f.lease,{freeBytes}).ensure()).toEqual(first);expect(statSync(f.data).ino).toBe(before.ino);expect(readFileSync(f.receipt)).toEqual(proof);
});

test('consumption commits its marker before releasing bytes and requires verified recovery with a new generation',async()=>{
 const f=await fixture();const first=await f.reserve.ensure();let sawMarker=false;
 const consumer=new MemoryEmergencyReserve(f.root,f.lease,{checkpoint:async phase=>{if(phase==='consumed-saved'){sawMarker=true;expect(JSON.parse(readFileSync(f.receipt,'utf8')).state).toBe('consumed');expect(statSync(f.data).size).toBe(Number(MEMORY_DISK_LIMITS.reserve));}}});
 await consumer.consume(first.generation);expect(sawMarker).toBe(true);expect(statSync(f.data).size).toBe(0);expect((await ready(f.root)).allowed).toBe(false);
 await expect(f.reserve.ensure()).rejects.toThrow('RECOVERY_REQUIRED');await expect(f.reserve.recover(first.generation,async()=>false)).rejects.toThrow('RECOVERY_REQUIRED');
 await f.reserve.consume(first.generation);const restored=await f.reserve.recover(first.generation,async()=>true);
 expect(restored.generation).not.toBe(first.generation);expect((await ready(f.root)).allowed).toBe(true);
 await expect(f.reserve.consume(first.generation)).rejects.toThrow('STALE_GENERATION');expect(statSync(f.data).size).toBe(Number(MEMORY_DISK_LIMITS.reserve));
});

test('interrupted allocation and consumption stay blocked and resume only with a matching recovery generation',async()=>{
 for(const step of ['preparing-saved','file-bound','allocated','consumed-saved']){
  const f=await fixture();const r=new MemoryEmergencyReserve(f.root,f.lease,{freeBytes,checkpoint:async phase=>{if(phase===step)throw new Error('fixture interruption');}});
  if(step==='consumed-saved'){const first=await f.reserve.ensure();await expect(r.consume(first.generation)).rejects.toThrow('UNAVAILABLE');}
  else await expect(r.ensure()).rejects.toThrow('UNAVAILABLE');
  const current=JSON.parse(readFileSync(f.receipt,'utf8'));expect((await ready(f.root)).allowed).toBe(false);
  await expect(f.reserve.ensure()).rejects.toThrow('RECOVERY_REQUIRED');
  await f.reserve.recover(current.generation,async()=>true);expect((await ready(f.root)).allowed).toBe(true);
 }
});

test('fsynced pending transitions block admission and recover through their exact parent hash',async()=>{
 for(const pendingState of ['preparing','ready','consumed','rearming']){
  const f=await fixture();const r=new MemoryEmergencyReserve(f.root,f.lease,{freeBytes,checkpoint:async(phase,state)=>{if(phase==='pending-synced'&&state===pendingState)throw new Error('fixture pending interruption');}});
  if(pendingState==='consumed'||pendingState==='rearming'){
   const first=await f.reserve.ensure();if(pendingState==='consumed')await expect(r.consume(first.generation)).rejects.toThrow();
   else{await f.reserve.consume(first.generation);await expect(r.recover(first.generation,async()=>true)).rejects.toThrow();}
  }else await expect(r.ensure()).rejects.toThrow();
  expect(existsSync(f.pending)).toBe(true);expect((await ready(f.root)).allowed).toBe(false);
  const generation=JSON.parse(readFileSync(f.receipt,'utf8')).generation;
  await f.reserve.recover(generation,async()=>true);expect(existsSync(f.pending)).toBe(false);expect((await ready(f.root)).allowed).toBe(true);
 }
});

test('unknown, mismatched and symlink files are preserved rather than adopted or removed',async()=>{
 const f=await fixture();writeFileSync(f.data,'unowned');await expect(f.reserve.ensure()).rejects.toThrow('RECOVERY_REQUIRED');expect(readFileSync(f.data,'utf8')).toBe('unowned');rmSync(f.data);
 const first=await f.reserve.ensure();const original=readFileSync(f.receipt);
 writeFileSync(f.receipt,JSON.stringify({...JSON.parse(original.toString()),nextGeneration:'invalid'}));await expect(f.reserve.ensure()).rejects.toThrow('RECOVERY_REQUIRED');writeFileSync(f.receipt,original);
 await f.reserve.consume(first.generation);rmSync(f.data);const outside=join(f.root,'unrelated');writeFileSync(outside,'preserve');symlinkSync(outside,f.data);
 await expect(f.reserve.recover(first.generation,async()=>true)).rejects.toThrow();expect(readFileSync(outside,'utf8')).toBe('preserve');
});

test('a pending record with the wrong parent is never promoted and no plaintext error is exposed',async()=>{
 const f=await fixture();await f.reserve.ensure();const proof=JSON.parse(readFileSync(f.receipt,'utf8'));writeFileSync(f.pending,JSON.stringify({...proof,state:'consumed',parentHash:'0'.repeat(64)}),{mode:0o600});
 const before=readFileSync(f.receipt);await expect(f.reserve.recover(proof.generation,async()=>true)).rejects.toThrow('RECOVERY_REQUIRED');expect(readFileSync(f.receipt)).toEqual(before);expect(existsSync(f.pending)).toBe(true);
});

test('low space and lost ownership do not overwrite an existing reserve or enable new work',async()=>{
 const f=await fixture();await expect(new MemoryEmergencyReserve(f.root,f.lease,{freeBytes:async()=>0n}).ensure()).rejects.toThrow('SPACE_LOW');expect(existsSync(f.receipt)).toBe(false);
 const first=await f.reserve.ensure();await f.reserve.consume(first.generation);
 await expect(new MemoryEmergencyReserve(f.root,f.lease,{freeBytes:async()=>0n}).recover(first.generation,async()=>true)).rejects.toThrow('SPACE_LOW');expect((await ready(f.root)).allowed).toBe(false);
 f.lease.release();await expect(f.reserve.ensure()).rejects.toThrow('LEASE_LOST');
});

test('concurrent callers sharing a lease cannot interleave reserve mutations',async()=>{
 const f=await fixture();let release!:()=>void;
 const r=new MemoryEmergencyReserve(f.root,f.lease,{freeBytes,checkpoint:async phase=>{if(phase==='preparing-saved')await new Promise<void>(resolve=>{release=resolve;});}});
 const pending=r.ensure();while(!release)await Bun.sleep(1);
 await expect(f.reserve.ensure()).rejects.toThrow('BUSY');release();await pending;expect((await ready(f.root)).allowed).toBe(true);
});

test('SIGKILL after the consumption marker retains the fence and repeat consumption releases only its own bytes',async()=>{
 const f=await fixture();const first=await f.reserve.ensure();f.lease.release();
 const reserveModule=join(import.meta.dir,'../src/memoryEmergencyReserve.ts'),leaseModule=join(import.meta.dir,'../src/workspaceLease.ts');
 const code=`import {MemoryEmergencyReserve} from ${JSON.stringify(reserveModule)};import {acquireWorkspaceDirectoryLease} from ${JSON.stringify(leaseModule)};const lease=await acquireWorkspaceDirectoryLease({workspacePath:${JSON.stringify(f.root)},appDataDir:${JSON.stringify(f.root)},deadOwnerRecoveryClass:'guarded'});const r=new MemoryEmergencyReserve(${JSON.stringify(f.root)},lease,{checkpoint:async phase=>{if(phase==='consumed-saved')process.kill(process.pid,'SIGKILL');}});await r.consume(${JSON.stringify(first.generation)});`;
 const child=Bun.spawn([process.execPath,'-e',code],{stdout:'pipe',stderr:'pipe'});expect(await child.exited).not.toBe(0);expect(await new Response(child.stderr).text()).toBe('');
 expect(JSON.parse(readFileSync(f.receipt,'utf8')).state).toBe('consumed');expect(statSync(f.data).size).toBe(Number(MEMORY_DISK_LIMITS.reserve));expect((await ready(f.root)).allowed).toBe(false);
 // This fixture child has no descendants, and exited has been observed. The
 // production host uses manual ownership recovery; the reserve never deletes locks.
 const recovered=await acquireWorkspaceDirectoryLease({workspacePath:f.root,appDataDir:f.root,attempts:3,retryMs:1,deadOwnerGraceMs:0,canRecoverDeadOwner:()=>true,deadOwnerRecoveryClass:'manual'});leases.push(recovered);
 const r=new MemoryEmergencyReserve(f.root,recovered,{freeBytes});await r.consume(first.generation);expect(statSync(f.data).size).toBe(0);
 const next=await r.recover(first.generation,async()=>true);expect(next.generation).not.toBe(first.generation);
},15000);
