import {normalizeMetaMemoryVocabulary,parseMetaMemoryRequest} from './metaCommonMemoryContract';
import {CommonMemoryError, commonMemoryId, commonMemoryText} from './commonMemory';
export const COMMON_MEMORY_REMOTE_TARGET = 'goal-common-memory';
export const COMMON_MEMORY_REMOTE_FEATURE = 'goal-common-memory-v1';
const fields:Record<string,string[]> = {
  'migration-preview':['groupId','assignments','retireMemberIds'],'migration-execute':['plan','requestId'],'migration-status':['groupId'],knowledge:['request','scopeId'],'project-names':[],'project-links':['portId','memoryId'],
  'application-status':['groupId','applicationId','scopeId'],'read-source':['groupId','memoryId','entryId','contentHash','scopeId'],'read-cloud-source':['memoryId','offset','scopeId'],'topic-candidates':['after','memoryIds'],'operation-status':['groupId','requestId','requestHash','scopeId'],'project-add-status':['requestId'],updates:['offset'],'prepare-workroom':['kind','groupId','scopeId','projectIds'],roots:[],list:['offset'],catalog:['after'],inspect:['groupId','offset','itemOffset','analysis'],history:['groupId'],
  recommend:['projectGoal'],recall:['groupId','task','revisionId','scopeId','memoryId','query'],
  report:['groupId','application','scopeId'],preflight:['groupIds','expectedSelections'],
  'projects-status':['groupId'],'projects-plan':['groupId','workspaceRootId'],'projects-add':['plan','requestId','memoryId'],
  'bind-project':['portId','projectGoal','groupIds','expectedSelections'],
  manage:['operation','groupId','expectedVersion','requestId','scopeId','name','goal','sourceMemoryIds','evidence','rule','reason','conditions','itemId','title','revisionId'],
};
/** The same bounded request contract is used by HTTP, MCP and encrypted mobile RPC. */
export function parseCommonMemoryRequest(raw:unknown):{operation:string;input:Record<string,any>} {
  const fail=():never=>{throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','지원하는 공통기억 요청 형식을 확인하세요.',400);};
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return fail();
  const r=raw as Record<string,any>,input=r.input??{};
  if(Object.keys(r).some(k=>!['operation','input'].includes(k))||!Object.hasOwn(fields,r.operation)||!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!fields[r.operation]!.includes(k)))return fail();
  if(new TextEncoder().encode(JSON.stringify(r)).length>128_000)return fail();
  if(input.groupId!==undefined)commonMemoryId(input.groupId);
  if(input.offset!==undefined&&(!Number.isSafeInteger(input.offset)||input.offset<0||input.offset>2000))return fail();
  if(input.itemOffset!==undefined&&(!Number.isSafeInteger(input.itemOffset)||input.itemOffset<0||input.itemOffset>500))return fail();
  if(input.analysis!==undefined&&typeof input.analysis!=='boolean')return fail();
  if(input.after!==undefined&&input.after!==null)commonMemoryId(input.after);
  if(r.operation==='read-cloud-source')commonMemoryId(input.memoryId);
  if(r.operation==='topic-candidates'&&input.memoryIds!==undefined){if(!Array.isArray(input.memoryIds)||!input.memoryIds.length||input.memoryIds.length>16)return fail();input.memoryIds=input.memoryIds.map(commonMemoryId);if(new Set(input.memoryIds).size!==input.memoryIds.length)return fail();}
  if(input.scopeId!==undefined&&(typeof input.scopeId!=='string'||!/^[a-f0-9]{64}$/.test(input.scopeId)))return fail();
  if(input.goal&&Object.keys(input.goal).some(k=>!['objective','include','exclude','conditions','checks','sdkModules'].includes(k)))return fail();
  if(input.evidence&&(!Array.isArray(input.evidence)||input.evidence.some((e:any)=>!e||Object.keys(e).some(k=>!['memoryId','entryId','contentHash','revisionId','title','excerpt','section'].includes(k)))))return fail();
  if(r.operation==='prepare-workroom'&&(!['recommend','update'].includes(input.kind)||input.kind==='update'&&!input.groupId||input.projectIds!==undefined&&(!Array.isArray(input.projectIds)||input.projectIds.length>8||new Set(input.projectIds).size!==input.projectIds.length||input.projectIds.some((id:any)=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(id)))))return fail();
  // project-links names one project card (portId) or one long-term memory (memoryId), never both.
  if(r.operation==='project-links'){if(input.portId!==undefined&&input.memoryId!==undefined)return fail();if(input.memoryId!==undefined)input.memoryId=commonMemoryId(input.memoryId);}
  // recall is either the goal form {groupId, task, revisionId?} or the long-term-memory form {memoryId, query}.
  if(r.operation==='recall'&&(input.memoryId!==undefined||input.query!==undefined)){if(input.memoryId===undefined||input.groupId!==undefined||input.task!==undefined||input.revisionId!==undefined)return fail();input.memoryId=commonMemoryId(input.memoryId);input.query=commonMemoryText(input.query,2000);}
  if(r.operation==='knowledge'){const named=normalizeMetaMemoryVocabulary(input.request) as Record<string,unknown>,parsed=parseMetaMemoryRequest(named);if(parsed.operation==='import'||parsed.operation==='prepare-project')return fail();if(Object.keys(named).some(k=>!Object.hasOwn(parsed,k)))return fail();input.request=parsed;}
  return {operation:r.operation,input};
}

/** One write/read classification for HTTP uncertainty and MCP effect receipts. */
export function commonMemoryOperationMutates(operation:string,input:any={}):boolean{
 return ['manage','report','projects-add','bind-project','migration-execute'].includes(operation)||operation==='knowledge'&&['save','archive','save-entry','propose-entry','propose-source-entry','review-entry','review-entries','import','prepare-project'].includes(input?.request?.operation);
}
