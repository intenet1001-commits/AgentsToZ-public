import {validateMetaMemorySnapshot,metaMemoryApplies,isMemberAssignment,MetaMemoryError,META_COMMON_MEMORY_LIMITS,type MetaCommonMemory,type MetaMemoryRequest,type MetaMemoryProject,type MetaMemoryRecall} from './metaCommonMemoryContract';
import {recallProjectMemoryEntries} from './projectMemoryRecall';
import {CommonMemoryError,commonMemoryHash,type CommonMemory} from './commonMemory';
import {readCommonTopicEvidence} from './commonMemoryTopicEvidence';
import type {PortableCommonKnowledge} from './commonMemoryPortableTypes';
export type {PortableCommonKnowledge} from './commonMemoryPortableTypes';
export function validatePortableCommonKnowledge(value:unknown):PortableCommonKnowledge{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new CommonMemoryError('COMMON_MEMORY_KNOWLEDGE_INVALID','공통 지식의 원본과 현재 상태를 확인하세요.');
 const v=value as PortableCommonKnowledge,snapshot=validateMetaMemorySnapshot(v.snapshot),current=validateMetaMemorySnapshot(v.current);
 if(v.schemaVersion!==1||snapshot.id!==current.id||current.revision<snapshot.revision||!/^[a-f0-9]{64}$/.test(v.sourceFingerprint)||!Number.isFinite(Date.parse(v.importedAt)))throw new CommonMemoryError('COMMON_MEMORY_KNOWLEDGE_INVALID','공통 지식의 계보를 확인하세요.');
 return {schemaVersion:1,snapshot,current,sourceFingerprint:v.sourceFingerprint,importedAt:v.importedAt};
}
/** Snapshot and candidate states survive import; membership changes do not promote knowledge. */
export async function portableCommonMemory(snapshot:MetaCommonMemory,current:MetaCommonMemory,now=new Date()):Promise<CommonMemory>{
 snapshot=validateMetaMemorySnapshot(snapshot);current=validateMetaMemorySnapshot(current);
 const portableKnowledge=validatePortableCommonKnowledge({schemaVersion:1,snapshot,current,sourceFingerprint:await commonMemoryHash(JSON.stringify(snapshot)),importedAt:now.toISOString()});
 const state:CommonMemory={schemaVersion:1,id:snapshot.id,name:current.name,goal:{objective:current.description||current.name,include:[],exclude:[],conditions:[],checks:[],sdkModules:[]},goalConfigured:false,goalVersion:1,sourceMemoryIds:[],items:[],sourceHeads:[],publication:null,archived:current.archived,knowledgeSummary:commonKnowledgeSummary(current),portableKnowledge};
 if(new TextEncoder().encode(JSON.stringify(state)).length>1_000_000)throw new CommonMemoryError('COMMON_MEMORY_BUDGET_EXCEEDED','원본을 보존했습니다. 공통 지식의 이관 크기를 확인하세요.');
 return state;
}
export function portableKnowledgeView(knowledge:PortableCommonKnowledge,offset=0){
 return {schemaVersion:1,sourceFingerprint:knowledge.sourceFingerprint,importedAt:knowledge.importedAt,current:{...knowledge.current,entries:knowledge.current.entries.slice(offset,offset+10)},entryCount:knowledge.current.entries.length,entryOffset:offset,nextEntryOffset:offset+10<knowledge.current.entries.length?offset+10:null,snapshotRetained:true};
}
/** Revision zero is a read-only editor view; it is persisted only by an explicit mutation. */
export function commonKnowledgeForState(state:CommonMemory):MetaCommonMemory{
 return state.portableKnowledge?.current??{id:state.id,revision:0,name:state.name,description:[...state.goal.objective].slice(0,500).join(''),tags:[],categories:[],archived:state.archived,entries:[],members:[],createdAt:state.publication?.publishedAt??'1970-01-01T00:00:00.000Z',updatedAt:state.publication?.publishedAt??'1970-01-01T00:00:00.000Z'};
}
export function commonKnowledgeSummary(memory:MetaCommonMemory){return {id:memory.id,revision:memory.revision,name:memory.name,description:memory.description,tags:memory.tags,categories:memory.categories,archived:memory.archived,createdAt:memory.createdAt,updatedAt:memory.updatedAt,entryCount:memory.entries.filter(e=>['active','contested'].includes(e.state)).length,candidateCount:memory.entries.filter(e=>e.state==='candidate').length,memberCount:memory.members.filter(m=>m.mode==='include').length};}
/** verifiedMembers: long-term memories the caller has just confirmed in the cloud (memoryId -> display name). A {memoryId}
 *  assignment is stored only through it; {portId} assignments still resolve through the registered projects. */
export function editPortableKnowledge(current:MetaCommonMemory,request:MetaMemoryRequest,projects:MetaMemoryProject[],entryId:string,now=new Date(),verifiedMembers:ReadonlyMap<string,string>=new Map()):MetaCommonMemory{
 if(!('expectedRevision' in request)||request.expectedRevision!==current.revision)throw new MetaMemoryError('META_MEMORY_CONFLICT','다른 기기에서 공통기억이 변경됐습니다. 최신 내용을 확인하세요.',409);
 const next=structuredClone(current);
 if(request.operation==='save'){
   next.name=request.name;next.description=request.description;next.tags=request.tags;next.categories=request.categories;
   const assignments=request.assignments.map(a=>{if(isMemberAssignment(a)){const name=verifiedMembers.get(a.memoryId);if(name===undefined)throw new MetaMemoryError('META_MEMORY_PROJECT_UNAVAILABLE','선택한 장기기억을 클라우드에서 다시 확인하세요.',409);return {...a,name};}const p=projects.find(p=>p.id===a.portId);if(!p?.memoryId||p.state!=='ready'||p.memoryId!==a.expectedMemoryId)throw new MetaMemoryError('META_MEMORY_PROJECT_UNAVAILABLE','선택한 등록 프로젝트와 기억 ID를 다시 확인하세요.',409);return {...a,memoryId:p.memoryId,name:p.name};});
   for(const a of assignments){if(assignments.some(b=>b.memoryId===a.memoryId&&b.mode!==a.mode))throw new MetaMemoryError('META_MEMORY_ASSIGNMENT_CONFLICT','같은 기억의 연결 선택이 서로 다릅니다.',409);next.members=next.members.filter(m=>m.memoryId!==a.memoryId);if(a.mode!=='inherit')next.members.push({memoryId:a.memoryId,name:a.name,mode:a.mode});}
 }else if(request.operation==='archive')next.archived=request.archived;
 else if(request.operation==='review-entry'||request.operation==='review-entries'){
   const ids=request.operation==='review-entries'?request.entryIds:[request.entryId];
   for(const id of ids){const entry=next.entries.find(e=>e.id===id);if(!entry)throw new MetaMemoryError('META_MEMORY_ENTRY_NOT_FOUND','공통 항목을 다시 확인하세요.',404);if(request.operation==='review-entries'&&entry.state!=='candidate')throw new MetaMemoryError('META_MEMORY_CONFLICT','선택한 검토 후보의 상태가 바뀌었습니다.',409);entry.state=request.state;entry.updatedAt=now.toISOString();}
 }else if(request.operation==='save-entry'||request.operation==='propose-entry'){
   if(current.archived)throw new MetaMemoryError('META_MEMORY_ARCHIVED','보관을 해제한 뒤 편집하세요.',409);
   const id=request.entryId??entryId,old=next.entries.find(e=>e.id===id);if(request.operation==='propose-entry'&&old)throw new MetaMemoryError('META_MEMORY_PROPOSAL_INVALID','후보는 기존 확정 항목을 덮어쓰지 않습니다.',409);
   const p=request.portId?projects.find(p=>p.id===request.portId):null;
   if(request.portId&&(!p?.memoryId||p.state!=='ready'||!metaMemoryApplies(current,p.memoryId,p.category)))throw new MetaMemoryError('META_MEMORY_PROJECT_NOT_LINKED','연결된 프로젝트를 선택하세요.',403);
   // A source named by memoryId has no local category here, so it must be an explicit member of this group.
   if(request.sourceMemoryId&&!metaMemoryApplies(current,request.sourceMemoryId))throw new MetaMemoryError('META_MEMORY_PROJECT_NOT_LINKED','이 공통기억에 연결된 장기기억을 출처로 선택하세요.',403);
   next.entries=[...next.entries.filter(e=>e.id!==id),{id,title:request.title,body:request.body,state:request.operation==='propose-entry'?'candidate':'active',sourceMemoryId:p?.memoryId??request.sourceMemoryId??old?.sourceMemoryId??null,updatedAt:now.toISOString()}];
 }else throw new MetaMemoryError('META_MEMORY_OPERATION_INVALID','이관된 공통기억의 지원하는 편집 동작을 선택하세요.');
 return validateMetaMemorySnapshot({...next,revision:current.revision+1,updatedAt:now.toISOString()});
}
export function recallPortableKnowledge(groups:MetaCommonMemory[],memoryId:string,query:string,category=''):MetaMemoryRecall{
 const applicable=groups.filter(g=>metaMemoryApplies(g,memoryId,category)),hits=applicable.flatMap(g=>g.entries.filter(e=>e.state==='active'||e.state==='contested').flatMap(e=>{
  const body=readCommonTopicEvidence(e.body).body,document=`## Common Memory\n\n### ${e.title.replace(/\s+/g,' ')}\n<!-- memory-entry-id:${e.id} -->\n${body.replace(/^#{1,6}\s/gm,'')}`;
  return recallProjectMemoryEntries(document,query,{limit:1}).filter(h=>h.entryId===e.id).map(h=>({memoryId:g.id,memoryName:g.name,revision:g.revision,entryId:e.id,title:e.title,body,state:e.state as 'active'|'contested',score:h.score}));
 })).sort((a,b)=>b.score-a.score||a.entryId.localeCompare(b.entryId));
 return rebudgetRecall({state:'ready',groups:applicable.map(g=>({id:g.id,name:g.name,revision:g.revision})),hits,truncated:false});
}
/** Caps any recall, including a merged one, to 8 hits, 32 groups and 16 KB: lowest-ranked hits go first, then groups. */
export function rebudgetRecall(recall:MetaMemoryRecall):MetaMemoryRecall{
 const L=META_COMMON_MEMORY_LIMITS,result:MetaMemoryRecall={...recall,groups:recall.groups.slice(0,L.recallGroups),hits:recall.hits.slice(0,L.recallHits),truncated:recall.truncated||recall.hits.length>L.recallHits||recall.groups.length>L.recallGroups};
 while(new TextEncoder().encode(JSON.stringify(result)).length>L.recallBytes&&(result.hits.length||result.groups.length)){if(result.hits.length)result.hits.pop();else result.groups.pop();result.truncated=true;}
 return result;
}
