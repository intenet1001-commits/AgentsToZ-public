import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,realpathSync,readFileSync,writeFileSync,mkdirSync,rmSync,existsSync,symlinkSync,lstatSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomBytes,createHash} from 'node:crypto';
import {MemorySaveKeyLifecycle,MEMORY_SAVE_KEY_FILE} from '../src/memorySaveKeyLifecycle';
import {MemoryInputKeyError,addMemorySaveInputKey} from '../src/memorySaveInputKeyProvider';
import {MemorySaveStore} from '../src/memorySaveStore';import {saveDigest} from '../src/memorySaveContract';
import {acquireWorkspaceDirectoryLease,type WorkspaceLease} from '../src/workspaceLease';
const roots:string[]=[],leases:WorkspaceLease[]=[];afterEach(()=>{for(const lease of leases.splice(0))lease.release();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
async function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'memory-key-lifecycle-')));roots.push(root);
 const lease=await acquireWorkspaceDirectoryLease({workspacePath:root,appDataDir:root,attempts:1,deadOwnerRecoveryClass:'manual'});leases.push(lease);
 let stored:Buffer|null=null,adds=0,reads=0,valid=true;const deps={platform:'darwin',readKey:async()=>{reads++;if(!stored)throw new MemoryInputKeyError('MISSING');return Buffer.from(stored);},addKey:async(key:Buffer)=>{adds++;stored=Buffer.from(key);}};
 const service=new MemorySaveKeyLifecycle(root,'installation',deps),path=join(root,MEMORY_SAVE_KEY_FILE);
 return {root,path,lease,service,deps,valid:async()=>valid,setValid:(v:boolean)=>{valid=v;},stored:()=>stored,setStored:(v:Buffer|null)=>{stored=v;},adds:()=>adds,reads:()=>reads};
}
test('status is side-effect free; explicit preparation creates one key and fresh loads verify its fingerprint',async()=>{
 const f=await fixture();expect(f.service.status()).toBe('not-configured');expect(f.reads()).toBe(0);expect(existsSync(f.path)).toBe(false);
 expect(await f.service.prepare(f.lease,f.valid)).toBe('registered');expect(f.adds()).toBe(1);expect(f.stored()?.length).toBe(32);
 const raw=readFileSync(f.path,'utf8');expect(raw).not.toContain(f.stored()!.toString('base64'));expect(lstatSync(f.path).mode&0o077).toBe(0);
 const loaded=await f.service.load();expect(loaded).toEqual(f.stored()!);loaded.fill(0);
 await f.service.prepare(f.lease,f.valid);expect(f.adds()).toBe(1);expect(readFileSync(f.path,'utf8')).toBe(raw);
});
test('lost, changed and inaccessible registered keys never rotate or alter the marker',async()=>{
 for(const kind of ['lost','changed','locked']){const f=await fixture();await f.service.prepare(f.lease,f.valid);const before=readFileSync(f.path);
  if(kind==='lost')f.setStored(null);if(kind==='changed')f.setStored(randomBytes(32));if(kind==='locked')f.deps.readKey=async()=>{throw new MemoryInputKeyError('UNAVAILABLE');};
  await expect(f.service.prepare(f.lease,f.valid,true)).rejects.toThrow(kind==='lost'?'KEY_LOST':kind==='changed'?'KEY_CHANGED':'UNAVAILABLE');
  await expect(f.service.load()).rejects.toThrow();expect(f.adds()).toBe(1);expect(readFileSync(f.path)).toEqual(before);
 }
});
test('existing ciphertext or durable jobs prevent initial generation even if no marker survived',async()=>{
 for(const kind of ['cipher','job']){const f=await fixture();
  if(kind==='cipher'){mkdirSync(join(f.root,'memory-save-inputs'));writeFileSync(join(f.root,'memory-save-inputs','old.enc'),'ciphertext');}
  else{const s=new MemorySaveStore(join(f.root,'memory-save-v2.sqlite'));const key=s.observe({agent:'codex',instanceId:'i',sessionId:'s',turnId:'t',startByte:0,endByte:1,sourceDigest:saveDigest('source'),memoryId:'memory',policyEpoch:1,completedAt:1});s.reserve('memory',1,[key]);}
  await expect(f.service.prepare(f.lease,f.valid,true)).rejects.toThrow('HISTORY_EXISTS');expect(f.adds()).toBe(0);expect(existsSync(f.path)).toBe(false);
 }
});
test('a failed initial add requires explicit recovery and may restart only while history is empty',async()=>{
 const f=await fixture(),add=f.deps.addKey;f.deps.addKey=async()=>{throw new Error('private failure');};
 await expect(f.service.prepare(f.lease,f.valid)).rejects.toThrow('SETUP_INCOMPLETE');expect(f.service.status()).toBe('setup-incomplete');const first=readFileSync(f.path,'utf8');
 f.deps.addKey=add;await expect(f.service.prepare(f.lease,f.valid)).rejects.toThrow('SETUP_INCOMPLETE');expect(f.adds()).toBe(0);
 await f.service.prepare(f.lease,f.valid,true);expect(f.adds()).toBe(1);expect(f.service.status()).toBe('registered');expect(readFileSync(f.path,'utf8')).not.toBe(first);
});
test('interruption after Keychain add completes the same key on retry rather than adding a second one',async()=>{
 const f=await fixture(),add=f.deps.addKey;f.deps.addKey=async key=>{await add(key);f.setValid(false);};
 await expect(f.service.prepare(f.lease,f.valid)).rejects.toThrow('LEASE_LOST');const key=Buffer.from(f.stored()!);expect(f.service.status()).toBe('setup-incomplete');
 f.setValid(true);await f.service.prepare(f.lease,f.valid);expect(f.adds()).toBe(1);expect(await f.service.load()).toEqual(key);
});
test('uncertain add result is resolved by exact readback and cannot accept a competing different key',async()=>{
 for(const competing of [false,true]){const f=await fixture();f.deps.addKey=async key=>{f.setStored(competing?randomBytes(32):Buffer.from(key));throw new Error('uncertain add');};
  if(competing)await expect(f.service.prepare(f.lease,f.valid)).rejects.toThrow('KEY_CHANGED');else expect(await f.service.prepare(f.lease,f.valid)).toBe('registered');
 }
});
test('registration loss, malformed pending files and symlink markers fail without key creation',async()=>{
 for(const kind of ['registration','pending','symlink']){const f=await fixture();
  if(kind==='registration')f.setValid(false);if(kind==='pending')writeFileSync(f.path+'.next','broken');if(kind==='symlink'){writeFileSync(join(f.root,'other'),'foreign');symlinkSync(join(f.root,'other'),f.path);}
  await expect(f.service.prepare(f.lease,f.valid,true)).rejects.toThrow();expect(f.adds()).toBe(0);expect(f.reads()).toBe(0);
 }
});
test('concurrent preparation on the same lease admits a single key operation',async()=>{
 const f=await fixture();const results=await Promise.allSettled([f.service.prepare(f.lease,f.valid),f.service.prepare(f.lease,f.valid)]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(f.adds()).toBe(1);
});
test('an exact pending marker resumes without another key, while a stale or replaced pending marker stays preserved',async()=>{
 for(const kind of ['exact','stale','replaced']){const f=await fixture();await f.service.prepare(f.lease,f.valid);
  const original=readFileSync(f.path),pending={...JSON.parse(original.toString()),parentHash:kind==='stale'?'f'.repeat(64):createHash('sha256').update(original).digest('hex')};
  writeFileSync(f.path+'.next',JSON.stringify(pending),{mode:0o600});expect(f.service.status()).toBe('setup-incomplete');
  let validations=0;const validate=async()=>{if(kind==='replaced'&&++validations===2)writeFileSync(f.path+'.next',JSON.stringify({...pending,state:'creating'}));return true;};
  if(kind==='exact'){await f.service.prepare(f.lease,validate);expect(f.service.status()).toBe('registered');expect(existsSync(f.path+'.next')).toBe(false);}
  else{await expect(f.service.prepare(f.lease,validate)).rejects.toThrow('UNAVAILABLE');expect(existsSync(f.path+'.next')).toBe(true);expect(readFileSync(f.path)).toEqual(original);}
  expect(f.adds()).toBe(1);
 }
});
test('credential addition uses a detached private pipe contract, never argv or an update flag',async()=>{
 const key=randomBytes(32);let captured:Buffer|undefined,stdout:Buffer|undefined;
 await addMemorySaveInputKey({installationId:'installation',platform:'darwin',key,runner:async(command,args,input)=>{
  expect(command).toBe('/usr/bin/security');expect(args[0]).toBe('add-generic-password');expect(args.at(-1)).toBe('-w');expect(args).not.toContain('-U');expect(args).not.toContain('-A');expect(args.join(' ')).not.toContain(key.toString('base64'));
  captured=input;expect(input!.toString()).toBe(`${key.toString('base64')}\n${key.toString('base64')}\n`);stdout=Buffer.from('private output');return {status:0,stdout};
 }});
 expect(captured!.every(v=>v===0)).toBe(true);expect(stdout!.every(v=>v===0)).toBe(true);key.fill(0);
});
