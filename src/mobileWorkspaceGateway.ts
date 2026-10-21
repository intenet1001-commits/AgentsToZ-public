import {isWorkroomThreadAction} from './workroomThreadProtocol';
import type { RemoteTerminalGateway } from './remoteControlTerminalProtocol';
import type { AiTerminalRequest, AiTerminalResponse } from './aiTerminalProtocol';
import type { RemoteControlTaskTargetBinding } from './remoteControlCore';
import type { MetaMemoryRemoteRequest, MetaMemoryRemoteResponse } from './metaCommonMemoryRemoteProtocol';
import { metaMemoryRemoteRefusal } from './metaCommonMemoryRemoteHost';
import { REMOTE_HISTORY_COMMUNITY_REFUSAL, REMOTE_HISTORY_SCOPE_LABELS, isRemoteHistoryAction, isRemoteRestartAction, remoteHistoryScopeFor, type RemoteHistoryResult, type RemoteHistoryScope } from './workroomHistoryRemoteProtocol';
import { WORKROOM_ATTACH_COMMUNITY_REFUSAL, WORKROOM_ATTACH_RATE_PER_MINUTE, isWorkroomAttachAction } from './workroomRemoteAttachmentProtocol';
import { MOBILE_WORKSPACE_SCOPE_LABELS, normalizeMobileWorkspaceRequest, normalizeMobileWorkspaceResult, workspaceScope, type MobileWorkspaceRequest, type MobileWorkspaceResult, type MobileWorkspaceScope } from './mobileWorkspaceProtocol';

export function createMobileWorkspaceGateway(deps: {
  terminal: RemoteTerminalGateway;
  testerSupported?:boolean;
  deviceMemory?(request:MetaMemoryRemoteRequest,owner:string,active:()=>boolean,canImport:()=>boolean):Promise<MetaMemoryRemoteResponse>;
  metaMemory?(request:MetaMemoryRemoteRequest,owner:string,active:()=>boolean):Promise<MetaMemoryRemoteResponse>;
  commonMemory?(request:MetaMemoryRemoteRequest,owner:string,active:()=>boolean,canAdd:(rootId?:string,identity?:string)=>boolean):Promise<MetaMemoryRemoteResponse>;
  active(owner:string):boolean;
  resolve(bindings:readonly RemoteControlTaskTargetBinding[]):Promise<readonly {controlId:string;runtimeTargetId:string}[]>;
  consent(owner:string, authorities:readonly {controlId:string;runtimeTargetId:string}[],bindings:readonly RemoteControlTaskTargetBinding[]):Promise<{targetIds:ReadonlySet<string>;workspaceScopes:readonly MobileWorkspaceScope[];historyScopes?:readonly RemoteHistoryScope[];projectRoots?:readonly {workspaceRootId:string;identityHash:string}[];isActive():boolean;executionAllowed?:()=>boolean;requestOwner:string}|null>;
  perform(request:MobileWorkspaceRequest,targetId:string,owner:string,active:()=>boolean,testerAccess?:{canRun:boolean;executionAllowed:()=>boolean},authorizedTargetIds?:ReadonlySet<string>,threadAccess?:{readAll:boolean}):Promise<MobileWorkspaceResult>;
  /** Workroom conversation history for one authorized project. Runs only with the separate `historyScopes` grant;
   *  `allowed` re-checks the grant and the connection at the launch boundary of a resume. */
  history?(request:MobileWorkspaceRequest,targetId:string,owner:string,access:{canResume:boolean;accountSelect:boolean;allowed:()=>boolean;targets?:ReadonlySet<string>;controlIds?:ReadonlyMap<string,string>;canRead?:boolean}):Promise<RemoteHistoryResult>;
  /** This Mac's OPS runtime target id — the scope that lets a phone drive the community at all. */
  opsRuntimeTargetId?():string|null;
  /** Hand one request to another community device and return its answer unchanged. */
  forward?(deviceRef:string,request:AiTerminalRequest|MobileWorkspaceRequest):Promise<AiTerminalResponse|MobileWorkspaceResult>;
}):RemoteTerminalGateway {
  const reads=new Map<string,{since:number;count:number}>(),mediaReads=new Map<string,{since:number;count:number}>(),vocSubmits=new Map<string,{since:number;count:number}>(),attachReceives=new Map<string,{since:number;count:number}>(),metaTransfers=new Map<string,{since:number;count:number}>();
  return async (request,bindings,owner,transportActive=()=>true,device,receiptOwner) => {
    // 다른 아젠투지의 워크룸 — 이 Mac은 우체통이다. 요청·응답은 그대로 지나가고(그 기기가 자기
    // 엄격한 검사를 다시 한다) 이 Mac에서 보는 것은 **참조를 되돌릴 자격**뿐이다: 이 휴대폰이 이
    // Mac의 OPS 범위를 허락받았는가. 프로젝트 범위는 저쪽 Mac의 것이므로 여기서 대조하지 않는다.
    if(device!==undefined){
      if(request.operation==='workspace'&&['meta-memory','common-memory','common-memory.bind','device-memory'].includes(request.workspace.action))throw new Error('공통 기억은 관리할 Mac에 직접 연결해서 사용하세요.');
      // History is granted per phone on the Mac that holds it; this Mac's grant says nothing about another device's history.
      if(request.operation==='workspace'&&isRemoteHistoryAction(request.workspace.action))throw new Error(REMOTE_HISTORY_COMMUNITY_REFUSAL);
      // Attachment ids are bound to this Mac's ledger; another AgentsToZ has its own (and its own bucket rules).
      if(request.operation==='workspace'&&isWorkroomAttachAction(request.workspace.action))throw new Error(WORKROOM_ATTACH_COMMUNITY_REFUSAL);
      // …and a submission naming them would only be refused there (its ids mean nothing on that Mac): say why here.
      if(request.operation==='submission'&&request.submission&&(request.submission.phase==='begin'||request.submission.phase==='single')&&request.submission.attachments?.length)throw new Error(WORKROOM_ATTACH_COMMUNITY_REFUSAL);
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
    if(request.operation!=='workspace')return deps.terminal(request,bindings,owner,transportActive,undefined,receiptOwner);
    normalizeMobileWorkspaceRequest(request);
    const tester=request.workspace.action.startsWith('tester.');
    if(tester&&!deps.testerSupported)throw new Error('연결한 Mac 앱을 업데이트하면 테스터를 사용할 수 있습니다.');
    // A common-memory v2 `call` refused here never ran. Answer it as a refused result: a thrown error reaches the phone as a
    // bare message, which it must treat as a possibly-executed mutation (and keep its form blocked).
    const v2Call=(request.workspace.action==='common-memory'||request.workspace.action==='meta-memory'||request.workspace.action==='device-memory')&&request.workspace.meta?.phase==='call'?request.workspace.meta:null;
    const refuse=(message:string):MobileWorkspaceResult=>{if(!v2Call)throw new Error(message);return normalizeMobileWorkspaceResult({kind:'workspace',action:request.workspace.action,meta:metaMemoryRemoteRefusal(v2Call.rpcId,message)});};
    const active=()=>deps.active(owner)&&transportActive();
    if(!active())return refuse('등록한 기기에 다시 연결하세요.');
    const now=Date.now();
    // Subtitles are part of the live conversation (one per finished line), so they share the media budget;
    // on the 60-per-minute read budget a lively talk starved the 5-second state check and ended the voice.
    const realtime=request.workspace.action==='voice'&&(!!request.workspace.voice?.action.startsWith('media.')||request.workspace.voice?.action==='caption');
    // 2,048 input frames at 48 kHz are about 43 ms; append plus output polling
    // stays below this 35 requests/second ceiling without opening an unbounded path.
    // A VOC carries up to five photos the Mac downloads; ten per minute is far above a person typing notes.
    // `voc.inbox` only reads bounded summaries, so it spends the read budget, never the VOC-submit one.
    const voc=request.workspace.action==='voc.submit';
    // A receive makes this Mac download up to five files (bounded again by the ledger's live, host-wide and daily limits);
    // its status is a read and spends the read budget.
    const attach=request.workspace.action==='attachments.receive';
    const cloud=request.workspace.action==='common-memory';
    const deviceMemory=request.workspace.action==='device-memory';
    const meta=cloud||deviceMemory||request.workspace.action==='meta-memory';
    const budgets=meta?metaTransfers:realtime?mediaReads:voc?vocSubmits:attach?attachReceives:reads,limit=meta?(cloud?600:300):realtime?2100:voc?10:attach?WORKROOM_ATTACH_RATE_PER_MINUTE:60;
    for(const [key,entry] of budgets)if(now-entry.since>=60000)budgets.delete(key);
    const budget=budgets.get(owner);
    if(budget?budget.count>=limit:budgets.size>=16)return refuse(realtime?'모바일 음성 데이터 요청이 많습니다. 음성을 다시 연결하세요.':voc?'VOC를 너무 자주 보냈습니다. 잠시 후 다시 보내 주세요.':attach?'첨부를 너무 자주 보냈습니다. 잠시 후 다시 넣어 주세요. (WORKROOM_ATTACH_RATE_LIMITED)':'모바일 조회 요청이 많습니다. 잠시 후 다시 확인하세요.');
    if(budget)budget.count++;else budgets.set(owner,{since:now,count:1});
    const authorities=meta?[]:await deps.resolve(bindings);
    const consent=await deps.consent(owner,authorities,meta?[]:bindings);
    if(meta){
      // This independently opted-in scope is host-wide. It neither needs an original
      // project nor authorizes terminal access to any additional project.
      if(!consent||!consent.workspaceScopes.includes(deviceMemory?'ops-memory.manage':cloud?'common-memory.manage':'meta-memory.manage'))return refuse(deviceMemory?'Mac 연결 설정에서 이 기기의 ‘기기 운영기억 조회·저장’ 권한을 따로 허용하세요.':'Mac의 외부 인터넷 QR 원격제어에서 이 기기의 ‘공통기억 조회·관리’ 권한을 따로 허용하세요.');
      if(deviceMemory?!deps.deviceMemory:cloud?!deps.commonMemory:!deps.metaMemory)return refuse('연결한 Mac 앱을 업데이트하면 공통 기억을 관리할 수 있습니다.');
      const allowed=()=>active()&&consent.isActive();
      if(!allowed())return refuse('공통 기억 관리 권한이 변경되었습니다.');
      const result=deviceMemory?await deps.deviceMemory!(request.workspace.meta!,consent.requestOwner,allowed,()=>allowed()&&consent.workspaceScopes.includes('meta-memory.manage')):cloud?await deps.commonMemory!(request.workspace.meta!,consent.requestOwner,allowed,(rootId,identity)=>allowed()&&consent.workspaceScopes.includes('projects.add')&&!!consent.projectRoots?.some(r=>(!rootId||r.workspaceRootId===rootId)&&(!identity||r.identityHash===identity))):await deps.metaMemory!(request.workspace.meta!,consent.requestOwner,allowed);
      if(!allowed())throw new Error('공통 기억 관리 권한이 변경되었습니다. 결과를 다시 확인하세요.');
      return normalizeMobileWorkspaceResult({kind:'workspace',action:request.workspace.action,meta:result});
    }
    const target=authorities.find(a=>a.controlId===request.targetId);
    // The restart offer (w14) is about every project this phone may use; the one it is asked through is only a channel the
    // phone was shown. Its rows are still cut to the grant on the Mac (`controlIds` below), so naming another project gains nothing.
    const restart=isRemoteRestartAction(request.workspace.action);
    if(!consent||!target||!restart&&!consent.targetIds.has(target.runtimeTargetId))throw new Error('Mac의 외부 인터넷 QR 원격제어에서 이 기기가 사용할 프로젝트 범위를 허용하세요.');
    if(isRemoteHistoryAction(request.workspace.action)){
      const scopes=consent.historyScopes??[],needed=remoteHistoryScopeFor(request.workspace.action);
      // The restart offer to a phone without ‘워크룸 대화 기록 보기’ (w14 review): only how many sessions of its own projects a
      // restart ended — no rows, no titles — so its banner can say which permission would let it reopen them instead of
      // staying silent. Every other history action still needs the read permission.
      const countOnly=request.workspace.action==='history.restart'&&!scopes.includes('history.read');
      if(!scopes.includes('history.read')&&!countOnly)throw new Error(`Mac의 외부 인터넷 QR 원격제어에서 이 기기의 ‘${REMOTE_HISTORY_SCOPE_LABELS['history.read']}’(대화 기록) 권한을 허용하세요.`);
      if(!countOnly&&!scopes.includes(needed))throw new Error(`Mac의 외부 인터넷 QR 원격제어에서 이 기기의 ‘${REMOTE_HISTORY_SCOPE_LABELS[needed]}’ 권한을 허용하세요.`);
      if(!deps.history)throw new Error('연결한 Mac 앱을 업데이트하면 대화 기록을 볼 수 있습니다.');
      const allowed=countOnly?()=>active()&&consent.isActive():()=>active()&&consent.isActive()&&!!consent.historyScopes?.includes(needed);
      if(!allowed())throw new Error('대화 기록 권한이 변경되었습니다.');
      // Host-only: this phone's own control id for each project it may use (never on the wire back).
      const controlIds=new Map<string,string>();
      for(const authority of authorities)if(consent.targetIds.has(authority.runtimeTargetId)&&!controlIds.has(authority.runtimeTargetId))controlIds.set(authority.runtimeTargetId,authority.controlId);
      const history=await deps.history(request,target.runtimeTargetId,consent.requestOwner,{canResume:!countOnly&&scopes.includes('history.resume'),accountSelect:consent.workspaceScopes.includes('account.select'),allowed,targets:consent.targetIds,controlIds,...(countOnly?{canRead:false}:{})});
      if(!allowed())throw new Error('대화 기록 권한이 변경되었습니다. 결과를 다시 확인하세요.');
      return normalizeMobileWorkspaceResult({kind:'workspace',action:request.workspace.action,history});
    }
    if(request.workspace.action==='common-memory.bind'&&!consent.workspaceScopes.includes('common-memory.manage'))throw new Error('공통기억 연결에는 클라우드 공통기억 권한도 필요합니다.');
    const requiredScope=workspaceScope(request.workspace.action);
    if(requiredScope&&!consent.workspaceScopes.includes(requiredScope))throw new Error(`Mac의 외부 인터넷 QR 원격제어에서 이 기기의 ‘${MOBILE_WORKSPACE_SCOPE_LABELS[requiredScope]}’ 권한을 허용하세요.`);
    if(tester&&!consent.workspaceScopes.includes('tester.read'))throw new Error('Mac의 워크룸 연결 설정에서 테스트 결과 조회를 허용하세요.');
    const allowed=()=>active()&&consent.isActive();
    if(!allowed())throw new Error('모바일 작업 권한이 변경되었습니다.');
    let mapped=request;
    const threads=isWorkroomThreadAction(request.workspace.action);
    const controlIds=new Map<string,string>();
    for(const a of authorities)if(consent.targetIds.has(a.runtimeTargetId)&&!controlIds.has(a.runtimeTargetId))controlIds.set(a.runtimeTargetId,a.controlId);
    controlIds.set(target.runtimeTargetId,request.targetId);
    if(threads){
      const resolve=(id:string)=>{const a=authorities.find(v=>v.controlId===id);if(!a||!consent.targetIds.has(a.runtimeTargetId))throw Error('호출할 프로젝트의 연결 권한을 확인하세요.');return a.runtimeTargetId;};
      const thread=request.workspace.thread!;
      mapped={...request,workspace:{...request.workspace,thread:{...thread,...(thread.targetIds?{targetIds:thread.targetIds.map(resolve)}:{}),...(thread.recipientTargetId?{recipientTargetId:resolve(thread.recipientTargetId)}:{})}}};
    }
    // Task journals are shared within the approved projects, regardless of which device
    // created them. Raw Workroom conversation history retains its separate scope above.
    const result=await deps.perform(mapped,target.runtimeTargetId,consent.requestOwner,allowed,tester?{canRun:consent.workspaceScopes.includes('tester.run'),executionAllowed:consent.executionAllowed??(()=>false)}:undefined,consent.targetIds,{readAll:threads});
    if(!allowed())throw new Error('모바일 작업 권한이 변경되었습니다. 결과를 다시 확인하세요.');
    if(result.action!==request.workspace.action)throw new Error('모바일 작업 결과가 요청과 다릅니다.');
    if(threads&&result.threads){
      const control=(id:string)=>{const c=controlIds.get(id);if(!c)throw Error('공동 업무의 프로젝트 권한이 변경되었습니다.');return c;};
      const summary=(t:NonNullable<typeof result.threads>['thread'])=>t?{...t,...(t.participants?{participants:t.participants.map(p=>({...p,targetId:control(p.targetId)}))}:{})}:t;
      result.threads={...result.threads,...(result.threads.thread?{thread:summary(result.threads.thread)}:{}),...(result.threads.threads?{threads:result.threads.threads.map(t=>summary(t)!)}:{}),...(result.threads.messages?{messages:result.threads.messages.map(m=>m.targetId?{...m,targetId:control(m.targetId)}:m)}:{})};
    }
    return normalizeMobileWorkspaceResult(result);
  };
}
