import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PlatformCliStore} from '../src/platformCliStore';
import {PlatformCliHost,type PlatformCliExecution} from '../src/platformCliHost';
import {connectNativePlatformAccount,platformCliSetupStatus,readNativePlatformCredential,readSupabaseSetup,readSupabasePublicSetupKey} from '../src/platformCliSetup';
import {buildPlatformCliSetupHandoff} from '../src/platformCliSetupGuide';
import {validatePlatformCliRequest} from '../src/platformCliRequestValidation';
import {PLATFORM_CLI_PROVIDERS,type PlatformCliProvider} from '../src/platformCliProtocol';
const dirs:string[]=[];afterEach(()=>dirs.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true})));
const email='owner@example.test',rid=()=>crypto.randomUUID();
const secrets={github:'ghp_'+'a'.repeat(40),vercel:JSON.stringify({token:'oauth_'+'v'.repeat(30),refreshToken:'synthetic-refresh',expiresAt:12345}),supabase:'sbp_'+'s'.repeat(40),'google-workspace':JSON.stringify({type:'authorized_user',client_id:'synthetic-client',client_secret:'synthetic-client-secret',refresh_token:'synthetic-refresh'})};
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'atz-first-cli-'));dirs.push(dir);const vault=new Map<string,string>(),calls:PlatformCliExecution[]=[];let reads=0,actual=email,fail=false;
 const store=new PlatformCliStore(dir,{get:async id=>{reads++;return vault.get(id)??null;},set:async(id,value)=>{vault.set(id,value);}});
 const publicKey='sb_publishable_synthetic_anon',serviceKey='sb_secret_SYNTHETIC_NEVER_RENDER';
 const host=new PlatformCliHost({store,env:{HOME:dir,PATH:'/fixture',SUPABASE_SERVICE_ROLE_KEY:'app-only'},executable:p=>'/fixture/'+p,resolveProject:async id=>({id,cwd:dir,label:id}),json:async(url)=>url.includes('github')?[{email:actual,verified:true}]:url.includes('vercel')?{user:{email:actual}}:{primary_email:actual},run:async e=>{calls.push(e);if(fail)return {code:1,stdout:'',stderr:'private provider failure'};const p=e.account.provider;return {code:0,stderr:'',stdout:p==='github'?'{"login":"actual-owner","id":123}':p==='vercel'?'actual-owner':p==='google-workspace'?JSON.stringify({user:{emailAddress:actual}}):e.args[1]==='api-keys'?JSON.stringify([{name:'anon',api_key:publicKey},{name:'service_role',api_key:serviceKey}]):JSON.stringify([{id:'a'.repeat(20),name:'App sync',region:'ap-northeast-2'}])};}});
 return {dir,store,host,vault,calls,publicKey,serviceKey,reads:()=>reads,setEmail:(v:string)=>{actual=v;},fail:()=>{fail=true;}};
}
test('a first device with no or some CLIs reports installation independently of accounts without opening its vault',()=>{
 const f=fixture();f.host.deps.executable=()=>null;expect(platformCliSetupStatus(f.host)).toEqual(PLATFORM_CLI_PROVIDERS.map(provider=>({provider,installed:false,connected:0})));
 f.host.deps.executable=p=>{if(p==='supabase')throw Error('unknown');return p==='github'?'/fixture/gh':null;};
 const rows=platformCliSetupStatus(f.host);expect(rows.find(r=>r.provider==='github')?.installed).toBe(true);expect(rows.find(r=>r.provider==='supabase')?.installed).toBeNull();expect(f.reads()).toBe(0);expect(f.calls).toHaveLength(0);
});
for(const provider of PLATFORM_CLI_PROVIDERS)test(provider+' existing login is email verified, stored privately, and does not alter a project override',async()=>{
 const f=fixture();await f.store.setDefault(provider,email,null,rid());const id=rid(),read=async()=>secrets[provider];
 const account=await connectNativePlatformAccount(f.host,provider,email,id,read);expect(account.verifiedEmail).toBe(email);expect(account.state).toBe('ready');expect(f.store.defaultAccountId(provider)).toBe(account.id);
 await f.host.bind('project',provider,{accountId:account.id,resourceId:'',scope:''},rid());
 expect((await connectNativePlatformAccount(f.host,provider,email,id,read)).id).toBe(account.id);expect(f.store.list()).toHaveLength(1);expect(f.store.binding('project',provider)?.accountId).toBe(account.id);
 expect(readFileSync(f.store.file,'utf8')).not.toContain('synthetic-refresh');expect(readFileSync(f.store.file,'utf8')).not.toContain(secrets.supabase);
});
for(const provider of PLATFORM_CLI_PROVIDERS)test(provider+' mismatched existing account never registers a usable account or changes a reserved default',async()=>{
 const f=fixture();await f.store.setDefault(provider,email,null,rid());f.setEmail('someone-else@example.test');await expect(connectNativePlatformAccount(f.host,provider,email,rid(),async()=>secrets[provider])).rejects.toThrow();
 expect(f.store.list()).toHaveLength(0);expect(f.store.deviceDefaults()[provider]?.accountId).toBeNull();
});
test('Vercel native import preserves OAuth refresh information and never rewrites its global config',async()=>{
 const f=fixture(),data=join(f.dir,'vercel-data'),directory=join(data,'com.vercel.cli');mkdirSync(directory,{recursive:true});const file=join(directory,'auth.json');writeFileSync(file,secrets.vercel,{mode:0o600});f.host.deps.env={HOME:f.dir,XDG_DATA_HOME:data};
 expect(await readNativePlatformCredential(f.host,'vercel')).toBe(secrets.vercel);expect(readFileSync(file,'utf8')).toBe(secrets.vercel);expect(f.calls).toHaveLength(0);
});
test.skipIf(process.platform!=='darwin')('Supabase native detection decodes the current CLI profile without global login or logout',async()=>{
 const f=fixture();f.host.deps.run=async e=>{f.calls.push(e);return {code:0,stderr:'',stdout:'go-keyring-base64:'+Buffer.from(secrets.supabase).toString('base64')};};
 expect(await readNativePlatformCredential(f.host,'supabase')).toBe(secrets.supabase);expect(f.calls).toHaveLength(1);expect(f.calls[0]?.args).toEqual(['find-generic-password','-s','Supabase CLI','-a','supabase','-w']);expect(f.calls[0]?.timeoutMs).toBe(120000);
});
test('an existing Vercel config directory without auth never falls back to a stale legacy login',async()=>{
 const f=fixture(),data=join(f.dir,'vercel-data');mkdirSync(join(data,'com.vercel.cli'),{recursive:true});mkdirSync(join(f.dir,'.now'));writeFileSync(join(f.dir,'.now','auth.json'),secrets.vercel,{mode:0o600});f.host.deps.env={HOME:f.dir,XDG_DATA_HOME:data};
 await expect(readNativePlatformCredential(f.host,'vercel')).rejects.toThrow('브라우저');expect(f.store.list()).toHaveLength(0);
});
test('explicit Supabase setup selects one verified account and exposes only its public key without changing the app DB or defaults',async()=>{
 const f=fixture(),a=await connectNativePlatformAccount(f.host,'supabase',email,rid(),async()=>secrets.supabase);const before=readFileSync(f.store.file,'utf8');
 expect(await readSupabaseSetup(f.host,a.id)).toEqual([{ref:'a'.repeat(20),name:'App sync',region:'ap-northeast-2'}]);
 const result=await readSupabasePublicSetupKey(f.host,a.id,'a'.repeat(20));expect(result).toEqual({projectUrl:'https://'+'a'.repeat(20)+'.supabase.co',anonKey:f.publicKey});expect(JSON.stringify(result)).not.toContain(f.serviceKey);
 expect(f.calls.at(-1)?.env.SUPABASE_ACCESS_TOKEN).toBe(secrets.supabase);expect(f.calls.at(-1)?.env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();expect(readFileSync(f.store.file,'utf8')).toBe(before);
 f.fail();await expect(readSupabasePublicSetupKey(f.host,a.id,'a'.repeat(20))).rejects.toThrow('다른 계정');await expect(readSupabaseSetup(f.host,a.id,'bad/ref')).rejects.toThrow('ref');
});
test('setup and app-sync key operations remain unavailable to agent MCP requests',()=>{
 for(const operation of ['setup-status','connect-native','supabase-projects','supabase-client-key'])expect(()=>validatePlatformCliRequest({operation},true)).toThrow('앱');
});
test('AI setup handoff describes a missing tool and manual verification without copying arbitrary diagnostics or credentials',()=>{
 const prompt=buildPlatformCliSetupHandoff('supabase',{provider:'supabase',installed:false,connected:0,token:'DO_NOT_COPY'} as any,'MacIntel');expect(prompt).toContain('찾지 못함');expect(prompt).toContain('기존 로그인 확인·연결');expect(prompt).toContain('두 번째·추가 기기 연결');expect(prompt).not.toContain('DO_NOT_COPY');expect(prompt).not.toContain('sb_secret_');
});
test('app data management login leaves a matching pending project CLI default and bindings unchanged, including replay across purposes',async()=>{
 const f=fixture();await f.store.setDefault('supabase',email,null,rid());const id=rid();
 const account=await connectNativePlatformAccount(f.host,'supabase',email,id,async()=>secrets.supabase,'app-sync-account');
 expect(account.state).toBe('ready');expect(f.store.deviceDefaults().supabase?.accountId).toBeNull();expect(f.store.binding('project','supabase')).toBeNull();
 expect((await connectNativePlatformAccount(f.host,'supabase',email,id,async()=>secrets.supabase,'app-sync-account')).id).toBe(account.id);
 await expect(connectNativePlatformAccount(f.host,'supabase',email,id,async()=>secrets.supabase,'project-cli')).rejects.toThrow();
 expect(f.store.deviceDefaults().supabase?.accountId).toBeNull();expect(f.store.list()).toHaveLength(1);
});
test('app management login purpose is explicit, Supabase only, local only, and its AI handoff never selects a project CLI default',()=>{
 for(const operation of ['login-start','connect-native']){
  expect(validatePlatformCliRequest({operation,provider:'supabase',purpose:'app-sync-account'}).purpose).toBe('app-sync-account');
  for(const provider of ['github','vercel','google-workspace'])expect(()=>validatePlatformCliRequest({operation,provider,purpose:'app-sync-account'})).toThrow('용도');
  expect(()=>validatePlatformCliRequest({operation,provider:'supabase',purpose:'arbitrary'})).toThrow('용도');
  expect(()=>validatePlatformCliRequest({operation,provider:'supabase',purpose:'app-sync-account'},true)).toThrow('앱');
 }
 const prompt=buildPlatformCliSetupHandoff('supabase',null,'MacIntel','app-sync-account');expect(prompt).toContain('프로젝트 작업용 CLI 기본 계정은 바꾸지 마세요');expect(prompt).toContain('연결한 계정 다시 읽기');expect(prompt).not.toContain('“기본 계정으로 사용”을 선택');
});
