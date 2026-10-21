import {describe,expect,test} from 'bun:test';
import {createCommonMemory,configureCommonMemory,reviewCommonMemoryItem,refreshCommonMemorySources,publishCommonMemory,recommendCommonMemories,recallCommonMemory,commonMemoryReady,normalizeCommonMemoryApplication,commonMemoryHash,type CommonMemoryGoal,type CommonMemorySourceEntry,type CommonMemorySourceHead} from '../src/commonMemory';
import {agentsToZUseMcpActionForTool,AGENTSTOZ_USE_MCP_TOOLS} from '../agentstoz-use-mcp-server';
import {parseAgentsToZUseActionRequest} from '../src/agentstozUseControl';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',C='33333333-3333-4333-8333-333333333333';
const game:CommonMemoryGoal={objective:'아이폰 운전게임의 물리와 조작 품질 개선',include:['게임 물리','운전 조작'],exclude:['금융 앱'],conditions:['게임 개발'],checks:['조작 회귀 테스트']};
const ios:CommonMemoryGoal={objective:'SwiftUI 아이폰 네이티브 앱의 생명주기 관리',include:['iOS','SwiftUI'],exclude:['웹 브라우저'],conditions:['iOS 네이티브 앱'],checks:['백그라운드 복귀 실기 검사']};
const entry=async(memoryId:string,title:string,excerpt:string):Promise<CommonMemorySourceEntry>=>({memoryId,revisionId:crypto.randomUUID(),entryId:crypto.randomUUID().replaceAll('-','').slice(0,24),contentHash:await commonMemoryHash(excerpt),title,excerpt,section:'Decisions'});
const heads=(entries:CommonMemorySourceEntry[]):CommonMemorySourceHead[]=>[...new Map(entries.map(e=>[e.memoryId,{memoryId:e.memoryId,revisionId:e.revisionId,contentHash:e.contentHash}])).values()];
async function fixture(){
 const driving=await entry(B,'게임 조작','운전게임 조작은 프레임 시간에 독립적이어야 한다.'),lifecycle=await entry(B,'iOS 생명주기','SwiftUI 앱은 백그라운드 복귀 시 연결을 점검한다.');lifecycle.revisionId=driving.revisionId;
 const a=await entry(A,'물리','운전게임 충돌은 실제 속도와 시간으로 검증한다.'),c=await entry(C,'iOS 권한','아이폰 권한 화면에서는 실제 사용자 동의를 확인한다.');
 const sourceHeads=heads([a,driving,c]),gameHeads=sourceHeads.filter(h=>[A,B].includes(h.memoryId)),iosHeads=sourceHeads.filter(h=>[B,C].includes(h.memoryId));
 let g=createCommonMemory({name:'운전게임',goal:game,sourceMemoryIds:[A,B]}),i=createCommonMemory({name:'아이폰 네이티브 앱',goal:ios,sourceMemoryIds:[B,C]});
 g=await reviewCommonMemoryItem(g,{sourceEntries:[driving],reason:'게임 조작 품질을 안정화한다.',conditions:['운전게임 조작 구현']},gameHeads);
 i=await reviewCommonMemoryItem(i,{sourceEntries:[lifecycle],reason:'iOS 앱 복귀 시 연결 품질을 유지한다.',conditions:['SwiftUI 앱 백그라운드 복귀']},iosHeads);
 return {g:publishCommonMemory(g,gameHeads),i:publishCommonMemory(i,iosHeads),driving,lifecycle,a,c,gameHeads,iosHeads};
}
describe('goal-specific common memory',()=>{
 test('A+B and B+C coexist and select different entries of B without changing source identity',async()=>{
  const f=await fixture();expect(f.g.sourceMemoryIds).toEqual([A,B]);expect(f.i.sourceMemoryIds).toEqual([B,C]);expect(f.g.items[0]?.rule).toContain('프레임');expect(f.i.items[0]?.rule).toContain('백그라운드');expect(f.g.items[0]?.evidence[0]?.memoryId).toBe(B);expect(f.i.items[0]?.evidence[0]?.memoryId).toBe(B);
  expect(f.g.publication?.id).not.toBe(f.i.publication?.id);
 });
 test('a goal change invalidates new use while preserving the exact old publication for in-flight work',async()=>{
  const f=await fixture(),old=structuredClone(f.g.publication),changed=configureCommonMemory(f.g,{name:'앱',goal:ios,sourceMemoryIds:[A,B]});
  expect(changed.goalVersion).toBe(2);expect(changed.items.every(item=>item.state==='needs-review')).toBe(true);expect(commonMemoryReady(changed)).toBe(false);expect(changed.publication).toEqual(old);
  expect(()=>publishCommonMemory(changed,f.gameHeads)).toThrow('검토');expect(recallCommonMemory(old!,'운전게임 조작').items).toHaveLength(1);
 });
 test('renaming alone does not invalidate the goal, while source membership changes do',async()=>{
  const f=await fixture(),renamed=configureCommonMemory(f.g,{name:'새 이름',goal:game,sourceMemoryIds:[B,A]});expect(renamed.goalVersion).toBe(1);expect(commonMemoryReady(renamed)).toBe(true);
  const changed=configureCommonMemory(f.g,{name:'게임',goal:game,sourceMemoryIds:[A,C]});expect(changed.goalVersion).toBe(2);expect(commonMemoryReady(changed)).toBe(false);
 });
 test('source changes invalidate dependent rules, while an unrelated B change can rebase unchanged iOS evidence',async()=>{
  const f=await fixture(),changed={...f.driving,revisionId:crypto.randomUUID(),contentHash:await commonMemoryHash('new rule'),excerpt:'운전 조작의 새 조건'},unchanged={...f.lifecycle,revisionId:changed.revisionId};
  const gameHeads=f.gameHeads.map(h=>h.memoryId===B?{...h,revisionId:changed.revisionId}:h),iosHeads=f.iosHeads.map(h=>h.memoryId===B?{...h,revisionId:changed.revisionId}:h);
  const g=refreshCommonMemorySources(f.g,[f.a,changed],gameHeads),i=refreshCommonMemorySources(f.i,[unchanged,f.c],iosHeads);
  expect(g.items[0]?.state).toBe('needs-review');expect(i.items[0]?.state).toBe('reviewed');expect(i.items[0]?.evidence[0]?.revisionId).toBe(changed.revisionId);
  expect(commonMemoryReady(i,iosHeads)).toBe(false);expect(commonMemoryReady(publishCommonMemory(i,iosHeads),iosHeads)).toBe(true);
 });
 test('publication refuses an obsolete source snapshot and a source outside the selected group',async()=>{
  const f=await fixture();expect(()=>publishCommonMemory(f.g,f.gameHeads.map(h=>({...h,revisionId:crypto.randomUUID()})))).toThrow('검토');
  await expect(reviewCommonMemoryItem(f.g,{sourceEntries:[f.c],reason:'bad',conditions:[]},heads([f.c]))).rejects.toThrow('원본');
 });
 test('recommendations use goals and conditions, exclude archived/unreviewed groups, and never choose automatically',async()=>{
  const f=await fixture(),groups=[f.g,f.i,{...f.i,id:crypto.randomUUID(),archived:true},configureCommonMemory(f.g,{name:'changed',goal:ios,sourceMemoryIds:[A,B]})];
  const rec=recommendCommonMemories(groups,'SwiftUI 아이폰 네이티브 앱 만들기');expect(rec[0]?.groupId).toBe(f.i.id);expect(rec.some(r=>r.name==='changed')).toBe(false);expect(rec[0]?.method).toBe('goal-metadata-retrieval');
 });
 test('recall is bounded, goal-specific and never claims verification',async()=>{
  const f=await fixture(),capsule=recallCommonMemory(f.i.publication!,'SwiftUI 앱 생명주기');expect(capsule.items).toHaveLength(1);expect(capsule.verified).toBe(false);expect(new TextEncoder().encode(JSON.stringify(capsule)).length).toBeLessThanOrEqual(16_000);
  expect(recallCommonMemory(f.i.publication!,'unrelated accounting database').items).toHaveLength(0);
 });
 test('an application pass requires actual check identity and exact published items, independently of recall',async()=>{
  const f=await fixture(),p=f.i.publication!,base={revisionId:p.id,goalVersion:p.goalVersion,itemIds:[p.items[0]!.id],task:'앱 복귀 검사',outcome:'passed',evidence:'실제 검사 결과'};
  expect(()=>normalizeCommonMemoryApplication(base,p,f.i.id)).toThrow('검사');expect(normalizeCommonMemoryApplication({...base,checkId:'ios-background-reconnect'},p,f.i.id).outcome).toBe('passed');
  expect(()=>normalizeCommonMemoryApplication({...base,outcome:'observed',itemIds:['invented']},p,f.i.id)).toThrow('항목');
 });
 test('MCP exposes shared recommendation and goal/selection fields without arbitrary paths or silent target changes',()=>{
  const rec=agentsToZUseMcpActionForTool('agentstoz_use_recommend_common_memories',{projectGoal:'아이폰 앱'},'controller');expect(parseAgentsToZUseActionRequest(rec).commonMemory?.projectGoal).toBe('아이폰 앱');
  const create=agentsToZUseMcpActionForTool('agentstoz_use_create_project',{projectName:'new',workspaceRootId:'root',projectGoal:'아이폰 앱',commonMemoryIds:[A]},'controller');expect(parseAgentsToZUseActionRequest(create).commonMemoryIds).toEqual([A]);
  expect(()=>parseAgentsToZUseActionRequest({...create,projectGoal:undefined})).toThrow('목표');
  expect(()=>agentsToZUseMcpActionForTool('agentstoz_use_recall_common_memory',{groupId:A,task:'game',path:'/tmp'},'controller')).toThrow('documented');
  expect(AGENTSTOZ_USE_MCP_TOOLS.some(t=>t.name==='agentstoz_use_record_common_memory_application')).toBe(true);
  const binding=agentsToZUseMcpActionForTool('agentstoz_use_bind_project_common_memory',{portId:'registered',projectGoal:'새 목표',groupIds:[]},'controller');expect(parseAgentsToZUseActionRequest(binding).commonMemory?.groupIds).toEqual([]);expect(parseAgentsToZUseActionRequest(binding).portId).toBe('registered');
  const sdk=agentsToZUseMcpActionForTool('agentstoz_use_recommend_sdk_project',{portId:'sdk',projectGoal:'아이폰 앱'},'controller');expect(parseAgentsToZUseActionRequest(sdk).sdkProject?.projectGoal).toBe('아이폰 앱');expect(()=>agentsToZUseMcpActionForTool('agentstoz_use_prepare_sdk_project',{portId:'sdk',path:'/tmp'},'controller')).toThrow('documented');
 });
});
