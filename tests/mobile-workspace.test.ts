import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initialWorkspaceTab} from '../src/workspaceNavigation';
import {normalizeMobileWorkspaceRequest,normalizeMobileWorkspaceResult,workspaceScope} from '../src/mobileWorkspaceProtocol';
import {createMobileWorkspaceGateway} from '../src/mobileWorkspaceGateway';
import {MobileWorkspaceJobs} from '../src/mobileWorkspaceJobs';
const request={operation:'workspace' as const,requestId:'request_1234',targetId:'control_1234',workspace:{action:'said.list' as const}};
test('legacy links select internal screens without carrying credentials',()=>{
 for(const [search,tab] of [['?tab=ports','projects'],['?tab=memories','records'],['?tab=said','records'],['?tab=bookmarks','bookmarks'],['','home']] as const)expect(initialWorkspaceTab(search!)).toBe(tab);
});
test('workspace input denies paths, extra fields and unsigned duty enable',()=>{
 expect(normalizeMobileWorkspaceRequest(request)).toEqual(request);
 for(const extra of [{folderPath:'/tmp'}, {sessionToken:'secret'}])expect(()=>normalizeMobileWorkspaceRequest({...request,...extra})).toThrow();
 expect(()=>normalizeMobileWorkspaceRequest({...request,workspace:{action:'duty.enable',connectionId:'connect_1234',revision:1,knowledgeRevision:2}})).toThrow();
 expect(()=>normalizeMobileWorkspaceRequest({...request,workspace:{action:'said.list',beforeSeq:'1e3'}})).toThrow();
 expect(()=>normalizeMobileWorkspaceResult({kind:'workspace',action:'said.list',records:[],serviceRole:'secret'})).toThrow();
 expect(workspaceScope('said.list')).toBe('records.read');expect(workspaceScope('memory.save')).toBe('memory.save');
});
test('terminal consent alone never opens records, and scope cannot open another target',async()=>{
 let calls=0,scopes:string[]=[],permitted=true,live=true;
 const gateway=createMobileWorkspaceGateway({terminal:async()=>({sessions:[]}),active:()=>live,resolve:async()=>[{controlId:'control_1234',runtimeTargetId:'runtime_1234'}],consent:async()=>({targetIds:new Set(permitted?['runtime_1234']:[]),workspaceScopes:scopes as ['records.read'],isActive:()=>live,requestOwner:'device_1234'}),perform:async()=>{calls++;return {kind:'workspace',action:'said.list',records:[]}}});
 await expect(gateway(request,[],'owner')).rejects.toThrow();expect(calls).toBe(0);
 scopes=['records.read'];permitted=false;await expect(gateway(request,[],'owner')).rejects.toThrow();expect(calls).toBe(0);
 permitted=true;await gateway(request,[],'owner');expect(calls).toBe(1);
 live=false;await expect(gateway(request,[],'owner')).rejects.toThrow();expect(calls).toBe(1);
});
test('missing mobile voice scope reports the exact Mac permission without exposing provider settings',async()=>{
 const gateway=createMobileWorkspaceGateway({terminal:async()=>({}),active:()=>true,resolve:async()=>[{controlId:'control_1234',runtimeTargetId:'runtime_1234'}],consent:async()=>({targetIds:new Set(['runtime_1234']),workspaceScopes:['records.read'],isActive:()=>true,requestOwner:'device_1234'}),perform:async()=>({kind:'workspace',action:'voice',voice:{configured:true}})});
 await expect(gateway({...request,workspace:{action:'voice',voice:{action:'capabilities',requestId:request.requestId}}},[],'owner')).rejects.toThrow("‘음성 입력·실시간 대화’ 권한");
});
test('forwards only the device-approved project set for OPS orchestration',async()=>{
 const approved=new Set(['runtime_1234','runtime_5678']);let received:ReadonlySet<string>|undefined;
 const voice={...request,workspace:{action:'voice' as const,voice:{action:'prepare' as const,requestId:request.requestId,target:{kind:'ops' as const},mode:'conversation' as const,consent:true}}};
 const gateway=createMobileWorkspaceGateway({terminal:async()=>({sessions:[]}),active:()=>true,resolve:async()=>[{controlId:'control_1234',runtimeTargetId:'runtime_1234'}],consent:async()=>({targetIds:approved,workspaceScopes:['voice.use'],isActive:()=>true,requestOwner:'device_1234'}),perform:async(_request,_target,_owner,_active,_tester,authorizedTargetIds)=>{received=authorizedTargetIds;return {kind:'workspace',action:'voice',voice:{configured:true}};}});
 await gateway(voice,[],'owner');
 expect(received).toBe(approved);
 expect([...received!]).toEqual(['runtime_1234','runtime_5678']);
});
test('realtime voice media has a separate bounded budget from ordinary workspace reads',async()=>{
 const approved=new Set(['runtime_1234']);let calls=0;
 const gateway=createMobileWorkspaceGateway({terminal:async()=>({sessions:[]}),active:()=>true,resolve:async()=>[{controlId:'control_1234',runtimeTargetId:'runtime_1234'}],consent:async()=>({targetIds:approved,workspaceScopes:['voice.use'],isActive:()=>true,requestOwner:'device_1234'}),perform:async request=>{calls++;return {kind:'workspace',action:'voice',voice:{media:[],session:{id:'voice_fixture',state:'active',mode:'conversation',provider:'gemini',label:'fixture',draft:null,notice:'active',expiresAt:Date.now()+60000}}};}});
 for(let i=0;i<61;i++){const requestId='request_media_'+String(i).padStart(8,'0');await gateway({operation:'workspace',requestId,targetId:'control_1234',workspace:{action:'voice',voice:{action:'media.read',requestId,sessionId:'voice_fixture'}}},[],'owner_fixture');}
 expect(calls).toBe(61);
});
test('revocation while reading withholds the response',async()=>{
 let live=true;
 const gateway=createMobileWorkspaceGateway({terminal:async()=>({sessions:[]}),active:()=>true,resolve:async()=>[{controlId:'control_1234',runtimeTargetId:'runtime_1234'}],consent:async()=>({targetIds:new Set(['runtime_1234']),workspaceScopes:['records.read'],isActive:()=>live,requestOwner:'owner'}),perform:async()=>{live=false;return {kind:'workspace',action:'said.list',records:[]}}});
 await expect(gateway(request,[],'owner')).rejects.toThrow('권한이 변경');
});
test('save admission survives retry and restart without a second AI run',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mobile-workspace-'));let calls=0;let finish!:(v:any)=>void;
 try{
 const store=new MobileWorkspaceJobs(dir);const run=()=>{calls++;return new Promise<any>(r=>{finish=r})};
 expect((await store.start('owner','target','request_1234',run)).state).toBe('saving');
 expect((await store.start('owner','target','request_1234',run)).state).toBe('saving');expect(calls).toBe(1);
 expect(new MobileWorkspaceJobs(dir).status('owner','target').state).toBe('recovery-required');
 await expect(store.start('owner','different','request_1234',run)).rejects.toThrow();
 finish({state:'saved',localSaved:true,backupSaved:false,message:'로컬 저장 완료 · 백업 대기'});
 for(let i=0;i<20&&store.status('owner','target').state!=='saved';i++)await new Promise(r=>setTimeout(r,5));
 expect(store.status('owner','target').localSaved).toBe(true);
 await new MobileWorkspaceJobs(dir).start('owner','target','request_1234',run);expect(calls).toBe(1);
 expect(store.status('different','target').state).toBe('idle');
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('an admitted save finishes after the phone disconnects and is read after reconnect',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mobile-disconnect-'));let connected=true,calls=0;let finish!:()=>void;
 try{
 const jobs=new MobileWorkspaceJobs(dir);
 const gateway=createMobileWorkspaceGateway({terminal:async()=>({sessions:[]}),active:()=>connected,resolve:async()=>[{controlId:'control_1234',runtimeTargetId:'runtime_1234'}],consent:async()=>({targetIds:new Set(['runtime_1234']),workspaceScopes:['memory.save'],isActive:()=>connected,requestOwner:'device'}),perform:async r=>({kind:'workspace',action:r.workspace.action,memory:await jobs.start('device','runtime_1234',r.requestId,async()=>{calls++;await new Promise<void>(resolve=>{finish=resolve});return {state:'saved',localSaved:true,backupSaved:false,message:'로컬 저장 완료'};})})});
 const save={...request,workspace:{action:'memory.save' as const}};
 await gateway(save,[],'owner');connected=false;finish();
 for(let i=0;i<20&&jobs.status('device','runtime_1234').state!=='saved';i++)await new Promise(r=>setTimeout(r,5));
 expect(jobs.status('device','runtime_1234').localSaved).toBe(true);
 connected=true;await gateway(save,[],'new-socket');expect(calls).toBe(1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('workroom receipts bind owner, exact request, target and input revision across restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'workroom-receipt-'));const jobs=new MobileWorkspaceJobs(dir);
 try{
  await jobs.start('device:workroom:session','target','request-1234',async()=>({state:'saved',localSaved:true,backupSaved:false,message:'backup pending'}),7);
  for(let i=0;i<30&&!jobs.receipt('device:workroom:session','target','request-1234')?.completedAt;i++)await Bun.sleep(5);
  const restored=new MobileWorkspaceJobs(dir),receipt=restored.receipt('device:workroom:session','target','request-1234');
  expect(receipt?.result.localSaved).toBe(true);expect(receipt?.binding).toBe(7);expect(receipt?.completedAt).toBeGreaterThan(0);
  expect(restored.receipt('device:workroom:other','target','request-1234')).toBeNull();expect(restored.receipt('device:workroom:session','other','request-1234')).toBeNull();expect(restored.receipt('device:workroom:session','target','other-request')).toBeNull();
 }finally{rmSync(dir,{recursive:true,force:true})}
});
// A save rewrites project files and its own AI run fires the activity hook. Close evidence taken
// before the save therefore never matched afterwards, and every successful save refused
// "저장하고 종료" (2026-09-26, three saves in a row on the OPS project).
test('close evidence is the post-save state, and a failed save records none',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mobile-evidence-'));
 try{
  const jobs=new MobileWorkspaceJobs(dir);const pre='a'.repeat(64),post='b'.repeat(64);let state=pre;
  const saved=()=>{state=post;return Promise.resolve({state:'saved',localSaved:true,backupSaved:true,message:'로컬 저장과 백업 완료'})};
  await jobs.start('owner','target','request_ok_1',saved,11,()=>state);
  for(let i=0;i<40&&!jobs.receipt('owner','target','request_ok_1')?.completedAt;i++)await new Promise(r=>setTimeout(r,5));
  const receipt=jobs.receipt('owner','target','request_ok_1')!;
  expect(receipt.evidence).toBe(post);expect(receipt.binding).toBe(11);
  const failed=()=>Promise.resolve({state:'recovery-required',localSaved:false,backupSaved:false,message:'저장되지 않았습니다.'});
  await jobs.start('owner','target2','request_fail_1',failed,3,()=>post);
  for(let i=0;i<40&&!jobs.receipt('owner','target2','request_fail_1')?.completedAt;i++)await new Promise(r=>setTimeout(r,5));
  expect(jobs.receipt('owner','target2','request_fail_1')!.evidence).toBeNull();
  await jobs.start('owner','target3','request_str_1',saved,1,pre);
  expect(jobs.receipt('owner','target3','request_str_1')!.evidence).toBe(pre);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('community actions carry only a cursor, a message and a device reference',()=>{
 const base={operation:'workspace' as const,requestId:'req_'+'1'.repeat(12),targetId:'ops-project-1234'};
 for(const workspace of [{action:'community.status'},{action:'community.read',afterSeq:0},{action:'community.send',text:'3호 상태 알려줘'},
   {action:'community.projects',deviceRef:'ab12ef3456789012',page:0}] as const)
   expect(normalizeMobileWorkspaceRequest({...base,workspace}).workspace.action).toBe(workspace.action);
 // 커서는 필수(읽기), 참조는 모양을 본다, 빈 글은 보내지 않는다.
 expect(()=>normalizeMobileWorkspaceRequest({...base,workspace:{action:'community.read'}})).toThrow();
 expect(()=>normalizeMobileWorkspaceRequest({...base,workspace:{action:'community.send',text:'   '}})).toThrow();
 expect(()=>normalizeMobileWorkspaceRequest({...base,workspace:{action:'community.projects',deviceRef:'nope',page:0}})).toThrow();
 expect(()=>normalizeMobileWorkspaceRequest({...base,workspace:{action:'community.status',deviceRef:'ab12ef3456789012'}})).toThrow();
 // 커뮤니티는 프로젝트 범위 밖의 기능 스위치를 요구하지 않는다(VOC와 같은 판정).
 for(const action of ['community.status','community.read','community.send','community.projects'] as const)expect(workspaceScope(action)).toBeNull();
 // 상태·읽기·보내기는 community, 프로젝트 목록은 communityProjects — 섞으면 거절한다.
 expect(normalizeMobileWorkspaceResult({kind:'workspace',action:'community.status',
   community:{inside:false,roomId:null,unread:0,members:[],devices:[],messages:[],nextSeq:0}}).community?.inside).toBe(false);
 expect(()=>normalizeMobileWorkspaceResult({kind:'workspace',action:'community.status',
   communityProjects:{deviceName:'3호',opsTargetId:null,projects:[],page:0,hasMore:false,total:0}})).toThrow();
 expect(()=>normalizeMobileWorkspaceResult({kind:'workspace',action:'community.projects',
   community:{inside:false,roomId:null,unread:0,members:[],devices:[],messages:[],nextSeq:0}})).toThrow();
 expect(normalizeMobileWorkspaceResult({kind:'workspace',action:'community.projects',
   communityProjects:{deviceName:'3호 맥',opsTargetId:'p-00000001',projects:[{targetId:'p-00000001',label:'OPS'}],page:0,hasMore:true,total:40}})
   .communityProjects?.hasMore).toBe(true);
});
