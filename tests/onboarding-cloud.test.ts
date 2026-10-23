import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,statSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {OnboardingCloudHost,CloudCreateRejected,type CloudEffects} from '../src/onboardingCloudHost';
import {cloudSchemaTransaction,cloudWriteReadProbeSql} from '../src/onboardingCloudEffects';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {pg_trgm} from '@electric-sql/pglite/contrib/pg_trgm';
import {migrationSqlForAllowedEmails,PORTMGR_TABLES} from '../src/schemaSql';
const roots:string[]=[],hosts:OnboardingCloudHost[]=[];
afterEach(async()=>{for(const h of hosts.splice(0))await h.shutdown();for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'atz-cloud-'));roots.push(root);
  const calls:string[]=[],account={id:'pcli_'+crypto.randomUUID(),revision:'account-1',email:'owner@example.test'},org={id:'organization-free',name:'본인 조직',plan:'free'};
  let configured=false,present=false;
  const effects:CloudEffects={configured:()=>configured,account:async()=>({...account}),organizations:async()=>[{...org}],create:async(_j,password)=>{expect(password.length).toBeGreaterThan(32);calls.push('create');return 'a'.repeat(20);},find:async()=>{calls.push('find');return 'a'.repeat(20);},wait:async()=>{calls.push('wait');},schemaPresent:async()=>present,schema:async(_j,sql)=>{calls.push('schema');expect(sql).toContain('portmgr_ports');expect(sql).toContain("'owner@example.test'");present=true;},verify:async()=>{calls.push('verify');},save:async()=>{calls.push('save');configured=true;}};
  const host=new OnboardingCloudHost(root,effects);hosts.push(host);
  const start=()=>({operation:'cloud-start',accountId:account.id,organizationId:org.id,requestId:crypto.randomUUID(),expectedRevision:host.status().revision,consent:true});
  return {root,host,effects,calls,account,org,start};
}
async function settle(h:OnboardingCloudHost){for(let n=0;n<400;n++){const v=h.status();if(!v.job?.active)return v;await Bun.sleep(2);}throw Error('setup did not settle');}
test('inventory and incomplete consent create nothing; one explicit setup verifies before saving',async()=>{
  const f=fixture();expect(await f.host.handle({operation:'cloud-status'})).toMatchObject({configured:false,job:null});
  expect(await f.host.handle({operation:'cloud-options',accountId:f.account.id})).toMatchObject({account:f.account,organizations:[f.org]});expect(f.calls).toEqual([]);
  await expect(f.host.handle({...f.start(),consent:false})).rejects.toThrow('승인');
  const request=f.start();await f.host.handle(request);await f.host.handle(request);const v=await settle(f.host);expect(v.job?.stage).toBe('ready');expect(v.configured).toBe(true);expect(f.calls).toEqual(['create','wait','schema','verify','save']);
  expect(v.job).not.toHaveProperty('ownerPid');expect(statSync(join(f.root,'cloud-setup.json')).mode&0o777).toBe(0o600);
  await f.host.handle(request);expect(f.calls.filter(c=>c==='create')).toHaveLength(1);
});
test('unknown create outcome is read back without a second create, including after restart',async()=>{
  const f=fixture();f.effects.create=async()=>{f.calls.push('create');throw Error('lost acknowledgement');};const request=f.start();await f.host.handle(request);let v=await settle(f.host);expect(v.job?.stage).toBe('creating');expect(v.job?.active).toBe(false);
  const next=new OnboardingCloudHost(f.root,f.effects);hosts.push(next);
  await next.handle({operation:'cloud-continue',requestId:request.requestId,expectedRevision:next.status().revision});v=await settle(next);expect(v.job?.stage).toBe('ready');expect(f.calls.filter(c=>c==='create')).toHaveLength(1);expect(f.calls.filter(c=>c==='find')).toHaveLength(1);
});
test('a missing reconciliation cannot create another project or save a false completion',async()=>{
  const f=fixture();f.effects.create=async()=>{f.calls.push('create');throw Error();};f.effects.find=async()=>null;const request=f.start();await f.host.handle(request);await settle(f.host);
  await f.host.handle({operation:'cloud-continue',requestId:request.requestId,expectedRevision:f.host.status().revision});const v=await settle(f.host);expect(v.job?.stage).toBe('creating');expect(f.calls).toEqual(['create']);
  await expect(f.host.handle(f.start())).rejects.toThrow('기존');
});
test('a definite rejection can be explicitly retried with the same setup; a lost reply still cannot',async()=>{
  const f=fixture(),original=f.effects.create;let first=true;f.effects.create=async(...args)=>{if(first){first=false;f.calls.push('rejected');throw new CloudCreateRejected('quota');}return original(...args);};
  const request=f.start();await f.host.handle(request);await settle(f.host);expect(f.host.status().job?.createRejected).toBe(true);
  await f.host.handle({operation:'cloud-continue',requestId:request.requestId,expectedRevision:f.host.status().revision});await settle(f.host);expect(f.host.status().job?.stage).toBe('ready');expect(f.calls.filter(c=>c==='create')).toHaveLength(1);
});
test('existing configuration and paid or unavailable organizations never admit a project create',async()=>{
  for(const kind of ['existing','paid','unavailable']){const f=fixture();if(kind==='existing')f.effects.configured=()=>true;else if(kind==='paid')f.org.plan='pro';else f.effects.organizations=async()=>[];await expect(f.host.handle(f.start())).rejects.toThrow();expect(f.calls).toEqual([]);}
});
test('schema acknowledgement loss uses the committed receipt; verification failures do not save configuration',async()=>{
  const f=fixture(),original=f.effects.schema;let first=true;f.effects.schema=async(...args)=>{await original(...args);throw Error('response lost after commit');};f.effects.verify=async()=>{f.calls.push('verify');if(first){first=false;throw Error('RLS failure');}};
  const request=f.start();await f.host.handle(request);await settle(f.host);
  for(let n=0;n<2;n++){await f.host.handle({operation:'cloud-continue',requestId:request.requestId,expectedRevision:f.host.status().revision});await settle(f.host);if(n===0)expect(f.calls).not.toContain('save');}
  expect(f.host.status().job?.stage).toBe('ready');expect(f.calls.filter(c=>c==='schema')).toHaveLength(1);expect(f.calls.filter(c=>c==='create')).toHaveLength(1);
});
test('changed account revision and unreviewed target fields cannot continue privileged work',async()=>{
  const f=fixture();f.effects.wait=async()=>{f.calls.push('wait');f.account.revision='account-2';};await f.host.handle(f.start());await settle(f.host);expect(f.calls).toEqual(['create','wait']);
  for(const field of ['sql','password','token','ref','path','url'])await expect(f.host.handle({...f.start(),[field]:'untrusted'})).rejects.toThrow('요청');
});
test('corrupt and symlinked records are preserved and cannot become a fresh successful setup',async()=>{
  const f=fixture(),file=join(f.root,'cloud-setup.json');writeFileSync(file,'broken',{mode:0o600});expect(()=>f.host.status()).toThrow();expect(readFileSync(file,'utf8')).toBe('broken');rmSync(file);const original=join(f.root,'original');writeFileSync(original,'preserve');symlinkSync(original,file);expect(()=>f.host.status()).toThrow();expect(readFileSync(original,'utf8')).toBe('preserve');rmSync(file);
});
test('unknown secret-shaped record fields are never returned by public status',async()=>{
  const f=fixture();await f.host.handle(f.start());await settle(f.host);const file=join(f.root,'cloud-setup.json'),d=JSON.parse(readFileSync(file,'utf8'));d.job.token='private';writeFileSync(file,JSON.stringify(d),{mode:0o600});expect(()=>f.host.status()).toThrow('형식');
});
test('SQL application is one guarded transaction with a private exact request/schema receipt',async()=>{
  const f=fixture();await f.host.handle(f.start());await settle(f.host);const job=JSON.parse(readFileSync(join(f.root,'cloud-setup.json'),'utf8')).job;
  const sql=cloudSchemaTransaction(job,'select 1;');expect(sql.startsWith('begin;')).toBe(true);expect(sql.endsWith('commit;')).toBe(true);expect(sql).toContain('pg_advisory_xact_lock');expect(sql).toContain('NONEMPTY_ONBOARDING_TARGET');expect(sql).toContain('revoke all on schema agentstoz_onboarding from public, anon, authenticated');expect(sql).toContain(job.schemaHash);
  expect(()=>cloudSchemaTransaction({...job,id:"unsafe';select"},'')).toThrow();
});
test('the complete canonical newcomer schema executes in Postgres and rejects an occupied target atomically',async()=>{
  const f=fixture();await f.host.handle(f.start());await settle(f.host);const job=JSON.parse(readFileSync(join(f.root,'cloud-setup.json'),'utf8')).job;
  const db=new PGlite({extensions:{pgcrypto,pg_trgm}});
  try{
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema extensions; create schema auth; create table auth.users(id uuid primary key);
      create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key,bucket_id text,name text);alter table storage.objects enable row level security;
      create function storage.foldername(text) returns text[] language sql immutable as $$ select string_to_array($1,'/') $$;
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      create function auth.role() returns text language sql stable as $$ select 'authenticated' $$;
      create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;`);
    try{await db.exec(cloudSchemaTransaction(job,migrationSqlForAllowedEmails([job.account.email])));}catch(e:any){throw Error(String(e.message).slice(0,600));}
    const tables=await db.query<{relname:string;relrowsecurity:boolean}>("select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind='r'");
    for(const name of PORTMGR_TABLES)expect(tables.rows.find(r=>r.relname===name)).toMatchObject({relrowsecurity:true});
    const receipt=await db.query<{request_id:string}>('select request_id from agentstoz_onboarding.installation');expect(receipt.rows[0]?.request_id).toBe(job.id);
    await db.exec(cloudWriteReadProbeSql(job.id));expect((await db.query<{count:number}>('select count(*)::int as count from public.portmgr_ports')).rows[0]?.count).toBe(0);
    await db.exec('set role anon');await expect(db.query('select id from public.portmgr_ports limit 1')).rejects.toThrow();await db.exec('reset role');
    await db.exec('set role authenticated');await expect(db.query('select * from agentstoz_onboarding.installation')).rejects.toThrow();await db.exec('reset role');
    await expect(db.exec(cloudSchemaTransaction({...job,id:crypto.randomUUID()},'drop table public.portmgr_ports cascade;'))).rejects.toThrow('NONEMPTY_ONBOARDING_TARGET');await db.exec('rollback');
    expect((await db.query('select count(*) from public.portmgr_ports')).rows).toHaveLength(1);
  }finally{await db.close();}
},60_000);
