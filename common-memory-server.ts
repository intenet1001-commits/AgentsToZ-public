import {commonMemoryWorkroomDraft,commonMemoryUpdateAdvice,commonMemoryTracking} from './src/commonMemoryFollowup';
import {commonTopicDiscovery,commonTopicProposalText,readCommonTopicEvidence,withCommonTopicEvidence} from './src/commonMemoryTopicEvidence';
import {COMMON_MEMORY_DISCOVERY_MAX_BYTES,COMMON_MEMORY_DISCOVERY_MAX_ENTRIES} from './src/commonMemoryLessonClusters';
import {metaMemoryCreationId} from './src/metaCommonMemoryIdentity';
import {validatePortableCommonKnowledge,portableKnowledgeView,commonKnowledgeForState,commonKnowledgeSummary,editPortableKnowledge,portableCommonMemory} from './src/commonMemoryPortableKnowledge';
import {parseMetaMemoryRequest,validateMetaMemorySnapshot,metaMemoryApplies,type MetaMemoryProject,type MetaCommonMemory} from './src/metaCommonMemoryContract';
import {parseCommonMemoryRequest} from './src/commonMemoryRequest';
import {normalizeGitHubRepositoryUrl} from './src/githubUrls';
import {createHash} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {mkdirSync,existsSync,readFileSync,renameSync,writeFileSync,lstatSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {fsyncExistingProjectMemoryFile,fsyncProjectMemoryDirectory} from './src/projectMemoryDurability';
import {parseProjectMemoryEntries} from './src/projectMemoryRecall';
import {detectProjectMemory} from './project-memory-server';
import {CommonMemoryError,commonMemoryHash,commonMemoryId,commonMemoryText,commonMemorySourceIds,createCommonMemory,configureCommonMemory,reviewCommonMemoryItem,refreshCommonMemorySources,publishCommonMemory,commonMemoryReady,recommendCommonMemories,recallCommonMemory,normalizeCommonMemoryApplication,type CommonMemory,type CommonMemorySourceEntry,type CommonMemorySourceHead,type CommonMemorySelection} from './src/commonMemory';

export type CommonMemoryRecord={state:CommonMemory;version:number;scopeId?:string};
type SourceSnapshot={entries:CommonMemorySourceEntry[];heads:CommonMemorySourceHead[];choices?:Array<{memoryId:string;name:string;githubUrl:string|null}>};
function fail(error:any):never{
  const code=String(error?.message??error?.code??'');
  if(/COMMON_MEMORY_(VERSION_CHANGED|SOURCE_CHANGED|REQUEST_CONFLICT|REVIEW_REQUIRED)/.test(code))throw new CommonMemoryError(code.match(/COMMON_MEMORY_[A-Z_]+/)![0],'목표·원본·게시 이력이 바뀌었습니다. 현재 내용을 다시 확인하세요.');
  if(/42P01|PGRST202|PGRST205/.test(String(error?.code)))throw new CommonMemoryError('COMMON_MEMORY_MIGRATION_REQUIRED','클라우드 공통기억 업데이트가 필요합니다. 기존 장기기억은 유지됩니다.',503);
  throw new CommonMemoryError('COMMON_MEMORY_CLOUD_UNAVAILABLE','클라우드 공통기억을 확인하지 못했습니다. 연결과 접근 권한을 확인하세요.',503);
}
function record(row:any):CommonMemoryRecord {
  const state=row.state as CommonMemory,version=Number(row.version);
  if(!state||state.schemaVersion!==1||state.id!==row.group_id||!Number.isSafeInteger(version)||version<1||!Array.isArray(state.items)||state.items.length>500||!Number.isSafeInteger(state.goalVersion))throw new CommonMemoryError('COMMON_MEMORY_FORMAT_UNSUPPORTED','지원하지 않는 공통기억 형식입니다. 앱을 업데이트하세요.');
  if(state.portableKnowledge){state.portableKnowledge=validatePortableCommonKnowledge(state.portableKnowledge);if(state.portableKnowledge.current.id!==state.id)throw new CommonMemoryError('COMMON_MEMORY_KNOWLEDGE_INVALID','공통 지식 ID를 확인하세요.');}
  return {state,version};
}
// One deadline for a whole call chain (a recall touches several reads); each read keeps its own 15 s limit too.
const chainDeadline=new AsyncLocalStorage<AbortSignal>();
export function withCommonMemoryDeadline<T>(operation:()=>Promise<T>,ms=20_000):Promise<T>{
  const outer=chainDeadline.getStore(),own=AbortSignal.timeout(Math.max(1,ms));
  return chainDeadline.run(outer?AbortSignal.any([outer,own]):own,operation);
}
// Module-level read caches. A sidecar builds a fresh client (and often a fresh service) per request, so they are keyed by
// the cloud scope. Writes through this module clear them; project-memory pushes from elsewhere show up within the TTL.
// `commonMemoryCachePartition` lets distinct client families that share a scope (isolated test clouds) keep separate caches.
const CATALOG_TTL_MS=30_000,KNOWLEDGE_TTL_MS=15_000,REVISION_TTL_MS=60_000,REVISION_CACHE_ENTRIES=8,REVISION_CACHE_BYTES=8_000_000;
type ParsedRevision={id:string;memory_id:string;content:string;content_hash:string;project_name:unknown;github_url:unknown;entries:ReturnType<typeof parseProjectMemoryEntries>};
const catalogCache=new Map<string,{at:number;value:any}>(),knowledgeCache=new Map<string,{at:number;value:any}>(),revisionCache=new Map<string,{at:number;bytes:number;row:ParsedRevision}>();
let revisionCacheBytes=0;
// Bumped by every write and explicit clear. A read records it when it starts and stores its result only if it is unchanged,
// so a read that began before a write and finished after it cannot put the pre-write answer back for the whole TTL.
let cacheGeneration=0;
/** Tests and explicit refreshes only: forget every cached catalog page, member lookup and parsed revision. */
export function clearCommonMemoryServiceCaches(){cacheGeneration++;catalogCache.clear();knowledgeCache.clear();revisionCache.clear();revisionCacheBytes=0;}
const cacheRead=(cache:Map<string,{at:number;value:any}>,key:string|null,ttl:number)=>{if(!key)return undefined;const hit=cache.get(key);if(!hit)return undefined;if(Date.now()-hit.at>ttl){cache.delete(key);return undefined;}return structuredClone(hit.value);};
const cacheWrite=(cache:Map<string,{at:number;value:any}>,key:string|null,value:any,max:number,since:number)=>{if(!key||since!==cacheGeneration)return;cache.delete(key);cache.set(key,{at:Date.now(),value:structuredClone(value)});while(cache.size>max)cache.delete(cache.keys().next().value!);};
const revisionRead=(key:string|null)=>{if(!key)return undefined;const hit=revisionCache.get(key);if(!hit)return undefined;revisionCache.delete(key);if(Date.now()-hit.at>REVISION_TTL_MS){revisionCacheBytes-=hit.bytes;return undefined;}revisionCache.set(key,hit);return hit.row;};
const revisionWrite=(key:string|null,row:ParsedRevision)=>{if(!key)return;const bytes=Buffer.byteLength(row.content);if(bytes>REVISION_CACHE_BYTES)return;const old=revisionCache.get(key);if(old){revisionCache.delete(key);revisionCacheBytes-=old.bytes;}revisionCache.set(key,{at:Date.now(),bytes,row});revisionCacheBytes+=bytes;while(revisionCache.size>REVISION_CACHE_ENTRIES||revisionCacheBytes>REVISION_CACHE_BYTES){const [oldest,entry]=revisionCache.entries().next().value!;revisionCache.delete(oldest);revisionCacheBytes-=entry.bytes;}};
// PostgREST answers these when a json-path filter itself is not understood; recall then falls back to one unfiltered scan.
const REJECTED_FILTER_CODES=new Set(['PGRST100','22P02','42883','42804','22023']);
const SOURCE_REVISION_COLUMNS={hash:'id,memory_id,content_hash',meta:'id,memory_id,content_hash,project_name,github_url',content:'id,memory_id,content,content_hash,project_name,github_url'} as const;
type SourceMode=keyof typeof SOURCE_REVISION_COLUMNS;
const aliasChanged=()=>new CommonMemoryError('COMMON_MEMORY_SOURCE_ALIAS_CHANGED','원본 기억의 계보가 바뀌었습니다. 대표 기억을 다시 선택하세요.');
const sourceArchived=()=>new CommonMemoryError('COMMON_MEMORY_SOURCE_ARCHIVED','보관된 원본 기억을 연결 목록에서 확인하세요.');
export function createCommonMemoryService(client:()=>any,assertActive:()=>void=()=>{}){
  const context=new AsyncLocalStorage<any>();
  const sb=()=>{const c=context.getStore()??client();if(!c)throw new CommonMemoryError('COMMON_MEMORY_CLOUD_REQUIRED','공통기억에는 장기기억과 같은 클라우드(Supabase) 연결이 필요합니다.',503);return c;};
  const checkScope=(expected?:string)=>{if(expected&&expected!==sb().commonMemoryScope)throw new CommonMemoryError('COMMON_MEMORY_SCOPE_CHANGED','공통기억이 선택된 클라우드와 현재 연결이 다릅니다. 다시 확인하세요.');};
  const deadlineError=()=>new CommonMemoryError('COMMON_MEMORY_CLOUD_UNAVAILABLE','클라우드 공통기억 응답이 늦어 확인을 멈췄습니다. 잠시 후 다시 시도하세요.',503);
  const raw=async(query:any)=>{assertActive();const deadline=chainDeadline.getStore();if(deadline?.aborted)throw deadlineError();const r=await query.abortSignal(deadline?AbortSignal.any([AbortSignal.timeout(15_000),deadline]):AbortSignal.timeout(15_000));assertActive();if(r.error&&deadline?.aborted)throw deadlineError();return r;};
  const result=async(query:any)=>{const r=await raw(query);if(r.error)fail(r.error);return r.data;};
  const cacheKey=(...parts:string[])=>{const c=sb(),scope=c.commonMemoryScope;return typeof scope==='string'&&scope?[String(c.commonMemoryCachePartition??''),scope,...parts].join('\u0000'):null;};
  const get=async(id:string)=>{id=commonMemoryId(id);const row=await result(sb().from('portmgr_common_memories').select('group_id,version,state').eq('group_id',id).single());return {...record(row),...(sb().commonMemoryScope?{scopeId:sb().commonMemoryScope}:{})};};
  const metadataPage=(page:any[]):CommonMemoryRecord[]=>{
      if(page.some((r:any)=>String(r.schemaVersion)!=='1'||!Array.isArray(r.sourceMemoryIds)||!Number.isSafeInteger(Number(r.goalVersion))))throw new CommonMemoryError('COMMON_MEMORY_FORMAT_UNSUPPORTED','지원하지 않는 공통기억 형식입니다. 앱을 업데이트하세요.');
    return page.map((r:any)=>({version:Number(r.version),metadataOnly:true,state:{schemaVersion:1,id:r.group_id,name:r.name,goal:r.goal,goalVersion:Number(r.goalVersion),sourceMemoryIds:r.sourceMemoryIds,archived:r.archived==='true',...(r.goalConfigured===undefined||r.goalConfigured===null?{}:{goalConfigured:r.goalConfigured!=='false'}),...(r.knowledgeSummary?{knowledgeSummary:r.knowledgeSummary}:{}),...(r.knowledgeSourceHeads?{knowledgeSourceHeads:r.knowledgeSourceHeads}:{}),items:[],sourceHeads:r.reviewSourceHeads??[],publication:r.publicationId?{id:r.publicationId,goalVersion:Number(r.publicationGoalVersion),goal:r.goal,sourceHeads:r.publicationSourceHeads??[],items:[],publishedAt:r.publicationDate??''}:null}}));
  };
  const LIST_COLUMNS='group_id,version,schemaVersion:state->>schemaVersion,name:state->>name,goal:state->goal,goalVersion:state->>goalVersion,sourceMemoryIds:state->sourceMemoryIds,archived:state->>archived,goalConfigured:state->>goalConfigured,knowledgeSummary:state->knowledgeSummary,knowledgeSourceHeads:state->knowledgeSourceHeads,publicationId:state->publication->>id,publicationGoalVersion:state->publication->>goalVersion,publicationSourceHeads:state->publication->sourceHeads,publicationDate:state->publication->>publishedAt,reviewSourceHeads:state->sourceHeads';
  /** One page of group metadata in list order: one read of size+1 rows (the extra row only says whether more exist). */
  const listPage=async(offset:number,size:number)=>{
    const start=Math.max(0,Math.floor(offset)||0),count=Math.max(1,Math.min(50,Math.floor(size)||10));
    const page=await result(sb().from('portmgr_common_memories').select(LIST_COLUMNS).order('group_id').range(start,start+count));
    if(!Array.isArray(page))fail(null);
    return {groups:metadataPage(page.slice(0,count)) as CommonMemoryRecord[],nextOffset:page.length>count?start+count:null};
  };
  const list=async()=>{
    const rows:any[]=[];let bytes=0;
    for(let offset=0;offset<2000;offset+=50){
      const page=await result(sb().from('portmgr_common_memories').select(LIST_COLUMNS).order('group_id').range(offset,offset+49));
      if(!Array.isArray(page))fail(null);bytes+=Buffer.byteLength(JSON.stringify(page));if(bytes>8_000_000)throw new CommonMemoryError('COMMON_MEMORY_BUDGET_EXCEEDED','공통기억 목록의 크기 한도를 넘습니다.');
      rows.push(...metadataPage(page));
      if(page.length<50)return rows as CommonMemoryRecord[];
    }
    throw new CommonMemoryError('COMMON_MEMORY_BUDGET_EXCEEDED','공통기억 목록이 조회 한도를 넘었습니다. 검색 범위를 줄이세요.');
  };
  // One batched alias/trash/head read per 64 ids. Alias rows mean the id no longer resolves to itself; the resolve RPC is
  // then asked for that id only, so cycles and over-deep chains fail exactly as the per-id resolve always did.
  const headBatch=async(batch:string[])=>{
    const [aliases,trash,heads]=await Promise.all([
      result(sb().from('portmgr_project_memory_aliases').select('alias_memory_id,canonical_memory_id').in('alias_memory_id',batch)),
      result(sb().from('portmgr_project_memory_trash').select('memory_id').in('memory_id',batch)),
      result(sb().from('portmgr_project_memory_heads').select('memory_id,head_revision_id').in('memory_id',batch)),
    ]);
    return {alias:new Set<string>((aliases??[]).map((r:any)=>r.alias_memory_id)),trash:new Set<string>((trash??[]).map((r:any)=>r.memory_id)),head:new Map<string,string|null>((heads??[]).map((r:any)=>[r.memory_id,r.head_revision_id??null]))};
  };
  // Walks ids in input order and throws the first error the former per-id chain would have thrown.
  // Revisions are fetched in one read (hash/meta) or ≤8 at a time with content, stopping at the 2 MB budget.
  const sourceRows=async(ids:string[],mode:SourceMode)=>{
    const heads:CommonMemorySourceHead[]=[],entries:CommonMemorySourceEntry[]=[],choices:NonNullable<SourceSnapshot['choices']>=[],meta:Array<{name:string;githubUrl:any}>=[];let bytes=0;
    for(let start=0;start<ids.length;start+=64){
      const batch=ids.slice(start,start+64),info=await headBatch([...new Set(batch)]),rows=new Map<string,any>();
      const gated=(id:string)=>!info.alias.has(id)&&!info.trash.has(id)&&!!info.head.get(id);
      const fetchFrom=async(index:number)=>{
        const window=[batch[index]!];for(let j=index+1;j<batch.length&&window.length<(mode==='content'?8:64)&&gated(batch[j]!);j++)window.push(batch[j]!);
        const wanted=[...new Set(window.map(id=>info.head.get(id)!))].filter(id=>!rows.has(id));
        const missing=mode==='content'?wanted.filter(id=>{const hit=revisionRead(cacheKey('revision',id));if(hit)rows.set(id,hit);return !hit;}):wanted;
        if(!missing.length)return;
        for(const row of await result(sb().from('portmgr_project_memory_revisions').select(SOURCE_REVISION_COLUMNS[mode]).in('id',missing))??[])rows.set(row.id,row);
      };
      for(let index=0;index<batch.length;index++){
        const id=batch[index]!;
        if(info.alias.has(id)){const canonical=await result(sb().rpc('portmgr_resolve_project_memory_id',{p_memory_id:id}));if(canonical!==id)throw aliasChanged();}
        if(info.trash.has(id))throw sourceArchived();
        const headRevisionId=info.head.get(id);if(!headRevisionId)fail({code:'PGRST116'});
        if(!rows.has(headRevisionId))await fetchFrom(index);
        const revision=rows.get(headRevisionId);if(!revision||revision.memory_id!==id)fail({code:'PGRST116'});
        if(mode!=='content'){
          if(!/^[a-f0-9]{64}$/.test(revision.content_hash))throw new CommonMemoryError('COMMON_MEMORY_SOURCE_INVALID','원본 기억의 hash 형식을 확인하세요.');
          heads.push({memoryId:id,revisionId:revision.id,contentHash:revision.content_hash});
          if(mode==='meta')meta.push({name:revision.project_name||id,githubUrl:revision.github_url??null});
          continue;
        }
        if(!revision.entries){
          if(typeof revision.content!=='string'||createHash('sha256').update(revision.content).digest('hex')!==revision.content_hash)throw new CommonMemoryError('COMMON_MEMORY_SOURCE_INVALID','원본 기억의 내용 검증에 실패했습니다.');
          revision.entries=parseProjectMemoryEntries(revision.content);revisionWrite(cacheKey('revision',revision.id),revision);
        }
        bytes+=Buffer.byteLength(revision.content);if(bytes>2_000_000)throw new CommonMemoryError('COMMON_MEMORY_BUDGET_EXCEEDED','선택한 원본의 크기가 한도를 넘습니다. 연결 범위를 줄여서 검토하세요.');
        heads.push({memoryId:id,revisionId:revision.id,contentHash:revision.content_hash});
        choices.push({memoryId:id,name:commonMemoryText(revision.project_name||id,240),githubUrl:typeof revision.github_url==='string'?normalizeGitHubRepositoryUrl(revision.github_url):null});
        for(const entry of revision.entries as ParsedRevision['entries']){
          if(!entry.body.trim())continue;
          if(Buffer.byteLength(entry.body)>12_000)throw new CommonMemoryError('COMMON_MEMORY_BUDGET_EXCEEDED','원본 항목이 너무 큽니다. 원본에서 항목을 나눠 저장한 뒤 검토하세요.');
          entries.push({memoryId:id,revisionId:revision.id,entryId:entry.entryId,contentHash:entry.contentVersionHash,title:entry.title,excerpt:entry.body,section:entry.section});
        }
        if(entries.length>500)throw new CommonMemoryError('COMMON_MEMORY_BUDGET_EXCEEDED','검토할 원본 항목이 500개를 넘습니다. 원본 연결 범위를 줄이세요.');
      }
    }
    return {entries,heads,choices,meta};
  };
  const sources=async(ids:string[],includeEntries=true):Promise<SourceSnapshot>=>{const {entries,heads,choices}=await sourceRows(ids,includeEntries?'content':'hash');return {entries,heads,choices};};
  const write=async(state:CommonMemory,expectedVersion:number,requestId:string,requestHash:string,scopeId?:string)=>{
    checkScope(scopeId);
    commonMemoryTracking(state);
    if(!Number.isSafeInteger(expectedVersion)||expectedVersion<0)throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','현재 공통기억 버전을 확인하세요.',400);
    if(Buffer.byteLength(JSON.stringify(state))>1_000_000)throw new CommonMemoryError('COMMON_MEMORY_BUDGET_EXCEEDED','공통기억의 크기 한도를 넘습니다. 항목이나 근거 범위를 줄이세요.');
    let data:any;try{data=await result(sb().rpc('portmgr_write_common_memory',{p_group_id:state.id,p_expected_version:expectedVersion,p_state:state,p_request_id:commonMemoryText(requestId,200),p_request_hash:requestHash}));}finally{cacheGeneration++;catalogCache.clear();knowledgeCache.clear();}
    return {...record({group_id:state.id,state:data.state,version:data.version}),...(sb().commonMemoryScope?{scopeId:sb().commonMemoryScope}:{}),...(data.replayed?{replayed:true,committedVersion:Number(data.committedVersion)}:{})};
  };
  // Periodic recommendations read IDs/revisions only, never original bodies or an AI provider.
  const updates=async(offset=0,now=Date.now())=>{
    if(!Number.isSafeInteger(offset)||offset<0||offset>2000)throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','조회 위치를 확인하세요.',400);
    const rows=await result(sb().from('portmgr_common_memories').select('group_id,version,schemaVersion:state->>schemaVersion,name:state->>name,goal:state->goal,goalVersion:state->>goalVersion,sourceMemoryIds:state->sourceMemoryIds,archived:state->>archived,goalConfigured:state->>goalConfigured,knowledgeSummary:state->knowledgeSummary,knowledgeSourceHeads:state->knowledgeSourceHeads,publicationId:state->publication->>id,publicationGoalVersion:state->publication->>goalVersion,publicationSourceHeads:state->publication->sourceHeads,publicationDate:state->publication->>publishedAt,reviewSourceHeads:state->sourceHeads').order('group_id').range(offset,offset+16));
    if(!Array.isArray(rows)||Buffer.byteLength(JSON.stringify(rows))>350_000)throw new CommonMemoryError('COMMON_MEMORY_BUDGET_EXCEEDED','공통기억 변경 조회의 크기를 확인하세요.');
    const page=metadataPage(rows.slice(0,16)).filter(r=>!r.state.archived);
    const ids=[...new Set(page.flatMap(r=>commonMemoryTracking(r.state).sourceMemoryIds))];
    if(page.some(r=>r.state.sourceMemoryIds.length>16))throw new CommonMemoryError('COMMON_MEMORY_BUDGET_EXCEEDED','원본 연결 수를 확인하세요.');
    const heads:Array<{memoryId:string;revisionId:string}>=[];
    for(let start=0;start<ids.length;start+=64){
      const batch=ids.slice(start,start+64);
      const [rows,trash,aliases]=await Promise.all([
        result(sb().from('portmgr_project_memory_heads').select('memory_id,head_revision_id').in('memory_id',batch)),
        result(sb().from('portmgr_project_memory_trash').select('memory_id').in('memory_id',batch)),
        result(sb().from('portmgr_project_memory_aliases').select('alias_memory_id').in('alias_memory_id',batch)),
      ]);
      const hidden=new Set([...(trash??[]).map((r:any)=>r.memory_id),...(aliases??[]).map((r:any)=>r.alias_memory_id)]);
      for(const row of rows??[])if(!hidden.has(row.memory_id))heads.push({memoryId:row.memory_id,revisionId:row.head_revision_id});
    }
    return {updates:page.map(r=>commonMemoryUpdateAdvice({groupId:r.state.id,name:r.state.name,version:r.version,...commonMemoryTracking(r.state),heads,publishedAt:r.state.publication?.publishedAt,archived:r.state.archived},now)),
      nextOffset:rows.length===17?offset+16:null,scopeId:sb().commonMemoryScope};
  };
  // The picker a person is looking at always reads fresh (a just-pushed or renamed memory must show up); every read refreshes
  // the 30 s cache that background walks (project names, topic discovery, workroom drafts) reuse.
  const catalogPage=async(after:string|null,cached:boolean):Promise<{sources:Array<{memoryId:string;name:string;revisionId:string;githubUrl:string|null}>;nextAfter:string|null;scopeId:string}>=>{
    const generation=cacheGeneration,cursor=after?commonMemoryId(after):null,key=cacheKey('catalog',cursor??''),hit=cached?cacheRead(catalogCache,key,CATALOG_TTL_MS):undefined;
    if(hit){assertActive();return hit;}
    const rows=await result(sb().rpc('portmgr_list_project_memory_head_page',{p_after_memory_id:cursor,p_limit:50}));
    if(!Array.isArray(rows))fail(null);
    const ids=rows.map((r:any)=>r.memory_id);
    const [aliases,labels,archived]=rows.length?await Promise.all([
      result(sb().from('portmgr_project_memory_aliases').select('alias_memory_id').in('alias_memory_id',ids)),
      result(sb().from('portmgr_project_memory_labels').select('memory_id,display_name').in('memory_id',ids)),
      result(sb().from('portmgr_project_memory_trash').select('memory_id').in('memory_id',ids)),
    ]):[[],[],[]];
    const hidden=new Set([...(archived??[]).map((r:any)=>r.memory_id),...(aliases??[]).map((r:any)=>r.alias_memory_id)]);
    const value={sources:rows.filter((r:any)=>!hidden.has(r.memory_id)).map((r:any)=>({memoryId:commonMemoryId(r.memory_id),name:commonMemoryText((labels??[]).find((l:any)=>l.memory_id===r.memory_id)?.display_name||r.project_name||r.memory_id,240),revisionId:r.id as string,githubUrl:typeof r.github_url==='string'?normalizeGitHubRepositoryUrl(r.github_url):null})),nextAfter:rows.length===50?rows.at(-1).memory_id as string:null,scopeId:sb().commonMemoryScope as string};
    cacheWrite(catalogCache,key,value,64,generation);
    return value;
  };
  const catalog=(after:string|null=null)=>catalogPage(after,false);
  /** Walks up to maxPages catalog pages (each cached for 30 s) for name lookups such as the host's project-names. */
  const catalogAll=async(maxPages=40)=>{
    const pages=Math.max(1,Math.min(40,Math.floor(Number(maxPages))||1)),sources:Awaited<ReturnType<typeof catalogPage>>['sources']=[];let after:string|null=null;
    for(let page=0;page<pages;page++){const next=await catalogPage(after,true);sources.push(...next.sources);if(!next.nextAfter)return {sources,complete:true,scopeId:sb().commonMemoryScope as string};after=next.nextAfter;}
    return {sources,complete:false,scopeId:sb().commonMemoryScope as string};
  };
  const projectSources=async(groupId:string)=>{
    const current=await get(groupId);if(current.state.archived)throw new CommonMemoryError('COMMON_MEMORY_ARCHIVED','보관된 공통기억은 프로젝트 추가에 사용할 수 없습니다.');const ids=current.state.portableKnowledge?current.state.portableKnowledge.current.members.filter(m=>m.mode==='include').map(m=>m.memoryId):current.state.sourceMemoryIds;
    if(ids.length>16)throw new CommonMemoryError('COMMON_MEMORY_BUDGET_EXCEEDED','적용 프로젝트가 16개를 넘습니다. 관리 화면에서 추가할 묶음을 나눠 선택하세요.');
    // One batched head + metadata read. If any member fails on a knowledge group, retry per id so each bad member
    // reports itself while the healthy ones still list (failures first, as before).
    const listed=(rows:Awaited<ReturnType<typeof sourceRows>>)=>rows.heads.map((head,i)=>({...head,name:rows.meta[i]!.name,githubUrl:rows.meta[i]!.githubUrl}));
    const projects:Array<CommonMemorySourceHead&{name:string;githubUrl:any}>=[];
    try{projects.push(...listed(await sourceRows(ids,'meta')));}
    catch(error){
      if(!current.state.portableKnowledge)throw error;const healthy:typeof projects=[];
      for(const id of ids){try{healthy.push(...listed(await sourceRows([id],'meta')));}catch{projects.push({memoryId:id,revisionId:'',contentHash:'',name:current.state.portableKnowledge.current.members.find(m=>m.memoryId===id)!.name,githubUrl:null});}}
      projects.push(...healthy);
    }
    return {...current,projects};
  };
  const readCloudSource=async(memoryId:string,offset=0,scopeId?:string)=>{
    checkScope(scopeId);if(!Number.isSafeInteger(offset)||offset<0||offset>500)throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','원본 항목 조회 위치를 확인하세요.',400);
    const source=await sources([commonMemoryId(memoryId)]);
    const entries=source.entries.slice(offset,offset+10);while(Buffer.byteLength(JSON.stringify(entries))>128000&&entries.length>1)entries.pop();
    if(Buffer.byteLength(JSON.stringify(entries))>128000)throw new CommonMemoryError('COMMON_MEMORY_BUDGET_EXCEEDED','원본 항목 하나가 응답 한도를 넘습니다. 원본에서 항목을 나눠 저장하세요.');
    return {entries,head:source.heads[0],source:source.choices?.[0],nextOffset:offset+entries.length<source.entries.length?offset+entries.length:null,entryCount:source.entries.length,scopeId:sb().commonMemoryScope};
  };
  const topicCandidates=async(after:string|null=null,memoryIds?:string[])=>{
    const page=await catalogPage(after,true),ids=memoryIds?commonMemorySourceIds(memoryIds):page.sources.slice(0,8).map(source=>source.memoryId);
    const entries:CommonMemorySourceEntry[]=[],warnings:Array<{memoryId:string;message:string}>=[];let discoveryBytes=0;
    for(const id of ids){try{const source=await sources([id]),bytes=Buffer.byteLength(JSON.stringify(source.entries));if(entries.length+source.entries.length>COMMON_MEMORY_DISCOVERY_MAX_ENTRIES||discoveryBytes+bytes>COMMON_MEMORY_DISCOVERY_MAX_BYTES){warnings.push({memoryId:id,message:'이번 분석의 500개 항목·2MB 근거 한도를 넘었습니다. 이 기억을 별도로 선택해 확인하세요.'});continue;}discoveryBytes+=bytes;entries.push(...source.entries);}catch(error){warnings.push({memoryId:id,message:error instanceof Error?error.message:'원본 조회를 완료하지 못했습니다.'});}}
    // Lesson clusters across these memories; keyword topics only when no lesson repeats (commonTopicDiscovery).
    const groups=await list(),discovery=commonTopicDiscovery(entries);
    return {candidates:discovery.candidates.map(candidate=>({...candidate,evidence:candidate.evidence.map(entry=>({...entry,excerpt:[...entry.excerpt].slice(0,240).join(''),excerptTruncated:[...entry.excerpt].length>240})),existingGroups:groups.filter(group=>!group.state.archived&&(group.state.name===candidate.name||group.state.goal.objective===candidate.name)).map(group=>({id:group.state.id,name:group.state.name}))})),checkedMemoryIds:ids,warnings,scopeId:sb().commonMemoryScope,nextAfter:memoryIds?null:page.sources.length>8?ids.at(-1):page.nextAfter,scanComplete:!warnings.length&&!!memoryIds||!warnings.length&&page.sources.length<=8&&!page.nextAfter,method:discovery.method,semanticDecisionRequired:true};
  };
  const analysisIds=(state:CommonMemory)=>[...new Set([...commonMemoryTracking(state).sourceMemoryIds,...(state.portableKnowledge?.current.members??[]).filter(m=>m.mode==='include').map(m=>m.memoryId)])];
  const inspect=async(id:string,offset?:number,itemOffset=0,analysis=false,pageSize=20)=>{
    const size=Math.max(1,Math.min(20,Math.floor(Number(pageSize))||20));
    const current=await get(id),ids=analysis?analysisIds(current.state):commonMemoryTracking(current.state).sourceMemoryIds;if(ids.length>32)throw new CommonMemoryError('COMMON_MEMORY_BUDGET_EXCEEDED','분석할 연결 프로젝트 범위를 줄이세요.');let source:SourceSnapshot={entries:[],heads:[]},sourceWarning:string|null=null;
    try{source=await sources(ids);}catch(error){if(!(error instanceof CommonMemoryError)||!['COMMON_MEMORY_SOURCE_ALIAS_CHANGED','COMMON_MEMORY_SOURCE_ARCHIVED','COMMON_MEMORY_SOURCE_INVALID'].includes(error.code))throw error;sourceWarning=error.message;}
    const labels=ids.length?await result(sb().from('portmgr_project_memory_labels').select('memory_id,display_name').in('memory_id',ids)):[];
    const sourceChoices=(source.choices??[]).map(choice=>({...choice,name:commonMemoryText(labels.find((l:any)=>l.memory_id===choice.memoryId)?.display_name||choice.name,240)}));
    const reviewHeads=source.heads.filter(h=>current.state.sourceMemoryIds.includes(h.memoryId));
    const refreshed=refreshCommonMemorySources(current.state,source.entries.filter(e=>current.state.sourceMemoryIds.includes(e.memoryId)),reviewHeads);
    const applications=await result(sb().from('portmgr_common_memory_applications').select('payload').eq('group_id',id).order('created_at',{ascending:false}).limit(offset===undefined?100:10));
    const reports=(applications??[]).map((r:any)=>r.payload),reviewSignals=reports.filter((r:any)=>r.revisionId===current.state.publication?.id&&['failed','not-applied'].includes(r.outcome));
    const compactItem=(i:any)=>({...i,evidence:i.evidence.map((e:any)=>({...e,excerpt:''}))});
    const state=offset===undefined?{...current.state}:{...current.state,items:current.state.items.slice(itemOffset,itemOffset+5).map(compactItem),publication:current.state.publication?{...current.state.publication,items:current.state.publication.items.slice(itemOffset,itemOffset+5).map(compactItem)}:null};
    if(current.state.portableKnowledge)(state as any).portableKnowledge=portableKnowledgeView(current.state.portableKnowledge,itemOffset);
    const inspectedEntries=analysis?source.entries:source.entries.filter(entry=>current.state.sourceMemoryIds.includes(entry.memoryId));
    const view={...current,state,itemCount:current.state.items.length,publicationItemCount:current.state.publication?.items.length??0,paged:offset!==undefined,sourceChoices,sourceEntries:offset===undefined?inspectedEntries:inspectedEntries.slice(offset,offset+size),sourceEntryCount:inspectedEntries.length,nextOffset:offset===undefined||offset+size>=inspectedEntries.length?null:offset+size,sourceHeads:reviewHeads,currentTrackedSourceHeads:source.heads,sourceWarning,analysis,ready:!sourceWarning&&commonMemoryReady(current.state,reviewHeads),needsReview:refreshed.items.filter(i=>i.state==='needs-review').map(i=>i.id),applications:reports,reviewSignals,applicationEvidence:'reported-results'};
    if(offset!==undefined){let window=5;while(Buffer.byteLength(JSON.stringify(view))>350_000){if(view.sourceEntries.length>1)view.sourceEntries.pop();else if(window>1){window--;view.state.items=current.state.items.slice(itemOffset,itemOffset+window).map(compactItem);if(view.state.publication)view.state.publication.items=current.state.publication!.items.slice(itemOffset,itemOffset+window).map(compactItem);}else throw new CommonMemoryError('COMMON_MEMORY_BUDGET_EXCEEDED','공통기억 항목의 조회 범위를 줄이세요.');}view.nextOffset=offset+view.sourceEntries.length<inspectedEntries.length?offset+view.sourceEntries.length:null;return {...view,itemOffset,itemNextOffset:itemOffset+window<Math.max(current.state.items.length,current.state.publication?.items.length??0)?itemOffset+window:null};}
    return view;

  };
  const action=async(input:Record<string,any>)=>{
    parseCommonMemoryRequest({operation:'manage',input});checkScope(input.scopeId);
    const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
    const operation=commonMemoryText(input.operation,40),hash=await commonMemoryHash(JSON.stringify(canonical(input)));
    if(input.groupId&&input.requestId){const receipt=await result(sb().from('portmgr_common_memory_operations').select('request_hash,result').eq('group_id',commonMemoryId(input.groupId)).eq('request_id',commonMemoryText(input.requestId,200)).maybeSingle());if(receipt){if(receipt.request_hash!==hash)throw new CommonMemoryError('COMMON_MEMORY_REQUEST_CONFLICT','같은 요청 ID에 다른 내용을 저장할 수 없습니다.');return {...await get(input.groupId),replayed:true,committedVersion:receipt.result.version};}}
    if(operation==='create'){
      const state=createCommonMemory({id:input.groupId,name:input.name,goal:input.goal,sourceMemoryIds:input.sourceMemoryIds});await sources(state.sourceMemoryIds);
      return write(state,0,input.requestId,hash);
    }
    const current=await get(input.groupId),version=Number(input.expectedVersion);
    if(version!==current.version)throw new CommonMemoryError('COMMON_MEMORY_VERSION_CHANGED','공통기억이 변경되었습니다. 다시 불러오세요.');
    let state=current.state;
    if(operation==='configure'){state=configureCommonMemory(state,{name:input.name,goal:input.goal,sourceMemoryIds:input.sourceMemoryIds});await sources(state.sourceMemoryIds);}
    else if(operation==='refresh'){const source=await sources(state.sourceMemoryIds);state=refreshCommonMemorySources(state,source.entries,source.heads);}
    else if(operation==='review'){
      const source=await sources(state.sourceMemoryIds);state=refreshCommonMemorySources(state,source.entries,source.heads);
      if(!Array.isArray(input.evidence)||!input.evidence.length||input.evidence.length>16)throw new CommonMemoryError('COMMON_MEMORY_EVIDENCE_REQUIRED','현재 원본 항목을 선택하세요.',400);
      const selected=input.evidence.map((ref:any)=>{const entry=source.entries.find(e=>e.memoryId===ref.memoryId&&e.entryId===ref.entryId&&e.contentHash===ref.contentHash);if(!entry)throw new CommonMemoryError('COMMON_MEMORY_SOURCE_CHANGED','원본 항목이 바뀌었습니다. 다시 검토하세요.');return entry;});
      state=await reviewCommonMemoryItem(state,{sourceEntries:selected,title:input.title,rule:input.rule,reason:input.reason,conditions:input.conditions??[],itemId:input.itemId},source.heads);
    }else if(operation==='remove-item'){
      if(!state.items.some(i=>i.id===input.itemId))throw new CommonMemoryError('COMMON_MEMORY_ITEM_MISSING','항목을 다시 확인하세요.');state={...state,items:state.items.filter(i=>i.id!==input.itemId)};
    }else if(operation==='restore-draft'){
      const previous=await result(sb().from('portmgr_common_memory_revisions').select('payload').eq('group_id',state.id).eq('revision_id',commonMemoryId(input.revisionId)).single());
      state={...state,items:previous.payload.items.map((item:any)=>({...item,goalVersion:state.goalVersion,state:'needs-review'})),sourceHeads:[]};
    }else if(operation==='publish'){const source=await sources(state.sourceMemoryIds);state=publishCommonMemory(state,source.heads);if(state.knowledgeSourceHeads)state={...state,knowledgeSourceHeads:[...state.knowledgeSourceHeads.filter(old=>!source.heads.some(head=>head.memoryId===old.memoryId)),...source.heads]};}
    else if(operation==='archive'||operation==='unarchive')state={...state,archived:operation==='archive'};
    else throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','지원하는 공통기억 관리 동작을 선택하세요.',400);
    if(state.portableKnowledge){const old=state.portableKnowledge.current,changed=old.name!==state.name||old.archived!==state.archived,knowledge={...old,name:state.name,archived:state.archived,...(changed?{revision:old.revision+1,updatedAt:new Date().toISOString()}: {})};state={...state,portableKnowledge:{...state.portableKnowledge,current:knowledge},knowledgeSummary:commonKnowledgeSummary(knowledge)};}
    return write(state,version,input.requestId,hash);
  };
  const recommend=async(projectGoal:string)=>{
    const all=await list(),available:CommonMemory[]=[],blocked:Array<{groupId:string;name:string;reason:string}>=[];
    const ranked=recommendCommonMemories(all.map(r=>r.state),projectGoal,20),headCache=new Map<string,CommonMemorySourceHead>();
    for(const candidate of ranked){const state=all.find(r=>r.state.id===candidate.groupId)!.state;try{const missing=state.sourceMemoryIds.filter(id=>!headCache.has(id));if(missing.length){const source=await sources(missing,false);for(const h of source.heads)headCache.set(h.memoryId,h);}const heads=state.sourceMemoryIds.map(id=>headCache.get(id)!);if(commonMemoryReady(state,heads))available.push(state);else blocked.push({groupId:state.id,name:state.name,reason:'원본 변경 후 재게시 필요'});}catch(error){blocked.push({groupId:state.id,name:state.name,reason:error instanceof Error?error.message:'원본 확인 필요'});}if(available.length>=8)break;}
    return {projectGoal:commonMemoryText(projectGoal),recommendations:recommendCommonMemories(available,projectGoal).map(r=>({...r,...(sb().commonMemoryScope?{scopeId:sb().commonMemoryScope}:{})})),blocked,scanComplete:ranked.length<20&&available.length+blocked.length===ranked.length,checkedCandidates:available.length+blocked.length,selectionRequired:true,semanticDecision:'사용자 또는 MCP 대화에서 목표·조건을 확인한 뒤 선택'};
  };
  const recall=async(groupId:string,task:string,revisionId?:string,scopeId?:string)=>{
    checkScope(scopeId);
    const current=await get(groupId);
    if(revisionId){const pub=await result(sb().from('portmgr_common_memory_revisions').select('payload').eq('group_id',groupId).eq('revision_id',commonMemoryId(revisionId)).single());return {groupId,...recallCommonMemory(pub.payload,task),pinned:true,currentGoalVersion:current.state.goalVersion};}
    const source=await sources(current.state.sourceMemoryIds,false);
    if(!commonMemoryReady(current.state,source.heads))throw new CommonMemoryError('COMMON_MEMORY_REVIEW_REQUIRED','목표나 원본이 바뀌었습니다. 검토·게시한 뒤 새 작업에서 사용하세요.');
    return {groupId,...recallCommonMemory(current.state.publication!,task),pinned:false};
  };
  const report=async(groupId:string,application:unknown,scopeId?:string)=>{
    checkScope(scopeId);
    const v=application as Record<string,any>,pub=await result(sb().from('portmgr_common_memory_revisions').select('payload').eq('group_id',commonMemoryId(groupId)).eq('revision_id',commonMemoryId(v?.revisionId)).single());
    const record=normalizeCommonMemoryApplication(application,pub.payload,groupId);
    const existing=await result(sb().from('portmgr_common_memory_applications').select('payload').eq('application_id',record.id).maybeSingle());
    if(existing){const {recordedAt,...old}=existing.payload,{recordedAt:now,...next}=record;if(JSON.stringify(old)!==JSON.stringify(next))throw new CommonMemoryError('COMMON_MEMORY_REQUEST_CONFLICT','같은 적용 기록 ID에 다른 결과를 저장할 수 없습니다.');return existing.payload;}
    await result(sb().from('portmgr_common_memory_applications').insert({application_id:record.id,group_id:groupId,revision_id:record.revisionId,payload:record}));return record;
  };
  const selections=async(groupIds:string[],expected?:CommonMemorySelection[]):Promise<CommonMemorySelection[]>=>{
    if(!Array.isArray(groupIds)||expected&&(!Array.isArray(expected)||expected.length>8||expected.some(e=>!e||typeof e!=='object'||!Number.isSafeInteger(e.goalVersion)||e.goalVersion<1)))throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','선택한 게시본의 형식을 확인하세요.',400);
    if(groupIds.length>8)throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','프로젝트 공통기억은 최대 8개 선택하세요.',400);
    const selected:CommonMemorySelection[]=[];for(const id of [...new Set(groupIds.map(commonMemoryId))]){const current=await get(id),source=await sources(current.state.sourceMemoryIds,false);if(!commonMemoryReady(current.state,source.heads))throw new CommonMemoryError('COMMON_MEMORY_REVIEW_REQUIRED','선택한 공통기억의 목표·원본을 검토해 다시 게시하세요.');const ref={groupId:id,revisionId:current.state.publication!.id,goalVersion:current.state.goalVersion,...(current.scopeId?{scopeId:current.scopeId}:{})};if(expected){for(const e of expected)checkScope(e.scopeId);if(!expected.some(e=>e.groupId===id&&e.revisionId===ref.revisionId&&e.goalVersion===ref.goalVersion))throw new CommonMemoryError('COMMON_MEMORY_SELECTION_CHANGED','추천에서 선택한 게시본이 바뀌었습니다. 목표와 조건을 다시 확인해 선택하세요.');}selected.push(ref);}if(expected&&expected.length!==selected.length)throw new CommonMemoryError('COMMON_MEMORY_SELECTION_CHANGED','선택한 게시본과 기억 목록을 다시 확인하세요.');return selected;
  };
  const history=async(groupId:string)=>result(sb().from('portmgr_common_memory_revisions').select('revision_id,created_at,goalVersion:payload->>goalVersion,goal:payload->goal').eq('group_id',commonMemoryId(groupId)).order('created_at',{ascending:false}).limit(20));
  const bind=async(projectMemoryId:string,projectGoal:string,selected:CommonMemorySelection[])=>{
    for(const selection of selected)checkScope(selection.scopeId);
    const id=commonMemoryId(projectMemoryId),goal=commonMemoryText(projectGoal),prior=await result(sb().from('portmgr_common_memory_bindings').select('version').eq('project_memory_id',id).maybeSingle());
    const saved=await result(sb().rpc('portmgr_bind_common_memory',{p_memory_id:id,p_project_goal:goal,p_selections:selected,p_expected_version:prior?Number(prior.version):0}));
    return {projectMemoryId:id,projectGoal:goal,selections:selected,version:Number(saved.version)};
  };
  const readSource=async(groupId:string,memoryId:string,entryId:string,contentHash:string,scopeId?:string)=>{checkScope(scopeId);const current=await get(groupId),id=commonMemoryId(memoryId);if(!analysisIds(current.state).includes(id))throw new CommonMemoryError('COMMON_MEMORY_SOURCE_CHANGED','이 공통기억에 연결된 원본을 선택하세요.');const source=await sources([id]);const entry=source.entries.find(e=>e.memoryId===id&&e.entryId===entryId&&e.contentHash===contentHash);if(!entry)throw new CommonMemoryError('COMMON_MEMORY_SOURCE_CHANGED','원본 항목의 현재 내용·검증값을 다시 확인하세요.');return {entry,scopeId:current.scopeId,groupVersion:current.version};};
  const binding=async(memoryId:string)=>{const row=await result(sb().from('portmgr_common_memory_bindings').select('project_goal,selections,version').eq('project_memory_id',commonMemoryId(memoryId)).maybeSingle());return row?{projectGoal:commonMemoryText(row.project_goal),selections:row.selections as CommonMemorySelection[],version:Number(row.version),scopeId:sb().commonMemoryScope}:null;};
  const scope=async()=>sb().commonMemoryScope as string;
  const applicationStatus=async(groupId:string,applicationId:string,scopeId?:string)=>{checkScope(scopeId);const row=await result(sb().from('portmgr_common_memory_applications').select('application_id').eq('group_id',commonMemoryId(groupId)).eq('application_id',commonMemoryId(applicationId)).maybeSingle());return {found:!!row,groupId};};
  const operationStatus=async(groupId:string,requestId:string,requestHash:string,scopeId?:string)=>{checkScope(scopeId);if(!/^[a-f0-9]{64}$/.test(requestHash))throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','요청 검증값을 확인하세요.',400);const row=await result(sb().from('portmgr_common_memory_operations').select('request_hash,result').eq('group_id',commonMemoryId(groupId)).eq('request_id',commonMemoryText(requestId,200)).maybeSingle());if(row&&row.request_hash!==requestHash)throw new CommonMemoryError('COMMON_MEMORY_REQUEST_CONFLICT','저장된 요청의 내용이 다릅니다.');return {found:!!row,groupId,version:row?.result?.version??null};};
  /** verifiedMembers: {memoryId} assignments the caller has just confirmed with memoryTargets (memoryId -> name). */
  const knowledge=async(raw:unknown,projects:MetaMemoryProject[],scopeId?:string,verifiedMembers?:ReadonlyMap<string,string>)=>{
    checkScope(scopeId);const request=parseMetaMemoryRequest(raw);
    if(!('requestId' in request))throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','공통기억 편집 요청을 확인하세요.',400);
    const id=request.operation==='save'&&!request.memoryId?metaMemoryCreationId(request.requestId):'memoryId' in request?request.memoryId:null;
    if(!id)throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','클라우드 공통 지식 ID를 확인하세요.',400);
    const hash=await commonMemoryHash(JSON.stringify(request)),receipt=await result(sb().from('portmgr_common_memory_operations').select('request_hash,result').eq('group_id',id).eq('request_id',request.requestId).maybeSingle());
    if(receipt){if(receipt.request_hash!==hash)throw new CommonMemoryError('COMMON_MEMORY_REQUEST_CONFLICT','같은 요청 ID에 다른 편집을 저장할 수 없습니다.');return {...await get(id),replayed:true,committedVersion:receipt.result.version};}
    if(request.operation==='save'&&!request.memoryId){const now=new Date().toISOString(),snapshot={id,revision:0,name:request.name,description:request.description,tags:request.tags,categories:request.categories,archived:false,entries:[],members:[],createdAt:now,updatedAt:now},next=editPortableKnowledge(snapshot,request,projects,createHash('sha256').update(request.requestId).digest('hex').slice(0,24),undefined,verifiedMembers);return write(await portableCommonMemory(snapshot,next),0,request.requestId,hash);}
    const current=await get(id),snapshot=commonKnowledgeForState(current.state);
    if(request.expectedRevision!==snapshot.revision)throw new CommonMemoryError('COMMON_MEMORY_VERSION_CHANGED','다른 기기에서 공통기억이 변경됐습니다. 최신 내용을 다시 확인하세요.');
    let editRequest=request;
    if(request.operation==='propose-source-entry'){
      const source=await sources([...new Set(request.evidence.map(ref=>ref.memoryId))]),refs=request.evidence.map(ref=>{
        const entry=source.entries.find(entry=>entry.memoryId===ref.memoryId&&entry.revisionId===ref.revisionId&&entry.entryId===ref.entryId&&entry.contentHash===ref.contentHash);
        if(!entry)throw new CommonMemoryError('COMMON_MEMORY_SOURCE_CHANGED','제안의 원본 항목이 바뀌었습니다. 최신 원본으로 후보를 다시 준비하세요.');
        return {memoryId:entry.memoryId,revisionId:entry.revisionId,entryId:entry.entryId,contentHash:entry.contentHash,title:entry.title,memoryName:source.choices?.find(choice=>choice.memoryId===entry.memoryId)?.name??entry.memoryId};
      });
      const prior=request.supersedesEntryId?snapshot.entries.find(entry=>entry.id===request.supersedesEntryId):null;
      if(request.supersedesEntryId&&(!prior||prior.state!=='active'))throw new CommonMemoryError('COMMON_MEMORY_VERSION_CHANGED','바꿀 확정 항목의 현재 상태를 다시 확인하세요.');
      const duplicate=snapshot.entries.find(entry=>{if(entry.state==='superseded'||commonTopicProposalText(entry.title)!==commonTopicProposalText(request.title))return false;try{return commonTopicProposalText(readCommonTopicEvidence(entry.body).body)===commonTopicProposalText(request.body);}catch{return false;}});
      if(duplicate)throw new CommonMemoryError('COMMON_MEMORY_DUPLICATE_PROPOSAL',`같은 내용을 이미 ${duplicate.state==='candidate'?'검토 후보로 준비했습니다':'확정 기억에 가지고 있습니다'}. 항목 ${duplicate.id}를 확인하세요.`);
      const body=withCommonTopicEvidence(request.body,{schemaVersion:1,reason:request.reason,category:request.category,conditions:request.conditions,sources:refs,...(prior?{supersedes:{entryId:prior.id,contentHash:await commonMemoryHash(JSON.stringify({title:prior.title,body:prior.body}))}}:{})});
      editRequest={operation:'propose-entry',memoryId:id,expectedRevision:request.expectedRevision,requestId:request.requestId,title:request.title,body};
    }
    const acceptIds=request.operation==='review-entry'&&request.state==='active'?[request.entryId]:request.operation==='review-entries'&&request.state==='active'?request.entryIds:[];
    const replacements:string[]=[],acceptedHeads:CommonMemorySourceHead[]=[];
    const acceptEvidence=acceptIds.map(entryId=>{const entry=snapshot.entries.find(entry=>entry.id===entryId);if(!entry)throw new CommonMemoryError('COMMON_MEMORY_ITEM_MISSING','검토할 항목을 다시 확인하세요.');return readCommonTopicEvidence(entry.body).evidence;}).filter(evidence=>evidence!==null);
    if(request.operation==='save-entry'){const evidence=readCommonTopicEvidence(request.body).evidence;if(evidence)acceptEvidence.push(evidence);}
    const evidenceMemoryIds=[...new Set(acceptEvidence.flatMap(evidence=>evidence.sources.map(ref=>ref.memoryId)))];
    if(evidenceMemoryIds.length>32)throw new CommonMemoryError('COMMON_MEMORY_BUDGET_EXCEEDED','한 번의 검토에서 원본 기억을 32개까지 확인합니다. 후보를 나눠 검토하세요.');
    const source=acceptEvidence.length?await sources(evidenceMemoryIds):{entries:[],heads:[]};
    for(const evidence of acceptEvidence){
      if(evidence.sources.some(ref=>!source.entries.some(entry=>entry.memoryId===ref.memoryId&&entry.revisionId===ref.revisionId&&entry.entryId===ref.entryId&&entry.contentHash===ref.contentHash)))throw new CommonMemoryError('COMMON_MEMORY_SOURCE_CHANGED','검토 중 원본이 바뀌었습니다. 최신 근거로 후보를 다시 준비하세요.');
      for(const head of source.heads)if(!acceptedHeads.some(old=>old.memoryId===head.memoryId))acceptedHeads.push(head);
      if(evidence.supersedes&&!(request.operation==='save-entry'&&snapshot.entries.find(entry=>entry.id===request.entryId)?.state==='active')){const prior=snapshot.entries.find(entry=>entry.id===evidence.supersedes!.entryId);if(!prior||prior.state!=='active'||await commonMemoryHash(JSON.stringify({title:prior.title,body:prior.body}))!==evidence.supersedes.contentHash||replacements.includes(prior.id))throw new CommonMemoryError('COMMON_MEMORY_VERSION_CHANGED','바꿀 확정 항목이 변경되었거나 겹칩니다. 변경 후보를 다시 확인하세요.');replacements.push(prior.id);}
    }
    const next=editPortableKnowledge(snapshot,editRequest,projects,createHash('sha256').update(request.requestId).digest('hex').slice(0,24),undefined,verifiedMembers);
    for(const entry of next.entries)if(replacements.includes(entry.id)){entry.state='superseded';entry.updatedAt=next.updatedAt;}
    const retained=current.state.portableKnowledge??{schemaVersion:1 as const,snapshot,sourceFingerprint:await commonMemoryHash(JSON.stringify(snapshot)),importedAt:new Date().toISOString()};
    const knowledgeSourceHeads=acceptedHeads.length?[...(current.state.knowledgeSourceHeads??[]).filter(old=>!acceptedHeads.some(head=>head.memoryId===old.memoryId)),...acceptedHeads]:current.state.knowledgeSourceHeads;
    return write({...current.state,name:next.name,...(current.state.goalConfigured===false?{goal:{...current.state.goal,objective:next.description||next.name}}:{}),archived:next.archived,...(knowledgeSourceHeads?{knowledgeSourceHeads}:{}),knowledgeSummary:commonKnowledgeSummary(next),portableKnowledge:{...retained,current:next}},current.version,request.requestId,hash);
  };
  /** Long-term memories with their current head, skipping archived, aliased or missing ones (one batched read, no throw). */
  const liveSources=async(members:Array<{memoryId:string;name:string}>)=>{
    const ids=[...new Set(members.map(m=>commonMemoryId(m.memoryId)))],info=await headBatch(ids);
    return ids.filter(id=>!info.alias.has(id)&&!info.trash.has(id)&&!!info.head.get(id)).map(id=>({memoryId:id,name:members.find(m=>commonMemoryId(m.memoryId)===id)!.name||id,revisionId:info.head.get(id)!}));
  };
  const readKnowledge=async(groupId:string)=>{const current=await get(groupId);return {memory:commonKnowledgeForState(current.state),scopeId:current.scopeId,persisted:!!current.state.portableKnowledge};};
  const workroomDraft=async(kind:'recommend'|'update',groupId?:string,projects:Array<{portId:string;name:string}>=[],scopeId?:string)=>{
    checkScope(scopeId);if(!['recommend','update'].includes(kind)||kind==='update'&&!groupId)throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','정리할 공통기억을 선택하세요.',400);
    const current=groupId?await get(groupId):null;if(current?.state.archived)throw new CommonMemoryError('COMMON_MEMORY_ARCHIVED','보관된 공통기억은 다시 사용한 뒤 정리하세요.');
    const state=current?.state,knowledge=state?commonKnowledgeForState(state):null;
    const tracked=state?commonMemoryTracking(state).sourceMemoryIds:[],linked=knowledge?knowledge.members.filter(m=>m.mode==='include'):[];
    // An update with no tracked sources reads its linked long-term memories (up to 16, live ones only) as this draft's
    // cloudSources; they are never written to sourceMemoryIds. With neither (or no linked one still readable), it gets one
    // catalog page to search, as recommend does.
    const linkedSources=kind==='update'&&!tracked.length&&linked.length?await liveSources(linked.slice(0,16)):[];
    const cloudCatalog=kind==='recommend'||kind==='update'&&!tracked.length&&!linkedSources.length?await catalogPage(null,true):null;
    const draft=commonMemoryWorkroomDraft({kind,scopeId:sb().commonMemoryScope,cloudSources:linkedSources.length?linkedSources:cloudCatalog?.sources.slice(0,16),sourceNextAfter:cloudCatalog&&cloudCatalog.sources.length>16?cloudCatalog.sources[15]!.memoryId:cloudCatalog?.nextAfter,group:state?{id:state.id,name:state.name,version:current!.version,goal:state.goal.objective,sourceMemoryIds:tracked,knowledgeRevision:knowledge!.revision,useProjectMemoryIds:linked.map(m=>m.memoryId)}:undefined});
    return {target:'ops' as const,requiresUserSend:true,scopeId:sb().commonMemoryScope,...draft,...(state?{groupId:state.id,version:current!.version}:{})};
  };
  const knowledgeHistory=async(groupId:string)=>{const rows=await result(sb().from('portmgr_common_memory_operations').select('created_at,result').eq('group_id',commonMemoryId(groupId)).order('created_at',{ascending:false}).limit(20));return rows.map((r:any)=>({revision:r.result.knowledgeRevision??r.result.version,operation:r.result.knowledgeOperation??'cloud-update',createdAt:r.created_at}));};
  /** Fresh check (never the catalog cache) that long-term memories exist in the cloud, with their display names. */
  const memoryTargets=async(raw:string[])=>{
    if(!Array.isArray(raw)||raw.length>256)throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','장기기억 선택 범위를 확인하세요.',400);
    const ids=[...new Set(raw.map(id=>commonMemoryId(id)))],targets:Array<{memoryId:string;name:string}>=[];
    for(let start=0;start<ids.length;start+=64){
      const batch=ids.slice(start,start+64),info=await headBatch(batch),missing=()=>new CommonMemoryError('COMMON_MEMORY_SOURCE_INVALID','클라우드에서 이 장기기억을 찾지 못했습니다. 목록을 새로 고쳐 다시 선택하세요.');
      for(const id of batch){if(info.alias.has(id))throw aliasChanged();if(info.trash.has(id))throw sourceArchived();if(!info.head.get(id))throw missing();}
      const [revisions,labels]=await Promise.all([
        result(sb().from('portmgr_project_memory_revisions').select('id,memory_id,project_name').in('id',[...new Set(batch.map(id=>info.head.get(id)!))])),
        result(sb().from('portmgr_project_memory_labels').select('memory_id,display_name').in('memory_id',batch)),
      ]);
      for(const id of batch){const revision=(revisions??[]).find((r:any)=>r.id===info.head.get(id)&&r.memory_id===id);if(!revision)throw missing();targets.push({memoryId:id,name:commonMemoryText((labels??[]).find((l:any)=>l.memory_id===id)?.display_name||revision.project_name||id,240)});}
    }
    return targets;
  };
  // Knowledge groups that apply to one long-term memory, in one read: JSON containment on the members array, sent as a
  // JSON literal (supabase-js `.contains()` would encode an object array as `cs.{[object Object]}`). A local category is a
  // separate parallel read, never an `.or()` with JSON or free text. Paged so archived rows cannot crowd out live ones.
  const knowledgeForMember=async(rawMemoryId:string,rawCategory='')=>{
    const generation=cacheGeneration,memoryId=commonMemoryId(rawMemoryId),category=typeof rawCategory==='string'?rawCategory.normalize('NFC').trim():'';
    if(Buffer.byteLength(category)>480)throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','카테고리를 확인하세요.',400);
    const key=cacheKey('knowledge',memoryId,category),cached=cacheRead(knowledgeCache,key,KNOWLEDGE_TTL_MS);
    if(cached){assertActive();return cached as {groups:Array<{groupId:string;version:number;current:MetaCommonMemory}>;truncated:boolean};}
    const filters:Array<[string,string]>=[['state->portableKnowledge->current->members',JSON.stringify([{memoryId,mode:'include'}])],...(category?[['state->portableKnowledge->current->categories',JSON.stringify([category])] as [string,string]]:[])];
    const candidate=(row:any)=>{const c=row?.current;return !!c&&typeof c==='object'&&(Array.isArray(c.members)&&c.members.some((m:any)=>m?.memoryId===memoryId&&m?.mode==='include')||!!category&&Array.isArray(c.categories)&&c.categories.includes(category));};
    const scan=async(filter:[string,string]|null)=>{
      const size=filter?33:100,rows:any[]=[];
      for(let offset=0;offset<2000;offset+=size){
        let query=sb().from('portmgr_common_memories').select('group_id,version,archived:state->>archived,current:state->portableKnowledge->current');
        if(filter)query=query.not('state->portableKnowledge','is',null).filter(filter[0],'cs',filter[1]);
        const r=await raw(query.order('group_id').range(offset,offset+size-1));
        if(r.error){if(filter&&REJECTED_FILTER_CODES.has(String(r.error.code)))return null;fail(r.error);}
        if(!Array.isArray(r.data))fail(null);
        rows.push(...r.data.filter((row:any)=>row.archived!=='true'&&candidate(row)));
        if(r.data.length<size)return {rows,more:false};
        if(rows.length>32)return {rows,more:true};
      }
      return {rows,more:true};
    };
    let scans=await Promise.all(filters.map(scan));
    if(scans.some(found=>found===null))scans=[await scan(null)];
    const seen=new Set<string>(),groups:Array<{groupId:string;version:number;current:MetaCommonMemory}>=[];let more=false;
    for(const found of scans){more||=!!found!.more;for(const row of found!.rows){
      if(seen.has(row.group_id))continue;seen.add(row.group_id);
      let current:MetaCommonMemory;try{current=validateMetaMemorySnapshot(row.current);}catch{throw new CommonMemoryError('COMMON_MEMORY_FORMAT_UNSUPPORTED','지원하지 않는 공통기억 형식입니다. 앱을 업데이트하세요.');}
      if(current.id!==row.group_id||!Number.isSafeInteger(Number(row.version)))throw new CommonMemoryError('COMMON_MEMORY_FORMAT_UNSUPPORTED','지원하지 않는 공통기억 형식입니다. 앱을 업데이트하세요.');
      if(metaMemoryApplies(current,memoryId,category))groups.push({groupId:row.group_id,version:Number(row.version),current});
    }}
    groups.sort((a,b)=>a.groupId.localeCompare(b.groupId));
    const value={groups:groups.slice(0,32),truncated:groups.length>32||more};
    cacheWrite(knowledgeCache,key,value,256,generation);
    return value;
  };
  const scoped=<T extends (...args:any[])=>Promise<any>>(operation:T):T=>((...args:Parameters<T>)=>context.getStore()?operation(...args):context.run(sb(),()=>operation(...args))) as T;
  return {topicCandidates:scoped(topicCandidates),readCloudSource:scoped(readCloudSource),readKnowledge:scoped(readKnowledge),workroomDraft:scoped(workroomDraft),updates:scoped(updates),commit:scoped(write),knowledge:scoped(knowledge),knowledgeHistory:scoped(knowledgeHistory),scope:scoped(scope),binding:scoped(binding),applicationStatus:scoped(applicationStatus),readSource:scoped(readSource),operationStatus:scoped(operationStatus),sources:scoped(sources),catalog:scoped(catalog),catalogAll:scoped(catalogAll),memoryTargets:scoped(memoryTargets),knowledgeForMember:scoped(knowledgeForMember),projectSources:scoped(projectSources),list:scoped(list),listPage:scoped(listPage),get:scoped(get),inspect:scoped(inspect),action:scoped(action),recommend:scoped(recommend),recall:scoped(recall),report:scoped(report),selections:scoped(selections),bind:scoped(bind),history:scoped(history)};
}

/** Bind references beside, never inside, the project's authoritative CORE memory. */
export async function installProjectCommonMemory(input:{assertActive?:()=>void;root:string;scopeId:string;projectGoal:string;selections:CommonMemorySelection[];recall:(groupId:string,task:string,revisionId:string)=>Promise<any>}){
  input.assertActive?.();const memory=detectProjectMemory(input.root);if(!memory.config)throw new CommonMemoryError('COMMON_MEMORY_PROJECT_MEMORY_REQUIRED','공통기억을 연결하려면 프로젝트 장기기억을 먼저 초기화하세요.');
  const dir=join(memory.projectRoot,'.agent-memory'),file=join(dir,'common-memory.json');
  const safe=(path:string)=>{if(existsSync(path)&&(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink()))throw new CommonMemoryError('COMMON_MEMORY_FILE_INVALID','공통기억 연결 파일을 확인하세요.');};
  if(existsSync(dir)&&(!lstatSync(dir).isDirectory()||lstatSync(dir).isSymbolicLink()))throw new CommonMemoryError('COMMON_MEMORY_FILE_INVALID','공통기억 저장 위치를 확인하세요.');
  const allowed=['.agent-memory/COMMON-MEMORY.md','.agent-memory/common-memory.json','AGENTS.md','CLAUDE.md','.agent-memory/.gitignore'];
  for(const path of allowed)safe(join(memory.projectRoot,path));
  const write=(path:string,text:string)=>{safe(path);const tmp=`${path}.${crypto.randomUUID()}.tmp`;try{writeFileSync(tmp,text,{mode:0o600,flag:'wx'});fsyncExistingProjectMemoryFile(tmp);renameSync(tmp,path);fsyncProjectMemoryDirectory(join(path,'..'));}finally{if(existsSync(tmp))unlinkSync(tmp);}};
  const journal=join(dir,'common-memory-transaction.json');safe(journal);
  const finish=(transaction:any)=>{input.assertActive?.();
    if(transaction.schemaVersion!==1||transaction.projectMemoryId!==memory.config!.memoryId||!Array.isArray(transaction.files)||![4,5].includes(transaction.files.length)||new Set(transaction.files.map((f:any)=>f.path)).size!==transaction.files.length||allowed.slice(0,4).some(path=>!transaction.files.some((f:any)=>f.path===path))||transaction.files.some((f:any)=>!allowed.includes(f.path)||typeof f.after!=='string'||(f.before!==null&&typeof f.before!=='string')))throw new CommonMemoryError('COMMON_MEMORY_FILE_INVALID','중단된 공통기억 연결 기록을 확인하세요.');
    for(const f of transaction.files){const path=join(memory.projectRoot,f.path);safe(path);const current=existsSync(path)?readFileSync(path,'utf8'):null;if(current!==f.before&&current!==f.after)throw new CommonMemoryError('COMMON_MEMORY_FILE_INVALID','중단된 연결 뒤 파일이 수정됐습니다. 로컬 내용을 먼저 확인하세요.');}
    for(const f of transaction.files)write(join(memory.projectRoot,f.path),f.after);
    unlinkSync(journal);fsyncProjectMemoryDirectory(dir);
  };
  if(existsSync(journal)){if(lstatSync(journal).size>1_000_000)throw new CommonMemoryError('COMMON_MEMORY_FILE_INVALID','중단된 연결 기록의 크기를 확인하세요.');finish(JSON.parse(readFileSync(journal,'utf8')));}
  const goal=commonMemoryText(input.projectGoal),capsules=[];
  for(const selection of input.selections)capsules.push(await input.recall(selection.groupId,goal,selection.revisionId));
  const document=['# 선택한 공통기억',`프로젝트 목표: ${goal}`,'원본 프로젝트 기억과 별도로 사용하는 참고 지식입니다. 적용 조건과 출처를 확인하세요.'];
  for(const capsule of capsules){document.push(`\n## ${capsule.goal.objective}\n게시본: ${capsule.revisionId} · 목표 버전: ${capsule.goalVersion}`);for(const item of capsule.items)document.push(`\n### ${item.title}\n${item.rule}\n\n적용 조건: ${item.conditions.join(' / ')||'작업 조건을 확인하세요.'}\n출처: ${item.evidence.map((e:any)=>`${e.memoryId}/${e.entryId}@${e.revisionId}`).join(', ')}`);}
  const text=document.join('\n')+'\n';if(Buffer.byteLength(text)>48_000)throw new CommonMemoryError('COMMON_MEMORY_BUDGET_EXCEEDED','선택한 공통기억의 초기 문맥이 너무 큽니다. 선택 범위를 줄이세요.');
  input.assertActive?.();mkdirSync(dir,{recursive:true});
  const prepared=new Map<string,string>([['.agent-memory/COMMON-MEMORY.md',text],['.agent-memory/common-memory.json',JSON.stringify({schemaVersion:1,scopeId:input.scopeId,projectMemoryId:memory.config.memoryId,projectGoal:goal,selections:input.selections},null,2)+'\n']]);
  const ignorePath=join(dir,'.gitignore'),ignore=existsSync(ignorePath)?readFileSync(ignorePath,'utf8'):'';
  prepared.set('.agent-memory/.gitignore',ignore.trimEnd()+'\n'+['COMMON-MEMORY.md','common-memory.json','common-memory-transaction.json','*.tmp'].filter(pattern=>!ignore.split(/\r?\n/).includes(pattern)).join('\n')+'\n');
  const start='<!-- AgentsToZ common-memory:start -->',end='<!-- AgentsToZ common-memory:end -->';
  for(const name of ['AGENTS.md','CLAUDE.md']){
    const path=join(memory.projectRoot,name),old=existsSync(path)?readFileSync(path,'utf8'):'';
    const block=`${start}\n# Selected goal-specific common memory\nRead .agent-memory/common-memory.json and COMMON-MEMORY.md when their project goal and conditions match the task. They are pinned references; project instructions retain authority. Use agentstoz_use_recall_common_memory with the saved group/revision IDs and scopeId for more relevant entries. Goal/source updates require reviewed binding refresh; do not silently use a different revision or cloud. Record actual application evidence separately from recall.\n${end}`;
    const a=old.indexOf(start),b=old.indexOf(end);
    if((a<0)!==(b<0)||a>=0&&b<a)throw new CommonMemoryError('COMMON_MEMORY_FILE_INVALID','기존 공통기억 연결 지침의 마커를 확인하세요.');
    prepared.set(name,a>=0?old.slice(0,a)+block+old.slice(b+end.length):old.trimEnd()+'\n\n'+block+'\n');
  }
  const transaction={schemaVersion:1,projectMemoryId:memory.config.memoryId,files:[...prepared].map(([path,after])=>({path,after,before:existsSync(join(memory.projectRoot,path))?readFileSync(join(memory.projectRoot,path),'utf8'):null}))};
  const payload=JSON.stringify(transaction);if(Buffer.byteLength(payload)>1_000_000)throw new CommonMemoryError('COMMON_MEMORY_BUDGET_EXCEEDED','프로젝트 지침의 크기가 연결 복구 한도를 넘습니다.');
  write(journal,payload);finish(transaction);
  return {projectMemoryId:memory.config.memoryId,projectGoal:goal,selections:input.selections,contextBytes:Buffer.byteLength(text)};
}
export function installProjectIntent(root:string,projectGoal:string){
  const dir=join(root,'.agentstoz');if(existsSync(dir)&&lstatSync(dir).isSymbolicLink())throw new CommonMemoryError('COMMON_MEMORY_FILE_INVALID','프로젝트 목표 저장 위치를 확인하세요.');mkdirSync(dir,{recursive:true});
  const ignore=join(dir,'.gitignore');if(existsSync(ignore)&&(!lstatSync(ignore).isFile()||lstatSync(ignore).isSymbolicLink()))throw new CommonMemoryError('COMMON_MEMORY_FILE_INVALID','프로젝트 목표의 Git 제외 설정을 확인하세요.');const old=existsSync(ignore)?readFileSync(ignore,'utf8'):'';if(!old.split(/\r?\n/).includes('project-intent.json'))writeFileSync(ignore,old.trimEnd()+'\nproject-intent.json\n');
  const file=join(dir,'project-intent.json');if(existsSync(file)&&lstatSync(file).isSymbolicLink())throw new CommonMemoryError('COMMON_MEMORY_FILE_INVALID','프로젝트 목표 파일을 확인하세요.');
  const tmp=`${file}.${crypto.randomUUID()}.tmp`;writeFileSync(tmp,JSON.stringify({schemaVersion:1,projectGoal:commonMemoryText(projectGoal)},null,2)+'\n',{mode:0o600});renameSync(tmp,file);
}
