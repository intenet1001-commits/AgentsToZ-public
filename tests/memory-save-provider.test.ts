import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,writeFileSync,chmodSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareMemoryProvider,revalidateMemoryProvider,inspectMemoryProviderTransition,verifyMemoryProviderTransition,memorySaveTextProvider,type MemoryProviderHost} from '../src/memorySaveProvider';
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'memory-provider-')));roots.push(root);
 const bin=join(root,'fixture');writeFileSync(bin,'fixture');chmodSync(bin,0o700);
 const calls:{argv:string[];input?:string}[]=[];let account='first',returnedModel='claude-fixture-1';
 const host:MemoryProviderHost={appDataRoot:root,installationId:'fixture-installation',executable:()=>bin,run:async(argv,_cwd,input)=>{
  calls.push({argv,input});return {exitCode:0,stderr:'',stdout:JSON.stringify(input===undefined
   ? {loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',email:account+'@example.invalid',orgId:'fixture-org'}
   : {type:'result',subtype:'success',is_error:false,result:input==='Return only MEMORY_SAVE_READY with no punctuation or other text.'?'MEMORY_SAVE_READY':'Checked proposal',modelUsage:{[returnedModel]:{inputTokens:1}},permission_denials:[]})};
 }};
 return {root,bin,host,calls,setAccount:(a:string)=>{account=a;},setModel:(m:string)=>{returnedModel=m;}};
}
test('one explicit model probe binds the account, binary and exact model without persisting secrets',async()=>{
 const f=fixture(),binding=await prepareMemoryProvider(f.host,'claude-fixture-1','low');
 expect(f.calls.filter(c=>c.input!==undefined)).toHaveLength(1);
 expect(JSON.stringify(binding)).not.toContain('@');expect(JSON.stringify(binding)).not.toContain(f.bin);
 const provider=memorySaveTextProvider(f.host,binding);expect(await provider.ready()).toBe(true);
 expect(await provider.propose(Buffer.from('evidence'))).toBe('Checked proposal');
 for(const c of f.calls.filter(c=>c.input!==undefined)){
  expect(c.argv.slice(c.argv.indexOf('--tools'),c.argv.indexOf('--tools')+2)).toEqual(['--tools','']);
  expect(c.argv).toContain('--safe-mode');expect(c.argv).toContain('--strict-mcp-config');expect(c.argv).toContain('--disable-slash-commands');
  expect(c.argv.slice(c.argv.indexOf('--name'),c.argv.indexOf('--name')+2)).toEqual(['--name','AgentsToZ memory']);
  expect(c.argv).not.toContain('--fallback-model');expect(c.argv).not.toContain(c.input!);
 }
});
test('a changed account or binary refuses the provider before a new model call',async()=>{
 const f=fixture(),b=await prepareMemoryProvider(f.host,'claude-fixture-1','low'),provider=memorySaveTextProvider(f.host,b);
 f.setAccount('second');expect(await provider.ready()).toBe(false);
 await expect(provider.propose(Buffer.from('private evidence'))).rejects.toThrow('POLICY_CHANGED');
 f.setAccount('first');writeFileSync(f.bin,'changed executable');expect(await provider.ready()).toBe(false);
 expect(f.calls.filter(c=>c.input!==undefined)).toHaveLength(1);
});
test('aliases, unexpected model routing and permission denial never become prepared bindings',async()=>{
 const f=fixture();await expect(prepareMemoryProvider(f.host,'sonnet','low')).rejects.toThrow('INVALID_INPUT');expect(f.calls).toHaveLength(0);
 f.setModel('claude-unexpected-1');await expect(prepareMemoryProvider(f.host,'claude-fixture-1','low')).rejects.toThrow('POLICY_CHANGED');
 f.host.run=async(_a,_c,input)=>({exitCode:0,stderr:'',stdout:JSON.stringify(input?{type:'result',subtype:'success',result:'MEMORY_SAVE_READY',modelUsage:{'claude-fixture-1':{}},permission_denials:[{}]}:{loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',email:'fixture@example.invalid',orgId:'org'})});
 await expect(prepareMemoryProvider(f.host,'claude-fixture-1','low')).rejects.toThrow('POLICY_CHANGED');
});

test('account changes during the model call cannot produce an accepted proposal',async()=>{
 const f=fixture(),binding=await prepareMemoryProvider(f.host,'claude-fixture-1','low'),run=f.host.run!;
 f.host.run=async(...args)=>{const result=await run(...args);if(args[2]!==undefined)f.setAccount('changed-during-call');return result;};
 await expect(memorySaveTextProvider(f.host,binding).propose(Buffer.from('fixture evidence'))).rejects.toThrow('POLICY_CHANGED');
 expect(f.calls.filter(c=>c.input!==undefined)).toHaveLength(2);
});

test('explicit revalidation renews only the changed binary with one exact-model canary',async()=>{
 const f=fixture(),prior=await prepareMemoryProvider(f.host,'claude-fixture-1','medium');
 writeFileSync(f.bin,'updated fixture executable');
 const next=await revalidateMemoryProvider(f.host,prior);
 expect(next.binaryFingerprint).not.toBe(prior.binaryFingerprint);
 expect({...next,binaryFingerprint:prior.binaryFingerprint,preparedAt:prior.preparedAt}).toEqual(prior);
 expect(await memorySaveTextProvider(f.host,next).ready()).toBe(true);
 const calls=f.calls.filter(c=>c.input!==undefined);expect(calls).toHaveLength(2);
 expect(calls[1]!.argv.slice(-4)).toEqual(['--model','claude-fixture-1','--effort','medium']);
 expect(calls[1]!.input).toBe('Return only MEMORY_SAVE_READY with no punctuation or other text.');
});

test('revalidation rejects a different account or installation before any new canary',async()=>{
 const f=fixture(),prior=await prepareMemoryProvider(f.host,'claude-fixture-1','low');
 f.setAccount('other');await expect(revalidateMemoryProvider(f.host,prior)).rejects.toThrow('POLICY_CHANGED');
 f.setAccount('first');f.host.installationId='other-installation';
 await expect(revalidateMemoryProvider(f.host,prior)).rejects.toThrow('POLICY_CHANGED');
 expect(f.calls.filter(c=>c.input!==undefined)).toHaveLength(1);
});

test('a revalidation cannot accept an account or binary replacement during its canary',async()=>{
 for(const change of ['account','binary']){
  const f=fixture(),prior=await prepareMemoryProvider(f.host,'claude-fixture-1','low'),run=f.host.run!;
  f.host.run=async(...args)=>{const result=await run(...args);if(args[2]!==undefined){if(change==='account')f.setAccount('during-probe');else writeFileSync(f.bin,'changed while probing');}return result;};
  await expect(revalidateMemoryProvider(f.host,prior)).rejects.toThrow('POLICY_CHANGED');
  expect(f.calls.filter(c=>c.input!==undefined)).toHaveLength(2);
 }
});

test('one deadline aborts a stalled probe without starting a second canary or changing proposal budgets',async()=>{
 const f=fixture(),run=f.host.run!;f.host.probeTimeoutMs=30;
 let aborted=false,models=0;
 f.host.run=async(...args)=>{
  if(args[2]===undefined)return run(...args);
  models++;
  return new Promise((_,reject)=>{
   const abort=()=>{aborted=true;reject(new Error('fixture process stopped'));};
   args[4]!.addEventListener('abort',abort,{once:true});if(args[4]!.aborted)abort();
  });
 };
 const start=performance.now();await expect(prepareMemoryProvider(f.host,'claude-fixture-1','low')).rejects.toMatchObject({code:'PROVIDER_PROBE_UNCONFIRMED'});
 expect(aborted).toBe(true);expect(models).toBe(1);expect(performance.now()-start).toBeLessThan(2000);
 const proposalFixture=fixture(),binding=await prepareMemoryProvider(proposalFixture.host,'claude-fixture-1','low'),proposalRun=proposalFixture.host.run!;
 proposalFixture.host.probeTimeoutMs=1;
 proposalFixture.host.run=async(...args)=>{if(args[2]!==undefined)await new Promise(resolve=>setTimeout(resolve,20));return proposalRun(...args);};
 expect(await memorySaveTextProvider(proposalFixture.host,binding).propose(Buffer.from('fixture evidence'))).toBe('Checked proposal');
});

test('the probe deadline includes final identity confirmation and cannot be extended by a host',async()=>{
 const f=fixture(),run=f.host.run!;f.host.probeTimeoutMs=40;let auth=0,aborted=false;
 f.host.run=async(...args)=>{
  if(args[2]===undefined&&++auth===2)return new Promise((_,reject)=>{
   const abort=()=>{aborted=true;reject(new Error('fixture post-check stopped'));};args[4]!.addEventListener('abort',abort,{once:true});if(args[4]!.aborted)abort();
  });
  return run(...args);
 };
 await expect(prepareMemoryProvider(f.host,'claude-fixture-1','low')).rejects.toMatchObject({code:'PROVIDER_PROBE_UNCONFIRMED'});
 expect(aborted).toBe(true);expect(f.calls.filter(c=>c.input!==undefined)).toHaveLength(1);
 f.host.probeTimeoutMs=60_001;await expect(prepareMemoryProvider(f.host,'claude-fixture-1','low')).rejects.toThrow('INVALID_INPUT');
});

 test('auxiliary model usage is still rejected instead of weakening the exact-model contract',async()=>{
 const f=fixture(),run=f.host.run!;f.host.run=async(...args)=>{const result=await run(...args);if(args[2]!==undefined){const d=JSON.parse(result.stdout);d.modelUsage['claude-haiku-extra']={inputTokens:1};result.stdout=JSON.stringify(d);}return result;};
 await expect(prepareMemoryProvider(f.host,'claude-fixture-1','low')).rejects.toThrow('POLICY_CHANGED');
 expect(f.calls.filter(c=>c.input!==undefined)).toHaveLength(1);
});

test('recovery inspection makes no inference and a separately verified probe retains the exact reviewed binding',async()=>{
 const f=fixture();f.host.now=()=>100;
 const prior=await prepareMemoryProvider(f.host,'claude-fixture-1','medium');
 writeFileSync(f.bin,'new executable for reviewed recovery');f.calls.splice(0);f.host.now=()=>200;
 const observed=await inspectMemoryProviderTransition(f.host,prior);
 expect(f.calls.every(call=>call.input===undefined)).toBe(true);
 expect(observed.binaryFingerprint).not.toBe(prior.binaryFingerprint);expect(observed.preparedAt).toBe(200);
 f.host.now=()=>300;
 expect(await verifyMemoryProviderTransition(f.host,prior,observed)).toEqual(observed);
 expect(f.calls.filter(call=>call.input!==undefined)).toHaveLength(1);
 expect(await memorySaveTextProvider(f.host,observed).ready()).toBe(true);
});

test('recovery verification refuses post-review binary, account, installation and clock changes before an inference',async()=>{
 for(const change of ['binary','account','installation','clock']){
  const f=fixture();f.host.now=()=>100;
  const prior=await prepareMemoryProvider(f.host,'claude-fixture-1','low');f.host.now=()=>200;
  const observed=await inspectMemoryProviderTransition(f.host,prior);f.calls.splice(0);
  if(change==='binary')writeFileSync(f.bin,'changed after explicit review');
  if(change==='account')f.setAccount('different');
  if(change==='installation')f.host.installationId='different-installation';
  if(change==='clock')f.host.now=()=>199;
  await expect(verifyMemoryProviderTransition(f.host,prior,observed)).rejects.toThrow('POLICY_CHANGED');
  expect(f.calls.filter(call=>call.input!==undefined)).toHaveLength(0);
 }
});

test('recovery verification checks identity again after its only canary and respects cancellation',async()=>{
 const f=fixture(),prior=await prepareMemoryProvider(f.host,'claude-fixture-1','low');
 const observed=await inspectMemoryProviderTransition(f.host,prior),run=f.host.run!;f.calls.splice(0);
 f.host.run=async(...args)=>{const result=await run(...args);if(args[2]!==undefined)writeFileSync(f.bin,'changed during reviewed probe');return result;};
 await expect(verifyMemoryProviderTransition(f.host,prior,observed)).rejects.toThrow('POLICY_CHANGED');
 expect(f.calls.filter(call=>call.input!==undefined)).toHaveLength(1);
 const controller=new AbortController();controller.abort();f.calls.splice(0);
 await expect(inspectMemoryProviderTransition(f.host,prior,controller.signal)).rejects.toThrow();
 await expect(verifyMemoryProviderTransition(f.host,prior,observed,controller.signal)).rejects.toMatchObject({code:'PROVIDER_PROBE_UNCONFIRMED'});
 expect(f.calls).toHaveLength(0);
});

test.skipIf(process.platform==='win32')('real provider children cannot self-update during auth, probe or summary',async()=>{
 const f=fixture();
 // Exercise the production spawn environment, not the injected provider runner.
 // This local executable simulates an updater and never contacts an AI service.
 writeFileSync(f.bin,`#!${process.execPath}
import {appendFileSync} from 'node:fs';
if(process.env.DISABLE_AUTOUPDATER!=='1')appendFileSync(import.meta.path,'\\n// updated');
if(process.env.ANTHROPIC_API_KEY||process.env.FORCE_AUTOUPDATE_PLUGINS)process.exit(7);
const auth=process.argv.includes('auth');
const input=auth?'':await Bun.stdin.text();
console.log(JSON.stringify(auth
 ? {loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',email:'fixture@example.invalid',orgId:'fixture-org'}
 : {type:'result',subtype:'success',result:input.startsWith('Return only MEMORY_SAVE_READY')?'MEMORY_SAVE_READY':'Checked proposal',modelUsage:{'claude-fixture-1':{}},permission_denials:[]}));
`);
 const previous={DISABLE_AUTOUPDATER:process.env.DISABLE_AUTOUPDATER,ANTHROPIC_API_KEY:process.env.ANTHROPIC_API_KEY,FORCE_AUTOUPDATE_PLUGINS:process.env.FORCE_AUTOUPDATE_PLUGINS};
 try{
  process.env.DISABLE_AUTOUPDATER='0';process.env.ANTHROPIC_API_KEY='fixture-never-forward';process.env.FORCE_AUTOUPDATE_PLUGINS='1';
  const host={...f.host,run:undefined};
  const binding=await prepareMemoryProvider(host,'claude-fixture-1','low');
  const provider=memorySaveTextProvider(host,binding);
  expect(await provider.propose(Buffer.from('fixture evidence'))).toBe('Checked proposal');
  expect(await provider.ready()).toBe(true);
  // An unrelated updater is still detected and cannot be silently accepted.
  writeFileSync(f.bin,'#!/bin/sh\nexit 0\n');
  await expect(provider.propose(Buffer.from('fixture evidence'))).rejects.toThrow();
 }finally{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
