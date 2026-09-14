begin;

alter table public.portmgr_what_i_said_prompts
  add column if not exists prompt_origin text not null default 'unknown';
alter table public.portmgr_what_i_said_prompts
  drop constraint if exists portmgr_what_i_said_prompts_prompt_origin_check;
alter table public.portmgr_what_i_said_prompts
  add constraint portmgr_what_i_said_prompts_prompt_origin_check
  check (prompt_origin in ('human', 'agentstoz', 'unknown'));
set local lock_timeout = '10s';
set local statement_timeout = '2min';

alter table public.portmgr_what_i_said_memory_policy
  add column if not exists capture_configured boolean not null default false;
alter table public.portmgr_what_i_said_memory_policy
  add column if not exists capture_enabled boolean not null default false;
alter table public.portmgr_what_i_said_memory_policy
  add column if not exists capture_enabled_at timestamptz;
alter table public.portmgr_what_i_said_memory_policy
  add column if not exists retention_days text not null default '90';
alter table public.portmgr_what_i_said_memory_policy
  add column if not exists analysis_allowed boolean not null default false;
do $policy_constraint$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.portmgr_what_i_said_memory_policy'::regclass
      and conname = 'portmgr_what_i_said_memory_policy_retention_days_check'
  ) then
    alter table public.portmgr_what_i_said_memory_policy
      add constraint portmgr_what_i_said_memory_policy_retention_days_check
      check (retention_days in ('30', '90', '365', 'forever')) not valid;
  end if;
end;
$policy_constraint$;
alter table public.portmgr_what_i_said_memory_policy
  validate constraint portmgr_what_i_said_memory_policy_retention_days_check;

create or replace function public.portmgr_set_what_i_said_capture_policy(
  p_memory_ids text[],
  p_enabled boolean,
  p_retention_days text,
  p_analysis_allowed boolean
)
returns table(
  memory_id text,
  capture_configured boolean,
  capture_enabled boolean,
  capture_enabled_at timestamptz,
  retention_days text,
  analysis_allowed boolean,
  updated_at timestamptz
)
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'WHAT_I_SAID_SERVICE_ROLE_REQUIRED';
  end if;
  if p_memory_ids is null or cardinality(p_memory_ids) < 1 or cardinality(p_memory_ids) > 2048
     or p_enabled is null or p_analysis_allowed is null
     or p_retention_days not in ('30', '90', '365', 'forever')
     or exists (
       select 1 from unnest(p_memory_ids) as value
       where value is null or btrim(value) = '' or char_length(value) > 512
     ) then
    raise exception using errcode = '22023', message = 'WHAT_I_SAID_CAPTURE_POLICY_INVALID';
  end if;

  return query
  insert into public.portmgr_what_i_said_memory_policy as policy (
    memory_id, capture_configured, capture_enabled, capture_enabled_at,
    retention_days, analysis_allowed, updated_at
  )
  select distinct btrim(value), true, p_enabled,
         case when p_enabled then now() else null end,
         p_retention_days, p_analysis_allowed, now()
  from unnest(p_memory_ids) as value
  on conflict (memory_id) do update
    set capture_configured = true,
        capture_enabled = excluded.capture_enabled,
        capture_enabled_at = case
          when excluded.capture_enabled and policy.capture_enabled
            then policy.capture_enabled_at
          else excluded.capture_enabled_at
        end,
        retention_days = excluded.retention_days,
        analysis_allowed = excluded.analysis_allowed,
        updated_at = excluded.updated_at
  returning policy.memory_id, policy.capture_configured, policy.capture_enabled,
            policy.capture_enabled_at, policy.retention_days,
            policy.analysis_allowed, policy.updated_at;
end;
$$;

-- The external read-only feed carries the same explicit origin attribute as
-- the desktop library. Changing a RETURNS TABLE shape requires dropping the
-- prior overload before recreating it.
drop function if exists public.portmgr_what_i_said_feed(text, bigint, integer);
drop function if exists public.portmgr_what_i_said_feed(text, text, integer);
create or replace function public.portmgr_what_i_said_feed(
  p_token text,
  p_after text default '0',
  p_limit integer default 100
)
returns table(
  feed_seq text,
  id text,
  memory_id text,
  project_name text,
  device_name text,
  agent text,
  prompt_origin text,
  recorded_at timestamptz,
  retention_until timestamptz,
  body text,
  projection_hash text,
  redaction_state text,
  redaction_reasons text[],
  truncated boolean,
  next_cursor text,
  daily_remaining bigint
)
language plpgsql volatile security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_key public.portmgr_what_i_said_feed_keys%rowtype;
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 250);
  v_after bigint;
  v_used bigint;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'WHAT_I_SAID_SERVICE_ROLE_REQUIRED';
  end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '42501', message = 'WHAT_I_SAID_FEED_UNAUTHORIZED';
  end if;
  if p_after is null or p_after !~ '^[0-9]{1,19}$' then
    raise exception using errcode = '22023', message = 'WHAT_I_SAID_CURSOR_INVALID';
  end if;
  begin
    v_after := p_after::bigint;
  exception when numeric_value_out_of_range then
    raise exception using errcode = '22023', message = 'WHAT_I_SAID_CURSOR_INVALID';
  end;
  select * into v_key
  from public.portmgr_what_i_said_feed_keys k
  where k.token_hash = encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex')
    and k.revoked_at is null
  for update;
  if not found or (v_key.expires_at is not null and v_key.expires_at <= now()) then
    raise exception using errcode = '42501', message = 'WHAT_I_SAID_FEED_UNAUTHORIZED';
  end if;

  insert into public.portmgr_what_i_said_feed_key_usage(key_id, usage_date, rows_served)
  values (v_key.id, current_date, 0)
  on conflict (key_id, usage_date) do nothing;
  select u.rows_served into v_used
  from public.portmgr_what_i_said_feed_key_usage u
  where u.key_id = v_key.id and u.usage_date = current_date
  for update;
  if v_used >= v_key.daily_limit then
    raise exception using errcode = '53400', message = 'WHAT_I_SAID_FEED_RATE_LIMITED';
  end if;
  v_limit := least(v_limit, (v_key.daily_limit - v_used)::integer);

  return query
    with selected as materialized (
      select p.feed_seq, p.id, p.memory_id, p.project_name, p.device_name, p.agent, p.prompt_origin,
             p.recorded_at, p.retention_until, p.body, p.projection_hash,
             p.redaction_state, p.redaction_reasons, p.truncated
      from public.portmgr_what_i_said_prompts p
      where p.feed_seq > v_after
        and (p.retention_until is null or p.retention_until > now())
        and (v_key.allowed_memory_ids is null or p.memory_id = any(v_key.allowed_memory_ids))
        and not exists (
          select 1 from public.portmgr_what_i_said_memory_policy mp
          where mp.memory_id = p.memory_id and mp.upload_excluded
        )
      order by p.feed_seq
      limit v_limit
    ), charged as (
      update public.portmgr_what_i_said_feed_key_usage u
      set rows_served = u.rows_served + (select count(*) from selected)
      where u.key_id = v_key.id and u.usage_date = current_date
      returning u.rows_served
    ), touched_key as (
      update public.portmgr_what_i_said_feed_keys k
      set last_used_at = now()
      where k.id = v_key.id
      returning k.id
    )
    select s.feed_seq::text, s.id, s.memory_id, s.project_name, s.device_name, s.agent, s.prompt_origin,
           s.recorded_at, s.retention_until, s.body, s.projection_hash,
           s.redaction_state, s.redaction_reasons, s.truncated,
           (max(s.feed_seq) over ())::text,
           (v_key.daily_limit - charged.rows_served)::bigint
    from selected s
    cross join charged
    cross join touched_key
    order by s.feed_seq;
end;
$$;

drop function if exists public.portmgr_list_what_i_said_prompts(text[], text, text, text, integer);
create or replace function public.portmgr_list_what_i_said_prompts(
  p_memory_ids text[],
  p_query text default '',
  p_agent text default null,
  p_prompt_origin text default null,
  p_before_feed_seq text default null,
  p_limit integer default 50
)
returns table(
  id text,
  memory_id text,
  project_name text,
  device_id text,
  device_name text,
  feed_seq text,
  agent text,
  prompt_origin text,
  recorded_at timestamptz,
  body text,
  redaction_state text
)
language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_query text := coalesce(p_query, '');
  v_before numeric := null;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'WHAT_I_SAID_SERVICE_ROLE_REQUIRED';
  end if;
  if p_memory_ids is null or cardinality(p_memory_ids) < 1 or cardinality(p_memory_ids) > 2048
     or octet_length(v_query) > 1024
     or (p_agent is not null and p_agent not in ('claude', 'codex'))
     or (p_prompt_origin is not null and p_prompt_origin not in ('human', 'agentstoz', 'unknown'))
     or exists (
       select 1 from unnest(p_memory_ids) as value
       where value is null or btrim(value) = '' or char_length(value) > 512
     )
     or (p_before_feed_seq is not null
       and (p_before_feed_seq !~ '^[0-9]+$' or char_length(p_before_feed_seq) > 20)) then
    raise exception using errcode = '22023', message = 'WHAT_I_SAID_LIST_INPUT_INVALID';
  end if;
  if p_before_feed_seq is not null then v_before := p_before_feed_seq::numeric; end if;

  return query
  select p.id, p.memory_id, p.project_name, p.device_id, p.device_name,
         p.feed_seq::text, p.agent, p.prompt_origin, p.recorded_at, p.body, p.redaction_state
  from public.portmgr_what_i_said_prompts p
  where p.memory_id = any(p_memory_ids)
    and p.body is not null
    and p.redaction_state <> 'withheld'
    and (p_agent is null or p.agent = p_agent)
    and (p_prompt_origin is null or p.prompt_origin = p_prompt_origin)
    and (v_before is null or p.feed_seq < v_before)
    and (v_query = '' or position(
      lower(normalize(v_query, NFKC)) in lower(normalize(p.body, NFKC))
    ) > 0)
    and not exists (
      select 1 from public.portmgr_what_i_said_memory_policy mp
      where mp.memory_id = p.memory_id and mp.upload_excluded
    )
  order by p.feed_seq desc
  limit v_limit + 1;
end;
$$;

revoke all on function public.portmgr_set_what_i_said_capture_policy(text[], boolean, text, boolean)
  from public, anon, authenticated;
grant execute on function public.portmgr_set_what_i_said_capture_policy(text[], boolean, text, boolean)
  to service_role;
revoke all on function public.portmgr_what_i_said_feed(text, text, integer)
  from public, anon, authenticated;
grant execute on function public.portmgr_what_i_said_feed(text, text, integer) to service_role;
revoke all on function public.portmgr_list_what_i_said_prompts(text[], text, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.portmgr_list_what_i_said_prompts(text[], text, text, text, text, integer)
  to service_role;

commit;
