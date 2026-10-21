import {commonMemoryRecommendationProjects} from '../../../src/commonMemoryFollowup';
import {createCommonMemoryMigration} from '../../../common-memory-migration-server';
import {MetaCommonMemoryStore} from '../../../src/metaCommonMemoryStore';
import {parseMetaMemoryRequest,isMemberAssignment} from '../../../src/metaCommonMemoryContract';
import {commonKnowledgeSummary} from '../../../src/commonMemoryPortableKnowledge';
import {isPrivateRemoteControlIpv4} from '../../../src/remoteControlLanServer';
import {CommonCloud,A,B,C} from './cloud';
/** A long-term memory that exists only in the cloud (no project on this fixture Mac uses it). */
export const CLOUD_ONLY='44444444-4444-4444-8444-444444444444';
import {COMMON_MEMORY_HOST_CAPABILITIES} from '../../../src/commonMemoryCapabilities';
import {MetaCommonMemoryRemoteHost} from '../../../src/metaCommonMemoryRemoteHost';
/** Registered project ids differ from their long-term memory ids, as on a real Mac. */
export const PORT_IDS=['port-fixture-a','port-fixture-b','port-fixture-c'] as const;
import {createCommonMemoryService} from '../../../common-memory-server';
import {createCommonMemoryProjectManager} from '../../../common-memory-projects-server';
import {parseCommonMemoryRequest} from '../../../src/commonMemoryRequest';
import {mkdtempSync,readFileSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import tailwindConfig from '../../../tailwind.config';
export async function commonMemoryUiFixture(hostname='127.0.0.1'){
  if(hostname!=='127.0.0.1'&&!isPrivateRemoteControlIpv4(hostname))throw Error('Fixture requires loopback or a private LAN address');
  const built=await Bun.build({entrypoints:[import.meta.dir+'/panel.tsx'],target:'browser',minify:false});if(!built.success)throw Error(String(built.logs));
  const javascript=await built.outputs[0]!.text(),root=mkdtempSync(join(tmpdir(),'common-memory-screen-'));
  const portalCss=readFileSync(new URL('../../../src/remote-control-portal.css',import.meta.url),'utf8').replace("@import './appearanceTokens.css';",readFileSync(new URL('../../../src/appearanceTokens.css',import.meta.url),'utf8'));
  const css=(await postcss([tailwind(tailwindConfig as any)]).process(portalCss,{from:undefined})).css;
  const cloud=Object.assign(new CommonCloud(),{commonMemoryScope:'a'.repeat(64)}),service=createCommonMemoryService(()=>cloud);
  cloud.source(C,'### iOS 권한\n<!-- memory-entry-id:dddddddddddddddddddddddd -->\n아이폰 권한은 사용자 동의로 시작한다.\n'+Array.from({length:24},(_,i)=>`\n### iOS 추가 ${i}\n아이폰 검증 조건 ${i}`).join('\n'));
  const local:any[]=[];let clones=0,lose=false,restoreFailure=false;
  const seed=join(root,'seed');mkdirSync(seed);writeFileSync(join(seed,'README.md'),'owned fixture repository\n');
  for(const args of [['init','-q'],['add','README.md'],['-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','-qm','fixture']])if(Bun.spawnSync(['git',...args],{cwd:seed}).exitCode)throw Error('fixture git seed');
  const manager=createCommonMemoryProjectManager({appDataDir:join(root,'private'),roots:async()=>[{workspaceRootId:'root_fixture',name:'격리된 시험 작업 루트',path:root}],sources:groupId=>service.projectSources(groupId),inventory:async()=>local,lease:async<T>(_path:string,task:()=>Promise<T>)=>task(),
    async clone(url,path){clones++;if(Bun.spawnSync(['git','clone','--',seed,path]).exitCode)throw Error('clone');Bun.spawnSync(['git','remote','set-url','origin',url],{cwd:path});},
    async restore(path,member){mkdirSync(join(path,'.agent-memory'),{recursive:true});writeFileSync(join(path,'.agent-memory/config.json'),JSON.stringify({schemaVersion:1,memoryId:member.memoryId,sourcePath:'.agent-memory/CORE.md'}));const source=cloud.tables.portmgr_project_memory_revisions!.find(r=>r.id===member.revisionId);writeFileSync(join(path,'.agent-memory/CORE.md'),source.content);if(restoreFailure){restoreFailure=false;throw Error('confirmed restoration failure after owned clone');}},
    async register(_path,_name,id,memoryId,githubUrl){if(!local.some(p=>p.id===id))local.push({id,memoryId,githubUrl,available:true});},
  });
  // Per-operation request counts (knowledge counts its inner operation too), an optional delay per operation and an
  // 'old Mac' mode whose list/updates carry no scope or capabilities. Test-only routes below read and set them.
  let requests:Record<string,number>={},delays:Record<string,number>={},failures:Record<string,boolean>={},oldMac=false;
  const handle=async(op:string,body:any):Promise<any>=>{
      requests[op]=(requests[op]??0)+1;if(op==='knowledge'&&body.request?.operation){const key='knowledge:'+body.request.operation+(body.request.withProjects===false?'-lean':'');requests[key]=(requests[key]??0)+1;}
      if(delays[op])await Bun.sleep(delays[op]!);
      if(failures[op])throw Object.assign(Error('fixture failure'),{code:'FIXTURE_FAILURE',status:409});
      const knowledge=async()=>{const request=parseMetaMemoryRequest(body.request),projects=[A,B,C].map((memoryId,i)=>({id:PORT_IDS[i]!,name:['등록 A','등록 B','등록 C'][i]!,category:'NHCS',memoryId,state:'ready' as const}));
         // Exercise the host's actual read-only serializer; no fake checksum or production app data.
         if(request.operation==='export'){const result=await createCommonMemoryMigration(new MetaCommonMemoryStore(join(root,'export-store')),service,async()=>projects).legacy(request);if(!result.handled)throw Error('Fixture cloud export was not handled');return result.result;}
         if(request.operation==='projects')return {projects};if(request.operation==='list'){const memories=(await service.list()).filter(r=>r.state.knowledgeSummary).map(r=>r.state.knowledgeSummary!);return {memories,total:memories.length,nextOffset:null,storage:'cloud'};}
         if(request.operation==='read')return {...await service.readKnowledge(request.memoryId),...(request.withProjects===false&&!oldMac?{}:{projects}),storage:'cloud',...(oldMac?{}:{memberForm:'memory'})};if(request.operation==='history')return {history:await service.knowledgeHistory(request.memoryId)};
         // Like the host: named memories are verified in the cloud; an older Mac's parser rejected that form before acting.
         const members=request.operation==='save'?request.assignments.filter(isMemberAssignment).map(a=>a.memoryId):[];if(oldMac&&members.length)throw Object.assign(Error('연결 대상은 {portId, expectedMemoryId, mode} 형식으로 보내세요.'),{code:'META_MEMORY_INPUT_INVALID',status:400});
         const verified=new Map((members.length?await service.memoryTargets(members):[]).map(t=>[t.memoryId,t.name]));
         const saved=await service.knowledge(request,projects,undefined,verified);return {memory:saved.state.portableKnowledge!.current,storage:'cloud'};};
        const data=op==='topic-candidates'?await service.topicCandidates(body.after??null,body.memoryIds):op==='read-cloud-source'?await service.readCloudSource(body.memoryId,body.offset??0,body.scopeId):op==='prepare-workroom'?await service.workroomDraft(body.kind,body.groupId,commonMemoryRecommendationProjects([{id:'recent-fixture',name:'최근 사용 프로젝트'},...[A,B,C].map((_id,i)=>({id:PORT_IDS[i]!,name:['등록 A','등록 B','등록 C'][i]!}))],body.projectIds??[]),body.scopeId):op==='updates'?await(async()=>{const u=await service.updates(body.offset??0);if(oldMac)delete (u as any).scopeId;return u;})():op==='knowledge'?await knowledge():op==='project-links'?await(async()=>{const memoryId=body.memoryId??A,groups=[];for(const r of await service.list()){if(!r.state.knowledgeSummary||r.state.archived)continue;const members=(await service.readKnowledge(r.state.id)).memory.members;if(members.some((m:any)=>m.memoryId===memoryId&&m.mode==='include'))groups.push({id:r.state.id,name:r.state.name,goal:r.state.goal.objective,version:r.version,status:'기억 항목 사용 중',knowledgeRevision:r.state.knowledgeSummary!.revision});}return {memoryId,name:'공유 프로젝트 A',groups,scopeId:cloud.commonMemoryScope};})():op==='list'?{groups:await service.list(),...(oldMac?{}:{scopeId:cloud.commonMemoryScope,hostCapabilities:[...COMMON_MEMORY_HOST_CAPABILITIES]})}:op==='roots'?{roots:[{workspaceRootId:'root_fixture',name:'격리된 시험 작업 루트'}],scopeId:cloud.commonMemoryScope}
          :op==='projects-plan'?{plan:await manager.plan(body.groupId,body.workspaceRootId)}:op==='projects-add'?await manager.add(body.plan,body.requestId,body.memoryId)
          :op==='projects-status'?await manager.membersStatus(body.groupId):op==='project-add-status'?await manager.status(body.requestId)
          :op==='catalog'?await service.catalog(body.after):op==='operation-status'?await service.operationStatus(body.groupId,body.requestId,body.requestHash,body.scopeId)
          :op==='application-status'?await service.applicationStatus(body.groupId,body.applicationId,body.scopeId):op==='read-source'?await service.readSource(body.groupId,body.memoryId,body.entryId,body.contentHash,body.scopeId)
          :op==='inspect'?await service.inspect(body.groupId,body.offset,body.itemOffset,body.analysis===true):op==='manage'?await service.action(body):op==='recommend'?await service.recommend(body.projectGoal)
          :op==='history'?{revisions:await service.history(body.groupId)}:op==='report'?await service.report(body.groupId,body.application,body.scopeId):null;
      if(!data)throw Error('unsupported');return data;
  };
  const remoteHost=new MetaCommonMemoryRemoteHost(async(_owner,raw)=>{const {operation,input}=parseCommonMemoryRequest(raw);return handle(operation,input);});
  const server=Bun.serve({hostname,port:0,async fetch(req){const path=new URL(req.url).pathname;
    if(path==='/panel.js')return new Response(javascript,{headers:{'Content-Type':'application/javascript'}});
    if(path==='/panel.css')return new Response(css,{headers:{'Content-Type':'text/css'}});
    if(path==='/health')return Response.json({fixture:true});
    if(path==='/fixture/requests')return Response.json(requests);
    if(path==='/fixture/requests/reset'&&req.method==='POST'){requests={};return Response.json({ok:true});}
    if(path==='/fixture/delay'&&req.method==='POST'){const {op,ms}=await req.json();delays[op]=ms;return Response.json({ok:true});}
    if(path==='/fixture/fail'&&req.method==='POST'){const {op,on}=await req.json();failures[op]=!!on;return Response.json({ok:true});}
    if(path==='/fixture/old-mac'&&req.method==='POST'){oldMac=true;return Response.json({ok:true});}
    if(path==='/fixture/workspace'&&req.method==='POST'){try{const request=await req.json();if(request?.operation!=='workspace'||request.workspace?.action!=='common-memory')throw Error('fixture workspace');return Response.json({kind:'workspace',action:'common-memory',meta:await remoteHost.perform('fixture-phone',request.workspace.meta,()=>true,'cloud')});}catch(error){return Response.json({error:error instanceof Error?error.message:String(error)},{status:409});}}
    if(path==='/fixture/cloud-only'&&req.method==='POST'){cloud.source(CLOUD_ONLY,'### 클라우드 전용 규칙\n이 Mac에 없는 장기기억');return Response.json({ok:true,memoryId:CLOUD_ONLY});}
    if(path==='/fixture/restore-failure'&&req.method==='POST'){restoreFailure=true;return Response.json({ok:true});}
    if(path==='/fixture/loss'&&req.method==='POST'){lose=true;return Response.json({ok:true});}
    if(path==='/fixture/accumulate'&&req.method==='POST'){cloud.source(A,'### 새 물리 규칙\n교통수단 충돌 검증');cloud.source(B,'### 새 입력 규칙\n프레임과 독립적인 조작');return Response.json({ok:true});}
    if(path==='/fixture/propose'&&req.method==='POST'){const g=(await service.list()).at(-1)!;const current=await service.readKnowledge(g.state.id);await service.knowledge(parseMetaMemoryRequest({operation:'propose-entry',memoryId:g.state.id,expectedRevision:current.memory.revision,requestId:crypto.randomUUID(),title:'공유 검증 규칙',body:'연결된 프로젝트의 공통 검증 근거'}),[]);return Response.json({ok:true});}
    if(path==='/fixture/propose-source'&&req.method==='POST'){const g=(await service.list()).at(-1)!,evidence=[];for(const memoryId of [A,B]){const entry=(await service.readCloudSource(memoryId)).entries[0]!;evidence.push({memoryId,revisionId:entry.revisionId,entryId:entry.entryId,contentHash:entry.contentHash});}for(let i=0;i<2;i++){const current=await service.readKnowledge(g.state.id);await service.knowledge({operation:'propose-source-entry',memoryId:g.state.id,expectedRevision:current.memory.revision,requestId:crypto.randomUUID(),title:['공통 게임 입력 검증','공통 게임 물리 검증'][i],body:['게임 조작은 실제 입력과 프레임 조건을 함께 확인한다.','게임 물리는 충돌과 조작 조건을 함께 검사한다.'][i],reason:'두 클라우드 원본의 조작과 물리 검증을 비교한 후보',category:'게임',conditions:['각 게임의 실제 입력 조건을 확인한다.'],evidence},[]);}return Response.json({ok:true});}
    if(path==='/fixture/malformed-candidate'&&req.method==='POST'){const g=(await service.list()).at(-1)!,current=await service.readKnowledge(g.state.id);await service.knowledge({operation:'propose-entry',memoryId:g.state.id,expectedRevision:current.memory.revision,requestId:crypto.randomUUID(),title:'형식 확인이 필요한 후보',body:'보존할 원문\n\n<!-- agentstoz-topic-evidence-v1:invalid -->'},[]);return Response.json({ok:true});}
    if(path==='/fixture/stats')return Response.json({groups:cloud.tables.portmgr_common_memories,clones,registered:local.map(p=>p.memoryId),sources:cloud.tables.portmgr_project_memory_heads});
    if(path.startsWith('/api/common-memory/')){try{const op=path.split('/').at(-1)!;const {input:body}=parseCommonMemoryRequest({operation:op,input:req.method==='POST'?await req.json():{}});
      const data=await handle(op,body);
if(lose&&(op==='manage'||op==='knowledge'&&body.request?.requestId)){lose=false;return Response.json({success:false,code:'COMMON_MEMORY_CLOUD_UNAVAILABLE',error:'저장은 완료됐지만 응답이 유실된 시험입니다.'},{status:503});}
      return Response.json({success:true,...data});
    }catch(error){return Response.json({success:false,code:(error as any)?.code,error:error instanceof Error?error.message:String(error)},{status:(error as any)?.status??409});}}
    return new Response('<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/panel.css"><div id="root"></div><script type="module" src="/panel.js"></script></html>',{headers:{'Content-Type':'text/html'}});
  }});
  return {server,url:`http://${hostname}:${server.port}`,cloud,service,root,stop(){remoteHost.dispose();server.stop(true);rmSync(root,{recursive:true,force:true});}};
}
if(import.meta.main){const fixture=await commonMemoryUiFixture();console.log(JSON.stringify({fixture:true,url:fixture.url}));process.on('SIGTERM',()=>{fixture.stop();process.exit(0);});}
