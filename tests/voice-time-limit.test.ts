import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {VoiceHistoryStore,type VoiceHistoryMeta} from '../src/voiceHistoryStore';
import {VoiceSessionHost,type VoiceResolvedTarget} from '../src/voiceSessionHost';
import {connectGeminiLive} from '../src/geminiLiveProvider';
import {VOICE_TIME_LIMIT_NOTICE} from '../src/voiceSessionProtocol';

/**
 * 2026-09-29 review: a Gemini conversation that reached the 15-minute limit was recorded incomplete.
 * The browser sends audio every ~43 ms, so the first request past the limit was media.append — not the
 * state poll or the 3-second timer — and the host rejected it as an error; the client then stopped with
 * interrupted:true and the host ended the session as failed.
 */
const roots:string[]=[],hosts:VoiceSessionHost[]=[];
afterEach(async()=>{await Promise.all(hosts.splice(0).map(host=>host.shutdown()));for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const authority={owner:'local',active:()=>true};
const request=(action:string,other:Record<string,unknown>={})=>({action,requestId:crypto.randomUUID(),...other});
const meta:VoiceHistoryMeta={id:'x',target:{kind:'workroom',targetId:'project_fixture',sessionId:'terminal_fixture'},binding:'b',memoryId:'m',label:'별빛 작업',createdAt:'',mode:'conversation',model:'g'};
const binding=():VoiceResolvedTarget=>({label:'별빛 작업',key:'limit-'+crypto.randomUUID(),validate:async()=>{},tools:[],run:async()=>null});

function store(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'voice-limit-')));roots.push(root);let key:Buffer|null=null;
  return new VoiceHistoryStore(join(root,'records'),{read:async()=>key?Buffer.from(key):null,create:async()=>{key=randomBytes(32);return Buffer.from(key);}});
}
/** A real host over the real encrypted store; the Gemini connection and the clock are scripted. */
function geminiHost(records:VoiceHistoryStore){
  let now=Date.parse('2026-09-29T00:00:00Z'),onEvent:(event:Record<string,unknown>)=>void=()=>{};const appended:string[]=[];
  const host=new VoiceSessionHost({now:()=>now,credentials:{status:()=>({configured:false}),key:async()=>'',configure:async()=>({})},
    history:{store:records,identity:async()=>({target:meta.target,binding:'b',memoryId:'m'}),review:async()=>''},
    gemini:{status:()=>({configured:true,model:'gemini-live-fixture'}),key:async()=>'k',configure:async()=>{},
      provider:async input=>{onEvent=input.onEvent;return {sdp:'',send:()=>{},appendAudio:data=>{appended.push(data);},endAudio:()=>{},readMedia:async()=>[],close:async()=>{}};}},
    bind:async()=>binding()});hosts.push(host);
  const start=async()=>{
    const id=(await host.perform(request('prepare',{provider:'gemini',target:meta.target,mode:'conversation',consent:true,recordConsent:true}),authority)).session!.id;
    await host.perform(request('media.connect',{sessionId:id}),authority);return id;
  };
  return {host,start,appended,event:(event:Record<string,unknown>)=>onEvent(event),pastLimit:()=>{now+=15*60_000+10;}};
}

test('Gemini: the first audio chunk past the limit ends the conversation normally and the record stays complete',async()=>{
  const records=store(),g=geminiHost(records),id=await g.start();
  g.event({type:'conversation.item.input_audio_transcription.completed',item_id:'gemini_0_in',transcript:'여기까지 정리해 줘'});
  g.pastLimit(); // the host's 3-second timer has not ticked yet
  const appended=await g.host.perform(request('media.append',{sessionId:id,audio:'AAAA'}),authority);
  expect(appended.session).toMatchObject({state:'ended',notice:VOICE_TIME_LIMIT_NOTICE});
  expect(appended.media).toEqual([]);
  expect(g.appended).toEqual([]); // nothing is streamed past the limit
  // The client's stop that follows (interrupted, as after an error) cannot turn it into a failure.
  expect((await g.host.perform(request('stop',{sessionId:id,interrupted:true}),authority)).session).toMatchObject({state:'ended',notice:VOICE_TIME_LIMIT_NOTICE});
  expect((await records.list()).sessions.find(session=>session.id===id)).toMatchObject({complete:true,turnCount:1});
  await records.assertRememberable(id);
});

test('Gemini: a media read past the limit ends it the same way, and later media requests see the end',async()=>{
  const records=store(),g=geminiHost(records),id=await g.start();
  g.pastLimit();
  expect(await g.host.perform(request('media.read',{sessionId:id}),authority)).toMatchObject({session:{state:'ended',notice:VOICE_TIME_LIMIT_NOTICE},media:[]});
  expect(await g.host.perform(request('media.append',{sessionId:id,audio:'AAAA'}),authority)).toMatchObject({session:{state:'ended'},media:[]});
  expect(await g.host.perform(request('media.end',{sessionId:id}),authority)).toMatchObject({session:{state:'ended'},media:[]});
  expect((await records.list()).sessions.find(session=>session.id===id)).toMatchObject({complete:true});
});

test('an interrupted stop that arrives past the limit is a normal end; before the limit it is still a failure',async()=>{
  const records=store(),g=geminiHost(records);
  const late=await g.start();g.pastLimit();
  expect((await g.host.perform(request('stop',{sessionId:late,interrupted:true}),authority)).session).toMatchObject({state:'ended',notice:VOICE_TIME_LIMIT_NOTICE});
  await records.assertRememberable(late);
  const other=geminiHost(records),early=await other.start();
  expect((await other.host.perform(request('stop',{sessionId:early,interrupted:true}),authority)).session!.state).toBe('failed');
  await expect(records.assertRememberable(early)).rejects.toThrow();
});

test('a failed conversation still rejects media requests',async()=>{
  const records=store();let valid=true;
  const host=new VoiceSessionHost({credentials:{status:()=>({configured:false}),key:async()=>'',configure:async()=>({})},history:{store:records,identity:async()=>({target:meta.target,binding:'b',memoryId:'m'}),review:async()=>''},
    gemini:{status:()=>({configured:true,model:'gemini-live-fixture'}),key:async()=>'k',configure:async()=>{},provider:async()=>({sdp:'',send:()=>{},appendAudio:()=>{},endAudio:()=>{},readMedia:async()=>[],close:async()=>{}})},
    bind:async()=>({...binding(),validate:async()=>{if(!valid)throw Error('changed');}})});hosts.push(host);
  const id=(await host.perform(request('prepare',{provider:'gemini',target:meta.target,mode:'conversation',consent:true,recordConsent:true}),authority)).session!.id;
  await host.perform(request('media.connect',{sessionId:id}),authority);
  valid=false;expect((await host.perform(request('state',{sessionId:id}),authority)).session!.state).toBe('failed');
  await expect(host.perform(request('media.append',{sessionId:id,audio:'AAAA'}),authority)).rejects.toThrow();
});

/** The Live socket as the host sees it. */
class LiveSocket {
  static OPEN=1;readyState=1;sent:any[]=[];onopen:any;onmessage:any;onerror:any;onclose:any;closed=0;
  constructor(){queueMicrotask(()=>this.onopen?.({}));}
  send(data:string){this.sent.push(JSON.parse(data));}
  close(){this.closed++;this.readyState=3;}
  emit(message:unknown){return this.onmessage?.({data:JSON.stringify(message)});}
}
async function liveHost(records:VoiceHistoryStore){
  let now=Date.parse('2026-09-29T00:00:00Z'),socket!:LiveSocket;
  const host=new VoiceSessionHost({now:()=>now,credentials:{status:()=>({configured:false}),key:async()=>'',configure:async()=>({})},
    history:{store:records,identity:async()=>({target:meta.target,binding:'b',memoryId:'m'}),review:async()=>''},
    gemini:{status:()=>({configured:true,model:'gemini-live-fixture'}),key:async()=>'k',configure:async()=>{},provider:input=>connectGeminiLive(input,()=>{socket=new LiveSocket();return socket as unknown as WebSocket;})},
    bind:async()=>binding()});hosts.push(host);
  const id=(await host.perform(request('prepare',{provider:'gemini',target:meta.target,mode:'conversation',consent:true,recordConsent:true}),authority)).session!.id;
  const connecting=host.perform(request('media.connect',{sessionId:id}),authority);
  for(const deadline=Date.now()+2000;Date.now()<deadline&&!socket?.sent.length;)await Bun.sleep(5);
  await socket.emit({setupComplete:{}});await connecting;
  return {host,id,socket,pastLimit:()=>{now+=15*60_000+10;}};
}

test('Gemini: pressing stop before turnComplete keeps what was said so far, and the record is complete',async()=>{
  const records=store(),live=await liveHost(records);
  await live.socket.emit({serverContent:{inputTranscription:{text:'여기까지 '}}});
  await live.socket.emit({serverContent:{inputTranscription:{text:'정리해 줘'}}});
  await live.socket.emit({serverContent:{outputTranscription:{text:'네, 지금까지'}}});
  expect((await live.host.perform(request('stop',{sessionId:live.id}),authority)).session!.state).toBe('ended');
  const saved=(await records.list()).sessions.find(session=>session.id===live.id)!;
  expect(saved).toMatchObject({complete:true,turnCount:2});
  const first=await records.read(live.id);expect(first.turn).toMatchObject({role:'user',text:'여기까지 정리해 줘'});
  expect((await records.read(live.id,first.nextCursor!)).turn).toMatchObject({role:'assistant',text:'네, 지금까지'});
});

test('Gemini: the time limit also keeps an unfinished turn',async()=>{
  const records=store(),live=await liveHost(records);
  await live.socket.emit({serverContent:{inputTranscription:{text:'마지막 부탁'}}});
  live.pastLimit();
  expect((await live.host.perform(request('media.append',{sessionId:live.id,audio:'AAAA'}),authority)).session).toMatchObject({state:'ended',notice:VOICE_TIME_LIMIT_NOTICE});
  expect((await records.list()).sessions.find(session=>session.id===live.id)).toMatchObject({complete:true,turnCount:1});
  expect((await records.read(live.id)).turn?.text).toBe('마지막 부탁');
});
