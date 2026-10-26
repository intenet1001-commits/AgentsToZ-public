import {expect,test} from 'bun:test';
import {commonMemoryUpdateAdvice,commonMemoryWorkroomDraft} from '../src/commonMemoryFollowup';
import {createCommonMemoryFollowupWatcher,COMMON_MEMORY_FOLLOWUP_POLL_MS} from '../src/commonMemoryFollowupWatcher';
import {parseCommonMemoryRequest} from '../src/commonMemoryRequest';

const now=Date.parse('2026-10-12T00:00:00Z');
const input={groupId:'11111111-1111-4111-8111-111111111111',name:'교통수단게임',version:2,sourceMemoryIds:['A','B'],
  baseline:[{memoryId:'A',revisionId:'old-A',contentHash:'hash-A'},{memoryId:'B',revisionId:'old-B',contentHash:'hash-B'}],
  heads:[{memoryId:'A',revisionId:'old-A'},{memoryId:'B',revisionId:'old-B'}],publishedAt:'2026-10-11T00:00:00Z'};
test('recommendations require real new data and a time or accumulation threshold',()=>{
  expect(commonMemoryUpdateAdvice({...input,publishedAt:'2020-01-01'},now).suggested).toBe(false);
  const one={...input,heads:[{memoryId:'A',revisionId:'new-A'},input.heads[1]!]};
  expect(commonMemoryUpdateAdvice(one,now).suggested).toBe(false);
  expect(commonMemoryUpdateAdvice({...one,publishedAt:'2026-10-05T00:00:00Z'},now).suggested).toBe(true);
  expect(commonMemoryUpdateAdvice({...one,heads:[{memoryId:'A',revisionId:'new-A'},{memoryId:'B',revisionId:'new-B'}]},now).suggested).toBe(true);
  expect(commonMemoryUpdateAdvice({...one,archived:true},now).suggested).toBe(false);
  const unavailable=commonMemoryUpdateAdvice({...one,heads:[one.heads[0]!]},now);
  expect(unavailable.unavailableCount).toBe(1);expect(unavailable.suggested).toBe(false);
  expect(commonMemoryUpdateAdvice({...input,baseline:[],publishedAt:undefined},now).suggested).toBe(true);
});
test('the Workroom handoff carries exact identity, latest version, topic and bounded real activity, without declaring a save',()=>{
  const group={id:input.groupId,name:input.name,version:9,goal:'함께 쓰는 게임 규칙',sourceMemoryIds:['A','B'],knowledgeRevision:3};
  const draft=commonMemoryWorkroomDraft({kind:'update',scopeId:'a'.repeat(64),group});
  expect(draft.prompt).toContain('"version":9');expect(draft.prompt).toContain(input.groupId);
  expect(draft.prompt).toContain('propose-source-entry');expect(draft.prompt).toContain('스스로 확정');
  const recommended=commonMemoryWorkroomDraft({kind:'recommend',scopeId:'a'.repeat(64),cloudSources:Array.from({length:100},(_,i)=>({memoryId:`memory-${i}`,name:'한'.repeat(100),revisionId:`revision-${i}`}))});
  const context=JSON.parse(recommended.prompt.split('\n').at(-1)!);
  expect(context.projects).toBeUndefined();expect(context.cloudSources).toHaveLength(16);expect(context.cloudSources[0].memoryId).toBe('memory-0');
  expect(new TextEncoder().encode(recommended.prompt).length).toBeLessThan(6000);
  expect(()=>parseCommonMemoryRequest({operation:'updates',input:{offset:0,folderPath:'/unapproved'}})).toThrow();
});
test('an update draft names where to read: tracked sources, else the linked memories, else a search without guessing',()=>{
  const base={id:input.groupId,name:input.name,version:3,goal:'공유 규칙',knowledgeRevision:1};
  const tracked=commonMemoryWorkroomDraft({kind:'update',scopeId:'a'.repeat(64),group:{...base,sourceMemoryIds:['A'],useProjectMemoryIds:['L']}}).prompt;
  expect(tracked).toContain('원본을 정하는 기준이 아닙니다');expect(tracked).toContain('추측하지 마세요');
  const linked=commonMemoryWorkroomDraft({kind:'update',scopeId:'a'.repeat(64),group:{...base,sourceMemoryIds:[],useProjectMemoryIds:['L']},cloudSources:[{memoryId:'L',name:'연결 A',revisionId:'r'}]}).prompt;
  expect(linked).toContain('가져올 기억이 없으니 연결된 장기기억(cloudSources)을 원본으로 읽고');expect(linked).not.toContain('기준이 아닙니다');expect(linked).not.toContain('추측하지 마세요');
  const none=commonMemoryWorkroomDraft({kind:'update',scopeId:'a'.repeat(64),group:{...base,sourceMemoryIds:[],useProjectMemoryIds:[]}}).prompt;
  expect(none).toContain('모두 없습니다');expect(none).toContain('list_common_memory_sources');expect(none).toContain('추측하지 마세요');
  // Linked memories that cannot be read leave a catalog page: not called the linked memories, and still no guessing.
  const unreadable=commonMemoryWorkroomDraft({kind:'update',scopeId:'a'.repeat(64),group:{...base,sourceMemoryIds:[],useProjectMemoryIds:['L']},cloudSources:[{memoryId:'X',name:'카탈로그 X',revisionId:'r'}]}).prompt;
  expect(unreadable).not.toContain('연결된 장기기억(cloudSources)을 원본으로 읽고');expect(unreadable).toContain('지금 읽을 수 없습니다');expect(unreadable).toContain('추측하지 마세요');
  expect(commonMemoryWorkroomDraft({kind:'update',scopeId:'a'.repeat(64),group:{...base,sourceMemoryIds:[],useProjectMemoryIds:['L']}}).prompt).toContain('추측하지 마세요');
  expect(commonMemoryWorkroomDraft({kind:'recommend',scopeId:'a'.repeat(64)}).prompt).toContain('기기와 무관하게');
});
test('follow-up advice names the sources it reads, and counts days only from a publication',()=>{
  expect(commonMemoryUpdateAdvice({...input,baseline:[],publishedAt:undefined},now).reason).toBe('가져올 기억에서 함께 쓸 기억을 처음 정리할 수 있습니다.');
  const one={...input,heads:[{memoryId:'A',revisionId:'new-A'},input.heads[1]!]};
  expect(commonMemoryUpdateAdvice(one,now).reason).toContain('지난 게시 후 7일');
  expect(commonMemoryUpdateAdvice({...one,publishedAt:undefined},now).reason).toBe('원본 1개가 바뀌었습니다. 변경이 더 모이면 정리를 제안합니다.');
});
test('the periodic watcher is bounded, serialized, visibility-aware and stopped callbacks cannot publish',async()=>{
  let clock=0,visible=false,calls=0;const results:any[]=[],errors:string[]=[];
  const watcher=createCommonMemoryFollowupWatcher({now:()=>clock,visible:()=>visible,read:async offset=>{calls++;return {updates:[commonMemoryUpdateAdvice(input,now)],scopeId:'cloud',nextOffset:offset+16};},result:r=>results.push(r),error:e=>errors.push(e)});
  await watcher.check();expect(calls).toBe(0);
  visible=true;await Promise.all([watcher.check(),watcher.check()]);expect(calls).toBe(3);expect(results[0].partial).toBe(true);
  await watcher.check();expect(calls).toBe(3);
  clock+=COMMON_MEMORY_FOLLOWUP_POLL_MS;await watcher.check();expect(calls).toBe(6);
  watcher.stop();clock+=COMMON_MEMORY_FOLLOWUP_POLL_MS;await watcher.check();expect(calls).toBe(6);expect(errors).toEqual([]);
  let release!:()=>void;const held=new Promise<void>(r=>release=r);
  const stopped=createCommonMemoryFollowupWatcher({read:async()=>{await held;return {updates:[],scopeId:'cloud',nextOffset:null};},visible:()=>true,result:()=>{throw Error('stopped watcher published');},error:()=>{throw Error('stopped watcher failed');}});
  const pending=stopped.check();stopped.stop();release();await pending;
});
