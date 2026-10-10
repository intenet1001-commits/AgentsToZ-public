import {expect,test} from 'bun:test';
import {connectGeminiLive} from '../src/geminiLiveProvider';

class SocketFixture {
  readyState=1;onopen:null|(()=>void)=null;onmessage:null|((event:{data:string})=>void)=null;onerror:null|(()=>void)=null;onclose:null|(()=>void)=null;
  sent:any[]=[];closed=0;send(value:string){this.sent.push(JSON.parse(value));}close(){this.closed++;this.readyState=3;}
  emit(value:unknown){this.onmessage?.({data:JSON.stringify(value)});}
  emitBinary(value:unknown){this.onmessage?.({data:new TextEncoder().encode(JSON.stringify(value)).buffer} as any);}
}
const input=(events:Record<string,any>[],abort=new AbortController())=>({key:'secret',model:'gemini-live-fixture',voice:'',sdp:'',mode:'conversation' as const,instructions:'trusted host rules',context:'{"project":"fixture"}',tools:[{name:'read_workroom',description:'read',parameters:{type:'object'}}],signal:abort.signal,onEvent:(event:Record<string,any>)=>events.push(event),onDisconnect:()=>{}});

test('Gemini Live keeps context in host setup, streams bounded PCM and translates transcripts',async()=>{
  const socket=new SocketFixture(),events:Record<string,any>[]=[];let url='';
  const pending=connectGeminiLive(input(events),value=>{url=value;return socket as unknown as WebSocket;});
  socket.onopen!();expect(url).toContain('?key=secret');expect(socket.sent[0].setup.systemInstruction.parts[0].text).toBe('trusted host rules');expect(socket.sent[0].setup.tools[0].functionDeclarations[0].name).toBe('read_workroom');
  socket.emit({setupComplete:{}});const connection=await pending;expect(socket.sent[1].clientContent.turnComplete).toBe(false);expect(socket.sent[1].clientContent.turns[0].parts[0].text).toContain('fixture');
  connection.appendAudio('AQI=');expect(socket.sent.at(-1)).toEqual({realtimeInput:{audio:{data:'AQI=',mimeType:'audio/pcm;rate=16000'}}});
  socket.emit({serverContent:{inputTranscription:{text:'안녕 OpenAI'},outputTranscription:{text:'안녕하세요'},modelTurn:{parts:[{inlineData:{mimeType:'audio/pcm;rate=24000',data:'AQIDBA=='}}]},turnComplete:true}});
  const media=await connection.readMedia();expect(media).toContainEqual({kind:'input-transcript',text:'안녕 OpenAI',final:true});expect(media).toContainEqual({kind:'output-transcript',text:'안녕하세요',final:true});expect(media).toContainEqual({kind:'audio',data:'AQIDBA=='});
  // Who listened is announced when the turn starts (host record routing), with the same ids as the finals.
  expect(events.map(event=>event.type)).toEqual(['conversation.item.added','conversation.item.added','conversation.item.input_audio_transcription.completed','response.output_audio_transcript.done']);
  expect(events.slice(0,2).map(event=>event.item.id).sort()).toEqual([events[2]!.item_id,events[3]!.item_id].sort());
  await connection.close();expect(socket.closed).toBe(1);
});

test('Gemini tool calls use only declared names and return host execution receipts',async()=>{
  const socket=new SocketFixture(),events:Record<string,any>[]=[];const pending=connectGeminiLive(input(events),()=>socket as unknown as WebSocket);socket.onopen!();socket.emitBinary({setupComplete:{}});const connection=await pending;
  socket.emit({toolCall:{functionCalls:[{id:'call_ok',name:'read_workroom',args:{limit:2}},{id:'call_bad',name:'shell',args:{}}]}});
  expect(events).toHaveLength(1);expect(events[0]).toMatchObject({call_id:'call_ok',name:'read_workroom'});
  connection.send({type:'conversation.item.create',item:{type:'function_call_output',call_id:'call_ok',output:'{"ok":true}'}});
  expect(socket.sent.at(-1)).toEqual({toolResponse:{functionResponses:[{id:'call_ok',name:'read_workroom',response:{result:{ok:true}}}]}});await connection.close();
});

test('Gemini Live: a silent note is context only (no spoken reply); a normal message still completes the turn',async()=>{
  const socket=new SocketFixture(),events:Record<string,any>[]=[];
  const pending=connectGeminiLive(input(events),()=>socket as unknown as WebSocket);
  socket.onopen!();socket.emit({setupComplete:{}});const connection=await pending;
  connection.send({type:'conversation.item.create',silent:true,item:{type:'message',role:'user',content:[{type:'input_text',text:'[화면 전환 · 명령 아님]'}]}});
  expect(socket.sent.at(-1).clientContent.turnComplete).toBe(false);
  connection.send({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text:'상태 알려줘'}]}});
  expect(socket.sent.at(-1).clientContent.turnComplete).toBe(true);
  // A turn's first parts claim it once; the next turn claims its own ids.
  socket.emit({serverContent:{inputTranscription:{text:'하나'}}});socket.emit({serverContent:{inputTranscription:{text:' 둘'}}});
  socket.emit({serverContent:{turnComplete:true}});socket.emit({serverContent:{outputTranscription:{text:'셋'}}});
  expect(events.filter(event=>event.type==='conversation.item.added').map(event=>event.item.id)).toEqual(['gemini_0_in','gemini_1_out']);
  await connection.close();
});
