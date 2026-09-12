import {test,expect} from 'bun:test';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {SHARED_PROMPT_GUIDE_SQL} from '../src/sharedPromptGuideSql';
import {mergePromptGuideImport} from '../src/sharedPromptGuideClient';

const entry={id:'guide-1',title:'검토',body:'변경점을 검토해줘',pinned:true,updatedAt:'2026-09-11T00:00:00.000Z'};
test('shared prompt migration parity and real PostgreSQL member/CAS boundaries',async()=>{
  expect(SHARED_PROMPT_GUIDE_SQL).toBe(readFileSync(new URL('../supabase/migrations/20260911010000_shared_prompt_guides.sql',import.meta.url),'utf8'));
  const db=new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; grant usage on schema auth,public to anon,authenticated,service_role;
      create function auth.role() returns text language sql stable as $$select current_setting('request.role',true)$$;
      create function public.portmgr_is_member() returns boolean language sql stable as $$select current_setting('request.member',true)='yes'$$;`);
    await db.exec(SHARED_PROMPT_GUIDE_SQL);
    await db.exec("set role anon; set request.role='anon';");
    await expect(db.query('select public.portmgr_prompt_guides_read()')).rejects.toThrow();
    await db.exec("reset role; set role authenticated; set request.role='authenticated'; set request.member='no';");
    await expect(db.query('select public.portmgr_prompt_guides_read()')).rejects.toThrow('MEMBER_REQUIRED');
    await db.exec("set request.member='yes';");
    const read=async()=> (await db.query<{v:any}>('select public.portmgr_prompt_guides_read() as v')).rows[0]!.v;
    const save=async(revision:string,entries:unknown)=> (await db.query<{v:any}>('select public.portmgr_prompt_guides_save($1,$2::jsonb) as v',[revision,JSON.stringify(entries)])).rows[0]!.v;
    expect(await read()).toEqual({success:true,revision:'0',entries:[]});
    const saved=await save('0',[entry]);
    expect(saved.entries).toEqual([entry]);expect(saved.revision).not.toBe('0');
    await expect(save('0',[])).rejects.toThrow('CONFLICT');
    expect(await save(saved.revision,[entry])).toEqual(saved);
    await expect(save(saved.revision,[entry,entry])).rejects.toThrow('INVALID_INPUT');
    await expect(save(saved.revision,[{...entry,extra:'unknown'}])).rejects.toThrow('INVALID_INPUT');
    await expect(save(saved.revision,[{...entry,body:'x'.repeat(16385)}])).rejects.toThrow('INVALID_INPUT');
    await expect(db.query('delete from public.portmgr_prompt_guides')).rejects.toThrow();
    const deleted=await save(saved.revision,[]);expect(deleted.entries).toEqual([]);
    await expect(save(saved.revision,[entry])).rejects.toThrow('CONFLICT');
    await db.exec("set request.member='no';");
    expect((await db.query('select * from public.portmgr_prompt_guides')).rows).toEqual([]);
    await expect(save(deleted.revision,[entry])).rejects.toThrow('MEMBER_REQUIRED');
  } finally {await db.close();}
},20000);

test('explicit local import preserves cloud edits and is content-idempotent',()=>{
  const changed={...entry,body:'cloud changed'};
  const merged=mergePromptGuideImport([changed],[entry]);
  expect(merged[0]).toEqual(changed);expect(merged[1]!.id).not.toBe(entry.id);
  expect(mergePromptGuideImport(merged,[entry])).toEqual(merged);
  expect(mergePromptGuideImport([changed],[])).toEqual([changed]);
});
