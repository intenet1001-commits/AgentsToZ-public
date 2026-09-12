import type {AiTerminalService} from './aiTerminalService';
import type {AiTerminalSummary,AiTerminalResponse} from './aiTerminalProtocol';
import type {RemoteTerminalGateway} from './remoteControlTerminalProtocol';
import type {RemoteControlTaskTargetBinding} from './remoteControlCore';
export interface RemoteTerminalDeviceConsent {targetIds:ReadonlySet<string>;isActive:()=>boolean;requestOwner?:string}
export function createAiTerminalRemoteGateway(deps:{
 service:AiTerminalService;
 active:(owner:string)=>boolean;
 resolve:(bindings:readonly RemoteControlTaskTargetBinding[])=>Promise<readonly {controlId:string;runtimeTargetId:string}[]>;
 /** Returns only explicitly granted durable consent; null retains the legacy socket-only flow. */
 consent?:(owner:string,authorities:readonly {controlId:string;runtimeTargetId:string}[],bindings:readonly RemoteControlTaskTargetBinding[])=>Promise<RemoteTerminalDeviceConsent|null>;
}):(...args:Parameters<RemoteTerminalGateway>)=>Promise<AiTerminalResponse> {
 return async(request,bindings,owner,transportActive=()=>true)=>{
  if(request.operation==='workspace')throw new Error('이 호스트는 모바일 기록 작업을 지원하지 않습니다.');
  const active=()=>deps.active(owner)&&transportActive();
  if(!active())throw new Error('원격 연결이 종료되어 터미널 접근이 허용되지 않습니다.');
  const authorities=await deps.resolve(bindings);
  const consent=await deps.consent?.(owner,authorities,bindings);
  const allowed=()=>active()&&(consent?consent.isActive():deps.service.remoteAllowed(owner));
  if(!allowed())throw new Error('Mac에서 이 기기의 워크룸 작업을 허용하세요.');
  const permitted=consent?authorities.filter(a=>consent.targetIds.has(a.runtimeTargetId)):authorities;
  const ids=new Map(permitted.map(a=>[a.controlId,a.runtimeTargetId]));
  const targetId=request.targetId?ids.get(request.targetId):undefined;
  if(request.targetId&&!targetId)throw new Error('이 기기에 허용된 프로젝트가 아닙니다.');
  const response=await deps.service.perform({...request,...(targetId?{targetId}:{})},{owner:consent?.requestOwner??owner,targets:new Set(ids.values()),isActive:active,...(consent?{deviceConsentActive:consent.isActive}:{})});
  if(!allowed())throw new Error('원격 터미널 권한이 해제되었습니다.');
  const project=(s:AiTerminalSummary)=>({...s,targetId:permitted.find(a=>a.runtimeTargetId===s.targetId)!.controlId});
  return {...response,...(response.session?{session:project(response.session)}:{}),...(response.sessions?{sessions:response.sessions.map(project)}:{})};
 };
}
