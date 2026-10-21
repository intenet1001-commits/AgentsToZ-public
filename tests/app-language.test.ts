import {expect,test} from 'bun:test';
import {APP_LANGUAGES,isAppLanguage,readAppLanguage,t,translations} from '../src/i18n';
import {normalizeVoiceRequest,normalizeVoiceResponse} from '../src/voiceSessionProtocol';
import {realtimeSessionConfig} from '../src/voiceRealtimeProvider';
test('all seven menu catalogs have complete, nonempty keys and Korean is the safe default',()=>{
 expect(readAppLanguage()).toBe('ko');expect(isAppLanguage('bogus')).toBe(false);expect(isAppLanguage('constructor')).toBe(false);
 for(const {id} of APP_LANGUAGES){expect(Object.keys(translations[id]).sort()).toEqual(Object.keys(translations.ko).sort());for(const value of Object.values(translations[id]))expect(value.trim().length).toBeGreaterThan(0);expect(t(id,'deviceMemory')).toBeTruthy();}
});
test('voice language is validated, does not expand execution authority, and primes the chosen language plus English',()=>{
 const base={action:'prepare',requestId:crypto.randomUUID(),target:{kind:'ops'},mode:'conversation',consent:true};
 for(const {id} of APP_LANGUAGES){expect(normalizeVoiceRequest({...base,language:id}).language).toBe(id);const input=realtimeSessionConfig({model:'gpt-realtime-2.1',voice:'marin',instructions:'test',mode:'conversation',tools:[],language:id}).audio.input.transcription;expect(input.languages).toContain(id==='zh-CN'?'zh':id);expect(input.keywords).toContain('AgentsToZ');}
 expect(()=>normalizeVoiceRequest({...base,language:'../../secret'})).toThrow();
});
test('recognition receipts are bounded text only and reject extra audio or paths',()=>{
 const s={id:'voice_fixture',state:'active',mode:'dictation',provider:'openai',label:'fixture',draft:null,notice:'',expiresAt:Date.now()+1000,recognition:{itemId:'item_fixture',text:'확인해 줘',source:'reviewed'}};
 expect(normalizeVoiceResponse({session:s}).session?.recognition?.text).toBe('확인해 줘');for(const extra of [{audio:'secret'},{path:'/tmp/audio.wav'}])expect(()=>normalizeVoiceResponse({session:{...s,recognition:{...s.recognition,...extra}}})).toThrow();
});
