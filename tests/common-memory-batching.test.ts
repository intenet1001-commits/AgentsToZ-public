// T1: batched/cached cloud reads in common-memory-server.ts.
// - The batched source walk must throw the same first error, in the same input order, as the former per-id chain
//   (kept below as `serialSources`, copied verbatim from the pre-batching code).
// - The fake's alias walk is proven against the real portmgr_resolve_project_memory_id on PGlite, so "same as the fake"
//   means "same as the database".
// - knowledgeForMember is checked through the real supabase-js/postgrest-js URL builder, not only the fake.
import {afterEach,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createClient} from '@supabase/supabase-js';
import {createCommonMemoryService,clearCommonMemoryServiceCaches,withCommonMemoryDeadline} from '../common-memory-server';
import {CommonMemoryError,commonMemoryText} from '../src/commonMemory';
import {parseProjectMemoryEntries} from '../src/projectMemoryRecall';
import {normalizeGitHubRepositoryUrl} from '../src/githubUrls';
import {PROJECT_MEMORY_MERGE_SQL} from '../src/schemaSql';
import {CommonCloud,A,B,C} from './fixtures/common-memory/cloud';

afterEach(()=>clearCommonMemoryServiceCaches());

function fail(error:any):never{
  const code=String(error?.message??error?.code??'');
  if(/COMMON_MEMORY_(VERSION_CHANGED|SOURCE_CHANGED|REQUEST_CONFLICT|REVIEW_REQUIRED)/.test(code))throw new CommonMemoryError(code.match(/COMMON_MEMORY_[A-Z_]+/)![0],'목표·원본·게시 이력이 바뀌었습니다. 현재 내용을 다시 확인하세요.');
  if(/42P01|PGRST202|PGRST205/.test(String(error?.code)))throw new CommonMemoryError('COMMON_MEMORY_MIGRATION_REQUIRED','클라우드 공통기억 업데이트가 필요합니다. 기존 장기기억은 유지됩니다.',503);
  throw new CommonMemoryError('COMMON_MEMORY_CLOUD_UNAVAILABLE','클라우드 공통기억을 확인하지 못했습니다. 연결과 접근 권한을 확인하세요.',503);
}
/** The pre-batching implementation: 4 sequential calls per id. Reference behaviour only. */
async function serialSources(sb:any,ids:string[],includeEntries=true){
  const result=async(query:any)=>{const r=await query.abortSignal(AbortSignal.timeout(15_000));if(r.error)fail(r.error);return r.data;};
  const heads:any[]=[],entries:any[]=[],choices:any[]=[];let bytes=0;
  for(const id of ids){
    const canonical=await result(sb.rpc('portmgr_resolve_project_memory_id',{p_memory_id:id}));
    if(canonical!==id)throw new CommonMemoryError('COMMON_MEMORY_SOURCE_ALIAS_CHANGED','원본 기억의 계보가 바뀌었습니다. 대표 기억을 다시 선택하세요.');
    const trash=await result(sb.from('portmgr_project_memory_trash').select('memory_id').eq('memory_id',id).maybeSingle());
    if(trash)throw new CommonMemoryError('COMMON_MEMORY_SOURCE_ARCHIVED','보관된 원본 기억을 연결 목록에서 확인하세요.');
    const head=await result(sb.from('portmgr_project_memory_heads').select('head_revision_id').eq('memory_id',id).single());
    const revision=await result(sb.from('portmgr_project_memory_revisions').select(includeEntries?'id,memory_id,content,content_hash,project_name,github_url':'id,memory_id,content_hash').eq('id',head?.head_revision_id).eq('memory_id',id).single());
    if(!includeEntries){if(!/^[a-f0-9]{64}$/.test(revision?.content_hash))throw new CommonMemoryError('COMMON_MEMORY_SOURCE_INVALID','원본 기억의 hash 형식을 확인하세요.');heads.push({memoryId:id,revisionId:revision.id,contentHash:revision.content_hash});continue;}
    if(typeof revision?.content!=='string'||createHash('sha256').update(revision.content).digest('hex')!==revision.content_hash)throw new CommonMemoryError('COMMON_MEMORY_SOURCE_INVALID','원본 기억의 내용 검증에 실패했습니다.');
    bytes+=Buffer.byteLength(revision.content);if(bytes>2_000_000)throw new CommonMemoryError('COMMON_MEMORY_BUDGET_EXCEEDED','선택한 원본의 크기가 한도를 넘습니다. 연결 범위를 줄여서 검토하세요.');
    heads.push({memoryId:id,revisionId:revision.id,contentHash:revision.content_hash});
    choices.push({memoryId:id,name:commonMemoryText(revision.project_name||id,240),githubUrl:typeof revision.github_url==='string'?normalizeGitHubRepositoryUrl(revision.github_url):null});
    for(const entry of parseProjectMemoryEntries(revision.content)){
      if(!entry.body.trim())continue;
      if(Buffer.byteLength(entry.body)>12_000)throw new CommonMemoryError('COMMON_MEMORY_BUDGET_EXCEEDED','원본 항목이 너무 큽니다. 원본에서 항목을 나눠 저장한 뒤 검토하세요.');
      entries.push({memoryId:id,revisionId:revision.id,entryId:entry.entryId,contentHash:entry.contentVersionHash,title:entry.title,excerpt:entry.body,section:entry.section});
    }
    if(entries.length>500)throw new CommonMemoryError('COMMON_MEMORY_BUDGET_EXCEEDED','검토할 원본 항목이 500개를 넘습니다. 원본 연결 범위를 줄이세요.');
  }
  return {entries,heads,choices};
}
const outcome=async(run:()=>Promise<any>)=>{try{return {ok:await run()};}catch(error){return {code:(error as any)?.code??String(error),message:(error as Error)?.message};}};
const entryId=(n:number)=>n.toString(16).padStart(24,'0');
const noteBody=(label:string,count=1)=>Array.from({length:count},(_,i)=>`### ${label} ${i}\n<!-- memory-entry-id:${entryId(i+1)} -->\n${label} 본문 ${i}`).join('\n\n');
/** A cloud with `n` extra healthy long-term memories; returns their ids in creation order. */
function cloudWith(n:number){const cloud=Object.assign(new CommonCloud(),{commonMemoryScope:'c'.repeat(64)}),ids=Array.from({length:n},()=>crypto.randomUUID());ids.forEach((id,i)=>cloud.source(id,noteBody('원본'+i,2)));return {cloud,ids};}
const head=(cloud:CommonCloud,id:string)=>cloud.tables.portmgr_project_memory_revisions!.find(r=>r.id===cloud.tables.portmgr_project_memory_heads!.find(h=>h.memory_id===id)!.head_revision_id)!;

test('the fake alias walk matches portmgr_resolve_project_memory_id on PGlite, including self-alias and cycles',async()=>{
  const fn=PROJECT_MEMORY_MERGE_SQL.match(/create or replace function public\.portmgr_resolve_project_memory_id[\s\S]*?\$\$;/)![0];
  // The real table forbids alias=canonical; the scenario is still checked so a legacy or hand-made row fails identically.
  expect(PROJECT_MEMORY_MERGE_SQL).toContain('check (alias_memory_id <> canonical_memory_id)');
  const db=new PGlite();
  try{
    await db.exec(`create table public.portmgr_project_memory_aliases(alias_memory_id text primary key,canonical_memory_id text not null);\n${fn}`);
    const X='44444444-4444-4444-8444-444444444444';
    const configs:Array<Array<[string,string]>>=[[],[[A,B]],[[A,A]],[[A,B],[B,A]],[[A,B],[B,C]],[[A,B],[B,C],[C,C]],Array.from({length:21},(_,i)=>[i?`chain-${i}`:A,`chain-${i+1}`] as [string,string])];
    for(const rows of configs){
      await db.exec('delete from public.portmgr_project_memory_aliases');
      for(const [alias,canonical] of rows)await db.query('insert into public.portmgr_project_memory_aliases values($1,$2)',[alias,canonical]);
      const cloud=new CommonCloud();cloud.tables.portmgr_project_memory_aliases!.push(...rows.map(([alias_memory_id,canonical_memory_id])=>({alias_memory_id,canonical_memory_id})));
      for(const id of [A,B,C,X]){
        const real=await db.query<{v:string}>('select public.portmgr_resolve_project_memory_id($1) as v',[id]).then(r=>({data:r.rows[0]!.v}),(e:any)=>({error:e.message}));
        const fake=cloud.resolve(id);
        expect(fake.error?{error:fake.error.message}:{data:fake.data}).toEqual(real);
        if(fake.error)expect(fake.error.code).toBe('P0001');
      }
    }
  }finally{await db.close();}
});

test('batched sources return the same results and first errors as the per-id chain, in input order',async()=>{
  type Scenario={name:string;setup:(cloud:CommonCloud,ids:string[])=>string[]};
  const scenarios:Scenario[]=[
    {name:'healthy, input order and duplicates',setup:(_,ids)=>[ids[5]!,ids[0]!,ids[3]!,ids[0]!,ids[9]!]},
    {name:'alias at position 3',setup:(cloud,ids)=>{cloud.tables.portmgr_project_memory_aliases!.push({alias_memory_id:ids[2]!,canonical_memory_id:ids[7]!});return ids.slice(0,6);}},
    {name:'self-alias row',setup:(cloud,ids)=>{cloud.tables.portmgr_project_memory_aliases!.push({alias_memory_id:ids[2]!,canonical_memory_id:ids[2]!});return ids.slice(0,6);}},
    {name:'alias cycle',setup:(cloud,ids)=>{cloud.tables.portmgr_project_memory_aliases!.push({alias_memory_id:ids[1]!,canonical_memory_id:ids[8]!},{alias_memory_id:ids[8]!,canonical_memory_id:ids[1]!});return ids.slice(0,6);}},
    {name:'trashed after an earlier alias',setup:(cloud,ids)=>{cloud.tables.portmgr_project_memory_trash!.push({memory_id:ids[1]!});cloud.aliases.set(ids[4]!,ids[9]!);return ids.slice(0,6);}},
    {name:'missing head',setup:(cloud,ids)=>{cloud.tables.portmgr_project_memory_heads=cloud.tables.portmgr_project_memory_heads!.filter(h=>h.memory_id!==ids[3]);return ids.slice(0,6);}},
    {name:'head pointing at another memory',setup:(cloud,ids)=>{head(cloud,ids[2]!).memory_id=ids[9];return ids.slice(0,6);}},
    {name:'bad hash',setup:(cloud,ids)=>{head(cloud,ids[4]!).content_hash='not-a-hash';return ids.slice(0,6);}},
    {name:'content changed under the hash',setup:(cloud,ids)=>{head(cloud,ids[1]!).content+='\n변조';return ids.slice(0,6);}},
    {name:'oversize entry',setup:(cloud,ids)=>{cloud.source(ids[3]!,`### 큰 항목\n<!-- memory-entry-id:${entryId(9)} -->\n${'가'.repeat(5000)}`);return ids.slice(0,6);}},
    {name:'2 MB budget',setup:(cloud,ids)=>{for(const id of ids.slice(0,10))cloud.source(id,'x'.repeat(300_000));return ids.slice(0,10);}},
    {name:'500-entry budget',setup:(cloud,ids)=>{for(const id of ids.slice(0,3))cloud.source(id,noteBody('많은 항목',200));return ids.slice(0,3);}},
    {name:'unknown id',setup:(_,ids)=>[ids[0]!,crypto.randomUUID(),ids[1]!]},
  ];
  for(const scenario of scenarios)for(const includeEntries of [true,false]){
    const make=()=>{const {cloud,ids}=cloudWith(10);return {cloud,input:scenario.setup(cloud,ids)};};
    // Same seed for both paths: build once, deep-copy the tables into a second cloud.
    const left=make(),right=Object.assign(new CommonCloud(),{commonMemoryScope:left.cloud.commonMemoryScope});right.tables=structuredClone(left.cloud.tables);right.aliases=new Map(left.cloud.aliases);
    const expected=await outcome(()=>serialSources(left.cloud,left.input,includeEntries));
    clearCommonMemoryServiceCaches();
    const actual=await outcome(()=>createCommonMemoryService(()=>right).sources(left.input,includeEntries));
    expect({scenario:scenario.name,includeEntries,actual}).toEqual({scenario:scenario.name,includeEntries,actual:expected});
  }
});

test('sources(16) costs at most 3 sequential round trips; content is fetched ≤8 ids at a time and stops at 2 MB',async()=>{
  const {cloud,ids}=cloudWith(16),s=createCommonMemoryService(()=>cloud);cloud.latency=1;
  cloud.resetCounts();const heads=await s.sources(ids,false);
  expect(heads.heads.map(h=>h.memoryId)).toEqual(ids);
  expect(cloud.waves).toBeLessThanOrEqual(3);expect(cloud.waves).toBe(2);expect(cloud.roundTrips).toBe(4);
  clearCommonMemoryServiceCaches();cloud.resetCounts();const full=await s.sources(ids,true);
  expect(full.entries).toHaveLength(32);expect(cloud.waves).toBe(3);
  const contentReads=cloud.calls.filter(c=>c.name==='portmgr_project_memory_revisions');
  expect(contentReads).toHaveLength(2);expect(contentReads.every(c=>c.inSizes!.every(n=>n<=8))).toBe(true);
  // 10 × 300 KB: the 7th crosses 2 MB inside the first window of 8, so the last two are never downloaded.
  const big=cloudWith(10);for(const id of big.ids)big.cloud.source(id,'x'.repeat(300_000));big.cloud.resetCounts();
  await expect(createCommonMemoryService(()=>big.cloud).sources(big.ids,true)).rejects.toMatchObject({code:'COMMON_MEMORY_BUDGET_EXCEEDED'});
  expect(big.cloud.calls.filter(c=>c.name==='portmgr_project_memory_revisions')).toHaveLength(1);
});

test('catalog lookups run concurrently; background walks reuse a scope cache the picker refreshes; a write clears it',async()=>{
  const {cloud}=cloudWith(3),s=createCommonMemoryService(()=>cloud);cloud.latency=1;
  cloud.resetCounts();const first=await s.catalog();expect(cloud.roundTrips).toBe(4);expect(cloud.waves).toBe(2);
  // The project-names walk (catalogAll) reuses the page the picker just read, also from a fresh per-request service.
  cloud.resetCounts();expect(await createCommonMemoryService(()=>cloud).catalogAll(3)).toEqual({sources:first.sources,complete:true,scopeId:'c'.repeat(64)});expect(cloud.roundTrips).toBe(0);
  // The picker itself always reads fresh: a renamed memory shows up at once and refreshes the cache.
  cloud.tables.portmgr_project_memory_labels!.push({memory_id:A,display_name:'새 이름'});
  cloud.resetCounts();expect((await s.catalog()).sources.find(x=>x.memoryId===A)!.name).toBe('새 이름');expect(cloud.roundTrips).toBe(4);
  cloud.resetCounts();expect((await s.catalogAll()).sources.find(x=>x.memoryId===A)!.name).toBe('새 이름');expect(cloud.roundTrips).toBe(0);
  await s.action({operation:'create',groupId:crypto.randomUUID(),requestId:crypto.randomUUID(),name:'캐시 확인',goal:{objective:'캐시 확인'},sourceMemoryIds:[A]});
  cloud.resetCounts();await s.catalogAll();expect(cloud.roundTrips).toBe(4);
  // No scope, no module cache.
  const bare=new CommonCloud(),plain=createCommonMemoryService(()=>bare);await plain.catalogAll();bare.resetCounts();await plain.catalogAll();expect(bare.roundTrips).toBe(4);
});

test('readCloudSource page 2 reuses the parsed revision while the head is unchanged and refetches after a head change',async()=>{
  const {cloud}=cloudWith(0),s=createCommonMemoryService(()=>cloud);cloud.source(A,noteBody('게임',14));
  const content=()=>cloud.calls.filter(c=>c.name==='portmgr_project_memory_revisions'&&c.select!.split(',').includes('content')).length;
  cloud.resetCounts();const one=await s.readCloudSource(A,0);expect(one.entries).toHaveLength(10);expect(one.nextOffset).toBe(10);expect(content()).toBe(1);
  cloud.resetCounts();const two=await s.readCloudSource(A,10);expect(two.entries).toHaveLength(4);expect(content()).toBe(0);
  expect(cloud.calls.map(c=>c.name).sort()).toEqual(['portmgr_project_memory_aliases','portmgr_project_memory_heads','portmgr_project_memory_trash']);
  cloud.source(A,noteBody('바뀐 게임',3));cloud.resetCounts();const three=await s.readCloudSource(A,0);
  expect(content()).toBe(1);expect(three.entries.map(e=>e.title)).toEqual(['바뀐 게임 0','바뀐 게임 1','바뀐 게임 2']);expect(three.head!.revisionId).not.toBe(one.head!.revisionId);
});

test('inspect pageSize is an internal page clamp with a matching nextOffset',async()=>{
  const {cloud}=cloudWith(0),s=createCommonMemoryService(()=>cloud);cloud.source(A,noteBody('게임',12));
  const group=await s.action({operation:'create',groupId:crypto.randomUUID(),requestId:crypto.randomUUID(),name:'게임',goal:{objective:'게임'},sourceMemoryIds:[A]});
  const page=await s.inspect(group.state.id,0,0,false,5);expect(page.sourceEntries).toHaveLength(5);expect(page.nextOffset).toBe(5);expect(page.sourceEntryCount).toBe(12);
  const next=await s.inspect(group.state.id,10,0,false,5);expect(next.sourceEntries).toHaveLength(2);expect(next.nextOffset).toBeNull();
  expect((await s.inspect(group.state.id,0,0,false,500)).sourceEntries).toHaveLength(12);
  expect((await s.inspect(group.state.id,0)).sourceEntries).toHaveLength(12);
});

test('projectSources batches heads and metadata; a bad knowledge member still reports itself',async()=>{
  const {cloud}=cloudWith(0),s=createCommonMemoryService(()=>cloud);
  const goal=await s.action({operation:'create',groupId:crypto.randomUUID(),requestId:crypto.randomUUID(),name:'목표',goal:{objective:'목표'},sourceMemoryIds:[A,B,C]});
  cloud.latency=1;cloud.resetCounts();const listed=await s.projectSources(goal.state.id);
  expect(listed.projects.map(p=>[p.memoryId,p.name])).toEqual([[A,'원본 A'],[B,'원본 B'],[C,'원본 C']]);expect(cloud.waves).toBe(3);
  cloud.tables.portmgr_project_memory_trash!.push({memory_id:B});
  await expect(s.projectSources(goal.state.id)).rejects.toMatchObject({code:'COMMON_MEMORY_SOURCE_ARCHIVED'});
  const saved=await s.knowledge({operation:'save',expectedRevision:0,requestId:'pk-members',name:'지식',description:'',tags:[],categories:[],assignments:[{portId:'a',expectedMemoryId:A,mode:'include'},{portId:'b',expectedMemoryId:B,mode:'include'},{portId:'c',expectedMemoryId:C,mode:'include'}]},[{id:'a',name:'A 폴더',memoryId:A,state:'ready',category:''},{id:'b',name:'B 폴더',memoryId:B,state:'ready',category:''},{id:'c',name:'C 폴더',memoryId:C,state:'ready',category:''}] as any);
  const knowledge=await s.projectSources(saved.state.id);
  expect(knowledge.projects.map(p=>[p.memoryId,p.revisionId?'ok':'bad'])).toEqual([[B,'bad'],[A,'ok'],[C,'ok']]);
});

test('memoryTargets returns cloud names freshly and rejects alias, trashed and unknown long-term memories',async()=>{
  const {cloud}=cloudWith(0),s=createCommonMemoryService(()=>cloud);cloud.tables.portmgr_project_memory_labels!.push({memory_id:B,display_name:'공유 B'});
  expect(await s.memoryTargets([B,A,B])).toEqual([{memoryId:B,name:'공유 B'},{memoryId:A,name:'원본 A'}]);
  cloud.tables.portmgr_project_memory_trash!.push({memory_id:C});
  await expect(s.memoryTargets([A,C])).rejects.toMatchObject({code:'COMMON_MEMORY_SOURCE_ARCHIVED'});
  await expect(s.memoryTargets([crypto.randomUUID()])).rejects.toMatchObject({code:'COMMON_MEMORY_SOURCE_INVALID'});
  cloud.aliases.set(A,B);await expect(s.memoryTargets([A])).rejects.toMatchObject({code:'COMMON_MEMORY_SOURCE_ALIAS_CHANGED'});
  await expect(s.memoryTargets(['not-a-uuid'])).rejects.toMatchObject({code:'COMMON_MEMORY_INPUT_INVALID'});
});

const snapshot=(id:string,members:Array<{memoryId:string;mode:string;name?:string}>,extra:Record<string,any>={})=>({id,revision:1,name:'지식 '+id.slice(0,4),description:'',tags:[],categories:[],archived:false,entries:[],members:members.map(m=>({name:'프로젝트',...m})),createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z',...extra});
const knowledgeRow=(id:string,current:any,state:Record<string,any>={})=>({group_id:id,version:1,state:{schemaVersion:1,id,name:current?.name??'목표',goal:{objective:'목표'},goalVersion:1,sourceMemoryIds:[],archived:false,items:[],sourceHeads:[],publication:null,...(current?{portableKnowledge:{schemaVersion:1,snapshot:current,sourceFingerprint:'f'.repeat(64),importedAt:'2026-10-01T00:00:00.000Z',current}}:{}),...state}});
const gid=(n:number)=>`${String(n).padStart(8,'0')}-0000-4000-8000-000000000000`;

test('knowledgeForMember is one round trip, excludes archived/exclude/goal-only rows, falls back once and caches until a write',async()=>{
  const cloud=Object.assign(new CommonCloud(),{commonMemoryScope:'k'.repeat(64)}),s=createCommonMemoryService(()=>cloud);
  const archivedNoKey=knowledgeRow(gid(3),snapshot(gid(3),[{memoryId:A,mode:'include'}],{archived:true}));delete (archivedNoKey.state as any).archived;
  cloud.tables.portmgr_common_memories!.push(
    knowledgeRow(gid(1),snapshot(gid(1),[{memoryId:A,mode:'include'},{memoryId:B,mode:'exclude'}])),
    knowledgeRow(gid(2),snapshot(gid(2),[{memoryId:A,mode:'include'}],{archived:true}),{archived:true}),
    archivedNoKey,
    knowledgeRow(gid(4),snapshot(gid(4),[{memoryId:A,mode:'exclude'}])),
    knowledgeRow(gid(5),null,{sourceMemoryIds:[A]}),
    knowledgeRow(gid(6),snapshot(gid(6),[{memoryId:B,mode:'include'}],{categories:['게임']})),
    knowledgeRow(gid(7),snapshot(gid(7),[],{categories:['게임']})),
    knowledgeRow(gid(8),snapshot(gid(8),[{memoryId:A,mode:'exclude'}],{categories:['게임']})),
  );
  cloud.latency=1;cloud.resetCounts();
  const found=await s.knowledgeForMember(A);
  expect(found).toEqual({groups:[{groupId:gid(1),version:1,current:expect.objectContaining({id:gid(1)})}],truncated:false});
  expect(cloud.roundTrips).toBe(1);expect(cloud.calls[0]!.filters).toEqual(['state->portableKnowledge=not.is.null',`state->portableKnowledge->current->members=cs.${JSON.stringify([{memoryId:A,mode:'include'}])}`]);
  cloud.resetCounts();expect(await s.knowledgeForMember(A)).toEqual(found);expect(cloud.roundTrips).toBe(0);
  // A local category is a parallel containment read (one wave) and never overrides an explicit exclude.
  cloud.resetCounts();const byCategory=await s.knowledgeForMember(A,'게임');
  expect(byCategory.groups.map(g=>g.groupId)).toEqual([gid(1),gid(6),gid(7)]);expect(cloud.waves).toBe(1);expect(cloud.roundTrips).toBe(2);
  // PostgREST rejecting the json-path filter: one unfiltered read, filtered here, same answer.
  clearCommonMemoryServiceCaches();cloud.rejectJsonFilters=true;cloud.resetCounts();
  expect(await s.knowledgeForMember(A)).toEqual(found);expect(cloud.roundTrips).toBe(2);expect(cloud.waves).toBe(2);expect(cloud.calls[1]!.filters).toEqual([]);
  cloud.rejectJsonFilters=false;
  // A write through this module clears the cache.
  await s.action({operation:'create',groupId:crypto.randomUUID(),requestId:crypto.randomUUID(),name:'무관한 목표',goal:{objective:'무관'},sourceMemoryIds:[C]});
  cloud.resetCounts();await s.knowledgeForMember(A);expect(cloud.roundTrips).toBe(1);
  // A corrupt current is rejected, not silently skipped.
  clearCommonMemoryServiceCaches();cloud.tables.portmgr_common_memories!.push(knowledgeRow(gid(9),{id:gid(9),members:[{memoryId:A,mode:'include'}]}));
  await expect(s.knowledgeForMember(A)).rejects.toMatchObject({code:'COMMON_MEMORY_FORMAT_UNSUPPORTED'});
  cloud.tables.portmgr_common_memories!.pop();cloud.tables.portmgr_common_memories!.push(knowledgeRow(gid(9),snapshot(gid(10),[{memoryId:A,mode:'include'}])));
  await expect(s.knowledgeForMember(A)).rejects.toMatchObject({code:'COMMON_MEMORY_FORMAT_UNSUPPORTED'});
});

test('archived rows cannot crowd a live group out of knowledgeForMember',async()=>{
  const cloud=Object.assign(new CommonCloud(),{commonMemoryScope:'q'.repeat(64)}),s=createCommonMemoryService(()=>cloud);
  for(let i=1;i<=40;i++)cloud.tables.portmgr_common_memories!.push(knowledgeRow(gid(i),snapshot(gid(i),[{memoryId:A,mode:'include'}],{archived:true}),{archived:true}));
  cloud.tables.portmgr_common_memories!.push(knowledgeRow(gid(99),snapshot(gid(99),[{memoryId:A,mode:'include'}])));
  expect((await s.knowledgeForMember(A)).groups.map(g=>g.groupId)).toEqual([gid(99)]);
  clearCommonMemoryServiceCaches();cloud.rejectJsonFilters=true;
  expect((await s.knowledgeForMember(A)).groups.map(g=>g.groupId)).toEqual([gid(99)]);
});

test('knowledgeForMember sends a JSON containment literal through the real supabase-js client',async()=>{
  const urls:URL[]=[];let reject=false;
  const fetch=async(input:any)=>{const url=new URL(typeof input==='string'?input:input.url);urls.push(url);const filtered=[...url.searchParams.values()].some(v=>v.startsWith('cs.'));
    if(reject&&filtered)return new Response(JSON.stringify({code:'PGRST100',message:'failed to parse filter',details:null,hint:null}),{status:400,headers:{'content-type':'application/json'}});
    return new Response('[]',{status:200,headers:{'content-type':'application/json'}});};
  const client=createClient('https://example.supabase.co','service-role-test-key',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:fetch as any}});
  Object.defineProperty(client,'commonMemoryScope',{value:'r'.repeat(64)});
  const s=createCommonMemoryService(()=>client);
  expect(await s.knowledgeForMember(A,'게임, "따옴표" (괄호)')).toEqual({groups:[],truncated:false});
  expect(urls).toHaveLength(2);
  const members=urls.find(u=>u.searchParams.has('state->portableKnowledge->current->members'))!,categories=urls.find(u=>u.searchParams.has('state->portableKnowledge->current->categories'))!;
  expect(members.pathname).toBe('/rest/v1/portmgr_common_memories');
  expect(members.searchParams.get('state->portableKnowledge->current->members')).toBe(`cs.[{"memoryId":"${A}","mode":"include"}]`);
  expect(categories.searchParams.get('state->portableKnowledge->current->categories')).toBe('cs.["게임, \\"따옴표\\" (괄호)"]');
  for(const url of urls){expect(url.searchParams.get('state->portableKnowledge')).toBe('not.is.null');expect(url.searchParams.has('or')).toBe(false);expect(url.search).not.toContain('object%20Object');expect(url.searchParams.get('select')).toBe('group_id,version,archived:state->>archived,current:state->portableKnowledge->current');}
  clearCommonMemoryServiceCaches();urls.length=0;reject=true;
  expect(await s.knowledgeForMember(A)).toEqual({groups:[],truncated:false});
  expect(urls).toHaveLength(2);expect([...urls[1]!.searchParams.keys()].filter(k=>k.startsWith('state'))).toEqual([]);
});

test('a chain deadline stops the remaining reads with a cloud-unavailable error',async()=>{
  const {cloud,ids}=cloudWith(4),s=createCommonMemoryService(()=>cloud);cloud.latency=30;
  await expect(withCommonMemoryDeadline(()=>s.sources(ids,true),5)).rejects.toMatchObject({code:'COMMON_MEMORY_CLOUD_UNAVAILABLE',message:expect.stringContaining('늦어')});
  cloud.latency=0;expect((await withCommonMemoryDeadline(()=>s.sources(ids,false))).heads).toHaveLength(4);
});
