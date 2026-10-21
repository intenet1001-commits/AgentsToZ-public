import {expect,test} from 'bun:test';
import {VoiceUtteranceReview,pcm24kWav,voiceReviewNeedsConfirmation} from '../src/voiceUtteranceReview';
const pcm=Buffer.alloc(4800,1).toString('base64');
const turn=(id:string,text='코덱스 워크룸을 열어 줘')=>({type:'conversation.item.input_audio_transcription.completed',item_id:id,transcript:text});
const audio=(id:string,data=pcm)=>({type:'conversation.item.retrieved',item:{id,content:[{type:'input_audio',audio:data}]}});
const tick=()=>new Promise(r=>setTimeout(r,8));
test('original PCM is the exact 24k mono waveform, bounded and never a truncated tail',()=>{
 const wav=Buffer.from(pcm24kWav(pcm));expect(wav.toString('ascii',0,4)).toBe('RIFF');expect(wav.readUInt32LE(24)).toBe(24000);expect(wav.subarray(44)).toEqual(Buffer.from(pcm,'base64'));
 for(const bad of ['wrong*',Buffer.alloc(4801).toString('base64'),Buffer.alloc(32*48000+2).toString('base64')])expect(()=>pcm24kWav(bad)).toThrow();
});
test('polarity, numbers, short answers and missing tails require confirmation; spelling alone does not',()=>{
 for(const [a,b] of [['푸시 해','푸시 하지 마'],['버전 1104 배포','버전 1105 배포'],['deploy 0.01','deploy 0.1'],['버전 1104','버전 11.04'],['yes','no'],['ne pas envoyer','envoyer'],['이 프로젝트에서 전체 테스트를 실행하고 결과를 확인한 다음 보고해 주세요','보고해 주세요']])expect(voiceReviewNeedsConfirmation(a!,b!)).toBe(true);
 expect(voiceReviewNeedsConfirmation('코댁스 워크룸 열어 줘','코덱스 워크룸 열어 줘')).toBe(false);expect(voiceReviewNeedsConfirmation('Push 1104.','push 1104')).toBe(false);expect(voiceReviewNeedsConfirmation('yes.','yes')).toBe(false);
});
test('rereads only the exact item, delivers final lines in order and deduplicates provider completion',async()=>{
 const output:any[]=[],ids:string[]=[],waits=new Map<string,(text:string)=>void>();let n=0;
 const review=new VoiceUtteranceReview({retrieve:id=>ids.push(id),transcribe:()=>new Promise(r=>waits.set(String(++n),r)),emit:e=>output.push(e)});
 review.accept(turn('a'));review.accept(turn('b'));review.accept(turn('a'));review.accept(audio('unknown'));review.accept(audio('a'));review.accept(audio('b'));await tick();
 waits.get('2')!('코덱스 워크룸을 열어 줘');await tick();expect(output).toHaveLength(0);waits.get('1')!('코덱스 워크룸을 열어 줘');await tick();
 expect(ids).toEqual(['a','b']);expect(output.map(e=>e.item_id)).toEqual(['a','b']);expect(output[0].recognition.source).toBe('reviewed');review.close();
});
test('review failure and unavailable original audio retain the primary line; stopped sessions drop late results',async()=>{
 const output:any[]=[];let release!:(text:string)=>void;
 const review=new VoiceUtteranceReview({retrieve:()=>{},transcribe:()=>new Promise(r=>release=r),emit:e=>output.push(e),timeoutMs:10});
 review.accept(turn('timeout'));await new Promise(r=>setTimeout(r,25));expect(output[0].recognition.source).toBe('primary');
 review.accept(turn('late'));review.accept(audio('late'));await tick();review.close();release('코덱스');await tick();expect(output).toHaveLength(1);
});
test('a changed number is a confirmation result, not a silent corrected command',async()=>{
 const output:any[]=[];const review=new VoiceUtteranceReview({retrieve:()=>{},transcribe:async()=> '버전 1105 배포',emit:e=>output.push(e)});
 review.accept(turn('number','버전 1104 배포'));review.accept(audio('number'));await tick();expect(output[0]).toMatchObject({primaryTranscript:'버전 1104 배포',transcript:'버전 1105 배포',recognition:{source:'needs-confirmation'}});review.close();
});
test('a busy review preserves ordering and uses no more than two simultaneous file transcriptions',async()=>{
 const output:any[]=[];let release!:(s:string)=>void;let calls=0;
 const review=new VoiceUtteranceReview({retrieve:()=>{},transcribe:()=>{calls++;return new Promise(r=>release=r);},emit:e=>output.push(e)});
 review.accept(turn('a'));review.accept(audio('a'));review.accept(turn('b'));review.accept(turn('c'));review.accept(audio('b','invalid*'));await tick();expect(calls).toBe(1);expect(output).toHaveLength(0);release('코덱스 워크룸을 열어 줘');await tick();expect(output.map(e=>e.item_id)).toEqual(['a','b','c']);expect(output[2].recognition.source).toBe('primary');review.close();
});
