import type { RemoteTerminalGateway } from './remoteControlTerminalProtocol';
import type { RemoteControlTaskTargetBinding } from './remoteControlCore';
import { normalizeMobileWorkspaceRequest, normalizeMobileWorkspaceResult, workspaceScope, type MobileWorkspaceRequest, type MobileWorkspaceResult, type MobileWorkspaceScope } from './mobileWorkspaceProtocol';

export function createMobileWorkspaceGateway(deps: {
  terminal: RemoteTerminalGateway;
  active(owner:string):boolean;
  resolve(bindings:readonly RemoteControlTaskTargetBinding[]):Promise<readonly {controlId:string;runtimeTargetId:string}[]>;
  consent(owner:string, authorities:readonly {controlId:string;runtimeTargetId:string}[],bindings:readonly RemoteControlTaskTargetBinding[]):Promise<{targetIds:ReadonlySet<string>;workspaceScopes:readonly MobileWorkspaceScope[];isActive():boolean;requestOwner:string}|null>;
  perform(request:MobileWorkspaceRequest,targetId:string,owner:string,active:()=>boolean):Promise<MobileWorkspaceResult>;
}):RemoteTerminalGateway {
  const reads=new Map<string,{since:number;count:number}>();
  return async (request,bindings,owner,transportActive=()=>true) => {
    if(request.operation!=='workspace')return deps.terminal(request,bindings,owner,transportActive);
    normalizeMobileWorkspaceRequest(request);
    const active=()=>deps.active(owner)&&transportActive();
    if(!active())throw new Error('등록한 기기에 다시 연결하세요.');
    const now=Date.now();
    for(const [key,entry] of reads)if(now-entry.since>=60000)reads.delete(key);
    const budget=reads.get(owner);
    if(budget?budget.count>=60:reads.size>=16)throw new Error('모바일 조회 요청이 많습니다. 잠시 후 다시 확인하세요.');
    if(budget)budget.count++;else reads.set(owner,{since:now,count:1});
    const authorities=await deps.resolve(bindings);
    const consent=await deps.consent(owner,authorities,bindings);
    const target=authorities.find(a=>a.controlId===request.targetId);
    if(!consent||!target||!consent.targetIds.has(target.runtimeTargetId)||!consent.workspaceScopes.includes(workspaceScope(request.workspace.action)))throw new Error('Mac의 워크룸 연결 설정에서 이 기기의 프로젝트와 기록·관리 권한을 허용하세요.');
    const allowed=()=>active()&&consent.isActive();
    if(!allowed())throw new Error('모바일 작업 권한이 변경되었습니다.');
    const result=await deps.perform(request,target.runtimeTargetId,consent.requestOwner,allowed);
    if(!allowed())throw new Error('모바일 작업 권한이 변경되었습니다. 결과를 다시 확인하세요.');
    if(result.action!==request.workspace.action)throw new Error('모바일 작업 결과가 요청과 다릅니다.');
    return normalizeMobileWorkspaceResult(result);
  };
}
