#!/usr/bin/env bun
/**
 * Measure one benchmark capture (src/voiceBenchmarkTiming.ts). Offline: decodes with ffmpeg, no network or
 * provider. Prints numbers and hashes only — never audio, transcripts or paths.
 *
 *   bun scripts/analyze-voice-benchmark-capture.ts --capture <file> --stimulus-ms <rendered clip duration>
 *     [--barge-ms <barge-in clip duration>] [--barge-at-ms <capture time it was played>]
 *     [--stimulus-channel 0] [--product-channel 1]
 *
 * With one channel (a microphone that hears both the speaker and the product) the barge-in time is required
 * for interrupt/resume, and a stop inside the barge-in is reported only as an upper bound.
 */
import {existsSync, readFileSync} from 'node:fs';
import {decodeWav} from '../src/voiceEvalAudio';
import {sha256Hex} from '../src/voiceEvalCorpus';
import {analyzeCapture, timingClockHash} from '../src/voiceBenchmarkTiming';

export const CAPTURE_DECODE_RATE = 16000;
export function decodeCaptureArgv(ffmpeg:string, capture:string, sampleRate:number):string[] {
  return [ffmpeg,'-hide_banner','-nostdin','-loglevel','error','-i',capture,'-ar',String(sampleRate),'-c:a','pcm_s16le','-f','wav','pipe:1'];
}
export async function main(args:string[], print:(line:string)=>void=line=>console.log(line)):Promise<number> {
  const at=(name:string)=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
  const capture=at('--capture'),stimulusMs=Number(at('--stimulus-ms'));
  const ffmpeg=['/opt/homebrew/bin/ffmpeg','/usr/local/bin/ffmpeg','/usr/bin/ffmpeg'].find(existsSync);
  if(!capture||!Number.isFinite(stimulusMs)||stimulusMs<=0){print('usage: --capture <file> --stimulus-ms <ms> [--barge-ms <ms>] [--barge-at-ms <ms>]');return 64;}
  if(!ffmpeg){print(JSON.stringify({error:'FFMPEG_MISSING'}));return 69;}
  const bytes=readFileSync(capture),decoded=Bun.spawnSync(decodeCaptureArgv(ffmpeg,capture,CAPTURE_DECODE_RATE),{stdout:'pipe',stderr:'pipe',stdin:'ignore'});
  if(decoded.exitCode!==0){print(JSON.stringify({error:'CAPTURE_DECODE_FAILED'}));return 65;}
  // ffmpeg cannot seek a pipe, so it writes the data size as 0xFFFFFFFF; decodeWav clamps to what was received.
  const wav=decodeWav(new Uint8Array(decoded.stdout));
  const stimulusChannel=Number(at('--stimulus-channel')??0),productChannel=at('--product-channel');
  const stimulus=wav.channels[stimulusChannel],product=productChannel===undefined?null:wav.channels[Number(productChannel)];
  if(!stimulus||product===undefined){print(JSON.stringify({error:'CAPTURE_CHANNEL_MISSING'}));return 65;}
  const bargeMs=at('--barge-ms'),bargeAt=at('--barge-at-ms');
  const timing=analyzeCapture({sampleRate:wav.sampleRate,stimulus,product,stimulusDurationMs:stimulusMs,
    ...(bargeMs?{bargeIn:{durationMs:Number(bargeMs),...(bargeAt?{atMs:Number(bargeAt)}:{})}}:{})});
  print(JSON.stringify({captureHash:sha256Hex(new Uint8Array(bytes)),clockHashes:{response:timingClockHash('response'),
    interrupt:timingClockHash('interrupt'),resume:timingClockHash('resume')},...timing}));
  return 0;
}
if(import.meta.main)process.exitCode=await main(process.argv.slice(2));
