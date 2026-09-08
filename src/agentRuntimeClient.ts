import {
  normalizeAgentRuntimeCapabilitiesResponse,
  normalizeAgentRuntimeTargetsResponse,
  normalizeAgentRuntimeErrorResponse,
  normalizeAgentTaskCancelRequest,
  normalizeAgentTaskCancelResponse,
  normalizeAgentTaskEventsResponse,
  normalizeAgentTaskListResponse,
  normalizeAgentTaskStartResponse,
  type AgentRuntimeCapabilitiesResponse,
  type AgentRuntimeTargetsResponse,
  type AgentTaskCancelResponse,
  type AgentTaskEventsResponse,
  type AgentTaskListResponse,
  type AgentTaskStartResponse,
} from './agentRuntimeApiContract';
import {
  AGENT_RUNTIME_PROTOCOL_VERSION,
  normalizeAgentTaskStartRequest,
  type AgentTaskStartRequest,
} from './agentRuntimeProtocol';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './lib/env';
import {
  normalizeAgentRuntimeReadinessDiagnostic,
  type AgentRuntimeReadinessDiagnostic,
} from './agentRuntimeReadinessContract';
import {
  normalizeAgentRuntimeConversationDeleteResponse,
  normalizeAgentRuntimeConversationErrorResponse,
  normalizeAgentRuntimeConversationEventsResponse,
  normalizeAgentRuntimeConversationHistoryResponse,
  normalizeAgentRuntimeConversationListResponse,
  normalizeAgentRuntimeConversationTurnAcceptedResponse,
  type AgentRuntimeConversationDeleteResponse,
  type AgentRuntimeConversationEventsResponse,
  type AgentRuntimeConversationHistoryResponse,
  type AgentRuntimeConversationListResponse,
  type AgentRuntimeConversationTurnAcceptedResponse,
} from './agentRuntimeConversationApiContract';
import {
  AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
  normalizeAgentRuntimeConversationContinueRequest,
  normalizeAgentRuntimeConversationCreateRequest,
  normalizeAgentRuntimeConversationDeleteRequest,
  normalizeAgentRuntimeConversationHistoryRequest,
  normalizeAgentRuntimeConversationInterruptRequest,
  normalizeAgentRuntimeConversationMutationRequest,
  normalizeAgentRuntimeConversationSteerRequest,
  normalizeAgentRuntimeConversationSummary,
  type AgentRuntimeConversationContinueRequest,
  type AgentRuntimeConversationCreateRequest,
  type AgentRuntimeConversationDeleteRequest,
  type AgentRuntimeConversationHistoryRequest,
  type AgentRuntimeConversationInterruptRequest,
  type AgentRuntimeConversationMutationRequest,
  type AgentRuntimeConversationSteerRequest,
  type AgentRuntimeConversationSummary,
} from './agentRuntimeConversationProtocol';
import {
  AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
  normalizeAgentRuntimeConversationQuestionAnswerRequest,
  normalizeAgentRuntimeConversationQuestionAnswerResponse,
  normalizeAgentRuntimeConversationQuestionErrorResponse,
  normalizeAgentRuntimeConversationQuestionStatusResponse,
  type AgentRuntimeConversationQuestionAnswerRequest,
  type AgentRuntimeConversationQuestionAnswerResponse,
  type AgentRuntimeConversationQuestionStatusResponse,
} from './agentRuntimeConversationQuestionProtocol';

export const AGENT_RUNTIME_API_PATH = '/api/agent-runtime' as const;
export const AGENT_RUNTIME_DEFAULT_TIMEOUT_MS = 15_000;
export const AGENT_RUNTIME_MAX_RESPONSE_BYTES = 3 * 1024 * 1024;

export type AgentRuntimeClientErrorCode =
  | 'AGENT_RUNTIME_REQUEST_ABORTED'
  | 'AGENT_RUNTIME_REQUEST_TIMEOUT'
  | 'AGENT_RUNTIME_NETWORK_ERROR'
  | 'AGENT_RUNTIME_HTTP_ERROR'
  | 'AGENT_RUNTIME_RESPONSE_INVALID'
  | 'AGENT_RUNTIME_SERVER_UPGRADE_REQUIRED'
  | 'AGENT_RUNTIME_RANDOM_UNAVAILABLE';

export class AgentRuntimeClientError extends Error {
  readonly code: AgentRuntimeClientErrorCode;
  readonly status: number | null;

  constructor(
    code: AgentRuntimeClientErrorCode,
    message: string,
    status: number | null = null,
  ) {
    super(message);
    this.name = 'AgentRuntimeClientError';
    this.code = code;
    this.status = status;
  }
}

export type AgentRuntimeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type AgentRuntimeInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export interface AgentRuntimeClientOptions {
  fetchImpl?: AgentRuntimeFetch;
  invokeImpl?: AgentRuntimeInvoke;
  /** Overrides environment detection only for an isolated client test. */
  tauri?: boolean;
  /** Overrides Vite's compile-time development flag only for an isolated client test. */
  development?: boolean;
  timeoutMs?: number;
}

export interface AgentRuntimeRequestOptions {
  signal?: AbortSignal;
}

export function resolveAgentRuntimeApiBase(): string {
  // Only the unbundled browser-development client uses HTTP directly. Tauri
  // calls a Rust command that owns the private sidecar capability.
  return '';
}

export function createAgentRuntimeRequestId(prefix: 'request' | 'cancel' = 'request'): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (!randomUuid) {
    throw new AgentRuntimeClientError(
      'AGENT_RUNTIME_RANDOM_UNAVAILABLE',
      '안전한 작업 요청 ID를 만들 수 없습니다.',
    );
  }
  return `${prefix}_${randomUuid}`;
}

function taskIdentifier(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 128 || !/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new AgentRuntimeClientError(
      'AGENT_RUNTIME_RESPONSE_INVALID',
      '작업 식별자가 올바르지 않습니다.',
    );
  }
  return normalized;
}

interface ActiveRequest {
  controller: AbortController;
  timeoutId: ReturnType<typeof setTimeout>;
  detachCaller: () => void;
  didTimeout: () => boolean;
}

function activeRequest(signal: AbortSignal | undefined, timeoutMs: number): ActiveRequest {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    controller,
    timeoutId,
    detachCaller: () => signal?.removeEventListener('abort', abortFromCaller),
    didTimeout: () => timedOut,
  };
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const advertisedLength = response.headers.get('content-length');
  if (advertisedLength !== null
    && (!/^(0|[1-9][0-9]*)$/.test(advertisedLength.trim())
      || !Number.isSafeInteger(Number(advertisedLength))
      || Number(advertisedLength) > AGENT_RUNTIME_MAX_RESPONSE_BYTES)) {
    throw new AgentRuntimeClientError(
      'AGENT_RUNTIME_RESPONSE_INVALID',
      '에이전트 런타임의 응답 형식이 올바르지 않습니다.',
    );
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new AgentRuntimeClientError(
      'AGENT_RUNTIME_RESPONSE_INVALID',
      '에이전트 런타임의 응답 형식이 올바르지 않습니다.',
    );
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let decoded = '';
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > AGENT_RUNTIME_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new AgentRuntimeClientError(
          'AGENT_RUNTIME_RESPONSE_INVALID',
          '에이전트 런타임의 응답 형식이 올바르지 않습니다.',
        );
      }
      decoded += decoder.decode(value, { stream: true });
    }
    decoded += decoder.decode();
    return decoded;
  } catch (error) {
    if (error instanceof AgentRuntimeClientError) throw error;
    throw new AgentRuntimeClientError(
      'AGENT_RUNTIME_RESPONSE_INVALID',
      '에이전트 런타임의 응답 형식이 올바르지 않습니다.',
    );
  } finally {
    reader.releaseLock();
  }
}

export class AgentRuntimeClient {
  readonly #fetch: AgentRuntimeFetch;
  readonly #invoke: AgentRuntimeInvoke;
  readonly #tauri: boolean;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #activeControllers = new Set<AbortController>();

  constructor(options: AgentRuntimeClientOptions = {}) {
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#invoke = options.invokeImpl ?? ((command, args) => invoke(command, args));
    const tauri = options.tauri ?? isTauri();
    const development = options.development ?? String(import.meta.env.DEV) === 'true';
    // `tauri dev` is served by Vite and its same-origin `/api` proxy. Its API
    // starts before Rust can mint/hand off a private capability, so only the
    // production bundled app uses the capability-owning native bridge.
    this.#tauri = tauri && !development;
    this.#baseUrl = resolveAgentRuntimeApiBase();
    const timeoutMs = options.timeoutMs ?? AGENT_RUNTIME_DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new AgentRuntimeClientError(
        'AGENT_RUNTIME_RESPONSE_INVALID',
        '에이전트 런타임 요청 시간 제한이 올바르지 않습니다.',
      );
    }
    this.#timeoutMs = timeoutMs;
  }

  /** Abort every in-flight request owned by this client instance. */
  abort(): void {
    for (const controller of this.#activeControllers) controller.abort();
    this.#activeControllers.clear();
  }

  async capabilities(options: AgentRuntimeRequestOptions = {}): Promise<AgentRuntimeCapabilitiesResponse> {
    const value = await this.#request('/capabilities', { method: 'GET' }, options.signal);
    return this.#normalize(value, normalizeAgentRuntimeCapabilitiesResponse);
  }

  async conversationCapabilities(
    options: AgentRuntimeRequestOptions = {},
  ): Promise<AgentRuntimeCapabilitiesResponse> {
    const value = await this.#request('/conversations/capabilities', { method: 'GET' }, options.signal);
    return this.#normalize(value, normalizeAgentRuntimeCapabilitiesResponse);
  }

  async readiness(options: AgentRuntimeRequestOptions = {}): Promise<AgentRuntimeReadinessDiagnostic> {
    const value = await this.#request('/readiness', { method: 'GET' }, options.signal);
    return this.#normalize(value, normalizeAgentRuntimeReadinessDiagnostic);
  }

  async targets(options: AgentRuntimeRequestOptions = {}): Promise<AgentRuntimeTargetsResponse> {
    const value = await this.#request('/targets', { method: 'GET' }, options.signal);
    return this.#normalize(value, normalizeAgentRuntimeTargetsResponse);
  }

  async tasks(options: AgentRuntimeRequestOptions = {}): Promise<AgentTaskListResponse> {
    const value = await this.#request('/tasks', { method: 'GET' }, options.signal);
    const normalized = this.#normalize(value, normalizeAgentTaskListResponse);
    if (new Set(normalized.tasks.map(task => task.taskId)).size !== normalized.tasks.length) {
      throw this.#invalidResponse();
    }
    return normalized;
  }

  async events(
    taskId: string,
    after: number,
    options: AgentRuntimeRequestOptions = {},
  ): Promise<AgentTaskEventsResponse> {
    const safeTaskId = taskIdentifier(taskId);
    if (!Number.isSafeInteger(after) || after < 0) throw this.#invalidResponse();
    const value = await this.#request(
      `/tasks/${encodeURIComponent(safeTaskId)}/events?after=${after}`,
      { method: 'GET' },
      options.signal,
    );
    const normalized = this.#normalize(value, normalizeAgentTaskEventsResponse);
    if (normalized.taskId !== safeTaskId || normalized.after !== after) throw this.#invalidResponse();
    return normalized;
  }

  async start(
    request: AgentTaskStartRequest,
    options: AgentRuntimeRequestOptions = {},
  ): Promise<AgentTaskStartResponse> {
    let body: AgentTaskStartRequest;
    try {
      body = normalizeAgentTaskStartRequest(request);
    } catch {
      throw new AgentRuntimeClientError(
        'AGENT_RUNTIME_RESPONSE_INVALID',
        '에이전트 작업 요청이 올바르지 않습니다.',
      );
    }
    const value = await this.#request('/tasks/start', {
      method: 'POST',
      body: JSON.stringify(body),
    }, options.signal);
    const normalized = this.#normalize(value, normalizeAgentTaskStartResponse);
    if (normalized.task.targetId !== body.targetId
      || normalized.task.adapterId !== body.adapterId
      || normalized.task.modelId !== body.modelId
      || normalized.task.executionMode !== body.executionMode) {
      throw this.#invalidResponse();
    }
    return normalized;
  }

  async cancel(
    taskId: string,
    requestId: string,
    options: AgentRuntimeRequestOptions = {},
  ): Promise<AgentTaskCancelResponse> {
    const safeTaskId = taskIdentifier(taskId);
    let body;
    try {
      body = normalizeAgentTaskCancelRequest({
        protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
        requestId,
      });
    } catch {
      throw new AgentRuntimeClientError(
        'AGENT_RUNTIME_RESPONSE_INVALID',
        '작업 취소 요청이 올바르지 않습니다.',
      );
    }
    const value = await this.#request(`/tasks/${encodeURIComponent(safeTaskId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify(body),
    }, options.signal);
    const normalized = this.#normalize(value, normalizeAgentTaskCancelResponse);
    if (normalized.task.taskId !== safeTaskId) throw this.#invalidResponse();
    return normalized;
  }

  async conversations(
    includeArchived = false,
    options: AgentRuntimeRequestOptions = {},
  ): Promise<AgentRuntimeConversationListResponse> {
    const value = await this.#request(
      includeArchived ? '/conversations/archived' : '/conversations',
      { method: 'GET' },
      options.signal,
      true,
    );
    return this.#normalize(value, normalizeAgentRuntimeConversationListResponse);
  }

  async startConversation(
    request: AgentRuntimeConversationCreateRequest,
    options: AgentRuntimeRequestOptions = {},
  ): Promise<AgentRuntimeConversationTurnAcceptedResponse> {
    const body = this.#conversationRequest(request, normalizeAgentRuntimeConversationCreateRequest);
    const value = await this.#request('/conversations/start', {
      method: 'POST',
      body: JSON.stringify(body),
    }, options.signal, true);
    const normalized = this.#normalize(value, normalizeAgentRuntimeConversationTurnAcceptedResponse);
    if (normalized.conversation.targetId !== body.targetId
      || normalized.conversation.adapterId !== body.adapterId
      || normalized.conversation.modelId !== body.modelId) throw this.#invalidResponse();
    return normalized;
  }

  async continueConversation(
    request: AgentRuntimeConversationContinueRequest,
    options: AgentRuntimeRequestOptions = {},
  ): Promise<AgentRuntimeConversationTurnAcceptedResponse> {
    const body = this.#conversationRequest(request, normalizeAgentRuntimeConversationContinueRequest);
    const conversationId = taskIdentifier(body.conversationId);
    const value = await this.#request(`/conversations/${encodeURIComponent(conversationId)}/continue`, {
      method: 'POST',
      body: JSON.stringify(body),
    }, options.signal, true);
    const normalized = this.#normalize(value, normalizeAgentRuntimeConversationTurnAcceptedResponse);
    if (normalized.conversation.conversationId !== conversationId) throw this.#invalidResponse();
    return normalized;
  }

  async conversationEvents(
    conversationIdInput: string,
    after: number,
    options: AgentRuntimeRequestOptions = {},
  ): Promise<AgentRuntimeConversationEventsResponse> {
    const conversationId = taskIdentifier(conversationIdInput);
    if (!Number.isSafeInteger(after) || after < 0) throw this.#invalidResponse();
    const value = await this.#request(
      `/conversations/${encodeURIComponent(conversationId)}/events?after=${after}`,
      { method: 'GET' },
      options.signal,
      true,
    );
    const normalized = this.#normalize(value, normalizeAgentRuntimeConversationEventsResponse);
    if (normalized.conversationId !== conversationId || normalized.after !== after) {
      throw this.#invalidResponse();
    }
    return normalized;
  }

  async conversationHistory(
    request: AgentRuntimeConversationHistoryRequest,
    options: AgentRuntimeRequestOptions = {},
  ): Promise<AgentRuntimeConversationHistoryResponse> {
    const body = this.#conversationRequest(request, normalizeAgentRuntimeConversationHistoryRequest);
    const conversationId = taskIdentifier(body.conversationId);
    const value = await this.#request(`/conversations/${encodeURIComponent(conversationId)}/history`, {
      method: 'POST',
      body: JSON.stringify(body),
    }, options.signal, true);
    const normalized = this.#normalize(value, normalizeAgentRuntimeConversationHistoryResponse);
    if (normalized.conversation.conversationId !== conversationId
      || normalized.conversation.revision !== body.expectedRevision) throw this.#invalidResponse();
    return normalized;
  }

  async conversationQuestion(
    conversationIdInput: string,
    options: AgentRuntimeRequestOptions = {},
  ): Promise<AgentRuntimeConversationQuestionStatusResponse> {
    const conversationId = taskIdentifier(conversationIdInput);
    const value = await this.#request(
      `/conversations/${encodeURIComponent(conversationId)}/question`,
      { method: 'GET' },
      options.signal,
      'question',
    );
    const normalized = this.#normalize(value, normalizeAgentRuntimeConversationQuestionStatusResponse);
    if (normalized.conversationId !== conversationId) throw this.#invalidResponse();
    return normalized;
  }

  async answerConversationQuestion(
    request: AgentRuntimeConversationQuestionAnswerRequest,
    options: AgentRuntimeRequestOptions = {},
  ): Promise<AgentRuntimeConversationQuestionAnswerResponse> {
    let body: AgentRuntimeConversationQuestionAnswerRequest;
    try {
      body = normalizeAgentRuntimeConversationQuestionAnswerRequest(request);
    } catch {
      throw this.#invalidResponse();
    }
    const conversationId = taskIdentifier(body.conversationId);
    const value = await this.#request(
      `/conversations/${encodeURIComponent(conversationId)}/question/answer`,
      { method: 'POST', body: JSON.stringify(body) },
      options.signal,
      'question',
    );
    const normalized = this.#normalize(value, normalizeAgentRuntimeConversationQuestionAnswerResponse);
    if (normalized.conversationId !== conversationId
      || normalized.requestId !== body.requestId
      || normalized.questionRequestId !== body.questionRequestId) throw this.#invalidResponse();
    return normalized;
  }

  async steerConversation(
    request: AgentRuntimeConversationSteerRequest,
    options: AgentRuntimeRequestOptions = {},
  ): Promise<AgentRuntimeConversationSummary> {
    return this.#conversationSummaryMutation('steer', request, normalizeAgentRuntimeConversationSteerRequest, options);
  }

  async interruptConversation(
    request: AgentRuntimeConversationInterruptRequest,
    options: AgentRuntimeRequestOptions = {},
  ): Promise<AgentRuntimeConversationSummary> {
    return this.#conversationSummaryMutation(
      'interrupt',
      request,
      normalizeAgentRuntimeConversationInterruptRequest,
      options,
    );
  }

  async setConversationArchived(
    request: AgentRuntimeConversationMutationRequest,
    archived: boolean,
    options: AgentRuntimeRequestOptions = {},
  ): Promise<AgentRuntimeConversationSummary> {
    return this.#conversationSummaryMutation(
      archived ? 'archive' : 'unarchive',
      request,
      normalizeAgentRuntimeConversationMutationRequest,
      options,
    );
  }

  async deleteConversation(
    request: AgentRuntimeConversationDeleteRequest,
    options: AgentRuntimeRequestOptions = {},
  ): Promise<AgentRuntimeConversationDeleteResponse> {
    const body = this.#conversationRequest(request, normalizeAgentRuntimeConversationDeleteRequest);
    const conversationId = taskIdentifier(body.conversationId);
    const value = await this.#request(`/conversations/${encodeURIComponent(conversationId)}/delete`, {
      method: 'POST',
      body: JSON.stringify(body),
    }, options.signal, true);
    const normalized = this.#normalize(value, normalizeAgentRuntimeConversationDeleteResponse);
    if (normalized.conversationId !== conversationId) throw this.#invalidResponse();
    return normalized;
  }

  #conversationRequest<T>(value: T, normalize: (candidate: unknown) => T): T {
    try {
      return normalize(value);
    } catch {
      throw new AgentRuntimeClientError(
        'AGENT_RUNTIME_RESPONSE_INVALID',
        '지속형 대화 요청이 올바르지 않습니다.',
      );
    }
  }

  async #conversationSummaryMutation<T extends { conversationId: string }>(
    action: 'steer' | 'interrupt' | 'archive' | 'unarchive',
    request: T,
    normalize: (candidate: unknown) => T,
    options: AgentRuntimeRequestOptions,
  ): Promise<AgentRuntimeConversationSummary> {
    const body = this.#conversationRequest(request, normalize);
    const conversationId = taskIdentifier(body.conversationId);
    const value = await this.#request(`/conversations/${encodeURIComponent(conversationId)}/${action}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }, options.signal, true);
    const normalized = this.#normalize(value, normalizeAgentRuntimeConversationSummary);
    if (normalized.conversationId !== conversationId) throw this.#invalidResponse();
    return normalized;
  }

  #normalize<T>(value: unknown, normalize: (candidate: unknown) => T): T {
    try {
      return normalize(value);
    } catch {
      throw this.#invalidResponse();
    }
  }

  #invalidResponse(): AgentRuntimeClientError {
    return new AgentRuntimeClientError(
      'AGENT_RUNTIME_RESPONSE_INVALID',
      '에이전트 런타임의 응답 형식이 올바르지 않습니다.',
    );
  }

  #assertConversationServerVersion(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const protocolVersion = (value as Record<string, unknown>).protocolVersion;
    if (typeof protocolVersion === 'string'
      && protocolVersion !== AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION) {
      throw new AgentRuntimeClientError(
        'AGENT_RUNTIME_SERVER_UPGRADE_REQUIRED',
        '앱과 로컬 실행 서버 버전이 다릅니다. AgentsToZ 앱 또는 개발 서버를 완전히 종료한 뒤 다시 실행하세요.',
      );
    }
  }

  #assertQuestionServerVersion(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const protocolVersion = (value as Record<string, unknown>).protocolVersion;
    if (typeof protocolVersion === 'string'
      && protocolVersion !== AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION) {
      throw new AgentRuntimeClientError(
        'AGENT_RUNTIME_SERVER_UPGRADE_REQUIRED',
        '앱과 로컬 실행 서버의 대화 질문 버전이 다릅니다. AgentsToZ 앱 또는 개발 서버를 완전히 종료한 뒤 다시 실행하세요.',
      );
    }
  }

  async #request(
    path: string,
    init: RequestInit,
    callerSignal: AbortSignal | undefined,
    conversation: boolean | 'question' = false,
  ): Promise<unknown> {
    const request = activeRequest(callerSignal, this.#timeoutMs);
    this.#activeControllers.add(request.controller);
    try {
      if (this.#tauri) {
        const method = typeof init.method === 'string' ? init.method : 'GET';
        let body: unknown = null;
        if (init.body !== undefined && init.body !== null) {
          if (typeof init.body !== 'string') throw this.#invalidResponse();
          try {
            body = JSON.parse(init.body) as unknown;
          } catch {
            throw this.#invalidResponse();
          }
        }
        const invokeRequest = this.#invoke('agent_runtime_request', {
          path: `${AGENT_RUNTIME_API_PATH}${path}`,
          method,
          body,
        });
        let rejectInvokeOnAbort: (() => void) | null = null;
        const abortRequest = new Promise<never>((_resolve, reject) => {
          rejectInvokeOnAbort = () => reject(new DOMException('aborted', 'AbortError'));
          if (request.controller.signal.aborted) rejectInvokeOnAbort();
          else request.controller.signal.addEventListener('abort', rejectInvokeOnAbort, { once: true });
        });
        let proxied: unknown;
        try {
          proxied = await Promise.race([invokeRequest, abortRequest]);
        } finally {
          if (rejectInvokeOnAbort) {
            request.controller.signal.removeEventListener('abort', rejectInvokeOnAbort);
          }
        }
        if (!proxied || typeof proxied !== 'object' || Array.isArray(proxied)) {
          throw this.#invalidResponse();
        }
        const envelope = proxied as Record<string, unknown>;
        if (Object.keys(envelope).length !== 2
          || !Object.prototype.hasOwnProperty.call(envelope, 'status')
          || !Object.prototype.hasOwnProperty.call(envelope, 'body')
          || typeof envelope.status !== 'number'
          || !Number.isInteger(envelope.status)
          || envelope.status < 100
          || envelope.status > 599) {
          throw this.#invalidResponse();
        }
        let serialized: string;
        try {
          serialized = JSON.stringify(envelope.body);
        } catch {
          throw this.#invalidResponse();
        }
        if (typeof serialized !== 'string'
          || new TextEncoder().encode(serialized).byteLength > AGENT_RUNTIME_MAX_RESPONSE_BYTES) {
          throw this.#invalidResponse();
        }
        if (conversation === 'question') this.#assertQuestionServerVersion(envelope.body);
        else if (conversation) this.#assertConversationServerVersion(envelope.body);
        if (envelope.status < 200 || envelope.status >= 300) {
          const publicError = conversation === 'question'
            ? this.#normalize(envelope.body, normalizeAgentRuntimeConversationQuestionErrorResponse)
            : conversation
            ? this.#normalize(envelope.body, normalizeAgentRuntimeConversationErrorResponse)
            : this.#normalize(envelope.body, normalizeAgentRuntimeErrorResponse);
          throw new AgentRuntimeClientError(
            'AGENT_RUNTIME_HTTP_ERROR',
            publicError.error,
            envelope.status,
          );
        }
        return envelope.body;
      }

      const response = await this.#fetch(`${this.#baseUrl}${AGENT_RUNTIME_API_PATH}${path}`, {
        ...init,
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        headers: {
          Accept: 'application/json',
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        signal: request.controller.signal,
      });
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (contentType !== 'application/json') throw this.#invalidResponse();
      const text = await readBoundedResponseText(response);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw this.#invalidResponse();
      }
      if (conversation === 'question') this.#assertQuestionServerVersion(parsed);
      else if (conversation) this.#assertConversationServerVersion(parsed);
      if (!response.ok) {
        const publicError = conversation === 'question'
          ? this.#normalize(parsed, normalizeAgentRuntimeConversationQuestionErrorResponse)
          : conversation
          ? this.#normalize(parsed, normalizeAgentRuntimeConversationErrorResponse)
          : this.#normalize(parsed, normalizeAgentRuntimeErrorResponse);
        throw new AgentRuntimeClientError(
          'AGENT_RUNTIME_HTTP_ERROR',
          publicError.error,
          response.status,
        );
      }
      return parsed;
    } catch (error) {
      if (error instanceof AgentRuntimeClientError) throw error;
      if (request.didTimeout()) {
        throw new AgentRuntimeClientError(
          'AGENT_RUNTIME_REQUEST_TIMEOUT',
          '에이전트 런타임 응답 시간이 초과됐습니다.',
        );
      }
      if (request.controller.signal.aborted || callerSignal?.aborted) {
        throw new AgentRuntimeClientError(
          'AGENT_RUNTIME_REQUEST_ABORTED',
          '에이전트 런타임 요청이 중단됐습니다.',
        );
      }
      throw new AgentRuntimeClientError(
        'AGENT_RUNTIME_NETWORK_ERROR',
        '에이전트 런타임에 연결할 수 없습니다.',
      );
    } finally {
      clearTimeout(request.timeoutId);
      request.detachCaller();
      this.#activeControllers.delete(request.controller);
    }
  }
}
