import type {AiTerminalService} from './aiTerminalService';
import type {AiTerminalSummary,AiTerminalResponse} from './aiTerminalProtocol';
import type {RemoteTerminalGateway} from './remoteControlTerminalProtocol';
import type {RemoteControlTaskTargetBinding} from './remoteControlCore';
export interface RemoteTerminalDeviceConsent {targetIds:ReadonlySet<string>;isActive:()=>boolean;requestOwner?:string;workspaceScopes?:readonly string[]}
export function createAiTerminalRemoteGateway(deps:{
 service:AiTerminalService;
 active:(owner:string)=>boolean;
 /** `readOnly` (output reads, session lists) may be served from a short cache; anything that acts must not. */
 resolve:(bindings:readonly RemoteControlTaskTargetBinding[],readOnly?:boolean)=>Promise<readonly {controlId:string;runtimeTargetId:string}[]>;
 /** Returns only explicitly granted durable consent; null retains the legacy socket-only flow. */
 consent?:(owner:string,authorities:readonly {controlId:string;runtimeTargetId:string}[],bindings:readonly RemoteControlTaskTargetBinding[])=>Promise<RemoteTerminalDeviceConsent|null>;
}):(...args:Parameters<RemoteTerminalGateway>)=>Promise<AiTerminalResponse> {
 // `receiptOwner` (6th argument, transport-supplied, never from the wire) is the stable principal a whole-request
 // submission receipt is filed under — a LAN controller keeps it across the restore that rotates `owner`. Durable
 // consent keeps its own requestOwner. It is a lookup namespace only: every grant check below reads `owner`/consent.
 return async(request,bindings,owner,transportActive=()=>true,_device,receiptOwner)=>{
  if(request.operation==='workspace')throw new Error('이 호스트는 모바일 기록 작업을 지원하지 않습니다.');
  const active=()=>deps.active(owner)&&transportActive();
  if(!active())throw new Error('원격 연결이 종료되어 터미널 접근이 허용되지 않습니다.');
  const authorities=await deps.resolve(bindings,request.operation==='read'||request.operation==='list'||request.operation==='accounts'&&request.accountAction==='list');
  // A launch submission names its project inside `submission.launch` (terminal-start-submission-v1).
  const launch=request.operation==='submission'&&request.submission&&(request.submission.phase==='begin'||request.submission.phase==='single')?request.submission.launch:undefined;
  for(const controlId of [request.targetId,launch?.targetId])
   if(controlId&&!authorities.some(a=>a.controlId===controlId))throw new Error('이 프로젝트의 폴더 또는 Git 연결을 확인하지 못했습니다. Mac에서 프로젝트 경로를 확인한 뒤 다시 시도하세요.');
  const consent=await deps.consent?.(owner,authorities,bindings);
  const allowed=()=>active()&&(consent?consent.isActive():deps.service.remoteAllowed(owner));
  if(!allowed())throw new Error('Mac에서 이 기기의 워크룸 작업을 허용하세요.');
  const permitted=consent?authorities.filter(a=>consent.targetIds.has(a.runtimeTargetId)):authorities;
  const ids=new Map(permitted.map(a=>[a.controlId,a.runtimeTargetId]));
  const targetId=request.targetId?ids.get(request.targetId):undefined;
  if(request.targetId&&!targetId)throw new Error('이 기기에 허용된 프로젝트가 아닙니다.');
  const launchTarget=launch?ids.get(launch.targetId):undefined;
  if(launch&&!launchTarget)throw new Error('이 기기에 허용된 프로젝트가 아닙니다.');
  const submission=launch&&launchTarget?{...request.submission!,launch:{...launch,targetId:launchTarget}}:undefined;
  // `#` references use the same allowlist as a start: a phone cannot point the AI at a project it was not granted.
  const references=request.references?.map(id=>{const runtime=ids.get(id);if(!runtime)throw new Error('참고할 프로젝트에 대한 권한이 없습니다.');return runtime;});
  const response=await deps.service.perform({...request,...(targetId?{targetId}:{}),...(references?{references}:{}),...(submission?{submission}:{})},{owner:consent?.requestOwner??owner,targets:new Set(ids.values()),isActive:active,
   accountSelectionAllowed:()=>!!consent?.workspaceScopes?.includes('account.select')&&allowed(),...(consent?{deviceConsentActive:consent.isActive}:{})},
   {receiptOwner:consent?.requestOwner??receiptOwner??owner});
  if(!allowed())throw new Error('원격 터미널 권한이 해제되었습니다.');
  // Old phones strictly validate v1 summaries. Keep their shape until the request itself opts
  // into a registered account (only a new client can send accountId). Account lists have their own DTO.
  const project=(s:AiTerminalSummary)=>{
   const {accountId,accountLabel,...legacy}=s;
   return {...legacy,...(request.accountId!==undefined&&accountId?{accountId,accountLabel}:{}),targetId:permitted.find(a=>a.runtimeTargetId===s.targetId)!.controlId};
  };
  // Launch receipts name their target too (terminal-start-submission-v1): the phone knows only its control ids. A
  // receipt whose target this connection may not see is dropped from `recent` (the service already hides those).
  const controlOf=(runtime:string)=>permitted.find(a=>a.runtimeTargetId===runtime)?.controlId;
  const receipt=<T extends {targetId?:string}>(r:T)=>{if(r.targetId===undefined)return r;const controlId=controlOf(r.targetId);if(!controlId)throw new Error('이 프로젝트의 제출 기록 권한이 없습니다.');return {...r,targetId:controlId};};
  return {...response,...(response.session?{session:project(response.session)}:{}),...(response.sessions?{sessions:response.sessions.map(project)}:{}),
   ...(response.submission?{submission:receipt(response.submission)}:{}),
   ...(response.submissions?{submissions:response.submissions.filter(r=>r.targetId===undefined||controlOf(r.targetId)).map(receipt)}:{})};
 };
}
