import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {lstatSync,mkdirSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute,join} from 'node:path';
import {withOwnedPortalFileLock} from './portalFileLock';
import {pathEntryExists,readPrivateFileStrict,writePrivateFileAtomically} from './remoteControlHostVault';
import {PlatformCliHost,platformCliEnvironment,runPlatformCliProcess,type PlatformCliProcess} from './platformCliHost';
import {platformCliDiscoveredEmail,type PlatformCliJson} from './platformCliIdentity';
import {supabaseKeyringToken} from './platformCliLogin';
import {macGithubCredentialChain,platformCliGitFiles} from './platformCliWorkroom';
import {platformCliHash} from './platformCliStore';
import {PlatformCliError,PLATFORM_CLI_LABELS,PLATFORM_CLI_PROVIDERS,platformCliManagedId,platformCliNativeGithubId,platformCliNativeGithubLogin,platformCliRequestId,type PlatformCliAccount,type PlatformCliProvider} from './platformCliProtocol';

/**
 * The Mac-wide login of each official CLI — what `gh`, `supabase` and `vercel` use when someone types them in a
 * terminal, a Workroom or another app. Switching changes that login through the CLI's own multi-account store:
 * `gh auth switch`, a Supabase CLI profile (one Keychain entry per profile), Vercel's auth.json. A login that is
 * not one of the connected accounts is kept (Supabase profile, gh login) or connected before it is replaced
 * (Vercel), never silently lost. gws has no multi-account store; it is chosen per project instead.
 */
export const PLATFORM_NATIVE_SWITCH_PROVIDERS=['github','supabase','vercel'] as const;
export type PlatformNativeProvider=typeof PLATFORM_NATIVE_SWITCH_PROVIDERS[number];
export interface PlatformNativeOption {id:string;label:string;current:boolean}
export interface PlatformNativeState {
  provider:PlatformCliProvider;
  state:'ready'|'none'|'unknown'|'not-installed'|'unsupported';
  /** The current Mac-wide login: a GitHub username or an email. */
  identity:string|null;
  currentId:string|null;
  options:PlatformNativeOption[];
  /** GitHub only: whether `git push` to github.com asks gh (and so follows the switch). null = git not found. */
  gitFollows?:boolean|null;
  message?:string;
}
export type PlatformSecurityRun=(args:string[],input?:string)=>Promise<PlatformCliProcess>;
export interface PlatformNativeSwitchDependencies {home?:string;env?:NodeJS.ProcessEnv;git?:string|null;security?:PlatformSecurityRun;json?:PlatformCliJson}
interface Ledger {schemaVersion:1;supabaseSelectors:string[];vercel:{accountId:string;hash:string}|null;vercelTeams:Record<string,string>;receipts:{id:string;hash:string;at:number}[]}

const SUPABASE_SERVICE='Supabase CLI';
const NATIVE_ID=/^native:[0-9a-f]{16}$/;
const VERCEL_NOTE={'// Note':'This is your Vercel credentials file. DO NOT SHARE!','// Docs':'https://vercel.com/docs/projects/project-configuration/global-configuration#auth.json'};
const nativeOptionId=(selector:string)=>'native:'+createHash('sha256').update(selector).digest('hex').slice(0,16);
const lower=(value?:string|null)=>value?.toLowerCase()??null;
/** go-keyring's own macOS path: `security -i` reads the command from stdin, so no secret reaches argv. */
export const runMacSecurity:PlatformSecurityRun=(args,input)=>new Promise(resolve=>{
  const child=execFile('/usr/bin/security',args,{timeout:15_000,killSignal:'SIGKILL',maxBuffer:65_536},(error,stdout,stderr)=>
    resolve({code:error?(typeof (error as {code?:unknown}).code==='number'?(error as {code:number}).code:1):0,stdout:String(stdout),stderr:String(stderr)}));
  if(input!==undefined){child.stdin?.on('error',()=>{});child.stdin?.end(input);}
});
const quoted=(value:string)=>`'${value.replaceAll("'",`'"'"'`)}'`;
function ownedDirectory(path:string,create:boolean):boolean {
  if(!pathEntryExists(path)){if(!create)return false;mkdirSync(path,{recursive:true,mode:0o700});}
  const s=lstatSync(path);
  if(!s.isDirectory()||s.isSymbolicLink()||process.platform!=='win32'&&s.uid!==process.getuid?.())throw new PlatformCliError('CLI 설정 폴더의 소유자·종류를 확인하세요. 아무것도 바꾸지 않았습니다.');
  return true;
}
function plainFile(path:string,limit:number):string|null {
  if(!pathEntryExists(path))return null;
  const s=lstatSync(path);
  if(!s.isFile()||s.isSymbolicLink()||s.size>limit)throw new PlatformCliError('CLI 설정 파일을 안전하게 읽지 못했습니다. 아무것도 바꾸지 않았습니다.');
  return readFileSync(path,'utf8');
}

export class PlatformNativeSwitch {
  private readonly emails=new Map<string,string>();
  constructor(private readonly host:PlatformCliHost,private readonly deps:PlatformNativeSwitchDependencies={}){}
  private get store(){return this.host.store;}
  private get env():NodeJS.ProcessEnv{return this.deps.env??this.host.deps.env??process.env;}
  private get home(){return this.deps.home??this.env.HOME??homedir();}
  private security(args:string[],input?:string){return (this.deps.security??runMacSecurity)(args,input);}
  private installed(provider:PlatformCliProvider){const e=this.host.deps.executable(provider);return !!e&&isAbsolute(e);}
  private exec(provider:PlatformCliProvider,args:string[],input?:string,executable=this.host.deps.executable(provider)):Promise<PlatformCliProcess> {
    if(!executable||!isAbsolute(executable))throw new PlatformCliError(`${PLATFORM_CLI_LABELS[provider]} CLI를 설치한 뒤 다시 확인하세요.`);
    const env=platformCliEnvironment(this.env);if(provider==='github'&&this.env.GH_CONFIG_DIR)env.GH_CONFIG_DIR=this.env.GH_CONFIG_DIR;
    return (this.host.deps.run??runPlatformCliProcess)({executable,args,env,cwd:this.store.appDirectory,timeoutMs:60_000,
      account:{id:'native-switch',provider,label:PLATFORM_CLI_LABELS[provider],identity:null,state:'unchecked',revision:''},...(input===undefined?{}:{input})});
  }
  private ledgerFile(){return join(this.store.root,'native-switch.json');}
  private ledger():Ledger {
    const empty:Ledger={schemaVersion:1,supabaseSelectors:[],vercel:null,vercelTeams:{},receipts:[]};
    if(!pathEntryExists(this.store.root))return empty;
    const raw=readPrivateFileStrict(this.ledgerFile());
    if(raw===null){if(pathEntryExists(this.ledgerFile()))throw new PlatformCliError('전환 기록을 읽지 못했습니다.');return empty;}
    const d=JSON.parse(raw) as Ledger;
    if(d.schemaVersion!==1||!Array.isArray(d.supabaseSelectors)||d.supabaseSelectors.length>8||d.supabaseSelectors.some(s=>typeof s!=='string'||s.length>1024)
      ||!(d.vercel===null||platformCliManagedId(d.vercel?.accountId)&&/^[a-f0-9]{64}$/.test(d.vercel.hash))
      ||!d.vercelTeams||typeof d.vercelTeams!=='object'||Array.isArray(d.vercelTeams)||Object.entries(d.vercelTeams).some(([k,v])=>!platformCliManagedId(k)||typeof v!=='string'||v.length>120)
      ||!Array.isArray(d.receipts)||d.receipts.length>256)throw new PlatformCliError('전환 기록 형식을 확인하세요.');
    return d;
  }
  private saveLedger(ledger:Ledger){this.store.ensureDirectory();writePrivateFileAtomically(this.store.root,this.ledgerFile(),JSON.stringify(ledger));}
  /** Successful lookups only: a network failure is asked again next time. */
  private async email(provider:'supabase'|'vercel',token:string):Promise<string|null> {
    const key=provider+':'+platformCliHash(token),known=this.emails.get(key);if(known)return known;
    try{const email=await platformCliDiscoveredEmail(provider,token,this.deps.json??this.host.deps.json);this.emails.set(key,email);if(this.emails.size>64)this.emails.delete(this.emails.keys().next().value!);return email;}
    catch{return null;}
  }
  /** App runs follow the Mac-wide login once it changes: a connected account becomes the device default. */
  private async followDefault(provider:PlatformCliProvider,account:PlatformCliAccount|null,requestId:string) {
    if(account?.verifiedEmail)await this.store.setDefault(provider,account.verifiedEmail,account.id,platformCliHash(requestId+':native-default'));
    else await this.store.clearDefault(provider,platformCliHash(requestId+':native-default'));
  }

  async status():Promise<PlatformNativeState[]> {
    return Promise.all(PLATFORM_CLI_PROVIDERS.map(provider=>this.providerStatus(provider).catch(error=>({provider,state:'unknown' as const,identity:null,currentId:null,options:[],
      message:error instanceof PlatformCliError?error.message:'현재 로그인을 확인하지 못했습니다.'}))));
  }
  async providerStatus(provider:PlatformCliProvider):Promise<PlatformNativeState> {
    if(provider==='google-workspace')return {provider,state:'unsupported',identity:null,currentId:null,options:[],message:'gws는 여러 계정을 바꿔 쓰는 기능이 없어 이 Mac 전체 전환을 지원하지 않습니다. 프로젝트별 연결에서 계정을 고르세요.'};
    if(!this.installed(provider))return {provider,state:'not-installed',identity:null,currentId:null,options:[],message:`${PLATFORM_CLI_LABELS[provider]} CLI가 설치되어 있지 않습니다.`};
    if(provider==='github')return this.githubStatus();
    if(provider==='supabase')return this.supabaseStatus();
    return this.vercelStatus();
  }

  async switch(provider:PlatformCliProvider,id:unknown,requestId:string):Promise<PlatformNativeState> {
    platformCliRequestId(requestId);
    if(!(PLATFORM_NATIVE_SWITCH_PROVIDERS as readonly string[]).includes(provider))throw new PlatformCliError('이 CLI는 이 Mac 전체 전환을 지원하지 않습니다. 프로젝트별 연결을 사용하세요.');
    if(typeof id!=='string'||!(platformCliManagedId(id)||platformCliNativeGithubLogin(id)&&provider==='github'||NATIVE_ID.test(id)&&provider==='supabase'))throw new PlatformCliError('전환할 계정을 선택하세요.');
    if(!this.installed(provider))throw new PlatformCliError(`${PLATFORM_CLI_LABELS[provider]} CLI를 설치한 뒤 다시 확인하세요.`);
    await this.once('switch',[provider,id],requestId,async()=>{
      if(provider==='github')await this.switchGithub(id,requestId);
      else if(provider==='supabase')await this.switchSupabase(id,requestId);
      else await this.switchVercel(id,requestId);
    });
    return this.providerStatus(provider);
  }
  /** `git push` to github.com then asks gh, so it follows the GitHub switch. A global Git setting, on request only. */
  async setupGit(requestId:string):Promise<PlatformNativeState> {
    platformCliRequestId(requestId);
    await this.once('git-setup',[],requestId,async()=>{
      const r=await this.exec('github',['auth','setup-git','--hostname','github.com']);
      if(r.code!==0)throw new PlatformCliError('git 인증 도우미를 설정하지 못했습니다. git 설정은 그대로입니다.');
    });
    const state=await this.providerStatus('github');
    if(state.gitFollows!==true)throw new PlatformCliError('git이 아직 다른 인증 도우미를 먼저 씁니다. 저장소별 git 설정을 확인하세요.');
    return state;
  }
  /** One switch at a time; a repeated request ID is that same request and is never performed twice. */
  private async once(operation:string,input:unknown[],requestId:string,perform:()=>Promise<void>) {
    this.store.ensureDirectory();
    await withOwnedPortalFileLock(join(this.store.root,'native-switch.lock'),async()=>{
      const ledger=this.ledger(),hash=platformCliHash(JSON.stringify([operation,...input]));
      ledger.receipts=ledger.receipts.filter(r=>Date.now()-r.at<7*86_400_000);
      const old=ledger.receipts.find(r=>r.id===requestId);
      if(old){if(old.hash!==hash)throw new PlatformCliError('같은 요청 ID로 다른 전환을 할 수 없습니다.');return;}
      if(ledger.receipts.length>=256)ledger.receipts.shift();
      ledger.receipts.push({id:requestId,hash,at:Date.now()});this.saveLedger(ledger);
      await perform();
    },{label:'Platform CLI Mac-wide switch',attempts:50,retryMs:40,deadOwnerRecoveryClass:'manual',canRecoverDeadOwner:()=>false});
  }

  // GitHub: gh keeps every login; `gh auth switch` only changes which one is active.
  private async githubStatus():Promise<PlatformNativeState> {
    const logins=await this.host.nativeGithubLogins(),managed=this.store.list('github').filter(a=>a.state==='ready'&&a.identity);
    const active=logins.find(l=>l.active)??null;
    const options:PlatformNativeOption[]=logins.map(l=>{const m=managed.find(a=>lower(a.identity)===lower(l.login));return {id:platformCliNativeGithubId(l.login),label:l.login+(m?.verifiedEmail?' · '+m.verifiedEmail:''),current:l.active};});
    for(const a of managed)if(!logins.some(l=>lower(l.login)===lower(a.identity)))options.push({id:a.id,label:a.identity+(a.verifiedEmail?' · '+a.verifiedEmail:''),current:false});
    return {provider:'github',state:active?'ready':'none',identity:active?.login??null,currentId:active?platformCliNativeGithubId(active.login):null,options,gitFollows:await this.gitFollows()};
  }
  private async switchGithub(id:string,requestId:string) {
    let logins=await this.host.nativeGithubLogins(),login:string|undefined;
    if(platformCliNativeGithubLogin(id))login=logins.find(l=>platformCliNativeGithubId(l.login)===id)?.login;
    else{
      const a=this.store.account(id);
      if(a.provider!=='github'||a.state!=='ready'||!a.identity)throw new PlatformCliError('연결을 확인한 GitHub 계정을 선택하세요.');
      login=logins.find(l=>lower(l.login)===lower(a.identity))?.login;
      if(!login){
        // Add the connected account to gh's own login list; gh makes a newly added login the active one.
        const r=await this.exec('github',['auth','login','--hostname','github.com','--with-token'],await this.store.credential(a)+'\n');
        if(r.code!==0)throw new PlatformCliError('GitHub CLI에 이 계정을 추가하지 못했습니다. 토큰 권한(repo·read:org)을 확인하세요. 현재 로그인은 그대로입니다.');
        logins=await this.host.nativeGithubLogins();login=logins.find(l=>lower(l.login)===lower(a.identity))?.login;
        if(!login)throw new PlatformCliError('GitHub CLI에 추가한 계정이 목록에 없습니다. 현재 로그인을 확인하세요.');
      }
    }
    if(!login)throw new PlatformCliError('GitHub 로그인 목록에서 계정을 선택하세요.');
    if(!logins.find(l=>l.login===login)?.active){
      const r=await this.exec('github',['auth','switch','--hostname','github.com','--user',login]);
      if(r.code!==0)throw new PlatformCliError('GitHub 계정을 바꾸지 못했습니다. 현재 로그인은 그대로입니다.');
    }
    if(!(await this.host.nativeGithubLogins()).find(l=>l.login===login)?.active)throw new PlatformCliError('GitHub 전환 결과를 확인하지 못했습니다. 터미널에서 gh auth status로 확인하세요.');
    await this.followDefault('github',this.store.list('github').find(a=>a.state==='ready'&&lower(a.identity)===lower(login)&&a.verifiedEmail)??null,requestId);
  }
  /** Git consults every matching helper in config order and an empty value resets the list; the first one answers. */
  private async gitFollows():Promise<boolean|null> {
    const git=this.deps.git;if(!git||!isAbsolute(git))return null;
    const r=await this.exec('github',['config','--null','--show-origin','--get-regexp','^credential\\.'],undefined,git);
    if(r.code!==0&&r.code!==1)return null;
    // What git uses for a folder with no project account: this Mac's own helpers, not AgentsToZ's routing in front of them.
    const chain=macGithubCredentialChain(r.stdout,platformCliGitFiles(this.store.root));
    return chain.length>0&&/\bauth git-credential\b/.test(chain[0]!)&&/(?:^|[\s!/\\])gh(?:\.exe)?\s/.test(chain[0]!);
  }


  // Supabase: ~/.supabase/profile names the active profile; each profile's token is its own Keychain entry.
  private supabaseSelectorFile(){return join(this.home,'.supabase','profile');}
  private supabaseSelector():string {return plainFile(this.supabaseSelectorFile(),4096)?.trim()||'supabase';}
  private supabaseProfileName(selector:string):string {
    if(!selector.includes('/'))return selector;
    const text=plainFile(selector.startsWith('~/')?join(this.home,selector.slice(2)):selector,16_384);
    if(text===null)throw new PlatformCliError('현재 Supabase 프로필 파일을 찾지 못했습니다.');
    let name:unknown;try{name=JSON.parse(text).name;}catch{name=/^\s*name\s*:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/m.exec(text)?.[1];}
    if(typeof name!=='string'||!/^[A-Za-z0-9_.-]{1,128}$/.test(name))throw new PlatformCliError('Supabase 프로필 이름을 읽지 못했습니다.');
    return name;
  }
  private async supabaseToken(name:string):Promise<string|null> {
    if(!/^[A-Za-z0-9_.-]{1,128}$/.test(name))throw new PlatformCliError('Supabase 프로필 이름을 확인하세요.');
    const r=await this.security(['find-generic-password','-s',SUPABASE_SERVICE,'-a',name,'-w']);
    if(r.code===0)return supabaseKeyringToken(r.stdout);
    if(/could not be found/i.test(r.stderr))return null;
    throw new PlatformCliError('키체인에서 Supabase 로그인을 확인하지 못했습니다. 키체인 확인창이 있으면 직접 승인한 뒤 다시 확인하세요.');
  }
  private supabaseDescriptor(accountId:string){const key=accountId.slice(5);return {name:'agentstoz-'+key,path:join(this.store.root,'native','supabase-'+key+'.json')};}
  private async supabaseStatus():Promise<PlatformNativeState> {
    const selector=this.supabaseSelector(),ledger=this.ledger(),managed=this.store.list('supabase').filter(a=>a.state==='ready'&&a.verifiedEmail);
    const ours=managed.find(a=>this.supabaseDescriptor(a.id).path===selector)??null;
    const token=await this.supabaseToken(this.supabaseProfileName(selector));
    const owner=ours??(token?this.store.matchCredential('supabase',token):null);
    const identity=owner?.verifiedEmail??(token?await this.email('supabase',token):null);
    const natives=[...new Set([...ledger.supabaseSelectors,...(ours?[]:[selector])])];
    const label=(s:string)=>{try{return this.supabaseProfileName(s);}catch{return s.split('/').at(-1)!;}};
    const options:PlatformNativeOption[]=[...managed.map(a=>({id:a.id,label:a.verifiedEmail!,current:ours?.id===a.id})),
      ...natives.map(s=>({id:nativeOptionId(s),label:label(s)+' · 기존 프로필'+(s===selector&&!ours&&identity?' · '+identity:''),current:s===selector&&!ours}))];
    return {provider:'supabase',state:token?'ready':'none',identity,currentId:ours?.id??nativeOptionId(selector),options};
  }
  private writeSupabaseSelector(value:string) {
    const directory=join(this.home,'.supabase');ownedDirectory(directory,true);
    writePrivateFileAtomically(directory,this.supabaseSelectorFile(),value);
  }
  private async switchSupabase(id:string,requestId:string) {
    const current=this.supabaseSelector(),ledger=this.ledger();
    if(platformCliManagedId(id)){
      const a=this.store.account(id);
      if(a.provider!=='supabase'||a.state!=='ready'||!a.verifiedEmail)throw new PlatformCliError('이메일을 확인한 Supabase 계정을 선택하세요.');
      const token=await this.store.credential(a),{name,path}=this.supabaseDescriptor(a.id),directory=join(this.store.root,'native');
      ownedDirectory(directory,true);
      writePrivateFileAtomically(directory,path,JSON.stringify({name,api_url:'https://api.supabase.com',dashboard_url:'https://supabase.com/dashboard',docs_url:'https://supabase.com/docs',project_host:'supabase.co',pooler_host:'supabase.com'}));
      // The same encoding go-keyring writes, so the CLI reads it as its own.
      await this.security(['-i'],`add-generic-password -U -s ${quoted(SUPABASE_SERVICE)} -a ${quoted(name)} -w ${quoted('go-keyring-base64:'+Buffer.from(token,'utf8').toString('base64'))}\n`);
      if(await this.supabaseToken(name)!==token)throw new PlatformCliError('키체인에 Supabase 로그인을 저장하지 못했습니다. 현재 로그인은 그대로입니다.');
      // The profile being left keeps its own Keychain entry; remember it so it can be chosen again.
      if(!this.store.list('supabase').some(m=>this.supabaseDescriptor(m.id).path===current)&&!ledger.supabaseSelectors.includes(current)){
        ledger.supabaseSelectors=[...ledger.supabaseSelectors,current].slice(-8);this.saveLedger(ledger);
      }
      this.writeSupabaseSelector(path);
      await this.followDefault('supabase',a,requestId);
      return;
    }
    const selector=[...ledger.supabaseSelectors,current].find(s=>nativeOptionId(s)===id);
    if(!selector)throw new PlatformCliError('그 Supabase 프로필을 찾지 못했습니다. 목록을 다시 확인하세요.');
    const token=await this.supabaseToken(this.supabaseProfileName(selector));
    if(!token)throw new PlatformCliError('그 Supabase 프로필에는 로그인이 없습니다. 아무것도 바꾸지 않았습니다.');
    this.writeSupabaseSelector(selector);
    const owner=this.store.matchCredential('supabase',token);
    await this.followDefault('supabase',owner?.state==='ready'?owner:null,requestId);
  }

  // Vercel: one auth.json. The login being replaced is connected first (or kept aside) so it is never lost.
  private vercelDirectory():string {
    const env=this.env,home=this.home;
    const roots=env.XDG_DATA_HOME?[join(env.XDG_DATA_HOME,'com.vercel.cli')]:process.platform==='darwin'?[join(home,'Library','Application Support','com.vercel.cli')]:process.platform==='win32'?[join(env.APPDATA??home,'xdg.data','com.vercel.cli')]:[join(home,'.local','share','com.vercel.cli')];
    return [...roots,join(home,'.now')].find(d=>pathEntryExists(d))??roots[0]!;
  }
  private vercelAuth(directory:string):{raw:string;token:string}|null {
    const file=join(directory,'auth.json');if(!pathEntryExists(file))return null;
    const raw=readPrivateFileStrict(file);if(raw===null)throw new PlatformCliError('Vercel 로그인 파일의 권한을 확인하세요. 아무것도 바꾸지 않았습니다.');
    let token:unknown;try{token=JSON.parse(raw).token;}catch{}
    return typeof token==='string'&&/^[A-Za-z0-9_.-]{16,4096}$/.test(token)?{raw,token}:null;
  }
  private async vercelOwner(auth:{raw:string;token:string},ledger:Ledger):Promise<{account:PlatformCliAccount|null;email:string|null}> {
    const managed=this.store.list('vercel').filter(a=>a.state==='ready'&&a.verifiedEmail);
    if(ledger.vercel&&platformCliHash(auth.raw)===ledger.vercel.hash){const a=managed.find(m=>m.id===ledger.vercel!.accountId);if(a)return {account:a,email:a.verifiedEmail!};}
    const email=await this.email('vercel',auth.token);
    return {account:email?managed.find(m=>m.verifiedEmail===email)??null:null,email};
  }
  private async vercelStatus():Promise<PlatformNativeState> {
    const auth=this.vercelAuth(this.vercelDirectory()),owner=auth?await this.vercelOwner(auth,this.ledger()):{account:null,email:null};
    const options=this.store.list('vercel').filter(a=>a.state==='ready'&&a.verifiedEmail).map(a=>({id:a.id,label:a.verifiedEmail!+(a.identity?' · '+a.identity:''),current:owner.account?.id===a.id}));
    return {provider:'vercel',state:auth?'ready':'none',identity:owner.account?.verifiedEmail??owner.email,currentId:owner.account?.id??null,options,
      ...(auth&&!owner.account?{message:owner.email?'지금 로그인은 앱에 연결되지 않은 계정입니다. 전환하면 먼저 연결해 둡니다.':'지금 로그인의 계정을 확인하지 못했습니다.'}:{})};
  }
  private async switchVercel(id:string,requestId:string) {
    const target=this.store.account(id);
    if(target.provider!=='vercel'||target.state!=='ready'||!target.verifiedEmail)throw new PlatformCliError('이메일을 확인한 Vercel 계정을 선택하세요.');
    const directory=this.vercelDirectory();ownedDirectory(directory,true);
    const ledger=this.ledger(),current=this.vercelAuth(directory),configFile=join(directory,'config.json');
    let config:Record<string,unknown>|null=null;
    try{const text=plainFile(configFile,65_536);config=text===null?null:JSON.parse(text);}catch{config=null;}
    if(config&&(typeof config!=='object'||Array.isArray(config)))config=null;
    if(current){
      let {account:owner,email}=await this.vercelOwner(current,ledger);
      if(owner){
        // The official CLI refreshes this session in place; bring the account's stored copy up to date.
        if(this.store.matchCredential('vercel',current.raw.trim())?.id!==owner.id)await this.store.refreshed(owner,current.raw.trim());
      }else if(email){
        const created=await this.store.create('vercel',email.slice(0,45)+' · 기존 '+requestId.slice(0,6),current.raw.trim(),platformCliHash(requestId+':vercel-keep'));
        try{owner=await this.store.verified(await this.host.check(created.id,platformCliHash(requestId+':vercel-keep-check')),email,platformCliHash(requestId+':vercel-keep-email'));}
        catch{await this.store.archive(created.id,platformCliHash(requestId+':vercel-keep-failed')).catch(()=>{});owner=null;}
      }
      if(!owner)this.keepVercelBackup(current.raw);
      if(owner&&typeof config?.currentTeam==='string'&&config.currentTeam.length<=120)ledger.vercelTeams[owner.id]=config.currentTeam;
      else if(owner)delete ledger.vercelTeams[owner.id];
    }
    const secret=await this.store.credential(target);
    const content=JSON.stringify({...VERCEL_NOTE,...(secret.startsWith('{')?JSON.parse(secret):{token:secret})},null,2)+'\n';
    writePrivateFileAtomically(directory,join(directory,'auth.json'),content);
    ledger.vercel={accountId:target.id,hash:platformCliHash(content)};this.saveLedger(ledger);
    // The previous account's team is not this account's; restore this account's own last team.
    if(config){
      const team=ledger.vercelTeams[target.id];if(team)config.currentTeam=team;else delete config.currentTeam;
      writePrivateFileAtomically(directory,configFile,JSON.stringify(config,null,2)+'\n');
    }
    await this.followDefault('vercel',target,requestId);
  }
  private keepVercelBackup(raw:string) {
    const directory=join(this.store.root,'native-backups');ownedDirectory(directory,true);
    const files=readdirSync(directory).filter(n=>/^vercel-auth-\d+\.json$/.test(n)).sort();
    for(const name of files.slice(0,Math.max(0,files.length-7)))rmSync(join(directory,name),{force:true});
    writePrivateFileAtomically(directory,join(directory,`vercel-auth-${Date.now()}.json`),raw);
  }
  /** The live Mac-wide directory while it still holds this account — refreshed by the CLI or not. */
  async vercelLive(account:PlatformCliAccount):Promise<string|null> {
    let ledger:Ledger;try{ledger=this.ledger();}catch{return null;}
    if(ledger.vercel?.accountId!==account.id||!account.verifiedEmail)return null;
    try{
      const directory=this.vercelDirectory(),auth=this.vercelAuth(directory);if(!auth)return null;
      if(platformCliHash(auth.raw)===ledger.vercel.hash)return directory;
      return await this.email('vercel',auth.token)===account.verifiedEmail?directory:null;
    }catch{return null;}
  }
}
