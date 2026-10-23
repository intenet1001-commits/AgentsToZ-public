import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PlatformCliStore} from '../src/platformCliStore';
import {PlatformCliHost} from '../src/platformCliHost';
import {createOnboardingCloudEffects} from '../src/onboardingCloudEffects';
import {onboardingSchemaHash,type CloudJob} from '../src/onboardingCloudHost';
import {PORTMGR_TABLES} from '../src/schemaSql';
const dirs:string[]=[];afterEach(()=>dirs.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true})));
async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'atz-cloud-effects-'));dirs.push(dir);const secrets=new Map<string,string>();
  const store=new PlatformCliStore(dir,{get:async id=>secrets.get(id)??null,set:async(id,v)=>{secrets.set(id,v);}});
  let a=await store.create('supabase','owner','sbp_'+'a'.repeat(40),crypto.randomUUID());a=await store.checked(a,'owner',crypto.randomUUID());a=await store.verified(a,'owner@example.test',crypto.randomUUID());
  const host=new PlatformCliHost({store,executable:()=>'/fixture/supabase',resolveProject:async id=>({id,cwd:dir,label:id}),env:{SUPABASE_ACCESS_TOKEN:'UNRELATED_GLOBAL_TOKEN'}});
  const job:CloudJob={id:crypto.randomUUID(),account:{id:a.id,revision:a.revision,email:a.verifiedEmail!},organization:{id:'organization-free',name:'본인 조직',plan:'free'},name:'AgentsToZ-'+'a'.repeat(16),ref:'a'.repeat(20),stage:'waiting',schemaHash:onboardingSchemaHash(a.verifiedEmail!),createdAt:Date.now(),active:false,message:'',ownerPid:process.pid};
  const calls:{url:string;method:string;body:any;authorization:string|null}[]=[],saved:any[]=[];let plan='free',anonStatus=403,receipt=true,secured=true,modernOnly=false;
  const publicKey='sb_publishable_'+'x'.repeat(24),serviceKey='sb_secret_'+'y'.repeat(40);
  const fetcher=(async(input:any,init:any={})=>{
    const url=new URL(String(input)),body=init.body?JSON.parse(init.body):null,authorization=new Headers(init.headers).get('Authorization');calls.push({url:url.href,method:init.method??'GET',body,authorization});
    if(url.hostname.endsWith('.supabase.co')){expect(authorization).toBeNull();return Response.json([],{status:new Headers(init.headers).get('apikey')===serviceKey?200:anonStatus});}
    expect(authorization).toBe('Bearer sbp_'+'a'.repeat(40));
    if(url.pathname==='/v1/organizations')return Response.json([{slug:job.organization.id}]);
    if(url.pathname.startsWith('/v1/organizations/'))return Response.json({id:job.organization.id,name:'본인 조직',plan});
    if(url.pathname==='/v1/projects')return Response.json(init.method==='POST'?{ref:job.ref,name:job.name,organization_slug:job.organization.id}:[{ref:job.ref,name:job.name,organization_slug:job.organization.id,created_at:new Date(job.createdAt).toISOString()}]);
    if(url.pathname.endsWith('/api-keys')){expect(url.searchParams.get('reveal')).toBe('true');return Response.json(modernOnly?[{name:'default',type:'publishable',api_key:publicKey},{name:'default',type:'secret',api_key:serviceKey}]:[{name:'anon',api_key:publicKey},{name:'service_role',api_key:serviceKey}]);}
    if(url.pathname.endsWith('/database/query')){
      if(body.query.includes('to_regclass'))return Response.json([{present:receipt}]);
      if(body.query.startsWith('select request_id'))return Response.json([{request_id:job.id,schema_hash:job.schemaHash}]);
      if(body.query.startsWith('select count'))return Response.json([{count:PORTMGR_TABLES.length,secured}]);
      return Response.json([]);
    }
    return Response.json({ref:job.ref,name:job.name,organization_slug:job.organization.id,status:'ACTIVE_HEALTHY'});
  }) as typeof fetch;
  const effects=createOnboardingCloudEffects(host,{configured:()=>false,connected:()=>true,save:async(value,j)=>{saved.push({value,id:j.id});}},fetcher);
  return {host,job,effects,calls,saved,publicKey,serviceKey,modernOnly:()=>{modernOnly=true;},setPlan:(v:string)=>{plan=v;},allowAnon:()=>{anonStatus=200;},unsecured:()=>{secured=false;},missingReceipt:()=>{receipt=false;}};
}
test('production effects use only the selected credential and a fresh dedicated free project',async()=>{
  const f=await fixture(),signal=new AbortController().signal;expect(await f.effects.organizations(f.job.account)).toEqual([f.job.organization]);
  const ref=await f.effects.create(f.job,'generated-private-password',signal);expect(ref).toBe(f.job.ref!);
  expect(f.calls.find(c=>c.method==='POST')?.body).toEqual({name:f.job.name,organization_slug:f.job.organization.id,db_pass:'generated-private-password',region:'ap-northeast-1'});
  expect(await f.effects.find(f.job,signal)).toBe(ref);await f.effects.wait(f.job,signal);expect(await f.effects.schemaPresent(f.job,signal)).toBe(true);await f.effects.verify(f.job,signal);await f.effects.save(f.job,signal);
  expect(f.saved[0].value).toEqual({ref:f.job.ref,publicKey:f.publicKey,serviceKey:f.serviceKey,email:f.job.account.email});
  expect(f.calls.some(c=>c.authorization?.includes('UNRELATED'))).toBe(false);expect(f.calls.filter(c=>c.url.endsWith('/database/query')&&c.body?.read_only===false)).toHaveLength(1);
});
test('paid plan, anonymous access, absent receipt and archived account stop the corresponding effects',async()=>{
  const signal=new AbortController().signal;
  const paid=await fixture();paid.setPlan('pro');await expect(paid.effects.create(paid.job,'password',signal)).rejects.toThrow('무료');expect(paid.calls.filter(c=>c.method==='POST')).toEqual([]);
  const exposed=await fixture();exposed.allowAnon();await expect(exposed.effects.verify(exposed.job,signal)).rejects.toThrow('익명');expect(exposed.saved).toEqual([]);
  const missing=await fixture();missing.missingReceipt();await expect(missing.effects.verify(missing.job,signal)).rejects.toThrow('데이터 구조');
  const revoked=await fixture();await revoked.host.store.archive(revoked.job.account.id,crypto.randomUUID());await expect(revoked.effects.create(revoked.job,'password',signal)).rejects.toThrow();expect(revoked.calls).toEqual([]);
  const rls=await fixture();rls.unsecured();await expect(rls.effects.verify(rls.job,signal)).rejects.toThrow('보안');expect(rls.calls.some(c=>c.body?.read_only===false)).toBe(false);
});

test('a newly created project with only publishable/secret keys completes without a legacy anon key',async()=>{const f=await fixture();f.modernOnly();const signal=new AbortController().signal;await f.effects.verify(f.job,signal);await f.effects.save(f.job,signal);expect(f.saved[0].value.publicKey).toBe(f.publicKey);});
