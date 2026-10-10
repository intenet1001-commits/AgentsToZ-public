import { AgentRuntimeHttpError } from './agentRuntimeHttp';

export type AgentRuntimeStartupState = 'ready' | 'recovery-required' | 'unavailable';

/** Keep filesystem paths, PIDs and raw startup exceptions out of local/mobile DTOs. */
export function agentRuntimeStartupFailure(error: unknown): AgentRuntimeStartupState {
  return error !== null && typeof error === 'object'
    && 'code' in error && error.code === 'FILE_LOCK_RECOVERY_REQUIRED'
    ? 'recovery-required'
    : 'unavailable';
}

export function throwAgentRuntimeUnavailable(state: AgentRuntimeStartupState): never {
  if (state === 'recovery-required') {
    throw new AgentRuntimeHttpError(
      'AGENT_RUNTIME_SUPERVISOR_RECOVERY_REQUIRED',
      '이전 AI 실행의 잠금 복구가 필요합니다. 관련 작업이 모두 종료됐는지 확인해야 하며, 앱 재시작만으로 잠금이 해제되지는 않습니다.',
      503,
    );
  }
  throw new AgentRuntimeHttpError(
    'AGENT_RUNTIME_UNAVAILABLE',
    'AI 실행 관리자를 준비하지 못했습니다. 실행 준비 상태에서 원인을 확인해 주세요.',
    503,
  );
}
