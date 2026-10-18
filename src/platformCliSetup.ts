import {join} from 'node:path';
import {homedir} from 'node:os';
import {PlatformCliHost,platformCliEnvironment,runPlatformCliProcess} from './platformCliHost';
import {platformCliEmail,platformCliRequestId,platformCliAccountPurpose,type PlatformCliAccountPurpose,PlatformCliError,PLATFORM_CLI_PROVIDERS,type PlatformCliProvider} from './platformCliProtocol';
import {platformCliVerifiedEmail} from './platformCliIdentity';
import {platformCliHash,validatePlatformCliCredential} from './platformCliStore';
import {readPrivateFileStrict,pathEntryExists} from './remoteControlHostVault';
import {supabaseKeyringToken} from './platformCliLogin';
import {supabaseStatusFromProbe} from './onboardingSupabaseStatus';
import {isPublicSupabaseClientKey} from './onboardingHandoff';

export interface PlatformCliSetupStatus {provider:PlatformCliProvider;installed:boolean|null;connected:number}
/** Inventory never reads credentials or treats an installed binary as an authenticated account. */
export function platformCliSetupStatus(host:PlatformCliHost):PlatformCliSetupStatus[]{
  return PLATFORM_CLI_PROVIDERS.map(provider=>{
    let installed:boolean|null;try{installed=!!host.deps.executable(provider);}catch{installed=null;}
    return {provider,installed,connected:host.store.list(provider).filter(a=>a.state==='ready'&&a.verifiedEmail).length};
  });
}
export async function readNativePlatformCredential(host:PlatformCliHost,provider:PlatformCliProvider):Promise<string>{
  const executable=host.deps.executable(provider);if(!executable)throw new PlatformCliError('CLI를 먼저 설치하고 상태를 다시 확인하세요.');
  const inherited=host.deps.env??process.env,env=platformCliEnvironment(inherited),home=inherited.HOME??homedir();
  const account={id:'native-setup',provider,label:'기존 로그인 확인',identity:null,state:'unchecked' as const,revision:''};
  const run=(args:string[],binary=executable)=>(host.deps.run??runPlatformCliProcess)({executable:binary,args,env,cwd:home,account,timeoutMs:120_000});
  if(provider==='github'||provider==='google-workspace'){
    if(provider==='google-workspace'&&inherited.GOOGLE_WORKSPACE_CLI_CONFIG_DIR)env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR=inherited.GOOGLE_WORKSPACE_CLI_CONFIG_DIR;
    const r=await run(provider==='github'?['auth','token','--hostname','github.com']:['auth','export','--unmasked']);
    if(r.code===0)return validatePlatformCliCredential(provider,r.stdout.trim());
  }else if(provider==='vercel'){
    const roots=inherited.XDG_DATA_HOME?[join(inherited.XDG_DATA_HOME,'com.vercel.cli')]:process.platform==='darwin'?[join(home,'Library','Application Support','com.vercel.cli')]:process.platform==='win32'?[join(inherited.APPDATA??home,'xdg.data','com.vercel.cli')]:[join(home,'.local','share','com.vercel.cli')];
    for(const directory of [...roots,join(home,'.now')]){
      if(!pathEntryExists(directory))continue;const file=join(directory,'auth.json');
      const raw=readPrivateFileStrict(file);if(!raw)throw new PlatformCliError('기존 Vercel 로그인 파일을 안전하게 읽지 못했습니다. 브라우저로 연결하세요.');
      return validatePlatformCliCredential(provider,raw);
    }
  }else{
    if(process.platform==='darwin')for(const profile of ['supabase','access-token']){
      const r=await run(['find-generic-password','-s','Supabase CLI','-a',profile,'-w'],'/usr/bin/security');
      if(r.code===0)return validatePlatformCliCredential(provider,supabaseKeyringToken(r.stdout));
      // A denied/locked keychain must not silently select an unrelated legacy account.
      if(!/could not be found|item.*not found/i.test(r.stderr))throw new PlatformCliError('키체인 접근을 확인하거나 브라우저로 계정을 연결하세요.');
    }
    const raw=readPrivateFileStrict(join(home,'.supabase','access-token'));if(raw)return validatePlatformCliCredential(provider,raw.trim());
  }
  throw new PlatformCliError('기존 로그인 정보를 찾지 못했습니다. 아래 브라우저 연결에서 로그인하거나 새 계정을 만드세요.');
}
export async function connectNativePlatformAccount(host:PlatformCliHost,provider:PlatformCliProvider,emailValue:unknown,requestId:string,read=readNativePlatformCredential,purposeValue?:PlatformCliAccountPurpose){
  platformCliRequestId(requestId);const email=platformCliEmail(emailValue),purpose=platformCliAccountPurpose(purposeValue,provider);
  if(!PLATFORM_CLI_PROVIDERS.includes(provider))throw new PlatformCliError('지원하는 CLI를 선택하세요.');
  const secret=await (read===readNativePlatformCredential&&host.deps.nativeCredential?host.deps.nativeCredential(provider):read(host,provider));let verifiedEmail:string;
  if(provider==='google-workspace'){
    // An isolated managed check proves the exported credential's actual email before selecting it.
    verifiedEmail=email;
  }else verifiedEmail=await platformCliVerifiedEmail(provider,secret,email,host.deps.json);
  const account=await host.store.create(provider,email.slice(0,45)+' · '+(purpose==='app-sync-account'?'앱 관리 ':'기존 ')+requestId.slice(0,6),secret,platformCliHash(requestId+':native-create'));
  try{
    const checked=await host.check(account.id,platformCliHash(requestId+':native-check'));
    if(provider==='google-workspace'&&platformCliEmail(checked.identity)!==email)throw new PlatformCliError('요청한 Google 이메일과 기존 로그인이 다릅니다.');
    const verified=await host.store.verified(checked,verifiedEmail,platformCliHash(requestId+':native-email'));
    if(purpose==='project-cli')await host.store.attachVerifiedDefault(verified,platformCliHash(requestId+':native-default'));return verified;
  }catch(error){await host.store.archive(account.id,platformCliHash(requestId+':native-failed'));throw error;}
}
/** Fixed read-only commands for the app's explicit Supabase setup choice. No project binding/default mutation. */
export async function readSupabaseSetup(host:PlatformCliHost,accountId:string,ref?:string):Promise<any>{
  const account=host.store.account(accountId);
  if(account.provider!=='supabase'||account.state!=='ready'||!account.verifiedEmail)throw new PlatformCliError('확인된 Supabase 계정을 선택하세요.');
  if(ref!==undefined&&!/^[a-z0-9]{20}$/.test(ref))throw new PlatformCliError('Supabase 프로젝트 ref를 확인하세요.');
  return host.using(account,{id:'app-sync-setup',cwd:host.store.root,label:'앱 동기화 준비'},ref?['projects','api-keys','--project-ref',ref,'--output','json']:['projects','list','--output','json'],async execution=>{
    execution.timeoutMs=15_000;const result=await(host.deps.run??runPlatformCliProcess)(execution);
    if(result.code!==0)throw new PlatformCliError('선택한 Supabase 계정의 프로젝트 권한을 확인하세요. 다른 계정으로 대체하지 않았습니다.');
    if(ref){let rows:unknown;try{rows=JSON.parse(result.stdout);}catch{throw new PlatformCliError('프로젝트 키 응답을 확인하지 못했습니다.');}if(!Array.isArray(rows)||rows.length>100)throw new PlatformCliError('프로젝트 키 응답을 확인하지 못했습니다.');return rows;}
    const status=supabaseStatusFromProbe('',{ok:true,stdout:result.stdout,stderr:'',timedOut:false});
    if(status.state!=='ready')throw new PlatformCliError('프로젝트 목록을 확인하지 못했습니다.');return status.projects;
  });
}
export async function readSupabasePublicSetupKey(host:PlatformCliHost,accountId:string,ref:string){
  const keys=await readSupabaseSetup(host,accountId,ref),key=Array.isArray(keys)?keys.find(k=>k.name==='anon')?.api_key:null;
  if(!isPublicSupabaseClientKey(key))throw new PlatformCliError('프로젝트의 공개 연결 키를 확인하지 못했습니다.');
  return {projectUrl:'https://'+ref+'.supabase.co',anonKey:key};
}
