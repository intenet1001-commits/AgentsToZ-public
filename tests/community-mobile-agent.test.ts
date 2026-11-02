import {afterEach,expect,test} from 'bun:test';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCommunityMobileAgent,communityMobileOpsEffortPolicy,communityMobileOpsMemberActive} from '../src/communityMobileAgent';
import {CommunityDeviceAuthorization,CommunityMobileUseSession} from '../src/communityMobilePrincipal';
import {CommunityAdapterAuthorization} from '../src/communityAdapterAuthorization';
import {OpsRequestHost} from '../src/opsRequestHost';
import {OpsRequestStore,type OpsRequestMobileOrigin} from '../src/opsRequestStore';
import type {CommunityMobileEffectGuard,CommunityMobileHostIdentity,CommunityMobilePrincipal} from '../src/communityMobileControlTypes';

const fixture=JSON.parse(readFileSync(new URL('../native/screen-control/Tests/Fixtures/community-mobile-control-v2.json',import.meta.url),'utf8'));
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const provider={read:async()=>Buffer.alloc(32,9),create:async()=>Buffer.alloc(32,9)};
async function envelope(source:any,at:number,change:(body:any)=>void=()=>{}){
  const value=JSON.parse(Buffer.from(source.payload,'base64url').toString()),body=value[4];value[3]=at;body.issuedAt=at;body.expiresAt=at+90_000;
  if(body.lastHumanAt!==undefined){body.lastHumanAt=at;body.idleExpiresAt=at+3600_000;}change(body);
  const point=Buffer.from(fixture.authority.issuerPublicKey,'base64url'),d=Buffer.alloc(32);d[31]=fixture.softwareKeyScalars.issuer;
  const key=await crypto.subtle.importKey('jwk',{kty:'EC',crv:'P-256',x:point.subarray(1,33).toString('base64url'),y:point.subarray(33).toString('base64url'),d:d.toString('base64url')},{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const bytes=Buffer.from(JSON.stringify(value));return {payload:bytes.toString('base64url'),signature:Buffer.from(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,Buffer.concat([Buffer.from('agentstoz.community-access.response/v2\0'),bytes]))).toString('base64url')};
}
async function principal(at:number,session=fixture.useSession.sessionId):Promise<CommunityMobilePrincipal>{
  const authority=fixture.authority,cid=fixture.mobileAuthorization.communityId;
  const mobile=await CommunityDeviceAuthorization.fromEnvelope(await envelope(fixture.envelopes.mobile,at),authority,{deviceKind:'mobile',communityId:cid,deviceId:fixture.mobileAuthorization.deviceId},at);
  const receiver=await CommunityDeviceAuthorization.fromEnvelope(await envelope(fixture.envelopes.receiver,at),authority,{deviceKind:'desktop',communityId:cid,deviceId:fixture.receiverAuthorization.deviceId},at);
  const use=await CommunityMobileUseSession.fromEnvelope(await envelope(fixture.envelopes.use,at,b=>{b.sessionId=session;}),mobile,{sessionId:session},at);return {mobile,receiver,use};
}
async function setup(){
  const root=mkdtempSync(join(tmpdir(),'atz-mobile-ops-'));roots.push(root);let p=await principal(fixture.now);
  const state={now:fixture.now,scope:'a'.repeat(64),identity:'b'.repeat(64),member:true,target:true,episode:true,native:true,launches:0};
  const starts:any[]=[],store=new OpsRequestStore(root,provider),deps={store,now:()=>state.now,binding:()=>({scope:state.scope,targetId:'actual-registered-ops',agent:'claude' as const}),peerActive:async()=>state.member,
    start:async(input:any)=>{state.launches++;starts.push(input);return {id:crypto.randomUUID(),targetId:input.targetId,agent:input.agent,state:'running',createdAt:new Date(state.now).toISOString(),exitCode:null,cols:100,rows:28} as any;},inspect:async()=>({state:'running' as const,awaitingAnswer:false})};
  let host=new OpsRequestHost(deps);
  const consumers=()=>createCommunityMobileAgent({host,target:async()=>{const current=state.identity,scope=state.scope;return state.target?{identity:current,scope,name:'3호 OPS',isCurrent:()=>state.target&&current===state.identity&&scope===state.scope}:null;},now:()=>state.now});
  const guard=(id=fixture.effect.operationId):CommunityMobileEffectGuard=>({operationId:id,createdAt:Number.parseInt(id.slice(0,8)+id.slice(9,13),16),active:()=>state.member,beforeEffect:async()=>{if(!state.member)throw Error('revoked');}});
  const targets=async()=>{const q=await consumers().prepare(p,'mobile-agent','query',{kind:'agent',op:'targets'});return await q.run(guard()) as {targets:{context:string;name:string}[]};};
  const submit=async(id=fixture.effect.operationId,text='등록된 프로젝트 상태를 확인해 주세요')=>{const rows=await targets();return consumers().prepare(p,'mobile-agent','effect',{kind:'agent',op:'submit',context:rows.targets[0]!.context,text});};
  const identity={authorization:async()=>{if(!state.native)throw Error('Native off');return p.receiver;},directory:async()=>state.member?[p.mobile]:[],currentUse:async(_purpose:any,mobile:any,session:string)=>{if(!state.episode||session!==p.use.body.sessionId||mobile!==p.mobile)throw Error('episode closed');return p.use;}} as unknown as CommunityMobileHostIdentity;
  const origin=():OpsRequestMobileOrigin=>({kind:'mobile',profileId:p.mobile.body.profileId,communityId:p.mobile.body.communityId,enrollmentId:p.mobile.body.enrollmentId,deviceId:p.mobile.body.deviceId,keyEpoch:p.mobile.body.keyEpoch,operationPublicKey:p.mobile.body.publicKey,initialUseId:p.use.body.sessionId,receiptOwner:p.mobile.receiptOwnerHash,name:p.mobile.body.name});
  return {root,state,store,starts,identity,origin,guard,targets,submit,consumers,deps,host:()=>host,p:()=>p,restart(){host=new OpsRequestHost(deps);},async refresh(session?:string){p=await principal(state.now,session);}};
}

test('actual OPS admission is durable, source-bound and starts only once across duplicate, episode change and receiver restart',async()=>{
  const f=await setup(),action=await f.submit();expect(f.state.launches).toBe(0);
  const accepted=await action.run(f.guard());expect(accepted).toEqual({accepted:true,ref:fixture.effect.operationId,createdAt:fixture.now});
  await action.run(f.guard());await f.host().tick();expect(f.state.launches).toBe(1);expect(f.starts[0].origin.kind).toBe('mobile');expect(f.starts[0].origin.endpointId).toBeUndefined();
  f.state.now+=1000;await f.refresh(crypto.randomUUID());
  const same=await f.submit();expect(await same.run(f.guard())).toEqual(accepted);expect(await f.consumers().readReceipt!(f.p(),'mobile-agent',same.scope,fixture.effect.operationId,fixture.now)).toEqual({state:'result',result:accepted});
  f.restart();await f.host().tick();expect(f.state.launches).toBe(1);expect(await same.run(f.guard())).toEqual(accepted);
  const status=await f.consumers().prepare(f.p(),'mobile-agent','query',{kind:'agent',op:'status',context:(await f.targets()).targets[0]!.context,ref:fixture.effect.operationId});
  const value=await status.run(f.guard());expect(value).toMatchObject({state:'unknown'});for(const privateField of ['sessionId','targetId','operationPublicKey','initialUseId','capability','endpointId'])expect(JSON.stringify(value)).not.toContain(privateField);
  await expect((await f.submit(undefined,'내용을 변경한 재전송')).run(f.guard())).rejects.toThrow('같은 요청 ID');
});
test('admission and recovered ACK retain the original mobile operation time despite real dispatch delay',async()=>{
  const f=await setup();f.state.now+=1789;const action=await f.submit(),ack=await action.run(f.guard());
  expect(ack).toEqual({accepted:true,ref:fixture.effect.operationId,createdAt:fixture.now});
  expect((await f.store.list(f.state.scope))[0]!.receipt.createdAt).toBe(fixture.now+1789);
  expect(await f.consumers().readReceipt!(f.p(),'mobile-agent',action.scope,fixture.effect.operationId,fixture.now)).toEqual({state:'result',result:ack});
});
test('forged principals, unsupported commands, missing OPS and withdrawal never admit or launch a worker',async()=>{
  const f=await setup(),c=f.consumers(),p=f.p();
  await expect(c.prepare({...p,mobile:{...p.mobile}} as unknown as CommunityMobilePrincipal,'mobile-agent','query',{kind:'agent',op:'targets'})).rejects.toThrow();
  for(const command of [{kind:'agent',op:'submit',path:'/tmp'},{kind:'agent',op:'shell',text:'id'},{kind:'agent',op:'targets',agent:'codex'}])await expect(c.prepare(p,'mobile-agent','effect',command)).rejects.toThrow();
  f.state.target=false;expect(await f.targets()).toEqual({targets:[]});f.state.target=true;
  const prepared=await f.submit();f.state.member=false;await expect(prepared.run(f.guard())).rejects.toThrow();await f.host().tick();expect(f.state.launches).toBe(0);expect(f.store.hasData()).toBe(false);
});
test('current OPS binding and actual member are rechecked after prepare and before queued launch',async()=>{
  const f=await setup(),prepared=await f.submit();f.state.identity='c'.repeat(64);await expect(prepared.run(f.guard())).rejects.toThrow('SCOPE_CHANGED');
  const fresh=await f.submit();await fresh.run(f.guard());f.state.member=false;await f.host().tick();expect(f.state.launches).toBe(0);
  f.state.member=true;f.state.scope='d'.repeat(64);expect(await f.consumers().authorizeReceipt(f.p(),'mobile-agent',fresh.scope)).toBe(false);
});
test('a canonical OPS target replacement during asynchronous admission cannot reach durable queue',async()=>{
  const f=await setup(),prepared=await f.submit();
  f.deps.peerActive=async()=>{f.state.identity='e'.repeat(64);return true;};
  await expect(prepared.run(f.guard())).rejects.toThrow();expect(await f.store.list(null)).toHaveLength(0);expect(f.state.launches).toBe(0);
});
test('canonical target withdrawal during backend receipt lookup cannot disclose the old result',async()=>{
  const f=await setup(),a=await f.submit();await a.run(f.guard());
  const original=f.store.get.bind(f.store);f.store.get=async id=>{const value=await original(id);f.state.identity='f'.repeat(64);return value;};
  const status=await f.consumers().prepare(f.p(),'mobile-agent','query',{kind:'agent',op:'status',context:(await f.targets()).targets[0]!.context,ref:fixture.effect.operationId});
  await expect(status.run(f.guard())).rejects.toThrow();
});
test('expired mobile v7 cannot be admitted again after its backend tombstone was pruned',async()=>{
  const f=await setup(),a=await f.submit();await a.run(f.guard());await f.host().tick();const rows=await f.store.list(f.state.scope);expect(rows).toHaveLength(1);
  await f.store.update(rows[0]!.id,r=>({...r!,receipt:{...r!.receipt,state:'completed',result:'완료',evidence:'fixture'}}));
  f.state.now+=31*24*3600_000;await f.refresh();await f.store.prune(f.state.now);
  // Simulate bounded tombstone retirement through a store with the same encrypted data and zero tombstone budget.
  const retired=new OpsRequestStore(f.root,provider,{maxTombstones:0});await retired.prune(f.state.now);
  const action=await f.submit();await expect(action.run(f.guard())).rejects.toThrow('접수 시간이');expect(f.state.launches).toBe(1);
  const absentId=fixture.effect.operationId.slice(0,-1)+'2';await expect((await f.submit(absentId)).run(f.guard(absentId))).rejects.toThrow('접수 시간이');expect(f.state.launches).toBe(1);
});
test('persisted member permits the job while the original closed human episode disables automatic CLI settings',async()=>{
  const f=await setup(),p=f.p(),adapter=new CommunityAdapterAuthorization({verifiedMain:true,request:async request=>({success:true,halted:false,authorized:f.state.native,capability:request.capability,communityId:p.receiver.body.communityId,profileId:p.receiver.body.profileId,deviceId:p.receiver.body.deviceId,revision:p.receiver.body.revision,expiresAt:f.state.now+90_000,desktopGrant:false})},()=>f.state.now);
  const setting={get:()=>true,set:()=>false,getMode:()=> 'auto' as const};
  const policy=await communityMobileOpsEffortPolicy(f.origin(),f.identity,adapter,()=>f.state.now)(setting);expect(policy.mode).toBe('auto');expect(await policy.beforeEffect?.()).toBe(true);
  f.state.episode=false;expect(await communityMobileOpsMemberActive(f.origin(),f.identity,()=>f.state.now)).toBe(true);
  const closed=await communityMobileOpsEffortPolicy(f.origin(),f.identity,adapter,()=>f.state.now)(setting);expect(closed.mode).toBe('off');await expect(policy.beforeEffect!()).rejects.toThrow();
  f.state.member=false;expect(await communityMobileOpsMemberActive(f.origin(),f.identity,()=>f.state.now)).toBe(false);
});
