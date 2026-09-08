begin;

-- RETURNS TABLE exposes memory_id as a PL/pgSQL output variable. Referring to
-- ON CONFLICT (memory_id) is therefore ambiguous at execution time even though
-- CREATE FUNCTION succeeds. Name the table constraint explicitly.
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
  on conflict on constraint portmgr_what_i_said_memory_policy_pkey do update
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

revoke all on function public.portmgr_set_what_i_said_capture_policy(text[], boolean, text, boolean)
  from public, anon, authenticated;
grant execute on function public.portmgr_set_what_i_said_capture_policy(text[], boolean, text, boolean)
  to service_role;

commit;
