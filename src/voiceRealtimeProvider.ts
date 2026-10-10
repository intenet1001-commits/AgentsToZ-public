import {VOICE_MAX_SDP_BYTES,type VoiceMediaEvent,type VoiceMode} from './voiceSessionProtocol';
export interface VoiceTool {name:string;description:string;parameters:Record<string,unknown>}
export interface VoiceProviderConnection {
  sdp:string;send(event:Record<string,unknown>):void;appendAudio?(base64Pcm16:string):void;endAudio?():void;readMedia?():Promise<VoiceMediaEvent[]>;close():Promise<void>;
  /** A normal end: emit the unfinished turn (Gemini holds it only here until turnComplete) as final transcripts. */
  flushTranscripts?():void;
}
export interface VoiceProviderInput {
  key:string;model:string;voice:string;sdp:string;mode:VoiceMode;instructions:string;context?:string;tools:VoiceTool[];
  signal:AbortSignal;onEvent(event:Record<string,any>):void;onDisconnect():void;
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
/** Standard key stays on the host. Unified SDP + host-owned sideband, never client-selected call IDs. */
export const connectVoiceRealtime:VoiceProviderConnect=async input=>{
  const form=new FormData();form.set('sdp',input.sdp);
  form.set('session',JSON.stringify({
    type:'realtime',model:input.model,instructions:input.instructions,
    output_modalities:['audio'],max_output_tokens:1024,
    audio:{input:{transcription:{model:'gpt-4o-mini-transcribe',prompt:'한국어와 English가 섞인 업무 대화. 아젠투지(AgentsToZ)와 워크룸 AI 이름(클로드, 코덱스, 헤르메스, 안티그래비티)을 자주 부릅니다. Preserve English terms: AgentsToZ, OPS, Workroom, OpenAI, Gemini, Codex, Claude, Hermes, Antigravity, agy, Realtime API, commit, push, pull, worktree, TestFlight.'},
      // Headsets and phone mics are close-talking; near_field filters the room before VAD and transcription (2026-10-08 headset VOC).
      noise_reduction:{type:'near_field'},
      turn_detection:realtimeTurnDetection(input.mode==='conversation')},
      output:{voice:input.voice}},
    tools:input.mode==='conversation'?input.tools.map(t=>({type:'function',...t})):[],
  }));
  const response=await fetch('https://api.openai.com/v1/realtime/calls',{method:'POST',headers:{Authorization:'Bearer '+input.key},body:form,signal:AbortSignal.any([input.signal,AbortSignal.timeout(20_000)])});
  if(!response.ok){await response.body?.cancel();throw Error('음성 제공자 연결 실패 (HTTP '+response.status+'). API 키·모델 접근·사용량을 확인하세요.');}
  const location=response.headers.get('location')??'';
  const match=/^(?:https:\/\/api\.openai\.com)?\/v1\/realtime\/calls\/(rtc_[A-Za-z0-9_-]+)$/.exec(location);
  if(!match){await response.body?.cancel();throw Error('음성 제공자의 세션 식별자를 확인하지 못했습니다.');}
  const callId=match[1]!;
  let socket:WebSocket|undefined,closed=false;
  let contextEvent:((event:Record<string,any>)=>void)|undefined;
  let contextFailure:((error:Error)=>void)|undefined;
  const close=async()=>{
    if(closed)return;closed=true;contextFailure?.(Error('음성 연결을 취소했습니다.'));socket?.close();input.signal.removeEventListener('abort',abort);
    try{const r=await fetch('https://api.openai.com/v1/realtime/calls/'+callId+'/hangup',{method:'POST',headers:{Authorization:'Bearer '+input.key},signal:AbortSignal.timeout(5000)});await r.body?.cancel();}catch{/* No execution channel remains. Client also closes media; do not expose a credential-bearing error. */}
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
        if(closed||typeof event.data!=='string'||event.data.length>128_000)return;
        try{const parsed=JSON.parse(event.data);if(parsed&&typeof parsed==='object'&&typeof parsed.type==='string'){contextEvent?.(parsed);input.onEvent(parsed);}}catch{/* Malformed provider messages never become commands. */}
      };
    });
    if(input.signal.aborted||closed)throw Error('음성 연결을 취소했습니다.');
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
