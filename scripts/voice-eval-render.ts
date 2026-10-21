#!/usr/bin/env bun
/**
 * Renders the shared voice corpus to synthetic WAV clips with macOS `say` + ffmpeg. MANUAL tool: it is never run by
 * `bun test` (the test suite only checks the pure plan builders, plus one guarded local integration render).
 * No network, no provider, no AI calls. Writes clips (0600) and manifest.json (0600) into a NEW output directory and
 * prints counts and hashes only — never corpus text.
 *
 *   bun scripts/voice-eval-render.ts --out <new dir> [--cases ko-num-01,en-num-01] [--variants clean,quiet,pink10]
 *     [--ko-voices Yuna,Eddy] [--en-voices Samantha] [--sample-rate 48000] [--no-chirp] [--compare <old manifest.json>]
 *
 * Default output: .agentstoz/maintainer/voice-eval-<timestamp>/ (gitignored). Korean and mixed items use the
 * Korean voices (a Korean voice reading Latin tokens mirrors code-switching; the clips are tagged synthetic).
 * `say` is not guaranteed byte-identical across runs or macOS updates: --compare reports changed hashes, and a
 * changed hash is a new render, never silently reused.
 */
import {chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {VOICE_EVAL_CORPUS, corpusHash, sha256Hex, validateVoiceEvalCorpus, type VoiceEvalItem} from '../src/voiceEvalCorpus';
import {activeRmsDbfs, concatSamples, decodeWav, encodeWav, generateChirp, msForSamples, peakDbfs, rmsDbfs, samplesForMs} from '../src/voiceEvalAudio';
import {
  VOICE_EVAL_CHIRP, VOICE_EVAL_VARIANTS, assembleArgv, buildRenderSpec, clipId, clipManifestHash, diffClipManifests,
  levelGains, noiseArgv, renderSpecHash, segmentNormalizeArgv, segmentSayPlan, validateClipManifest, variantArgv,
  type ClipEntry, type ClipManifest, type VoiceEvalVariant,
} from '../src/voiceEvalSynth';

function run(argv:string[]):string {
  const result=Bun.spawnSync(argv,{stdout:'pipe',stderr:'pipe',stdin:'ignore'});
  if(result.exitCode!==0)throw new Error(`${argv[0]!.split('/').pop()} exited ${result.exitCode}`);
  return result.stdout.toString();
}
function writePrivate(path:string, content:string|Uint8Array){writeFileSync(path,content,{mode:0o600,flag:'wx'});chmodSync(path,0o600);}

export interface RenderedClip {path:string;expectedSamples:number;entry:ClipEntry}
/** Render one clip (main utterance or the barge-in utterance) of one item. Executes say + ffmpeg. */
export async function renderVoiceEvalClip(input:{item:VoiceEvalItem;voice:string;variant:VoiceEvalVariant;dir:string;ffmpeg:string;
  sampleRate:number;chirp:boolean;role?:'main'|'barge-in'}):Promise<RenderedClip> {
  const role=input.role??'main',sr=input.sampleRate;
  const segments=role==='main'?input.item.segments:input.item.bargeIn?.segments;
  if(!segments)throw new Error('VOICE_EVAL_NO_BARGE_IN');
  mkdirSync(input.dir,{recursive:true,mode:0o700});
  const id=clipId(input.item.id,input.voice,input.variant,role),work=join(input.dir,`.work-${id}`);
  mkdirSync(work,{mode:0o700});
  try{
    const plan=segmentSayPlan(segments,input.voice,work,'seg');
    for(const f of plan.files)writePrivate(f.path,f.content);
    for(const argv of plan.commands)run(argv);
    const segmentWavs=plan.outputs.map((aiff,i)=>{const out=join(work,`seg-${i}.wav`);run(segmentNormalizeArgv(input.ffmpeg,aiff,out,sr));return out;});
    const segmentSamples=segmentWavs.map(p=>decodeWav(readFileSync(p)).channels[0]!.length);
    const inputs=[...segmentWavs],pads=segments.map(s=>s.pauseAfterMs??0);
    let speechStart=0;
    if(input.chirp&&role==='main'){
      const chirp=concatSamples([generateChirp(sr,VOICE_EVAL_CHIRP),new Float32Array(samplesForMs(VOICE_EVAL_CHIRP.gapAfterMs,sr))]);
      const chirpPath=join(work,'chirp.wav');writePrivate(chirpPath,encodeWav([chirp],sr));
      inputs.unshift(chirpPath);pads.unshift(0);speechStart=chirp.length;
    }
    const clean=join(work,'clean.wav');run(assembleArgv(input.ffmpeg,{inputs,padAfterMs:pads,sampleRate:sr,out:clean}));
    const cleanSamples=decodeWav(readFileSync(clean)).channels[0]!;
    const speechLevel=activeRmsDbfs(cleanSamples.subarray(speechStart),sr);
    let noisePath:string|null=null,noiseLevel:number|null=null;
    const noiseCmd=noiseArgv(input.ffmpeg,{variant:input.variant,durationMs:msForSamples(cleanSamples.length,sr),sampleRate:sr,out:join(work,'noise.wav')});
    if(noiseCmd){run(noiseCmd);noisePath=join(work,'noise.wav');noiseLevel=rmsDbfs(decodeWav(readFileSync(noisePath)).channels[0]!);}
    const gains=levelGains(input.variant,speechLevel,noiseLevel);
    const path=join(input.dir,`${id}.wav`);
    run(variantArgv(input.ffmpeg,{clean,noise:noisePath,speechGainDb:gains.speechGainDb,noiseGainDb:gains.noiseGainDb,sampleRate:sr,out:path}));
    chmodSync(path,0o600);
    const bytes=readFileSync(path),samples=decodeWav(bytes).channels[0]!;
    let clipped=0;for(let i=0;i<samples.length;i++)if(Math.abs(samples[i]!)>=32767/32768)clipped++;
    const peak=peakDbfs(samples);
    return {path,expectedSamples:speechStart+segmentSamples.reduce((a,b)=>a+b,0)+pads.reduce((a,ms)=>a+samplesForMs(ms,sr),0),
      entry:{clipId:id,caseId:input.item.id,role,voice:input.voice,variant:input.variant,sha256:sha256Hex(new Uint8Array(bytes)),
        durationMs:Math.round(msForSamples(samples.length,sr)),sampleRate:sr,speechStartMs:Math.round(msForSamples(speechStart,sr)),
        peakDbfs:Number.isFinite(peak)?Math.round(peak*100)/100:-120,clippedSamples:clipped}};
  }finally{rmSync(work,{recursive:true,force:true});}
}

function option(args:string[], name:string):string|undefined {const i=args.indexOf(name);return i>=0?args[i+1]:undefined;}
const list=(value:string|undefined, fallback:string[])=>value?value.split(',').map(s=>s.trim()).filter(Boolean):fallback;
export async function main(args:string[]):Promise<number> {
  const ffmpeg=['/opt/homebrew/bin/ffmpeg','/usr/local/bin/ffmpeg','/usr/bin/ffmpeg'].find(existsSync);
  if(!existsSync('/usr/bin/say')||!ffmpeg){console.error('say and ffmpeg are required (macOS).');return 69;}
  const corpus=validateVoiceEvalCorpus(VOICE_EVAL_CORPUS);
  const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\..+/,'');
  const out=resolve(option(args,'--out')??join('.agentstoz','maintainer',`voice-eval-${stamp}`));
  if(existsSync(out)&&readdirSync(out).length){console.error('Output directory must be new or empty.');return 64;}
  const sampleRate=Number(option(args,'--sample-rate')??48000),chirp=!args.includes('--no-chirp');
  const variants=list(option(args,'--variants'),['clean']) as VoiceEvalVariant[];
  if(variants.some(v=>!(v in VOICE_EVAL_VARIANTS))){console.error('Unknown variant.');return 64;}
  const caseIds=new Set(list(option(args,'--cases'),corpus.items.map(i=>i.id)));
  const koVoices=list(option(args,'--ko-voices'),['Yuna']),enVoices=list(option(args,'--en-voices'),['Samantha']);
  const spec=buildRenderSpec({sampleRate,chirp,tools:{say:'macOS '+run(['/usr/bin/sw_vers','-productVersion']).trim(),
    ffmpeg:run([ffmpeg,'-hide_banner','-version']).split('\n')[0]!.split(' ')[2]??'unknown'}});
  const clips:ClipEntry[]=[];
  for(const item of corpus.items.filter(i=>caseIds.has(i.id)))
    for(const voice of item.lang==='en'?enVoices:koVoices)
      for(const variant of variants)
        for(const role of item.bargeIn?['main','barge-in'] as const:['main'] as const)
          clips.push((await renderVoiceEvalClip({item,voice,variant,dir:out,ffmpeg,sampleRate,chirp,role})).entry);
  const manifest=validateClipManifest({schemaVersion:1,corpusVersion:corpus.version,corpusHash:corpusHash(corpus),
    renderSpec:spec,renderSpecHash:renderSpecHash(spec),clips} satisfies ClipManifest);
  writePrivate(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  const summary:Record<string,unknown>={clips:clips.length,clipped:clips.filter(c=>c.clippedSamples).length,
    manifestHash:clipManifestHash(manifest),renderSpecHash:manifest.renderSpecHash,corpusHash:manifest.corpusHash};
  const compare=option(args,'--compare');
  if(compare)summary.compare=diffClipManifests(validateClipManifest(JSON.parse(readFileSync(compare,'utf8'))),manifest);
  console.log(JSON.stringify(summary));
  return 0;
}
if(import.meta.main)process.exitCode=await main(process.argv.slice(2));
