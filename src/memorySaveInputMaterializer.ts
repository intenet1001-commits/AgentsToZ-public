import {createHash} from 'node:crypto';
import {constants,type Stats} from 'node:fs';
import {open,realpath,lstat} from 'node:fs/promises';
import {dirname,isAbsolute,relative,sep} from 'node:path';
import {canonicalSaveSource,memorySaveSourceKey,saveDigest,saveHash,type MemorySaveSource} from './memorySaveContract';
import {CompletedMemoryTurnReader,type MemoryObservationBinding} from './memorySaveObservation';
import {MEMORY_INPUT_LIMIT} from './memorySaveInputStore';

export interface MemoryInputSource {
 source:MemorySaveSource;binding:MemoryObservationBinding;path:string;transcriptRoot:string;
}
export class MemoryMaterializationError extends Error {
 constructor(readonly code:'INVALID_INPUT'|'SOURCE_CHANGED'|'REGISTRATION_CHANGED'|'SOURCE_OVERSIZED'|'INPUT_OVERSIZED'|'UNAVAILABLE'){super(`Memory materialization: ${code}`);}
}
const same=(a:Stats,b:Stats)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs&&a.birthtimeMs===b.birthtimeMs;
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
type Stamp={item:MemoryInputSource;file:Stats;parent:string;root:string;cwd:string};
/** Read only exact complete-turn coverage, never a newest-tail replacement.
 * JSONL records are preserved whole as untrusted input; this is not a prompt,
 * redactor, model invocation, or proposal validator. The host must separately
 * validate policy/lease/provider and retain its pre-model activity snapshot.
 * No plaintext is persisted. Caller owns and must zero the returned buffer.
 * Oversized groups fail as a whole, leaving coverage available for a smaller
 * group (oversized single turns still require explicit fragmentation policy). */
export async function materializeMemorySaveInput(input:{
 sources:readonly MemoryInputSource[];expectedCoverageDigest:string;
 validateRegistrationAndLease:()=>Promise<boolean>;
}):Promise<{plaintext:Buffer;inputDigest:string;coverageDigest:string;sourceCount:number;bytesRead:number}> {
 const fail=(code:MemoryMaterializationError['code']):never=>{throw new MemoryMaterializationError(code);};
 let bytesRead=0;let output:Buffer|undefined;
 try{
  if(!input||!Array.isArray(input.sources)||!input.sources.length||input.sources.length>128||!saveHash(input.expectedCoverageDigest))fail('INVALID_INPUT');
  const items=input.sources.map(raw=>({path:raw.path,transcriptRoot:raw.transcriptRoot,binding:{...raw.binding},source:canonicalSaveSource(raw.source)}));
  const keys=items.map(i=>memorySaveSourceKey(i.source));
  if(new Set(keys).size!==items.length)fail('INVALID_INPUT');
  items.sort((a,b)=>memorySaveSourceKey(a.source).localeCompare(memorySaveSourceKey(b.source)));
  const first=items[0]!.source;
  for(const item of items){const s=item.source,b=item.binding;
   if(s.coverageKind!=='complete-turn'||!['codex','claude'].includes(s.agent)||s.memoryId!==first.memoryId||s.policyEpoch!==first.policyEpoch
     ||b.agent!==s.agent||b.instanceId!==s.instanceId||b.sessionId!==s.sessionId||b.memoryId!==s.memoryId||b.policyEpoch!==s.policyEpoch
     ||![item.path,item.transcriptRoot,b.cwd].every(p=>typeof p==='string'&&p.length<=4096&&isAbsolute(p)&&!/[\0\r\n]/.test(p)))fail('INVALID_INPUT');
  }
  const coverageDigest=saveDigest(items.map(i=>[memorySaveSourceKey(i.source),i.source.sourceDigest]));
  if(coverageDigest!==input.expectedCoverageDigest)fail('SOURCE_CHANGED');
  if(items.reduce((n,i)=>n+i.source.endByte-i.source.startByte,0)>MEMORY_INPUT_LIMIT)fail('INPUT_OVERSIZED');
  if(!await input.validateRegistrationAndLease())fail('REGISTRATION_CHANGED');
  const stamps:Stamp[]=[],turns:{sourceKey:string;agent:string;sessionId:string;turnId:string;jsonl:string}[]=[];
  for(const item of items){
   const root=await realpath(item.transcriptRoot),parent=await realpath(dirname(item.path)),cwd=await realpath(item.binding.cwd);
   const rel=relative(root,parent);if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))fail('INVALID_INPUT');
   const fd=await open(item.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   try{
    const before=await fd.stat();if(!before.isFile()||before.nlink!==1||item.source.endByte>before.size)fail('SOURCE_CHANGED');
    const read=async(start:number,length:number)=>{
     if(bytesRead+length>8*1024*1024)fail('SOURCE_OVERSIZED');const bytes=Buffer.alloc(length);let at=0;
     while(at<length){const r=await fd.read(bytes,at,length-at,start+at);bytesRead+=r.bytesRead;if(!r.bytesRead)fail('SOURCE_CHANGED');at+=r.bytesRead;}return bytes;
    };
    const reader=new CompletedMemoryTurnReader(item.binding),s=item.source;
    if(s.startByte>0){
     let head=Buffer.alloc(0);
     while(head.indexOf(10)<0&&head.length<Math.min(before.size,256*1024))head=Buffer.concat([head,await read(head.length,Math.min(4096,before.size-head.length,256*1024-head.length))]);
     const end=head.indexOf(10);if(end<0)fail('SOURCE_OVERSIZED');head=head.subarray(0,end+1);
     if(s.startByte<head.length||(await read(s.startByte-1,1))[0]!==10)fail('SOURCE_CHANGED');
     reader.record(head,0);reader.resumeAt(s.startByte);
    }
    const range=await read(s.startByte,s.endByte-s.startByte);
    try{
     let start=0;while(start<range.length){const end=range.indexOf(10,start);if(end<0)fail('SOURCE_CHANGED');reader.record(range.subarray(start,end+1),s.startByte+start);start=end+1;}
     if(reader.invalid||reader.incomplete||reader.hasOpenTurn||reader.sources.length!==1||saveDigest(reader.sources[0])!==saveDigest(s)||hash(range)!==s.sourceDigest)fail('SOURCE_CHANGED');
     const jsonl=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(range);
     if(!Buffer.from(jsonl).equals(range))fail('SOURCE_CHANGED');
     turns.push({sourceKey:memorySaveSourceKey(s),agent:s.agent,sessionId:s.sessionId,turnId:s.turnId,jsonl});
     if(Buffer.byteLength(JSON.stringify({version:1,turns}))>MEMORY_INPUT_LIMIT)fail('INPUT_OVERSIZED');
    }finally{range.fill(0);}
    if(!same(before,await fd.stat()))fail('SOURCE_CHANGED');stamps.push({item,file:before,parent,root,cwd});
   }finally{await fd.close();}
  }
  if(!await input.validateRegistrationAndLease())fail('REGISTRATION_CHANGED');
  for(const stamp of stamps){const current=await lstat(stamp.item.path);
   if(!current.isFile()||current.nlink!==1||!same(stamp.file,current)||await realpath(dirname(stamp.item.path))!==stamp.parent||await realpath(stamp.item.transcriptRoot)!==stamp.root||await realpath(stamp.item.binding.cwd)!==stamp.cwd)fail('SOURCE_CHANGED');
  }
  output=Buffer.from(JSON.stringify({version:1,turns}));
  if(output.length>MEMORY_INPUT_LIMIT)fail('INPUT_OVERSIZED');
  return {plaintext:output,inputDigest:hash(output),coverageDigest,sourceCount:items.length,bytesRead};
 }catch(e){output?.fill(0);if(e instanceof MemoryMaterializationError)throw e;throw new MemoryMaterializationError('UNAVAILABLE');}
}
