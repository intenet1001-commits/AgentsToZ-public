import {createHash,randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {mkdirSync} from 'node:fs';
import {withOwnedPortalFileLock} from './portalFileLock';
import {pathEntryExists,readPrivateFileStrict,writePrivateFileAtomically} from './remoteControlHostVault';
import {migrationSqlForAllowedEmails} from './schemaSql';

export interface CloudAccount {id:string;revision:string;email:string}
export interface CloudOrganization {id:string;name:string;plan:string}
export type CloudStage='creating'|'waiting'|'schema'|'verifying'|'saving'|'ready';
export interface CloudJob {id:string;account:CloudAccount;organization:CloudOrganization;name:string;ref:string|null;createRejected?:boolean;schemaHash:string;stage:CloudStage;createdAt:number;active:boolean;message:string;ownerPid:number}
export class CloudCreateRejected extends Error {}
export interface CloudView {revision:number;configured:boolean;connected:boolean;job:Omit<CloudJob,'ownerPid'>|null}
export interface CloudEffects {
  configured():boolean;
  connected?(job:CloudJob):boolean;
  account(id:string):Promise<CloudAccount>;
  organizations(account:CloudAccount):Promise<CloudOrganization[]>;
  create(job:CloudJob,password:string,signal:AbortSignal):Promise<string>;
  find(job:CloudJob,signal:AbortSignal):Promise<string|null>;
  wait(job:CloudJob,signal:AbortSignal):Promise<void>;
  schemaPresent(job:CloudJob,signal:AbortSignal):Promise<boolean>;
  schema(job:CloudJob,sql:string,signal:AbortSignal):Promise<void>;
  verify(job:CloudJob,signal:AbortSignal):Promise<void>;
  save(job:CloudJob,signal:AbortSignal):Promise<void>;
}
export const onboardingSchemaHash=(email:string)=>createHash('sha256').update(migrationSqlForAllowedEmails([email])).digest('hex');
const validId=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9_-]{8,100}$/.test(v);
/** One durable setup, bound to one verified account and a newly created dedicated project.
 * Reads never create projects. An unknown create outcome is reconciled by name, never repeated. */
export class OnboardingCloudHost {
  private file:string;private work:{abort:AbortController;done:Promise<void>}|null=null;private closed=false;
  constructor(private directory:string,private effects:CloudEffects){mkdirSync(directory,{recursive:true,mode:0o700});this.file=join(directory,'cloud-setup.json');}
  private read():{schema:1;revision:number;job:CloudJob|null}{
    const raw=readPrivateFileStrict(this.file);
    if(raw===null){if(pathEntryExists(this.file))throw Error('클라우드 준비 기록을 안전하게 읽지 못했습니다.');return {schema:1,revision:0,job:null};}
    if(Buffer.byteLength(raw)>16_384)throw Error('클라우드 준비 기록 한도를 확인하세요.');
    const d=JSON.parse(raw),j=d?.job;
    const exact=(v:unknown,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
    if(!exact(d,['schema','revision','job'])||j!==null&&(!exact(j,['id','account','organization','name','ref','createRejected','schemaHash','stage','createdAt','active','message','ownerPid'])||!exact(j.account,['id','revision','email'])||!exact(j.organization,['id','name','plan'])||typeof j.organization.name!=='string'||j.organization.name.length>120||j.organization.plan!=='free'||j.createRejected!==undefined&&typeof j.createRejected!=='boolean'))throw Error('클라우드 준비 기록 형식이 올바르지 않습니다. 원본을 보존했습니다.');
    if(d.schema!==1||!Number.isSafeInteger(d.revision)||d.revision<0||j&&(!validId(j.id)||!validId(j.account?.id)||typeof j.account?.revision!=='string'||typeof j.account?.email!=='string'||!validId(j.organization?.id)||!/^AgentsToZ-[a-f0-9]{16}$/.test(j.name)||!['creating','waiting','schema','verifying','saving','ready'].includes(j.stage)||j.ref!==null&&!/^[a-z0-9]{20}$/.test(j.ref)||!/^[a-f0-9]{64}$/.test(j.schemaHash)||!Number.isSafeInteger(j.ownerPid)||typeof j.active!=='boolean'||typeof j.message!=='string'||j.message.length>1000||!Number.isFinite(j.createdAt)))throw Error('클라우드 준비 기록이 올바르지 않습니다. 원본을 보존했습니다.');
    return d;
  }
  private save(d:ReturnType<OnboardingCloudHost['read']>){d.revision++;writePrivateFileAtomically(this.directory,this.file,JSON.stringify(d));}
  status():CloudView{
    const d=this.read();if(d.job?.active&&!this.work){let alive=false;try{process.kill(d.job.ownerPid,0);alive=true;}catch(e:any){alive=e.code!=='ESRCH';}if(!alive)d.job={...d.job,active:false,message:'앱이 종료됐습니다. 같은 준비 결과를 확인한 뒤 이어가세요. 자동으로 다시 생성하지 않습니다.'};}
    const {ownerPid:_,...job}=d.job??{} as CloudJob;const configured=this.effects.configured();return {revision:d.revision,configured,connected:!!d.job&&d.job.stage==='ready'&&(this.effects.connected?.(d.job)??configured),job:d.job?job:null};
  }
  async handle(value:unknown):Promise<CloudView|{organizations:CloudOrganization[];account:CloudAccount}>{
    const r=value as Record<string,unknown>,fields:Record<string,string[]>={'cloud-status':[],'cloud-options':['accountId'],'cloud-start':['accountId','organizationId','requestId','expectedRevision','consent'],'cloud-continue':['requestId','expectedRevision']};
    if(!r||typeof r!=='object'||Array.isArray(r)||typeof r.operation!=='string'||!Object.hasOwn(fields,r.operation)||Object.keys(r).some(k=>k!=='operation'&&!fields[r.operation as string]!.includes(k)))throw Error('클라우드 준비 요청을 확인하세요.');
    if(r.operation==='cloud-status')return this.status();
    if(r.operation==='cloud-options'){
      if(!validId(r.accountId))throw Error('인증한 Supabase 계정을 선택하세요.');const account=await this.effects.account(r.accountId);return {account,organizations:await this.effects.organizations(account)};
    }
    if(this.closed||!validId(r.requestId)||!Number.isSafeInteger(r.expectedRevision))throw Error('같은 준비 기록을 다시 확인하세요.');
    await withOwnedPortalFileLock(this.file+'.lock',async()=>{
      const d=this.read();
      if(r.operation==='cloud-start'&&d.job&&d.job.id===r.requestId){if(d.job.account.id!==r.accountId||d.job.organization.id!==r.organizationId||r.consent!==true)throw Error('같은 준비 번호의 대상이 달라졌습니다.');return;}
      if(d.revision!==r.expectedRevision||this.work)throw Error('현재 준비 결과를 먼저 확인하세요.');
      if(r.operation==='cloud-start'){
        if(d.job||this.effects.configured())throw Error('기존 저장소 또는 준비 기록을 유지합니다. 추가 기기는 기존 저장소에 연결하세요.');
        if(!validId(r.accountId)||!validId(r.organizationId)||r.consent!==true)throw Error('본인 계정의 무료 조직에 전용 저장소 생성을 승인하세요.');
        const account=await this.effects.account(r.accountId),organizations=await this.effects.organizations(account),organization=organizations.find(o=>o.id===r.organizationId);
        if(!organization||organization.plan!=='free')throw Error('무료 요금제를 확인한 조직을 선택하세요. 유료 전환은 자동으로 하지 않습니다.');
        d.job={id:r.requestId as string,account,organization,name:'AgentsToZ-'+randomBytes(8).toString('hex'),ref:null,schemaHash:onboardingSchemaHash(account.email),stage:'creating',createdAt:Date.now(),active:true,message:'전용 저장소를 만들고 있습니다.',ownerPid:process.pid};
      }else{
        if(!d.job||d.job.id!==r.requestId)throw Error('원래 준비 번호를 확인하세요.');
        if(d.job.stage==='ready')return;
        if(d.job.active){let alive=false;try{process.kill(d.job.ownerPid,0);alive=true;}catch(e:any){alive=e.code!=='ESRCH';}if(alive)throw Error('실행 중인 원래 준비가 끝날 때까지 같은 결과를 확인하세요.');}
        d.job.active=true;d.job.ownerPid=process.pid;d.job.message='이전 준비 결과를 확인하고 이어갑니다.';
      }
      this.save(d);const abort=new AbortController();this.work={abort,done:Promise.resolve()};this.work.done=this.run(d,r.operation==='cloud-start',abort.signal).catch(()=>{});
    },{label:'Helpdesk cloud setup admission'});
    return this.status();
  }
  private async run(d:ReturnType<OnboardingCloudHost['read']>,create:boolean,signal:AbortSignal){
    await new Promise<void>(resolve=>setTimeout(resolve,0));const j=d.job!;const timer=setTimeout(()=>this.work?.abort.abort(),15*60_000);
    const update=(stage:CloudStage,message:string)=>{j.stage=stage;j.message=message;this.save(d);};
    const binding=async()=>{if(signal.aborted)throw Error();const now=await this.effects.account(j.account.id);if(now.revision!==j.account.revision||now.email!==j.account.email||j.schemaHash!==onboardingSchemaHash(now.email))throw Error('계정 또는 앱의 준비 규격이 바뀌었습니다. 원래 결과를 확인하세요.');};
    try{
      await binding();
      if(!j.ref){
        if(create||j.createRejected){if(this.effects.configured())throw Error('기존 저장소 설정을 보존했습니다.');j.createRejected=false;this.save(d);try{j.ref=await this.effects.create(j,randomBytes(32).toString('base64url'),signal);}catch(e){if(e instanceof CloudCreateRejected)j.createRejected=true;throw e;}}
        else j.ref=await this.effects.find(j,signal);
        if(!j.ref||!/^[a-z0-9]{20}$/.test(j.ref))throw Error('생성 결과를 확정하지 못했습니다. 같은 결과만 확인하며 저장소를 다시 만들지 않습니다.');
        update('waiting','클라우드 데이터베이스가 준비되는 동안 기다리고 있습니다.');
      }
      await binding();await this.effects.wait(j,signal);
      if(['waiting','schema','creating'].includes(j.stage)){
        update('schema','아젠투지의 데이터 구조와 접근 권한을 준비하고 있습니다.');
        await binding();if(!await this.effects.schemaPresent(j,signal))await this.effects.schema(j,migrationSqlForAllowedEmails([j.account.email]),signal);
      }
      update('verifying','테이블·보안 정책과 실제 저장·조회를 검사하고 있습니다.');await binding();await this.effects.verify(j,signal);
      update('saving','이 Mac에 연결 설정을 안전하게 저장하고 있습니다.');await binding();await this.effects.save(j,signal);
      update('ready','전용 저장소와 이 Mac의 연결을 확인했습니다.');
    }catch(error){j.message=signal.aborted?'준비가 중단됐습니다. 같은 결과를 확인한 뒤 이어가세요.':error instanceof CloudCreateRejected?'클라우드가 생성 요청을 거절했습니다. 무료 프로젝트 한도·조직·계정 권한을 확인한 뒤 같은 준비 이어가기를 누르세요.':error instanceof Error&&error.message.startsWith('생성 결과')?error.message:'준비를 마치지 못했습니다. 계정 권한·네트워크·무료 프로젝트 한도를 확인한 뒤 같은 결과에서 이어가세요. 저장소를 다시 만들지 않습니다.';}
    finally{clearTimeout(timer);j.active=false;this.save(d);this.work=null;}
  }
  async shutdown(){this.closed=true;this.work?.abort.abort();await this.work?.done;}
}
