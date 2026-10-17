
-- Ephemeral, same-Control-profile agent inbox. No project memory or local path is stored here.
create table if not exists public.portmgr_agent_dialogue_device_keys (
  profile_id text not null, device_id text not null, secret_hash bytea not null,
  revoked_at timestamptz, created_at timestamptz not null default now(),
  primary key(profile_id, device_id)
);
create table if not exists public.portmgr_agent_dialogue_endpoints (
  endpoint_id uuid primary key default gen_random_uuid(),
  profile_id text not null, device_id text not null,
  kind text not null check(kind in ('ops','project')),
  port_id text, incarnation_id uuid not null, display_name text not null,
  memory_id text, contract_version integer not null default 1,
  state text not null default 'active' check(state in ('active','revoked')),
  last_seen_at timestamptz not null default now(),
  check ((kind='ops' and port_id is null and memory_id is null)
      or (kind='project' and port_id is not null and length(port_id)>0))
);
create unique index if not exists portmgr_agent_dialogue_active_ops
  on public.portmgr_agent_dialogue_endpoints(profile_id,device_id) where kind='ops' and state='active';
create unique index if not exists portmgr_agent_dialogue_active_project
  on public.portmgr_agent_dialogue_endpoints(profile_id,device_id,port_id) where kind='project' and state='active';
create index if not exists portmgr_agent_dialogue_endpoints_profile
  on public.portmgr_agent_dialogue_endpoints(profile_id,state,last_seen_at desc);
create table if not exists public.portmgr_agent_dialogue_rooms (
  room_id uuid primary key default gen_random_uuid(), profile_id text not null,
  owner_participant_id uuid, state text not null default 'active' check(state in ('active','closed','expired')),
  next_seq bigint not null default 1 check(next_seq>0), message_count integer not null default 0,
  created_at timestamptz not null default now(), last_activity_at timestamptz not null default now(),
  expires_at timestamptz not null default (now()+interval '24 hours'), closed_at timestamptz,
  contract_version integer not null default 1,
  -- A community is the standing group room for one Control profile: each device enters once and
  -- stays until it leaves, so \u00ABwho calls whom\u00BB disappears. It is exempt from the 24-hour expiry and
  -- the 2-hour idle close, which is the whole point \u2014 a pairwise room is still an ordinary 'room'.
  kind text not null default 'room' check(kind in ('room','community'))
);
-- \u00ABcreate table if not exists\u00BB skips a rooms table made by 20261003010000, so add the column there too.
-- Existing rows become ordinary rooms; the constant default makes this a metadata-only change.
alter table public.portmgr_agent_dialogue_rooms
  add column if not exists kind text not null default 'room' check(kind in ('room','community'));
create unique index if not exists portmgr_agent_dialogue_one_community
  on public.portmgr_agent_dialogue_rooms(profile_id) where kind='community' and state='active';
create table if not exists public.portmgr_agent_dialogue_members (
  participant_id uuid primary key default gen_random_uuid(), room_id uuid not null references public.portmgr_agent_dialogue_rooms(room_id),
  endpoint_id uuid not null references public.portmgr_agent_dialogue_endpoints(endpoint_id),
  state text not null check(state in ('invited','joined','declined','left','revoked')),
  join_after_seq bigint not null default 0, leave_seq bigint, ack_seq bigint not null default 0,
  invited_at timestamptz not null default now(), joined_at timestamptz,
  unique(room_id,endpoint_id), unique(room_id,participant_id)
);
create index if not exists portmgr_agent_dialogue_members_endpoint
  on public.portmgr_agent_dialogue_members(endpoint_id,state,invited_at desc);
create table if not exists public.portmgr_agent_dialogue_events (
  room_id uuid not null references public.portmgr_agent_dialogue_rooms(room_id), seq bigint not null,
  kind text not null check(kind in ('joined','declined','left','message','closed')),
  sender_participant_id uuid not null, request_id uuid,
  message_kind text check(message_kind in ('question','answer','observation','build-receipt')),
  body text, recipient_participant_ids uuid[], created_at timestamptz not null default now(),
  primary key(room_id,seq),
  check(body is null or octet_length(body)<=4000)
);
create unique index if not exists portmgr_agent_dialogue_event_request
  on public.portmgr_agent_dialogue_events(room_id,sender_participant_id,request_id) where request_id is not null;
create table if not exists public.portmgr_agent_dialogue_requests (
  profile_id text not null, endpoint_id uuid not null, request_id uuid not null,
  operation text not null, payload_hash bytea not null, result jsonb,
  created_at timestamptz not null default now(),
  primary key(profile_id,endpoint_id,request_id)
);
create index if not exists portmgr_agent_dialogue_requests_created
  on public.portmgr_agent_dialogue_requests(created_at);
-- A 30-day mutual pairing between two exact endpoints, like the QR remote control's session.
-- Both sides must accept; the ordered pair keeps one row per couple so \u00ABmutual\u00BB is a fact, not two
-- opinions. It is a convenience that removes the per-room approval, never an authority of its own:
-- every RPC still re-checks profile, device key, endpoint state and incarnation.
create table if not exists public.portmgr_agent_dialogue_pairings (
  pairing_id uuid primary key default gen_random_uuid(), profile_id text not null,
  low_endpoint_id uuid not null references public.portmgr_agent_dialogue_endpoints(endpoint_id),
  high_endpoint_id uuid not null references public.portmgr_agent_dialogue_endpoints(endpoint_id),
  low_accepted_at timestamptz, high_accepted_at timestamptz,
  expires_at timestamptz, revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (low_endpoint_id < high_endpoint_id)
);
create unique index if not exists portmgr_agent_dialogue_pairings_pair
  on public.portmgr_agent_dialogue_pairings(profile_id,low_endpoint_id,high_endpoint_id)
  where revoked_at is null;
create index if not exists portmgr_agent_dialogue_pairings_low
  on public.portmgr_agent_dialogue_pairings(low_endpoint_id) where revoked_at is null;
create index if not exists portmgr_agent_dialogue_pairings_high
  on public.portmgr_agent_dialogue_pairings(high_endpoint_id) where revoked_at is null;
-- Device control between community members: one Mac drives another Mac's Workroom. Entering the
-- community is the consent (the user chose this over a per-device approval on 2026-10-05), so both
-- ends must be joined members of the same standing room. Rows are a mailbox, not a record: the
-- request text is cleared once answered, the answer is deleted when read, and anything older than
-- ten minutes is dropped. Terminal text passes through here in plain text \u2014 service_role only.
create table if not exists public.portmgr_agent_dialogue_controls (
  control_id uuid primary key default gen_random_uuid(), profile_id text not null,
  room_id uuid not null references public.portmgr_agent_dialogue_rooms(room_id),
  from_endpoint_id uuid not null references public.portmgr_agent_dialogue_endpoints(endpoint_id),
  to_endpoint_id uuid not null references public.portmgr_agent_dialogue_endpoints(endpoint_id),
  to_device_id text not null, request jsonb not null, response jsonb,
  state text not null default 'pending' check(state in ('pending','taken','done')),
  created_at timestamptz not null default now(), taken_at timestamptz, responded_at timestamptz,
  check(octet_length(request::text)<=65536),
  check(response is null or octet_length(response::text)<=262144)
);
create index if not exists portmgr_agent_dialogue_controls_inbox
  on public.portmgr_agent_dialogue_controls(profile_id,to_device_id,state,created_at);
create index if not exists portmgr_agent_dialogue_controls_sender
  on public.portmgr_agent_dialogue_controls(from_endpoint_id,state);

do $agent_dialogue_security$
declare v_name text;
begin
  foreach v_name in array array[
    'portmgr_agent_dialogue_device_keys','portmgr_agent_dialogue_endpoints','portmgr_agent_dialogue_rooms',
    'portmgr_agent_dialogue_members','portmgr_agent_dialogue_events','portmgr_agent_dialogue_requests',
    'portmgr_agent_dialogue_pairings','portmgr_agent_dialogue_controls'
  ] loop
    execute format('alter table public.%I enable row level security',v_name);
    execute format('revoke all on table public.%I from public, anon, authenticated',v_name);
    execute format('grant select, insert, update, delete on table public.%I to service_role',v_name);
  end loop;
end $agent_dialogue_security$;

create or replace function public.portmgr_agent_dialogue_community_members(p_room_id uuid)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public, pg_temp as $community_members$
  select coalesce(jsonb_agg(jsonb_build_object('endpointId',e.endpoint_id,'deviceId',e.device_id,
    'kind',e.kind,'displayName',e.display_name,'participantId',m.participant_id,
    'joinedAt',m.joined_at,'lastSeenAt',e.last_seen_at)
    order by e.display_name,e.endpoint_id),'[]'::jsonb)
  from public.portmgr_agent_dialogue_members m
  join public.portmgr_agent_dialogue_endpoints e on e.endpoint_id=m.endpoint_id
  where m.room_id=p_room_id and m.state='joined' and e.state='active';
$community_members$;
revoke all on function public.portmgr_agent_dialogue_community_members(uuid) from public, anon, authenticated;

create or replace function public.portmgr_agent_dialogue_call(
  p_operation text, p_profile_id text, p_device_id text, p_secret text, p_args jsonb default '{}'::jsonb
) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $agent_dialogue$
declare
  v_source public.portmgr_agent_dialogue_endpoints%rowtype;
  v_peer public.portmgr_agent_dialogue_endpoints%rowtype;
  v_room public.portmgr_agent_dialogue_rooms%rowtype;
  v_member public.portmgr_agent_dialogue_members%rowtype;
  v_request public.portmgr_agent_dialogue_requests%rowtype;
  v_result jsonb; v_hash bytea; v_request_id uuid; v_room_id uuid; v_peer_id uuid;
  v_peers uuid[]; v_recipients uuid[]; v_count integer; v_seq bigint; v_after bigint;
  v_pairing public.portmgr_agent_dialogue_pairings%rowtype; v_low uuid; v_high uuid; v_mine_low boolean;
  v_control_ids uuid[];
begin
  if auth.role() is distinct from 'service_role' then raise exception 'AGENT_DIALOGUE_ROLE_REQUIRED'; end if;
  if p_profile_id is null or length(p_profile_id)<8 or p_device_id is null or length(p_device_id)<8
    or p_secret is null or length(p_secret)<32 or p_args is null or jsonb_typeof(p_args)<>'object'
  then raise exception 'AGENT_DIALOGUE_INPUT_INVALID'; end if;
  if p_operation='register-device' then
    insert into public.portmgr_agent_dialogue_device_keys(profile_id,device_id,secret_hash)
    values(p_profile_id,p_device_id,sha256(convert_to(p_secret,'UTF8')))
    on conflict(profile_id,device_id) do nothing;
    if not exists(select 1 from public.portmgr_agent_dialogue_device_keys k
      where k.profile_id=p_profile_id and k.device_id=p_device_id and k.revoked_at is null
        and k.secret_hash=sha256(convert_to(p_secret,'UTF8')))
    then raise exception 'AGENT_DIALOGUE_DEVICE_KEY_MISMATCH'; end if;
    return jsonb_build_object('registered',true);
  end if;
  if not exists(select 1 from public.portmgr_agent_dialogue_device_keys k
    where k.profile_id=p_profile_id and k.device_id=p_device_id and k.revoked_at is null
      and k.secret_hash=sha256(convert_to(p_secret,'UTF8')))
  then raise exception 'AGENT_DIALOGUE_DEVICE_UNAUTHORIZED'; end if;

  if p_operation='prune' then
    update public.portmgr_agent_dialogue_rooms set state='expired'
      where profile_id=p_profile_id and state='active' and kind='room'
        and (expires_at<=now() or last_activity_at<now()-interval '2 hours');
    -- Control rows are a mailbox: nothing is kept past ten minutes, answered or not.
    delete from public.portmgr_agent_dialogue_controls
      where profile_id=p_profile_id and created_at<now()-interval '10 minutes';
    -- The community never expires, so its bodies are dropped by age instead of by room closure.
    with aged as (
      select e.ctid from public.portmgr_agent_dialogue_events e
      join public.portmgr_agent_dialogue_rooms r on r.room_id=e.room_id
      where r.profile_id=p_profile_id and r.kind='community' and e.body is not null
        and e.created_at<=now()-interval '30 days'
      order by e.created_at,e.room_id,e.seq limit 500
      for update of e skip locked
    )
    update public.portmgr_agent_dialogue_events e set body=null from aged
      where e.ctid=aged.ctid;
    with old_bodies as (
      select e.ctid from public.portmgr_agent_dialogue_events e
      join public.portmgr_agent_dialogue_rooms r on r.room_id=e.room_id
      where r.profile_id=p_profile_id and e.body is not null
        and coalesce(r.closed_at,r.expires_at)<=now()-interval '7 days'
      order by e.created_at,e.room_id,e.seq limit 500
      for update of e skip locked
    )
    update public.portmgr_agent_dialogue_events e set body=null from old_bodies old
      where e.ctid=old.ctid;
    get diagnostics v_count=row_count;
    return jsonb_build_object('removedBodies',v_count);
  end if;

  if p_operation='register-endpoint' then
    if p_args->>'kind' not in ('ops','project') or length(coalesce(p_args->>'displayName','')) not between 1 and 120
      or (p_args->>'kind'='project' and length(coalesce(p_args->>'portId','')) not between 1 and 200)
      or (p_args->>'kind'='ops' and (p_args ? 'portId' or p_args ? 'memoryId'))
    then raise exception 'AGENT_DIALOGUE_ENDPOINT_INVALID'; end if;
    select * into v_peer from public.portmgr_agent_dialogue_endpoints e
      where e.profile_id=p_profile_id and e.device_id=p_device_id and e.state='active'
        and e.kind=p_args->>'kind' and (e.kind='ops' or e.port_id=p_args->>'portId') for update;
    if found and v_peer.incarnation_id=(p_args->>'incarnationId')::uuid then
      update public.portmgr_agent_dialogue_endpoints set display_name=p_args->>'displayName',
        memory_id=case when kind='project' then nullif(p_args->>'memoryId','') else null end,
        last_seen_at=now() where endpoint_id=v_peer.endpoint_id;
      return jsonb_build_object('endpointId',v_peer.endpoint_id,'kind',v_peer.kind);
    end if;
    if found then
      perform 1 from public.portmgr_agent_dialogue_rooms r
        where r.room_id in (select room_id from public.portmgr_agent_dialogue_members where endpoint_id=v_peer.endpoint_id)
        order by r.room_id for update;
      update public.portmgr_agent_dialogue_endpoints set state='revoked' where endpoint_id=v_peer.endpoint_id;
      update public.portmgr_agent_dialogue_members set state='revoked'
        where endpoint_id=v_peer.endpoint_id and state in ('invited','joined');
    end if;
    insert into public.portmgr_agent_dialogue_endpoints(profile_id,device_id,kind,port_id,incarnation_id,display_name,memory_id)
    values(p_profile_id,p_device_id,p_args->>'kind',case when p_args->>'kind'='project' then p_args->>'portId' else null end,
      (p_args->>'incarnationId')::uuid,p_args->>'displayName',case when p_args->>'kind'='project' then nullif(p_args->>'memoryId','') else null end)
    returning * into v_peer;
    return jsonb_build_object('endpointId',v_peer.endpoint_id,'kind',v_peer.kind);
  end if;
  if p_operation='revoke-endpoint' then
    select * into v_peer from public.portmgr_agent_dialogue_endpoints e
      where e.endpoint_id=(p_args->>'endpointId')::uuid and e.profile_id=p_profile_id
        and e.device_id=p_device_id and e.state='active' for update;
    if found then
      perform 1 from public.portmgr_agent_dialogue_rooms r
        where r.room_id in (select room_id from public.portmgr_agent_dialogue_members where endpoint_id=v_peer.endpoint_id)
        order by r.room_id for update;
    end if;
    update public.portmgr_agent_dialogue_endpoints set state='revoked'
      where endpoint_id=(p_args->>'endpointId')::uuid and profile_id=p_profile_id and device_id=p_device_id and state='active';
    update public.portmgr_agent_dialogue_members set state='revoked'
      where endpoint_id=v_peer.endpoint_id and state in ('invited','joined');
    return jsonb_build_object('revoked',true);
  end if;

  -- Device-wide reads for the auto-join tick. Polling the per-endpoint pairings and invitations does
  -- not scale: a Mac can publish a hundred endpoints (measured 101 on 2026-10-04), so one tick would
  -- be two hundred RPCs. These two cover every active endpoint of this device in one call each and
  -- are read-only; joining still goes through the per-endpoint operation with its own checks.
  if p_operation='device-pairings' then
    select coalesce(jsonb_agg(jsonb_build_object('sourceEndpointId',mine.endpoint_id,
      'peerEndpointId',case when p.low_endpoint_id=mine.endpoint_id then p.high_endpoint_id else p.low_endpoint_id end,
      'expiresAt',p.expires_at)),'[]'::jsonb) into v_result
    from public.portmgr_agent_dialogue_endpoints mine
      join public.portmgr_agent_dialogue_pairings p
        on mine.endpoint_id in (p.low_endpoint_id,p.high_endpoint_id)
      join public.portmgr_agent_dialogue_endpoints peer
        on peer.endpoint_id=case when p.low_endpoint_id=mine.endpoint_id then p.high_endpoint_id else p.low_endpoint_id end
    where mine.profile_id=p_profile_id and mine.device_id=p_device_id and mine.state='active'
      and p.profile_id=p_profile_id and p.revoked_at is null and peer.state='active'
      and p.low_accepted_at is not null and p.high_accepted_at is not null
      and p.expires_at is not null and p.expires_at>now();
    return jsonb_build_object('pairings',v_result);
  end if;
  if p_operation='device-invitations' then
    select coalesce(jsonb_agg(jsonb_build_object('sourceEndpointId',m.endpoint_id,'roomId',m.room_id,
      'participantId',m.participant_id,'from',owner.endpoint_id) order by m.invited_at desc),'[]'::jsonb) into v_result
    from (select m.* from public.portmgr_agent_dialogue_members m
        join public.portmgr_agent_dialogue_endpoints mine on mine.endpoint_id=m.endpoint_id
        where mine.profile_id=p_profile_id and mine.device_id=p_device_id and mine.state='active'
          and m.state='invited' order by m.invited_at desc limit 50) m
      join public.portmgr_agent_dialogue_rooms r on r.room_id=m.room_id
      join public.portmgr_agent_dialogue_members om on om.participant_id=r.owner_participant_id
      join public.portmgr_agent_dialogue_endpoints owner on owner.endpoint_id=om.endpoint_id
    where r.profile_id=p_profile_id and r.state='active' and r.expires_at>now()
      and r.last_activity_at>=now()-interval '2 hours';
    return jsonb_build_object('invitations',v_result);
  end if;
  -- The target Mac takes the control requests addressed to any of its endpoints. Both ends must
  -- still be joined members of the active community and active endpoints at the moment of taking,
  -- so leaving the community or turning dialogue off stops control at once. A request older than
  -- two minutes is never executed: its sender has already given up on it.
  if p_operation='control-inbox' then
    delete from public.portmgr_agent_dialogue_controls
      where profile_id=p_profile_id and to_device_id=p_device_id and created_at<now()-interval '10 minutes';
    with picked as (
      select c.control_id from public.portmgr_agent_dialogue_controls c
      join public.portmgr_agent_dialogue_rooms r on r.room_id=c.room_id
      join public.portmgr_agent_dialogue_members fm on fm.room_id=c.room_id and fm.endpoint_id=c.from_endpoint_id
      join public.portmgr_agent_dialogue_members tm on tm.room_id=c.room_id and tm.endpoint_id=c.to_endpoint_id
      join public.portmgr_agent_dialogue_endpoints fe on fe.endpoint_id=c.from_endpoint_id
      join public.portmgr_agent_dialogue_endpoints te on te.endpoint_id=c.to_endpoint_id
      where c.profile_id=p_profile_id and c.to_device_id=p_device_id and c.state='pending'
        and c.created_at>now()-interval '2 minutes' and r.profile_id=p_profile_id
        and r.state='active' and r.kind='community' and fm.state='joined' and tm.state='joined'
        and fe.state='active' and te.state='active' and fe.profile_id=p_profile_id
        and te.profile_id=p_profile_id and te.device_id=p_device_id
      order by c.created_at,c.control_id limit 16
      for update of c skip locked
    ), taken as (
      update public.portmgr_agent_dialogue_controls c set state='taken',taken_at=now()
        from picked where c.control_id=picked.control_id
        returning c.control_id,c.from_endpoint_id,c.to_endpoint_id,c.request,c.created_at
    )
    select coalesce(jsonb_agg(jsonb_build_object('controlId',t.control_id,'fromEndpointId',t.from_endpoint_id,
      'toEndpointId',t.to_endpoint_id,'fromDeviceId',fe.device_id,'fromName',fe.display_name,'request',t.request)
      order by t.created_at,t.control_id),'[]'::jsonb) into v_result
    from taken t join public.portmgr_agent_dialogue_endpoints fe on fe.endpoint_id=t.from_endpoint_id;
    return jsonb_build_object('controls',v_result);
  end if;
  if p_operation='control-respond' then
    if jsonb_typeof(p_args->'response') is distinct from 'object' or (p_args->>'controlId') is null
    then raise exception 'AGENT_DIALOGUE_CONTROL_INVALID'; end if;
    update public.portmgr_agent_dialogue_controls set response=p_args->'response',state='done',
      responded_at=now(),request='{}'::jsonb
      where control_id=(p_args->>'controlId')::uuid and profile_id=p_profile_id
        and to_device_id=p_device_id and state='taken';
    get diagnostics v_count=row_count;
    return jsonb_build_object('responded',v_count=1);
  end if;

  select * into v_source from public.portmgr_agent_dialogue_endpoints e
    where e.endpoint_id=(p_args->>'sourceEndpointId')::uuid and e.profile_id=p_profile_id
      and e.device_id=p_device_id and e.state='active' for share;
  if not found then raise exception 'AGENT_DIALOGUE_SOURCE_UNAVAILABLE'; end if;

  if p_operation='heartbeat' then
    update public.portmgr_agent_dialogue_endpoints set last_seen_at=now()
      where endpoint_id=v_source.endpoint_id;
    return jsonb_build_object('seenAt',now());
  end if;

  if p_operation='pair' or p_operation='pair-revoke' then
    v_peer_id=(p_args->>'peerEndpointId')::uuid;
    if v_peer_id is null or v_peer_id=v_source.endpoint_id then raise exception 'AGENT_DIALOGUE_PAIR_PEER_INVALID'; end if;
    select * into v_peer from public.portmgr_agent_dialogue_endpoints e
      where e.endpoint_id=v_peer_id and e.profile_id=p_profile_id and e.state='active' for share;
    if not found then raise exception 'AGENT_DIALOGUE_PEER_UNAVAILABLE'; end if;
    v_low=least(v_source.endpoint_id,v_peer_id); v_high=greatest(v_source.endpoint_id,v_peer_id);
    v_mine_low=(v_source.endpoint_id=v_low);
    if p_operation='pair-revoke' then
      update public.portmgr_agent_dialogue_pairings set revoked_at=now()
        where profile_id=p_profile_id and low_endpoint_id=v_low and high_endpoint_id=v_high and revoked_at is null;
      return jsonb_build_object('revoked',true,'peerEndpointId',v_peer_id);
    end if;
    insert into public.portmgr_agent_dialogue_pairings(profile_id,low_endpoint_id,high_endpoint_id,
      low_accepted_at,high_accepted_at)
    values(p_profile_id,v_low,v_high,case when v_mine_low then now() end,case when v_mine_low then null else now() end)
    on conflict(profile_id,low_endpoint_id,high_endpoint_id) where revoked_at is null do update
      set low_accepted_at=case when v_mine_low then now() else public.portmgr_agent_dialogue_pairings.low_accepted_at end,
          high_accepted_at=case when v_mine_low then public.portmgr_agent_dialogue_pairings.high_accepted_at else now() end
    returning * into v_pairing;
    -- The 30 days start when the second side accepts, so a one-sided request never ages the pairing.
    if v_pairing.low_accepted_at is not null and v_pairing.high_accepted_at is not null then
      update public.portmgr_agent_dialogue_pairings set expires_at=now()+interval '30 days'
        where pairing_id=v_pairing.pairing_id returning * into v_pairing;
    end if;
    return jsonb_build_object('pairingId',v_pairing.pairing_id,'peerEndpointId',v_peer_id,
      'state',case when v_pairing.low_accepted_at is not null and v_pairing.high_accepted_at is not null
        then 'active' else 'waiting-peer' end,
      'acceptedByMe',true,'acceptedByPeer',case when v_mine_low then v_pairing.high_accepted_at is not null
        else v_pairing.low_accepted_at is not null end,
      'expiresAt',v_pairing.expires_at);
  end if;

  if p_operation='pairings' then
    select coalesce(jsonb_agg(jsonb_build_object('pairingId',p.pairing_id,
      'peerEndpointId',case when p.low_endpoint_id=v_source.endpoint_id then p.high_endpoint_id else p.low_endpoint_id end,
      'peerDisplayName',peer.display_name,'peerKind',peer.kind,'peerDeviceId',peer.device_id,
      'state',case when p.low_accepted_at is not null and p.high_accepted_at is not null
        and (p.expires_at is null or p.expires_at>now()) then 'active'
        when p.expires_at is not null and p.expires_at<=now() then 'expired' else 'waiting-peer' end,
      'acceptedByMe',case when p.low_endpoint_id=v_source.endpoint_id then p.low_accepted_at is not null
        else p.high_accepted_at is not null end,
      'acceptedByPeer',case when p.low_endpoint_id=v_source.endpoint_id then p.high_accepted_at is not null
        else p.low_accepted_at is not null end,
      'expiresAt',p.expires_at) order by peer.display_name,peer.endpoint_id),'[]'::jsonb) into v_result
    from public.portmgr_agent_dialogue_pairings p
    join public.portmgr_agent_dialogue_endpoints peer
      on peer.endpoint_id=case when p.low_endpoint_id=v_source.endpoint_id then p.high_endpoint_id else p.low_endpoint_id end
    where p.profile_id=p_profile_id and p.revoked_at is null and peer.state='active'
      and v_source.endpoint_id in (p.low_endpoint_id,p.high_endpoint_id)
    limit 200;
    return jsonb_build_object('pairings',v_result);
  end if;

  -- Sending a control request: the sender and the target are both joined members of this
  -- profile's community and the target is another device. Nothing else is required \u2014 the user
  -- chose \u00ABjoined means controllable\u00BB \u2014 but every profile, device-key and endpoint check holds.
  if p_operation='control-send' then
    v_peer_id=(p_args->>'targetEndpointId')::uuid;
    if v_peer_id is null or jsonb_typeof(p_args->'request') is distinct from 'object'
      or octet_length((p_args->'request')::text)>65536
    then raise exception 'AGENT_DIALOGUE_CONTROL_INVALID'; end if;
    select * into v_room from public.portmgr_agent_dialogue_rooms r
      where r.profile_id=p_profile_id and r.kind='community' and r.state='active';
    if not found or not exists(select 1 from public.portmgr_agent_dialogue_members m
      where m.room_id=v_room.room_id and m.endpoint_id=v_source.endpoint_id and m.state='joined')
    then raise exception 'AGENT_DIALOGUE_CONTROL_NOT_IN_COMMUNITY'; end if;
    select e.* into v_peer from public.portmgr_agent_dialogue_endpoints e
      join public.portmgr_agent_dialogue_members m on m.endpoint_id=e.endpoint_id
        and m.room_id=v_room.room_id and m.state='joined'
      where e.endpoint_id=v_peer_id and e.profile_id=p_profile_id and e.state='active';
    if not found or v_peer.device_id=p_device_id then raise exception 'AGENT_DIALOGUE_CONTROL_TARGET_UNAVAILABLE'; end if;
    delete from public.portmgr_agent_dialogue_controls
      where from_endpoint_id=v_source.endpoint_id and created_at<now()-interval '10 minutes';
    if (select count(*) from public.portmgr_agent_dialogue_controls c
      where c.from_endpoint_id=v_source.endpoint_id and c.state<>'done')>=64
    then raise exception 'AGENT_DIALOGUE_CONTROL_BUSY'; end if;
    insert into public.portmgr_agent_dialogue_controls(profile_id,room_id,from_endpoint_id,to_endpoint_id,to_device_id,request)
      values(p_profile_id,v_room.room_id,v_source.endpoint_id,v_peer.endpoint_id,v_peer.device_id,p_args->'request')
      returning control_id into v_request_id;
    return jsonb_build_object('controlId',v_request_id,'targetDeviceId',v_peer.device_id);
  end if;
  -- The sender collects answers; an answer is deleted in the same statement that returns it.
  if p_operation='control-result' then
    select array_agg(value::uuid) into v_control_ids from jsonb_array_elements_text(p_args->'controlIds') value;
    if coalesce(cardinality(v_control_ids),0) not between 1 and 16 then raise exception 'AGENT_DIALOGUE_CONTROL_INVALID'; end if;
    with answered as (
      delete from public.portmgr_agent_dialogue_controls c
        where c.control_id=any(v_control_ids) and c.from_endpoint_id=v_source.endpoint_id and c.state='done'
        returning c.control_id,c.response
    )
    select coalesce(jsonb_agg(jsonb_build_object('controlId',control_id,'response',response)),'[]'::jsonb)
      into v_result from answered;
    return jsonb_build_object('results',v_result,'waiting',(select coalesce(jsonb_agg(c.control_id),'[]'::jsonb)
      from public.portmgr_agent_dialogue_controls c
      where c.control_id=any(v_control_ids) and c.from_endpoint_id=v_source.endpoint_id and c.state<>'done'));
  end if;

  -- The community: entering is the consent, and membership lasts until this endpoint leaves.
  -- There is no invitation and nobody \u00ABcalls\u00BB anybody, so any active endpoint of this same Control
  -- profile may enter. Every other check still holds: profile, device key, endpoint state.
  if p_operation='community-join' then
    select * into v_room from public.portmgr_agent_dialogue_rooms r
      where r.profile_id=p_profile_id and r.kind='community' and r.state='active' for update;
    if not found then
      insert into public.portmgr_agent_dialogue_rooms(profile_id,kind,expires_at)
        values(p_profile_id,'community',now()+interval '100 years') returning * into v_room;
    end if;
    v_room_id=v_room.room_id;
    select * into v_member from public.portmgr_agent_dialogue_members m
      where m.room_id=v_room_id and m.endpoint_id=v_source.endpoint_id for update;
    if found and v_member.state='joined' then
      v_result=jsonb_build_object('roomId',v_room_id,'participantId',v_member.participant_id,
        'joined',true,'alreadyIn',true);
    else
      if (select count(*) from public.portmgr_agent_dialogue_members m
        where m.room_id=v_room_id and m.state='joined')>=16
      then raise exception 'AGENT_DIALOGUE_COMMUNITY_FULL'; end if;
      if found then
        update public.portmgr_agent_dialogue_members set state='joined',joined_at=now(),
          join_after_seq=v_room.next_seq,leave_seq=null where participant_id=v_member.participant_id;
      else
        insert into public.portmgr_agent_dialogue_members(room_id,endpoint_id,state,joined_at,join_after_seq)
          values(v_room_id,v_source.endpoint_id,'joined',now(),v_room.next_seq) returning * into v_member;
      end if;
      insert into public.portmgr_agent_dialogue_events(room_id,seq,kind,sender_participant_id,request_id)
        values(v_room_id,v_room.next_seq,'joined',v_member.participant_id,(p_args->>'requestId')::uuid)
        on conflict do nothing;
      update public.portmgr_agent_dialogue_rooms set next_seq=next_seq+1,last_activity_at=now()
        where room_id=v_room_id;
      v_result=jsonb_build_object('roomId',v_room_id,'participantId',v_member.participant_id,
        'joined',true,'alreadyIn',false,'seq',v_room.next_seq);
    end if;
    return v_result||jsonb_build_object('members',public.portmgr_agent_dialogue_community_members(v_room_id));
  end if;

  if p_operation='community-leave' then
    select * into v_room from public.portmgr_agent_dialogue_rooms r
      where r.profile_id=p_profile_id and r.kind='community' and r.state='active' for update;
    if not found then return jsonb_build_object('left',true,'roomId',null); end if;
    v_room_id=v_room.room_id;
    select * into v_member from public.portmgr_agent_dialogue_members m
      where m.room_id=v_room_id and m.endpoint_id=v_source.endpoint_id for update;
    if not found or v_member.state<>'joined' then
      return jsonb_build_object('left',true,'roomId',v_room_id,'alreadyOut',true);
    end if;
    update public.portmgr_agent_dialogue_members set state='left',leave_seq=v_room.next_seq
      where participant_id=v_member.participant_id;
    insert into public.portmgr_agent_dialogue_events(room_id,seq,kind,sender_participant_id,request_id)
      values(v_room_id,v_room.next_seq,'left',v_member.participant_id,(p_args->>'requestId')::uuid)
      on conflict do nothing;
    update public.portmgr_agent_dialogue_rooms set next_seq=next_seq+1,last_activity_at=now()
      where room_id=v_room_id;
    return jsonb_build_object('left',true,'roomId',v_room_id,'alreadyOut',false,'seq',v_room.next_seq,
      'members',public.portmgr_agent_dialogue_community_members(v_room_id));
  end if;

  if p_operation='community-status' then
    select * into v_room from public.portmgr_agent_dialogue_rooms r
      where r.profile_id=p_profile_id and r.kind='community' and r.state='active';
    if not found then
      return jsonb_build_object('roomId',null,'inside',false,'participantId',null,'members','[]'::jsonb);
    end if;
    v_room_id=v_room.room_id;
    select * into v_member from public.portmgr_agent_dialogue_members m
      where m.room_id=v_room_id and m.endpoint_id=v_source.endpoint_id;
    return jsonb_build_object('roomId',v_room_id,
      'inside',found and v_member.state='joined',
      'participantId',case when found and v_member.state='joined' then v_member.participant_id end,
      'nextSeq',v_room.next_seq,
      'members',public.portmgr_agent_dialogue_community_members(v_room_id));
  end if;

  if p_operation='peers' then
    select coalesce(jsonb_agg(jsonb_build_object('endpointId',e.endpoint_id,'deviceId',e.device_id,
      'kind',e.kind,'displayName',e.display_name,'memoryId',e.memory_id,
      'lastSeenAt',e.last_seen_at,'contractVersion',e.contract_version)
      order by e.display_name,e.endpoint_id),'[]'::jsonb) into v_result
    -- Every device's targets stay discoverable however many one device publishes. A flat
    -- \u00ABlimit 100\u00BB ordered by last_seen_at let a device with 101 endpoints crowd the others out, and
    -- heartbeat order changed the list between calls (measured 2026-10-04: a remote device's visible
    -- projects fell 38 -> 3). Ranking inside each device and taking that rank first makes the global
    -- cap a round robin: every device's rank 1 lands before any device's rank 2.
    from (select * from (select x.*,row_number() over (partition by x.device_id
        order by case when x.kind='ops' then 0 else 1 end,x.last_seen_at desc,x.endpoint_id) device_rank
      from public.portmgr_agent_dialogue_endpoints x
      where x.profile_id=p_profile_id and x.state='active' and x.endpoint_id<>v_source.endpoint_id) ranked
      order by case when ranked.kind='ops' then 0 else 1 end,ranked.device_rank,
        ranked.last_seen_at desc,ranked.endpoint_id limit 500) e;
    return jsonb_build_object('peers',v_result);
  end if;
  if p_operation='invitations' then
    select coalesce(jsonb_agg(jsonb_build_object('roomId',m.room_id,'participantId',m.participant_id,
      'from',owner.endpoint_id,'fromName',owner.display_name,'fromKind',owner.kind,'expiresAt',r.expires_at)
      order by m.invited_at desc),'[]'::jsonb) into v_result
    from (select * from public.portmgr_agent_dialogue_members
      where endpoint_id=v_source.endpoint_id and state='invited' order by invited_at desc limit 50) m
      join public.portmgr_agent_dialogue_rooms r on r.room_id=m.room_id
      join public.portmgr_agent_dialogue_members om on om.participant_id=r.owner_participant_id
      join public.portmgr_agent_dialogue_endpoints owner on owner.endpoint_id=om.endpoint_id
    where r.profile_id=p_profile_id and r.state='active' and r.expires_at>now()
      and r.last_activity_at>=now()-interval '2 hours';
    return jsonb_build_object('invitations',v_result);
  end if;

  if p_operation not in ('create','invite','join','decline','send','read','leave','close') then
    raise exception 'AGENT_DIALOGUE_OPERATION_INVALID';
  end if;
  if p_operation<>'read' then
    v_request_id=(p_args->>'requestId')::uuid;
    if v_request_id is null then raise exception 'AGENT_DIALOGUE_REQUEST_ID_REQUIRED'; end if;
    v_hash=sha256(convert_to(p_operation||':'||p_args::text,'UTF8'));
    insert into public.portmgr_agent_dialogue_requests(profile_id,endpoint_id,request_id,operation,payload_hash)
      values(p_profile_id,v_source.endpoint_id,v_request_id,p_operation,v_hash)
      on conflict do nothing;
    select * into v_request from public.portmgr_agent_dialogue_requests
      where profile_id=p_profile_id and endpoint_id=v_source.endpoint_id and request_id=v_request_id for update;
    if v_request.operation<>p_operation or v_request.payload_hash<>v_hash then raise exception 'AGENT_DIALOGUE_REQUEST_CONFLICT'; end if;
    if v_request.result is not null then return v_request.result; end if;
  end if;

  if p_operation='create' then
    select array_agg(value::uuid) into v_peers from jsonb_array_elements_text(p_args->'endpointIds') value;
    if cardinality(v_peers) not between 1 and 7 or v_source.endpoint_id=any(v_peers)
      or (select count(distinct value) from unnest(v_peers) value)<>cardinality(v_peers)
      or (select count(*) from public.portmgr_agent_dialogue_endpoints e
        where e.endpoint_id=any(v_peers) and e.profile_id=p_profile_id and e.state='active')<>cardinality(v_peers)
    then raise exception 'AGENT_DIALOGUE_PEERS_INVALID'; end if;
    insert into public.portmgr_agent_dialogue_rooms(profile_id) values(p_profile_id) returning * into v_room;
    insert into public.portmgr_agent_dialogue_members(room_id,endpoint_id,state,joined_at)
      values(v_room.room_id,v_source.endpoint_id,'joined',now()) returning * into v_member;
    update public.portmgr_agent_dialogue_rooms set owner_participant_id=v_member.participant_id,next_seq=2 where room_id=v_room.room_id;
    insert into public.portmgr_agent_dialogue_events(room_id,seq,kind,sender_participant_id,request_id)
      values(v_room.room_id,1,'joined',v_member.participant_id,v_request_id);
    insert into public.portmgr_agent_dialogue_members(room_id,endpoint_id,state)
      select v_room.room_id,value,'invited' from unnest(v_peers) value;
    v_result=jsonb_build_object('roomId',v_room.room_id,'participantId',v_member.participant_id,
      'invited',cardinality(v_peers),'expiresAt',v_room.expires_at);
  else
    v_room_id=(p_args->>'roomId')::uuid;
    select * into v_room from public.portmgr_agent_dialogue_rooms r
      where r.room_id=v_room_id and r.profile_id=p_profile_id for update;
    if not found then raise exception 'AGENT_DIALOGUE_ROOM_NOT_FOUND'; end if;
    if v_room.expires_at<=now() or (p_operation<>'read' and
      (v_room.state<>'active' or v_room.last_activity_at<now()-interval '2 hours'))
      or (p_operation='read' and v_room.state not in ('active','closed'))
    then raise exception 'AGENT_DIALOGUE_ROOM_INACTIVE'; end if;
    select * into v_member from public.portmgr_agent_dialogue_members m
      where m.room_id=v_room_id and m.endpoint_id=v_source.endpoint_id;
    if not found then raise exception 'AGENT_DIALOGUE_NOT_A_MEMBER'; end if;
    if p_operation in ('decline','invite','send','read','leave','close')
      and v_member.participant_id is distinct from (p_args->>'participantId')::uuid
    then raise exception 'AGENT_DIALOGUE_PARTICIPANT_MISMATCH'; end if;
    if p_operation='join' then
      if v_member.state<>'invited' then raise exception 'AGENT_DIALOGUE_INVITE_INACTIVE'; end if;
      update public.portmgr_agent_dialogue_members set state='joined',joined_at=now(),join_after_seq=v_room.next_seq
        where participant_id=v_member.participant_id;
      insert into public.portmgr_agent_dialogue_events(room_id,seq,kind,sender_participant_id,request_id)
        values(v_room_id,v_room.next_seq,'joined',v_member.participant_id,v_request_id);
      update public.portmgr_agent_dialogue_rooms set next_seq=next_seq+1,last_activity_at=now() where room_id=v_room_id;
      v_result=jsonb_build_object('roomId',v_room_id,'participantId',v_member.participant_id,'joined',true,'seq',v_room.next_seq);
    elsif p_operation='decline' then
      if v_member.state<>'invited' then raise exception 'AGENT_DIALOGUE_INVITE_INACTIVE'; end if;
      update public.portmgr_agent_dialogue_members set state='declined',leave_seq=v_room.next_seq
        where participant_id=v_member.participant_id;
      insert into public.portmgr_agent_dialogue_events(room_id,seq,kind,sender_participant_id,request_id)
        values(v_room_id,v_room.next_seq,'declined',v_member.participant_id,v_request_id);
      update public.portmgr_agent_dialogue_rooms set next_seq=next_seq+1,last_activity_at=now() where room_id=v_room_id;
      v_result=jsonb_build_object('roomId',v_room_id,'participantId',v_member.participant_id,'declined',true,'seq',v_room.next_seq);
    elsif p_operation='read' then
      if v_member.state<>'joined' then raise exception 'AGENT_DIALOGUE_MEMBER_INACTIVE'; end if;
      v_after=(p_args->>'afterSeq')::bigint;
      if v_after is null or v_after<0 or v_after>=v_room.next_seq then raise exception 'AGENT_DIALOGUE_CURSOR_INVALID'; end if;
      with scanned as (select * from public.portmgr_agent_dialogue_events e
        where e.room_id=v_room_id and e.seq>greatest(v_after,v_member.join_after_seq)
          and (v_member.leave_seq is null or e.seq<=v_member.leave_seq)
        order by e.seq limit 7)
      select coalesce(max(seq),v_after),coalesce(jsonb_agg(jsonb_build_object('seq',seq,'kind',kind,
        'senderParticipantId',sender_participant_id,'messageKind',message_kind,'text',body,'createdAt',created_at)
        order by seq) filter(where recipient_participant_ids is null
          or v_member.participant_id=any(recipient_participant_ids)
          or sender_participant_id=v_member.participant_id),'[]'::jsonb)
      into v_seq,v_result from scanned;
      update public.portmgr_agent_dialogue_members set ack_seq=greatest(ack_seq,least(v_after,v_room.next_seq-1))
        where participant_id=v_member.participant_id;
      return jsonb_build_object('roomId',v_room_id,'events',v_result,'nextSeq',v_seq,
        'hasMore',exists(select 1 from public.portmgr_agent_dialogue_events
          where room_id=v_room_id and seq>v_seq and seq>v_member.join_after_seq
            and (v_member.leave_seq is null or seq<=v_member.leave_seq)));
    else
      if v_member.state<>'joined' then raise exception 'AGENT_DIALOGUE_MEMBER_INACTIVE'; end if;
      if p_operation='send' then
        if v_room.message_count>=(case when v_room.kind='community' then 20000 else 2000 end)
          or length(coalesce(p_args->>'text',''))=0
          or octet_length(p_args->>'text')>4000 or p_args->>'kind' not in ('question','answer','observation','build-receipt')
        then raise exception 'AGENT_DIALOGUE_MESSAGE_INVALID'; end if;
        if p_args ? 'toParticipantIds' then
          select array_agg(value::uuid) into v_recipients from jsonb_array_elements_text(p_args->'toParticipantIds') value;
          if cardinality(v_recipients) not between 1 and 7
            or (select count(distinct value) from unnest(v_recipients) value)<>cardinality(v_recipients)
            or (select count(*) from public.portmgr_agent_dialogue_members m
              where m.room_id=v_room_id and m.participant_id=any(v_recipients) and m.state='joined')<>cardinality(v_recipients)
          then raise exception 'AGENT_DIALOGUE_RECIPIENT_INVALID'; end if;
        end if;
        insert into public.portmgr_agent_dialogue_events(room_id,seq,kind,sender_participant_id,request_id,message_kind,body,recipient_participant_ids)
          values(v_room_id,v_room.next_seq,'message',v_member.participant_id,v_request_id,p_args->>'kind',p_args->>'text',v_recipients);
        update public.portmgr_agent_dialogue_rooms set next_seq=next_seq+1,message_count=message_count+1,last_activity_at=now() where room_id=v_room_id;
        select count(*) into v_count from public.portmgr_agent_dialogue_members m
          where m.room_id=v_room_id and m.state='joined' and m.participant_id<>v_member.participant_id
            and (v_recipients is null or m.participant_id=any(v_recipients));
        v_result=jsonb_build_object('roomId',v_room_id,'seq',v_room.next_seq,'recipientCount',v_count);
      elsif p_operation='invite' then
        if v_member.participant_id<>v_room.owner_participant_id
          or (select count(*) from public.portmgr_agent_dialogue_members where room_id=v_room_id and state in ('invited','joined'))>=8
        then raise exception 'AGENT_DIALOGUE_INVITE_FORBIDDEN'; end if;
        v_peer_id=(p_args->>'endpointId')::uuid;
        select * into v_peer from public.portmgr_agent_dialogue_endpoints e
          where e.endpoint_id=v_peer_id and e.profile_id=p_profile_id and e.state='active' for share;
        if not found then raise exception 'AGENT_DIALOGUE_PEER_UNAVAILABLE'; end if;
        insert into public.portmgr_agent_dialogue_members(room_id,endpoint_id,state)
          values(v_room_id,v_peer_id,'invited') returning * into v_member;
        v_result=jsonb_build_object('roomId',v_room_id,'participantId',v_member.participant_id,'invited',true);
      elsif p_operation='leave' then
        update public.portmgr_agent_dialogue_members set state='left',leave_seq=v_room.next_seq
          where participant_id=v_member.participant_id;
        insert into public.portmgr_agent_dialogue_events(room_id,seq,kind,sender_participant_id,request_id)
          values(v_room_id,v_room.next_seq,'left',v_member.participant_id,v_request_id);
        update public.portmgr_agent_dialogue_rooms set next_seq=next_seq+1,last_activity_at=now(),
          state=case when owner_participant_id=v_member.participant_id then 'closed' else state end,
          closed_at=case when owner_participant_id=v_member.participant_id then now() else closed_at end
          where room_id=v_room_id;
        v_result=jsonb_build_object('roomId',v_room_id,'left',true,'closed',v_member.participant_id=v_room.owner_participant_id);
      elsif p_operation='close' then
        if v_member.participant_id<>v_room.owner_participant_id then raise exception 'AGENT_DIALOGUE_OWNER_REQUIRED'; end if;
        insert into public.portmgr_agent_dialogue_events(room_id,seq,kind,sender_participant_id,request_id)
          values(v_room_id,v_room.next_seq,'closed',v_member.participant_id,v_request_id);
        update public.portmgr_agent_dialogue_rooms set next_seq=next_seq+1,state='closed',closed_at=now() where room_id=v_room_id;
        v_result=jsonb_build_object('roomId',v_room_id,'closed',true);
      end if;
    end if;
  end if;
  update public.portmgr_agent_dialogue_requests set result=v_result
    where profile_id=p_profile_id and endpoint_id=v_source.endpoint_id and request_id=v_request_id;
  return v_result;
end;
$agent_dialogue$;

revoke all on function public.portmgr_agent_dialogue_call(text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.portmgr_agent_dialogue_call(text,text,text,text,jsonb) to service_role;
