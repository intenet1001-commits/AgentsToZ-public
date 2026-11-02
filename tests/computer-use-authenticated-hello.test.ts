import {describe,test,expect} from 'bun:test';
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import {CommunityAccessReply,communityBase64,communityBytes,type CommunityAccessEnvelope} from '../src/communityAccessClient';
import {CommunityComponentAuthorization,communityComponentHandshakeBytes,type NativeCommunityComponentIdentity} from '../src/communityComponentIdentity';
import {createComputerUseRemoteSidecar,type ComputerUseRemoteSidecar} from '../src/computerUseRemoteSidecar';
import {AGENT_DIALOGUE_CONTROL_DETACHED} from '../src/agentDialogueHost';

const pair=()=>generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const point=(key:ReturnType<typeof pair>['publicKey'])=>{const j=key.export({format:'jwk'});return Buffer.concat([Buffer.from([4]),Buffer.from(j.x!,'base64url'),Buffer.from(j.y!,'base64url')]).toString('base64url');};
async function fixture(){
 const issuer=pair(),profile=randomUUID(),community=randomUUID(),clock={now:Date.now()},records:Record<string,unknown>[]=[],executed:Record<string,unknown>[]=[];
 const peers=[0,1].map(()=>({device:randomUUID(),agentDevice:randomUUID(),enrollment:randomUUID(),endpoint:randomUUID(),control:pair(),host:pair(),bio:pair(),operation:pair(),enabled:true}));
 const wrap=(kind:string,payload:unknown):CommunityAccessEnvelope=>{const data=Buffer.from(JSON.stringify([2,kind,randomUUID(),clock.now,payload]));return {payload:data.toString('base64url'),signature:sign('sha256',Buffer.concat([Buffer.from('agentstoz.community-access.response/v2\0'),data]),{key:issuer.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url')};};
 const auth=async(index:number)=>{
  const p=peers[index]!;if(!p.enabled)throw Error('fixture revoked');
  const envelope=wrap('authorization',{version:1,communityId:community,profileId:profile,enrollmentId:p.enrollment,deviceId:p.device,agentDeviceId:p.agentDevice,deviceKind:'desktop',name:'Fixture '+index,
   hostPublicKey:point(p.host.publicKey),publicKey:point(p.operation.publicKey),biometricPublicKey:point(p.bio.publicKey),controlKey:point(p.control.publicKey),
   capabilities:['agent.communicate','teams.run'],revision:1,keyEpoch:1,issuedAt:clock.now,expiresAt:clock.now+90_000});
  const raw=JSON.parse(Buffer.from(envelope.payload,'base64url').toString()),reply=await CommunityAccessReply.verify(envelope,point(issuer.publicKey),raw[2],clock.now);
  return CommunityComponentAuthorization.fromReply(reply,profile,p.device,clock.now);
 };
 const identity=(index:number)=>({
  context:async()=>({communityId:community,profileId:profile,enrollmentId:peers[index]!.enrollment,deviceId:peers[index]!.device,agentDeviceId:peers[index]!.agentDevice,publicKey:point(peers[index]!.control.publicKey)}),
  currentAuthorization:async()=>auth(index),directory:async()=>Promise.all(peers.map((_,i)=>auth(i))),
  signHandshake:async(_purpose:any,role:any,t:any,own:any)=>{if(!peers[index]!.enabled||t[`${role}DeviceId`]!==peers[index]!.device||own.body.controlKey!==point(peers[index]!.control.publicKey))throw Error('fixture identity refused');return new Uint8Array(sign('sha256',communityComponentHandshakeBytes(t,role),{key:peers[index]!.control.privateKey,dsaEncoding:'ieee-p1363'}));},
  verifyAuthorization:async(envelope:CommunityAccessEnvelope,deviceId?:string)=>{
   const raw=JSON.parse(Buffer.from(envelope.payload,'base64url').toString()),reply=await CommunityAccessReply.verify(envelope,point(issuer.publicKey),raw[2],clock.now);
   return CommunityComponentAuthorization.fromReply(reply,profile,deviceId,clock.now);
  },
 } satisfies Pick<NativeCommunityComponentIdentity,'context'|'currentAuthorization'|'directory'|'signHandshake'|'verifyAuthorization'>);
 let receiving!:ComputerUseRemoteSidecar,mutate:(request:Record<string,unknown>)=>Record<string,unknown>=r=>r;
 const answers=new Map<string,(value:Record<string,unknown>)=>void>();
 const source=peers[0]!,target=peers[1]!;
 const dialogue={
  controlDevices:async()=>({inside:true,deviceId:source.agentDevice,devices:[{endpointId:target.endpoint,deviceId:target.agentDevice,displayName:'Fixture B',kind:'ops' as const,lastSeenAt:new Date(clock.now).toISOString()}]}),
  controlSource:async()=>({deviceId:source.agentDevice,endpointId:source.endpoint}),
  controlCall:async(_endpoint:string,request:Record<string,unknown>,_timeout:number,options:any)=>{
   const id=randomUUID();options.onSent?.({controlId:id,sourceEndpointId:source.endpoint,targetDeviceId:target.agentDevice});
   const changed=mutate(structuredClone(request));records.push(changed);let resolve!:(v:Record<string,unknown>)=>void;const deferred=new Promise<Record<string,unknown>>(r=>{resolve=r;});answers.set(id,resolve);
   try{const result=await receiving.computerUse(changed,{deviceId:source.agentDevice,name:'Fixture A',endpointId:source.endpoint},id);if(result===AGENT_DIALOGUE_CONTROL_DETACHED)return await deferred;answers.delete(id);return {ok:true,body:result};}
   catch(error){answers.delete(id);return {ok:false,error:error instanceof Error?error.message:'refused'};}
  },controlResult:async()=>({results:[],waiting:[]}),
  controlRespond:async(id:string,response:Record<string,unknown>)=>{answers.get(id)?.(response);answers.delete(id);},communityNotice:async()=>({}),
 };
 const runtime={remote:async(_session:string,_peer:any,body:Record<string,unknown>)=>{executed.push(body);return {success:true,available:true,fixture:'authenticated'};},remoteAdmission:()=>null,remoteGrants:()=>[],hasIncomingRemoteGrant:()=>false};
 receiving=createComputerUseRemoteSidecar({dialogue,identity:identity(1),runtime:()=>runtime,existingRuntime:()=>null,selfDeviceId:()=>target.agentDevice,bundled:true,platform:'darwin',now:()=>clock.now});
 const sending=createComputerUseRemoteSidecar({dialogue,identity:identity(0),runtime:()=>runtime,existingRuntime:()=>null,selfDeviceId:()=>source.agentDevice,bundled:true,platform:'darwin',now:()=>clock.now});
 return {source,target,clock,records,executed,call:()=>sending.client.agent({instance:'a'.repeat(64)},{device:target.agentDevice,operation:'scope-status'}),mutate:(fn:typeof mutate)=>{mutate=fn;},close:async()=>{await sending.dispose();await receiving.dispose();},receiving,peers};
}
describe('production sidecar authenticated hello',()=>{
 test('two independently certified native identities confirm keys before the actual runtime receives a call',async()=>{
  const f=await fixture();try{const result=await f.call();expect(result.success).toBe(true);expect(f.records.map(r=>r.op)).toEqual(['hello','confirm','call']);expect(f.records[0]!.v).toBe(2);expect(f.executed.filter(r=>r.operation==='scope-status')).toHaveLength(1);expect(f.source.device).not.toBe(f.source.agentDevice);}finally{await f.close();}
 });
 test('an active transport substituting an ephemeral public key cannot establish either authenticated session',async()=>{
  const f=await fixture(),attacker=point(pair().publicKey);try{f.mutate(request=>request.op==='hello'?{...request,pub:attacker}:request);const result=await f.call();expect(result.success).toBe(false);expect(f.executed).toHaveLength(0);expect(f.records).toHaveLength(1);}finally{await f.close();}
 });
 test('a forged receiver identity mapping and missing confirmation never reach the runtime',async()=>{
  const f=await fixture();try{f.mutate(request=>request.op==='hello'?{...request,expectedReceiver:randomUUID()}:request);expect((await f.call()).success).toBe(false);expect(f.executed).toHaveLength(0);}finally{await f.close();}
  const g=await fixture();try{g.mutate(request=>request.op==='confirm'?{...request,confirmation:communityBase64(new Uint8Array(32))}:request);expect((await g.call()).success).toBe(false);expect(g.executed).toHaveLength(0);}finally{await g.close();}
 });
 test('confirmation replay and a new unauthenticated v1 hello cannot replace an authenticated connection',async()=>{
  const f=await fixture();try{
   expect((await f.call()).success).toBe(true);const confirmed=f.records.find(r=>r.op==='confirm')!;
   await expect(f.receiving.computerUse(confirmed,{deviceId:f.source.agentDevice,name:'A'},randomUUID())).rejects.toThrow();
   const hello=f.records[0]!;await expect(f.receiving.computerUse({kind:'computer-use',v:1,op:'hello',session:hello.session,seq:0,sentAt:f.clock.now,pub:hello.pub,instance:hello.instance,platform:'darwin'},{deviceId:f.source.agentDevice,name:'A'},randomUUID())).rejects.toThrow();
   expect((await f.call()).success).toBe(true);expect(f.executed.filter(r=>r.operation==='scope-status')).toHaveLength(2);
  }finally{await f.close();}
 });
 test('revoked identity at the lease refresh boundary stops the next call without resending the input',async()=>{
  const f=await fixture();try{expect((await f.call()).success).toBe(true);f.clock.now+=70_001;f.peers[0]!.enabled=false;
   const before=f.executed.length;expect((await f.call()).success).toBe(false);expect(f.executed.length).toBe(before);expect(f.records.filter(r=>r.op==='call')).toHaveLength(1);
  }finally{await f.close();}
 });
});
