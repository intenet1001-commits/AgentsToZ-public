import {constants} from 'node:fs';
import {open,lstat,realpath,rename,statfs} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {createHash,randomFillSync,randomUUID} from 'node:crypto';
import type {WorkspaceLease} from './workspaceLease';
import {MEMORY_DISK_LIMITS} from './memorySaveDiskAdmission';
export const MEMORY_RESERVE_FILES={data:'memory-emergency-reserve.bin',receipt:'memory-emergency-reserve.json',pending:'memory-emergency-reserve.json.next'} as const;
type State='preparing'|'ready'|'consumed'|'rearming';
interface Receipt {schemaVersion:1;state:State;generation:string;dev:string|null;ino:string|null;size:string;nextGeneration?:string;parentHash?:string}
export class MemoryReserveError extends Error {constructor(readonly code:'BUSY'|'RECOVERY_REQUIRED'|'STALE_GENERATION'|'LEASE_LOST'|'SPACE_LOW'|'UNAVAILABLE'){super(`Memory reserve: ${code}`);}}
const active=new WeakSet<WorkspaceLease>();
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const hash=(raw:string)=>createHash('sha256').update(raw).digest('hex');
const numeric=(v:unknown)=>typeof v==='string'&&/^\d{1,30}$/.test(v);
const missing=async(path:string)=>{try{await lstat(path);return false;}catch(e:any){if(e?.code==='ENOENT')return true;throw e;}};
type Handle=Awaited<ReturnType<typeof open>>;
/** Host-only reserve lifecycle. The caller owns an app-data directory lease;
 * this class never reclaims a dead lease, invokes AI, or touches project memory. */
export class MemoryEmergencyReserve {
  constructor(private root:string,private lease:WorkspaceLease,private deps:{
    freeBytes?:(root:string)=>Promise<bigint>;
    checkpoint?:(phase:string,state:State)=>Promise<void>;
  }={}){}
  #canonical='';#dev=0n;#ino=0n;
  async #validate(){
    if(!this.lease.refresh())throw new MemoryReserveError('LEASE_LOST');
    const st=await lstat(this.#canonical,{bigint:true});
    if(!st.isDirectory()||st.dev!==this.#dev||st.ino!==this.#ino||await realpath(this.root)!==this.#canonical)throw new MemoryReserveError('LEASE_LOST');
  }
  async #run<T>(fn:()=>Promise<T>):Promise<T>{
    if(active.has(this.lease))throw new MemoryReserveError('BUSY');active.add(this.lease);
    try{
      if(!isAbsolute(this.root)||(await lstat(this.root)).isSymbolicLink())throw new MemoryReserveError('LEASE_LOST');
      this.#canonical=await realpath(this.root);
      if(this.lease.identity.kind!=='directory'||this.lease.identity.canonicalWorkspacePath!==this.#canonical)throw new MemoryReserveError('LEASE_LOST');
      const st=await lstat(this.#canonical,{bigint:true});this.#dev=st.dev;this.#ino=st.ino;
      await this.#validate();return await fn();
    }catch(e){if(e instanceof MemoryReserveError)throw e;throw new MemoryReserveError('UNAVAILABLE');}
    finally{active.delete(this.lease);}
  }
  #path(name:keyof typeof MEMORY_RESERVE_FILES){return join(this.#canonical,MEMORY_RESERVE_FILES[name]);}
  async #syncDir(){await this.#validate();const fd=await open(this.#canonical,constants.O_RDONLY|constants.O_NOFOLLOW);try{await fd.sync();}finally{await fd.close();}}
  async #read(name:'receipt'|'pending'):Promise<{value:Receipt;raw:string}|null>{
    if(await missing(this.#path(name)))return null;
    const fd=await open(this.#path(name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{
      const st=await fd.stat({bigint:true});
      if(!st.isFile()||st.nlink!==1n||st.size<1n||st.size>4096n||(process.platform!=='win32'&&(st.mode&0o077n)!==0n))throw new MemoryReserveError('RECOVERY_REQUIRED');
      const bytes=Buffer.alloc(Number(st.size));const r=await fd.read(bytes,0,bytes.length,0);if(r.bytesRead!==bytes.length)throw new MemoryReserveError('RECOVERY_REQUIRED');
      const raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes),v=JSON.parse(raw) as Receipt;
      const after=await fd.stat({bigint:true}),live=await lstat(this.#path(name),{bigint:true});
      if(after.mtimeNs!==st.mtimeNs||after.ctimeNs!==st.ctimeNs||live.ino!==st.ino||live.dev!==st.dev)throw new MemoryReserveError('RECOVERY_REQUIRED');
      if(v.schemaVersion!==1||!['preparing','ready','consumed','rearming'].includes(v.state)||!uuid(v.generation)||v.size!==String(MEMORY_DISK_LIMITS.reserve)
        ||!((v.dev===null&&v.ino===null&&v.state==='preparing')||(numeric(v.dev)&&numeric(v.ino)))
        ||(v.state==='rearming'&&!uuid(v.nextGeneration))||(v.nextGeneration!==undefined&&v.state!=='rearming')||(v.parentHash!==undefined&&!/^[a-f0-9]{64}$/.test(v.parentHash)))throw new MemoryReserveError('RECOVERY_REQUIRED');
      return {value:v,raw};
    }finally{await fd.close();}
  }
  async #writeAll(fd:Handle,bytes:Buffer,position:number){let offset=0;while(offset<bytes.length){const r=await fd.write(bytes,offset,bytes.length-offset,position+offset);if(!r.bytesWritten)throw new MemoryReserveError('UNAVAILABLE');offset+=r.bytesWritten;}}
  async #save(next:Receipt,current:{value:Receipt;raw:string}|null){
    await this.#validate();if(!await missing(this.#path('pending')))throw new MemoryReserveError('RECOVERY_REQUIRED');
    const name=current?'pending':'receipt';
    const value={...next,...(current?{parentHash:hash(current.raw)}:{})};const raw=JSON.stringify(value);
    const fd=await open(this.#path(name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{await this.#writeAll(fd,Buffer.from(raw),0);await fd.sync();}finally{await fd.close();}
    if(current){
      await this.deps.checkpoint?.('pending-synced',next.state);await this.#validate();
      const fresh=await this.#read('receipt');if(fresh?.raw!==current.raw)throw new MemoryReserveError('RECOVERY_REQUIRED');
      await rename(this.#path('pending'),this.#path('receipt'));
    }
    await this.#syncDir();return {value,raw};
  }
  async #data(receipt:Receipt):Promise<Handle>{
    if(receipt.dev===null||receipt.ino===null)throw new MemoryReserveError('RECOVERY_REQUIRED');
    const fd=await open(this.#path('data'),constants.O_RDWR|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{
      const st=await fd.stat({bigint:true});const live=await lstat(this.#path('data'),{bigint:true});
      if(!st.isFile()||st.nlink!==1n||String(st.dev)!==receipt.dev||String(st.ino)!==receipt.ino||st.dev!==this.#dev||st.size>MEMORY_DISK_LIMITS.reserve
        ||live.ino!==st.ino||live.dev!==st.dev||(process.platform!=='win32'&&(st.mode&0o077n)!==0n))throw new MemoryReserveError('RECOVERY_REQUIRED');
      return fd;
    }catch(e){await fd.close();throw e;}
  }
  async #allocated(receipt:Receipt){const fd=await this.#data(receipt);try{const st=await fd.stat({bigint:true});return st.size===MEMORY_DISK_LIMITS.reserve&&st.blocks*512n>=st.size;}finally{await fd.close();}}
  async #space(){const free=this.deps.freeBytes?await this.deps.freeBytes(this.#canonical):await statfs(this.#canonical,{bigint:true}).then(s=>s.bavail*s.bsize);if(typeof free!=='bigint'||free<MEMORY_DISK_LIMITS.free+MEMORY_DISK_LIMITS.reserve)throw new MemoryReserveError('SPACE_LOW');}
  async #allocate(current:{value:Receipt;raw:string}){
    await this.#space();await this.#validate();
    if(current.value.dev===null){
      if(!await missing(this.#path('data')))throw new MemoryReserveError('RECOVERY_REQUIRED');
      const fresh=await open(this.#path('data'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      let dev:string,ino:string;try{await fresh.sync();const st=await fresh.stat({bigint:true});dev=String(st.dev);ino=String(st.ino);}finally{await fresh.close();}
      await this.#syncDir();current=await this.#save({...current.value,dev,ino},current);
    }
    await this.deps.checkpoint?.('file-bound',current.value.state);
    const fd=await this.#data(current.value);
    try{
      const buffer=Buffer.alloc(64*1024);
      for(let pos=0;pos<Number(MEMORY_DISK_LIMITS.reserve);pos+=buffer.length){await this.#validate();randomFillSync(buffer);await this.#writeAll(fd,buffer,pos);}
      await fd.sync();
    }finally{await fd.close();}
    if(!await this.#allocated(current.value))throw new MemoryReserveError('RECOVERY_REQUIRED');
    await this.deps.checkpoint?.('allocated',current.value.state);
    const ready:Receipt={schemaVersion:1,state:'ready',generation:current.value.nextGeneration??current.value.generation,dev:current.value.dev,ino:current.value.ino,size:current.value.size};
    current=await this.#save(ready,current);return {state:'ready' as const,generation:current.value.generation};
  }
  async ensure(){return this.#run(async()=>{
    if(!await missing(this.#path('pending')))throw new MemoryReserveError('RECOVERY_REQUIRED');
    let current=await this.#read('receipt');
    if(current){if(current.value.state!=='ready'||!await this.#allocated(current.value))throw new MemoryReserveError('RECOVERY_REQUIRED');await this.#syncDir();return {state:'ready' as const,generation:current.value.generation};}
    if(!await missing(this.#path('data')))throw new MemoryReserveError('RECOVERY_REQUIRED');
    await this.#space();current=await this.#save({schemaVersion:1,state:'preparing',generation:randomUUID(),dev:null,ino:null,size:String(MEMORY_DISK_LIMITS.reserve)},null);
    await this.deps.checkpoint?.('preparing-saved','preparing');return this.#allocate(current);
  });}
  async consume(expectedGeneration:string){return this.#run(async()=>{
    if(!uuid(expectedGeneration))throw new MemoryReserveError('STALE_GENERATION');
    if(!await missing(this.#path('pending')))throw new MemoryReserveError('RECOVERY_REQUIRED');
    let current=await this.#read('receipt');if(!current||current.value.generation!==expectedGeneration)throw new MemoryReserveError('STALE_GENERATION');
    if(!['ready','consumed'].includes(current.value.state))throw new MemoryReserveError('RECOVERY_REQUIRED');
    if(current.value.state==='ready'){
      if(!await this.#allocated(current.value))throw new MemoryReserveError('RECOVERY_REQUIRED');
      current=await this.#save({...current.value,state:'consumed'},current);
    }
    await this.deps.checkpoint?.('consumed-saved','consumed');await this.#validate();
    const fd=await this.#data(current.value);try{await this.#validate();await fd.truncate(0);await fd.sync();}finally{await fd.close();}
    await this.deps.checkpoint?.('released','consumed');return {state:'consumed' as const,generation:expectedGeneration};
  });}
  /** hostRecovered must verify previous work/receipt reconciliation, not merely
   * a dead PID or elapsed time. Missing/unowned data is never adopted or deleted. */
  async recover(expectedGeneration:string,hostRecovered:()=>Promise<boolean>){return this.#run(async()=>{
    let current=await this.#read('receipt');if(!current||current.value.generation!==expectedGeneration)throw new MemoryReserveError('STALE_GENERATION');
    if(!await hostRecovered())throw new MemoryReserveError('RECOVERY_REQUIRED');await this.#validate();
    if((await this.#read('receipt'))?.raw!==current.raw)throw new MemoryReserveError('RECOVERY_REQUIRED');
    const pending=await this.#read('pending');
    if(pending){
      const a=current.value,b=pending.value;
      const same=b.generation===a.generation;
      const transition=(a.state==='preparing'&&same&&['preparing','ready'].includes(b.state))
        ||(a.state==='ready'&&same&&b.state==='consumed')||(a.state==='consumed'&&same&&b.state==='rearming')
        ||(a.state==='rearming'&&b.state==='ready'&&b.generation===a.nextGeneration);
      if(pending.value.parentHash!==hash(current.raw)||!transition||(a.dev!==null&&(a.dev!==b.dev||a.ino!==b.ino)))throw new MemoryReserveError('RECOVERY_REQUIRED');
      const fd=await this.#data(b);await fd.close();if(b.state==='ready'&&!await this.#allocated(b))throw new MemoryReserveError('RECOVERY_REQUIRED');
      await this.#validate();await rename(this.#path('pending'),this.#path('receipt'));await this.#syncDir();current=pending;
    }
    if(current.value.state==='ready'){if(!await this.#allocated(current.value))throw new MemoryReserveError('RECOVERY_REQUIRED');return {state:'ready' as const,generation:current.value.generation};}
    if(current.value.state==='consumed')current=await this.#save({...current.value,state:'rearming',nextGeneration:randomUUID()},current);
    return this.#allocate(current);
  });}
}
