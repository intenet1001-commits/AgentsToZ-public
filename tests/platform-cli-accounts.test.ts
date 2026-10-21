import {afterEach,expect,test} from 'bun:test';
import {writeFileSync,existsSync,lstatSync,mkdtempSync,readFileSync,rmSync,symlinkSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PlatformCliStore,type PlatformCliSecrets} from '../src/platformCliStore';
import {PlatformCliHost,platformCliEnvironment,runPlatformCliProcess,type PlatformCliExecution,type PlatformCliProcess} from '../src/platformCliHost';
import {PlatformGithubPush,platformGithubRepository} from '../src/platformGithubPush';
import {handlePlatformCliRequest,validatePlatformCliRequest} from '../src/platformCliRequest';
import {PLATFORM_CLI_DEFAULT_ACCOUNT,platformCliNativeGithubId,type PlatformCliProvider} from '../src/platformCliProtocol';
import {parseAgentsToZUseActionRequest} from '../src/agentstozUseControl';
import {AGENTSTOZ_USE_MCP_TOOLS,agentsToZUseMcpActionForTool} from '../agentstoz-use-mcp-server';
import {parsePlatformCliCommand,platformCliLocalProject} from '../src/platformCliCommand';

const dirs:string[]=[];afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const rid=()=>crypto.randomUUID();
const tokenA='ghp_'+'a'.repeat(40),tokenB='ghp_'+'b'.repeat(40),head='a'.repeat(40);
const google=JSON.stringify({type:'authorized_user',client_id:'client-id',client_secret:'private-client',refresh_token:'private-refresh'});
const result=(stdout='',code=0):PlatformCliProcess=>({code,stdout,stderr:code?'provider output is private':''});
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'atz-platform-cli-'));dirs.push(dir);
  const secrets=new Map<string,string>();let secretReads=0;
  const vault:PlatformCliSecrets={get:async id=>{secretReads++;return secrets.get(id)??null;},set:async(id,value)=>{secrets.set(id,value);}};
  const store=new PlatformCliStore(dir,vault),calls:PlatformCliExecution[]=[];
  let branch='feature/accounts',commit=head,permission=true,repositoryId='REPO_original',failPush=false,throwPush=false,unsafeConfig=false;
  let repositories:Record<string,string>={origin:'personal/repo',company:'company/repo'};
  let activeLogin='personal';const nativeTokens:Record<string,string>={personal:tokenA,company:tokenB};
  const execute=async(e:PlatformCliExecution):Promise<PlatformCliProcess>=>{
    calls.push({...e,args:[...e.args],env:{...e.env}});
    const a=e.args;
    if(e.executable==='/fixture/git'){
      if(a[0]==='remote'&&a.length===1)return result(Object.keys(repositories).join('\n'));
      if(a[0]==='remote'&&a[1]==='get-url')return repositories[a.at(-1)!]?result('git@github.com:'+repositories[a.at(-1)!]+'.git\n'):result('',1);
      if(a[0]==='symbolic-ref')return result(branch+'\n');
      if(a[0]==='rev-parse')return result(commit+'\n');
      if(a[0]==='check-ref-format')return result();
      if(a[0]==='config')return unsafeConfig?result('url.bad.insteadof\n'):result('',1);
      if(a.includes('push')){if(throwPush)throw Error('lost response');return result('',failPush?1:0);}
      throw Error('Unexpected Git command '+a.join(' '));
    }
    if(e.account.provider==='github'){
      if(a[0]==='auth'&&a[1]==='status')return result(JSON.stringify({hosts:{'github.com':Object.keys(nativeTokens).map(login=>({state:'success',active:login===activeLogin,login,token:'MASKED'}))}}));
      if(a[0]==='auth'&&a[1]==='token')return nativeTokens[a.at(-1)!]?result(nativeTokens[a.at(-1)!]!):result('',1);
      if(a.join(' ')==='api user')return result(JSON.stringify({login:e.env.GH_TOKEN===tokenA?'personal':'company',id:e.env.GH_TOKEN===tokenA?1:2}));
      return result(JSON.stringify({node_id:repositoryId,full_name:a[1]!.slice('repos/'.length),permissions:{push:permission}}));
    }
    if(e.account.provider==='vercel')return result('vercel-owner\n');
    if(e.account.provider==='supabase')return result('[]');
    return result('{"user":{"emailAddress":"work@example.test"}}');
  };
  const host=new PlatformCliHost({store,json:async url=>({id:decodeURIComponent(new URL(url).pathname.split('/').at(-1)!)}),env:{PATH:'/fixture',GH_TOKEN:'HOST_GH',GITHUB_TOKEN:'HOST_GITHUB',VERCEL_TOKEN:'HOST_VERCEL',SUPABASE_ACCESS_TOKEN:'HOST_SUPABASE',GOOGLE_APPLICATION_CREDENTIALS:'/host/secret.json',GOOGLE_WORKSPACE_CLI_TOKEN:'HOST_GOOGLE',PORTMGR_AGENT_RUNTIME_CAPABILITY:'HOST_CAPABILITY'},
    executable:provider=>'/fixture/'+({github:'gh',vercel:'vercel',supabase:'supabase','google-workspace':'gws'})[provider],
    resolveProject:async(id,folder)=>{if(!['project-one','project-two'].includes(id)||folder&&folder!==dir)throw Error('unregistered project');return {id,cwd:dir,label:id};},run:execute});
  const push=new PlatformGithubPush(host,'/fixture/git',execute);
  async function account(provider:PlatformCliProvider='github',label='Personal',credential=tokenA){const a=await store.create(provider,label,credential,rid());return host.check(a.id);}
  return {dir,store,vault,secrets,host,push,calls,account,nativeTokens,setActive:(login:string)=>{activeLogin=login;},useNativeDefault:()=>{delete host.deps.env!.GH_TOKEN;delete host.deps.env!.GITHUB_TOKEN;},reads:()=>secretReads,change:(v:{branch?:string;commit?:string;permission?:boolean;repositoryId?:string;failPush?:boolean;throwPush?:boolean;unsafeConfig?:boolean;repositories?:Record<string,string>})=>{branch=v.branch??branch;commit=v.commit??commit;permission=v.permission??permission;repositoryId=v.repositoryId??repositoryId;failPush=v.failPush??failPush;throwPush=v.throwPush??throwPush;unsafeConfig=v.unsafeConfig??unsafeConfig;repositories=v.repositories??repositories;}};
}
test('listing is read-only and never loads host credentials or the OS vault',()=>{
  const f=fixture();expect(f.store.list()).toEqual([]);expect(f.store.binding('project-one','github')).toBeNull();expect(f.reads()).toBe(0);expect(existsSync(f.store.root)).toBe(false);
});
test('account registration retries are durable, private and contain no credential',async()=>{
  const f=fixture(),id=rid();const [a,b]=await Promise.all([f.store.create('github','Work',tokenA,id),f.store.create('github','Work',tokenA,id)]);
  expect(a.id).toBe(b.id);expect(f.store.list()).toHaveLength(1);expect(JSON.stringify(a)).not.toContain(tokenA);expect(readFileSync(f.store.file,'utf8')).not.toContain(tokenA);
  if(process.platform!=='win32'){expect(lstatSync(f.store.root).mode&0o777).toBe(0o700);expect(lstatSync(f.store.file).mode&0o777).toBe(0o600);}
  await expect(f.store.create('github','Different',tokenB,id)).rejects.toThrow('요청 ID');
});
test('bindings persist per project and provider, and replay cannot reverse a later choice',async()=>{
  const f=fixture(),a=await f.account(),b=await f.account('github','Company',tokenB),id=rid();
  await f.store.bind('project-one','github',{accountId:a.id,scope:'',resourceId:'personal/repo'},id);
  await f.store.bind('project-one','github',{accountId:b.id,scope:'',resourceId:'company/repo'},rid());
  const restored=new PlatformCliStore(f.dir,f.vault);await restored.bind('project-one','github',{accountId:a.id,scope:'',resourceId:'personal/repo'},id);
  expect(restored.binding('project-one','github')?.accountId).toBe(b.id);expect(restored.binding('project-two','github')).toBeNull();expect(restored.binding('project-one','supabase')).toBeNull();
});
test('unverified accounts, wrong providers and foreign project IDs cannot become execution bindings',async()=>{
  const f=fixture(),a=await f.store.create('github','Pending',tokenA,rid());
  await expect(f.store.bind('project-one','github',{accountId:a.id,scope:'',resourceId:''},rid())).rejects.toThrow('연결 상태');
  await f.host.check(a.id);await expect(f.store.bind('project-one','vercel',{accountId:a.id,scope:'',resourceId:''},rid())).rejects.toThrow('같은 CLI');
  await expect(handlePlatformCliRequest(f.host,f.push,{operation:'bind',targetId:'foreign',provider:'github',binding:{accountId:a.id,scope:'',resourceId:''},requestId:rid()})).rejects.toThrow('unregistered');
});
test('missing or changed credentials never fall back to a host token',async()=>{
  const f=fixture(),a=await f.account();f.secrets.delete(a.id);const count=f.calls.length;
  await expect(f.host.check(a.id)).rejects.toThrow('다른 계정');expect(f.calls).toHaveLength(count);
  f.secrets.set(a.id,tokenB);await expect(f.host.check(a.id)).rejects.toThrow('인증 정보');expect(f.calls).toHaveLength(count);
});
test('environment isolation removes every other provider and management capability',()=>{
  const e=platformCliEnvironment({GH_CONFIG_DIR:'/shared',GH_TOKEN:'x',GITHUB_TOKEN:'x',VERCEL_TOKEN:'x',SUPABASE_DB_PASSWORD:'x',GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE:'/shared',GOOGLE_APPLICATION_CREDENTIALS:'/shared',GIT_CONFIG_PARAMETERS:'override',SSH_CONNECTION:'x',AGENTSTOZ_RUNTIME_CAPABILITY:'x',PATH:'/safe'});
  expect(e).toEqual({PATH:'/safe',GIT_TERMINAL_PROMPT:'0',GH_PROMPT_DISABLED:'1'});
});
test('general project Supabase accounts cannot receive or change the app data Supabase connection',async()=>{
  const f=fixture();Object.assign(f.host.deps.env!,{SUPABASE_URL:'APP_DB_URL',SUPABASE_ANON_KEY:'APP_ANON',SUPABASE_SERVICE_ROLE_KEY:'APP_SERVICE',VITE_SUPABASE_URL:'APP_FRONTEND_DB',VITE_SUPABASE_ANON_KEY:'APP_FRONTEND_KEY',NEXT_PUBLIC_SUPABASE_URL:'APP_PUBLIC_DB',DATABASE_URL:'APP_POSTGRES'});
  const account=await f.account('supabase','Project data','sbp_'+'e'.repeat(40));await f.host.bind('project-one','supabase',{accountId:account.id,scope:'',resourceId:'a'.repeat(20)},rid());await f.host.run('project-one','supabase',['functions','list']);
  const call=f.calls.at(-1)!;expect(call.env.SUPABASE_ACCESS_TOKEN).toBe('sbp_'+'e'.repeat(40));expect(JSON.stringify(call.env)).not.toContain('APP_');expect(f.host.deps.env!.SUPABASE_SERVICE_ROLE_KEY).toBe('APP_SERVICE');
  const registry=readFileSync(f.store.file,'utf8');expect(registry).not.toContain('APP_');expect(registry).not.toContain('sbp_');
  await expect(f.store.create('supabase','Wrong service key','eyJ'+'x'.repeat(100),rid())).rejects.toThrow('개인 액세스');
});
test('all four provider adapters use only the selected credential and never put it in argv',async()=>{
  const f=fixture();await f.account();await f.account('vercel','Deploy','vercel_'+'c'.repeat(30));await f.account('supabase','Data','sbp_'+'d'.repeat(40));await f.account('google-workspace','Office',google);
  expect(f.store.list().map(a=>a.state)).toEqual(['ready','ready','ready','ready']);
  const gh=f.calls.find(c=>c.account.provider==='github')!;expect(gh.env.GH_TOKEN).toBe(tokenA);expect(gh.env.SUPABASE_ACCESS_TOKEN).toBeUndefined();
  const sb=f.calls.find(c=>c.account.provider==='supabase')!;expect(sb.env.SUPABASE_ACCESS_TOKEN).toBe('sbp_'+'d'.repeat(40));expect(sb.env.GH_TOKEN).toBeUndefined();
  for(const c of f.calls){expect(JSON.stringify(c.args)).not.toContain(tokenA);expect(JSON.stringify(c.args)).not.toContain('private-refresh');expect(c.env.PORTMGR_AGENT_RUNTIME_CAPABILITY).toBeUndefined();}
  const vc=f.calls.find(c=>c.account.provider==='vercel')!;expect(vc.args[0]).toBe('--global-config');expect(existsSync(vc.args[1]!)).toBe(false);
  const gws=f.calls.find(c=>c.account.provider==='google-workspace')!;expect(existsSync(gws.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE!)).toBe(false);
});
test('managed Supabase checks work with inaccessible native configuration and isolate concurrent runs',async()=>{
  const f=fixture(),run=f.host.deps.run!,homes:string[]=[];
  Object.assign(f.host.deps.env!,{HOME:'/inaccessible-native-user',USERPROFILE:'/inaccessible-native-user',XDG_CONFIG_HOME:'/inaccessible-native-config',XDG_DATA_HOME:'/inaccessible-native-data',SUPABASE_PROFILE:'foreign-endpoint',SUPABASE_HOME:'/foreign-profile'});
  f.host.deps.run=async execution=>{
    if(execution.account.provider==='supabase'){
      const home=execution.env.HOME;
      if(!home||home==='/inaccessible-native-user'||execution.env.XDG_CONFIG_HOME==='/inaccessible-native-config'||execution.env.XDG_DATA_HOME==='/inaccessible-native-data')return result('Native Supabase configuration is inaccessible',1);
      expect(execution.env.USERPROFILE).toBe(home);
      expect(execution.env.SUPABASE_ACCESS_TOKEN).toBe('sbp_'+'d'.repeat(40));
      expect(execution.env.SUPABASE_PROFILE).toBeUndefined();expect(execution.env.SUPABASE_HOME).toBeUndefined();
      expect(existsSync(home)).toBe(true);homes.push(home);
      if(process.platform!=='win32')expect(lstatSync(home).mode&0o777).toBe(0o700);
    }
    return run(execution);
  };
  const account=await f.account('supabase','Data','sbp_'+'d'.repeat(40));
  await Promise.all([f.host.check(account.id),f.host.check(account.id)]);
  expect(f.store.account(account.id).state).toBe('ready');expect(new Set(homes).size).toBe(3);
  expect(homes.every(home=>!existsSync(home))).toBe(true);
  await expect(f.host.using(account,{id:'project-one',cwd:f.dir,label:'One'},[],async execution=>{
    homes.push(execution.env.HOME!);throw Error('interrupted provider request');
  })).rejects.toThrow('interrupted provider request');
  expect(homes.every(home=>!existsSync(home))).toBe(true);
  expect(f.host.deps.env!.HOME).toBe('/inaccessible-native-user');expect(f.host.deps.env!.SUPABASE_PROFILE).toBe('foreign-endpoint');
  await f.host.using(await f.host.account(PLATFORM_CLI_DEFAULT_ACCOUNT,'supabase'),{id:'project-one',cwd:f.dir,label:'Native'},[],async execution=>{
    expect(execution.env.HOME).toBe('/inaccessible-native-user');expect(execution.env.SUPABASE_ACCESS_TOKEN).toBe('HOST_SUPABASE');
  });
});
test('managed Google checks isolate gws token-cache keys from the native OS keyring',async()=>{
  const f=fixture(),run=f.host.deps.run!;
  const configDirectories:string[]=[];
  f.host.deps.env!.GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND='keyring';
  f.host.deps.env!.HOME='/native-user';f.host.deps.env!.USERPROFILE='/native-user';
  f.host.deps.run=async execution=>{
    if(execution.account.provider==='google-workspace'){
      // gws 0.22.5 encrypts the refreshed token cache; a native keyring refusal
      // must not break a managed account whose credential already lives in our vault.
      if(execution.env.GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND!=='file')return result('OS keyring failed',1);
      if(execution.env.HOME==='/native-user'||execution.env.USERPROFILE==='/native-user')return result('Host ADC quota project denied this account',1);
      expect(execution.env.GOOGLE_APPLICATION_CREDENTIALS).toBe('');
      expect(execution.env.GOOGLE_WORKSPACE_PROJECT_ID).toBe('');
      configDirectories.push(execution.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR!);
      expect(JSON.parse(readFileSync(execution.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE!,'utf8')).refresh_token).toBe('private-refresh');
    }
    return run(execution);
  };
  const account=await f.account('google-workspace','Office',google);
  await Promise.all([f.host.check(account.id),f.host.check(account.id)]);
  expect(f.store.account(account.id).state).toBe('ready');
  expect(new Set(configDirectories).size).toBe(3);
  expect(configDirectories.every(directory=>!existsSync(directory))).toBe(true);
  expect(f.host.deps.env!.GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND).toBe('keyring');
  expect(f.host.deps.env!.HOME).toBe('/native-user');
  expect(f.host.deps.env!.USERPROFILE).toBe('/native-user');
  await f.host.bind('project-one','google-workspace',{accountId:account.id,scope:'',resourceId:'chosen-google-project'},rid());
  f.host.deps.run=async execution=>{expect(execution.env.GOOGLE_WORKSPACE_PROJECT_ID).toBe('chosen-google-project');return run(execution);};
  await f.host.run('project-one','google-workspace',['drive','about','get']);
});
test('parallel invocations have separate native config files and clean them on errors',async()=>{
  const f=fixture(),a=await f.account('vercel','Deploy','vercel_'+'e'.repeat(30));let files:string[]=[];
  const run=async()=>f.host.using(a,{id:'project-one',cwd:f.dir,label:'One'},['whoami'],async e=>{const file=join(e.args[1]!,'auth.json');files.push(file);expect(JSON.parse(readFileSync(file,'utf8')).token).toBe('vercel_'+'e'.repeat(30));await Promise.resolve();});
  await Promise.all([run(),run()]);expect(new Set(files).size).toBe(2);expect(files.every(f=>!existsSync(f))).toBe(true);
  await expect(f.host.using(a,{id:'project-one',cwd:f.dir,label:'One'},[],async e=>{files.push(join(e.args[1]!,'auth.json'));throw Error('failure');})).rejects.toThrow('failure');expect(files.every(f=>!existsSync(f))).toBe(true);
});
test('SDK hosts share project bindings but reject command-level account overrides',async()=>{
  const f=fixture(),a=await f.account('vercel','Deploy','vercel_'+'f'.repeat(30));
  await f.store.bind('project-one','vercel',{accountId:a.id,scope:'company',resourceId:'prj_company'},rid());
  await f.host.run('project-one','vercel',['list']);const call=f.calls.at(-1)!;expect(call.args).toContain('company');expect(call.env.VERCEL_PROJECT_ID).toBe('prj_company');
  await expect(f.host.run('project-one','vercel',['deploy','--token','OTHER'])).rejects.toThrow('변경');
  await f.host.run('project-two','vercel',['deploy']);expect(f.calls.at(-1)!.account.source).toBe('default');expect(f.calls.at(-1)!.env.VERCEL_PROJECT_ID).toBeUndefined();expect(f.calls.at(-1)!.env.VERCEL_TOKEN).toBe('HOST_VERCEL');
  await expect(f.host.run('project-one','vercel',['login'])).rejects.toThrow('변경');
});
test('Supabase execution pins an explicit project and excludes database-password operations',async()=>{
  const f=fixture(),a=await f.account('supabase','Data','sbp_'+'e'.repeat(40));await f.store.bind('project-one','supabase',{accountId:a.id,scope:'',resourceId:'a'.repeat(20)},rid());
  await f.host.run('project-one','supabase',['functions','list']);expect(f.calls.at(-1)!.args.slice(-2)).toEqual(['--project-ref','a'.repeat(20)]);
  await expect(f.host.run('project-one','supabase',['db','push'])).rejects.toThrow('DB 연결');
});
test('origin and the current native login remain the default even with multiple accounts and remotes',async()=>{
  const f=fixture(),a=await f.account(),b=await f.account('github','Company',tokenB);
  f.useNativeDefault();const choose=await handlePlatformCliRequest(f.host,f.push,{operation:'prepare-push',targetId:'project-one'},true);expect(choose.plan).toMatchObject({accountId:platformCliNativeGithubId('personal'),repository:'personal/repo',remote:'origin'});
  await f.store.bind('project-one','github',{accountId:b.id,scope:'',resourceId:'company/repo'},rid());
  const prepared=await handlePlatformCliRequest(f.host,f.push,{operation:'prepare-push',targetId:'project-one'},true);
  expect(prepared.plan).toMatchObject({accountId:b.id,repository:'company/repo',remote:'company'});expect(JSON.stringify(prepared)).not.toContain(tokenB);expect(a.id).not.toBe(b.id);
});
test('app and conversational selection share native logins without registering or switching a global account',async()=>{
  const f=fixture();f.useNativeDefault();const accounts=await f.host.accounts('github');
  expect(accounts.some(a=>a.id===platformCliNativeGithubId('company'))).toBe(true);expect(f.reads()).toBe(0);expect(f.calls.some(c=>c.args[1]==='token')).toBe(false);
  await handlePlatformCliRequest(f.host,f.push,{operation:'bind',targetId:'project-one',provider:'github',binding:{accountId:platformCliNativeGithubId('company'),scope:'',resourceId:''},requestId:rid()},true);
  const state=await handlePlatformCliRequest(f.host,f.push,{operation:'project',targetId:'project-one'});
  expect(state.bindings).toMatchObject({github:{accountId:platformCliNativeGithubId('company')}});expect(f.store.binding('project-two','github')).toBeNull();expect(f.store.list()).toEqual([]);expect(f.reads()).toBe(0);
  const prepared=await handlePlatformCliRequest(f.host,f.push,{operation:'prepare-push',targetId:'project-one'},true);expect(prepared.plan).toMatchObject({identity:'company',repository:'personal/repo'});
  await handlePlatformCliRequest(f.host,f.push,{operation:'bind',targetId:'project-one',provider:'github',binding:{accountId:PLATFORM_CLI_DEFAULT_ACCOUNT,scope:'',resourceId:''},requestId:rid()},true);
  expect(f.store.binding('project-one','github')).toBeNull();expect(f.calls.some(c=>c.args.includes('switch')||c.args.includes('login'))).toBe(false);
});
test('a reviewed native push pins the initial login across active-account changes and rejects credential replacement',async()=>{
  const f=fixture();f.useNativeDefault();const plan=await f.push.prepare('project-one',PLATFORM_CLI_DEFAULT_ACCOUNT,'origin');f.setActive('company');
  expect((await f.push.execute('project-one',plan.id,rid())).state).toBe('completed');expect(f.calls.find(c=>c.executable==='/fixture/git'&&c.args.includes('push'))!.env.GH_TOKEN).toBe(tokenA);
  const next=await f.push.prepare('project-one',platformCliNativeGithubId('company'),'company');f.nativeTokens.company=tokenA;
  await expect(f.push.execute('project-one',next.id,rid())).rejects.toThrow('변경');expect(f.calls.filter(c=>c.args.includes('push'))).toHaveLength(1);
});
test('a removed explicit login or repository never falls back to the current login or origin',async()=>{
  const f=fixture();f.useNativeDefault();await f.host.bind('project-one','github',{accountId:platformCliNativeGithubId('company'),scope:'',resourceId:'company/repo'},rid());
  delete f.nativeTokens.company;await expect(handlePlatformCliRequest(f.host,f.push,{operation:'prepare-push',targetId:'project-one'},true)).rejects.toThrow('로그인');
  f.nativeTokens.company=tokenB;f.change({repositories:{origin:'personal/repo'}});expect((await handlePlatformCliRequest(f.host,f.push,{operation:'prepare-push',targetId:'project-one'},true)).selectionRequired).toBe(true);expect(f.calls.some(c=>c.args.includes('push'))).toBe(false);
});
test('a current environment login is resolved explicitly while native named accounts ignore it',async()=>{
  const f=fixture();f.host.deps.env!.GH_TOKEN=tokenA;const a=await f.host.account(PLATFORM_CLI_DEFAULT_ACCOUNT,'github');expect(a.identity).toBe('personal');
  const b=await f.host.account(platformCliNativeGithubId('company'),'github');await f.host.using(b,{id:'project-one',cwd:f.dir,label:'One'},['api','user'],async e=>{expect(e.env.GH_TOKEN).toBe(tokenB);});
  f.host.deps.env!.GH_TOKEN=tokenB;await expect(f.host.assertCurrent(a)).rejects.toThrow('변경');
});
test('native login lookup preserves the stored username case',async()=>{
  const f=fixture();f.useNativeDefault();f.nativeTokens.Company=tokenB;delete f.nativeTokens.company;
  const account=await f.host.account(platformCliNativeGithubId('Company'),'github');expect(account.identity).toBe('Company');
  expect(f.calls.filter(c=>c.args[0]==='auth'&&c.args[1]==='token').every(c=>c.args.at(-1)==='Company')).toBe(true);
});
test('an unavailable active login never silently selects the remaining non-active account',async()=>{
  const f=fixture();f.useNativeDefault();delete f.nativeTokens.personal;
  await expect(f.host.account(PLATFORM_CLI_DEFAULT_ACCOUNT,'github')).rejects.toThrow('현재 GitHub 로그인');
  expect((await f.host.account(platformCliNativeGithubId('company'),'github')).identity).toBe('company');expect(f.calls.some(c=>c.args.includes('switch'))).toBe(false);
});
test('a reviewed push uses the exact selected account, repository, branch and commit',async()=>{
  const f=fixture();await f.account();const b=await f.account('github','Company',tokenB),plan=await f.push.prepare('project-one',b.id,'company'),id=rid();
  const receipt=await f.push.execute('project-one',plan.id,id);expect(receipt.state).toBe('completed');
  const push=f.calls.find(c=>c.executable==='/fixture/git'&&c.args.includes('push'))!;
  expect(push.env.GH_TOKEN).toBe(tokenB);expect(push.args).toContain('https://github.com/company/repo.git');expect(push.args).toContain(head+':refs/heads/feature/accounts');expect(push.args.join(' ')).not.toContain(tokenB);expect(push.args).not.toContain('--force');
  const restored=new PlatformGithubPush(f.host,'/fixture/git');expect((await restored.execute('project-one',plan.id,id)).replayed).toBe(true);expect(f.calls.filter(c=>c.args.includes('push'))).toHaveLength(1);
});
test.each(['head','branch','repository','identity','permission'] as const)('a changed %s stops the push before Git transmission',async kind=>{
  const f=fixture(),a=await f.account(),plan=await f.push.prepare('project-one',a.id,'origin');
  if(kind==='head')f.change({commit:'b'.repeat(40)});if(kind==='branch')f.change({branch:'other'});if(kind==='repository')f.change({repositories:{origin:'another/repo'}});if(kind==='identity')f.change({repositoryId:'REASSIGNED_REPOSITORY'});if(kind==='permission')f.change({permission:false});
  await expect(f.push.execute('project-one',plan.id,rid())).rejects.toThrow();expect(f.calls.some(c=>c.args.includes('push'))).toBe(false);
});
test('an archived account or a Git URL rewrite cannot execute a prepared push',async()=>{
  const f=fixture(),a=await f.account(),plan=await f.push.prepare('project-one',a.id,'origin');await f.store.archive(a.id,rid());
  await expect(f.push.execute('project-one',plan.id,rid())).rejects.toThrow('계정');
  const b=await f.account('github','New',tokenB);f.change({unsafeConfig:true});await expect(f.push.prepare('project-one',b.id,'origin')).rejects.toThrow('URL 재작성');expect(f.calls.some(c=>c.args.includes('push'))).toBe(false);
});
test('unknown and unsuccessful push outcomes are durable and never automatically replayed',async()=>{
  const f=fixture(),a=await f.account(),p=await f.push.prepare('project-one',a.id,'origin'),id=rid();f.change({throwPush:true});
  await expect(f.push.execute('project-one',p.id,id)).rejects.toThrow('결과');
  expect((await new PlatformGithubPush(f.host,'/fixture/git').execute('project-one',p.id,id)).state).toBe('executing');expect(f.calls.filter(c=>c.args.includes('push'))).toHaveLength(1);
  f.change({throwPush:false,failPush:true});const p2=await f.push.prepare('project-one',a.id,'origin'),id2=rid();expect((await f.push.execute('project-one',p2.id,id2)).state).toBe('executing');expect((await f.push.execute('project-one',p2.id,id2)).replayed).toBe(true);expect(f.calls.filter(c=>c.args.includes('push'))).toHaveLength(2);
});
test('legacy and remote project push callers honor a saved account and reuse an unknown receipt',async()=>{
  const f=fixture(),company=await f.account('github','Company',tokenB);await f.host.bind('project-one','github',{accountId:company.id,scope:'',resourceId:'company/repo'},rid());
  const requestId=rid();f.change({failPush:true});expect((await f.push.pushDefault('project-one',requestId)).state).toBe('executing');
  expect((await new PlatformGithubPush(f.host,'/fixture/git').pushDefault('project-one',requestId)).replayed).toBe(true);expect(f.calls.filter(c=>c.args.includes('push'))).toHaveLength(1);
  const source=readFileSync(new URL('../api-server.ts',import.meta.url),'utf8');expect(source).toContain("pushWithConfiguredPlatformAccount(workingPath,createHash('sha256')");expect(source).toContain('pushWithConfiguredPlatformAccount(folderPath,body.requestId');expect(source).not.toContain("if(platformCliHost.store.list('github').length)");
});
test('repository input rejects credentials, flags, foreign hosts and query data',()=>{
  expect(platformGithubRepository('git@github.com:owner/repo.git')).toBe('owner/repo');expect(platformGithubRepository('https://github.com/owner/repo')).toBe('owner/repo');
  for(const v of ['https://token@github.com/a/b','https://example.test/a/b','--upload-pack=bad','https://github.com/a/b?token=x','https://github.com/a/../b'])expect(()=>platformGithubRepository(v)).toThrow();
});
test('unsafe registry links do not reveal or replace existing secrets',async()=>{
  if(process.platform==='win32')return;const f=fixture(),a=await f.account();renameSync(f.store.file,f.store.file+'.old');symlinkSync(f.store.file+'.old',f.store.file);expect(()=>f.store.list()).toThrow();expect(f.secrets.get(a.id)).toBe(tokenA);
});
test('all connected agents use a credential-free bounded MCP tool',()=>{
  const tool=AGENTSTOZ_USE_MCP_TOOLS.find(t=>t.name==='agentstoz_use_platform_cli')!;expect(tool).toBeDefined();expect(JSON.stringify(tool.inputSchema)).not.toContain('credential');
  const action=agentsToZUseMcpActionForTool(tool.name,{portId:'project-one',operation:'prepare-push'},'controller-one');expect(parseAgentsToZUseActionRequest(action)).toMatchObject({action:'platform-cli',portId:'project-one',platformCli:{operation:'prepare-push'}});
  for(const r of [{operation:'create',provider:'github',label:'A',credential:tokenA,requestId:rid()},{operation:'push-options',targetId:'project-one',folderPath:'/private'},{operation:'project',targetId:'project-one',token:tokenA}])expect(()=>validatePlatformCliRequest(r,true)).toThrow();
  expect(()=>agentsToZUseMcpActionForTool(tool.name,{portId:'project-one',operation:'project',command:'git push'},'controller-one')).toThrow();
});
test('existing native GitHub accounts connect by user without changing the active login',async()=>{
  const f=fixture(),original=f.host.deps.run!;const native:string[][]=[];
  f.host.deps.run=async e=>{
    if(e.account.id!=='native-github')return original(e);
    native.push(e.args);expect(e.env.GH_TOKEN).toBeUndefined();expect(e.env.PORTMGR_AGENT_RUNTIME_CAPABILITY).toBeUndefined();
    return e.args[1]==='status'?result(JSON.stringify({hosts:{'github.com':[{state:'success',login:'personal',token:'MASKED'},{state:'success',login:'company',token:'MASKED'},{state:'failed',login:'expired'}]}})):result(e.args.at(-1)==='company'?tokenB:tokenA);
  };
  expect(await f.host.nativeGithubAccounts()).toEqual(['personal','company']);
  const id=rid(),account=await f.host.connectNativeGithub('company',id);expect(account.identity).toBe('company');
  expect((await f.host.connectNativeGithub('company',id)).id).toBe(account.id);
  expect(native.some(args=>args.includes('switch')||args.includes('login'))).toBe(false);expect(native.find(a=>a[1]==='token')).toContain('company');
  expect(f.store.list()).toHaveLength(1);expect(JSON.stringify(f.store.list())).not.toContain(tokenB);
  await expect(f.host.connectNativeGithub('expired',rid())).rejects.toThrow('목록');
});
test('the shared CLI parser distinguishes wrapper account selection from native command args',()=>{
  expect(parsePlatformCliCommand(['github','--account','pcli_test','--remote','company','--yes','--','push'])).toMatchObject({provider:'github',accountId:'pcli_test',remote:'company',yes:true,command:['push']});
  expect(parsePlatformCliCommand(['vercel','--','deploy'])).toMatchObject({provider:'vercel',command:['deploy']});
  expect(()=>parsePlatformCliCommand(['github','push'])).toThrow('옵션');
});

test('local CLI hosts require the current registered project and resolve duplicate folders explicitly',()=>{
  const f=fixture();writeFileSync(join(f.dir,'ports.json'),JSON.stringify([{id:'one',name:'One',folderPath:f.dir},{id:'two',name:'Two',folderPath:f.dir}]));
  expect(()=>platformCliLocalProject(f.dir,f.dir,undefined,'/nonexistent/git')).toThrow('하나로');
  expect(platformCliLocalProject(f.dir,f.dir,'two','/nonexistent/git')).toMatchObject({id:'two',label:'Two'});
  expect(()=>platformCliLocalProject(f.dir,f.dir,'foreign','/nonexistent/git')).toThrow('하나로');
});
test('native CLI processes have bounded output and owned timeouts',async()=>{
  const f=fixture(),account=await f.account(),base={executable:process.execPath,cwd:f.dir,env:platformCliEnvironment(process.env),account};
  const good=await runPlatformCliProcess({...base,args:['-e','console.log("owned-output")']});expect(good.code).toBe(0);expect(good.stdout.trim()).toBe('owned-output');
  const started=Date.now();const timed=await runPlatformCliProcess({...base,args:['-e','setInterval(()=>{},1000)'],timeoutMs:100});expect(timed.code).not.toBe(0);expect(Date.now()-started).toBeLessThan(3000);
  const overflow=await runPlatformCliProcess({...base,args:['-e','process.stdout.write("x".repeat(300000))']});expect(overflow.code).not.toBe(0);expect(Buffer.byteLength(overflow.stdout)).toBeLessThanOrEqual(256*1024);
});
test('real Git includes cannot substitute a repository-specific credential helper',async()=>{
  const git=Bun.which('git');if(!git)return;
  const f=fixture(),account=await f.account(),env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'};
  const command=(args:string[])=>{const r=Bun.spawnSync([git,...args],{cwd:f.dir,env,stdout:'pipe',stderr:'pipe'});expect(r.exitCode).toBe(0);};
  command(['init','-q']);command(['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--allow-empty','-m','fixture']);command(['remote','add','origin','https://github.com/company/repo.git']);
  const included=join(f.dir,'included-auth');writeFileSync(included,'[credential "https://github.com/company/repo"]\n  helper = a-different-account\n');command(['config','--local','include.path',included]);
  const service=new PlatformGithubPush(f.host,git,e=>{if(e.args.includes('push'))throw Error('The guard must stop before transmission');return runPlatformCliProcess({...e,env});});
  await expect(service.prepare('project-one',account.id,'origin')).rejects.toThrow('인증 설정');
});

test('device intent is durable and blocks every native fallback until the requested email is verified',async()=>{
  const f=fixture();await f.store.setDefault('github','intenet1001@gmail.com',null,rid());
  const reloaded=new PlatformCliStore(f.dir,f.vault);expect(reloaded.deviceDefaults().github).toEqual({email:'intenet1001@gmail.com',accountId:null});
  expect((await f.host.accounts('github')).find(a=>a.source==='default')).toMatchObject({state:'login-required',label:'기기 기본값 · intenet1001@gmail.com'});
  await expect(f.host.run('project-one','github',['pr','list'])).rejects.toThrow('로그인 필요');
  await expect(handlePlatformCliRequest(f.host,f.push,{operation:'prepare-push',targetId:'project-one'},true)).rejects.toThrow('로그인 필요');
  expect(f.calls.some(c=>c.args.includes('push')||c.args.includes('pr'))).toBe(false);
});
test('explicit project accounts override device intent, inherit resets only the project, and other devices stay isolated',async()=>{
  const f=fixture(),a=await f.account(),b=await f.account('github','Company',tokenB);
  await f.store.verified(a,'intenet1001@gmail.com',rid());await f.store.setDefault('github','intenet1001@gmail.com',a.id,rid());
  await f.host.bind('project-one','github',{accountId:b.id,scope:'',resourceId:'company/repo'},rid());
  await f.host.run('project-one','github',['pr','list']);expect(f.calls.at(-1)!.account.id).toBe(b.id);
  await f.host.run('project-two','github',['pr','list']);expect(f.calls.at(-1)!.account.id).toBe(a.id);
  await f.host.bind('project-one','github',{accountId:PLATFORM_CLI_DEFAULT_ACCOUNT,scope:'',resourceId:''},rid());
  await f.host.run('project-one','github',['pr','list']);expect(f.calls.at(-1)!.account.id).toBe(a.id);
  expect(fixture().store.deviceDefaults()).toEqual({});
});
test('default selections reject label-only email claims and wrong-provider credentials',async()=>{
  const f=fixture(),a=await f.account('github','intenet1001@gmail.com');
  await expect(f.store.setDefault('github','intenet1001@gmail.com',a.id,rid())).rejects.toThrow('이메일');
  await f.store.verified(a,'other@example.test',rid());
  await expect(f.store.setDefault('github','intenet1001@gmail.com',a.id,rid())).rejects.toThrow('이메일');
  await expect(f.store.setDefault('supabase','other@example.test',a.id,rid())).rejects.toThrow('이메일');
});
test('archiving a selected account preserves broken bindings rather than choosing a device or native fallback',async()=>{
  const f=fixture(),a=await f.account(),b=await f.account('github','Company',tokenB);
  await f.store.verified(a,'intenet1001@gmail.com',rid());await f.store.setDefault('github','intenet1001@gmail.com',a.id,rid());
  await f.host.bind('project-one','github',{accountId:b.id,scope:'',resourceId:'company/repo'},rid());await f.store.archive(b.id,rid());
  expect(f.store.binding('project-one','github')?.accountId).toBe(b.id);
  await expect(f.host.run('project-one','github',['pr','list'])).rejects.toThrow('사용할 수 없');
  await f.store.archive(a.id,rid());await expect(f.host.account(PLATFORM_CLI_DEFAULT_ACCOUNT,'github')).rejects.toThrow('사용할 수 없');
});
test('reviewed work pins a resolved device account even when another window changes its default',async()=>{
  const f=fixture(),a=await f.account();await f.store.verified(a,'intenet1001@gmail.com',rid());await f.store.setDefault('github','intenet1001@gmail.com',a.id,rid());
  const plan=await f.push.prepare('project-one',PLATFORM_CLI_DEFAULT_ACCOUNT,'origin');
  await f.store.setDefault('github','other@example.test',null,rid());
  await f.push.execute('project-one',plan.id,rid());expect(f.calls.findLast(c=>c.args.includes('push'))!.env.GH_TOKEN).toBe(tokenA);
  await expect(f.host.run('project-two','github',['pr','list'])).rejects.toThrow('로그인 필요');
});
test('a completed login attaches only a still-pending matching device intent',async()=>{
  const f=fixture(),a=await f.account();const verified=await f.store.verified(a,'intenet1001@gmail.com',rid());
  await f.store.setDefault('github','other@example.test',null,rid());await f.store.attachVerifiedDefault(verified,rid());
  expect(f.store.deviceDefaults().github).toEqual({email:'other@example.test',accountId:null});
  await f.store.setDefault('github',verified.verifiedEmail,null,rid());await f.store.attachVerifiedDefault(verified,rid());expect(f.store.defaultAccountId('github')).toBe(a.id);
});
test('OAuth credentials retain refresh data and serialize rotation without changing the selected identity',async()=>{
  const f=fixture(),oauth=JSON.stringify({token:'oauth_'+'e'.repeat(35),refreshToken:'refresh-secret',expiresAt:1234});
  const a=await f.account('vercel','OAuth',oauth);let file='';
  await f.host.using(a,{id:'project-one',cwd:f.dir,label:'One'},['whoami'],async e=>{file=join(e.args[1]!,'auth.json');const v=JSON.parse(readFileSync(file,'utf8'));expect(v.refreshToken).toBe('refresh-secret');writeFileSync(file,JSON.stringify({...v,token:'oauth_'+'f'.repeat(35)}),{mode:0o600});});
  expect(existsSync(file)).toBe(false);const current=f.store.account(a.id);expect(current.identity).toBe(a.identity);expect(current.revision).not.toBe(a.revision);expect(JSON.parse(await f.store.credential(current)).refreshToken).toBe('refresh-secret');
  await expect(f.host.using(a,{id:'project-one',cwd:f.dir,label:'One'},[],async()=>{})).rejects.toThrow('변경');
});
test('a target the selected provider cannot prove is refused before a deployment command starts',async()=>{
  const f=fixture(),a=await f.account('supabase','Data','sbp_'+'e'.repeat(40));await f.host.bind('project-one','supabase',{accountId:a.id,scope:'',resourceId:'a'.repeat(20)},rid());
  f.host.deps.json=async()=>({id:'b'.repeat(20)});const count=f.calls.length;
  await expect(f.host.run('project-one','supabase',['functions','deploy','example'])).rejects.toThrow('프로젝트');expect(f.calls).toHaveLength(count);
});
test('an account excluded during the target permission check cannot start the command',async()=>{
  const f=fixture(),a=await f.account('supabase','Data','sbp_'+'e'.repeat(40)),resourceId='a'.repeat(20);await f.host.bind('project-one','supabase',{accountId:a.id,scope:'',resourceId},rid());
  f.host.deps.json=async()=>{await f.store.archive(a.id,rid());return {id:resourceId};};const count=f.calls.length;
  await expect(f.host.run('project-one','supabase',['functions','deploy','example'])).rejects.toThrow('변경');expect(f.calls).toHaveLength(count);
});
