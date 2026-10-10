import {afterEach,expect,test} from 'bun:test';
import {existsSync,mkdtempSync,readFileSync,rmSync,statSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {VoiceCredentials} from '../src/voiceCredentials';
const dirs:string[]=[];afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const root=()=>{const d=mkdtempSync(join(tmpdir(),'voice-key-test-'));dirs.push(d);return join(d,'voice');};
test('Keychain secret uses stdin only, metadata excludes secret, readiness does not unlock',async()=>{
 const dir=root(),calls:{args:string[];input?:string}[]=[],key='test-key-'+ 'a'.repeat(25);
 const c=new VoiceCredentials(dir,{},async(args,input)=>{calls.push({args,input});return {code:0,text:args[0]==='find-generic-password'?key:''};},'darwin');
 expect(c.status().configured).toBe(false);expect(calls).toHaveLength(0);
 await c.configure({action:'configure',requestId:'request_fixture',apiKey:key});expect(calls[0]!.args.join(' ')).not.toContain(key);expect(calls[0]!.input).toContain(key);
 expect(c.status().configured).toBe(true);expect(calls).toHaveLength(2);expect(await c.key()).toBe(key);
 const metadata=readFileSync(join(dir,'settings.json'),'utf8');expect(metadata).not.toContain(key);expect(statSync(join(dir,'settings.json')).mode&0o777).toBe(0o600);
 await c.configure({action:'configure',requestId:'request_fixture',removeKey:true});expect(c.status().configured).toBe(false);
});
test('dedicated environment key never invokes keychain; symlink metadata fails closed',async()=>{
 const c=new VoiceCredentials(root(),{AGENTSTOZ_VOICE_API_KEY:'x'.repeat(30)},async()=>{throw Error('must not call');});expect(await c.key()).toBe('x'.repeat(30));
 const dir=root();symlinkSync(dirs[0]!,dir);expect(()=>new VoiceCredentials(dir,{})).toThrow();
});

test('long key is sent through interactive command stdin, then read back exactly',async()=>{
 const dir=root(),key='sk-proj-'+ 'x'.repeat(504),calls:{args:string[];input?:string}[]=[];
 let stored='';
 const c=new VoiceCredentials(dir,{},async(args,input)=>{
  calls.push({args,input});
  if(args[0]==='-i')stored=input?.match(/ -w ([A-Za-z0-9_-]+)\n$/)?.[1]??'';
  // Model the macOS password prompt's 128-character truncation.
  if(args[0]==='add-generic-password')stored=(input??'').split('\n')[0]!.slice(0,128);
  return {code:0,text:args[0]==='find-generic-password'?stored+'\n':''};
 },'darwin');
 await c.configure({action:'configure',requestId:'request_fixture',apiKey:key});
 expect(await c.key()).toBe(key);
 expect(calls[0]!.args).toEqual(['-i']);
 expect(calls[0]!.input).toBe('add-generic-password -U -s com.agentstoz.voice.openai.v1 -a realtime -w '+key+'\n');
 expect(calls.every(call=>!call.args.join(' ').includes(key))).toBe(true);
 expect(readFileSync(join(dir,'settings.json'),'utf8')).not.toContain(key);
});
test('successful write exit with truncated or unreadable readback cannot report saved',async()=>{
 for(const code of [0,44]) {
  const dir=root(),key='sk-proj-'+'y'.repeat(156);
  const c=new VoiceCredentials(dir,{},async args=>({code:args[0]==='find-generic-password'?code:0,text:key.slice(0,128)}),'darwin');
  await expect(c.configure({action:'configure',requestId:'request_fixture',apiKey:key})).rejects.toThrow('Keychain');
  expect(c.status().configured).toBe(false);
  expect(existsSync(join(dir,'settings.json'))).toBe(false);
 }
});
test('replacement readback mismatch preserves previous metadata and never exposes key',async()=>{
 const dir=root(),first='sk-proj-'+'a'.repeat(156),second='sk-proj-'+'b'.repeat(156);
 const c=new VoiceCredentials(dir,{},async args=>({code:0,text:args[0]==='find-generic-password'?first:''}),'darwin');
 await c.configure({action:'configure',requestId:'first',apiKey:first});
 const before=readFileSync(join(dir,'settings.json'),'utf8');
 let message='';try{await c.configure({action:'configure',requestId:'second',apiKey:second,model:'gpt-realtime'});}catch(e){message=(e as Error).message;}
 expect(message).toContain('Keychain');expect(message).not.toContain(first);expect(message).not.toContain(second);
 expect(readFileSync(join(dir,'settings.json'),'utf8')).toBe(before);
 expect(c.status().model).toBe('gpt-realtime-2.1');
});
test('stdin command rejects separators, whitespace and oversized keys before spawning',async()=>{
 let calls=0;const c=new VoiceCredentials(root(),{},async()=>{calls++;return {code:0,text:''};},'darwin');
 for(const key of ['x'.repeat(513),'x'.repeat(30)+'\nquit','x'.repeat(30)+' other','x'.repeat(30)+'"','']){
  await expect(c.configure({action:'configure',requestId:'invalid',apiKey:key})).rejects.toThrow('API 키');
 }
 expect(calls).toBe(0);
});
