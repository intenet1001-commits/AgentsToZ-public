import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,rmSync,mkdirSync,symlinkSync,readlinkSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexInstallHost,CodexInstallStore,type CodexInstallEffects} from '../src/onboardingCodexInstallHost';
import {createCodexInstallEffects} from '../src/onboardingCodexInstallEffects';
import {handleGithubSetup} from '../src/onboardingGithubHttp';
import {ONBOARDING_EXECUTION_HEADER} from '../src/onboardingGithub';
const roots:string[]=[],stores:CodexInstallStore[]=[],hosts:CodexInstallHost[]=[];
afterEach(async()=>{for(const h of hosts.splice(0))await h.close();for(const s of stores.splice(0))s.close();for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
function setup(overrides:Partial<CodexInstallEffects>={}){
 const root=mkdtempSync(join(tmpdir(),'codex-install-'));roots.push(root);
 const store=new CodexInstallStore(root);stores.push(store);const calls:string[]=[];
 let installed=false;
 const effects:CodexInstallEffects={supported:true,probe:async()=>installed?'installed':'missing',prepare:async()=>{calls.push('prepare');},install:async()=>{calls.push('install');expect(store.receipt()?.state).toBe('installing');installed=true;},...overrides};
 const host=new CodexInstallHost(store,effects);hosts.push(host);return {root,store,host,calls,effects};
}
async function until(h:CodexInstallHost,state:string){for(let i=0;i<100;i++){if(h.status().receipt?.state===state)return;await Bun.sleep(5);}throw new Error('state');}

test('Codex explicit installation persists intent, reuses installed tools and does not replay on reload',async()=>{
 const {host,store,calls,effects}=setup();
 host.status();expect(calls).toEqual([]);
 const r=(await host.act('review','0')).receipt!;await host.act('install',r.revision);await until(host,'installed');
 const second=new CodexInstallHost(store,effects);hosts.push(second);second.status();
 await second.act('check',store.receipt()!.revision);expect(calls).toEqual(['prepare','install']);
 const again=(await second.act('review',store.receipt()!.revision)).receipt!;
 await second.act('install',again.revision);await until(second,'installed');expect(calls).toEqual(['prepare','install']);
});
test('unknown auth never authorizes reinstall and cached credentials are not first-response success',async()=>{
 for(const p of ['unknown','configured'] as const){
  const {host,calls}=setup({probe:async()=>p});const r=(await host.act('review','0')).receipt!;
  await host.act('install',r.revision);await until(host,p==='unknown'?'needs-review':'configured');expect(calls).toEqual([]);
 }
});
test('concurrent operations, stale reviews and cancellation cannot install twice or accept late success',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const {host,store,calls,effects}=setup({prepare:async()=>gate});
 let r=(await host.act('review','0')).receipt!;
 r=store.change(r.revision,x=>({...x!,reviewedAt:new Date(Date.now()-300001).toISOString()}));
 await expect(host.act('install',r.revision)).rejects.toThrow();
 r=(await host.act('review',r.revision)).receipt!;await host.act('install',r.revision);
 const other=new CodexInstallHost(store,effects);hosts.push(other);
 await expect(other.act('review',store.receipt()!.revision)).rejects.toThrow();
 await expect(host.act('install',r.revision)).rejects.toThrow();
 await host.act('cancel',store.receipt()!.revision);release();await Bun.sleep(10);
 expect(store.receipt()?.state).toBe('cancelled');expect(calls).not.toContain('install');
});
test('old recipe can read back but cannot install; strict native route rejects login and arbitrary targets',async()=>{
 const {host,store,calls}=setup();let r=(await host.act('review','0')).receipt!;
 r=store.change(r.revision,x=>({...x!,recipe:'retired-recipe'}));
 await expect(host.act('install',r.revision)).rejects.toThrow();await host.act('check',r.revision);
 const capability='a'.repeat(64);
 const req=(body:unknown,headers:Record<string,string>={})=>new Request('http://localhost/api/onboarding/codex',{method:'POST',headers:{'Content-Type':'application/json',[ONBOARDING_EXECUTION_HEADER]:capability,...headers},body:JSON.stringify(body)});
 expect((await handleGithubSetup(req({operation:'status'},{Origin:'http://tauri.localhost'}),capability,()=>host,'codex')).status).toBe(403);
 for(const operation of ['login','open-login','shell'])expect((await handleGithubSetup(req({operation,expectedRevision:store.receipt()!.revision}),capability,()=>host,'codex')).status).toBe(400);
 expect((await handleGithubSetup(req({operation:'install',expectedRevision:store.receipt()!.revision,path:'/tmp/tool'}),capability,()=>host,'codex')).status).toBe(400);
 expect((await handleGithubSetup(req({operation:'status'}),capability,()=>host,'codex')).status).toBe(200);expect(calls).toEqual([]);
});
test('broken existing link and custom profile remain unknown; failed download leaves no executable or partial cache',async()=>{
 const {root}=setup();const bin=join(root,'.local/bin');mkdirSync(bin,{recursive:true});const target=join(bin,'codex');symlinkSync('/nonexistent-codex-test',target);
 const effects=createCodexInstallEffects(root,{home:root,candidates:[target]});
 expect(await effects.probe()).toBe('unknown');expect(readlinkSync(target)).toBe('/nonexistent-codex-test');
 const original=process.env.CODEX_HOME;
 try{process.env.CODEX_HOME='/existing-custom-profile';expect(await createCodexInstallEffects(root,{home:root,candidates:[]}).probe()).toBe('unknown');}
 finally{if(original===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=original;}
 const originalFetch=globalThis.fetch;
 try{globalThis.fetch=(async()=>new Response('truncated package')) as unknown as typeof fetch;
  await expect(effects.prepare(new AbortController().signal)).rejects.toThrow();
  expect(readdirSync(join(root,'onboarding')).some(p=>p.endsWith('.part')||p.endsWith('.gz'))).toBe(false);
 }finally{globalThis.fetch=originalFetch;}
});
