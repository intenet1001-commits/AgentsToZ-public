import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync,mkdirSync,chmodSync,readdirSync,readlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isCodexLoginUrl,parseCodexLoginReceipt} from '../src/onboardingCodexLogin';
import {CodexLoginHost,type CodexLoginEffects,type CodexLoginProbe} from '../src/onboardingCodexLoginHost';
import {CodexLoginStore} from '../src/onboardingCodexLoginStore';
import {codexLoginOutputSink,codexAuthFileProtected,customCodexLoginContext} from '../src/onboardingCodexLoginRuntime';
import {handleGithubSetup} from '../src/onboardingGithubHttp';
import {ONBOARDING_EXECUTION_HEADER} from '../src/onboardingGithub';
const url=new URL('https://auth.openai.com/oauth/authorize');
for(const [k,v] of Object.entries({response_type:'code',client_id:'app_EMoamEEZ73f0CkXaXp7hrann',redirect_uri:'http://localhost:1455/auth/callback',scope:'openid profile email offline_access api.connectors.read api.connectors.invoke',code_challenge:'a'.repeat(43),code_challenge_method:'S256',state:'s'.repeat(43)}))url.searchParams.set(k,v);
const synthetic=url.href;
test('browser URL is exact-origin, callback, public client, scope and PKCE constrained',()=>{
 expect(isCodexLoginUrl(synthetic)).toBe(true);
 for(const [k,v] of [['redirect_uri','http://evil.test/callback'],['client_id','other'],['scope','admin'],['state','short'],['code_challenge_method','plain'],['extra','1']]){
  const u=new URL(synthetic);u.searchParams.set(k!,v!);expect(isCodexLoginUrl(u.href)).toBe(false);
 }
 for(const value of [synthetic.replace('auth.openai.com','auth.openai.com.evil.test'),synthetic+'&state='+ 's'.repeat(43),synthetic+'#secret',synthetic.replace('https:','http:')])expect(isCodexLoginUrl(value)).toBe(false);
});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'codex-auth-host-')),store=new CodexLoginStore(root);
 let probe:CodexLoginProbe='signed-out',finish!:()=>void,emit!:(url:string)=>void,starts=0,cancels=0,opens=0;
 const effects:CodexLoginEffects={supported:true,probe:async()=>probe,login:(_r,onUrl)=>{starts++;emit=onUrl;return {done:new Promise<void>(r=>finish=r),cancel:()=>{cancels++;}};},open:async()=>{opens++;}};
 const host=new CodexLoginHost(store,effects);
 return {root,store,host,setProbe:(p:CodexLoginProbe)=>probe=p,emit:(u=synthetic)=>emit(u),finish:()=>finish(),counts:()=>({starts,cancels,opens}),act:(op:string)=>host.act(op,store.receipt()?.revision??'0'),cleanup:async()=>{await host.close();store.close();rmSync(root,{recursive:true,force:true});}};
}
test('cached or indeterminate account is preserved and cannot start a second login',async()=>{
 for(const p of ['configured','unknown','storage-review'] as CodexLoginProbe[]){const f=fixture();try{
  f.setProbe(p);await f.act('check');await expect(f.act('login')).rejects.toThrow();expect(f.counts().starts).toBe(0);
 }finally{await f.cleanup();}}
});
test('readback is required, URL is ephemeral, reload never launches and cancellation rejects late success',async()=>{
 const f=fixture();try{
  await f.act('review');await f.act('login');f.emit();
  expect(f.host.status().browserReady).toBe(true);
  expect(JSON.stringify(f.host.status())).not.toContain('https:');
  expect(JSON.stringify(f.store.receipt())).not.toContain('state=');
  expect(()=>parseCodexLoginReceipt({...f.store.receipt(),url:synthetic})).toThrow();
  await f.act('open-login');expect(f.counts().opens).toBe(1);
  for(let i=0;i<5;i++)f.host.status();expect(f.counts().starts).toBe(1);
  await f.act('cancel');f.emit();f.setProbe('configured');f.finish();await Bun.sleep(1);
  expect(f.host.status().receipt?.state).toBe('cancelled');expect(f.host.status().browserReady).toBe(false);
  await expect(f.act('open-login')).rejects.toThrow();
  await f.act('check');expect(f.host.status().receipt?.state).toBe('configured');
 }finally{await f.cleanup();}
});
test('normal completion rechecks actual credentials; stale revisions and expired review are refused',async()=>{
 const f=fixture();try{
  await f.act('review');const old=f.store.receipt()!.revision;
  await f.act('check');await expect(f.host.act('login',old)).rejects.toThrow();
  let r=f.store.receipt()!;f.store.change(r.revision,x=>({...x!,checkedAt:'2020-01-01T00:00:00Z'}));
  await expect(f.act('login')).rejects.toThrow();await f.act('check');await f.act('login');f.emit();f.finish();await Bun.sleep(1);
  expect(f.host.status().receipt?.state).toBe('needs-review');
 }finally{await f.cleanup();}
});
test('private log sink discards login output without changing existing auth files',()=>{
 const root=mkdtempSync(join(tmpdir(),'codex-auth-sink-'));try{
  chmodSync(root,0o755);const sink=codexLoginOutputSink(root);
  expect(readlinkSync(join(sink,'codex-login.log'))).toBe('/dev/null');
  writeFileSync(join(sink,'codex-login.log'),'synthetic-private-data');expect(readFileSync(join(sink,'codex-login.log'),'utf8')).toBe('');
  mkdirSync(join(root,'.codex'),{mode:0o700});const file=join(root,'.codex/auth.json');writeFileSync(file,'preserve',{mode:0o600});expect(codexAuthFileProtected(root)).toBe(true);
  chmodSync(file,0o644);expect(codexAuthFileProtected(root)).toBe(false);expect(readFileSync(file,'utf8')).toBe('preserve');
  expect(customCodexLoginContext({CODEX_HOME:'/custom'})).toBe(true);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('login endpoint is native-capability-only and never accepts a URL, install or command',async()=>{
 const cap='a'.repeat(64);let calls=0;const host=()=>({status:()=>({}),act:async()=>{calls++;return {};}});
 const req=(body:object,headers:Record<string,string>={})=>new Request('http://127.0.0.1/api/onboarding/codex-login',{method:'POST',headers:{'Content-Type':'application/json',[ONBOARDING_EXECUTION_HEADER]:cap,...headers},body:JSON.stringify(body)});
 expect((await handleGithubSetup(req({operation:'status'},{origin:'http://localhost'}),cap,host,'codex-login')).status).toBe(403);
 for(const body of [{operation:'install',expectedRevision:'0'},{operation:'open-login',expectedRevision:'0',url:synthetic},{operation:'login',expectedRevision:'0',command:'anything'}])expect((await handleGithubSetup(req(body),cap,host,'codex-login')).status).toBe(400);
 expect((await handleGithubSetup(req({operation:'login',expectedRevision:'0'}),cap,host,'codex-login')).status).toBe(200);expect(calls).toBe(1);
});
function running(pid:number){const ps=Bun.spawnSync(['/bin/ps','-p',String(pid),'-o','stat=']);return ps.exitCode===0&&!ps.stdout.toString().trim().startsWith('Z');}
for(const mode of ['parent-death','success','cancel-before-claim'])test.skipIf(process.platform!=='darwin')(`guard ${mode}: sanitizes output/env and reaps owned provider`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'codex-auth-guard-')),exe=join(root,'codex');
 writeFileSync(exe,`#!/bin/sh\ncase "$*" in\n  --version) echo 'codex-cli 0.154.0'; exit 0;;\n  *'login status') echo 'Not logged in' >&2; exit 1;;\nesac\necho $$ > '${root}/provider.pid'\n[ -n "$OPENAI_API_KEY" ] && echo leaked > '${root}/leaked'\necho private-account-credential\nprintf '\\033[34m'; printf '%s' '${synthetic}'; /bin/sleep 0.05; printf '\\033[0m\\n'\n${mode==='success'?'/bin/sleep 30 &\necho $! > '+"'"+root+"/descendant.pid'\nexit 0":'while :; do /bin/sleep 1; done'}\n`,{mode:0o700});
 const parent=Bun.spawn([process.execPath,join(import.meta.dir,'fixtures/onboarding-codex-login/parent.ts'),exe,root,mode],{cwd:'/',stdin:'pipe',stdout:'pipe',stderr:'ignore'});
 let output='',guard=0;const pump=(async()=>{for await(const b of parent.stdout)output+=new TextDecoder().decode(b);})();
 try{
  if(mode==='cancel-before-claim'){await parent.exited;expect(existsSync(join(root,'provider.pid'))).toBe(false);return;}
  for(let i=0;i<300&&!output.includes('URL ');i++)await Bun.sleep(10);
  expect(output).toContain('URL '+synthetic);expect(output).not.toContain('private-account');expect(existsSync(join(root,'leaked'))).toBe(false);
  guard=Number(output.match(/GUARD (\d+)/)?.[1]);const provider=Number(readFileSync(join(root,'provider.pid'),'utf8'));
  if(mode==='parent-death')parent.kill('SIGKILL');await parent.exited;
  for(let i=0;i<100&&running(provider);i++)await Bun.sleep(20);expect(running(provider)).toBe(false);
  if(mode==='success'){expect(output).toContain('RESULT OK');const descendant=Number(readFileSync(join(root,'descendant.pid'),'utf8'));expect(running(descendant)).toBe(false);}
  expect(readdirSync(join(root,'onboarding/codex-login-output'))).toEqual(['codex-login.log']);
 }finally{try{parent.kill('SIGKILL');}catch{}if(guard>1)try{process.kill(-guard,'SIGKILL');}catch{}await parent.exited;await pump;rmSync(root,{recursive:true,force:true});}
},15000);

test('successful provider completion becomes configured only after readback; second host cannot resume a live login',async()=>{
 const f=fixture();const other=new CodexLoginHost(f.store,{supported:true,probe:async()=>'signed-out',login:()=>{throw new Error('must not start');},open:async()=>{throw new Error('must not open');}});
 try{
  await f.act('review');await f.act('login');f.emit();
  expect(other.status().receipt?.state).toBe('authenticating');expect(other.status().browserReady).toBe(false);
  await expect(other.act('check',f.store.receipt()!.revision)).rejects.toThrow();
  f.setProbe('configured');f.finish();await Bun.sleep(1);
  expect(f.host.status().receipt?.state).toBe('configured');expect(f.host.status().browserReady).toBe(false);expect(f.counts().starts).toBe(1);
 }finally{await other.close();await f.cleanup();}
});
