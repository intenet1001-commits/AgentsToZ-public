import {commonMemoryOperationMutates} from '../src/commonMemoryRequest';
import {expect,test} from 'bun:test';
import {join} from 'node:path';
import {CommonCloud,A,B,C,gameEntry} from './fixtures/common-memory/cloud';
import {createCommonMemoryService} from '../common-memory-server';
import {parseProjectMemoryEntries} from '../src/projectMemoryRecall';
import {AGENTSTOZ_USE_MCP_TOOLS} from '../agentstoz-use-mcp-server';
import {AGENTSTOZ_USE_MCP_CONTRACT_VERSION} from '../src/agentstozUseMcpVersion';
test('actual stdio MCP maps catalog, exact source read, idempotent management and rejects an undocumented path before host dispatch',async()=>{
 const cloud=Object.assign(new CommonCloud(),{commonMemoryScope:'a'.repeat(64)}),service=createCommonMemoryService(()=>cloud);let calls=0;
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){calls++;const body=await req.json() as any,r=body.commonMemory;let data:any;
  if(r.op==='catalog')data=await service.catalog(r.after);
  else if(r.op==='manage')data=await service.action(r.request);
  else if(r.op==='read-source')data=await service.readSource(r.groupId,r.memoryId,r.entryId,r.contentHash,r.scopeId);
  else data={groups:await service.list()};
  return Response.json({success:true,performed:true,action:'common-memory',effect:r.op==='manage'?'common-memory-updated':'read-only',...data});
 }});
 const groupId=crypto.randomUUID(),input={operation:'create',groupId,requestId:crypto.randomUUID(),scopeId:cloud.commonMemoryScope,name:'아이폰 MCP 검증',goal:{objective:'아이폰 앱'},sourceMemoryIds:[A,B]};
 const source=cloud.tables.portmgr_project_memory_revisions!.find(r=>r.memory_id===B),entry=parseProjectMemoryEntries(source.content).find(e=>e.entryId===gameEntry)!;
 const tool=(id:number,name:string,args:unknown)=>({jsonrpc:'2.0',id,method:'tools/call',params:{name:'agentstoz_use_'+name,arguments:args}});
 const requests=[{jsonrpc:'2.0',id:1,method:'initialize',params:{}},{jsonrpc:'2.0',id:2,method:'tools/list'},tool(3,'list_common_memory_sources',{}),tool(4,'manage_common_memory',{request:input}),tool(5,'read_common_memory_source',{groupId,memoryId:B,entryId:entry.entryId,contentHash:entry.contentVersionHash,scopeId:cloud.commonMemoryScope}),tool(6,'manage_common_memory',{request:input}),tool(7,'add_common_memory_project',{plan:{},requestId:crypto.randomUUID(),memoryId:A,folderPath:'/unapproved'})];
 const child=Bun.spawn([process.execPath,join(import.meta.dir,'../agentstoz-use-mcp-server.ts')],{stdin:'pipe',stdout:'pipe',stderr:'pipe',env:{...process.env,APP_DATA_DIR:'',AGENTSTOZ_USE_ENDPOINT:`http://127.0.0.1:${server.port}/api/agentstoz-use/action`,AGENTSTOZ_CONTROLLER_PORT_ID:'fixture-controller'}});
 try{
  child.stdin.write(requests.map(r=>JSON.stringify(r)).join('\n')+'\n');child.stdin.end();
  const timer=setTimeout(()=>child.kill(),20_000);const [output,errors,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);clearTimeout(timer);
  expect(exit).toBe(0);expect(errors).toBe('');const replies=new Map(output.trim().split('\n').map(line=>{const r=JSON.parse(line);return [r.id,r];}));
  expect(replies.size).toBe(7);expect(replies.get(1).result.serverInfo.version.startsWith(AGENTSTOZ_USE_MCP_CONTRACT_VERSION+'+build.')).toBe(true);expect(replies.get(2).result.tools).toHaveLength(AGENTSTOZ_USE_MCP_TOOLS.length);
  expect(replies.get(2).result.tools.map((t:any)=>t.name)).toContain('agentstoz_use_select_workroom_account');
  expect(replies.get(3).result.structuredContent.sources).toHaveLength(3);expect(replies.get(4).result.isError).toBe(false);expect(replies.get(5).result.structuredContent.entry.excerpt).toBe(entry.body);expect(replies.get(6).result.structuredContent.replayed).toBe(true);expect(replies.get(7).result.isError).toBe(true);expect(calls).toBe(4);expect(cloud.tables.portmgr_common_memories).toHaveLength(1);
 }finally{child.kill();server.stop(true);}
},30_000);

test('persona MCP operator uses the same OPS draft/update/candidate workflow without source writes or self-acceptance',async()=>{
 const cloud=Object.assign(new CommonCloud(),{commonMemoryScope:'a'.repeat(64)}),service=createCommonMemoryService(()=>cloud);
 const created=await service.action({operation:'create',groupId:crypto.randomUUID(),requestId:crypto.randomUUID(),name:'공통 입력',goal:{objective:'공통 게임 입력'},sourceMemoryIds:[A,B]});
 cloud.source(A,'### 입력 검증\n공통 입력의 새 근거');cloud.source(B,'### 입력 계약\n동일 프레임 검증');const before=JSON.stringify(cloud.tables.portmgr_project_memory_revisions);
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){try{const body=await req.json() as any;const {parseAgentsToZUseActionRequest}=await import('../src/agentstozUseControl');const r=parseAgentsToZUseActionRequest(body).commonMemory!;let data:any;
  if(r.op==='updates')data=await service.updates(r.offset??0);
  else if(r.op==='inspect')data=await service.inspect(r.groupId!,0,0,r.analysis===true);
  else if(r.op==='prepare-workroom')data=await service.workroomDraft(r.kind!,r.groupId,[],r.scopeId);
  else if(r.op==='knowledge'){const {parseMetaMemoryRequest}=await import('../src/metaCommonMemoryContract');const input=parseMetaMemoryRequest(r.request);if(input.operation==='read')data=await service.readKnowledge(input.memoryId);else {const saved=await service.knowledge(input,[]);data={memory:saved.state.portableKnowledge!.current};}}
  else throw Error('unexpected op');return Response.json({success:true,performed:true,action:'common-memory',effect:commonMemoryOperationMutates(r.op,r)?'common-memory-updated':'read-only',...data});
 }catch(e){return Response.json({success:false,error:(e as Error).message},{status:409});}}});
 const call=(id:number,name:string,args:unknown)=>({jsonrpc:'2.0',id,method:'tools/call',params:{name:'agentstoz_use_'+name,arguments:args}}),groupId=created.state.id;
 const requests=[call(1,'prepare_common_memory_workroom',{kind:'update',groupId,scopeId:cloud.commonMemoryScope}),call(2,'list_common_memory_updates',{offset:0}),call(3,'manage_common_knowledge',{request:{operation:'read',memoryId:groupId}}),call(4,'manage_common_knowledge',{request:{operation:'propose-entry',memoryId:groupId,expectedRevision:0,requestId:'mcp-persona-proposal',title:'새 공유 입력',body:'두 프로젝트에 공통으로 검증된 입력 계약'}}),call(5,'manage_common_knowledge',{request:{operation:'read',memoryId:groupId}}),call(6,'manage_common_knowledge',{request:{operation:'review-entry'}}),call(7,'prepare_common_memory_workroom',{kind:'update',groupId,scopeId:'b'.repeat(64)}),call(8,'prepare_common_memory_workroom',{kind:'update',groupId,portId:'one-project'}),call(9,'inspect_common_memory',{groupId,analysis:true})];
 const child=Bun.spawn([process.execPath,join(import.meta.dir,'../agentstoz-use-mcp-server.ts')],{stdin:'pipe',stdout:'pipe',stderr:'pipe',env:{...process.env,APP_DATA_DIR:'',AGENTSTOZ_USE_ENDPOINT:`http://127.0.0.1:${server.port}/api/agentstoz-use/action`,AGENTSTOZ_CONTROLLER_PORT_ID:'fixture-controller'}});
 try{child.stdin.write(requests.map(r=>JSON.stringify(r)).join('\n')+'\n');child.stdin.end();const timer=setTimeout(()=>child.kill(),20_000);const output=await new Response(child.stdout).text(),exit=await child.exited;clearTimeout(timer);expect(exit).toBe(0);const replies=new Map(output.trim().split('\n').map(line=>{const r=JSON.parse(line);return [r.id,r];}));
  expect(replies.get(4).result.structuredContent.effect).toBe('common-memory-updated');expect(replies.get(1).result.structuredContent.effect).toBe('read-only');
  expect(replies.get(1).result.structuredContent).toMatchObject({target:'ops',requiresUserSend:true,groupId,scopeId:cloud.commonMemoryScope});expect(replies.get(1).result.structuredContent.prompt).toContain(groupId);expect(replies.get(1).result.structuredContent.prompt).toContain('propose-source-entry');
  expect(replies.get(2).result.structuredContent.updates[0].suggested).toBe(true);expect(replies.get(3).result.structuredContent.memory.revision).toBe(0);expect(replies.get(5).result.structuredContent.memory.entries[0].state).toBe('candidate');for(const id of [6,7,8])expect(replies.get(id).result.isError).toBe(true);
  expect(replies.get(9).result.structuredContent.analysis).toBe(true);expect(replies.get(9).result.structuredContent.sourceChoices).toHaveLength(2);
  expect(cloud.tables.portmgr_common_memories).toHaveLength(1);expect(JSON.stringify(cloud.tables.portmgr_project_memory_revisions)).toBe(before);expect((await service.get(groupId)).state.sourceMemoryIds).toEqual([A,B]);
 }finally{child.kill();server.stop(true);}
},30_000);

// 1.39.0: the AI surface on the real host dispatcher (common-memory-dispatch.ts mcp() + commonMemoryMcpView) and the real
// control parser behind a loopback stub, driven through the actual stdio MCP server.
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createCommonMemoryDispatch,commonMemoryMcpView} from '../common-memory-dispatch';
import {createCommonMemoryMigration} from '../common-memory-migration-server';
import {MetaCommonMemoryStore} from '../src/metaCommonMemoryStore';
import {parseAgentsToZUseActionRequest,parseAgentsToZUseCommonMemory} from '../src/agentstozUseControl';
import {CommonMemoryError} from '../src/commonMemory';
import {handleAgentsToZUseMcpRequest} from '../agentstoz-use-mcp-server';
const D='44444444-4444-4444-8444-444444444444';
function aiHost(){
 const dir=mkdtempSync(join(tmpdir(),'cm-mcp-'));
 const cloud=Object.assign(new CommonCloud(),{commonMemoryScope:'e'.repeat(64)}),service=createCommonMemoryService(()=>cloud),store=new MetaCommonMemoryStore(dir);
 cloud.source(D,Array.from({length:12},(_,i)=>`### 항목 ${i}\n<!-- memory-entry-id:${i.toString(16).padStart(24,'0')} -->\n배포 규칙 ${i}`).join('\n\n'));
 const projects=[{id:'port-a',name:'프로젝트 A',category:'',memoryId:A,state:'ready' as const},{id:'port-b',name:'NHCS 앱',category:'NHCS',memoryId:B,state:'ready' as const}];
 const categories=new Map([[A,''],[B,'NHCS']]),projectsFn=async()=>projects;
 const d=createCommonMemoryDispatch({service,store,migration:createCommonMemoryMigration(store,service,projectsFn),projects:projectsFn,memoryCategory:async id=>categories.get(id)??null,
  resolveProject:async portId=>{const p=projects.find(x=>x.id===portId);if(!p)throw new CommonMemoryError('COMMON_MEMORY_PROJECT_MEMORY_REQUIRED','unregistered');return {memoryId:p.memoryId,projectName:p.name};},
  client:()=>cloud,workspaceRoots:async()=>[],projectManager:{} as any,runInGroup:(_g,run)=>run(),bindProject:async()=>{throw Error('not used');},remoteService:assertActive=>createCommonMemoryService(()=>cloud,assertActive)});
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){try{const request=parseAgentsToZUseActionRequest(await req.json()),r=request.commonMemory!,data=await d.mcp(r,request.portId??undefined);
  return Response.json({success:true,performed:true,action:'common-memory',effect:commonMemoryOperationMutates(r.op,r)?'common-memory-updated':'read-only',...commonMemoryMcpView(r.op,data,r.offset)});}
  catch(e){const err=e as CommonMemoryError;return Response.json({success:false,performed:false,code:err.code??'FAILED',error:err.message},{status:err.status??500});}}});
 return {cloud,service,d,server,endpoint:`http://127.0.0.1:${server.port}/api/agentstoz-use/action`,dispose(){server.stop(true);rmSync(dir,{recursive:true,force:true});}};
}
const errorData=(reply:any)=>JSON.parse(reply.result.content[0].text).data;
test('1.39.0 surface: 21 common-memory tools, recall and links by long-term memory, paged list/inspect, host-side AI guard',async()=>{
 const h=aiHost();
 try{
  const knowledge=(request:Record<string,unknown>)=>h.d.dispatch('knowledge',{request});
  let shared=(await knowledge({operation:'save',requestId:crypto.randomUUID(),expectedRevision:0,name:'NHCS 공통',description:'NHCS',categories:[],assignments:[{memoryId:B,mode:'include'}]})).memory;
  shared=(await knowledge({operation:'save-entry',memoryId:shared.id,expectedRevision:shared.revision,requestId:crypto.randomUUID(),title:'배포 호환',body:'배포 호환 규칙은 양쪽 결과로 확인한다.'})).memory;
  const goal=crypto.randomUUID();await h.d.dispatch('manage',{operation:'create',groupId:goal,requestId:crypto.randomUUID(),scopeId:h.cloud.commonMemoryScope,name:'열두 항목',goal:{objective:'배포'},sourceMemoryIds:[D]});
  for(let i=0;i<10;i++)await h.d.dispatch('manage',{operation:'create',groupId:crypto.randomUUID(),requestId:crypto.randomUUID(),scopeId:h.cloud.commonMemoryScope,name:`목표 ${i}`,goal:{objective:`목표 ${i}`},sourceMemoryIds:[A]});
  const tool=(id:number,name:string,args:unknown)=>({jsonrpc:'2.0',id,method:'tools/call',params:{name:'agentstoz_use_'+name,arguments:args}});
  const requests=[{jsonrpc:'2.0',id:1,method:'tools/list'},tool(2,'recall_common_memory',{memoryId:B,query:'배포 호환'}),tool(3,'recall_common_memory',{portId:'port-b',query:'배포 호환'}),tool(4,'recall_common_memory',{memoryId:C,query:'배포'}),
   tool(5,'inspect_project_memory_links',{memoryId:B}),tool(6,'list_common_memories',{offset:10}),tool(7,'inspect_common_memory',{groupId:goal}),tool(8,'recall_common_memory',{memoryId:B,groupId:goal,query:'x'}),tool(9,'list_common_memories',{})];
  const child=Bun.spawn([process.execPath,join(import.meta.dir,'../agentstoz-use-mcp-server.ts')],{stdin:'pipe',stdout:'pipe',stderr:'pipe',env:{...process.env,APP_DATA_DIR:'',AGENTSTOZ_USE_ENDPOINT:h.endpoint,AGENTSTOZ_CONTROLLER_PORT_ID:'fixture-controller'}});
  try{
   child.stdin.write(requests.map(r=>JSON.stringify(r)).join('\n')+'\n');child.stdin.end();const timer=setTimeout(()=>child.kill(),20_000);const output=await new Response(child.stdout).text();expect(await child.exited).toBe(0);clearTimeout(timer);
   const replies=new Map(output.trim().split('\n').map(line=>{const r=JSON.parse(line);return [r.id,r];}));
   const names:string[]=replies.get(1).result.tools.map((t:any)=>t.name);
   expect(names.filter(n=>/meta_common_memor|common_memory_migration/.test(n))).toEqual([]);
   expect(names.filter(n=>/common_memor|common_knowledge|project_memory_links/.test(n))).toHaveLength(21);
   expect(replies.get(1).result.tools.find((t:any)=>t.name==='agentstoz_use_prepare_common_memory_workroom').inputSchema.properties).not.toHaveProperty('projectIds');
   for(const id of [2,3]){const r=replies.get(id).result;expect(r.isError).toBe(false);expect(r.structuredContent.mode).toBe('memory');expect(r.structuredContent.memoryId).toBe(B);expect(r.structuredContent.hits.map((x:any)=>x.memoryId)).toContain(shared.id);}
   expect(replies.get(4).result.isError).toBe(true);expect(errorData(replies.get(4)).code).toBe('COMMON_MEMORY_PROJECT_MEMORY_REQUIRED');
   expect(replies.get(5).result.structuredContent.memoryId).toBe(B);expect(replies.get(5).result.structuredContent.groups.map((g:any)=>g.id)).toContain(shared.id);
   expect(replies.get(6).result.structuredContent).toMatchObject({total:12,nextOffset:null});expect(replies.get(6).result.structuredContent.groups).toHaveLength(2);
   expect(replies.get(9).result.structuredContent).toMatchObject({total:null,nextOffset:10});expect(replies.get(9).result.structuredContent.groups).toHaveLength(10);
   expect(replies.get(7).result.structuredContent).toMatchObject({sourceEntryCount:12,nextOffset:5});expect(replies.get(7).result.structuredContent.sourceEntries).toHaveLength(5);
   expect(replies.get(8).result.isError).toBe(true);
  }finally{child.kill();}
  // list reads only the requested page: one round trip of 10+1 rows, never the whole table.
  h.cloud.resetCounts();const page=await h.service.listPage(10,10);expect(h.cloud.roundTrips).toBe(1);expect(page.groups).toHaveLength(2);expect(page.nextOffset).toBeNull();
  // The host refuses AI acceptance/direct saves even from an MCP binary that does not check (old binaries since 2026-10-04).
  const candidate=(await knowledge({operation:'propose-entry',memoryId:shared.id,expectedRevision:shared.revision,requestId:crypto.randomUUID(),title:'후보',body:'후보 본문'})).memory;
  const entryId=candidate.entries.find((e:any)=>e.state==='candidate').id;
  for(const request of [{operation:'review-entry',memoryId:shared.id,expectedRevision:candidate.revision,requestId:crypto.randomUUID(),entryId,state:'active'},{operation:'save-entry',memoryId:shared.id,expectedRevision:candidate.revision,requestId:crypto.randomUUID(),title:'직접',body:'직접 저장'}]){
   const raw=await fetch(h.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'common-memory',controllerPortId:'fixture-controller',commonMemory:{op:'knowledge',request}})});
   expect(raw.status).toBe(403);expect((await raw.json() as any).code).toBe('COMMON_MEMORY_PERMISSION_REQUIRED');
  }
  expect((await h.d.dispatch('knowledge',{request:{operation:'read',memoryId:shared.id}})).memory.entries.find((e:any)=>e.id===entryId).state).toBe('candidate');
  await expect(h.d.mcp(parseAgentsToZUseCommonMemory({op:'knowledge',request:{operation:'propose-entry',memoryId:shared.id,expectedRevision:candidate.revision,requestId:crypto.randomUUID(),title:'AI 후보',body:'AI 제안'}}))).resolves.toBeDefined();
 }finally{h.dispose();}
},30_000);

test('1.39.0 memory forms against an older AgentsToZ are reported as AGENTSTOZ_USE_HOST_OUTDATED, never as a result',async()=>{
 const oldHost=(answer:(body:any)=>Response)=>Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){return answer(await req.json());}});
 // An older host's parser only knows recall {groupId, task}: it refuses the memory form as malformed input.
 const refusing=oldHost(()=>Response.json({success:false,performed:false,code:'COMMON_MEMORY_INPUT_INVALID',error:'기억 식별자가 올바르지 않습니다.'},{status:400}));
 // A host that answers without the memory echo (it ignored memoryId) is not trusted either.
 const ignoring=oldHost(()=>Response.json({success:true,performed:true,action:'common-memory',effect:'read-only',hits:[],groups:[]}));
 try{
  const call=async(server:ReturnType<typeof oldHost>,name:string,args:unknown)=>await handleAgentsToZUseMcpRequest({id:1,method:'tools/call',params:{name:'agentstoz_use_'+name,arguments:args}},{...process.env,APP_DATA_DIR:'',AGENTSTOZ_USE_ENDPOINT:`http://127.0.0.1:${server.port}/api/agentstoz-use/action`,AGENTSTOZ_CONTROLLER_PORT_ID:'fixture-controller'}) as any;
  for(const server of [refusing,ignoring])for(const [name,args] of [['recall_common_memory',{memoryId:B,query:'배포'}],['recall_common_memory',{portId:'port-b',query:'배포'}],['inspect_project_memory_links',{memoryId:B}]] as const){
   const reply=await call(server,name,args);expect(reply.result.isError).toBe(true);expect(errorData(reply).code).toBe('AGENTSTOZ_USE_HOST_OUTDATED');
  }
  // The goal form keeps working against the same old host (its refusal stays the host's own error).
  const goal=await call(refusing,'recall_common_memory',{groupId:crypto.randomUUID(),task:'배포'});expect(goal.result.isError).toBe(true);expect(errorData(goal).code).toBe('COMMON_MEMORY_INPUT_INVALID');
 }finally{refusing.stop(true);ignoring.stop(true);}
});
