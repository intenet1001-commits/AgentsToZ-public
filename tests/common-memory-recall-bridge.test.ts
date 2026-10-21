// T2: recall and compatibility bridge in common-memory-migration-server.ts, driven through the real cloud service on the
// shared fake cloud (round trips counted there) and the real local SQLite store.
// - recall: one member lookup, no per-group get; the local store is opened only when something is unfenced.
// - compatibility: no list probe; an unmigrated cloud still falls back to local when nothing is fenced.
// - fences are read across every local page, not the first 50.
import {afterEach,describe,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {MetaCommonMemoryStore} from '../src/metaCommonMemoryStore';
import {MetaCommonMemoryService} from '../src/metaCommonMemoryService';
import {type MetaMemoryProject} from '../src/metaCommonMemoryContract';
import {portableCommonMemory} from '../src/commonMemoryPortableKnowledge';
import {createCommonMemory} from '../src/commonMemory';
import {createCommonMemoryService,clearCommonMemoryServiceCaches} from '../common-memory-server';
import {createCommonMemoryMigration} from '../common-memory-migration-server';
import {CommonCloud,A} from './fixtures/common-memory/cloud';

const dirs:string[]=[];
afterEach(()=>{clearCommonMemoryServiceCaches();dirs.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true}));});
const tempStore=()=>{const dir=mkdtempSync(join(tmpdir(),'recall-bridge-'));dirs.push(dir);return new MetaCommonMemoryStore(dir);};
const SCOPE='e'.repeat(64);

function world(){
  const projects:MetaMemoryProject[]=['Marketplace','Usher','Other'].map(name=>({id:name,name,category:'NHCS',memoryId:crypto.randomUUID(),state:'ready'}));
  const cloud=Object.assign(new CommonCloud(),{commonMemoryScope:SCOPE});
  const raw=createCommonMemoryService(()=>cloud);
  const counts={list:0,get:0,projects:0,fresh:0};
  const service={...raw,list:async()=>{counts.list++;return raw.list();},get:async(id:string)=>{counts.get++;return raw.get(id);}} as typeof raw;
  const store=tempStore(),local=new MetaCommonMemoryService(store,{projects:async()=>projects,prepareProject:async()=>{throw Error('must not initialize');}});
  const projectsFn=async(fresh?:boolean)=>{counts.projects++;if(fresh)counts.fresh++;return projects;};
  const scratch=new MetaCommonMemoryService(tempStore(),{projects:async()=>projects,prepareProject:async()=>{throw Error('must not initialize');}});
  /** A group made in a throwaway store and placed only in the cloud. */
  const cloudGroup=async(name:string,opts:{members?:Array<[MetaMemoryProject,'include'|'exclude']>;categories?:string[];archived?:boolean;entries?:Array<[string,string]>}={})=>{
    const group=await localGroup(scratch,name,opts);const state=await portableCommonMemory(group,group);
    cloud.tables.portmgr_common_memories!.push({group_id:state.id,version:1,state});return state;
  };
  return {projects,cloud,service,counts,store,local,projectsFn,cloudGroup,migration:(deadline?:number)=>createCommonMemoryMigration(store,service,projectsFn,deadline?{recallDeadlineMs:deadline}:{})};
}
async function localGroup(svc:MetaCommonMemoryService,name:string,opts:{members?:Array<[MetaMemoryProject,'include'|'exclude']>;categories?:string[];archived?:boolean;entries?:Array<[string,string]>}={}){
  let memory=(await svc.execute({operation:'save',requestId:crypto.randomUUID(),expectedRevision:0,name,description:name+' 설명',categories:opts.categories??[],assignments:(opts.members??[]).map(([p,mode])=>({portId:p.id,expectedMemoryId:p.memoryId,mode}))} as any)).memory;
  for(const [title,body] of opts.entries??[['배포 호환',`${name} 배포 호환 규칙`]])memory=(await svc.execute({operation:'save-entry',memoryId:memory.id,expectedRevision:memory.revision,requestId:crypto.randomUUID(),title,body} as any)).memory;
  if(opts.archived)memory=(await svc.execute({operation:'archive',memoryId:memory.id,expectedRevision:memory.revision,requestId:crypto.randomUUID(),archived:true} as any)).memory;
  return memory;
}
const fence=(store:MetaCommonMemoryStore,id:string)=>{const snapshot=store.read(id);store.prepareHandoff({groupId:id,scopeId:SCOPE,requestId:crypto.randomUUID(),requestHash:'b'.repeat(64),sourceFingerprint:createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')},snapshot.revision,'{}');};
const gets=(cloud:CommonCloud)=>cloud.calls.filter(c=>c.select==='group_id,version,state').length;

describe('recall',()=>{
  test('one cloud read and no per-group get; a goal-only group costs nothing; archived groups are ignored',async()=>{
    const w=world(),[p]=w.projects as [MetaMemoryProject];
    await w.cloudGroup('배포 공통',{members:[[p,'include']]});await w.cloudGroup('보관됨',{members:[[p,'include']],archived:true});
    const goal=await createCommonMemory({name:'목표만',goal:{objective:'배포 호환',include:[],exclude:[],conditions:[],checks:[]},sourceMemoryIds:[A]});w.cloud.tables.portmgr_common_memories!.push({group_id:goal.id,version:1,state:goal});
    w.cloud.resetCounts();
    const r=await w.migration().recall(p.memoryId!,'배포 호환');
    expect(r.groups.map(g=>g.name)).toEqual(['배포 공통']);expect(r.hits).toHaveLength(1);
    expect(w.cloud.roundTrips).toBe(1);expect(gets(w.cloud)).toBe(0);expect(w.counts.list).toBe(0);expect(w.counts.get).toBe(0);
  });
  test('an explicit exclude beats the category rule',async()=>{
    const w=world(),[p,q]=w.projects as [MetaMemoryProject,MetaMemoryProject];
    await w.cloudGroup('카테고리 공통',{categories:['NHCS'],members:[[p,'exclude']]});
    expect((await w.migration().recall(p.memoryId!,'배포 호환','NHCS')).hits).toEqual([]);
    expect((await w.migration().recall(q.memoryId!,'배포 호환','NHCS')).hits).toHaveLength(1);
  });
  test('with every local group fenced the local store is never opened for recall',async()=>{
    const w=world(),[p]=w.projects as [MetaMemoryProject];
    const g=await localGroup(w.local,'로컬 원본',{members:[[p,'include']]});fence(w.store,g.id);await w.cloudGroup('클라우드',{members:[[p,'include']]});
    let opened=0;const original=w.store.recall.bind(w.store);w.store.recall=(...args)=>{opened++;return original(...args);};
    const r=await w.migration().recall(p.memoryId!,'배포 호환');
    expect(opened).toBe(0);expect(r.groups.map(x=>x.name)).toEqual(['클라우드']);expect(r.hits.every(h=>h.memoryId!==g.id)).toBe(true);
  });
  test('unfenced local hits merge best-score-first within 8 hits and 16 KB',async()=>{
    const w=world(),[p]=w.projects as [MetaMemoryProject];
    const many=(label:string)=>Array.from({length:6},(_,i)=>[`${label} 배포 ${i}`,`배포 호환 ${'규칙 '.repeat(i+1)}${label} ${i}`] as [string,string]);
    await localGroup(w.local,'로컬',{members:[[p,'include']],entries:many('로컬')});await w.cloudGroup('클라우드',{members:[[p,'include']],entries:many('클라우드')});
    const r=await w.migration().recall(p.memoryId!,'배포 호환');
    expect(r.hits).toHaveLength(8);expect(r.truncated).toBe(true);expect(new Set(r.groups.map(g=>g.name))).toEqual(new Set(['로컬','클라우드']));
    for(let i=1;i<r.hits.length;i++)expect(r.hits[i-1]!.score).toBeGreaterThanOrEqual(r.hits[i]!.score);
    const big=world(),[bp]=big.projects as [MetaMemoryProject],wide=(label:string)=>Array.from({length:4},(_,i)=>[`${label} 큰 배포 ${i}`,`배포 호환 ${'가'.repeat(1300)} ${i}`] as [string,string]);
    await localGroup(big.local,'로컬',{members:[[bp,'include']],entries:wide('로컬')});await big.cloudGroup('클라우드',{members:[[bp,'include']],entries:wide('클라우드')});
    const b=await big.migration().recall(bp.memoryId!,'배포 호환');
    expect(Buffer.byteLength(JSON.stringify(b))).toBeLessThanOrEqual(16_384);expect(b.truncated).toBe(true);expect(b.hits.length).toBeGreaterThan(0);expect(b.hits.length).toBeLessThan(8);
  });
  test('an unfenced local copy whose id the cloud already holds is not merged, even when the cloud copy excludes this memory',async()=>{
    const w=world(),[p]=w.projects as [MetaMemoryProject];
    const g=await localGroup(w.local,'같은 ID',{members:[[p,'include']]}),current={...structuredClone(g),revision:g.revision+1,members:g.members.map((m:any)=>({...m,mode:'exclude' as const}))};
    const state=await portableCommonMemory(g,current);w.cloud.tables.portmgr_common_memories!.push({group_id:state.id,version:3,state});
    const r=await w.migration().recall(p.memoryId!,'배포 호환');
    expect(r.hits).toEqual([]);expect(w.counts.list).toBe(1);
  });
  test('a slow cloud yields COMMON_MEMORY_RECALL_TIMEOUT',async()=>{
    const w=world(),[p]=w.projects as [MetaMemoryProject];await w.cloudGroup('느린',{members:[[p,'include']]});w.cloud.latency=400;
    const started=Date.now();await expect(w.migration(60).recall(p.memoryId!,'배포 호환')).rejects.toMatchObject({code:'COMMON_MEMORY_RECALL_TIMEOUT',status:504});
    expect(Date.now()-started).toBeLessThan(350);
  });
  test('an unmigrated cloud still falls back to local recall when nothing is fenced',async()=>{
    const w=world(),[p]=w.projects as [MetaMemoryProject];await localGroup(w.local,'로컬',{members:[[p,'include']]});w.cloud.error={code:'PGRST205'};
    expect((await w.migration().recall(p.memoryId!,'배포 호환')).hits).toHaveLength(1);
  });
});

describe('compatibility and legacy enumeration',()=>{
  test('compatibility makes no list probe; a meta request lists at most once; read enumerates projects once',async()=>{
    const w=world(),[p]=w.projects as [MetaMemoryProject],state=await w.cloudGroup('공통',{members:[[p,'include']]}),m=w.migration();
    expect((await m.compatibility({operation:'projects'} as any)).handled).toBe(false);expect(w.counts.list).toBe(0);
    const listed=await m.compatibility({operation:'list',query:'',offset:0});expect(listed.result.total).toBe(1);expect(w.counts.list).toBe(1);
    w.counts.list=0;w.counts.projects=0;
    const read=await m.compatibility({operation:'read',memoryId:state.id});expect(read.result.appliedProjectIds).toEqual([p.id]);expect(w.counts.list).toBeLessThanOrEqual(1);expect(w.counts.projects).toBe(1);
  });
  test('an unmigrated cloud with nothing fenced keeps the desktop on its local store',async()=>{
    const w=world();await localGroup(w.local,'로컬');w.cloud.error={code:'PGRST205'};
    expect(await w.migration().compatibility({operation:'list',query:'',offset:0})).toEqual({handled:false});
  });
  test('legacy recall resolves a portId from the identity cache and scans fresh only for a missing row',async()=>{
    const w=world(),[p]=w.projects as [MetaMemoryProject];await w.cloudGroup('공통',{members:[[p,'include']]});const m=w.migration();
    expect((await m.legacy({operation:'recall',portId:p.id,query:'배포 호환'})).result.hits).toHaveLength(1);expect(w.counts.fresh).toBe(0);
    await expect(m.legacy({operation:'recall',portId:'missing',query:'배포 호환'})).rejects.toMatchObject({code:'COMMON_MEMORY_PROJECT_MEMORY_REQUIRED'});expect(w.counts.fresh).toBe(1);
  });
  test('legacy recall by projectMemoryId needs a registered memory; a bare memoryId grants nothing',async()=>{
    const w=world(),[p]=w.projects as [MetaMemoryProject];await w.cloudGroup('공통',{members:[[p,'include']]});const m=w.migration();
    expect((await m.legacy({operation:'recall',portId:'',projectMemoryId:p.memoryId!.toUpperCase(),query:'배포 호환'} as any)).result.hits).toHaveLength(1);expect(w.counts.fresh).toBe(0);
    await expect(m.legacy({operation:'recall',portId:'',projectMemoryId:crypto.randomUUID(),query:'배포 호환'} as any)).rejects.toMatchObject({code:'COMMON_MEMORY_PROJECT_MEMORY_REQUIRED'});
  });
});

describe('fences across every page',()=>{
  test('fencedIds sees a group beyond the first 50, so an unmigrated cloud no longer falls back over a fenced original',async()=>{
    const w=world(),first=await localGroup(w.local,'가장 오래된');
    for(let i=0;i<54;i++)await localGroup(w.local,'그룹 '+i);
    expect(w.store.list().memories.some(m=>m.id===first.id)).toBe(false);
    fence(w.store,first.id);
    expect(w.store.fencedIds()).toEqual(new Set([first.id]));expect(w.store.hasUnfenced()).toBe(true);expect(w.store.fenceState().unfenced.size).toBe(54);
    w.cloud.error={code:'PGRST205'};
    await expect(w.migration().compatibility({operation:'list',query:'',offset:0})).rejects.toMatchObject({code:'COMMON_MEMORY_MIGRATION_REQUIRED'});
  });
  test('without any handoff every group is unfenced; an absent store has nothing',()=>{
    const empty=tempStore();expect(empty.fencedIds().size).toBe(0);expect(empty.hasUnfenced()).toBe(false);
  });
});
