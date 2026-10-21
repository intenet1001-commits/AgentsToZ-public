import {PGlite} from '@electric-sql/pglite';
import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AGENT_DIALOGUE_SQL} from '../src/agentDialogueSql';
import {AgentDialogueHost} from '../src/agentDialogueHost';
import {communityDeviceRef} from '../src/communityDeviceRef';
import {remoteCommunityState,remoteCommunityProjects} from '../src/remoteCommunity';
import {createMobileWorkspaceGateway} from '../src/mobileWorkspaceGateway';
import {normalizeRemoteTerminalRequest} from '../src/remoteControlTerminalProtocol';
import type {AgentDialogueTarget} from '../src/agentDialogueContract';
import type {AiTerminalRequest,AiTerminalResponse} from '../src/aiTerminalProtocol';
import type {MobileWorkspaceRequest,MobileWorkspaceResult} from '../src/mobileWorkspaceProtocol';

const temporary:string[]=[];
afterEach(()=>{for(const path of temporary.splice(0))rmSync(path,{recursive:true,force:true});});

test('a phone on one Mac reads, speaks in the community and drives another device through it',async()=>{
  const db=new PGlite();
  try{
    await db.exec("create role anon; create role authenticated; create role service_role;create schema auth;create function auth.role() returns text language sql stable as $$ select current_setting('request.jwt.claim.role',true) $$;set request.jwt.claim.role='service_role';");
    await db.exec(AGENT_DIALOGUE_SQL);
    const profileId=randomUUID();
    const ops:AgentDialogueTarget={target:'ops'};
    const makeHost=(deviceId:string)=>{
      const appDataDir=mkdtempSync(join(tmpdir(),'community-mobile-'));temporary.push(appDataDir);
      return new AgentDialogueHost({appDataDir,identity:()=>({profileId,deviceId}),secret:async()=>deviceId.padEnd(44,'x'),
        resolveTarget:async()=>({kind:'ops',displayName:`${deviceId} / 아젠투지(OPS)`}),
        rpc:async(operation,p,d,secret,args)=>{
          const {rows}=await db.query<{value:Record<string,any>}>(
            'select public.portmgr_agent_dialogue_call($1,$2,$3,$4,$5::jsonb) as value',[operation,p,d,secret,JSON.stringify(args)]);
          return rows[0]!.value;
        }});
    };
    const one=makeHost('mac-one-1'),three=makeHost('mac-three-3');
    for(const host of [one,three])await host.enable(ops,true);

    // 입장 전: 상태는 보여 주지만 읽기·보내기는 거절한다 — 입장은 Mac 화면에만 있다.
    expect(await one.communityMobile('status')).toMatchObject({inside:false,roomId:null});
    await expect(one.communityMobile('read',{afterSeq:0})).rejects.toThrow('커뮤니티에 입장');
    await expect(one.communityMobile('send',{text:'먼저 입장해야 한다'})).rejects.toThrow('커뮤니티에 입장');

    await one.uiCommunity(ops,'join');await three.uiCommunity(ops,'join');
    const threeEndpoint=three.status().enabled[0]!.endpointId;
    const ref=communityDeviceRef(threeEndpoint);
    const status=await one.communityMobile('status');
    expect(status.inside).toBe(true);
    expect(status.devices).toEqual([{ref,name:'mac-three-3 / 아젠투지(OPS)',kind:'ops'}]);

    // 휴대폰에 나가는 payload에는 endpointId·participantId·deviceId가 없다 — 참조와 사람이 읽을 이름만 있다.
    const wire=JSON.stringify(remoteCommunityState(status));
    for(const id of [threeEndpoint,String(status.participantId),String(status.roomId)])expect(wire.includes(id)).toBe(id===String(status.roomId));
    for(const key of ['endpointId','participantId','deviceId','senderParticipantId','displayName'])expect(wire).not.toContain(key);
    expect(wire).toContain(ref);

    await three.communityMobile('send',{text:'3호에서 보냅니다'});
    const read=await one.communityMobile('read',{afterSeq:0});
    const shown=remoteCommunityState(read);
    expect(shown.messages.map(message=>message.text)).toContain('3호에서 보냅니다');
    expect(shown.messages.find(message=>message.text==='3호에서 보냅니다')!.self).toBe(false);
    // 읽은 만큼 ack 된다 — 읽지 않음이 0으로 떨어진다.
    expect((await one.communityMobile('status')).unread).toBe(0);

    // 처음 여는 화면(커서 0)은 가장 오래된 줄이 아니라 방의 끝부터 보인다(2026-10-06 실기: 며칠 전 대화가 먼저 떴다).
    for(let i=0;i<12;i++)await three.communityMobile('send',{text:`긴 대화 ${i}`});
    const fresh=remoteCommunityState(await one.communityMobile('read',{afterSeq:0}));
    expect(fresh.messages.map(message=>message.text)).toContain('긴 대화 11');
    expect(fresh.messages.map(message=>message.text)).not.toContain('3호에서 보냅니다');

    // 같은 요청 id로 두 번 보내도 한 번만 들어간다(휴대폰 재시도).
    await one.communityMobile('send',{text:'한 번만',requestId:'phone-retry-1'});
    await one.communityMobile('send',{text:'한 번만',requestId:'phone-retry-1'});
    const all=await three.communityMobile('read',{afterSeq:0});
    expect((all.messages as {text?:string}[]).filter(message=>message.text==='한 번만').length).toBe(1);
    // 보낸 직후 응답에는 자기 줄이 함께 온다 — 커서를 준 경우에만 읽는다.
    const cursor=(await one.communityMobile('status')).nextSeq as number;
    const sent=remoteCommunityState(await one.communityMobile('send',{text:'내 말도 보인다',afterSeq:cursor}));
    expect(sent.messages.some(message=>message.text==='내 말도 보인다'&&message.self)).toBe(true);
    // 커서 없이 보내면 옛 대화를 끌어오지 않는다(보낸 것 자체는 성공한다).
    expect(remoteCommunityState(await one.communityMobile('send',{text:'커서 없이'})).messages).toEqual([]);
    expect((await three.communityMobile('read',{afterSeq:0})).messages.some(message=>(message as {text?:string}).text==='커서 없이')).toBe(true);

    // 다른 아젠투지에 요청을 넘긴다 — 그 Mac이 자기 사이드카로 실행한다.
    let polling=true;
    const poller=(async()=>{while(polling){
      await three.controlPoll(async request=>({echo:request.kind}));
      await new Promise(resolve=>setTimeout(resolve,20));
    }})();
    try{
      expect(await one.communityForward(ref,{kind:'projects'})).toEqual({ok:true,body:{echo:'projects'}});
      await expect(one.communityForward('0'.repeat(16),{kind:'projects'})).rejects.toThrow('커뮤니티에 없습니다');
    }finally{polling=false;await poller;}

    // 그 기기가 나가면 참조는 아무 것도 가리키지 않는다.
    await three.uiCommunity(ops,'leave');
    expect((await one.communityMobile('status')).devices).toEqual([]);
    await expect(one.communityForward(ref,{kind:'projects'})).rejects.toThrow('커뮤니티에 없습니다');
  }finally{await db.close();}
},30_000);

test('the workspace gateway forwards a device-tagged request only with the OPS scope, and never locally',async()=>{
  const localCalls:unknown[]=[],forwarded:{ref:string;request:unknown}[]=[];
  const request:AiTerminalRequest={requestId:'a'.repeat(20),operation:'list'};
  const answer:AiTerminalResponse={sessions:[]};
  const gateway=(options:{ops:string|null;allowed:string[];forward?:boolean})=>createMobileWorkspaceGateway({
    terminal:async r=>{localCalls.push(r);return answer;},
    active:()=>true,
    resolve:async()=>[{controlId:'control-1',runtimeTargetId:'ops-project'}],
    consent:async()=>({targetIds:new Set(options.allowed),workspaceScopes:[],isActive:()=>true,requestOwner:'device:1:2'}),
    perform:async()=>({kind:'workspace',action:'community.status'} as MobileWorkspaceResult),
    opsRuntimeTargetId:()=>options.ops,
    ...(options.forward===false?{}:{forward:async(ref,r)=>{forwarded.push({ref,request:r});return answer;}}),
  });
  // OPS 범위를 허락받았으면 그대로 넘어가고, 요청 안에는 기기 참조가 없다.
  expect(await gateway({ops:'ops-project',allowed:['ops-project']})(request,[],'device:1:2',()=>true,'ab12ef3456789012')).toBe(answer);
  expect(forwarded).toEqual([{ref:'ab12ef3456789012',request}]);
  expect(Object.keys(forwarded[0]!.request as object)).not.toContain('device');
  expect(localCalls).toEqual([]);
  // 프로젝트 하나만 허락받은 휴대폰은 다른 기기를 몰 수 없다.
  await expect(gateway({ops:'ops-project',allowed:['other-project']})(request,[],'device:1:2',()=>true,'ab12ef3456789012'))
    .rejects.toThrow('총괄(OPS) 프로젝트를 허용');
  // OPS 프로필이 없는 Mac도 마찬가지다.
  await expect(gateway({ops:null,allowed:['ops-project']})(request,[],'device:1:2',()=>true,'ab12ef3456789012'))
    .rejects.toThrow('총괄(OPS) 프로젝트를 허용');
  // 전달할 수 없는 구성(옛 코드 경로)은 업데이트로 안내한다.
  await expect(gateway({ops:'ops-project',allowed:['ops-project'],forward:false})(request,[],'device:1:2',()=>true,'ab12ef3456789012'))
    .rejects.toThrow('업데이트');
  expect(localCalls).toEqual([]);
});

test('the device reference rides on the envelope, not inside the request',()=>{
  const sessionToken='t'.repeat(43);
  const request:AiTerminalRequest={requestId:'b'.repeat(20),operation:'list'};
  const envelope=normalizeRemoteTerminalRequest({type:'terminal.request',sessionToken,request,device:'ab12ef3456789012'});
  expect(envelope.device).toBe('ab12ef3456789012');
  expect(Object.keys(envelope.request)).not.toContain('device');
  // 모양이 아닌 값은 거절한다(파일시스템도 DB도 아니지만, 참조는 커뮤니티 목록 조회의 입력이다).
  expect(()=>normalizeRemoteTerminalRequest({type:'terminal.request',sessionToken,request,device:'nope'})).toThrow();
  // 요청 안에 넣은 것은 그 요청의 키 검사가 거절한다 — 조용히 이 Mac에서 실행되지 않는다.
  expect(()=>normalizeRemoteTerminalRequest({type:'terminal.request',sessionToken,request:{...request,device:'ab12ef3456789012'}})).toThrow();
});

test('another device project page stays within one relay message',()=>{
  const projects=Array.from({length:140},(_,index)=>({targetId:'project-'+String(index).padStart(4,'0'),label:'프로젝트 이름 '+index}));
  const first=remoteCommunityProjects({projects,deviceName:'3호 맥',opsTargetId:'project-0000'},0);
  expect(first.projects.length).toBe(20);
  expect(first.hasMore).toBe(true);
  expect(first.total).toBe(140);
  expect(first.opsTargetId).toBe('project-0000');
  expect(new TextEncoder().encode(JSON.stringify(first)).length).toBeLessThan(8_000);
  const last=remoteCommunityProjects({projects,deviceName:'3호 맥'},6);
  expect(last.projects.length).toBe(20);
  expect(last.hasMore).toBe(false);
  // 이름 없는 답도 사람이 읽을 이름으로 떨어진다.
  expect(remoteCommunityProjects({},0).deviceName).toBe('다른 아젠투지');
});
