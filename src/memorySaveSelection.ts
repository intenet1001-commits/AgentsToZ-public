import {MemorySaveStore} from './memorySaveStore';
import {MemorySaveError} from './memorySaveContract';
import type {MemoryInputSource} from './memorySaveInputMaterializer';
import type {MemoryObservationCandidate} from './memoryObservationCoordinator';

/** One metadata page and at most eight complete turns. Caller keeps an advisory
 * scan cursor, never a remembered watermark. Discovery failures cannot silently
 * substitute another session or consume coverage. Materialization rechecks bytes. */
export function selectAutomaticMemorySources(input:{
 store:MemorySaveStore;memoryId:string;policyEpoch:number;revision:number;after?:number;
 instanceId:string;cwd:string;candidates:readonly MemoryObservationCandidate[];
}) {
 const page=input.store.automaticPending(input.memoryId,input.policyEpoch,input.revision,input.after??0);
 const sources:MemoryInputSource[]=[];
 let unavailable=0,oversized=0,bytes=0,remaining=0;
 for(const {source} of page.items){
  if(source.instanceId!==input.instanceId){unavailable++;continue;}
  const matches=input.candidates.filter(c=>c.agent===source.agent&&c.sessionId===source.sessionId);
  if(matches.length!==1){unavailable++;continue;}
  const length=source.endByte-source.startByte;
  if(length>20_000){oversized++;continue;}
  if(sources.length>=8||bytes+length>20_000){remaining++;continue;}
  const candidate=matches[0]!;
  if(candidate.agent!=='codex'&&candidate.agent!=='claude')throw new MemorySaveError('INVALID_INPUT');
  sources.push({source,binding:{agent:candidate.agent,instanceId:input.instanceId,sessionId:source.sessionId,
   cwd:input.cwd,memoryId:input.memoryId,policyEpoch:input.policyEpoch},path:candidate.path,transcriptRoot:candidate.transcriptRoot});
  bytes+=length;
 }
 return {sources,nextCursor:page.nextCursor,unavailable,oversized,remaining};
}
