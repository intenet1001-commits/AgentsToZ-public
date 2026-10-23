import {expect,test} from 'bun:test';
import {APP_LANGUAGES,appLocale,formatLastRun,formatProjectCount,isAppLanguage,readAppLanguage,writeAppLanguage,t,translations} from '../src/i18n';
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

test('every catalog preserves interpolation fields and treats substitutions as literal text',()=>{
 const fields=(text:string)=>[...text.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort();
 for(const {id} of APP_LANGUAGES)for(const key of Object.keys(translations.ko) as (keyof typeof translations.ko)[]){
  expect(fields(translations[id][key])).toEqual(fields(translations.ko[key]));
 }
 const query='<img src=x onerror=alert(1)> {count} $&';
 for(const {id} of APP_LANGUAGES)expect(t(id,'noMatchingProject',{query})).toContain(query);
});

test('language choices reach late readers when storage writes fail, then recover when storage returns',()=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 const data=new Map([['portmanager-lang','en']]);let blocked=true;
 const storage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{if(blocked)throw Error('quota');data.set(key,value);}};
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:storage});
 try{
  expect(readAppLanguage()).toBe('en');
  expect(writeAppLanguage('ja')).toBe(false);
  expect(readAppLanguage()).toBe('ja');
  expect(data.get('portmanager-lang')).toBe('en');
  expect(writeAppLanguage('bogus' as any)).toBe(false);
  expect(readAppLanguage()).toBe('ja');
  blocked=false;
  expect(writeAppLanguage('fr')).toBe(true);
  expect(readAppLanguage()).toBe('fr');
  expect(data.get('portmanager-lang')).toBe('fr');
  data.set('portmanager-lang','constructor');
  expect(readAppLanguage()).toBe('ko');
 }finally{
  blocked=false;writeAppLanguage('ko');
  if(descriptor)Object.defineProperty(globalThis,'localStorage',descriptor);else Reflect.deleteProperty(globalThis,'localStorage');
 }
});

test('relative dates and project counts follow all seven selected locales',()=>{
 const now=Date.UTC(2026,9,23,12),twoMinutes=now-120000;
 const expected={ko:'2분 전',en:'2 minutes ago',ja:'2 分前','zh-CN':'2分钟前',es:'hace 2 minutos',fr:'il y a 2 minutes',de:'vor 2 Minuten'};
 for(const {id,locale} of APP_LANGUAGES){
  expect(appLocale(id)).toBe(locale);
  expect(formatLastRun(id,twoMinutes,now)).toBe(expected[id]);
  expect(formatLastRun(id,undefined,now)).toBe(t(id,'neverRun'));
  expect(formatLastRun(id,now+60000,now)).toBe(t(id,'justNow'));
 }
 expect(formatProjectCount('en',1)).toBe('1 project');expect(formatProjectCount('en',2)).toBe('2 projects');
 expect(formatProjectCount('de',1200)).toBe('1.200 Projekte');
 expect(formatProjectCount('ja',2)).toBe('2件');expect(formatProjectCount('zh-CN',2)).toBe('2个项目');
 for(const minutes of [59,60,1439,1440,43199,43200])expect(formatLastRun('fr',now-minutes*60000,now)).not.toContain('ago');
});
