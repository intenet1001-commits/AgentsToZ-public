import {canonicalJson, sha256Hex} from './voiceEvalCorpus';
import {dbToLinear, frameDbfs, generateChirp, msForSamples, samplesForMs, type ChirpSpec} from './voiceEvalAudio';
import {VOICE_EVAL_CHIRP} from './voiceEvalSynth';

/**
 * Product-neutral timing from ONE recording that holds both the stimulus and the product's answer.
 * Neither product is instrumented: the clock is the capture's own sample clock, anchored at the sync chirp that
 * every rendered stimulus clip starts with. Pure functions over Float32 PCM; the parameters are sealed into
 * `methodHash` before any trial and never tuned afterwards.
 *
 * Honest outputs: a missing onset is `null`, never 0; a reply that starts before the stimulus ends is an
 * `overlap`, never a negative latency; on a single track (one microphone) the moment the product stops talking
 * inside the user's barge-in cannot be separated from the user's voice, so it is reported only as an upper bound.
 */
export interface TimingParams {
  frameMs:number;onDbfs:number;offDbfs:number;minSpeechMs:number;minSilenceMs:number;
  chirp:ChirpSpec;chirpThreshold:number;tailToleranceMs:number;
}
export const DEFAULT_TIMING_PARAMS:TimingParams = {
  frameMs:10,onDbfs:-40,offDbfs:-45,minSpeechMs:80,minSilenceMs:250,
  chirp:{f0Hz:VOICE_EVAL_CHIRP.f0Hz,f1Hz:VOICE_EVAL_CHIRP.f1Hz,durationMs:VOICE_EVAL_CHIRP.durationMs,amplitude:VOICE_EVAL_CHIRP.amplitude},
  chirpThreshold:0.6,tailToleranceMs:150,
};
export const timingMethodHash=(params:TimingParams)=>sha256Hex(canonicalJson({schema:'agentstoz-voice-timing-v1',params}));
const CLOCKS = {
  response:{start:'stimulus-end (chirp onset + rendered clip duration)',end:'first product speech onset after it'},
  interrupt:{start:'barge-in onset',end:'end of the product speech segment active at barge-in onset'},
  resume:{start:'barge-in end',end:'next product speech onset after it'},
} as const;
export const timingClockHash=(metric:keyof typeof CLOCKS)=>sha256Hex(canonicalJson({schema:'agentstoz-voice-clock-v1',
  clock:'capture-sample-clock',anchor:'sync-chirp-onset',metric,...CLOCKS[metric]}));

export interface Segment {startMs:number;endMs:number}
export interface ChirpHit {atMs:number;score:number}

/** Normalized cross-correlation with the sync chirp; one hit per chirp length, in time order. */
export function findChirps(pcm:Float32Array, sampleRate:number, chirp:ChirpSpec, threshold:number):ChirpHit[] {
  const template=generateChirp(sampleRate,chirp),m=template.length;
  if(pcm.length<m)return [];
  let tNorm=0;for(let i=0;i<m;i++)tNorm+=template[i]!*template[i]!;tNorm=Math.sqrt(tNorm);
  const energy=new Float64Array(pcm.length+1);
  for(let i=0;i<pcm.length;i++)energy[i+1]=energy[i]!+pcm[i]!*pcm[i]!;
  const score=(k:number)=>{
    const e=Math.sqrt(energy[k+m]!-energy[k]!);if(e<1e-9)return 0;
    let dot=0;for(let i=0;i<m;i++)dot+=pcm[k+i]!*template[i]!;
    return dot/(tNorm*e);
  };
  const stride=4,coarse:{k:number;s:number}[]=[];
  for(let k=0;k+m<=pcm.length;k+=stride){const s=score(k);if(s>=threshold*0.7)coarse.push({k,s});}
  const refined=coarse.map(({k})=>{
    let best={k,s:-1};
    for(let j=Math.max(0,k-stride);j<=Math.min(pcm.length-m,k+stride);j++){const s=score(j);if(s>best.s)best={k:j,s};}
    return best;
  }).filter(c=>c.s>=threshold).sort((a,b)=>b.s-a.s||a.k-b.k);
  const accepted:{k:number;s:number}[]=[];
  for(const c of refined)if(accepted.every(a=>Math.abs(a.k-c.k)>=m))accepted.push(c);
  return accepted.sort((a,b)=>a.k-b.k).map(c=>({atMs:msForSamples(c.k,sampleRate),score:Math.round(c.s*1000)/1000}));
}

/** Energy segments with hysteresis; edges refined to the first/last sample above the on-threshold. */
export function speechSegments(pcm:Float32Array, sampleRate:number, params:TimingParams):Segment[] {
  const frames=frameDbfs(pcm,sampleRate,params.frameMs),size=samplesForMs(params.frameMs,sampleRate);
  const quietFrames=Math.ceil(params.minSilenceMs/params.frameMs),level=dbToLinear(params.onDbfs);
  const raw:{start:number;end:number}[]=[];
  let start=-1,lastLoud=-1,quiet=0;
  frames.forEach((db,i)=>{
    if(start<0){if(db>=params.onDbfs){start=i;lastLoud=i;quiet=0;}return;}
    if(db>=params.offDbfs){quiet=0;lastLoud=i;return;}
    if(++quiet>=quietFrames){raw.push({start,end:lastLoud});start=-1;}
  });
  if(start>=0)raw.push({start,end:lastLoud});
  const out:Segment[]=[];
  for(const r of raw){
    let first=r.start*size,last=Math.min(pcm.length,(r.end+1)*size)-1;
    for(let i=first;i<Math.min(pcm.length,(r.start+1)*size);i++)if(Math.abs(pcm[i]!)>=level){first=i;break;}
    for(let i=last;i>=r.end*size;i--)if(Math.abs(pcm[i]!)>=level){last=i;break;}
    const seg={startMs:msForSamples(first,sampleRate),endMs:msForSamples(last+1,sampleRate)};
    if(seg.endMs-seg.startMs>=params.minSpeechMs)out.push(seg);
  }
  return out;
}

export type ResponseTiming =
  |{kind:'response';latencyMs:number;onsetMs:number}
  |{kind:'no-response'|'overlap'|'no-anchor';latencyMs:null};
export type InterruptTiming =
  |{kind:'stopped';latencyMs:number;stopMs:number}
  |{kind:'bounded';latencyMs:null;atMostMs:number}
  |{kind:'not-speaking'|'not-stopped'|'no-barge-in'|'unmeasurable';latencyMs:null};
export type ResumeTiming = {kind:'resumed';latencyMs:number}|{kind:'no-resume'|'overlap'|'unmeasurable';latencyMs:null};
export interface CaptureTiming {
  separation:'single-track'|'separate-tracks';anchorMs:number|null;stimulusEndMs:number|null;
  response:ResponseTiming;interrupt?:InterruptTiming;resume?:ResumeTiming;methodHash:string;
}
const r1=(ms:number)=>Math.round(ms*10)/10;
/**
 * `stimulus` holds the played stimulus (or, on one microphone, everything); `product` is a separate track of the
 * product's own output (e.g. a digital tap), or null. Both share one sample clock.
 * `stimulusDurationMs` is the rendered main clip's duration (chirp included); `bargeIn.atMs` is the capture time the
 * barge-in clip was played (required on a single track, detected on separate tracks when omitted).
 */
export function analyzeCapture(input:{sampleRate:number;stimulus:Float32Array;product:Float32Array|null;stimulusDurationMs:number;
  bargeIn?:{durationMs:number;atMs?:number};params?:TimingParams}):CaptureTiming {
  const params=input.params??DEFAULT_TIMING_PARAMS,sr=input.sampleRate,separate=input.product!==null;
  const base={separation:separate?'separate-tracks' as const:'single-track' as const,methodHash:timingMethodHash(params)};
  const anchor=findChirps(input.stimulus,sr,params.chirp,params.chirpThreshold)[0]?.atMs??null;
  if(anchor===null)return {...base,anchorMs:null,stimulusEndMs:null,response:{kind:'no-anchor',latencyMs:null},
    ...(input.bargeIn?{interrupt:{kind:'unmeasurable',latencyMs:null},resume:{kind:'unmeasurable',latencyMs:null}}:{})};
  const stimulusEnd=anchor+input.stimulusDurationMs,tail=params.tailToleranceMs;
  const productTrack=input.product??input.stimulus,captureEndMs=msForSamples(productTrack.length,sr);
  const product=speechSegments(productTrack,sr,params).filter(s=>s.endMs>anchor);
  let response:ResponseTiming;
  if(separate){
    const first=product[0];
    response=!first?{kind:'no-response',latencyMs:null}:first.startMs<stimulusEnd?{kind:'overlap',latencyMs:null}
      :{kind:'response',latencyMs:r1(first.startMs-stimulusEnd),onsetMs:r1(first.startMs)};
  }else{
    const spill=product.some(s=>s.startMs<=stimulusEnd&&s.endMs>stimulusEnd+tail);
    const next=product.find(s=>s.startMs>stimulusEnd);
    response=spill?{kind:'overlap',latencyMs:null}:next?{kind:'response',latencyMs:r1(next.startMs-stimulusEnd),onsetMs:r1(next.startMs)}
      :{kind:'no-response',latencyMs:null};
  }
  const result:CaptureTiming={...base,anchorMs:r1(anchor),stimulusEndMs:r1(stimulusEnd),response};
  if(!input.bargeIn)return result;
  let bargeAt=input.bargeIn.atMs??null,bargeEnd=bargeAt===null?null:bargeAt+input.bargeIn.durationMs;
  if(separate&&bargeAt===null){
    const seg=speechSegments(input.stimulus,sr,params).find(s=>s.startMs>stimulusEnd+tail);
    if(seg){bargeAt=seg.startMs;bargeEnd=seg.endMs;}
  }
  if(bargeAt===null||bargeEnd===null){
    result.interrupt={kind:separate?'no-barge-in':'unmeasurable',latencyMs:null};
    result.resume={kind:'unmeasurable',latencyMs:null};
    return result;
  }
  const active=product.find(s=>s.startMs<=bargeAt!&&s.endMs>bargeAt!);
  if(!active)result.interrupt={kind:'not-speaking',latencyMs:null};
  else if(active.endMs>=captureEndMs-params.frameMs)result.interrupt={kind:'not-stopped',latencyMs:null};
  else if(!separate&&active.endMs<=bargeEnd+tail)result.interrupt={kind:'bounded',latencyMs:null,atMostMs:r1(active.endMs-bargeAt)};
  else result.interrupt={kind:'stopped',latencyMs:r1(active.endMs-bargeAt),stopMs:r1(active.endMs)};
  const after=product.find(s=>s.startMs>(active?.endMs??bargeAt!));
  result.resume=!after?{kind:'no-resume',latencyMs:null}:after.startMs<bargeEnd?{kind:'overlap',latencyMs:null}
    :{kind:'resumed',latencyMs:r1(after.startMs-bargeEnd)};
  return result;
}
