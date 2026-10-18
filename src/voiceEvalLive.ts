import {VOICE_EVAL_CORPUS, canonicalJson, sha256Hex, type VoiceEvalItem} from './voiceEvalCorpus';
import {scoreAnswer, scoreDelivered} from './voiceEvalScoring';
import {realtimeSessionConfig, type RealtimeAudioOverrides, type VoiceProviderConnect, type VoiceProviderConnection} from './voiceRealtimeProvider';
import type {ExperimentCondition} from './voiceEvalExperiment';
import type {VoiceEvalVariant} from './voiceEvalSynth';

/**
 * Live accuracy runner core (KO-6). PAID when wired to the real provider, so it is gated twice: the caller must
 * pass `--live` AND set AGENTSTOZ_VOICE_EVAL_LIVE=1, and give `--max-sessions N`; it never opens session N+1.
 * Everything that touches the world is injected (provider connect, media driver, relay sink), so tests run it
 * against mocked fetch/WebSocket. One provider session per trial (no carried context); nothing is written to
 * voice history. Per-trial records (with transcripts) go only to the injected writer — the caller writes a 0600
 * JSONL file; `log` gets counts only.
 *
 * Modes:
 *  - ops-answer: the model answers (conversation mode, no tools); the final spoken transcript is scored.
 *  - relay-delivery: dictation mode (create_response:false), the input transcript is what a project AI would be
 *    typed; the injected relay echoes it as `GOT:<line>` (fixture CLI) and that delivered line is scored.
 * A trial is valid only when the provider echoed the requested audio settings (session.created/updated);
 * otherwise it is recorded `invalid` and stays in the denominator.
 */
export const VOICE_EVAL_LIVE_ENV = 'AGENTSTOZ_VOICE_EVAL_LIVE';
export const VOICE_EVAL_LIVE_MAX_SESSIONS = 500;
export const VOICE_EVAL_LIVE_INSTRUCTIONS = '평가용 세션입니다. 사용자의 질문에 짧게 답하세요. 계산 질문이면 최종 답을 숫자로 말하세요. Answer briefly; for arithmetic say the final number.';
export type LiveGate = {ok:true;maxSessions:number}|{ok:false;reason:'LIVE_FLAG_MISSING'|'LIVE_ENV_OPT_IN_MISSING'|'MAX_SESSIONS_MISSING'};
export function liveRunGate(argv:readonly string[], env:Readonly<Record<string,string|undefined>>):LiveGate {
  if(!argv.includes('--live'))return {ok:false,reason:'LIVE_FLAG_MISSING'};
  if(env[VOICE_EVAL_LIVE_ENV]!=='1')return {ok:false,reason:'LIVE_ENV_OPT_IN_MISSING'};
  const i=argv.indexOf('--max-sessions'),n=i>=0?Number(argv[i+1]):NaN;
  if(!Number.isSafeInteger(n)||n<1||n>VOICE_EVAL_LIVE_MAX_SESSIONS)return {ok:false,reason:'MAX_SESSIONS_MISSING'};
  return {ok:true,maxSessions:n};
}

export type LiveMode = 'ops-answer'|'relay-delivery';
export interface LiveClip {clipId:string;sha256:string;bytes:Uint8Array;durationMs:number}
export interface LiveTrial {
  trialId:string;caseId:string;condition:ExperimentCondition;voice:string;variant:VoiceEvalVariant;mode:LiveMode;clip:LiveClip;
  bargeIn?:{clip:LiveClip;afterResponseOnsetMs:number};
}
/** Feeds audio into a WebRTC peer whose SDP offer goes to `connect`. The real one is headless Chromium. */
export interface MediaDriver {start(connect:(sdp:string)=>Promise<string>):Promise<void>;play(clip:LiveClip):Promise<void>;close():Promise<void>}
export interface TimedEvent {at:number;event:Record<string,any>}
export interface LiveSession {
  events:TimedEvent[];configHash:string;play(clip:LiveClip):Promise<void>;delivered(text:string):Promise<string|null>;close():Promise<void>;
}
export interface LiveEnvironment {open(trial:LiveTrial):Promise<LiveSession>;shutdown():Promise<void>}

export function providerEnvironment(deps:{connect:VoiceProviderConnect;key:string;model:string;voice:string;media:()=>MediaDriver;
  relay:(text:string)=>Promise<string|null>;shutdown?:()=>Promise<void>;now?:()=>number}):LiveEnvironment {
  const now=deps.now??(()=>performance.now());
  return {
    async open(trial){
      const mode=trial.mode==='ops-answer'?'conversation' as const:'dictation' as const,events:TimedEvent[]=[];
      const config=realtimeSessionConfig({model:deps.model,instructions:VOICE_EVAL_LIVE_INSTRUCTIONS,voice:deps.voice,mode,tools:[]},trial.condition.audio);
      const media=deps.media(),abort=new AbortController();let connection:VoiceProviderConnection|undefined;
      const close=async()=>{try{await connection?.close();}finally{abort.abort();await media.close();}};
      try{
        await media.start(async sdp=>{
          connection=await deps.connect({key:deps.key,model:deps.model,voice:deps.voice,sdp,mode,instructions:VOICE_EVAL_LIVE_INSTRUCTIONS,
            tools:[],signal:abort.signal,onEvent:event=>{if(events.length<20_000)events.push({at:now(),event});},onDisconnect:()=>{},
            audioOverrides:trial.condition.audio});
          return connection.sdp;
        });
      }catch(error){await close().catch(()=>{});throw error;}
      return {events,configHash:sha256Hex(canonicalJson(config)),play:clip=>media.play(clip),delivered:text=>deps.relay(text),close};
    },
    shutdown:async()=>{await deps.shutdown?.();},
  };
}

/** Did the provider echo the requested input-audio settings? Production defaults apply to omitted keys. */
export function confirmCondition(events:Record<string,any>[], audio:RealtimeAudioOverrides):'confirmed'|'unconfirmed'|'mismatch' {
  const echo=[...events].reverse().find(e=>(e.type==='session.created'||e.type==='session.updated')&&e.session?.audio?.input);
  if(!echo)return 'unconfirmed';
  const input=echo.session.audio.input,expected='noiseReduction' in audio?audio.noiseReduction??null:'near_field';
  if((input.noise_reduction?.type??null)!==expected)return 'mismatch';
  for(const key of ['languages','keywords'] as const){
    const want=audio.transcription?.[key];
    if(want&&canonicalJson(input.transcription?.[key]??null)!==canonicalJson(want))return 'mismatch';
  }
  return 'confirmed';
}
export interface LiveTrialRecord {
  trialId:string;caseId:string;condition:string;mode:LiveMode;voice:string;variant:VoiceEvalVariant;clipSha256:string;
  configHash:string|null;conditionConfirmed:'confirmed'|'unconfirmed'|'mismatch'|null;eventCounts:Record<string,number>;
  inputTranscripts:string[];outputTranscripts:string[];delivered:string|null;verdict:string;invalidReason:string|null;
  speechStoppedToFirstAudioMs:number|null;errorCodes:string[];
}
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(check:()=>boolean, timeoutMs:number){const end=Date.now()+timeoutMs;while(!check()&&Date.now()<end)await sleep(10);return check();}

export async function runLiveTrials(input:{gate:LiveGate;trials:LiveTrial[];environment:LiveEnvironment;write:(record:LiveTrialRecord)=>void;
  log:(line:string)=>void;timeoutMs?:number;items?:ReadonlyMap<string,VoiceEvalItem>}):Promise<{refused?:string;ran:number;stoppedAtCap:boolean;verdicts:Record<string,number>}> {
  const verdicts:Record<string,number>={},byCondition:Record<string,Record<string,number>>={};
  if(!input.gate.ok)return {refused:input.gate.reason,ran:0,stoppedAtCap:false,verdicts};
  const items=input.items??new Map(VOICE_EVAL_CORPUS.items.map(i=>[i.id,i])),timeout=input.timeoutMs??30_000;
  let ran=0,stoppedAtCap=false;
  try{
    for(const trial of input.trials){
      if(ran>=input.gate.maxSessions){stoppedAtCap=true;break;}
      ran++;
      const item=items.get(trial.caseId);
      const record:LiveTrialRecord={trialId:trial.trialId,caseId:trial.caseId,condition:trial.condition.id,mode:trial.mode,voice:trial.voice,
        variant:trial.variant,clipSha256:trial.clip.sha256,configHash:null,conditionConfirmed:null,eventCounts:{},inputTranscripts:[],
        outputTranscripts:[],delivered:null,verdict:'invalid',invalidReason:'TRIAL_ERROR',speechStoppedToFirstAudioMs:null,errorCodes:[]};
      let session:LiveSession|undefined;
      try{
        if(!item)throw new Error('unknown case');
        session=await input.environment.open(trial);
        record.configHash=session.configHash;
        const events=session.events,has=(type:string,from=0)=>events.slice(from).some(e=>e.event.type===type);
        await session.play(trial.clip);
        if(trial.mode==='ops-answer'){
          const answered=(from=0)=>has('response.output_audio_transcript.done',from)||has('response.function_call_arguments.done',from);
          if(trial.bargeIn){
            // Interrupt the first response WHILE it is speaking: wait only for its audio onset, never for its end
            // (waiting for transcript.done would turn every interruption item into a plain follow-up question).
            await waitFor(()=>has('response.output_audio.delta')||answered(),timeout);
            await sleep(trial.bargeIn.afterResponseOnsetMs);
            const mark=events.length;
            await session.play(trial.bargeIn.clip);
            await waitFor(()=>has('response.output_audio_transcript.done',mark),timeout);
          }else await waitFor(()=>answered(),timeout);
        }else{
          await waitFor(()=>has('conversation.item.input_audio_transcription.completed'),timeout);
          if(trial.bargeIn){const mark=events.length;await session.play(trial.bargeIn.clip);await waitFor(()=>has('conversation.item.input_audio_transcription.completed',mark),timeout);}
        }
        const raw=events.map(e=>e.event);
        for(const e of raw)record.eventCounts[e.type]=(record.eventCounts[e.type]??0)+1;
        record.errorCodes=raw.filter(e=>e.type==='error').map(e=>String(e.error?.code??'unknown').slice(0,80));
        record.inputTranscripts=raw.filter(e=>e.type==='conversation.item.input_audio_transcription.completed').map(e=>String(e.transcript??''));
        record.outputTranscripts=raw.filter(e=>e.type==='response.output_audio_transcript.done').map(e=>String(e.transcript??''));
        const stopped=events.filter(e=>e.event.type==='input_audio_buffer.speech_stopped').at(-1);
        const audio=stopped&&events.find(e=>e.at>=stopped.at&&e.event.type==='response.output_audio.delta');
        record.speechStoppedToFirstAudioMs=stopped&&audio?Math.round(audio.at-stopped.at):null;
        record.conditionConfirmed=confirmCondition(raw,trial.condition.audio);
        record.invalidReason=null;
        if(trial.mode==='relay-delivery'){
          const said=record.inputTranscripts.join(' ').trim();
          record.delivered=said?await session.delivered(said):null;
          const line=record.delivered?.startsWith('GOT:')?record.delivered.slice(4):'';
          record.verdict=scoreDelivered(line,item).verdict;
        }else record.verdict=raw.some(e=>e.type==='response.function_call_arguments.done')?'tool-called':scoreAnswer(record.outputTranscripts,item);
        const invalid=record.conditionConfirmed!=='confirmed'?'CONDITION_UNCONFIRMED':record.errorCodes.length?'PROVIDER_ERROR'
          :!has('input_audio_buffer.speech_started')?'NO_SPEECH_STARTED':null;
        if(invalid){record.verdict='invalid';record.invalidReason=invalid;}
      }catch{
        record.verdict='invalid';record.invalidReason='TRIAL_ERROR';
      }finally{
        await session?.close().catch(()=>{});
      }
      verdicts[record.verdict]=(verdicts[record.verdict]??0)+1;
      const c=byCondition[record.condition]??={};c[record.verdict]=(c[record.verdict]??0)+1;
      input.write(record);
    }
  }finally{
    await input.environment.shutdown();
  }
  // Counts only: transcripts and delivered text stay in the private records.
  input.log(JSON.stringify({ran,stoppedAtCap,verdicts,byCondition}));
  return {ran,stoppedAtCap,verdicts};
}
