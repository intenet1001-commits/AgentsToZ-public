#!/usr/bin/env bun
/**
 * PAID live run of the Korean accuracy experiment (src/voiceEvalLive.ts). Refuses unless BOTH `--live` and
 * AGENTSTOZ_VOICE_EVAL_LIVE=1 are present, plus `--max-sessions N`. Synthetic clips only (from
 * scripts/voice-eval-render.ts); never the user's microphone, the installed app or a real project. Records go to a
 * new 0600 JSONL under .agentstoz/maintainer/voice-accuracy-<timestamp>/; stdout gets counts only.
 *
 *   AGENTSTOZ_VOICE_EVAL_LIVE=1 bun scripts/voice-eval-live.ts --live --max-sessions 12 \
 *     --plan <experiment-plan.json> --clips <render dir> --mode ops-answer|relay-delivery [--out <new dir>]
 *
 * UNVERIFIED: the live path (Chromium media driver, provider) has not been executed. relay-delivery uses an
 * in-process `GOT:` echo of the input transcript, not VoiceSessionHost's relay into a fixture PTY; wiring that
 * product path is the follow-up before relay results are quoted as "what a project AI receives".
 */
import {appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {VOICE_EVAL_CORPUS} from '../src/voiceEvalCorpus';
import {clipId, validateClipManifest, type ClipManifest} from '../src/voiceEvalSynth';
import type {ExperimentPlan} from '../src/voiceEvalExperiment';
import {liveRunGate, providerEnvironment, runLiveTrials, type LiveClip, type LiveMode, type LiveTrial, type MediaDriver} from '../src/voiceEvalLive';

export async function main(args:string[], env:Readonly<Record<string,string|undefined>>=process.env, print:(line:string)=>void=line=>console.log(line)):Promise<number> {
  const gate=liveRunGate(args,env);
  if(!gate.ok){print(JSON.stringify({refused:gate.reason,usage:'AGENTSTOZ_VOICE_EVAL_LIVE=1 bun scripts/voice-eval-live.ts --live --max-sessions N --plan <plan.json> --clips <dir> --mode ops-answer|relay-delivery'}));return 77;}
  const at=(name:string)=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
  const planPath=at('--plan'),clipsDir=at('--clips'),mode=at('--mode') as LiveMode|undefined;
  if(!planPath||!clipsDir||(mode!=='ops-answer'&&mode!=='relay-delivery')){print(JSON.stringify({error:'USAGE'}));return 64;}
  const plan=JSON.parse(readFileSync(planPath,'utf8')) as ExperimentPlan;
  const manifest=validateClipManifest(JSON.parse(readFileSync(join(clipsDir,'manifest.json'),'utf8')) as ClipManifest);
  const clips=new Map(manifest.clips.map(c=>[c.clipId,c]));
  const load=(id:string):LiveClip=>{const c=clips.get(id);if(!c)throw new Error('CLIP_MISSING');
    return {clipId:id,sha256:c.sha256,bytes:new Uint8Array(readFileSync(join(clipsDir,`${id}.wav`))),durationMs:c.durationMs};};
  const items=new Map(VOICE_EVAL_CORPUS.items.map(i=>[i.id,i]));
  const conditions=new Map(plan.conditions.map(c=>[c.id,c]));
  const trials:LiveTrial[]=plan.trials.map(t=>{
    const item=items.get(t.caseId)!;
    return {trialId:t.trialId,caseId:t.caseId,condition:conditions.get(t.condition)!,voice:t.voice,variant:t.variant,mode,
      clip:load(clipId(t.caseId,t.voice,t.variant,'main')),
      ...(item.bargeIn?{bargeIn:{clip:load(clipId(t.caseId,t.voice,t.variant,'barge-in')),afterResponseOnsetMs:item.bargeIn.afterResponseOnsetMs}}:{})};
  });
  const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\..+/,'');
  const out=resolve(at('--out')??join('.agentstoz','maintainer',`voice-accuracy-${stamp}`));
  if(existsSync(out)&&readdirSync(out).length){print(JSON.stringify({error:'OUTPUT_NOT_EMPTY'}));return 64;}
  mkdirSync(out,{recursive:true,mode:0o700});
  const records=join(out,'trials.jsonl');writeFileSync(records,'',{mode:0o600,flag:'wx'});chmodSync(records,0o600);
  // Live-only imports: nothing below loads in tests.
  const [{VoiceCredentials},{connectVoiceRealtime},{chromium}]=await Promise.all([import('../src/voiceCredentials'),import('../src/voiceRealtimeProvider'),import('playwright')]);
  const credentials=new VoiceCredentials(join(homedir(),'Library/Application Support/com.portmanager.portmanager/voice'),{...env});
  // The key first: a missing key must not leave a browser running.
  const status=credentials.status(),key=await credentials.key();
  const browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  const media=():MediaDriver=>{
    let page:Awaited<ReturnType<typeof browser.newPage>>|undefined;
    return {
      async start(connect){
        page=await browser.newPage();
        await page.exposeFunction('connectHost',connect);
        await page.evaluate(async()=>{
          const w=window as any,ctx=new AudioContext({sampleRate:48000}),destination=ctx.createMediaStreamDestination(),peer=new RTCPeerConnection();
          for(const track of destination.stream.getTracks())peer.addTrack(track,destination.stream);
          const channel=peer.createDataChannel('oai-events');w.__voiceEval={ctx,destination,peer};
          const offer=await peer.createOffer();await peer.setLocalDescription(offer);
          await peer.setRemoteDescription({type:'answer',sdp:await w.connectHost(offer.sdp)});
          await new Promise<void>((ok,fail)=>{const t=setTimeout(()=>fail(Error('channel timeout')),15000);if(channel.readyState==='open'){clearTimeout(t);ok();}channel.onopen=()=>{clearTimeout(t);ok();};});
          await ctx.resume();
        });
      },
      async play(clip){
        await page!.evaluate(async bytes=>{
          const {ctx,destination}=(window as any).__voiceEval as {ctx:AudioContext;destination:MediaStreamAudioDestinationNode};
          const buffer=await ctx.decodeAudioData(new Uint8Array(bytes).buffer),source=ctx.createBufferSource();
          source.buffer=buffer;source.connect(destination);
          await new Promise<void>(done=>{source.onended=()=>done();source.start();});
        },Array.from(clip.bytes));
      },
      async close(){await page?.evaluate(()=>{const v=(window as any).__voiceEval;v?.peer.close();v?.destination.stream.getTracks().forEach((t:MediaStreamTrack)=>t.stop());return v?.ctx.close();}).catch(()=>{});await page?.close().catch(()=>{});},
    };
  };
  const environment=providerEnvironment({connect:connectVoiceRealtime,key,model:status.model!,voice:status.voice!,media,
    relay:async text=>'GOT:'+text.replace(/\s+/g,' ').trim(),shutdown:()=>browser.close()});
  const result=await runLiveTrials({gate,trials,environment,write:record=>appendFileSync(records,JSON.stringify(record)+'\n'),log:print});
  return result.refused?77:0;
}
if(import.meta.main)process.exitCode=await main(process.argv.slice(2));
