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

function decodePcm16(data:string):Float32Array {
  const binary=atob(data),result=new Float32Array(Math.floor(binary.length/2));
  for(let i=0;i<result.length;i++){const lo=binary.charCodeAt(i*2),hi=binary.charCodeAt(i*2+1);let value=(hi<<8)|lo;if(value&0x8000)value-=0x10000;result[i]=value/(value<0?0x8000:0x7fff);}
  return result;
}

export class GeminiPcmClient {
  private context:AudioContext|null=null;private source:MediaStreamAudioSourceNode|null=null;private processor:ScriptProcessorNode|null=null;
  private silent:GainNode|null=null;private output:GainNode|null=null;private sources=new Set<AudioBufferSourceNode>();private nextPlay=0;
  private stopped=false;private reading=false;private sending=false;private queue:string[]=[];
  /** The host answered that the conversation is over; nothing more is sent or read. */
  private finished=false;
  constructor(private request:(action:'media.append'|'media.read'|'media.end',audio?:string)=>Promise<VoiceResponse>,private onMedia:(event:VoiceMediaEvent)=>void,private onError:(error:Error)=>void,
    /** Called once when a media answer carries an ended (or failed) session, e.g. at the host's 15-minute limit. */
    private onEnded:(session:VoiceSnapshot)=>void=()=>{}){}
  private hostEnded(result:VoiceResponse):boolean{
    const session=result.session;
    if(!session||session.state!=='ended'&&session.state!=='failed')return false;
    if(!this.finished&&!this.stopped){this.finished=true;this.queue=[];this.onEnded(session);}
    return true;
  }
  async start(stream:MediaStream){
    const Context=globalThis.AudioContext??(globalThis as any).webkitAudioContext;if(!Context)throw Error('이 브라우저는 PCM 음성 연결을 지원하지 않습니다.');
    const context=new Context();this.context=context;await context.resume();this.output=context.createGain();this.output.connect(context.destination);
    this.silent=context.createGain();this.silent.gain.value=0;this.silent.connect(context.destination);
    this.attachInput(stream,context);
    this.reading=true;void this.readLoop();
  }
  private attachInput(stream:MediaStream,context:AudioContext){
    this.source=context.createMediaStreamSource(stream);this.processor=context.createScriptProcessor(2048,1,1);
    this.source.connect(this.processor);this.processor.connect(this.silent!);
    this.processor.onaudioprocess=event=>{if(this.stopped||this.finished)return;try{const data=float32ToPcm16Base64(event.inputBuffer.getChannelData(0),context.sampleRate);if(this.queue.length<6)this.queue.push(data);void this.pump();}catch(error){this.onError(error instanceof Error?error:Error('마이크 음성을 변환하지 못했습니다.'));}};
  }
  /** Gemini Live resumes the same session when audio follows audioStreamEnd, so only the input is reattached. */
  async resumeInput(stream:MediaStream){
    const context=this.context;if(!context||this.stopped||this.finished||!this.silent)throw Error('Gemini 음성 연결이 종료되었습니다. 새 대화로 시작하세요.');
    if(this.source)return;await context.resume();this.attachInput(stream,context);
  }
  private async pump(){if(this.sending||this.stopped||this.finished)return;this.sending=true;try{while(this.queue.length&&!this.stopped&&!this.finished){const result=await this.request('media.append',this.queue.shift()!);this.consume(result.media??[]);if(this.hostEnded(result))break;}}catch(error){if(!this.stopped&&!this.finished)this.onError(error instanceof Error?error:Error('Gemini로 음성을 보내지 못했습니다.'));}finally{this.sending=false;}}
  private async readLoop(){while(this.reading&&!this.stopped&&!this.finished){try{const result=await this.request('media.read');this.consume(result.media??[]);if(this.hostEnded(result))return;}catch(error){if(!this.stopped&&!this.finished)this.onError(error instanceof Error?error:Error('Gemini 음성 응답을 받지 못했습니다.'));return;}}}
  private consume(events:VoiceMediaEvent[]){for(const event of events){if(event.kind==='audio')this.play(event.data);else if(event.kind==='interrupted')this.clearPlayback();this.onMedia(event);}}
  private play(data:string){const context=this.context,output=this.output;if(!context||!output||this.stopped)return;const samples=decodePcm16(data),buffer=context.createBuffer(1,samples.length,24_000);buffer.getChannelData(0).set(samples);const source=context.createBufferSource();source.buffer=buffer;source.connect(output);source.onended=()=>this.sources.delete(source);this.sources.add(source);const at=Math.max(context.currentTime+.02,this.nextPlay);source.start(at);this.nextPlay=at+buffer.duration;}
  private clearPlayback(){for(const source of this.sources)try{source.stop();}catch{}this.sources.clear();this.nextPlay=this.context?.currentTime??0;}
  setMuted(muted:boolean){if(this.output)this.output.gain.value=muted?0:1;}
  async finishInput(){this.processor?.disconnect();this.source?.disconnect();this.processor=null;this.source=null;this.queue=[];if(this.finished)return;this.hostEnded(await this.request('media.end'));}
  async close(){if(this.stopped)return;this.stopped=true;this.reading=false;this.queue=[];this.clearPlayback();this.processor?.disconnect();this.source?.disconnect();this.silent?.disconnect();this.output?.disconnect();await this.context?.close().catch(()=>{});this.context=null;}
}
