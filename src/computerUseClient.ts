import {invoke,isTauri} from '@tauri-apps/api/core';
import {COMPUTER_USE_PATH,type ComputerTarget} from './computerUseProtocol';
import type {ComputerUseScope} from './computerUseScopeProtocol';
export type ComputerUseManagementRequest=
  |{operation:'status'}
  |{operation:'request-approval';connectionId:string;target:ComputerTarget;label:string}
  |{operation:'revoke';id:string}
  |{operation:'disconnect';connectionId:string}
  |{operation:'review-recovery';id:string;confirmed:true}
  |{operation:'scope-status'}
  |{operation:'scope-request-approval';connectionId:string;scope:ComputerUseScope;label:string}
  |{operation:'scope-access-set';enabled:true;scope:ComputerUseScope}
  |{operation:'scope-access-set';enabled:false}
  |{operation:'scope-revoke';id:string}
  |{operation:'scope-review-recovery';id:string;confirmed:true};
export type ComputerUseManagementRequester=(body:ComputerUseManagementRequest)=>Promise<Record<string,any>>;
/**
 * The request's name in Control's review, made from what the person picked (the connection and the scope). It only
 * names the request and never narrows or widens what the AI may do, so the person is not asked to type one.
 * Control accepts 1–100 characters with no control or format characters (window titles can carry bidi marks).
 */
export function computerUseApprovalLabel(connectionLabel:unknown,scopeName:string):string{
  const clean=(value:unknown)=>typeof value==='string'?value.replace(/[\p{Cc}\p{Cf}]/gu,' ').replace(/\s+/g,' ').trim():'';
  let label='';
  for(const character of [clean(connectionLabel)||'AI 연결',clean(scopeName)].filter(Boolean).join(' · ')){
    if(label.length+character.length>100)break;
    label+=character;
  }
  return label.trim();
}
export const requestComputerUse:ComputerUseManagementRequester=async body=>{
  let response:{status:number;body:Record<string,any>};
  if(isTauri())response=await invoke('agent_runtime_request',{path:COMPUTER_USE_PATH,method:'POST',body});
  else{const result=await fetch(COMPUTER_USE_PATH,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});response={status:result.status,body:await result.json()};}
  if(response.status<200||response.status>=300||response.body?.success!==true)throw Error(response.body?.error||'컴퓨터 유즈 상태를 확인하지 못했습니다.');return response.body;
};
export type ComputerUseNativeRequester=(operation:'status'|'catalog'|'scope-status'|'scope-catalog'|'open'|'review')=>Promise<Record<string,any>>;
export const requestComputerUseNative:ComputerUseNativeRequester=async operation=>{
  if(!isTauri())return {success:false,code:'installed-main-required'};
  return invoke('computer_use_native',{operation});
};
