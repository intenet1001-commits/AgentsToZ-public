import {createHash} from 'node:crypto';
import {type CommonMemory,CommonMemoryError,commonMemoryHash,commonMemoryId} from './src/commonMemory';
import {portableCommonMemory,editPortableKnowledge,commonKnowledgeForState,commonKnowledgeSummary,recallPortableKnowledge,rebudgetRecall} from './src/commonMemoryPortableKnowledge';
import {MetaCommonMemoryStore} from './src/metaCommonMemoryStore';
import {type MetaCommonMemory,type MetaMemoryProject,type MetaMemoryRecall,type MetaMemoryRequest,META_COMMON_MEMORY_LIMITS,isMemberAssignment,metaMemoryApplies,parseMetaMemoryRequest} from './src/metaCommonMemoryContract';
import {type createCommonMemoryService,withCommonMemoryDeadline} from './common-memory-server';
const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
export const unifiedStateHash=(state:unknown)=>commonMemoryHash(JSON.stringify(canonical(state)));
type Service=ReturnType<typeof createCommonMemoryService>;
/** The cloud half of one recall (member lookup plus, rarely, one id check) must answer within this, or fail clearly. */
export const COMMON_MEMORY_RECALL_DEADLINE_MS=6_000;
/** Cloud hits plus unfenced local hits, best score first, within the recall caps (8 hits, 32 groups, 16 KB). */
function mergeRecall(cloud:MetaMemoryRecall,local:MetaMemoryRecall,allowed:Set<string>,more:boolean):MetaMemoryRecall{
 const localGroups=local.groups.filter(g=>allowed.has(g.id));
 const hits=[...cloud.hits,...local.hits.filter(h=>allowed.has(h.memoryId))].sort((a,b)=>b.score-a.score||a.memoryId.localeCompare(b.memoryId)||a.entryId.localeCompare(b.entryId)),groups=[...cloud.groups,...localGroups];
 return rebudgetRecall({state:'ready',groups,hits,truncated:cloud.truncated||more||(local.truncated&&(localGroups.length>0||local.groups.length>=META_COMMON_MEMORY_LIMITS.recallGroups))});
}
/** Local originals and all revision receipts remain fenced; cloud becomes the sole editor. */
export function createCommonMemoryMigration(store:MetaCommonMemoryStore,service:Service,projects:(fresh?:boolean)=>Promise<MetaMemoryProject[]>,options:{recallDeadlineMs?:number}={}){
 const preview=async(groupId:string,assignments:any[]=[],retireMemberIds:string[]=[])=>{
  if(!Array.isArray(assignments)||!Array.isArray(retireMemberIds)||assignments.length>16||retireMemberIds.length>16)throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','등록 프로젝트 연결 계획을 확인하세요.',400);
  groupId=commonMemoryId(groupId);const scopeId=await service.scope(),prior=store.handoff(groupId);
  if(prior)return {groupId,scopeId,state:prior.state,requestId:prior.requestId,sourceFingerprint:prior.sourceFingerprint};
  const existing=(await service.list()).find(g=>g.state.id===groupId);
  if(existing){
   if(assignments.length||retireMemberIds.length)throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','이미 있는 정본의 프로젝트 연결은 클라우드 관리에서 수정하세요.',400);
   const snapshot=store.read(groupId),current=await service.get(groupId);
   if(current.scopeId&&current.scopeId!==scopeId)throw new CommonMemoryError('COMMON_MEMORY_SCOPE_CHANGED','원래 클라우드 연결을 확인하세요.');
   if(!current.state.portableKnowledge)throw new CommonMemoryError('COMMON_MEMORY_KNOWLEDGE_INVALID','같은 ID의 클라우드 항목이 공통 지식 정본인지 확인하세요.');
   return {groupId,scopeId,mode:'follow-cloud',expectedLocalRevision:snapshot.revision,sourceFingerprint:createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),expectedCloudVersion:current.version,cloudHash:await unifiedStateHash(current.state),entryCount:current.state.portableKnowledge.current.entries.length,memberCount:current.state.portableKnowledge.current.members.filter(m=>m.mode==='include').length,localEntryCount:snapshot.entries.length,localReviewRequired:await unifiedStateHash(snapshot)!==await unifiedStateHash(current.state.portableKnowledge.snapshot),state:'ready',cloudWritten:false};
  }
  const snapshot=store.read(groupId),r=parseMetaMemoryRequest({operation:'save',memoryId:groupId,requestId:crypto.randomUUID(),expectedRevision:snapshot.revision,name:snapshot.name,description:snapshot.description,tags:snapshot.tags,categories:snapshot.categories,assignments});
  let current=assignments.length?editPortableKnowledge(snapshot,r,await projects(true),'000000000000000000000000'):structuredClone(snapshot);
  if(!Array.isArray(retireMemberIds)||retireMemberIds.length>16||retireMemberIds.some(id=>!snapshot.members.some(m=>m.memoryId===commonMemoryId(id))))throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','원본에 있는 이전 연결만 제외하세요.',400);
  if(retireMemberIds.length)current={...current,revision:snapshot.revision+1,members:current.members.map(m=>retireMemberIds.includes(m.memoryId)?{...m,mode:'exclude' as const}:m)};
  const state=await portableCommonMemory(snapshot,current),sourceFingerprint=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return {groupId,scopeId,expectedLocalRevision:snapshot.revision,sourceFingerprint,assignments,retireMemberIds,importedAt:state.portableKnowledge!.importedAt,entryCount:current.entries.length,memberCount:current.members.filter(m=>m.mode==='include').length,state:'ready'};
 };
 const execute=async(plan:any,requestId:string)=>{
  if(!plan||typeof plan!=='object')throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','이관 계획을 확인하세요.',400);
  const groupId=commonMemoryId(plan.groupId);requestId=commonMemoryId(requestId);const scopeId=await service.scope();
  if(plan.mode!==undefined&&!['create-cloud','follow-cloud'].includes(plan.mode))throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','정본 연결 계획을 확인하세요.',400);
  if(scopeId!==plan.scopeId)throw new CommonMemoryError('COMMON_MEMORY_SCOPE_CHANGED','계획을 만든 클라우드 연결을 확인하세요.');
  let receipt=store.handoff(groupId),state:CommonMemory;
  if(receipt){if(receipt.scopeId!==scopeId||receipt.requestId!==requestId)throw new CommonMemoryError('COMMON_MEMORY_REQUEST_CONFLICT','진행 중인 원래 이관 요청을 확인하세요.');if(receipt.state==='handed-off')return receipt;state=JSON.parse(store.preparedCloudState(groupId)!);}
  else{
   const snapshot=store.read(groupId);if(snapshot.revision!==plan.expectedLocalRevision||createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')!==plan.sourceFingerprint)throw new CommonMemoryError('COMMON_MEMORY_VERSION_CHANGED','이관 원본이 바뀌었습니다. 계획을 다시 확인하세요.');
   if(plan.mode==='follow-cloud'){
    const current=await service.get(groupId),hash=await unifiedStateHash(current.state);
    if(current.scopeId&&current.scopeId!==scopeId)throw new CommonMemoryError('COMMON_MEMORY_SCOPE_CHANGED','원래 클라우드 연결을 확인하세요.');
    if(!current.state.portableKnowledge||current.version!==plan.expectedCloudVersion||hash!==plan.cloudHash)throw new CommonMemoryError('COMMON_MEMORY_VERSION_CHANGED','정본이 바뀌었습니다. 연결 계획을 다시 확인하세요.');
    state=current.state;receipt=store.prepareHandoff({groupId,scopeId,requestId,requestHash:hash,sourceFingerprint:plan.sourceFingerprint,mode:'follow-cloud'},snapshot.revision,JSON.stringify(state));
    // Following a verified existing ID never imports, overwrites, or approves cloud entries.
    return store.completeHandoff(receipt,current.version,hash);
   }
   const r=parseMetaMemoryRequest({operation:'save',memoryId:groupId,requestId,expectedRevision:snapshot.revision,name:snapshot.name,description:snapshot.description,tags:snapshot.tags,categories:snapshot.categories,assignments:plan.assignments??[]});
   let current=plan.assignments?.length?editPortableKnowledge(snapshot,r,await projects(true),'000000000000000000000000'):structuredClone(snapshot);
   const retired=plan.retireMemberIds??[];if(!Array.isArray(retired)||retired.length>16||retired.some((id:string)=>!snapshot.members.some(m=>m.memoryId===commonMemoryId(id))))throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','이전 연결 제외 계획을 확인하세요.',400);
   if(retired.length)current={...current,revision:snapshot.revision+1,members:current.members.map(m=>retired.includes(m.memoryId)?{...m,mode:'exclude' as const}:m)};
   state=await portableCommonMemory(snapshot,current,new Date(plan.importedAt));
   receipt=store.prepareHandoff({groupId,scopeId,requestId,requestHash:await unifiedStateHash(state),sourceFingerprint:plan.sourceFingerprint},snapshot.revision,JSON.stringify(state));
  }
  if(receipt.mode==='follow-cloud'){
   const current=await service.get(groupId);
   if(current.scopeId&&current.scopeId!==scopeId)throw new CommonMemoryError('COMMON_MEMORY_SCOPE_CHANGED','원래 클라우드 연결을 확인하세요.');
   if(!current.state.portableKnowledge)throw new CommonMemoryError('COMMON_MEMORY_KNOWLEDGE_INVALID','원래 정본을 확인하세요.');
   return store.completeHandoff(receipt,current.version,await unifiedStateHash(current.state));
  }
  // Retrying uses precisely the staged state and request; absence of a receipt never releases the fence.
  const committed=await service.commit(state,0,receipt.requestId,receipt.requestHash,receipt.scopeId),readback=await service.get(groupId);
  const hash=await unifiedStateHash(readback.state);
  if(committed.version!==readback.version||hash!==receipt.requestHash)throw new CommonMemoryError('COMMON_MEMORY_MIGRATION_UNKNOWN','클라우드 응답 이후 상태가 바뀌었습니다. 이관 영수증과 원본은 보존했습니다.');
  return store.completeHandoff(receipt,readback.version,hash);
 };
 const status=async(groupId:string)=>{const receipt=store.handoff(commonMemoryId(groupId));if(!receipt)return {found:false};if(receipt.scopeId!==await service.scope())throw new CommonMemoryError('COMMON_MEMORY_SCOPE_CHANGED','이관된 클라우드 연결을 확인하세요.');return {found:true,...receipt,operation:receipt.mode==='follow-cloud'?{found:true,readOnly:true,version:(await service.get(groupId)).version}:await service.operationStatus(groupId,receipt.requestId,receipt.requestHash,receipt.scopeId)};};
 const cloudGroups=async()=>{const local=store.fenceState(),summaries=(await service.list()).filter(g=>g.state.knowledgeSummary||!(local.fenced.has(g.state.id)||local.unfenced.has(g.state.id))).map(g=>({...g,state:{...g.state,knowledgeSummary:g.state.knowledgeSummary??commonKnowledgeSummary(commonKnowledgeForState(g.state))}}));if(summaries.length>1000)throw new CommonMemoryError('COMMON_MEMORY_BUDGET_EXCEEDED','공통 지식 조회 범위를 줄이세요.');return summaries;};
 // True only when no local group has a cloud fence (every page, one read); then an unmigrated cloud may fall back to local.
 const unfenced=()=>store.fencedIds().size===0;
 const optionalCloudError=(e:unknown)=>e instanceof CommonMemoryError&&['COMMON_MEMORY_CLOUD_REQUIRED','COMMON_MEMORY_MIGRATION_REQUIRED'].includes(e.code);
 const recallDeadline=Math.max(1,options.recallDeadlineMs??COMMON_MEMORY_RECALL_DEADLINE_MS);
 const recallTimeout=()=>new CommonMemoryError('COMMON_MEMORY_RECALL_TIMEOUT','공통기억 조회가 늦어 멈췄습니다. 잠시 후 다시 시도하세요.',504);
 const withRecallDeadline=async<T>(run:()=>Promise<T>):Promise<T>=>{
  const started=Date.now();let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(recallTimeout()),recallDeadline);});
  try{return await Promise.race([withCommonMemoryDeadline(run,recallDeadline),timeout]);}
  catch(error){if(Date.now()-started>=recallDeadline)throw recallTimeout();throw error;}
  finally{clearTimeout(timer);}
 };
 /** Groups that apply to this memory. One member lookup when the service has it; otherwise the former list + per-group read. */
 const cloudApplicable=async(memoryId:string,category:string):Promise<{groups:MetaCommonMemory[];known:Set<string>|null;more:boolean}>=>{
  if(typeof service.knowledgeForMember==='function'){const found=await service.knowledgeForMember(memoryId,category);return {groups:found.groups.map(g=>g.current).filter(c=>metaMemoryApplies(c,memoryId,category)),known:null,more:found.truncated};}
  const all=await cloudGroups(),groups:MetaCommonMemory[]=[];
  for(const summary of all.filter(g=>!g.state.archived)){const current=(await service.get(summary.state.id)).state.portableKnowledge?.current;if(current&&metaMemoryApplies(current,memoryId,category))groups.push(current);if(groups.length>=META_COMMON_MEMORY_LIMITS.recallGroups)break;}
  return {groups,known:new Set(all.map(g=>g.state.id)),more:false};
 };
 const recall=async(memoryId:string,query:string,category=''):Promise<MetaMemoryRecall>=>{
  const fence=store.fenceState();
  try{return await withRecallDeadline(async()=>{
   let {groups,known,more}=await cloudApplicable(memoryId,category);
   const cloud=recallPortableKnowledge(groups,memoryId,query,category);
   // Fenced originals are cloud-owned: with nothing unfenced the local store is never opened.
   if(!fence.unfenced.size)return more?{...cloud,truncated:true}:cloud;
   const local=store.recall(memoryId,query,category),applied=new Set(groups.map(g=>g.id));
   let allowed=new Set(local.groups.filter(g=>fence.unfenced.has(g.id)&&!applied.has(g.id)).map(g=>g.id));
   // A local copy whose id the cloud already holds (e.g. migrated on another Mac) is not merged; checked only when it matters.
   if(allowed.size&&!known)known=new Set((await cloudGroups()).map(g=>g.state.id));
   if(known)allowed=new Set([...allowed].filter(id=>!known!.has(id)));
   return mergeRecall(cloud,local,allowed,more);
  });}catch(error){if(optionalCloudError(error)&&!fence.fenced.size)return store.recall(memoryId,query,category);throw error;}
 };
 /** What a knowledge edit needs: registered projects (a fresh scan) only for project-card assignments or a portId source,
  *  and a fresh cloud check (memoryTargets) for {memoryId} members, which never consult this Mac's folders. */
 const editInputs=async(request:MetaMemoryRequest)=>{
  const usesPorts=request.operation==='save'?request.assignments.some(a=>!isMemberAssignment(a)):'portId' in request&&!!request.portId;
  const memberIds=request.operation==='save'?request.assignments.filter(isMemberAssignment).map(a=>a.memoryId):[];
  const [rows,targets]=await Promise.all([usesPorts?projects(true):Promise.resolve([] as MetaMemoryProject[]),memberIds.length?service.memoryTargets(memberIds):Promise.resolve([] as Array<{memoryId:string;name:string}>)]);
  return {rows,verified:new Map(targets.map(t=>[t.memoryId,t.name]))};
 };
 const legacy=async(request:MetaMemoryRequest):Promise<{handled:boolean;result?:any}>=>{
  if(request.operation==='save'&&!request.memoryId){const {rows,verified}=await editInputs(request),saved=await service.knowledge(request,rows,undefined,verified);return {handled:true,result:{memory:saved.state.portableKnowledge!.current,storage:'cloud',replayed:saved.replayed??false}};}
  if(request.operation==='projects'||request.operation==='prepare-project'||request.operation==='import')return {handled:false};
  if(request.operation==='list'){
   const scopeId=await service.scope(),cloud=(await cloudGroups()).map(g=>g.state.knowledgeSummary!),ids=new Set(cloud.map(m=>m.id)),fenced=store.fencedIds(),local=store.list(request.query,0).memories.filter(m=>!fenced.has(m.id)&&!ids.has(m.id));
   const groups=[...cloud,...local].filter(m=>`${m.name} ${m.description} ${m.tags.join(' ')}`.toLowerCase().includes(request.query.toLowerCase()));
   return {handled:true,result:{memories:groups.slice(request.offset,request.offset+50),nextOffset:request.offset+50<groups.length?request.offset+50:null,total:groups.length,storage:'cloud',scopeId,automaticRemoteSync:true}};
  }
  if(request.operation==='recall'){
   // Registered rows come from the identity cache; only a missing row asks for a fresh scan. A memoryId alone grants no
   // access: it must be the memory of a registered folder (main or worktree) on this Mac.
   const byMemory='projectMemoryId' in request&&request.projectMemoryId?commonMemoryId(request.projectMemoryId):null,portId='portId' in request?request.portId:null;
   const match=(rows:MetaMemoryProject[])=>byMemory?rows.find(p=>p.state==='ready'&&p.memoryId?.toLowerCase()===byMemory):rows.find(p=>p.id===portId);
   const p=match(await projects(false))??match(await projects(true));
   if(!p?.memoryId||p.state!=='ready')throw new CommonMemoryError('COMMON_MEMORY_PROJECT_MEMORY_REQUIRED','등록 프로젝트의 기억을 확인하세요.');
   return {handled:true,result:await recall(byMemory??p.memoryId,request.query,p.category??'')};
  }
  const id='memoryId' in request?request.memoryId:null;if(!id)return {handled:false};const fence=store.handoff(id),summary=(await cloudGroups()).find(g=>g.state.id===id);
  if(fence&&fence.scopeId!==await service.scope())throw new CommonMemoryError('COMMON_MEMORY_SCOPE_CHANGED','원래 이관된 클라우드 연결을 확인하세요.');
  if(fence?.state==='prepared')throw new CommonMemoryError('COMMON_MEMORY_MIGRATION_UNKNOWN','이관 응답을 확인해야 합니다. 원래 요청으로 상태를 확인하세요.');
  if(!summary)return fence?(()=>{throw new CommonMemoryError('COMMON_MEMORY_CLOUD_UNAVAILABLE','클라우드 정본을 찾지 못했습니다. 원본 사본과 영수증을 보존합니다.',503);})():{handled:false};
  const current=await service.get(id),memory=commonKnowledgeForState(current.state);
  if(request.operation==='history')return {handled:true,result:{history:await service.knowledgeHistory(id),legacyHistory:store.list().memories.some(m=>m.id===id)?store.history(id):[],storage:'cloud'}};
  if(request.operation==='read'){if(request.withProjects===false)return {handled:true,result:{memory,storage:'cloud',scopeId:current.scopeId,memberForm:'memory'}};const rows=await projects();return {handled:true,result:{memory,projects:rows,appliedProjectIds:rows.filter(p=>p.memoryId&&metaMemoryApplies(memory,p.memoryId,p.category)).map(p=>p.id),storage:'cloud',scopeId:current.scopeId,memberForm:'memory'}};}
  if(request.operation==='export')return {handled:true,result:{format:'agentstoz-meta-common-memory',schemaVersion:1,snapshot:memory,checksum:createHash('sha256').update(JSON.stringify(memory)).digest('hex'),automaticRemoteSync:true}};
  const {rows,verified}=await editInputs(request),saved=await service.knowledge(request,rows,current.scopeId,verified);
  return {handled:true,result:{memory:saved.state.portableKnowledge!.current,storage:'cloud',replayed:saved.replayed??false}};
 };
 // No list probe: the first real cloud read in legacy() reports an unmigrated or absent cloud, and with nothing fenced
 // the desktop then keeps using its local store exactly as the former probe decided.
 const compatibility=async(request:MetaMemoryRequest)=>{try{await service.scope();return await legacy(request);}catch(error){if(optionalCloudError(error)&&unfenced())return {handled:false};throw error;}};
 /** The compatibility decision as a yes/no, for the phone's local-common create gate: a client being configured is not enough;
  *  the first real cloud read must succeed. Absent or unmigrated → false; any other failure is reported, not guessed. */
 const cloudAvailable=async()=>{try{await service.scope();await service.list();return true;}catch(error){if(optionalCloudError(error))return false;throw error;}};
 return {preview,execute,status,legacy,compatibility,recall,cloudAvailable};
}
