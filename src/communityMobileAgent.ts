import {createHash} from 'node:crypto';
import {CommunityDeviceAuthorization,CommunityMobileUseSession} from './communityMobilePrincipal';
import type {CommunityMobileConsumers,CommunityMobileEffectGuard,CommunityMobileHostIdentity,CommunityMobilePrincipal} from './communityMobileControlTypes';
import {communityObject} from './communityAccessClient';
import {mobileControlOperationTime} from './communityMobileControlProtocol';
import {opsRequestId,opsRequestText,type OpsRequestReceipt} from './opsRequestProtocol';
import type {OpsRequestHost} from './opsRequestHost';
import type {OpsRequestMobileOrigin} from './opsRequestStore';
import type {CommunityAdapterAuthorization} from './communityAdapterAuthorization';
import type {AiTerminalEffortPolicy} from './aiTerminalService';
import {communityMobileWorkroomEffortPolicy} from './communityMobileConsumers';

export interface CommunityMobileOpsTarget {identity:string;scope:string;name:string;isCurrent():boolean}
export interface CommunityMobileAgentDependencies {
  host:OpsRequestHost;
  /** Actual enabled Main OPS plus current registered/canonical binding. No caller-selected path, account or AI. */
  target():Promise<CommunityMobileOpsTarget|null>;
  now?:()=>number;
}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const HEX=/^[0-9a-f]{64}$/;
function fail(code:string):never{throw new Error(code);}
function current(p:CommunityMobilePrincipal,now:number):void {
  if(!CommunityDeviceAuthorization.isVerified(p.receiver)||!CommunityDeviceAuthorization.isVerified(p.mobile)||!CommunityMobileUseSession.isVerified(p.use)
    ||p.receiver.body.deviceKind!=='desktop'||p.mobile.body.deviceKind!=='mobile'||p.use.authorization!==p.mobile
    ||p.receiver.body.profileId!==p.mobile.body.profileId||p.receiver.body.communityId!==p.mobile.body.communityId
    ||p.receiver.authority.origin!==p.mobile.authority.origin||p.receiver.authority.issuerPublicKey!==p.mobile.authority.issuerPublicKey
    ||!p.receiver.permits('mobile-agent',now)||!p.mobile.permits('mobile-agent',now)||!p.use.permits('mobile-agent',now))fail('MOBILE_AGENT_PERMISSION_REQUIRED');
}
const receiver=(p:CommunityMobilePrincipal)=>hash([p.receiver.body.profileId,p.receiver.body.communityId,p.receiver.body.enrollmentId,p.receiver.body.deviceId,p.receiver.body.controlKey,p.receiver.body.keyEpoch]);
/** Persisted OPS jobs remain receiver-owned. Check the real current member/key/capability, without renewing its idle. */
export async function communityMobileOpsMemberActive(origin:OpsRequestMobileOrigin,identity:CommunityMobileHostIdentity,now=Date.now):Promise<boolean>{
  try{return (await communityMobileOpsTaskFence(origin,identity,()=>true,now))();}catch{return false;}
}
export async function communityMobileOpsTaskFence(origin:OpsRequestMobileOrigin,identity:CommunityMobileHostIdentity,targetCurrent:()=>boolean,now=Date.now):Promise<()=>boolean>{
  try{
    const own=await identity.authorization('mobile-agent');
    if(own.body.profileId!==origin.profileId||own.body.communityId!==origin.communityId)fail('MOBILE_AGENT_SCOPE_CHANGED');
    const peers=(await identity.directory('mobile-agent')).filter(peer=>peer.body.deviceKind==='mobile'&&peer.body.profileId===origin.profileId
      &&peer.body.communityId===origin.communityId&&peer.body.deviceId===origin.deviceId&&peer.body.enrollmentId===origin.enrollmentId
      &&peer.body.keyEpoch===origin.keyEpoch&&peer.body.publicKey===origin.operationPublicKey&&peer.receiptOwnerHash===origin.receiptOwner);
    if(peers.length!==1)fail('MOBILE_AGENT_PERMISSION_REQUIRED');const peer=peers[0]!;
    return ()=>targetCurrent()&&own.permits('mobile-agent',now())&&peer.permits('mobile-agent',now());
  }catch{fail('MOBILE_AGENT_PERMISSION_REQUIRED');}
}
/** A queued OPS job keeps its job authority, but automatic settings require the original still-live human episode. */
export function communityMobileOpsEffortPolicy(origin:OpsRequestMobileOrigin,identity:CommunityMobileHostIdentity,adapter:CommunityAdapterAuthorization,now=Date.now):AiTerminalEffortPolicy {
  const off=()=>({mode:'off' as const,isAuthorized:()=>false,beforeEffect:async()=>false});
  return async setting=>{
    try{
      const fresh=async():Promise<CommunityMobilePrincipal>=>{
        const receiver=await identity.authorization('mobile-agent-settings');
        if(receiver.body.profileId!==origin.profileId||receiver.body.communityId!==origin.communityId)fail('MOBILE_AGENT_SCOPE_CHANGED');
        const matches=(await identity.directory('mobile-agent-settings')).filter(a=>a.body.deviceKind==='mobile'&&a.body.deviceId===origin.deviceId
          &&a.body.profileId===origin.profileId&&a.body.communityId===origin.communityId&&a.body.enrollmentId===origin.enrollmentId
          &&a.body.keyEpoch===origin.keyEpoch&&a.body.publicKey===origin.operationPublicKey&&a.receiptOwnerHash===origin.receiptOwner);
        if(matches.length!==1)fail('MOBILE_AGENT_PERMISSION_REQUIRED');const mobile=matches[0]!;
        return {receiver,mobile,use:await identity.currentUse('mobile-agent-settings',mobile,origin.initialUseId)};
      };
      const p=await fresh(),active=()=>p.receiver.permits('mobile-agent-settings',now())&&p.mobile.permits('mobile-agent-settings',now())&&p.use.permits('mobile-agent-settings',now());
      const guard:CommunityMobileEffectGuard={operationId:null,createdAt:null,active,beforeEffect:async()=>{
        const next=await fresh();if(!active()||next.receiver.policyDigest!==p.receiver.policyDigest||next.mobile.policyDigest!==p.mobile.policyDigest||next.use.policyDigest!==p.use.policyDigest)fail('MOBILE_AGENT_PERMISSION_REQUIRED');
      }};
      return await communityMobileWorkroomEffortPolicy(adapter,p,guard,now)(setting);
    }catch{return off();}
  };
}
function page(text:string|undefined,offset=0,limit=3000):{text:string;nextOffset:number|null;totalChars:number}{
  const value=text??'';
  if(!Number.isSafeInteger(offset)||offset<0||offset>value.length||offset>0&&offset<value.length&&/[\uDC00-\uDFFF]/.test(value[offset]!))fail('MOBILE_AGENT_INVALID_PAGE');
  let out='',used=2,next=offset;
  for(const point of value.slice(offset)){
    const cost=Buffer.byteLength(JSON.stringify(point))-2;if(used+cost>limit)break;out+=point;used+=cost;next+=point.length;
  }
  return {text:out,nextOffset:next<value.length?next:null,totalChars:value.length};
}
function publicStatus(ref:string,r:OpsRequestReceipt){return {ref,state:r.state,createdAt:r.createdAt,updatedAt:r.updatedAt,result:page(r.result),evidence:page(r.evidence),message:page(r.message)};}
type Scope={v:1;kind:'mobile-agent';owner:string;receiver:string;identity:string;opsScope:string};

export function createCommunityMobileAgent(deps:CommunityMobileAgentDependencies):CommunityMobileConsumers {
  const now=deps.now??Date.now;
  const target=async()=>{const t=await deps.target();if(!t||!HEX.test(t.identity)||!HEX.test(t.scope)||typeof t.name!=='string'||!t.name.trim()||Buffer.byteLength(t.name)>240||typeof t.isCurrent!=='function'||!t.isCurrent())fail('MOBILE_AGENT_TARGET_UNAVAILABLE');return Object.freeze({...t});};
  const scope=(p:CommunityMobilePrincipal,t:CommunityMobileOpsTarget):Scope=>({v:1,kind:'mobile-agent',owner:p.mobile.receiptOwnerHash,receiver:receiver(p),identity:t.identity,opsScope:t.scope});
  const context=(s:Scope)=>'ops_'+hash(s);
  const readScope=(raw:string):Scope=>{
    if(Buffer.byteLength(raw)>1024)fail('MOBILE_AGENT_SCOPE_CHANGED');
    const s=communityObject(JSON.parse(raw),['v','kind','owner','receiver','identity','opsScope']);
    if(s.v!==1||s.kind!=='mobile-agent'||!['owner','receiver','identity','opsScope'].every(k=>typeof s[k]==='string'&&HEX.test(s[k] as string)))fail('MOBILE_AGENT_SCOPE_CHANGED');
    return s as unknown as Scope;
  };
  const check=async(p:CommunityMobilePrincipal,s:Scope,g:CommunityMobileEffectGuard)=>{
    await g.beforeEffect();current(p,now());if(!g.active()||JSON.stringify(scope(p,await target()))!==JSON.stringify(s))fail('MOBILE_AGENT_SCOPE_CHANGED');
  };
  const queryGuard=(p:CommunityMobilePrincipal):CommunityMobileEffectGuard=>({operationId:null,createdAt:null,active:()=>{try{current(p,now());return true;}catch{return false;}},beforeEffect:async()=>{current(p,now());}});
  const receipt=async(p:CommunityMobilePrincipal,s:Scope,ref:string,g:CommunityMobileEffectGuard)=>{
    await check(p,s,g);const t=await target();
    const authority:CommunityMobileEffectGuard={operationId:g.operationId,createdAt:g.createdAt,active:()=>g.active()&&t.isCurrent(),beforeEffect:()=>check(p,s,g)};
    const value=await deps.host.receiveMobile({kind:'ops-request',operation:'status',requestId:ref},p,authority,s.opsScope);
    await check(p,s,authority);return value;
  };
  const result:CommunityMobileConsumers={
    capabilities(purpose){return purpose==='mobile-agent'?[{op:'targets',mode:'query',label:'허용된 아젠투지 OPS'},{op:'submit',mode:'effect',label:'OPS에 작업 요청'},{op:'status',mode:'query',label:'내 OPS 작업 결과'},{op:'read',mode:'query',label:'긴 결과 이어 읽기'}]:[];},
    async authorizeReceipt(p,purpose,raw){try{if(purpose!=='mobile-agent')return false;current(p,now());return JSON.stringify(readScope(raw))===JSON.stringify(scope(p,await target()));}catch{return false;}},
    async readReceipt(p,purpose,raw,operationId,createdAt){
      if(!await result.authorizeReceipt(p,purpose,raw))fail('MOBILE_AGENT_SCOPE_CHANGED');
      if(mobileControlOperationTime(operationId)!==createdAt)fail('MOBILE_AGENT_INVALID_OPERATION');
      try{await receipt(p,readScope(raw),operationId,queryGuard(p));return {state:'result',result:{accepted:true,ref:operationId,createdAt}};}catch{return {state:'unknown'};}
    },
    async prepare(p,purpose,mode,command){
      if(purpose!=='mobile-agent')fail('MOBILE_AGENT_PURPOSE_MISMATCH');current(p,now());
      const op=command.op,keys=op==='targets'?['kind','op']:op==='submit'?['kind','op','context','text']:op==='status'?['kind','op','context','ref']:op==='read'?['kind','op','context','ref','field','offset','revision']:[];
      const c=communityObject(command,keys);
      if(c.kind!=='agent'||!['targets','submit','status','read'].includes(String(op))||(op==='submit'?'effect':'query')!==mode)fail('MOBILE_AGENT_COMMAND_UNAVAILABLE');
      if(op==='targets')return {scope:JSON.stringify({kind:'mobile-agent-targets',owner:p.mobile.receiptOwnerHash,receiver:receiver(p)}),run:async g=>{
        await g.beforeEffect();current(p,now());if(!g.active())fail('MOBILE_AGENT_PERMISSION_REQUIRED');
        const available=await deps.target();if(!available)return {targets:[]};
        const t=await target(),s=scope(p,t);return {targets:[{context:context(s),name:t.name}]};
      }};
      const t=await target(),s=scope(p,t),raw=JSON.stringify(s);
      if(op!=='targets'&&c.context!==context(s))fail('MOBILE_AGENT_SCOPE_CHANGED');
      const text=op==='submit'?opsRequestText(c.text):undefined;
      const ref=op==='status'||op==='read'?opsRequestId(c.ref):null;
      if(op==='read'&&(!['result','evidence','message'].includes(String(c.field))||!Number.isSafeInteger(c.offset)||(c.offset as number)<0||!Number.isSafeInteger(c.revision)||(c.revision as number)<0))fail('MOBILE_AGENT_INVALID_PAGE');
      return {scope:raw,run:async g=>{
        await check(p,s,g);
        if(op==='submit'){
          if(!g.operationId||g.createdAt===null)fail('MOBILE_AGENT_ORIGINAL_OPERATION_REQUIRED');
          const admission:CommunityMobileEffectGuard={operationId:g.operationId,createdAt:g.createdAt,active:()=>g.active()&&t.isCurrent(),beforeEffect:()=>check(p,s,g)};
          await deps.host.receiveMobile({kind:'ops-request',operation:'submit',requestId:g.operationId,text:text!},p,admission,s.opsScope);
          return {accepted:true,ref:g.operationId,createdAt:g.createdAt};
        }
        const r=await receipt(p,s,ref!,g);
        if(op==='status')return publicStatus(ref!,r);
        if(r.updatedAt!==c.revision)fail('MOBILE_AGENT_RESULT_CHANGED');
        const field=c.field as 'result'|'evidence'|'message';return {ref,field,revision:r.updatedAt,...page(r[field],c.offset as number,6000)};
      }};
    },
  };return result;
}
