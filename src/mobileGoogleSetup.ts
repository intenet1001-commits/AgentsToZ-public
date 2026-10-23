import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {withOwnedPortalFileLock} from './portalFileLock';
import {readPrivateFileStrict,writePrivateFileAtomically} from './remoteControlHostVault';

export const MOBILE_GOOGLE_RETURN='agentstoz-mobile://auth/callback?state=*';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const validId=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{8,100}$/.test(v);
type Auth=Record<string,unknown>;
export interface MobileGoogleAccount {id:string;revision:string;email:string}
export interface MobileGoogleEffects {
  target():{ref:string;googleProjectId?:string};
  account(id:string):Promise<MobileGoogleAccount>;
  read(ref:string,account:MobileGoogleAccount):Promise<Auth>;
  patch(ref:string,account:MobileGoogleAccount,patch:Auth):Promise<void>;
  now?:()=>number;
}
function redirectList(auth:Auth){
  const raw=auth.uri_allow_list;
  if(raw!==undefined&&typeof raw!=='string'||typeof raw==='string'&&raw.length>12000)throw Error('기존 앱 복귀 주소를 확인하지 못했습니다. 공식 설정 화면에서 확인하세요.');
  const values=[...new Set(((raw as string|undefined)??'').split(',').map(s=>s.trim()).filter(Boolean))];
  if(values.length>255)throw Error('기존 앱 복귀 주소가 너무 많습니다. 공식 설정에서 확인하세요.');
  return values;
}
function facts(auth:Auth){return {enabled:auth.external_google_enabled===true,clientId:typeof auth.external_google_client_id==='string'?auth.external_google_client_id:'',secretPresent:typeof auth.external_google_secret==='string'&&!!auth.external_google_secret,returns:redirectList(auth)};}
export function parseGoogleWebClient(raw:unknown,ref:string){
  if(typeof raw!=='string'||Buffer.byteLength(raw)>8000)throw Error('Google에서 받은 웹 애플리케이션 JSON 파일을 직접 첨부하세요.');
  let value:any;try{value=JSON.parse(raw);}catch{throw Error('웹 애플리케이션 JSON 형식을 확인하세요.');}
  const c=value?.web;
  if(!c||value.installed||value.type||typeof c.client_id!=='string'||!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(c.client_id)||c.client_id.length>512
    ||typeof c.client_secret!=='string'||c.client_secret.length<8||c.client_secret.length>4096||/[\s\x00-\x1f]/.test(c.client_secret)
    ||c.auth_uri!=='https://accounts.google.com/o/oauth2/auth'||c.token_uri!=='https://oauth2.googleapis.com/token'
    ||!Array.isArray(c.redirect_uris)||!c.redirect_uris.includes(`https://${ref}.supabase.co/auth/v1/callback`)
    ||typeof c.project_id!=='string'||!/^[-a-zA-Z0-9_]{1,128}$/.test(c.project_id))throw Error('같은 Supabase의 callback 주소가 등록된 웹 애플리케이션 JSON이 필요합니다. Workspace 데스크톱 JSON은 바꾸지 않습니다.');
  return {clientId:c.client_id as string,secret:c.client_secret as string,projectId:c.project_id as string};
}
interface Review {id:string;at:number;ref:string;account:MobileGoogleAccount;revision:string;patch:Auth;clientId:string;googleProjectId?:string;changes:string[]}
interface Attempt {requestId:string;reviewId:string;ref:string;accountId:string;clientId:string;returns:string[];state:'unconfirmed'|'configured';at:number}
/** The only writer is an explicitly reviewed apply. Unknown outcomes are read back,
 * never replayed. Credentials stay in RAM; the bounded journal contains public metadata only. */
export class MobileGoogleSetup {
  private reviews=new Map<string,Review>();
  constructor(private directory:string,private effects:MobileGoogleEffects){}
  private now(){return this.effects.now?.()??Date.now();}
  private path(){return join(this.directory,'google-login-attempts.json');}
  private attempts():Attempt[]{
    const raw=readPrivateFileStrict(this.path());if(raw===null)return [];
    let rows:unknown;try{if(Buffer.byteLength(raw)>400_000)throw Error();rows=JSON.parse(raw);}catch{throw Error('이전 Google 설정 기록을 확인하세요. 자동 재실행하지 않습니다.');}
    if(!Array.isArray(rows)||rows.length>24||rows.some(r=>!r||typeof r!=='object'||Array.isArray(r)
      ||Object.keys(r).some(k=>!['requestId','reviewId','ref','accountId','clientId','returns','state','at'].includes(k))
      ||!validId(r.requestId)||!validId(r.reviewId)||!validId(r.accountId)||!['unconfirmed','configured'].includes(r.state)
      ||typeof r.ref!=='string'||!/^[a-z0-9]{20}$/.test(r.ref)||typeof r.clientId!=='string'||r.clientId.length>512
      ||!Array.isArray(r.returns)||r.returns.length>256||r.returns.some((u:unknown)=>typeof u!=='string'||u.length>12000)
      ||r.returns.join(',').length>12000||!Number.isSafeInteger(r.at)||r.at<0)
      ||new Set(rows.map(r=>r.requestId)).size!==rows.length)throw Error('이전 Google 설정 기록을 확인하세요. 자동 재실행하지 않습니다.');
    return rows;
  }
  private save(rows:Attempt[]){
    if(rows.length>24)throw Error('Google 설정 확인 기록 한도입니다. 미확정 결과를 먼저 확인하세요.');
    writePrivateFileAtomically(this.directory,this.path(),JSON.stringify(rows));
  }
  private async current(accountId:string){
    const target=this.effects.target();if(!/^[a-z0-9]{20}$/.test(target.ref))throw Error('이 Mac의 Supabase 프로젝트를 먼저 확인하세요.');
    const account=await this.effects.account(accountId),auth=await this.effects.read(target.ref,account);
    if(this.effects.target().ref!==target.ref||(await this.effects.account(accountId)).revision!==account.revision)throw Error('설정 대상 또는 계정이 바뀌었습니다.');
    return {target,account,auth,revision:hash([target.ref,account.id,account.revision,facts(auth),auth.external_google_secret])};
  }
  private view(c:Awaited<ReturnType<MobileGoogleSetup['current']>>){
    const f=facts(c.auth);return {projectRef:c.target.ref,googleProjectId:c.target.googleProjectId??null,accountEmail:c.account.email,revision:c.revision,
      googleConfigured:f.enabled&&!!f.clientId&&f.secretPresent,nativeReturnConfigured:f.returns.includes(MOBILE_GOOGLE_RETURN),
      emailLimitPerHour:Number.isSafeInteger(c.auth.rate_limit_email_sent)?c.auth.rate_limit_email_sent:null,
      callbackUrl:`https://${c.target.ref}.supabase.co/auth/v1/callback`,nativeReturnUrl:MOBILE_GOOGLE_RETURN,
      providerUrl:`https://supabase.com/dashboard/project/${c.target.ref}/auth/providers`,phoneLoginVerified:false,
      pendingAttempts:this.attempts().filter(a=>a.ref===c.target.ref&&a.accountId===c.account.id&&a.state==='unconfirmed').map(a=>({requestId:a.requestId,at:a.at}))};
  }
  async handle(raw:unknown):Promise<any>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Google 로그인 준비 요청을 확인하세요.');
    const r=raw as Record<string,unknown>,allowed:Record<string,string[]>={'google-login-status':['accountId'],'google-login-review':['accountId','clientJson'],'google-login-apply':['accountId','reviewId','requestId','consent'],'google-login-check':['accountId','requestId']};
    if(typeof r.operation!=='string'||!Object.hasOwn(allowed,r.operation)||Object.keys(r).some(k=>k!=='operation'&&!allowed[r.operation as string]!.includes(k))||!validId(r.accountId))throw Error('인증된 Supabase 관리 계정을 선택하세요.');
    for(const [id,v] of this.reviews)if(this.now()-v.at>300_000)this.reviews.delete(id);
    const c=await this.current(r.accountId);
    if(r.operation==='google-login-status')return this.view(c);
    if(r.operation==='google-login-check'){
      if(!validId(r.requestId))throw Error('확인할 설정 기록을 선택하세요.');
      return withOwnedPortalFileLock(this.path()+'.lock',async()=>{
        const rows=this.attempts(),attempt=rows.find(a=>a.requestId===r.requestId),latest=await this.current(r.accountId as string);
        if(!attempt||attempt.ref!==latest.target.ref||attempt.accountId!==latest.account.id)throw Error('같은 프로젝트·계정의 설정 기록을 선택하세요.');
        const f=facts(latest.auth),confirmed=f.enabled&&f.secretPresent&&f.clientId===attempt.clientId&&attempt.returns.every(u=>f.returns.includes(u));
        if(confirmed){attempt.state='configured';this.save(rows);}
        return {...this.view(latest),state:confirmed?'configured':'unconfirmed',replayed:false};
      },{label:'mobile Google login readback'});
    }
    if(r.operation==='google-login-review'){
      for(const [id,v] of this.reviews)if(v.ref===c.target.ref&&v.account.id===c.account.id)this.reviews.delete(id);
      if(this.reviews.size>=8)throw Error('준비 중인 검토를 마친 뒤 다시 확인하세요.');
      const f=facts(c.auth),web=r.clientJson===undefined?null:parseGoogleWebClient(r.clientJson,c.target.ref);
      if(web&&f.clientId&&web.clientId!==f.clientId)throw Error('기존 Google 로그인 클라이언트가 있습니다. 덮어쓰지 않았습니다. 공식 설정에서 기존 값을 확인하세요.');
      if(!web&&(!f.clientId||!f.secretPresent))throw Error('Google 웹 애플리케이션 JSON을 직접 첨부하세요.');
      const patch:Auth={},changes:string[]=[];
      if(!f.enabled){patch.external_google_enabled=true;changes.push('이 Supabase에 Google 로그인 켜기');}
      if(web&&(!f.clientId||!f.secretPresent)){patch.external_google_client_id=web.clientId;patch.external_google_secret=web.secret;changes.push('선택한 웹 로그인 클라이언트 등록');}
      if(!f.returns.includes(MOBILE_GOOGLE_RETURN)){patch.uri_allow_list=[...f.returns,MOBILE_GOOGLE_RETURN].join(',');changes.push('기존 주소를 유지하며 iPhone 앱 복귀 주소 추가');}
      redirectList({...c.auth,...patch});
      const review:Review={id:randomUUID(),at:this.now(),ref:c.target.ref,account:c.account,revision:c.revision,patch,clientId:web?.clientId??f.clientId,googleProjectId:web?.projectId??c.target.googleProjectId,changes};
      this.reviews.set(review.id,review);
      return {...this.view(c),reviewId:review.id,changes,googleProjectId:review.googleProjectId??null,requiresApply:changes.length>0};
    }
    if(!validId(r.reviewId)||!validId(r.requestId)||r.consent!==true)throw Error('대상 프로젝트와 변경 내용을 확인하고 적용에 동의하세요.');
    return withOwnedPortalFileLock(this.path()+'.lock',async()=>{
      const rows=this.attempts(),previous=rows.find(a=>a.requestId===r.requestId);
      const latest=await this.current(r.accountId as string);
      const configured=(a:Attempt)=>{const f=facts(latest.auth);return a.ref===latest.target.ref&&a.accountId===latest.account.id&&f.enabled&&f.secretPresent&&f.clientId===a.clientId&&a.returns.every(u=>f.returns.includes(u));};
      if(previous){
        if(previous.reviewId!==r.reviewId||previous.accountId!==r.accountId||!configured(previous))throw Error('이전 적용 결과를 확정하지 못했습니다. 다시 쓰지 않았습니다. 공식 설정과 iPhone 로그인을 확인하세요.');
        previous.state='configured';this.save(rows);return {...this.view(latest),state:'configured',replayed:false};
      }
      if(rows.some(a=>a.ref===latest.target.ref&&a.state==='unconfirmed'&&!configured(a)))throw Error('이전 적용 결과 확인이 필요합니다. Google 설정을 자동으로 다시 변경하지 않습니다.');
      const review=this.reviews.get(r.reviewId as string);
      if(!review||review.account.id!==r.accountId||review.account.revision!==latest.account.revision||review.ref!==latest.target.ref||review.revision!==latest.revision)throw Error('설정이나 검토가 바뀌었습니다. 변경 내용을 다시 확인하세요.');
      const attempt:Attempt={requestId:r.requestId as string,reviewId:review.id,ref:review.ref,accountId:review.account.id,clientId:review.clientId,returns:redirectList({...latest.auth,...review.patch}),state:'unconfirmed',at:this.now()};
      // Retire completed metadata only. An unresolved fence survives every new request.
      while(rows.length>=24){const index=rows.findIndex(a=>a.state==='configured');if(index<0)throw Error('미확정 Google 설정 기록을 먼저 확인하세요.');rows.splice(index,1);}
      rows.push(attempt);this.save(rows); // Durable fence precedes the only remote write.
      this.reviews.delete(review.id);
      if(review.changes.length)await this.effects.patch(review.ref,review.account,review.patch);
      const after=await this.current(review.account.id),f=facts(after.auth);
      if(!f.enabled||!f.secretPresent||f.clientId!==review.clientId||!attempt.returns.every(u=>f.returns.includes(u)))throw Error('등록 확인이 끝나지 않았습니다. 같은 적용 결과만 확인하며 재실행하지 않습니다.');
      attempt.state='configured';this.save(rows);this.reviews.delete(review.id);
      return {...this.view(after),state:'configured',replayed:false};
    },{label:'mobile Google login configuration'});
  }
}
