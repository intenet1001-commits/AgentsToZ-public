import {invoke,isTauri} from '@tauri-apps/api/core';
import {DESKTOP_EFFORT_PATH,type DesktopEffortManagementRequest,type DesktopEffortStatus} from './desktopEffortProtocol';
export type DesktopEffortRequester=(body:DesktopEffortManagementRequest)=>Promise<DesktopEffortStatus>;
export const requestDesktopEffort:DesktopEffortRequester=async body=>{
  let result:{status:number;body:Record<string,any>};
  if(isTauri())result=await invoke('agent_runtime_request',{path:DESKTOP_EFFORT_PATH,method:'POST',body});
  else{const r=await fetch(DESKTOP_EFFORT_PATH,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});result={status:r.status,body:await r.json()};}
  if(result.status<200||result.status>=300||result.body.success!==true)throw Error(result.body.error||'외부 앱 세션을 확인하지 못했습니다.');
  return result.body as DesktopEffortStatus;
};
