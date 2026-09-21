import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {OnboardingGithubStore} from '../src/onboardingGithubStore';
import {OnboardingGithubHost,createGithubHostEffects,type GithubHostEffects} from '../src/onboardingGithubHost';
import {handleGithubSetup,onboardingHealthProof} from '../src/onboardingGithubHttp';
import {ONBOARDING_EXECUTION_HEADER} from '../src/onboardingGithub';
const roots:string[]=[],stores:OnboardingGithubStore[]=[],hosts:OnboardingGithubHost[]=[];
afterEach(async()=>{for(const h of hosts.splice(0))await h.close();for(const s of stores.splice(0))s.close();for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
function setup(overrides:Partial<GithubHostEffects>={}){
 const root=mkdtempSync(join(tmpdir(),'github-setup-'));roots.push(root);const store=new OnboardingGithubStore(root);stores.push(store);
 const calls:string[]=[];const effects:GithubHostEffects={platform:'darwin',probe:async()=>{calls.push('probe');return 'missing';},prepare:async()=>{calls.push('prepare');},installFile:async()=>{calls.push('open');},openLoginPage:async()=>{},login:()=>{throw new Error('not configured');},...overrides};
 const host=new OnboardingGithubHost(store,effects);hosts.push(host);return {host,store,root,calls,effects};
}
async function until(host:OnboardingGithubHost,state:string){for(let i=0;i<100;i++){if(host.status().receipt?.state===state)return;await Bun.sleep(5);}throw new Error('state not reached');}

test('review and explicit install persist before file installation; refresh/restart does not install again',async()=>{
 const {host,store,calls,effects}=setup();
 const reviewed=(await host.act('review','0')).receipt!;expect(calls).toEqual([]);
 await host.act('install',reviewed.revision);await until(host,'needs-review');
 expect(calls).toEqual(['probe','prepare','open','probe']);
 expect(host.status().receipt?.state).not.toBe('ready');
 const other=new OnboardingGithubHost(store,effects);hosts.push(other);other.status();
 expect(calls.filter(c=>c==='open')).toHaveLength(1);
 await other.act('check',other.status().receipt!.revision);
 expect(other.status().receipt?.state).toBe('needs-review');
 expect(calls.filter(c=>c==='open')).toHaveLength(1);
});

test('installed tools are reused; unknown network state cannot authorize installation',async()=>{
 for(const state of ['installed','unknown'] as const){
  const {host,calls}=setup({probe:async()=>state});
  const reviewed=(await host.act('review','0')).receipt!;await host.act('install',reviewed.revision);
  await until(host,state==='installed'?'installed':'needs-review');
  expect(calls).toEqual([]);
 }
});

test('concurrent clicks and cancellation cannot start a second installer or install after cancellation',async()=>{
 let release!:()=>void;const wait=new Promise<void>(r=>release=r);
 const {host,store,effects,calls}=setup({prepare:async()=>{await wait;}});
 const reviewed=(await host.act('review','0')).receipt!;
 await host.act('install',reviewed.revision);
 await expect(host.act('install',reviewed.revision)).rejects.toThrow();
 const second=new OnboardingGithubHost(store,effects);hosts.push(second);
 await expect(second.act('check',second.status().receipt!.revision)).rejects.toThrow();
 await host.act('cancel',host.status().receipt!.revision);release();await Bun.sleep(10);
 expect(host.status().receipt?.state).toBe('cancelled');expect(calls).not.toContain('open');
});

test('auth code exists only during owned login, is never durable, and cancel rejects a late success',async()=>{
 let finish!:()=>void,onCode!:(v:string)=>void;const done=new Promise<void>(r=>finish=r);
 const {host,root}=setup({probe:async()=> 'installed',login:code=>{onCode=code;return {done,cancel:()=>finish()};}});
 let r=(await host.act('review','0')).receipt!;await host.act('check',r.revision);
 await host.act('login',host.status().receipt!.revision);onCode('ABCD-1234');
 expect(host.status().code).toBe('ABCD-1234');
 expect(readFileSync(join(root,'onboarding','progress-v1.sqlite')).includes(Buffer.from('ABCD-1234'))).toBe(false);
 await host.act('cancel',host.status().receipt!.revision);onCode('LATE-1234');await Bun.sleep(10);
 expect(host.status().code).toBeNull();expect(host.status().receipt?.state).toBe('cancelled');
});

test('capability is independent, strict and never accepted from a web Origin',async()=>{
 const {host,calls}=setup();const capability='a'.repeat(64),url='http://127.0.0.1/api/onboarding/github';
 const req=(body:unknown,headers:Record<string,string>={})=>new Request(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 expect((await handleGithubSetup(req({operation:'status'}),capability,()=>host)).status).toBe(403);
 expect((await handleGithubSetup(req({operation:'status'},{[ONBOARDING_EXECUTION_HEADER]:capability,Origin:'tauri://localhost'}),capability,()=>host)).status).toBe(403);
 expect((await handleGithubSetup(req({operation:'install',expectedRevision:'0',command:'whoami'},{[ONBOARDING_EXECUTION_HEADER]:capability}),capability,()=>host)).status).toBe(400);
 const response=await handleGithubSetup(req({operation:'review',expectedRevision:'0'},{[ONBOARDING_EXECUTION_HEADER]:capability}),capability,()=>host);
 expect(response.status).toBe(200);expect(calls).toEqual([]);
 expect(onboardingHealthProof(capability,'b'.repeat(64))).not.toBe(onboardingHealthProof('c'.repeat(64),'b'.repeat(64)));
});

test('plaintext fallback remains unresolved across restart and cannot automatically relogin',async()=>{
 let authenticated=false,logins=0;
 const {host,store,effects}=setup({probe:async()=>authenticated?'storage-review':'installed',
  login:()=>{logins++;authenticated=true;return {done:Promise.resolve(),cancel:()=>{}};}});
 let r=(await host.act('review','0')).receipt!;await host.act('check',r.revision);
 await host.act('login',host.status().receipt!.revision);await until(host,'storage-review');
 expect(host.status().code).toBeNull();
 const reopened=new OnboardingGithubHost(store,effects);hosts.push(reopened);
 expect(reopened.status().receipt?.state).toBe('storage-review');
 await expect(reopened.act('login',reopened.status().receipt!.revision)).rejects.toThrow();
 await reopened.act('check',reopened.status().receipt!.revision);
 expect(reopened.status().receipt?.state).toBe('storage-review');expect(logins).toBe(1);
 // Re-review/install must reuse the existing CLI and retain the storage finding.
 const review=(await reopened.act('review',reopened.status().receipt!.revision)).receipt!;
 await reopened.act('install',review.revision);await until(reopened,'storage-review');
 expect(logins).toBe(1);
});


test('custom XDG config never silently switches to the default GitHub account',async()=>{
 const previous=process.env.XDG_CONFIG_HOME;
 try{process.env.XDG_CONFIG_HOME='/nonexistent-onboarding-profile';
  const effects=createGithubHostEffects('/unused-readonly');
  expect(await effects.probe()).toBe('unknown');
 }finally{if(previous===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=previous;}
});
