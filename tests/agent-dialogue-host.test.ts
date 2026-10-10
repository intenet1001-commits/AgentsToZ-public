import {PGlite} from '@electric-sql/pglite';
import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AGENT_DIALOGUE_SQL} from '../src/agentDialogueSql';
import {AgentDialogueHost} from '../src/agentDialogueHost';
import type {AgentDialogueTarget} from '../src/agentDialogueContract';

const temporary:string[]=[];
afterEach(()=>{for(const path of temporary.splice(0))rmSync(path,{recursive:true,force:true});});

test('Mac hosts require local consent and exact per-instance approval before cross-device messages',async()=>{
  const db=new PGlite();
  try{
    await db.exec("create role anon; create role authenticated; create role service_role;create schema auth;create function auth.role() returns text language sql stable as $$ select current_setting('request.jwt.claim.role',true) $$;set request.jwt.claim.role='service_role';");
    await db.exec(AGENT_DIALOGUE_SQL);
    const profileId=randomUUID();
    let refuseRevocation=false;
    const labels=new Map<string,string>();
    const makeHost=(deviceId:string,portId:string)=>{
      const appDataDir=mkdtempSync(join(tmpdir(),'agent-dialogue-host-'));temporary.push(appDataDir);
      return new AgentDialogueHost({appDataDir,
        identity:()=>({profileId,deviceId}),
        secret:async()=>deviceId.padEnd(44,'x'),
        resolveTarget:async(target:AgentDialogueTarget)=>{
          if('target'in target)throw Error('OPS is not this project');
          if(target.portId!==portId)throw Error('wrong project');
          return {kind:'project',portId,displayName:labels.get(deviceId)??`${deviceId} ${portId}`,memoryId:'qq'};
        },
        rpc:async(operation,p,d,secret,args)=>{
          if(operation==='revoke-endpoint'&&refuseRevocation)throw Error('offline');
          const {rows}=await db.query<{value:Record<string,any>}>(
            'select public.portmgr_agent_dialogue_call($1,$2,$3,$4,$5::jsonb) as value',
            [operation,p,d,secret,JSON.stringify(args)]);
          return rows[0]!.value;
        },
      });
    };
    const first=makeHost('mac-one-1','project-a');
    const second=makeHost('mac-two-2','project-b');
    const third=makeHost('mac-three-3','project-c');
    const instance='a'.repeat(64);
    const firstSource={portId:'project-a'},secondSource={portId:'project-b'},thirdSource={portId:'project-c'};
    expect(first.status().enabled).toEqual([]);
    await expect(first.enable(firstSource,false)).rejects.toThrow('동의');
    const [a,b,c]=await Promise.all([
      first.enable(firstSource,true),second.enable(secondSource,true),third.enable(thirdSource,true),
    ]);
    expect(a.endpointId).not.toBe(b.endpointId);
    expect(b.endpointId).not.toBe(c.endpointId);
    const peers=await first.perform(instance,{operation:'peers',source:firstSource});
    expect((peers.peers as any[]).map(peer=>peer.endpointId)).toContain(b.endpointId);
    labels.set('mac-one-1','아젠투지 1호 / project-a');
    expect((await first.refreshDisplayNames()).updated).toBe(1);
    expect(first.status().enabled[0]?.endpointId).toBe(a.endpointId);
    expect(((await second.perform(instance,{operation:'peers',source:secondSource})).peers as any[])
      .find(peer=>peer.endpointId===a.endpointId)?.displayName).toBe('아젠투지 1호 / project-a');
    const create={operation:'create',source:firstSource,endpointIds:[b.endpointId],requestId:randomUUID()};
    const pending=await first.perform(instance,create);
    expect(pending.approvalRequired).toBe(true);
    expect((await db.query<{count:number}>('select count(*)::int count from public.portmgr_agent_dialogue_rooms')).rows[0]!.count).toBe(0);
    await first.approve(String(pending.pendingId),true);
    const room=await first.perform(instance,create);
    const invitations=await second.perform(instance,{operation:'invitations',source:secondSource});
    expect((invitations.invitations as any[])[0].roomId).toBe(room.roomId);
    const joinRequest={operation:'join',source:secondSource,roomId:room.roomId,requestId:randomUUID()};
    const joinPending=await second.perform(instance,joinRequest);
    await second.approve(String(joinPending.pendingId),true);
    const joined=await second.perform(instance,joinRequest);
    const sent=await first.perform(instance,{operation:'send',source:firstSource,roomId:room.roomId,
      participantId:room.participantId,requestId:randomUUID(),kind:'question',text:'한영 변환 빌드 상태?'});
    expect(sent.recipientCount).toBe(1);
    const read=await second.perform(instance,{operation:'wait',source:secondSource,roomId:room.roomId,
      participantId:joined.participantId,afterSeq:0,timeoutMs:10});
    expect((read.events as any[]).map(event=>event.text)).toContain('한영 변환 빌드 상태?');
    const invite={operation:'invite',source:firstSource,roomId:room.roomId,participantId:room.participantId,
      endpointId:c.endpointId,requestId:randomUUID()};
    const invitePending=await first.perform(instance,invite);
    expect(invitePending.approvalRequired).toBe(true);
    await first.approve(String(invitePending.pendingId),true);
    await first.perform(instance,invite);
    const thirdJoin={operation:'join',source:thirdSource,roomId:room.roomId,requestId:randomUUID()};
    const thirdJoinPending=await third.perform(instance,thirdJoin);
    expect((await third.approve(String(thirdJoinPending.pendingId),false)).declined).toBe(true);
    expect((await third.perform(instance,{operation:'invitations',source:thirdSource}).then(value=>value.invitations as any[]))).toEqual([]);
    const outsiderWait={operation:'wait',source:thirdSource,roomId:room.roomId,
      participantId:randomUUID(),afterSeq:0,timeoutMs:0};
    const outsiderPending=await third.perform(instance,outsiderWait);
    await third.approve(String(outsiderPending.pendingId),true);
    await expect(third.perform(instance,outsiderWait)).rejects.toThrow();
    await expect(first.perform(instance,{operation:'send',source:{target:'ops'},roomId:room.roomId,
      participantId:room.participantId,requestId:randomUUID(),kind:'question',text:'wrong source'})).rejects.toThrow();
    refuseRevocation=true;
    expect((await first.disable(firstSource)).remoteRevocationPending).toBe(true);
    expect(first.status().remoteRevocationPending).toBe(1);
    await expect(first.perform(instance,{operation:'peers',source:firstSource})).rejects.toThrow('먼저 켜세요');
    refuseRevocation=false;
    await first.maintenance();
    expect(first.status().remoteRevocationPending).toBe(0);
    expect((await second.perform(instance,{operation:'peers',source:secondSource}).then(value=>value.peers as any[]))
      .some(peer=>peer.endpointId===a.endpointId)).toBe(false);
  }finally{await db.close();}
});

test('profile changes keep old endpoints in a durable remote revocation queue',async()=>{
  const appDataDir=mkdtempSync(join(tmpdir(),'agent-dialogue-switch-'));temporary.push(appDataDir);
  const oldProfile=randomUUID(),newProfile=randomUUID();
  let deviceId='mac-one-1';
  let profileId=oldProfile,offline=true;
  const calls:{operation:string;profileId:string;deviceId:string;endpointId?:string}[]=[];
  const makeHost=()=>new AgentDialogueHost({appDataDir,
    identity:()=>({profileId,deviceId}),secret:async()=> 's'.repeat(44),
    resolveTarget:async()=>({kind:'ops',displayName:'1호 총괄'}),
    rpc:async(operation,p,d,_secret,args)=>{
      calls.push({operation,profileId:p,deviceId:d,endpointId:args.endpointId as string|undefined});
      if(operation==='register-endpoint')return {endpointId:randomUUID(),kind:'ops'};
      if(operation==='revoke-endpoint'&&offline)throw new Error('offline');
      return {ok:true};
    },
  });
  const host=makeHost();
  const old=await host.enable({target:'ops'},true);
  profileId=newProfile;
  expect(host.status().enabled).toEqual([]);
  expect(host.status().remoteRevocationPending).toBe(1);
  await expect(host.perform('a'.repeat(64),{operation:'peers',source:{target:'ops'}})).rejects.toThrow('먼저 켜세요');
  const current=await host.enable({target:'ops'},true);
  await expect(host.maintenance()).rejects.toThrow('offline');
  expect(calls.some(call=>call.operation==='heartbeat'&&call.profileId===newProfile)).toBe(true);
  const restarted=makeHost();
  expect(restarted.status().remoteRevocationPending).toBe(1);
  expect(restarted.status().enabled[0]?.endpointId).toBe(current.endpointId);
  offline=false;
  await restarted.maintenance();
  expect(restarted.status().remoteRevocationPending).toBe(0);
  expect(calls.some(call=>call.operation==='revoke-endpoint'&&call.profileId===oldProfile
    &&call.deviceId==='mac-one-1'&&call.endpointId===old.endpointId)).toBe(true);
  expect(calls.some(call=>call.operation==='heartbeat'&&call.profileId===oldProfile)).toBe(false);
  deviceId='mac-one-2';
  expect(restarted.status().enabled).toEqual([]);
  expect(restarted.status().remoteRevocationPending).toBe(1);
  await restarted.maintenance();
  expect(calls.some(call=>call.operation==='revoke-endpoint'&&call.profileId===newProfile
    &&call.deviceId==='mac-one-1'&&call.endpointId===current.endpointId)).toBe(true);
});

test('approval requests name the asking connection, and a used room grant stays open until it idles or hits 24h',async()=>{
  const appDataDir=mkdtempSync(join(tmpdir(),'agent-dialogue-grant-'));temporary.push(appDataDir);
  let now=Date.parse('2026-10-04T01:00:00Z');
  const roomId=randomUUID(),participantId=randomUUID();
  const remote:string[]=[];
  const host=new AgentDialogueHost({appDataDir,now:()=>now,
    identity:()=>({profileId:'profile-1',deviceId:'mac-three'}),secret:async()=>'s'.repeat(44),
    resolveTarget:async()=>({kind:'ops',displayName:'아젠투지 3호 / 총괄'}),
    rpc:async(operation,_p,_d,_secret,args)=>{
      remote.push(operation);
      if(operation==='register-endpoint')return {endpointId:'ep-3'};
      if(operation==='invitations')return {invitations:[{roomId,participantId,fromName:'아젠투지 1호 / 총괄'}]};
      if(operation==='join')return {roomId,participantId,joined:true,seq:3};
      if(operation==='read')return {events:[],nextSeq:args.afterSeq,hasMore:false};
      if(operation==='send')return {roomId,seq:4,recipientCount:1};
      return {ok:true};
    },
  });
  const source={target:'ops' as const};
  await host.enable(source,true);
  const claude='c'.repeat(64),codex='d'.repeat(64);
  const joinRoom=(requestId:string)=>({operation:'join',source,roomId,requestId});
  const claudeJoin=joinRoom(randomUUID());
  const first=await host.perform(claude,claudeJoin,{client:'claude-code‮\u0007 '});
  now+=1_000;
  await host.perform(codex,joinRoom(randomUUID()),{client:'codex-mcp-client'});
  const pending=host.status().pending;
  expect(pending.map(item=>item.client)).toEqual(['codex-mcp-client','claude-code']);
  expect(pending[0]!.connection).toMatch(/^[0-9a-f]{6}$/);
  expect(pending[0]!.connection).not.toBe(pending[1]!.connection);
  // The tag must not reveal the private instance id the host authorizes on.
  expect(claude.startsWith(pending[1]!.connection)).toBe(false);
  expect(pending[1]!.requestedAt).toBe(new Date(now-1_000).toISOString());
  expect(pending[0]!.summary).toBe(pending[1]!.summary);
  const callsBefore=remote.length;host.status();expect(remote.length).toBe(callsBefore);

  await host.approve(String(first.pendingId),true);
  expect(host.status().pending.map(item=>item.client)).toEqual(['codex-mcp-client']);
  expect((await host.perform(claude,claudeJoin)).joined).toBe(true);

  const wait={operation:'wait',source,roomId,participantId,afterSeq:3,timeoutMs:0};
  for(const step of [25,25,25]){
    now+=step*60_000;
    expect((await host.perform(claude,wait)).approvalRequired).toBeUndefined();
  }
  // The grant belongs to this connection only.
  expect((await host.perform(codex,wait)).approvalRequired).toBe(true);
  now+=31*60_000;
  const idle=await host.perform(claude,wait);
  expect(idle.approvalRequired).toBe(true);
  await host.approve(String(idle.pendingId),true);
  expect((await host.perform(claude,wait)).approvalRequired).toBeUndefined();
  // Re-approving one read reopened the room: the next message needs no new approval.
  expect((await host.perform(claude,{operation:'send',source,roomId,participantId,requestId:randomUUID(),
    kind:'answer',text:'pong'})).recipientCount).toBe(1);
  for(let minutes=20;minutes<24*60;minutes+=20){
    now+=20*60_000;
    expect((await host.perform(claude,wait)).approvalRequired).toBeUndefined();
  }
  now+=20*60_000;
  expect((await host.perform(claude,wait)).approvalRequired).toBe(true);
});

test('maintenance retires only endpoints whose project registration is gone, never on doubt, and keeps other rooms',async()=>{
  const appDataDir=mkdtempSync(join(tmpdir(),'agent-dialogue-retire-'));temporary.push(appDataDir);
  let registered:ReadonlySet<string>=new Set(['project-a','project-b']),registryFails=false;
  let opsLabel='3호 / 총괄';
  const reachable=new Set(['project-a','project-b']);
  const roomId=randomUUID(),participantId=randomUUID();
  const calls:{operation:string;args:Record<string,unknown>}[]=[];
  const host=new AgentDialogueHost({appDataDir,
    identity:()=>({profileId:'profile-1',deviceId:'mac-three'}),secret:async()=>'s'.repeat(44),
    registeredProjectIds:async()=>{if(registryFails)throw Error('ports.json unreadable');return registered;},
    resolveTarget:async target=>{
      if('target'in target)return {kind:'ops',displayName:opsLabel};
      if(!reachable.has(target.portId))throw Error('folder unreachable');
      return {kind:'project',portId:target.portId,displayName:`3호 / ${target.portId}`};
    },
    rpc:async(operation,_p,_d,_secret,args)=>{
      calls.push({operation,args});
      if(operation==='register-endpoint')return {endpointId:`ep-${String(args.portId??'ops')}`};
      if(operation==='invitations')return {invitations:[{roomId,participantId,fromName:'1호 / 아젠투지(OPS)'}]};
      if(operation==='join')return {roomId,participantId,joined:true};
      if(operation==='read')return {events:[],nextSeq:args.afterSeq,hasMore:false};
      return {ok:true};
    },
  });
  // Project A first, so a failure there would have stopped the OPS rename behind it.
  await host.enable({portId:'project-a'},true);
  await host.enable({portId:'project-b'},true);
  await host.enable({target:'ops'},true);
  const instance='e'.repeat(64),ops={target:'ops' as const};
  const joinRequest={operation:'join',source:ops,roomId,requestId:randomUUID()};
  await host.approve(String((await host.perform(instance,joinRequest)).pendingId),true);
  await host.perform(instance,joinRequest);
  const wait={operation:'wait',source:ops,roomId,participantId,afterSeq:0,timeoutMs:0};
  const revoked=()=>calls.filter(call=>call.operation==='revoke-endpoint').map(call=>call.args.endpointId);

  registered=new Set(['project-a']);registryFails=true;
  await expect(host.maintenance()).rejects.toThrow('unreadable');
  expect(host.status().enabled.map(item=>item.endpointId).sort()).toEqual(['ep-ops','ep-project-a','ep-project-b']);
  expect(revoked()).toEqual([]);

  registryFails=false;reachable.delete('project-a');opsLabel='3호 / 아젠투지(OPS)';
  await expect(host.maintenance()).rejects.toThrow('unreachable');
  // B was deleted: retired here and revoked remotely. A is only unreachable: kept.
  expect(host.status().enabled.map(item=>item.endpointId).sort()).toEqual(['ep-ops','ep-project-a']);
  expect(revoked()).toEqual(['ep-project-b']);
  expect(host.status().remoteRevocationPending).toBe(0);
  // A's failure did not stop the OPS rename that comes after it.
  expect(host.status().enabled.find(item=>item.kind==='ops')?.displayName).toBe('3호 / 아젠투지(OPS)');
  // The OPS room grant survived the retirement.
  expect((await host.perform(instance,wait)).approvalRequired).toBeUndefined();
  await expect(host.perform(instance,{operation:'peers',source:{portId:'project-b'}})).rejects.toThrow('먼저 켜세요');
});

test('a 30-day pairing is accepted once per couple, then rooms open and auto-join without a person',async()=>{
  const db=new PGlite();
  try{
    await db.exec("create role anon; create role authenticated; create role service_role;create schema auth;create function auth.role() returns text language sql stable as $$ select current_setting('request.jwt.claim.role',true) $$;set request.jwt.claim.role='service_role';");
    await db.exec(AGENT_DIALOGUE_SQL);
    const profileId=randomUUID();
    const instance='a'.repeat(64);
    const ops:AgentDialogueTarget={target:'ops'};
    const makeHost=(deviceId:string)=>{
      const appDataDir=mkdtempSync(join(tmpdir(),'agent-dialogue-pair-'));temporary.push(appDataDir);
      return new AgentDialogueHost({appDataDir,
        identity:()=>({profileId,deviceId}),
        secret:async()=>deviceId.padEnd(44,'x'),
        resolveTarget:async(target:AgentDialogueTarget)=>{
          if(!('target'in target))throw Error('only OPS here');
          return {kind:'ops',displayName:`${deviceId} 총괄`};
        },
        rpc:async(operation,p,d,secret,args)=>{
          const {rows}=await db.query<{value:Record<string,any>}>(
            'select public.portmgr_agent_dialogue_call($1,$2,$3,$4,$5::jsonb) as value',
            [operation,p,d,secret,JSON.stringify(args)]);
          return rows[0]!.value;
        },
      });
    };
    const one=makeHost('mac-one-1'),two=makeHost('mac-two-2'),three=makeHost('mac-three-3');
    const ids=new Map<AgentDialogueHost,string>();
    for(const host of [one,two,three])ids.set(host,(await host.enable(ops,true)).endpointId);
    // Accepting a pairing always asks the app: that approval IS the 30-day consent.
    const pair=async(from:AgentDialogueHost,to:AgentDialogueHost)=>{
      const request={operation:'pair' as const,source:ops,peerEndpointId:ids.get(to)!,requestId:randomUUID()};
      const asked=await from.perform(instance,request);
      expect(asked.approvalRequired).toBe(true);
      await from.approve(String(asked.pendingId),true);
      return from.perform(instance,request);
    };
    expect(await pair(one,three)).toMatchObject({state:'waiting-peer',acceptedByPeer:false});
    expect(await pair(three,one)).toMatchObject({state:'active',acceptedByPeer:true});
    const listed=await one.perform(instance,{operation:'pairings',source:ops});
    expect((listed.pairings as any[]).map(row=>row.state)).toEqual(['active']);
    // With the pairing in place the room opens with no approval at all.
    const room=await one.perform(instance,{operation:'create',source:ops,
      endpointIds:[ids.get(three)!],requestId:randomUUID()});
    expect(room.approvalRequired).toBeUndefined();
    expect(typeof room.roomId).toBe('string');
    // 3호 joins by itself — the exact step that left the live test silent on 2026-10-04. The fast
    // tick does it with two device-wide reads, so a Mac with a hundred endpoints still pays two.
    expect(await three.autoJoinPairedInvitations()).toEqual({joined:1});
    expect(await three.autoJoinPairedInvitations()).toEqual({joined:0});
    const sent=await one.perform(instance,{operation:'send',source:ops,roomId:String(room.roomId),
      participantId:String(room.participantId),requestId:randomUUID(),kind:'question',text:'통신 테스트'});
    expect(sent.recipientCount).toBe(1);
    // An unpaired device is never auto-joined, and its own room still needs approval.
    const unpairedRequest={operation:'create' as const,source:ops,endpointIds:[ids.get(two)!],requestId:randomUUID()};
    const asked=await one.perform(instance,unpairedRequest);
    expect(asked.approvalRequired).toBe(true);
    await one.approve(String(asked.pendingId),true);
    const unpairedRoom=await one.perform(instance,unpairedRequest);
    expect(await two.autoJoinPairedInvitations()).toEqual({joined:0});
    await two.maintenance();
    const toUnpaired=await one.perform(instance,{operation:'send',source:ops,roomId:String(unpairedRoom.roomId),
      participantId:String(unpairedRoom.participantId),requestId:randomUUID(),kind:'question',text:'아직 아님'});
    expect(toUnpaired.recipientCount).toBe(0);
  }finally{await db.close();}
});

test('devices that entered the community talk in it without any further approval',async()=>{
  const db=new PGlite();
  try{
    await db.exec("create role anon; create role authenticated; create role service_role;create schema auth;create function auth.role() returns text language sql stable as $$ select current_setting('request.jwt.claim.role',true) $$;set request.jwt.claim.role='service_role';");
    await db.exec(AGENT_DIALOGUE_SQL);
    const profileId=randomUUID();
    const instance='b'.repeat(64);
    const ops:AgentDialogueTarget={target:'ops'};
    const makeHost=(deviceId:string)=>{
      const appDataDir=mkdtempSync(join(tmpdir(),'agent-dialogue-community-'));temporary.push(appDataDir);
      return new AgentDialogueHost({appDataDir,
        identity:()=>({profileId,deviceId}),
        secret:async()=>deviceId.padEnd(44,'x'),
        resolveTarget:async(target:AgentDialogueTarget)=>{
          if(!('target'in target))throw Error('only OPS here');
          return {kind:'ops',displayName:`${deviceId} 총괄`};
        },
        rpc:async(operation,p,d,secret,args)=>{
          const {rows}=await db.query<{value:Record<string,any>}>(
            'select public.portmgr_agent_dialogue_call($1,$2,$3,$4,$5::jsonb) as value',
            [operation,p,d,secret,JSON.stringify(args)]);
          return rows[0]!.value;
        },
      });
    };
    const one=makeHost('mac-one-1'),two=makeHost('mac-two-2');
    for(const host of [one,two])await host.enable(ops,true);
    // Nobody is in the community yet, and the app says so without asking for anything.
    expect(await one.uiCommunity(ops,'status')).toMatchObject({roomId:null,inside:false});
    // Entering from the app is the consent — the button is the approval.
    const entered=await one.uiCommunity(ops,'join');
    const joinedTwo=await two.uiCommunity(ops,'join');
    expect(joinedTwo.roomId).toBe(entered.roomId);
    expect((joinedTwo.members as any[])).toHaveLength(2);
    // An AI inside the community sends with no pending approval at all.
    const sent=await one.perform(instance,{operation:'send',source:ops,roomId:String(entered.roomId),
      participantId:String(entered.participantId),requestId:randomUUID(),kind:'question',text:'단체방 테스트'});
    expect(sent.approvalRequired).toBeUndefined();
    expect(sent.recipientCount).toBe(1);
    const inbox=await two.perform(instance,{operation:'wait',source:ops,roomId:String(entered.roomId),
      participantId:String(joinedTwo.participantId),afterSeq:0});
    expect((inbox.events as any[]).map(event=>event.text)).toContain('단체방 테스트');
    // ⚠️ An AI may not enter or end the community on its own: both go through the app.
    const askedJoin=await two.perform(instance,{operation:'community-join',source:ops,requestId:randomUUID()});
    expect(askedJoin.approvalRequired).toBe(true);
    // ⚠️ A legitimate community send leaves a room grant on this connection, so `close` must be
    // refused outright rather than approval-gated — otherwise that grant would carry it through and
    // one AI could evict every device.
    for(const operation of ['close','leave'] as const)
      await expect(one.perform(instance,{operation,source:ops,roomId:String(entered.roomId),
        participantId:String(entered.participantId),requestId:randomUUID()}))
        .rejects.toThrow('아젠투지 설정에서만');
    // Leaving from the app stops delivery to that device.
    await two.uiCommunity(ops,'leave');
    const afterLeave=await one.perform(instance,{operation:'send',source:ops,roomId:String(entered.roomId),
      participantId:String(entered.participantId),requestId:randomUUID(),kind:'observation',text:'떠난 뒤'});
    expect(afterLeave.recipientCount).toBe(0);
  }finally{await db.close();}
});

test('a Mac in the community drives another member Mac and nothing outside it',async()=>{
  const db=new PGlite();
  try{
    await db.exec("create role anon; create role authenticated; create role service_role;create schema auth;create function auth.role() returns text language sql stable as $$ select current_setting('request.jwt.claim.role',true) $$;set request.jwt.claim.role='service_role';");
    await db.exec(AGENT_DIALOGUE_SQL);
    const profileId=randomUUID();
    const ops:AgentDialogueTarget={target:'ops'};
    const rpcCalls:string[]=[];
    const makeHost=(deviceId:string)=>{
      const appDataDir=mkdtempSync(join(tmpdir(),'agent-dialogue-control-'));temporary.push(appDataDir);
      return new AgentDialogueHost({appDataDir,identity:()=>({profileId,deviceId}),secret:async()=>deviceId.padEnd(44,'x'),
        resolveTarget:async()=>({kind:'ops',displayName:`${deviceId} / 아젠투지(OPS)`}),
        rpc:async(operation,p,d,secret,args)=>{
          rpcCalls.push(`${d}:${operation}`);
          const {rows}=await db.query<{value:Record<string,any>}>(
            'select public.portmgr_agent_dialogue_call($1,$2,$3,$4,$5::jsonb) as value',[operation,p,d,secret,JSON.stringify(args)]);
          return rows[0]!.value;
        }});
    };
    const rpcCount=(deviceId:string,operation:string)=>rpcCalls.filter(call=>call===`${deviceId}:${operation}`).length;
    const one=makeHost('mac-one-1'),three=makeHost('mac-three-3'),outsider=makeHost('mac-four-4');
    for(const host of [one,three,outsider])await host.enable(ops,true);
    // Outside the community there is nothing to drive and nothing to take.
    expect(await one.controlDevices()).toEqual({inside:false,deviceId:'mac-one-1',devices:[],unread:0,lastMessageAt:null});
    expect(await three.controlPoll(async()=>({}))).toEqual({handled:0});
    await one.uiCommunity(ops,'join');await three.uiCommunity(ops,'join');
    const listed=await one.controlDevices();
    expect(listed.inside).toBe(true);
    // 읽지 않음은 이 호출이 이미 부르는 community-status에서 덤으로 온다 — 맥 대화창이 접혀 있을 때
    // 따로 두드리지 않기 위한 것이므로, 키가 사라지면 그 화면이 조용히 0으로 보인다.
    expect(listed.unread).toBe(0);
    expect(Object.keys(listed).sort()).toEqual(['deviceId','devices','inside','lastMessageAt','unread']);
    // 15초마다·팝아웃 창마다 불리는 경로다. 멤버십 캐시를 건너뛰면 같은 인자로 두 번 부르고,
    // 입장하지 않은 Mac은 공개 엔드포인트 전부를 매번 순회한다(2026-10-05 감사).
    const before=rpcCount('mac-one-1','community-status');
    await one.controlDevices();
    // At most one: a call within 5s of the last shares its answer (several windows ask together).
    expect(rpcCount('mac-one-1','community-status')-before).toBeLessThanOrEqual(1);
    expect(listed.devices).toMatchObject([{deviceId:'mac-three-3',displayName:'mac-three-3 / 아젠투지(OPS)',kind:'ops'}]);
    const target=listed.devices[0]!.endpointId;
    // 3호's sidecar polls while 1호 waits for the answer, as the two real Macs do.
    const seen:Record<string,unknown>[]=[];let polling=true;
    const poller=(async()=>{while(polling){
      await three.controlPoll(async(request,from)=>{
        seen.push({...request,from:from.deviceId});
        if(request.kind==='fail')throw new Error('실행 실패');
        return {echo:request.kind};
      });
      await new Promise(resolve=>setTimeout(resolve,20));
    }})();
    try{
      expect(await one.controlCall(target,{kind:'projects'},5_000)).toEqual({ok:true,body:{echo:'projects'}});
      expect(await one.controlCall(target,{kind:'fail'},5_000)).toEqual({ok:false,error:'실행 실패'});
      expect(seen).toEqual([{kind:'projects',from:'mac-one-1'},{kind:'fail',from:'mac-one-1'}]);
      // A device outside the community cannot be addressed, even with its exact endpoint id.
      const outsiderEndpoint=outsider.status().enabled[0]!.endpointId;
      await expect(one.controlCall(outsiderEndpoint,{kind:'projects'},2_000)).rejects.toThrow('AGENT_DIALOGUE_CONTROL_TARGET_UNAVAILABLE');
      // And the outsider cannot drive anyone.
      await expect(outsider.controlCall(target,{kind:'projects'},2_000)).rejects.toThrow('커뮤니티에 입장해야');
    }finally{polling=false;await poller;}
    // Nobody polling on 3호: the caller gives up and says the outcome is unknown.
    await expect(one.controlCall(target,{kind:'projects'},400)).rejects.toThrow('요청이 실행됐는지는 알 수 없습니다');
    // Leaving the community ends control at once.
    await three.uiCommunity(ops,'leave');
    await expect(one.controlCall(target,{kind:'projects'},2_000)).rejects.toThrow('AGENT_DIALOGUE_CONTROL_TARGET_UNAVAILABLE');
    expect((await one.controlDevices()).devices).toEqual([]);
  }finally{await db.close();}
});

test('50 outside endpoints probe in a bounded pool; a UI join becomes the preferred endpoint immediately',async()=>{
  const appDataDir=mkdtempSync(join(tmpdir(),'agent-dialogue-many-endpoints-'));temporary.push(appDataDir);
  const profileId=randomUUID(),inside=new Set<string>(),roomId=randomUUID();
  let now=0,statusCalls=0,active=0,maxActive=0,controlSends=0;
  const host=new AgentDialogueHost({appDataDir,now:()=>now,
    identity:()=>({profileId,deviceId:'mac-many'}),secret:async()=>('x'.repeat(44)),
    resolveTarget:async(target:AgentDialogueTarget)=>'target'in target
      ?{kind:'ops',displayName:'총괄'}
      :{kind:'project',portId:target.portId,displayName:target.portId},
    rpc:async(operation,_profile,_device,_secret,args)=>{
      if(operation==='register-endpoint')return {endpointId:String(args.portId??'ops')};
      if(operation==='community-join'){inside.add(String(args.sourceEndpointId));return {joined:true,roomId};}
      if(operation==='community-leave'){inside.delete(String(args.sourceEndpointId));return {left:true,roomId};}
      if(operation==='community-status'){
        statusCalls++;active++;maxActive=Math.max(maxActive,active);
        await new Promise(resolve=>setTimeout(resolve,2));
        active--;
        return {inside:inside.has(String(args.sourceEndpointId)),roomId,members:[],unread:0,lastMessageAt:null};
      }
      if(operation==='control-send')controlSends++;
      return {};
    }});
  await host.enable({target:'ops'},true);
  for(let i=1;i<50;i++)await host.enable({portId:`project-${i}`},true);
  expect((await host.controlDevices()).inside).toBe(false);
  expect(statusCalls).toBe(50);
  expect(maxActive).toBeGreaterThan(1);
  expect(maxActive).toBeLessThanOrEqual(6);
  await host.controlDevices();
  expect(statusCalls).toBe(50);

  await host.uiCommunity({portId:'project-49'},'join');
  const beforeJoin=statusCalls;
  expect((await host.controlDevices()).inside).toBe(true);
  expect(statusCalls-beforeJoin).toBeLessThanOrEqual(2);
  now+=61_000;
  const beforeExpiry=statusCalls;
  expect((await host.controlDevices()).inside).toBe(true);
  expect(statusCalls-beforeExpiry).toBeLessThanOrEqual(3);

  await host.uiCommunity({portId:'project-49'},'leave');
  expect((await host.controlDevices()).inside).toBe(false);
  await expect(host.controlCall(randomUUID(),{kind:'projects'})).rejects.toThrow('커뮤니티에 입장해야');
  expect(controlSends).toBe(0);
});

test('simultaneous control poll and device list share an endpoint membership probe',async()=>{
  const appDataDir=mkdtempSync(join(tmpdir(),'agent-dialogue-membership-flight-'));temporary.push(appDataDir);
  let statusCalls=0,inside=false;
  let releaseStatus!:()=>void;
  const statusGate=new Promise<void>(resolve=>{releaseStatus=resolve;});
  const host=new AgentDialogueHost({appDataDir,
    identity:()=>({profileId:'profile-one',deviceId:'device-one'}),secret:async()=>('x'.repeat(44)),
    resolveTarget:async()=>({kind:'ops',displayName:'총괄'}),
    rpc:async(operation)=>{
      if(operation==='register-endpoint')return {endpointId:'endpoint-one'};
      if(operation==='community-status'){
        statusCalls++;
        await statusGate;
        return {inside,roomId:inside?'room-one':null};
      }
      return {};
    }});
  await host.enable({target:'ops'},true);
  const poll=host.controlPoll(async()=>({}));
  const devices=host.controlDevices();
  await new Promise(resolve=>setTimeout(resolve,0));
  const concurrentCalls=statusCalls;
  releaseStatus();
  expect(await poll).toEqual({handled:0});
  expect((await devices).inside).toBe(false);
  expect(concurrentCalls).toBe(1);
  inside=true;
  expect(await host.uiCommunity({target:'ops'},'status')).toMatchObject({inside:true,roomId:'room-one'});
  expect(statusCalls).toBe(2); // explicit UI status still reads the server, even during membership TTL
});

test('a pending membership probe cannot authorize control after leaving the community',async()=>{
  const appDataDir=mkdtempSync(join(tmpdir(),'agent-dialogue-membership-leave-'));temporary.push(appDataDir);
  let inside=true,statusCalls=0,inboxCalls=0;
  let releaseStatus!:()=>void;
  const statusGate=new Promise<void>(resolve=>{releaseStatus=resolve;});
  const host=new AgentDialogueHost({appDataDir,
    identity:()=>({profileId:'profile-one',deviceId:'device-one'}),secret:async()=>('x'.repeat(44)),
    resolveTarget:async()=>({kind:'ops',displayName:'총괄'}),
    rpc:async(operation)=>{
      if(operation==='register-endpoint')return {endpointId:'endpoint-one'};
      if(operation==='community-status'){
        statusCalls++;
        const answer={inside,roomId:inside?'room-one':null};
        if(statusCalls===1)await statusGate;
        return answer;
      }
      if(operation==='community-leave'){inside=false;return {left:true};}
      if(operation==='control-inbox')inboxCalls++;
      return {};
    }});
  await host.enable({target:'ops'},true);
  const pendingPoll=host.controlPoll(async()=>({}));
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(statusCalls).toBe(1);
  await host.uiCommunity({target:'ops'},'leave');
  releaseStatus();
  expect(await pendingPoll).toEqual({handled:0});
  expect(inboxCalls).toBe(0);
  expect((await host.controlDevices()).inside).toBe(false);
  expect(statusCalls).toBe(2);
});

test('a pending membership probe cannot fill a different profile cache',async()=>{
  const appDataDir=mkdtempSync(join(tmpdir(),'agent-dialogue-membership-profile-'));temporary.push(appDataDir);
  let profileId='profile-one',now=0,newProfileStatusCalls=0;
  let releaseOldStatus!:()=>void;
  const oldStatusGate=new Promise<void>(resolve=>{releaseOldStatus=resolve;});
  const host=new AgentDialogueHost({appDataDir,now:()=>now,
    identity:()=>({profileId,deviceId:'device-one'}),secret:async()=>('x'.repeat(44)),
    resolveTarget:async()=>({kind:'ops',displayName:'총괄'}),
    rpc:async(operation,profile)=>{
      if(operation==='register-endpoint')return {endpointId:'endpoint-one'};
      if(operation==='community-status'){
        if(profile==='profile-one'){
          await oldStatusGate;
          return {inside:true,roomId:'room-one'};
        }
        newProfileStatusCalls++;
        return {inside:false,roomId:null};
      }
      return {};
    }});
  await host.enable({target:'ops'},true);
  const oldPoll=host.controlPoll(async()=>({}));
  await new Promise(resolve=>setTimeout(resolve,0));
  profileId='profile-two';
  host.status();
  await host.enable({target:'ops'},true);
  expect((await host.controlDevices()).inside).toBe(false);
  releaseOldStatus();
  expect(await oldPoll).toEqual({handled:0});
  now+=6_000; // the device-list promise expires; the membership cache is still live
  expect((await host.controlDevices()).inside).toBe(false);
  expect(newProfileStatusCalls).toBe(1);
});

test('fresh membership batch preserves every endpoint response while bypassing warm TTL entries',async()=>{
  const appDataDir=mkdtempSync(join(tmpdir(),'agent-dialogue-membership-fresh-'));temporary.push(appDataDir);
  let joined=false,statusCalls=0;
  const host=new AgentDialogueHost({appDataDir,
    identity:()=>({profileId:'profile-one',deviceId:'device-one'}),secret:async()=>('x'.repeat(44)),
    resolveTarget:async(target:AgentDialogueTarget)=>'target'in target
      ?{kind:'ops',displayName:'총괄'}
      :{kind:'project',portId:target.portId,displayName:target.portId},
    rpc:async(operation,_profile,_device,_secret,args)=>{
      if(operation==='register-endpoint')return {endpointId:String(args.portId??'ops')};
      if(operation==='community-status'){
        statusCalls++;
        await Promise.resolve(); // let the six fresh probes overlap
        const inside=joined&&args.sourceEndpointId==='project-0';
        return {inside,roomId:inside?'room-one':null};
      }
      return {};
    }});
  await host.enable({target:'ops'},true);
  for(let index=0;index<6;index++)await host.enable({portId:`project-${index}`},true);
  expect((await host.controlDevices()).inside).toBe(false);
  expect(statusCalls).toBe(7);
  joined=true;
  // The helper is private because callers normally use its cached form. Exercise its fresh
  // contract directly: a future caller must not lose earlier responses in a parallel batch.
  const fresh=await (host as unknown as {communityEndpoint:(fresh:boolean)=>Promise<{
    endpoint:{portId?:string};roomId:string}|null>}).communityEndpoint(true);
  expect(fresh?.endpoint.portId).toBe('project-0');
  expect(fresh?.roomId).toBe('room-one');
  expect(statusCalls).toBe(14);
});

test('overlapping fresh checks of one endpoint share the fresh server response',async()=>{
  const appDataDir=mkdtempSync(join(tmpdir(),'agent-dialogue-membership-fresh-flight-'));temporary.push(appDataDir);
  let statusCalls=0;
  let releaseStatus!:()=>void;
  const statusGate=new Promise<void>(resolve=>{releaseStatus=resolve;});
  const host=new AgentDialogueHost({appDataDir,
    identity:()=>({profileId:'profile-one',deviceId:'device-one'}),secret:async()=>('x'.repeat(44)),
    resolveTarget:async()=>({kind:'ops',displayName:'총괄'}),
    rpc:async(operation)=>{
      if(operation==='register-endpoint')return {endpointId:'endpoint-one'};
      if(operation==='community-status'){
        statusCalls++;
        await statusGate;
        return {inside:true,roomId:'room-one'};
      }
      return {};
    }});
  await host.enable({target:'ops'},true);
  const select=()=>((host as unknown as {communityEndpoint:(fresh:boolean)=>Promise<{
    roomId:string}|null>}).communityEndpoint(true));
  const first=select(),second=select();
  await new Promise(resolve=>setTimeout(resolve,0));
  const concurrentCalls=statusCalls;
  releaseStatus();
  expect((await first)?.roomId).toBe('room-one');
  expect((await second)?.roomId).toBe('room-one');
  expect(concurrentCalls).toBe(1);
});
