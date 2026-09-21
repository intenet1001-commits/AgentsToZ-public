import {constants,openSync,closeSync,readSync,writeSync,fsyncSync,mkdirSync,fstatSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {basename,dirname,isAbsolute,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {claudeProjectSlugCandidates} from './sessionTranscript';
import {recentSessionFiles,type RecentSessionFile} from './recentSessionFiles';
import {saveDigest,saveToken} from './memorySaveContract';
import type {MemoryObservationCandidate} from './memoryObservationCoordinator';

/** A separate, local installation identity. Corruption never silently creates a new lineage. */
export function memoryObservationInstanceId(path:string,dataAlreadyExists:()=>boolean=()=>false):string {
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  let fd:number|undefined;
  try{
    try{
      // Existing durable observations must not acquire a new owner after identity loss.
      let missing=false;
      try{const existing=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);closeSync(existing);}
      catch(error:any){if(error?.code!=='ENOENT')throw error;missing=true;}
      if(missing){
        if(dataAlreadyExists())throw new Error('Observation identity recovery required');
        fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);writeSync(fd,randomUUID());fsyncSync(fd);closeSync(fd);fd=undefined;
        if(process.platform!=='win32'){const directory=openSync(dirname(path),constants.O_RDONLY);try{fsyncSync(directory);}finally{closeSync(directory);}}
      }
    }
    catch(error:any){if(error?.code!=='EEXIST')throw error;}
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const stat=fstatSync(fd);if(!stat.isFile()||stat.size!==36)throw new Error('Invalid observation identity');
    const bytes=Buffer.alloc(36);if(readSync(fd,bytes,0,36,0)!==36)throw new Error('Invalid observation identity');
    const id=bytes.toString();if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id))throw new Error('Invalid observation identity');return id;
  }finally{if(fd!==undefined)closeSync(fd);}
}

/** Recent active-session discovery only, not a whole-history backfill. Header metadata
 * is capped at 128 cached files and 2 MiB of actual reads per project discovery. */
export class MemoryObservationDiscovery {
  #cache=new Map<string,{stamp:string;expires:number;meta:{id:string;cwd:string}|null}>();
  constructor(private deps:{codexRoot:string;claudeRoot:string;codexFiles:()=>Promise<RecentSessionFile[]>;now?:()=>number}){}
  async discover(cwd:string):Promise<MemoryObservationCandidate[]>{
    const candidates:MemoryObservationCandidate[]=[];
    let readBudget=2*1024*1024;
    const now=this.deps.now?.()??Date.now();
    for(const file of (await this.deps.codexFiles()).slice(0,96)){
      const stamp=`${file.size}:${file.mtimeMs}`;
      let cached=this.#cache.get(file.full);
      if(!cached||cached.stamp!==stamp||cached.expires<=now){
        if(readBudget<=0)break;
        const header=await this.#header(file.full,Math.min(256*1024,readBudget));readBudget-=header.bytes;
        if(!header.complete)break;
        cached={stamp,expires:now+60_000,meta:header.meta};
        this.#cache.delete(file.full);this.#cache.set(file.full,cached);
        while(this.#cache.size>128)this.#cache.delete(this.#cache.keys().next().value!);
      }
      if(cached.meta&&resolve(cached.meta.cwd)===resolve(cwd)&&candidates.length<16)candidates.push({
        key:saveDigest(['codex',file.full]),stamp,agent:'codex',path:file.full,transcriptRoot:this.deps.codexRoot,sessionId:cached.meta.id});
    }
    const claude:RecentSessionFile[]=[];
    for(const slug of claudeProjectSlugCandidates(cwd)){
      try{claude.push(...await recentSessionFiles(join(this.deps.claudeRoot,slug),16));}catch{/* One unavailable legacy slug cannot block the current one. */}
    }
    const seen=new Set<string>();
    for(const file of claude.sort((a,b)=>b.mtimeMs-a.mtimeMs)){
      if(seen.size>=16)break;if(seen.has(file.full))continue;seen.add(file.full);
      const sessionId=basename(file.full,'.jsonl');if(!saveToken(sessionId))continue;
      candidates.push({key:saveDigest(['claude',file.full]),stamp:`${file.size}:${file.mtimeMs}`,agent:'claude',path:file.full,
        transcriptRoot:this.deps.claudeRoot,sessionId});
    }
    return candidates;
  }
  async #header(path:string,limit:number):Promise<{bytes:number;meta:{id:string;cwd:string}|null;complete:boolean}>{
    let fd:Awaited<ReturnType<typeof open>>|undefined;let count=0,complete=false;
    try{
      fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      if(!(await fd.stat()).isFile())return {bytes:0,meta:null,complete:true};
      const parts:Buffer[]=[];
      while(count<limit){
        const chunk=Buffer.allocUnsafe(Math.min(4096,limit-count));const read=await fd.read(chunk,0,chunk.length,count);
        if(!read.bytesRead){complete=true;break;}count+=read.bytesRead;const bytes=chunk.subarray(0,read.bytesRead);const end=bytes.indexOf(10);
        parts.push(end<0?bytes:bytes.subarray(0,end+1));if(end<0)continue;
        complete=true;
        const row=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));
        const meta=row.payload;
        if(row.type!=='session_meta'||!saveToken(meta?.id)||!['cli','vscode'].includes(meta.source)
          ||meta.thread_source==='subagent'||(meta.thread_source&&typeof meta.thread_source==='object')
          ||typeof meta.cwd!=='string'||!isAbsolute(meta.cwd)||meta.cwd.length>4096
          ||(meta.session_id!==undefined&&meta.session_id!==meta.id))return {bytes:count,meta:null,complete:true};
        // Detach tiny identity strings from a possibly large parsed header backing store.
        return {bytes:count,meta:{id:Buffer.from(meta.id).toString(),cwd:Buffer.from(meta.cwd).toString()},complete:true};
      }
    }catch{complete=true;/* Bounded untrusted provider metadata is not an execution authority. */}
    finally{await fd?.close();}
    return {bytes:count,meta:null,complete:complete||limit===256*1024};
  }
}
