import {parseTeamMemberSelection, type TeamMemberSelection} from './teamLaunchOptions';

export const REMOTE_TEAMS_PATH='/api/agent-runtime/remote-teams';
export interface RemoteTeamTarget {deviceId:string;endpointId:string;projectId:string}
export interface RemoteTeamRef {kind:'remote';remoteRef:string;deviceId:string;endpointId:string;generation:string;projectId:string}
export type RemoteTeamMember=Pick<TeamMemberSelection,'agent'|'name'|'model'|'provider'|'effort'|'role'>&{task:string};
type Base={kind:'team';version:1;targetDeviceId:string};
export type RemoteTeamRequest=Base&(
  |{op:'projects'}
  |{op:'create';requestId:string;projectId:string;title:string;goal:string;member:RemoteTeamMember}
  |{op:'status';ref:RemoteTeamRef}
  |{op:'instruct';requestId:string;ref:RemoteTeamRef;text:string}
  |{op:'cancel';requestId:string;ref:RemoteTeamRef}
  |{op:'receipt';requestId:string}
);
export interface RemoteTeamStatus {ref:RemoteTeamRef;state:'starting'|'working'|'reported'|'blocked'|'failed'|'exited'|'unknown'|'closed';delivery:'verified'|'unknown'|'not-sent';report?:{status:'done'|'blocked';summary:string;provenance:'member'|'manual';at:string}}
export type RemoteTeamResponse={outcome:'projects';projects:{projectId:string;name:string}[]}
  |{outcome:'settled';status:RemoteTeamStatus}
  |{outcome:'instructed';delivery:'verified'|'unknown'}
  |{outcome:'cancelled';closed:'closed'|'not-running'|'unknown'}
  |{outcome:'unknown';ref?:RemoteTeamRef}
  |{outcome:'missing'};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function fail():never{throw Error('원격 Teams 요청 형식을 확인하세요.');}
export function remoteTeamObject(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))return fail();return value as Record<string,unknown>;}
export function remoteTeamExact(value:Record<string,unknown>,keys:readonly string[]):void{if(Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))fail();}
const identifier=(value:unknown,uuid=false):string=>typeof value==='string'&&(uuid?UUID:ID).test(value)?value:fail();
const text=(value:unknown,max:number):string=>typeof value==='string'&&value.trim()&&new TextEncoder().encode(value).length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)?value:fail();
export function parseRemoteTeamTarget(value:unknown):RemoteTeamTarget{const v=remoteTeamObject(value);remoteTeamExact(v,['deviceId','endpointId','projectId']);return{deviceId:identifier(v.deviceId,true),endpointId:identifier(v.endpointId,true),projectId:identifier(v.projectId)};}
export function parseRemoteTeamRef(value:unknown):RemoteTeamRef{const v=remoteTeamObject(value);remoteTeamExact(v,['kind','remoteRef','deviceId','endpointId','generation','projectId']);if(v.kind!=='remote')fail();return{kind:'remote',remoteRef:identifier(v.remoteRef,true),generation:identifier(v.generation,true),...parseRemoteTeamTarget({deviceId:v.deviceId,endpointId:v.endpointId,projectId:v.projectId})};}
export function parseRemoteTeamMember(value:unknown):RemoteTeamMember{
  const v=remoteTeamObject(value),allowed=['agent','task','name','model','provider','effort','role'];
  if(Object.keys(v).some(k=>!allowed.includes(k)))fail();
  // Reuse the local model/effort/agent contract. No account, bypass, attached session, external surface or recursive delegation.
  const member=parseTeamMemberSelection({...v,surface:'internal'});
  return {agent:member.agent,task:text(member.task,4000),...(member.name?{name:member.name}:{}),...(member.model?{model:member.model}:{}),...(member.provider?{provider:member.provider}:{}),...(member.effort?{effort:member.effort}:{}),...(member.role?{role:member.role}:{})};
}
export function parseTeamMemberWithRemote(value:unknown,index=0):TeamMemberSelection&{remote?:RemoteTeamTarget}{
  const raw=remoteTeamObject(value);if(!Object.hasOwn(raw,'remote'))return parseTeamMemberSelection(raw,index);
  const {remote,...local}=raw,target=parseRemoteTeamTarget(remote);
  if(local.sessionId!==undefined||local.accountId!==undefined||local.bypassPermissions!==undefined||local.launchOptions!==undefined||local.computerUseApprovals!==undefined||local.surface!=='internal')throw Error('원격 팀원은 받는 기기의 새 워크룸에서 시작합니다.');
  return{...parseTeamMemberSelection(local,index),remote:target};
}
export function parseRemoteTeamRequest(value:unknown):RemoteTeamRequest{
  const v=remoteTeamObject(value);if(v.kind!=='team'||v.version!==1)fail();const base={kind:'team' as const,version:1 as const,targetDeviceId:identifier(v.targetDeviceId,true)};
  switch(v.op){
    case 'projects':remoteTeamExact(v,['kind','version','targetDeviceId','op']);return{...base,op:'projects'};
    case 'create':remoteTeamExact(v,['kind','version','targetDeviceId','op','requestId','projectId','title','goal','member']);return{...base,op:'create',requestId:identifier(v.requestId),projectId:identifier(v.projectId),title:text(v.title,240),goal:text(v.goal,6000),member:parseRemoteTeamMember(v.member)};
    case 'status':remoteTeamExact(v,['kind','version','targetDeviceId','op','ref']);return{...base,op:'status',ref:parseRemoteTeamRef(v.ref)};
    case 'instruct':remoteTeamExact(v,['kind','version','targetDeviceId','op','requestId','ref','text']);return{...base,op:'instruct',requestId:identifier(v.requestId),ref:parseRemoteTeamRef(v.ref),text:text(v.text,4000)};
    case 'cancel':remoteTeamExact(v,['kind','version','targetDeviceId','op','requestId','ref']);return{...base,op:'cancel',requestId:identifier(v.requestId),ref:parseRemoteTeamRef(v.ref)};
    case 'receipt':remoteTeamExact(v,['kind','version','targetDeviceId','op','requestId']);return{...base,op:'receipt',requestId:identifier(v.requestId)};
    default:return fail();
  }
}
export function parseRemoteTeamResponse(value:unknown):RemoteTeamResponse{
  const v=remoteTeamObject(value);
  switch(v.outcome){
    case 'missing':remoteTeamExact(v,['outcome']);return{outcome:'missing'};
    case 'unknown':remoteTeamExact(v,Object.hasOwn(v,'ref')?['outcome','ref']:['outcome']);return{outcome:'unknown',...(Object.hasOwn(v,'ref')?{ref:parseRemoteTeamRef(v.ref)}:{})};
    case 'projects':{
      remoteTeamExact(v,['outcome','projects']);if(!Array.isArray(v.projects)||v.projects.length>200)fail();
      const projects=v.projects.map(raw=>{const p=remoteTeamObject(raw);remoteTeamExact(p,['projectId','name']);return{projectId:identifier(p.projectId),name:text(p.name,240)};});if(new Set(projects.map(p=>p.projectId)).size!==projects.length)fail();return{outcome:'projects',projects};
    }
    case 'instructed':remoteTeamExact(v,['outcome','delivery']);if(v.delivery!=='verified'&&v.delivery!=='unknown')fail();return{outcome:'instructed',delivery:v.delivery};
    case 'cancelled':remoteTeamExact(v,['outcome','closed']);if(v.closed!=='closed'&&v.closed!=='not-running'&&v.closed!=='unknown')fail();return{outcome:'cancelled',closed:v.closed};
    case 'settled':{
      remoteTeamExact(v,['outcome','status']);const s=remoteTeamObject(v.status);remoteTeamExact(s,Object.hasOwn(s,'report')?['ref','state','delivery','report']:['ref','state','delivery']);
      if(!['starting','working','reported','blocked','failed','exited','unknown','closed'].includes(String(s.state))||!['verified','unknown','not-sent'].includes(String(s.delivery)))fail();
      let report:RemoteTeamStatus['report'];if(Object.hasOwn(s,'report')){const r=remoteTeamObject(s.report);remoteTeamExact(r,['status','summary','provenance','at']);if(r.status!=='done'&&r.status!=='blocked'||r.provenance!=='member'&&r.provenance!=='manual'||typeof r.at!=='string'||!Number.isFinite(Date.parse(r.at)))fail();report={status:r.status,summary:text(r.summary,16000),provenance:r.provenance,at:r.at};}
      return{outcome:'settled',status:{ref:parseRemoteTeamRef(s.ref),state:s.state as RemoteTeamStatus['state'],delivery:s.delivery as RemoteTeamStatus['delivery'],...(report?{report}:{})}};
    }
    default:return fail();
  }
}
export type RemoteTeamManagementRequest={operation:'permissions'}|{operation:'set-permissions';expectedRevision:number;projectIds:string[]};
export function parseRemoteTeamManagement(value:unknown):RemoteTeamManagementRequest{
  const v=remoteTeamObject(value);if(v.operation==='permissions'){remoteTeamExact(v,['operation']);return{operation:'permissions'};}
  remoteTeamExact(v,['operation','expectedRevision','projectIds']);
  if(v.operation!=='set-permissions'||!Number.isSafeInteger(v.expectedRevision)||Number(v.expectedRevision)<0||!Array.isArray(v.projectIds)||v.projectIds.length>200)fail();
  const projectIds=v.projectIds.map(id=>identifier(id));if(new Set(projectIds).size!==projectIds.length)fail();
  return{operation:'set-permissions',expectedRevision:Number(v.expectedRevision),projectIds};
}
