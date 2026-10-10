-- Make What-I-said deletion and feed cursors truthful.
--
-- 1. identity/sequence allocation is not commit ordered. A long transaction
--    could reserve 100, let 101 commit and be consumed, then commit 100 after
--    the consumer had advanced. Serialize the final feed_seq assignment under
--    a transaction-scoped advisory lock so visibility and sequence order agree.
-- 2. Excluding a memory must reject concurrent uploads and delete every
--    existing device row atomically with the policy change.
-- 3. Keep cursor values as decimal text across PostgREST and cap a page to the
--    key's actual remaining daily allowance.

-- Keep the table lock below until the replacement trigger and RPCs are fully
-- installed. This makes the transition atomic even in runners that otherwise
-- execute migration statements with autocommit enabled.
begin;
set local lock_timeout = '10s';
set local statement_timeout = '2min';

-- Keep the generated identity for backward/fresh-schema compatibility. Its
-- unlocked default is overwritten by the trigger's O(1), lock-serialized
-- nextval; the resulting extra gaps are harmless and rollbacks may add more.
do $$
declare
  v_sequence regclass;
  v_next bigint;
begin
  v_sequence := pg_get_serial_sequence('public.portmgr_what_i_said_prompts', 'feed_seq')::regclass;
  if v_sequence is null then
    raise exception 'WHAT_I_SAID_FEED_SEQUENCE_UNAVAILABLE';
  end if;
  lock table public.portmgr_what_i_said_prompts in share row exclusive mode;
  select greatest(coalesce(max(feed_seq), 0) + 1, 1) into v_next
  from public.portmgr_what_i_said_prompts;
  perform setval(v_sequence, v_next, false);
end
$$;

create or replace function public.portmgr_assign_what_i_said_feed_seq()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_sequence regclass;
begin
  perform pg_advisory_xact_lock(hashtextextended('what-i-said-feed-sequence-v1', 0));
  v_sequence := pg_get_serial_sequence('public.portmgr_what_i_said_prompts', 'feed_seq')::regclass;
  if v_sequence is null then
    raise exception using errcode = '55000', message = 'WHAT_I_SAID_FEED_SEQUENCE_UNAVAILABLE';
  end if;
  new.feed_seq := nextval(v_sequence);
  return new;
end;
$$;
drop trigger if exists portmgr_what_i_said_prompts_feed_sequence
  on public.portmgr_what_i_said_prompts;
drop trigger if exists portmgr_what_i_said_prompts_00_feed_sequence
  on public.portmgr_what_i_said_prompts;
-- Same-kind triggers execute alphabetically. Take the global feed lock before
-- the per-memory exclusion lock for every INSERT, so multi-row transactions
-- cannot invert the two lock classes and deadlock.
create trigger portmgr_what_i_said_prompts_00_feed_sequence
  before insert on public.portmgr_what_i_said_prompts
  for each row execute function public.portmgr_assign_what_i_said_feed_seq();
revoke all on function public.portmgr_assign_what_i_said_feed_seq()
  from public, anon;
grant execute on function public.portmgr_assign_what_i_said_feed_seq()
  to authenticated, service_role;

create or replace function public.portmgr_what_i_said_reject_excluded_upload()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('what-i-said-memory:' || new.memory_id, 0));
  if exists (
    select 1 from public.portmgr_what_i_said_memory_policy p
    where p.memory_id = new.memory_id and p.upload_excluded
  ) then
    raise exception using errcode = '42501', message = 'WHAT_I_SAID_MEMORY_EXCLUDED';
  end if;
  return new;
end;
$$;

create or replace function public.portmgr_delete_what_i_said_prompts(
  p_memory_id text,
  p_device_id text default null,
  p_ids text[] default null,
  p_all_devices boolean default false
)
returns bigint
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_deleted bigint := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'WHAT_I_SAID_SERVICE_ROLE_REQUIRED';
  end if;
  if p_memory_id is null or btrim(p_memory_id) = '' or char_length(p_memory_id) > 512
     or p_all_devices is null
     or (not p_all_devices and (p_device_id is null or btrim(p_device_id) = ''))
     or (p_ids is not null and (
       cardinality(p_ids) = 0 or cardinality(p_ids) > 1000 or exists (
         select 1 from unnest(p_ids) as candidate(id)
         where candidate.id is null or candidate.id <> btrim(candidate.id)
           or candidate.id = '' or char_length(candidate.id) > 512
       )
     )) then
    raise exception using errcode = '22023', message = 'WHAT_I_SAID_REMOTE_DELETE_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('what-i-said-memory:' || btrim(p_memory_id), 0));
  delete from public.portmgr_what_i_said_prompts p
  where p.memory_id = btrim(p_memory_id)
    and (p_all_devices or p.device_id = btrim(p_device_id))
    and (p_ids is null or p.id = any(p_ids));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
drop trigger if exists portmgr_what_i_said_prompts_exclusion_guard
  on public.portmgr_what_i_said_prompts;
drop trigger if exists portmgr_what_i_said_prompts_10_exclusion_guard
  on public.portmgr_what_i_said_prompts;
create trigger portmgr_what_i_said_prompts_10_exclusion_guard
  before insert or update on public.portmgr_what_i_said_prompts
  for each row execute function public.portmgr_what_i_said_reject_excluded_upload();

create or replace function public.portmgr_set_what_i_said_memory_exclusion(
  p_memory_id text,
  p_excluded boolean
)
returns bigint
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_deleted bigint := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'WHAT_I_SAID_SERVICE_ROLE_REQUIRED';
  end if;
  if p_memory_id is null or btrim(p_memory_id) = '' or char_length(p_memory_id) > 512
     or p_excluded is null then
    raise exception using errcode = '22023', message = 'WHAT_I_SAID_MEMORY_POLICY_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('what-i-said-memory:' || btrim(p_memory_id), 0));
  insert into public.portmgr_what_i_said_memory_policy(
    memory_id, upload_excluded, excluded_at, updated_at
  ) values (
    btrim(p_memory_id), p_excluded, case when p_excluded then now() else null end, now()
  )
  on conflict (memory_id) do update
    set upload_excluded = excluded.upload_excluded,
        excluded_at = excluded.excluded_at,
        updated_at = excluded.updated_at;
  if p_excluded then
    delete from public.portmgr_what_i_said_prompts p
    where p.memory_id = btrim(p_memory_id);
    get diagnostics v_deleted = row_count;
  end if;
  return v_deleted;
end;
$$;

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

  -- One materialized page owns the returned rows, charged count, and cursor.
  -- Splitting count/max from RETURN QUERY would use different READ COMMITTED
  -- snapshots and let a concurrent commit make those values disagree.
  return query
    with selected as materialized (
      select p.feed_seq, p.id, p.memory_id, p.project_name, p.device_name, p.agent,
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
    select s.feed_seq::text, s.id, s.memory_id, s.project_name, s.device_name, s.agent,
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

revoke all on function public.portmgr_what_i_said_feed(text, text, integer)
  from public, anon, authenticated;
grant execute on function public.portmgr_what_i_said_feed(text, text, integer) to service_role;
revoke all on function public.portmgr_set_what_i_said_memory_exclusion(text, boolean)
  from public, anon, authenticated;
grant execute on function public.portmgr_set_what_i_said_memory_exclusion(text, boolean) to service_role;
revoke all on function public.portmgr_delete_what_i_said_prompts(text, text, text[], boolean)
  from public, anon, authenticated;
grant execute on function public.portmgr_delete_what_i_said_prompts(text, text, text[], boolean)
  to service_role;

commit;
