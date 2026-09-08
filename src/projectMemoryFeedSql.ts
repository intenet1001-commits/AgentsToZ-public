/** Read-only external access is scoped to explicitly selected memory identities. */
export const PROJECT_MEMORY_FEED_SQL = String.raw`
create table if not exists public.portmgr_project_memory_feed_keys (
  id uuid primary key default gen_random_uuid(),
  label text not null check (char_length(label) between 1 and 120),
  token text not null unique check (token ~ '^[0-9a-f]{64}$'),
  allowed_memory_ids text[] not null check (cardinality(allowed_memory_ids) between 1 and 100),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '90 days',
  last_used_at timestamptz,
  usage_date date not null default current_date,
  usage_count integer not null default 0
);
alter table public.portmgr_project_memory_feed_keys enable row level security;
revoke all on public.portmgr_project_memory_feed_keys from public, anon, authenticated;
grant select, insert, update, delete on public.portmgr_project_memory_feed_keys to service_role;

create or replace function public.portmgr_project_memory_feed_keys_manage(
  p_action text, p_key_id uuid default null, p_label text default null,
  p_token text default null, p_memory_ids text[] default null
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_result jsonb;
begin
  if auth.role() is distinct from 'service_role' and not coalesce(public.portmgr_is_member(), false) then
    raise exception using errcode = '42501', message = 'MEMORY_FEED_FORBIDDEN';
  end if;
  if p_action in ('issue', 'rotate') and (p_token is null or p_token !~ '^[0-9a-f]{64}$') then
    raise exception 'MEMORY_FEED_INVALID_TOKEN';
  end if;
  if p_action = 'issue' then
    if p_label is null or char_length(btrim(p_label)) not between 1 and 120
       or p_memory_ids is null or cardinality(p_memory_ids) not between 1 and 100
       or exists(select 1 from unnest(p_memory_ids) m(id) where m.id is null or not exists (
         select 1 from public.portmgr_project_memory_heads h where h.memory_id = m.id and h.head_revision_id is not null
       ) or exists(select 1 from public.portmgr_project_memory_trash t where t.memory_id = m.id)
         or exists(select 1 from public.portmgr_project_memory_aliases a where a.alias_memory_id = m.id)) then
      raise exception 'MEMORY_FEED_SELECT_BACKED_UP_MEMORIES';
    end if;
    insert into public.portmgr_project_memory_feed_keys(label,token,allowed_memory_ids)
      values(btrim(p_label),p_token,p_memory_ids);
  elsif p_action = 'rotate' then
    update public.portmgr_project_memory_feed_keys set token=p_token, expires_at=now()+interval '90 days'
      where id=p_key_id;
    if not found then raise exception 'MEMORY_FEED_KEY_NOT_FOUND'; end if;
  elsif p_action = 'revoke' then
    delete from public.portmgr_project_memory_feed_keys where id=p_key_id;
    if not found then raise exception 'MEMORY_FEED_KEY_NOT_FOUND'; end if;
  elsif p_action <> 'list' or p_action is null then
    raise exception 'MEMORY_FEED_INVALID_ACTION';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',k.id,'label',k.label,'token',k.token,'memoryIds',k.allowed_memory_ids,
    'expiresAt',k.expires_at,'lastUsedAt',k.last_used_at) order by k.created_at),'[]'::jsonb)
    into v_result from public.portmgr_project_memory_feed_keys k;
  return v_result;
end $$;
revoke all on function public.portmgr_project_memory_feed_keys_manage(text,uuid,text,text,text[]) from public,anon;
grant execute on function public.portmgr_project_memory_feed_keys_manage(text,uuid,text,text,text[]) to authenticated,service_role;

create or replace function public.portmgr_project_memory_feed(
  p_token text, p_after text default '', p_limit integer default 10
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_key public.portmgr_project_memory_feed_keys%rowtype; v_items jsonb; v_more boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode='42501', message='MEMORY_FEED_UNAUTHORIZED';
  end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'MEMORY_FEED_UNAUTHORIZED'; end if;
  select * into v_key from public.portmgr_project_memory_feed_keys k where k.token=p_token for update;
  if not found or v_key.expires_at <= now() then raise exception 'MEMORY_FEED_UNAUTHORIZED'; end if;
  if p_after is null or char_length(p_after)>512 or p_limit is null or p_limit not between 1 and 25 then
    raise exception 'MEMORY_FEED_INVALID_REQUEST';
  end if;
  if v_key.usage_date=current_date and v_key.usage_count>=10000 then raise exception 'MEMORY_FEED_RATE_LIMITED'; end if;
  update public.portmgr_project_memory_feed_keys set usage_date=current_date,
    usage_count=case when usage_date=current_date then usage_count+1 else 1 end,last_used_at=now() where id=v_key.id;
  with candidates as (
    select h.memory_id,r.id,r.project_name,r.content,r.content_hash,r.created_at
    from public.portmgr_project_memory_heads h
    join public.portmgr_project_memory_revisions r on r.id=h.head_revision_id and r.memory_id=h.memory_id
    where h.memory_id=any(v_key.allowed_memory_ids) and h.memory_id collate "C">p_after collate "C"
      and not exists(select 1 from public.portmgr_project_memory_trash t where t.memory_id=h.memory_id)
      and not exists(select 1 from public.portmgr_project_memory_aliases a where a.alias_memory_id=h.memory_id)
    order by h.memory_id collate "C" limit p_limit+1
  ), page as (select * from candidates order by memory_id collate "C" limit p_limit)
  select coalesce((select jsonb_agg(jsonb_build_object(
    'memoryId',p.memory_id,'revisionId',p.id,'projectName',p.project_name,
    'content',left(p.content,262144),'truncated',char_length(p.content)>262144,
    'contentHash',p.content_hash,'updatedAt',p.created_at) order by p.memory_id collate "C") from page p),'[]'::jsonb),
    (select count(*)>p_limit from candidates) into v_items,v_more;
  return jsonb_build_object('schemaVersion',1,'items',v_items,'hasMore',v_more,
    'nextCursor',case when v_more then v_items->-1->>'memoryId' else null end);
end $$;
revoke all on function public.portmgr_project_memory_feed(text,text,integer) from public,anon,authenticated;
grant execute on function public.portmgr_project_memory_feed(text,text,integer) to service_role;
`;
