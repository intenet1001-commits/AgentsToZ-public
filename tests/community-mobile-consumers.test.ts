import {afterEach,expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createCommunityMobileConsumers,communityMobileWorkroomEffortPolicy} from '../src/communityMobileConsumers';
import {CommunityDeviceAuthorization,CommunityMobileUseSession} from '../src/communityMobilePrincipal';
import {RemoteTeamStore} from '../src/remoteTeamHost';
import {CommunityAdapterAuthorization} from '../src/communityAdapterAuthorization';
import type {CommunityMobileEffectGuard,CommunityMobilePrincipal} from '../src/communityMobileControlTypes';
const fixture=JSON.parse(readFileSync(new URL('../native/screen-control/Tests/Fixtures/community-mobile-control-v2.json',import.meta.url),'utf8'));
const clean:(()=>void)[]=[];afterEach(()=>{for(const f of clean.splice(0))f();});
async function setup(){
  const now=fixture.now,authority=fixture.authority;
  const mobile=await CommunityDeviceAuthorization.fromEnvelope(fixture.envelopes.mobile,authority,{deviceKind:'mobile',communityId:fixture.mobileAuthorization.communityId,deviceId:fixture.mobileAuthorization.deviceId},now);
  const receiver=await CommunityDeviceAuthorization.fromEnvelope(fixture.envelopes.receiver,authority,{deviceKind:'desktop',communityId:fixture.receiverAuthorization.communityId,deviceId:fixture.receiverAuthorization.deviceId},now);
  const use=await CommunityMobileUseSession.fromEnvelope(fixture.envelopes.use,mobile,{sessionId:fixture.useSession.sessionId},now),principal={receiver,mobile,use};
  const store=new RemoteTeamStore(null);clean.push(()=>store.close());const state={allowed:true,live:true,launches:0,inputs:0,browser:0,settings:0,workroomCurrent:true,revokeDuringWorkroomRead:false,nativeReads:0,revokeOnNativeRead:0,policy:'auto' as 'auto'|'recommend'|'off'};
  const project={projectId:'registered-project',identity:'a'.repeat(64),name:'시험 프로젝트',isCurrent:()=>state.allowed},scope={grantScope:createHash('sha256').update(JSON.stringify([receiver.body.communityId,receiver.body.enrollmentId,receiver.body.controlKey])).digest('hex'),active:()=>state.live};
  const teams=new Map<string,any>();
  const service={store:{byRequest:(id:string)=>[...teams.values()].find(t=>t.requestId===id)??null,get:(id:string)=>teams.get(id)??null,save:(t:any)=>teams.set(t.id,t)},refreshMembers(){},
    create:async(r:any,_caller:any,guard:any)=>{await guard.beforeEffect();expect(guard.active()).toBe(true);state.launches++;const team={id:crypto.randomUUID(),requestId:r.requestId,projectId:r.portId,state:'active',members:[{id:'m',sessionId:'fixture-session',targetId:'fixture-target',execution:{kind:'workroom'},state:'working'}]};teams.set(team.id,team);return{team};},
    host:{session:()=>({state:'running'}),instruct:async(i:any)=>{await i.guard.beforeEffect();state.inputs++;return'written';},close:async()=>{state.inputs++;}}};
  const adapter=new CommunityAdapterAuthorization({verifiedMain:true,request:async r=>{state.nativeReads++;if(state.nativeReads===state.revokeOnNativeRead)state.workroomCurrent=false;return{success:true,halted:false,authorized:state.live,capability:r.capability,communityId:receiver.body.communityId,profileId:receiver.body.profileId,deviceId:receiver.body.deviceId,revision:receiver.body.revision,expiresAt:now+90_000,desktopGrant:false};}},()=>now);
  const consumers=createCommunityMobileConsumers({teams:{store,service:()=>service as never,projects:async()=>[project],authorizeOwn:async()=>scope},
    adapter,now:()=>now,effortSetting:{get:()=>state.policy==='auto',set:()=>false,getMode:()=>state.policy},workrooms:async()=>{await Promise.resolve();if(state.revokeDuringWorkroomRead)state.workroomCurrent=false;return state.allowed?[{sessionId:'fixture-session',targetId:'fixture-target',label:'실제 허용 워크룸',isCurrent:()=>state.allowed&&state.workroomCurrent}]:[];},
    terminal:{runningSession:()=>({targetId:'fixture-target'}) as never,workspaceEffort:()=>({mode:state.policy,auto:state.policy==='auto'}),reevaluateCommonEffort:async i=>{const p=await i.effortPolicy({get:()=>state.policy==='auto',set:()=>false,getMode:()=>state.policy});await p.beforeEffect?.();if(p.mode==='auto')state.settings++;return{mode:p.mode,auto:p.mode==='auto'};}},
    browser:{mobileContexts:()=>state.allowed?[{workspaceId:'fixture-workspace',epoch:3,sessionId:'fixture-session',targetId:'fixture-target',label:'허용 브라우저'}]:[],mobileAgent:async(_w,_e,r,g)=>{await g.beforeEffect();if(!g.active())throw Error('revoked');state.browser++;return{success:true,workspace:{receipt:{state:'applied',id:r.requestId},observation:{id:'observed',title:'제목',text:'문서',elements:[{selector:'#ok',name:'확인',role:'button'}]}}} as never;}},
  });
  const guard=(id=fixture.effect.operationId):CommunityMobileEffectGuard=>({operationId:id,createdAt:fixture.effect.createdAt,active:()=>state.live,beforeEffect:async()=>{if(!state.live)throw Error('revoked');}});
  return{consumers,principal,store,state,project,scope,guard};
}
test('prepare is effect-free, projects are default-none and mobile Teams has no invented portal endpoint',async()=>{
  const f=await setup(),c={kind:'teams',op:'projects'},p=await f.consumers.prepare(f.principal,'mobile-teams','query',c);
  expect(f.state.launches).toBe(0);expect(await p.run(f.guard())).toEqual({projects:[]});f.store.set(0,[f.project],f.scope.grantScope,()=>true);
  const rows=await p.run(f.guard()) as {projects:{context:string;name:string}[]};expect(rows.projects).toHaveLength(1);expect(JSON.stringify(rows)).not.toContain('registered-project');expect(JSON.stringify(rows)).not.toContain('endpoint');
  const create=await f.consumers.prepare(f.principal,'mobile-teams','effect',{kind:'teams',op:'create',project:rows.projects[0]!.context,title:'팀',goal:'검토',member:{agent:'codex',task:'검토해 주세요',model:'gpt-6.1-sol',effort:'medium'}});
  expect(f.state.launches).toBe(0);const first=await create.run(f.guard());expect(first).toMatchObject({outcome:'accepted'});expect(f.state.launches).toBe(1);
  expect(await create.run(f.guard())).toEqual(first);expect(f.state.launches).toBe(1);
  expect(await f.consumers.readReceipt!(f.principal,'mobile-teams',create.scope,fixture.effect.operationId,fixture.effect.createdAt)).toEqual({state:'result',result:first});
  f.state.allowed=false;expect(await f.consumers.authorizeReceipt(f.principal,'mobile-teams',create.scope)).toBe(false);await expect(create.run(f.guard())).rejects.toThrow('권한');expect(f.state.launches).toBe(1);
});
test('fake principals, alternate commands and caller-owned scopes never reach actual consumers',async()=>{
  const f=await setup();await expect(f.consumers.prepare({...f.principal,mobile:{...f.principal.mobile}} as unknown as CommunityMobilePrincipal,'mobile-teams','query',{kind:'teams',op:'projects'})).rejects.toThrow('등록');
  for(const c of [{kind:'teams',op:'create',path:'/anywhere'},{kind:'browser',op:'connect'},{kind:'agent-settings',op:'set-mode',mode:'auto'}])await expect(f.consumers.prepare(f.principal,`mobile-${c.kind}` as never,'effect',c)).rejects.toThrow();
  expect(f.state.launches+f.state.settings+f.state.browser).toBe(0);
});
test.each(['auto','recommend','off'] as const)('mobile settings reuses the existing %s CLI policy and never mutates it',async mode=>{
  const f=await setup();f.state.policy=mode;const list=await f.consumers.prepare(f.principal,'mobile-agent-settings','query',{kind:'agent-settings',op:'contexts'}),r=await list.run(f.guard()) as {contexts:{context:string}[]};
  const action=await f.consumers.prepare(f.principal,'mobile-agent-settings','effect',{kind:'agent-settings',op:'evaluate',context:r.contexts[0]!.context,text:'권한 격리 검토'});expect(f.state.settings).toBe(0);await action.run(f.guard());expect(f.state.settings).toBe(mode==='auto'?1:0);expect(f.state.policy).toBe(mode);
});
test('owned browser effects bind current context, epoch and observed selector; withdrawal prevents the queued effect',async()=>{
  const f=await setup(),list=await f.consumers.prepare(f.principal,'mobile-browser','query',{kind:'browser',op:'contexts'}),r=await list.run(f.guard()) as {contexts:{context:string}[]};
  const prepared=await f.consumers.prepare(f.principal,'mobile-browser','effect',{kind:'browser',op:'click',context:r.contexts[0]!.context,observationId:'observed',selector:'#ok'});expect(f.state.browser).toBe(0);f.state.live=false;await expect(prepared.run(f.guard())).rejects.toThrow();expect(f.state.browser).toBe(0);
});

test('a verified mobile Teams-only scope cannot turn its receiver CLI effort auto on',async()=>{
  const f=await setup(),point=Buffer.from(fixture.authority.issuerPublicKey,'base64url'),d=Buffer.alloc(32);d[31]=fixture.softwareKeyScalars.issuer;
  const key=await crypto.subtle.importKey('jwk',{kty:'EC',crv:'P-256',x:point.subarray(1,33).toString('base64url'),y:point.subarray(33).toString('base64url'),d:d.toString('base64url')},{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const narrow=async(envelope:any)=>{const value=JSON.parse(Buffer.from(envelope.payload,'base64url').toString('utf8'));value[4].capabilities=value[4].capabilities.filter((v:string)=>v!=='computer-use.agent-settings');const bytes=Buffer.from(JSON.stringify(value));return{payload:bytes.toString('base64url'),signature:Buffer.from(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,Buffer.concat([Buffer.from('agentstoz.community-access.response/v2\0'),bytes]))).toString('base64url')};};
  const mobile=await CommunityDeviceAuthorization.fromEnvelope(await narrow(fixture.envelopes.mobile),fixture.authority,{deviceKind:'mobile',communityId:fixture.mobileAuthorization.communityId,deviceId:fixture.mobileAuthorization.deviceId},fixture.now);
  const use=await CommunityMobileUseSession.fromEnvelope(await narrow(fixture.envelopes.use),mobile,{sessionId:fixture.useSession.sessionId},fixture.now);let nativeReads=0;
  const adapter=new CommunityAdapterAuthorization({verifiedMain:true,request:async()=>{nativeReads++;throw Error('must not request settings');}},()=>fixture.now);
  const policy=await communityMobileWorkroomEffortPolicy(adapter,{receiver:f.principal.receiver,mobile,use},f.guard(),()=>fixture.now)({get:()=>true,set:()=>false,getMode:()=> 'auto'});
  expect(policy.mode).toBe('off');expect(await policy.beforeEffect?.()).toBe(false);expect(nativeReads).toBe(0);
});

async function changedReceiver(change:(body:any)=>void){
  const value=JSON.parse(Buffer.from(fixture.envelopes.receiver.payload,'base64url').toString('utf8'));change(value[4]);
  const point=Buffer.from(fixture.authority.issuerPublicKey,'base64url'),d=Buffer.alloc(32);d[31]=fixture.softwareKeyScalars.issuer;
  const key=await crypto.subtle.importKey('jwk',{kty:'EC',crv:'P-256',x:point.subarray(1,33).toString('base64url'),y:point.subarray(33).toString('base64url'),d:d.toString('base64url')},{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const bytes=Buffer.from(JSON.stringify(value)),envelope={payload:bytes.toString('base64url'),signature:Buffer.from(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,Buffer.concat([Buffer.from('agentstoz.community-access.response/v2\0'),bytes]))).toString('base64url')};
  return CommunityDeviceAuthorization.fromEnvelope(envelope,fixture.authority,{deviceKind:'desktop',communityId:fixture.receiverAuthorization.communityId,deviceId:fixture.receiverAuthorization.deviceId},fixture.now);
}
test.each(['teams','agent-settings','browser'] as const)('immutable %s receipts survive an unrelated policy revision while execution contexts stay policy-pinned',async kind=>{
  const f=await setup(),purpose=`mobile-${kind}` as const;
  let command:Record<string,unknown>;
  if(kind==='teams'){
    f.store.set(0,[f.project],f.scope.grantScope,()=>true);const list=await f.consumers.prepare(f.principal,purpose,'query',{kind,op:'projects'}),rows=await list.run(f.guard()) as {projects:{context:string}[]};
    command={kind,op:'create',project:rows.projects[0]!.context,title:'팀',goal:'검토',member:{agent:'codex',task:'검토해 주세요',model:'gpt-6.1-sol',effort:'medium'}};
  }else{
    const list=await f.consumers.prepare(f.principal,purpose,'query',{kind,op:'contexts'}),rows=await list.run(f.guard()) as {contexts:{context:string}[]};
    command=kind==='browser'?{kind,op:'click',context:rows.contexts[0]!.context,observationId:'observed',selector:'#ok'}:{kind,op:'evaluate',context:rows.contexts[0]!.context,text:'권한 격리 검토'};
  }
  const action=await f.consumers.prepare(f.principal,purpose,'effect',command),original=await action.run(f.guard());
  const count=()=>f.state.launches+f.state.settings+f.state.browser,once=count();expect(once).toBe(1);
  const receiver=await changedReceiver(b=>{b.revision++;b.name='같은 Mac / 새 표시 이름';b.capabilities=b.capabilities.filter((c:string)=>c!==(kind==='browser'?'teams.run':'computer-use.browser'));}),current={...f.principal,receiver};
  expect(receiver.policyDigest).not.toBe(f.principal.receiver.policyDigest);
  expect(await f.consumers.authorizeReceipt(current,purpose,action.scope)).toBe(true);
  expect(await f.consumers.readReceipt!(current,purpose,action.scope,fixture.effect.operationId,fixture.effect.createdAt)).toEqual({state:'result',result:original});
  await expect(f.consumers.prepare(current,purpose,'effect',command)).rejects.toThrow('대상');
  // A duplicate backend execution remains an immutable receipt lookup, never another AI/PTY/browser action.
  expect(await action.run(f.guard())).toEqual(original);expect(count()).toBe(once);
  const required=kind==='teams'?'teams.run':`computer-use.${kind}`;
  const revoked={...f.principal,receiver:await changedReceiver(b=>{b.revision++;b.capabilities=b.capabilities.filter((c:string)=>c!==required);})};
  expect(await f.consumers.authorizeReceipt(revoked,purpose,action.scope)).toBe(false);
  await expect(f.consumers.readReceipt!(revoked,purpose,action.scope,fixture.effect.operationId,fixture.effect.createdAt)).rejects.toThrow('범위');
  const differentEpoch={...f.principal,receiver:await changedReceiver(b=>{b.revision++;b.keyEpoch++;})};
  expect(await f.consumers.authorizeReceipt(differentEpoch,purpose,action.scope)).toBe(false);
  f.state.allowed=false;expect(await f.consumers.authorizeReceipt(current,purpose,action.scope)).toBe(false);expect(count()).toBe(once);
});

test.each(['endpoint-during-resolve','initial-native-policy','final-native-policy'] as const)('settings withdrawal at %s never reaches the existing CLI effect',async race=>{
  const f=await setup(),purpose='mobile-agent-settings',kind='agent-settings',list=await f.consumers.prepare(f.principal,purpose,'query',{kind,op:'contexts'}),rows=await list.run(f.guard()) as {contexts:{context:string}[]};
  const command={kind,op:'evaluate',context:rows.contexts[0]!.context,text:'권한 격리와 동시성을 검토해 주세요'},action=await f.consumers.prepare(f.principal,purpose,'effect',command);
  expect(f.state.settings).toBe(0);
  if(race==='endpoint-during-resolve')f.state.revokeDuringWorkroomRead=true;
  else f.state.revokeOnNativeRead=race==='initial-native-policy'?1:2;
  await expect(action.run(f.guard())).rejects.toThrow();expect(f.state.settings).toBe(0);
  if(race==='final-native-policy')expect(f.state.nativeReads).toBe(2);
  expect(await f.consumers.authorizeReceipt(f.principal,purpose,action.scope)).toBe(false);
});
