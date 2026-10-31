import {mkdirSync,mkdtempSync,rmSync,writeFileSync,readdirSync,lstatSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {PlatformCliHost,platformCliEnvironment,runPlatformCliProcess,type PlatformCliExecution} from './platformCliHost';
import {PlatformCliError,platformCliAccountPurpose,type PlatformCliAccountPurpose,platformCliEmail,platformCliProvider,platformCliRequestId,type PlatformCliAccount,type PlatformCliProvider} from './platformCliProtocol';
import {platformCliVerifiedEmail,platformCliDiscoveredEmail} from './platformCliIdentity';
import {readPrivateFileStrict,writePrivateFileAtomically,pathEntryExists} from './remoteControlHostVault';
import {withOwnedPortalFileLock} from './portalFileLock';
import {execFile} from 'node:child_process';

export interface PlatformCliLoginView {id:string;provider:PlatformCliProvider;email:string;purpose?:PlatformCliAccountPurpose;state:'waiting'|'checking'|'completed'|'failed'|'cancelled'|'interrupted';url?:string;code?:string;needsCode?:boolean;account?:PlatformCliAccount;message?:string;expiresAt:number}
export interface PlatformLoginChild {write(value:string):void;kill():void;exited:Promise<number>}
export type PlatformLoginSpawn=(e:PlatformCliExecution,output:(value:string)=>void)=>PlatformLoginChild;
interface NativeLoginSecrets {get(profile:string):Promise<string|null>;delete(profile:string):Promise<void>}
function privateSupabaseKeychain(name:string,remove=false):Promise<string|null>{
  if(!/^agentstoz-[A-Za-z0-9_-]{1,128}$/.test(name))throw new PlatformCliError('임시 로그인 프로필을 확인하세요.');
  return new Promise((resolve,reject)=>execFile('/usr/bin/security',[remove?'delete-generic-password':'find-generic-password','-s','Supabase CLI','-a',name,...(remove?[]:['-w'])],{timeout:15_000,killSignal:'SIGKILL',maxBuffer:16_384},(error,stdout,stderr)=>{
    if(error){if(/could not be found/i.test(stderr))return resolve(null);return reject(new PlatformCliError('Supabase 임시 키체인 접근을 확인하세요.'));}resolve(remove?null:stdout.trim());
  }));
}
const nativeLoginSecrets:NativeLoginSecrets={get:async name=>process.platform==='darwin'?privateSupabaseKeychain(name):await Bun.secrets.get({service:'Supabase CLI',name})??null,delete:async name=>{if(process.platform==='darwin')await privateSupabaseKeychain(name,true);else await Bun.secrets.delete({service:'Supabase CLI',name});}};
const liveChildren=new Set<PlatformLoginChild>();
process.once('exit',()=>{for(const child of liveChildren)child.kill();});
/** A private login PTY, deliberately outside Workroom transcripts, memory hooks and raw-output APIs. */
export const spawnPlatformLogin:PlatformLoginSpawn=(e,output)=>{
  if(process.platform==='win32')throw new PlatformCliError('이 로그인 연결은 현재 Mac에서 지원합니다. Windows 실기 검증이 필요합니다.');
  const spawn=Bun.spawn as unknown as (args:string[],options:unknown)=>{pid:number;terminal:{write(value:string):void;close():void};exited:Promise<number>};
  const decoder=new TextDecoder();
  const child=spawn([e.executable,...e.args],{cwd:e.cwd,env:e.env,detached:true,terminal:{cols:100,rows:30,data:(_terminal:unknown,data:Uint8Array)=>output(decoder.decode(data,{stream:true}))}});
  return {write:value=>{child.terminal!.write(value);},kill:()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},exited:child.exited.finally(()=>child.terminal?.close())};
};
interface Login {view:PlatformCliLoginView;discoverEmail?:boolean;/** A newcomer's first sign-in fills an unset device default; adding another account never does. */fillDefault:boolean;directory:string;child?:PlatformLoginChild;timer?:ReturnType<typeof setTimeout>;tail:string;bytes:number;execution:PlatformCliExecution;profile:string;sentCode:boolean}
const TTL=10*60_000;
/** Supabase's go-keyring macOS adapter encodes stored passwords; Bun returns the stored bytes. */
export function supabaseKeyringToken(value:string):string {
  const raw=value.trim();
  for(const [prefix,encoding,valid]of [
    ['go-keyring-base64:','base64',/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/],
    ['go-keyring-encoded:','hex',/^(?:[0-9a-fA-F]{2})+$/],
  ] as const){
    if(raw.startsWith(prefix)){
      const encoded=raw.slice(prefix.length);
      if(!encoded||encoded.length>4096||!valid.test(encoded))throw new PlatformCliError('Supabase 로그인 자격 증명을 읽지 못했습니다.');
      return Buffer.from(encoded,encoding).toString('utf8');
    }
  }
  return raw;
}
export class PlatformCliLoginHost {
  private jobs=new Map<string,Login>();
  constructor(private readonly host:PlatformCliHost,private readonly spawn:PlatformLoginSpawn=spawnPlatformLogin,private readonly nativeSecrets:NativeLoginSecrets=nativeLoginSecrets){}
  busy(){return [...this.jobs.values()].some(j=>['waiting','checking'].includes(j.view.state));}
  private public(job:Login):PlatformCliLoginView {return {...job.view,account:job.view.account?{...job.view.account}:undefined};}
  private record(job:Login){
    // Transient OAuth URLs, codes, credentials and CLI output never reach disk.
    const {id,provider,email,purpose,state,account,expiresAt,message}=job.view;
    writePrivateFileAtomically(this.host.store.root,join(this.host.store.root,'login-'+id+'.json'),JSON.stringify({id,provider,email,purpose,state,account,expiresAt,message}));
  }
  async start(provider:PlatformCliProvider,emailValue:unknown,requestId:string,purposeValue?:PlatformCliAccountPurpose,discoverEmail=false,fillDefault=true) {
    platformCliRequestId(requestId);if(requestId.length>128)throw new PlatformCliError('로그인 요청 ID가 너무 깁니다.');if(!platformCliProvider(provider)||discoverEmail&&provider==='google-workspace')throw new PlatformCliError('지원하는 CLI를 선택하세요.');const email=discoverEmail?'':platformCliEmail(emailValue),purpose=platformCliAccountPurpose(purposeValue,provider);
    this.host.store.ensureDirectory();
    return withOwnedPortalFileLock(join(this.host.store.root,'login-start.lock'),async()=>{
      for(const [id,job]of this.jobs)if(job.view.expiresAt<Date.now()&&!['waiting','checking'].includes(job.view.state))this.jobs.delete(id);
      const existing=this.jobs.get(requestId);if(existing){if(existing.view.provider!==provider||!!existing.discoverEmail!==discoverEmail||existing.fillDefault!==fillDefault||!discoverEmail&&existing.view.email!==email||(existing.view.purpose??'project-cli')!==purpose)throw new PlatformCliError('같은 로그인 요청 ID를 다른 계정에 사용할 수 없습니다.');return this.public(existing);}
      const receipt=join(this.host.store.root,'login-'+requestId+'.json');
      if(pathEntryExists(receipt))throw new PlatformCliError('이 로그인 요청은 이미 시작되었습니다. 앱 재시작 전 결과를 확인하고 새로 로그인하세요. 자동 재실행하지 않았습니다.');
      // Bounded admission receipts; prune only terminal metadata after the retry window.
      const receipts=readdirSync(this.host.store.root).filter(name=>/^login-[A-Za-z0-9_-]+\.json$/.test(name));
      let count=0;
      for(const name of receipts){const file=join(this.host.store.root,name),raw=readPrivateFileStrict(file);if(!raw||raw.length>8192)throw new PlatformCliError('로그인 기록을 확인하세요.');const old=JSON.parse(raw);if(['completed','failed','cancelled'].includes(old.state)&&old.expiresAt<Date.now()-86_400_000)rmSync(file);else count++;}
      if(count>=128)throw new PlatformCliError('로그인 기록 한도에 도달했습니다. 기존 로그인 결과를 확인하세요.');
      for(const name of readdirSync(this.host.store.root).filter(name=>/^login-[A-Za-z0-9]{6}$/.test(name))){const file=join(this.host.store.root,name),info=lstatSync(file);if(info.isDirectory()&&!info.isSymbolicLink()&&info.mtimeMs<Date.now()-TTL-60_000&&!Array.from(this.jobs.values()).some(job=>job.directory===file))rmSync(file,{recursive:true});}
      if(this.jobs.size>=8||this.busy())throw new PlatformCliError('진행 중인 로그인을 먼저 마치거나 취소하세요. 계정 인증은 하나씩 진행합니다.');
      const executable=this.host.deps.executable(provider);if(!executable||!isAbsolute(executable))throw new PlatformCliError('공식 CLI를 먼저 설치하세요.');
      const directory=mkdtempSync(join(this.host.store.root,'login-')),config=join(directory,'config'),home=join(directory,'home');mkdirSync(config,{mode:0o700});mkdirSync(home,{mode:0o700});
      const env=platformCliEnvironment(this.host.deps.env??process.env);Object.assign(env,{HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:config,XDG_DATA_HOME:join(directory,'data'),NO_COLOR:'1',TERM:'xterm-256color',CI:'1',BROWSER:process.platform==='darwin'?'/usr/bin/true':'true'});
      const profile='agentstoz-'+requestId;let args:string[];
      if(provider==='github'){env.GH_CONFIG_DIR=config;env.GH_BROWSER=process.platform==='darwin'?'/usr/bin/true':'true';args=['auth','login','--hostname','github.com','--git-protocol','https','--web','--clipboard=false','--insecure-storage','--scopes','user:email'];}
      else if(provider==='vercel')args=['--global-config',config,'login'];
      else if(provider==='supabase'){
        // --profile accepts a descriptor path, not an arbitrary account alias (CLI v2.90).
        const file=join(config,'profile.json');
        writeFileSync(file,JSON.stringify({name:profile,api_url:'https://api.supabase.com',dashboard_url:'https://supabase.com/dashboard',docs_url:'https://supabase.com/docs',project_host:'supabase.co',pooler_host:'supabase.com'}),{mode:0o600});
        // The official CLI concatenates token_name without URL encoding. Spaces
        // would truncate the URL before its ECDH public_key in the output reader.
        args=['login','--no-browser','--profile',file,'--name','AgentsToZ-local-project-CLI'];
      }
      else{
        // Copy only Desktop OAuth client configuration, never a native user's credential/session.
        let client:string;
        try{const selected=await this.host.store.googleClient.read(this.host.deps.env??process.env);if(!selected)throw Error();client=selected.client;}catch{rmSync(directory,{recursive:true,force:true});throw new PlatformCliError('Google 클라이언트 파일을 먼저 첨부하세요. Google Cloud Console의 데스크톱 앱 OAuth JSON이 필요합니다.');}
        writeFileSync(join(config,'client_secret.json'),client,{mode:0o600});env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR=config;env.GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND='file';
        args=['auth','login','--scopes','https://www.googleapis.com/auth/drive.readonly'];
      }
      const view:PlatformCliLoginView={id:requestId,provider,email,purpose,state:'waiting',expiresAt:Date.now()+TTL};
      const job:Login={view,discoverEmail,fillDefault,directory,execution:{executable,args,env,cwd:directory,account:{id:'login',provider,label:email,identity:null,state:'unchecked',revision:''}},profile,tail:'',bytes:0,sentCode:false};
      this.record(job);this.jobs.set(requestId,job);
      try{job.child=this.spawn(job.execution,value=>this.consume(job,value));liveChildren.add(job.child);job.timer=setTimeout(()=>void this.cancel(requestId).catch(()=>{}),TTL);job.timer.unref?.();void job.child.exited.then(code=>this.finish(job,code),()=>this.finish(job,1)).catch(()=>{}).finally(()=>liveChildren.delete(job.child!));}
      catch{view.state='failed';view.message='로그인 CLI를 시작하지 못했습니다.';this.cleanup(job);this.record(job);}
      return this.public(job);
    },{label:'Platform CLI login admission',attempts:2,retryMs:20,deadOwnerRecoveryClass:'manual',canRecoverDeadOwner:()=>false});
  }
  private consume(job:Login,value:string){
    if(job.view.state!=='waiting')return;
    job.bytes+=Buffer.byteLength(value);if(job.bytes>65536){void this.cancel(job.view.id);return;}
    job.tail=(job.tail+value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'')).slice(-8192);
    const p=job.view.provider;
    if(p==='github'){
      const code=/one-time code(?:\s*:\s*|\s*\()([A-Z0-9]{4}-[A-Z0-9]{4})(?:\)|\b)/i.exec(job.tail);
      if(code){job.view.code=code[1]!.toUpperCase();job.view.url='https://github.com/login/device';}
      if(/Press Enter/i.test(job.tail)){job.child?.write('\r');job.tail='';}
    }else{
      for(const match of job.tail.matchAll(/https:\/\/[^\s<>"\x1b]+/g)){
        try{const u=new URL(match[0]);
          const supabase=p==='supabase'&&u.origin==='https://supabase.com'&&u.pathname==='/dashboard/cli/login'&&!u.hash
            &&/^[a-f0-9-]{36}$/i.test(u.searchParams.get('session_id')??'')
            &&/^[A-Za-z0-9_-]+$/.test(u.searchParams.get('token_name')??'')
            &&/^04[a-f0-9]{128}$/i.test(u.searchParams.get('public_key')??'');
          // PTY chunks can end midway through the URL. Publish it only after the
          // entire P-256 public key arrives so auto-open cannot consume a prefix.
          if(!u.username&&!u.password&&(p==='vercel'&&u.hostname==='vercel.com'&&u.pathname==='/oauth/device'||supabase||p==='google-workspace'&&u.hostname==='accounts.google.com'&&u.pathname.startsWith('/o/oauth2/')))job.view.url=u.toString();
        }catch{/* ignore non-URLs and every other CLI output */}
      }
      if(p==='supabase'&&/Enter your verification code/i.test(job.tail))job.view.needsCode=true;
    }
  }
  status(id:string){
    platformCliRequestId(id);const job=this.jobs.get(id);if(job)return this.public(job);
    const raw=readPrivateFileStrict(join(this.host.store.root,'login-'+id+'.json'));
    if(raw&&raw.length<8192){const saved=JSON.parse(raw);if(saved.id===id&&platformCliProvider(saved.provider)&&typeof saved.email==='string'){
      if(['waiting','checking'].includes(saved.state))return {...saved,state:'interrupted',message:'앱 재시작으로 로그인이 중단되었습니다. 기존 계정 목록과 실제 연결을 먼저 확인하세요. 자동으로 새 로그인을 시작하지 않았습니다.'} as PlatformCliLoginView;
      if(['completed','failed','cancelled'].includes(saved.state))return saved as PlatformCliLoginView;
    }}
    throw new PlatformCliError('로그인 세션이 없거나 앱이 다시 시작되었습니다. 자동으로 재실행하지 않았습니다.');
  }
  code(id:string,value:unknown){const job=this.jobs.get(platformCliRequestId(id));if(!job||job.view.provider!=='supabase'||job.view.state!=='waiting'||!job.view.needsCode||job.sentCode||typeof value!=='string'||!/^[A-Za-z0-9-]{4,64}$/.test(value))throw new PlatformCliError('진행 중 Supabase 로그인의 확인 코드를 확인하세요.');job.sentCode=true;job.view.needsCode=false;job.child!.write(value+'\r');return this.public(job);}
  async cancel(id:string):Promise<PlatformCliLoginView|{cancelled:true}> {
    const job=this.jobs.get(platformCliRequestId(id));
    if(!job){
      this.host.store.ensureDirectory();
      return withOwnedPortalFileLock(join(this.host.store.root,'login-start.lock'),()=>{
        const file=join(this.host.store.root,'login-'+id+'.json');
        if(pathEntryExists(file))return this.status(id);
        // Fence a delayed admission with this exact request ID, even after a lost start reply.
        writePrivateFileAtomically(this.host.store.root,file,JSON.stringify({id,state:'cancelled',expiresAt:Date.now()+TTL}));return {cancelled:true as const};
      },{label:'Platform login cancellation',attempts:2,retryMs:20,deadOwnerRecoveryClass:'manual',canRecoverDeadOwner:()=>false});
    }
    if(job.view.state==='checking')throw new PlatformCliError('계정 확인이 끝난 뒤 결과를 확인하세요.');
    if(job.view.state!=='waiting')return this.public(job);
    job.view.state='cancelled';job.child?.kill();await job.child?.exited.catch(()=>{});
    if(job.view.provider==='supabase')try{await this.nativeSecrets.delete(job.profile);}catch{job.view.message='취소했습니다. 임시 OS 로그인 항목 정리 결과는 확인이 필요합니다.';}
    this.cleanup(job);this.record(job);return this.public(job);
  }
  private cleanup(job:Login){clearTimeout(job.timer);job.tail='';job.view.url=undefined;job.view.code=undefined;job.view.needsCode=false;rmSync(job.directory,{recursive:true,force:true});}
  private async finish(job:Login,code:number){
    if(job.view.state!=='waiting')return;clearTimeout(job.timer);job.view.state='checking';this.record(job);
    let created:PlatformCliAccount|undefined;
    try{
      if(code!==0)throw new PlatformCliError('로그인을 완료하지 못했습니다. 브라우저 승인·CLI 버전을 확인하세요.');
      let secret:string;const p=job.view.provider,config=join(job.directory,'config');
      if(p==='vercel'){secret=readPrivateFileStrict(join(config,'auth.json'))??'';}
      else if(p==='supabase'){const keyring=await this.nativeSecrets.get(job.profile);secret=keyring===null?(readPrivateFileStrict(join(job.directory,'home','.supabase','access-token'))??''):supabaseKeyringToken(keyring);}
      else{
        const r=await(this.host.deps.run??runPlatformCliProcess)({...job.execution,args:p==='github'?['auth','token','--hostname','github.com']:['auth','export','--unmasked']});if(r.code!==0)throw new PlatformCliError('승인 결과를 읽지 못했습니다.');secret=r.stdout.trim();
      }
      let verifiedEmail:string;
      if(p==='google-workspace'){
        const r=await(this.host.deps.run??runPlatformCliProcess)({...job.execution,args:['drive','about','get','--params','{"fields":"user(emailAddress)"}']});
        if(r.code!==0||platformCliEmail(JSON.parse(r.stdout).user?.emailAddress)!==job.view.email)throw new PlatformCliError('승인한 Google 계정 이메일이 일치하지 않습니다.');verifiedEmail=job.view.email;
      }else verifiedEmail=job.discoverEmail?await platformCliDiscoveredEmail(p,secret,this.host.deps.json):await platformCliVerifiedEmail(p,secret,job.view.email,this.host.deps.json);
      if(job.discoverEmail)job.view.email=verifiedEmail;
      // Expected email has been verified before an account can appear as connected.
      const account=await this.host.store.create(p,job.view.email.slice(0,50)+' · '+job.view.id.slice(0,6),secret,job.view.id+'-create');
      created=account;
      const checked=await this.host.check(account.id,job.view.id+'-check');
      job.view.account=await this.host.store.verified(checked,verifiedEmail,job.view.id+'-email');
      if(job.view.purpose!=='app-sync-account'){
        if(job.discoverEmail&&job.fillDefault)await this.host.store.attachOnboardingDefault(job.view.account,job.view.id+'-default');
        else await this.host.store.attachVerifiedDefault(job.view.account,job.view.id+'-default');
      }job.view.state='completed';
    }catch{if(created&&!job.view.account)try{await this.host.store.archive(created.id,job.view.id+'-failed');}catch{}job.view.state='failed';job.view.message='로그인 또는 요청한 이메일 확인에 실패했습니다. 다른 계정으로 연결하지 않았습니다.';}
    finally{if(job.view.provider==='supabase')try{await this.nativeSecrets.delete(job.profile);}catch{/* private profile only; never call global logout */}this.cleanup(job);this.record(job);}
  }
}
