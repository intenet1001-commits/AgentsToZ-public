import {constants} from 'node:fs';
import {open,opendir,lstat,realpath,statfs} from 'node:fs/promises';
import {join,basename,dirname,isAbsolute} from 'node:path';
import type {MemorySaveStore} from './memorySaveStore';
import {MemorySaveError,type MemorySaveAttemptIntent} from './memorySaveContract';
const MiB=1024n*1024n,GiB=1024n*MiB;
export const MEMORY_DISK_LIMITS={free:2n*GiB,receiptsWarning:250n*MiB,receipts:GiB,wal:64n*MiB,inputs:64n*MiB,manifests:512n*MiB,reserve:32n*MiB} as const;
export type MemoryDiskReason='ready'|'invalid-input'|'unavailable'|'inventory-incomplete'|'receipts-full'|'wal-full'|'inputs-full'|'manifests-full'|'free-space-low'|'reserve-unavailable'|'scope-changed';
/** plannedInputBytes includes the encrypted envelope (plaintext is separately capped at 48,000). */
export interface MemoryDiskScope {appDataRoot:string;memoryRoot:string;plannedInputBytes:number;plannedManifestBytes:number}
export interface MemoryDiskAdmission {
  allowed:boolean;reason:MemoryDiskReason;warning:boolean;
  usage:{receiptsBytes:string;walBytes:string;inputBytes:string|null;manifestBytes:string|null;appFreeBytes:string;memoryFreeBytes:string}|null;
}
export class MemoryDiskAdmissionError extends Error {constructor(readonly reason:MemoryDiskReason){super(`Memory disk admission: ${reason}`);}}
const fail=(reason:MemoryDiskReason,usage:MemoryDiskAdmission['usage']=null):MemoryDiskAdmission=>({allowed:false,reason,warning:false,usage});
async function rootIdentity(path:string){
  if(!(await lstat(path)).isDirectory())throw new MemoryDiskAdmissionError('scope-changed');
  const canonical=await realpath(path);const st=await lstat(canonical,{bigint:true});
  if(!st.isDirectory())throw new MemoryDiskAdmissionError('scope-changed');
  return {canonical,dev:st.dev,ino:st.ino};
}
async function regularSize(path:string):Promise<bigint>{
  try{const st=await lstat(path,{bigint:true});if(!st.isFile()||st.nlink!==1n)throw new MemoryDiskAdmissionError('inventory-incomplete');return st.size;}
  catch(error:any){if(error?.code==='ENOENT')return 0n;throw error;}
}
/** No whole-tree arrays. The scan fails closed on special entries, over 4096
 * entries, deep trees or directory mutation. Unresolved files are never pruned. */
async function treeBytes(path:string,limit:bigint,fullReason:'inputs-full'|'manifests-full'):Promise<bigint>{
  let total=0n,entries=0;
  async function walk(dir:string,depth:number):Promise<void>{
    if(depth>8)throw new MemoryDiskAdmissionError('inventory-incomplete');
    const before=await lstat(dir,{bigint:true});if(!before.isDirectory())throw new MemoryDiskAdmissionError('inventory-incomplete');
    const handle=await opendir(dir,{bufferSize:32});
    for await(const entry of handle){
      if(++entries>4096)throw new MemoryDiskAdmissionError('inventory-incomplete');
      const child=join(dir,entry.name),st=await lstat(child,{bigint:true});
      if(st.isDirectory())await walk(child,depth+1);
      else if(st.isFile()&&st.nlink===1n)total+=st.size;
      else throw new MemoryDiskAdmissionError('inventory-incomplete');
      if(total>limit)throw new MemoryDiskAdmissionError(fullReason);
    }
    const after=await lstat(dir,{bigint:true});
    if(after.dev!==before.dev||after.ino!==before.ino||after.mtimeNs!==before.mtimeNs||after.ctimeNs!==before.ctimeNs)throw new MemoryDiskAdmissionError('inventory-incomplete');
  }
  try{await lstat(path);}catch(error:any){if(error?.code==='ENOENT')return 0n;throw error;}
  await walk(path,0);return total;
}
async function reserveReady(root:string,dev:bigint):Promise<boolean>{
  let receipt:Awaited<ReturnType<typeof open>>|undefined,reserve:Awaited<ReturnType<typeof open>>|undefined;
  try{
    try{await lstat(join(root,'memory-emergency-reserve.json.next'));return false;}catch(error:any){if(error?.code!=='ENOENT')return false;}
    receipt=await open(join(root,'memory-emergency-reserve.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const meta=await receipt.stat({bigint:true});
    if(!meta.isFile()||meta.nlink!==1n||meta.size>4096n||meta.size<1n)return false;
    if(process.platform!=='win32'&&(meta.mode&0o077n)!==0n)return false;
    const buffer=Buffer.alloc(Number(meta.size));const read=await receipt.read(buffer,0,buffer.length,0);if(read.bytesRead!==buffer.length)return false;
    const proof=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer));
    const afterMeta=await receipt.stat({bigint:true});
    if(afterMeta.size!==meta.size||afterMeta.mtimeNs!==meta.mtimeNs||afterMeta.ctimeNs!==meta.ctimeNs)return false;
    reserve=await open(join(root,'memory-emergency-reserve.bin'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const st=await reserve.stat({bigint:true});
    const liveMeta=await lstat(join(root,'memory-emergency-reserve.json'),{bigint:true});
    const liveReserve=await lstat(join(root,'memory-emergency-reserve.bin'),{bigint:true});
    if(liveMeta.dev!==meta.dev||liveMeta.ino!==meta.ino||liveMeta.mtimeNs!==meta.mtimeNs||liveMeta.ctimeNs!==meta.ctimeNs||liveReserve.dev!==st.dev||liveReserve.ino!==st.ino||liveReserve.size!==st.size||liveReserve.blocks!==st.blocks||liveReserve.mtimeNs!==st.mtimeNs||liveReserve.ctimeNs!==st.ctimeNs)return false;
    try{await lstat(join(root,'memory-emergency-reserve.json.next'));return false;}catch(error:any){if(error?.code!=='ENOENT')return false;}
    return st.isFile()&&st.nlink===1n&&st.dev===dev&&st.size===MEMORY_DISK_LIMITS.reserve&&st.blocks*512n>=st.size
      &&(process.platform==='win32'||(st.mode&0o077n)===0n)&&proof.schemaVersion===1&&proof.state==='ready'
      &&typeof proof.generation==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(proof.generation)
      &&proof.dev===String(st.dev)&&proof.ino===String(st.ino)&&proof.size===String(st.size);
  }catch{return false;}finally{await reserve?.close();await receipt?.close();}
}

/** Read-only preflight, not a filesystem space reservation. The future sole
 * writer must hold its workspace/staging lease across this check and admission.
 * probeFree is an injectable platform measurement for isolated failure tests. */
export async function checkMemorySaveDiskAdmission(scope:MemoryDiskScope,probeFree:(path:string)=>Promise<bigint>=async path=>{const s=await statfs(path,{bigint:true});return s.bavail*s.bsize;}):Promise<MemoryDiskAdmission>{
  if(!scope||![scope.appDataRoot,scope.memoryRoot].every(p=>typeof p==='string'&&p.length>0&&p.length<=4096&&isAbsolute(p)&&!/[\0\r\n]/.test(p))
    ||![scope.plannedInputBytes,scope.plannedManifestBytes].every(n=>Number.isSafeInteger(n)&&n>=0)
    ||scope.plannedInputBytes>70000||BigInt(scope.plannedManifestBytes)>MEMORY_DISK_LIMITS.manifests)return fail('invalid-input');
  try{
    const app=await rootIdentity(scope.appDataRoot),memory=await rootIdentity(scope.memoryRoot);
    let receipts=0n,wal=0n;
    for(const name of ['memory-save-v2.sqlite','memory-observation-cursors.sqlite']){
      receipts+=await regularSize(join(app.canonical,name));
      receipts+=await regularSize(join(app.canonical,name+'-journal'));
      for(const suffix of ['-wal','-shm']){const size=await regularSize(join(app.canonical,name+suffix));receipts+=size;wal+=size;}
    }
    const appFree=await probeFree(app.canonical),memoryFree=app.dev===memory.dev?appFree:await probeFree(memory.canonical);
    if(typeof appFree!=='bigint'||typeof memoryFree!=='bigint'||appFree<0n||memoryFree<0n)return fail('unavailable');
    const usage:NonNullable<MemoryDiskAdmission['usage']>={receiptsBytes:String(receipts),walBytes:String(wal),inputBytes:null,manifestBytes:null,appFreeBytes:String(appFree),memoryFreeBytes:String(memoryFree)};
    if(receipts>=MEMORY_DISK_LIMITS.receipts)return fail('receipts-full',usage);
    if(wal>MEMORY_DISK_LIMITS.wal)return fail('wal-full',usage);
    const inputs=await treeBytes(join(app.canonical,'memory-save-inputs'),MEMORY_DISK_LIMITS.inputs,'inputs-full');
    let manifests=await treeBytes(join(app.canonical,'memory-save-manifests'),MEMORY_DISK_LIMITS.manifests,'manifests-full');
    // Host-owned proposals include before/after documents and must share the
    // staging budget rather than grow outside it in a separate SQLite file.
    for(const suffix of ['', '-journal', '-wal', '-shm'])manifests+=await regularSize(join(app.canonical,'memory-session-recovery.sqlite'+suffix));
    usage.inputBytes=String(inputs);usage.manifestBytes=String(manifests);
    if(inputs+BigInt(scope.plannedInputBytes)>MEMORY_DISK_LIMITS.inputs)return fail('inputs-full',usage);
    if(manifests+BigInt(scope.plannedManifestBytes)>MEMORY_DISK_LIMITS.manifests)return fail('manifests-full',usage);
    const required=MEMORY_DISK_LIMITS.free+BigInt(scope.plannedInputBytes)+BigInt(scope.plannedManifestBytes);
    if(appFree<required||memoryFree<required)return fail('free-space-low',usage);
    if(!await reserveReady(app.canonical,app.dev))return fail('reserve-unavailable',usage);
    const afterApp=await rootIdentity(scope.appDataRoot),afterMemory=await rootIdentity(scope.memoryRoot);
    if(afterApp.dev!==app.dev||afterApp.ino!==app.ino||afterMemory.dev!==memory.dev||afterMemory.ino!==memory.ino)return fail('scope-changed');
    return {allowed:true,reason:'ready',warning:receipts>=MEMORY_DISK_LIMITS.receiptsWarning,usage};
  }catch(error){return fail(error instanceof MemoryDiskAdmissionError?error.reason:'unavailable');}
}

/** Internal composition only; no route, timer or provider process is created. */
export async function beginDiskCheckedAutomaticMemoryAttempt(options:{store:MemorySaveStore;saveId:string;coverageDigest:string;policyRevision:number;intent:MemorySaveAttemptIntent;scope:MemoryDiskScope;validateLeaseAndRegistration:()=>Promise<boolean>},probeFree?:(path:string)=>Promise<bigint>,monotonicNow:()=>number=()=>performance.now()):Promise<string>{
 try{
  if(!await options.validateLeaseAndRegistration())throw new MemoryDiskAdmissionError('scope-changed');
  if(basename(options.store.path)!=='memory-save-v2.sqlite'||await realpath(dirname(options.store.path))!==await realpath(options.scope.appDataRoot))throw new MemoryDiskAdmissionError('scope-changed');
  const checkedAt=monotonicNow();
  const result=await checkMemorySaveDiskAdmission(options.scope,probeFree);
  if(!result.allowed)throw new MemoryDiskAdmissionError(result.reason);
  if(!await options.validateLeaseAndRegistration())throw new MemoryDiskAdmissionError('scope-changed');
  const age=monotonicNow()-checkedAt;if(!Number.isFinite(age)||age<0||age>5000)throw new MemoryDiskAdmissionError('unavailable');
  return options.store.beginAutomaticAttempt(options.saveId,options.coverageDigest,options.policyRevision,options.intent);
 }catch(error){if(error instanceof MemoryDiskAdmissionError||error instanceof MemorySaveError)throw error;throw new MemoryDiskAdmissionError('unavailable');}
}
