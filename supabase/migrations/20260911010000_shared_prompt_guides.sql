-- Private deployment library, shared only with its allowed members. No anonymous access.
-- Local encrypted guides remain untouched; importing them is an explicit operation.
create table if not exists public.portmgr_prompt_guides (
  id smallint primary key default 1 check (id = 1),
  revision text not null,
  entries jsonb not null check (jsonb_typeof(entries) = 'array' and jsonb_array_length(entries) <= 100),
  updated_at timestamptz not null default now()
);
alter table public.portmgr_prompt_guides enable row level security;
revoke all on public.portmgr_prompt_guides from public, anon, authenticated;
grant select on public.portmgr_prompt_guides to authenticated;
grant all on public.portmgr_prompt_guides to service_role;
drop policy if exists prompt_guides_member_read on public.portmgr_prompt_guides;
create policy prompt_guides_member_read on public.portmgr_prompt_guides for select to authenticated
  using ((select public.portmgr_is_member()));

create or replace function public.portmgr_prompt_guides_read() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare v public.portmgr_prompt_guides;
begin
  if auth.role() is distinct from 'service_role' and not coalesce(public.portmgr_is_member(), false) then
    raise exception using errcode='42501', message='PROMPT_GUIDES_MEMBER_REQUIRED';
  end if;
  select * into v from public.portmgr_prompt_guides where id=1;
  return jsonb_build_object('success',true,'revision',coalesce(v.revision,'0'),'entries',coalesce(v.entries,'[]'::jsonb));
end $$;

create or replace function public.portmgr_prompt_guides_save(p_expected_revision text, p_entries jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare v public.portmgr_prompt_guides; item jsonb; seen text[] := '{}';
begin
  if auth.role() is distinct from 'service_role' and not coalesce(public.portmgr_is_member(), false) then
    raise exception using errcode='42501', message='PROMPT_GUIDES_MEMBER_REQUIRED';
  end if;
  if p_expected_revision is null or p_expected_revision !~ '^(0|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
     or p_entries is null or jsonb_typeof(p_entries) <> 'array' then
    raise exception 'PROMPT_GUIDES_INVALID_INPUT';
  end if;
  if jsonb_array_length(p_entries)>100 or octet_length(p_entries::text)>1048576 then raise exception 'PROMPT_GUIDES_LIMIT_EXCEEDED'; end if;
  for item in select value from jsonb_array_elements(p_entries) loop
    if jsonb_typeof(item) <> 'object' then raise exception 'PROMPT_GUIDES_INVALID_INPUT'; end if;
    if (select count(*) from jsonb_object_keys(item)) <> 5 or not item ?& array['id','title','body','pinned','updatedAt']
      or jsonb_typeof(item->'id') <> 'string' or (item->>'id') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      or item->>'id'=any(seen)
      or jsonb_typeof(item->'title') <> 'string' or (item->>'title') !~ '[^[:space:]]' or length(regexp_replace(item->>'title',U&'[\+010000-\+10FFFF]','xx','g'))>120
      or (item->>'title') ~ '[[:cntrl:]]'
      or jsonb_typeof(item->'body') <> 'string' or (item->>'body') !~ '[^[:space:]]' or length(regexp_replace(item->>'body',U&'[\+010000-\+10FFFF]','xx','g'))>16384
      or octet_length(item->>'body')>65536
      or regexp_replace(item->>'body',E'[\n\r\t]','','g') ~ '[[:cntrl:]]'
      or jsonb_typeof(item->'pinned') <> 'boolean'
      or jsonb_typeof(item->'updatedAt') <> 'string'
      or (item->>'updatedAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' then
      raise exception 'PROMPT_GUIDES_INVALID_INPUT';
    end if;
    perform (item->>'updatedAt')::timestamptz;
    seen := array_append(seen,item->>'id');
  end loop;
  perform pg_advisory_xact_lock(hashtextextended('portmgr_prompt_guides',0));
  select * into v from public.portmgr_prompt_guides where id=1 for update;
  if coalesce(v.revision,'0') <> p_expected_revision then raise exception 'PROMPT_GUIDES_CONFLICT'; end if;
  if coalesce(v.entries,'[]'::jsonb) <> p_entries then
    insert into public.portmgr_prompt_guides(id,revision,entries) values(1,gen_random_uuid()::text,p_entries)
      on conflict(id) do update set revision=excluded.revision,entries=excluded.entries,updated_at=now();
  end if;
  return public.portmgr_prompt_guides_read();
end $$;
revoke all on function public.portmgr_prompt_guides_read() from public, anon;
revoke all on function public.portmgr_prompt_guides_save(text,jsonb) from public, anon;
grant execute on function public.portmgr_prompt_guides_read() to authenticated, service_role;
grant execute on function public.portmgr_prompt_guides_save(text,jsonb) to authenticated, service_role;
