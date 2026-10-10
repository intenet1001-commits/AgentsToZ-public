import type { RemoteTerminalGateway } from './remoteControlTerminalProtocol';
import type { AiTerminalRequest, AiTerminalResponse } from './aiTerminalProtocol';
import type { RemoteControlTaskTargetBinding } from './remoteControlCore';
import { MOBILE_WORKSPACE_SCOPE_LABELS, normalizeMobileWorkspaceRequest, normalizeMobileWorkspaceResult, workspaceScope, type MobileWorkspaceRequest, type MobileWorkspaceResult, type MobileWorkspaceScope } from './mobileWorkspaceProtocol';

export function createMobileWorkspaceGateway(deps: {
  terminal: RemoteTerminalGateway;
  testerSupported?:boolean;
  active(owner:string):boolean;
  resolve(bindings:readonly RemoteControlTaskTargetBinding[]):Promise<readonly {controlId:string;runtimeTargetId:string}[]>;
  consent(owner:string, authorities:readonly {controlId:string;runtimeTargetId:string}[],bindings:readonly RemoteControlTaskTargetBinding[]):Promise<{targetIds:ReadonlySet<string>;workspaceScopes:readonly MobileWorkspaceScope[];isActive():boolean;executionAllowed?:()=>boolean;requestOwner:string}|null>;
  perform(request:MobileWorkspaceRequest,targetId:string,owner:string,active:()=>boolean,testerAccess?:{canRun:boolean;executionAllowed:()=>boolean},authorizedTargetIds?:ReadonlySet<string>):Promise<MobileWorkspaceResult>;
  /** This Mac's OPS runtime target id — the scope that lets a phone drive the community at all. */
  opsRuntimeTargetId?():string|null;
  /** Hand one request to another community device and return its answer unchanged. */
  forward?(deviceRef:string,request:AiTerminalRequest|MobileWorkspaceRequest):Promise<AiTerminalResponse|MobileWorkspaceResult>;
}):RemoteTerminalGateway {
  const reads=new Map<string,{since:number;count:number}>(),mediaReads=new Map<string,{since:number;count:number}>(),vocSubmits=new Map<string,{since:number;count:number}>();
  return async (request,bindings,owner,transportActive=()=>true,device) => {
    // 다른 아젠투지의 워크룸 — 이 Mac은 우체통이다. 요청·응답은 그대로 지나가고(그 기기가 자기
    // 엄격한 검사를 다시 한다) 이 Mac에서 보는 것은 **참조를 되돌릴 자격**뿐이다: 이 휴대폰이 이
    // Mac의 OPS 범위를 허락받았는가. 프로젝트 범위는 저쪽 Mac의 것이므로 여기서 대조하지 않는다.
    if(device!==undefined){
      if(!deps.forward||!deps.opsRuntimeTargetId)throw new Error('연결한 Mac 앱을 업데이트하면 다른 아젠투지를 제어할 수 있습니다.');
      const active=()=>deps.active(owner)&&transportActive();
      if(!active())throw new Error('등록한 기기에 다시 연결하세요.');
      const authorities=await deps.resolve(bindings);
      const consent=await deps.consent(owner,authorities,bindings);
      const ops=deps.opsRuntimeTargetId();
      if(!consent||!ops||!consent.targetIds.has(ops))
        throw new Error('Mac의 외부 인터넷 QR 원격제어에서 이 기기에 아젠투지 총괄(OPS) 프로젝트를 허용하세요.');
      if(!active()||!consent.isActive())throw new Error('모바일 작업 권한이 변경되었습니다.');
      const result=await deps.forward(device,request);
      if(!active()||!consent.isActive())throw new Error('모바일 작업 권한이 변경되었습니다. 결과를 다시 확인하세요.');
      return result;
    }
    if(request.operation!=='workspace')return deps.terminal(request,bindings,owner,transportActive);
    normalizeMobileWorkspaceRequest(request);
    const tester=request.workspace.action.startsWith('tester.');
    if(tester&&!deps.testerSupported)throw new Error('연결한 Mac 앱을 업데이트하면 테스터를 사용할 수 있습니다.');
    const active=()=>deps.active(owner)&&transportActive();
    if(!active())throw new Error('등록한 기기에 다시 연결하세요.');
    const now=Date.now();
    // Subtitles are part of the live conversation (one per finished line), so they share the media budget;
    // on the 60-per-minute read budget a lively talk starved the 5-second state check and ended the voice.
    const realtime=request.workspace.action==='voice'&&(!!request.workspace.voice?.action.startsWith('media.')||request.workspace.voice?.action==='caption');
    // 2,048 input frames at 48 kHz are about 43 ms; append plus output polling
    // stays below this 35 requests/second ceiling without opening an unbounded path.
    // A VOC carries up to five photos the Mac downloads; ten per minute is far above a person typing notes.
    // `voc.inbox` only reads bounded summaries, so it spends the read budget, never the VOC-submit one.
    const voc=request.workspace.action==='voc.submit';
    const budgets=realtime?mediaReads:voc?vocSubmits:reads,limit=realtime?2100:voc?10:60;
    for(const [key,entry] of budgets)if(now-entry.since>=60000)budgets.delete(key);
    const budget=budgets.get(owner);
    if(budget?budget.count>=limit:budgets.size>=16)throw new Error(realtime?'모바일 음성 데이터 요청이 많습니다. 음성을 다시 연결하세요.':voc?'VOC를 너무 자주 보냈습니다. 잠시 후 다시 보내 주세요.':'모바일 조회 요청이 많습니다. 잠시 후 다시 확인하세요.');
    if(budget)budget.count++;else budgets.set(owner,{since:now,count:1});
    const authorities=await deps.resolve(bindings);
    const consent=await deps.consent(owner,authorities,bindings);
    const target=authorities.find(a=>a.controlId===request.targetId);
    if(!consent||!target||!consent.targetIds.has(target.runtimeTargetId))throw new Error('Mac의 외부 인터넷 QR 원격제어에서 이 기기가 사용할 프로젝트 범위를 허용하세요.');
    const requiredScope=workspaceScope(request.workspace.action);
    if(requiredScope&&!consent.workspaceScopes.includes(requiredScope))throw new Error(`Mac의 외부 인터넷 QR 원격제어에서 이 기기의 ‘${MOBILE_WORKSPACE_SCOPE_LABELS[requiredScope]}’ 권한을 허용하세요.`);
    if(tester&&!consent.workspaceScopes.includes('tester.read'))throw new Error('Mac의 워크룸 연결 설정에서 테스트 결과 조회를 허용하세요.');
    const allowed=()=>active()&&consent.isActive();
    if(!allowed())throw new Error('모바일 작업 권한이 변경되었습니다.');
    const result=await deps.perform(request,target.runtimeTargetId,consent.requestOwner,allowed,tester?{canRun:consent.workspaceScopes.includes('tester.run'),executionAllowed:consent.executionAllowed??(()=>false)}:undefined,consent.targetIds);
    if(!allowed())throw new Error('모바일 작업 권한이 변경되었습니다. 결과를 다시 확인하세요.');
    if(result.action!==request.workspace.action)throw new Error('모바일 작업 결과가 요청과 다릅니다.');
    return normalizeMobileWorkspaceResult(result);
  };
}
