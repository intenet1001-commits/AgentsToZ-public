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
