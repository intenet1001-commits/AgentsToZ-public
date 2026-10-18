import {isWorkroomEffortMode, type WorkroomEffortMode} from './workroomEffortMode';
import {classifyWorkroomEffort, workroomEffortRequestText, type WorkroomEffortDecision, type WorkroomEffortLevel} from './workroomEffortPolicy';

/** Host-proven context of the exact registered project and native agent session. */
export interface ProjectAgentEffortSession {
  projectId: string;
  sessionId: string;
  agent: 'codex' | 'claude' | 'hermes' | 'agy';
  model: string;
  provider?: string;
  accountId?: string;
  /** Changes when the execution binding, input or manual selection changes. */
  revision: string;
  effort: string | null;
  supportedEfforts: readonly string[];
  manual: boolean;
  control: 'session' | 'none';
}

export interface ProjectAgentEffortHost {
  mode(): WorkroomEffortMode;
  /** Must reject unregistered, ambiguous or no-longer-owned project/session bindings. */
  resolve(projectId: string, sessionId: string): Promise<ProjectAgentEffortSession>;
  /** Revalidate the supplied binding atomically before using a native session-only control. */
  apply(session: ProjectAgentEffortSession, level: WorkroomEffortLevel): Promise<void>;
}

export interface ProjectAgentEffortRequest {
  projectId: string;
  sessionId: string;
  prompt: string;
  /** Existing task context, supplied by the active agent; no additional model call. */
  context?: {
    concurrency?: boolean;
    privilegeIsolation?: boolean;
    destructiveMigration?: boolean;
    unresolvedFailure?: boolean;
    routineVerification?: boolean;
  };
}

export interface ProjectAgentEffortReceipt {
  mode: WorkroomEffortMode;
  status: 'applied' | 'unchanged' | 'recommended' | 'off' | 'manual' | 'unsupported' | 'unclassified' | 'deferred' | 'unconfirmed';
  decision?: WorkroomEffortDecision;
  observed?: string;
}

function decisionFor(request: ProjectAgentEffortRequest): WorkroomEffortDecision | null {
  const text = workroomEffortRequestText(request.prompt);
  const decision = classifyWorkroomEffort(text);
  if (!decision) return null;
  const c = request.context;
  if (c?.concurrency) return {tier: 'high', reason: 'concurrency'};
  if (c?.privilegeIsolation) return {tier: 'high', reason: 'security'};
  if (c?.destructiveMigration) return {tier: 'high', reason: 'migration'};
  if (c?.unresolvedFailure) return {tier: 'high', reason: 'unclear-failure'};
  if (c?.routineVerification && decision.tier !== 'high') return {tier: 'low', reason: 'standard'};
  return decision;
}

function sameBinding(a: ProjectAgentEffortSession, b: ProjectAgentEffortSession): boolean {
  return a.projectId === b.projectId && a.sessionId === b.sessionId && a.agent === b.agent
    && a.model === b.model && a.provider === b.provider && a.accountId === b.accountId && a.revision === b.revision;
}

/**
 * Shared by Workroom-free SDK hosts, agent plugins and CLI adapters. It owns no PTY,
 * window, credential or model choice. Native control remains with the caller's host.
 * Only in-flight keys are kept (at most 32); request text and advice history are not stored.
 */
export class ProjectAgentEffortController {
  #pending = new Set<string>();
  constructor(private readonly host: ProjectAgentEffortHost) {}

  async adjust(request: ProjectAgentEffortRequest): Promise<ProjectAgentEffortReceipt> {
    if (!request.projectId || !request.sessionId || request.projectId.length > 160
      || request.sessionId.length > 160 || /[\x00\r\n]/.test(request.projectId + request.sessionId)
      || typeof request.prompt !== 'string' || request.prompt.length > 24_000) throw Error('프로젝트 에포트 요청을 확인하세요.');
    const mode = this.host.mode();
    if (!isWorkroomEffortMode(mode)) throw Error('프로젝트 에포트 모드를 확인하세요.');
    const key = JSON.stringify([request.projectId, request.sessionId]);
    if (this.#pending.has(key) || this.#pending.size >= 32) return {mode, status: 'deferred'};
    this.#pending.add(key);
    try {
      // Registration is verified even in off/recommend mode; policy is not execution authority.
      const initial = await this.host.resolve(request.projectId, request.sessionId);
      if (initial.projectId !== request.projectId || initial.sessionId !== request.sessionId) throw Error('프로젝트 작업 세션이 변경되었습니다.');
      if (mode === 'off') return {mode, status: 'off'};
      if (initial.manual) return {mode, status: 'manual', ...(initial.effort ? {observed: initial.effort} : {})};
      const decision = decisionFor(request);
      if (!decision) return {mode, status: 'unclassified'};
      if (mode === 'recommend') return {mode, status: 'recommended', decision};
      if (initial.control !== 'session' || initial.agent === 'agy' || !initial.supportedEfforts.includes(decision.tier)) {
        return {mode, status: 'unsupported', decision};
      }
      if (initial.effort === decision.tier) return {mode, status: 'unchanged', decision, observed: initial.effort};
      const current = await this.host.resolve(request.projectId, request.sessionId);
      if (!sameBinding(initial, current) || current.effort !== initial.effort || current.manual
        || current.control !== 'session' || !current.supportedEfforts.includes(decision.tier)
        || this.host.mode() !== mode) return {mode, status: 'deferred', decision};
      await this.host.apply(current, decision.tier);
      const observed = await this.host.resolve(request.projectId, request.sessionId);
      if (!sameBinding(current, observed) || observed.manual || this.host.mode() !== mode
        || observed.control !== 'session' || !observed.supportedEfforts.includes(decision.tier)
        || observed.effort !== decision.tier) return {mode, status: 'unconfirmed', decision};
      return {mode, status: 'applied', decision, observed: observed.effort};
    } finally {
      this.#pending.delete(key);
    }
  }
}
