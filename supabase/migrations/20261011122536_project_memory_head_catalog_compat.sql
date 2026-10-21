-- Restore the existing bounded, invoker-only metadata RPC on older cloud installations.
-- No source memory, revision, head, binding or membership row is modified.
create or replace function public.portmgr_list_project_memory_head_page(
  p_after_memory_id text default null,p_limit integer default 100
)
returns table(
  id text,memory_id text,project_name text,github_url text,device_id text,
  device_name text,content_hash text,created_at timestamptz
)
language sql stable security invoker set search_path=public as $$
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
    on selected_head.id=head.head_revision_id and selected_head.memory_id=head.memory_id
  left join lateral (
    select r.id,r.project_name,r.github_url,r.device_id,r.device_name,r.content_hash,r.created_at
    from public.portmgr_project_memory_revisions r
    where r.memory_id=head.memory_id and selected_head.id is null
    order by r.created_at desc nulls last,r.id desc
    limit 1
  ) fallback on true
  where (p_after_memory_id is null or head.memory_id>p_after_memory_id)
    and (selected_head.id is not null or fallback.id is not null)
  order by head.memory_id asc
  limit least(greatest(coalesce(p_limit,100),1),500);
$$;
revoke all on function public.portmgr_list_project_memory_head_page(text,integer) from public,anon;
grant execute on function public.portmgr_list_project_memory_head_page(text,integer) to authenticated,service_role;
notify pgrst, 'reload schema';
