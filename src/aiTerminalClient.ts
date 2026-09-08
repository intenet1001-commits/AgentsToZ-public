import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './lib/env';
import { AI_TERMINAL_PREFIX, normalizeAiTerminalResponse, type AiTerminalRequest, type AiTerminalResponse } from './aiTerminalProtocol';
export type AiTerminalTransport = (request: AiTerminalRequest) => Promise<AiTerminalResponse>;
export async function terminalLocalRequest(path: string, body: unknown): Promise<any> {
  if(isTauri()) {
    const result=await invoke<{status:number;body:any}>('agent_runtime_request',{path,method:'POST',body});
    if(result.status>=400) throw new Error(result.body.error || '터미널 요청에 실패했습니다.');
    return result.body;
  }
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15_000)});
  const result=await response.json();
  if(!response.ok) throw new Error(result.error || '터미널 요청에 실패했습니다.');
  return result;
}
export const localAiTerminalTransport: AiTerminalTransport = async request => normalizeAiTerminalResponse(await terminalLocalRequest(AI_TERMINAL_PREFIX,request));
