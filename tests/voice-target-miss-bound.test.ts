import {afterEach,expect,test} from 'bun:test';
import type {AiTerminalService} from '../src/aiTerminalService';
import {bindVoiceRuntime} from '../src/voiceRuntimeBinding';
import {VoiceSessionHost,type VoiceAuthority} from '../src/voiceSessionHost';
import {resolveConversationTarget,textConversationTargets,voiceConversationTargets,type ConversationDirectoryEntry,type ConversationDirectoryRuntimeTarget} from '../src/conversationTargetDirectory';

/**
 * 2026-09-29 review: a spoken 「바이브2 담당자」 misses, and the miss answer carried every registered
 * name (up to 200, each with aliases). Around 140 projects that answer passed the voice host's
 * 16,000-byte tool limit and the model received only 「응답이 큽니다」 — no candidates, so it could
 * not map 바이브2 → vibe2. The answer is now bounded, and the names that sound like what was said
 * come first so the bounded page still carries vibe2.
 */
const hosts:VoiceSessionHost[]=[];afterEach(async()=>{await Promise.all(hosts.splice(0).map(host=>host.shutdown()));});
const authority:VoiceAuthority={owner:'local',active:()=>true};
const VIBE2='0b7a2c1e-2222-4a4a-8b8b-000000000002';

/** Registered rows shaped like a busy Mac: short names, aiName aliases, Korean names and one vibe2. */
function inventory(count:number){
  const ports:Record<string,string>[]=Array.from({length:count},(_,index)=>({
    id:`5c0ffee0-${String(index).padStart(4,'0')}-4a4a-8b8b-${String(index).padStart(12,'0')}`,
    name:index%3===0?`프로젝트${index}번`:`project-${index}-app`,
    aiName:`Synthetic Project Name ${index}`,folderPath:`/Users/fixture/p${index}`,
  }));
  ports.push({id:VIBE2,name:'vibe2',aiName:'Vibe Coding Guide v2',folderPath:'/Users/fixture/vibe2'});
  const runtime:ConversationDirectoryRuntimeTarget[]=ports.map(port=>({targetId:port.id!,projectTargetId:port.id!,label:port.aiName!,scope:'main',branch:null}));
  return {ports,runtime,entries:voiceConversationTargets(ports,runtime,{})};
}
async function opsVoice(entries:ConversationDirectoryEntry[]){
  return bindVoiceRuntime({terminal:{} as AiTerminalService,targets:async()=>entries,target:async()=>({label:'unused',fingerprint:'unused'}),
    ops:()=>({fingerprint:'ops',projectId:null}),recall:()=>({}),projectRecall:async()=>({}),propose:async()=>({})},{kind:'ops'},authority);
}

test('a miss over 150+ projects stays under 12 KB, says it was cut, and still carries vibe2 first',async()=>{
  for(const count of [150,200,260]){
    const {entries}=inventory(count);
    const miss:any=await (await opsVoice(entries)).run('resolve_target_alias',{alias:'바이브2 담당자'},'voice_request_fixture');
    const bytes=Buffer.byteLength(JSON.stringify(miss));
    expect(bytes,`${count+1} projects`).toBeLessThan(12_000);
    expect(miss).toMatchObject({resolved:false,code:'TARGET_ALIAS_NOT_FOUND',total:count+1,truncated:true});
    expect(miss.candidates.length).toBeGreaterThan(20);
    expect(miss.candidates.length).toBeLessThan(count+1);
    // The spoken name comes first — the model does not have to page for it.
    expect(miss.candidates[0]).toEqual({id:VIBE2,name:'vibe2',aliases:['Vibe Coding Guide v2']});
    // Names and ids only: no role/scope, no paths.
    expect(Object.keys(miss.candidates[1]).every((key:string)=>['id','name','aliases'].includes(key))).toBe(true);
    expect(miss.hint).toContain('list_projects');
  }
});

test('long aliases are left out of a miss so one noisy row cannot push the names out',async()=>{
  const {ports,runtime}=inventory(40);
  ports[5]!.aiName='A very long descriptive alias '.repeat(8);runtime[5]!.label=ports[5]!.aiName;
  const miss:any=await (await opsVoice(voiceConversationTargets(ports,runtime,{}))).run('resolve_target_alias',{alias:'바이브2 담당자'},'voice_request_fixture');
  const row=miss.candidates.find((candidate:{id:string})=>candidate.id===ports[5]!.id);
  expect(row).toEqual({id:ports[5]!.id,name:ports[5]!.name});
  expect(miss.truncated).toBe(false);expect(miss.total).toBe(41);expect(miss.candidates).toHaveLength(41);
  expect(miss.hint).toBeUndefined();
});

test('through the real host the model receives the bounded candidates, not the 16 KB error',async()=>{
  const {entries}=inventory(150);
  const outputs:Record<string,any>[]=[];let onEvent:(event:Record<string,unknown>)=>void=()=>{};
  const host=new VoiceSessionHost({wait:async()=>{},credentials:{status:()=>({configured:true,model:'gpt-realtime-2.1',voice:'marin'}),key:async()=>'test-only',configure:async()=>({})},
    bind:(target,a)=>bindVoiceRuntime({terminal:{perform:async()=>({sessions:[]})} as unknown as AiTerminalService,targets:async()=>entries,target:async()=>({label:'u',fingerprint:'u'}),
      ops:()=>({fingerprint:'o',projectId:null}),recall:()=>({}),projectRecall:async()=>({}),propose:async()=>({})},target,a),
    provider:async input=>{onEvent=input.onEvent;return {sdp:'v=0',send:event=>outputs.push(event),close:async()=>{}};}});hosts.push(host);
  const id=(await host.perform({action:'prepare',requestId:crypto.randomUUID(),target:{kind:'ops'},mode:'conversation',consent:true},authority)).session!.id;
  await host.perform({action:'connect',requestId:crypto.randomUUID(),sessionId:id,sdp:'v=0'},authority);
  onEvent({type:'response.function_call_arguments.done',call_id:'call_miss_fixture',name:'resolve_target_alias',arguments:JSON.stringify({alias:'바이브2 담당자'})});
  let item:any;for(const deadline=Date.now()+3000;Date.now()<deadline&&!(item=outputs.find(event=>event.item?.call_id==='call_miss_fixture'));)await Bun.sleep(20);
  const result=JSON.parse(item.item.output);
  expect(result.error).toBeUndefined();
  expect(result.candidates[0]).toMatchObject({id:VIBE2,name:'vibe2'});
});

test('text and voice rank a miss the same way; text keeps every candidate up to its own limit',async()=>{
  const {ports,runtime}=inventory(30);
  const voice:any=await (await opsVoice(voiceConversationTargets(ports,runtime,{}))).run('resolve_target_alias',{alias:'바이브2 담당자'},'voice_request_fixture');
  const text=resolveConversationTarget('바이브2 담당자',textConversationTargets(ports,{available:new Set(ports.map(port=>port.id!))}));
  if(text.resolved)throw new Error('expected a miss');
  expect(text.candidates[0]!.id).toBe(VIBE2);
  expect(text).toMatchObject({total:31,truncated:false});
  expect(voice.candidates.map((candidate:{id:string})=>candidate.id)).toEqual(text.candidates.map(candidate=>candidate.id));
});
