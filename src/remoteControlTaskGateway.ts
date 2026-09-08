import { createHash } from 'node:crypto';

import {
  normalizeAgentRuntimeCapabilitiesResponse,
  normalizeAgentTaskEventsResponse,
  normalizeAgentTaskListResponse,
  normalizeAgentTaskStartResponse,
  normalizeAgentTaskCancelResponse,
  type AgentTaskSummary,
} from './agentRuntimeApiContract';
import { AgentRuntimeHttpError, type AgentRuntimeHttpService } from './agentRuntimeHttp';
import { AGENT_RUNTIME_PROTOCOL_VERSION } from './agentRuntimeProtocol';
import type { RemoteControlTaskTargetBinding } from './remoteControlCore';
import {
  REMOTE_CONTROL_TASK_EVENT_PAGE_LIMIT,
  REMOTE_CONTROL_TASK_LIST_PAGE_LIMIT,
  REMOTE_CONTROL_TASK_MAX_PROMPT_BYTES,
  REMOTE_CONTROL_TASK_MAX_SERIALIZED_BYTES,
  REMOTE_CONTROL_TASK_MODEL_PAGE_LIMIT,
  REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
  normalizeRemoteControlTaskRequest,
  normalizeRemoteControlTaskResult,
  projectRemoteControlTaskEvent,
  projectRemoteControlTaskSummary,
  remoteControlTaskUtf8ByteLength,
  type RemoteControlTaskRequest,
  type RemoteControlTaskResult,
} from './remoteControlTaskProtocol';

const ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const CURSOR_RE = /^(models|tasks)_([a-f0-9]{16})_([0-9a-z]{1,8})$/;
// Reserve room for the tasks.result envelope and a maximum-length operationId.
// The final protocol normalizer still enforces the exact whole-message bound.
const EVENT_RESULT_ENVELOPE_RESERVE_BYTES = 512;

export interface RemoteControlTaskTargetAuthority {
  /** Random control ID minted by RemoteControlCore for this exact session. */
  controlId: string;
  /** Local Agent Runtime target ID. It never crosses the remote protocol. */
  runtimeTargetId: string;
}

export interface RemoteControlTaskGatewayOptions {
  service: AgentRuntimeHttpService;
  /**
   * Join server-only remote targets to one fresh Agent Runtime inventory. The
   * implementation must compare canonical local identities, not display names.
   */
  resolveTargetAuthorities(
    bindings: readonly RemoteControlTaskTargetBinding[],
  ): Promise<readonly RemoteControlTaskTargetAuthority[]>;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function pageCursor(kind: 'models' | 'tasks', revision: string, offset: number): string {
  return `${kind}_${revision.slice(0, 16)}_${offset.toString(36)}`;
}

function cursorOffset(
  value: string | null,
  kind: 'models' | 'tasks',
  revision: string,
): number {
  if (value === null) return 0;
  const match = value.match(CURSOR_RE);
  if (!match || match[1] !== kind || match[2] !== revision.slice(0, 16)) {
    throw new RemoteControlTaskGatewayError(
      'REMOTE_CONTROL_TASK_CURSOR_STALE',
      '목록이 변경되었습니다. 첫 페이지부터 다시 불러오세요.',
      true,
    );
  }
  const offset = Number.parseInt(match[3]!, 36);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RemoteControlTaskGatewayError(
      'REMOTE_CONTROL_TASK_CURSOR_INVALID',
      '목록 위치가 올바르지 않습니다.',
      false,
    );
  }
  return offset;
}

function exactAuthorities(
  bindings: readonly RemoteControlTaskTargetBinding[],
  authorities: readonly RemoteControlTaskTargetAuthority[],
): RemoteControlTaskTargetAuthority[] {
  const bindingControlIds = new Set(bindings.map(binding => binding.controlId));
  const seenControlIds = new Set<string>();
  const seenRuntimeIds = new Set<string>();
  const normalized: RemoteControlTaskTargetAuthority[] = [];
  for (const authority of authorities) {
    if (!authority || typeof authority !== 'object'
      || !/^[A-Za-z0-9_-]{43}$/.test(authority.controlId)
      || !ID_RE.test(authority.runtimeTargetId)
      || !bindingControlIds.has(authority.controlId)
      || seenControlIds.has(authority.controlId)
      || seenRuntimeIds.has(authority.runtimeTargetId)) {
      throw new RemoteControlTaskGatewayError(
        'REMOTE_CONTROL_TASK_TARGET_STATUS_UNKNOWN',
        '프로젝트 실행 대상을 안전하게 확인하지 못했습니다.',
        true,
      );
    }
    seenControlIds.add(authority.controlId);
    seenRuntimeIds.add(authority.runtimeTargetId);
    normalized.push({ ...authority });
  }
  return normalized;
}

export class RemoteControlTaskGatewayError extends Error {
  constructor(
    readonly code: string,
    readonly publicMessage: string,
    readonly retryable: boolean,
  ) {
    super(publicMessage);
    this.name = 'RemoteControlTaskGatewayError';
  }
}

function publicFailure(error: unknown): RemoteControlTaskGatewayError {
  if (error instanceof RemoteControlTaskGatewayError) return error;
  if (error instanceof AgentRuntimeHttpError) {
    return new RemoteControlTaskGatewayError(
      /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code) ? error.code : 'AGENT_RUNTIME_FAILED',
      error.publicMessage,
      error.status >= 500 || error.status === 409,
    );
  }
  return new RemoteControlTaskGatewayError(
    'REMOTE_CONTROL_TASK_FAILED',
    '이 Mac에서 에이전트 작업 요청을 처리하지 못했습니다.',
    true,
  );
}

function taskForId(tasks: readonly AgentTaskSummary[], taskId: string): AgentTaskSummary {
  const task = tasks.find(candidate => candidate.taskId === taskId);
  if (!task) {
    throw new RemoteControlTaskGatewayError(
      'REMOTE_CONTROL_TASK_NOT_FOUND',
      '현재 연결에서 볼 수 있는 작업이 아닙니다.',
      false,
    );
  }
  return task;
}

/**
 * Path-free, session-scoped adapter from the E2EE tasks-v1 envelope to the
 * localhost Agent Runtime service. Every operation re-reads both the phone's
 * control-ID authority and the local runtime target inventory.
 */
export class RemoteControlTaskGateway {
  readonly #service: AgentRuntimeHttpService;
  readonly #resolveTargetAuthorities: RemoteControlTaskGatewayOptions['resolveTargetAuthorities'];

  constructor(options: RemoteControlTaskGatewayOptions) {
    this.#service = options.service;
    this.#resolveTargetAuthorities = options.resolveTargetAuthorities;
  }

  async perform(
    requestValue: unknown,
    bindingsValue: readonly RemoteControlTaskTargetBinding[],
  ): Promise<RemoteControlTaskResult> {
    const request = normalizeRemoteControlTaskRequest(requestValue);
    try {
      const result = await this.#perform(request, [...bindingsValue]);
      return normalizeRemoteControlTaskResult({
        type: 'tasks.result',
        protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
        taskProtocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        operationId: request.operationId,
        ok: true,
        result,
      });
    } catch (error) {
      const failure = publicFailure(error);
      return normalizeRemoteControlTaskResult({
        type: 'tasks.result',
        protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
        taskProtocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        operationId: request.operationId,
        ok: false,
        error: {
          code: failure.code,
          message: failure.publicMessage,
          retryable: failure.retryable,
        },
      });
    }
  }

  async #authorities(
    bindings: readonly RemoteControlTaskTargetBinding[],
  ): Promise<RemoteControlTaskTargetAuthority[]> {
    return exactAuthorities(bindings, await this.#resolveTargetAuthorities(bindings));
  }

  async #visibleTasks(
    bindings: readonly RemoteControlTaskTargetBinding[],
  ): Promise<{ task: AgentTaskSummary; controlId: string }[]> {
    const authorities = await this.#authorities(bindings);
    const controlIdByRuntimeId = new Map(authorities.map(authority => (
      [authority.runtimeTargetId, authority.controlId] as const
    )));
    const local = normalizeAgentTaskListResponse(await this.#service.listTasks());
    return local.tasks.flatMap(task => {
      const controlId = controlIdByRuntimeId.get(task.targetId);
      return controlId ? [{ task, controlId }] : [];
    });
  }

  async #perform(
    request: RemoteControlTaskRequest,
    bindings: readonly RemoteControlTaskTargetBinding[],
  ): Promise<unknown> {
    switch (request.operation) {
      case 'capabilities': {
        const capabilities = normalizeAgentRuntimeCapabilitiesResponse(await this.#service.capabilities());
        return {
          adapters: capabilities.adapters.map(adapter => ({
            adapterId: adapter.adapterId,
            label: adapter.label,
            availability: adapter.availability,
            features: {
              structuredProgress: adapter.features.structuredProgress,
              questions: false,
              approvals: false,
              cancellation: adapter.features.cancellation,
            },
          })),
          limits: {
            maxPromptBytes: Math.min(capabilities.limits.maxPromptBytes, REMOTE_CONTROL_TASK_MAX_PROMPT_BYTES),
            maxConcurrentTasks: capabilities.limits.maxConcurrentTasks,
          },
        };
      }
      case 'models.list': {
        const capabilities = normalizeAgentRuntimeCapabilitiesResponse(await this.#service.capabilities());
        const adapter = capabilities.adapters.find(candidate => candidate.adapterId === request.payload.adapterId);
        if (!adapter) {
          throw new RemoteControlTaskGatewayError(
            'REMOTE_CONTROL_TASK_ADAPTER_NOT_FOUND',
            '요청한 실행기를 찾지 못했습니다.',
            false,
          );
        }
        const revision = digest({ adapterId: adapter.adapterId, models: adapter.models });
        const catalogId = `catalog_${revision.slice(0, 40)}`;
        if (request.payload.catalogId !== null && request.payload.catalogId !== catalogId) {
          throw new RemoteControlTaskGatewayError(
            'REMOTE_CONTROL_TASK_CATALOG_STALE',
            '모델 목록이 변경되었습니다. 첫 페이지부터 다시 불러오세요.',
            true,
          );
        }
        const offset = cursorOffset(request.payload.cursor, 'models', revision);
        if (offset > adapter.models.length) {
          throw new RemoteControlTaskGatewayError(
            'REMOTE_CONTROL_TASK_CURSOR_INVALID',
            '모델 목록 위치가 올바르지 않습니다.',
            false,
          );
        }
        const models = adapter.models.slice(offset, offset + REMOTE_CONTROL_TASK_MODEL_PAGE_LIMIT);
        const nextOffset = offset + models.length;
        return {
          adapterId: adapter.adapterId,
          catalogId,
          cursor: request.payload.cursor,
          nextCursor: nextOffset < adapter.models.length
            ? pageCursor('models', revision, nextOffset)
            : null,
          models,
        };
      }
      case 'tasks.start': {
        const authorities = await this.#authorities(bindings);
        const authority = authorities.find(candidate => candidate.controlId === request.payload.controlId);
        if (!authority) {
          throw new RemoteControlTaskGatewayError(
            'REMOTE_CONTROL_TASK_TARGET_NOT_FOUND',
            '현재 연결에서 실행할 수 있는 프로젝트가 아닙니다.',
            false,
          );
        }
        const started = normalizeAgentTaskStartResponse(await this.#service.startTask({
          protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
          requestId: request.payload.requestId,
          targetId: authority.runtimeTargetId,
          adapterId: request.payload.adapterId,
          modelId: request.payload.modelId,
          executionMode: 'workspace-write',
          prompt: request.payload.prompt,
        }));
        return {
          duplicate: started.duplicate,
          task: projectRemoteControlTaskSummary(started.task, authority.controlId),
        };
      }
      case 'tasks.cancel': {
        const visible = await this.#visibleTasks(bindings);
        const selected = visible.find(candidate => candidate.task.taskId === request.payload.taskId);
        if (!selected) taskForId([], request.payload.taskId);
        const cancelled = normalizeAgentTaskCancelResponse(await this.#service.cancelTask(
          request.payload.taskId,
          { protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION, requestId: request.payload.requestId },
        ));
        return { task: projectRemoteControlTaskSummary(cancelled.task, selected!.controlId) };
      }
      case 'tasks.list': {
        const visible = await this.#visibleTasks(bindings);
        const revision = digest(visible.map(candidate => ({
          taskId: candidate.task.taskId,
          targetId: candidate.task.targetId,
          lastSeq: candidate.task.lastSeq,
          updatedAt: candidate.task.updatedAt,
        })));
        const offset = cursorOffset(request.payload.cursor, 'tasks', revision);
        if (offset > visible.length) {
          throw new RemoteControlTaskGatewayError(
            'REMOTE_CONTROL_TASK_CURSOR_INVALID',
            '작업 목록 위치가 올바르지 않습니다.',
            false,
          );
        }
        const page = visible.slice(offset, offset + REMOTE_CONTROL_TASK_LIST_PAGE_LIMIT);
        const nextOffset = offset + page.length;
        return {
          cursor: request.payload.cursor,
          nextCursor: nextOffset < visible.length ? pageCursor('tasks', revision, nextOffset) : null,
          tasks: page.map(candidate => projectRemoteControlTaskSummary(candidate.task, candidate.controlId)),
        };
      }
      case 'tasks.events': {
        const visible = await this.#visibleTasks(bindings);
        const selected = visible.find(candidate => candidate.task.taskId === request.payload.taskId);
        if (!selected) taskForId([], request.payload.taskId);
        const local = normalizeAgentTaskEventsResponse(await this.#service.readEvents(
          request.payload.taskId,
          request.payload.after,
        ));
        const projected = local.events
          .slice(0, REMOTE_CONTROL_TASK_EVENT_PAGE_LIMIT)
          .map(event => projectRemoteControlTaskEvent(event, selected!.task));
        const events: typeof projected = [];
        for (const event of projected) {
          const candidate = [...events, event];
          const candidateResult = {
            taskId: request.payload.taskId,
            after: request.payload.after,
            nextCursor: event.seq,
            events: candidate,
          };
          if (remoteControlTaskUtf8ByteLength(JSON.stringify(candidateResult))
            > REMOTE_CONTROL_TASK_MAX_SERIALIZED_BYTES - EVENT_RESULT_ENVELOPE_RESERVE_BYTES) {
            break;
          }
          events.push(event);
        }
        if (projected.length > 0 && events.length === 0) {
          throw new RemoteControlTaskGatewayError(
            'REMOTE_CONTROL_TASK_EVENT_TOO_LARGE',
            '작업 진행 기록 한 건이 원격 전송 한도를 초과했습니다.',
            false,
          );
        }
        return {
          taskId: request.payload.taskId,
          after: request.payload.after,
          nextCursor: events.at(-1)?.seq ?? request.payload.after,
          events,
        };
      }
    }
  }
}
