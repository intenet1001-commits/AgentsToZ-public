
import {isAppLanguage,type Lang} from './i18n';
export const VOICE_DOMAIN_TERMS=['AgentsToZ','아젠투지','OPS','Workroom','워크룸','Codex','코덱스','Claude','클로드','Hermes','Antigravity','TestFlight','worktree'];
export function voiceInputLanguages(lang?:Lang):string[]{const primary=lang==='zh-CN'?'zh':isAppLanguage(lang)?lang:'ko';return primary==='en'?['en','ko']:[primary,'en'];}
export async function transcribeVoiceOriginal(wav:Uint8Array,key:string,signal:AbortSignal,language?:Lang):Promise<string>{
 const form=new FormData();form.set('file',new Blob([wav as BlobPart],{type:'audio/wav'}),'utterance.wav');form.set('model','gpt-transcribe');
 for(const term of VOICE_DOMAIN_TERMS)form.append('keywords[]',term);for(const lang of voiceInputLanguages(language))form.append('languages[]',lang);
 const response=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:'Bearer '+key},body:form,signal:AbortSignal.any([signal,AbortSignal.timeout(8000)])});
 if(!response.ok){await response.body?.cancel();throw Error('VOICE_REVIEW_PROVIDER_FAILED');}
 const reader=response.body?.getReader();if(!reader)throw Error('VOICE_REVIEW_RESULT_INVALID');let bytes=0;const chunks:Uint8Array[]=[];try{for(;;){const p=await reader.read();if(p.done)break;bytes+=p.value.byteLength;if(bytes>16000)throw Error('VOICE_REVIEW_RESULT_BOUNDS');chunks.push(p.value);}}finally{await reader.cancel().catch(()=>{});}
 const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(typeof result.text!=='string')throw Error('VOICE_REVIEW_RESULT_INVALID');return result.text;
}
