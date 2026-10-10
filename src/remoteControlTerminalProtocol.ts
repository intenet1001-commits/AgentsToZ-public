import {normalizeMobileWorkspaceRequest,normalizeMobileWorkspaceResult,type MobileWorkspaceRequest,type MobileWorkspaceResult} from './mobileWorkspaceProtocol';
import {normalizeAiTerminalRequest, normalizeAiTerminalResponse, type AiTerminalRequest,type AiTerminalResponse} from './aiTerminalProtocol';
import type {RemoteControlTaskTargetBinding} from './remoteControlCore';
import {isCommunityDeviceRef} from './remoteCommunity';
/**
 * `device`는 **봉투에만** 있다 — 안에 든 요청은 손대지 않는다. 그 요청을 실행하는 쪽(다른 Mac)이
 * 엄격한 키 검사로 다시 보기 때문에, 요청 안에 넣으면 거절되거나(좋은 경우) 조용히 무시돼 **다른
 * 기기로 가야 할 일이 이 Mac에서 실행**된다(나쁜 경우). 참조를 모르는 옛 Mac은 이 키 때문에 봉투를
 * 거절하므로 휴대폰이 「Mac 앱 업데이트 필요」로 옮겨 말한다.
 */
export interface RemoteTerminalRequest {type:'terminal.request';sessionToken:string;request:AiTerminalRequest|MobileWorkspaceRequest;device?:string}
export interface RemoteTerminalResult {type:'terminal.result';requestId:string;ok:boolean;body?:AiTerminalResponse|MobileWorkspaceResult;error?:string}
export type RemoteTerminalGateway = (r:AiTerminalRequest|MobileWorkspaceRequest,bindings:readonly RemoteControlTaskTargetBinding[],owner:string,transportActive?:()=>boolean,device?:string)=>Promise<AiTerminalResponse|MobileWorkspaceResult>;
export function normalizeRemoteTerminalRequest(x:unknown):RemoteTerminalRequest {
 const r=x as RemoteTerminalRequest;
 if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!['type','sessionToken','request','device'].includes(k))||(r.device!==undefined&&!isCommunityDeviceRef(r.device))||r.type!=='terminal.request'||typeof r.sessionToken!=='string'||!/^[-\w]{43}$/.test(r.sessionToken))throw new Error('원격 터미널 요청이 올바르지 않습니다.');
 return {type:r.type,sessionToken:r.sessionToken,request:r.request?.operation==='workspace'?normalizeMobileWorkspaceRequest(r.request):normalizeAiTerminalRequest(r.request),...(r.device!==undefined?{device:r.device}:{})};
}
export function normalizeRemoteTerminalResult(x:unknown):RemoteTerminalResult {
 const r=x as RemoteTerminalResult;
 if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!['type','requestId','ok','body','error'].includes(k))||r.type!=='terminal.result'||typeof r.requestId!=='string'||!/^[-\w]{8,160}$/.test(r.requestId)||typeof r.ok!=='boolean'||JSON.stringify(r).length>60_000)throw new Error('원격 터미널 응답이 올바르지 않습니다.');
 if(r.ok){if(r.error!==undefined)throw new Error('터미널 응답 형식 오류');if(r.body&&'kind' in r.body&&r.body.kind==='workspace')normalizeMobileWorkspaceResult(r.body);else normalizeAiTerminalResponse(r.body);}
 else if(r.body!==undefined||typeof r.error!=='string'||r.error.length>500)throw new Error('터미널 오류 형식 오류');
 return r;
}
