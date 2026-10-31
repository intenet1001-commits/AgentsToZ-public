import {execFileSync} from 'node:child_process';
import {readFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {resolveAppDataDirFromEnvironment} from './appDataDir';
import {PlatformCliHost,platformCliEnvironment} from './platformCliHost';
import {PlatformCliStore} from './platformCliStore';
import {PlatformGithubPush} from './platformGithubPush';
import {platformCliProvider,PLATFORM_CLI_PROVIDERS,platformCliPublicError,PlatformCliError} from './platformCliProtocol';
import {handlePlatformCliRequest,platformNativeSwitch,registerPlatformNativeSwitch} from './platformCliRequest';
import {PlatformNativeSwitch} from './platformCliNativeSwitch';
import {PLATFORM_CLI_BINARIES,PLATFORM_GIT_FALLBACK_ENV,gitFallbackHelpers,gitHelperEnvironment,parseGitCredential,platformCliGitFiles,platformCliProjectAccountId,platformCliRealExecutable,platformCliRevealsToken,platformCliShimTarget,readMacGithubCredentialChain,runAttached,runGitHelper} from './platformCliWorkroom';
import {agentsToZUseMcpLauncherPath} from './agentsToZUseMcpLauncher';
import {homedir} from 'node:os';

export function parsePlatformCliCommand(args:string[]) {
  const provider=args[0];if(provider!=='status'&&!platformCliProvider(provider))throw new PlatformCliError('사용법: agentstoz-use-mcp cli <github|vercel|supabase|google-workspace|status> [--project ID] [--account ID] [--remote NAME] [--yes] -- 명령 인수');
  let projectId:string|undefined,accountId:string|undefined,remote:string|undefined,yes=false,command:string[]=[];
  for(let i=1;i<args.length;i++){
    const a=args[i];if(a==='--'){command=args.slice(i+1);break;}
    if(a==='--yes'){yes=true;continue;}
    if(!['--project','--account','--remote'].includes(a!)||!args[i+1])throw new PlatformCliError('CLI 실행 옵션을 확인하세요. 명령 앞에는 --를 넣으세요.');
    const value=args[++i]!;if(a==='--project')projectId=value;if(a==='--account')accountId=value;if(a==='--remote')remote=value;
  }
  return {provider,projectId,accountId,remote,yes,command};
}
/** Resolve cwd against the fresh app registry and Git-owned main/worktree identity. */
export function platformCliLocalProject(appDataDir:string,cwd:string,requestedId?:string,git='git') {
  const directory=realpathSync(cwd);let roots=[directory];
  try{
    const root=execFileSync(git,['rev-parse','--show-toplevel'],{cwd:directory,encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:3000}).trim();
    const families=execFileSync(git,['worktree','list','--porcelain'],{cwd:directory,encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:3000}).split('\n').filter(x=>x.startsWith('worktree '));
    roots=[realpathSync(root),...(families[0]?[realpathSync(families[0].slice(9))]:[])];
  }catch{/* Non-Git projects still require an exact registered directory. */}
  const ports=JSON.parse(readFileSync(join(appDataDir,'ports.json'),'utf8'));
  if(!Array.isArray(ports))throw new PlatformCliError('이 기기의 프로젝트 등록 목록을 확인하세요.');
  const matches=ports.filter(p=>p&&typeof p.id==='string'&&typeof p.folderPath==='string'&&(!requestedId||p.id===requestedId)).filter(p=>{try{return roots.includes(realpathSync(p.folderPath));}catch{return false;}});
  if(matches.length!==1)throw new PlatformCliError('현재 폴더에 해당하는 등록 프로젝트를 하나로 확인하지 못했습니다. --project ID로 지정하세요.');
  const row=matches[0];return {id:row.id as string,cwd:directory,label:String(row.aiName||row.name||row.id).slice(0,120)};
}
export async function runPlatformCliCommand(args:string[],cwd=process.cwd()):Promise<number> {
  try{
    const options=parsePlatformCliCommand(args),appData=resolveAppDataDirFromEnvironment(),git=Bun.which('git');
    if(!git)throw new PlatformCliError('Git을 설치한 뒤 다시 실행하세요.');
    const project=platformCliLocalProject(appData,cwd,options.projectId,git);
    const host:PlatformCliHost=new PlatformCliHost({store:new PlatformCliStore(appData),executable:p=>Bun.which(({github:'gh',vercel:'vercel',supabase:'supabase','google-workspace':'gws'})[p]),resolveProject:async id=>{
      const current=platformCliLocalProject(appData,cwd,id,git);if(current.id!==project.id)throw new PlatformCliError('현재 프로젝트가 변경되었습니다.');return current;
    },nativeVercelConfig:(account):Promise<string|null>=>platformNativeSwitch(host).vercelLive(account)});
    registerPlatformNativeSwitch(host,new PlatformNativeSwitch(host,{git}));
    if(options.provider==='status'){
      console.log(JSON.stringify({project:{id:project.id,label:project.label},accounts:await host.accounts(),deviceDefaults:host.store.deviceDefaults(),bindings:Object.fromEntries(PLATFORM_CLI_PROVIDERS.map(p=>[p,host.store.binding(project.id,p)]))},null,2));return 0;
    }
    if(options.provider==='github'&&options.command[0]==='push'){
      if(options.command.length!==1)throw new PlatformCliError('GitHub 푸시 대상은 --account·--remote 옵션과 프로젝트 연결에서 선택하세요.');
      const push=new PlatformGithubPush(host,git),r=await handlePlatformCliRequest(host,push,{operation:'prepare-push',targetId:project.id,...(options.accountId?{accountId:options.accountId}:{}),...(options.remote?{remote:options.remote}:{})});
      console.log(JSON.stringify(r,null,2));
      if(r.selectionRequired)throw new PlatformCliError('사용할 계정과 원격을 선택하세요. 여러 후보를 임의로 선택하지 않았습니다.');
      if(!options.yes){console.error('푸시하려면 표시된 계정·저장소·브랜치를 확인하고 --yes를 지정하세요.');return 2;}
      const plan=r.plan as {id:string};const receipt=await push.execute(project.id,plan.id,crypto.randomUUID());console.log(JSON.stringify({receipt},null,2));return receipt.state==='completed'?0:1;
    }
    if(options.accountId||options.remote||options.yes)throw new PlatformCliError('이 명령은 프로젝트에 연결된 계정을 사용합니다. 별도 계정·원격 옵션은 GitHub push에서 지원합니다.');
    if(!platformCliProvider(options.provider))throw new PlatformCliError('지원하는 CLI를 선택하세요.');
    const result=await host.run(project.id,options.provider,options.command);process.stdout.write(result.stdout);
    // Native error output can contain credentials. Keep provider stderr out of agent transcripts.
    if(result.code!==0)console.error('선택한 계정의 CLI 명령이 완료되지 않았습니다. 대상·권한·연결 상태를 확인하세요.');return result.code===0?0:1;
  }catch(error){console.error(platformCliPublicError(error));return 1;}
}

type LocalProject=ReturnType<typeof platformCliLocalProject>;
function localHost(appData:string,git:string,project:LocalProject,real?:{provider:string;path:string}):PlatformCliHost {
  const host:PlatformCliHost=new PlatformCliHost({store:new PlatformCliStore(appData),executable:p=>real&&p===real.provider?real.path:platformCliRealExecutable(p,process.env,join(appData,'platform-cli-v1','shims')),
    resolveProject:async()=>project,nativeVercelConfig:(account):Promise<string|null>=>platformNativeSwitch(host).vercelLive(account)});
  registerPlatformNativeSwitch(host,new PlatformNativeSwitch(host,{git}));
  return host;
}
/** The registered project of this folder, or null when it is not one (then the CLI runs exactly as this Mac would). */
function workroomProject(cwd:string):{appData:string;git:string;project:LocalProject}|null {
  try{
    const appData=resolveAppDataDirFromEnvironment(),git=Bun.which('git');if(!git)return null;
    return {appData,git,project:platformCliLocalProject(appData,cwd,undefined,git)};
  }catch{return null;}
}

/**
 * `cli-exec <provider> --real <path> -- args`: the Workroom shim. With a project account, the official CLI runs
 * attached to this terminal under that account; without one, it runs untouched. Never another account.
 */
export async function runPlatformCliExec(args:string[],cwd=process.cwd()):Promise<number> {
  const provider=args[0];
  if(!platformCliProvider(provider)||args[1]!=='--real'||!args[2]||args[3]!=='--'){console.error('사용법: agentstoz-use-mcp cli-exec <github|supabase|vercel|google-workspace> --real <경로> -- 명령 인수');return 2;}
  // A CLI reinstalled elsewhere since the shim was written is found on PATH again — never the shim itself.
  const real=platformCliShimTarget(provider,args[2])??platformCliRealExecutable(provider,process.env,join(resolveAppDataDirFromEnvironment(),'platform-cli-v1','shims')),command=args.slice(4);
  if(!real){console.error(`${PLATFORM_CLI_BINARIES[provider]} 실행 파일을 찾지 못했습니다.`);return 127;}
  const local=workroomProject(cwd);
  if(!local)return runAttached(real,command,process.env,cwd);
  try{
    const binding=new PlatformCliStore(local.appData).binding(local.project.id,provider),accountId=platformCliProjectAccountId(binding);
    if(!accountId)return runAttached(real,command,process.env,cwd);
    if(platformCliRevealsToken(provider,command))throw new PlatformCliError('이 프로젝트에 연결된 계정의 토큰은 보여주지 않습니다. 다른 gh 명령은 그 계정으로 그대로 실행됩니다.');
    const host=localHost(local.appData,local.git,local.project,{provider,path:real});
    const account=await host.account(accountId,provider);
    return await host.using(account,local.project,command,async execution=>{
      // This terminal's own environment, plus only what selects the account.
      const baseline=platformCliEnvironment(process.env),env:NodeJS.ProcessEnv={...process.env};
      for(const [key,value] of Object.entries(execution.env))if(baseline[key]!==value)env[key]=value;
      if(provider==='vercel')delete env.VERCEL_TOKEN;
      return runAttached(execution.executable,execution.args,env,cwd);
    });
  }catch(error){console.error(`[AgentsToZ] ${platformCliPublicError(error)}`);return 1;}
}

/**
 * `git-credential <get|store|erase>`: git asks this first for github.com inside a Workroom. A project with its own
 * GitHub account answers with it; any other request goes to this Mac's own helpers, unchanged and in order.
 */
export async function runPlatformGitCredential(args:string[],cwd=process.cwd()):Promise<number> {
  const action=args[0];if(action!=='get'&&action!=='store'&&action!=='erase')return 0;
  const input=(await Bun.stdin.text()).slice(0,64*1024),fields=parseGitCredential(input);
  const viaMac=async()=>{
    const env=gitHelperEnvironment(process.env);
    // A Workroom names this Mac's helpers; elsewhere git's own config does, without AgentsToZ's routing.
    const named=process.env[PLATFORM_GIT_FALLBACK_ENV],git=Bun.which('git');
    const chain=named!==undefined?gitFallbackHelpers(named):git?await readMacGithubCredentialChain(git,cwd,env,{...platformCliGitFiles(join(resolveAppDataDirFromEnvironment(),'platform-cli-v1')),launcher:agentsToZUseMcpLauncherPath(homedir())})??[]:[];
    for(const spec of chain){
      const output=await runGitHelper(spec,action,input,env);
      if(action==='get'){const got=parseGitCredential(output);if(got.password||got.quit){process.stdout.write(output);return 0;}}
    }
    return 0;
  };
  if(fields.protocol!=='https'||(fields.host??'').toLowerCase()!=='github.com')return viaMac();
  const local=workroomProject(cwd);if(!local)return viaMac();
  try{
    const accountId=platformCliProjectAccountId(new PlatformCliStore(local.appData).binding(local.project.id,'github'));
    if(!accountId)return viaMac();
    // Nothing of the project's account is kept in, or removed from, this Mac's own helpers.
    if(action!=='get')return 0;
    const host=localHost(local.appData,local.git,local.project),account=await host.account(accountId,'github');
    const token=await host.using(account,local.project,[],async execution=>execution.env.GH_TOKEN);
    if(!token)throw new PlatformCliError('GitHub 계정 정보를 확인하지 못했습니다.');
    process.stdout.write(`username=${account.identity??'x-access-token'}\npassword=${token}\n`);return 0;
  }catch(error){
    // Fail closed: git must not fall through to this Mac's other GitHub login.
    console.error(`[AgentsToZ] ${platformCliPublicError(error)} 프로젝트 화면의 CLI 계정에서 GitHub 계정을 확인하세요.`);
    process.stdout.write('quit=1\n');return 0;
  }
}
