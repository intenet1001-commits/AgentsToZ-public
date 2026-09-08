import type {AiTerminalService} from './aiTerminalService';
import type {AiTerminalSummary} from './aiTerminalProtocol';
import type {RemoteTerminalGateway} from './remoteControlTerminalProtocol';
import type {RemoteControlTaskTargetBinding} from './remoteControlCore';
export function createAiTerminalRemoteGateway(deps:{service:AiTerminalService;active:(owner:string)=>boolean;resolve:(bindings:readonly RemoteControlTaskTargetBinding[])=>Promise<readonly {controlId:string;runtimeTargetId:string}[]>}):RemoteTerminalGateway {
 return async(request,bindings,owner)=>{
  const allowed=()=>deps.active(owner)&&deps.service.remoteAllowed(owner);
  if(!allowed())throw new Error('Mac의 AI 터미널에서 이 원격 연결의 터미널 접근을 허용하세요.');
  const authorities=await deps.resolve(bindings);
  if(!allowed())throw new Error('원격 터미널 권한이 해제되었습니다.');
  const ids=new Map(authorities.map(a=>[a.controlId,a.runtimeTargetId]));
  const targetId=request.targetId?ids.get(request.targetId):undefined;
  if(request.targetId&&!targetId)throw new Error('이 연결에 등록된 프로젝트가 아닙니다.');
  const response=await deps.service.perform({...request,...(targetId?{targetId}:{})},{owner,targets:new Set(ids.values()),isActive:()=>deps.active(owner)});
  if(!allowed())throw new Error('원격 터미널 권한이 해제되었습니다.');
  const project=(s:AiTerminalSummary)=>({...s,targetId:authorities.find(a=>a.runtimeTargetId===s.targetId)!.controlId});
  return {...response,...(response.session?{session:project(response.session)}:{}),...(response.sessions?{sessions:response.sessions.map(project)}:{})};
 };
}
