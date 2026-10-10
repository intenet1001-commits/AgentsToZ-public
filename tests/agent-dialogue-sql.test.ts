import {PGlite} from '@electric-sql/pglite';
import {describe,expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {AGENT_DIALOGUE_SQL,AGENT_DIALOGUE_TABLES,MIGRATION_SQL,PORTMGR_TABLES} from '../src/schemaSql';

const migration=readFileSync(new URL('../supabase/migrations/20261003010000_agent_dialogue.sql',import.meta.url),'utf8');
const peerPriorityMigration=readFileSync(new URL('../supabase/migrations/20261004010000_agent_dialogue_peer_priority.sql',import.meta.url),'utf8');
const pairingsMigration=readFileSync(new URL('../supabase/migrations/20261004020000_agent_dialogue_pairings.sql',import.meta.url),'utf8');
const communityMigration=readFileSync(new URL('../supabase/migrations/20261004030000_agent_dialogue_community.sql',import.meta.url),'utf8');
const controlMigration=readFileSync(new URL('../supabase/migrations/20261005010000_agent_dialogue_control.sql',import.meta.url),'utf8');
const communityIdleMigration=readFileSync(new URL('../supabase/migrations/20261005020000_agent_dialogue_community_idle.sql',import.meta.url),'utf8');
const controlWindowMigration=readFileSync(new URL('../supabase/migrations/20261006010000_agent_dialogue_control_window.sql',import.meta.url),'utf8');
const profile='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const one='11111111-1111-4111-8111-111111111111';
const two='22222222-2222-4222-8222-222222222222';
const secretOne='a'.repeat(44),secretTwo='b'.repeat(44);
async function setup(){
  const db=new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
create schema auth;create function auth.role() returns text language sql stable as $$ select current_setting('request.jwt.claim.role',true) $$;
set request.jwt.claim.role='service_role';`);
  await db.exec(AGENT_DIALOGUE_SQL);
  return db;
}
async function call(db:PGlite,operation:string,device:string,secret:string,args:Record<string,unknown>={}){
  const result=await db.query<{value:Record<string,any>}>('select public.portmgr_agent_dialogue_call($1,$2,$3,$4,$5::jsonb) as value',
    [operation,profile,device,secret,JSON.stringify(args)]);
  return result.rows[0]!.value;
}
describe('agent dialogue database',()=>{
  test('versioned migration matches canonical setup and grants only service role',async()=>{
    // Only the newest migration is re-derived from the canonical SQL; the earlier two are history
    // (20261003010000 created everything with a flat cap, 20261004010000 put OPS first).
    // The canonical SQL is idempotent (create table if not exists / create or replace), so the
    // newest migration is simply all of it — this one adds the pairing table the function needs.
    // The newest migration is the canonical SQL in full (each one replaces the functions idempotently).
    expect(controlWindowMigration).toBe(AGENT_DIALOGUE_SQL);
    expect(communityIdleMigration).not.toBe(AGENT_DIALOGUE_SQL);
    expect(communityMigration).toContain('add column if not exists kind');
    expect(communityMigration).toContain("kind text not null default 'room' check(kind in ('room','community'))");
    expect(pairingsMigration).toContain('create table if not exists public.portmgr_agent_dialogue_pairings');
    expect(migration).toContain('order by last_seen_at desc,endpoint_id limit 100) e;');
    expect(peerPriorityMigration).toContain("order by case when kind='ops' then 0 else 1 end,last_seen_at desc,endpoint_id limit 100) e;");
    expect(AGENT_DIALOGUE_SQL).not.toContain('limit 100) e;');
    expect(MIGRATION_SQL).toContain(AGENT_DIALOGUE_SQL);
    for(const table of AGENT_DIALOGUE_TABLES)expect(PORTMGR_TABLES).toContain(table);
    const db=await setup();try{
      const rows=(await db.query<{role:string;allowed:boolean}>(`select role,has_function_privilege(role,
        'public.portmgr_agent_dialogue_call(text,text,text,text,jsonb)','EXECUTE') allowed
        from unnest(array['anon','authenticated','service_role']) role`)).rows;
      expect(rows).toEqual([{role:'anon',allowed:false},{role:'authenticated',allowed:false},{role:'service_role',allowed:true}]);
    }finally{await db.close();}
  });
  test('OPS and another project exchange ordered messages, with exact consent and idempotency',async()=>{
    const db=await setup();try{
      await call(db,'register-device','mac-one-1',secretOne);
      await call(db,'register-device','mac-two-2',secretTwo);
      const ops=await call(db,'register-endpoint','mac-one-1',secretOne,{kind:'ops',incarnationId:one,displayName:'1호 총괄'});
      const project=await call(db,'register-endpoint','mac-two-2',secretTwo,{kind:'project',portId:'local-b',incarnationId:two,displayName:'2호 B',memoryId:'other-memory'});
      expect(ops.kind).toBe('ops');expect(project.kind).toBe('project');
      const peers=await call(db,'peers','mac-one-1',secretOne,{sourceEndpointId:ops.endpointId});
      expect(peers.peers).toMatchObject([{endpointId:project.endpointId,kind:'project'}]);
      const args={sourceEndpointId:ops.endpointId,endpointIds:[project.endpointId],requestId:one};
      const room=await call(db,'create','mac-one-1',secretOne,args);
      expect(await call(db,'create','mac-one-1',secretOne,args)).toEqual(room);
      const invitation=await call(db,'invitations','mac-two-2',secretTwo,{sourceEndpointId:project.endpointId});
      expect(invitation.invitations[0].roomId).toBe(room.roomId);
      const joined=await call(db,'join','mac-two-2',secretTwo,{sourceEndpointId:project.endpointId,roomId:room.roomId,requestId:two});
      const sent=await call(db,'send','mac-one-1',secretOne,{sourceEndpointId:ops.endpointId,roomId:room.roomId,
        participantId:room.participantId,requestId:two,kind:'question',text:'빌드 상태?'});
      expect(sent.recipientCount).toBe(1);
      expect(await call(db,'send','mac-one-1',secretOne,{sourceEndpointId:ops.endpointId,roomId:room.roomId,
        participantId:room.participantId,requestId:two,kind:'question',text:'빌드 상태?'})).toEqual(sent);
      const inbox=await call(db,'read','mac-two-2',secretTwo,{sourceEndpointId:project.endpointId,roomId:room.roomId,
        participantId:joined.participantId,afterSeq:0});
      expect(inbox.events.map((event:any)=>event.text)).toContain('빌드 상태?');
      expect(inbox.nextSeq).toBe(sent.seq);
      expect((await db.query<{count:number}>('select count(*)::int count from public.portmgr_agent_dialogue_events where kind=\'message\'')).rows[0]!.count).toBe(1);
    }finally{await db.close();}
  });
  test('a remote OPS stays discoverable beyond the first 100 project endpoints',async()=>{
    const db=await setup();try{
      await call(db,'register-device','mac-one-1',secretOne);
      await call(db,'register-device','mac-two-2',secretTwo);
      const local=await call(db,'register-endpoint','mac-one-1',secretOne,{kind:'ops',incarnationId:one,displayName:'1호 총괄'});
      const remote=await call(db,'register-endpoint','mac-two-2',secretTwo,{kind:'ops',incarnationId:two,displayName:'3호 총괄'});
      for(let n=0;n<105;n++){
        const incarnation=`${String(n+1).padStart(8,'0')}-0000-4000-8000-000000000000`;
        await call(db,'register-endpoint','mac-two-2',secretTwo,{kind:'project',portId:`project-${n}`,incarnationId:incarnation,displayName:`3호 프로젝트 ${n}`});
      }
      const peers=await call(db,'peers','mac-one-1',secretOne,{sourceEndpointId:local.endpointId});
      expect(peers.peers).toHaveLength(106);
      expect(peers.peers.some((peer:any)=>peer.endpointId===remote.endpointId&&peer.kind==='ops')).toBe(true);
    }finally{await db.close();}
  });
  test('three devices enter one community and talk without inviting anybody',async()=>{
    const db=await setup();try{
      const third='33333333-3333-4333-8333-333333333333',secretThird='c'.repeat(44);
      for(const [device,secret] of [['mac-one-1',secretOne],['mac-two-2',secretTwo],['mac-three-3',secretThird]] as const)
        await call(db,'register-device',device,secret);
      const one1=await call(db,'register-endpoint','mac-one-1',secretOne,{kind:'ops',incarnationId:one,displayName:'1호 총괄'});
      const two2=await call(db,'register-endpoint','mac-two-2',secretTwo,{kind:'ops',incarnationId:two,displayName:'2호 총괄'});
      const three3=await call(db,'register-endpoint','mac-three-3',secretThird,{kind:'ops',incarnationId:third,displayName:'3호 총괄'});
      // Before anyone enters there is no community at all.
      expect(await call(db,'community-status','mac-one-1',secretOne,{sourceEndpointId:one1.endpointId}))
        .toMatchObject({roomId:null,inside:false,members:[]});
      const joinedOne=await call(db,'community-join','mac-one-1',secretOne,{sourceEndpointId:one1.endpointId,requestId:one});
      expect(joinedOne).toMatchObject({joined:true,alreadyIn:false});
      // Entering twice is the same membership, not a second seat or a second event.
      const again=await call(db,'community-join','mac-one-1',secretOne,{sourceEndpointId:one1.endpointId,requestId:two});
      expect(again).toMatchObject({participantId:joinedOne.participantId,alreadyIn:true});
      const joinedTwo=await call(db,'community-join','mac-two-2',secretTwo,{sourceEndpointId:two2.endpointId,requestId:two});
      const joinedThree=await call(db,'community-join','mac-three-3',secretThird,{sourceEndpointId:three3.endpointId,requestId:third});
      expect(joinedTwo.roomId).toBe(joinedOne.roomId);
      expect(joinedThree.roomId).toBe(joinedOne.roomId);
      expect((joinedThree.members as any[]).map(m=>m.displayName)).toEqual(['1호 총괄','2호 총괄','3호 총괄']);
      expect((await db.query<{count:number}>("select count(*)::int count from public.portmgr_agent_dialogue_rooms where kind='community'")).rows[0]!.count).toBe(1);
      // One message reaches both of the others — no invitation, no approval, no «calling».
      const sent=await call(db,'send','mac-one-1',secretOne,{sourceEndpointId:one1.endpointId,roomId:joinedOne.roomId,
        participantId:joinedOne.participantId,requestId:third,kind:'question',text:'커뮤니티 통신 테스트'});
      expect(sent.recipientCount).toBe(2);
      for(const [device,secret,endpoint,joined] of [
        ['mac-two-2',secretTwo,two2,joinedTwo],['mac-three-3',secretThird,three3,joinedThree]] as const){
        const inbox=await call(db,'read',device,secret,{sourceEndpointId:(endpoint as any).endpointId,
          roomId:joinedOne.roomId,participantId:(joined as any).participantId,afterSeq:0});
        expect(inbox.events.map((event:any)=>event.text)).toContain('커뮤니티 통신 테스트');
      }
      // Leaving stops delivery; entering again resumes it without a new room.
      await call(db,'community-leave','mac-three-3',secretThird,{sourceEndpointId:three3.endpointId,requestId:one});
      expect(await call(db,'community-status','mac-three-3',secretThird,{sourceEndpointId:three3.endpointId}))
        .toMatchObject({inside:false,roomId:joinedOne.roomId});
      const after=await call(db,'send','mac-one-1',secretOne,{sourceEndpointId:one1.endpointId,roomId:joinedOne.roomId,
        participantId:joinedOne.participantId,requestId:'44444444-4444-4444-8444-444444444444',kind:'observation',text:'떠난 뒤'});
      expect(after.recipientCount).toBe(1);
      const back=await call(db,'community-join','mac-three-3',secretThird,{sourceEndpointId:three3.endpointId,requestId:'55555555-5555-4555-8555-555555555555'});
      expect(back.roomId).toBe(joinedOne.roomId);
      expect(back.alreadyIn).toBe(false);
    }finally{await db.close();}
  });
  test('the versioned migrations upgrade a database that already holds 10-03 rooms',async()=>{
    // The live DB got the migrations one at a time, so its rooms table predates `kind`.
    // `create table if not exists` skips an existing table, so a fresh-DB test cannot see this.
    const db=new PGlite();try{
      await db.exec(`create role anon; create role authenticated; create role service_role;
create schema auth;create function auth.role() returns text language sql stable as $$ select current_setting('request.jwt.claim.role',true) $$;
set request.jwt.claim.role='service_role';`);
      await db.exec(migration);
      await call(db,'register-device','mac-one-1',secretOne);
      await call(db,'register-device','mac-two-2',secretTwo);
      const ops=await call(db,'register-endpoint','mac-one-1',secretOne,{kind:'ops',incarnationId:one,displayName:'1호 총괄'});
      const peer=await call(db,'register-endpoint','mac-two-2',secretTwo,{kind:'ops',incarnationId:two,displayName:'2호 총괄'});
      const old=await call(db,'create','mac-one-1',secretOne,{sourceEndpointId:ops.endpointId,endpointIds:[peer.endpointId],requestId:one});
      for(const next of [peerPriorityMigration,pairingsMigration,communityMigration,controlMigration])await db.exec(next);
      const rows=(await db.query<{room_id:string;kind:string}>('select room_id,kind from public.portmgr_agent_dialogue_rooms')).rows;
      expect(rows).toEqual([{room_id:old.roomId,kind:'room'}]);
      const joined=await call(db,'community-join','mac-one-1',secretOne,{sourceEndpointId:ops.endpointId,requestId:two});
      expect(joined).toMatchObject({joined:true,alreadyIn:false});
      // Re-running the newest migration on the upgraded DB is a no-op, as `db push` retries expect.
      await db.exec(controlMigration);
    }finally{await db.close();}
  });
  test('a community member drives another member device through the control mailbox',async()=>{
    const db=await setup();try{
      const third='33333333-3333-4333-8333-333333333333',secretThird='c'.repeat(44);
      for(const [device,secret] of [['mac-one-1',secretOne],['mac-two-2',secretTwo],['mac-three-3',secretThird]] as const)
        await call(db,'register-device',device,secret);
      const a=await call(db,'register-endpoint','mac-one-1',secretOne,{kind:'ops',incarnationId:one,displayName:'1호 총괄'});
      const b=await call(db,'register-endpoint','mac-two-2',secretTwo,{kind:'ops',incarnationId:two,displayName:'2호 총괄'});
      const c=await call(db,'register-endpoint','mac-three-3',secretThird,{kind:'ops',incarnationId:third,displayName:'3호 총괄'});
      const req=()=>crypto.randomUUID();
      // Not in the community yet: no control at all.
      await expect(call(db,'control-send','mac-one-1',secretOne,{sourceEndpointId:a.endpointId,targetEndpointId:b.endpointId,request:{kind:'projects'}}))
        .rejects.toThrow('AGENT_DIALOGUE_CONTROL_NOT_IN_COMMUNITY');
      await call(db,'community-join','mac-one-1',secretOne,{sourceEndpointId:a.endpointId,requestId:req()});
      // The target has not entered: it is not controllable.
      await expect(call(db,'control-send','mac-one-1',secretOne,{sourceEndpointId:a.endpointId,targetEndpointId:b.endpointId,request:{kind:'projects'}}))
        .rejects.toThrow('AGENT_DIALOGUE_CONTROL_TARGET_UNAVAILABLE');
      await call(db,'community-join','mac-two-2',secretTwo,{sourceEndpointId:b.endpointId,requestId:req()});
      // A device cannot address itself.
      await expect(call(db,'control-send','mac-one-1',secretOne,{sourceEndpointId:a.endpointId,targetEndpointId:a.endpointId,request:{kind:'projects'}}))
        .rejects.toThrow('AGENT_DIALOGUE_CONTROL_TARGET_UNAVAILABLE');
      const sent=await call(db,'control-send','mac-one-1',secretOne,{sourceEndpointId:a.endpointId,targetEndpointId:b.endpointId,
        request:{kind:'terminal',body:{operation:'list',requestId:one}}});
      expect(sent.targetDeviceId).toBe('mac-two-2');
      // Another device sees nothing addressed to mac-two-2, and cannot answer it.
      expect((await call(db,'control-inbox','mac-three-3',secretThird)).controls).toEqual([]);
      expect(await call(db,'control-respond','mac-three-3',secretThird,{controlId:sent.controlId,response:{ok:true}})).toEqual({responded:false});
      const inbox=await call(db,'control-inbox','mac-two-2',secretTwo);
      expect(inbox.controls).toMatchObject([{controlId:sent.controlId,fromDeviceId:'mac-one-1',fromName:'1호 총괄',
        request:{kind:'terminal',body:{operation:'list'}}}]);
      // Taken once: a second poll does not deliver it again.
      expect((await call(db,'control-inbox','mac-two-2',secretTwo)).controls).toEqual([]);
      expect(await call(db,'control-result','mac-one-1',secretOne,{sourceEndpointId:a.endpointId,controlIds:[sent.controlId]}))
        .toEqual({results:[],waiting:[sent.controlId]});
      expect(await call(db,'control-respond','mac-two-2',secretTwo,{controlId:sent.controlId,response:{ok:true,body:{sessions:[]}}})).toEqual({responded:true});
      // The answered request no longer keeps its text.
      expect((await db.query<{request:unknown}>('select request from public.portmgr_agent_dialogue_controls')).rows).toEqual([{request:{}}]);
      // Only the sender can collect, and collecting deletes the row.
      expect((await call(db,'control-result','mac-three-3',secretThird,{sourceEndpointId:c.endpointId,controlIds:[sent.controlId]})).results).toEqual([]);
      expect(await call(db,'control-result','mac-one-1',secretOne,{sourceEndpointId:a.endpointId,controlIds:[sent.controlId]}))
        .toEqual({results:[{controlId:sent.controlId,response:{ok:true,body:{sessions:[]}}}],waiting:[]});
      expect((await db.query<{count:number}>('select count(*)::int count from public.portmgr_agent_dialogue_controls')).rows[0]!.count).toBe(0);
      // Leaving the community stops control at once, even for a request already queued.
      const queued=await call(db,'control-send','mac-one-1',secretOne,{sourceEndpointId:a.endpointId,targetEndpointId:b.endpointId,request:{kind:'projects'}});
      await call(db,'community-leave','mac-two-2',secretTwo,{sourceEndpointId:b.endpointId,requestId:req()});
      expect((await call(db,'control-inbox','mac-two-2',secretTwo)).controls).toEqual([]);
      await expect(call(db,'control-send','mac-one-1',secretOne,{sourceEndpointId:a.endpointId,targetEndpointId:b.endpointId,request:{kind:'projects'}}))
        .rejects.toThrow('AGENT_DIALOGUE_CONTROL_TARGET_UNAVAILABLE');
      // Stale requests are never executed and old rows are dropped by prune.
      await call(db,'community-join','mac-two-2',secretTwo,{sourceEndpointId:b.endpointId,requestId:req()});
      await db.query("update public.portmgr_agent_dialogue_controls set created_at=now()-interval '45 seconds' where control_id=$1",[queued.controlId]);
      expect((await call(db,'control-inbox','mac-two-2',secretTwo)).controls).toEqual([]);
      await db.query("update public.portmgr_agent_dialogue_controls set created_at=now()-interval '11 minutes'");
      await call(db,'prune','mac-one-1',secretOne);
      expect((await db.query<{count:number}>('select count(*)::int count from public.portmgr_agent_dialogue_controls')).rows[0]!.count).toBe(0);
    }finally{await db.close();}
  });
  test('the receiving side is told a message is waiting, and reading clears it',async()=>{
    const db=await setup();try{
      await call(db,'register-device','mac-one-1',secretOne);
      await call(db,'register-device','mac-two-2',secretTwo);
      const mine=await call(db,'register-endpoint','mac-one-1',secretOne,{kind:'ops',incarnationId:one,displayName:'1호 총괄'});
      const peer=await call(db,'register-endpoint','mac-two-2',secretTwo,{kind:'ops',incarnationId:two,displayName:'3호 총괄'});
      const sender=await call(db,'community-join','mac-one-1',secretOne,{sourceEndpointId:mine.endpointId,requestId:one});
      const receiver=await call(db,'community-join','mac-two-2',secretTwo,{sourceEndpointId:peer.endpointId,requestId:two});
      const mineStatus=()=>call(db,'community-status','mac-one-1',secretOne,{sourceEndpointId:mine.endpointId});
      const peerStatus=()=>call(db,'community-status','mac-two-2',secretTwo,{sourceEndpointId:peer.endpointId});
      expect((await peerStatus()).unread).toBe(0);
      const sent=await call(db,'send','mac-one-1',secretOne,{sourceEndpointId:mine.endpointId,roomId:sender.roomId,
        participantId:sender.participantId,requestId:'33333333-3333-4333-8333-333333333333',kind:'question',text:'거기 있나요'});
      // The receiver learns a message is waiting without anyone reading the room first.
      expect((await peerStatus()).unread).toBe(1);
      // My own message is never unread for me.
      expect((await mineStatus()).unread).toBe(0);
      const inbox=await call(db,'read','mac-two-2',secretTwo,{sourceEndpointId:peer.endpointId,roomId:sender.roomId,
        participantId:receiver.participantId,afterSeq:0});
      expect(inbox.events.map((event:any)=>event.text)).toContain('거기 있나요');
      // Reading acknowledges what was delivered — it used to store the requested cursor, so a read
      // from 0 acked 0 and the count never cleared.
      const after=await peerStatus();
      expect(after.unread).toBe(0);
      expect(Number(after.ackSeq)).toBe(Number(sent.seq));
      // The answer comes back the other way and is unread for the first sender.
      await call(db,'send','mac-two-2',secretTwo,{sourceEndpointId:peer.endpointId,roomId:sender.roomId,
        participantId:receiver.participantId,requestId:'99999999-9999-4999-8999-999999999999',kind:'answer',text:'여기 있습니다'});
      expect((await mineStatus()).unread).toBe(1);
      const back=await call(db,'read','mac-one-1',secretOne,{sourceEndpointId:mine.endpointId,roomId:sender.roomId,
        participantId:sender.participantId,afterSeq:0});
      expect(back.events.map((event:any)=>event.text)).toContain('여기 있습니다');
      expect((await mineStatus()).unread).toBe(0);
    }finally{await db.close();}
  });
  test('a community that sat quiet for hours still accepts a message',async()=>{
    const db=await setup();try{
      await call(db,'register-device','mac-one-1',secretOne);
      await call(db,'register-device','mac-two-2',secretTwo);
      const mine=await call(db,'register-endpoint','mac-one-1',secretOne,{kind:'ops',incarnationId:one,displayName:'1호 총괄'});
      const peer=await call(db,'register-endpoint','mac-two-2',secretTwo,{kind:'ops',incarnationId:two,displayName:'3호 총괄'});
      const joined=await call(db,'community-join','mac-one-1',secretOne,{sourceEndpointId:mine.endpointId,requestId:one});
      const other=await call(db,'community-join','mac-two-2',secretTwo,{sourceEndpointId:peer.endpointId,requestId:two});
      // ⚠️ Exempting the community from the retention pass was not enough: the room-operation guard
      // also refused a send after 2 idle hours. Measured on the live room 2026-10-05 — active,
      // expires_at in 2126, 520 idle minutes, AGENT_DIALOGUE_ROOM_INACTIVE.
      await db.query("update public.portmgr_agent_dialogue_rooms set last_activity_at=now()-interval '9 hours' where kind='community'");
      const sent=await call(db,'send','mac-one-1',secretOne,{sourceEndpointId:mine.endpointId,roomId:joined.roomId,
        participantId:joined.participantId,requestId:'66666666-6666-4666-8666-666666666666',kind:'question',text:'조용한 뒤에도 전달'});
      expect(sent.recipientCount).toBe(1);
      const inbox=await call(db,'read','mac-two-2',secretTwo,{sourceEndpointId:peer.endpointId,roomId:joined.roomId,
        participantId:other.participantId,afterSeq:0});
      expect(inbox.events.map((event:any)=>event.text)).toContain('조용한 뒤에도 전달');
      // An ordinary room still goes inactive after the same quiet period.
      const ordinary=await call(db,'create','mac-one-1',secretOne,{sourceEndpointId:mine.endpointId,
        endpointIds:[peer.endpointId],requestId:'77777777-7777-4777-8777-777777777777'});
      await db.query("update public.portmgr_agent_dialogue_rooms set last_activity_at=now()-interval '9 hours' where kind='room'");
      await expect(call(db,'send','mac-one-1',secretOne,{sourceEndpointId:mine.endpointId,roomId:ordinary.roomId,
        participantId:ordinary.participantId,requestId:'88888888-8888-4888-8888-888888888888',kind:'question',text:'옛 방'}))
        .rejects.toThrow('AGENT_DIALOGUE_ROOM_INACTIVE');
    }finally{await db.close();}
  });
  test('the community outlives the idle and expiry rules that close an ordinary room',async()=>{
    const db=await setup();try{
      await call(db,'register-device','mac-one-1',secretOne);
      await call(db,'register-device','mac-two-2',secretTwo);
      const mine=await call(db,'register-endpoint','mac-one-1',secretOne,{kind:'ops',incarnationId:one,displayName:'1호 총괄'});
      const peer=await call(db,'register-endpoint','mac-two-2',secretTwo,{kind:'project',portId:'local-b',incarnationId:two,displayName:'2호 B'});
      const community=await call(db,'community-join','mac-one-1',secretOne,{sourceEndpointId:mine.endpointId,requestId:one});
      const ordinary=await call(db,'create','mac-one-1',secretOne,{sourceEndpointId:mine.endpointId,endpointIds:[peer.endpointId],requestId:two});
      await db.query("update public.portmgr_agent_dialogue_rooms set last_activity_at=now()-interval '3 hours',expires_at=now()-interval '1 minute'");
      await call(db,'prune','mac-one-1',secretOne);
      const rows=(await db.query<{room_id:string;state:string;kind:string}>('select room_id,state,kind from public.portmgr_agent_dialogue_rooms')).rows;
      expect(rows.find(row=>row.room_id===community.roomId)).toMatchObject({state:'active',kind:'community'});
      expect(rows.find(row=>row.room_id===ordinary.roomId)).toMatchObject({state:'expired',kind:'room'});
    }finally{await db.close();}
  });
  test('a pairing needs both sides, then lasts 30 days until either side revokes it',async()=>{
    const db=await setup();try{
      await call(db,'register-device','mac-one-1',secretOne);
      await call(db,'register-device','mac-two-2',secretTwo);
      const mine=await call(db,'register-endpoint','mac-one-1',secretOne,{kind:'ops',incarnationId:one,displayName:'1호 총괄'});
      const theirs=await call(db,'register-endpoint','mac-two-2',secretTwo,{kind:'ops',incarnationId:two,displayName:'3호 총괄'});
      const asked=await call(db,'pair','mac-one-1',secretOne,{sourceEndpointId:mine.endpointId,peerEndpointId:theirs.endpointId});
      expect(asked).toMatchObject({state:'waiting-peer',acceptedByMe:true,acceptedByPeer:false,expiresAt:null});
      // Asking twice is the same request, not a second pairing.
      await call(db,'pair','mac-one-1',secretOne,{sourceEndpointId:mine.endpointId,peerEndpointId:theirs.endpointId});
      const accepted=await call(db,'pair','mac-two-2',secretTwo,{sourceEndpointId:theirs.endpointId,peerEndpointId:mine.endpointId});
      expect(accepted).toMatchObject({pairingId:asked.pairingId,state:'active',acceptedByPeer:true});
      const days=(new Date(accepted.expiresAt).getTime()-Date.now())/86_400_000;
      expect(days).toBeGreaterThan(29.9);expect(days).toBeLessThan(30.1);
      const listed=await call(db,'pairings','mac-one-1',secretOne,{sourceEndpointId:mine.endpointId});
      expect(listed.pairings).toMatchObject([{peerEndpointId:theirs.endpointId,peerDisplayName:'3호 총괄',state:'active'}]);
      expect((await db.query<{count:number}>('select count(*)::int count from public.portmgr_agent_dialogue_pairings')).rows[0]!.count).toBe(1);
      // Either side revokes; a later ask starts a fresh pairing rather than reviving the old row.
      await call(db,'pair-revoke','mac-two-2',secretTwo,{sourceEndpointId:theirs.endpointId,peerEndpointId:mine.endpointId});
      expect((await call(db,'pairings','mac-one-1',secretOne,{sourceEndpointId:mine.endpointId})).pairings).toEqual([]);
      const again=await call(db,'pair','mac-one-1',secretOne,{sourceEndpointId:mine.endpointId,peerEndpointId:theirs.endpointId});
      expect(again.pairingId).not.toBe(asked.pairingId);
      expect(again.state).toBe('waiting-peer');
      await expect(call(db,'pair','mac-one-1',secretOne,{sourceEndpointId:mine.endpointId,peerEndpointId:mine.endpointId}))
        .rejects.toThrow('AGENT_DIALOGUE_PAIR_PEER_INVALID');
    }finally{await db.close();}
  });
  test('an expired pairing reads as expired, not active',async()=>{
    const db=await setup();try{
      await call(db,'register-device','mac-one-1',secretOne);
      await call(db,'register-device','mac-two-2',secretTwo);
      const mine=await call(db,'register-endpoint','mac-one-1',secretOne,{kind:'ops',incarnationId:one,displayName:'1호 총괄'});
      const theirs=await call(db,'register-endpoint','mac-two-2',secretTwo,{kind:'ops',incarnationId:two,displayName:'3호 총괄'});
      await call(db,'pair','mac-one-1',secretOne,{sourceEndpointId:mine.endpointId,peerEndpointId:theirs.endpointId});
      await call(db,'pair','mac-two-2',secretTwo,{sourceEndpointId:theirs.endpointId,peerEndpointId:mine.endpointId});
      await db.query("update public.portmgr_agent_dialogue_pairings set expires_at=now()-interval '1 minute'");
      expect((await call(db,'pairings','mac-one-1',secretOne,{sourceEndpointId:mine.endpointId})).pairings[0].state).toBe('expired');
    }finally{await db.close();}
  });
  test('one device publishing hundreds never starves another device',async()=>{
    const db=await setup();try{
      const third='33333333-3333-4333-8333-333333333333',secretThird='c'.repeat(44);
      for(const [device,secret] of [['mac-one-1',secretOne],['mac-two-2',secretTwo],['mac-three-3',secretThird]] as const)
        await call(db,'register-device',device,secret);
      const local=await call(db,'register-endpoint','mac-one-1',secretOne,{kind:'ops',incarnationId:one,displayName:'1호 총괄'});
      const loud=await call(db,'register-endpoint','mac-two-2',secretTwo,{kind:'ops',incarnationId:two,displayName:'2호 총괄'});
      const quiet=await call(db,'register-endpoint','mac-three-3',secretThird,{kind:'ops',incarnationId:third,displayName:'3호 총괄'});
      // The loud device's projects are also the freshest, which is what used to crowd the list.
      await db.query(`insert into public.portmgr_agent_dialogue_endpoints
        (profile_id,device_id,kind,port_id,incarnation_id,display_name,last_seen_at)
        select $1,'mac-two-2','project','loud-'||n,gen_random_uuid(),'2호 프로젝트 '||n,now()
        from generate_series(1,600) n`,[profile]);
      await db.query(`insert into public.portmgr_agent_dialogue_endpoints
        (profile_id,device_id,kind,port_id,incarnation_id,display_name,last_seen_at)
        select $1,'mac-three-3','project','quiet-'||n,gen_random_uuid(),'3호 프로젝트 '||n,now()-interval '1 hour'
        from generate_series(1,4) n`,[profile]);
      const peers=await call(db,'peers','mac-one-1',secretOne,{sourceEndpointId:local.endpointId});
      expect(peers.peers).toHaveLength(500);
      for(const ops of [loud.endpointId,quiet.endpointId])
        expect(peers.peers.some((peer:any)=>peer.endpointId===ops&&peer.kind==='ops')).toBe(true);
      // All four of the quiet device's projects survive the cap: the round robin takes its rank 1–4
      // before the loud device's rank 5.
      expect(peers.peers.filter((peer:any)=>peer.deviceId==='mac-three-3'&&peer.kind==='project')).toHaveLength(4);
    }finally{await db.close();}
  });
  test('same-memory endpoints stay distinct; private delivery and retained body cleanup are bounded',async()=>{
    const db=await setup();try{
      const third='33333333-3333-4333-8333-333333333333',secretThird='c'.repeat(44);
      for(const [device,secret] of [['mac-one-1',secretOne],['mac-two-2',secretTwo],['mac-three-3',secretThird]] as const)
        await call(db,'register-device',device,secret);
      const a=await call(db,'register-endpoint','mac-one-1',secretOne,{kind:'project',portId:'local-a',incarnationId:one,displayName:'1호 QQ',memoryId:'qq'});
      const b=await call(db,'register-endpoint','mac-two-2',secretTwo,{kind:'project',portId:'local-b',incarnationId:two,displayName:'2호 QQ',memoryId:'qq'});
      const c=await call(db,'register-endpoint','mac-three-3',secretThird,{kind:'ops',incarnationId:third,displayName:'3호 총괄'});
      expect(a.endpointId).not.toBe(b.endpointId);
      const room=await call(db,'create','mac-one-1',secretOne,{sourceEndpointId:a.endpointId,endpointIds:[b.endpointId,c.endpointId],requestId:one});
      const joinedB=await call(db,'join','mac-two-2',secretTwo,{sourceEndpointId:b.endpointId,roomId:room.roomId,requestId:two});
      const joinedC=await call(db,'join','mac-three-3',secretThird,{sourceEndpointId:c.endpointId,roomId:room.roomId,requestId:third});
      await expect(call(db,'send','mac-two-2',secretTwo,{sourceEndpointId:b.endpointId,roomId:room.roomId,
        participantId:joinedC.participantId,requestId:one,kind:'answer',text:'wrong actor'})).rejects.toThrow('AGENT_DIALOGUE_PARTICIPANT_MISMATCH');
      const sent=await call(db,'send','mac-two-2',secretTwo,{sourceEndpointId:b.endpointId,roomId:room.roomId,
        participantId:joinedB.participantId,toParticipantIds:[joinedC.participantId],requestId:one,kind:'answer',text:'3호 전용'});
      expect(sent.recipientCount).toBe(1);
      const ownerRead=await call(db,'read','mac-one-1',secretOne,{sourceEndpointId:a.endpointId,roomId:room.roomId,
        participantId:room.participantId,afterSeq:0});
      expect(ownerRead.events.map((event:any)=>event.text)).not.toContain('3호 전용');
      expect(ownerRead.nextSeq).toBe(sent.seq);
      const recipientRead=await call(db,'read','mac-three-3',secretThird,{sourceEndpointId:c.endpointId,roomId:room.roomId,
        participantId:joinedC.participantId,afterSeq:0});
      expect(recipientRead.events.map((event:any)=>event.text)).toContain('3호 전용');
      await call(db,'close','mac-one-1',secretOne,{sourceEndpointId:a.endpointId,roomId:room.roomId,
        participantId:room.participantId,requestId:third});
      await db.query("update public.portmgr_agent_dialogue_rooms set closed_at=now()-interval '8 days' where room_id=$1",[room.roomId]);
      expect((await call(db,'prune','mac-one-1',secretOne)).removedBodies).toBe(1);
      const body=(await db.query<{body:string|null}>("select body from public.portmgr_agent_dialogue_events where kind='message' and room_id=$1",[room.roomId])).rows[0]!.body;
      expect(body).toBeNull();
    }finally{await db.close();}
  });
  test('a refused invitation is recorded once and cannot be joined later',async()=>{
    const db=await setup();try{
      await call(db,'register-device','mac-one-1',secretOne);
      await call(db,'register-device','mac-two-2',secretTwo);
      const a=await call(db,'register-endpoint','mac-one-1',secretOne,{kind:'ops',incarnationId:one,displayName:'1호 총괄'});
      const b=await call(db,'register-endpoint','mac-two-2',secretTwo,{kind:'project',portId:'project-b',incarnationId:two,displayName:'2호 B'});
      const room=await call(db,'create','mac-one-1',secretOne,{sourceEndpointId:a.endpointId,endpointIds:[b.endpointId],requestId:one});
      const invitation=(await call(db,'invitations','mac-two-2',secretTwo,{sourceEndpointId:b.endpointId})).invitations[0];
      const refusal={sourceEndpointId:b.endpointId,roomId:room.roomId,participantId:invitation.participantId,requestId:two};
      const receipt=await call(db,'decline','mac-two-2',secretTwo,refusal);
      expect(receipt.declined).toBe(true);
      expect(await call(db,'decline','mac-two-2',secretTwo,refusal)).toEqual(receipt);
      expect((await call(db,'invitations','mac-two-2',secretTwo,{sourceEndpointId:b.endpointId})).invitations).toEqual([]);
      await expect(call(db,'join','mac-two-2',secretTwo,{sourceEndpointId:b.endpointId,roomId:room.roomId,
        requestId:'33333333-3333-4333-8333-333333333333'}))
        .rejects.toThrow('AGENT_DIALOGUE_INVITE_INACTIVE');
      const owner=await call(db,'read','mac-one-1',secretOne,{sourceEndpointId:a.endpointId,roomId:room.roomId,
        participantId:room.participantId,afterSeq:0});
      expect(owner.events.map((event:any)=>event.kind)).toContain('declined');
    }finally{await db.close();}
  });
  test('one device cannot revoke another device’s room membership',async()=>{
    const db=await setup();try{
      await call(db,'register-device','mac-one-1',secretOne);
      await call(db,'register-device','mac-two-2',secretTwo);
      const a=await call(db,'register-endpoint','mac-one-1',secretOne,{kind:'ops',incarnationId:one,displayName:'1호 총괄'});
      const b=await call(db,'register-endpoint','mac-two-2',secretTwo,{kind:'ops',incarnationId:two,displayName:'2호 총괄'});
      const room=await call(db,'create','mac-one-1',secretOne,{sourceEndpointId:a.endpointId,endpointIds:[b.endpointId],requestId:one});
      const joined=await call(db,'join','mac-two-2',secretTwo,{sourceEndpointId:b.endpointId,roomId:room.roomId,requestId:two});
      await call(db,'revoke-endpoint','mac-one-1',secretOne,{endpointId:b.endpointId});
      const state=(await db.query<{state:string}>('select state from public.portmgr_agent_dialogue_members where participant_id=$1',[joined.participantId])).rows[0]!.state;
      expect(state).toBe('joined');
      const sent=await call(db,'send','mac-two-2',secretTwo,{sourceEndpointId:b.endpointId,roomId:room.roomId,
        participantId:joined.participantId,requestId:one,kind:'answer',text:'계속 연결됨'});
      expect(sent.recipientCount).toBe(1);
    }finally{await db.close();}
  });
});
