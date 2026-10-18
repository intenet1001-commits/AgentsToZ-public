// One name per id in knowledge requests: `groupId` is the common-memory group, `memoryId` a project long-term memory (as in
// recall_common_memory, project-links, assignments[].memoryId and evidence[].memoryId). The original forms, which named
// the group `memoryId` at the top level, stay valid for old phones and hosts.
import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseMetaMemoryRequest} from '../src/metaCommonMemoryContract';
import {parseCommonMemoryRequest} from '../src/commonMemoryRequest';
import {createCommonMemoryDispatch} from '../common-memory-dispatch';
import {createCommonMemoryService,clearCommonMemoryServiceCaches} from '../common-memory-server';
import {createCommonMemoryMigration} from '../common-memory-migration-server';
import {MetaCommonMemoryStore} from '../src/metaCommonMemoryStore';
import {CommonCloud,A,B} from './fixtures/common-memory/cloud';

const G='44444444-4444-4444-8444-444444444444',rid='r-'+'1'.repeat(20);
const dirs:string[]=[];afterEach(()=>{clearCommonMemoryServiceCaches();dirs.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true}));});

test('groupId names the group and yields exactly the original form',()=>{
  for(const op of ['read','history','export'])expect(parseMetaMemoryRequest({operation:op,groupId:G})).toEqual(parseMetaMemoryRequest({operation:op,memoryId:G}));
  const save={operation:'save',expectedRevision:3,requestId:rid,name:'공통',assignments:[{memoryId:A,mode:'include'}]};
  expect(parseMetaMemoryRequest({...save,groupId:G})).toEqual(parseMetaMemoryRequest({...save,memoryId:G}));
  // The same group named twice is fine; two different groups are refused, never guessed.
  expect(parseMetaMemoryRequest({...save,groupId:G,memoryId:G})).toEqual(parseMetaMemoryRequest({...save,memoryId:G}));
  expect(()=>parseMetaMemoryRequest({...save,groupId:G,memoryId:A})).toThrow('groupId');
  expect(()=>parseMetaMemoryRequest({operation:'list',query:'',groupId:G})).toThrow();
});

test('with groupId, memoryId on a proposed entry is its source long-term memory',()=>{
  const entry={operation:'propose-entry',expectedRevision:1,requestId:rid,title:'배포',body:'규칙'};
  const named=parseMetaMemoryRequest({...entry,groupId:G,memoryId:A});
  expect(named).toEqual(parseMetaMemoryRequest({...entry,memoryId:G,sourceMemoryId:A}));
  expect((named as any).memoryId).toBe(G);expect((named as any).sourceMemoryId).toBe(A);
  expect(()=>parseMetaMemoryRequest({...entry,groupId:G,memoryId:A,sourceMemoryId:B})).toThrow();
});

test('recall takes memoryId for the long-term memory, never a group',()=>{
  expect(parseMetaMemoryRequest({operation:'recall',memoryId:A.toUpperCase(),query:'배포'})).toEqual({operation:'recall',projectMemoryId:A,query:'배포'});
  expect(parseMetaMemoryRequest({operation:'recall',projectMemoryId:A,query:'배포'})).toEqual({operation:'recall',projectMemoryId:A,query:'배포'});
  expect(()=>parseMetaMemoryRequest({operation:'recall',memoryId:A,projectMemoryId:A,query:'q'})).toThrow();
  expect(()=>parseMetaMemoryRequest({operation:'recall',groupId:G,query:'q'})).toThrow();
});

test('the knowledge wrapper accepts the new names and still refuses unknown keys',()=>{
  const r=parseCommonMemoryRequest({operation:'knowledge',input:{request:{operation:'read',groupId:G}}});
  expect((r.input as any).request).toEqual({operation:'read',memoryId:G});
  expect(()=>parseCommonMemoryRequest({operation:'knowledge',input:{request:{operation:'read',groupId:G,extra:1}}})).toThrow();
});

test('end to end: create, link by memoryId, read by groupId and recall by memoryId',async()=>{
  const cloud:any=Object.assign(new CommonCloud(),{commonMemoryScope:'d'.repeat(64)});
  cloud.source(A,'### 배포\n<!-- memory-entry-id:aaaaaaaaaaaaaaaaaaaaaaaa -->\n배포 규칙');
  const projects:any[]=[{id:'port-a',name:'원본 A',category:'',memoryId:A,state:'ready'}],projectsFn=async()=>projects;
  const dir=mkdtempSync(join(tmpdir(),'cm-vocab-'));dirs.push(dir);const store=new MetaCommonMemoryStore(dir),service=createCommonMemoryService(()=>cloud);
  const d=createCommonMemoryDispatch({service,store,migration:createCommonMemoryMigration(store,service,projectsFn),projects:projectsFn,memoryCategory:async()=>'',resolveProject:async()=>({memoryId:A,projectName:'원본 A'}),
    client:()=>cloud,workspaceRoots:async()=>[],projectManager:{membersStatus:async()=>({ok:true})} as any,runInGroup:(_g:any,run:any)=>run(),bindProject:async()=>{throw Error('x');},remoteService:(a:any)=>createCommonMemoryService(()=>cloud,a)} as any);
  const created=await d.dispatch('knowledge',{request:{operation:'save',requestId:crypto.randomUUID(),expectedRevision:0,name:'배포 공통',assignments:[{memoryId:A,mode:'include'}]}}) as any;
  const groupId=created.memory.id;
  const withEntry=await d.dispatch('knowledge',{request:{operation:'save-entry',groupId,expectedRevision:created.memory.revision,requestId:crypto.randomUUID(),title:'배포 규칙',body:'배포 전에 호환을 확인한다'}}) as any;
  expect(withEntry.memory.entries.map((e:any)=>e.title)).toEqual(['배포 규칙']);
  const read=await d.dispatch('knowledge',{request:{operation:'read',groupId}}) as any;
  expect(read.memory.id).toBe(groupId);expect(read.memory.members.map((m:any)=>m.memoryId)).toEqual([A]);
  const recalled=await d.dispatch('knowledge',{request:{operation:'recall',memoryId:A,query:'배포 호환'}}) as any;
  expect(JSON.stringify(recalled)).toContain('배포 전에 호환을 확인한다');
});
