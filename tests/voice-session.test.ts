import {afterEach,expect,test} from 'bun:test';
import {VoiceSessionHost,type VoiceAuthority,type VoiceResolvedTarget} from '../src/voiceSessionHost';
import {normalizeVoiceRequest,normalizeVoiceResponse,type VoiceRequest} from '../src/voiceSessionProtocol';
import {normalizeMobileWorkspaceRequest,normalizeMobileWorkspaceResult,workspaceScope} from '../src/mobileWorkspaceProtocol';
import type {VoiceProviderInput} from '../src/voiceRealtimeProvider';
import {remoteVoiceTransport} from '../src/voiceSessionClient';
import {VOICE_AGENT_NAME_GUIDANCE,VOICE_TARGET_CALL_GUIDANCE} from '../src/voiceOrchestrationGuidance';
const hosts:VoiceSessionHost[]=[];afterEach(async()=>{await Promise.all(hosts.splice(0).map(h=>h.shutdown()));});
const request=(action:VoiceRequest['action'],other:Partial<VoiceRequest>={})=>({action,requestId:crypto.randomUUID(),...other});
const authority:VoiceAuthority={owner:'local',active:()=>true};
function fixture(options:{delay?:Promise<void>;send?:()=>Promise<void>;observe?:()=>Promise<unknown>}={}){
 let event:VoiceProviderInput['onEvent']=()=>{},closed=0,connected=0,keyReads=0,sends=0,valid=true,now=1000;
 const outputs:Record<string,unknown>[]=[],inputs:VoiceProviderInput[]=[];
 const binding:VoiceResolvedTarget={label:'fixture · codex',key:'fixed-fixture',validate:async()=>{if(!valid)throw Error('changed');},tools:[],run:async()=>({}),review:async()=>({label:'fixture · codex',send:async()=>{sends++;await options.send?.();},observe:options.observe})};
 const host=new VoiceSessionHost({now:()=>now,wait:async()=>{},credentials:{status:()=>({configured:true,model:'gpt-realtime-2.1',voice:'marin'}),key:async()=>{keyReads++;return 'test-only-secret';},configure:async()=>({configured:true})},bind:async()=>binding,provider:async i=>{inputs.push(i);event=i.onEvent;connected++;await options.delay;return {sdp:'v=0\r\n'+'x'.repeat(9000),send:e=>outputs.push(e),close:async()=>{closed++;}};}});hosts.push(host);
 const perform=(r:VoiceRequest,a=authority)=>host.perform(r,a);
 const prepare=async(mode:'dictation'|'conversation'='dictation',a=authority)=>(await perform(request('prepare',{target:{kind:'workroom',targetId:'project_fixture',sessionId:'terminal_fixture'},mode,consent:true}),a)).session!.id;
 return {host,perform,prepare,binding,event:(e:Record<string,unknown>)=>event(e),stats:()=>({closed,connected,keyReads,sends}),outputs,inputs,invalidate:()=>{valid=false;},advance:(ms:number)=>{now+=ms;}};
}
const settle=()=>new Promise(r=>setTimeout(r,5));
test('wire rejects arbitrary execution, credentials on remote, missing consent and control characters',()=>{
 for(const bad of [request('prepare',{target:{kind:'ops'},mode:'conversation'}),{...request('capabilities'),path:'/tmp'},request('submit',{sessionId:'voice_fixture',draftId:'draft_fixture',text:'a\x1bb',inputReady:true})])expect(()=>normalizeVoiceRequest(bad)).toThrow();
 expect(workspaceScope('voice')).toBe('voice.use');
 const outer=(voice:VoiceRequest)=>({operation:'workspace',requestId:voice.requestId,targetId:'project_fixture',workspace:{action:'voice',voice}});
 expect(()=>normalizeMobileWorkspaceRequest(outer(request('configure',{apiKey:'x'.repeat(30)})))).toThrow();
 expect(()=>normalizeMobileWorkspaceRequest(outer(request('connect',{sessionId:'voice_fixture',sdp:'v=0'})))).toThrow();
 expect(()=>normalizeMobileWorkspaceRequest(outer(request('prepare',{target:{kind:'workroom',targetId:'other_fixture',sessionId:'session_fixture'},mode:'dictation',consent:true})))).toThrow();
 expect(()=>normalizeVoiceResponse({configured:true,apiKey:'secret'})).toThrow();
 expect(normalizeVoiceResponse({session:{id:'voice_fixture',state:'active',mode:'conversation',label:'old Mac',draft:null,notice:'active',expiresAt:Date.now()+1000}}).session?.provider).toBe('openai');
 expect(()=>normalizeVoiceResponse({session:{id:'voice_fixture',state:'active',mode:'conversation',label:'Mac',draft:null,notice:'active',expiresAt:Date.now()+1000,openedWorkroom:{kind:'workroom',eventId:'event_fixture_123',label:'project',targetId:'target_fixture_123',sessionId:'session_fixture_123',agent:'codex',path:'/secret'}}})).toThrow();
});
test('capability check never reads Keychain; prepare admission and target ownership are single flight',async()=>{
 const f=fixture();await f.perform(request('capabilities'));expect(f.stats().keyReads).toBe(0);
 const r=request('prepare',{target:{kind:'ops'},mode:'conversation',consent:true});
 const [a,b]=await Promise.all([f.perform(r),f.perform(r)]);expect(a).toEqual(b);
 await expect(f.perform({...r,mode:'dictation'})).rejects.toThrow();
 await expect(f.prepare()).rejects.toThrow();
 await expect(f.prepare('dictation',{owner:'remote-device',active:()=>true})).rejects.toThrow();
 expect(f.stats().connected).toBe(0);
});
test('late provider completion after stop closes connection and cannot resurrect session',async()=>{
 let release!:()=>void;const f=fixture({delay:new Promise<void>(r=>{release=r;})});const sessionId=await f.prepare();
 const connection=f.perform(request('connect',{sessionId,sdp:'v=0'}));await settle();
 await f.perform(request('stop',{sessionId}));release();await expect(connection).rejects.toThrow();
 expect(f.stats().closed).toBe(1);expect((await f.perform(request('state',{sessionId}))).session!.state).toBe('ended');
});
test('dictation accumulates concurrent finals, never sends before review, deduplicates submitted receipt',async()=>{
 const f=fixture(),sessionId=await f.prepare();await f.perform(request('connect',{sessionId,sdp:'v=0'}));
 f.event({type:'conversation.item.input_audio_transcription.completed',item_id:'one',transcript:'첫 문장'});
 f.event({type:'conversation.item.input_audio_transcription.completed',item_id:'two',transcript:'둘째 문장'});
 f.event({type:'conversation.item.input_audio_transcription.completed',item_id:'two',transcript:'중복'});await settle();
 const s=(await f.perform(request('state',{sessionId}))).session!;expect(s.draft!.text).toBe('첫 문장\n둘째 문장');expect(f.stats().sends).toBe(0);
 const submit=request('submit',{sessionId,draftId:s.draft!.id,text:s.draft!.text,inputReady:true});
 await Promise.all([f.perform(submit),f.perform(submit)]);expect(f.stats().sends).toBe(1);
 await expect(f.perform({...submit,text:'changed'})).rejects.toThrow();
});
test('uncertain send has a rejected receipt and cannot replay the same request',async()=>{
 const f=fixture({send:async()=>{throw Error('lost receipt');}}),sessionId=await f.prepare();await f.perform(request('connect',{sessionId,sdp:'v=0'}));
 f.event({type:'conversation.item.input_audio_transcription.completed',item_id:'one',transcript:'지시'});await settle();
 const draft=(await f.perform(request('state',{sessionId}))).session!.draft!;
 const r=request('submit',{sessionId,draftId:draft.id,text:draft.text,inputReady:true});await expect(f.perform(r)).rejects.toThrow('lost receipt');await expect(f.perform(r)).rejects.toThrow('lost receipt');expect(f.stats().sends).toBe(1);
});
test('conversation submit observes only the reviewed workroom result and asks the provider to explain it',async()=>{
 const f=fixture({observe:async()=>({state:'observed-output',completed:false,partial:true,nextCursor:42,output:'실제 채팅 결과'})});
 const sessionId=await f.prepare('conversation');await f.perform(request('connect',{sessionId,sdp:'v=0'}));
 f.event({type:'response.function_call_arguments.done',call_id:'call_observe',name:'prepare_instruction',arguments:JSON.stringify({text:'테스트 실행'})});await settle();
 const draft=(await f.perform(request('state',{sessionId}))).session!.draft!;
 await f.perform(request('submit',{sessionId,draftId:draft.id,text:draft.text,inputReady:true}));await settle();
 const followup=f.outputs.find((event:any)=>event.type==='conversation.item.create'&&event.item?.type==='message') as any;
 expect(followup.item.content[0].text).toContain('실제 채팅 결과');
 expect(followup.item.content[0].text).toContain('completed:false는 출력 관찰이 이어진다는 뜻');
 expect(followup.item.content[0].text).toContain('기억 저장만 보류된 것인지 원래 지시도 실패했는지 구분');
 expect(f.outputs.some((event:any)=>event.type==='response.create')).toBe(true);
});
test('conversation keeps observing a slow Workroom and relays its later result',async()=>{
 let reads=0;
 const f=fixture({observe:async()=>{
  reads++;
  return {state:'observed-output',completed:reads>20,partial:reads<=20,nextCursor:reads>20?41:40,output:reads===1?'작업 시작':reads===21?'창 종료 완료':''};
 }});
 const sessionId=await f.prepare('conversation');await f.perform(request('connect',{sessionId,sdp:'v=0'}));
 f.event({type:'response.function_call_arguments.done',call_id:'call_slow',name:'prepare_instruction',arguments:JSON.stringify({text:'창 닫아'})});await settle();
 const draft=(await f.perform(request('state',{sessionId}))).session!.draft!;
 await f.perform(request('submit',{sessionId,draftId:draft.id,text:draft.text,inputReady:true}));
 for(let i=0;i<20&&reads<21;i++)await settle();
 expect(reads).toBeGreaterThan(20);
 const messages=f.outputs.filter((event:any)=>event.type==='conversation.item.create'&&event.item?.type==='message') as any[];
 expect(messages.some(event=>event.item.content[0].text.includes('창 종료 완료'))).toBe(true);
 expect(messages.some(event=>event.item.content[0].text.includes('완료했다고 보고하면 그 사실을 전달'))).toBe(true);
});
test('target invalidation and expiry close only voice; owner mismatch cannot inspect or stop',async()=>{
 const f=fixture(),sessionId=await f.prepare();await f.perform(request('connect',{sessionId,sdp:'v=0'}));
 await expect(f.perform(request('stop',{sessionId}),{owner:'stranger',active:()=>true})).rejects.toThrow();expect(f.stats().closed).toBe(0);
 f.invalidate();expect((await f.perform(request('state',{sessionId}))).session!.state).toBe('failed');expect(f.stats().closed).toBe(1);expect(f.stats().sends).toBe(0);
 const g=fixture(),id=await g.prepare();g.advance(15*60000);expect((await g.perform(request('state',{sessionId:id}))).session!.state).toBe('failed');
});
test('remote SDP roundtrip stays within strict workspace envelopes and preserves host ownership',async()=>{
 const f=fixture(),sessionId=await f.prepare();let largest=0;
 const transport=remoteVoiceTransport(async raw=>{
  const r=normalizeMobileWorkspaceRequest(raw);largest=Math.max(largest,JSON.stringify(r).length);
  return normalizeMobileWorkspaceResult({kind:'workspace',action:'voice',voice:await f.perform(r.workspace.voice!)});
 },'project_fixture');
 const answer=await transport(request('connect',{sessionId,sdp:'v=0\r\n'+'a'.repeat(13000)}));expect(answer.sdp).toBe('v=0\r\n'+'x'.repeat(9000));expect(largest).toBeLessThan(8500);expect(f.stats().connected).toBe(1);
 await expect(f.perform(request('signal.append',{sessionId,part:0,parts:1,chunk:'changed'}))).rejects.toThrow();
});
test('provider tool calls are bounded, deduplicated and staged for a person',async()=>{
 const f=fixture(),sessionId=await f.prepare('conversation');await f.perform(request('connect',{sessionId,sdp:'v=0'}));
 const event={type:'response.function_call_arguments.done',call_id:'call_fixture',name:'prepare_instruction',arguments:JSON.stringify({text:'테스트 실행'})};f.event(event);f.event(event);await settle();
 expect(f.stats().sends).toBe(0);expect(f.outputs.filter(e=>e.type==='conversation.item.create')).toHaveLength(1);
 expect((await f.perform(request('state',{sessionId}))).session!.draft!.text).toBe('테스트 실행');
});
test('tool output waits for the active spoken response to finish before requesting the next response',async()=>{
 const f=fixture(),sessionId=await f.prepare('conversation');await f.perform(request('connect',{sessionId,sdp:'v=0'}));
 (f.binding as any).tools=[{name:'inspect',description:'inspect',parameters:{type:'object',properties:{},additionalProperties:false}}];
 f.event({type:'response.created'});f.event({type:'response.function_call_arguments.done',call_id:'call_wait',name:'inspect',arguments:'{}'});await settle();
 expect(f.outputs.some((event:any)=>event.type==='conversation.item.create')).toBe(true);expect(f.outputs.some((event:any)=>event.type==='response.create')).toBe(false);
 f.event({type:'response.done'});expect(f.outputs.filter((event:any)=>event.type==='response.create')).toHaveLength(1);
});

test('remote voice requires its own grant in addition to terminal or record access',async()=>{
 const {createMobileWorkspaceGateway}=await import('../src/mobileWorkspaceGateway');let enabled=false,called=0;
 const gateway=createMobileWorkspaceGateway({terminal:async()=>({}),active:()=>true,resolve:async()=>[{controlId:'project_fixture',runtimeTargetId:'registered_fixture'}],consent:async()=>({targetIds:new Set(['registered_fixture']),workspaceScopes:enabled?['voice.use']:['records.read'],isActive:()=>true,requestOwner:'device_fixture'}),perform:async()=>{called++;return {kind:'workspace',action:'voice',voice:{configured:true}};}});
 const voice=request('capabilities');const r=normalizeMobileWorkspaceRequest({operation:'workspace',requestId:voice.requestId,targetId:'project_fixture',workspace:{action:'voice',voice}});
 await expect(gateway(r,[],'owner_fixture')).rejects.toThrow();expect(called).toBe(0);enabled=true;expect(await gateway(r,[],'owner_fixture')).toEqual({kind:'workspace',action:'voice',voice:{configured:true}});expect(called).toBe(1);
});


test('slow remote connection starts a fresh heartbeat window when media becomes active',async()=>{
 let release!:()=>void;const f=fixture({delay:new Promise<void>(r=>{release=r;})}),sessionId=await f.prepare();
 const connecting=f.perform(request('connect',{sessionId,sdp:'v=0'}));await settle();f.advance(30_000);release();await connecting;
 await Bun.sleep(3100);expect((await f.perform(request('state',{sessionId}))).session!.state).toBe('active');expect(f.stats().closed).toBe(0);
});

test('conversation receives bound current context before provider connects; missing context fails closed',async()=>{
 const f=fixture();(f.binding as any).context=async()=>({kind:'workroom',project:'한울 프로젝트',agent:'claude',output:'현재 로그인 오류를 수정 중'});
 const sessionId=await f.prepare('conversation');await f.perform(request('connect',{sessionId,sdp:'v=0'}));
 expect((f.inputs[0] as any).context).toContain('한울 프로젝트');expect((f.inputs[0] as any).context).toContain('로그인 오류');
 const g=fixture();(g.binding as any).context=async()=>{throw Error('문맥 읽기 실패');};const id=await g.prepare('conversation');
 await expect(g.perform(request('connect',{sessionId:id,sdp:'v=0'}))).rejects.toThrow('문맥');expect(g.stats().connected).toBe(0);
});

test('OPS voice instructions teach spoken AI names, target calls and the app/folder route; workroom voice does not',async()=>{
 const inputs:VoiceProviderInput[]=[],outputs:Record<string,any>[]=[];let event:VoiceProviderInput['onEvent']=()=>{};const requested:unknown[]=[];
 const ops:VoiceResolvedTarget={label:'AgentsToZ OPS',key:'ops-fixture',validate:async()=>{},tools:[],run:async()=>({}),
  reviewOps:async agent=>{requested.push(agent);return {label:'AgentsToZ-Control · agy',agent:'agy',reused:true,send:async()=>{}};}};
 const host=new VoiceSessionHost({wait:async()=>{},credentials:{status:()=>({configured:true,model:'gpt-realtime-2.1',voice:'marin'}),key:async()=>'test-only',configure:async()=>({})},bind:async()=>ops,
  provider:async i=>{inputs.push(i);event=i.onEvent;return {sdp:'v=0',send:e=>outputs.push(e),close:async()=>{}};}});hosts.push(host);
 const sessionId=(await host.perform(request('prepare',{target:{kind:'ops'},mode:'conversation',consent:true}),authority)).session!.id;
 await host.perform(request('connect',{sessionId,sdp:'v=0'}),authority);
 const instructions=inputs[0]!.instructions;
 expect(instructions).toContain(VOICE_AGENT_NAME_GUIDANCE);expect(instructions).toContain(VOICE_TARGET_CALL_GUIDANCE);
 expect(instructions).toContain('안티그래비티');expect(instructions).toContain('바이브2 → vibe2');
 // 「<프로젝트> 열어」 is a delegate now; only app/folder/dashboard openings go to the OPS workroom.
 expect(instructions).not.toContain('등록 프로젝트 열기');
 event({type:'response.function_call_arguments.done',call_id:'call_ops_agy',name:'prepare_ops_instruction',arguments:JSON.stringify({text:'vibe2 폴더를 열어 줘',agent:'agy'})});await settle();
 expect(requested).toEqual(['agy']);
 const result=JSON.parse(outputs.find(e=>e.item?.call_id==='call_ops_agy')!.item.output);
 expect(result).toMatchObject({state:'awaiting-user',target:'AgentsToZ-Control · agy',agent:'agy',reused:true});
 await host.perform(request('discard',{sessionId,draftId:(await host.perform(request('state',{sessionId}),authority)).session!.draft!.id}),authority);
 event({type:'response.function_call_arguments.done',call_id:'call_ops_bad',name:'prepare_ops_instruction',arguments:JSON.stringify({text:'열어',agent:'gpt'})});await settle();
 expect(requested).toEqual(['agy']);
 expect(JSON.parse(outputs.find(e=>e.item?.call_id==='call_ops_bad')!.item.output).error).toContain('워크룸 AI');
 const w=fixture();await w.perform(request('connect',{sessionId:await w.prepare('conversation'),sdp:'v=0'}));
 expect(w.inputs[0]!.instructions).not.toContain(VOICE_AGENT_NAME_GUIDANCE);
});

test('Gemini sessions use PCM actions while preserving target context and review tools',async()=>{
 let providerInput:VoiceProviderInput|undefined,appended:string[]=[];let ended=0;
 const binding:VoiceResolvedTarget={label:'Gemini 프로젝트 · claude',key:'gemini-binding',validate:async()=>{},tools:[],run:async()=>({}),context:async()=>({project:'Gemini 프로젝트',task:'현재 작업'}),review:async()=>({label:'Gemini 프로젝트 · claude',send:async()=>{}})};
 const host=new VoiceSessionHost({credentials:{status:()=>({configured:false}),key:async()=>'',configure:async()=>({})},gemini:{status:()=>({configured:true,model:'gemini-live-fixture'}),key:async()=> 'gemini-secret',configure:async()=>{},provider:async input=>{providerInput=input;return {sdp:'',send:()=>{},appendAudio:data=>appended.push(data),endAudio:()=>{ended++;},readMedia:async()=>[{kind:'input-transcript',text:'한영 mixed terms',final:true}],close:async()=>{}};}},bind:async()=>binding});hosts.push(host);
 const prepared=await host.perform(request('prepare',{provider:'gemini',target:{kind:'workroom',targetId:'project_fixture',sessionId:'terminal_fixture'},mode:'conversation',consent:true}),authority);expect(prepared.session?.provider).toBe('gemini');
 const connected=await host.perform(request('media.connect',{sessionId:prepared.session!.id}),authority);expect(connected.session?.state).toBe('active');expect(providerInput?.context).toContain('현재 작업');expect(providerInput?.tools.map(t=>t.name)).toContain('prepare_instruction');
 const streamed=await host.perform(request('media.append',{sessionId:prepared.session!.id,audio:'AQI='}),authority);expect(appended).toEqual(['AQI=']);expect(streamed.media?.[0]).toMatchObject({kind:'input-transcript'});
 await host.perform(request('media.end',{sessionId:prepared.session!.id}),authority);expect(ended).toBe(1);
 await expect(host.perform(request('connect',{sessionId:prepared.session!.id,sdp:'v=0'}),authority)).rejects.toThrow('WebRTC');
});
