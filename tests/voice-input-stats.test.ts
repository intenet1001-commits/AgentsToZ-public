import {expect,test} from 'bun:test';
import {countVoiceInputEvent,emptyVoiceInputStats,voiceInputHint,voiceInputHintText,voiceInputStatsLine} from '../src/voiceInputStats';

test('the host counts which layer stopped, never the words',()=>{
  const stats=emptyVoiceInputStats();
  for(const type of ['input_audio_buffer.speech_started','conversation.item.input_audio_transcription.completed','response.done','session.updated'])countVoiceInputEvent(stats,{type,transcript:'비밀 문장'});
  expect(stats).toEqual({speechStarted:1,transcribed:1,transcriptFailed:0,responses:1});
  const line=voiceInputStatsLine('voice_9d33051c-aaaa','openai',29_400,stats);
  expect(line).toContain('speech 1, transcribed 1');expect(line).not.toContain('비밀');
  expect(voiceInputStatsLine('voice_x','openai',30_000,emptyVoiceInputStats())).toContain('no speech detected');
});

test('the phone stays quiet for the first seconds and once speech is seen',()=>{
  expect(voiceInputHint({listeningMs:5_000,peak:0,loudMs:0,speechSeen:false})).toBeNull();
  expect(voiceInputHint({listeningMs:20_000,peak:0,loudMs:0,speechSeen:true})).toBeNull();
});

test('silence from the microphone and sound without speech are different answers',()=>{
  expect(voiceInputHint({listeningMs:9_000,peak:0.01,loudMs:0,speechSeen:false})).toBe('no-signal');
  expect(voiceInputHint({listeningMs:9_000,peak:0.6,loudMs:2_000,speechSeen:false})).toBe('no-speech');
  // A quiet room with a working mic: say nothing rather than blame the headset.
  expect(voiceInputHint({listeningMs:9_000,peak:0.08,loudMs:200,speechSeen:false})).toBeNull();
  expect(voiceInputHintText('no-signal','AirPods Pro')).toContain('마이크(AirPods Pro)에서 소리가 들어오지 않습니다');
  expect(voiceInputHintText('no-speech','')).toContain('마이크로 소리는 들어오지만');
  expect(voiceInputHintText(null,'x')).toBe('');
});

test('turn detection is semantic at session start and in the relay switch alike',async()=>{
  const {realtimeTurnDetection}=await import('../src/voiceRealtimeProvider');
  expect(realtimeTurnDetection(true)).toEqual({type:'semantic_vad',eagerness:'auto',create_response:true,interrupt_response:true});
  const host=await Bun.file(new URL('../src/voiceSessionHost.ts',import.meta.url)).text();
  expect(host).not.toContain("type:'server_vad'");
  expect(host).toContain('turn_detection:realtimeTurnDetection(!relay)');
});

test('Bluetooth headphones record from the iPhone mic; without them voiceChat stays',async()=>{
  const swift=await Bun.file(new URL('../mobile/ios/App/LANWorkroomView.swift',import.meta.url)).text();
  const body=swift.slice(swift.indexOf('static func configureVoiceAudioSession'));
  expect(body).toContain('.allowBluetoothA2DP');expect(body).toContain('.builtInMic');
  expect(body.indexOf('.allowBluetoothA2DP')).toBeLessThan(body.indexOf('mode: .voiceChat'));
  expect(swift).toContain('try Self.configureVoiceAudioSession(AVAudioSession.sharedInstance())');
});

test('finer counts and the audio condition tell the layers apart, still without words',async()=>{
  const {emptyVoiceInputDetail}=await import('../src/voiceInputStats');
  const {realtimeAudioConditionSummary,realtimeSessionConfig}=await import('../src/voiceRealtimeProvider');
  const stats=emptyVoiceInputStats(),detail=emptyVoiceInputDetail();
  for(const e of [
    {type:'input_audio_buffer.speech_started'},{type:'input_audio_buffer.speech_stopped'},{type:'input_audio_buffer.committed',item_id:'i1'},
    {type:'error',error:{code:'input_audio_buffer_commit_empty',message:'비밀 문장'}},{type:'error',error:{code:'some_unlisted_code_비밀',message:'x'}},
    {type:'response.done',response:{status:'cancelled',output:[{content:[{transcript:'비밀 문장'}]}]}},
    {type:'response.done',response:{status:'completed'}},
    {type:'conversation.item.input_audio_transcription.completed',transcript:'비밀 문장'},
  ])countVoiceInputEvent(stats,e,detail);
  expect(stats).toEqual({speechStarted:1,transcribed:1,transcriptFailed:0,responses:2});
  expect(detail).toEqual({committed:1,speechStopped:1,responseCancelled:1,errors:{input_audio_buffer_commit_empty:1,other:1}});
  const condition=realtimeAudioConditionSummary(realtimeSessionConfig({model:'gpt-realtime-2.1',instructions:'비밀 문장',voice:'marin',mode:'conversation',tools:[]}));
  const line=voiceInputStatsLine('voice_9d33051c-aaaa','openai',29_400,stats,detail,condition);
  expect(line).toContain('speech 1, transcribed 1');
  expect(line).toContain('committed 1, stopped 1, cancelled 1, errors input_audio_buffer_commit_empty:1 other:1');
  expect(line).toContain('nr=near_field');expect(line).toContain('vad=semantic_vad/auto');expect(line).toContain('tx=gpt-transcribe');expect(line).toContain('hints=prompt');
  expect(line).not.toContain('비밀');expect(line).not.toContain('some_unlisted');
  const gemini=voiceInputStatsLine('voice_x','gemini',30_000,emptyVoiceInputStats(),emptyVoiceInputDetail(),'gemini');
  expect(gemini).toContain('errors 0');expect(gemini).toContain(' gemini — no speech detected');
});

test('the host session line carries the finer counts and the audio condition it connected with',async()=>{
  const {VoiceSessionHost}=await import('../src/voiceSessionHost');
  let onEvent:(e:Record<string,unknown>)=>void=()=>{};
  const binding={label:'fixture · codex',key:'fixed-fixture',validate:async()=>{},tools:[],run:async()=>({}),review:async()=>({label:'fixture · codex',send:async()=>{}})};
  const host=new VoiceSessionHost({wait:async()=>{},credentials:{status:()=>({configured:true,model:'gpt-realtime-2.1',voice:'marin'}),key:async()=>'fixture-key',configure:async()=>({configured:true})},bind:async()=>binding as any,provider:async (i:{onEvent:(e:Record<string,unknown>)=>void})=>{onEvent=i.onEvent;return {sdp:'v=0',send:()=>{},close:async()=>{}};}} as any);
  const lines:string[]=[],original=console.log;console.log=(...args:unknown[])=>{lines.push(args.map(String).join(' '));};
  try{
    const authority={owner:'local',active:()=>true};
    const sessionId=(await host.perform({action:'prepare',requestId:crypto.randomUUID(),target:{kind:'workroom',targetId:'project_fixture',sessionId:'terminal_fixture'},mode:'dictation',consent:true},authority)).session!.id;
    await host.perform({action:'connect',requestId:crypto.randomUUID(),sessionId,sdp:'v=0'},authority);
    onEvent({type:'input_audio_buffer.speech_started'});onEvent({type:'input_audio_buffer.speech_stopped'});onEvent({type:'input_audio_buffer.committed'});
    onEvent({type:'error',error:{code:'input_audio_buffer_commit_empty',message:'비밀 문장'}});
    await host.perform({action:'stop',requestId:crypto.randomUUID(),sessionId},authority);
  }finally{console.log=original;await host.shutdown();}
  const line=lines.find(l=>l.startsWith('[Voice] voice_'))!;
  expect(line).toContain('committed 1, stopped 1, cancelled 0, errors input_audio_buffer_commit_empty:1');
  expect(line).toContain('nr=near_field vad=semantic_vad/auto tx=gpt-transcribe hints=prompt');
  expect(line).not.toContain('비밀');
});
