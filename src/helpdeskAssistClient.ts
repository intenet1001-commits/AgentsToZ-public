import {terminalLocalRequest} from './aiTerminalClient';
import {WorkroomBrowserError} from './workroomBrowserErrorCodes';
import type {WorkroomBrowserRequester} from './workroomBrowserClient';
import type {WorkroomBrowserResult} from './workroomBrowserProtocol';
import {HELPDESK_ASSIST_PATH,OPEN_HELPDESK_ASSIST_EVENT,type AssistBrowserRequest,type AssistIntent,type AssistView} from './helpdeskAssistProtocol';
export type AssistTransport=(body:Record<string,unknown>)=>Promise<AssistView>;
export const nativeAssistTransport:AssistTransport=body=>terminalLocalRequest(HELPDESK_ASSIST_PATH,body);
/** Entry points ask the app to open the helpdesk in this mode; the helpdesk itself decides nothing until the person
 * confirms a scope there. */
export function openHelpdeskAssist(intent:AssistIntent){window.dispatchEvent(new CustomEvent<AssistIntent>(OPEN_HELPDESK_ASSIST_EVENT,{detail:intent}));}
/** The built-in view's own management for the help's run, as the Workroom panel does it: connect, select, take, detach
 * and status. A page release is not this view's to make; it reads the status instead. A grant or an agent action never
 * travels here. */
export function assistBrowserRequester(transport:AssistTransport,runId:string):WorkroomBrowserRequester{
 return async r=>{
  const browser:AssistBrowserRequest=r.operation==='connect-owned'?{operation:'connect-owned',port:r.port,pageId:r.pageId}
   :r.operation==='select'?{operation:'select',pageId:r.pageId}:r.operation==='take'||r.operation==='detach'?{operation:r.operation}:{operation:'status'};
  const view=await transport({operation:'assist-browser',runId,browser});const result=view.browser as WorkroomBrowserResult|undefined;
  if(!result||result.success!==true)throw new WorkroomBrowserError('workspace-changed',result&&typeof result.error==='string'?result.error:'아젠투지브라우저 상태를 확인하지 못했습니다.');
  return result;
 };
}
