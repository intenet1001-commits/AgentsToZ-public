create table if not exists public.portmgr_project_memory_mentions (
  alias text not null check (alias ~ '^[a-zA-Z0-9가-힣]+(?:-[a-zA-Z0-9가-힣]+)*$'),
  memory_id text not null,
  status text not null check (status in ('primary','redirect')),
  updated_at timestamptz not null default now(),
  primary key (alias)
);
create unique index if not exists one_primary_per_memory
  on public.portmgr_project_memory_mentions(memory_id) where status = 'primary';

create or replace function public.portmgr_save_project_memory_mention(p_memory_id text, p_alias text)
returns setof public.portmgr_project_memory_mentions
language plpgsql security definer set search_path = public as $$
begin
  if p_memory_id is null or btrim(p_memory_id) = '' or p_alias !~ '^[a-zA-Z0-9가-힣]+(?:-[a-zA-Z0-9가-힣]+)*$' then
    raise exception 'MENTION_ALIAS_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('project-memory-mentions', 0));
  if exists(select 1 from public.portmgr_project_memory_mentions where alias = p_alias and memory_id <> p_memory_id) then
    raise exception 'MENTION_ALIAS_RESERVED';
  end if;
  update public.portmgr_project_memory_mentions set status = 'redirect', updated_at = now()
    where memory_id = p_memory_id and status = 'primary' and alias <> p_alias;
  insert into public.portmgr_project_memory_mentions(alias, memory_id, status)
    values (p_alias, p_memory_id, 'primary')
    on conflict (alias) do update set status = 'primary', updated_at = now()
      where portmgr_project_memory_mentions.memory_id = excluded.memory_id;
  return query select * from public.portmgr_project_memory_mentions where memory_id = p_memory_id order by status, alias;
end;
$$;

alter table public.portmgr_project_memory_mentions enable row level security;
drop policy if exists portmgr_project_memory_mentions_read on public.portmgr_project_memory_mentions;
create policy portmgr_project_memory_mentions_read on public.portmgr_project_memory_mentions
  for select to authenticated using ((select public.portmgr_is_member()));
revoke all on table public.portmgr_project_memory_mentions from public, anon;
grant select on table public.portmgr_project_memory_mentions to authenticated;
revoke all on function public.portmgr_save_project_memory_mention(text,text) from public, anon, authenticated;
grant execute on function public.portmgr_save_project_memory_mention(text,text) to service_role;
