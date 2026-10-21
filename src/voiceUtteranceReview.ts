/** Same-utterance rereading, adapted from Tongyeoksa's AudioReview. No transcript is used as an ASR prompt. */
export const VOICE_REVIEW_PCM_BYTES=32*24000*2;
export const VOICE_REVIEW_MAX_BASE64=Math.ceil(VOICE_REVIEW_PCM_BYTES/3)*4;
export interface VoiceRecognition {itemId:string;text:string;source:'reviewed'|'primary'|'needs-confirmation'}
const normalized=(text:string)=>text.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{Z}\s]/gu,'');
function critical(text:string){
 const digits=(text.match(/\d+(?:[.,:/-]\d+)*|(?:하나|둘|셋|넷|다섯|여섯|일|이|삼|사|오|육|한|두|세|네)\s*(?:번|호|개|명|건)|\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\b/giu)??[]).join('|');
 const negative=/\b(?:no|not|never|don't|dont|cannot|can't|cancel|without|nicht|kein\w*|jamais|pas|sans|nunca|sin)\b|(?:하지\s*마|하지\s*말|안\s*(?:해|돼|되|하|보내|열|꺼|켜|지워|삭제|푸시|머지|배포)|못\s*|않|취소|금지|아니|不要|不能|别|不行|しない|ません|禁止)/iu.test(text);
 const choice=/^\s*(?:네|예|아니[요오]?|yes|no|はい|いいえ|sí|oui|non|ja|nein)\s*[.!?]?\s*$/iu.exec(text)?.[0]?.trim().toLowerCase().replace(/[.!?]/g,'')??'';
 return {digits,negative,choice};
}
/** A different number, polarity, short answer or large missing tail requires a person, never a guessed command. */
export function voiceReviewNeedsConfirmation(primary:string,reviewed:string):boolean {
 const a=critical(primary),b=critical(reviewed);
 if(a.digits!==b.digits||a.negative!==b.negative||a.choice!==b.choice)return true;
 if(normalized(primary)===normalized(reviewed))return false;
 const first=normalized(primary),last=normalized(reviewed);
 return !first||!last||Math.min(first.length,last.length)<Math.max(first.length,last.length)*0.55;
}
export function pcm24kWav(base64:string):Uint8Array {
 if(!base64||base64.length>VOICE_REVIEW_MAX_BASE64||!/^[A-Za-z0-9+/]+={0,2}$/.test(base64))throw Error('VOICE_REVIEW_AUDIO_INVALID');
 const pcm=Buffer.from(base64,'base64');if(pcm.length<4800||pcm.length>VOICE_REVIEW_PCM_BYTES||pcm.length%2)throw Error('VOICE_REVIEW_AUDIO_BOUNDS');
 const out=Buffer.alloc(44+pcm.length);out.write('RIFF');out.writeUInt32LE(36+pcm.length,4);out.write('WAVEfmt ',8);out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);out.writeUInt16LE(1,22);out.writeUInt32LE(24000,24);out.writeUInt32LE(48000,28);out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);out.write('data',36);out.writeUInt32LE(pcm.length,40);pcm.copy(out,44);return new Uint8Array(out);
}
/** At most two original utterances in flight, 60 per connection, 12 per rolling minute. No raw audio is persisted. */
export class VoiceUtteranceReview {
 private jobs=new Map<string,{finish:(audio:string|null)=>void;timer:ReturnType<typeof setTimeout>}>();
 private completed=new Set<string>();private times:number[]=[];private total=0;private closed=false;private running=0;private queued=0;
 private tail:Promise<void>=Promise.resolve();
 constructor(private deps:{retrieve(itemId:string):void;transcribe(wav:Uint8Array):Promise<string>;emit(event:Record<string,any>):void;now?:()=>number;timeoutMs?:number}){}
 accept(event:Record<string,any>):boolean {
  if(event.type==='conversation.item.retrieved'){
   const id=event.item?.id,job=this.jobs.get(id);if(!job)return true;
   const content=event.item?.content;
   // Exactly one original input-audio part; never concatenate a truncated tail or another item.
   const parts=Array.isArray(content)?content.filter((p:any)=>p?.type==='input_audio'):[];
   const audio=parts.length===1&&typeof parts[0]?.audio==='string'?parts[0].audio:null;
   job.finish(audio);return true;
  }
  if(event.type!=='conversation.item.input_audio_transcription.completed')return false;
  const id=event.item_id,primary=event.transcript;
  if(this.closed||typeof id!=='string'||id.length>160||typeof primary!=='string'||!primary.trim()||Buffer.byteLength(primary)>4000)return false;
  if(this.completed.has(id)||this.jobs.has(id))return true;
  if(this.completed.size>=2000)return true;this.completed.add(id);
  const deliver=(event:Record<string,any>)=>{if(this.queued>=16){this.deps.emit({type:'conversation.item.input_audio_transcription.failed',item_id:id});return;}this.queued++;this.tail=this.tail.then(()=>{if(!this.closed)this.deps.emit(event);}).finally(()=>{this.queued--;}).catch(()=>{});};
  const now=(this.deps.now??Date.now)();this.times=this.times.filter(at=>now-at<60000);
  if(this.running>=2||this.total>=60||this.times.length>=12){deliver({...event,recognition:{itemId:id,text:primary,source:'primary'}});return true;}
  this.total++;this.running++;this.queued++;this.times.push(now);
  // Reserve its place before fetching audio; final lines cannot overtake each other.
  let finish!:(audio:string|null)=>void;
  const audio=new Promise<string|null>(resolve=>{finish=value=>{const job=this.jobs.get(id);if(job)clearTimeout(job.timer);this.jobs.delete(id);resolve(value);};});
  const timer=setTimeout(()=>finish(null),this.deps.timeoutMs??2500);timer.unref?.();
  this.jobs.set(id,{finish,timer});
  const reviewed=audio.then(async raw=>{
   if(this.closed||!raw)return null;
   try{const text=(await this.deps.transcribe(pcm24kWav(raw))).trim();return text&&Buffer.byteLength(text)<=4000?text:null;}catch{return null;}
  });
  const delivery=this.tail.then(async()=>{
   const text=await reviewed;if(this.closed)return;
   const conflict=!!text&&voiceReviewNeedsConfirmation(primary,text);
   this.deps.emit({...event,transcript:text??primary,recognition:{itemId:id,text:text??primary,source:conflict?'needs-confirmation':text?'reviewed':'primary'},...(conflict?{primaryTranscript:primary}:{} )});
  });
  this.tail=delivery.finally(()=>{this.running--;this.queued--;}).catch(()=>{});
  try{this.deps.retrieve(id);}catch{finish(null);}return true;
 }
 close(){this.closed=true;for(const job of this.jobs.values())job.finish(null);this.jobs.clear();}
}
