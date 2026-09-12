import {AI_TERMINAL_PREFIX} from './aiTerminalProtocol';
export function isMemoryProviderProbeRequest(path:string,body:unknown):boolean {
 if(path!==AI_TERMINAL_PREFIX+'/memory'||!body||typeof body!=='object'||Array.isArray(body))return false;
 const operation=(body as {automaticOperation?:unknown}).automaticOperation;
 return operation==='prepare-provider'||operation==='revalidate-provider'||operation==='verify-recovery-provider';
}
export function memoryRecoveryRequestKind(path:string,body:unknown):'review'|'execute'|null {
 if(path!==AI_TERMINAL_PREFIX+'/memory'||!body||typeof body!=='object'||Array.isArray(body))return null;
 const op=(body as {automaticOperation?:unknown}).automaticOperation;
 return op==='review-recovery'||op==='review-recovery-provider'?'review':op==='execute-recovery'?'execute':null;
}
/** Exact explicit operations only; status/ordinary terminal requests stay short. */
export function terminalRequestTimeoutMs(path:string,body:unknown):number {
 if(path==='/api/agent-runtime/cs-duty'&&body&&typeof body==='object'&&'operation' in body&&body.operation==='enable')return 80000;
 const recovery=memoryRecoveryRequestKind(path,body);
 return recovery==='execute'?380_000:recovery==='review'||isMemoryProviderProbeRequest(path,body)?80_000:15_000;
}
export const MEMORY_PROVIDER_PROBE_UNCONFIRMED='모델 연결 검사 결과를 아직 확인하지 못했습니다. 자동 정리를 껐다 켜거나 바로 재실행하지 말고 상태를 다시 확인하세요.';

export const MEMORY_RECOVERY_UNCONFIRMED='복구 요청 결과를 아직 확인하지 못했습니다. AI를 다시 실행하지 말고 상태 다시 확인을 누르세요. 이전 기록과 호출 한도는 보존됩니다.';
