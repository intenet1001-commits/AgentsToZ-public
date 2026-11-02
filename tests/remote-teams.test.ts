import {describe,test,expect} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {RemoteTeamHost,RemoteTeamStore,type RemoteTeamScope} from '../src/remoteTeamHost';
import {RemoteTeamClient} from '../src/remoteTeamClient';
import {parseRemoteTeamRequest,parseRemoteTeamResponse,parseTeamMemberWithRemote,type RemoteTeamRef,type RemoteTeamResponse} from '../src/remoteTeamProtocol';
import {WorkroomTeamService,WorkroomTeamStore,parseWorkroomTeamRequest,type WorkroomTeamHost,type TeamEffectGuard} from '../src/workroomTeam';
import {createWorkroomTeamHost} from '../src/workroomTeamHost';
import {runTeamMemberOperation} from '../src/workroomTeamMemberOperation';
import {agentsToZUseMcpActionForTool,AGENTSTOZ_USE_MCP_TOOLS} from '../agentstoz-use-mcp-server';
import {agentstozMcpAgentChoice} from '../src/agentstozMcpAgentChoice';

const sender=randomUUID(),receiver=randomUUID(),senderEndpoint=randomUUID(),receiverEndpoint=randomUUID();
const from={deviceId:sender,name:'sender',endpointId:senderEndpoint};
const target={deviceId:receiver,endpointId:receiverEndpoint,projectId:'project-a'};
const create={kind:'team' as const,version:1 as const,targetDeviceId:receiver,op:'create' as const,requestId:'original-create-01',projectId:'project-a',title:'Remote test',goal:'Complete a fixture-only task',member:{agent:'codex' as const,task:'Implement the fixture',surface:undefined}};
function localHost(){
  const starts:unknown[]=[],inputs:unknown[]=[],closes:string[]=[],worktrees:string[]=[],removed:string[]=[],sessions=new Set<string>();
  let beforeWorktree:()=>Promise<void>=async()=>{};
  const host:WorkroomTeamHost={
    resolveProject:async id=>({projectId:id,projectName:'Receiver project',canonicalPath:'/receiver/project'}),
    primary:async path=>({path,base:path,head:'a'.repeat(40),branch:'main',trackedChanges:[],untracked:0}),
    addWorktree:async(_root,path)=>{worktrees.push(path);await beforeWorktree();},worktreeTargetId:(_id,path)=>'worktree-'+path.split('/').pop(),
    start:async input=>{await input.guard?.beforeEffect();if(input.guard&&!input.guard.active())throw Error('revoked');starts.push(input);const sessionId='fixture-session-'+starts.length;sessions.add(sessionId);return{sessionId};},
    session:id=>({state:sessions.has(id)?'running':'exited',lastOutputAt:null}),sessionForTarget:async()=>null,attachable:async()=>null,
    instruct:async input=>{await input.guard?.beforeEffect();if(input.guard&&!input.guard.active())throw Error('revoked');inputs.push(input);return'written';},
    close:async id=>{closes.push(id);sessions.delete(id);},branchGit:async()=>null,removeWorktree:async(_root,path)=>{removed.push(path);return'removed';},deleteMergedBranch:async()=> 'deleted',
  };
  return{host,starts,inputs,closes,worktrees,removed,pause: (f:()=>Promise<void>)=>{beforeWorktree=f;}};
}
function fixture(store=new RemoteTeamStore(null),teamStore=new WorkroomTeamStore(null)){
  const machine=localHost(),service=new WorkroomTeamService(machine.host,teamStore),scopeState={enabled:true,grantScope:'community-one',projectIdentity:'same-registered-inode',registered:true};
  const host=new RemoteTeamHost({store,service:()=>service,projects:async()=>scopeState.registered?[{projectId:'project-a',name:'A',identity:scopeState.projectIdentity,isCurrent:()=>scopeState.registered}]:[],
    authorize:async peer=>{if(!scopeState.enabled)throw Error('native current consent refused');return{subject:peer?`${peer.deviceId}:${peer.endpointId}`:'self',grantScope:scopeState.grantScope,deviceId:receiver,endpointId:receiverEndpoint,active:()=>scopeState.enabled} satisfies RemoteTeamScope;}});
  const allow=()=>host.manage({operation:'set-permissions',expectedRevision:store.revision(),projectIds:['project-a']});
  const dispatch=(request:unknown)=>host.dispatch(request,from,randomUUID());
  return{store,service,host,machine,scopeState,allow,dispatch};
}
const request=()=>({...create,member:{agent:'codex',task:'Implement the fixture'}});
function resultRef(result:RemoteTeamResponse):RemoteTeamRef{if(result.outcome!=='settled')throw Error('expected settled');return result.status.ref;}

describe('receiver project permission and durable remote execution',()=>{
  test('defaults to none; only Main management can select projects with CAS',async()=>{
    const f=fixture();expect((await f.host.permissions()).projects[0]?.allowed).toBe(false);
    await expect(f.dispatch(request())).rejects.toThrow('먼저 허용');expect(f.machine.starts).toHaveLength(0);
    await expect(f.dispatch({kind:'team',version:1,targetDeviceId:receiver,op:'set-permissions',projectIds:['project-a']})).rejects.toThrow();
    await f.allow();expect((await f.host.permissions()).projects[0]?.allowed).toBe(true);
    await expect(f.host.manage({operation:'set-permissions',expectedRevision:0,projectIds:[]})).rejects.toThrow('바뀌었습니다');
    expect((await f.dispatch(request())).result.outcome).toBe('settled');expect(f.machine.starts).toHaveLength(1);f.store.close();
  });
  test('same original ID replays; changed body and a different sender cannot drive the owned reference',async()=>{
    const f=fixture();await f.allow();const first=(await f.dispatch(request())).result,ref=resultRef(first);
    expect((await f.dispatch(request())).result).toEqual(first);expect(f.machine.starts).toHaveLength(1);
    await expect(f.dispatch({...request(),goal:'different'})).rejects.toThrow('내용이 바뀌었습니다');
    await expect(f.host.dispatch({kind:'team',version:1,targetDeviceId:receiver,op:'status',ref},{...from,endpointId:randomUUID()},randomUUID())).rejects.toThrow('아닙니다');
    expect(Object.keys(ref).sort()).toEqual(['kind','remoteRef','deviceId','endpointId','generation','projectId'].sort());
    expect(JSON.stringify(first)).not.toContain('/receiver');expect(JSON.stringify(first)).not.toContain('sessionId');f.store.close();
  });
  test('recipient device, ref generation, project identity and enrollment scope are exact',async()=>{
    const f=fixture();await f.allow();await expect(f.dispatch({...request(),targetDeviceId:randomUUID()})).rejects.toThrow('다릅니다');
    const ref=resultRef((await f.dispatch(request())).result);
    await expect(f.dispatch({kind:'team',version:1,targetDeviceId:receiver,op:'status',ref:{...ref,generation:randomUUID()}})).rejects.toThrow('아닙니다');
    f.scopeState.projectIdentity='new-inode';await expect(f.dispatch({kind:'team',version:1,targetDeviceId:receiver,op:'status',ref})).rejects.toThrow('먼저 허용');
    f.scopeState.projectIdentity='same-registered-inode';f.scopeState.grantScope='another-community';expect((await f.host.permissions()).projects[0]?.allowed).toBe(false);
    await expect(f.dispatch({...request(),requestId:'new-community-request'})).rejects.toThrow('먼저 허용');expect(f.machine.starts).toHaveLength(1);f.store.close();
  });
  test('permission withdrawal while worktree creation awaits blocks actual launch and keeps the checkout',async()=>{
    const f=fixture();await f.allow();let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(r=>{entered=r;});
    f.machine.pause(async()=>{entered();await new Promise<void>(r=>{release=r;});});
    const running=f.dispatch(request());await waiting;
    await f.host.manage({operation:'set-permissions',expectedRevision:f.store.revision(),projectIds:[]});release();
    const answer=await running;expect(answer.result.outcome).toBe('settled');expect(f.machine.starts).toHaveLength(0);expect(f.machine.worktrees).toHaveLength(1);expect(f.machine.removed).toHaveLength(0);f.store.close();
  });
  test('instruction/cancel receipts never duplicate input and cancellation preserves worktrees and branches',async()=>{
    const f=fixture();await f.allow();const ref=resultRef((await f.dispatch(request())).result);
    const instruct={kind:'team',version:1,targetDeviceId:receiver,op:'instruct',requestId:'original-input-01',ref,text:'Refine fixture'};
    expect((await f.dispatch(instruct)).result).toEqual({outcome:'instructed',delivery:'verified'});await f.dispatch(instruct);expect(f.machine.inputs).toHaveLength(1);
    const cancel={kind:'team',version:1,targetDeviceId:receiver,op:'cancel',requestId:'original-cancel-01',ref};await f.dispatch(cancel);await f.dispatch(cancel);
    expect(f.machine.closes).toHaveLength(1);expect(f.machine.removed).toHaveLength(0);
    f.scopeState.enabled=false;await expect(f.dispatch({kind:'team',version:1,targetDeviceId:receiver,op:'status',ref})).rejects.toThrow();f.store.close();
  });
  test('restart keeps a started-but-unsettled receipt unknown instead of starting another AI',async()=>{
    const root=join(import.meta.dir,'../.agentstoz/maintainer/manual/community-control-auth');mkdirSync(root,{recursive:true});const directory=mkdtempSync(join(root,'remote-fixture-'));
    try{let store=new RemoteTeamStore(join(directory,'ledger.sqlite'));const f=fixture(store);await f.allow();
      store.prepare(`${sender}:${senderEndpoint}`,'lost-create-id','precommitted-fingerprint');store.close();
      store=new RemoteTeamStore(join(directory,'ledger.sqlite'));const resumed=fixture(store);const answer=await resumed.dispatch({kind:'team',version:1,targetDeviceId:receiver,op:'receipt',requestId:'lost-create-id'});
      expect(answer.result).toEqual({outcome:'unknown'});expect(resumed.machine.starts).toHaveLength(0);store.close();
    }finally{rmSync(directory,{recursive:true,force:true});}
  });
});

describe('sender opaque proxy, authenticated dispatcher seam and existing Teams runtime',()=>{
  function channel(f:ReturnType<typeof fixture>){
    const answers=new Map<string,Record<string,unknown>>(),sent:Record<string,unknown>[]=[],fault={drop:false,before:false};
    const transport={controlCall:async(endpoint:string,r:Record<string,unknown>,_timeout:number,options:{transportPurpose:'teams';onSent?:(r:{controlId:string;sourceEndpointId:string;targetDeviceId:string|null})=>void})=>{
      expect(endpoint).toBe(receiverEndpoint);expect(options.transportPurpose).toBe('teams');sent.push(r);if(fault.before)throw Error('admission unknown');
      const id=randomUUID();options.onSent?.({controlId:id,sourceEndpointId:senderEndpoint,targetDeviceId:receiver});
      const response={ok:true,body:await f.host.dispatch(r,from,id)};answers.set(id,response);if(fault.drop){fault.drop=false;throw Error('reply lost');}return response;
    },controlResult:async(ids:readonly string[],source:string)=>{expect(source).toBe(senderEndpoint);return{results:ids.flatMap(controlId=>answers.has(controlId)?[{controlId,response:answers.get(controlId)!}]:[]),waiting:ids.filter(id=>!answers.has(id))};}};
    return{transport,sent,fault};
  }
  test('lost create reply resolves its original receipt; observe never repeats the launch',async()=>{
    const f=fixture();await f.allow();const c=channel(f),store=new RemoteTeamStore(null),client=new RemoteTeamClient(store,c.transport);c.fault.drop=true;
    const started=await client.start({target,title:'Remote',goal:'Fixture',member:{agent:'codex',task:'Fixture'},requestId:'leader-original-01'});
    expect(started.state).toBe('unknown');expect((await client.observe(started.ref)).state).toBe('working');expect(f.machine.starts).toHaveLength(1);
    expect(c.sent.filter(r=>r.op==='create')).toHaveLength(1);
    await client.send(started.ref,'Next fixture','input-original-01');await client.send(started.ref,'Next fixture','input-original-01');expect(f.machine.inputs).toHaveLength(1);
    await client.close(started.ref);await client.close(started.ref);expect(f.machine.closes).toHaveLength(1);store.close();f.store.close();
  });
  test('unknown send before admission is never retried under another control ID',async()=>{
    const f=fixture();await f.allow();const c=channel(f),store=new RemoteTeamStore(null),client=new RemoteTeamClient(store,c.transport);c.fault.before=true;
    const started=await client.start({target,title:'Remote',goal:'Fixture',member:{agent:'codex',task:'Fixture'},requestId:'leader-original-02'});c.fault.before=false;
    await client.observe(started.ref);expect(c.sent.filter(r=>r.op==='create')).toHaveLength(1);expect(f.machine.starts).toHaveLength(0);store.close();f.store.close();
  });
  test('full sender receipts refuse a fresh launch before allocating another proxy record',async()=>{
    const f=fixture(),store=new RemoteTeamStore(null),c=channel(f),client=new RemoteTeamClient(store,c.transport);
    store.db.transaction(()=>{for(let i=0;i<4096;i++)store.db.query('INSERT INTO client_calls(id,fingerprint) VALUES(?,?)').run('fixture-'+i,'fixture');})();
    await expect(client.start({target,title:'Remote',goal:'Fixture',member:{agent:'codex',task:'Fixture'},requestId:'capacity-original-id'})).rejects.toThrow('한도');
    expect((store.db.query('SELECT count(*) AS n FROM client_refs').get() as {n:number}).n).toBe(0);expect(c.sent).toHaveLength(0);store.close();f.store.close();
  });
  test('the existing local team service creates a remote member through its actual proxy instead of a local checkout',async()=>{
    const f=fixture();await f.allow();const c=channel(f),store=new RemoteTeamStore(null),client=new RemoteTeamClient(store,c.transport),local=localHost();local.host.remote=client;
    const service=new WorkroomTeamService(local.host,new WorkroomTeamStore(null));
    const parsed=parseWorkroomTeamRequest({op:'create',portId:'leader-project',requestId:'mixed-original-id',title:'Across Macs',goal:'Fixture',members:[{agent:'codex',surface:'internal',task:'Fixture',remote:target}]});if(parsed.op!=='create')throw Error('create expected');
    const {team}=await service.create(parsed,null);expect(team.members[0]?.execution?.kind).toBe('remote');expect(team.members[0]?.worktreePath).toBe('');expect(team.members[0]?.branch).toBe('');
    expect(local.worktrees).toHaveLength(0);expect(local.starts).toHaveLength(0);expect(f.machine.starts).toHaveLength(1);
    await runTeamMemberOperation({service,external:{} as never,readWorkroom:async()=>{throw Error('no local terminal');}},{op:'member',teamId:team.id,memberId:'m1',operation:'send',requestId:'leader-instruct-id',text:'Next fixture'},null);expect(f.machine.inputs).toHaveLength(1);
    await service.close({op:'close',teamId:team.id,deleteMergedBranches:true},null);expect(f.machine.closes).toHaveLength(1);expect(local.removed).toHaveLength(0);expect(f.machine.removed).toHaveLength(0);store.close();f.store.close();
  });
  test('strict MCP discovery and member selection retain explicit remote IDs and refuse authority shortcuts',()=>{
    expect(AGENTSTOZ_USE_MCP_TOOLS.some(t=>t.name==='agentstoz_use_team_remote_devices')).toBe(true);
    expect(agentsToZUseMcpActionForTool('agentstoz_use_team_remote_devices',{},'control-port')).toMatchObject({action:'workroom-team',team:{op:'remote-devices'}});
    expect(AGENTSTOZ_USE_MCP_TOOLS.some(t=>t.name==='agentstoz_use_team_remote_projects')).toBe(true);
    expect(agentsToZUseMcpActionForTool('agentstoz_use_team_remote_projects',{deviceId:receiver,endpointId:receiverEndpoint},'control-port')).toMatchObject({action:'workroom-team',team:{op:'remote-projects',deviceId:receiver,endpointId:receiverEndpoint}});
    expect(parseTeamMemberWithRemote({agent:'codex',surface:'internal',task:'Fixture',remote:target}).remote).toEqual(target);
    expect(agentstozMcpAgentChoice('agentstoz_use_create_team',{members:[{task:'Fixture',surface:'internal',remote:target}]})).toMatchObject({selectionRequired:true,stage:'agent'});
    expect(()=>parseWorkroomTeamRequest({op:'remote-devices',projectIds:['private']})).toThrow();
    for(const extra of [{path:'/other'},{bypassPermissions:true},{sessionId:'some-session'},{remote:target}])expect(()=>parseRemoteTeamRequest({...request(),member:{...request().member,...extra}})).toThrow();
    for(const extra of [{accountId:'x'},{bypassPermissions:false},{surface:'app'},{launchOptions:{}},{sessionId:'open-session'}])expect(()=>parseTeamMemberWithRemote({agent:'codex',surface:'internal',task:'Fixture',remote:target,...extra})).toThrow();
    expect(()=>parseRemoteTeamResponse({outcome:'instructed',delivery:'verified',sessionId:'private-session'})).toThrow();
    expect(()=>parseRemoteTeamResponse({outcome:'unknown',ref:null})).toThrow();
    expect(()=>parseRemoteTeamResponse({outcome:'projects',projects:[{projectId:'project-a',name:'A',path:'/private'}]})).toThrow();
  });
  test('native terminal spawn and input gates preserve a late common-consent withdrawal',async()=>{
    let active=true,spawned=false;const guard:TeamEffectGuard={active:()=>active,beforeEffect:async()=>{if(!active)throw Error('withdrawn');}};
    const host=createWorkroomTeamHost({gitPath:'/fixture/git',resolveProject:async()=>{throw Error('unused');},targetCwd:async()=>null,ensureExclude:async()=>{},seedConfig:()=>{},withLease:async(_p,_l,f)=>f(),terminal:{
      perform:async(_body,_authority,options)=>{await options?.startGuard?.({} as never);active=false;options?.startEffectGate?.(()=>{spawned=true;});return{session:{id:'fixture'}} as never;},runningSession:()=>null,retiredSession:()=>null,sessionActivity:()=>({} as never),wholeSubmissionSupported:()=>true,submitHostInstruction:async input=>{await input.beforeInput?.();active=false;input.writeEffectGate?.(()=>{spawned=true;});return{state:'written'};},
    }});
    await expect(host.start({targetId:'fixture',agent:'codex',prompt:'Fixture',requestId:'original-guard',effort:{requestText:'Fixture'},guard})).rejects.toThrow('변경');expect(spawned).toBe(false);
    active=true;await expect(host.instruct({sessionId:'fixture',prompt:'Fixture',requestId:'original-input',guard})).rejects.toThrow('변경');expect(spawned).toBe(false);
  });
});
