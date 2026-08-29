begin;

do $$
declare
  v_token text := repeat('7a', 32);
  v_device_id text;
  v_credential text;
  v_name text;
  v_count integer;
  v_present boolean;
  v_rotate_token text := repeat('8b', 32);
  v_new_device_id text;
  v_new_credential text;
  v_previous_device_id text;
  v_revoked_at timestamptz;
  v_unauthorized_blocked boolean := false;
  v_pending_token text := repeat('9c', 32);
  v_pending_device_id text;
  v_pending_credential text;
  v_pending_expires_at timestamptz;
  v_cancelled boolean;
begin
  insert into public.portmgr_remote_device_enrollments(
    id, token_hash, requested_name, environment_kind, target_memory_id, expires_at
  ) values (
    'host-project-test-enrollment', encode(digest(v_token, 'sha256'), 'hex'),
    'SQL test AWS', 'aws', null, now() + interval '5 minutes'
  );

  select device_id, device_credential, device_name
  into v_device_id, v_credential, v_name
  from public.portmgr_claim_remote_host_enrollment(
    v_token, 'sql-test-host', 'linux', 'aws', 'Ubuntu test', 'x86_64', 'test',
    null, null, false
  );
  if v_device_id is null or v_credential is null or v_name <> 'SQL test AWS' then
    raise exception 'host claim failed';
  end if;

  select project_count into v_count
  from public.portmgr_report_remote_device_inventory(
    v_device_id, v_credential, '/home/ubuntu/projects',
    jsonb_build_array(jsonb_build_object(
      'project_path', '/home/ubuntu/projects/demo',
      'project_name', 'demo',
      'memory_id', '884575df-63c4-407c-8b43-860d1295e663',
      'git_head_sha', repeat('a', 40),
      'git_dirty', false,
      'registered', true
    ))
  );
  if v_count <> 1 then raise exception 'project inventory count failed'; end if;
  perform * from public.portmgr_report_remote_device_agent_version(
    v_device_id, v_credential, 'test-v3'
  );
  if (select agent_version from public.portmgr_remote_devices where device_id = v_device_id) <> 'test-v3' then
    raise exception 'agent version refresh failed';
  end if;

  perform * from public.portmgr_report_remote_device_inventory(
    v_device_id, v_credential, '/home/ubuntu/projects', '[]'::jsonb
  );
  select present into v_present from public.portmgr_remote_device_projects
  where device_id = v_device_id and project_path = '/home/ubuntu/projects/demo';
  if v_present is distinct from false then
    raise exception 'missing project history was not preserved';
  end if;

  insert into public.portmgr_remote_device_enrollments(
    id, token_hash, requested_name, environment_kind, target_memory_id, expires_at
  ) values (
    'host-rotation-test-enrollment', encode(digest(v_rotate_token, 'sha256'), 'hex'),
    'SQL test AWS rotated', 'aws', null, now() + interval '5 minutes'
  );
  select device_id, device_credential, previous_device_id
  into v_new_device_id, v_new_credential, v_previous_device_id
  from public.portmgr_claim_remote_host_enrollment(
    v_rotate_token, 'sql-test-host', 'linux', 'aws', 'Ubuntu test', 'x86_64', 'test-rotate',
    v_device_id, v_credential, true
  );
  if v_new_device_id is null or v_new_device_id = v_device_id or v_previous_device_id <> v_device_id then
    raise exception 'two-phase rotation claim failed';
  end if;
  select count(*) into v_count from public.portmgr_remote_device_credentials
  where device_id = v_device_id;
  if v_count <> 1 then
    raise exception 'old credential was revoked before local persistence confirmation';
  end if;

  insert into public.portmgr_remote_devices(device_id, display_name, platform, environment_kind)
  values ('00000000-0000-4000-8000-000000000099', 'unrelated host', 'linux', 'aws');
  insert into public.portmgr_remote_device_credentials(device_id, credential_hash)
  values ('00000000-0000-4000-8000-000000000099', encode(digest('unrelated-secret', 'sha256'), 'hex'));
  begin
    perform * from public.portmgr_finalize_remote_device_rotation(
      v_new_device_id, v_new_credential, '00000000-0000-4000-8000-000000000099'
    );
  exception when insufficient_privilege then
    v_unauthorized_blocked := true;
  end;
  if not v_unauthorized_blocked then
    raise exception 'replacement identity could revoke an unrelated host';
  end if;
  select count(*) into v_count from public.portmgr_remote_device_credentials
  where device_id = '00000000-0000-4000-8000-000000000099';
  if v_count <> 1 then raise exception 'unrelated host credential was changed'; end if;

  perform * from public.portmgr_finalize_remote_device_rotation(
    v_new_device_id, v_new_credential, v_previous_device_id
  );
  select count(*) into v_count from public.portmgr_remote_device_credentials
  where device_id = v_device_id;
  select revoked_at into v_revoked_at from public.portmgr_remote_devices
  where device_id = v_device_id;
  if v_count <> 0 or v_revoked_at is null then
    raise exception 'old identity was not revoked after persistence confirmation';
  end if;
  select project_count into v_count
  from public.portmgr_report_remote_device_inventory(
    v_new_device_id, v_new_credential, '/home/ubuntu/projects', '[]'::jsonb
  );
  if v_count <> 0 then raise exception 'replacement identity report failed'; end if;

  insert into public.portmgr_remote_device_enrollments(
    id, token_hash, requested_name, environment_kind, target_memory_id, expires_at
  ) values (
    'host-pending-claim-test', encode(digest(v_pending_token, 'sha256'), 'hex'),
    'SQL pending AWS', 'aws', null, now() + interval '5 minutes'
  );
  select device_id, device_credential into v_pending_device_id, v_pending_credential
  from public.portmgr_claim_remote_host_enrollment(
    v_pending_token, 'pending-host', 'linux', 'aws', 'Ubuntu test', 'x86_64', 'test',
    null, null, false
  );
  select provisioning_expires_at into v_pending_expires_at
  from public.portmgr_remote_devices where device_id = v_pending_device_id;
  if v_pending_expires_at is null then raise exception 'new claim was not provisional'; end if;
  select public.portmgr_cancel_remote_device_claim(v_pending_device_id, v_pending_credential)
  into v_cancelled;
  if not v_cancelled or exists (
    select 1 from public.portmgr_remote_devices where device_id = v_pending_device_id
  ) then raise exception 'unpersisted claim cancellation failed'; end if;

  select device_id, device_credential into v_pending_device_id, v_pending_credential
  from public.portmgr_claim_remote_host_enrollment(
    v_pending_token, 'pending-host', 'linux', 'aws', 'Ubuntu test', 'x86_64', 'test',
    null, null, false
  );
  if not public.portmgr_confirm_remote_device_claim(v_pending_device_id, v_pending_credential) then
    raise exception 'persisted claim confirmation failed';
  end if;
  select provisioning_expires_at into v_pending_expires_at
  from public.portmgr_remote_devices where device_id = v_pending_device_id;
  if v_pending_expires_at is not null then raise exception 'confirmed claim remained provisional'; end if;
end;
$$;

rollback;
