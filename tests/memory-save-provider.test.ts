import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,writeFileSync,chmodSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareMemoryProvider,memorySaveTextProvider,type MemoryProviderHost} from '../src/memorySaveProvider';
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

 test('auxiliary model usage is still rejected instead of weakening the exact-model contract',async()=>{
 const f=fixture(),run=f.host.run!;f.host.run=async(...args)=>{const result=await run(...args);if(args[2]!==undefined){const d=JSON.parse(result.stdout);d.modelUsage['claude-haiku-extra']={inputTokens:1};result.stdout=JSON.stringify(d);}return result;};
 await expect(prepareMemoryProvider(f.host,'claude-fixture-1','low')).rejects.toThrow('POLICY_CHANGED');
 expect(f.calls.filter(c=>c.input!==undefined)).toHaveLength(1);
});
