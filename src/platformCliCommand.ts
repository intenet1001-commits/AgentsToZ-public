import {execFileSync} from 'node:child_process';
import {readFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {resolveAppDataDirFromEnvironment} from './appDataDir';
import {PlatformCliHost} from './platformCliHost';
import {PlatformCliStore} from './platformCliStore';
import {PlatformGithubPush} from './platformGithubPush';
import {platformCliProvider,PLATFORM_CLI_PROVIDERS,platformCliPublicError,PlatformCliError} from './platformCliProtocol';
import {handlePlatformCliRequest} from './platformCliRequest';

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
    const host=new PlatformCliHost({store:new PlatformCliStore(appData),executable:p=>Bun.which(({github:'gh',vercel:'vercel',supabase:'supabase','google-workspace':'gws'})[p]),resolveProject:async id=>{
      const current=platformCliLocalProject(appData,cwd,id,git);if(current.id!==project.id)throw new PlatformCliError('현재 프로젝트가 변경되었습니다.');return current;
    }});
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
