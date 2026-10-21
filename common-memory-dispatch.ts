// The host's cloud common-memory dispatcher (HTTP, MCP and the phone's encrypted RPC all land here). Its dependencies are
// injected so tests run the real dispatcher on the fake cloud; api-server.ts only wires them.
import {CommonMemoryError,commonMemoryHash} from './src/commonMemory';
import {validateCommonMemoryProjectPlan} from './src/commonMemoryProjects';
import {metaMemoryRemoteProjectRef} from './src/metaCommonMemoryRemoteHost';
import {projectLaunchDirectoryIdentity} from './src/projectLaunchReceipt';
import {parseCommonMemoryRequest} from './src/commonMemoryRequest';
import {COMMON_MEMORY_HOST_CAPABILITIES,COMMON_MEMORY_REMOTE_INSPECT_PAGE_SIZE} from './src/commonMemoryCapabilities';
import {type MetaMemoryProject,parseMetaMemoryRequest} from './src/metaCommonMemoryContract';
import {type MetaCommonMemoryStore} from './src/metaCommonMemoryStore';
import {createCommonMemoryMigration} from './common-memory-migration-server';
import {type createCommonMemoryService} from './common-memory-server';
import {type createCommonMemoryProjectManager} from './common-memory-projects-server';

type Service=ReturnType<typeof createCommonMemoryService>;
type Migration=ReturnType<typeof createCommonMemoryMigration>;
type ProjectManager=ReturnType<typeof createCommonMemoryProjectManager>;
type ProjectsLoader=(fresh:boolean)=>Promise<MetaMemoryProject[]>;

// Reads only display the project list, so they go through the identity cache. Opening one cloud common memory
// sends several of these at once and each fresh scan spawned git twice per registered project (~0.2-0.3 s each).
// Anything that writes (or an operation added later) still re-reads fresh before acting.
export const META_MEMORY_READ_ONLY_OPERATIONS=new Set(['projects','list','read','history','export','recall']);

/**
 * Registered projects for one knowledge request, enumerated only when the operation first asks (list, history, export,
 * archive and review never do; save with project cards, read, recall by portId and portId sources do). One scan per
 * freshness per request. A call without an explicit freshness follows the operation's read-only class.
 */
export function lazyProjects(load:ProjectsLoader,operation:string):(fresh?:boolean)=>Promise<MetaMemoryProject[]>{
  const memo=new Map<boolean,Promise<MetaMemoryProject[]>>();
  return fresh=>{const key=fresh??!META_MEMORY_READ_ONLY_OPERATIONS.has(operation);let found=memo.get(key);if(!found){found=load(key);memo.set(key,found);}return found;};
}

export interface CommonMemoryDispatchDeps{
  /** The host's default cloud service (requests from a phone pass their own permission-checked service). */
  service:Service;
  store:MetaCommonMemoryStore;
  /** The host-level migration (local-only migration-* operations). */
  migration:Pick<Migration,'preview'|'execute'|'status'>;
  projects:(fresh?:boolean)=>Promise<MetaMemoryProject[]>;
  /** Local category of a long-term memory registered on this Mac (main or worktree); null when none owns it. */
  memoryCategory:(memoryId:string)=>Promise<string|null>;
  resolveProject:(portId:unknown)=>Promise<{memoryId?:string|null;projectName?:string|null}>;
  /** Raw Supabase client for the project-memory label/head reads, or null without cloud. */
  client:()=>any;
  workspaceRoots:()=>Promise<Array<{workspaceRootId:string;name:string;path:string}>>;
  /** A permission-checked cloud service for one phone request. */
  remoteService:(assertActive:()=>void)=>Service;
  /** Device identity of a workspace root (phones may clone only into roots they were separately allowed). */
  rootIdentity?:(path:string)=>string;
  projectManager:Pick<ProjectManager,'status'|'membersStatus'|'plan'|'add'>;
  runInGroup:<T>(groupId:string|undefined,run:()=>Promise<T>)=>Promise<T>;
  bindProject:(portId:string,projectGoal:string,groupIds:string[],expectedSelections?:any)=>Promise<any>;
}
export interface CommonMemoryDispatchOptions{
  /** A phone maps registered projects to device-bound references; it supplies its own loader. */
  projects?:ProjectsLoader;
}

/** Knowledge operations an AI connection may not run: accepting, directly saving or importing stays on the review surface. */
export const COMMON_MEMORY_AI_REFUSED_KNOWLEDGE=['review-entry','review-entries','save-entry','import','prepare-project'] as const;
const MCP_DISPATCHED=new Set(['updates','prepare-workroom','knowledge','migration-preview','migration-execute','project-links','catalog','read-source','read-cloud-source','topic-candidates','projects-status','projects-plan','projects-add','operation-status','project-add-status']);
export const COMMON_MEMORY_MCP_LIST_PAGE=10;
export const COMMON_MEMORY_MCP_INSPECT_PAGE=5;

export function createCommonMemoryDispatch(deps:CommonMemoryDispatchDeps){
  const scopeChanged=()=>new CommonMemoryError('COMMON_MEMORY_SCOPE_CHANGED','선택된 공통기억의 클라우드 연결이 바뀌었습니다.');
  /**
   * Groups a long-term memory takes part in: knowledge groups that include it (one containment read) and goal groups
   * its binding selected (older Macs still create those). Three reads in parallel, no per-group read.
   */
  const projectLinks=async(memoryId:string|null,fallbackName:string,service:Service=deps.service)=>{
    if(!memoryId)return {memoryId:null,name:fallbackName,groups:[],warning:'전용 장기기억을 먼저 확인하세요.'};
    const client=deps.client();if(!client)throw new CommonMemoryError('COMMON_MEMORY_CLOUD_REQUIRED','프로젝트 기억 이름과 공통기억 연결을 확인하려면 클라우드가 필요합니다.',503);
    const [label,head,summaries,binding,members]=await Promise.all([
      client.from('portmgr_project_memory_labels').select('display_name').eq('memory_id',memoryId).maybeSingle(),
      client.from('portmgr_project_memory_heads').select('head_revision_id').eq('memory_id',memoryId).maybeSingle(),
      service.list(),service.binding(memoryId),service.knowledgeForMember(memoryId),
    ]);
    let sharedName=label.data?.display_name;if(!sharedName&&head.data?.head_revision_id){const revision=await client.from('portmgr_project_memory_revisions').select('project_name').eq('id',head.data.head_revision_id).maybeSingle();sharedName=revision.data?.project_name;}
    const memberRevision=new Map(members.groups.map(g=>[g.groupId,g.current.revision]));
    const groups=[];
    for(const summary of summaries){if(summary.state.archived)continue;const selected=!!binding?.selections.some(s=>s.groupId===summary.state.id),member=memberRevision.has(summary.state.id),revision=memberRevision.get(summary.state.id)??summary.state.knowledgeSummary?.revision??null;if(selected||member)groups.push({id:summary.state.id,name:summary.state.name,goal:summary.state.goal.objective,knowledgeRevision:revision,goalConfigured:summary.state.goalConfigured!==false,status:member&&summary.state.goalConfigured===false?'기억 항목 사용 중':selected&&summary.state.publication?.goalVersion===summary.state.goalVersion?'선택한 게시본 사용 중':'목표 검토 필요',publicationId:summary.state.publication?.id??null,version:summary.version});}
    return {memoryId,name:sharedName||fallbackName,groups,scopeId:await service.scope()};
  };
  const dispatch=async(operation:string,input:Record<string,any>={},service:Service=deps.service,assertActive:()=>void=()=>{},owner='local',options:CommonMemoryDispatchOptions={}):Promise<any>=>{
    const {input:body}=parseCommonMemoryRequest({operation,input});assertActive();
    if(operation.startsWith('migration-')){if(owner!=='local')throw new CommonMemoryError('COMMON_MEMORY_PERMISSION_REQUIRED','기존 로컬 공통기억 이관은 Mac에서 수행하세요.',403);if(operation==='migration-preview')return {plan:await deps.migration.preview(body.groupId,body.assignments??[],body.retireMemberIds??[])};if(operation==='migration-execute')return {receipt:await deps.migration.execute(body.plan,body.requestId)};return deps.migration.status(body.groupId);}
    if(operation==='knowledge'){
      if(body.scopeId&&body.scopeId!==await service.scope())throw scopeChanged();
      const request=parseMetaMemoryRequest(body.request),projects=lazyProjects(options.projects??(fresh=>deps.projects(fresh)),request.operation);
      if(request.operation==='projects')return {projects:await projects()};
      if(request.operation==='prepare-project')throw new CommonMemoryError('COMMON_MEMORY_PERMISSION_REQUIRED','전용 기억 준비는 프로젝트 영역에서 수행하세요.',403);
      const r=await createCommonMemoryMigration(deps.store,service,projects).legacy(request);
      if(!r.handled)throw new CommonMemoryError('COMMON_MEMORY_KNOWLEDGE_INVALID','클라우드로 이관된 공통기억을 선택하세요.');return r.result;
    }
    // Names come from the cached catalog walk (30 s), not a fresh page loop per call.
    if(operation==='project-names'){const [local,catalog]=await Promise.all([deps.projects(),service.catalogAll()]),names=new Map(catalog.sources.map(source=>[source.memoryId,source.name]));return {projects:local.map(p=>({projectId:p.id,name:p.memoryId?names.get(p.memoryId)??p.name:p.name,memoryId:p.memoryId}))};}
    if(operation==='project-links'){if(body.memoryId)return projectLinks(body.memoryId,body.memoryId,service);const project=await deps.resolveProject(body.portId);return projectLinks(project.memoryId??null,project.projectName??'',service);}
    if(operation==='application-status')return service.applicationStatus(body.groupId,body.applicationId,body.scopeId);
    if(operation==='read-source')return service.readSource(body.groupId,body.memoryId,body.entryId,body.contentHash,body.scopeId);
    if(operation==='operation-status')return service.operationStatus(body.groupId,body.requestId,body.requestHash,body.scopeId);
    if(operation==='project-add-status')return deps.projectManager.status(body.requestId,owner);
    if(operation==='roots')return {scopeId:await service.scope(),roots:(await deps.workspaceRoots()).map(r=>({workspaceRootId:r.workspaceRootId,name:r.name}))};
    if(operation==='list'){
      const [groups,scopeId]=await Promise.all([service.list(),service.scope()]),offset=body.offset??0,page=[];let bytes=0;
      for(const g of groups.slice(offset,offset+50)){const size=Buffer.byteLength(JSON.stringify(g));if(bytes+size>350_000)break;bytes+=size;page.push(g);}
      if(!page.length&&offset<groups.length)throw new CommonMemoryError('COMMON_MEMORY_BUDGET_EXCEEDED','공통기억 목록 항목의 크기를 확인하세요.');
      // Local copies still waiting for migration: one fence read over every local page, not one open per group.
      const legacyPending=owner==='local'?(()=>{const fenced=deps.store.fencedIds();return deps.store.list().memories.filter(m=>!fenced.has(m.id));})():null;
      // A phone cannot migrate, so it gets only the number of this Mac's local groups the cloud does not hold yet (the
      // ones it would otherwise list but not open). It keeps '이 Mac의 기억' visible while that number is not 0.
      const localPending=owner==='local'?null:(()=>{const cloudIds=new Set(groups.map(g=>g.state.id));return [...deps.store.fenceState().unfenced].filter(id=>!cloudIds.has(id)).length;})();
      return {groups:page,nextOffset:offset+page.length<groups.length?offset+page.length:null,total:groups.length,...(legacyPending?{legacyPending}:{}),...(localPending!==null?{localPending}:{}),hostCapabilities:[...COMMON_MEMORY_HOST_CAPABILITIES],scopeId};
    }
    if(operation==='catalog')return service.catalog(body.after??null);
    if(operation==='read-cloud-source')return service.readCloudSource(body.memoryId,body.offset??0,body.scopeId);
    if(operation==='topic-candidates')return service.topicCandidates(body.after??null,body.memoryIds);
    if(operation==='updates')return service.updates(body.offset??0);
    if(operation==='prepare-workroom')return service.workroomDraft(body.kind,body.groupId,[],body.scopeId);
    // A phone pages source entries 5 at a time; nextOffset still walks them all.
    if(operation==='inspect')return service.inspect(body.groupId,body.offset,body.itemOffset,body.analysis===true,owner==='local'?undefined:COMMON_MEMORY_REMOTE_INSPECT_PAGE_SIZE);
    if(operation==='history')return {revisions:await service.history(body.groupId)};
    if(operation==='manage')return service.action(body);
    if(operation==='recommend')return service.recommend(body.projectGoal);
    if(operation==='recall'){
      if(body.memoryId===undefined)return service.recall(body.groupId,body.task,body.revisionId,body.scopeId);
      // A memoryId alone grants nothing: it must be the long-term memory of a folder registered on this Mac.
      if(body.scopeId&&body.scopeId!==await service.scope())throw scopeChanged();
      const category=await deps.memoryCategory(body.memoryId);assertActive();
      if(category===null)throw new CommonMemoryError('COMMON_MEMORY_PROJECT_MEMORY_REQUIRED','등록 프로젝트의 기억을 확인하세요.');
      const recalled=await createCommonMemoryMigration(deps.store,service,deps.projects).recall(body.memoryId,body.query,category);
      return {...recalled,mode:'memory',memoryId:body.memoryId};
    }
    if(operation==='report')return service.report(body.groupId,body.application,body.scopeId);
    if(operation==='preflight')return {selections:await service.selections(body.groupIds??[],body.expectedSelections)};
    if(operation==='projects-status')return deps.projectManager.membersStatus(body.groupId);
    if(operation==='projects-plan')return {plan:await deps.projectManager.plan(body.groupId,body.workspaceRootId)};
    if(operation==='projects-add')return deps.runInGroup(body.plan?.groupId,()=>deps.projectManager.add(body.plan,body.requestId,body.memoryId,owner,assertActive));
    if(operation==='bind-project')return deps.bindProject(body.portId,body.projectGoal,body.groupIds??[],body.expectedSelections);
    throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','지원하는 공통기억 동작을 선택하세요.',400);
  };
  /**
   * One phone (remote owner) request on the cloud kind. Paths and registration ids never leave the Mac: projects and
   * workspace roots are device-bound references. Project-card links, names, binding and migration stay on the Mac.
   */
  const remote=async(owner:string,request:unknown,active:()=>boolean,canAdd?:(rootId?:string,identity?:string)=>boolean):Promise<any>=>{
    const assertActive=()=>{if(!active())throw new CommonMemoryError('COMMON_MEMORY_PERMISSION_CHANGED','클라우드 공통기억 권한이 변경됐습니다.',403);};
    const {operation,input}=parseCommonMemoryRequest(request);
    // project-links by memoryId is a pure cloud lookup (which groups hold this long-term memory); by portId it stays on the Mac.
    if(operation==='project-links'&&input.memoryId===undefined||operation==='project-names'||operation.startsWith('migration-'))throw new CommonMemoryError('COMMON_MEMORY_PERMISSION_REQUIRED','이 작업은 Mac 프로젝트 영역에서 수행하세요.',403);
    if(operation==='bind-project')throw new CommonMemoryError('COMMON_MEMORY_PERMISSION_REQUIRED','프로젝트의 목표 연결은 해당 프로젝트에서 관리하세요.',403);
    if(operation==='projects-add'&&!canAdd?.())throw new CommonMemoryError('COMMON_MEMORY_PERMISSION_REQUIRED','Mac에서 이 기기의 프로젝트 Clone·등록 권한을 따로 허용하세요.',403);
    const service=deps.remoteService(assertActive),identity=deps.rootIdentity??projectLaunchDirectoryIdentity;
    // Workspace roots are read only by the operations that use them.
    const roots=['roots','projects-plan','projects-add'].includes(operation)?(await deps.workspaceRoots()).filter(r=>canAdd?.(r.workspaceRootId,identity(r.path))):[],ref=(id:string)=>metaMemoryRemoteProjectRef(owner,'common-root:'+id);
    if(operation==='roots')return {scopeId:await service.scope(),roots:roots.map(r=>({workspaceRootId:ref(r.workspaceRootId),name:r.name}))};
    if(operation==='projects-plan'){const root=roots.find(r=>ref(r.workspaceRootId)===input.workspaceRootId);if(!root)throw new CommonMemoryError('COMMON_MEMORY_ROOT_CHANGED','이 연결에서 조회한 작업 루트를 선택하세요.');input.workspaceRootId=root.workspaceRootId;}
    if(operation==='projects-add'){const p=await validateCommonMemoryProjectPlan(input.plan),root=roots.find(r=>ref(r.workspaceRootId)===p.workspaceRootId);if(!root)throw new CommonMemoryError('COMMON_MEMORY_ROOT_CHANGED','작업 루트 연결이 변경됐습니다.');const {planHash,...body}=p;body.workspaceRootId=root.workspaceRootId;input.plan={...body,planHash:await commonMemoryHash(JSON.stringify(body))};}
    // Knowledge requests see registered projects only as device-bound references, enumerated only when the operation asks.
    const projects=async(fresh:boolean)=>{const rows=await deps.projects(fresh);assertActive();return rows.map(p=>({...p,id:metaMemoryRemoteProjectRef(owner,p.id)}));};
    const result=await dispatch(operation,input,service,operation==='projects-add'?()=>{assertActive();if(!canAdd?.(input.plan.workspaceRootId,input.plan.rootIdentity))throw new CommonMemoryError('COMMON_MEMORY_PERMISSION_CHANGED','프로젝트 추가 권한이 변경됐습니다.',403);}:assertActive,owner,{projects});
    if(operation==='projects-plan'){const {planHash,...body}=result.plan;body.workspaceRootId=ref(body.workspaceRootId);result.plan={...body,planHash:await commonMemoryHash(JSON.stringify(body))};}
    if(operation==='manage')return {state:{id:result.state.id},version:result.version,scopeId:result.scopeId,replayed:result.replayed};
    return result;
  };
  /**
   * One agentstoz_use (AI) request, already parsed by parseAgentsToZUseCommonMemory. The host enforces the AI rules
   * itself, so an older MCP binary is bound too. Removed tools' operations (migration-*) stay accepted.
   */
  const mcp=async(r:Record<string,any>,portId?:string):Promise<any>=>{
    const {op,...fields}=r;
    if(op==='knowledge'&&(COMMON_MEMORY_AI_REFUSED_KNOWLEDGE as readonly string[]).includes(String(fields.request?.operation)))throw new CommonMemoryError('COMMON_MEMORY_PERMISSION_REQUIRED','AI 변경은 propose-entry로 제안하세요. 후보 승인·직접 저장은 앱의 검토 화면에서 합니다.',403);
    if(MCP_DISPATCHED.has(op))return dispatch(op,fields);
    if(op==='list')return {...await deps.service.listPage(fields.offset??0,COMMON_MEMORY_MCP_LIST_PAGE),paged:true};
    if(op==='inspect')return deps.service.inspect(fields.groupId,fields.offset??0,0,fields.analysis===true,COMMON_MEMORY_MCP_INSPECT_PAGE);
    if(op==='recall'&&(fields.memoryId!==undefined||fields.portId!==undefined)){
      // A portId is only a way to name a registered project; its long-term memory is resolved here, never trusted from the AI.
      let memoryId=fields.memoryId as string|undefined;
      if(memoryId===undefined){const project=await deps.resolveProject(fields.portId);if(!project.memoryId)throw new CommonMemoryError('COMMON_MEMORY_PROJECT_MEMORY_REQUIRED','이 프로젝트의 장기기억을 먼저 시작하세요.');memoryId=project.memoryId;}
      return dispatch('recall',{memoryId,query:fields.query,...(fields.scopeId?{scopeId:fields.scopeId}:{})});
    }
    if(op==='recall')return deps.service.recall(fields.groupId,fields.task,fields.revisionId,fields.scopeId);
    if(op==='recommend')return deps.service.recommend(fields.projectGoal);
    if(op==='manage')return deps.service.action(fields.request);
    if(op==='history')return {revisions:await deps.service.history(fields.groupId)};
    if(op==='bind-project')return deps.bindProject(portId!,fields.projectGoal,fields.groupIds??[],fields.expectedSelections);
    if(op==='report')return deps.service.report(fields.groupId,fields.application,fields.scopeId);
    throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','지원하는 공통기억 동작을 선택하세요.',400);
  };
  return {dispatch,projectLinks,remote,mcp};
}

/** The bounded MCP answer for one common-memory operation (list and inspect arrive already paged from mcp()). */
export function commonMemoryMcpView(op:string,data:any,offset=0){
  const goal=(g:any)=>({...g,objective:String(g.objective).slice(0,600),include:g.include.slice(0,3).map((s:string)=>s.slice(0,100)),exclude:g.exclude.slice(0,3).map((s:string)=>s.slice(0,100)),conditions:g.conditions.slice(0,3).map((s:string)=>s.slice(0,100)),checks:g.checks.slice(0,3).map((s:string)=>s.slice(0,100)),sdkModules:(g.sdkModules??[]).slice(0,8),summaryOnly:true});
  const summary=(s:any)=>({id:s.id,name:s.name,goalConfigured:s.goalConfigured!==false,knowledgeSummary:s.knowledgeSummary??null,goal:goal(s.goal),goalVersion:s.goalVersion,sourceMemoryIds:s.sourceMemoryIds,archived:s.archived,publication:s.publication?{id:s.publication.id,goalVersion:s.publication.goalVersion}:null});
  const page=(rows:any[],start:number,size:number)=>{const selected:any[]=[];let bytes=0;for(const row of rows.slice(start,start+size)){const length=Buffer.byteLength(JSON.stringify(row));if(bytes+length>12_000)break;bytes+=length;selected.push(row);}return {selected,nextOffset:start+selected.length<rows.length?start+selected.length:null};};
  // A paged list (listPage) holds only the requested rows; the byte budget may still stop early.
  if(op==='list'&&data.paged){const p=page(data.groups.map((r:any)=>({state:summary(r.state),version:r.version})),0,10),next=p.selected.length<data.groups.length?offset+p.selected.length:data.nextOffset;return {groups:p.selected,total:next===null?offset+p.selected.length:null,nextOffset:next};}
  if(op==='list'){const p=page(data.groups.map((r:any)=>({state:summary(r.state),version:r.version})),offset,10);return {groups:p.selected,total:data.groups.length,nextOffset:p.nextOffset};}
  if(op==='inspect'&&data.paged)return {analysis:data.analysis===true,scopeId:data.scopeId,state:summary(data.state),version:data.version,ready:data.ready,sourceChoices:(data.sourceChoices??[]).map((s:any)=>({...s,name:s.name.slice(0,80)})),sourceWarning:data.sourceWarning,sourceEntryCount:data.sourceEntryCount,sourceEntries:data.sourceEntries.slice(0,5).map((e:any)=>({...e,excerpt:e.excerpt.slice(0,1200),excerptTruncated:e.excerpt.length>1200})),nextOffset:data.nextOffset,items:data.state.items.slice(0,10).map((i:any)=>({id:i.id,title:i.title,state:i.state,goalVersion:i.goalVersion})),itemCount:data.itemCount,needsReviewCount:data.needsReview.length,applicationCountInRecentWindow:data.applications.length};
  if(op==='inspect')return {analysis:data.analysis===true,scopeId:data.scopeId,state:summary(data.state),version:data.version,ready:data.ready,sourceChoices:(data.sourceChoices??[]).map((s:any)=>({...s,name:s.name.slice(0,80)})),sourceWarning:data.sourceWarning,sourceEntryCount:data.sourceEntries.length,sourceEntries:data.sourceEntries.slice(offset,offset+5).map((e:any)=>({...e,excerpt:e.excerpt.slice(0,1200),excerptTruncated:e.excerpt.length>1200})),nextOffset:offset+5<data.sourceEntries.length?offset+5:null,items:data.state.items.slice(0,10).map((i:any)=>({id:i.id,title:i.title,state:i.state,goalVersion:i.goalVersion})),needsReviewCount:data.needsReview.length,applicationCountInRecentWindow:data.applications.length};
  if(op==='manage')return {scopeId:data.scopeId,state:summary(data.state),version:data.version,...(data.replayed?{replayed:true,committedVersion:data.committedVersion}:{})};
  if(op==='recommend'){const rows=data.recommendations.map((r:any)=>({...r,goal:goal(r.goal),reason:r.reason.slice(0,300),conditions:r.conditions.slice(0,3).map((s:string)=>s.slice(0,100))})),p=page(rows,0,8);return {...data,recommendations:p.selected,blocked:data.blocked.slice(0,8),scanComplete:data.scanComplete&&p.nextOffset===null};}
  if(op==='history')return {revisions:data.revisions.map((r:any)=>({...r,goal:goal(r.goal)})).slice(0,5),windowLimit:5};
  return data;
}

