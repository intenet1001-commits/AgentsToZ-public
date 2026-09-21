import type {AiTerminalAgent, AiTerminalRequest, AiTerminalResponse, AiTerminalSummary} from './aiTerminalProtocol';

/** Reuse exact live sessions and retain an uncertain start ID for bounded retries. */
export class ProjectWorkroomLauncher {
  readonly #pending = new Map<string, string>();
  readonly #inflight = new Map<string, Promise<AiTerminalSummary>>();
  constructor(readonly transport: (request: AiTerminalRequest) => Promise<AiTerminalResponse>, readonly nextId: () => string = () => crypto.randomUUID()) {}
  open(targetId: string, agent: AiTerminalAgent): Promise<AiTerminalSummary> {
    const key = `${targetId}\0${agent}`, prior = this.#inflight.get(key);
    if (prior) return prior;
    const promise = (async () => {
      const listed = await this.transport({operation: 'list', requestId: this.nextId()});
      if (!listed.sessions) throw new Error('워크룸 세션 목록을 확인하지 못했습니다. 잠시 후 다시 확인하세요.');
      const active = listed.sessions.find(session => session.targetId === targetId && session.agent === agent && session.state === 'running');
      if (active) { this.#pending.delete(key); return active; }
      if (!this.#pending.has(key) && this.#pending.size >= 24) throw new Error('이전에 요청한 워크룸 실행 결과를 먼저 확인하세요. 기존 세션은 계속 사용할 수 있습니다.');
      const requestId = this.#pending.get(key) ?? this.nextId();
      this.#pending.set(key, requestId);
      const {session} = await this.transport({operation: 'start', requestId, targetId, agent, cols: 100, rows: 28}).catch(error => {
        // A received server rejection can be retried after CLI setup changes.
        // A timeout/transport error keeps the same request fence instead.
        if (error?.serverRejected === true) this.#pending.delete(key);
        throw error;
      });
      if (!session || session.targetId !== targetId || session.agent !== agent) throw new Error('워크룸 실행 결과를 확인하지 못했습니다. 같은 버튼으로 다시 확인하세요.');
      if (session.state !== 'running') { this.#pending.delete(key); throw new Error('AI 프로세스가 종료되었습니다. 워크룸에서 종료 결과와 CLI 설치·로그인 상태를 확인하세요.'); }
      this.#pending.delete(key);
      return session;
    })().finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, promise);
    return promise;
  }
}
