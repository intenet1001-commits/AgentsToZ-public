begin;

-- 공식 VOC receiver의 service_role을 가진 운영자 단말 전용 경로다.
-- 공개 Edge Function은 이 RPC를 호출하지 않으며 기존 단말별 일일 한도를 유지한다.
create or replace function public.portmgr_submit_voc_admin(
  p_id uuid, p_device_hash text, p_app_version text, p_tab text, p_anchor jsonb, p_comment text
)
returns table(accepted boolean, reason text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_accepting boolean;
  v_block_scope text;
begin
  select s.accepting into v_accepting
  from public.portmgr_voc_settings s where s.id = 'default';
  if not coalesce(v_accepting, false) then
    return query select false, 'disabled'::text; return;
  end if;
  if p_device_hash is null or p_device_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid device hash';
  end if;
  select b.scope into v_block_scope from public.portmgr_voc_blocklist b
  where b.device_hash = p_device_hash and (b.expires_at is null or b.expires_at > now());
  if v_block_scope is not null then
    return query select false, (v_block_scope || '_blocked')::text; return;
  end if;
  if p_comment is null or char_length(btrim(p_comment)) not between 1 and 4000 then
    raise exception using errcode = '22023', message = 'comment must be 1..4000 characters';
  end if;
  insert into public.portmgr_voc_inbox(id, app_version, tab, anchor, comment, device_hash)
  values (p_id, left(coalesce(p_app_version, ''), 100), left(coalesce(p_tab, ''), 50),
          coalesce(p_anchor, '{}'::jsonb), btrim(p_comment), p_device_hash)
  on conflict (id) do nothing;
  return query select true, null::text;
end;
$$;

revoke all on function public.portmgr_submit_voc_admin(uuid, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.portmgr_submit_voc_admin(uuid, text, text, text, jsonb, text) to service_role;

commit;
