import {join} from 'node:path';
import {VOICE_EVAL_CORPUS, canonicalJson, corpusHash, sha256Hex, type VoiceEvalCorpus, type VoiceEvalLang, type VoiceEvalSegment} from './voiceEvalCorpus';
import type {ChirpSpec} from './voiceEvalAudio';

/**
 * Synthetic audio render plans for the shared voice corpus: `say` text-to-speech, then ffmpeg for resampling,
 * exact pauses, level and seeded pink noise. Every function here is PURE — it only builds argv arrays and
 * numbers. scripts/voice-eval-render.ts executes them (manually, never in CI), always without a shell, and
 * text is passed to `say` through a file (-f), never on the command line.
 *
 * Synthetic TTS is not human speech: results rank conditions; they do not transfer to physical microphones.
 */
export type VoiceEvalVariant = 'clean'|'quiet'|'pink20'|'pink10'|'pink5';
export interface VariantSpec {speechRmsDbfs:number;noise:null|{color:'pink';snrDb:number;seed:number}}
/**
 * Levels are active-speech RMS (20 ms frames above -60 dBFS). `quiet` reproduces the USB physical attempt
 * (mic level 0.018–0.024 ≈ -45 dBFS RMS). Noise seeds are fixed so the same render spec gives the same noise.
 */
export const VOICE_EVAL_VARIANTS:Record<VoiceEvalVariant,VariantSpec> = {
  clean:{speechRmsDbfs:-23,noise:null},
  quiet:{speechRmsDbfs:-45,noise:null},
  pink20:{speechRmsDbfs:-23,noise:{color:'pink',snrDb:20,seed:2020}},
  pink10:{speechRmsDbfs:-23,noise:{color:'pink',snrDb:10,seed:1010}},
  pink5:{speechRmsDbfs:-23,noise:{color:'pink',snrDb:5,seed:505}},
};
export const VOICE_EVAL_CHIRP:ChirpSpec&{gapAfterMs:number} = {f0Hz:1000,f1Hz:4000,durationMs:120,amplitude:0.5,gapAfterMs:400};
export const SAY_BIN = '/usr/bin/say';
export interface RenderSpec {
  schema:'agentstoz-voice-eval-render-v1';sampleRate:number;channels:1;codec:'pcm_s16le';
  chirp:(ChirpSpec&{gapAfterMs:number})|null;variants:Record<VoiceEvalVariant,VariantSpec>;levelMethod:string;
  tools:{say:string;ffmpeg:string};
}
export function buildRenderSpec(input:{sampleRate:number;chirp:boolean;tools:{say:string;ffmpeg:string}}):RenderSpec {
  if(![16000,24000,44100,48000].includes(input.sampleRate))throw new Error('VOICE_EVAL_SAMPLE_RATE_UNSUPPORTED');
  return {schema:'agentstoz-voice-eval-render-v1',sampleRate:input.sampleRate,channels:1,codec:'pcm_s16le',
    chirp:input.chirp?{...VOICE_EVAL_CHIRP}:null,variants:VOICE_EVAL_VARIANTS,levelMethod:'active-rms-20ms-floor-60dbfs',
    tools:{say:String(input.tools.say).slice(0,80),ffmpeg:String(input.tools.ffmpeg).slice(0,80)}};
}
export const renderSpecHash=(spec:RenderSpec)=>sha256Hex(canonicalJson(spec));

const VOICE=/^[A-Za-z][A-Za-z0-9 ()._'-]{0,63}$/;
const PREFIX=/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
export function assertSayVoice(voice:string):string {
  if(typeof voice!=='string'||!VOICE.test(voice))throw new Error('VOICE_EVAL_VOICE_INVALID');
  return voice;
}
export const voiceSlug=(voice:string)=>assertSayVoice(voice).replace(/[^A-Za-z0-9]+/g,'_').replace(/_+$/,'');
export function clipId(caseId:string, voice:string, variant:VoiceEvalVariant, role:'main'|'barge-in'):string {
  return `${caseId}.${voiceSlug(voice)}.${variant}.${role==='main'?'main':'barge'}`;
}
/** Text files plus `say` argv for each segment. The text never appears on a command line. */
export function segmentSayPlan(segments:VoiceEvalSegment[], voice:string, dir:string, prefix:string) {
  assertSayVoice(voice);
  if(!PREFIX.test(prefix)||prefix.includes('..'))throw new Error('VOICE_EVAL_PREFIX_INVALID');
  const files=segments.map((s,i)=>({path:join(dir,`${prefix}-${i}.txt`),content:s.text}));
  const commands=segments.map((_,i)=>[SAY_BIN,'-v',voice,'-f',join(dir,`${prefix}-${i}.txt`),'-o',join(dir,`${prefix}-${i}.aiff`)]);
  return {files,commands,outputs:segments.map((_,i)=>join(dir,`${prefix}-${i}.aiff`))};
}
const COMMON=['-hide_banner','-nostdin','-loglevel','error','-n'];
const PCM=(sampleRate:number)=>['-ar',String(sampleRate),'-ac','1','-c:a','pcm_s16le'];
const db=(value:number)=>value.toFixed(3)+'dB';
export function segmentNormalizeArgv(ffmpeg:string, input:string, out:string, sampleRate:number):string[] {
  return [ffmpeg,...COMMON,'-i',input,...PCM(sampleRate),out];
}
/** Concatenate inputs in order; `padAfterMs[i]` exact silence after input i (apad counts samples). */
export function assembleArgv(ffmpeg:string, plan:{inputs:string[];padAfterMs:number[];sampleRate:number;out:string}):string[] {
  if(!plan.inputs.length||plan.padAfterMs.length!==plan.inputs.length)throw new Error('VOICE_EVAL_ASSEMBLE_INVALID');
  const sr=plan.sampleRate,chains=plan.inputs.map((_,i)=>{
    const pad=Math.round((plan.padAfterMs[i]??0)*sr/1000);
    if(!Number.isInteger(pad)||pad<0)throw new Error('VOICE_EVAL_PAD_INVALID');
    return `[${i}:a]aresample=${sr},aformat=sample_fmts=s16:channel_layouts=mono${pad?`,apad=pad_len=${pad}`:''}[a${i}]`;
  });
  const graph=chains.join(';')+';'+plan.inputs.map((_,i)=>`[a${i}]`).join('')+`concat=n=${plan.inputs.length}:v=0:a=1[out]`;
  return [ffmpeg,...COMMON,...plan.inputs.flatMap(input=>['-i',input]),'-filter_complex',graph,'-map','[out]',...PCM(sr),plan.out];
}
export function noiseArgv(ffmpeg:string, plan:{variant:VoiceEvalVariant;durationMs:number;sampleRate:number;out:string}):string[]|null {
  const noise=VOICE_EVAL_VARIANTS[plan.variant].noise;
  if(!noise)return null;
  if(!Number.isFinite(plan.durationMs)||plan.durationMs<=0)throw new Error('VOICE_EVAL_DURATION_INVALID');
  return [ffmpeg,...COMMON,'-f','lavfi','-i',
    `anoisesrc=color=${noise.color}:seed=${noise.seed}:sample_rate=${plan.sampleRate}:amplitude=0.5:duration=${(plan.durationMs/1000).toFixed(3)}`,
    ...PCM(plan.sampleRate),plan.out];
}
export function variantArgv(ffmpeg:string, plan:{clean:string;noise:string|null;speechGainDb:number;noiseGainDb:number|null;sampleRate:number;out:string}):string[] {
  if(plan.noise===null)return [ffmpeg,...COMMON,'-i',plan.clean,'-af',`volume=${db(plan.speechGainDb)}`,...PCM(plan.sampleRate),plan.out];
  if(plan.noiseGainDb===null)throw new Error('VOICE_EVAL_NOISE_GAIN_MISSING');
  return [ffmpeg,...COMMON,'-i',plan.clean,'-i',plan.noise,'-filter_complex',
    `[0:a]volume=${db(plan.speechGainDb)}[s];[1:a]volume=${db(plan.noiseGainDb)}[n];[s][n]amix=inputs=2:normalize=0:duration=first[out]`,
    '-map','[out]',...PCM(plan.sampleRate),plan.out];
}
const round3=(n:number)=>Math.round(n*1000)/1000;
/** Gain that brings measured speech to the variant level, and noise to `speech level − SNR`. */
export function levelGains(variant:VoiceEvalVariant, speechActiveRmsDbfs:number, noiseRmsDbfs:number|null) {
  const spec=VOICE_EVAL_VARIANTS[variant];
  if(!spec||!Number.isFinite(speechActiveRmsDbfs))throw new Error('VOICE_EVAL_LEVEL_UNMEASURED');
  const speechGainDb=round3(spec.speechRmsDbfs-speechActiveRmsDbfs);
  if(!spec.noise)return {speechGainDb,noiseGainDb:null};
  if(noiseRmsDbfs===null||!Number.isFinite(noiseRmsDbfs))throw new Error('VOICE_EVAL_NOISE_UNMEASURED');
  return {speechGainDb,noiseGainDb:round3(spec.speechRmsDbfs-spec.noise.snrDb-noiseRmsDbfs)};
}

export interface ClipEntry {
  clipId:string;caseId:string;role:'main'|'barge-in';voice:string;variant:VoiceEvalVariant;sha256:string;
  durationMs:number;sampleRate:number;speechStartMs:number;peakDbfs:number;clippedSamples:number;
}
/** Hashes and numbers only: no text and no paths (the clips sit next to it). */
export interface ClipManifest {
  schemaVersion:1;corpusVersion:string;corpusHash:string;renderSpec:RenderSpec;renderSpecHash:string;clips:ClipEntry[];
}
const CLIP_KEYS=['clipId','caseId','role','voice','variant','sha256','durationMs','sampleRate','speechStartMs','peakDbfs','clippedSamples'];
export function validateClipManifest(manifest:ClipManifest, corpus:VoiceEvalCorpus=VOICE_EVAL_CORPUS):ClipManifest {
  const fail=(why:string):never=>{throw new Error('VOICE_EVAL_MANIFEST_INVALID: '+why);};
  const keys=(value:object,expected:string[])=>{const actual=Object.keys(value);if(actual.length!==expected.length||actual.some(k=>!expected.includes(k)))fail('keys');};
  keys(manifest,['schemaVersion','corpusVersion','corpusHash','renderSpec','renderSpecHash','clips']);
  if(manifest.schemaVersion!==1||manifest.corpusVersion!==corpus.version||manifest.corpusHash!==corpusHash(corpus))fail('corpus');
  if(manifest.renderSpecHash!==renderSpecHash(manifest.renderSpec))fail('render spec');
  const ids=new Set<string>(),cases=new Map(corpus.items.map(i=>[i.id,i]));
  for(const clip of manifest.clips){
    keys(clip,CLIP_KEYS);
    if(!/^[a-zA-Z][a-zA-Z0-9._-]{0,159}$/.test(clip.clipId)||ids.has(clip.clipId))fail('clip id');
    ids.add(clip.clipId);
    const item=cases.get(clip.caseId);
    if(!item)fail('unknown case');
    if(clip.role!=='main'&&!(clip.role==='barge-in'&&item!.bargeIn))fail('role');
    if(!(clip.variant in VOICE_EVAL_VARIANTS))fail('variant');
    if(clip.clipId!==clipId(clip.caseId,clip.voice,clip.variant,clip.role))fail('clip id shape');
    if(!/^[a-f0-9]{64}$/.test(clip.sha256))fail('sha256');
    for(const n of [clip.durationMs,clip.speechStartMs])if(!Number.isFinite(n)||n<0)fail('timing');
    if(clip.sampleRate!==manifest.renderSpec.sampleRate)fail('sample rate');
    if(!Number.isFinite(clip.peakDbfs)||clip.peakDbfs>0)fail('peak');
    if(!Number.isInteger(clip.clippedSamples)||clip.clippedSamples<0)fail('clipping');
  }
  return manifest;
}
export const clipManifestHash=(manifest:ClipManifest)=>sha256Hex(canonicalJson(manifest));
/** What changed between two renders. A different hash for the same clip is a new corpus render, never reused. */
export function diffClipManifests(a:ClipManifest, b:ClipManifest) {
  const left=new Map(a.clips.map(c=>[c.clipId,c.sha256])),right=new Map(b.clips.map(c=>[c.clipId,c.sha256]));
  return {
    sameSpec:a.renderSpecHash===b.renderSpecHash&&a.corpusHash===b.corpusHash,
    changed:[...left].filter(([id,hash])=>right.has(id)&&right.get(id)!==hash).map(([id])=>id),
    added:[...right.keys()].filter(id=>!left.has(id)),
    removed:[...left.keys()].filter(id=>!right.has(id)),
  };
}
/**
 * case id → sha256 of the main clip for one variant and one voice (or one voice per language): the benchmark's
 * `inputHash`. Korean and mixed cases are usually read by a Korean voice, English cases by an English one.
 */
export function caseInputHashes(manifest:ClipManifest, pick:{voice:string|Record<VoiceEvalLang,string>;variant:VoiceEvalVariant},
  corpus:VoiceEvalCorpus=VOICE_EVAL_CORPUS):Map<string,string> {
  const lang=new Map(corpus.items.map(i=>[i.id,i.lang]));
  const voiceFor=(caseId:string)=>typeof pick.voice==='string'?pick.voice:pick.voice[lang.get(caseId)!];
  return new Map(manifest.clips.filter(c=>c.role==='main'&&c.variant===pick.variant&&c.voice===voiceFor(c.caseId)).map(c=>[c.caseId,c.sha256]));
}
