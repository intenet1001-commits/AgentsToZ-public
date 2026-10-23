import {afterEach,beforeEach,expect,test} from 'bun:test';
import {VoiceMediaClient} from '../src/voiceMediaClient';
import {localVoiceTransport} from '../src/voiceSessionClient';
import {VOICE_TIME_LIMIT_NOTICE,type VoiceRequest,type VoiceResponse,type VoiceSnapshot} from '../src/voiceSessionProtocol';

/** Just enough browser for both paths: a fake microphone, peer, data channel and audio context. No network. */
const saved:Record<string,PropertyDescriptor|undefined>={};
const globals=['window','document','RTCPeerConnection','isSecureContext','AudioContext'] as const;
let lastChannel:{readyState:string;onclose:null|(()=>void)}|null=null;
let lastPeer:{connectionState:string;onconnectionstatechange:null|(()=>void)}|null=null;
/** The Gemini client's audio graph: the last script processor receives fake microphone frames. */
class FakeAudioContext {
  static processor:null|{onaudioprocess:null|((event:unknown)=>void)}=null;
  sampleRate=48_000;currentTime=0;state='running';destination={};
  async resume(){}async close(){this.state='closed';}
  createGain(){return {gain:{value:1},connect(){},disconnect(){}};}
  createMediaStreamSource(){return {connect(){},disconnect(){}};}
  createAnalyser(){return {fftSize:0,connect(){},disconnect(){},getFloatTimeDomainData(){}};}
  createScriptProcessor(){const node={onaudioprocess:null,connect(){},disconnect(){}};FakeAudioContext.processor=node;return node;}
  createBuffer(){return {duration:0,getChannelData:()=>new Float32Array(1)};}
  createBufferSource(){return {buffer:null,onended:null,connect(){},start(){},stop(){}};}
}
beforeEach(()=>{
  for(const name of globals)saved[name]=Object.getOwnPropertyDescriptor(globalThis,name);
  saved.mediaDevices=Object.getOwnPropertyDescriptor(navigator,'mediaDevices');
  const target=new EventTarget();
  Object.defineProperty(globalThis,'window',{value:Object.assign(target,{agentstozNativeWorkroom:false}),configurable:true,writable:true});
  Object.defineProperty(globalThis,'document',{value:{hidden:false,addEventListener(){},removeEventListener(){},createElement:()=>({autoplay:false,muted:false,srcObject:null,setAttribute(){},pause(){},remove(){},play:async()=>{}})},configurable:true,writable:true});
  Object.defineProperty(globalThis,'isSecureContext',{value:true,configurable:true,writable:true});
  Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>({getTracks:()=>[{label:'fixture mic',onended:null,stop(){}}]})},configurable:true});
  class Channel {readyState='open';onmessage:unknown=null;onclose:null|(()=>void)=null;addEventListener(){}removeEventListener(){}send(){}close(){this.readyState='closed';}}
  class Peer {constructor(){lastPeer=this;}connectionState='connected';ontrack:unknown=null;onconnectionstatechange:null|(()=>void)=null;addTrack(){}addTransceiver(){return {sender:{track:null,replaceTrack:async()=>{}}};}getSenders(){return [{track:null,replaceTrack:async()=>{}}];}createDataChannel(){const channel=new Channel();lastChannel=channel;return channel;}
    async createOffer(){return {type:'offer',sdp:'v=0'};}async setLocalDescription(){}async setRemoteDescription(){}close(){this.connectionState='closed';}}
  Object.defineProperty(globalThis,'RTCPeerConnection',{value:Peer,configurable:true,writable:true});
  Object.defineProperty(globalThis,'AudioContext',{value:FakeAudioContext,configurable:true,writable:true});
  lastChannel=null;FakeAudioContext.processor=null;
});
afterEach(()=>{
  for(const name of globals){const descriptor=saved[name];if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete (globalThis as Record<string,unknown>)[name];}
  if(saved.mediaDevices)Object.defineProperty(navigator,'mediaDevices',saved.mediaDevices);else delete (navigator as unknown as Record<string,unknown>).mediaDevices;
});

/**
 * A scripted host. `host.ended` is what the real host reports once its limit passed: every state and
 * media answer carries the ended session with the time-limit notice.
 */
function transport(options:{provider?:'openai'|'gemini';connectDelay?:number;appendThrows?:boolean;stateActive?:boolean;olderMac?:boolean}={}){
  const requests:(VoiceRequest&{at:number})[]=[];
  const host={ended:false,preparedAt:0};
  const session:VoiceSnapshot={id:'voice_client_fixture',state:'prepared',mode:'conversation',provider:options.provider??'openai',label:'AgentsToZ OPS',draft:null,notice:'준비 중',expiresAt:Date.now()+900_000,recording:{state:'saved',savedTurns:1,message:'음성 발언을 내가 한 말에 기록합니다.'}};
  const current=():VoiceSnapshot=>host.ended?{...session,state:'ended',notice:VOICE_TIME_LIMIT_NOTICE}:{...session,state:'active'};
  const send=async(request:VoiceRequest):Promise<VoiceResponse>=>{
    requests.push({...request,at:Date.now()});
    if(request.action==='prepare'){host.preparedAt=Date.now();return {session};}
    if(request.action==='connect'){await Bun.sleep(options.connectDelay??0);return {sdp:'v=0',session:current()};}
    if(request.action==='media.connect')return {session:current(),media:[]};
    if(request.action==='media.read'){await Bun.sleep(20);return {session:current(),media:[]};}
    if(request.action==='media.append'){if(options.appendThrows&&host.ended)throw new Error('음성 연결이 만료되었거나 권한이 변경되었습니다. 다시 시작하세요.');return {session:current(),media:[]};}
    if(request.action==='state')return {session:options.stateActive?{...session,state:'active'}:current()};
    if(request.action==='stop')return {session:host.ended?current():{...session,state:request.interrupted?'failed':'ended',notice:'음성 대화를 종료했습니다. 워크룸 작업은 유지됩니다.'}};
    // An older Mac rejects the dock's requests exactly as normalizeVoiceRequest does for an unknown action.
    if(['caption','partners','partner'].includes(request.action)&&options.olderMac)throw new Error('지원하지 않는 음성 요청입니다.');
    // An older Mac knows `say` but not its # 언급 / @ 호출 keys.
    if(request.action==='say'){if(options.olderMac&&(request.references||request.route))throw new Error('지원하지 않는 음성 요청입니다.');return {session:current()};}
    if(request.action==='caption')return {caption:{text:request.text!,translation:/[가-힣]/.test(request.text!)?'EN:'+request.text:'KO:'+request.text,source:/[가-힣]/.test(request.text!)?'ko':'en'}};
    if(request.action==='partners')return {session:current(),partners:[{kind:'ops',label:'AgentsToZ OPS'},{kind:'workroom',label:'vibe2',targetId:'target_vibe2_fixture',sessionId:'ai_vibe2_fixture',agent:'claude'}]};
    if(request.action==='partner'){const p=request.partner!;return {session:{...current(),activeTarget:p.kind==='ops'?{kind:'ops',label:'AgentsToZ OPS'}:{kind:'workroom',label:'vibe2',targetId:p.targetId,sessionId:p.kind==='workroom'?p.sessionId:'ai_opened_fixture',agent:p.kind==='project'&&p.agent?p.agent:'claude'}}};}
    throw new Error('unexpected '+request.action);
  };
  const of=(action:string)=>requests.filter(request=>request.action===action);
  return {send,requests,host,stops:()=>of('stop'),of};
}
async function until(check:()=>boolean,what:string,ms=3000){for(const deadline=Date.now()+ms;Date.now()<deadline;await Bun.sleep(5))if(check())return;throw new Error('timed out waiting for '+what);}
const frame={inputBuffer:{getChannelData:()=>new Float32Array(2048).fill(0.1)}};

test('a typed route response from an ended voice session cannot change its replacement session',async()=>{
  const client=new VoiceMediaClient(),old=transport(),next=transport();
  let reply!:(value:VoiceResponse)=>void;
  const send:typeof old.send=request=>request.action==='say'?new Promise(resolve=>{reply=resolve;}):old.send(request);
  await client.start('old',{kind:'ops'},'conversation',send);
  const pending=client.sendText('이전 프로젝트 지시',[],'target_old');
  await client.stop();await client.start('new',{kind:'ops'},'conversation',next.send);
  reply({session:{...client.snapshot().session!,label:'OLD',activeTarget:{kind:'ops',label:'OLD'}}});
  await pending;
  expect(client.snapshot().owner).toBe('new');
  expect(client.snapshot().session?.label).not.toBe('OLD');
  expect(client.snapshot().captions).toEqual([]);
  await client.stop();
});

test('an old unsupported caption reply cannot disable translations in a new voice session',async()=>{
  const client=new VoiceMediaClient(),old=transport(),next=transport();
  let rejectCaption!:(error:Error)=>void;
  const send:typeof old.send=request=>request.action==='caption'?new Promise((_resolve,reject)=>{rejectCaption=reject;}):old.send(request);
  await client.start('old',{kind:'ops'},'conversation',send);await client.sendText('첫 대화');
  await client.stop();await client.start('new',{kind:'ops'},'conversation',next.send);
  rejectCaption(Error('지원하지 않는 음성 요청입니다.'));await Bun.sleep(0);
  await client.sendText('두 번째 대화');
  await until(()=>client.snapshot().captions[0]?.state!=='translating','caption settles');
  expect(client.snapshot().captions[0]?.state).toBe('translated');
  await client.stop();
});

test('double microphone resume coalesces permission requests and releases a cancelled acquisition',async()=>{
  const client=new VoiceMediaClient(),wire=transport();
  await client.start('owner',{kind:'ops'},'conversation',wire.send);client.finishInput();
  let acquire!:(stream:MediaStream)=>void,calls=0,stops=0;
  Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:()=>{calls++;return new Promise(resolve=>{acquire=resolve;});}},configurable:true});
  const first=client.resumeInput(),second=client.resumeInput();
  client.finishInput();
  acquire({getTracks:()=>[{stop(){stops++;}}]} as unknown as MediaStream);
  await Promise.all([first,second]);
  expect(calls).toBe(1);expect(stops).toBe(1);expect(client.snapshot().microphone).toBe(false);
  await client.stop();
});

test('ending the same voice session twice sends one host stop',async()=>{
  const client=new VoiceMediaClient(),wire=transport();
  await client.start('owner',{kind:'ops'},'conversation',wire.send);
  await Promise.all([client.stop(),client.stop()]);
  expect(wire.stops()).toHaveLength(1);
});

test('a transient host-state failure recovers the same voice session without replaying prepare or input',async()=>{
  const client=new VoiceMediaClient({conversationMs:60_000,dictationMs:60_000,initialPollMs:10,retryMs:25}),wire=transport();let reads=0;
  const send:typeof wire.send=request=>{if(request.action==='state'&&++reads===1)return Promise.reject(new TypeError('Load failed'));return wire.send(request);};
  await client.start('owner',{kind:'ops'},'conversation',send);
  await until(()=>!!client.snapshot().connectionNotice,'recovery notice');
  expect(client.snapshot().microphone).toBe(true);
  await until(()=>reads===2,'state recovery');
  expect(client.snapshot().connectionNotice).toBe('');expect(client.snapshot().phase).toBe('listening');
  expect(wire.of('prepare')).toHaveLength(1);expect(wire.stops()).toHaveLength(0);
  await client.stop();
});

test('host-state recovery has a fixed retry budget and never retries a permission refusal',async()=>{
  for(const error of [new TypeError('Load failed'),Error('권한이 변경되었습니다.')]){
    const client=new VoiceMediaClient({conversationMs:60_000,dictationMs:60_000,initialPollMs:10,retryMs:10}),wire=transport();let reads=0;
    const send:typeof wire.send=request=>{if(request.action==='state'){reads++;return Promise.reject(error);}return wire.send(request);};
    await client.start('owner',{kind:'ops'},'conversation',send);
    await until(()=>client.snapshot().phase==='failed','bounded failure');
    expect(reads).toBe(error instanceof TypeError?3:1);expect(wire.stops()).toHaveLength(1);
    expect(client.snapshot().microphone).toBe(false);
  }
});

test('a brief WebRTC disconnect keeps its peer and microphone and clears the recovery notice',async()=>{
  const client=new VoiceMediaClient({conversationMs:60_000,dictationMs:60_000,mediaGraceMs:25}),wire=transport();
  await client.start('owner',{kind:'ops'},'conversation',wire.send);
  lastPeer!.connectionState='disconnected';lastPeer!.onconnectionstatechange!();
  expect(client.snapshot().connectionNotice).toContain('복구');
  lastPeer!.connectionState='connected';lastPeer!.onconnectionstatechange!();await Bun.sleep(35);
  expect(client.snapshot().phase).toBe('listening');expect(client.snapshot().microphone).toBe(true);
  expect(client.snapshot().connectionNotice).toBe('');expect(wire.stops()).toHaveLength(0);
  await client.stop();
});

// Replaces the test that set a 40 ms client limit counted from connect: the host's limit is counted
// from prepare, so in production the host always expired first and that client path never ran.
test('the client ends cleanly just before the host limit, counted from the prepared session, not from connect',async()=>{
  const client=new VoiceMediaClient({conversationMs:600,dictationMs:600,marginMs:100}),wire=transport({connectDelay:300});
  await client.start('owner-fixture',{kind:'ops'},'conversation',wire.send,true,'openai');
  expect(client.snapshot().phase).toBe('listening');
  await until(()=>wire.stops().length>0,'the client stop');
  const stop=wire.stops()[0]!;
  // The host limit is 600 ms after prepare; the client stops ~100 ms before it (not 600 ms after connect).
  expect(stop.at-wire.host.preparedAt).toBeLessThan(600);
  expect(stop.at-wire.host.preparedAt).toBeGreaterThanOrEqual(450);
  expect(stop.interrupted).toBeUndefined();
  await until(()=>client.snapshot().session?.state==='ended','the ended session');
  expect(client.snapshot()).toMatchObject({phase:'ended',error:''});
  expect(client.snapshot().session).toMatchObject({state:'ended',notice:VOICE_TIME_LIMIT_NOTICE});
});

test('OpenAI: a data channel that closes because the host ended at its limit is a normal end, not an error',async()=>{
  const client=new VoiceMediaClient({conversationMs:60_000,dictationMs:60_000}),wire=transport();
  await client.start('owner-fixture',{kind:'ops'},'conversation',wire.send,true,'openai');
  wire.host.ended=true;lastChannel!.onclose!(); // the host hung up the provider at its limit
  await until(()=>wire.stops().length>0,'the client stop');
  expect(wire.of('state').length).toBeGreaterThan(0); // it asked the host before calling it a failure
  expect(wire.stops()[0]!.interrupted).toBeUndefined();
  await until(()=>client.snapshot().phase!=='listening','the end');
  expect(client.snapshot()).toMatchObject({phase:'ended',error:''});
  expect(client.snapshot().session).toMatchObject({state:'ended',notice:VOICE_TIME_LIMIT_NOTICE});
});

test('OpenAI: a data channel that closes while the host conversation is still active is a failure',async()=>{
  const client=new VoiceMediaClient({conversationMs:60_000,dictationMs:60_000}),wire=transport();
  await client.start('owner-fixture',{kind:'ops'},'conversation',wire.send,true,'openai');
  lastChannel!.onclose!();
  await until(()=>wire.stops().length>0,'the client stop');
  expect(wire.stops()[0]!.interrupted).toBe(true);
  expect(client.snapshot()).toMatchObject({phase:'failed',error:'음성 데이터 연결이 종료되었습니다.'});
});

test('the project picker reads later pages and falls back to searchable first-page results on an older host',async()=>{
  const modern=new VoiceMediaClient({conversationMs:60_000,dictationMs:60_000}),wire=transport();
  const send=async(request:VoiceRequest):Promise<VoiceResponse>=>{
    if(request.action==='projects.page')return {projectPage:{projects:[{id:request.offset?'target_project_13':'target_project_01',label:request.offset?'Project 13':'Project 01'}],total:13,nextOffset:request.offset?null:12}};
    return wire.send(request);
  };
  await modern.start('owner-fixture',{kind:'ops'},'conversation',send,true,'openai');
  expect((await modern.searchProjectsPage())?.nextOffset).toBe(12);
  expect((await modern.searchProjectsPage('',12))?.projects[0]?.label).toBe('Project 13');
  await modern.stop();

  const older=new VoiceMediaClient({conversationMs:60_000,dictationMs:60_000}),oldWire=transport();
  const oldSend=async(request:VoiceRequest):Promise<VoiceResponse>=>{
    if(request.action==='projects.page')throw Error('지원하지 않는 음성 요청입니다.');
    if(request.action==='projects')return {projects:[{id:'target_project_01',label:'Project 01'}]};
    return oldWire.send(request);
  };
  await older.start('owner-fixture',{kind:'ops'},'conversation',oldSend,true,'openai');
  expect(await older.searchProjectsPage('project')).toMatchObject({legacy:true,total:1,nextOffset:null});
  await older.stop();
});

test('Gemini: an audio answer that says the host ended stops the stream cleanly, once',async()=>{
  const client=new VoiceMediaClient({conversationMs:60_000,dictationMs:60_000}),wire=transport({provider:'gemini',stateActive:true});
  await client.start('owner-fixture',{kind:'ops'},'conversation',wire.send,true,'gemini');
  expect(client.snapshot().phase).toBe('listening');
  wire.host.ended=true;FakeAudioContext.processor!.onaudioprocess!(frame);
  await until(()=>wire.stops().length>0,'the client stop',1500);
  expect(wire.stops()[0]!.interrupted).toBeUndefined();
  expect(client.snapshot()).toMatchObject({phase:'ended',error:''});
  expect(client.snapshot().session).toMatchObject({state:'ended',notice:VOICE_TIME_LIMIT_NOTICE});
  const appended=wire.of('media.append').length;FakeAudioContext.processor!.onaudioprocess?.(frame);await Bun.sleep(60);
  expect(wire.of('media.append').length).toBe(appended); // nothing more is streamed
  expect(wire.stops()).toHaveLength(1);
});

test('Gemini: a media error at the limit (an older host rejects the chunk) still ends cleanly once the host says so',async()=>{
  const client=new VoiceMediaClient({conversationMs:60_000,dictationMs:60_000}),wire=transport({provider:'gemini',appendThrows:true});
  await client.start('owner-fixture',{kind:'ops'},'conversation',wire.send,true,'gemini');
  wire.host.ended=true;FakeAudioContext.processor!.onaudioprocess!(frame);
  await until(()=>wire.stops().length>0,'the client stop',1500);
  expect(wire.stops()[0]!.interrupted).toBeUndefined();
  expect(client.snapshot()).toMatchObject({phase:'ended',error:''});
  expect(client.snapshot().session).toMatchObject({notice:VOICE_TIME_LIMIT_NOTICE});
});

test('a real failure still stops as interrupted so the host does not claim a complete record',async()=>{
  const client=new VoiceMediaClient({conversationMs:60_000,dictationMs:60_000}),wire=transport();
  await client.start('owner-fixture',{kind:'ops'},'conversation',wire.send,true,'openai');
  await client.stop('음성 네트워크 연결이 끊겼습니다.');
  expect(wire.stops()).toHaveLength(1);expect(wire.stops()[0]!.interrupted).toBe(true);
  expect(client.snapshot()).toMatchObject({phase:'failed',error:'음성 네트워크 연결이 끊겼습니다.'});
  // A person pressing 「음성 종료」 is a clean stop.
  const clean=new VoiceMediaClient({conversationMs:60_000,dictationMs:60_000}),other=transport();
  await clean.start('owner-fixture',{kind:'ops'},'conversation',other.send,true,'openai');
  await clean.stop();
  expect(other.stops()[0]!.interrupted).toBeUndefined();expect(clean.snapshot().phase).toBe('ended');
});

/** The provider's data channel, as the OpenAI path hears it. */
const say=(event:Record<string,unknown>)=>(lastChannel as unknown as {onmessage:(e:{data:string})=>void}).onmessage({data:JSON.stringify(event)});

test('subtitles: each finished line shows what was said and, by default, its translation',async()=>{
  const client=new VoiceMediaClient({conversationMs:60_000,dictationMs:60_000}),wire=transport();
  await client.start('owner-fixture',{kind:'ops'},'conversation',wire.send,true,'openai');
  say({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'테스트 돌려 줘'});
  say({type:'response.output_audio_transcript.done',item_id:'a1',transcript:'Running the tests now.'});
  await until(()=>client.snapshot().captions.every(line=>line.state==='translated'),'both translations');
  expect(client.snapshot().captions).toEqual([
    {id:'u1',role:'user',text:'테스트 돌려 줘',source:'ko',translation:'EN:테스트 돌려 줘',state:'translated'},
    {id:'a1',role:'assistant',text:'Running the tests now.',source:'en',translation:'KO:Running the tests now.',state:'translated'},
  ]);
  // The same item twice (a retried event) is one line.
  say({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'테스트 돌려 줘'});
  expect(client.snapshot().captions).toHaveLength(2);
  await client.stop();
});

test('subtitles: 원문 only asks for no translation, 끄기 shows nothing, and an older Mac falls back to 원문 quietly',async()=>{
  const client=new VoiceMediaClient({conversationMs:60_000,dictationMs:60_000}),wire=transport();
  await client.start('owner-fixture',{kind:'ops'},'conversation',wire.send,true,'openai');
  client.setCaptionMode('original');
  say({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'커밋해 줘'});
  expect(client.snapshot().captions).toEqual([expect.objectContaining({text:'커밋해 줘',translation:null,state:'original'})]);
  client.setCaptionMode('off');
  say({type:'conversation.item.input_audio_transcription.completed',item_id:'u2',transcript:'푸시해 줘'});
  expect(client.snapshot().captions).toEqual([]);
  expect(wire.of('caption')).toHaveLength(0);
  client.setCaptionMode('bilingual');await client.stop();

  const older=new VoiceMediaClient({conversationMs:60_000,dictationMs:60_000}),old=transport({olderMac:true});
  await older.start('owner-fixture',{kind:'ops'},'conversation',old.send,true,'openai');
  say({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'안녕'});
  await until(()=>older.snapshot().captions[0]?.state==='original','the fallback');
  expect(older.snapshot().error).toBe('');
  say({type:'conversation.item.input_audio_transcription.completed',item_id:'u2',transcript:'다시'});
  expect(old.of('caption')).toHaveLength(1); // it stops asking after the first refusal
  await older.stop();
});

test('subtitles: Gemini finished lines get the same treatment',async()=>{
  const client=new VoiceMediaClient({conversationMs:60_000,dictationMs:60_000}),wire=transport({provider:'gemini',stateActive:true});
  await client.start('owner-fixture',{kind:'ops'},'conversation',wire.send,true,'gemini');
  (client as unknown as {geminiEvent:(e:unknown)=>void}).geminiEvent({kind:'input-transcript',text:'빌드',final:false});
  (client as unknown as {geminiEvent:(e:unknown)=>void}).geminiEvent({kind:'input-transcript',text:'빌드해 줘',final:true});
  await until(()=>client.snapshot().captions[0]?.state==='translated','the Gemini line');
  expect(client.snapshot().captions).toEqual([expect.objectContaining({role:'user',text:'빌드해 줘',translation:'EN:빌드해 줘'})]);
  await client.stop();
});

test('the dock learns who can answer, and a tap switches the conversation partner',async()=>{
  const client=new VoiceMediaClient({conversationMs:60_000,dictationMs:60_000}),wire=transport();
  await client.start('owner-fixture',{kind:'ops'},'conversation',wire.send,true,'openai');
  await until(()=>client.snapshot().partners!==null,'the partner list');
  expect(client.snapshot().partners!.map(p=>p.label)).toEqual(['AgentsToZ OPS','vibe2']);
  await client.switchPartner({kind:'workroom',targetId:'target_vibe2_fixture',sessionId:'ai_vibe2_fixture'});
  expect(client.snapshot().session!.activeTarget).toMatchObject({kind:'workroom',label:'vibe2',agent:'claude'});
  expect(wire.of('partner')).toHaveLength(1);
  await client.stop();
  // A workroom-fixed voice never asks for partners.
  const fixed=new VoiceMediaClient({conversationMs:60_000,dictationMs:60_000}),other=transport();
  await fixed.start('owner-fixture',{kind:'workroom',targetId:'target_vibe2_fixture',sessionId:'ai_vibe2_fixture'},'conversation',other.send,true,'openai');
  await Bun.sleep(30);expect(other.of('partners')).toHaveLength(0);
  await fixed.stop();
});

test('an older Mac: the dock hides the list and a tap explains that voice still switches',async()=>{
  const client=new VoiceMediaClient({conversationMs:60_000,dictationMs:60_000}),wire=transport({olderMac:true});
  await client.start('owner-fixture',{kind:'ops'},'conversation',wire.send,true,'openai');
  await until(()=>client.snapshot().partnersSupported===false,'the older-Mac answer');
  expect(client.snapshot().partners).toBeNull();
  await expect(client.switchPartner({kind:'ops'})).rejects.toThrow(/업데이트/);
  await client.stop();
});

test('a one-off voice error clears once voice works again; one that needs the person stays',async()=>{
  const client=new VoiceMediaClient({conversationMs:60_000,dictationMs:60_000}),wire=transport();
  await client.start('owner-fixture',{kind:'ops'},'conversation',wire.send,true,'openai');
  say({type:'conversation.item.input_audio_transcription.failed',item_id:'u1'});
  expect(client.snapshot().error).toContain('전사하지 못했습니다');
  say({type:'conversation.item.input_audio_transcription.completed',item_id:'u2',transcript:'다시 말할게'});
  expect(client.snapshot().error).toBe('');
  say({type:'error',error:{code:'server_error'}});expect(client.snapshot().error).toContain('음성 제공자');
  say({type:'response.created'});expect(client.snapshot().error).toBe('');
  await client.stop();
});

test('a partner tap reads the list once, not twice',async()=>{
  const client=new VoiceMediaClient({conversationMs:60_000,dictationMs:60_000}),wire=transport();
  await client.start('owner-fixture',{kind:'ops'},'conversation',wire.send,true,'openai');
  await until(()=>client.snapshot().partners!==null,'the partner list');
  const before=wire.of('partners').length;
  await client.switchPartner({kind:'workroom',targetId:'target_vibe2_fixture',sessionId:'ai_vibe2_fixture'});
  await Bun.sleep(30);
  expect(wire.of('partners').length).toBe(before+1);
  await client.stop();
});

test('# 언급 reaches an older Mac as plain words; an @ 호출 never falls back to whoever answers now',async()=>{
  const client=new VoiceMediaClient({conversationMs:60_000,dictationMs:60_000}),wire=transport({olderMac:true,stateActive:true});
  await client.start('owner-fixture',{kind:'ops'},'conversation',wire.send,true,'openai');
  await client.sendText('#vibe2 상태 봐 줘',['target_vibe2_fixture']);
  expect(wire.of('say').map(r=>[r.text,r.references])).toEqual([['#vibe2 상태 봐 줘',['target_vibe2_fixture']],['#vibe2 상태 봐 줘',undefined]]);
  await expect(client.sendText('빌드해 줘',[],'target_vibe2_fixture')).rejects.toThrow(/업데이트하면 @ 호출/);
  expect(wire.of('say')).toHaveLength(3); // no plain retry for the @ 호출
  const fresh=transport({stateActive:true}),current=new VoiceMediaClient({conversationMs:60_000,dictationMs:60_000});
  await client.stop();await current.start('owner-fixture',{kind:'ops'},'conversation',fresh.send,true,'openai');
  await current.sendText('빌드해 줘',['target_a_fixture0'],'target_vibe2_fixture');
  expect(fresh.of('say')[0]).toMatchObject({text:'빌드해 줘',references:['target_a_fixture0'],route:'target_vibe2_fixture'});
  await current.stop();
});

test('a voice-routed Workroom opens once while the OPS partner remains selected',async()=>{
  const client=new VoiceMediaClient({conversationMs:60_000,dictationMs:60_000}),wire=transport({stateActive:true});
  const opened={kind:'workroom' as const,eventId:'opened_voice_fixture_1',label:'vibe2',targetId:'target_vibe2_fixture',sessionId:'ai_vibe2_fixture',agent:'codex' as const};
  const events:unknown[]=[];
  window.addEventListener('agentstoz:voice-workroom-opened',event=>events.push((event as CustomEvent).detail));
  const send:typeof wire.send=async request=>{
    const response=await wire.send(request);
    return request.action==='say'&&request.route&&response.session?{...response,session:{...response.session,activeTarget:{kind:'ops',label:'AgentsToZ OPS'},openedWorkroom:opened}}:response;
  };
  await client.start('owner-fixture',{kind:'ops'},'conversation',send,true,'openai');
  await client.sendText('테스트 돌려 줘',[],'target_vibe2_fixture');
  await client.sendText('결과 보여 줘',[],'target_vibe2_fixture');
  expect(events).toEqual([opened]);
  expect(client.snapshot().session?.activeTarget?.kind).toBe('ops');
  await client.stop();
});


test('local desktop stop releases microphone and speaker immediately but keeps its peer until host acknowledgement',async()=>{
 const client=new VoiceMediaClient(),wire=transport();let stopped=false,paused=false;const track={label:'fixture mic',onended:null,stop(){stopped=true;}};
 Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>({getTracks:()=>[track]})},configurable:true});
 const audio={autoplay:false,muted:false,srcObject:null as unknown,setAttribute(){},pause(){paused=true;},remove(){},play:async()=>{}};
 (document as any).createElement=()=>audio;
 let acknowledge!:(v:unknown)=>void;
 (window as any).__TAURI_INTERNALS__={invoke:async(_command:string,args:{body:VoiceRequest})=>{const body=await wire.send(args.body);return args.body.action==='stop'?new Promise(resolve=>{acknowledge=()=>resolve({status:200,body});}):{status:200,body};}};
 await client.start('local',{kind:'ops'},'conversation',localVoiceTransport);
 (lastPeer as any).ontrack({streams:[{}]});const peer=lastPeer!,channel=lastChannel!;
 const stopping=client.stop();
 try{expect(stopped).toBe(true);expect(paused).toBe(true);expect(client.snapshot().microphone).toBe(false);expect(peer.connectionState).toBe('connected');expect(channel.readyState).toBe('open');}
 finally{await until(()=>!!acknowledge,'host stop request');acknowledge(undefined);await stopping;}
 expect(peer.connectionState).toBe('closed');expect(channel.readyState).toBe('closed');expect(wire.stops()).toHaveLength(1);
});

function localDesktopHost(wire:ReturnType<typeof transport>,deferStop=false){
 let acknowledge:(()=>void)|undefined;
 (window as any).__TAURI_INTERNALS__={invoke:async(_command:string,args:{body:VoiceRequest})=>{const body=await wire.send(args.body);return deferStop&&args.body.action==='stop'?new Promise(resolve=>{acknowledge=()=>resolve({status:200,body});}):{status:200,body};}};
 return {ack:()=>acknowledge?.(),ready:()=>!!acknowledge};
}

test('remote transports still close their peer immediately even inside a desktop webview',async()=>{
 const client=new VoiceMediaClient(),wire=transport();(window as any).__TAURI_INTERNALS__={};let acknowledge!:(v:VoiceResponse)=>void;
 const send:typeof wire.send=request=>request.action==='stop'?new Promise(resolve=>{acknowledge=resolve;}):wire.send(request);
 await client.start('remote',{kind:'ops'},'conversation',send);const peer=lastPeer!;const stopping=client.stop();
 expect(peer.connectionState).toBe('closed');expect(client.snapshot().microphone).toBe(false);
 acknowledge({session:{...client.snapshot().session!,state:'ended'}});await stopping;
});

test('local error and background teardown never wait with an open peer',async()=>{
 for(const reason of ['error','background']){
  const client=new VoiceMediaClient(),wire=transport(),host=localDesktopHost(wire,true);
  await client.start(reason,{kind:'ops'},'conversation',localVoiceTransport);const peer=lastPeer!;
  const stopping=client.stop(reason==='error'?'network error':undefined,undefined,reason==='background');
  try{expect(peer.connectionState).toBe('closed');expect(client.snapshot().microphone).toBe(false);}
  finally{await until(host.ready,'immediate stop request');host.ack();await stopping;}
 }
});

test('an unacknowledged local stop is bounded and a late reply cannot change the next session',async()=>{
 const client=new VoiceMediaClient({conversationMs:60_000,dictationMs:60_000,localStopMs:20}),wire=transport(),old=localDesktopHost(wire,true);
 await client.start('old',{kind:'ops'},'conversation',localVoiceTransport);const peer=lastPeer!;const stopping=client.stop();expect(peer.connectionState).toBe('connected');
 await stopping;expect(peer.connectionState).toBe('closed');expect(client.snapshot().session?.notice).toContain('호스트의 종료 확인은 받지 못했습니다');
 localDesktopHost(transport());await client.start('new',{kind:'ops'},'conversation',localVoiceTransport);const replacement=lastPeer!;
 old.ack();await Bun.sleep(0);expect(client.snapshot().owner).toBe('new');expect(client.snapshot().phase).toBe('listening');expect(replacement.connectionState).toBe('connected');await client.stop();
});

test('starting another local session releases the previous closing peer without closing its replacement',async()=>{
 const client=new VoiceMediaClient(),old=localDesktopHost(transport(),true);
 await client.start('old',{kind:'ops'},'conversation',localVoiceTransport);const peer=lastPeer!;const stopping=client.stop();await until(old.ready,'old stop request');
 localDesktopHost(transport());await client.start('replacement',{kind:'ops'},'conversation',localVoiceTransport);const replacement=lastPeer!;await stopping;
 expect(peer.connectionState).toBe('closed');expect(replacement.connectionState).toBe('connected');old.ack();await Bun.sleep(0);expect(client.snapshot().owner).toBe('replacement');expect(replacement.connectionState).toBe('connected');await client.stop();
});

test('both microphone acquisitions ask for the same capture constraints and record only what the browser applied',async()=>{
  const {VOICE_CAPTURE_CONSTRAINTS}=await import('../src/voiceMediaClient');
  expect(VOICE_CAPTURE_CONSTRAINTS).toEqual({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
  const asked:unknown[]=[];
  const track={label:'USB 비밀 마이크',onended:null,stop(){},getSettings:()=>({echoCancellation:true,noiseSuppression:false,autoGainControl:true,sampleRate:48_000,channelCount:1,deviceId:'device-secret',groupId:'group-secret',label:'USB 비밀 마이크'})};
  Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async(constraints:unknown)=>{asked.push(constraints);return {getTracks:()=>[track]};}},configurable:true});
  const logged:unknown[][]=[],original=console.info;console.info=(...args:unknown[])=>{logged.push(args);};
  const client=new VoiceMediaClient(),wire=transport();
  try{
    await client.start('owner',{kind:'ops'},'conversation',wire.send);
    (lastPeer as any).getSenders=()=>[{track:null,replaceTrack:async()=>{}}];
    client.finishInput();await client.resumeInput();expect(client.snapshot().microphone).toBe(true);
  }finally{console.info=original;await client.stop();}
  expect(asked).toHaveLength(2);for(const constraints of asked)expect(constraints).toEqual(VOICE_CAPTURE_CONSTRAINTS);
  const expected={echoCancellation:true,noiseSuppression:false,autoGainControl:true,sampleRate:48_000,channelCount:1};
  expect(client.captureSettings()).toEqual(expected);
  const captureLogs=logged.filter(args=>args[0]==='[Voice] capture');
  expect(captureLogs).toHaveLength(2);expect(captureLogs[0]![1]).toEqual(expected);
  expect(JSON.stringify(logged)).not.toContain('secret');expect(JSON.stringify(logged)).not.toContain('비밀');
  // Nothing of it reaches the host.
  expect(JSON.stringify(wire.requests)).not.toContain('noiseSuppression');
});

test('a microphone track without getSettings records nothing and does not fail',async()=>{
  const client=new VoiceMediaClient(),wire=transport();
  await client.start('owner',{kind:'ops'},'conversation',wire.send);
  expect(client.snapshot().microphone).toBe(true);expect(client.captureSettings()).toBeNull();
  await client.stop();
});


test('text-only OpenAI starts with no microphone permission or audio element and keeps text visible with captions off',async()=>{
 let microphones=0,elements=0;
 Object.defineProperty(globalThis,'isSecureContext',{value:false,configurable:true});
 Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{microphones++;throw Error('denied');}},configurable:true});
 (document as any).createElement=()=>{elements++;throw Error('No audio element in text-only mode');};
 const {send,requests}=transport(),client=new VoiceMediaClient();
 try{
  client.setCaptionMode('off');await client.start('text-openai',{kind:'ops'},'conversation',send,false,'openai',true);
  expect(client.snapshot().phase).toBe('review');expect(client.snapshot().textOnly).toBe(true);expect(client.snapshot().microphone).toBe(false);
  (lastPeer as any).ontrack({streams:[{}]});await client.sendText('글로 요청합니다');
  (lastChannel as any).onmessage({data:JSON.stringify({type:'response.output_audio_transcript.done',item_id:'text_answer',transcript:'글로 답합니다'})});
  expect(client.snapshot().captions.map(x=>x.text)).toEqual(['글로 요청합니다','글로 답합니다']);
  expect(requests.filter(r=>r.action==='say')).toHaveLength(1);
  expect(microphones).toBe(0);expect(elements).toBe(0);
  client.toggleSpeaker();await expect(client.resumeInput()).rejects.toThrow('텍스트로만');expect(microphones).toBe(0);
 }finally{await client.stop();}
});

test('text-only Gemini receives transcripts without AudioContext, capture or PCM append',async()=>{
 let microphones=0,reads=0;
 Object.defineProperty(globalThis,'AudioContext',{value:undefined,configurable:true});
 Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{microphones++;throw Error('denied');}},configurable:true});
 const host=transport({provider:'gemini'}),client=new VoiceMediaClient();
 const send=async(request:VoiceRequest):Promise<VoiceResponse>=>{
  const result=await host.send(request);
  if(request.action==='media.read'&&++reads===1)return {...result,media:[{kind:'audio',data:'AAAA'},{kind:'output-transcript',text:'조용한 답변',final:true}]};
  return result;
 };
 try{
  await client.start('text-gemini',{kind:'ops'},'conversation',send,false,'gemini',true);
  await Bun.sleep(45);expect(client.snapshot().phase).toBe('review');expect(client.snapshot().captions.some(x=>x.text==='조용한 답변')).toBe(true);
  await client.sendText('텍스트 질문');expect(microphones).toBe(0);expect(host.requests.some(r=>r.action==='media.append')).toBe(false);
 }finally{await client.stop();}
});

test('switching to text ends capture immediately, retains session and rejects accidental microphone resume',async()=>{
 let stopped=0,captures=0;
 Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{captures++;return {getTracks:()=>[{kind:'audio',label:'fixture',onended:null,stop(){stopped++;}}]};}},configurable:true});
 const {send,requests}=transport(),client=new VoiceMediaClient();
 try{
  await client.start('switch-text',{kind:'ops'},'conversation',send);const id=client.snapshot().session!.id;
  await client.setTextOnly(true);expect(stopped).toBe(1);expect(client.snapshot().session!.id).toBe(id);expect(client.snapshot().microphone).toBe(false);
  await expect(client.resumeInput()).rejects.toThrow('텍스트로만');expect(captures).toBe(1);
  await client.sendText('같은 대화를 이어갑니다');expect(requests.filter(r=>r.action==='prepare')).toHaveLength(1);
  Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{throw Error('microphone denied');}},configurable:true});
  await client.setTextOnly(false);expect(client.snapshot().textOnly).toBe(true);expect(client.snapshot().microphone).toBe(false);
 }finally{await client.stop();}
});


test('a late reviewed caption and primary transcript cannot replace a newer utterance or reorder the caption strip',async()=>{
 const client=new VoiceMediaClient({conversationMs:60000,dictationMs:60000,initialPollMs:15,pollMs:20}),wire=transport();let reads=0;
 const send:typeof wire.send=async request=>{const r=await wire.send(request);if(request.action==='state'&&r.session){reads++;return {...r,session:{...r.session,recognition:{itemId:'old_utterance',text:'교정한 이전 발언',source:'reviewed'}}};}return r;};
 try{await client.start('caption-review',{kind:'ops'},'conversation',send);
 const emit=(event:Record<string,unknown>)=>(lastChannel as any).onmessage({data:JSON.stringify(event)});
 emit({type:'input_audio_buffer.speech_started',item_id:'old_utterance'});emit({type:'conversation.item.input_audio_transcription.completed',item_id:'old_utterance',transcript:'이전 발언'});
 emit({type:'input_audio_buffer.speech_started',item_id:'new_utterance'});emit({type:'conversation.item.input_audio_transcription.completed',item_id:'new_utterance',transcript:'새 발언'});
 emit({type:'conversation.item.input_audio_transcription.completed',item_id:'old_utterance',transcript:'늦게 도착한 이전 발언'});
 await until(()=>reads>0,'review poll');expect(client.snapshot().caption).toBe('새 발언');expect(client.snapshot().captions.map(c=>c.id)).toEqual(['old_utterance','new_utterance']);expect(client.snapshot().captions[0]?.text).toBe('교정한 이전 발언');
 }finally{await client.stop();}
});
