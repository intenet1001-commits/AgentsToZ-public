
-- Project-memory revision retention. Service-role only, bounded per call.
-- Kept: the newest p_keep_recent revisions of each memory, the newest one per
-- UTC day for 90 days and per week before that, the newest one per device, the
-- current head, any revision a device reports as its sync point, and any
-- revision a lineage merge references. Everything else goes, oldest first, at
-- most p_limit rows per call, skipping rows another transaction holds.
create or replace function public.portmgr_prune_project_memory_revisions(
  p_memory_id text default null,
  p_keep_recent integer default 30,
  p_limit integer default 200
)
returns integer
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_keep integer := least(greatest(coalesce(p_keep_recent, 30), 10), 500);
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 500);
  v_deleted integer := 0;
begin
  with ranked as (
    select r.id, r.created_at,
      row_number() over (
        partition by r.memory_id
        order by r.created_at desc nulls first, r.id desc
      ) as recent_rank,
      row_number() over (
        partition by r.memory_id, coalesce(r.device_id, '')
        order by r.created_at desc nulls first, r.id desc
      ) as device_rank,
      row_number() over (
        partition by r.memory_id,
          case when r.created_at >= now() - interval '90 days'
            then date_trunc('day', r.created_at at time zone 'UTC')
            else date_trunc('week', r.created_at at time zone 'UTC') end
        order by r.created_at desc nulls first, r.id desc
      ) as bucket_rank
    from public.portmgr_project_memory_revisions r
    where p_memory_id is null or r.memory_id = p_memory_id
  ),
  doomed as (
    select ranked.id, ranked.created_at from ranked
    where ranked.recent_rank > v_keep
      and ranked.device_rank > 1
      and ranked.bucket_rank > 1
      and ranked.created_at is not null
      and not exists (
        select 1 from public.portmgr_project_memory_heads h
        where h.head_revision_id = ranked.id
      )
      and not exists (
        select 1 from public.portmgr_project_memory_devices d
        where d.revision_id = ranked.id
      )
      and not exists (
        select 1 from public.portmgr_project_memory_merges m
        where m.merged_revision_id = ranked.id
          or ranked.id = any(m.source_head_revision_ids)
      )
    order by ranked.created_at asc, ranked.id asc
    limit v_limit
  ),
  locked as (
    select r.id from public.portmgr_project_memory_revisions r
    join doomed on doomed.id = r.id
    for update of r skip locked
  )
  delete from public.portmgr_project_memory_revisions r
  using locked
  where r.id = locked.id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.portmgr_prune_project_memory_revisions(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.portmgr_prune_project_memory_revisions(text, integer, integer)
  to service_role;
