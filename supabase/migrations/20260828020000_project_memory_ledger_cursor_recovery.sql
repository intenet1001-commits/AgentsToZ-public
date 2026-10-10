-- Recovery contract for databases that applied the first ledger-scale migration
-- before exact cursor anchors were introduced. Fresh installs also receive the
-- same function from 20260828010000; CREATE OR REPLACE keeps this replay-safe.

create extension if not exists pgcrypto with schema extensions;

alter table public.portmgr_project_memory_feedback
  add column if not exists origin_event_id text;

create or replace function public.portmgr_project_memory_feedback_lineage_id(
  p_target_memory_id text,
  p_origin_event_id text
)
returns text
language sql
immutable
strict
security invoker
set search_path = public
as $$
  select substr(encode(extensions.digest(convert_to(
    p_target_memory_id || chr(10) || p_origin_event_id, 'UTF8'
  ), 'sha256'), 'hex'), 1, 32);
$$;

-- Draft installations may already contain copies made with target+immediate
-- source IDs. Recover their true origin in chronological merge order before
-- replacing the writers. This adds provenance only; evidence and row IDs stay
-- immutable.
do $$
declare
  merged record;
begin
  for merged in
    select source_memory_ids, target_memory_id
    from public.portmgr_project_memory_merges
    order by created_at asc, id asc
  loop
    update public.portmgr_project_memory_feedback target
    set origin_event_id = coalesce(source.origin_event_id, source.id)
    from public.portmgr_project_memory_feedback source
    where source.memory_id = any(merged.source_memory_ids)
      and source.memory_id <> merged.target_memory_id
      and target.memory_id = merged.target_memory_id
      and target.id = public.portmgr_project_memory_feedback_lineage_id(
        merged.target_memory_id, source.id
      )
      and target.origin_event_id is null;
  end loop;
end;
$$;

update public.portmgr_project_memory_feedback
set origin_event_id = id
where origin_event_id is null;

create or replace function public.portmgr_record_project_memory_ledger_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_layer text := tg_argv[0];
  v_canonical_memory_id text;
begin
  if v_layer not in ('journal', 'feedback') then
    raise exception using
      errcode = '22023',
      message = 'PROJECT_MEMORY_LEDGER_LAYER_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'portmgr-project-memory-ledger:' || new.memory_id,
    0
  ));

  insert into public.portmgr_project_memory_ledger_changes(layer, memory_id, row_id)
  values (v_layer, new.memory_id, new.id)
  on conflict (layer, row_id) do nothing;

  v_canonical_memory_id := public.portmgr_resolve_project_memory_id(new.memory_id);
  if v_canonical_memory_id <> new.memory_id then
    if v_layer = 'journal' then
      insert into public.portmgr_project_memory_journal(
        id, memory_id, entry_hash, device_id, device_name, project_name, agent,
        recorded_at, head_commit, summary, body
      ) values (
        v_canonical_memory_id || ':' || new.entry_hash,
        v_canonical_memory_id, new.entry_hash, new.device_id, new.device_name,
        new.project_name, new.agent, new.recorded_at, new.head_commit,
        new.summary, new.body
      ) on conflict (memory_id, entry_hash) do nothing;
    elsif v_layer = 'feedback' then
      insert into public.portmgr_project_memory_feedback(
        id, origin_event_id, memory_id, entry_key, kind, evidence, device_id, recorded_at
      ) select
        public.portmgr_project_memory_feedback_lineage_id(
          v_canonical_memory_id, coalesce(new.origin_event_id, new.id)
        ),
        coalesce(new.origin_event_id, new.id), v_canonical_memory_id,
        new.entry_key, new.kind, new.evidence,
        new.device_id, new.recorded_at
      where not exists (
        select 1
        from public.portmgr_project_memory_feedback existing
        where existing.memory_id = v_canonical_memory_id
          and coalesce(existing.origin_event_id, existing.id)
            = coalesce(new.origin_event_id, new.id)
      )
      on conflict (id) do nothing;
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.portmgr_copy_project_memory_ledgers(
  p_source_memory_ids text[],
  p_target_memory_id text
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_target_memory_id is null or btrim(p_target_memory_id) = ''
    or coalesce(array_length(p_source_memory_ids, 1), 0) = 0 then
    raise exception using
      errcode = '22023',
      message = 'PROJECT_MEMORY_LEDGER_COPY_TARGET_REQUIRED';
  end if;

  insert into public.portmgr_project_memory_journal(
    id, memory_id, entry_hash, device_id, device_name, project_name, agent,
    recorded_at, head_commit, summary, body
  )
  select
    p_target_memory_id || ':' || source.entry_hash,
    p_target_memory_id,
    source.entry_hash,
    source.device_id,
    source.device_name,
    source.project_name,
    source.agent,
    source.recorded_at,
    source.head_commit,
    source.summary,
    source.body
  from (
    select distinct on (j.entry_hash)
      j.entry_hash, j.device_id, j.device_name, j.project_name, j.agent,
      j.recorded_at, j.head_commit, j.summary, j.body, j.id
    from public.portmgr_project_memory_journal j
    where j.memory_id = any(p_source_memory_ids)
      and j.memory_id <> p_target_memory_id
    order by j.entry_hash, j.recorded_at asc, j.id asc
  ) source
  on conflict (memory_id, entry_hash) do nothing;

  insert into public.portmgr_project_memory_feedback(
    id, origin_event_id, memory_id, entry_key, kind, evidence, device_id, recorded_at
  )
  select
    public.portmgr_project_memory_feedback_lineage_id(
      p_target_memory_id, coalesce(f.origin_event_id, f.id)
    ),
    coalesce(f.origin_event_id, f.id),
    p_target_memory_id,
    f.entry_key,
    f.kind,
    f.evidence,
    f.device_id,
    f.recorded_at
  from public.portmgr_project_memory_feedback f
  where f.memory_id = any(p_source_memory_ids)
    and f.memory_id <> p_target_memory_id
    and not exists (
      select 1
      from public.portmgr_project_memory_feedback existing
      where existing.memory_id = p_target_memory_id
        and coalesce(existing.origin_event_id, existing.id)
          = coalesce(f.origin_event_id, f.id)
    )
  order by f.recorded_at asc, f.id asc
  on conflict (id) do nothing;
end;
$$;

create or replace function public.portmgr_project_memory_ledger_delta(
  p_memory_id text,
  p_after_seq text default '0',
  p_limit integer default 1000
)
returns table(seq text, layer text, row_id text, payload jsonb)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_memory_id text;
  v_after_seq bigint;
  v_limit integer := least(greatest(coalesce(p_limit, 1000), 1), 1000);
begin
  if p_memory_id is null or btrim(p_memory_id) = '' then
    raise exception using
      errcode = '22023',
      message = 'PROJECT_MEMORY_LEDGER_MEMORY_ID_REQUIRED';
  end if;
  if coalesce(p_after_seq, '') !~ '^[0-9]+$' then
    raise exception using
      errcode = '22023',
      message = 'PROJECT_MEMORY_LEDGER_CURSOR_INVALID';
  end if;
  begin
    v_after_seq := p_after_seq::bigint;
  exception
    when invalid_text_representation or numeric_value_out_of_range then
      raise exception using
        errcode = '22023',
        message = 'PROJECT_MEMORY_LEDGER_CURSOR_INVALID';
  end;

  v_memory_id := public.portmgr_resolve_project_memory_id(btrim(p_memory_id));
  return query
  select
    ledger_change.sync_seq::text,
    ledger_change.layer,
    ledger_change.row_id,
    case ledger_change.layer
      when 'journal' then
        case when journal.id is null then null::jsonb else jsonb_build_object(
          'memory_id', journal.memory_id,
          'entry_hash', journal.entry_hash,
          'recorded_at', journal.recorded_at,
          'agent', journal.agent,
          'head_commit', journal.head_commit,
          'summary', journal.summary,
          'body', journal.body
        ) end
      when 'feedback' then
        case when feedback.id is null then null::jsonb else jsonb_build_object(
          'id', feedback.id,
          'origin_event_id', feedback.origin_event_id,
          'memory_id', feedback.memory_id,
          'entry_key', feedback.entry_key,
          'kind', feedback.kind,
          'evidence', feedback.evidence,
          'device_id', feedback.device_id,
          'recorded_at', feedback.recorded_at
        ) end
      else null::jsonb
    end
  from public.portmgr_project_memory_ledger_changes ledger_change
  left join public.portmgr_project_memory_journal journal
    on ledger_change.layer = 'journal' and journal.id = ledger_change.row_id
  left join public.portmgr_project_memory_feedback feedback
    on ledger_change.layer = 'feedback' and feedback.id = ledger_change.row_id
  where ledger_change.memory_id = v_memory_id
    and ledger_change.sync_seq > v_after_seq
  order by ledger_change.sync_seq asc
  limit v_limit;
end;
$$;

create or replace function public.portmgr_project_memory_ledger_cursor_status(
  p_memory_id text,
  p_cursor text,
  p_layer text,
  p_row_id text
)
returns table(cursor_valid boolean, max_seq text)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_memory_id text;
  v_cursor bigint;
begin
  if p_memory_id is null or btrim(p_memory_id) = ''
    or p_layer not in ('journal', 'feedback')
    or p_row_id is null or p_row_id = ''
    or octet_length(p_row_id) > 1024 then
    raise exception using
      errcode = '22023',
      message = 'PROJECT_MEMORY_LEDGER_ANCHOR_INVALID';
  end if;
  if coalesce(p_cursor, '') !~ '^[0-9]+$' then
    raise exception using
      errcode = '22023',
      message = 'PROJECT_MEMORY_LEDGER_CURSOR_INVALID';
  end if;
  begin
    v_cursor := p_cursor::bigint;
  exception
    when invalid_text_representation or numeric_value_out_of_range then
      raise exception using
        errcode = '22023',
        message = 'PROJECT_MEMORY_LEDGER_CURSOR_INVALID';
  end;

  v_memory_id := public.portmgr_resolve_project_memory_id(btrim(p_memory_id));
  return query select
    exists (
      select 1
      from public.portmgr_project_memory_ledger_changes ledger_change
      where ledger_change.memory_id = v_memory_id
        and ledger_change.sync_seq = v_cursor
        and ledger_change.layer = p_layer
        and ledger_change.row_id = p_row_id
    ),
    coalesce((
      select max(ledger_change.sync_seq)
      from public.portmgr_project_memory_ledger_changes ledger_change
      where ledger_change.memory_id = v_memory_id
    ), 0)::text;
end;
$$;

revoke all on function public.portmgr_project_memory_ledger_cursor_status(text, text, text, text)
  from public, anon;
grant execute on function public.portmgr_project_memory_ledger_cursor_status(text, text, text, text)
  to authenticated, service_role;

revoke all on function public.portmgr_project_memory_feedback_lineage_id(text, text)
  from public, anon, authenticated;
grant execute on function public.portmgr_project_memory_feedback_lineage_id(text, text)
  to service_role;
