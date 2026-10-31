import {PlatformCliError} from './platformCliProtocol';
import {PlatformGoogleOAuthClient} from './platformGoogleOAuthClient';
import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,mkdirSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {withOwnedPortalFileLock} from './portalFileLock';
import {pathEntryExists,readPrivateFileStrict,writePrivateFileAtomically} from './remoteControlHostVault';
import {platformCliBinding,platformCliEmail,platformCliManagedId,platformCliNativeGithubLogin,PLATFORM_CLI_DEFAULT_ACCOUNT,platformCliProvider,platformCliRequestId,platformCliText,type PlatformCliAccount,type PlatformCliBinding,type PlatformCliProvider,type PlatformCliDeviceDefaults} from './platformCliProtocol';

interface RecordAccount extends PlatformCliAccount {credentialHash:string; archived:boolean}
interface Data {schemaVersion:1; accounts:RecordAccount[]; bindings:Record<string,PlatformCliBinding>; deviceDefaults?:PlatformCliDeviceDefaults; receipts:{id:string;hash:string;result:string;at:number}[]}
export interface PlatformCliSecrets {get(id:string):Promise<string|null>;set(id:string,value:string):Promise<void>}
/** Fail closed when the OS credential store is unavailable; no plaintext fallback. */
export const osPlatformCliSecrets:PlatformCliSecrets = {
  async get(id) {return await Bun.secrets.get({service:'com.agentstoz.platform-cli.v1',name:id})??null;},
  async set(id,value) {
    const key={service:'com.agentstoz.platform-cli.v1',name:id};
    await Bun.secrets.set({...key,value});
    if(await Bun.secrets.get(key)!==value)throw new PlatformCliError('OS 자격 증명 저장소의 저장 결과를 확인하지 못했습니다.');
  },
};
export const platformCliHash=(v:string)=>createHash('sha256').update(v).digest('hex');
export function validatePlatformCliCredential(provider:PlatformCliProvider,value:unknown):string {
  if(typeof value!=='string'||value.length<16||value.length>16_384)throw new PlatformCliError('인증 정보를 확인하세요.');
  if(provider==='vercel'&&value.startsWith('{')){
    let v:any;try{v=JSON.parse(value);}catch{throw new PlatformCliError('Vercel 로그인 정보를 확인하세요.');}
    if(typeof v.token!=='string'||!/^[A-Za-z0-9_.-]{16,4096}$/.test(v.token)||v.refreshToken!==undefined&&(typeof v.refreshToken!=='string'||v.refreshToken.length>4096)||v.expiresAt!==undefined&&!Number.isFinite(v.expiresAt))throw new PlatformCliError('Vercel OAuth 정보를 확인하세요.');
    return JSON.stringify({token:v.token,...(v.refreshToken?{refreshToken:v.refreshToken}:{}),...(v.expiresAt?{expiresAt:v.expiresAt}:{})});
  }
  if(provider==='google-workspace') {
    let v:any;try{v=JSON.parse(value);}catch{throw new PlatformCliError('Google OAuth JSON 파일을 선택하세요.');}
    if(!v||Array.isArray(v)||typeof v.client_id!=='string'||typeof v.client_secret!=='string'||typeof v.refresh_token!=='string'||!v.refresh_token||v.type&&v.type!=='authorized_user')throw new PlatformCliError('사용자 계정의 OAuth JSON이 필요합니다. 서비스 계정 키는 지원하지 않습니다.');
    if(v.token_uri&&v.token_uri!=='https://oauth2.googleapis.com/token')throw new PlatformCliError('Google 공식 OAuth 토큰 주소를 확인하세요.');
    return JSON.stringify({type:'authorized_user',client_id:v.client_id,client_secret:v.client_secret,refresh_token:v.refresh_token});
  }
  if(!/^[A-Za-z0-9_.-]{16,512}$/.test(value))throw new PlatformCliError('CLI 액세스 토큰 형식을 확인하세요.');
  if(provider==='supabase'&&!/^sbp_[A-Za-z0-9_-]{20,240}$/.test(value))throw new PlatformCliError('Supabase 개인 액세스 토큰이 필요합니다.');
  return value;
}
export class PlatformCliStore {
  readonly root:string;readonly file:string;
  readonly googleClient:PlatformGoogleOAuthClient;
  get appDirectory(){return this.appDataDir;}
  constructor(private readonly appDataDir:string,private readonly secrets:PlatformCliSecrets=osPlatformCliSecrets){
    if(!isAbsolute(appDataDir))throw new PlatformCliError('앱 데이터 위치를 확인하세요.');
    this.root=join(appDataDir,'platform-cli-v1');this.file=join(this.root,'registry.json');
    this.googleClient=new PlatformGoogleOAuthClient(secrets);
  }
  private directory(create=false) {
    const p=lstatSync(this.appDataDir);
    if(!p.isDirectory()||p.isSymbolicLink()||process.platform!=='win32'&&(p.uid!==process.getuid?.()||p.mode&0o022))throw new PlatformCliError('앱 데이터 폴더의 접근 권한을 확인하세요.');
    if(!pathEntryExists(this.root)){if(!create)return false;mkdirSync(this.root,{mode:0o700});}
    const s=lstatSync(this.root);
    if(!s.isDirectory()||s.isSymbolicLink()||process.platform!=='win32'&&(s.uid!==process.getuid?.()||s.mode&0o077))throw new PlatformCliError('CLI 계정 폴더의 접근 권한을 확인하세요.');
    return true;
  }
  ensureDirectory(){this.directory(true);}
  private read():Data {
    if(!this.directory())return {schemaVersion:1,accounts:[],bindings:{},receipts:[]};
    const raw=readPrivateFileStrict(this.file);
    if(raw===null){if(pathEntryExists(this.file))throw new PlatformCliError('CLI 계정 목록을 읽지 못했습니다.');return {schemaVersion:1,accounts:[],bindings:{},receipts:[]};}
    if(raw.length>512*1024)throw new PlatformCliError('CLI 계정 저장소 한도를 초과했습니다.');
    const d=JSON.parse(raw) as Data;
    if(d.schemaVersion!==1||!Array.isArray(d.accounts)||d.accounts.length>64||!d.bindings||typeof d.bindings!=='object'||Array.isArray(d.bindings)||Object.keys(d.bindings).length>4096||!Array.isArray(d.receipts)||d.receipts.length>512)throw new PlatformCliError('CLI 계정 저장소 형식을 확인하세요.');
    for(const a of d.accounts)if(!platformCliManagedId(a.id)||!platformCliProvider(a.provider)||!platformCliText(a.label,64)||!['unchecked','ready'].includes(a.state)||typeof a.archived!=='boolean'||!/^[a-f0-9]{64}$/.test(a.credentialHash)||!/^[a-f0-9]{64}$/.test(a.revision)||!(a.identity===null||typeof a.identity==='string'&&a.identity.length<=120))throw new PlatformCliError('CLI 계정 기록을 확인하세요.');
    if(new Set(d.accounts.map(a=>a.id)).size!==d.accounts.length)throw new PlatformCliError('중복된 CLI 계정입니다.');
    for(const [key,b]of Object.entries(d.bindings)){if(!/^[a-f0-9]{64}$/.test(key))throw new PlatformCliError('CLI 프로젝트 연결을 확인하세요.');platformCliBinding(b);}
    if(d.deviceDefaults!==undefined){
      if(!d.deviceDefaults||typeof d.deviceDefaults!=='object'||Array.isArray(d.deviceDefaults))throw new PlatformCliError('기기 기본 계정을 확인하세요.');
      for(const [provider,value]of Object.entries(d.deviceDefaults))if(!platformCliProvider(provider)||!value||platformCliEmail(value.email)!==value.email||value.accountId!==null&&!platformCliManagedId(value.accountId))throw new PlatformCliError('기기 기본 계정을 확인하세요.');
    }
    for(const a of d.accounts)if(a.verifiedEmail!==undefined&&platformCliEmail(a.verifiedEmail)!==a.verifiedEmail)throw new PlatformCliError('계정 이메일을 확인하세요.');
    return d;
  }
  private key(targetId:string,provider:PlatformCliProvider) {if(!/^[A-Za-z0-9_-]{1,200}$/.test(targetId)||!platformCliProvider(provider))throw new PlatformCliError('등록 프로젝트와 CLI를 선택하세요.');return platformCliHash(JSON.stringify([targetId,provider]));}
  private async change(operation:string,requestId:string,input:unknown,update:(d:Data)=>Promise<string>|string) {
    platformCliRequestId(requestId);this.directory(true);
    return withOwnedPortalFileLock(this.file+'.lock',async()=>{
      const d=this.read(),hash=platformCliHash(JSON.stringify([operation,input]));
      d.receipts=d.receipts.filter(r=>Date.now()-r.at<86_400_000);
      const old=d.receipts.find(r=>r.id===requestId);
      if(old){if(old.hash!==hash)throw new PlatformCliError('같은 요청 ID로 다른 CLI 설정을 변경할 수 없습니다.');return old.result;}
      if(d.receipts.length>=512)throw new PlatformCliError('최근 CLI 설정 요청 한도에 도달했습니다.');
      const result=await update(d);d.receipts.push({id:requestId,hash,result,at:Date.now()});
      writePrivateFileAtomically(this.root,this.file,JSON.stringify(d));return result;
    },{label:'Platform CLI accounts',attempts:50,retryMs:20,deadOwnerRecoveryClass:'manual',canRecoverDeadOwner:()=>false});
  }
  list(provider?:PlatformCliProvider):PlatformCliAccount[] {return this.read().accounts.filter(a=>!a.archived&&(!provider||a.provider===provider)).map(({credentialHash,archived,...a})=>a);}
  account(id:string):PlatformCliAccount {const a=this.list().find(a=>a.id===id);if(!a)throw new PlatformCliError('선택한 CLI 계정을 사용할 수 없습니다.');return a;}
  binding(targetId:string,provider:PlatformCliProvider) {return this.read().bindings[this.key(targetId,provider)]??null;}
  deviceDefaults():PlatformCliDeviceDefaults {return this.read().deviceDefaults??{};}
  /** Whether any project chose an account of its own (not 「this Mac」). */
  hasProjectAccounts():boolean {return Object.values(this.read().bindings).some(b=>b.accountId!==PLATFORM_CLI_DEFAULT_ACCOUNT);}
  defaultAccountId(provider:PlatformCliProvider):string {
    const value=this.deviceDefaults()[provider];
    if(!value)return PLATFORM_CLI_DEFAULT_ACCOUNT;
    if(!value.accountId)throw new PlatformCliError(`${value.email} · 로그인 필요. 다른 계정으로 실행하지 않았습니다.`);
    const a=this.account(value.accountId);
    if(a.provider!==provider||a.state!=='ready'||a.verifiedEmail!==value.email)throw new PlatformCliError('기기 기본 계정의 인증을 다시 확인하세요. 다른 계정으로 실행하지 않았습니다.');
    return a.id;
  }
  /** The Mac-wide login was switched to one with no connected account: app runs follow that login again. */
  async clearDefault(provider:PlatformCliProvider,requestId:string) {
    if(!platformCliProvider(provider))throw new PlatformCliError('지원하는 CLI를 선택하세요.');
    await this.change('device-default-clear',requestId,provider,d=>{if(d.deviceDefaults)delete d.deviceDefaults[provider];return provider;});
  }
  /** The connected account whose stored credential is exactly this one — never a guess from a name. */
  matchCredential(provider:PlatformCliProvider,secret:string):PlatformCliAccount|null {
    let normalized:string;try{normalized=validatePlatformCliCredential(provider,secret);}catch{return null;}
    const hash=platformCliHash(normalized),row=this.read().accounts.find(a=>!a.archived&&a.provider===provider&&a.credentialHash===hash);
    if(!row)return null;const {credentialHash,archived,...account}=row;return account;
  }
  /** A null account reserves the user's intended email; it never means native fallback. */
  async setDefault(provider:PlatformCliProvider,emailValue:unknown,accountId:string|null,requestId:string) {
    if(!platformCliProvider(provider))throw new PlatformCliError('지원하는 CLI를 선택하세요.');
    const email=platformCliEmail(emailValue);
    await this.change('device-default',requestId,[provider,email,accountId],d=>{
      if(accountId!==null){const a=d.accounts.find(a=>a.id===accountId&&!a.archived&&a.provider===provider&&a.state==='ready'&&a.verifiedEmail===email);if(!a)throw new PlatformCliError('이메일을 인증한 같은 CLI 계정을 선택하세요.');}
      (d.deviceDefaults??={})[provider]={email,accountId};return accountId??'login-required';
    });return this.deviceDefaults()[provider]!;
  }
  async verified(account:PlatformCliAccount,emailValue:unknown,requestId:string) {
    const email=platformCliEmail(emailValue);
    await this.change('verified-email',requestId,[account.id,account.revision,email],d=>{
      const a=d.accounts.find(a=>a.id===account.id&&!a.archived&&a.revision===account.revision&&a.state==='ready');
      if(!a||a.verifiedEmail&&a.verifiedEmail!==email)throw new PlatformCliError('인증 계정의 이메일이 변경되었습니다.');a.verifiedEmail=email;return a.id;
    });return this.account(account.id);
  }
  async attachVerifiedDefault(account:PlatformCliAccount,requestId:string) {
    await this.change('attach-default',requestId,[account.id,account.revision,account.verifiedEmail],d=>{
      const a=d.accounts.find(a=>a.id===account.id&&!a.archived&&a.revision===account.revision&&a.state==='ready'&&a.verifiedEmail===account.verifiedEmail);
      if(!a||!a.verifiedEmail)throw new PlatformCliError('계정 이메일 인증을 확인하세요.');
      const current=d.deviceDefaults?.[a.provider];
      if(current?.email===a.verifiedEmail&&current.accountId===null)current.accountId=a.id;
      return a.id;
    });
  }
  /** The newcomer explicitly authenticated this account; fill only an unset device default. */
  async attachOnboardingDefault(account:PlatformCliAccount,requestId:string){
    await this.change('onboarding-default',requestId,[account.id,account.revision,account.verifiedEmail],d=>{
      const a=d.accounts.find(a=>a.id===account.id&&!a.archived&&a.revision===account.revision&&a.state==='ready'&&a.verifiedEmail===account.verifiedEmail);
      if(!a?.verifiedEmail)throw new PlatformCliError('계정 이메일 인증을 확인하세요.');
      d.deviceDefaults??={};if(!d.deviceDefaults[a.provider])d.deviceDefaults[a.provider]={email:a.verifiedEmail,accountId:a.id};return a.id;
    });
  }
  /** CLI-managed OAuth refresh; compare the original revision under the same registry lock. */
  async refreshed(account:PlatformCliAccount,value:string) {
    const secret=validatePlatformCliCredential(account.provider,value),hash=platformCliHash(secret);
    this.directory(true);
    await withOwnedPortalFileLock(this.file+'.lock',async()=>{
      const d=this.read(),a=d.accounts.find(a=>a.id===account.id&&!a.archived&&a.revision===account.revision);
      if(!a)throw new PlatformCliError('OAuth 계정이 변경되었습니다.');
      if(a.credentialHash===hash)return;
      await this.secrets.set(a.id,secret);a.credentialHash=hash;a.revision=platformCliHash(a.id+hash);
      writePrivateFileAtomically(this.root,this.file,JSON.stringify(d));
    },{label:'Platform OAuth refresh',attempts:50,retryMs:20,deadOwnerRecoveryClass:'manual',canRecoverDeadOwner:()=>false});
  }
  async create(provider:PlatformCliProvider,label:string,credential:unknown,requestId:string) {
    if(!platformCliProvider(provider)||!platformCliText(label,64))throw new PlatformCliError('CLI와 계정 이름을 확인하세요.');
    const secret=validatePlatformCliCredential(provider,credential),credentialHash=platformCliHash(secret);
    const id=await this.change('create',requestId,[provider,label,credentialHash],async d=>{
      if(d.accounts.length>=64||d.accounts.some(a=>!a.archived&&a.provider===provider&&a.label===label))throw new PlatformCliError('중복되지 않는 계정 이름을 사용하세요. 계정은 최대 64개입니다.');
      const id='pcli_'+randomUUID();try{await this.secrets.set(id,secret);}catch{throw new PlatformCliError('OS 자격 증명 저장소에 계정을 저장하지 못했습니다.');}
      d.accounts.push({id,provider,label,credentialHash,revision:platformCliHash(id+credentialHash),identity:null,state:'unchecked',archived:false});return id;
    });return this.account(id);
  }
  async credential(account:PlatformCliAccount):Promise<string> {
    const current=this.read().accounts.find(a=>a.id===account.id&&!a.archived);
    if(!current||current.revision!==account.revision)throw new PlatformCliError('CLI 계정이 변경되었습니다. 다시 선택하세요.');
    let value:string|null;try{value=await this.secrets.get(current.id);}catch{throw new PlatformCliError('OS 자격 증명 저장소에서 선택한 계정을 확인하지 못했습니다.');}
    if(!value||platformCliHash(value)!==current.credentialHash)throw new PlatformCliError('선택한 CLI 인증 정보를 확인하지 못했습니다. 다른 계정으로 실행하지 않았습니다.');
    if(this.account(account.id).revision!==account.revision)throw new PlatformCliError('CLI 계정이 변경되었습니다.');return value;
  }
  async checked(account:PlatformCliAccount,identity:string|null,requestId:string) {
    await this.change('checked',requestId,[account.id,account.revision,identity],d=>{
      const a=d.accounts.find(a=>a.id===account.id&&!a.archived&&a.revision===account.revision);if(!a)throw new PlatformCliError('CLI 계정이 변경되었습니다.');
      if(a.identity&&a.identity!==identity)throw new PlatformCliError('연결한 계정의 정체성이 달라졌습니다.');a.state='ready';a.identity=identity;return a.id;
    });return this.account(account.id);
  }
  async bind(targetId:string,provider:PlatformCliProvider,value:unknown,requestId:string) {
    const binding=platformCliBinding(value);
    if(binding.accountId===PLATFORM_CLI_DEFAULT_ACCOUNT||provider==='github'&&platformCliNativeGithubLogin(binding.accountId)){
      // Native logins are resolved by the host at selection/execution. No credential is copied here.
      await this.change('bind',requestId,[targetId,provider,binding],d=>{
        const key=this.key(targetId,provider);
        if(binding.accountId===PLATFORM_CLI_DEFAULT_ACCOUNT&&!binding.scope&&!binding.resourceId)delete d.bindings[key];else d.bindings[key]=binding;
        return binding.accountId;
      });return this.binding(targetId,provider);
    }
    const a=this.account(binding.accountId);
    if(a.provider!==provider||a.state!=='ready')throw new PlatformCliError('연결 상태를 확인한 같은 CLI 계정을 선택하세요.');
    await this.change('bind',requestId,[targetId,provider,binding],d=>{const current=d.accounts.find(x=>x.id===a.id&&!x.archived&&x.revision===a.revision);if(!current)throw new PlatformCliError('CLI 계정이 변경되었습니다.');d.bindings[this.key(targetId,provider)]=binding;return a.id;});return binding;
  }
  async archive(id:string,requestId:string) {
    this.account(id);await this.change('archive',requestId,id,d=>{const a=d.accounts.find(a=>a.id===id&&!a.archived);if(!a)throw new PlatformCliError('CLI 계정을 확인하세요.');a.archived=true;return id;});
  }
}
