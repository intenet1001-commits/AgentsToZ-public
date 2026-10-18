// T5: the host's cloud common-memory dispatcher (common-memory-dispatch.ts), run for real on the shared fake cloud and a
// real local SQLite store. Phone requests go through the real MetaCommonMemoryRemoteHost, mobile gateway and the v1
// requester an old phone uses.
import {afterEach,describe,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createCommonMemoryDispatch,lazyProjects} from '../common-memory-dispatch';
import {createCommonMemoryService,clearCommonMemoryServiceCaches} from '../common-memory-server';
import {createCommonMemoryMigration} from '../common-memory-migration-server';
import {COMMON_MEMORY_HOST_CAPABILITIES} from '../src/commonMemoryCapabilities';
import {parseCommonMemoryRequest} from '../src/commonMemoryRequest';
import {MetaCommonMemoryStore} from '../src/metaCommonMemoryStore';
import {MetaCommonMemoryService} from '../src/metaCommonMemoryService';
import {MetaCommonMemoryRemoteHost} from '../src/metaCommonMemoryRemoteHost';
import {createMetaMemoryRemoteRequester} from '../src/metaCommonMemoryRemoteClient';
import {createMobileWorkspaceGateway} from '../src/mobileWorkspaceGateway';
import {normalizeMobileWorkspaceRequest} from '../src/mobileWorkspaceProtocol';
import {type MetaMemoryProject} from '../src/metaCommonMemoryContract';
import {CommonCloud,A,B,C} from './fixtures/common-memory/cloud';
import {portalLocalCommonVisible} from '../src/commonMemoryEntrypoints';
import {COMMON_MEMORY_REMOTE_FEATURE} from '../src/commonMemoryRequest';

const SCOPE='d'.repeat(64),D='44444444-4444-4444-8444-444444444444';
const dirs:string[]=[],hosts:MetaCommonMemoryRemoteHost[]=[];
afterEach(()=>{clearCommonMemoryServiceCaches();for(const h of hosts.splice(0))h.dispose();dirs.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true}));});
const tempStore=()=>{const dir=mkdtempSync(join(tmpdir(),'cm-dispatch-'));dirs.push(dir);return new MetaCommonMemoryStore(dir);};
const hex=(i:number)=>i.toString(16).padStart(24,'0');

function world(){
  const cloud=Object.assign(new CommonCloud(),{commonMemoryScope:SCOPE});
  // D: one long-term memory with 12 entries, so source paging has more than one page.
  cloud.source(D,Array.from({length:12},(_,i)=>`### 항목 ${i}\n<!-- memory-entry-id:${hex(i+1)} -->\n배포 규칙 ${i}`).join('\n\n'));
  const projects:MetaMemoryProject[]=[{id:'port-a',name:'프로젝트 A',category:'',memoryId:A,state:'ready'},{id:'port-b',name:'프로젝트 B',category:'NHCS',memoryId:B,state:'ready'}];
  const calls={projects:0,fresh:0,recall:[] as unknown[][]};
  const projectsFn=async(fresh?:boolean)=>{calls.projects++;if(fresh)calls.fresh++;return projects;};
  const store=tempStore(),service=createCommonMemoryService(()=>cloud);
  const categories=new Map<string,string>([[A,''],[B,'NHCS']]);
  const d=createCommonMemoryDispatch({
    service,store,migration:createCommonMemoryMigration(store,service,projectsFn),projects:projectsFn,
    memoryCategory:async id=>categories.get(id)??null,resolveProject:async portId=>{const p=projects.find(x=>x.id===portId);if(!p)throw Error('unregistered');return {memoryId:p.memoryId,projectName:p.name};},
    client:()=>cloud,workspaceRoots:async()=>[],projectManager:{} as any,runInGroup:(_g,run)=>run(),bindProject:async()=>{throw Error('not used');},
    remoteService:assertActive=>createCommonMemoryService(()=>cloud,assertActive),
  });
  const knowledge=(request:Record<string,unknown>,owner='local')=>owner==='local'?d.dispatch('knowledge',{request}):d.remote(owner,{operation:'knowledge',input:{request}},()=>true);
  const group=async(name:string,members:Array<[string,'include'|'exclude']>,entries=1)=>{
    let memory=(await knowledge({operation:'save',requestId:crypto.randomUUID(),expectedRevision:0,name,description:name,categories:[],assignments:members.map(([memoryId,mode])=>({memoryId,mode}))})).memory;
    for(let i=0;i<entries;i++)memory=(await knowledge({operation:'save-entry',memoryId:memory.id,expectedRevision:memory.revision,requestId:crypto.randomUUID(),title:`${name} 배포 ${i}`,body:`배포 호환 규칙 ${name} ${i}`})).memory;
    return memory;
  };
  const goalGroup=async(name:string,sourceMemoryIds:string[])=>{const groupId=crypto.randomUUID();await d.dispatch('manage',{operation:'create',groupId,requestId:crypto.randomUUID(),scopeId:SCOPE,name,goal:{objective:name},sourceMemoryIds});return groupId;};
  return {cloud,store,service,d,calls,projects,knowledge,group,goalGroup};
}
/** An old phone: the real host, mobile gateway and v1 requester; the host callback is the production cloud branch. */
function phone(d:ReturnType<typeof world>['d']){
  const host=new MetaCommonMemoryRemoteHost(async(owner,raw,active,kind,canAdd)=>{expect(kind).toBe('cloud');return d.remote(owner,raw,active,canAdd);});hosts.push(host);
  const gateway=createMobileWorkspaceGateway({terminal:async()=>{throw Error('terminal');},active:()=>true,resolve:async()=>[],consent:async()=>({targetIds:new Set<string>(),workspaceScopes:['common-memory.manage'],projectRoots:[],isActive:()=>true,requestOwner:'stable-phone',executionAllowed:()=>false}),perform:async()=>{throw Error('project');},commonMemory:(r,o,a,c)=>host.perform(o,r,a,'cloud',c)});
  return createMetaMemoryRemoteRequester(async r=>{normalizeMobileWorkspaceRequest(r);return await gateway(r,[],'phone') as any;},'common-memory');
}

describe('list',()=>{
  test('carries hostCapabilities and scopeId; legacyPending reads fences once and omits fenced copies; phones get no legacyPending',async()=>{
    const w=world();await w.goalGroup('목표',[A]);
    const local=new MetaCommonMemoryService(w.store,{projects:async()=>w.projects,prepareProject:async()=>{throw Error('no');}});
    const save=async(name:string)=>(await local.execute({operation:'save',requestId:crypto.randomUUID(),expectedRevision:0,name,description:name,categories:[],assignments:[]} as any)).memory;
    const kept=await save('남은 로컬'),moved=await save('이관됨');
    const snapshot=w.store.read(moved.id);w.store.prepareHandoff({groupId:moved.id,scopeId:SCOPE,requestId:crypto.randomUUID(),requestHash:'b'.repeat(64),sourceFingerprint:createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')},snapshot.revision,'{}');
    let handoffs=0;const original=w.store.handoff.bind(w.store);w.store.handoff=id=>{handoffs++;return original(id);};
    const r=await w.d.dispatch('list');
    expect(r.hostCapabilities).toEqual([...COMMON_MEMORY_HOST_CAPABILITIES]);expect(r.scopeId).toBe(SCOPE);expect(r.groups).toHaveLength(1);
    expect(r.legacyPending.map((m:any)=>m.id)).toEqual([kept.id]);expect(handoffs).toBe(0);
    const remote=await w.d.remote('phone',{operation:'list',input:{}},()=>true);
    expect(remote.hostCapabilities).toEqual([...COMMON_MEMORY_HOST_CAPABILITIES]);expect(remote.scopeId).toBe(SCOPE);expect('legacyPending' in remote).toBe(false);
    // Only the count: the one unfenced local copy the cloud does not hold keeps the phone's '이 Mac의 기억' tab.
    expect(remote.localPending).toBe(1);expect('localPending' in r).toBe(false);
  });
  test('a phone list reports localPending 0 when every local copy is fenced or the cloud holds its id',async()=>{
    const w=world();expect((await w.d.remote('phone',{operation:'list',input:{}},()=>true)).localPending).toBe(0);
    // A local copy migrated on another Mac (its id is already a cloud group) is opened from the cloud, so it is not pending.
    const local=new MetaCommonMemoryService(w.store,{projects:async()=>w.projects,prepareProject:async()=>{throw Error('no');}});
    const copy=(await local.execute({operation:'save',requestId:crypto.randomUUID(),expectedRevision:0,name:'다른 Mac에서 이관',description:'x',categories:[],assignments:[]} as any)).memory;
    expect((await w.d.remote('phone',{operation:'list',input:{}},()=>true)).localPending).toBe(1);
    await w.d.dispatch('manage',{operation:'create',groupId:copy.id,requestId:crypto.randomUUID(),scopeId:SCOPE,name:'다른 Mac에서 이관',goal:{objective:'x'},sourceMemoryIds:[A]});
    expect((await w.d.remote('phone',{operation:'list',input:{}},()=>true)).localPending).toBe(0);
  });
});

describe('the phone\'s local-common gate',()=>{
  test('an unmigrated cloud fails the phone list (the tab stays); a migrated one reports the count that decides it',async()=>{
    const w=world();
    w.cloud.error={code:'PGRST205',message:'missing table'} as any;clearCommonMemoryServiceCaches();
    const failed=await w.d.remote('phone',{operation:'list',input:{}},()=>true).then(()=>null,(e:any)=>e);
    expect(failed?.code).toBe('COMMON_MEMORY_MIGRATION_REQUIRED');
    expect(portalLocalCommonVisible([COMMON_MEMORY_REMOTE_FEATURE],{ok:false,localPending:null})).toBe(true);
    w.cloud.error=null as any;clearCommonMemoryServiceCaches();
    const local=new MetaCommonMemoryService(w.store,{projects:async()=>w.projects,prepareProject:async()=>{throw Error('no');}});
    await local.execute({operation:'save',requestId:crypto.randomUUID(),expectedRevision:0,name:'이관 전',description:'x',categories:[],assignments:[]} as any);
    const listed=await w.d.remote('phone',{operation:'list',input:{}},()=>true);
    expect(portalLocalCommonVisible([COMMON_MEMORY_REMOTE_FEATURE],{ok:true,localPending:listed.localPending})).toBe(true);
  });
});

describe('inspect',()=>{
  test('a phone gets at most 5 source entries per page and an old-phone paging loop still reaches all of them',async()=>{
    const w=world(),groupId=await w.goalGroup('열두 항목',[D]),rpc=phone(w.d);
    const seen:string[]=[];let offset:number|null=0,pages=0;
    while(offset!==null){const page=await rpc({operation:'inspect',input:{groupId,offset}}) as any;expect(page.sourceEntries.length).toBeLessThanOrEqual(5);seen.push(...page.sourceEntries.map((e:any)=>e.entryId));offset=page.nextOffset;pages++;}
    expect(new Set(seen).size).toBe(12);expect(pages).toBe(3);
    // The Mac itself keeps 20 per page.
    const local=await w.d.dispatch('inspect',{groupId,offset:0});expect(local.sourceEntries).toHaveLength(12);expect(local.nextOffset).toBeNull();
  });
});

describe('knowledge enumeration',()=>{
  test('list, history, export and entry edits never enumerate registered projects; read and project-card saves do',async()=>{
    const w=world(),g=await w.group('공유 배포',[[A,'include']]);
    expect(w.calls.projects).toBe(0);
    for(const owner of ['local','phone']){
      await w.knowledge({operation:'list',query:'',offset:0},owner);
      await w.knowledge({operation:'history',memoryId:g.id},owner);
      await w.knowledge({operation:'export',memoryId:g.id},owner);
    }
    expect(w.calls.projects).toBe(0);
    const read=await w.knowledge({operation:'read',memoryId:g.id},'phone');
    expect(w.calls.projects).toBe(1);expect(w.calls.fresh).toBe(0);
    // Project references leave the Mac only as device-bound references.
    expect(read.projects.map((p:any)=>p.id)).not.toContain('port-a');expect(read.appliedProjectIds).toHaveLength(1);
    await w.knowledge({operation:'save',memoryId:g.id,expectedRevision:read.memory.revision,requestId:crypto.randomUUID(),name:g.name,description:g.description,categories:[],assignments:[{portId:'port-b',expectedMemoryId:B,mode:'include'}]});
    expect(w.calls.fresh).toBe(1);
  });
  test('lazyProjects scans once per freshness and defaults to the operation class',async()=>{
    const asked:boolean[]=[];const load=async(fresh:boolean)=>{asked.push(fresh);return [];};
    const read=lazyProjects(load,'read');await read();await read();await read(false);await read(true);
    expect(asked).toEqual([false,true]);
    const save=lazyProjects(load,'save');await save();expect(asked).toEqual([false,true,true]);
  });
});

describe('recall by long-term memory',()=>{
  test('{memoryId, query} recalls for a memory registered here and echoes mode and memoryId',async()=>{
    const w=world();await w.group('공유 배포',[[B,'include']]);await w.group('다른 묶음',[[C,'include']]);
    const r=await w.d.dispatch('recall',{memoryId:B,query:'배포 호환'});
    expect(r.mode).toBe('memory');expect(r.memoryId).toBe(B);expect(r.groups.map((g:any)=>g.name)).toEqual(['공유 배포']);expect(r.hits.length).toBeGreaterThan(0);
    expect(w.calls.projects).toBe(0);
    // A phone gets the same answer; the guard is the same.
    expect((await w.d.remote('phone',{operation:'recall',input:{memoryId:B,query:'배포 호환'}},()=>true)).groups).toHaveLength(1);
  });
  test('a memoryId registered nowhere on this Mac grants nothing',async()=>{
    const w=world();await w.group('다른 묶음',[[C,'include']]);
    await expect(w.d.dispatch('recall',{memoryId:C,query:'배포'})).rejects.toMatchObject({code:'COMMON_MEMORY_PROJECT_MEMORY_REQUIRED'});
  });
  test('the two recall forms are mutually exclusive; the goal form still reaches the group recall',async()=>{
    const bad=[{memoryId:A,query:'q',groupId:crypto.randomUUID()},{memoryId:A,query:'q',task:'t'},{memoryId:A},{query:'q'},{memoryId:'not-a-uuid',query:'q'},{memoryId:A,query:'   '},{memoryId:A,query:'q',revisionId:crypto.randomUUID()}];
    for(const input of bad)expect(()=>parseCommonMemoryRequest({operation:'recall',input})).toThrow();
    expect(parseCommonMemoryRequest({operation:'recall',input:{memoryId:A.toUpperCase(),query:' 배포 '}}).input).toEqual({memoryId:A,query:'배포'});
    const w=world(),seen:unknown[][]=[];const service={...w.service,recall:async(...args:unknown[])=>{seen.push(args);return {recalled:true};}} as unknown as typeof w.service;
    const groupId=crypto.randomUUID();
    expect(await w.d.dispatch('recall',{groupId,task:'배포'},service)).toEqual({recalled:true});expect(seen).toEqual([[groupId,'배포',undefined,undefined]]);
  });
});

describe('project-links',()=>{
  test('by memoryId: knowledge membership and binding selections in a few parallel reads, no per-group read',async()=>{
    const w=world(),member=await w.group('멤버 묶음',[[A,'include']]),excluded=await w.group('제외 묶음',[[A,'exclude']]),selected=await w.goalGroup('선택된 목표',[B]);await w.goalGroup('무관 목표',[C]);
    const archived=await w.group('보관 묶음',[[A,'include']]);await w.knowledge({operation:'archive',memoryId:archived.id,expectedRevision:archived.revision,requestId:crypto.randomUUID(),archived:true});
    w.cloud.tables.portmgr_common_memory_bindings!.push({project_memory_id:A,version:1,project_goal:'배포',selections:[{groupId:selected}]});
    w.cloud.tables.portmgr_project_memory_labels!.push({memory_id:A,display_name:'공유 이름 A'});
    clearCommonMemoryServiceCaches();w.cloud.resetCounts();
    const r=await w.d.dispatch('project-links',{memoryId:A});
    expect(r.memoryId).toBe(A);expect(r.name).toBe('공유 이름 A');expect(r.scopeId).toBe(SCOPE);
    expect(new Set(r.groups.map((g:any)=>g.id))).toEqual(new Set([member.id,selected]));expect(r.groups.map((g:any)=>g.id)).not.toContain(excluded.id);
    expect(r.groups.find((g:any)=>g.id===member.id).knowledgeRevision).toBe(member.revision);
    expect(w.cloud.calls.filter(c=>c.select==='group_id,version,state')).toHaveLength(0);expect(w.cloud.waves).toBeLessThanOrEqual(2);
    // The portId form resolves the registered project and answers the same.
    expect((await w.d.dispatch('project-links',{portId:'port-a'})).groups).toHaveLength(2);
    expect(()=>parseCommonMemoryRequest({operation:'project-links',input:{portId:'port-a',memoryId:A}})).toThrow();
    // A phone may ask by memoryId (one lookup instead of reading every group); a project card stays on the Mac.
    expect((await w.d.remote('phone',{operation:'project-links',input:{memoryId:A}},()=>true)).groups).toHaveLength(2);
    await expect(w.d.remote('phone',{operation:'project-links',input:{portId:'port-a'}},()=>true)).rejects.toMatchObject({code:'COMMON_MEMORY_PERMISSION_REQUIRED'});
  });
});

describe('project-names',()=>{
  test('reuses the cached catalog walk: no Supabase call within 30 s of a walk',async()=>{
    const w=world();
    const first=await w.d.dispatch('project-names');
    expect(first.projects).toEqual([{projectId:'port-a',name:'원본 A',memoryId:A},{projectId:'port-b',name:'원본 B',memoryId:B}]);
    w.cloud.resetCounts();
    expect(await w.d.dispatch('project-names')).toEqual(first);expect(w.cloud.roundTrips).toBe(0);
    await expect(w.d.remote('phone',{operation:'project-names',input:{}},()=>true)).rejects.toMatchObject({code:'COMMON_MEMORY_PERMISSION_REQUIRED'});
  });
});
