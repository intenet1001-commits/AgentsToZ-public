import {commonMemoryRecommendationProjects} from '../src/commonMemoryFollowup';
import {commonMemoryOperationMutates} from '../src/commonMemoryRequest';
import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {CommonCloud,A,B} from './fixtures/common-memory/cloud';
import {createCommonMemoryService} from '../common-memory-server';
import {createCommonMemoryMigration} from '../common-memory-migration-server';
import {MetaCommonMemoryStore} from '../src/metaCommonMemoryStore';
import {parseMetaMemoryRequest} from '../src/metaCommonMemoryContract';
import {parseAgentsToZUseActionRequest} from '../src/agentstozUseControl';
import {agentsToZUseMcpActionForTool} from '../agentstoz-use-mcp-server';
const roots:string[]=[];afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
const projects=[{id:'project-a',name:'등록 A',memoryId:A,category:'Games',state:'ready' as const},{id:'project-b',name:'등록 B',memoryId:B,category:'Games',state:'ready' as const}];
const fixture=async()=>{const cloud=Object.assign(new CommonCloud(),{commonMemoryScope:'a'.repeat(64)}),service=createCommonMemoryService(()=>cloud);const group=await service.action({operation:'create',groupId:crypto.randomUUID(),requestId:crypto.randomUUID(),name:'함께 쓰는 게임',goal:{objective:'공통 입력 검증'},sourceMemoryIds:[A,B]});return {cloud,service,group};};
test('curator: an existing goal group accepts a candidate once without changing its identity, sources, goal or published rules',async()=>{
 const {cloud,service,group}=await fixture(),before=structuredClone(group.state),request=parseMetaMemoryRequest({operation:'propose-entry',memoryId:group.state.id,expectedRevision:0,requestId:'persona-first-candidate',title:'공유 입력 규칙',body:'검증된 프레임 독립 입력 규칙'});
 const saved=await service.knowledge(request,projects);expect(saved.state.id).toBe(before.id);expect(saved.state.sourceMemoryIds).toEqual(before.sourceMemoryIds);expect(saved.state.goal).toEqual(before.goal);expect(saved.state.items).toEqual(before.items);expect(saved.state.publication).toEqual(before.publication);expect(saved.state.portableKnowledge!.current.members).toEqual([]);expect(saved.state.portableKnowledge!.current.entries[0]!.state).toBe('candidate');
 const replay=await service.knowledge(request,projects);expect(replay.replayed).toBe(true);expect(replay.version).toBe(saved.version);expect(cloud.tables.portmgr_common_memories).toHaveLength(1);
 await expect(service.knowledge({...request,requestId:'persona-stale-second'},projects)).rejects.toThrow();
});
test('newcomer: reading an old goal topic exposes the same editor at revision zero without creating a duplicate or writing',async()=>{
 const {cloud,service,group}=await fixture(),root=mkdtempSync(join(tmpdir(),'common-persona-'));roots.push(root);const store=new MetaCommonMemoryStore(root),bridge=createCommonMemoryMigration(store,service,async()=>projects),before=JSON.stringify(cloud.tables);
 const result=await bridge.legacy({operation:'read',memoryId:group.state.id});expect(result.handled).toBe(true);expect(result.result.memory).toMatchObject({id:group.state.id,revision:0,name:group.state.name,entries:[],members:[]});expect(JSON.stringify(cloud.tables)).toBe(before);
});
test('MCP operator: update advice and OPS draft preparation share the strict UI contract and reject project ownership/path spoofing',()=>{
 for(const [tool,args,op] of [['list_common_memory_updates',{offset:0},'updates'],['prepare_common_memory_workroom',{kind:'update',groupId:A,scopeId:'a'.repeat(64)},'prepare-workroom']] as const){
  const action=agentsToZUseMcpActionForTool('agentstoz_use_'+tool,args,'controller');const parsed=parseAgentsToZUseActionRequest(action);expect(parsed.commonMemory!.op).toBe(op);expect(parsed.portId).toBe(null);
  expect(()=>agentsToZUseMcpActionForTool('agentstoz_use_'+tool,{...args,folderPath:'/unapproved'},'controller')).toThrow();
 }
 expect(()=>parseAgentsToZUseActionRequest({action:'common-memory',controllerPortId:'controller',commonMemory:{op:'prepare-workroom',kind:'update'}})).toThrow();
 // 1.39.0: projectIds left the tool schema (the draft never used them), so the MCP server refuses it as undocumented.
 expect(()=>agentsToZUseMcpActionForTool('agentstoz_use_prepare_common_memory_workroom',{kind:'update',groupId:A,scopeId:'a'.repeat(64),projectIds:['project-a']},'controller')).toThrow();
});

test('returning user: a name-only topic rename follows the topic without promoting candidates or altering use/source membership',async()=>{
 const cloud=Object.assign(new CommonCloud(),{commonMemoryScope:'a'.repeat(64)}),service=createCommonMemoryService(()=>cloud);const created=await service.knowledge(parseMetaMemoryRequest({operation:'save',expectedRevision:0,requestId:'persona-name-only',name:'첫 주제',assignments:[{portId:'project-a',expectedMemoryId:A,mode:'include'}]}),projects);
 const renamed=await service.knowledge(parseMetaMemoryRequest({operation:'save',memoryId:created.state.id,expectedRevision:1,requestId:'persona-rename',name:'셀프트레이닝',assignments:[]}),projects);expect(renamed.state.goal.objective).toBe('셀프트레이닝');expect(renamed.state.sourceMemoryIds).toEqual([]);expect(renamed.state.portableKnowledge!.current.members).toEqual(created.state.portableKnowledge!.current.members);expect(renamed.state.publication).toBe(null);
});
test('curator: selected sources retain exact cloud names beyond the first catalog page without scanning all catalogs',async()=>{
 const {cloud,service,group}=await fixture();cloud.tables.portmgr_project_memory_labels!.push({memory_id:B,display_name:'동일 원본의 정본 이름'});const view=await service.inspect(group.state.id,0);expect(view.sourceChoices.map(s=>s.name)).toEqual(['원본 A','동일 원본의 정본 이름']);expect(view.sourceChoices.map(s=>s.memoryId)).toEqual([A,B]);
});

test('MCP analyst: use-only topics expose bounded original reads without making them publishing sources',async()=>{
 const cloud=Object.assign(new CommonCloud(),{commonMemoryScope:'a'.repeat(64)}),service=createCommonMemoryService(()=>cloud),topic=await service.knowledge(parseMetaMemoryRequest({operation:'save',expectedRevision:0,requestId:'persona-analysis-only',name:'셀프트레이닝',assignments:[{portId:'project-a',expectedMemoryId:A,mode:'include'}]}),projects),before=JSON.stringify(cloud.tables.portmgr_common_memories);
 expect((await service.inspect(topic.state.id,0)).sourceEntries).toEqual([]);const analysis=await service.inspect(topic.state.id,0,0,true);expect(analysis.sourceEntries.length).toBeGreaterThan(0);const entry=analysis.sourceEntries[0]!;expect((await service.readSource(topic.state.id,A,entry.entryId,entry.contentHash)).entry).toEqual(entry);await expect(service.readSource(topic.state.id,B,entry.entryId,entry.contentHash)).rejects.toThrow();
 expect(analysis.sourceHeads).toEqual([]);expect(topic.state.sourceMemoryIds).toEqual([]);expect(JSON.stringify(cloud.tables.portmgr_common_memories)).toBe(before);
});

test('MCP receipts and HTTP retries classify read-only preparation separately from candidate writes',()=>{
 expect(commonMemoryOperationMutates('prepare-workroom',{kind:'update'})).toBe(false);expect(commonMemoryOperationMutates('updates')).toBe(false);expect(commonMemoryOperationMutates('knowledge',{request:{operation:'read'}})).toBe(false);expect(commonMemoryOperationMutates('knowledge',{request:{operation:'propose-entry'}})).toBe(true);expect(commonMemoryOperationMutates('migration-execute')).toBe(true);
});

test('recommendation context uses exact current registered IDs/names and rejects arbitrary or duplicate projects',()=>{
 expect(commonMemoryRecommendationProjects(projects,['project-b','project-a'])).toEqual([{portId:'project-b',name:'등록 B'},{portId:'project-a',name:'등록 A'}]);expect(()=>commonMemoryRecommendationProjects(projects,['unregistered'])).toThrow();expect(()=>commonMemoryRecommendationProjects(projects,['project-a','project-a'])).toThrow();
});
