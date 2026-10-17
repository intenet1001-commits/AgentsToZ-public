/**
 * Pure PCM helpers shared by the synthetic renderer (voiceEvalSynth) and the acoustic timing analyzer
 * (voiceBenchmarkTiming). Float32 samples in [-1, 1]. No filesystem, process or clock access.
 */
export interface ChirpSpec {f0Hz:number;f1Hz:number;durationMs:number;amplitude:number}
export interface DecodedWav {sampleRate:number;channels:Float32Array[]}

export const samplesForMs=(ms:number, sampleRate:number)=>Math.round(ms*sampleRate/1000);
export const msForSamples=(samples:number, sampleRate:number)=>samples*1000/sampleRate;
export const dbToLinear=(db:number)=>10**(db/20);

export function rmsDbfs(samples:Float32Array):number {
  if(!samples.length)return -Infinity;
  let sum=0;for(let i=0;i<samples.length;i++)sum+=samples[i]!*samples[i]!;
  return sum?10*Math.log10(sum/samples.length):-Infinity;
}
export function peakDbfs(samples:Float32Array):number {
  let peak=0;for(let i=0;i<samples.length;i++)peak=Math.max(peak,Math.abs(samples[i]!));
  return peak?20*Math.log10(peak):-Infinity;
}
/** Per-frame RMS in dBFS (frames do not overlap; a trailing partial frame is included). */
export function frameDbfs(samples:Float32Array, sampleRate:number, frameMs:number):number[] {
  const size=Math.max(1,samplesForMs(frameMs,sampleRate)),out:number[]=[];
  for(let start=0;start<samples.length;start+=size)out.push(rmsDbfs(samples.subarray(start,Math.min(samples.length,start+size))));
  return out;
}
/** Active level: RMS over the frames above `floorDb`, so long silences do not lower a speech level. */
export function activeRmsDbfs(samples:Float32Array, sampleRate:number, frameMs=20, floorDb=-60):number {
  const size=samplesForMs(frameMs,sampleRate);let sum=0,count=0;
  for(let start=0;start<samples.length;start+=size){
    const frame=samples.subarray(start,Math.min(samples.length,start+size));
    if(rmsDbfs(frame)<=floorDb)continue;
    for(let i=0;i<frame.length;i++)sum+=frame[i]!*frame[i]!;
    count+=frame.length;
  }
  return count&&sum?10*Math.log10(sum/count):-Infinity;
}
export function sineWave(sampleRate:number, hz:number, durationMs:number, amplitude:number):Float32Array {
  const out=new Float32Array(samplesForMs(durationMs,sampleRate));
  for(let i=0;i<out.length;i++)out[i]=amplitude*Math.sin(2*Math.PI*hz*i/sampleRate);
  return out;
}
/** Linear sweep from f0 to f1 with a 5 ms raised-cosine fade at both ends (no click, sharp correlation peak). */
export function generateChirp(sampleRate:number, spec:ChirpSpec):Float32Array {
  const n=samplesForMs(spec.durationMs,sampleRate),out=new Float32Array(n),seconds=n/sampleRate,k=(spec.f1Hz-spec.f0Hz)/seconds;
  const fade=Math.min(Math.floor(n/2),samplesForMs(5,sampleRate));
  for(let i=0;i<n;i++){
    const t=i/sampleRate;
    const envelope=i<fade?0.5-0.5*Math.cos(Math.PI*i/fade):i>=n-fade?0.5-0.5*Math.cos(Math.PI*(n-1-i)/fade):1;
    out[i]=spec.amplitude*envelope*Math.sin(2*Math.PI*(spec.f0Hz*t+k*t*t/2));
  }
  return out;
}
export function concatSamples(parts:Float32Array[]):Float32Array {
  const out=new Float32Array(parts.reduce((n,p)=>n+p.length,0));let at=0;
  for(const p of parts){out.set(p,at);at+=p.length;}
  return out;
}
/** 16-bit PCM WAV, one array per channel (all the same length). */
export function encodeWav(channels:Float32Array[], sampleRate:number):Uint8Array {
  const count=channels.length,frames=channels[0]?.length??0;
  if(!count||channels.some(c=>c.length!==frames))throw new Error('WAV_CHANNELS_INVALID');
  const data=frames*count*2,buffer=new ArrayBuffer(44+data),view=new DataView(buffer);
  const ascii=(at:number,text:string)=>{for(let i=0;i<text.length;i++)view.setUint8(at+i,text.charCodeAt(i));};
  ascii(0,'RIFF');view.setUint32(4,36+data,true);ascii(8,'WAVE');ascii(12,'fmt ');view.setUint32(16,16,true);
  view.setUint16(20,1,true);view.setUint16(22,count,true);view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*count*2,true);
  view.setUint16(32,count*2,true);view.setUint16(34,16,true);ascii(36,'data');view.setUint32(40,data,true);
  let at=44;
  for(let i=0;i<frames;i++)for(let c=0;c<count;c++){
    const v=Math.max(-1,Math.min(1,channels[c]![i]!));view.setInt16(at,Math.round(v<0?v*32768:v*32767),true);at+=2;
  }
  return new Uint8Array(buffer);
}
/** PCM 16-bit or float32 WAV (incl. WAVE_FORMAT_EXTENSIBLE); other chunks are skipped. */
export function decodeWav(bytes:Uint8Array):DecodedWav {
  const fail=():never=>{throw new Error('WAV_INVALID');};
  if(bytes.length<12)fail();
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const tag=(at:number)=>String.fromCharCode(...bytes.subarray(at,at+4));
  if(tag(0)!=='RIFF'||tag(8)!=='WAVE')fail();
  let format=0,count=0,sampleRate=0,bits=0,data:{at:number;size:number}|null=null;
  for(let at=12;at+8<=bytes.length;){
    const id=tag(at),size=view.getUint32(at+4,true),body=at+8;
    if(id==='fmt '){
      if(size<16)fail();
      format=view.getUint16(body,true);count=view.getUint16(body+2,true);sampleRate=view.getUint32(body+4,true);bits=view.getUint16(body+14,true);
      if(format===0xfffe&&size>=26)format=view.getUint16(body+24,true);
    }else if(id==='data')data={at:body,size:Math.min(size,bytes.length-body)};
    at=body+size+(size%2);
  }
  if(!data||!count||!sampleRate||!(format===1&&bits===16||format===3&&bits===32))fail();
  const width=bits/8,frames=Math.floor(data!.size/(width*count)),channels=Array.from({length:count},()=>new Float32Array(frames));
  for(let i=0;i<frames;i++)for(let c=0;c<count;c++){
    const at=data!.at+(i*count+c)*width;
    channels[c]![i]=format===1?view.getInt16(at,true)/32768:view.getFloat32(at,true);
  }
  return {sampleRate,channels};
}
