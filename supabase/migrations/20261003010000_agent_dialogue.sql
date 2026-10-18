
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
  contract_version integer not null default 1
);
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

do $agent_dialogue_security$
declare v_name text;
begin
  foreach v_name in array array[
    'portmgr_agent_dialogue_device_keys','portmgr_agent_dialogue_endpoints','portmgr_agent_dialogue_rooms',
    'portmgr_agent_dialogue_members','portmgr_agent_dialogue_events','portmgr_agent_dialogue_requests'
  ] loop
    execute format('alter table public.%I enable row level security',v_name);
    execute format('revoke all on table public.%I from public, anon, authenticated',v_name);
    execute format('grant select, insert, update, delete on table public.%I to service_role',v_name);
  end loop;
end $agent_dialogue_security$;

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
      where profile_id=p_profile_id and state='active'
        and (expires_at<=now() or last_activity_at<now()-interval '2 hours');
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

  select * into v_source from public.portmgr_agent_dialogue_endpoints e
    where e.endpoint_id=(p_args->>'sourceEndpointId')::uuid and e.profile_id=p_profile_id
      and e.device_id=p_device_id and e.state='active' for share;
  if not found then raise exception 'AGENT_DIALOGUE_SOURCE_UNAVAILABLE'; end if;

  if p_operation='heartbeat' then
    update public.portmgr_agent_dialogue_endpoints set last_seen_at=now()
      where endpoint_id=v_source.endpoint_id;
    return jsonb_build_object('seenAt',now());
  end if;

  if p_operation='peers' then
    select coalesce(jsonb_agg(jsonb_build_object('endpointId',e.endpoint_id,'deviceId',e.device_id,
      'kind',e.kind,'displayName',e.display_name,'memoryId',e.memory_id,
      'lastSeenAt',e.last_seen_at,'contractVersion',e.contract_version)
      order by e.display_name,e.endpoint_id),'[]'::jsonb) into v_result
    from (select * from public.portmgr_agent_dialogue_endpoints
      where profile_id=p_profile_id and state='active' and endpoint_id<>v_source.endpoint_id
      order by last_seen_at desc,endpoint_id limit 100) e;
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
        if v_room.message_count>=2000 or length(coalesce(p_args->>'text',''))=0
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
