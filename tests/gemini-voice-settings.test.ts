import {describe,test,expect} from 'bun:test';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGeminiVoiceSettingsHost,probeGeminiLive} from '../src/geminiVoiceSettingsHost';
import {parseGeminiVoiceSettingsRequest} from '../src/geminiVoiceSettings';
const secret='AQ.fixture_not_a_real_key.'.padEnd(2048,'x');
describe('Gemini voice settings',()=>{
 test('strict request cannot set endpoints, paths, or transmit extra material',()=>{
  for(const value of [{operation:'save',apiKey:secret,model:'gemini-test',url:'https://elsewhere'}, {operation:'test',model:'../other'}, {operation:'status',apiKey:secret},...['short',secret+'x',secret+'\n','AQ.fixture key has spaces','AQ.fixture_key_한글_12345','AQ.fixture_key_\u0000_12345'].map(apiKey=>({operation:'save',apiKey,model:'gemini-test'}))])expect(()=>parseGeminiVoiceSettingsRequest(value)).toThrow();
 });
 test('authorization keys are opaque and may contain dots or exceed legacy lengths',()=>{
  for(const apiKey of ['AIza_test_fixture_only_1234567890',secret,'AQ.fixture_only.with.dots_12345'])expect(parseGeminiVoiceSettingsRequest({operation:'save',apiKey,model:'gemini-test'})).toEqual({operation:'save',apiKey,model:'gemini-test'});
 });
 test('status is side-effect free; saved API key is encrypted; probe and replacement bind receipts',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'gemini-settings-'));let reads=0,creates=0,probes=0;
  const wrapping=Buffer.alloc(32,7);
  const host=createGeminiVoiceSettingsHost({appDataDir:dir,supported:true,keyProvider:{read:async()=>{reads++;return Buffer.from(wrapping)},create:async()=>{creates++;return Buffer.from(wrapping)}},probe:async(key,model)=>{probes++;expect(key).toBe(secret);expect(model).toBe('gemini-test')}});
  try{
   expect((await host.perform({operation:'status'})).configured).toBe(false);expect(reads+creates+probes).toBe(0);expect(readdirSync(dir)).toHaveLength(0);
   const saved=await host.perform({operation:'save',apiKey:secret,model:'gemini-test'});expect(saved.checkedAt).toBeNull();expect(probes).toBe(0);expect(JSON.stringify(saved)).not.toContain(secret);
   const file=readFileSync(join(dir,'gemini-voice-settings.v1.json'),'utf8');expect(file).not.toContain(secret);
   const before=reads;expect((await host.perform({operation:'status'})).configured).toBe(true);expect(reads).toBe(before);
   expect(host.runtimeKey()).resolves.toBe(secret);expect((await host.updateModel('gemini-other')).model).toBe('gemini-other');expect(host.status().checkedAt).toBeNull();
   const tested=await host.perform({operation:'test',model:'gemini-test'});expect(tested.checkedModel).toBe('gemini-test');expect(tested.checkedAt).not.toBeNull();expect(probes).toBe(1);
   expect((await host.perform({operation:'save',apiKey:secret,model:'gemini-other'})).checkedAt).toBeNull();expect(creates).toBe(1);
   expect((await host.perform({operation:'delete'})).configured).toBe(false);expect(readdirSync(dir)).toHaveLength(0);
  }finally{rmSync(dir,{recursive:true,force:true})}
 });
 test('missing Keychain wrapping key never replaces an existing credential',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'gemini-settings-'));let missing=false,creates=0;
  const host=createGeminiVoiceSettingsHost({appDataDir:dir,supported:true,keyProvider:{read:async()=>missing?null:Buffer.alloc(32,5),create:async()=>{creates++;return Buffer.alloc(32,5)}}});
  try{await host.perform({operation:'save',apiKey:secret,model:'gemini-test'});const prior=readFileSync(join(dir,'gemini-voice-settings.v1.json'),'utf8');missing=true;await expect(host.perform({operation:'save',apiKey:secret,model:'gemini-other'})).rejects.toThrow('Keychain');expect(creates).toBe(1);expect(readFileSync(join(dir,'gemini-voice-settings.v1.json'),'utf8')).toBe(prior);}finally{rmSync(dir,{recursive:true,force:true})}
 });
 test('concurrent probe cannot race with replacement or deletion',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'gemini-settings-'));let release!:()=>void;let started!:()=>void;const ready=new Promise<void>(resolve=>started=resolve);
  const host=createGeminiVoiceSettingsHost({appDataDir:dir,supported:true,keyProvider:{read:async()=>Buffer.alloc(32,5),create:async()=>Buffer.alloc(32,5)},probe:async()=>{started();await new Promise<void>(resolve=>release=resolve)}});
  try{await host.perform({operation:'save',apiKey:secret,model:'gemini-test'});const probe=host.perform({operation:'test',model:'gemini-test'});await ready;await expect(host.perform({operation:'delete'})).rejects.toThrow('진행 중');await expect(host.updateModel('gemini-other')).rejects.toThrow('진행 중');release();await probe;}finally{rmSync(dir,{recursive:true,force:true})}
 });
 test('Live test requires setupComplete, closes connection, sends no content or tools',async()=>{
  const messages:string[]=[];let closed=0;
  const socket={onopen:null as null|(()=>void),onmessage:null as null|((e:{data:string})=>void),onerror:null,onclose:null,send:(value:string)=>messages.push(value),close:()=>closed++};
  const task=probeGeminiLive(secret,'gemini-test',url=>{expect(url.startsWith('wss://generativelanguage.googleapis.com/ws/')).toBe(true);return socket as unknown as WebSocket;});
  socket.onopen!();expect(JSON.parse(messages[0]!)).toEqual({setup:{model:'models/gemini-test',generationConfig:{responseModalities:['AUDIO']}}});socket.onmessage!({data:'{"setupComplete":{}}'});await task;expect(closed).toBe(1);expect(socket.onmessage).toBeNull();
 });
 test('timeout and provider error never reveal API key or upstream error body',async()=>{
  const socket={onopen:null,onmessage:null as null|((e:{data:string})=>void),onerror:null,onclose:null,close:()=>{}};
  const task=probeGeminiLive(secret,'gemini-test',()=>socket as unknown as WebSocket);socket.onmessage!({data:JSON.stringify({error:{message:secret}})});await expect(task).rejects.not.toThrow(secret);
  await expect(probeGeminiLive(secret,'gemini-test',()=>socket as unknown as WebSocket,5)).rejects.toThrow('초과');
 });
 test('binary JSON setup acknowledgement is accepted and oversized frames are rejected',async()=>{
  for(const data of [new TextEncoder().encode('{"setupComplete":{}}').buffer,new Blob(['{"setupComplete":{}}'])]){
   const socket={onopen:null,onmessage:null as null|((e:{data:unknown})=>void),onerror:null,onclose:null,close:()=>{}};
   const task=probeGeminiLive(secret,'gemini-test',()=>socket as unknown as WebSocket);socket.onmessage!({data});await task;
  }
  const socket={onopen:null,onmessage:null as null|((e:{data:unknown})=>void),onerror:null,onclose:null,close:()=>{}};
  const task=probeGeminiLive(secret,'gemini-test',()=>socket as unknown as WebSocket);socket.onmessage!({data:new ArrayBuffer(65537)});await expect(task).rejects.toThrow('형식');
 });
});

/**
 * The host was wired `supported: IS_BUNDLED_API_SIDECAR` -- true only inside the
 * installed Mac app -- so on Windows every write was refused before it reached
 * the key provider, with copy telling the user to use "설치된 Mac 앱".
 * Windows now has its own encrypted store (DPAPI), so the gate is per platform.
 */
test('the Gemini key gate admits Windows, not only the bundled Mac app',()=>{
 const source=readFileSync(new URL('../api-server.ts',import.meta.url),'utf8');
 const start=source.indexOf('const geminiVoiceSettings=createGeminiVoiceSettingsHost(');
 expect(start).toBeGreaterThanOrEqual(0);
 const wiring=source.slice(start,source.indexOf('\n',start));
 expect(wiring).toContain("process.platform==='darwin'?IS_BUNDLED_API_SIDECAR:process.platform==='win32'");
});
