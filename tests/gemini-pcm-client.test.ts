import {afterEach,beforeEach,expect,test} from 'bun:test';
import {float32ToPcm16Base64,GeminiPcmClient} from '../src/geminiPcmClient';
import type {VoiceMediaEvent,VoiceResponse} from '../src/voiceSessionProtocol';

let saved:PropertyDescriptor|undefined;
let processor:{onaudioprocess:((event:unknown)=>void)|null}|null;
class AudioFixture {
  sampleRate=48_000;currentTime=0;destination={};
  async resume(){}async close(){}
  createGain(){return {gain:{value:1},connect(){},disconnect(){}};}
  createMediaStreamSource(){return {connect(){},disconnect(){}};}
  createScriptProcessor(){return processor={onaudioprocess:null,connect(){},disconnect(){}} as typeof processor;}
}
beforeEach(()=>{saved=Object.getOwnPropertyDescriptor(globalThis,'AudioContext');processor=null;Object.defineProperty(globalThis,'AudioContext',{value:AudioFixture,configurable:true});});
afterEach(()=>{if(saved)Object.defineProperty(globalThis,'AudioContext',saved);else delete (globalThis as any).AudioContext;});
const stream={} as MediaStream;
const frame={inputBuffer:{getChannelData:()=>new Float32Array(2048).fill(.1)}};
const pendingRead=()=>new Promise<VoiceResponse>(()=>{});

test('late Gemini media after close cannot publish transcripts or audio',async()=>{
  const seen:VoiceMediaEvent[]=[];let reply!:(value:VoiceResponse)=>void;
  const client=new GeminiPcmClient(action=>action==='media.read'?pendingRead():new Promise(resolve=>{reply=resolve;}),e=>seen.push(e),()=>{});
  await client.start(stream);processor!.onaudioprocess!(frame);await client.close();
  reply({media:[{kind:'output-transcript',text:'old answer',final:true}]});await Bun.sleep(0);
  expect(seen).toEqual([]);
});

test('microphone end drains buffered Gemini input in order before media.end',async()=>{
  const sent:string[]=[];let release!:(value:VoiceResponse)=>void;
  const client=new GeminiPcmClient(action=>{
    if(action==='media.read')return pendingRead();sent.push(action);
    if(sent.length===1)return new Promise(resolve=>{release=resolve;});return Promise.resolve({media:[]});
  },()=>{},()=>{});
  await client.start(stream);
  for(let i=0;i<3;i++)processor!.onaudioprocess!(frame);
  const end=client.finishInput();
  expect(sent).toEqual(['media.append']);
  release({media:[]});await end;await client.close();
  expect(sent).toEqual(['media.append','media.append','media.append','media.end']);
});

test('a saturated Gemini audio queue reports loss once instead of silently dropping speech',async()=>{
  const errors:Error[]=[];let release!:(value:VoiceResponse)=>void;
  const client=new GeminiPcmClient(action=>action==='media.read'?pendingRead():new Promise(resolve=>{release=resolve;}),()=>{},e=>errors.push(e));
  await client.start(stream);
  for(let i=0;i<12;i++)processor!.onaudioprocess!(frame);
  await client.close();release({media:[]});await Bun.sleep(0);
  expect(errors).toHaveLength(1);expect(errors[0]?.message).toContain('음성');
});

test('browser PCM conversion downsamples to signed 16-bit little endian',()=>{
  const source=new Float32Array(48);source.fill(1,0,16);source.fill(-1,16,32);source.fill(.5,32);
  const raw=Buffer.from(float32ToPcm16Base64(source,48_000,16_000),'base64');expect(raw.length).toBe(32);
  expect(raw.readInt16LE(0)).toBe(32767);expect(raw.readInt16LE(12)).toBe(-32768);expect(raw.readInt16LE(24)).toBeGreaterThan(16000);
});

test('PCM conversion rejects unsupported microphone sample rates',()=>{
  expect(()=>float32ToPcm16Base64(new Float32Array([.1]),8_000)).toThrow('샘플 속도');
});

// Streaming resampler (KO-10): 2048-sample ScriptProcessor buffers at 48 kHz are 682.67 output samples each, so a
// per-buffer resample dropped ~0.67 samples every 42.7 ms and the stream jumped at every buffer join.
const decode=(base64:string)=>{const raw=Buffer.from(base64,'base64'),out=new Float32Array(raw.length/2);for(let i=0;i<out.length;i++){const v=raw.readInt16LE(i*2);out[i]=v/(v<0?0x8000:0x7fff);}return out;};
const sine=(length:number,rate:number,hz=440)=>Float32Array.from({length},(_,i)=>.5*Math.sin(2*Math.PI*hz*i/rate));
function streamed(rate:number,signal:Float32Array,chunk=2048){
  const {PcmStreamResampler}=require('../src/geminiPcmClient');const resampler=new PcmStreamResampler(rate);const parts:Float32Array[]=[];const joins:number[]=[];let total=0;
  for(let i=0;i<signal.length;i+=chunk){const out=decode(resampler.processToPcm16Base64(signal.subarray(i,i+chunk)));parts.push(out);total+=out.length;joins.push(total);}
  const all=new Float32Array(total);let at=0;for(const part of parts){all.set(part,at);at+=part.length;}return {all,joins:joins.slice(0,-1)};
}
test('streamed 2048-sample buffers keep the exact output count at 48 kHz and 44.1 kHz',()=>{
  for(const rate of [48_000,44_100]){
    const length=2048*30,{all}=streamed(rate,sine(length,rate));
    expect(Math.abs(all.length-Math.floor(length*16_000/rate))).toBeLessThanOrEqual(1);
  }
});
test('streaming matches a one-shot resample and has no step at buffer joins',()=>{
  const {PcmStreamResampler}=require('../src/geminiPcmClient');
  for(const rate of [48_000,44_100]){
    const signal=sine(2048*30,rate),{all,joins}=streamed(rate,signal);
    const once=decode(new PcmStreamResampler(rate).processToPcm16Base64(signal));
    expect(once.length).toBe(all.length);
    let error=0;for(let i=0;i<once.length;i++)error+=(once[i]!-all[i]!)**2;expect(Math.sqrt(error/once.length)).toBeLessThan(1e-3);
    // The 440 Hz tone itself survives the 7 kHz low-pass (after the filter's short start-up).
    let peak=0;for(let i=200;i<all.length;i++)peak=Math.max(peak,Math.abs(all[i]!));expect(peak).toBeGreaterThan(.45);
    const curvature=(i:number)=>Math.abs(all[i+1]!-2*all[i]!+all[i-1]!);
    const values:number[]=[];for(let i=200;i<all.length-1;i++)values.push(curvature(i));
    const mean=values.reduce((a,b)=>a+b,0)/values.length,sd=Math.sqrt(values.reduce((a,b)=>a+(b-mean)**2,0)/values.length);
    for(const join of joins)if(join>200&&join<all.length-1)for(const i of [join-1,join])expect(curvature(i)).toBeLessThanOrEqual(mean+3*sd);
  }
});
test('the streaming resampler attenuates content above the 8 kHz output Nyquist',()=>{
  const {PcmStreamResampler}=require('../src/geminiPcmClient');
  const out=decode(new PcmStreamResampler(48_000).processToPcm16Base64(sine(48_000,48_000,12_000)));
  let energy=0;for(let i=200;i<out.length;i++)energy+=out[i]!**2;
  // A 12 kHz tone would alias to 4 kHz at the old 3-tap average's ~-6 dB; the low-pass keeps it far below.
  expect(Math.sqrt(energy/(out.length-200))).toBeLessThan(.05);
  expect(()=>new PcmStreamResampler(8_000)).toThrow('샘플 속도');
});
test('the Gemini client sends a continuous stream across ScriptProcessor buffers',async()=>{
  const appended:string[]=[];
  const client=new GeminiPcmClient(async(action,audio)=>{if(action==='media.read')return pendingRead();if(audio)appended.push(audio);return {media:[]};},()=>{},()=>{});
  await client.start(stream);
  const signal=sine(2048*9,48_000);
  for(let i=0;i<9;i++){processor!.onaudioprocess!({inputBuffer:{getChannelData:()=>signal.subarray(i*2048,(i+1)*2048)}});await Bun.sleep(0);}
  await client.close();
  const total=appended.reduce((n,part)=>n+decode(part).length,0);
  expect(Math.abs(total-2048*9/3)).toBeLessThanOrEqual(1);
});
