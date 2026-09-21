-- Public VOC ingestion is server-mediated through the submit-voc Edge Function.
-- The public app never receives database credentials that can write these tables.

begin;

create table if not exists public.portmgr_voc_settings (
  id text primary key default 'default' check (id = 'default'),
  accepting boolean not null default true,
  daily_device_limit integer not null default 10
    check (daily_device_limit between 1 and 100),
  updated_at timestamptz not null default now()
);

insert into public.portmgr_voc_settings(id, accepting, daily_device_limit)
values ('default', true, 10)
on conflict (id) do nothing;

create table if not exists public.portmgr_voc_daily_usage (
  usage_date date not null,
  device_hash text not null check (device_hash ~ '^[0-9a-f]{64}$'),
  submission_count integer not null default 0 check (submission_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (usage_date, device_hash)
);

create table if not exists public.portmgr_voc_blocklist (
  device_hash text primary key check (device_hash ~ '^[0-9a-f]{64}$'),
  scope text not null check (scope in ('voc', 'app')),
  operator_note text not null default '' check (char_length(operator_note) <= 500),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.portmgr_voc_inbox (
  id uuid primary key,
  received_at timestamptz not null default now(),
  app_version text not null default '' check (char_length(app_version) <= 100),
  tab text not null default '' check (char_length(tab) <= 50),
  anchor jsonb not null default '{}'::jsonb,
  comment text not null check (char_length(comment) between 1 and 4000),
  device_hash text not null check (device_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'open' check (status in ('open', 'reviewing', 'done', 'spam')),
  handled_at timestamptz
);

create index if not exists idx_portmgr_voc_inbox_status_received
  on public.portmgr_voc_inbox(status, received_at desc);

create or replace function public.portmgr_check_voc_device(p_device_hash text)
returns table(blocked boolean, block_scope text, expires_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select true, b.scope, b.expires_at
  from public.portmgr_voc_blocklist b
  where b.device_hash = p_device_hash
    and (b.expires_at is null or b.expires_at > now())
  limit 1;
$$;

create or replace function public.portmgr_submit_voc(
  p_id uuid,
  p_device_hash text,
  p_app_version text,
  p_tab text,
  p_anchor jsonb,
  p_comment text
)
returns table(accepted boolean, remaining integer, daily_limit integer, reason text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_accepting boolean;
  v_daily_limit integer;
  v_count integer;
  v_block_scope text;
begin
  select s.accepting, s.daily_device_limit
    into v_accepting, v_daily_limit
  from public.portmgr_voc_settings s
  where s.id = 'default';

  if not coalesce(v_accepting, false) then
    return query select false, 0, coalesce(v_daily_limit, 10), 'disabled'::text;
    return;
  end if;

  if p_device_hash is null or p_device_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid device hash';
  end if;
  select b.scope into v_block_scope
  from public.portmgr_voc_blocklist b
  where b.device_hash = p_device_hash
    and (b.expires_at is null or b.expires_at > now());
  if v_block_scope is not null then
    return query select false, 0, v_daily_limit, (v_block_scope || '_blocked')::text;
    return;
  end if;
  if p_comment is null or char_length(btrim(p_comment)) not between 1 and 4000 then
    raise exception using errcode = '22023', message = 'comment must be 1..4000 characters';
  end if;

  insert into public.portmgr_voc_daily_usage(
    usage_date, device_hash, submission_count, updated_at
  ) values (
    current_date, p_device_hash, 1, now()
  )
  on conflict (usage_date, device_hash) do update
    set submission_count = public.portmgr_voc_daily_usage.submission_count + 1,
        updated_at = now()
    where public.portmgr_voc_daily_usage.submission_count < v_daily_limit
  returning submission_count into v_count;

  if v_count is null then
    return query select false, 0, v_daily_limit, 'rate_limited'::text;
    return;
  end if;

  insert into public.portmgr_voc_inbox(
    id, app_version, tab, anchor, comment, device_hash
  ) values (
    p_id,
    left(coalesce(p_app_version, ''), 100),
    left(coalesce(p_tab, ''), 50),
    coalesce(p_anchor, '{}'::jsonb),
    btrim(p_comment),
    p_device_hash
  );

  return query select true, greatest(v_daily_limit - v_count, 0), v_daily_limit, null::text;
end;
$$;

alter table public.portmgr_voc_settings enable row level security;
alter table public.portmgr_voc_daily_usage enable row level security;
alter table public.portmgr_voc_blocklist enable row level security;
alter table public.portmgr_voc_inbox enable row level security;

revoke all privileges on table public.portmgr_voc_settings from public, anon, authenticated;
revoke all privileges on table public.portmgr_voc_daily_usage from public, anon, authenticated;
revoke all privileges on table public.portmgr_voc_blocklist from public, anon, authenticated;
revoke all privileges on table public.portmgr_voc_inbox from public, anon, authenticated;
grant select, insert, update on table public.portmgr_voc_settings to service_role;
grant select, insert, update, delete on table public.portmgr_voc_daily_usage to service_role;
grant select, insert, update, delete on table public.portmgr_voc_blocklist to service_role;
grant select, insert, update, delete on table public.portmgr_voc_inbox to service_role;

revoke all on function public.portmgr_check_voc_device(text) from public, anon, authenticated;
grant execute on function public.portmgr_check_voc_device(text) to service_role;

revoke all on function public.portmgr_submit_voc(uuid, text, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.portmgr_submit_voc(uuid, text, text, text, jsonb, text)
  to service_role;

commit;
