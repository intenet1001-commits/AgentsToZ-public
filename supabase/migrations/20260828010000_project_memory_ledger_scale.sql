-- Decades-scale project-memory ledgers and one-head-per-memory directory pages.
--
-- Existing journal/feedback rows keep their schema and remain immutable. A
-- separate server-ingestion sequence makes late historical backfill visible to
-- cursor clients without asking every client to download every hash forever.

create extension if not exists pgcrypto with schema extensions;

alter table public.portmgr_project_memory_feedback
  add column if not exists origin_event_id text;

-- Preserve one immutable origin across any number of lineage hops. Without
-- this provenance A -> B -> C hashes B's derived ID, while a late A -> C write
-- hashes A's ID and creates a second copy of the same user evidence.
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

create table if not exists public.portmgr_project_memory_ledger_changes (
  sync_seq bigint generated always as identity primary key,
  layer text not null check (layer in ('journal', 'feedback')),
  memory_id text not null,
  row_id text not null,
  created_at timestamptz not null default now(),
  unique (layer, row_id)
);

create index if not exists idx_portmgr_project_memory_ledger_changes_memory_seq
  on public.portmgr_project_memory_ledger_changes(memory_id, sync_seq);

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

  -- Identity values are allocated before commit. Without this per-memory
  -- transaction lock, transaction A can allocate seq 100 and pause while B
  -- allocates+commits 101; a client advancing to 101 would then miss A forever.
  -- The AFTER trigger acquires the lock before inserting the change row, so
  -- allocation and commit order are identical for both ledger layers.
  perform pg_advisory_xact_lock(hashtextextended(
    'portmgr-project-memory-ledger:' || new.memory_id,
    0
  ));

  insert into public.portmgr_project_memory_ledger_changes(layer, memory_id, row_id)
  values (v_layer, new.memory_id, new.id)
  on conflict (layer, row_id) do nothing;

  -- A device may stay offline across a lineage merge and later Push using the
  -- retired source ID. Forward that one immutable row continuously; copying
  -- the whole source ledger here would turn late inserts into O(N²). The target
  -- insert fires this trigger once more, but canonical resolution then equals
  -- NEW.memory_id and stops the recursion.
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

drop trigger if exists portmgr_record_project_memory_journal_change
  on public.portmgr_project_memory_journal;
create trigger portmgr_record_project_memory_journal_change
after insert on public.portmgr_project_memory_journal
for each row execute function public.portmgr_record_project_memory_ledger_change('journal');

drop trigger if exists portmgr_record_project_memory_feedback_change
  on public.portmgr_project_memory_feedback;
create trigger portmgr_record_project_memory_feedback_change
after insert on public.portmgr_project_memory_feedback
for each row execute function public.portmgr_record_project_memory_ledger_change('feedback');

-- Rows predating this migration receive one stable ingestion position. The
-- unique key makes this safe to replay, while new/old clients are captured by
-- the INSERT triggers above.
insert into public.portmgr_project_memory_ledger_changes(layer, memory_id, row_id, created_at)
select 'journal', j.memory_id, j.id, coalesce(j.created_at, now())
from public.portmgr_project_memory_journal j
order by j.created_at nulls first, j.id
on conflict (layer, row_id) do nothing;

insert into public.portmgr_project_memory_ledger_changes(layer, memory_id, row_id, created_at)
select 'feedback', f.memory_id, f.id, coalesce(f.created_at, now())
from public.portmgr_project_memory_feedback f
order by f.created_at nulls first, f.id
on conflict (layer, row_id) do nothing;

-- Merge source ledgers into the target without rewriting or deleting sources.
-- Journal IDs keep the app's target:hash convention. Feedback IDs are derived
-- from target+immutable origin ID so chained merges and late direct forwards
-- converge on the same row.
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

create or replace function public.portmgr_copy_project_memory_ledgers_on_merge()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.portmgr_copy_project_memory_ledgers(
    new.source_memory_ids,
    new.target_memory_id
  );
  return new;
end;
$$;

-- Close the snapshot/alias race during a merge. Ledger INSERT triggers take
-- the same per-memory lock. A write that started first commits before the merge
-- snapshot; a write that starts later waits until aliases are visible and is
-- then continuously forwarded to the canonical target.
create or replace function public.portmgr_lock_project_memory_merge_ledgers()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_memory_id text;
begin
  for v_memory_id in
    select distinct candidate
    from unnest(new.source_memory_ids || array[new.target_memory_id]) candidate
    where candidate is not null and btrim(candidate) <> ''
    order by candidate
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      'portmgr-project-memory-ledger:' || v_memory_id,
      0
    ));
  end loop;
  return new;
end;
$$;

drop trigger if exists portmgr_lock_project_memory_merge_ledgers
  on public.portmgr_project_memory_merges;
create trigger portmgr_lock_project_memory_merge_ledgers
before insert on public.portmgr_project_memory_merges
for each row execute function public.portmgr_lock_project_memory_merge_ledgers();

drop trigger if exists portmgr_copy_project_memory_ledgers_on_merge
  on public.portmgr_project_memory_merges;
create trigger portmgr_copy_project_memory_ledgers_on_merge
after insert on public.portmgr_project_memory_merges
for each row execute function public.portmgr_copy_project_memory_ledgers_on_merge();

-- Repair every historical merge in chronological order so a later merge sees
-- copies produced for its earlier source lineage. Re-running is a no-op.
do $$
declare
  merged record;
begin
  for merged in
    select source_memory_ids, target_memory_id
    from public.portmgr_project_memory_merges
    order by created_at asc, id asc
  loop
    perform public.portmgr_copy_project_memory_ledgers(
      merged.source_memory_ids,
      merged.target_memory_id
    );
  end loop;
end;
$$;

-- Backfill and repair missing/null/dangling/stale heads. `id` breaks equal
-- created_at ties deterministically.
with latest as (
  select distinct on (r.memory_id)
    r.memory_id,
    r.id,
    coalesce(r.created_at, 'epoch'::timestamptz) as updated_at
  from public.portmgr_project_memory_revisions r
  order by r.memory_id, r.created_at desc nulls last, r.id desc
)
insert into public.portmgr_project_memory_heads as head(
  memory_id, head_revision_id, updated_at
)
select latest.memory_id, latest.id, latest.updated_at
from latest
on conflict (memory_id) do update
set head_revision_id = excluded.head_revision_id,
    updated_at = excluded.updated_at
where head.head_revision_id is distinct from excluded.head_revision_id;

update public.portmgr_project_memory_heads head
set head_revision_id = null,
    updated_at = now()
where head.head_revision_id is not null
  and not exists (
    select 1
    from public.portmgr_project_memory_revisions r
    where r.memory_id = head.memory_id
  );

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

-- Validate the exact immutable row at a device cursor. This detects a database
-- restore even after the identity sequence later grows beyond the stale cursor.
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

create or replace function public.portmgr_list_project_memory_head_page(
  p_after_memory_id text default null,
  p_limit integer default 100
)
returns table(
  id text,
  memory_id text,
  project_name text,
  github_url text,
  device_id text,
  device_name text,
  content_hash text,
  created_at timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    case when selected_head.id is not null then selected_head.id else fallback.id end,
    head.memory_id,
    case when selected_head.id is not null then selected_head.project_name else fallback.project_name end,
    case when selected_head.id is not null then selected_head.github_url else fallback.github_url end,
    case when selected_head.id is not null then selected_head.device_id else fallback.device_id end,
    case when selected_head.id is not null then selected_head.device_name else fallback.device_name end,
    case when selected_head.id is not null then selected_head.content_hash else fallback.content_hash end,
    case when selected_head.id is not null then selected_head.created_at else fallback.created_at end
  from public.portmgr_project_memory_heads head
  left join public.portmgr_project_memory_revisions selected_head
    on selected_head.id = head.head_revision_id
   and selected_head.memory_id = head.memory_id
  left join lateral (
    select
      r.id, r.project_name, r.github_url, r.device_id, r.device_name,
      r.content_hash, r.created_at
    from public.portmgr_project_memory_revisions r
    where r.memory_id = head.memory_id
      and selected_head.id is null
    order by r.created_at desc nulls last, r.id desc
    limit 1
  ) fallback on true
  where (p_after_memory_id is null or head.memory_id > p_after_memory_id)
    and (selected_head.id is not null or fallback.id is not null)
  order by head.memory_id asc
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

alter table public.portmgr_project_memory_ledger_changes enable row level security;
drop policy if exists portmgr_authenticated_all
  on public.portmgr_project_memory_ledger_changes;
drop policy if exists portmgr_authenticated_read
  on public.portmgr_project_memory_ledger_changes;

do $$
declare
  predicate text;
begin
  predicate := case
    when to_regprocedure('public.portmgr_is_member()') is null then 'false'
    else '(select public.portmgr_is_member())'
  end;
  execute format(
    'create policy portmgr_authenticated_read on public.portmgr_project_memory_ledger_changes for select to authenticated using (%s)',
    predicate
  );
end;
$$;

revoke all privileges on table public.portmgr_project_memory_ledger_changes
  from public, anon, authenticated, service_role;
grant select on table public.portmgr_project_memory_ledger_changes
  to authenticated, service_role;

revoke all on function public.portmgr_record_project_memory_ledger_change()
  from public, anon, authenticated;
grant execute on function public.portmgr_record_project_memory_ledger_change()
  to service_role;
revoke all on function public.portmgr_project_memory_feedback_lineage_id(text, text)
  from public, anon, authenticated;
grant execute on function public.portmgr_project_memory_feedback_lineage_id(text, text)
  to service_role;
revoke all on function public.portmgr_copy_project_memory_ledgers(text[], text)
  from public, anon, authenticated;
grant execute on function public.portmgr_copy_project_memory_ledgers(text[], text)
  to service_role;
revoke all on function public.portmgr_copy_project_memory_ledgers_on_merge()
  from public, anon, authenticated;
grant execute on function public.portmgr_copy_project_memory_ledgers_on_merge()
  to service_role;
revoke all on function public.portmgr_lock_project_memory_merge_ledgers()
  from public, anon, authenticated;
grant execute on function public.portmgr_lock_project_memory_merge_ledgers()
  to service_role;
revoke all on function public.portmgr_project_memory_ledger_delta(text, text, integer)
  from public, anon;
grant execute on function public.portmgr_project_memory_ledger_delta(text, text, integer)
  to authenticated, service_role;
revoke all on function public.portmgr_project_memory_ledger_cursor_status(text, text, text, text)
  from public, anon;
grant execute on function public.portmgr_project_memory_ledger_cursor_status(text, text, text, text)
  to authenticated, service_role;
revoke all on function public.portmgr_list_project_memory_head_page(text, integer)
  from public, anon;
grant execute on function public.portmgr_list_project_memory_head_page(text, integer)
  to authenticated, service_role;
