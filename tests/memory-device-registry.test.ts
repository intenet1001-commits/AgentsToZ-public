import {test,expect} from 'bun:test';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {MEMORY_DEVICE_REGISTRY_SQL} from '../src/memoryDeviceRegistrySql';
import {buildMemoryDeviceFilters,buildMemoryDirectory} from '../src/projectMemoryDirectory';

test('current memory-only host registration preserves names, timestamps, old aliases and revoked hosts',async()=>{
  expect(MEMORY_DEVICE_REGISTRY_SQL).toBe(readFileSync(new URL('../supabase/migrations/20260911011000_memory_device_registry.sql',import.meta.url),'utf8'));
  const db=new PGlite(); const old='11111111-1111-4111-8111-111111111111', current='22222222-2222-4222-8222-222222222222',remote='33333333-3333-4333-8333-333333333333';
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; grant usage on schema auth,public to anon,authenticated,service_role;
      create function auth.role() returns text language sql stable as $$select current_setting('request.role',true)$$;
      create table portmgr_devices(id text primary key,name text,last_push_at timestamptz default now());
      create table portmgr_device_identity_aliases(alias_device_id text,canonical_device_id text);
      create table portmgr_remote_devices(device_id text,revoked_at timestamptz);
      insert into portmgr_devices values('${old}','내 Mac','2026-09-01');
      insert into portmgr_device_identity_aliases values('${old}','${current}');
      insert into portmgr_remote_devices values('${remote}',now());`);
    await db.exec(MEMORY_DEVICE_REGISTRY_SQL);
    const register=async(id:string,name:string|null)=>(await db.query<{v:boolean}>('select portmgr_register_memory_device($1,$2) v',[id,name])).rows[0]!.v;
    await db.exec("set role authenticated;set request.role='authenticated';");
    await expect(register(current,'침입')).rejects.toThrow();
    await db.exec("reset role;set role service_role;set request.role='service_role';");
    expect(await register(old,'old report')).toBe(false);
    expect(await register(remote,'revoked report')).toBe(false);
    expect(await register(current,null)).toBe(true);
    expect(await register(current,'new hostname')).toBe(true);
    await db.exec('reset role');
    expect((await db.query('select * from portmgr_devices where id=$1',[current])).rows).toEqual([{id:current,name:'내 Mac',last_push_at:null}]);
    expect((await db.query('select * from portmgr_devices')).rows).toHaveLength(2);
  }finally {await db.close();}
},20000);

test('explicit aliases deduplicate every memory/filter, independent of row order; equal names stay separate',()=>{
  const aliases=[{alias_device_id:'old',canonical_device_id:'current',linked_at:null}];
  const devices=[{id:'old',name:'옛 이름',last_push_at:'2026-09-11'}, {id:'current',name:'내 Mac',last_push_at:null},{id:'separate',name:'내 Mac',last_push_at:null}];
  const rows=['old','current','separate'].map(id=>({id,memory_id:'memory',project_name:'project',github_url:null,device_id:id,device_name:'hostname',content_hash:'hash',created_at:'2026-09-01'}));
  for(const order of [devices,[...devices].reverse()]) {
    const entries=buildMemoryDirectory(rows,[],[],[],[],[],[],aliases,order);
    expect(entries[0]!.devices).toHaveLength(2);
    expect(entries[0]!.devices.find(d=>d.deviceId==='current')!.deviceName).toBe('내 Mac');
    const filters=buildMemoryDeviceFilters(entries,aliases,order);
    expect(filters).toHaveLength(2);
    expect(filters.find(d=>d.deviceId==='current')).toMatchObject({deviceName:'내 Mac',memoryCount:1,legacyDeviceIds:['old']});
  }
});
