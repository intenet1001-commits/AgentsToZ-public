import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,readdirSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MobileGoogleSetup,MOBILE_GOOGLE_RETURN,parseGoogleWebClient,type MobileGoogleEffects} from '../src/mobileGoogleSetup';
import {createMobileGoogleSetupEffects} from '../src/mobileGoogleSetupEffects';
import {PlatformCliStore} from '../src/platformCliStore';
import {PlatformCliHost} from '../src/platformCliHost';

const dirs:string[]=[];
afterEach(()=>dirs.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true})));
const ref='a'.repeat(20),accountId='pcli_fixture_owner',clientId='123-fixture.apps.googleusercontent.com',secret='GOCSPX_fixture_private_secret';
const web=()=>JSON.stringify({web:{project_id:'fixture-google',client_id:clientId,client_secret:secret,auth_uri:'https://accounts.google.com/o/oauth2/auth',token_uri:'https://oauth2.googleapis.com/token',redirect_uris:[`https://${ref}.supabase.co/auth/v1/callback`]}});
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'atz-mobile-google-'));dirs.push(dir);
  const state={ref,revision:'account-revision-1',now:Date.now(),auth:{external_google_enabled:false,uri_allow_list:'https://existing.example/callback',rate_limit_email_sent:2,smtp_pass:'unrelated-private-smtp'} as Record<string,unknown>,writes:[] as Record<string,unknown>[],failAfterWrite:false,failBeforeWrite:false};
  const effects:MobileGoogleEffects={target:()=>({ref:state.ref,googleProjectId:'fixture-google'}),account:async id=>{if(id!==accountId)throw Error('wrong account');return {id,revision:state.revision,email:'owner@example.test'};},read:async()=>structuredClone(state.auth),patch:async(_ref,_account,patch)=>{state.writes.push(structuredClone(patch));if(state.failBeforeWrite)throw Error('lost before remote mutation');Object.assign(state.auth,patch);if(state.failAfterWrite)throw Error('lost response');},now:()=>state.now};
  const host=new MobileGoogleSetup(dir,effects),status=()=>host.handle({operation:'google-login-status',accountId});
  const review=(clientJson:string|undefined=web())=>host.handle({operation:'google-login-review',accountId,...(clientJson===undefined?{}:{clientJson})});
  const apply=(reviewId:string,requestId=crypto.randomUUID())=>host.handle({operation:'google-login-apply',accountId,reviewId,requestId,consent:true});
  return {dir,state,effects,host,status,review,apply};
}
test('status is read-only and reports actual project settings without auth secrets or a phone success claim',async()=>{
  const f=fixture(),view=await f.status();
  expect(view).toMatchObject({projectRef:ref,googleConfigured:false,nativeReturnConfigured:false,emailLimitPerHour:2,phoneLoginVerified:false,pendingAttempts:[]});
  expect(JSON.stringify(view)).not.toContain('smtp');expect(readdirSync(f.dir)).toEqual([]);expect(f.state.writes).toEqual([]);
});
test('Web JSON rejects Desktop clients, a different callback and oversized files',()=>{
  expect(parseGoogleWebClient(web(),ref)).toEqual({clientId,secret,projectId:'fixture-google'});
  for(const text of [JSON.stringify({installed:JSON.parse(web()).web}),web().replace(ref,'b'.repeat(20)),' '.repeat(8001),'{not-json'])expect(()=>parseGoogleWebClient(text,ref)).toThrow();
});
test('review is redacted; explicit apply preserves unrelated settings and confirms by readback',async()=>{
  const f=fixture(),review=await f.review();
  expect(review.changes).toHaveLength(3);expect(JSON.stringify(review)).not.toContain(secret);expect(f.state.writes).toEqual([]);
  await expect(f.host.handle({operation:'google-login-apply',accountId,reviewId:review.reviewId,requestId:crypto.randomUUID(),consent:false})).rejects.toThrow('동의');
  const result=await f.apply(review.reviewId);
  expect(result).toMatchObject({state:'configured',googleConfigured:true,nativeReturnConfigured:true,phoneLoginVerified:false});
  expect(f.state.writes).toEqual([{external_google_enabled:true,external_google_client_id:clientId,external_google_secret:secret,uri_allow_list:'https://existing.example/callback,'+MOBILE_GOOGLE_RETURN}]);
  expect(f.state.auth.smtp_pass).toBe('unrelated-private-smtp');
  const journal=readFileSync(join(f.dir,'google-login-attempts.json'),'utf8');expect(journal).not.toContain(secret);expect(journal).not.toContain('smtp');expect(statSync(join(f.dir,'google-login-attempts.json')).mode&0o777).toBe(0o600);
});
test('existing provider is reused, another Google client cannot replace it',async()=>{
  const f=fixture();Object.assign(f.state.auth,{external_google_enabled:true,external_google_client_id:clientId,external_google_secret:secret});
  await expect(f.review(web().replace(clientId,'other.apps.googleusercontent.com'))).rejects.toThrow('덮어쓰지');
  const review=await f.host.handle({operation:'google-login-review',accountId});
  expect(review.changes).toEqual(['기존 주소를 유지하며 iPhone 앱 복귀 주소 추가']);
  await f.apply(review.reviewId);expect(Object.keys(f.state.writes[0]!)).toEqual(['uri_allow_list']);
  const done=await f.host.handle({operation:'google-login-review',accountId});expect(done.requiresApply).toBe(false);
});
test('changing target, account, allow list or secret invalidates a reviewed write',async()=>{
  for(const mutate of [(f:ReturnType<typeof fixture>)=>{f.state.ref='b'.repeat(20);},(f:ReturnType<typeof fixture>)=>{f.state.revision='new-account';},(f:ReturnType<typeof fixture>)=>{f.state.auth.uri_allow_list='https://new.example';},(f:ReturnType<typeof fixture>)=>{f.state.auth.external_google_secret='changed-secret';}]){
    const f=fixture(),review=await f.review();mutate(f);await expect(f.apply(review.reviewId)).rejects.toThrow('바뀌었습니다');expect(f.state.writes).toEqual([]);
  }
});
test('lost PATCH response survives restart; checking and retrying never perform a second PATCH',async()=>{
  const f=fixture(),review=await f.review(),requestId=crypto.randomUUID();f.state.failAfterWrite=true;
  await expect(f.apply(review.reviewId,requestId)).rejects.toThrow('lost response');
  const restarted=new MobileGoogleSetup(f.dir,f.effects);
  const status=await restarted.handle({operation:'google-login-status',accountId});expect(status.pendingAttempts).toEqual([{requestId,at:f.state.now}]);
  const checked=await restarted.handle({operation:'google-login-check',accountId,requestId});expect(checked.state).toBe('configured');
  expect((await restarted.handle({operation:'google-login-apply',accountId,reviewId:review.reviewId,requestId,consent:true})).state).toBe('configured');
  expect(f.state.writes).toHaveLength(1);
});
test('unconfirmed write blocks a new attempt; readback does not pretend it succeeded',async()=>{
  const f=fixture(),first=await f.review(),requestId=crypto.randomUUID();f.state.failBeforeWrite=true;
  await expect(f.apply(first.reviewId,requestId)).rejects.toThrow();
  expect((await f.host.handle({operation:'google-login-check',accountId,requestId})).state).toBe('unconfirmed');
  const next=await f.review();await expect(f.apply(next.reviewId)).rejects.toThrow('이전 적용 결과');expect(f.state.writes).toHaveLength(1);
  await expect(f.apply(first.reviewId,requestId)).rejects.toThrow('다시 쓰지');expect(f.state.writes).toHaveLength(1);
});
test('concurrent double submit is serialized and its exact request cannot be rebound',async()=>{
  const f=fixture(),review=await f.review(),requestId=crypto.randomUUID();
  const results=await Promise.all([f.apply(review.reviewId,requestId),f.apply(review.reviewId,requestId)]);
  expect(results.every(r=>r.state==='configured')).toBe(true);expect(f.state.writes).toHaveLength(1);
  await expect(f.apply(crypto.randomUUID(),requestId)).rejects.toThrow('다시 쓰지');
});
test('expired reviews, unexpected fields and damaged journals fail before a write',async()=>{
  const f=fixture(),review=await f.review();f.state.now+=300_001;await expect(f.apply(review.reviewId)).rejects.toThrow('바뀌었습니다');
  await expect(f.host.handle({operation:'google-login-review',accountId,targetRef:'b'.repeat(20),clientJson:web()})).rejects.toThrow();
  writeFileSync(join(f.dir,'google-login-attempts.json'),JSON.stringify([{requestId:'valid-request',reviewId:'valid-review',ref,accountId,clientId,returns:[123],state:'unconfirmed',at:1}]),{mode:0o600});
  await expect(f.status()).rejects.toThrow('이전 Google 설정 기록');expect(f.state.writes).toEqual([]);
});
test('a full pending journal is never truncated to make room for a new attempt',async()=>{
  const f=fixture();Object.assign(f.state.auth,{external_google_enabled:true,external_google_client_id:clientId,external_google_secret:secret,uri_allow_list:MOBILE_GOOGLE_RETURN});
  const rows=Array.from({length:24},(_,i)=>({requestId:'request-'+i,reviewId:'review-'+i+'x',ref,accountId,clientId,returns:[MOBILE_GOOGLE_RETURN],state:'unconfirmed',at:1}));
  writeFileSync(join(f.dir,'google-login-attempts.json'),JSON.stringify(rows),{mode:0o600});
  const review=await f.host.handle({operation:'google-login-review',accountId});await expect(f.apply(review.reviewId)).rejects.toThrow('미확정 Google');
  expect(JSON.parse(readFileSync(join(f.dir,'google-login-attempts.json'),'utf8'))).toEqual(rows);expect(f.state.writes).toEqual([]);
});

test('production adapter uses only the verified selected credential and strips all other auth secrets',async()=>{
  const f=fixture(),secrets=new Map<string,string>(),store=new PlatformCliStore(f.dir,{get:async id=>secrets.get(id)??null,set:async(id,v)=>{secrets.set(id,v);}});
  let a=await store.create('supabase','owner','sbp_'+'a'.repeat(40),crypto.randomUUID());a=await store.checked(a,'owner',crypto.randomUUID());a=await store.verified(a,'owner@example.test',crypto.randomUUID());
  const host=new PlatformCliHost({store,executable:()=>'/fixture/supabase',resolveProject:async id=>({id,cwd:f.dir,label:id}),env:{SUPABASE_ACCESS_TOKEN:'unrelated-global-token'}});
  const calls:{url:string;init:RequestInit}[]=[];
  const fetcher=(async(input:unknown,init:RequestInit)=>{calls.push({url:String(input),init});return Response.json(f.state.auth);}) as typeof fetch;
  const effects=createMobileGoogleSetupEffects(host,()=>`https://${ref}.supabase.co`,fetcher),account=await effects.account(a.id);
  const auth=await effects.read(ref,account);expect(auth.smtp_pass).toBeUndefined();expect(auth.rate_limit_email_sent).toBe(2);
  expect(calls[0]!.url).toBe(`https://api.supabase.com/v1/projects/${ref}/config/auth`);expect(new Headers(calls[0]!.init.headers).get('Authorization')).toBe('Bearer sbp_'+'a'.repeat(40));expect(calls[0]!.init.redirect).toBe('error');
  await effects.patch(ref,account,{external_google_enabled:true});expect(calls[1]!.init.method).toBe('PATCH');
  await store.archive(a.id,crypto.randomUUID());await expect(effects.read(ref,account)).rejects.toThrow();expect(calls).toHaveLength(2);
  expect(()=>createMobileGoogleSetupEffects(host,()=>`https://${ref}.supabase.co.attacker.test`,fetcher).target()).toThrow('이 Mac');
});
