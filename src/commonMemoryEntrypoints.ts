// Entry points into common memory from other screens: project creation, the project memory card, the phone's record modes.
import {connectProjectMetaMemories,type MetaMemoryRequester} from './metaCommonMemoryClient';
import {COMMON_MEMORY_REMOTE_FEATURE} from './commonMemoryRequest';

/** One stable request id per new project and group: a repeated link replays instead of writing twice. */
export const newProjectCommonMemoryRequestId=(portId:string,groupId:string,form:'memory'|'port')=>`new-project-link:${portId}:${groupId}:${form}`;

/** Links a just-created project to the chosen common memories. The memory form ({memoryId, mode}) needs the long-term
 *  memory in the cloud already (a push or a restore in this flow) and a cloud group (its read answers memberForm:'memory');
 *  a group in this Mac's local store, or a memory not yet pushed, gets the project-card form, which works for both stores.
 *  An older service that rejects the memory form in its parser gets one project-card retry. */
export function linkNewProjectCommonMemories(options:{portId:string;memoryId:string;groupIds:readonly string[];memoryInCloud:boolean;request?:MetaMemoryRequester}){
  return connectProjectMetaMemories(options.portId,options.memoryId,options.groupIds,{form:options.memoryInCloud?'memory':'port',request:options.request,requestIdFor:(groupId,form)=>newProjectCommonMemoryRequestId(options.portId,groupId,form)});
}

/** What the phone's last cloud common-memory list said: it answered (ok), and how many of the Mac's local groups the cloud
 *  does not hold yet (null from a Mac that does not report it). */
export type PortalCloudListState={ok:boolean;localPending:number|null};
/** The phone's '이 Mac의 기억' (meta-memory-v1 local store) mode hides only when a real cloud list answered and the Mac said
 *  none of its local groups is left outside the cloud. The feature flag alone is not enough: every Mac advertises it, also
 *  on an unmigrated cloud (where the cloud list fails and the local store is the only way in) and while unmigrated local
 *  groups would be listed in 공통기억 but could not be opened there. */
export const portalLocalCommonVisible=(features:readonly string[]|null|undefined,cloudList?:PortalCloudListState|null)=>
  !(features??[]).includes(COMMON_MEMORY_REMOTE_FEATURE)||!(cloudList?.ok===true&&cloudList.localPending===0);

type LinksRequest=(operation:string,input:Record<string,unknown>)=>Promise<any>;
const linkMemory=new Map<string,string>();
const parserRefused=(e:unknown)=>{const error=e as {code?:unknown;uncertain?:unknown};return !error?.uncertain&&typeof error?.code==='string'&&/(^|_)INPUT_INVALID$/.test(error.code);};
/** project-links by long-term memory when it is known (a pure cloud lookup, no folder detection on the Mac), else by project
 *  card. The memoryId a project card resolved to is remembered for the next open. An older service whose parser refuses the
 *  memoryId form gets one project-card retry. */
export async function readProjectCommonMemoryLinks(request:LinksRequest,target:{portId:string;memoryId?:string|null}){
  const memoryId=target.memoryId||linkMemory.get(target.portId);
  let result:any;
  if(memoryId){try{result=await request('project-links',{memoryId});}catch(e){if(!parserRefused(e))throw e;result=await request('project-links',{portId:target.portId});}}
  else result=await request('project-links',{portId:target.portId});
  if(typeof result?.memoryId==='string'&&result.memoryId)linkMemory.set(target.portId,result.memoryId);
  return result;
}
/** "다시 확인" drops the remembered memoryId so the project card is resolved again. */
export const forgetProjectCommonMemoryLink=(portId:string)=>{linkMemory.delete(portId);};
