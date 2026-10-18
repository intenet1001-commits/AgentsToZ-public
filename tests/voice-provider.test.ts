import {expect,test} from 'bun:test';
import {connectVoiceRealtime,boundedVoiceResponse} from '../src/voiceRealtimeProvider';
test('Realtime SDP stays on fixed provider URLs, sideband key never enters returned data, abort hangs up once',async()=>{
 const originalFetch=globalThis.fetch,OriginalSocket=globalThis.WebSocket;
 const calls:{url:string;options:RequestInit}[]=[],sockets:any[]=[];const key='fixture-secret-never-client';
 class Socket {static OPEN=1;readyState=1;onopen:any;onmessage:any;onclose:any;onerror:any;closed=0;sent:string[]=[];constructor(public url:string,public options:any){sockets.push(this);queueMicrotask(()=>this.onopen?.({}));}send(data:string){this.sent.push(data)}close(){this.closed++;}}
 try{
  globalThis.WebSocket=Socket as unknown as typeof WebSocket;
  globalThis.fetch=(async(url:any,options:any)=>{calls.push({url:String(url),options});return String(url).endsWith('/hangup')?new Response(null,{status:200}):new Response('v=0\r\nfixture',{status:201,headers:{location:'/v1/realtime/calls/rtc_fixture'}});}) as typeof fetch;
  const abort=new AbortController(),events:any[]=[];
  const connection=await connectVoiceRealtime({key,model:'gpt-realtime-2.1',voice:'marin',sdp:'v=0\r\noffer',mode:'conversation',instructions:'fixture',tools:[{name:'read_workroom',description:'fixture',parameters:{type:'object'}}],signal:abort.signal,onEvent:e=>events.push(e),onDisconnect:()=>{}});
  expect(calls[0]!.url).toBe('https://api.openai.com/v1/realtime/calls');
  const form=calls[0]!.options.body as FormData;const config=JSON.parse(form.get('session') as string);
  // A live English pilot dropped the no-tools and brevity instructions with the
  // older mini recognizer. Keep accurate multilingual transcription independent
  // of the person's selected speech model and the conversation's turn detector.
  expect(config.audio.input.transcription.model).toBe('gpt-transcribe');
  expect(config.model).toBe('gpt-realtime-2.1');
  expect(config.audio.input.turn_detection.type).toBe('semantic_vad');
  expect(config.audio.input.transcription.language).toBeUndefined();expect(config.audio.input.transcription.prompt).toContain('OpenAI');
  // The workroom AIs and the OPS name are spoken constantly; the recognizer must keep them intact.
  for(const term of ['Antigravity','Hermes','Claude','Codex','아젠투지'])expect(config.audio.input.transcription.prompt).toContain(term);expect(config.type).toBe('realtime');expect(config.audio.input.turn_detection.create_response).toBe(true);expect(config.tools[0].type).toBe('function');
  expect(JSON.stringify(connection)).not.toContain(key);expect(sockets[0].url).toBe('wss://api.openai.com/v1/realtime?call_id=rtc_fixture');expect(sockets[0].options.headers.Authorization).toBe('Bearer '+key);
  sockets[0].onmessage({data:JSON.stringify({type:'response.function_call_arguments.done'})});expect(events).toHaveLength(1);
  connection.send({type:'response.create'});expect(sockets[0].sent).toHaveLength(1);
  abort.abort();await connection.close();expect(calls.filter(c=>c.url.endsWith('/hangup'))).toHaveLength(1);expect(sockets[0].closed).toBe(1);
 }finally{globalThis.fetch=originalFetch;globalThis.WebSocket=OriginalSocket;}
});
test('provider body reader cancels oversized streams',async()=>{
 let cancelled=false;const stream=new ReadableStream({pull(c){c.enqueue(new Uint8Array(30));},cancel(){cancelled=true}});
 await expect(boundedVoiceResponse(new Response(stream),20)).rejects.toThrow('크기');expect(cancelled).toBe(true);
});
test('abort and explicit close share the same pending provider hangup instead of reporting early completion',async()=>{
 const originalFetch=globalThis.fetch,OriginalSocket=globalThis.WebSocket;let finish!:(r:Response)=>void;let hangups=0,closed=false;
 class Socket {static OPEN=1;readyState=1;onopen:any;onmessage:any;onclose:any;onerror:any;constructor(){queueMicrotask(()=>this.onopen?.({}));}send(){}close(){}}
 try{
  globalThis.WebSocket=Socket as any;globalThis.fetch=(async(url:any)=>String(url).endsWith('/hangup')?(hangups++,new Promise<Response>(resolve=>{finish=resolve;})):new Response('v=0\r\nfixture',{status:201,headers:{location:'/v1/realtime/calls/rtc_fixture'}})) as any;
  const abort=new AbortController(),connection=await connectVoiceRealtime({key:'fixture',model:'gpt-realtime-2.1',voice:'marin',sdp:'v=0',mode:'conversation',instructions:'fixture',tools:[],signal:abort.signal,onEvent:()=>{},onDisconnect:()=>{}});
  abort.abort();const pending=connection.close().then(result=>{closed=true;return result;});await Bun.sleep(10);expect(closed).toBe(false);expect(hangups).toBe(1);finish(new Response(null,{status:200}));expect(await pending).toEqual({confirmed:true});expect(hangups).toBe(1);
 }finally{finish?.(new Response(null,{status:200}));globalThis.fetch=originalFetch;globalThis.WebSocket=OriginalSocket;}
});
test('provider hangup retries bounded failures and reports unconfirmed cleanup without leaking errors',async()=>{
 const originalFetch=globalThis.fetch,OriginalSocket=globalThis.WebSocket;let hangups=0;
 class Socket {static OPEN=1;readyState=1;onopen:any;onmessage:any;onclose:any;onerror:any;constructor(){queueMicrotask(()=>this.onopen?.({}));}send(){}close(){}}
 try{globalThis.WebSocket=Socket as any;globalThis.fetch=(async(url:any)=>String(url).endsWith('/hangup')?(hangups++,new Response('private provider detail',{status:503})):new Response('v=0\r\nfixture',{status:201,headers:{location:'/v1/realtime/calls/rtc_fixture'}})) as any;
  const connection=await connectVoiceRealtime({key:'fixture-secret',model:'gpt-realtime-2.1',voice:'marin',sdp:'v=0',mode:'conversation',instructions:'fixture',tools:[],signal:new AbortController().signal,onEvent:()=>{},onDisconnect:()=>{}});
  expect(await connection.close()).toEqual({confirmed:false});expect(hangups).toBe(2);expect(await connection.close()).toEqual({confirmed:false});expect(hangups).toBe(2);
 }finally{globalThis.fetch=originalFetch;globalThis.WebSocket=OriginalSocket;}
});

test('initial project context is untrusted user data and connection waits for its matching acknowledgement',async()=>{
 const originalFetch=globalThis.fetch,OriginalSocket=globalThis.WebSocket;let socket:any,done=false;const abort=new AbortController();
 class Socket {static OPEN=1;readyState=1;onopen:any;onmessage:any;onclose:any;onerror:any;sent:any[]=[];constructor(){socket=this;queueMicrotask(()=>this.onopen?.({}));}send(data:string){this.sent.push(JSON.parse(data));}close(){}}
 try{
  globalThis.WebSocket=Socket as any;globalThis.fetch=(async(url:any)=>String(url).endsWith('/hangup')?new Response(null):new Response('v=0\r\nfixture',{status:201,headers:{location:'/v1/realtime/calls/rtc_fixture'}})) as any;
  const pending=connectVoiceRealtime({key:'fixture',model:'gpt-realtime-2.1',voice:'marin',sdp:'v=0',mode:'conversation',instructions:'trusted',context:'{"project":"fixture","output":"untrusted"}',tools:[],signal:abort.signal,onEvent:()=>{},onDisconnect:()=>{}}).then(r=>{done=true;return r;});
  await Bun.sleep(5);expect(done).toBe(false);const event=socket.sent[0];expect(event.item.id.length).toBeLessThanOrEqual(32);expect(event.item.role).toBe('user');expect(event.item.content[0].text).toContain('untrusted');
  socket.onmessage({data:JSON.stringify({type:'conversation.item.added',item:{id:'other'}})});await Bun.sleep(5);expect(done).toBe(false);
  socket.onmessage({data:JSON.stringify({type:'conversation.item.added',item:{id:event.item.id}})});const connection=await pending;expect(done).toBe(true);await connection.close();
 }finally{abort.abort();globalThis.fetch=originalFetch;globalThis.WebSocket=OriginalSocket;}
});

// Byte-identical guard for the production session config (KO-1). Copied from the inline object before it moved into
// realtimeSessionConfig; a change here is a change to every OpenAI voice session.
const GOLDEN_CONVERSATION='{"type":"realtime","model":"gpt-realtime-2.1","instructions":"fixture instructions","output_modalities":["audio"],"max_output_tokens":1024,"audio":{"input":{"transcription":{"model":"gpt-transcribe","prompt":"한국어와 English가 섞인 업무 대화. 아젠투지(AgentsToZ)와 워크룸 AI 이름(클로드, 코덱스, 헤르메스, 안티그래비티)을 자주 부릅니다. Preserve English terms: AgentsToZ, OPS, Workroom, OpenAI, Gemini, Codex, Claude, Hermes, Antigravity, agy, Realtime API, commit, push, pull, worktree, TestFlight."},"noise_reduction":{"type":"near_field"},"turn_detection":{"type":"semantic_vad","eagerness":"auto","create_response":true,"interrupt_response":true}},"output":{"voice":"marin"}},"tools":[{"type":"function","name":"read_workroom","description":"fixture","parameters":{"type":"object"}}]}';
const GOLDEN_DICTATION='{"type":"realtime","model":"gpt-realtime-2.1","instructions":"fixture instructions","output_modalities":["audio"],"max_output_tokens":1024,"audio":{"input":{"transcription":{"model":"gpt-transcribe","prompt":"한국어와 English가 섞인 업무 대화. 아젠투지(AgentsToZ)와 워크룸 AI 이름(클로드, 코덱스, 헤르메스, 안티그래비티)을 자주 부릅니다. Preserve English terms: AgentsToZ, OPS, Workroom, OpenAI, Gemini, Codex, Claude, Hermes, Antigravity, agy, Realtime API, commit, push, pull, worktree, TestFlight."},"noise_reduction":{"type":"near_field"},"turn_detection":{"type":"semantic_vad","eagerness":"auto","create_response":false,"interrupt_response":true}},"output":{"voice":"marin"}},"tools":[]}';
const sessionInput=(mode:'conversation'|'dictation')=>({model:'gpt-realtime-2.1',instructions:'fixture instructions',voice:'marin',mode,tools:[{name:'read_workroom',description:'fixture',parameters:{type:'object'}}]});
test('the default Realtime session config is byte-identical to the production golden',async()=>{
 const {realtimeSessionConfig,REALTIME_TRANSCRIPTION_PROMPT}=await import('../src/voiceRealtimeProvider');
 expect(JSON.stringify(realtimeSessionConfig(sessionInput('conversation')))).toBe(GOLDEN_CONVERSATION);
 expect(JSON.stringify(realtimeSessionConfig(sessionInput('dictation')))).toBe(GOLDEN_DICTATION);
 const config=realtimeSessionConfig(sessionInput('conversation')) as any;
 expect(config.audio.input.transcription.prompt).toBe(REALTIME_TRANSCRIPTION_PROMPT);
 for(const key of ['language','languages','keywords'])expect(config.audio.input.transcription[key]).toBeUndefined();
 expect(config.audio.input.noise_reduction).toEqual({type:'near_field'});
 // An empty override object changes nothing either.
 expect(JSON.stringify(realtimeSessionConfig(sessionInput('conversation'),{}))).toBe(GOLDEN_CONVERSATION);
});
test('connect sends exactly the golden default config',async()=>{
 const originalFetch=globalThis.fetch,OriginalSocket=globalThis.WebSocket;let body:FormData|undefined;
 class Socket {static OPEN=1;readyState=1;onopen:any;onmessage:any;onclose:any;onerror:any;constructor(){queueMicrotask(()=>this.onopen?.({}));}send(){}close(){}}
 try{globalThis.WebSocket=Socket as any;globalThis.fetch=(async(url:any,o:any)=>{if(String(url).endsWith('/hangup'))return new Response(null);body=o.body;return new Response('v=0\r\nfixture',{status:201,headers:{location:'/v1/realtime/calls/rtc_fixture'}});}) as any;
  const connection=await connectVoiceRealtime({key:'fixture',sdp:'v=0',signal:new AbortController().signal,onEvent:()=>{},onDisconnect:()=>{},...sessionInput('conversation')});
  expect(body!.get('session')).toBe(GOLDEN_CONVERSATION);await connection.close();
 }finally{globalThis.fetch=originalFetch;globalThis.WebSocket=OriginalSocket;}
});
test('harness-only audio overrides change only what they name',async()=>{
 const {realtimeSessionConfig,realtimeAudioConditionSummary}=await import('../src/voiceRealtimeProvider');
 const off=realtimeSessionConfig(sessionInput('conversation'),{noiseReduction:null}) as any;
 expect(off.audio.input.noise_reduction).toBeNull();expect('noise_reduction' in off.audio.input).toBe(true);
 expect((realtimeSessionConfig(sessionInput('conversation'),{noiseReduction:'far_field'}) as any).audio.input.noise_reduction).toEqual({type:'far_field'});
 const hinted=realtimeSessionConfig(sessionInput('conversation'),{transcription:{languages:['ko','en'],keywords:['아젠투지']}}) as any;
 expect(hinted.audio.input.transcription.languages).toEqual(['ko','en']);expect(hinted.audio.input.transcription.keywords).toEqual(['아젠투지']);
 expect(hinted.audio.input.noise_reduction).toEqual({type:'near_field'});
 expect(realtimeAudioConditionSummary(realtimeSessionConfig(sessionInput('conversation')))).toEqual({nr:'near_field',vad:'semantic_vad',eagerness:'auto',txModel:'gpt-transcribe',hints:'prompt'});
 expect(realtimeAudioConditionSummary(off).nr).toBe('off');expect(realtimeAudioConditionSummary(hinted).hints).toBe('prompt+languages+keywords');
});
test('the voice host never passes audio overrides and the wire cannot carry them',async()=>{
 const {VoiceSessionHost}=await import('../src/voiceSessionHost');const {normalizeVoiceRequest}=await import('../src/voiceSessionProtocol');
 const inputs:any[]=[];
 const binding={label:'fixture · codex',key:'fixed-fixture',validate:async()=>{},tools:[],run:async()=>({}),review:async()=>({label:'fixture · codex',send:async()=>{}})};
 const host=new VoiceSessionHost({wait:async()=>{},credentials:{status:()=>({configured:true,model:'gpt-realtime-2.1',voice:'marin'}),key:async()=>'fixture-key',configure:async()=>({configured:true})},bind:async()=>binding as any,provider:async (i:unknown)=>{inputs.push(i);return {sdp:'v=0',send:()=>{},close:async()=>{}};}} as any);
 try{
  const authority={owner:'local',active:()=>true};
  const prepared=await host.perform({action:'prepare',requestId:crypto.randomUUID(),target:{kind:'workroom',targetId:'project_fixture',sessionId:'terminal_fixture'},mode:'conversation',consent:true},authority);
  const sessionId=prepared.session!.id;
  await host.perform({action:'connect',requestId:crypto.randomUUID(),sessionId,sdp:'v=0'},authority);
  expect(inputs).toHaveLength(1);expect('audioOverrides' in inputs[0]).toBe(false);
  expect(()=>normalizeVoiceRequest({action:'connect',requestId:crypto.randomUUID(),sessionId,sdp:'v=0',audioOverrides:{noiseReduction:null}})).toThrow();
 }finally{await host.shutdown();}
});
