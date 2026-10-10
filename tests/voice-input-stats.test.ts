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
