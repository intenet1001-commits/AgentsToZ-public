import {createCipheriv,createDecipheriv,createHash,createHmac,timingSafeEqual,randomBytes} from 'node:crypto';
import {constants,openSync,closeSync,fstatSync,lstatSync,realpathSync,mkdirSync,writeSync,readSync,fsyncSync,unlinkSync,type Stats} from 'node:fs';
import {join} from 'node:path';
import {opendir,lstat} from 'node:fs/promises';
import {saveDigest,saveHash,saveInteger,saveToken} from './memorySaveContract';
import type {WorkspaceLease} from './workspaceLease';

export const MEMORY_INPUT_LIMIT=48000, MEMORY_INPUT_TTL=7*24*60*60*1000;
const FILE_LIMIT=70000,TOTAL_LIMIT=64*1024*1024;
const writing=new WeakSet<WorkspaceLease>();
/** Failures of the lease or the staging root (every #scope error) and errno codes of the process rather than of one
 * file. The intent sweep rethrows these so the next tick looks again. EIO is not here: a read error of one file recurs,
 * and rethrowing it would stop every later tick before the remaining intents and expirations. */
const environmental=new WeakSet<object>(),PROCESS_ERRORS=new Set(['EMFILE','ENFILE','ENOMEM','EAGAIN','EINTR','EBUSY']);
export interface MemoryInputBinding {
 saveId:string;memoryId:string;policyEpoch:number;coverageDigest:string;
 inputDigest:string;beforeHash:string;providerBindingDigest:string;
}
interface Header {version:1;binding:MemoryInputBinding;createdAt:number;expiresAt:number}
export class MemoryInputError extends Error {
 constructor(readonly code:'INVALID_INPUT'|'UNAVAILABLE'|'CONFLICT'|'EXPIRED'|'CLOCK_ROLLBACK'|'BUDGET_PAUSED') {super(`Memory input: ${code}`);}
}
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
function canonical(b:MemoryInputBinding):MemoryInputBinding {
 if(!b||![b.saveId,b.memoryId].every(saveToken)||!saveInteger(b.policyEpoch)||![b.coverageDigest,b.inputDigest,b.beforeHash,b.providerBindingDigest].every(saveHash))throw new MemoryInputError('INVALID_INPUT');
 return {saveId:b.saveId,memoryId:b.memoryId,policyEpoch:b.policyEpoch,coverageDigest:b.coverageDigest,inputDigest:b.inputDigest,beforeHash:b.beforeHash,providerBindingDigest:b.providerBindingDigest};
}
function same(a:Stats,b:Stats){return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;}
/** Internal bounded encrypted staging only. The caller supplies a separate OS-held
 * 32-byte key and a live app-data directory lease; this module never creates keys,
 * grants consent, validates transcripts, admits AI, or marks coverage saved.
 * The sole dispatcher must retain its registration/policy/disk admission guards.
 * Plaintext returned by read is caller-owned and should be zeroed after use. */
export class MemorySaveInputStore {
 private readonly appStamp;
 private stagingIdentity:{dev:number;ino:number}|null=null;
 private readonly created=new WeakMap<Header,Stats>();
 constructor(readonly appDataRoot:string,readonly lease:WorkspaceLease,readonly now=Date.now,
  private readonly namespace:'memory-save-inputs'|'precompaction-inputs'='memory-save-inputs'){
  if(!['memory-save-inputs','precompaction-inputs'].includes(namespace))throw new MemoryInputError('INVALID_INPUT');
  this.appStamp=lstatSync(appDataRoot);
 }
 #scope(create=false){try{return this.#checkScope(create);}catch(e){
  const error=e instanceof MemoryInputError?e:new MemoryInputError('UNAVAILABLE');environmental.add(error);throw error;}}
 #checkScope(create:boolean){
  if(!this.lease.refresh()||this.lease.identity.canonicalWorkspacePath!==this.appDataRoot||realpathSync(this.appDataRoot)!==this.appDataRoot||!lstatSync(this.appDataRoot).isDirectory())throw new MemoryInputError('UNAVAILABLE');
  const current=lstatSync(this.appDataRoot);if(current.dev!==this.appStamp.dev||current.ino!==this.appStamp.ino)throw new MemoryInputError('UNAVAILABLE');
  const root=join(this.appDataRoot,this.namespace);
  if(create)mkdirSync(root,{mode:0o700,recursive:true});
  const st=lstatSync(root);if(!st.isDirectory()||realpathSync(root)!==root||(process.platform!=='win32'&&(Number(st.mode)&0o077)!==0))throw new MemoryInputError('UNAVAILABLE');
  if(this.stagingIdentity&&(this.stagingIdentity.dev!==st.dev||this.stagingIdentity.ino!==st.ino))throw new MemoryInputError('UNAVAILABLE');
  this.stagingIdentity={dev:st.dev,ino:st.ino};
  return root;
 }
 #safe<T>(fn:()=>T):T {try{return fn();}catch(e){if(e instanceof MemoryInputError)throw e;throw new MemoryInputError('UNAVAILABLE');}}
 #key(key:Uint8Array){if(!(key instanceof Uint8Array)||key.byteLength!==32)throw new MemoryInputError('INVALID_INPUT');return Buffer.from(key);}
 #path(root:string,b:MemoryInputBinding){return join(root,saveDigest(b.saveId)+'.enc');}
 /** Directory entry flush. POSIX-only: Windows cannot fsync a directory handle
  * (measured: EPERM), and the file fsyncs in this store still run on both. */
 #sync(root:string){if(process.platform==='win32')return;const fd=openSync(root,constants.O_RDONLY);try{fsyncSync(fd);}finally{closeSync(fd);}}
 #expiry(root:string,b:MemoryInputBinding,key:Buffer):number|null {
  const path=this.#path(root,b)+'.expired';let fd:number;
  try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(e:any){if(e?.code==='ENOENT')return null;throw e;}
  try{const st=fstatSync(fd);if(!st.isFile()||st.nlink!==1||st.size<1||st.size>2048||(process.platform!=='win32'&&(st.mode&0o077)!==0))throw new MemoryInputError('UNAVAILABLE');
   const bytes=Buffer.alloc(st.size);if(readSync(fd,bytes,0,bytes.length,0)!==bytes.length)throw new MemoryInputError('UNAVAILABLE');
   const marker=JSON.parse(bytes.toString('utf8'));const data=marker.data;
   if(data?.version!==1||data.bindingDigest!==saveDigest(b)||!saveInteger(data.expiresAt)||!saveHash(marker.mac))throw new MemoryInputError('CONFLICT');
   const mac=createHmac('sha256',key).update('memory-input-expired-v1\0').update(JSON.stringify(data)).digest();
   if(!timingSafeEqual(mac,Buffer.from(marker.mac,'hex'))||!same(st,fstatSync(fd))||!same(st,lstatSync(path)))throw new MemoryInputError('CONFLICT');return data.expiresAt;
  }finally{closeSync(fd);}
 }
 #markExpired(root:string,b:MemoryInputBinding,key:Buffer,expiresAt:number){
  const data={version:1,bindingDigest:saveDigest(b),expiresAt};
  const payload=Buffer.from(JSON.stringify({data,mac:createHmac('sha256',key).update('memory-input-expired-v1\0').update(JSON.stringify(data)).digest('hex')}));
  const fd=openSync(this.#path(root,b)+'.expired',constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{let offset=0;while(offset<payload.length){const n=writeSync(fd,payload,offset,payload.length-offset);if(!n)throw new MemoryInputError('UNAVAILABLE');offset+=n;}fsyncSync(fd);}finally{closeSync(fd);}
  this.#sync(root);
 }
 #read(root:string,b:MemoryInputBinding,key:Buffer){
  const path=this.#path(root,b),fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let plain:Buffer|undefined;
  try{
   const before=fstatSync(fd);if(!before.isFile()||before.nlink!==1||before.size<1||before.size>FILE_LIMIT||(process.platform!=='win32'&&(before.mode&0o077)!==0))throw new MemoryInputError('UNAVAILABLE');
   const bytes=Buffer.alloc(before.size);let offset=0;
   while(offset<bytes.length){const n=readSync(fd,bytes,offset,bytes.length-offset,offset);if(!n)throw new MemoryInputError('UNAVAILABLE');offset+=n;}
   const envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));const h=envelope.header as Header;
   if(h?.version!==1||!saveInteger(h.createdAt)||!saveInteger(h.expiresAt)||h.expiresAt-h.createdAt!==MEMORY_INPUT_TTL||JSON.stringify(canonical(h.binding))!==JSON.stringify(b))throw new MemoryInputError('CONFLICT');
   const decode=(s:unknown,size?:number)=>{if(typeof s!=='string'||s.length>64000||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s))throw new MemoryInputError('CONFLICT');const value=Buffer.from(s,'base64');if(value.toString('base64')!==s||(size!==undefined&&value.length!==size))throw new MemoryInputError('CONFLICT');return value;};
   const nonce=decode(envelope.nonce,12),tag=decode(envelope.tag,16),ciphertext=decode(envelope.ciphertext);
   if(ciphertext.length<1||ciphertext.length>MEMORY_INPUT_LIMIT)throw new MemoryInputError('CONFLICT');
   const decipher=createDecipheriv('aes-256-gcm',key,nonce);decipher.setAAD(Buffer.from(JSON.stringify(h)));decipher.setAuthTag(tag);
   const partial=decipher.update(ciphertext);try{plain=Buffer.concat([partial,decipher.final()]);}finally{partial.fill(0);}
   if(hash(plain)!==b.inputDigest||!same(before,fstatSync(fd))||!same(before,lstatSync(path))||this.#scope()!==root)throw new MemoryInputError('CONFLICT');
   return {header:h,plain,stamp:before,path};
  }catch(e){plain?.fill(0);throw e;}finally{closeSync(fd);}
 }
 #time(h:Header,allowExpired=false){const now=this.now();if(!saveInteger(now))throw new MemoryInputError('UNAVAILABLE');if(now<h.createdAt)throw new MemoryInputError('CLOCK_ROLLBACK');if(!allowExpired&&now>=h.expiresAt)throw new MemoryInputError('EXPIRED');return now;}
 async stage(raw:MemoryInputBinding,input:Uint8Array,key:Uint8Array):Promise<Header>{
 if(writing.has(this.lease))throw new MemoryInputError('UNAVAILABLE');writing.add(this.lease);
 try{return await (async()=>{
  const b=canonical(raw);if(!(input instanceof Uint8Array)||input.length<1||input.length>MEMORY_INPUT_LIMIT||hash(input)!==b.inputDigest)throw new MemoryInputError('INVALID_INPUT');
  const secret=this.#key(key);try{
   const root=this.#scope(true),path=this.#path(root,b);
   if(this.#expiry(root,b,secret)!==null)throw new MemoryInputError('EXPIRED');
   try{lstatSync(path);const prior=this.#read(root,b,secret);try{this.#time(prior.header);return prior.header;}finally{prior.plain.fill(0);}}catch(e:any){if(e?.code!=='ENOENT')throw e;}
   const createdAt=this.now();if(!saveInteger(createdAt)||!saveInteger(createdAt+MEMORY_INPUT_TTL))throw new MemoryInputError('INVALID_INPUT');
   const header:Header={version:1,binding:b,createdAt,expiresAt:createdAt+MEMORY_INPUT_TTL};
   const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',secret,nonce);cipher.setAAD(Buffer.from(JSON.stringify(header)));
   const ciphertext=Buffer.concat([cipher.update(input),cipher.final()]);
   const payload=Buffer.from(JSON.stringify({header,nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}));
   let total=payload.length,count=1;const beforeScan=lstatSync(root);const dir=await opendir(root,{bufferSize:32});
   for await(const entry of dir){if(++count>4096)throw new MemoryInputError('BUDGET_PAUSED');const st=await lstat(join(root,entry.name));if(!st.isFile()||st.nlink!==1)throw new MemoryInputError('UNAVAILABLE');total+=st.size;if(total>TOTAL_LIMIT)throw new MemoryInputError('BUDGET_PAUSED');}
   if(!same(beforeScan,lstatSync(root)))throw new MemoryInputError('CONFLICT');
   this.#scope();this.#time(header);const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);let stamp:Stats;
   try{let offset=0;while(offset<payload.length){const n=writeSync(fd,payload,offset,payload.length-offset);if(!n)throw new MemoryInputError('UNAVAILABLE');offset+=n;}fsyncSync(fd);stamp=fstatSync(fd);}finally{closeSync(fd);}
   this.#sync(root);this.#scope();if(!same(stamp,lstatSync(path)))throw new MemoryInputError('CONFLICT');this.created.set(header,stamp);return header;
  }finally{secret.fill(0);}
 })();}catch(e){if(e instanceof MemoryInputError)throw e;throw new MemoryInputError('UNAVAILABLE');}finally{writing.delete(this.lease);}
 }
 read(raw:MemoryInputBinding,key:Uint8Array):Buffer{return this.#safe(()=>{
  if(writing.has(this.lease))throw new MemoryInputError('UNAVAILABLE');
  const b=canonical(raw),secret=this.#key(key);try{const root=this.#scope();if(this.#expiry(root,b,secret)!==null)throw new MemoryInputError('EXPIRED');const value=this.#read(root,b,secret);try{this.#time(value.header);return value.plain;}catch(e){value.plain.fill(0);throw e;}}finally{secret.fill(0);}
 });}
 /** Explicit per-save expiry, to be driven by a bounded host sweep. Authentication
  * precedes deletion. Missing keys/corrupt files stay unresolved for recovery.
  * A durable authenticated expiry marker precedes removal and prevents restaging.
  * This removes only ciphertext; durable job/coverage/attempt fences are untouched. */
 expire(raw:MemoryInputBinding,key:Uint8Array):boolean{return this.#safe(()=>{
  if(writing.has(this.lease))throw new MemoryInputError('UNAVAILABLE');
  const b=canonical(raw),secret=this.#key(key);try{const root=this.#scope(),expired=this.#expiry(root,b,secret);
   if(expired!==null){const now=this.now();if(!saveInteger(now)||now<expired)throw new MemoryInputError('CLOCK_ROLLBACK');try{lstatSync(this.#path(root,b));}catch(e:any){if(e?.code==='ENOENT')return true;throw e;}}
   const value=this.#read(root,b,secret);try{
   if(this.#time(value.header,true)<value.header.expiresAt)return false;
   if(expired===null)this.#markExpired(root,b,secret,value.header.expiresAt);
   this.#scope();if(!same(value.stamp,lstatSync(value.path)))throw new MemoryInputError('CONFLICT');unlinkSync(value.path);this.#sync(root);return true;
  }finally{value.plain.fill(0);}}finally{secret.fill(0);}
 });}

 /** Caller may discard only a file created and fully flushed by this store
  * instance, before starting any receipt transaction. Existing, partial or
  * uncertain files remain untouched. No permanent expiry marker is created. */
 discardCreated(header:Header,key:Uint8Array):boolean{return this.#safe(()=>{
  const created=this.created.get(header);
  if(this.namespace!=='precompaction-inputs'||writing.has(this.lease)||!created)return false;
  const secret=this.#key(key);try{
   const root=this.#scope(),binding=canonical(header.binding),value=this.#read(root,binding,secret);
   try{
    if(JSON.stringify(value.header)!==JSON.stringify(header)||!same(created,value.stamp))throw new MemoryInputError('CONFLICT');
    this.#time(value.header,true);this.#scope();
    if(!same(value.stamp,lstatSync(value.path)))throw new MemoryInputError('CONFLICT');
    unlinkSync(value.path);this.created.delete(header);this.#sync(root);return true;
   }finally{value.plain.fill(0);}
  }finally{secret.fill(0);}
 });}

 /** Whether anything (a file of any type, partial or not) already occupies this binding's staging path. A
  * pre-compaction capture records its write intent only when nothing is there yet, so the intent sweep below can
  * never claim a file that another attempt created. Creates only the private staging directory, as stage would. */
 exists(raw:MemoryInputBinding):boolean{return this.#safe(()=>{
  if(writing.has(this.lease))throw new MemoryInputError('UNAVAILABLE');
  const b=canonical(raw),path=this.#path(this.#scope(true),b);
  try{lstatSync(path);return true;}catch(e:any){if(e?.code==='ENOENT')return false;throw e;}
 });}

 /** Write-intent sweep, pre-compaction only. The caller proves under the app-data lease that the capture which
  * recorded an intent at `notBefore` is no longer in flight and never wrote a receipt. Only a file that authenticates
  * as exactly this binding and was created no earlier than that intent is removed. An expiry marker, a partial,
  * corrupt, linked or replaced file, or a clock rollback is 'retained' for manual recovery; no marker is written.
  * Lease, staging-root and key problems, at any step, throw instead, as do errno codes of the process such as
  * EMFILE, so the caller retries rather than giving up on the file. */
 discardUnreceipted(raw:MemoryInputBinding,key:Uint8Array,notBefore:number):'removed'|'absent'|'retained'{return this.#safe(()=>{
  if(this.namespace!=='precompaction-inputs'||writing.has(this.lease)||!saveInteger(notBefore))return 'retained';
  const keep=(e:unknown):'retained'=>{if(environmental.has(e as object)||PROCESS_ERRORS.has((e as {code?:string}|null)?.code??''))throw e;return 'retained';};
  const secret=this.#key(key);try{
   const root=this.#scope(true);let b:MemoryInputBinding,value:{header:Header;plain:Buffer;stamp:Stats;path:string};
   try{b=canonical(raw);if(this.#expiry(root,b,secret)!==null)return 'retained';}catch(e){return keep(e);}
   try{lstatSync(this.#path(root,b));}catch(e:any){return e?.code==='ENOENT'?'absent':keep(e);}
   try{value=this.#read(root,b,secret);}catch(e){return keep(e);}
   try{
    if(value.header.createdAt<notBefore)return 'retained';
    try{this.#time(value.header,true);}catch(e){return keep(e);}
    this.#scope();if(!same(value.stamp,lstatSync(value.path)))return 'retained';
    unlinkSync(value.path);this.#sync(root);return 'removed';
   }finally{value.plain.fill(0);}
  }finally{secret.fill(0);}
 });}
}
