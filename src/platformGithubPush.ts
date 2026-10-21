import {PlatformCliError} from './platformCliProtocol';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {PlatformCliHost,runPlatformCliProcess,type PlatformCliExecution,type PlatformCliProcess,type PlatformCliProject} from './platformCliHost';
import {platformCliHash} from './platformCliStore';
import {PLATFORM_CLI_DEFAULT_ACCOUNT,platformCliRequestId,platformCliText,type PlatformCliAccount} from './platformCliProtocol';
import {readPrivateFileStrict,writePrivateFileAtomically,pathEntryExists} from './remoteControlHostVault';
import {withOwnedPortalFileLock} from './portalFileLock';

export interface GithubPushPlan {id:string;targetId:string;projectLabel:string;accountId:string;accountLabel:string;identity:string;remote:string;repository:string;branch:string;head:string;expiresAt:number}
interface PrivatePlan {view:GithubPushPlan;account:PlatformCliAccount;project:PlatformCliProject;repositoryId:string;folderPath?:string;state:'ready'|'executing'|'done'}
interface PushReceipt {requestId:string;fingerprint:string;targetId:string;planId:string;state:'executing'|'completed'|'failed';repository:string;branch:string;commit:string;at:number}
const quote=(v:string)=>"'"+v.replaceAll("'","'\\''")+"'";
export function platformGithubRepository(value:string):string {
  const v=value.trim();const m=/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*?)(?:\.git)?$/.exec(v);
  if(!m||m[1]!.split('/').some(v=>v==='.'||v==='..'))throw new PlatformCliError('GitHub.com 저장소 주소를 확인하세요.');return m[1]!;
}
export class PlatformGithubPush {
  private plans=new Map<string,PrivatePlan>();
  constructor(readonly host:PlatformCliHost,readonly gitExecutable:string,private readonly run=runPlatformCliProcess){}
  /** Existing authorized project-push callers can reuse the broker without receiving credentials. */
  async pushDefault(targetId:string,requestId:string,folderPath?:string) {
    platformCliRequestId(requestId);
    const file=join(this.host.store.root,'push-receipts.json'),raw=readPrivateFileStrict(file);
    if(raw===null&&pathEntryExists(file))throw new PlatformCliError('이전 푸시 기록을 확인하지 못했습니다. 다시 전송하지 않았습니다.');
    if(raw){
      if(raw.length>512*1024)throw new PlatformCliError('푸시 기록 한도를 확인하세요.');
      const rows=JSON.parse(raw);if(!Array.isArray(rows)||rows.length>512)throw new PlatformCliError('푸시 기록을 확인하세요.');
      const old=rows.find(r=>r?.requestId===requestId);
      if(old){if(old.targetId!==targetId||!['executing','completed','failed'].includes(old.state))throw new PlatformCliError('푸시 요청 ID를 확인하세요.');return {...old,replayed:true};}
    }
    const options=await this.options(targetId,folderPath);
    if(!options.defaultRemote)throw new PlatformCliError('이 프로젝트에 연결한 GitHub 원격을 확인하세요. 다른 저장소로 푸시하지 않았습니다.');
    const plan=await this.prepare(targetId,options.defaultAccountId,options.defaultRemote,folderPath);
    return this.execute(targetId,plan.id,requestId);
  }
  private async git(project:PlatformCliProject,args:string[],account?:PlatformCliAccount,template?:PlatformCliExecution):Promise<PlatformCliProcess> {
    return this.run({executable:this.gitExecutable,args,cwd:project.cwd,env:template?.env??{...process.env,GIT_TERMINAL_PROMPT:'0'},account:account??{id:'',provider:'github',label:'',identity:null,state:'unchecked',revision:''}});
  }
  private async snapshot(project:PlatformCliProject,remote:string) {
    if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(remote))throw new PlatformCliError('등록된 Git 원격을 선택하세요.');
    const r=await this.git(project,['remote','get-url','--push','--all',remote]);
    const urls=r.stdout.trim().split(/\r?\n/).filter(Boolean);
    if(r.code||urls.length!==1)throw new PlatformCliError('전송 주소가 하나인 Git 원격을 선택하세요.');
    const repository=platformGithubRepository(urls[0]!);
    const branch=await this.git(project,['symbolic-ref','--quiet','--short','HEAD']);
    const head=await this.git(project,['rev-parse','--verify','HEAD']);
    if(branch.code||head.code||!branch.stdout.trim()||!/^[0-9a-f]{40,64}$/.test(head.stdout.trim()))throw new PlatformCliError('브랜치에 연결된 커밋이 있어야 푸시할 수 있습니다.');
    const ref=await this.git(project,['check-ref-format','refs/heads/'+branch.stdout.trim()]);if(ref.code)throw new PlatformCliError('푸시할 브랜치를 확인하세요.');
    // A local rewrite or HTTP credential header could override the reviewed destination/account.
    const config=await this.git(project,['config','--local','--includes','--name-only','--get-regexp','^(url\\..*\\.(insteadof|pushinsteadof)|http\\..*(extraheader|cookiefile|sslverify|proxy)|credential\\..*)$']);
    if(config.stdout.trim())throw new PlatformCliError('저장소의 URL 재작성·HTTP 인증 설정을 확인해야 합니다. 선택한 계정으로 푸시하지 않았습니다.');
    if(config.code!==0&&config.code!==1)throw new PlatformCliError('Git 저장소 설정을 확인하지 못했습니다.');
    return {repository,branch:branch.stdout.trim(),head:head.stdout.trim()};
  }
  async options(targetId:string,folderPath?:string) {
    const project=await this.host.deps.resolveProject(targetId,folderPath),r=await this.git(project,['remote']);
    if(r.code)throw new PlatformCliError('등록 프로젝트의 Git 원격을 조회하지 못했습니다.');
    const remotes:{name:string;repository:string}[]=[];
    for(const name of r.stdout.trim().split(/\r?\n/).filter(Boolean).slice(0,32)){
      try{const s=await this.snapshot(project,name);remotes.push({name,repository:s.repository});}catch{/* Unsafe or non-GitHub remotes are not candidates. */}
    }
    const binding=this.host.store.binding(targetId,'github');
    const matched=binding?.resourceId?remotes.filter(r=>r.repository.toLowerCase()===binding.resourceId.toLowerCase()):[];
    // An explicit repository that disappeared must never fall back to a different origin.
    const defaultRemote=binding?.resourceId?(matched.length===1?matched[0]!.name:null):remotes.some(r=>r.name==='origin')?'origin':remotes.length===1?remotes[0]!.name:null;
    return {targetId,projectLabel:project.label,accounts:(await this.host.accounts('github')).filter(a=>a.state==='ready'||a.source==='default'),binding,defaultAccountId:binding?.accountId??PLATFORM_CLI_DEFAULT_ACCOUNT,defaultRemote,remotes};
  }
  private async repository(account:PlatformCliAccount,project:PlatformCliProject,repository:string) {
    return this.host.using(account,project,['api','repos/'+repository],async execution=>{
      const r=await(this.host.deps.run??runPlatformCliProcess)(execution);
      let v:any;try{v=JSON.parse(r.stdout);}catch{}
      if(r.code!==0||!v||v.permissions?.push!==true||typeof v.node_id!=='string'||v.full_name?.toLowerCase()!==repository.toLowerCase())throw new PlatformCliError('선택한 GitHub 계정의 저장소 쓰기 권한을 확인하지 못했습니다.');
      return v.node_id as string;
    });
  }
  async prepare(targetId:string,accountId:string,remote:string,folderPath?:string):Promise<GithubPushPlan> {
    for(const [id,p]of this.plans)if(p.view.expiresAt<Date.now()&&p.state!=='executing')this.plans.delete(id);
    if(this.plans.size>=64)throw new PlatformCliError('푸시 준비 요청이 많습니다. 잠시 후 다시 시도하세요.');
    const project=await this.host.deps.resolveProject(targetId,folderPath),account=await this.host.account(accountId,'github');
    if(account.provider!=='github'||account.state!=='ready'||!account.identity)throw new PlatformCliError('연결 상태를 확인한 GitHub 계정을 선택하세요.');
    const snapshot=await this.snapshot(project,remote),repositoryId=await this.repository(account,project,snapshot.repository);
    const view={id:randomUUID(),targetId,projectLabel:project.label,accountId:account.id,accountLabel:account.label,identity:account.identity,remote,...snapshot,expiresAt:Date.now()+300_000};
    this.plans.set(view.id,{view,account,project,repositoryId,folderPath,state:'ready'});return {...view};
  }
  async execute(targetId:string,planId:string,requestId:string) {
    platformCliRequestId(requestId);platformCliText(planId,64);
    this.host.store.ensureDirectory();const root=this.host.store.root,file=join(root,'push-receipts.json');
    return withOwnedPortalFileLock(file+'.lock',async()=>{
      const raw=readPrivateFileStrict(file);if(raw===null&&pathEntryExists(file))throw new PlatformCliError('이전 푸시 기록을 확인하지 못했습니다. 다시 전송하지 않았습니다.');
      if(raw&&raw.length>512*1024)throw new PlatformCliError('푸시 기록 한도를 확인하세요.');
      let receipts:PushReceipt[]=raw?JSON.parse(raw):[];if(!Array.isArray(receipts)||receipts.length>512)throw new PlatformCliError('푸시 기록을 확인하세요.');
      if(receipts.some(r=>!r||!['executing','completed','failed'].includes(r.state)||!Number.isFinite(r.at)||typeof r.fingerprint!=='string'))throw new PlatformCliError('푸시 결과 기록의 형식을 확인하세요.');
      receipts=receipts.filter(r=>r.state==='executing'||Date.now()-r.at<7*86_400_000);
      const fingerprint=platformCliHash(JSON.stringify([targetId,planId])),old=receipts.find(r=>r.requestId===requestId||r.planId===planId);
      if(old){if(old.targetId!==targetId||old.fingerprint!==fingerprint)throw new PlatformCliError('푸시 요청 ID가 다른 작업에 사용되었습니다.');return {...old,replayed:true};}
      const p=this.plans.get(planId);
      if(!p||p.state!=='ready'||p.view.targetId!==targetId||p.view.expiresAt<Date.now())throw new PlatformCliError('푸시 준비가 만료되었거나 앱이 다시 시작되었습니다. 기존 결과를 확인한 뒤 새로 준비하세요.');
      if(receipts.length>=512)throw new PlatformCliError('푸시 기록 한도에 도달했습니다. 기존 기록을 확인하세요.');
      const project=await this.host.deps.resolveProject(targetId,p.folderPath);
      if(project.cwd!==p.project.cwd)throw new PlatformCliError('프로젝트 위치가 변경되었습니다.');
      const current=await this.snapshot(project,p.view.remote);
      if(current.repository!==p.view.repository||current.branch!==p.view.branch||current.head!==p.view.head)throw new PlatformCliError('계정·저장소·브랜치·커밋이 변경되었습니다. 푸시 대상을 다시 확인하세요.');
      await this.host.assertCurrent(p.account);
      if(await this.repository(p.account,project,current.repository)!==p.repositoryId)throw new PlatformCliError('원격 저장소의 정체성이 변경되었습니다.');
      const receipt:PushReceipt={requestId,fingerprint,targetId,planId,state:'executing',repository:current.repository,branch:current.branch,commit:current.head,at:Date.now()};
      receipts.push(receipt);writePrivateFileAtomically(root,file,JSON.stringify(receipts));p.state='executing';
      try{
        const code=await this.host.using(p.account,project,[],async execution=>{
          const env={...execution.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_ASKPASS:'',SSH_ASKPASS:''};
          // Git uses the selected gh process environment; tokens never enter argv or a remote URL.
          const helper='!'+quote(execution.executable)+' auth git-credential';
          const args=['-c','credential.helper=','-c','credential.https://github.com.helper='+helper,'-c','http.extraHeader=','push','--porcelain','https://github.com/'+current.repository+'.git',current.head+':refs/heads/'+current.branch];
          await this.host.assertCurrent(p.account);
          return(await this.run({...execution,executable:this.gitExecutable,args,env})).code;
        });
        // A nonzero client exit can follow a server accepting the update. Keep the outcome unknown.
        receipt.state=code===0?'completed':'executing';
        writePrivateFileAtomically(root,file,JSON.stringify(receipts));p.state='done';return {...receipt,replayed:false};
      }catch{p.state='done';throw new PlatformCliError('푸시 결과를 확인하지 못했습니다. 같은 요청 ID로 상태를 조회하세요. 자동으로 재전송하지 않았습니다.');}
    },{label:'Platform CLI push',attempts:2,retryMs:20,deadOwnerRecoveryClass:'manual',canRecoverDeadOwner:()=>false});
  }
}
