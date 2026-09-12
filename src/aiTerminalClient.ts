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
