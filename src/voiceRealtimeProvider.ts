import {VoiceUtteranceReview,VOICE_REVIEW_MAX_BASE64} from './voiceUtteranceReview';
import {transcribeVoiceOriginal,voiceInputLanguages,VOICE_DOMAIN_TERMS} from './voiceAudioTranscription';
import type {Lang} from './i18n';
import {VOICE_MAX_SDP_BYTES,type VoiceMediaEvent,type VoiceMode} from './voiceSessionProtocol';
export interface VoiceTool {name:string;description:string;parameters:Record<string,unknown>}
export interface VoiceProviderCloseResult {confirmed:boolean}
export interface VoiceProviderConnection {
  sdp:string;send(event:Record<string,unknown>):void;appendAudio?(base64Pcm16:string):void;endAudio?():void;readMedia?(wait?:boolean):Promise<VoiceMediaEvent[]>;close():Promise<void|VoiceProviderCloseResult>;
  /** A normal end: emit the unfinished turn (Gemini holds it only here until turnComplete) as final transcripts. */
  flushTranscripts?():void;
}
export interface VoiceProviderInput {
  key:string;model:string;voice:string;sdp:string;mode:VoiceMode;language?:Lang;instructions:string;context?:string;tools:VoiceTool[];
  signal:AbortSignal;onEvent(event:Record<string,any>):void;onDisconnect():void;
  /**
   * Measurement harnesses only. VoiceSessionHost never sets it and the voice wire protocol has no field for it, so no
   * phone, remote or MCP path can change the production audio settings.
   */
  audioOverrides?:RealtimeAudioOverrides;
}
/** Harness-only changes to the input audio settings; omitted keys keep the production default. */
export interface RealtimeAudioOverrides {
  /** null turns server noise reduction off. */
  noiseReduction?:'near_field'|'far_field'|null;
  transcription?:{languages?:string[];keywords?:string[]};
}
export type VoiceProviderConnect=(input:VoiceProviderInput)=>Promise<VoiceProviderConnection>;
export async function boundedVoiceResponse(response:Response,maximum:number):Promise<string>{
  if(!response.body)return '';
  const reader=response.body.getReader(),parts:Uint8Array[]=[];let bytes=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>maximum)throw Error('음성 응답 크기 제한을 초과했습니다.');parts.push(value);}return Buffer.concat(parts).toString('utf8');}
  finally{await reader.cancel().catch(()=>{});}
}
/** Host→provider hints (`silent`, for Gemini) never reach the Realtime API, which rejects unknown client-event keys. */
/**
 * When a turn ends. semantic_vad decides from what was said, not only from loudness, so a quiet voice or a noisy
 * room does not cut a sentence short or end it early (2026-10-08 headset VOC). Session start and the relay switch
 * must send the same type — a partial session.update with server_vad would silently switch the session back.
 */
export function realtimeTurnDetection(createResponse:boolean){return {type:'semantic_vad',eagerness:'auto',create_response:createResponse,interrupt_response:true} as const;}
export function realtimeWireEvent(event:Record<string,unknown>):Record<string,unknown>{const {silent:_silent,...wire}=event;return wire;}
export const REALTIME_TRANSCRIPTION_PROMPT='한국어와 English가 섞인 업무 대화. 아젠투지(AgentsToZ)와 워크룸 AI 이름(클로드, 코덱스, 헤르메스, 안티그래비티)을 자주 부릅니다. Preserve English terms: AgentsToZ, OPS, Workroom, OpenAI, Gemini, Codex, Claude, Hermes, Antigravity, agy, Realtime API, commit, push, pull, worktree, TestFlight.';
/**
 * The Realtime session sent at connect. Without `audio` it is the production config, byte for byte
 * (tests/voice-provider.test.ts pins it against a golden string).
 */
export function realtimeSessionConfig(input:Pick<VoiceProviderInput,'model'|'instructions'|'voice'|'mode'|'tools'|'language'>,audio?:RealtimeAudioOverrides){
  const languages=audio?.transcription?.languages??(input.language?voiceInputLanguages(input.language):undefined),keywords=audio?.transcription?.keywords??(input.language?VOICE_DOMAIN_TERMS:undefined);
  return {
    type:'realtime',model:input.model,instructions:input.instructions,
    output_modalities:['audio'],max_output_tokens:1024,
    audio:{input:{transcription:{model:'gpt-transcribe',prompt:input.language&&input.language!=='ko'?undefined:REALTIME_TRANSCRIPTION_PROMPT,...(languages?{languages:[...languages]}:{}),...(keywords?{keywords:[...keywords]}:{})},
      // Headsets and phone mics are close-talking; near_field filters the room before VAD and transcription (2026-10-08 headset VOC).
      noise_reduction:audio&&'noiseReduction' in audio?(audio.noiseReduction===null?null:{type:audio.noiseReduction??'near_field'}):{type:'near_field'},
      turn_detection:realtimeTurnDetection(input.mode==='conversation')},
      output:{voice:input.voice}},
    tools:input.mode==='conversation'?input.tools.map(t=>({type:'function',...t})):[],
  };
}
export interface RealtimeAudioCondition {nr:string;vad:string;eagerness:string;txModel:string;hints:string}
/** Which audio settings a session ran with, for the per-session log line: fixed names only, never prompt text. */
export function realtimeAudioConditionSummary(config:ReturnType<typeof realtimeSessionConfig>):RealtimeAudioCondition{
  const input=config.audio.input as {transcription:{model:string;prompt?:string;languages?:string[];keywords?:string[]};noise_reduction:{type:string}|null;turn_detection:{type:string;eagerness?:string}};
  const hints=[input.transcription.prompt?'prompt':'',input.transcription.languages?'languages':'',input.transcription.keywords?'keywords':''].filter(Boolean).join('+')||'none';
  return {nr:input.noise_reduction?.type??'off',vad:input.turn_detection.type,eagerness:input.turn_detection.eagerness??'none',txModel:input.transcription.model,hints};
}
/** Standard key stays on the host. Unified SDP + host-owned sideband, never client-selected call IDs. */
export const connectVoiceRealtime:VoiceProviderConnect=async input=>{
  const form=new FormData();form.set('sdp',input.sdp);
  form.set('session',JSON.stringify(realtimeSessionConfig(input,input.audioOverrides)));
  const response=await fetch('https://api.openai.com/v1/realtime/calls',{method:'POST',headers:{Authorization:'Bearer '+input.key},body:form,signal:AbortSignal.any([input.signal,AbortSignal.timeout(20_000)])});
  if(!response.ok){await response.body?.cancel();throw Error('음성 제공자 연결 실패 (HTTP '+response.status+'). API 키·모델 접근·사용량을 확인하세요.');}
  const location=response.headers.get('location')??'';
  const match=/^(?:https:\/\/api\.openai\.com)?\/v1\/realtime\/calls\/(rtc_[A-Za-z0-9_-]+)$/.exec(location);
  if(!match){await response.body?.cancel();throw Error('음성 제공자의 세션 식별자를 확인하지 못했습니다.');}
  const callId=match[1]!;
  let socket:WebSocket|undefined,closed=false;
  let closing:Promise<VoiceProviderCloseResult>|undefined;
  let reviewer:VoiceUtteranceReview|undefined;
  let contextEvent:((event:Record<string,any>)=>void)|undefined;
  let contextFailure:((error:Error)=>void)|undefined;
  const close=():Promise<VoiceProviderCloseResult>=>{
    if(closing)return closing;
    closed=true;reviewer?.close();contextFailure?.(Error('음성 연결을 취소했습니다.'));try{socket?.close();}catch{/* Hangup still runs. */}input.signal.removeEventListener('abort',abort);
    // Host abort fires before its explicit close. Both must await this exact hangup, not a boolean fence.
    closing=(async()=>{
      for(let attempt=0;attempt<2;attempt++){
        try{const response=await fetch('https://api.openai.com/v1/realtime/calls/'+callId+'/hangup',{method:'POST',headers:{Authorization:'Bearer '+input.key},signal:AbortSignal.timeout(2500)});const confirmed=response.ok;await response.body?.cancel();if(confirmed)return {confirmed:true};}catch{/* Never return credential-bearing transport errors. */}
        if(attempt===0)await new Promise(resolve=>setTimeout(resolve,300));
      }
      return {confirmed:false};
    })();return closing;
  };
  const abort=()=>{void close();};input.signal.addEventListener('abort',abort,{once:true});
  try{
    const sdp=await boundedVoiceResponse(response,VOICE_MAX_SDP_BYTES);if(!sdp.startsWith('v=0'))throw Error('음성 제공자의 SDP 응답이 올바르지 않습니다.');
    if(input.signal.aborted)throw Error('음성 연결을 취소했습니다.');
    const HostWebSocket=WebSocket as unknown as new(url:string,options:{headers:Record<string,string>})=>WebSocket;
    socket=new HostWebSocket('wss://api.openai.com/v1/realtime?call_id='+callId,{headers:{Authorization:'Bearer '+input.key}});
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('음성 서버 제어 연결 시간이 초과되었습니다.')),10_000);
      const finish=(error?:Error)=>{clearTimeout(timer);input.signal.removeEventListener('abort',cancel);error?reject(error):resolve();};
      const cancel=()=>finish(Error('음성 연결을 취소했습니다.'));input.signal.addEventListener('abort',cancel,{once:true});
      socket!.onopen=()=>finish();socket!.onerror=()=>finish(Error('음성 서버 제어 연결에 실패했습니다.'));
      socket!.onclose=()=>{contextFailure?.(Error('음성 문맥 연결이 종료되었습니다.'));finish(Error('음성 서버 제어 연결이 종료되었습니다.'));if(!closed)input.onDisconnect();};
      socket!.onmessage=event=>{
        if(closed||typeof event.data!=='string'||event.data.length>VOICE_REVIEW_MAX_BASE64+16000)return;
        if(event.data.length>128_000&&!event.data.includes('conversation.item.retrieved'))return;
        try{const parsed=JSON.parse(event.data);if(parsed&&typeof parsed==='object'&&typeof parsed.type==='string'){if(event.data.length>128_000&&parsed.type!=='conversation.item.retrieved')return;
          if(parsed.type==='conversation.item.retrieved'){reviewer?.accept(parsed);return;}
          delete parsed.recognition;delete parsed.primaryTranscript;
          contextEvent?.(parsed);if(!reviewer?.accept(parsed))input.onEvent(parsed);}}catch{/* Malformed provider messages never become commands. */}
      };
    });
    if(input.signal.aborted||closed)throw Error('음성 연결을 취소했습니다.');
    reviewer=new VoiceUtteranceReview({retrieve:itemId=>{if(!closed&&socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'conversation.item.retrieve',item_id:itemId}));},transcribe:wav=>transcribeVoiceOriginal(wav,input.key,input.signal,input.language),emit:event=>{if(!closed)input.onEvent(event);}});
    if(input.context){
      const itemId='ctx_'+crypto.randomUUID().replaceAll('-','').slice(0,24);
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>finish(Error('프로젝트 문맥 전달 시간이 초과되었습니다. 다시 연결하세요.')),5000);
        const finish=(error?:Error)=>{clearTimeout(timer);contextEvent=undefined;contextFailure=undefined;error?reject(error):resolve();};
        contextFailure=finish;
        contextEvent=e=>{
          if(['conversation.item.created','conversation.item.added','conversation.item.done'].includes(e.type)&&e.item?.id===itemId)finish();
          else if(e.type==='error')finish(Error('프로젝트 문맥을 전달하지 못했습니다. 다시 연결하세요.'));
        };
        socket!.send(JSON.stringify({type:'conversation.item.create',item:{id:itemId,type:'message',role:'user',content:[{type:'input_text',text:input.context}]}}));
      });
    }

    return {sdp,send:event=>{if(!closed&&socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(realtimeWireEvent(event)));},close};
  }catch(error){await close();throw error;}
};
