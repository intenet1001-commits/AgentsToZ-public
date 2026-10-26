import {invoke,isTauri} from '@tauri-apps/api/core';
import {BROWSER_ERROR_CODES,WorkroomBrowserError,classifyWorkroomBrowserError} from './workroomBrowserErrorCodes';
import {WORKROOM_BROWSER_PATH,type WorkroomBrowserRequest,type WorkroomBrowserResult} from './workroomBrowserProtocol';
export type WorkroomBrowserRequester=(r:WorkroomBrowserRequest)=>Promise<Extract<WorkroomBrowserResult,{success:true}>>;
export const requestWorkroomBrowser:WorkroomBrowserRequester=async request=>{
 try{
 let body:WorkroomBrowserResult,status:number;
 if(isTauri()){const r=await invoke<{status:number;body:WorkroomBrowserResult}>('agent_runtime_request',{path:WORKROOM_BROWSER_PATH,method:'POST',body:request});body=r.body;status=r.status;}
 else{const r=await fetch(WORKROOM_BROWSER_PATH,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(request.operation==='connect'?150000:40000)});body=await r.json();status=r.status;}
 if(!body||body.success!==true||status<200||status>=300){
  if(body?.success===false&&typeof body.error==='string')throw new WorkroomBrowserError(BROWSER_ERROR_CODES.includes(body.code)?body.code:classifyWorkroomBrowserError(body.error),body.error);
  throw new WorkroomBrowserError('workspace-changed','Invalid browser response.');
 }
 if('workspaceId' in request&&!(request.operation==='detach'&&body.workspace===undefined)&&body.workspace?.id!==request.workspaceId)throw new WorkroomBrowserError('workspace-changed','Browser workspace changed.');
 if(request.operation==='connect'&&(!body.workspace||body.workspace.sessionId!==request.sessionId||body.workspace.targetId!==request.targetId||body.workspace.profileId!==request.profileId))throw new WorkroomBrowserError('workspace-changed','Browser session changed.');
 return body;
 }catch(e){if(e instanceof WorkroomBrowserError)throw e;throw new WorkroomBrowserError(classifyWorkroomBrowserError(e),e instanceof Error?e.message:typeof e==='string'?e:'Browser operation failed.');}
};
