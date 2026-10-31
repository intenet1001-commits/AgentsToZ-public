/** A provider CLI's stderr may echo the entire private prompt. Never put it in an Error/API response. */
export class ProjectMemoryAgentFailure extends Error {
  readonly code = 'PROJECT_MEMORY_AGENT_FAILED';
  constructor(readonly agent: 'claude' | 'codex', readonly exitCode: number) {
    super(`${agent === 'codex' ? 'Codex' : 'Claude'} 기억 정리가 실패했습니다. 워크룸에서 로그인·모델 설정과 연결 상태를 확인하세요.`);
    this.name = 'ProjectMemoryAgentFailure';
  }
}

export function projectMemoryAgentOutput(agent:'claude'|'codex',result:{exitCode:number;stdout:string;stderr:string}):string {
  if(result.exitCode!==0)throw new ProjectMemoryAgentFailure(agent,result.exitCode);
  return result.stdout;
}
