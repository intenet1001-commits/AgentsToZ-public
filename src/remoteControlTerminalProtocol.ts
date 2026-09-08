import {normalizeAiTerminalRequest, normalizeAiTerminalResponse, type AiTerminalRequest,type AiTerminalResponse} from './aiTerminalProtocol';
import type {RemoteControlTaskTargetBinding} from './remoteControlCore';
export interface RemoteTerminalRequest {type:'terminal.request';sessionToken:string;request:AiTerminalRequest}
export interface RemoteTerminalResult {type:'terminal.result';requestId:string;ok:boolean;body?:AiTerminalResponse;error?:string}
export type RemoteTerminalGateway = (r:AiTerminalRequest,bindings:readonly RemoteControlTaskTargetBinding[],owner:string)=>Promise<AiTerminalResponse>;
export function normalizeRemoteTerminalRequest(x:unknown):RemoteTerminalRequest {
 const r=x as RemoteTerminalRequest;
 if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!['type','sessionToken','request'].includes(k))||r.type!=='terminal.request'||typeof r.sessionToken!=='string'||!/^[-\w]{43}$/.test(r.sessionToken))throw new Error('원격 터미널 요청이 올바르지 않습니다.');
 return {type:r.type,sessionToken:r.sessionToken,request:normalizeAiTerminalRequest(r.request)};
}
export function normalizeRemoteTerminalResult(x:unknown):RemoteTerminalResult {
 const r=x as RemoteTerminalResult;
 if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!['type','requestId','ok','body','error'].includes(k))||r.type!=='terminal.result'||typeof r.requestId!=='string'||!/^[-\w]{8,160}$/.test(r.requestId)||typeof r.ok!=='boolean'||JSON.stringify(r).length>60_000)throw new Error('원격 터미널 응답이 올바르지 않습니다.');
 if(r.ok){if(r.error!==undefined)throw new Error('터미널 응답 형식 오류');normalizeAiTerminalResponse(r.body);}
 else if(r.body!==undefined||typeof r.error!=='string'||r.error.length>500)throw new Error('터미널 오류 형식 오류');
 return r;
}
