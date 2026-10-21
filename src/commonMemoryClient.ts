import {commonMemoryOperationMutates} from './commonMemoryRequest';
import type {CommonMemory,CommonMemorySelection,CommonMemoryApplication} from './commonMemory';
export type CommonMemoryTransport=(operation:string,input?:unknown)=>Promise<any>;
/** Inject transport in SDK consumers; the browser never receives a server key. */
export function createCommonMemoryClient(transport:CommonMemoryTransport){return {
  prepareWorkroom:(input:{kind:'recommend'|'update';groupId?:string;scopeId?:string;projectIds?:string[]})=>transport('prepare-workroom',input),
  updates:(offset=0)=>transport('updates',{offset}),
  topicCandidates:(after?:string|null,memoryIds?:string[])=>transport('topic-candidates',{after:after??null,...(memoryIds?{memoryIds}:{})}),
  readCloudSource:(memoryId:string,offset=0,scopeId?:string)=>transport('read-cloud-source',{memoryId,offset,...(scopeId?{scopeId}:{})}),
  request:transport,applicationStatus:(groupId:string,applicationId:string,scopeId?:string)=>transport('application-status',{groupId,applicationId,scopeId}),readSource:(groupId:string,memoryId:string,entryId:string,contentHash:string,scopeId?:string)=>transport('read-source',{groupId,memoryId,entryId,contentHash,scopeId}),operationStatus:(groupId:string,requestId:string,requestHash:string,scopeId?:string)=>transport('operation-status',{groupId,requestId,requestHash,scopeId}),projectAddStatus:(requestId:string)=>transport('project-add-status',{requestId}),roots:()=>transport('roots'),catalog:(after?:string|null)=>transport('catalog',{after:after??null}),
  projectsStatus:(groupId:string)=>transport('projects-status',{groupId}),projectsPlan:(groupId:string,workspaceRootId:string)=>transport('projects-plan',{groupId,workspaceRootId}),projectsAdd:(plan:unknown,requestId:string,memoryId:string)=>transport('projects-add',{plan,requestId,memoryId}),
  list:(offset=0)=>offset?transport('list',{offset}):transport('list'),inspect:(groupId:string,offset?:number,itemOffset=0)=>transport('inspect',{groupId,...(offset===undefined?{}:{offset,itemOffset})}),
  history:(groupId:string)=>transport('history',{groupId}),
  manage:(input:Record<string,unknown>)=>transport('manage',input),recommend:(projectGoal:string)=>transport('recommend',{projectGoal}),
  recall:(groupId:string,task:string,revisionId?:string,scopeId?:string)=>transport('recall',{groupId,task,...(revisionId?{revisionId}:{}),...(scopeId?{scopeId}:{})}),
  report:(groupId:string,application:CommonMemoryApplication,scopeId?:string)=>transport('report',{groupId,application,...(scopeId?{scopeId}:{})}),
  preflight:(groupIds:string[],expectedSelections?:CommonMemorySelection[])=>transport('preflight',{groupIds,...(expectedSelections?{expectedSelections}:{})}),
  bindProject:(portId:string,projectGoal:string,groupIds:string[],expectedSelections?:CommonMemorySelection[])=>transport('bind-project',{portId,projectGoal,groupIds,...(expectedSelections?{expectedSelections}:{})}),
};}
export function commonMemoryHttpTransport(baseUrl='/api/common-memory'):CommonMemoryTransport{return async(operation,input)=>{
  const mutating=commonMemoryOperationMutates(operation,input);
  let response:Response;try{response=await fetch(`${baseUrl}/${operation}`,{method:input===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)}),signal:AbortSignal.timeout(60_000)});}catch(e){throw Object.assign(new Error(mutating?'공통기억 저장 응답을 확인하지 못했습니다. 같은 요청으로 결과를 확인하세요.':'공통기억을 조회하지 못했습니다. 연결을 확인한 뒤 다시 조회하세요.'),{unknownOutcome:mutating,uncertain:mutating});}
  const result=await response.json().catch(()=>{throw Object.assign(new Error('공통기억 응답을 읽지 못했습니다. 같은 요청으로 결과를 확인하세요.'),{uncertain:mutating,unknownOutcome:mutating});});if(!response.ok||result.success!==true)throw Object.assign(new Error(result.error??'공통기억 응답을 확인하지 못했습니다.'),{code:result.code,uncertain:response.status>=500&&mutating,unknownOutcome:response.status>=500&&mutating});return result;
};}

export type CommonMemoryClient=ReturnType<typeof createCommonMemoryClient>;
