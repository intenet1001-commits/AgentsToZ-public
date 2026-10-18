// T4: membership and recall keyed by the long-term memory itself ({memoryId, mode}, projectMemoryId), next to the kept
// legacy {portId, expectedMemoryId, mode} form. The cloud verifies a memoryId member (memoryTargets) before it is stored;
// the local SQLite store refuses these forms with META_MEMORY_CLOUD_REQUIRED.
import {afterEach,describe,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MetaCommonMemoryStore} from '../src/metaCommonMemoryStore';
import {MetaCommonMemoryService} from '../src/metaCommonMemoryService';
import {META_COMMON_MEMORY_LIMITS,metaMemoryApplies,parseMetaMemoryRequest,type MetaCommonMemory,type MetaMemoryProject,type MetaMemoryRecall} from '../src/metaCommonMemoryContract';
import {editPortableKnowledge,rebudgetRecall,recallPortableKnowledge} from '../src/commonMemoryPortableKnowledge';
import {createCommonMemoryService,clearCommonMemoryServiceCaches} from '../common-memory-server';
import {createCommonMemoryMigration} from '../common-memory-migration-server';
import {CommonCloud,A,B,C} from './fixtures/common-memory/cloud';

const dirs:string[]=[];
afterEach(()=>{clearCommonMemoryServiceCaches();dirs.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true}));});
const tempStore=()=>{const dir=mkdtempSync(join(tmpdir(),'membership-'));dirs.push(dir);return new MetaCommonMemoryStore(dir);};
const rid=()=>crypto.randomUUID();
const save=(assignments:unknown[],extra:Record<string,unknown>={})=>({operation:'save',requestId:rid(),expectedRevision:0,name:'공통',assignments,...extra});
const empty=(extra:Partial<MetaCommonMemory>={}):MetaCommonMemory=>({id:C,revision:0,name:'공통',description:'',tags:[],categories:[],archived:false,entries:[],members:[],createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z',...extra});
const projects:MetaMemoryProject[]=[{id:'port-a',name:'원본 A',category:'NHCS',memoryId:A,state:'ready'},{id:'port-a-wt',name:'원본 A 워크트리',category:'NHCS',memoryId:A,state:'ready'},{id:'port-b',name:'원본 B',category:'NHCS',memoryId:B,state:'ready'}];

describe('parseMetaMemoryRequest',()=>{
  test('both assignment forms parse; the memoryId form is normalized',()=>{
    const r=parseMetaMemoryRequest(save([{portId:'port-b',expectedMemoryId:B,mode:'include'},{memoryId:A.toUpperCase(),mode:'exclude'}]));
    expect(r.operation==='save'&&r.assignments).toEqual([{portId:'port-b',expectedMemoryId:B,mode:'include'},{memoryId:A,mode:'exclude'}]);
    // Main and worktree cards resolving to one memory stay allowed (contradictions are decided by the edit, as before).
    expect(()=>parseMetaMemoryRequest(save([{portId:'port-a',expectedMemoryId:A,mode:'include'},{portId:'port-a-wt',expectedMemoryId:A,mode:'include'}]))).not.toThrow();
  });
  test('mixed, extra or duplicate forms are rejected',()=>{
    const bad=[
      [{portId:'port-a',expectedMemoryId:A,memoryId:A,mode:'include'}],
      [{memoryId:A,mode:'include',name:'원본 A'}],
      [{portId:'port-a',expectedMemoryId:A,mode:'include',extra:1}],
      [{portId:'port-a',mode:'include'}],
      [{memoryId:A,mode:'include'},{memoryId:A,mode:'include'}],
      [{memoryId:A,mode:'include'},{portId:'port-a',expectedMemoryId:A,mode:'include'}],
      [{portId:'port-a',expectedMemoryId:A,mode:'include'},{portId:'port-a',expectedMemoryId:A,mode:'exclude'}],
      [{memoryId:'not-a-uuid',mode:'include'}],
      [{memoryId:A,mode:'merge'}],
    ];
    for(const assignments of bad)expect(()=>parseMetaMemoryRequest(save(assignments))).toThrow();
  });
  test('recall takes exactly one of portId or projectMemoryId',()=>{
    expect(parseMetaMemoryRequest({operation:'recall',portId:'port-a',query:'배포'})).toEqual({operation:'recall',portId:'port-a',query:'배포'});
    expect(parseMetaMemoryRequest({operation:'recall',projectMemoryId:A.toUpperCase(),query:'배포'})).toEqual({operation:'recall',projectMemoryId:A,query:'배포'});
    expect(()=>parseMetaMemoryRequest({operation:'recall',query:'배포'})).toThrow();
    expect(()=>parseMetaMemoryRequest({operation:'recall',portId:'port-a',projectMemoryId:A,query:'배포'})).toThrow();
    expect(()=>parseMetaMemoryRequest({operation:'recall',projectMemoryId:'port-a',query:'배포'})).toThrow();
  });
  test('save-entry keeps portId and gains sourceMemoryId, never both',()=>{
    const base={operation:'save-entry',memoryId:C,expectedRevision:1,requestId:rid(),title:'규칙',body:'본문'};
    expect(parseMetaMemoryRequest({...base,sourceMemoryId:A.toUpperCase()})).toMatchObject({sourceMemoryId:A});
    expect(parseMetaMemoryRequest({...base,portId:'port-a'})).toMatchObject({portId:'port-a'});
    expect(()=>parseMetaMemoryRequest({...base,portId:'port-a',sourceMemoryId:A})).toThrow();
  });
});

describe('editPortableKnowledge with verified members',()=>{
  test('an unverified memoryId is rejected; a verified one stores the same member shape as the portId form',()=>{
    const byMemory=parseMetaMemoryRequest(save([{memoryId:A,mode:'include'}])),byPort=parseMetaMemoryRequest(save([{portId:'port-a',expectedMemoryId:A,mode:'include'}]));
    expect(()=>editPortableKnowledge(empty(),byMemory,projects,'a'.repeat(24))).toThrow(expect.objectContaining({code:'META_MEMORY_PROJECT_UNAVAILABLE'}));
    expect(()=>editPortableKnowledge(empty(),byMemory,projects,'a'.repeat(24),new Date(),new Map([[B,'원본 B']]))).toThrow(expect.objectContaining({code:'META_MEMORY_PROJECT_UNAVAILABLE'}));
    const viaMemory=editPortableKnowledge(empty(),byMemory,[],'a'.repeat(24),new Date(),new Map([[A,'원본 A']])),viaPort=editPortableKnowledge(empty(),byPort,projects,'a'.repeat(24));
    expect(viaMemory.members).toEqual([{memoryId:A,name:'원본 A',mode:'include'}]);
    expect(viaMemory.members).toEqual(viaPort.members);
  });
  test('an explicit memoryId exclude still wins over the category; inherit restores it',()=>{
    const verified=new Map([[A,'원본 A']]);
    let g=editPortableKnowledge(empty(),parseMetaMemoryRequest(save([{memoryId:A,mode:'exclude'}],{categories:['NHCS']})),[],'a'.repeat(24),new Date(),verified);
    g={...g,entries:[{id:'b'.repeat(24),title:'배포 호환',body:'NHCS 배포 호환 규칙',state:'active',sourceMemoryId:null,updatedAt:g.updatedAt}]};
    expect(metaMemoryApplies(g,A,'NHCS')).toBe(false);expect(metaMemoryApplies(g,B,'NHCS')).toBe(true);
    expect(recallPortableKnowledge([g],A,'배포 호환','NHCS').hits).toEqual([]);
    expect(recallPortableKnowledge([g],B,'배포 호환','NHCS').hits).toHaveLength(1);
    const restored=editPortableKnowledge(g,parseMetaMemoryRequest(save([{memoryId:A,mode:'inherit'}],{memoryId:C,expectedRevision:g.revision,categories:['NHCS']})),[],'a'.repeat(24),new Date(),verified);
    expect(restored.members).toEqual([]);expect(metaMemoryApplies(restored,A,'NHCS')).toBe(true);
  });
  test('sourceMemoryId must be an explicit member and is recorded on the entry',()=>{
    const g=editPortableKnowledge(empty(),parseMetaMemoryRequest(save([{memoryId:A,mode:'include'}])),[],'a'.repeat(24),new Date(),new Map([[A,'원본 A']]));
    const entry=(sourceMemoryId:string)=>parseMetaMemoryRequest({operation:'propose-entry',memoryId:C,expectedRevision:g.revision,requestId:rid(),title:'규칙',body:'본문',sourceMemoryId});
    expect(editPortableKnowledge(g,entry(A),[],'c'.repeat(24)).entries).toEqual([expect.objectContaining({id:'c'.repeat(24),state:'candidate',sourceMemoryId:A})]);
    expect(()=>editPortableKnowledge(g,entry(B),[],'c'.repeat(24))).toThrow(expect.objectContaining({code:'META_MEMORY_PROJECT_NOT_LINKED'}));
  });
});

describe('rebudgetRecall',()=>{
  const hit=(i:number,size:number)=>({memoryId:C,memoryName:'공통',revision:1,entryId:String(i).padStart(24,'0'),title:'항목 '+i,body:'가'.repeat(size),state:'active' as const,score:100-i});
  test('caps hits, groups and bytes, marking the result truncated',()=>{
    const groups=Array.from({length:40},(_,i)=>({id:`${String(i).padStart(8,'0')}-0000-4000-8000-000000000000`,name:'그룹 '+i,revision:1}));
    const capped=rebudgetRecall({state:'ready',groups,hits:Array.from({length:12},(_,i)=>hit(i,1500)),truncated:false});
    expect(capped.groups).toHaveLength(META_COMMON_MEMORY_LIMITS.recallGroups);expect(capped.hits.length).toBeLessThanOrEqual(META_COMMON_MEMORY_LIMITS.recallHits);
    expect(new TextEncoder().encode(JSON.stringify(capped)).length).toBeLessThanOrEqual(META_COMMON_MEMORY_LIMITS.recallBytes);expect(capped.truncated).toBe(true);
    // Best-ranked hits survive; the lowest go first.
    expect(capped.hits.map(h=>h.score)).toEqual(Array.from({length:capped.hits.length},(_,i)=>100-i));
    const small:MetaMemoryRecall={state:'ready',groups:groups.slice(0,1),hits:[hit(0,10)],truncated:false};
    expect(rebudgetRecall(small)).toEqual(small);
  });
  test('stops when nothing is left to drop',()=>{
    const r=rebudgetRecall({state:'unavailable',groups:[],hits:[],truncated:false,error:'가'.repeat(20_000)});
    expect(r.groups).toEqual([]);expect(r.hits).toEqual([]);
  });
});

describe('local SQLite store',()=>{
  test('refuses the long-term-memory forms with META_MEMORY_CLOUD_REQUIRED; the portId form keeps working',async()=>{
    const local=new MetaCommonMemoryService(tempStore(),{projects:async()=>projects,prepareProject:async()=>{}});
    await expect(local.execute(save([{memoryId:A,mode:'include'}]))).rejects.toMatchObject({code:'META_MEMORY_CLOUD_REQUIRED'});
    await expect(local.execute({operation:'recall',projectMemoryId:A,query:'배포'})).rejects.toMatchObject({code:'META_MEMORY_CLOUD_REQUIRED'});
    const g=(await local.execute(save([{portId:'port-a',expectedMemoryId:A,mode:'include'}]))).memory;
    expect(g.members).toEqual([{memoryId:A,name:'원본 A',mode:'include'}]);
    await expect(local.execute({operation:'save-entry',memoryId:g.id,expectedRevision:g.revision,requestId:rid(),title:'규칙',body:'본문',sourceMemoryId:A})).rejects.toMatchObject({code:'META_MEMORY_CLOUD_REQUIRED'});
    const saved=(await local.execute({operation:'save-entry',memoryId:g.id,expectedRevision:g.revision,requestId:rid(),title:'배포 호환',body:'배포 호환 규칙',portId:'port-a'})).memory;
    expect(saved.entries[0].sourceMemoryId).toBe(A);
    expect((await local.execute({operation:'recall',portId:'port-a',query:'배포 호환'})).hits).toHaveLength(1);
  });
});

describe('cloud path (migration legacy)',()=>{
  function world(){
    const cloud=Object.assign(new CommonCloud(),{commonMemoryScope:'e'.repeat(64)});cloud.source(A,'원본 A 결정');cloud.source(B,'원본 B 결정');
    const service=createCommonMemoryService(()=>cloud),counts={projects:0,fresh:0};
    const projectsFn=async(fresh?:boolean)=>{counts.projects++;if(fresh)counts.fresh++;return projects;};
    return {cloud,counts,migration:createCommonMemoryMigration(tempStore(),service,projectsFn)};
  }
  test('a memoryId member is verified in the cloud and stored like a project member, without scanning folders',async()=>{
    const w=world();
    const created=(await w.migration.legacy(parseMetaMemoryRequest(save([{memoryId:A,mode:'include'}])))).result.memory;
    expect(created.members).toEqual([{memoryId:A,name:'원본 A',mode:'include'}]);expect(w.counts.projects).toBe(0);
    const updated=(await w.migration.legacy(parseMetaMemoryRequest(save([{memoryId:B,mode:'exclude'}],{memoryId:created.id,expectedRevision:created.revision})))).result.memory;
    expect(updated.members).toEqual([{memoryId:A,name:'원본 A',mode:'include'},{memoryId:B,name:'원본 B',mode:'exclude'}]);expect(w.counts.projects).toBe(0);
    const read=(await w.migration.legacy(parseMetaMemoryRequest({operation:'read',memoryId:created.id}))).result;
    expect(read.memberForm).toBe('memory');expect(read.memory.members).toEqual(updated.members);
    // The legacy form still resolves through the registered projects.
    const legacy=(await w.migration.legacy(parseMetaMemoryRequest(save([{portId:'port-b',expectedMemoryId:B,mode:'include'}],{memoryId:created.id,expectedRevision:updated.revision})))).result.memory;
    expect(legacy.members).toEqual([{memoryId:A,name:'원본 A',mode:'include'},{memoryId:B,name:'원본 B',mode:'include'}]);expect(w.counts.fresh).toBe(1);
  });
  test('an unknown memoryId is refused before anything is written',async()=>{
    const w=world(),before=w.cloud.tables.portmgr_common_memories!.length;
    await expect(w.migration.legacy(parseMetaMemoryRequest(save([{memoryId:crypto.randomUUID(),mode:'include'}])))).rejects.toMatchObject({code:'COMMON_MEMORY_SOURCE_INVALID'});
    expect(w.cloud.tables.portmgr_common_memories!.length).toBe(before);
  });
  test('recall by projectMemoryId uses the typed field and still needs a registered memory',async()=>{
    const w=world();
    const g=(await w.migration.legacy(parseMetaMemoryRequest(save([{memoryId:A,mode:'include'}])))).result.memory;
    await w.migration.legacy(parseMetaMemoryRequest({operation:'save-entry',memoryId:g.id,expectedRevision:g.revision,requestId:rid(),title:'배포 호환',body:'배포 호환 규칙',sourceMemoryId:A}));
    const hit=(await w.migration.legacy(parseMetaMemoryRequest({operation:'recall',projectMemoryId:A,query:'배포 호환'}))).result;
    expect(hit.hits).toEqual([expect.objectContaining({memoryId:g.id,title:'배포 호환'})]);
    await expect(w.migration.legacy(parseMetaMemoryRequest({operation:'recall',projectMemoryId:C,query:'배포 호환'}))).rejects.toMatchObject({code:'COMMON_MEMORY_PROJECT_MEMORY_REQUIRED'});
  });
});
