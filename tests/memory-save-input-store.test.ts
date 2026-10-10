import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,realpathSync,rmSync,readFileSync,writeFileSync,readdirSync,lstatSync,symlinkSync,linkSync,truncateSync,renameSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {MemorySaveInputStore,MEMORY_INPUT_TTL,MEMORY_INPUT_LIMIT} from '../src/memorySaveInputStore';
import {saveDigest} from '../src/memorySaveContract';
import {acquireWorkspaceDirectoryLease,type WorkspaceLease} from '../src/workspaceLease';
const roots:string[]=[],leases:WorkspaceLease[]=[];afterEach(()=>{for(const l of leases.splice(0))l.release();for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
async function fixture(){const root=realpathSync(mkdtempSync(join(tmpdir(),'save-input-')));roots.push(root);const app=join(root,'app');mkdirSync(app);const lease=await acquireWorkspaceDirectoryLease({workspacePath:app,appDataDir:app,attempts:1,deadOwnerRecoveryClass:'manual'});leases.push(lease);let now=1000;
 const store=new MemorySaveInputStore(app,lease,()=>now),key=randomBytes(32),input=Buffer.from('합성 대화 fixture: durable selected input');
 const binding={saveId:'save-one',memoryId:'memory-one',policyEpoch:1,coverageDigest:saveDigest('coverage'),inputDigest:createHash('sha256').update(input).digest('hex'),beforeHash:saveDigest('before'),providerBindingDigest:saveDigest('provider')};
 return {root,app,lease,store,key,input,binding,path:join(app,'memory-save-inputs',saveDigest(binding.saveId)+'.enc'),setNow:(n:number)=>{now=n;}};}

test('staging survives reopening, stores ciphertext only, and binds exact source metadata',async()=>{
 const f=await fixture();const header=await f.store.stage(f.binding,f.input,f.key);expect(header.expiresAt-header.createdAt).toBe(MEMORY_INPUT_TTL);
 const bytes=readFileSync(f.path);expect(bytes.includes(f.input)).toBe(false);expect(bytes.includes(f.key)).toBe(false);expect(lstatSync(f.path).mode&0o777).toBe(0o600);
 const reopened=new MemorySaveInputStore(f.app,f.lease,()=>1001);const plaintext=reopened.read(f.binding,f.key);expect(plaintext).toEqual(f.input);plaintext.fill(0);
 expect(await f.store.stage(f.binding,f.input,f.key)).toEqual(header);expect(readFileSync(f.path)).toEqual(bytes);
 expect(f.key.some(v=>v!==0)).toBe(true);
});

test('all binding fields and authenticated header reject substitution without overwriting ciphertext',async()=>{
 const f=await fixture();await f.store.stage(f.binding,f.input,f.key);const bytes=readFileSync(f.path);
 for(const field of ['memoryId','policyEpoch','coverageDigest','inputDigest','beforeHash','providerBindingDigest'] as const){const changed={...f.binding,[field]:field==='policyEpoch'?2:field==='memoryId'?'another':saveDigest('changed')};expect(()=>f.store.read(changed,f.key)).toThrow('CONFLICT');}
 const envelope=JSON.parse(bytes.toString());envelope.header.expiresAt++;writeFileSync(f.path,JSON.stringify(envelope));expect(()=>f.store.read(f.binding,f.key)).toThrow();
 writeFileSync(f.path,bytes);expect(readFileSync(f.path)).toEqual(bytes);
});

test('wrong or unavailable keys and altered ciphertext cannot yield partial plaintext',async()=>{
 const f=await fixture();await f.store.stage(f.binding,f.input,f.key);expect(()=>f.store.read(f.binding,randomBytes(32))).toThrow('UNAVAILABLE');expect(()=>f.store.read(f.binding,new Uint8Array())).toThrow('INVALID_INPUT');
 const envelope=JSON.parse(readFileSync(f.path,'utf8'));const cipher=Buffer.from(envelope.ciphertext,'base64');cipher[0]=cipher[0]!^1;envelope.ciphertext=cipher.toString('base64');writeFileSync(f.path,JSON.stringify(envelope));expect(()=>f.store.read(f.binding,f.key)).toThrow('UNAVAILABLE');
});

test('the 48000-byte bound uses bytes, accepts the boundary and rejects a mismatched digest',async()=>{
 const f=await fixture();const input=Buffer.alloc(MEMORY_INPUT_LIMIT,1),binding={...f.binding,inputDigest:createHash('sha256').update(input).digest('hex')};await f.store.stage(binding,input,f.key);expect(f.store.read(binding,f.key)).toEqual(input);
 await expect(f.store.stage(binding,Buffer.alloc(MEMORY_INPUT_LIMIT+1),f.key)).rejects.toThrow('INVALID_INPUT');await expect(f.store.stage(binding,Buffer.from('different'),f.key)).rejects.toThrow('INVALID_INPUT');
});

test('clock rollback and the seven-day boundary prevent reuse; expiry removes only encrypted staging',async()=>{
 const f=await fixture();await f.store.stage(f.binding,f.input,f.key);const fence=join(f.app,'memory-save-v2.sqlite');writeFileSync(fence,'preserved durable fence fixture');
 f.setNow(999);expect(()=>f.store.read(f.binding,f.key)).toThrow('CLOCK_ROLLBACK');expect(()=>f.store.expire(f.binding,f.key)).toThrow('CLOCK_ROLLBACK');
 f.setNow(1000+MEMORY_INPUT_TTL-1);expect(f.store.expire(f.binding,f.key)).toBe(false);
 f.setNow(1000+MEMORY_INPUT_TTL);expect(()=>f.store.read(f.binding,f.key)).toThrow('EXPIRED');expect(f.store.expire(f.binding,f.key)).toBe(true);
 expect(readFileSync(fence,'utf8')).toBe('preserved durable fence fixture');expect(()=>lstatSync(f.path)).toThrow();expect(f.store.expire(f.binding,f.key)).toBe(true);
 f.setNow(1001);await expect(f.store.stage(f.binding,f.input,f.key)).rejects.toThrow('EXPIRED');expect(()=>f.store.read(f.binding,f.key)).toThrow('EXPIRED');
});

test('partial files left by interrupted staging are preserved instead of being restaged',async()=>{
 const f=await fixture();mkdirSync(join(f.app,'memory-save-inputs'),{mode:0o700});writeFileSync(f.path,'{"header":',{mode:0o600});
 await expect(f.store.stage(f.binding,f.input,f.key)).rejects.toThrow('UNAVAILABLE');expect(readFileSync(f.path,'utf8')).toBe('{"header":');
});

test('symlink and hardlink files or linked staging roots never read, overwrite or remove outside bytes',async()=>{
 for(const kind of ['root','file','hardlink']){const f=await fixture(),outside=join(f.root,'outside');mkdirSync(outside);const marker=join(outside,'marker');writeFileSync(marker,'preserve');
  const staging=join(f.app,'memory-save-inputs');if(kind==='root')symlinkSync(outside,staging);else{mkdirSync(staging,{mode:0o700});if(kind==='file')symlinkSync(marker,f.path);else linkSync(marker,f.path);}
  await expect(f.store.stage(f.binding,f.input,f.key)).rejects.toThrow();expect(()=>f.store.expire(f.binding,f.key)).toThrow();expect(readFileSync(marker,'utf8')).toBe('preserve');
 }
});

test('64 MiB staging quota counts actual encrypted bytes and retains existing files',async()=>{
 const f=await fixture();const dir=join(f.app,'memory-save-inputs');mkdirSync(dir,{mode:0o700});const old=join(dir,'retained.enc');writeFileSync(old,'');truncateSync(old,64*1024*1024);
 await expect(f.store.stage(f.binding,f.input,f.key)).rejects.toThrow('BUDGET_PAUSED');expect(readdirSync(dir)).toEqual(['retained.enc']);
});

test('released leases deny staging and plaintext reads',async()=>{
 const f=await fixture();await f.store.stage(f.binding,f.input,f.key);f.lease.release();expect(()=>f.store.read(f.binding,f.key)).toThrow('UNAVAILABLE');await expect(f.store.stage(f.binding,f.input,f.key)).rejects.toThrow('UNAVAILABLE');
});


test('expiry retries after its durable marker without extending retention or touching other files',async()=>{
 const f=await fixture();await f.store.stage(f.binding,f.input,f.key);const bytes=readFileSync(f.path);f.setNow(1000+MEMORY_INPUT_TTL);
 expect(f.store.expire(f.binding,f.key)).toBe(true);
 // Model a crash after marker fsync but before ciphertext unlink.
 writeFileSync(f.path,bytes,{mode:0o600});expect(()=>f.store.read(f.binding,f.key)).toThrow('EXPIRED');
 expect(f.store.expire(f.binding,f.key)).toBe(true);expect(()=>lstatSync(f.path)).toThrow();
});

test('corrupt expiry markers stop reuse and cleanup without deleting the retained ciphertext',async()=>{
 const f=await fixture();await f.store.stage(f.binding,f.input,f.key);const bytes=readFileSync(f.path);
 writeFileSync(f.path+'.expired','partial fixture',{mode:0o600});f.setNow(1000+MEMORY_INPUT_TTL);
 await expect(f.store.stage(f.binding,f.input,f.key)).rejects.toThrow('UNAVAILABLE');expect(()=>f.store.expire(f.binding,f.key)).toThrow('UNAVAILABLE');expect(readFileSync(f.path)).toEqual(bytes);
});

test('a full 4096-entry inventory cannot admit a 4097th file or evict existing evidence',async()=>{
 const f=await fixture();const dir=join(f.app,'memory-save-inputs');mkdirSync(dir,{mode:0o700});for(let i=0;i<4096;i++)writeFileSync(join(dir,String(i)),'');
 await expect(f.store.stage(f.binding,f.input,f.key)).rejects.toThrow('BUDGET_PAUSED');expect(readdirSync(dir)).toHaveLength(4096);
 unlinkSync(join(dir,'4095'));const header=await f.store.stage(f.binding,f.input,f.key);
 expect(readdirSync(dir)).toHaveLength(4096);expect(await f.store.stage(f.binding,f.input,f.key)).toEqual(header);
});


test('large inventory yields the event loop and one lease cannot run two staging operations',async()=>{
 const f=await fixture();const dir=join(f.app,'memory-save-inputs');mkdirSync(dir,{mode:0o700});for(let i=0;i<500;i++)writeFileSync(join(dir,String(i)),'');
 let ticks=0;const timer=setInterval(()=>ticks++,0);
 try{const pending=f.store.stage(f.binding,f.input,f.key);const other=new MemorySaveInputStore(f.app,f.lease,()=>1000);
  await expect(other.stage(f.binding,f.input,f.key)).rejects.toThrow('UNAVAILABLE');await pending;expect(ticks).toBeGreaterThan(0);
 }finally{clearInterval(timer);}
});

test('directory replacement during asynchronous inventory cannot publish into a new staging root',async()=>{
 const f=await fixture();const dir=join(f.app,'memory-save-inputs');mkdirSync(dir,{mode:0o700});writeFileSync(join(dir,'retained'),'fixture');
 const pending=f.store.stage(f.binding,f.input,f.key);renameSync(dir,dir+'-old');mkdirSync(dir,{mode:0o700});
 await expect(pending).rejects.toThrow();expect(readdirSync(dir)).toEqual([]);expect(readFileSync(join(dir+'-old','retained'),'utf8')).toBe('fixture');
});
