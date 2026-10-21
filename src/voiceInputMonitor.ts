/** Local-only level measurement. No recording, playback, or additional network upload. */
export class VoiceInputMonitor {
  private context:AudioContext|null=null;
  private source:MediaStreamAudioSourceNode|null=null;
  private analyser:AnalyserNode|null=null;
  private timer:ReturnType<typeof setInterval>|undefined;
  constructor(){
    try{if(typeof AudioContext!=='undefined'){this.context=new AudioContext();void this.context.resume().catch(()=>{});}}catch{/* Meter availability must not block voice. */}
  }
  attach(stream:MediaStream,onLevel:(level:number|null)=>void){
    const context=this.context;if(!context){onLevel(null);return;}
    try{
      const analyser=context.createAnalyser();analyser.fftSize=512;
      this.analyser=analyser;this.source=context.createMediaStreamSource(stream);this.source.connect(analyser);
      const data=new Float32Array(analyser.fftSize);
      this.timer=setInterval(()=>{
        if(context.state!=='running'){onLevel(null);return;}
        analyser.getFloatTimeDomainData(data);
        const rms=Math.sqrt(data.reduce((sum,n)=>sum+n*n,0)/data.length);
        onLevel(Math.min(1,rms*5));
      },200);
    }catch{this.close();onLevel(null);}
  }
  close(){clearInterval(this.timer);this.timer=undefined;this.source?.disconnect();this.analyser?.disconnect();this.source=null;this.analyser=null;const context=this.context;this.context=null;if(context)void context.close().catch(()=>{});}
}
