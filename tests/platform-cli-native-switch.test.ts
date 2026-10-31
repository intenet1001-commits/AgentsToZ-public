import {afterEach,expect,test} from 'bun:test';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PlatformCliStore,type PlatformCliSecrets} from '../src/platformCliStore';
import {PlatformCliHost,type PlatformCliExecution,type PlatformCliProcess} from '../src/platformCliHost';
import {PlatformNativeSwitch} from '../src/platformCliNativeSwitch';
import {handlePlatformCliRequest,registerPlatformNativeSwitch} from '../src/platformCliRequest';
import {platformCliNativeGithubId} from '../src/platformCliProtocol';

const dirs:string[]=[];afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const rid=()=>crypto.randomUUID();
const result=(stdout='',code=0):PlatformCliProcess=>({code,stdout,stderr:code?'private':''});
const tokens={personal:'gho_'+'p'.repeat(36),company:'gho_'+'c'.repeat(36),worker:'gho_'+'w'.repeat(36)} as Record<string,string>;
const supabaseNative='sbp_'+'n'.repeat(40),supabaseManaged='sbp_'+'m'.repeat(40);
const vercelOld='vercel_old_'+'o'.repeat(24),vercelNew='vercel_new_'+'v'.repeat(24);
const emails:Record<string,string>={[supabaseNative]:'native@example.test',[supabaseManaged]:'managed@example.test',[vercelOld]:'old@example.test',[vercelNew]:'new@example.test'};
const vercelLogins:Record<string,string>={[vercelOld]:'old-user',[vercelNew]:'new-user'};

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'atz-native-switch-'));dirs.push(dir);
  const app=join(dir,'app'),home=join(dir,'home'),xdg=join(dir,'xdg');mkdirSync(home,{recursive:true});mkdirSync(app,{mode:0o700});
  const secrets=new Map<string,string>();
  const vault:PlatformCliSecrets={get:async id=>secrets.get(id)??null,set:async(id,value)=>{secrets.set(id,value);}};
  const store=new PlatformCliStore(app,vault),calls:PlatformCliExecution[]=[];
  let logins=[{login:'personal',active:true},{login:'company',active:false}];
  let gitConfig='credential.helper\nosxkeychain\0';
  const login=(token:string|undefined)=>Object.entries(tokens).find(([,t])=>t===token)?.[0];
  const run=async(e:PlatformCliExecution):Promise<PlatformCliProcess>=>{
    calls.push({...e,args:[...e.args],env:{...e.env}});const a=e.args;
    // git config --null --show-origin: `origin\0key\nvalue\0` per entry.
    if(e.executable==='/fixture/git')return a[0]==='config'?(gitConfig?result(a.includes('--show-origin')?gitConfig.split('\0').filter(Boolean).map(v=>'file:/home/.gitconfig\0'+v+'\0').join(''):gitConfig):result('',1)):result('',1);
    if(e.executable==='/fixture/gh'){
      if(a[0]==='auth'&&a[1]==='status')return result(JSON.stringify({hosts:{'github.com':logins.map(l=>({state:'success',login:l.login,active:l.active}))}}));
      if(a[0]==='auth'&&a[1]==='switch'){const user=a[a.indexOf('--user')+1];logins=logins.map(l=>({...l,active:l.login===user}));return result();}
      if(a[0]==='auth'&&a[1]==='token')return result(tokens[a[a.indexOf('--user')+1]!]+'\n');
      if(a[0]==='auth'&&a[1]==='login'){const who=login(e.input?.trim());if(!who)return result('',1);logins=[...logins.map(l=>({...l,active:false})),{login:who,active:true}];return result();}
      if(a[0]==='auth'&&a[1]==='setup-git'){gitConfig='credential.https://github.com.helper\n\0credential.https://github.com.helper\n!/fixture/gh auth git-credential\0';return result();}
      if(a[0]==='api'&&a[1]==='user'){const who=login(e.env.GH_TOKEN);return who?result(JSON.stringify({login:who,id:7})):result('',1);}
    }
    if(e.executable==='/fixture/supabase'&&a.includes('projects'))return result('[]');
    if(e.executable==='/fixture/vercel'&&a.includes('whoami')){
      const config=a[a.indexOf('--global-config')+1]!,token=JSON.parse(readFileSync(join(config,'auth.json'),'utf8')).token;
      return vercelLogins[token]?result(vercelLogins[token]+'\n'):result('',1);
    }
    throw Error('Unexpected '+e.executable+' '+a.join(' '));
  };
  const json=async(url:string,token:string)=>{
    if(url.endsWith('/v1/profile'))return {primary_email:emails[token]};
    if(url.endsWith('/v2/user'))return {user:{email:emails[token]}};
    throw Error('Unexpected '+url);
  };
  const keychain=new Map<string,string>(),securityCalls:{args:string[];input?:string}[]=[];
  const security=async(args:string[],input?:string)=>{
    securityCalls.push({args,...(input===undefined?{}:{input})});
    if(args[0]==='find-generic-password'){const v=keychain.get(args[args.indexOf('-s')+1]+'|'+args[args.indexOf('-a')+1]);return v?{code:0,stdout:v+'\n',stderr:''}:{code:44,stdout:'',stderr:'The specified item could not be found in the keychain.'};}
    const m=/add-generic-password -U -s '([^']*)' -a '([^']*)' -w '([^']*)'/.exec(input??'');if(m)keychain.set(m[1]+'|'+m[2],m[3]!);
    return {code:0,stdout:'',stderr:''};
  };
  const env={HOME:home,XDG_DATA_HOME:xdg,PATH:'/usr/bin:/bin'};
  const host=new PlatformCliHost({store,env,run,json,executable:p=>'/fixture/'+({github:'gh',vercel:'vercel',supabase:'supabase','google-workspace':'gws'})[p],resolveProject:async id=>({id,cwd:dir,label:'Project'})});
  const native=registerPlatformNativeSwitch(host,new PlatformNativeSwitch(host,{home,env,git:'/fixture/git',security,json}));
  async function managed(provider:'github'|'supabase'|'vercel',label:string,credential:string,email:string) {
    const created=await store.create(provider,label,credential,rid());
    return store.verified(await host.check(created.id,rid()),email,rid());
  }
  return {dir,app,home,xdg,store,host,native,calls,keychain,securityCalls,managed,logins:()=>logins};
}

test('GitHub switches gh\'s own active login, adds a connected account once, and git follows only on request',async()=>{
  const f=fixture();
  let state=await f.native.providerStatus('github');
  expect(state).toMatchObject({state:'ready',identity:'personal',currentId:platformCliNativeGithubId('personal'),gitFollows:false});
  expect(state.options.map(o=>o.id)).toEqual([platformCliNativeGithubId('personal'),platformCliNativeGithubId('company')]);
  const id=rid();
  state=await f.native.switch('github',platformCliNativeGithubId('company'),id);
  expect(state.identity).toBe('company');
  // The same request is that request: never performed twice, and never reused for another switch.
  const switches=()=>f.calls.filter(c=>c.args[0]==='auth'&&c.args[1]==='switch').length;
  expect(switches()).toBe(1);await f.native.switch('github',platformCliNativeGithubId('company'),id);expect(switches()).toBe(1);
  await expect(f.native.switch('github',platformCliNativeGithubId('personal'),id)).rejects.toThrow('같은 요청 ID');
  // A connected account gh does not know yet is added through stdin, never argv, and becomes the device default.
  const worker=await f.managed('github','worker',tokens.worker!,'worker@example.test');
  state=await f.native.switch('github',worker.id,rid());
  expect(state.identity).toBe('worker');
  const added=f.calls.find(c=>c.args[1]==='login')!;
  expect(added.args).toEqual(['auth','login','--hostname','github.com','--with-token']);expect(added.input).toBe(tokens.worker+'\n');
  expect(f.calls.every(c=>!c.args.some(arg=>arg.includes(tokens.worker!)))).toBe(true);
  expect(f.store.deviceDefaults().github).toEqual({email:'worker@example.test',accountId:worker.id});
  // Back to a login that is not a connected account: the device default follows it away.
  await f.native.switch('github',platformCliNativeGithubId('personal'),rid());
  expect(f.store.deviceDefaults().github).toBeUndefined();
  // git push keeps the Keychain helper until the person asks for gh.
  expect((await f.native.setupGit(rid())).gitFollows).toBe(true);
});

test('Supabase switches through a CLI profile and its own Keychain entry, and the old profile stays selectable',async()=>{
  const f=fixture();
  f.keychain.set('Supabase CLI|supabase','go-keyring-base64:'+Buffer.from(supabaseNative).toString('base64'));
  let state=await f.native.providerStatus('supabase');
  expect(state).toMatchObject({state:'ready',identity:'native@example.test'});
  const nativeId=state.currentId!;expect(nativeId).toMatch(/^native:[0-9a-f]{16}$/);
  const account=await f.managed('supabase','work',supabaseManaged,'managed@example.test');
  state=await f.native.switch('supabase',account.id,rid());
  expect(state).toMatchObject({currentId:account.id,identity:'managed@example.test'});
  const selector=readFileSync(join(f.home,'.supabase','profile'),'utf8');
  const descriptor=JSON.parse(readFileSync(selector,'utf8'));
  expect(descriptor.name).toBe('agentstoz-'+account.id.slice(5));expect(descriptor.api_url).toBe('https://api.supabase.com');
  expect(f.keychain.get('Supabase CLI|'+descriptor.name)).toBe('go-keyring-base64:'+Buffer.from(supabaseManaged).toString('base64'));
  // The token reaches `security` only through stdin.
  expect(f.securityCalls.every(c=>!c.args.some(arg=>arg.includes(supabaseManaged)||arg.includes(Buffer.from(supabaseManaged).toString('base64'))))).toBe(true);
  expect(f.store.deviceDefaults().supabase?.accountId).toBe(account.id);
  expect(state.options.some(o=>o.id===nativeId&&o.label.includes('기존 프로필'))).toBe(true);
  state=await f.native.switch('supabase',nativeId,rid());
  expect(readFileSync(join(f.home,'.supabase','profile'),'utf8')).toBe('supabase');
  expect(state).toMatchObject({currentId:nativeId,identity:'native@example.test'});
  expect(f.store.deviceDefaults().supabase).toBeUndefined();
  // A profile with no login is refused and changes nothing.
  f.keychain.delete('Supabase CLI|supabase');
  await expect(f.native.switch('supabase',nativeId,rid())).rejects.toThrow('로그인이 없습니다');
});

test('Vercel connects the login it replaces, restores each account\'s own team, and runs against the live session',async()=>{
  const f=fixture();
  const directory=join(f.xdg,'com.vercel.cli');mkdirSync(directory,{recursive:true,mode:0o700});
  writeFileSync(join(directory,'auth.json'),JSON.stringify({'// Note':'x',token:vercelOld},null,2),{mode:0o600});
  writeFileSync(join(directory,'config.json'),JSON.stringify({currentTeam:'team_old',collectMetrics:false}),{mode:0o600});
  let state=await f.native.providerStatus('vercel');
  expect(state).toMatchObject({state:'ready',identity:'old@example.test',currentId:null});
  const target=await f.managed('vercel','new',vercelNew,'new@example.test');
  state=await f.native.switch('vercel',target.id,rid());
  expect(state).toMatchObject({currentId:target.id,identity:'new@example.test'});
  expect(JSON.parse(readFileSync(join(directory,'auth.json'),'utf8')).token).toBe(vercelNew);
  const config=JSON.parse(readFileSync(join(directory,'config.json'),'utf8'));
  expect(config.currentTeam).toBeUndefined();expect(config.collectMetrics).toBe(false);
  // The login that was there is now a connected account, not lost.
  const kept=f.store.list('vercel').find(a=>a.verifiedEmail==='old@example.test')!;expect(kept.state).toBe('ready');
  expect(await f.native.vercelLive(f.store.account(target.id))).toBe(directory);
  expect(await f.native.vercelLive(kept)).toBeNull();
  state=await f.native.switch('vercel',kept.id,rid());
  expect(JSON.parse(readFileSync(join(directory,'auth.json'),'utf8')).token).toBe(vercelOld);
  expect(JSON.parse(readFileSync(join(directory,'config.json'),'utf8')).currentTeam).toBe('team_old');
  expect(f.store.deviceDefaults().vercel?.accountId).toBe(kept.id);
  expect(existsSync(join(f.app,'platform-cli-v1','native-backups'))).toBe(false);
});

test('status covers every CLI; gws is chosen per project, and the app request routes reach the same switch',async()=>{
  const f=fixture();
  const native=(await handlePlatformCliRequest(f.host,undefined as never,{operation:'native-status'})).native as {provider:string;state:string}[];
  expect(native.map(s=>s.provider)).toEqual(['github','vercel','supabase','google-workspace']);
  expect(native.find(s=>s.provider==='google-workspace')!.state).toBe('unsupported');
  const switched=await handlePlatformCliRequest(f.host,undefined as never,{operation:'native-switch',provider:'github',accountId:platformCliNativeGithubId('company'),requestId:rid(),targetId:'project-1'},true);
  expect((switched.native as {identity:string}).identity).toBe('company');
  await expect(f.native.switch('google-workspace','pcli_x',rid())).rejects.toThrow('프로젝트별');
});
