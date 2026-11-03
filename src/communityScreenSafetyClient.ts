/** Gate/status metadata only. Long-term and RAM private keys remain in the native implementation. */
import {createHash} from 'node:crypto';
import {CommunityAccessReply,CommunityAccessClientError,communityObject,communityBytes,communityId,type CommunityAccessEnvelope,type CommunityAccessRequest} from './communityAccessClient';
import {CommunityDeviceAuthorization,CommunityMobileUseSession,type CommunityDeviceAuthorizationBody,type CommunityMobileAuthority,COMMUNITY_MOBILE_CAPABILITY_ORDER} from './communityMobilePrincipal';
export interface CommunitySafetyWatcher {enrollmentId:string;deviceId:string;hostPublicKey:string;operationPublicKey:string;keyEpoch:number;revision:number;policyDigest:string;subscriptionGeneration:string;authorizationExpiresAt:number;administrator:true}
export interface CommunitySafetySnapshot {observationSequence:number;power:'on'|'waiting'|'off';held:boolean;session:null|{channelId:string;controllerEnrollmentId:string;since:number}}
export interface CommunitySafetyCommand {commandId:string;sequence:number;acceptedAt:number;expiresAt:number;receiverPolicyDigest:string;subscriptionGeneration:string;authorization:CommunityAccessEnvelope;useSession:CommunityAccessEnvelope;request:CommunityAccessEnvelope}
export interface CommunitySafetyRoundBody {version:1;receiver:CommunityDeviceAuthorizationBody;activationId:string;pollRequestId:string;pollNonce:string;communityRevision:number;watcherSetHash:string;watchers:readonly CommunitySafetyWatcher[];commands:readonly CommunitySafetyCommand[];nextSequence:number;issuedAt:number;expiresAt:number}
export interface CommunitySafetyExpectedReceiver {communityId:string;profileId:string;enrollmentId:string;deviceId:string;hostPublicKey:string;keyEpoch:number;revision:number;policyDigest:string}
export const COMMUNITY_SAFETY_OUTCOMES=['ended','turned-off','revoked','nothing-to-do','refused','superseded'] as const;
const TOKEN=Symbol('verified-common-safety-round'),known=new WeakSet<object>(),encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const fail=(code='INVALID_SAFETY_PROOF'):never=>{throw new CommunityAccessClientError(code);};
const uuid=(v:unknown):v is string=>communityId(v)&&v===v.toLowerCase();
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const hash=(domain:string,value:unknown)=>createHash('sha256').update(domain,'utf8').update(JSON.stringify(value),'utf8').digest('hex');
const AUTH_FIELDS=['version','communityId','profileId','enrollmentId','deviceId','agentDeviceId','deviceKind','name','hostPublicKey','publicKey','biometricPublicKey','controlKey','capabilities','revision','keyEpoch','issuedAt','expiresAt'];
function frozen<T>(v:T):T {if(v&&typeof v==='object'){for(const c of Object.values(v))frozen(c);Object.freeze(v);}return v;}
async function point(value:unknown):Promise<string>{const b=communityBytes(value,65);if(b.length!==65||b[0]!==4)return fail();try{await crypto.subtle.importKey('raw',new Uint8Array(b),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);}catch{return fail();}return value as string;}
async function verifySignature(key:string,domain:string,bytes:Uint8Array,signature:unknown):Promise<void>{
  const raw=communityBytes(signature,64);if(raw.length!==64)return fail();const prefix=encoder.encode(domain),input=new Uint8Array(prefix.length+bytes.length);input.set(prefix);input.set(bytes,prefix.length);
  const pub=await crypto.subtle.importKey('raw',new Uint8Array(communityBytes(key,65)),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
  if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},pub,new Uint8Array(raw),input))return fail();
}
export function communitySafetyPolicyDigest(b:CommunityDeviceAuthorizationBody):string{return hash('',[b.version,b.communityId,b.profileId,b.enrollmentId,b.deviceId,b.agentDeviceId,b.deviceKind,b.name,b.hostPublicKey,b.publicKey,b.biometricPublicKey,b.controlKey,b.capabilities,b.revision,b.keyEpoch]);}
export function communitySafetyWatcherHash(receiver:CommunityDeviceAuthorizationBody,activation:string,watchers:readonly CommunitySafetyWatcher[]):string{return hash('agentstoz.community-screen-safety.watchers/v1\0',[1,receiver.communityId,receiver.enrollmentId,activation,communitySafetyPolicyDigest(receiver),watchers.map(w=>[w.enrollmentId,w.deviceId,w.hostPublicKey,w.operationPublicKey,w.keyEpoch,w.revision,w.policyDigest,w.subscriptionGeneration,true])]);}
async function pin(reply:CommunityAccessReply,a:CommunityMobileAuthority,now:number):Promise<CommunityAccessReply>{
  if(!CommunityAccessReply.isVerified(reply)||!reply.requestId||!integer(now)||!uuid(a.profileId))return fail();
  let origin:URL;try{origin=new URL(a.origin);}catch{return fail();}
  if(origin.protocol!=='https:'||origin.origin!==a.origin||origin.pathname!=='/'||origin.username||origin.password||origin.port||origin.search||origin.hash||!origin.hostname.endsWith('.workers.dev'))return fail();
  await point(a.issuerPublicKey);return CommunityAccessReply.verify(reply.envelope,a.issuerPublicKey,reply.requestId,now);
}
async function receiver(value:unknown,a:CommunityMobileAuthority,at:number,now:number):Promise<CommunityDeviceAuthorizationBody>{
  const b=communityObject(value,AUTH_FIELDS);
  if(b.version!==1||b.profileId!==a.profileId||!['communityId','profileId','enrollmentId','deviceId'].every(k=>uuid(b[k]))||b.deviceKind!=='desktop'||!integer(b.revision)||b.revision<1||!integer(b.keyEpoch)||b.keyEpoch<1
    ||b.issuedAt!==at||!integer(b.expiresAt)||b.expiresAt<=now||b.expiresAt>at+90_000||typeof b.name!=='string'||!b.name||b.name.trim()!==b.name||encoder.encode(b.name).length>120||/[\p{Cc}\p{Cf}]/u.test(b.name))return fail();
  if(!Array.isArray(b.capabilities)||!b.capabilities.includes('screen.receive.view')||JSON.stringify(b.capabilities)!==JSON.stringify(COMMUNITY_MOBILE_CAPABILITY_ORDER.filter(c=>b.capabilities instanceof Array&&b.capabilities.includes(c)))
    ||b.capabilities.includes('screen.control')&&!b.capabilities.includes('screen.view')||b.capabilities.includes('screen.receive.control')&&!b.capabilities.includes('screen.receive.view'))return fail();
  const points=await Promise.all([point(b.hostPublicKey),point(b.publicKey),point(b.biometricPublicKey),...(b.controlKey===null?[]:[point(b.controlKey)])]);if(new Set(points).size!==points.length)return fail();
  if(b.agentDeviceId!==null&&!uuid(b.agentDeviceId)||b.capabilities.some(c=>['agent.communicate','teams.run','computer-use.agent-settings','computer-use.browser'].includes(c))&&b.controlKey===null||b.capabilities.some(c=>['agent.communicate','teams.run'].includes(c))&&b.agentDeviceId===null)return fail();
  return frozen({...b,capabilities:[...b.capabilities]}) as unknown as CommunityDeviceAuthorizationBody;
}
/** Issuer verified and bound to the exact original native poll; it is not executable device authorization. */
export class CommunitySafetyRound {
  private constructor(token:typeof TOKEN,readonly body:Readonly<CommunitySafetyRoundBody>,readonly envelope:CommunityAccessEnvelope,readonly authority:Readonly<CommunityMobileAuthority>){if(token!==TOKEN)return fail();known.add(this);Object.freeze(this);}
  static isVerified(value:unknown):value is CommunitySafetyRound{return !!value&&typeof value==='object'&&known.has(value);}
  static async fromReply(reply:CommunityAccessReply,a:CommunityMobileAuthority,own:CommunitySafetyExpectedReceiver,poll:Pick<CommunityAccessRequest,'requestId'|'nonce'>&{activationId:string},now=Date.now()):Promise<CommunitySafetyRound>{
    const p=await pin(reply,a,now);communityBytes(p.envelope.payload,32_768);if(p.kind!=='safety-round'||p.requestId!==poll.requestId)return fail();
    const raw=communityObject(p.payload,['version','receiver','activationId','pollRequestId','pollNonce','communityRevision','watcherSetHash','watchers','commands','nextSequence','issuedAt','expiresAt']);
    const host=await receiver(raw.receiver,a,p.issuedAt,now);
    if(raw.version!==1||raw.activationId!==poll.activationId||!uuid(raw.activationId)||raw.pollRequestId!==poll.requestId||raw.pollNonce!==poll.nonce||communityBytes(raw.pollNonce,32).length!==32||raw.issuedAt!==p.issuedAt
      ||!integer(raw.expiresAt)||raw.expiresAt<=now||raw.expiresAt>p.issuedAt+90_000||!integer(raw.communityRevision)||raw.communityRevision<1||!integer(raw.nextSequence)||!Array.isArray(raw.watchers)||raw.watchers.length>16||!Array.isArray(raw.commands)||raw.commands.length>4)return fail();
    if(host.profileId!==own.profileId||host.communityId!==own.communityId||host.enrollmentId!==own.enrollmentId||host.deviceId!==own.deviceId||host.hostPublicKey!==own.hostPublicKey||host.keyEpoch!==own.keyEpoch||host.revision!==own.revision||communitySafetyPolicyDigest(host)!==own.policyDigest)return fail('WRONG_SAFETY_RECEIVER');
    const watchers:CommunitySafetyWatcher[]=[],seen=new Set<string>([host.hostPublicKey,host.publicKey,host.biometricPublicKey,...(host.controlKey?[host.controlKey]:[])]),ids=new Set<string>(),devices=new Set<string>();
    for(const value of raw.watchers){const w=communityObject(value,['enrollmentId','deviceId','hostPublicKey','operationPublicKey','keyEpoch','revision','policyDigest','subscriptionGeneration','authorizationExpiresAt','administrator']);
      if(!uuid(w.enrollmentId)||!uuid(w.deviceId)||!uuid(w.subscriptionGeneration)||w.administrator!==true||!integer(w.keyEpoch)||w.keyEpoch<1||!integer(w.revision)||w.revision<1||!digest(w.policyDigest)||!integer(w.authorizationExpiresAt)||w.authorizationExpiresAt<=now||w.authorizationExpiresAt>p.issuedAt+90_000||ids.has(w.enrollmentId)||devices.has(w.deviceId)||w.enrollmentId===host.enrollmentId||w.deviceId===host.deviceId)return fail();
      const keys=await Promise.all([point(w.hostPublicKey),point(w.operationPublicKey)]);for(const key of keys){if(seen.has(key))return fail();seen.add(key);}ids.add(w.enrollmentId);devices.add(w.deviceId);watchers.push(w as unknown as CommunitySafetyWatcher);
    }
    if(watchers.some((w,i)=>i>0&&watchers[i-1]!.enrollmentId.localeCompare(w.enrollmentId)>=0)||raw.watcherSetHash!==communitySafetyWatcherHash(host,raw.activationId,watchers))return fail();
    const commands:CommunitySafetyCommand[]=[],commandIds=new Set<string>(),sequences=new Set<number>();
    for(const value of raw.commands){const c=communityObject(value,['commandId','sequence','acceptedAt','expiresAt','receiverPolicyDigest','subscriptionGeneration','authorization','useSession','request']);
      if(!uuid(c.commandId)||commandIds.has(c.commandId)||!integer(c.sequence)||c.sequence<1||sequences.has(c.sequence)||!integer(c.acceptedAt)||c.acceptedAt>now+5_000||!integer(c.expiresAt)||c.expiresAt<=now||c.expiresAt>c.acceptedAt+7*86400_000||c.receiverPolicyDigest!==own.policyDigest||!uuid(c.subscriptionGeneration))return fail();
      const request=communityObject(c.request,['payload','signature']),bytes=communityBytes(request.payload,24_000);let fields:unknown;try{fields=JSON.parse(decoder.decode(bytes));}catch{return fail();}
      if(!Array.isArray(fields)||fields.length!==7||fields[0]!==2||fields[1]!=='screen-safety-stop'||fields[2]!==c.commandId||!integer(fields[3])||Math.abs(fields[3]-c.acceptedAt)>60_000||communityBytes(fields[4],32).length!==32||!uuid(fields[5])||!Array.isArray(fields[6])||fields[6].length!==5)return fail();
      const args=fields[6],watcher=watchers.find(w=>w.enrollmentId===fields[5]);if(!watcher||args[0]!==host.communityId||!uuid(args[1])||args[2]!==host.enrollmentId||args[3]!==raw.activationId||watcher.subscriptionGeneration!==c.subscriptionGeneration)return fail();
      const command=communityObject(args[4],['action','targetEnrollmentId','expectedSessionId']);if(!['end','turnOff','revoke'].includes(command.action as string))return fail();
      if(command.action==='end'&&(!uuid(command.expectedSessionId)||command.targetEnrollmentId!==null||c.expiresAt>c.acceptedAt+600_000)||command.action==='turnOff'&&(command.expectedSessionId!==null||command.targetEnrollmentId!==null)||command.action==='revoke'&&(!uuid(command.targetEnrollmentId)||command.expectedSessionId!==null))return fail();
      const auth=await CommunityDeviceAuthorization.fromEnvelope(c.authorization,a,{communityId:host.communityId,deviceKind:'mobile',deviceId:watcher.deviceId,enrollmentId:watcher.enrollmentId,revision:watcher.revision,policyDigest:watcher.policyDigest},c.acceptedAt);
      if(auth.body.keyEpoch!==watcher.keyEpoch||auth.body.hostPublicKey!==watcher.hostPublicKey||auth.body.publicKey!==watcher.operationPublicKey||!auth.body.capabilities.includes('screen.view'))return fail();
      const use=await CommunityMobileUseSession.fromEnvelope(c.useSession,auth,{sessionId:args[1]},c.acceptedAt);if(!use.body.capabilities.includes('screen.view'))return fail();
      await verifySignature(use.body.publicKey,'agentstoz.community-access.request/v2\0',bytes,request.signature);
      commandIds.add(c.commandId);sequences.add(c.sequence);commands.push(c as unknown as CommunitySafetyCommand);
    }
    if(commands.length&&raw.nextSequence!==commands.at(-1)!.sequence)return fail();
    const body=frozen({...raw,receiver:host,watchers,commands}) as unknown as CommunitySafetyRoundBody;
    return new CommunitySafetyRound(TOKEN,body,p.envelope,Object.freeze({...a}));
  }
}
export async function verifyCommunitySafetyHostResult(value:unknown,expected:{communityId:string;receiverEnrollmentId:string;activationId:string;commandId:string;hostPublicKey:string;acceptedAt:number;expiresAt:number;action?:'end'|'turnOff'|'revoke'},now=Date.now()):Promise<Readonly<{outcome:typeof COMMUNITY_SAFETY_OUTCOMES[number];issuedAt:number}>>{
  if(!integer(now)||!integer(expected.acceptedAt)||!integer(expected.expiresAt)||expected.expiresAt<expected.acceptedAt||expected.expiresAt>expected.acceptedAt+7*86400_000||![expected.communityId,expected.receiverEnrollmentId,expected.activationId,expected.commandId].every(uuid)||expected.action!==undefined&&!['end','turnOff','revoke'].includes(expected.action))return fail();
  const envelope=communityObject(value,['payload','signature']),bytes=communityBytes(envelope.payload,2048);let fields:unknown;try{fields=JSON.parse(decoder.decode(bytes));}catch{return fail();}
  if(!Array.isArray(fields)||fields.length!==7||fields[0]!==1||fields[1]!==expected.communityId||fields[2]!==expected.receiverEnrollmentId||fields[3]!==expected.activationId||fields[4]!==expected.commandId||!COMMUNITY_SAFETY_OUTCOMES.includes(fields[5] as never)||!integer(fields[6])||fields[6]>now+5_000||fields[6]<now-7*86400_000||fields[6]<expected.acceptedAt-5_000||fields[6]>expected.expiresAt+5_000)return fail();
  if(expected.action&&['ended','turned-off','revoked'].includes(fields[5])&&({end:'ended',turnOff:'turned-off',revoke:'revoked'}[expected.action]!==fields[5]))return fail();
  await point(expected.hostPublicKey);await verifySignature(expected.hostPublicKey,'agentstoz.community-screen-safety.result/v1\0',bytes,envelope.signature);
  return Object.freeze({outcome:fields[5] as typeof COMMUNITY_SAFETY_OUTCOMES[number],issuedAt:fields[6]});
}
