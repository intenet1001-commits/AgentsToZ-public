import {createHash,randomBytes} from 'node:crypto';
import {constants,openSync,closeSync,lstatSync,fstatSync,readSync,writeSync,fsyncSync,renameSync,realpathSync} from 'node:fs';
import {opendir} from 'node:fs/promises';
import {join} from 'node:path';
import {Database,constants as sqlite} from 'bun:sqlite';
import {readMemorySaveInputKey,addMemorySaveInputKey,MemoryInputKeyError,memoryInputKeyAccount} from './memorySaveInputKeyProvider';
import {saveHash} from './memorySaveContract';
import type {WorkspaceLease} from './workspaceLease';

export const MEMORY_SAVE_KEY_FILE='memory-save-key.json';
export type MemorySaveKeyStatus='not-configured'|'registered'|'setup-incomplete'|'unavailable'|'unsupported';
export class MemorySaveKeyLifecycleError extends Error {
 constructor(readonly code:'UNAVAILABLE'|'LEASE_LOST'|'KEY_LOST'|'KEY_CHANGED'|'HISTORY_EXISTS'|'SETUP_INCOMPLETE'|'UNSUPPORTED') {super(`Memory save key: ${code}`);}
}
interface Marker {version:1;account:string;fingerprint:string;state:'creating'|'ready';parentHash:string|null}
interface Record {value:Marker;raw:Buffer;dev:number;ino:number;mtimeMs:number;ctimeMs:number}
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const active=new WeakSet<WorkspaceLease>();
/** Marker contains only a key fingerprint. It cannot recover a lost key. Read
 * status never touches Keychain, creates an identity/database, or prompts macOS. */
export class MemorySaveKeyLifecycle {
 constructor(readonly appDataRoot:string,readonly installationId:string,private deps:{
  platform?:string;readKey?:()=>Promise<Buffer>;addKey?:(key:Buffer)=>Promise<void>;
 }={}){}
 #account(){return memoryInputKeyAccount(this.installationId);}
 #platform(){return this.deps.platform??process.platform;}
 #root(){const st=lstatSync(this.appDataRoot);if(!st.isDirectory()||realpathSync(this.appDataRoot)!==this.appDataRoot)throw new MemorySaveKeyLifecycleError('UNAVAILABLE');return st;}
 #read(pending=false):Record|null {
  const path=join(this.appDataRoot,MEMORY_SAVE_KEY_FILE+(pending?'.next':''));let fd:number;
  try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(e:any){if(e?.code==='ENOENT')return null;throw new MemorySaveKeyLifecycleError('UNAVAILABLE');}
  try{
   const st=fstatSync(fd);if(!st.isFile()||st.nlink!==1||st.size<1||st.size>4096||(process.platform!=='win32'&&(st.mode&0o077)!==0))throw new Error();
   const raw=Buffer.alloc(st.size);if(readSync(fd,raw,0,raw.length,0)!==raw.length)throw new Error();
   const after=fstatSync(fd),live=lstatSync(path);if(after.mtimeMs!==st.mtimeMs||after.ctimeMs!==st.ctimeMs||after.size!==st.size||live.ino!==st.ino||live.dev!==st.dev)throw new Error();
   const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)) as Marker;
   if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['version','account','fingerprint','state','parentHash'].includes(k))
    ||value.version!==1||value.account!==this.#account()||!saveHash(value.fingerprint)||!['creating','ready'].includes(value.state)||(value.parentHash!==null&&!saveHash(value.parentHash)))throw new Error();
   return {value,raw,dev:st.dev,ino:st.ino,mtimeMs:st.mtimeMs,ctimeMs:st.ctimeMs};
  }catch{throw new MemorySaveKeyLifecycleError('UNAVAILABLE');}finally{closeSync(fd);}
 }
 status():MemorySaveKeyStatus {
  if(this.#platform()!=='darwin')return 'unsupported';
  try{this.#root();if(this.#read(true))return 'setup-incomplete';const marker=this.#read();return !marker?'not-configured':marker.value.state==='ready'?'registered':'setup-incomplete';}catch{return 'unavailable';}
 }
 #readKey(){return this.deps.readKey?.()??readMemorySaveInputKey({installationId:this.installationId,platform:this.#platform()});}
 async #key():Promise<Buffer|null>{try{return await this.#readKey();}catch(e){if(e instanceof MemoryInputKeyError&&e.code==='MISSING')return null;throw new MemorySaveKeyLifecycleError('UNAVAILABLE');}}
 #checkKey(key:Buffer,marker:Pick<Marker,'fingerprint'>){if(!Buffer.isBuffer(key)||key.length!==32||hash(key)!==marker.fingerprint)throw new MemorySaveKeyLifecycleError('KEY_CHANGED');}
 async load():Promise<Buffer>{
  if(this.#platform()!=='darwin')throw new MemorySaveKeyLifecycleError('UNSUPPORTED');
  const root=this.#root();const marker=this.#read();if(this.#read(true)||!marker||marker.value.state!=='ready')throw new MemorySaveKeyLifecycleError('SETUP_INCOMPLETE');
  const key=await this.#key();if(!key)throw new MemorySaveKeyLifecycleError('KEY_LOST');
  try{this.#checkKey(key,marker.value);const current=this.#root(),fresh=this.#read();if(current.dev!==root.dev||current.ino!==root.ino||!fresh||!fresh.raw.equals(marker.raw)||this.#read(true))throw new MemorySaveKeyLifecycleError('UNAVAILABLE');return key;}
  catch(e){key.fill(0);throw e;}
 }
 async #virgin(){
  for(const name of ['memory-save-inputs','memory-save-manifests']){
   const path=join(this.appDataRoot,name);try{if(!lstatSync(path).isDirectory())throw new Error();const dir=await opendir(path,{bufferSize:32});for await(const _ of dir)throw new MemorySaveKeyLifecycleError('HISTORY_EXISTS');}
   catch(e:any){if(e?.code==='ENOENT')continue;if(e instanceof MemorySaveKeyLifecycleError)throw e;throw new MemorySaveKeyLifecycleError('UNAVAILABLE');}
  }
  const path=join(this.appDataRoot,'memory-save-v2.sqlite');let db:Database|undefined;
  try{try{const st=lstatSync(path);if(!st.isFile()||st.nlink!==1)throw new Error();}catch(e:any){if(e?.code==='ENOENT')return;throw e;}
   db=new Database(path,sqlite.SQLITE_OPEN_READONLY|sqlite.SQLITE_OPEN_NOFOLLOW);db.run('PRAGMA busy_timeout=100');db.run('PRAGMA cache_size=-256');
   const version=(db.query('PRAGMA user_version').get() as {user_version:number}).user_version;
   if(version<1||version>7)throw new Error();if(db.query('SELECT 1 FROM save_jobs LIMIT 1').get())throw new MemorySaveKeyLifecycleError('HISTORY_EXISTS');
  }catch(e){if(e instanceof MemorySaveKeyLifecycleError)throw e;throw new MemorySaveKeyLifecycleError('UNAVAILABLE');}finally{db?.close();}
 }
 /** Only this explicit host operation can create a key. Lost READY keys never
  * rotate. Recovery may restart an incomplete first setup only with no history. */
 async prepare(lease:WorkspaceLease,validate:()=>Promise<boolean>,recoverInitial=false):Promise<MemorySaveKeyStatus>{
  if(this.#platform()!=='darwin')throw new MemorySaveKeyLifecycleError('UNSUPPORTED');
  if(active.has(lease))throw new MemorySaveKeyLifecycleError('LEASE_LOST');
  const root=this.#root();active.add(lease);let key:Buffer|null=null;
  const valid=async()=>{const current=this.#root();if(!lease.refresh()||lease.identity.kind!=='directory'||lease.identity.canonicalWorkspacePath!==this.appDataRoot||current.dev!==root.dev||current.ino!==root.ino||!await validate()||!lease.refresh())throw new MemorySaveKeyLifecycleError('LEASE_LOST');};
  const sync=()=>{const fd=openSync(this.appDataRoot,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}};
  const settle=async()=>{const pending=this.#read(true);if(!pending)return;const prior=this.#read();if(pending.value.parentHash!==(prior?hash(prior.raw):null))throw new MemorySaveKeyLifecycleError('UNAVAILABLE');await valid();
   const fresh=this.#read(true),live=this.#read();if(!fresh||fresh.ino!==pending.ino||fresh.dev!==pending.dev||!fresh.raw.equals(pending.raw)||(live?hash(live.raw):null)!==(prior?hash(prior.raw):null))throw new MemorySaveKeyLifecycleError('UNAVAILABLE');
   renameSync(join(this.appDataRoot,MEMORY_SAVE_KEY_FILE+'.next'),join(this.appDataRoot,MEMORY_SAVE_KEY_FILE));sync();};
  const save=async(value:Omit<Marker,'parentHash'>)=>{
   await valid();const prior=this.#read();if(this.#read(true))throw new MemorySaveKeyLifecycleError('SETUP_INCOMPLETE');
   const raw=Buffer.from(JSON.stringify({...value,parentHash:prior?hash(prior.raw):null}));const path=join(this.appDataRoot,MEMORY_SAVE_KEY_FILE+'.next');
   const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{let at=0;while(at<raw.length){const n=writeSync(fd,raw,at,raw.length-at);if(!n)throw new Error();at+=n;}fsyncSync(fd);}finally{closeSync(fd);}sync();await settle();
  };
  try{
   await valid();await settle();let marker=this.#read();key=await this.#key();await valid();
   if(marker?.value.state==='ready'){if(!key)throw new MemorySaveKeyLifecycleError('KEY_LOST');this.#checkKey(key,marker.value);return 'registered';}
   if(marker&&key){this.#checkKey(key,marker.value);await save({...marker.value,state:'ready'});return 'registered';}
   if(marker&&!recoverInitial)throw new MemorySaveKeyLifecycleError('SETUP_INCOMPLETE');
   await this.#virgin();await valid();
   if(key){await save({version:1,account:this.#account(),fingerprint:hash(key),state:'ready'});return 'registered';}
   key=randomBytes(32);const next={version:1 as const,account:this.#account(),fingerprint:hash(key),state:'creating' as const};await save(next);
   await this.#virgin();await valid();
   // An uncertain add is resolved by reading back the exact fingerprint. Neither
   // failure nor a competing item permits -U or deletion of a Keychain item.
   try{if(this.deps.addKey)await this.deps.addKey(key);else await addMemorySaveInputKey({installationId:this.installationId,key,platform:this.#platform()});}catch{}
   key.fill(0);key=await this.#key();await valid();if(!key)throw new MemorySaveKeyLifecycleError('SETUP_INCOMPLETE');this.#checkKey(key,next);
   await save({...next,state:'ready'});return 'registered';
  }catch(e){if(e instanceof MemorySaveKeyLifecycleError)throw e;throw new MemorySaveKeyLifecycleError('UNAVAILABLE');}
  finally{key?.fill(0);active.delete(lease);}
 }
}
