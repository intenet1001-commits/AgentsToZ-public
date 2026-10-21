import {PlatformCliHost} from './platformCliHost';
import {platformCliManagedId} from './platformCliProtocol';
import {PORTMGR_TABLES} from './schemaSql';
import {selectServiceRoleKey} from './supabaseServiceKeyCli';
import {isPublicSupabaseClientKey} from './onboardingHandoff';
import type {CloudAccount,CloudEffects,CloudJob} from './onboardingCloudHost';
import {CloudCreateRejected} from './onboardingCloudHost';
import {supabaseApiKeyHeaders} from './supabaseApiKeyHeaders';

export const CLOUD_SCHEMA_RECEIPT='agentstoz_onboarding.installation';
export function cloudWriteReadProbeSql(id:string){
  if(!/^[a-zA-Z0-9_-]{8,100}$/.test(id))throw Error('준비 기록을 확인하세요.');
  return `begin; insert into public.portmgr_ports(id,name) values ('onboarding-${id}','onboarding connection check'); do $probe$ begin if not exists(select 1 from public.portmgr_ports where id='onboarding-${id}') then raise exception 'ONBOARDING_WRITE_READ_FAILED'; end if; end $probe$; delete from public.portmgr_ports where id='onboarding-${id}'; commit;`;
}
export function cloudSchemaTransaction(job:CloudJob,sql:string){
  if(!/^[a-zA-Z0-9_-]{8,100}$/.test(job.id)||!/^[a-f0-9]{64}$/.test(job.schemaHash))throw Error('준비 기록을 확인하세요.');
  return `begin;
select pg_advisory_xact_lock(8726102201);
do $guard$ begin if exists(select 1 from pg_tables where schemaname='public') then raise exception 'NONEMPTY_ONBOARDING_TARGET'; end if; end $guard$;
${sql}
create schema agentstoz_onboarding;
revoke all on schema agentstoz_onboarding from public, anon, authenticated;
create table ${CLOUD_SCHEMA_RECEIPT}(request_id text primary key, schema_hash text not null);
alter table ${CLOUD_SCHEMA_RECEIPT} enable row level security;
revoke all on ${CLOUD_SCHEMA_RECEIPT} from public, anon, authenticated;
insert into ${CLOUD_SCHEMA_RECEIPT} values ('${job.id}','${job.schemaHash}');
notify pgrst, 'reload schema';
commit;`;
}
export function createOnboardingCloudEffects(host:PlatformCliHost,configuration:{configured():boolean;connected(job:CloudJob):boolean;save(value:{ref:string;publicKey:string;serviceKey:string;email:string},job:CloudJob,signal:AbortSignal):Promise<void>},fetcher:typeof fetch=fetch):CloudEffects{
  const account=async(id:string):Promise<CloudAccount>=>{
    if(!platformCliManagedId(id))throw Error('본인 계정 인증을 먼저 완료하세요.');const a=host.store.account(id);
    if(a.provider!=='supabase'||a.state!=='ready'||!a.verifiedEmail)throw Error('본인 계정 인증을 먼저 완료하세요.');
    return {id:a.id,revision:a.revision,email:a.verifiedEmail};
  };
  const api=async(a:CloudAccount,path:string,signal?:AbortSignal,body?:unknown):Promise<any>=>{
    const now=host.store.account(a.id);if(now.provider!=='supabase'||now.state!=='ready'||now.revision!==a.revision||now.verifiedEmail!==a.email)throw Error('인증한 계정이 바뀌었습니다.');
    if(!/^\/(?:organizations(?:\/[a-zA-Z0-9_-]+)?|projects(?:\/[a-z0-9]{20}(?:\/(?:database\/query|api-keys(?:\?reveal=true)?))?)?)$/.test(path))throw Error('지원하지 않는 준비 요청입니다.');
    return host.using(now,{id:'helpdesk-onboarding',cwd:host.store.root,label:'아젠투지 첫 저장소'},[],async e=>{
      const token=e.env.SUPABASE_ACCESS_TOKEN;if(!token)throw Error('인증을 확인하세요.');
      const response=await fetcher('https://api.supabase.com/v1'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(60_000)]):AbortSignal.timeout(20_000)});
      if(!response.ok)throw Error('SUPABASE_SETUP_HTTP_'+response.status);
      const text=await response.text();if(Buffer.byteLength(text)>2_000_000)throw Error('준비 응답 한도를 초과했습니다.');return JSON.parse(text);
    });
  };
  const query=(j:CloudJob,sql:string,signal:AbortSignal,readOnly=true)=>api(j.account,`/projects/${j.ref}/database/query`,signal,{query:sql,read_only:readOnly});
  const receipt=async(j:CloudJob,signal:AbortSignal)=>{
    const exists=await query(j,`select to_regclass('${CLOUD_SCHEMA_RECEIPT}') is not null as present`,signal);
    if(!Array.isArray(exists)||exists[0]?.present!==true)return false;
    const rows=await query(j,`select request_id, schema_hash from ${CLOUD_SCHEMA_RECEIPT}`,signal);
    if(!Array.isArray(rows)||rows.length!==1||rows[0]?.request_id!==j.id||rows[0]?.schema_hash!==j.schemaHash)throw Error('다른 준비 기록의 데이터베이스를 변경하지 않습니다.');return true;
  };
  const keys=async(j:CloudJob,signal:AbortSignal)=>{
    const rows=await api(j.account,`/projects/${j.ref}/api-keys?reveal=true`,signal);const serviceKey=selectServiceRoleKey(rows);
    const publicKey=Array.isArray(rows)?(rows.find(r=>r.type==='publishable'&&typeof r.api_key==='string'&&r.api_key.startsWith('sb_publishable_')&&isPublicSupabaseClientKey(r.api_key))??rows.find(r=>r.name==='anon'&&isPublicSupabaseClientKey(r.api_key)))?.api_key:null;
    if(!serviceKey||!publicKey)throw Error('프로젝트 연결 키를 확인하지 못했습니다.');return {serviceKey,publicKey};
  };
  return {
    configured:configuration.configured,connected:j=>{try{const a=host.store.account(j.account.id);return a.state==='ready'&&a.revision===j.account.revision&&a.verifiedEmail===j.account.email&&configuration.connected(j);}catch{return false;}},account,
    organizations:async a=>{
      const rows=await api(a,'/organizations');if(!Array.isArray(rows)||rows.length>64)throw Error('조직 목록을 확인하세요.');
      return Promise.all(rows.map(async row=>{const id=row.slug??row.id;if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(id))throw Error('조직 식별자를 확인하세요.');const info=await api(a,'/organizations/'+id);return {id,name:typeof info.name==='string'?info.name.slice(0,120):id,plan:info.plan==='free'?'free':'other'};}));
    },
    create:async(j,password,signal)=>{
      const org=await api(j.account,'/organizations/'+j.organization.id,signal);if(org.plan!=='free'||configuration.configured())throw new CloudCreateRejected('무료 조직과 현재 저장소를 다시 확인하세요.');
      let row:any;try{row=await api(j.account,'/projects',signal,{name:j.name,organization_slug:j.organization.id,db_pass:password,region:'ap-northeast-1'});}catch(e){if(e instanceof Error&&/^SUPABASE_SETUP_HTTP_(400|401|403|404|422|429)$/.test(e.message))throw new CloudCreateRejected('클라우드가 생성 요청을 거절했습니다.');throw e;}
      const ref=row.ref??row.id;if(typeof ref!=='string'||!/^[a-z0-9]{20}$/.test(ref)||row.name!==j.name||(row.organization_slug??row.organization_id)!==j.organization.id)throw Error('생성 결과를 확인하지 못했습니다.');return ref;
    },
    find:async(j,signal)=>{
      const rows=await api(j.account,'/projects',signal);if(!Array.isArray(rows)||rows.length>256)throw Error('생성 결과를 확인하세요.');
      const matches=rows.filter(r=>r.name===j.name&&(r.organization_slug??r.organization_id)===j.organization.id&&Number.isFinite(Date.parse(r.created_at))&&Date.parse(r.created_at)>=j.createdAt-60_000);
      if(matches.length!==1)return null;const ref=matches[0].ref??matches[0].id;return typeof ref==='string'&&/^[a-z0-9]{20}$/.test(ref)?ref:null;
    },
    wait:async(j,signal)=>{
      for(let i=0;i<80;i++){
        const row=await api(j.account,'/projects/'+j.ref,signal);
        if((row.ref??row.id)!==j.ref||row.name!==j.name||(row.organization_slug??row.organization_id)!==j.organization.id)throw Error('원래 전용 저장소를 확인하세요.');
        if(row.status==='ACTIVE_HEALTHY')return;
        await new Promise<void>((resolve,reject)=>{if(signal.aborted)return reject(Error('중단'));const abort=()=>{clearTimeout(timer);reject(Error('중단'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},5000);signal.addEventListener('abort',abort,{once:true});});
      }throw Error('데이터베이스 준비가 지연되고 있습니다.');
    },
    schemaPresent:receipt,
    schema:async(j,sql,signal)=>{if(configuration.configured())throw Error('기존 저장소 설정을 보존합니다.');await query(j,cloudSchemaTransaction(j,sql),signal,false);},
    verify:async(j,signal)=>{
      if(!await receipt(j,signal))throw Error('데이터 구조 준비를 확인하지 못했습니다.');
      const names=PORTMGR_TABLES.map(name=>"'"+name+"'").join(',');
      const rows=await query(j,`select count(*)::int as count, bool_and(c.relrowsecurity) as secured from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname in (${names})`,signal);
      if(!Array.isArray(rows)||rows[0]?.count!==PORTMGR_TABLES.length||rows[0]?.secured!==true)throw Error('데이터 구조와 보안 정책을 확인하세요.');
      // The transaction writes and reads an owned probe, then removes it before commit.
      await query(j,cloudWriteReadProbeSql(j.id),signal,false);
      const {serviceKey,publicKey}=await keys(j,signal),url=`https://${j.ref}.supabase.co/rest/v1/portmgr_ports?select=id&limit=1`;
      const fetchKey=(key:string)=>fetcher(url,{headers:supabaseApiKeyHeaders(key),redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(20_000)])});
      const [admin,anon]=await Promise.all([fetchKey(serviceKey),fetchKey(publicKey)]);
      if(!admin.ok||![401,403].includes(anon.status))throw Error('실제 연결 또는 익명 접근 차단을 확인하지 못했습니다.');
      await Promise.all([admin.body?.cancel(),anon.body?.cancel()]);
    },
    save:async(j,signal)=>{const {serviceKey,publicKey}=await keys(j,signal);signal.throwIfAborted();const current=await account(j.account.id);if(current.revision!==j.account.revision)throw Error('인증한 계정이 바뀌었습니다.');await configuration.save({ref:j.ref!,serviceKey,publicKey,email:j.account.email},j,signal);},
  };
}
