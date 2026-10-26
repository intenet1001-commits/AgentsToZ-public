// The MCP surface teaches one common-memory model: knowledge linked to long-term memories by memoryId. That rule must sit
// inside the ~2,000 characters Claude Code keeps, the goal/publication tools must say they are the legacy model, and the
// tool that links a long-term memory must show the {memoryId, mode} member form.
import {expect,test} from 'bun:test';
import {AGENTSTOZ_USE_MCP_INSTRUCTIONS as I,AGENTSTOZ_USE_MCP_TOOLS,agentsToZUseMcpActionForTool} from '../agentstoz-use-mcp-server';
import {parseAgentsToZUseActionRequest} from '../src/agentstozUseControl';

const tool=(name:string)=>AGENTSTOZ_USE_MCP_TOOLS.find(t=>t.name===`agentstoz_use_${name}`)!;
const G='44444444-4444-4444-8444-444444444444',M='11111111-1111-4111-8111-111111111111';

test('the memoryId rule is inside the first 2,000 characters and is the only model presented first',()=>{
  for(const phrase of ['Common memory = knowledge linked to long-term memories by memoryId','recall_common_memory(memoryId, query)','link with manage_common_knowledge','Goal/publication tools are legacy.']){
    const at=I.indexOf(phrase);expect(at).toBeGreaterThanOrEqual(0);expect(at+phrase.length).toBeLessThanOrEqual(2000);
  }
  expect(I).not.toContain('To recommend common memory');
  // The goal flow is still documented, but only after it is labelled legacy.
  const legacy=I.indexOf('Legacy goal model (이전 방식)');
  expect(legacy).toBeGreaterThan(0);expect(I.indexOf('agentstoz_use_recommend_common_memories')).toBeGreaterThan(legacy);
  expect(I.split('Common memory =')).toHaveLength(2);
});

test('goal/publication tools are labelled legacy and point at the current tools',()=>{
  for(const name of ['list_common_memory_updates','read_common_memory_source','common_memory_history','recommend_common_memories','manage_common_memory','record_common_memory_application','bind_project_common_memory']){
    expect(tool(name).description.startsWith('Legacy goal model (이전 방식)')).toBe(true);
    expect(tool(name).description).toContain('manage_common_knowledge');
  }
  expect(tool('manage_common_knowledge').description).toContain('The current common-memory tool');
  expect(tool('list_common_memories').description).not.toContain('goal-specific');
});

// A Korean request ('공통기억에 이거 정리해') found no tool through deferred tool search: the current tools lead with the word.
test('the current common-memory tools start with the Korean word a person uses',()=>{
  for(const name of ['manage_common_knowledge','recall_common_memory','list_common_memories'])expect(tool(name).description.startsWith('공통기억')).toBe(true);
  expect(tool('manage_common_knowledge').description).toContain('장기기억 연결');
  // The legacy tools keep their own lead, so a Korean search lands on the current ones first.
  expect(tool('manage_common_memory').description.startsWith('공통기억')).toBe(false);
});

test('recall says which id names the group and where one whole common memory is read',()=>{
  const d=tool('recall_common_memory').description;
  expect(d).toContain('groupId/groupName');expect(d).toContain('top-level memoryId is the long-term memory');
  expect(d).toContain('manage_common_knowledge {operation:"read", groupId}');expect(d).toContain('published goal groups only');
});

test('every documented request field is declared, typed, and the request object stays open for older forms',()=>{
  const request=(tool('manage_common_knowledge').inputSchema as any).properties.request;
  for(const key of ['name','description','title','body','reason','category','supersedesEntryId'])expect(request.properties[key].type).toBe('string');
  for(const key of ['tags','categories','conditions','evidence'])expect(request.properties[key].type).toBe('array');
  expect(request.properties.archived.type).toBe('boolean');expect(request.properties.offset.type).toBe('integer');
  // Evidence items are described, not required, and the legacy {portId, expectedMemoryId, mode} member is not newly refused.
  expect(request.properties.evidence.items.required).toBeUndefined();expect(request.additionalProperties).toBeUndefined();
});

test('an argument outside request:{…} is named and the wrapper is shown',()=>{
  expect(()=>agentsToZUseMcpActionForTool('agentstoz_use_manage_common_knowledge',{operation:'read',groupId:G},'ctrl')).toThrow(/not operation, groupId\).*request:\{…\}/);
  expect(()=>agentsToZUseMcpActionForTool('agentstoz_use_recall_common_memory',{groupId:G,query:'배포'},'ctrl')).toThrow(/operation:"read", groupId/);
  // The documented forms are unchanged: the goal form and the memory form still build an action.
  expect(agentsToZUseMcpActionForTool('agentstoz_use_recall_common_memory',{groupId:G,task:'배포'},'ctrl')).toMatchObject({action:'common-memory'});
  expect(agentsToZUseMcpActionForTool('agentstoz_use_recall_common_memory',{memoryId:M,query:'배포'},'ctrl')).toMatchObject({action:'common-memory'});
});

test('a malformed knowledge request names the field to fix',()=>{
  const fails=(request:Record<string,unknown>)=>{try{agentsToZUseMcpActionForTool('agentstoz_use_manage_common_knowledge',{request},'ctrl');}catch(error){return (error as Error).message;}throw Error('accepted');};
  expect(fails({operation:'save',expectedRevision:0,requestId:'r-1',name:' '})).toContain('name(필수)');
  expect(fails({operation:'propose-entry',groupId:G,expectedRevision:1,requestId:'r-2',title:'제목',body:''})).toContain('body(필수)');
  expect(fails({operation:'propose-entry',groupId:G,requestId:'r-3',title:'제목',body:'본문'})).toContain('expectedRevision');
});

test('manage_common_knowledge documents the memoryId member form and one name per id',()=>{
  const t=tool('manage_common_knowledge'),d=t.description,request=(t.inputSchema as any).properties.request;
  expect(d).toContain('assignments:[{memoryId, mode:"include"|"exclude"}]');
  expect(d).toContain('groupId is always the common memory, memoryId always a long-term memory');
  expect(d).toContain('legacy {portId, expectedMemoryId, mode}');
  expect(request.properties.assignments.items.required).toEqual(['memoryId','mode']);
  expect(request.properties.groupId.format).toBe('uuid');
});

test('the documented link request is accepted by the host parser exactly as written',()=>{
  const action:any=agentsToZUseMcpActionForTool('agentstoz_use_manage_common_knowledge',{request:{operation:'save',groupId:G,expectedRevision:2,requestId:'link-'+'1'.repeat(10),name:'배포 공통',assignments:[{memoryId:M,mode:'include'}]}},'ctrl');
  const host:any=parseAgentsToZUseActionRequest(JSON.parse(JSON.stringify(action)));
  expect(host.commonMemory.request.memoryId).toBe(G);
  expect(host.commonMemory.request.assignments).toEqual([{memoryId:M,mode:'include'}]);
  const recall:any=parseAgentsToZUseActionRequest(JSON.parse(JSON.stringify(agentsToZUseMcpActionForTool('agentstoz_use_manage_common_knowledge',{request:{operation:'recall',memoryId:M,query:'배포'}},'ctrl'))));
  expect(recall.commonMemory.request).toEqual({operation:'recall',projectMemoryId:M,query:'배포'});
});
