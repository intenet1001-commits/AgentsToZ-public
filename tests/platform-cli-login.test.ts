import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync,mkdirSync,readFileSync,readdirSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PlatformCliStore} from '../src/platformCliStore';
import {PlatformCliHost,type PlatformCliExecution} from '../src/platformCliHost';
import {PlatformCliLoginHost,spawnPlatformLogin,type PlatformLoginSpawn} from '../src/platformCliLogin';
import {platformCliVerifiedEmail} from '../src/platformCliIdentity';
import {validatePlatformCliRequest} from '../src/platformCliRequest';
import {parseGoogleDesktopClient} from '../src/platformGoogleOAuthClient';
const dirs:string[]=[];afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const token='ghp_'+'a'.repeat(40),vercelToken='oauth_'+'b'.repeat(35),supabaseToken='sbp_'+'c'.repeat(40),email='intenet1001@gmail.com';
const google=JSON.stringify({type:'authorized_user',client_id:'fake-client',client_secret:'fake-secret',refresh_token:'fake-refresh'});
const rid=()=>crypto.randomUUID();
function fixture(nativeSupabaseToken=supabaseToken){
  const dir=mkdtempSync(join(tmpdir(),'atz-oauth-'));dirs.push(dir);const values=new Map<string,string>();
  const store=new PlatformCliStore(dir,{get:async id=>values.get(id)??null,set:async(id,v)=>{values.set(id,v);}});
  const native=join(dir,'native');mkdirSync(native);writeFileSync(join(native,'client_secret.json'),JSON.stringify({installed:{client_id:'fake',client_secret:'fake',auth_uri:'https://accounts.google.com/o/oauth2/auth',token_uri:'https://oauth2.googleapis.com/token'}}));
  const calls:PlatformCliExecution[]=[],spawned:PlatformCliExecution[]=[],inputs:string[]=[],deletes:string[]=[];let authenticatedEmail=email,resolve!: (code:number)=>void,output!:(v:string)=>void;
  const host=new PlatformCliHost({store,env:{PATH:'/fixture',HOME:'/native-user',GH_TOKEN:'native-token',SUPABASE_ACCESS_TOKEN:'app-token',GOOGLE_WORKSPACE_CLI_CONFIG_DIR:native},executable:p=>'/fixture/'+p,resolveProject:async id=>({id,cwd:dir,label:id}),json:async(url,credential)=>{
    if(url.includes('github')){expect(credential).toBe(token);return [{email:authenticatedEmail,verified:true}];}
    if(url.includes('vercel')){expect(credential).toBe(vercelToken);return {user:{email:authenticatedEmail}};}
    expect(credential).toBe(supabaseToken);return {primary_email:authenticatedEmail};
  },run:async e=>{calls.push(e);return {code:0,stderr:'',stdout:e.args[0]==='auth'?(e.account.provider==='github'?token:google):e.account.provider==='github'?'{"login":"actual-login","id":123}':e.account.provider==='vercel'?'actual-vercel-user':e.account.provider==='supabase'?'[]':JSON.stringify({user:{emailAddress:authenticatedEmail}})};}});
  const spawn:PlatformLoginSpawn=(e,consume)=>{spawned.push(e);output=consume;return {write:v=>inputs.push(v),kill:()=>resolve(1),exited:new Promise(r=>{resolve=r;})};};
  const login=new PlatformCliLoginHost(host,spawn,{get:async()=>nativeSupabaseToken,delete:async profile=>{deletes.push(profile);}});
  const complete=async(id:string,code=0)=>{resolve(code);for(let i=0;i<100;i++){const v=login.status(id);if(!['waiting','checking'].includes(v.state))return v;await Bun.sleep(5);}throw Error('login did not finish');};
  return {dir,store,host,login,calls,spawned,inputs,deletes,values,output:(s:string)=>output(s),complete,setEmail:(s:string)=>{authenticatedEmail=s;},native};
}
for(const provider of ['github','vercel','supabase','google-workspace'] as const)test(provider+' browser approval verifies email, isolates login configuration and stores no raw OAuth transcript',async()=>{
  const f=fixture(),id=rid();await f.store.setDefault(provider,email,null,rid());
  await f.login.start(provider,email,id);const e=f.spawned[0]!;expect(e.env.HOME).not.toBe('/native-user');expect(e.env.GH_TOKEN).toBeUndefined();expect(e.env.SUPABASE_ACCESS_TOKEN).toBeUndefined();
  if(provider==='github'){expect(e.args).toContain('--insecure-storage');f.output('secret oauth raw output '+token+'\nFirst copy your one-time code: ABCD-1234\nPress Enter');expect(f.login.status(id)).toMatchObject({url:'https://github.com/login/device',code:'ABCD-1234'});}
  if(provider==='vercel'){writeFileSync(join(e.cwd,'config','auth.json'),JSON.stringify({token:vercelToken,refreshToken:'fake-refresh',expiresAt:1234}),{mode:0o600});f.output('https://evil.invalid/oauth/device https://vercel.com/oauth/device?user_code=ABCD-1234\n'+token);expect(f.login.status(id).url).toBe('https://vercel.com/oauth/device?user_code=ABCD-1234');}
  if(provider==='supabase'){const file=e.args[e.args.indexOf('--profile')+1]!;expect(JSON.parse(readFileSync(file,'utf8'))).toMatchObject({name:'agentstoz-'+id,api_url:'https://api.supabase.com'});f.output('https://supabase.com/dashboard/cli/login?session_id=fake&public_key=public\nEnter your verification code: ');expect(f.login.status(id).needsCode).toBe(true);f.login.code(id,'123456');await expect(Promise.resolve().then(()=>f.login.code(id,'123456'))).rejects.toThrow('코드');expect(f.inputs.at(-1)).toBe('123456\r');}
  if(provider==='google-workspace'){expect(e.args).toContain('https://www.googleapis.com/auth/drive.readonly');expect(readFileSync(join(e.cwd,'config','client_secret.json'),'utf8')).toContain('fake');}
  expect((await f.login.start(provider,email,id)).id).toBe(id);expect(f.spawned).toHaveLength(1);
  const view=await f.complete(id);expect(view.state).toBe('completed');expect(view.account?.verifiedEmail).toBe(email);expect(f.store.defaultAccountId(provider)).toBe(view.account!.id);expect(existsSync(e.cwd)).toBe(false);
  const disk=readdirSync(f.store.root).filter(n=>n.endsWith('.json')).map(n=>readFileSync(join(f.store.root,n),'utf8')).join('');for(const secret of [token,vercelToken,supabaseToken,'fake-refresh','ABCD-1234','public_key','session_id'])expect(disk).not.toContain(secret);
  if(provider==='supabase')expect(f.deletes).toEqual(['agentstoz-'+id]);
});
for(const encoding of ['base64','hex'] as const)test('Supabase browser approval imports the go-keyring '+encoding+' credential and removes only its private profile',async()=>{
  const prefix=encoding==='base64'?'go-keyring-base64:':'go-keyring-encoded:';
  const f=fixture(prefix+Buffer.from(supabaseToken).toString(encoding)),id=rid();
  await f.store.setDefault('supabase',email,null,rid());await f.login.start('supabase',email,id);
  const view=await f.complete(id);expect(view.state).toBe('completed');expect(view.account?.verifiedEmail).toBe(email);
  expect(f.store.defaultAccountId('supabase')).toBe(view.account!.id);expect(f.deletes).toEqual(['agentstoz-'+id]);
});
test('malformed Supabase keyring encoding fails closed without reading a fallback account',async()=>{
  const f=fixture('go-keyring-base64:!invalid!'),id=rid();await f.login.start('supabase',email,id);
  const fallback=join(f.spawned[0]!.cwd,'home','.supabase');mkdirSync(fallback);writeFileSync(join(fallback,'access-token'),supabaseToken,{mode:0o600});
  expect((await f.complete(id)).state).toBe('failed');expect(f.store.list()).toHaveLength(0);expect(f.deletes).toEqual(['agentstoz-'+id]);
});
test('wrong email and a failed CLI login cannot select another account or fulfill a pending default',async()=>{
  const f=fixture(),id=rid();await f.store.setDefault('github',email,null,rid());f.setEmail('other@example.test');await f.login.start('github',email,id);const view=await f.complete(id);expect(view.state).toBe('failed');expect(f.store.list()).toHaveLength(0);expect(f.store.deviceDefaults().github?.accountId).toBeNull();
});
test('GitHub 2.103 parenthesized device-code prompt reaches the same official sign-in link',async()=>{
 const f=fixture(),id=rid();await f.login.start('github',undefined,id,'project-cli',true);
 f.output('! One-time code (ABCD-1234) copied to clipboard\r\nOpen this URL to continue in your web browser: https://github.com/login/device\r\n');
 expect(f.login.status(id)).toMatchObject({url:'https://github.com/login/device',code:'ABCD-1234',state:'waiting'});expect(f.store.list()).toEqual([]);await f.login.cancel(id);
});
test('Supabase CLI login keeps every ECDH parameter and waits for the complete public key',async()=>{
 const f=fixture(),id=rid();await f.login.start('supabase',undefined,id,'app-sync-account',true);
 const args=f.spawned[0]!.args,name=args[args.indexOf('--name')+1]!;
 // The official CLI concatenates token_name without URL encoding.
 expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
 const url='https://supabase.com/dashboard/cli/login?session_id='+id+'&token_name='+name+'&public_key=04'+'a'.repeat(128);
 f.output(url.slice(0,-64));expect(f.login.status(id).url).toBeUndefined();
 f.output(url.slice(-64)+'\r\nEnter your verification code: ');
 const parsed=new URL(f.login.status(id).url!);
 expect(parsed.searchParams.get('session_id')).toBe(id);expect(parsed.searchParams.get('token_name')).toBe(name);expect(parsed.searchParams.get('public_key')).toBe('04'+'a'.repeat(128));
 expect(f.login.status(id).needsCode).toBe(true);await f.login.cancel(id);
});
for(const provider of ['github','vercel','supabase'] as const)test(provider+' newcomer login discovers its verified email without typing it in the app',async()=>{
  const f=fixture(),id=rid();f.setEmail('newcomer@example.test');
  const view=await f.login.start(provider,undefined,id,provider==='supabase'?'app-sync-account':'project-cli',true);expect(view.email).toBe('');
  if(provider==='vercel')writeFileSync(join(f.spawned[0]!.cwd,'config','auth.json'),JSON.stringify({token:vercelToken}),{mode:0o600});
  const done=await f.complete(id);expect(done.state).toBe('completed');expect(done.email).toBe('newcomer@example.test');expect(done.account?.verifiedEmail).toBe('newcomer@example.test');
  if(provider==='supabase')expect(f.store.deviceDefaults()).toEqual({});else expect(f.store.deviceDefaults()[provider]?.accountId).toBe(done.account!.id);
  await f.login.start(provider,undefined,id,provider==='supabase'?'app-sync-account':'project-cli',true);expect(f.spawned).toHaveLength(1);
  expect(()=>validatePlatformCliRequest({operation:'login-onboarding-start',provider,requestId:id},true)).toThrow('앱');
});
test('newcomer authentication preserves an existing device default for a different account',async()=>{
 const f=fixture(),id=rid();await f.store.setDefault('github','keep@example.test',null,rid());await f.login.start('github',undefined,id,'project-cli',true);expect((await f.complete(id)).state).toBe('completed');expect(f.store.deviceDefaults().github).toEqual({email:'keep@example.test',accountId:null});
});
test('cancel clears private scratch and retains a durable no-replay reservation across a host restart',async()=>{
  const f=fixture(),id=rid();await f.login.start('github',email,id);const dir=f.spawned[0]!.cwd;
  expect(await f.login.cancel(id)).toMatchObject({state:'cancelled'});expect(existsSync(dir)).toBe(false);expect(f.store.list()).toHaveLength(0);
  const restored=new PlatformCliLoginHost(f.host,()=>{throw Error('must not spawn');});await expect(restored.start('github',email,id)).rejects.toThrow('이미 시작');
});
test('email proof uses verified GitHub addresses and rejects missing identity and service redirects',async()=>{
  await expect(platformCliVerifiedEmail('github',token,email,async()=>[{email,verified:false}])).rejects.toThrow('일치');
  await expect(platformCliVerifiedEmail('supabase',supabaseToken,email,async()=>[])).rejects.toThrow('일치');
});
test('browser login, codes and device defaults cannot be invoked through an agent MCP request',()=>{
  for(const operation of ['set-default','login-start','login-status','login-code','login-cancel'])expect(()=>validatePlatformCliRequest({operation},true)).toThrow('앱');
});
test.skipIf(process.platform==='win32')('real private PTY captures synthetic output and accepts one confirmation without a transcript',async()=>{
  let output='';const child=spawnPlatformLogin({executable:process.execPath,args:['-e',"process.stdout.write('PRIVATE_SYNTHETIC_READY\\n'); process.stdin.once('data',()=>process.exit(0));"],env:{...process.env},cwd:tmpdir(),account:{id:'synthetic',provider:'supabase',label:'test',identity:null,state:'unchecked',revision:''}},s=>{output+=s;});
  try{for(let i=0;i<100&&!output.includes('PRIVATE_SYNTHETIC_READY');i++)await Bun.sleep(10);expect(output).toContain('PRIVATE_SYNTHETIC_READY');child.write('123456\r');expect(await child.exited).toBe(0);}finally{child.kill();}
});

test('cancelling an unadmitted request fences a delayed start and enables an explicit new attempt',async()=>{
  const f=fixture(),id=rid();expect(await f.login.cancel(id)).toEqual({cancelled:true});
  await expect(f.login.start('github',email,id)).rejects.toThrow('이미 시작');expect(f.spawned).toHaveLength(0);
  const next=rid();await f.login.start('github',email,next);expect(f.spawned).toHaveLength(1);await f.login.cancel(next);
});
test('terminal approval results stay readable after a host restart without opening another login',async()=>{
  const f=fixture(),id=rid();await f.login.start('github',email,id);await f.complete(id);
  const restored=new PlatformCliLoginHost(f.host,()=>{throw Error('must not spawn');});expect(restored.status(id)).toMatchObject({state:'completed',account:{verifiedEmail:email}});
});

const desktopClient=(name='first')=>JSON.stringify({installed:{client_id:name,client_secret:'synthetic-desktop-secret',project_id:'synthetic-project',auth_uri:'https://accounts.google.com/o/oauth2/auth',token_uri:'https://oauth2.googleapis.com/token'},ignored:'not persisted'});
test('Google Console attachment survives restart in the vault and never registers an account or completes a default',async()=>{
  const f=fixture();rmSync(join(f.native,'client_secret.json'));await f.store.setDefault('google-workspace',email,null,rid());
  expect(await f.store.googleClient.status(f.host.deps.env)).toEqual({ready:false,source:'missing'});
  const status=await f.store.googleClient.save(desktopClient());expect(status).toEqual({ready:true,source:'app',projectId:'synthetic-project'});
  const restored=new PlatformCliStore(f.dir,{get:async id=>f.values.get(id)??null,set:async(id,value)=>{f.values.set(id,value);}});
  expect(await restored.googleClient.status(f.host.deps.env)).toEqual(status);expect(restored.list()).toHaveLength(0);
  expect(restored.deviceDefaults()['google-workspace']?.accountId).toBeNull();expect(f.spawned).toHaveLength(0);
  const disk=readdirSync(f.store.root).filter(n=>n.endsWith('.json')).map(n=>readFileSync(join(f.store.root,n),'utf8')).join('');
  expect(disk).not.toContain('synthetic-desktop-secret');expect(JSON.stringify(status)).not.toContain('client_secret');
});
test('Google client rejects wrong file types, malicious endpoints and oversized JSON without replacing a working client',async()=>{
  const f=fixture();await f.store.googleClient.save(desktopClient());
  for(const value of ['{not json',google,JSON.stringify({type:'service_account',private_key:'fake'}),JSON.stringify({web:JSON.parse(desktopClient()).installed}),desktopClient().replace('https://oauth2.googleapis.com/token','https://evil.invalid/token'),' '.repeat(16_385)]){
    await expect(f.store.googleClient.save(value)).rejects.toThrow('데스크톱');
  }
  expect(JSON.parse((await f.store.googleClient.read(f.host.deps.env))!.client).installed.client_id).toBe('first');
  expect(JSON.parse(parseGoogleDesktopClient(desktopClient())).ignored).toBeUndefined();
});
test('Google client vault failures do not fall back to an unrelated native client',async()=>{
  const f=fixture();const broken=new PlatformCliStore(f.dir,{get:async()=>{throw Error('private synthetic failure');},set:async()=>{throw Error('private synthetic failure');}});
  await expect(broken.googleClient.status(f.host.deps.env)).rejects.toThrow('다시 첨부');
  await expect(broken.googleClient.save(desktopClient())).rejects.toThrow('저장하지 못했습니다');
});
test('uploaded Google client pins each pending approval and leaves native CLI configuration unchanged',async()=>{
  const f=fixture(),original=readFileSync(join(f.native,'client_secret.json'),'utf8'),id=rid();
  await f.store.googleClient.save(desktopClient('first'));await f.login.start('google-workspace',email,id);
  const scratch=join(f.spawned[0]!.cwd,'config','client_secret.json');
  await f.store.googleClient.save(desktopClient('second'));
  expect(JSON.parse(readFileSync(scratch,'utf8')).installed.client_id).toBe('first');
  expect(readFileSync(join(f.native,'client_secret.json'),'utf8')).toBe(original);
  await f.login.cancel(id);const next=rid();await f.login.start('google-workspace',email,next);
  expect(JSON.parse(readFileSync(join(f.spawned[1]!.cwd,'config','client_secret.json'),'utf8')).installed.client_id).toBe('second');await f.login.cancel(next);
});
test('multiple Google approvals use one client and keep the first default and each project account independent',async()=>{
  const f=fixture();await f.store.googleClient.save(desktopClient());await f.store.setDefault('google-workspace',email,null,rid());
  const first=rid();await f.login.start('google-workspace',email,first);const a=(await f.complete(first)).account!;
  const secondEmail='intenet1002@gmail.com';f.setEmail(secondEmail);const second=rid();await f.login.start('google-workspace',secondEmail,second);const b=(await f.complete(second)).account!;
  expect(f.store.list('google-workspace')).toHaveLength(2);expect(f.store.deviceDefaults()['google-workspace']).toEqual({email,accountId:a.id});
  await f.host.bind('first-project','google-workspace',{accountId:a.id,scope:'',resourceId:''},rid());
  await f.host.bind('second-project','google-workspace',{accountId:b.id,scope:'',resourceId:''},rid());
  expect(f.store.binding('first-project','google-workspace')?.accountId).toBe(a.id);expect(f.store.binding('second-project','google-workspace')?.accountId).toBe(b.id);
});
test('Google client attachment and lookup are local-app operations and cannot accept agent-supplied paths',()=>{
  for(const operation of ['google-client-save','google-client-status'])expect(()=>validatePlatformCliRequest({operation},true)).toThrow('앱');
  expect(()=>validatePlatformCliRequest({operation:'google-client-save',clientJson:desktopClient(),path:'/tmp/untrusted'})).toThrow('형식');
});
test('app data browser login verifies its account without selecting a pending project CLI default and cannot change purpose on retry',async()=>{
 const f=fixture(),id=rid();await f.store.setDefault('supabase',email,null,rid());
 await f.login.start('supabase',email,id,'app-sync-account');
 await expect(f.login.start('supabase',email,id,'project-cli')).rejects.toThrow('같은 로그인');
 const view=await f.complete(id);expect(view).toMatchObject({state:'completed',purpose:'app-sync-account',account:{verifiedEmail:email}});
 expect(f.store.deviceDefaults().supabase?.accountId).toBeNull();expect(f.store.binding('project','supabase')).toBeNull();
 const restored=new PlatformCliLoginHost(f.host,()=>{throw Error('must not spawn');});expect(restored.status(id)).toMatchObject({state:'completed',purpose:'app-sync-account'});
});
