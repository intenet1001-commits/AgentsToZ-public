import {readAppLanguage} from './i18n';
import {VoiceInputMonitor} from './voiceInputMonitor';
import {voiceInputHint,type VoiceInputHint} from './voiceInputStats';
import {GeminiPcmClient} from './geminiPcmClient';
import {normalizeVoiceResponse,VOICE_CLIENT_LIMIT_MARGIN_MS,VOICE_CONVERSATION_LIMIT_MS,VOICE_TIME_LIMIT_NOTICE,type VoiceActiveTarget,type VoicePartner,type VoiceProjectChoice,type VoiceProjectPage,type VoiceMediaEvent,type VoiceMode,type VoiceProvider,type VoiceSnapshot,type VoiceTarget} from './voiceSessionProtocol';
import {localVoiceTransport,type VoiceTransport} from './voiceSessionClient';
import {isTauri} from './lib/env';
import {voiceCaptionSource} from './voiceCaption';
import {readVoiceCaptionMode,voicePreferenceStorage,writeVoiceCaptionMode,type VoiceCaptionMode} from './voicePreferences';
import {isTransientNetworkError} from './remoteTransientNetworkError';
/** One subtitle line (VOC 2026-09-29): what was said and, by default, its translation into the other language. */
export interface VoiceCaptionLine {id:string;role:'user'|'assistant';text:string;source:'ko'|'en';translation:string|null;state:'original'|'translating'|'translated'|'failed'}
const MAX_CAPTION_LINES=12;
/** One-off errors that stop mattering once voice works again (the dock would otherwise pin them in red). */
const TRANSCRIBE_FAILED='발화를 감지했지만 전사하지 못했습니다. 다시 짧게 말씀해 주세요.',PROVIDER_ERROR='음성 제공자에서 오류가 발생했습니다. 연결과 사용량을 확인하세요.';
/**
 * What both microphone acquisitions ask the browser for (start and resumeInput). Server near_field noise reduction
 * stacks on top of whatever the browser applies; captureSettings() says what that actually was on this device.
 */
export const VOICE_CAPTURE_CONSTRAINTS={audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false} as const;
/** The browser-applied capture settings, booleans and numbers only (no device id, group id or label). Local only. */
export interface VoiceCaptureSettings {echoCancellation?:boolean;noiseSuppression?:boolean;autoGainControl?:boolean;sampleRate?:number;channelCount?:number}
function appliedCaptureSettings(track:MediaStreamTrack|undefined):VoiceCaptureSettings|null{
  const settings=(track as (MediaStreamTrack&{getSettings?:()=>MediaTrackSettings})|undefined)?.getSettings?.();if(!settings)return null;
  const kept:VoiceCaptureSettings={};
  for(const key of ['echoCancellation','noiseSuppression','autoGainControl'] as const)if(typeof settings[key]==='boolean')kept[key]=settings[key];
  for(const key of ['sampleRate','channelCount'] as const)if(typeof settings[key]==='number'&&Number.isFinite(settings[key]))kept[key]=settings[key];
  return kept;
}
/** An older Mac answers new dock requests with this; the dock then quietly hides what it cannot do. */
const unsupported=(error:unknown)=>error instanceof Error&&error.message.includes('지원하지 않는 음성 요청');
export interface VoiceMediaState {
  phase:'idle'|'preparing'|'listening'|'review'|'ended'|'failed';owner:string|null;
  device:string;level:number|null;inputState:'waiting'|'speaking'|'transcribing'|'recognized';
  session:VoiceSnapshot|null;microphone:boolean;muted:boolean;caption:string;answer:string;error:string;textOnly?:boolean;
  /** Finished lines for the subtitle strip, newest last. */
  captions:VoiceCaptionLine[];captionMode:VoiceCaptionMode;
  /** Who the dock can switch to (OPS voice only); null until known, false-y support when the Mac is older. */
  partners:VoiceActiveTarget[]|null;partnersSupported:boolean|null;
  /** Whether this Mac relays 담당자 conversations into the workroom (null until asked; false on an older Mac). */
  relaySupported:boolean|null;
  /** What this phone measured about its own microphone while listening (headset VOC 2026-10-08); null when nothing to say. */
  inputHint:VoiceInputHint;
  /** A bounded recovery of this connection; no prepare/connect or user command is replayed. */
  connectionNotice?:string;
}
/** One media owner per web surface. Host admission additionally fences other windows/devices. */
export class VoiceMediaClient {
  private value:VoiceMediaState={phase:'idle',owner:null,device:'',level:null,inputState:'waiting',session:null,microphone:false,muted:false,caption:'',answer:'',error:'',captions:[],captionMode:readVoiceCaptionMode(voicePreferenceStorage()),partners:null,partnersSupported:null,relaySupported:null,inputHint:null};
  private target:VoiceTarget|null=null;private captionsSupported=true;private geminiLine=0;private partnerTick=0;
  private listeners=new Set<()=>void>();private epoch=0;
  private stream:MediaStream|null=null;private peer:RTCPeerConnection|null=null;private channel:RTCDataChannel|null=null;
  private audio:HTMLAudioElement|null=null;private remoteAudio:MediaStream|null=null;private transport:VoiceTransport|null=null;
  private gemini:GeminiPcmClient|null=null;
  private heartbeat:ReturnType<typeof setTimeout>|undefined;private deadline:ReturnType<typeof setTimeout>|undefined;private idle:ReturnType<typeof setTimeout>|undefined;
  private submission:{fingerprint:string;requestId:string}|null=null;
  private monitor:VoiceInputMonitor|null=null;
  private speech=false;private interruptConnect:(()=>void)|null=null;
  private releaseEvents:(()=>void)|null=null;
  private inputEpoch=0;private resuming:Promise<void>|null=null;
  private capture:VoiceCaptureSettings|null=null;
  private mediaRecovery:ReturnType<typeof setTimeout>|undefined;
  private controlRecovering=false;private mediaRecovering=false;
  private releaseStoppingPeer:(()=>void)|null=null;
  /** Limits are injectable only so a test does not wait 15 minutes; the app uses the defaults. */
  constructor(private readonly limits:{conversationMs:number;dictationMs:number;marginMs?:number;pollMs?:number;retryMs?:number;initialPollMs?:number;mediaGraceMs?:number;localStopMs?:number}={conversationMs:VOICE_CONVERSATION_LIMIT_MS,dictationMs:120_000,marginMs:VOICE_CLIENT_LIMIT_MARGIN_MS}){}
  private connectionNotice(){this.update({connectionNotice:this.mediaRecovering?'음성 연결을 복구하고 있습니다. 같은 대화를 유지하며, 연결이 돌아온 뒤 말씀해 주세요.':this.controlRecovering?'호스트 상태를 다시 확인하고 있습니다. 같은 음성 대화와 작성 내용을 유지합니다.':''});}
  /**
   * Time left before the conversation should end. The host counts its limit from prepare (expiresAt),
   * so counting from connect let the host always expire first and the person saw an error instead
   * of the limit notice. Measured on this device's clock from the prepare answer — a phone's clock
   * may differ from the Mac's — and ended a margin early so the end is the client's own clean stop.
   */
  private untilLimit(preparedAt:number){return Math.max(0,preparedAt+this.limits.conversationMs-(this.limits.marginMs??VOICE_CLIENT_LIMIT_MARGIN_MS)-Date.now());}
  /**
   * A dropped data channel or a media error is often the host ending the conversation at its limit
   * (it hangs up the provider). Ask the host first: a normal end keeps its notice and is no failure.
   */
  private async failUnlessEnded(epoch:number,message:string){
    const session=this.value.session,transport=this.transport;
    if(session&&transport)try{
      const result=normalizeVoiceResponse(await transport({action:'state',requestId:crypto.randomUUID(),sessionId:session.id}));
      if(epoch!==this.epoch)return;
      if(result.session?.state==='ended'){await this.stop(undefined,result.session.notice);return;}
    }catch{/* The host could not say; report what failed here. */}
    if(epoch===this.epoch)await this.stop(message);
  }
  snapshot=()=>this.value;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  /** Microphone evidence since listening began: loudest meter reading, time above a speaking level, speech seen. */
  private probe={since:0,peak:0,loudMs:0,speech:false,lastLevelAt:0};
  private probeInput(patch:Partial<VoiceMediaState>):Partial<VoiceMediaState>{
    const now=Date.now(),phase=patch.phase??this.value.phase;
    if(phase!=='listening'){this.probe.since=0;return this.value.inputHint&&patch.inputHint===undefined?{...patch,inputHint:null}:patch;}
    if(!this.probe.since||this.value.phase!=='listening')this.probe={since:now,peak:0,loudMs:0,speech:false,lastLevelAt:0};
    if(patch.inputState&&patch.inputState!=='waiting')this.probe.speech=true;
    if(typeof patch.level==='number'){
      this.probe.peak=Math.max(this.probe.peak,patch.level);
      if(patch.level>=0.15&&this.probe.lastLevelAt)this.probe.loudMs+=Math.min(400,now-this.probe.lastLevelAt);
      this.probe.lastLevelAt=now;
    }
    const inputHint=voiceInputHint({listeningMs:now-this.probe.since,peak:this.probe.peak,loudMs:this.probe.loudMs,speechSeen:this.probe.speech});
    return inputHint!==this.value.inputHint?{...patch,inputHint}:patch;
  }
  private update(patch:Partial<VoiceMediaState>){
    patch=this.probeInput(patch);
    const previous=this.value.session?.activeTarget,next=patch.session?.activeTarget;
    const previousOpened=this.value.session?.openedWorkroom?.eventId,opened=patch.session?.openedWorkroom;
    this.value={...this.value,...patch};this.listeners.forEach(l=>l());
    if(opened&&opened.eventId!==previousOpened&&typeof window!=='undefined')
      window.dispatchEvent(new CustomEvent('agentstoz:voice-workroom-opened',{detail:opened}));
    // Initial binding already matches the surface that opened Voice. Navigate only
    // after an established OPS session actually switches delegates (or returns).
    if(next&&JSON.stringify(previous)!==JSON.stringify(next)){
      if(previous&&typeof window!=='undefined')window.dispatchEvent(new CustomEvent('agentstoz:voice-target-change',{detail:next}));
      // Voice switched partner (or a tap did): the dock's list must show who answers now (it skips until listening).
      if(this.value.partnersSupported!==false)void this.refreshPartners().catch(()=>{});
    }
  }
  private cleanup(){
    ++this.inputEpoch;this.resuming=null;
    clearTimeout(this.mediaRecovery);this.controlRecovering=false;this.mediaRecovering=false;
    this.monitor?.close();this.monitor=null;
    this.interruptConnect?.();this.interruptConnect=null;
    clearTimeout(this.heartbeat);clearTimeout(this.deadline);clearTimeout(this.idle);this.releaseEvents?.();this.releaseEvents=null;
    for(const track of this.stream?.getTracks()??[]){track.onended=null;track.stop();}this.stream=null;
    if(this.channel){this.channel.onmessage=null;this.channel.onclose=null;this.channel.close();}this.channel=null;
    if(this.peer){this.peer.onconnectionstatechange=null;this.peer.ontrack=null;this.peer.close();}this.peer=null;
    if(this.audio){this.audio.pause();this.audio.srcObject=null;this.audio.remove();this.audio=null;}
    this.remoteAudio=null;
    void this.gemini?.close();this.gemini=null;
  }
  /** Only the desktop's direct local capability path may wait; remote/error/background teardown stays immediate. */
  private holdLocalPeer(){
    if(!isTauri()||this.transport!==localVoiceTransport||!this.peer)return null;
    const peer=this.peer,channel=this.channel;this.peer=null;this.channel=null;
    peer.onconnectionstatechange=null;peer.ontrack=null;if(channel){channel.onmessage=null;channel.onclose=null;}
    let resolve!:(value:undefined)=>void,timer:ReturnType<typeof setTimeout>|undefined,released=false;
    const done=new Promise<undefined>(r=>{resolve=r;});
    const release=()=>{if(released)return;released=true;clearTimeout(timer);try{channel?.close();}catch{}try{peer.close();}catch{}if(this.releaseStoppingPeer===release)this.releaseStoppingPeer=null;resolve(undefined);};
    this.releaseStoppingPeer?.();this.releaseStoppingPeer=release;
    const limit=this.limits.localStopMs??10_000;timer=setTimeout(release,Number.isFinite(limit)?Math.max(1,Math.min(10_000,limit)):10_000);
    return {done,release};
  }
  private touch(){
    clearTimeout(this.idle);
    if(this.value.microphone)this.idle=setTimeout(()=>{this.finishInput();this.update({error:'60초 동안 발화가 없어 마이크를 껐습니다. 마이크 버튼을 누르면 같은 대화를 이어갑니다.'});},60_000);
  }
  async start(owner:string,target:VoiceTarget,mode:VoiceMode,transport:VoiceTransport,recordConsent=false,provider:VoiceProvider='openai',textOnly=false){
    if(this.value.owner&&['preparing','listening','review'].includes(this.value.phase))throw Error('현재 음성 대화를 먼저 종료하세요.');
    this.releaseStoppingPeer?.();
    if(!textOnly&&(!globalThis.isSecureContext||!navigator.mediaDevices?.getUserMedia)||provider==='openai'&&typeof RTCPeerConnection==='undefined')throw Error(textOnly?'이 화면은 대화 연결을 지원하지 않습니다. HTTPS 인터넷 연결을 사용하세요.':'이 화면은 마이크 연결을 지원하지 않습니다. iPhone에서는 HTTPS 인터넷 연결을 사용하세요.');
    if(textOnly)mode='conversation';
    const epoch=++this.epoch;this.transport=transport;this.submission=null;this.speech=false;this.capture=null;
    this.monitor=textOnly?null:new VoiceInputMonitor();
    this.target=target;this.captionsSupported=true;this.partnerTick=0;
    this.update({device:'',level:null,inputState:'waiting',phase:'preparing',owner,session:null,microphone:false,muted:textOnly,textOnly,caption:'',answer:'',error:'',connectionNotice:'',captions:[],partners:null,partnersSupported:null,relaySupported:null});
    const current=()=>this.epoch===epoch;
    const nativeWorkroom=(window as typeof window&{agentstozNativeWorkroom?:boolean}).agentstozNativeWorkroom===true;
    // WKWebView briefly reports the document hidden while presenting native media
    // permission UI. The native shell emits a dedicated event for a real app
    // background transition, so that prompt must not tear down a new microphone.
    const stopOnHide=()=>{if(document.hidden&&!nativeWorkroom)void this.stop(undefined,undefined,true);};const stopOnExit=()=>{void this.stop(undefined,undefined,true);};
    const stopOnNativeBackground=()=>{if(nativeWorkroom)void this.stop(undefined,undefined,true);};
    document.addEventListener('visibilitychange',stopOnHide);window.addEventListener('pagehide',stopOnExit);window.addEventListener('agentstoz:native-background',stopOnNativeBackground);
    this.releaseEvents=()=>{document.removeEventListener('visibilitychange',stopOnHide);window.removeEventListener('pagehide',stopOnExit);window.removeEventListener('agentstoz:native-background',stopOnNativeBackground);};
    this.deadline=setTimeout(()=>{void this.stop('음성 연결 준비 시간이 초과되었습니다.');},60_000);
    try{
      this.currentInputItem='';this.reviewedItem='';
      const prepared=normalizeVoiceResponse(await transport({action:'prepare',requestId:crypto.randomUUID(),target,mode,provider,language:readAppLanguage(),consent:true,...(recordConsent?{recordConsent:true}:{})}));
      if(!prepared.session)throw Error('음성 세션을 준비하지 못했습니다.');
      const preparedAt=Date.now();
      if(!current()){void transport({action:'stop',requestId:crypto.randomUUID(),sessionId:prepared.session.id}).catch(()=>{});return;}
      this.update({session:prepared.session});this.poll(epoch);
      const stream=textOnly?null:await navigator.mediaDevices.getUserMedia(VOICE_CAPTURE_CONSTRAINTS);
      if(!current()){stream?.getTracks().forEach(t=>t.stop());return;}
      if(stream){this.stream=stream;this.recordCapture(stream);this.update({microphone:true,device:stream.getTracks()[0]?.label||'기본 마이크'});this.monitor?.attach(stream,level=>{if(current())this.update({level});});stream.getTracks().forEach(t=>{t.onended=()=>{void this.stop('마이크 연결이 끊겼습니다.');};});}
      if(prepared.session.provider==='gemini'){
        const connected=normalizeVoiceResponse(await transport({action:'media.connect',requestId:crypto.randomUUID(),sessionId:prepared.session.id}));if(!current())return;
        for(const event of connected.media??[])this.geminiEvent(event);
        const sessionId=prepared.session.id;
        const gemini=new GeminiPcmClient(async(action,audio)=>normalizeVoiceResponse(await transport({action,requestId:crypto.randomUUID(),sessionId,...(audio?{audio}:{})})),event=>{if(current())this.geminiEvent(event);},
          error=>{if(current())void this.failUnlessEnded(epoch,error.message);},
          // The host ended it (e.g. its limit) and said so in a media answer: end with its notice, not an error.
          ended=>{if(current())void(ended.state==='ended'?this.stop(undefined,ended.notice):this.stop(ended.notice||'음성 연결이 종료되었습니다.'));});
        this.gemini=gemini;if(textOnly)gemini.startTextOnly();else await gemini.start(stream!);if(!current())return;
        clearTimeout(this.deadline);this.deadline=setTimeout(()=>{void this.stop(undefined,VOICE_TIME_LIMIT_NOTICE);},this.untilLimit(preparedAt));
        this.update({session:connected.session??prepared.session,phase:textOnly?'review':'listening'});this.touch();void this.refreshPartners().catch(()=>{});void this.probeRelay();return;
      }
      const peer=new RTCPeerConnection();this.peer=peer;
      peer.ontrack=e=>{if(current()){this.remoteAudio=e.streams[0]??new MediaStream([e.track]);this.playRemoteAudio(epoch);}};
      if(stream)stream.getTracks().forEach(t=>peer.addTrack(t,stream));
      else peer.addTransceiver('audio',{direction:'sendrecv'});
      const channel=peer.createDataChannel('oai-events');this.channel=channel;
      channel.onmessage=e=>{if(current())this.event(e.data);};
      channel.onclose=()=>{if(current())void this.failUnlessEnded(epoch,'음성 데이터 연결이 종료되었습니다.');};
      peer.onconnectionstatechange=()=>{
        if(!current())return;
        if(peer.connectionState==='connected'){clearTimeout(this.mediaRecovery);this.mediaRecovering=false;this.connectionNotice();}
        else if(peer.connectionState==='disconnected'){
          if(this.mediaRecovering)return;this.mediaRecovering=true;this.connectionNotice();
          this.mediaRecovery=setTimeout(()=>{if(current()&&peer.connectionState==='disconnected')void this.failUnlessEnded(epoch,'음성 네트워크 연결을 복구하지 못했습니다. 다시 연결하세요.');},this.limits.mediaGraceMs??5000);
        }else if(['failed','closed'].includes(peer.connectionState))void this.failUnlessEnded(epoch,'음성 네트워크 연결이 끊겼습니다.');
      };
      const offer=await peer.createOffer();await peer.setLocalDescription(offer);if(!current())return;
      const answer=normalizeVoiceResponse(await transport({action:'connect',requestId:crypto.randomUUID(),sessionId:prepared.session.id,sdp:offer.sdp!}));
      if(!current())return;if(!answer.sdp)throw Error('음성 연결 응답이 없습니다.');
      await peer.setRemoteDescription({type:'answer',sdp:answer.sdp});
      if(!current())return;
      if(channel.readyState!=='open')await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>finish(Error('음성 미디어 연결 시간이 초과되었습니다.')),10_000);
        const finish=(error?:Error)=>{clearTimeout(timer);channel.removeEventListener('open',opened);this.interruptConnect=null;error?reject(error):resolve();};
        const opened=()=>finish();this.interruptConnect=()=>finish(Error('음성 연결을 취소했습니다.'));channel.addEventListener('open',opened,{once:true});
      });
      if(!current())return;
      clearTimeout(this.deadline);this.deadline=setTimeout(()=>{if(mode==='dictation')this.finishInput();else void this.stop(undefined,VOICE_TIME_LIMIT_NOTICE);},mode==='dictation'?this.limits.dictationMs:this.untilLimit(preparedAt));
      this.update({phase:textOnly?'review':'listening'});this.touch();void this.refreshPartners().catch(()=>{});void this.probeRelay();
    }catch(error){if(current())await this.stop(error instanceof Error?error.message:'음성을 연결하지 못했습니다.');}
  }
  private poll(epoch:number){
    let failures=0;
    const poll=async()=>{
      if(epoch!==this.epoch||!this.value.session||!this.transport)return;
      try{
        const result=normalizeVoiceResponse(await this.transport({action:'state',requestId:crypto.randomUUID(),sessionId:this.value.session.id}));
        if(epoch!==this.epoch)return;
        if(!result.session)throw Error('음성 상태를 확인하지 못했습니다.');
        failures=0;this.controlRecovering=false;this.connectionNotice();
        this.update({session:result.session});
        const review=result.session.recognition;
        if(review&&this.reviewedItem!==review.itemId){this.reviewedItem=review.itemId;if(!this.currentInputItem||this.currentInputItem===review.itemId)this.update({caption:review.text,inputState:'recognized'});const prior=this.value.captions.find(c=>c.id===review.itemId);if(prior&&prior.text!==review.text)this.addCaption('user',review.itemId,review.text,true);}
        if(['ended','failed'].includes(result.session.state)){await this.stop(result.session.state==='failed'?result.session.notice:undefined);return;}
        // Workrooms opened or closed elsewhere show up within ~15 s (one read per three polls).
        if(++this.partnerTick%3===0&&this.value.partnersSupported!==false)void this.refreshPartners().catch(()=>{});
      }catch(error){
        if(epoch!==this.epoch)return;
        // Only read-only state is retried. Permission/expiry/protocol errors end immediately.
        const code=(error as {code?:unknown}|null)?.code;
        if((isTransientNetworkError(error)||['REMOTE_CONTROL_PHONE_OFFLINE','REMOTE_CONTROL_RESULT_UNREACHABLE','REMOTE_CONTROL_REQUEST_UNSENT','REMOTE_CONTROL_REQUEST_UNSENT_AHEAD'].includes(String(code)))&&++failures<=2){
          this.controlRecovering=true;this.connectionNotice();this.heartbeat=setTimeout(poll,this.limits.retryMs??1000);return;
        }
        await this.stop(error instanceof Error?error.message:'음성 호스트 연결이 끊겼습니다.');return;
      }
      if(epoch===this.epoch)this.heartbeat=setTimeout(poll,this.limits.pollMs??5000);
    };this.heartbeat=setTimeout(poll,this.limits.initialPollMs??1000);
  }
  private event(raw:unknown){
    if(typeof raw!=='string'||raw.length>128_000)return;
    let e:any;try{e=JSON.parse(raw);}catch{return;}
    if(e.type==='input_audio_buffer.speech_started'){if(typeof e.item_id==='string')this.currentInputItem=e.item_id;this.speech=true;this.touch();this.update({caption:'',inputState:'speaking'});}
    if(e.type==='input_audio_buffer.speech_stopped'){this.speech=false;this.update({inputState:'transcribing'});}
    if(e.type==='conversation.item.input_audio_transcription.delta'&&typeof e.delta==='string'&&(!e.item_id||!this.currentInputItem||e.item_id===this.currentInputItem))this.update({caption:(this.value.caption+e.delta).slice(-4000)});
    if(e.type==='input_audio_buffer.committed'&&typeof e.item_id==='string')this.currentInputItem=e.item_id;
    if(e.type==='conversation.item.input_audio_transcription.completed'&&typeof e.transcript==='string'){if(!this.currentInputItem||this.currentInputItem===e.item_id)this.update({caption:e.transcript.slice(-4000),inputState:'recognized',...this.recovered()});this.addCaption('user',String(e.item_id??crypto.randomUUID()),e.transcript);}
    if(e.type==='response.output_audio_transcript.done'&&typeof e.transcript==='string')this.addCaption('assistant',String(e.item_id??crypto.randomUUID()),e.transcript);
    if(e.type==='conversation.item.input_audio_transcription.failed')this.update({inputState:'waiting',error:TRANSCRIBE_FAILED});
    if(e.type==='response.created')this.update({answer:'',...this.recovered()});
    if(e.type==='response.output_audio_transcript.delta'&&typeof e.delta==='string')this.update({answer:(this.value.answer+e.delta).slice(-6000)});
    if(e.type==='error'&&e.error?.code!=='input_audio_buffer_commit_empty')this.update({error:PROVIDER_ERROR});
  }
  private recovered():Partial<VoiceMediaState>{return this.value.error===TRANSCRIBE_FAILED||this.value.error===PROVIDER_ERROR?{error:''}:{};}
  private geminiEvent(event:VoiceMediaEvent){
    if(event.kind==='input-transcript'){this.touch();this.update({caption:event.text.slice(-4000),inputState:event.final?'recognized':'speaking',...(event.final?this.recovered():{})});if(event.final)this.addCaption('user','gemini_'+(++this.geminiLine),event.text);}
    if(event.kind==='output-transcript'){this.update({answer:event.text.slice(-6000)});if(event.final)this.addCaption('assistant','gemini_'+(++this.geminiLine),event.text);}
    if(event.kind==='interrupted')this.update({answer:''});
  }
  /**
   * A finished line joins the subtitle strip. In the default two-language mode the Mac translates it
   * (Korean → English, English → Korean) with the provider already consented to for this conversation.
   */
  private reviewedItem='';
  private currentInputItem='';
  private addCaption(role:'user'|'assistant',id:string,raw:string,replace=false){
    const text=raw.trim().slice(0,1200),existing=this.value.captions.find(line=>line.id===id);if(!text||this.value.captionMode==='off'&&!this.value.textOnly||existing&&(!replace||existing.text===text))return;
    const translate=this.value.captionMode==='bilingual'&&this.captionsSupported&&!!this.value.session&&!!this.transport;
    const line:VoiceCaptionLine={id,role,text,source:voiceCaptionSource(text),translation:null,state:translate?'translating':'original'};
    this.update({captions:existing?this.value.captions.map(item=>item.id===id?line:item):[...this.value.captions,line].slice(-MAX_CAPTION_LINES)});
    if(!translate)return;
    const epoch=this.epoch,transport=this.transport!,sessionId=this.value.session!.id;
    const settle=(patch:Partial<VoiceCaptionLine>)=>{if(epoch===this.epoch)this.update({captions:this.value.captions.map(item=>item.id===id&&item.text===text?{...item,...patch}:item)});};
    void transport({action:'caption',requestId:crypto.randomUUID(),sessionId,text}).then(result=>{const caption=normalizeVoiceResponse(result).caption;settle(caption?{translation:caption.translation,state:'translated'}:{state:'failed'});})
      .catch(error=>{if(epoch!==this.epoch)return;if(unsupported(error))this.captionsSupported=false;settle({state:unsupported(error)?'original':'failed'});});
  }
  setCaptionMode(mode:VoiceCaptionMode){writeVoiceCaptionMode(voicePreferenceStorage(),mode);this.update({captionMode:mode,...(mode==='off'&&!this.value.textOnly?{captions:[]}:{})});}
  /** The dock's list: the 총괄 plus running workrooms. An older Mac cannot answer; the dock then hides it. */
  async refreshPartners(){
    const session=this.value.session,transport=this.transport;
    if(!session||!transport||this.target?.kind!=='ops'||!['listening','review'].includes(this.value.phase))return;
    const epoch=this.epoch;
    try{const result=normalizeVoiceResponse(await transport({action:'partners',requestId:crypto.randomUUID(),sessionId:session.id}));if(epoch===this.epoch)this.update({partners:result.partners??null,partnersSupported:true});}
    catch(error){if(epoch===this.epoch)this.update(unsupported(error)?{partners:null,partnersSupported:false}:{});if(!unsupported(error))throw error;}
  }
  /** Asks the Mac once whether it relays; the dock promises 「그대로 들어갑니다」 only when it does. */
  private async probeRelay(){
    const session=this.value.session,transport=this.transport,epoch=this.epoch;if(!session||!transport)return;
    try{await transport({action:'relay',requestId:crypto.randomUUID(),sessionId:session.id});if(epoch===this.epoch)this.update({relaySupported:true});}
    catch(error){if(epoch===this.epoch)this.update({relaySupported:unsupported(error)?false:null});}
  }
  /** A tap on the dock: the same switch the voice command makes. */
  /** Typed in the dock: said to whoever is answering; it joins the subtitles like a spoken line. */
  /** `references`: # 언급 project ids; a Mac without them still gets the words, 「#이름」 included. */
  async sendText(raw:string,references:readonly string[]=[],route?:string){
    const text=raw.trim(),session=this.value.session,transport=this.transport;
    if(!text)return;
    if(!session||!transport||!['listening','review'].includes(this.value.phase))throw Error('음성이 연결된 뒤 입력하세요.');
    const epoch=this.epoch,current=()=>epoch===this.epoch;
    const say=(refs:readonly string[])=>transport({action:'say',requestId:crypto.randomUUID(),sessionId:session.id,text,...(refs.length?{references:[...refs]}:{}),...(route?{route}:{})});
    // An @ 호출 never falls back to plain words: they would reach whoever answers now, not that project.
    if(route){try{const response=normalizeVoiceResponse(await say(references));if(current()&&response.session)this.update({session:response.session});}catch(error){if(!current())return;if(unsupported(error))throw Error('이 Mac의 AgentsToZ를 업데이트하면 @ 호출을 쓸 수 있습니다. 대화 상대 버튼으로 그 담당자를 고르세요.');throw error;}if(current())this.addCaption('user','typed_'+crypto.randomUUID(),text);return;}
    try{await say(references).catch(error=>{if(!current())return;if(references.length&&unsupported(error))return say([]);throw error;});}
    catch(error){if(unsupported(error))throw Error('이 Mac의 AgentsToZ를 업데이트하면 입력해서 말할 수 있습니다. 지금은 말로 해 주세요.');throw error;}
    if(current())this.addCaption('user','typed_'+crypto.randomUUID(),text);
  }
  /** ⋯ in the dock: allowed projects matching `query`. An older Mac cannot answer (null). */
  async searchProjects(query=''):Promise<VoiceProjectChoice[]|null>{
    const session=this.value.session,transport=this.transport;
    if(!session||!transport||this.target?.kind!=='ops')return null;
    try{return normalizeVoiceResponse(await transport({action:'projects',requestId:crypto.randomUUID(),sessionId:session.id,...(query.trim()?{text:query.trim().slice(0,300)}:{})})).projects??[];}
    catch(error){if(unsupported(error))return null;throw error;}
  }
  /** Bounded picker page. Older hosts still offer search, but cannot report a total or next page. */
  async searchProjectsPage(query='',offset=0):Promise<(VoiceProjectPage&{legacy?:boolean})|null>{
    const session=this.value.session,transport=this.transport;
    if(!session||!transport||this.target?.kind!=='ops')return null;
    try{
      const response=normalizeVoiceResponse(await transport({action:'projects.page',requestId:crypto.randomUUID(),sessionId:session.id,offset,...(query.trim()?{text:query.trim().slice(0,300)}:{})}));
      if(!response.projectPage)throw Error('프로젝트 목록 응답을 확인하지 못했습니다.');
      return response.projectPage;
    }catch(error){
      if(!unsupported(error))throw error;
      if(offset>0)return null;
      const projects=await this.searchProjects(query);
      return projects===null?null:{projects,total:projects.length,nextOffset:null,legacy:true};
    }
  }
  async switchPartner(partner:VoicePartner){
    const session=this.value.session,transport=this.transport;
    if(!session||!transport||!['listening','review'].includes(this.value.phase))throw Error('음성이 연결된 뒤 대화 상대를 바꾸세요.');
    const epoch=this.epoch;
    let result;
    try{result=normalizeVoiceResponse(await transport({action:'partner',requestId:crypto.randomUUID(),sessionId:session.id,partner}));}
    catch(error){if(unsupported(error)){if(epoch===this.epoch)this.update({partnersSupported:false});throw Error('이 Mac의 AgentsToZ를 업데이트하면 버튼으로 대화 상대를 바꿀 수 있습니다. 지금은 음성으로 말해 주세요.');}
      // A workroom that ended since the list was read: drop its chip.
      if(error instanceof Error&&error.message.includes('실행 중인 워크룸'))void this.refreshPartners().catch(()=>{});throw error;}
    if(epoch===this.epoch&&result.session){
      const before=JSON.stringify(this.value.session?.activeTarget??null);this.update({session:result.session});
      // update() refreshes the list when the partner changed; otherwise once, without holding the tap.
      if(JSON.stringify(result.session.activeTarget??null)===before&&this.value.partnersSupported!==false)void this.refreshPartners().catch(()=>{});
    }
  }
  finishInput(){
    if(!['listening','review'].includes(this.value.phase))return;
    ++this.inputEpoch;const epoch=this.epoch;
    if(this.gemini)void this.gemini.finishInput().catch(error=>{if(epoch===this.epoch)this.update({error:error instanceof Error?error.message:'마이크 종료를 전달하지 못했습니다.'});});
    if(this.speech&&this.channel?.readyState==='open')this.channel.send(JSON.stringify({type:'input_audio_buffer.commit'}));
    this.monitor?.close();this.monitor=null;
    this.speech=false;for(const t of this.stream?.getTracks()??[]){t.onended=null;t.stop();}this.stream=null;clearTimeout(this.idle);
    this.update({microphone:false,level:null,phase:this.value.session?'review':this.value.phase});
  }
  /** Turns the microphone back on inside the same conversation (VOC 2026-09-24). The
   * provider connection and its context stay; only the input track is reattached. */
  resumeInput():Promise<void>{
    if(this.value.textOnly)return Promise.reject(Error('텍스트로만 모드입니다. 음성 모드로 전환한 뒤 마이크를 켜세요.'));
    return this.resume();
  }
  private resume():Promise<void>{
    if(this.resuming)return this.resuming;
    const pending=this.acquireInput();this.resuming=pending;
    const release=()=>{if(this.resuming===pending)this.resuming=null;};
    void pending.then(release,release);return pending;
  }
  private async acquireInput(){
    if(!this.value.session||this.value.phase!=='review'||this.value.microphone||!this.transport)throw Error('다시 켤 음성 대화가 없습니다. 새 대화로 시작하세요.');
    const epoch=this.epoch,inputEpoch=++this.inputEpoch,current=()=>this.epoch===epoch&&this.inputEpoch===inputEpoch&&this.value.phase==='review';
    let stream:MediaStream;
    try{stream=await navigator.mediaDevices.getUserMedia(VOICE_CAPTURE_CONSTRAINTS);}
    catch(error){if(current())this.update({error:error instanceof Error?error.message:'마이크를 다시 켜지 못했습니다.'});return;}
    if(!current()){stream.getTracks().forEach(t=>t.stop());return;}
    const track=stream.getTracks()[0];
    try{
      if(this.gemini)await this.gemini.resumeInput(stream);
      else{const sender=this.peer?.getSenders().find(s=>!s.track||s.track.kind==='audio');if(!sender||!track)throw Error('음성 연결이 끝나 마이크를 다시 붙일 수 없습니다. 새 대화로 시작하세요.');await sender.replaceTrack(track);}
    }catch(error){stream.getTracks().forEach(t=>t.stop());if(current())this.update({error:error instanceof Error?error.message:'마이크를 다시 켜지 못했습니다.'});return;}
    if(!current()){stream.getTracks().forEach(t=>t.stop());return;}
    this.stream=stream;this.recordCapture(stream);this.monitor=new VoiceInputMonitor();this.monitor.attach(stream,level=>{if(this.epoch===epoch)this.update({level});});
    stream.getTracks().forEach(t=>{t.onended=()=>{void this.stop('마이크 연결이 끊겼습니다.');};});
    this.update({microphone:true,phase:'listening',inputState:'waiting',error:'',device:track?.label||'기본 마이크'});this.touch();
  }
  /** What the browser applied to the last microphone acquired (null when it cannot say). Never sent to the host. */
  captureSettings():VoiceCaptureSettings|null{return this.capture?{...this.capture}:null;}
  private recordCapture(stream:MediaStream){
    this.capture=appliedCaptureSettings(stream.getTracks()[0]);
    if(this.capture)console.info('[Voice] capture',{...this.capture});
  }
  /** Mode changes retain the session, target, draft and provider connection. */
  async setTextOnly(textOnly:boolean){
    if(!this.value.session||!['listening','review'].includes(this.value.phase))throw Error('대화 연결을 먼저 확인하세요.');
    if(textOnly){
      this.update({textOnly:true,muted:true});this.finishInput();
      if(this.audio){this.audio.muted=true;this.audio.pause();}
      this.gemini?.setTextOnly(true);return;
    }
    if(!this.value.textOnly)return;
    const epoch=this.epoch;await this.resume();
    if(epoch!==this.epoch||!this.value.microphone)return;
    this.update({textOnly:false,muted:false});this.gemini?.setTextOnly(false);this.playRemoteAudio(epoch);
  }
  private playRemoteAudio(epoch:number){
    if(this.value.textOnly||!this.remoteAudio)return;
    const audio=this.audio??document.createElement('audio');this.audio=audio;audio.autoplay=true;audio.setAttribute('playsinline','');audio.muted=this.value.muted;audio.srcObject=this.remoteAudio;
    void audio.play().catch(()=>{if(epoch===this.epoch&&!this.value.textOnly)this.update({muted:true,error:'답변 소리 켜기 버튼을 눌러 재생하세요.'});});
  }
  toggleSpeaker(){
    if(this.value.textOnly)return;
    if(this.gemini){const muted=!this.value.muted;this.gemini.setMuted(muted);this.update({muted});return;}
    if(!this.audio)return;const muted=!this.value.muted;this.audio.muted=muted;
    // A blocked play keeps the answer muted, so the dock's unmute button stays there to retry.
    const epoch=this.epoch;
    if(!muted)void this.audio.play().then(()=>{if(epoch===this.epoch)this.update({error:''});}).catch(()=>{if(epoch!==this.epoch||!this.audio||this.value.muted)return;this.audio.muted=true;this.update({muted:true,error:'답변 소리 켜기를 다시 눌러 재생을 허용해 주세요.'});});
    this.update({muted});
  }
  async submit(text:string,inputReady:boolean){
    const session=this.value.session;if(!session?.draft||!this.transport)throw Error('전송할 음성 초안을 확인하세요.');
    const fingerprint=JSON.stringify([session.id,session.draft.id,text,inputReady]);
    if(this.submission&&this.submission.fingerprint!==fingerprint)throw Error('이 초안의 전송 결과를 먼저 확인하세요. 내용을 바꿔 재전송하지 않습니다.');
    this.submission??={fingerprint,requestId:crypto.randomUUID()};
    const epoch=this.epoch,result=await this.transport({action:'submit',requestId:this.submission.requestId,sessionId:session.id,draftId:session.draft.id,text,inputReady});
    if(epoch===this.epoch&&result.session){this.submission=null;this.update({session:result.session});}
  }
  async discard(){
    const s=this.value.session;if(!s?.draft||!this.transport)return;
    const epoch=this.epoch,result=await this.transport({action:'discard',requestId:crypto.randomUUID(),sessionId:s.id,draftId:s.draft.id});
    if(epoch===this.epoch&&result.session){this.submission=null;this.update({session:result.session});}
  }
  /**
   * `error`: something failed, so the host may keep the record incomplete (interrupted).
   * `ended`: a normal end such as the time limit — not an error, and the saved speech stays complete.
   */
  async stop(error?:string,ended?:string,immediate=false){
    if(['idle','ended','failed'].includes(this.value.phase))return;
    const session=this.value.session,transport=this.transport;
    if(this.speech&&this.channel?.readyState==='open')this.channel.send(JSON.stringify({type:'input_audio_buffer.commit'}));
    const held=!error&&!immediate&&session?.provider==='openai'&&!['ended','failed'].includes(session.state)&&['listening','review'].includes(this.value.phase)&&this.peer?.connectionState==='connected'?this.holdLocalPeer():null;
    const epoch=++this.epoch;this.cleanup();this.update({phase:error?'failed':'ended',microphone:false,level:null,error:error??'',connectionNotice:'',session:session?{...session,state:error?'failed':'ended',draft:null,notice:error??ended??'음성을 종료했습니다. 워크룸 작업은 유지됩니다.'}:null});
    const unconfirmed=()=>{if(held&&epoch===this.epoch&&this.value.session)this.update({session:{...this.value.session,notice:'마이크와 스피커는 껐습니다. 호스트의 종료 확인은 받지 못했습니다.'}});};
    try{if(session&&transport){const request=transport({action:'stop',requestId:crypto.randomUUID(),sessionId:session.id,...(error&&session.recording?{interrupted:true}:{})});const result=held?await Promise.race([request,held.done]):await request;if(epoch===this.epoch&&result?.session)this.update({session:ended?{...result.session,notice:ended}:result.session});else if(!result)unconfirmed();}}
    catch{unconfirmed();if(epoch===this.epoch&&session?.recording)this.update({error:'음성은 종료했습니다. 최종 기록 저장 상태는 내가 한 말에서 확인하세요.'});}
    finally{held?.release();}
  }
}
export const voiceMediaClient=new VoiceMediaClient();
