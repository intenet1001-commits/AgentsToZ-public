import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,realpath,lstat} from 'node:fs/promises';
import {dirname,isAbsolute,relative,resolve} from 'node:path';
import {MemorySaveError,saveDigest,saveInteger,saveToken} from './memorySaveContract';
import type {MemorySaveStore} from './memorySaveStore';
import {CompletedMemoryTurnReader,MEMORY_OBSERVATION_MAX_BYTES,MEMORY_OBSERVATION_MAX_RECORD_BYTES,
  MEMORY_OBSERVATION_MAX_TURNS,type MemoryObservationBinding} from './memorySaveObservation';
import type {MemoryObservationCursorStore,MemoryObservationCursor} from './memoryObservationCursorStore';

type Handle=Awaited<ReturnType<typeof open>>;
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export interface IncrementalMemoryObservationResult {
  observed:number;
  offset:number;
  reset:boolean;
  bytesRead:number;
  reason:'observed'|'more'|'incomplete'|'source-oversized'|'source-invalid'|'source-changed'|'registration-changed'|'unavailable';
}
/** Bounded, observation-only continuation. No policy activation, model execution or new timer.
 * Header/anchor checks establish an append continuation, not integrity of every historical byte.
 * Before later AI input selection, each stored range digest must be freshly revalidated.
 * A single open turn exceeding the slice budget remains unresolved, never skipped. */
export async function observeIncrementalMemoryTranscript(input:{
  path:string;transcriptRoot:string;binding:MemoryObservationBinding;
  validateRegistration:()=>Promise<boolean>;
  store:Pick<MemorySaveStore,'observe'> & Partial<Pick<MemorySaveStore,'observeBatch'>>;
  cursors:Pick<MemoryObservationCursorStore,'get'|'advance'>;
  maxBytes?:number;
}):Promise<IncrementalMemoryObservationResult> {
  const b={...input.binding};
  const budget=input.maxBytes??MEMORY_OBSERVATION_MAX_BYTES;
  let bytesRead=0,offset=0,reset=false;
  const result=(reason:IncrementalMemoryObservationResult['reason'],observed=0):IncrementalMemoryObservationResult=>({observed,offset,reset,bytesRead,reason});
  if(!['codex','claude'].includes(b.agent)||![b.instanceId,b.sessionId,b.memoryId].every(saveToken)
    ||!saveInteger(b.policyEpoch)||!isAbsolute(b.cwd)||!isAbsolute(input.path)
    ||!Number.isSafeInteger(budget)||budget<512*1024||budget>MEMORY_OBSERVATION_MAX_BYTES)return result('source-invalid');
  let file:Handle|undefined;
  try{
    if(!await input.validateRegistration())return result('registration-changed');
    const root=await realpath(input.transcriptRoot),parent=await realpath(dirname(input.path));
    const inside=relative(root,parent);
    if(inside==='..'||inside.startsWith('../')||isAbsolute(inside))return result('source-invalid');
    const cwd=await realpath(b.cwd);
    file=await open(input.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const before=await file.stat();
    if(!before.isFile())return result('source-invalid');
    const read=async(start:number,length:number)=>{
      const buffer=Buffer.allocUnsafe(length);let count=0;
      while(count<length){const r=await file!.read(buffer,count,length-count,start+count);bytesRead+=r.bytesRead;if(!r.bytesRead)break;count+=r.bytesRead;}
      return buffer.subarray(0,count);
    };
    let head=Buffer.alloc(0);
    while(head.length<Math.min(before.size,256*1024)){
      const part=await read(head.length,Math.min(4096,before.size-head.length,256*1024-head.length));
      if(!part.length)return result('source-changed');
      head=Buffer.concat([head,part]);const newline=head.indexOf(10);
      if(newline>=0){head=head.subarray(0,newline+1);break;}
    }
    if(head.at(-1)!==10)return result(head.length>=256*1024?'source-oversized':'incomplete');
    const key=saveDigest([b.agent,b.instanceId,b.sessionId,b.memoryId,b.policyEpoch,resolve(input.path)]);
    const stored=input.cursors.get(key);
    const prior=stored?.cursor;
    const headHash=hash(head);
    let canResume=!!prior && prior.dev===before.dev&&prior.ino===before.ino&&prior.birthtimeMs===before.birthtimeMs
      &&before.size>=prior.snapshotSize&&prior.headEnd===head.length&&prior.headHash===headHash
      &&(before.size>prior.snapshotSize||(prior.mtimeMs===before.mtimeMs&&prior.ctimeMs===before.ctimeMs));
    if(canResume&&prior){
      const anchor=await read(prior.anchorStart,prior.offset-prior.anchorStart);
      canResume=anchor.length===prior.offset-prior.anchorStart&&anchor.at(-1)===10&&hash(anchor)===prior.anchorHash;
    }
    reset=!!stored&&!canResume;
    offset=canResume ? prior!.offset : 0;
    const startOffset=offset;
    const reader=new CompletedMemoryTurnReader(b);
    if(offset>0){reader.record(head,0);reader.resumeAt(offset);if(reader.invalid)return result('source-invalid');}
    const end=Math.min(before.size,startOffset+Math.max(0,budget-bytesRead-4096));
    let position=startOffset,recordStart=startOffset,length=0,stop=false;
    let parts:Buffer[]=[];
    while(position<end&&!stop){
      const chunk=await read(position,Math.min(64*1024,end-position));
      if(!chunk.length)return result('source-changed');
      position+=chunk.length;
      let local=0;
      while(local<chunk.length){
        const newline=chunk.indexOf(10,local),recordEnd=newline<0?chunk.length:newline+1;
        const piece=chunk.subarray(local,recordEnd);length+=piece.length;
        if(length>MEMORY_OBSERVATION_MAX_RECORD_BYTES)return result('source-oversized');
        parts.push(Buffer.from(piece));local=recordEnd;
        if(newline>=0){
          reader.record(Buffer.concat(parts,length),recordStart);recordStart+=length;length=0;parts=[];
          if(reader.invalid)return result('source-invalid');
          if(reader.incomplete||reader.sources.length>=MEMORY_OBSERVATION_MAX_TURNS){stop=true;break;}
        }
      }
    }
    const nextOffset=reader.safeOffset;
    let next:MemoryObservationCursor|null=null;
    if(nextOffset>startOffset){
      const anchorStart=Math.max(0,nextOffset-4096),anchor=await read(anchorStart,nextOffset-anchorStart);
      if(anchor.length!==nextOffset-anchorStart||anchor.at(-1)!==10)return result('source-changed');
      next={offset:nextOffset,snapshotSize:before.size,dev:before.dev,ino:before.ino,birthtimeMs:before.birthtimeMs,
        mtimeMs:before.mtimeMs,ctimeMs:before.ctimeMs,headEnd:head.length,headHash,anchorStart,anchorHash:hash(anchor)};
    }
    if(!await input.validateRegistration())return result('registration-changed');
    const after=await file.stat(),current=await lstat(input.path);
    if(!current.isFile()||[after,current].some(s=>s.dev!==before.dev||s.ino!==before.ino||s.size!==before.size||s.mtimeMs!==before.mtimeMs||s.ctimeMs!==before.ctimeMs)
      ||await realpath(dirname(input.path))!==parent||await realpath(b.cwd)!==cwd)return result('source-changed');
    // An interrupted cursor CAS can only repeat already durable observations.
    if(input.store.observeBatch)input.store.observeBatch(reader.sources);
    else for(const source of reader.sources)input.store.observe(source);
    if(next){input.cursors.advance(key,stored?.revision??null,next);offset=next.offset;}
    const reason=reader.incomplete?'incomplete':offset===before.size?'observed'
      :offset>startOffset?'more':position<before.size?'source-oversized':'incomplete';
    return result(reason,reader.sources.length);
  }catch(error){if(error instanceof MemorySaveError)throw error;return result('unavailable');}
  finally{await file?.close();}
}
