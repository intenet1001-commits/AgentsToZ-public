import {MemorySaveStore} from './memorySaveStore';
import {MemorySaveError,memorySaveSourceKey,saveDigest} from './memorySaveContract';
import {materializeMemorySaveInput,MemoryMaterializationError,type MemoryInputSource} from './memorySaveInputMaterializer';
import {MEMORY_CONVERSATION_INPUT_LIMIT} from './memorySaveConversationProjection';
import type {MemoryObservationCandidate} from './memoryObservationCoordinator';

/** One metadata page and at most eight complete turns. Caller keeps an advisory
 * scan cursor, never a remembered watermark. Discovery failures cannot silently
 * substitute another session or consume coverage. Materialization rechecks bytes. */
export async function selectAutomaticMemorySources(input:{
 store:MemorySaveStore;memoryId:string;policyEpoch:number;revision:number;after?:number;
 instanceId:string;cwd:string;candidates:readonly MemoryObservationCandidate[];
 validateRegistrationAndLease:()=>Promise<boolean>;
}) {
 const page=input.store.automaticPending(input.memoryId,input.policyEpoch,input.revision,input.after??0);
 const sources:MemoryInputSource[]=[];
 let unavailable=0,oversized=0,bytes=0,remaining=0,readBudget=0;
 for(const {source} of page.items){
  if(source.instanceId!==input.instanceId){unavailable++;continue;}
  const matches=input.candidates.filter(c=>c.agent===source.agent&&c.sessionId===source.sessionId);
  if(matches.length!==1){unavailable++;continue;}
  const length=source.endByte-source.startByte;
  // Two reads (admission then execution) share an 8 MiB worst-case budget.
  // Charge failures too; the header allowance covers the exact seek proof.
  const readCharge=length+(source.startByte>0?256*1024+1:0);
  if(readCharge>4*1024*1024){oversized++;continue;}
  if(sources.length>=8||readBudget+readCharge>4*1024*1024){remaining++;continue;}
  const candidate=matches[0]!;
  if(candidate.agent!=='codex'&&candidate.agent!=='claude')throw new MemorySaveError('INVALID_INPUT');
  const item:MemoryInputSource={source,binding:{agent:candidate.agent,instanceId:input.instanceId,sessionId:source.sessionId,
   cwd:input.cwd,memoryId:input.memoryId,policyEpoch:input.policyEpoch},path:candidate.path,transcriptRoot:candidate.transcriptRoot};
  readBudget+=readCharge;
  try{
   const checked=await materializeMemorySaveInput({sources:[item],expectedCoverageDigest:saveDigest([[memorySaveSourceKey(source),source.sourceDigest]]),
    projection:'conversation-v1',validateRegistrationAndLease:input.validateRegistrationAndLease});
   try{
    // Summing standalone envelopes conservatively includes repeated metadata;
    // the combined envelope is smaller. Never discard part of a conversation.
    if(bytes+checked.plaintext.length>MEMORY_CONVERSATION_INPUT_LIMIT){remaining++;continue;}
    sources.push(item);bytes+=checked.plaintext.length;
   }finally{checked.plaintext.fill(0);}
  }catch(error){
   if(!(error instanceof MemoryMaterializationError)||error.code==='REGISTRATION_CHANGED')throw error;
   if(error.code==='INPUT_OVERSIZED'||error.code==='SOURCE_OVERSIZED')oversized++;
   else unavailable++;
  }
 }
 return {sources,nextCursor:page.nextCursor,unavailable,oversized,remaining};
}
