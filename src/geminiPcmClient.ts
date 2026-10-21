import type {VoiceMediaEvent,VoiceResponse,VoiceSnapshot} from './voiceSessionProtocol';

export function float32ToPcm16Base64(input:Float32Array,inputRate:number,outputRate=16_000):string {
  if(!input.length||!Number.isFinite(inputRate)||inputRate<=0||inputRate<outputRate)throw Error('마이크 샘플 속도를 확인하지 못했습니다.');
  const length=Math.max(1,Math.floor(input.length*outputRate/inputRate)),bytes=new Uint8Array(length*2),view=new DataView(bytes.buffer);
  for(let i=0;i<length;i++){
    const start=Math.floor(i*inputRate/outputRate),end=Math.max(start+1,Math.floor((i+1)*inputRate/outputRate));let total=0;
    for(let j=start;j<Math.min(end,input.length);j++)total+=input[j]!;
    const sample=Math.max(-1,Math.min(1,total/Math.max(1,Math.min(end,input.length)-start)));
    view.setInt16(i*2,sample<0?sample*0x8000:sample*0x7fff,true);
  }
  let binary='';for(let i=0;i<bytes.length;i+=0x4000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x4000));return btoa(binary);
}

function pcm16Base64(samples:Float32Array):string {
  const bytes=new Uint8Array(samples.length*2),view=new DataView(bytes.buffer);
  for(let i=0;i<samples.length;i++){const sample=Math.max(-1,Math.min(1,samples[i]!));view.setInt16(i*2,sample<0?sample*0x8000:sample*0x7fff,true);}
  let binary='';for(let i=0;i<bytes.length;i+=0x4000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x4000));return btoa(binary);
}

/**
 * Microphone buffers to 16 kHz PCM as one continuous stream (Gemini Live input). A windowed-sinc low-pass at 7 kHz
 * runs first (the old 3-sample average let 8–16 kHz alias back in), then a fractional resample whose phase and filter
 * history carry across buffers: at 48 kHz a 2048-sample buffer is 682.67 output samples, and resampling each buffer
 * on its own dropped the fraction and jumped at every join. Output k sits at input position k×rate/16000, so the
 * result does not depend on how the input was split.
 */
export class PcmStreamResampler {
  private readonly ratio:number;private readonly taps:Float32Array;
  /** The last taps−1 raw samples (zeros before the stream starts). */
  private history:Float32Array;
  /** Filtered value at global input index `consumed − 1`, for interpolating across a buffer join. */
  private lastFiltered=0;private consumed=0;private produced=0;
  constructor(inputRate:number,private readonly outputRate=16_000){
    if(!Number.isFinite(inputRate)||inputRate<=0||inputRate<outputRate)throw Error('마이크 샘플 속도를 확인하지 못했습니다.');
    this.ratio=inputRate/outputRate;
    if(inputRate===outputRate)this.taps=Float32Array.of(1);
    else{
      const length=2*Math.max(4,Math.round(4*this.ratio))+1,center=(length-1)/2,cutoff=Math.min(7_000,outputRate*.4375)/inputRate;
      const taps=new Float32Array(length);let sum=0;
      for(let i=0;i<length;i++){const x=i-center,sinc=x===0?2*cutoff:Math.sin(2*Math.PI*cutoff*x)/(Math.PI*x);taps[i]=sinc*(.54-.46*Math.cos(2*Math.PI*i/(length-1)));sum+=taps[i]!;}
      for(let i=0;i<length;i++)taps[i]!/=sum;this.taps=taps;
    }
    this.history=new Float32Array(this.taps.length-1);
  }
  process(input:Float32Array):Float32Array{
    const length=input.length,taps=this.taps,order=taps.length-1;if(!length)return new Float32Array(0);
    const extended=new Float32Array(order+length);extended.set(this.history);extended.set(input,order);
    const filtered=new Float32Array(length);
    for(let j=0;j<length;j++){let total=0;for(let m=0;m<=order;m++)total+=taps[m]!*extended[order+j-m]!;filtered[j]=total;}
    const start=this.consumed,last=start+length-1,at=(index:number)=>index<start?this.lastFiltered:filtered[index-start]!;
    const output:number[]=[];
    for(;;){
      const position=this.produced*this.ratio,index=Math.floor(position);if(index+1>last)break;
      const fraction=position-index;output.push(at(index)*(1-fraction)+at(index+1)*fraction);this.produced++;
    }
    this.history=extended.slice(extended.length-order);this.lastFiltered=filtered[length-1]!;this.consumed+=length;
    return Float32Array.from(output);
  }
  processToPcm16Base64(input:Float32Array):string{return pcm16Base64(this.process(input));}
}

function decodePcm16(data:string):Float32Array {
  const binary=atob(data),result=new Float32Array(Math.floor(binary.length/2));
  for(let i=0;i<result.length;i++){const lo=binary.charCodeAt(i*2),hi=binary.charCodeAt(i*2+1);let value=(hi<<8)|lo;if(value&0x8000)value-=0x10000;result[i]=value/(value<0?0x8000:0x7fff);}
  return result;
}

export class GeminiPcmClient {
  private context:AudioContext|null=null;private source:MediaStreamAudioSourceNode|null=null;private processor:ScriptProcessorNode|null=null;
  private silent:GainNode|null=null;private output:GainNode|null=null;private sources=new Set<AudioBufferSourceNode>();private nextPlay=0;
  private stopped=false;private reading=false;private sending:Promise<void>|null=null;private queue:string[]=[];
  private ending:Promise<void>|null=null;private inputFailure:Error|null=null;
  /** The host answered that the conversation is over; nothing more is sent or read. */
  private finished=false;
  private textOnly=false;
  constructor(private request:(action:'media.append'|'media.read'|'media.end',audio?:string)=>Promise<VoiceResponse>,private onMedia:(event:VoiceMediaEvent)=>void,private onError:(error:Error)=>void,
    /** Called once when a media answer carries an ended (or failed) session, e.g. at the host's 15-minute limit. */
    private onEnded:(session:VoiceSnapshot)=>void=()=>{}){}
  private hostEnded(result:VoiceResponse):boolean{
    const session=result.session;
    if(!session||session.state!=='ended'&&session.state!=='failed')return false;
    if(!this.finished&&!this.stopped){this.finished=true;this.queue=[];this.onEnded(session);}
    return true;
  }
  private async prepareAudio(){
    if(this.context)return this.context;
    const Context=globalThis.AudioContext??(globalThis as any).webkitAudioContext;if(!Context)throw Error('이 브라우저는 PCM 음성 연결을 지원하지 않습니다.');
    const context=new Context();this.context=context;await context.resume();if(this.stopped||this.finished)throw Error('대화 연결이 종료되었습니다.');this.output=context.createGain();this.output.gain.value=this.textOnly?0:1;this.output.connect(context.destination);
    this.silent=context.createGain();this.silent.gain.value=0;this.silent.connect(context.destination);
    return context;
  }
  startTextOnly(){this.textOnly=true;this.reading=true;void this.readLoop();}
  setTextOnly(textOnly:boolean){this.textOnly=textOnly;if(textOnly)this.clearPlayback();this.setMuted(textOnly);}
  async start(stream:MediaStream){
    const context=await this.prepareAudio();if(this.stopped||this.finished)return;this.attachInput(stream,context);
    this.reading=true;void this.readLoop();
  }
  private attachInput(stream:MediaStream,context:AudioContext){
    // A resumed input is a new stream: its resampler starts fresh rather than interpolating from the old microphone.
    let resampler:PcmStreamResampler|null=null;
    this.source=context.createMediaStreamSource(stream);this.processor=context.createScriptProcessor(2048,1,1);
    this.source.connect(this.processor);this.processor.connect(this.silent!);
    this.processor.onaudioprocess=event=>{
      if(this.stopped||this.finished||this.inputFailure)return;
      try{
        if(this.queue.length>=6)throw Error('음성 전송이 밀려 발화를 온전히 전달하지 못했습니다. 연결을 확인하고 다시 말씀해 주세요.');
        resampler??=new PcmStreamResampler(context.sampleRate);
        const samples=resampler.process(event.inputBuffer.getChannelData(0));if(!samples.length)return;
        this.queue.push(pcm16Base64(samples));void this.pump();
      }catch(error){this.failInput(error instanceof Error?error:Error('마이크 음성을 변환하지 못했습니다.'));}
    };
  }
  /** Gemini Live resumes the same session when audio follows audioStreamEnd, so only the input is reattached. */
  async resumeInput(stream:MediaStream){
    await this.ending;
    if(this.stopped||this.finished)throw Error('Gemini 음성 연결이 종료되었습니다. 새 대화로 시작하세요.');
    const context=await this.prepareAudio();
    if(this.inputFailure)throw this.inputFailure;
    if(this.source)return;await context.resume();if(this.stopped||this.finished)return;this.attachInput(stream,context);
  }
  private failInput(error:Error){if(this.inputFailure||this.stopped||this.finished)return;this.inputFailure=error;this.queue=[];this.onError(error);}
  private pump():Promise<void>{
    if(this.sending)return this.sending;
    if(this.stopped||this.finished||this.inputFailure)return Promise.resolve();
    const pending=this.drain();this.sending=pending;
    void pending.then(()=>{if(this.sending===pending)this.sending=null;});return pending;
  }
  private async drain(){
    try{while(this.queue.length&&!this.stopped&&!this.finished&&!this.inputFailure){const result=await this.request('media.append',this.queue.shift()!);if(this.stopped||this.finished)return;this.consume(result.media??[]);if(this.hostEnded(result))return;}}
    catch(error){this.failInput(error instanceof Error?error:Error('Gemini로 음성을 보내지 못했습니다.'));}
  }
  private async readLoop(){while(this.reading&&!this.stopped&&!this.finished){try{const result=await this.request('media.read');this.consume(result.media??[]);if(this.hostEnded(result))return;}catch(error){if(!this.stopped&&!this.finished)this.onError(error instanceof Error?error:Error('Gemini 음성 응답을 받지 못했습니다.'));return;}}}
  private consume(events:VoiceMediaEvent[]){for(const event of events){if(this.stopped||this.finished)return;if(event.kind==='audio')this.play(event.data);else if(event.kind==='interrupted')this.clearPlayback();this.onMedia(event);}}
  private play(data:string){const context=this.context,output=this.output;if(this.textOnly||!context||!output||this.stopped)return;const samples=decodePcm16(data),buffer=context.createBuffer(1,samples.length,24_000);buffer.getChannelData(0).set(samples);const source=context.createBufferSource();source.buffer=buffer;source.connect(output);source.onended=()=>this.sources.delete(source);this.sources.add(source);const at=Math.max(context.currentTime+.02,this.nextPlay);source.start(at);this.nextPlay=at+buffer.duration;}
  private clearPlayback(){for(const source of this.sources)try{source.stop();}catch{}this.sources.clear();this.nextPlay=this.context?.currentTime??0;}
  setMuted(muted:boolean){if(this.output)this.output.gain.value=muted?0:1;}
  finishInput():Promise<void>{
    if(!this.source&&!this.processor)return this.ending??Promise.resolve();
    if(this.processor)this.processor.onaudioprocess=null;this.processor?.disconnect();this.source?.disconnect();this.processor=null;this.source=null;
    if(this.ending)return this.ending;
    const pending=this.endInput();this.ending=pending;
    const release=()=>{if(this.ending===pending)this.ending=null;};void pending.then(release,release);return pending;
  }
  private async endInput(){
    // media.end must follow every captured chunk, including the append awaiting its reply.
    await this.pump();if(this.stopped||this.finished)return;if(this.inputFailure)throw this.inputFailure;
    const result=await this.request('media.end');if(this.stopped||this.finished)return;this.consume(result.media??[]);this.hostEnded(result);
  }
  async close(){if(this.stopped)return;this.stopped=true;this.reading=false;this.queue=[];this.clearPlayback();if(this.processor)this.processor.onaudioprocess=null;this.processor?.disconnect();this.source?.disconnect();this.silent?.disconnect();this.output?.disconnect();await this.context?.close().catch(()=>{});this.context=null;}
}
