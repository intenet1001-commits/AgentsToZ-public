import {PlatformCliError} from './platformCliProtocol';
import {execFile,spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PlatformCliStore,platformCliHash} from './platformCliStore';
import {readPrivateFileStrict} from './remoteControlHostVault';
import {withOwnedPortalFileLock} from './portalFileLock';
import {platformCliJson,type PlatformCliJson} from './platformCliIdentity';
import {PLATFORM_CLI_DEFAULT_ACCOUNT,PLATFORM_CLI_PROVIDERS,PLATFORM_CLI_LABELS,platformCliBinding,platformCliManagedId,platformCliNativeGithubId,platformCliNativeGithubLogin,platformCliRequestId,platformCliProvider,type PlatformCliAccount,type PlatformCliProvider} from './platformCliProtocol';

export interface PlatformCliProcess {code:number;stdout:string;stderr:string}
export interface PlatformCliExecution {executable:string;args:string[];env:NodeJS.ProcessEnv;cwd:string;account:PlatformCliAccount;timeoutMs?:number}
export interface PlatformCliProject {id:string;cwd:string;label:string}
export interface PlatformCliHostDependencies {
  store:PlatformCliStore;
  executable(provider:PlatformCliProvider):string|null;
  resolveProject(targetId:string,folderPath?:string):Promise<PlatformCliProject>;
  run?(execution:PlatformCliExecution):Promise<PlatformCliProcess>;
  env?:NodeJS.ProcessEnv;
  json?:PlatformCliJson;
  nativeCredential?(provider:PlatformCliProvider):Promise<string>;
}
/** No global login switching, no inherited provider token, no shell evaluation. */
export function platformCliEnvironment(base:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
  const env={...base};
  for(const key of Object.keys(env))if(/^(GH_|GITHUB_|VERCEL_|(?:(?:VITE_|NEXT_PUBLIC_)?SUPABASE_)|DATABASE_URL$|DIRECT_URL$|PGPASSWORD$|PGSERVICEFILE$|GOOGLE_WORKSPACE_|GOOGLE_APPLICATION_CREDENTIALS$|CLOUDSDK_AUTH_|OPENAI_|ANTHROPIC_|CLAUDE_|CODEX_|GEMINI_|GOOGLE_API_KEY$|GIT_CONFIG|GIT_ASKPASS$|SSH_ASKPASS$|GIT_SSH|(?:PORTMGR_|AGENTSTOZ_))/.test(key))delete env[key];
  delete env.SSH_CLIENT;delete env.SSH_CONNECTION;delete env.SSH_TTY;
  env.GIT_TERMINAL_PROMPT='0';env.GH_PROMPT_DISABLED='1';return env;
}
export function runPlatformCliProcess(e:PlatformCliExecution):Promise<PlatformCliProcess> {
  return new Promise(resolve=>{
    const child=spawn(e.executable,e.args,{cwd:e.cwd,env:e.env,detached:process.platform!=='win32',windowsHide:true,stdio:['ignore','pipe','pipe']});
    const output:Buffer[]=[],errors:Buffer[]=[];let bytes=0,done=false,stopped=false;
    let hardStop:ReturnType<typeof setTimeout>|undefined;
    const kill=(hard:boolean)=>{if(!child.pid)return;if(process.platform==='win32'){execFile('taskkill',['/PID',String(child.pid),'/T',...(hard?['/F']:[])],{timeout:3000,windowsHide:true},()=>{});}else try{process.kill(-child.pid,hard?'SIGKILL':'SIGTERM');}catch{/* owned group exited */}};
    const finish=(code:number)=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(hardStop);kill(true);resolve({code:stopped?-1:code,stdout:Buffer.concat(output).toString('utf8'),stderr:Buffer.concat(errors).toString('utf8')});};
    const stop=()=>{if(done||stopped)return;stopped=true;kill(false);hardStop=setTimeout(()=>{kill(true);finish(1);},1000);};
    const timeout=Math.min(600_000,Math.max(100,e.timeoutMs??90_000));const timer=setTimeout(stop,timeout);
    const collect=(target:Buffer[],chunk:Buffer)=>{bytes+=chunk.length;if(bytes>256*1024){stop();return;}target.push(chunk);};
    child.stdout.on('data',chunk=>collect(output,chunk));child.stderr.on('data',chunk=>collect(errors,chunk));child.on('error',()=>finish(1));
    child.on('exit',()=>kill(true));child.on('close',code=>finish(code??1));
  });
}
export class PlatformCliHost {
  readonly store:PlatformCliStore;
  constructor(readonly deps:PlatformCliHostDependencies){this.store=deps.store;}
  private nativeGithub(args:string[]) {
    const executable=this.deps.executable('github');if(!executable||!isAbsolute(executable))throw new PlatformCliError('GitHub CLI를 설치한 뒤 다시 확인하세요.');
    const base=this.deps.env??process.env,env=platformCliEnvironment(base);if(base.GH_CONFIG_DIR)env.GH_CONFIG_DIR=base.GH_CONFIG_DIR;
    return (this.deps.run??runPlatformCliProcess)({executable,args,cwd:this.store.appDirectory,env,timeoutMs:15_000,account:{id:'native-github',provider:'github',label:'GitHub',identity:null,state:'unchecked',revision:''}});
  }
  private async nativeGithubLogins():Promise<{login:string;active:boolean}[]> {
    // No token output is exposed, including masked tokens returned by gh auth status.
    // cwd must exist even before the first managed account is created.
    const executable=this.deps.executable('github');if(!executable||!isAbsolute(executable))throw new PlatformCliError('GitHub CLI를 설치한 뒤 다시 확인하세요.');
    const base=this.deps.env??process.env,env=platformCliEnvironment(base);if(base.GH_CONFIG_DIR)env.GH_CONFIG_DIR=base.GH_CONFIG_DIR;
    const r=await(this.deps.run??runPlatformCliProcess)({executable,args:['auth','status','--hostname','github.com','--json','hosts'],cwd:this.store.appDirectory,env,timeoutMs:15_000,account:{id:'native-github',provider:'github',label:'GitHub',identity:null,state:'unchecked',revision:''}});
    let rows:any;try{rows=JSON.parse(r.stdout).hosts?.['github.com'];}catch{}
    if(!Array.isArray(rows))throw new PlatformCliError('기존 GitHub 로그인 목록을 확인하지 못했습니다.');
    const result=new Map<string,{login:string;active:boolean}>();
    for(const row of rows)if(row.state==='success'&&typeof row.login==='string'&&/^[A-Za-z0-9-]{1,39}$/.test(row.login))result.set(row.login.toLowerCase(),{login:row.login,active:row.active===true});
    return [...result.values()].slice(0,64);
  }
  async nativeGithubAccounts():Promise<string[]> {return(await this.nativeGithubLogins()).map(a=>a.login);}
  async accounts(provider?:PlatformCliProvider):Promise<PlatformCliAccount[]> {
    let native:{login:string;active:boolean}[]=[];
    if(!provider||provider==='github')try{native=await this.nativeGithubLogins();}catch{/* Defaults remain available; prepare/run reports a missing login. */}
    const choices=this.store.deviceDefaults();
    const defaults=(provider?[provider]:PLATFORM_CLI_PROVIDERS).map((p):PlatformCliAccount=>{
      const choice=choices[p],account=choice?.accountId?this.store.list(p).find(a=>a.id===choice.accountId&&a.state==='ready'&&a.verifiedEmail===choice.email):null;
      return {id:PLATFORM_CLI_DEFAULT_ACCOUNT,provider:p,label:choice?`기기 기본값 · ${choice.email}`:'현재 CLI 로그인 · 기본',identity:choice?(account?.identity??null):p==='github'&&!this.githubEnvironmentToken()?native.find(a=>a.active)?.login??null:null,state:choice&&!account?'login-required':'ready',revision:'',source:'default'};
    });
    return [...defaults,...this.store.list(provider),...native.map(a=>({id:platformCliNativeGithubId(a.login),provider:'github' as const,label:a.login+' · 기존 로그인',identity:a.login,state:'ready' as const,revision:'',source:'native' as const,active:a.active}))];
  }
  private githubEnvironmentToken(){const env=this.deps.env??process.env;return env.GH_TOKEN||env.GITHUB_TOKEN||null;}
  private async nativeGithubToken(login:string):Promise<string> {
    const r=await this.nativeGithub(['auth','token','--hostname','github.com','--user',login]);
    if(r.code!==0||!r.stdout.trim()||r.stdout.trim().length>512||/[\r\n\s]/.test(r.stdout.trim()))throw new PlatformCliError('선택한 GitHub 로그인 정보를 확인하지 못했습니다. 다른 계정으로 실행하지 않았습니다.');
    return r.stdout.trim();
  }
  /** Resolve the default once; reviewed/in-flight work retains the resolved login and credential revision. */
  async account(id:string,provider:PlatformCliProvider):Promise<PlatformCliAccount> {
    if(id===PLATFORM_CLI_DEFAULT_ACCOUNT)id=this.store.defaultAccountId(provider);
    if(platformCliManagedId(id)){const a=this.store.account(id);if(a.provider!==provider||a.state!=='ready')throw new PlatformCliError('연결 상태를 확인한 같은 CLI 계정을 선택하세요.');return a;}
    if(provider!=='github'){
      if(id!==PLATFORM_CLI_DEFAULT_ACCOUNT)throw new PlatformCliError('선택한 CLI 계정을 사용할 수 없습니다.');
      return {id,provider,label:PLATFORM_CLI_LABELS[provider]+' · 현재 로그인',identity:null,state:'ready',revision:'native-default-v1',source:'default'};
    }
    if((id===PLATFORM_CLI_DEFAULT_ACCOUNT&&this.githubEnvironmentToken())||id==='pcli_environment'){
      const secret=this.githubEnvironmentToken();if(!secret)throw new PlatformCliError('현재 GitHub 환경 로그인이 변경되었습니다. 다시 확인하세요.');
      const env=platformCliEnvironment(this.deps.env??process.env);env.GH_TOKEN=secret;env.GH_HOST='github.com';
      const executable=this.deps.executable('github');if(!executable||!isAbsolute(executable))throw new PlatformCliError('GitHub CLI를 설치한 뒤 다시 확인하세요.');
      const r=await(this.deps.run??runPlatformCliProcess)({executable,args:['api','user'],cwd:this.store.appDirectory,env,timeoutMs:15_000,account:{id:'pcli_environment',provider,label:'현재 GitHub 환경 로그인',identity:null,state:'unchecked',revision:'',source:'native'}});
      let v:any;try{v=JSON.parse(r.stdout);}catch{}
      if(r.code!==0||!v||!/^[A-Za-z0-9-]{1,39}$/.test(v.login)||!Number.isSafeInteger(v.id))throw new PlatformCliError('현재 GitHub CLI 로그인 계정을 확인하지 못했습니다.');
      return {id:'pcli_environment',provider,label:'현재 GitHub CLI 로그인',identity:v.login,state:'ready',revision:platformCliHash('pcli_environment'+secret),source:'native'};
    }
    const rows=await this.nativeGithubLogins();
    const login=id===PLATFORM_CLI_DEFAULT_ACCOUNT?(rows.filter(a=>a.active).length===1?rows.find(a=>a.active):null)?.login:rows.find(a=>platformCliNativeGithubId(a.login)===id)?.login;
    if(!login)throw new PlatformCliError('현재 GitHub 로그인 또는 선택한 기존 로그인을 확인하세요.');
    const accountId=platformCliNativeGithubId(login),secret=await this.nativeGithubToken(login);
    const account:PlatformCliAccount={id:accountId,provider,label:login+' · 기존 로그인',identity:login,state:'ready',revision:platformCliHash(accountId+secret),source:'native'};
    await this.using(account,{id:'account-check',cwd:this.store.appDirectory,label:'기존 로그인 확인'},['api','user'],async execution=>{
      execution.timeoutMs=15_000;const r=await(this.deps.run??runPlatformCliProcess)(execution);let value:any;try{value=JSON.parse(r.stdout);}catch{}
      if(r.code!==0||value?.login?.toLowerCase()!==login.toLowerCase()||!Number.isSafeInteger(value?.id))throw new PlatformCliError('선택한 GitHub 로그인과 실제 계정이 일치하지 않습니다.');
    });return account;
  }
  private async credential(account:PlatformCliAccount):Promise<string> {
    if(platformCliManagedId(account.id))return this.store.credential(account);
    const login=platformCliNativeGithubLogin(account.id);
    const secret=account.id==='pcli_environment'?this.githubEnvironmentToken():login&&account.identity?.toLowerCase()===login?await this.nativeGithubToken(account.identity):null;
    if(!secret||platformCliHash(account.id+secret)!==account.revision)throw new PlatformCliError('선택한 CLI 인증 정보가 변경되었습니다. 다른 계정으로 실행하지 않았습니다.');
    return secret;
  }
  async assertCurrent(account:PlatformCliAccount) {
    if(account.source==='default'&&account.provider!=='github')return;
    await this.credential(account);
  }
  async bind(targetId:string,provider:PlatformCliProvider,value:unknown,requestId:string) {
    const binding=platformCliBinding(value);
    if(binding.accountId!==PLATFORM_CLI_DEFAULT_ACCOUNT)await this.account(binding.accountId,provider);
    return this.store.bind(targetId,provider,binding,requestId);
  }
  async connectNativeGithub(login:string,requestId:string) {
    platformCliRequestId(requestId);const createId=platformCliHash(requestId+':connect-create'),checkId=platformCliHash(requestId+':connect-check');
    if(!/^[A-Za-z0-9-]{1,39}$/.test(login)||!(await this.nativeGithubAccounts()).includes(login))throw new PlatformCliError('현재 로그인 목록에서 GitHub 계정을 선택하세요.');
    const existing=this.store.list('github').find(a=>a.identity===login);
    if(existing)return this.check(existing.id,checkId);
    const r=await this.nativeGithub(['auth','token','--hostname','github.com','--user',login]);
    if(r.code!==0)throw new PlatformCliError('선택한 GitHub 로그인 정보를 확인하지 못했습니다.');
    const account=await this.store.create('github',login,r.stdout.trim(),createId);
    const checked=await this.check(account.id,checkId);
    if(checked.identity!==login){await this.store.archive(account.id,randomUUID());throw new PlatformCliError('선택한 GitHub 계정과 실제 로그인 계정이 일치하지 않습니다.');}
    return checked;
  }
  async using<T>(account:PlatformCliAccount,project:PlatformCliProject,args:string[],callback:(execution:PlatformCliExecution)=>Promise<T>):Promise<T> {
    if(account.provider==='vercel'&&platformCliManagedId(account.id))return withOwnedPortalFileLock(join(this.store.root,account.id+'.oauth.lock'),()=>this.usingUnlocked(account,project,args,callback),{label:'Vercel OAuth session',attempts:2,retryMs:20,deadOwnerRecoveryClass:'manual',canRecoverDeadOwner:()=>false});
    return this.usingUnlocked(account,project,args,callback);
  }
  private async usingUnlocked<T>(account:PlatformCliAccount,project:PlatformCliProject,args:string[],callback:(execution:PlatformCliExecution)=>Promise<T>):Promise<T> {
    const executable=this.deps.executable(account.provider);
    if(!executable||!isAbsolute(executable))throw new PlatformCliError('이 CLI가 설치되어 있지 않습니다. 공식 CLI를 설치한 뒤 다시 확인하세요.');
    const base=this.deps.env??process.env,env=platformCliEnvironment(base);
    const nativeDefault=account.source==='default'&&account.id===PLATFORM_CLI_DEFAULT_ACCOUNT&&account.provider!=='github';
    const secret=nativeDefault?null:await this.credential(account);
    let temporary:string|undefined;
    const prefix:string[]=[];
    try {
      if(nativeDefault){
        // With no explicit account, retain this provider's native login and the project's own link.
        for(const key of Object.keys(base))if(account.provider==='vercel'&&key==='VERCEL_TOKEN'||account.provider==='supabase'&&key==='SUPABASE_ACCESS_TOKEN'||account.provider==='google-workspace'&&(/^GOOGLE_WORKSPACE_/.test(key)||key==='GOOGLE_APPLICATION_CREDENTIALS'))env[key]=base[key];
      }
      if(account.provider==='github'){env.GH_TOKEN=secret!;env.GH_HOST='github.com';}
      if(account.provider==='supabase'&&!nativeDefault)env.SUPABASE_ACCESS_TOKEN=secret!;
      if(!nativeDefault&&(account.provider==='supabase'||account.provider==='vercel'||account.provider==='google-workspace')) {
        // Each invocation owns its temporary files, including concurrent invocations of one account.
        temporary=mkdtempSync(join(this.store.root,'run-'));mkdirSync(join(temporary,'config'),{mode:0o700});
        if(account.provider==='supabase'){
          // The CLI initializes ~/.supabase even with an explicit access token.
          // Keep native profiles/endpoints and telemetry outside managed runs.
          env.HOME=temporary;env.USERPROFILE=temporary;env.XDG_CONFIG_HOME=join(temporary,'config');
          env.XDG_DATA_HOME=join(temporary,'data');
        }else if(account.provider==='vercel'){
          writeFileSync(join(temporary,'config','auth.json'),secret!.startsWith('{')?secret!:JSON.stringify({token:secret}),{mode:0o600});
          prefix.push('--global-config',join(temporary,'config'));
        } else {
          const file=join(temporary,'oauth.json');writeFileSync(file,secret!,{mode:0o600});
          env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR=join(temporary,'config');env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=file;
          // gws encrypts its token cache even for an explicit OAuth file. Keep its
          // disposable encryption key beside that cache, as in the login sandbox.
          env.GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND='file';
          // A missing client config otherwise lets gws read the host's gcloud ADC
          // quota project. That can charge or reject the selected account against
          // an unrelated Google project even though its OAuth credential is correct.
          env.HOME=temporary;env.USERPROFILE=temporary;env.XDG_CONFIG_HOME=join(temporary,'config');
          env.GOOGLE_APPLICATION_CREDENTIALS='';env.GOOGLE_WORKSPACE_PROJECT_ID='';
          // dotenvy preserves an existing variable, even empty. Prevent a project's .env
          // from introducing a higher-priority access token ahead of this credential file.
          env.GOOGLE_WORKSPACE_CLI_TOKEN='';
        }
      }
      if(platformCliManagedId(account.id)&&this.store.account(account.id).revision!==account.revision)throw new PlatformCliError('CLI 계정이 변경되었습니다.');
      return await callback({executable,args:[...prefix,...args],env,cwd:project.cwd,account});
    } finally {
      try{if(temporary&&account.provider==='vercel'&&secret?.startsWith('{')){
        const updated=readPrivateFileStrict(join(temporary,'config','auth.json'));
        if(!updated)throw new PlatformCliError('OAuth 갱신 결과를 확인하지 못했습니다.');
        await this.store.refreshed(account,updated);
      }}finally{if(temporary)rmSync(temporary,{recursive:true,force:true});}
    }
  }
  async check(accountId:string,requestId:string=randomUUID()) {
    const account=this.store.account(accountId),project={id:'account-check',cwd:this.store.root,label:'계정 확인'};
    const args:Record<PlatformCliProvider,string[]>={github:['api','user'],vercel:['whoami'],supabase:['projects','list','--output','json'],'google-workspace':['drive','about','get','--params','{"fields":"user(emailAddress)"}']};
    const checked=await this.using(account,project,args[account.provider],async execution=>{
      execution.timeoutMs=15_000;
      const r=await(this.deps.run??runPlatformCliProcess)(execution);
      if(r.code!==0)throw new PlatformCliError('선택한 계정의 연결을 확인하지 못했습니다. 토큰·권한·CLI 설치 상태를 확인하세요.');
      let identity:string|null=null;
      try {
        if(account.provider==='github'){const v=JSON.parse(r.stdout);if(!/^[A-Za-z0-9-]{1,39}$/.test(v.login)||!Number.isSafeInteger(v.id))throw new PlatformCliError();identity=v.login;}
        if(account.provider==='vercel'){const v=r.stdout.trim();if(!/^[A-Za-z0-9_.@-]{1,120}$/.test(v))throw new PlatformCliError();identity=v;}
        if(account.provider==='supabase'&&!Array.isArray(JSON.parse(r.stdout)))throw new PlatformCliError();
        if(account.provider==='google-workspace'){const v=JSON.parse(r.stdout);if(typeof v.user?.emailAddress!=='string'||v.user.emailAddress.length>120)throw new PlatformCliError();identity=v.user.emailAddress;}
      }catch{throw new PlatformCliError('CLI의 계정 확인 응답을 해석하지 못했습니다. 계정은 변경하지 않았습니다.');}
      return this.store.checked(account,identity,requestId);
    });
    return this.store.account(checked.id);
  }
  /** For a connected local SDK/CLI host. Caller owns authorization for the supplied command. */
  async run(targetId:string,provider:PlatformCliProvider,args:string[]):Promise<PlatformCliProcess> {
    if(!platformCliProvider(provider)||!Array.isArray(args)||!args.length||args.length>128||args.some(a=>typeof a!=='string'||a.length>8192||/[\x00\r\n]/.test(a)))throw new PlatformCliError('CLI 명령 인수를 확인하세요.');
    // Per-command credentials or config overrides must not replace the selected account or target.
    const forbidden=/^(?:--(?:token|global-config|scope|team|profile|project|project-ref|repo|cwd|workdir|access-token|config-dir|account|impersonate|credentials)(?:=|$)|-[tQSTAR](?:$|.))/;
    if(args.some(a=>forbidden.test(a)||/^--(?:hostname|host|header)(?:=|$)/.test(a)||provider==='github'&&(/^-H/.test(a)||/^https?:\/\//.test(a)))||['auth','login','logout','config'].includes(args[0]!))throw new PlatformCliError('계정·대상 변경은 프로젝트의 CLI 연결 설정에서 실행하세요.');
    const project=await this.deps.resolveProject(targetId),binding=this.store.binding(targetId,provider);
    const account=await this.account(binding?.accountId??PLATFORM_CLI_DEFAULT_ACCOUNT,provider);
    const command=[...args];
    if(provider==='vercel'){
      if(binding?.scope)command.push('--scope',binding.scope);
      if(!binding?.resourceId&&account.source!=='default')throw new PlatformCliError('Vercel 프로젝트 ID를 먼저 지정하세요.');
    }
    if(provider==='supabase'){
      // Only Management API commands with an explicit project ref are exposed here.
      // Database-password commands need their own per-project connection, not a PAT account alone.
      const accountRead=(args[0]==='projects'||args[0]==='orgs')&&args[1]==='list';
      if(!accountRead&&(args[0]!=='functions'||!['list','deploy','delete','download'].includes(args[1]!)))throw new PlatformCliError('이 연결 실행기는 Supabase functions 명령을 지원합니다. DB 연결은 별도로 확인하세요.');
      if(!accountRead&&((!binding?.resourceId&&account.source!=='default')||(binding?.resourceId&&!/^[a-z0-9]{20}$/.test(binding.resourceId))))throw new PlatformCliError('Supabase 프로젝트 ref를 먼저 지정하세요.');
      if(!accountRead&&binding?.resourceId)command.push('--project-ref',binding.resourceId);
    }
    return this.using(account,project,command,async execution=>{
      execution.timeoutMs=600_000;
      if(provider==='github'&&binding?.resourceId)execution.env.GH_REPO=binding.resourceId;
      if(provider==='vercel'&&binding?.resourceId)execution.env.VERCEL_PROJECT_ID=binding.resourceId;
      if(provider==='google-workspace'&&binding?.resourceId)execution.env.GOOGLE_WORKSPACE_PROJECT_ID=binding.resourceId;
      if(account.source!=='default'&&binding?.resourceId&&(provider==='supabase'||provider==='vercel')){
        let secret=await this.credential(account);const json=this.deps.json??platformCliJson;
        if(provider==='vercel'&&secret.startsWith('{')){
          // Let the official CLI refresh its OAuth session before the fixed API preflight.
          const check=await(this.deps.run??runPlatformCliProcess)({...execution,args:execution.args.slice(0,2).concat('whoami'),timeoutMs:15_000});
          if(check.code!==0||check.stdout.trim()!==account.identity)throw new PlatformCliError('Vercel 로그인 갱신 또는 계정 확인이 필요합니다.');
          secret=readPrivateFileStrict(join(execution.args[1]!,'auth.json'))??'';
          if(!secret)throw new PlatformCliError('갱신된 Vercel 로그인을 읽지 못했습니다.');
        }
        const url=provider==='supabase'?'https://api.supabase.com/v1/projects/'+encodeURIComponent(binding.resourceId):'https://api.vercel.com/v9/projects/'+encodeURIComponent(binding.resourceId)+(binding.scope?'?slug='+encodeURIComponent(binding.scope):'');
        const value=await json(url,provider==='vercel'&&secret.startsWith('{')?JSON.parse(secret).token:secret);
        if(value?.id!==binding.resourceId)throw new PlatformCliError('선택한 계정과 배포 프로젝트가 일치하지 않습니다.');
      }
      if(JSON.stringify(this.store.binding(targetId,provider))!==JSON.stringify(binding))throw new PlatformCliError('프로젝트의 CLI 연결이 변경되었습니다. 다시 실행하세요.');
      await this.assertCurrent(account);
      return(this.deps.run??runPlatformCliProcess)(execution);
    });
  }
}
