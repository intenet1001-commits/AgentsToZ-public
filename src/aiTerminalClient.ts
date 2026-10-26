import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './lib/env';
import { AI_TERMINAL_PREFIX, normalizeAiTerminalResponse, type AiTerminalRequest, type AiTerminalResponse } from './aiTerminalProtocol';
import {isMemoryProviderProbeRequest,terminalRequestTimeoutMs,MEMORY_PROVIDER_PROBE_UNCONFIRMED,memoryRecoveryRequestKind,MEMORY_RECOVERY_UNCONFIRMED} from './aiTerminalRequestPolicy';
export type AiTerminalTransport = (request: AiTerminalRequest) => Promise<AiTerminalResponse>;
export class AiTerminalServerResponseError extends Error {
  readonly serverRejected = true;
}
export async function terminalLocalRequest(path: string, body: unknown): Promise<any> {
  if(isTauri()) {
    const result=await invoke<{status:number;body:any}>('agent_runtime_request',{path,method:'POST',body}).catch(error=>{
      if(memoryRecoveryRequestKind(path,body))throw new Error(MEMORY_RECOVERY_UNCONFIRMED);
      if(isMemoryProviderProbeRequest(path,body))throw new Error(MEMORY_PROVIDER_PROBE_UNCONFIRMED);throw error;
    });
    if(result.status>=400) throw new AiTerminalServerResponseError(result.body.error || '터미널 요청에 실패했습니다.');
    return result.body;
  }
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(terminalRequestTimeoutMs(path,body))}).catch(error=>{
    if(memoryRecoveryRequestKind(path,body))throw new Error(MEMORY_RECOVERY_UNCONFIRMED);
      if(isMemoryProviderProbeRequest(path,body))throw new Error(MEMORY_PROVIDER_PROBE_UNCONFIRMED);throw error;
  });
  const result=await response.json();
  if(!response.ok) throw new AiTerminalServerResponseError(result.error || '터미널 요청에 실패했습니다.');
  return result;
}
export const localAiTerminalTransport: AiTerminalTransport = async request => normalizeAiTerminalResponse(await terminalLocalRequest(AI_TERMINAL_PREFIX,request));

/**
 * This Mac only: start a Workroom as 「Hermes · Claude」/「Hermes · Codex」 (src/hermesVariants.ts). The enum rides
 * beside the ordinary request and the sidecar strips it before the shared DTO is normalized, so no wire key is added.
 */
export async function localAiTerminalStart(request: AiTerminalRequest, variant?: import('./hermesVariants').HermesVariant | null): Promise<AiTerminalResponse> {
  const {HERMES_VARIANT_START_KEY} = await import('./hermesVariants');
  return normalizeAiTerminalResponse(await terminalLocalRequest(AI_TERMINAL_PREFIX, variant ? {...request, [HERMES_VARIANT_START_KEY]: variant} : request));
}

export const localWorkroomTransport:import('./WorkroomSessionFooter').WorkroomTransport=async request=>{const {normalizeMobileWorkspaceResult}=await import('./mobileWorkspaceProtocol');return normalizeMobileWorkspaceResult(await terminalLocalRequest(AI_TERMINAL_PREFIX,request));};

/**
 * 워크룸 `@` 앱 전달(`src/workroomAppRoute.ts`). 이 Mac의 사이드카에만 간다 — 원격·커뮤니티 경로에는 없다.
 * 거절은 던지지 않고 결과로 돌려준다(화면이 코드와 문구를 그대로 보여 준다). 세 가지를 구분한다:
 * 보내기 전에 거절됨(너무 큼·프록시가 보내기 전 거절) = 실패, 응답을 받음 = 그 응답, 보낸 뒤 응답을 못 받음 =
 * 앱이 열렸는지 알 수 없으므로 실패로 단정하지 않고 「확인하지 못했다」고 말한다.
 */
export async function requestWorkroomAppDispatch(request:import('./workroomAppRoute').WorkroomAppDispatchRequest):Promise<import('./workroomAppRoute').WorkroomAppDispatchResult> {
  const {WORKROOM_APP_DISPATCH_MAX_REQUEST_BYTES,WORKROOM_APP_DISPATCH_PATH,normalizeWorkroomAppDispatchResult,workroomAppDispatchRefusedBeforeSend}=await import('./workroomAppRoute');
  const unconfirmed='앱 전달 결과를 받지 못했습니다. 앱이 열렸는지 직접 확인하세요 — 작업 내용은 입력칸에 그대로 있습니다.';
  const body=JSON.stringify(request);
  if(new TextEncoder().encode(body).length>WORKROOM_APP_DISPATCH_MAX_REQUEST_BYTES)return {ok:false,code:'WORKROOM_APP_DISPATCH_TOO_LARGE',error:'앱 전달 요청이 너무 커서 보내지 않았습니다. 앱은 열리지 않았습니다.'};
  if(isTauri()){
   const result=await invoke<{status:number;body:unknown}>('agent_runtime_request',{path:WORKROOM_APP_DISPATCH_PATH,method:'POST',body:request}).then(value=>({value,refused:null as string|null}),error=>({value:null,refused:workroomAppDispatchRefusedBeforeSend(error)}));
   if(!result.value)return result.refused?{ok:false,code:'WORKROOM_APP_DISPATCH_NOT_SENT',error:`앱 전달 요청을 보내지 못했습니다(${result.refused}). 앱은 열리지 않았습니다.`}:{ok:false,code:'WORKROOM_APP_DISPATCH_UNCONFIRMED',error:unconfirmed};
   return normalizeWorkroomAppDispatchResult(result.value.status,result.value.body);
  }
  const response=await fetch(WORKROOM_APP_DISPATCH_PATH,{method:'POST',headers:{'Content-Type':'application/json'},body,signal:AbortSignal.timeout(80_000)}).catch(()=>null);
  if(!response)return {ok:false,code:'WORKROOM_APP_DISPATCH_UNCONFIRMED',error:unconfirmed};
  return normalizeWorkroomAppDispatchResult(response.status,await response.json().catch(()=>({})));
}

/** 팀 현황 (src/workroomTeamPanel.ts): this Mac's sidecar only — a phone or a peer has no route to it. */
export async function requestWorkroomTeamPanel(request:import('./workroomTeamPanel').TeamPanelRequest):Promise<import('./workroomTeamPanel').TeamPanelResult> {
  const {WORKROOM_TEAM_PANEL_PATH,normalizeTeamPanelResult}=await import('./workroomTeamPanel');
  return normalizeTeamPanelResult(await terminalLocalRequest(WORKROOM_TEAM_PANEL_PATH,request));
}

/** Records only a person's explicit confirmation/report; the host rechecks the session is this team's leader. */
export async function requestWorkroomTeamPanelAction(request:import('./workroomTeamPanelActions').TeamPanelAction):Promise<void> {
  const {WORKROOM_TEAM_PANEL_PATH}=await import('./workroomTeamPanel');
  await terminalLocalRequest(WORKROOM_TEAM_PANEL_PATH,request);
}
export async function requestWorkroomTeamMemberBrief(request:{sessionId:string;teamId:string;memberId:string}):Promise<string> {
  const {WORKROOM_TEAM_PANEL_PATH}=await import('./workroomTeamPanel');
  const result=await terminalLocalRequest(WORKROOM_TEAM_PANEL_PATH,{...request,operation:'copy-brief'});
  if(typeof result.brief!=='string'||new TextEncoder().encode(result.brief).length>64_000)throw Error('팀원 지시문을 확인하지 못했습니다.');
  return result.brief;
}
