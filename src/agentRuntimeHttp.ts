import {
  normalizeAgentRuntimeCapabilitiesResponse,
  normalizeAgentRuntimeTargetsResponse,
  normalizeAgentTaskCancelRequest,
  normalizeAgentTaskCancelResponse,
  normalizeAgentTaskEventsResponse,
  normalizeAgentTaskListResponse,
  normalizeAgentTaskStartResponse,
  type AgentRuntimeCapabilitiesResponse,
  type AgentRuntimeTargetsResponse,
  type AgentTaskCancelRequest,
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
import {
  normalizeAgentRuntimeReadinessDiagnostic,
  type AgentRuntimeReadinessDiagnostic,
} from './agentRuntimeReadinessContract';
import {
  AGENT_RUNTIME_CONVERSATION_LIST_LIMIT,
  normalizeAgentRuntimeConversationDeleteResponse,
  normalizeAgentRuntimeConversationEventsResponse,
  normalizeAgentRuntimeConversationHistoryResponse,
  normalizeAgentRuntimeConversationListResponse,
  normalizeAgentRuntimeConversationTurnAcceptedResponse,
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
} from './agentRuntimeConversationProtocol';
import type {
  AgentRuntimeConversationDeleteOutcome,
  AgentRuntimeConversationEventsOutcome,
  AgentRuntimeConversationHistoryOutcome,
  AgentRuntimeConversationTurnAcceptedOutcome,
} from './agentRuntimeConversationService';
import {
  AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
  normalizeAgentRuntimeConversationQuestionAnswerRequest,
  normalizeAgentRuntimeConversationQuestionAnswerResponse,
  normalizeAgentRuntimeConversationQuestionStatusResponse,
  type AgentRuntimeConversationQuestionAnswerRequest,
  type AgentRuntimeConversationQuestionAnswerResponse,
  type AgentRuntimeConversationQuestionStatusResponse,
} from './agentRuntimeConversationQuestionProtocol';

export const AGENT_RUNTIME_HTTP_PREFIX = '/api/agent-runtime';
// A valid 32 KiB prompt can expand to nearly 6x when control characters are
// JSON-escaped. Keep the wire limit aligned with the advertised protocol limit
// while still bounding allocations before the complete body is buffered.
export const AGENT_RUNTIME_HTTP_BODY_MAX_BYTES = 256 * 1024;
const TASK_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export interface AgentRuntimeHttpService {
  capabilities(): AgentRuntimeCapabilitiesResponse | Promise<AgentRuntimeCapabilitiesResponse>;
  conversationCapabilities?(): AgentRuntimeCapabilitiesResponse | Promise<AgentRuntimeCapabilitiesResponse>;
  readiness?(): AgentRuntimeReadinessDiagnostic | Promise<AgentRuntimeReadinessDiagnostic>;
  targets?(): AgentRuntimeTargetsResponse | Promise<AgentRuntimeTargetsResponse>;
  listTasks(): AgentTaskListResponse | Promise<AgentTaskListResponse>;
  readEvents(taskId: string, after: number): AgentTaskEventsResponse | Promise<AgentTaskEventsResponse>;
  startTask(request: AgentTaskStartRequest): AgentTaskStartResponse | Promise<AgentTaskStartResponse>;
  cancelTask(taskId: string, request: AgentTaskCancelRequest): AgentTaskCancelResponse | Promise<AgentTaskCancelResponse>;
  conversations?: AgentRuntimeConversationHttpService;
}

export interface AgentRuntimeConversationHttpService {
  list(includeArchived?: boolean): ReturnType<typeof normalizeAgentRuntimeConversationSummary>[];
  startCreate(request: AgentRuntimeConversationCreateRequest): Promise<AgentRuntimeConversationTurnAcceptedOutcome>;
  startContinue(request: AgentRuntimeConversationContinueRequest): Promise<AgentRuntimeConversationTurnAcceptedOutcome>;
  readEvents(request: {
    protocolVersion: typeof AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION;
    conversationId: string;
    after: number;
  }): AgentRuntimeConversationEventsOutcome;
  history(request: AgentRuntimeConversationHistoryRequest): Promise<AgentRuntimeConversationHistoryOutcome>;
  steer(request: AgentRuntimeConversationSteerRequest): Promise<ReturnType<typeof normalizeAgentRuntimeConversationSummary>>;
  interrupt(request: AgentRuntimeConversationInterruptRequest): Promise<ReturnType<typeof normalizeAgentRuntimeConversationSummary>>;
  setArchived(request: AgentRuntimeConversationMutationRequest, archived: boolean): Promise<ReturnType<typeof normalizeAgentRuntimeConversationSummary>>;
  delete(request: AgentRuntimeConversationDeleteRequest): Promise<AgentRuntimeConversationDeleteOutcome>;
  questionStatus?(conversationId: string): AgentRuntimeConversationQuestionStatusResponse;
  answerQuestion?(request: AgentRuntimeConversationQuestionAnswerRequest): AgentRuntimeConversationQuestionAnswerResponse;
}

export class AgentRuntimeHttpError extends Error {
  constructor(
    readonly code: string,
    readonly publicMessage: string,
    readonly status = 400,
  ) {
    super(publicMessage);
    this.name = 'AgentRuntimeHttpError';
  }
}

function json(body: unknown, status = 200, responseHeaders: HeadersInit = {}): Response {
  const headers = new Headers(responseHeaders);
  headers.set('Content-Type', 'application/json');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Vary', 'Origin');
  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

function errorResponse(
  error: AgentRuntimeHttpError,
  responseHeaders: HeadersInit,
  protocolVersion: string = AGENT_RUNTIME_PROTOCOL_VERSION,
): Response {
  return json({
    protocolVersion,
    ok: false,
    code: error.code,
    error: error.publicMessage,
  }, error.status, responseHeaders);
}

function conversationHttpError(error: unknown): AgentRuntimeHttpError | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  if (code === 'AGENT_RUNTIME_CONVERSATION_PROTOCOL_INVALID') {
    return new AgentRuntimeHttpError('INVALID_REQUEST', '지속형 대화 요청이 올바르지 않습니다.', 400);
  }
  if (code === 'AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_INVALID') {
    return new AgentRuntimeHttpError('INVALID_REQUEST', '지속형 대화 질문 요청이 올바르지 않습니다.', 400);
  }
  if (typeof code !== 'string' || !code.startsWith('AGENT_RUNTIME_CONVERSATION_')) return null;
  const publicMessage = error instanceof Error
    ? error.message
    : '지속형 대화 요청을 처리하지 못했습니다.';
  const status = code === 'AGENT_RUNTIME_CONVERSATION_NOT_FOUND'
    ? 404
    : code === 'AGENT_RUNTIME_CONVERSATION_INVALID_CURSOR'
      ? 400
      : code === 'AGENT_RUNTIME_CONVERSATION_SHUTTING_DOWN'
        || code === 'AGENT_RUNTIME_CONVERSATION_RUNTIME_UNKNOWN'
        || code === 'AGENT_RUNTIME_CONVERSATION_TARGET_UNKNOWN'
        || code === 'AGENT_RUNTIME_CONVERSATION_CLEANUP_UNCONFIRMED'
        ? 503
        : 409;
  return new AgentRuntimeHttpError(code, publicMessage, status);
}

function method(req: Request, expected: 'GET' | 'POST'): void {
  if (req.method !== expected) {
    throw new AgentRuntimeHttpError('METHOD_NOT_ALLOWED', '허용되지 않은 요청 방식입니다.', 405);
  }
}

function noSearch(url: URL): void {
  if (url.search) throw new AgentRuntimeHttpError('INVALID_REQUEST', '허용되지 않은 query가 포함되어 있습니다.');
}

async function readJsonBody(req: Request): Promise<unknown> {
  const contentType = req.headers.get('content-type')?.toLowerCase() ?? '';
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
    throw new AgentRuntimeHttpError(
      'UNSUPPORTED_MEDIA_TYPE',
      '에이전트 작업 요청은 JSON 형식이어야 합니다.',
      415,
    );
  }
  const contentEncoding = req.headers.get('content-encoding')?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== 'identity') {
    throw new AgentRuntimeHttpError(
      'UNSUPPORTED_CONTENT_ENCODING',
      '압축된 에이전트 작업 요청은 허용되지 않습니다.',
      415,
    );
  }
  const declaredRaw = req.headers.get('content-length');
  if (declaredRaw !== null && !/^(0|[1-9][0-9]*)$/.test(declaredRaw.trim())) {
    throw new AgentRuntimeHttpError('INVALID_REQUEST', '요청 크기 정보가 올바르지 않습니다.');
  }
  const declared = declaredRaw === null ? null : Number(declaredRaw);
  if (declared !== null
    && (!Number.isSafeInteger(declared) || declared > AGENT_RUNTIME_HTTP_BODY_MAX_BYTES)) {
    throw new AgentRuntimeHttpError('REQUEST_TOO_LARGE', '에이전트 작업 요청이 너무 큽니다.', 413);
  }

  const reader = req.body?.getReader();
  if (!reader) {
    throw new AgentRuntimeHttpError('INVALID_REQUEST', '에이전트 작업 요청 형식이 올바르지 않습니다.');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > AGENT_RUNTIME_HTTP_BODY_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new AgentRuntimeHttpError('REQUEST_TOO_LARGE', '에이전트 작업 요청이 너무 큽니다.', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AgentRuntimeHttpError('INVALID_REQUEST', '에이전트 작업 요청 형식이 올바르지 않습니다.');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new AgentRuntimeHttpError('INVALID_REQUEST', '에이전트 작업 요청 형식이 올바르지 않습니다.');
  }
}

function eventCursor(url: URL): number {
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== 'after' || url.searchParams.getAll('after').length !== 1) {
    throw new AgentRuntimeHttpError('INVALID_CURSOR', '작업 이벤트 cursor가 올바르지 않습니다.');
  }
  const raw = url.searchParams.get('after') ?? '';
  if (!/^(0|[1-9][0-9]{0,15})$/.test(raw)) {
    throw new AgentRuntimeHttpError('INVALID_CURSOR', '작업 이벤트 cursor가 올바르지 않습니다.');
  }
  const after = Number(raw);
  if (!Number.isSafeInteger(after)) {
    throw new AgentRuntimeHttpError('INVALID_CURSOR', '작업 이벤트 cursor가 올바르지 않습니다.');
  }
  return after;
}

function startRequest(value: unknown): AgentTaskStartRequest {
  try {
    return normalizeAgentTaskStartRequest(value);
  } catch {
    throw new AgentRuntimeHttpError('INVALID_REQUEST', '에이전트 런타임 요청이 올바르지 않습니다.');
  }
}

function cancelRequest(value: unknown): AgentTaskCancelRequest {
  try {
    return normalizeAgentTaskCancelRequest(value);
  } catch {
    throw new AgentRuntimeHttpError('INVALID_REQUEST', '에이전트 런타임 요청이 올바르지 않습니다.');
  }
}

/**
 * Handles only the isolated local task API. The caller retains the existing
 * host/origin gate and must not expose this handler directly to a public port.
 */
export async function handleAgentRuntimeHttpRequest(
  req: Request,
  url: URL,
  service: AgentRuntimeHttpService,
  responseHeaders: HeadersInit = {},
): Promise<Response | null> {
  if (!url.pathname.startsWith(`${AGENT_RUNTIME_HTTP_PREFIX}/`)) return null;
  try {
    const conversationPrefix = `${AGENT_RUNTIME_HTTP_PREFIX}/conversations`;
    if (url.pathname === `${conversationPrefix}/capabilities`) {
      method(req, 'GET');
      noSearch(url);
      if (!service.conversationCapabilities) {
        throw new AgentRuntimeHttpError(
          'AGENT_RUNTIME_CONVERSATIONS_UNAVAILABLE',
          '지속형 대화 런타임을 준비하지 못했습니다.',
          503,
        );
      }
      return json(
        normalizeAgentRuntimeCapabilitiesResponse(await service.conversationCapabilities()),
        200,
        responseHeaders,
      );
    }
    if (url.pathname === conversationPrefix) {
      method(req, 'GET');
      noSearch(url);
      if (!service.conversations) {
        throw new AgentRuntimeHttpError(
          'AGENT_RUNTIME_CONVERSATIONS_UNAVAILABLE',
          '지속형 대화 런타임을 준비하지 못했습니다.',
          503,
        );
      }
      return json(normalizeAgentRuntimeConversationListResponse({
        protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
        conversations: service.conversations.list(false).slice(0, AGENT_RUNTIME_CONVERSATION_LIST_LIMIT),
      }), 200, responseHeaders);
    }
    if (url.pathname === `${conversationPrefix}/archived`) {
      method(req, 'GET');
      noSearch(url);
      if (!service.conversations) {
        throw new AgentRuntimeHttpError(
          'AGENT_RUNTIME_CONVERSATIONS_UNAVAILABLE',
          '지속형 대화 런타임을 준비하지 못했습니다.',
          503,
        );
      }
      return json(normalizeAgentRuntimeConversationListResponse({
        protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
        conversations: service.conversations.list(true)
          .filter(conversation => conversation.state === 'archived')
          .slice(0, AGENT_RUNTIME_CONVERSATION_LIST_LIMIT),
      }), 200, responseHeaders);
    }
    if (url.pathname === `${conversationPrefix}/start`) {
      method(req, 'POST');
      noSearch(url);
      if (!service.conversations) {
        throw new AgentRuntimeHttpError(
          'AGENT_RUNTIME_CONVERSATIONS_UNAVAILABLE',
          '지속형 대화 런타임을 준비하지 못했습니다.',
          503,
        );
      }
      const request = normalizeAgentRuntimeConversationCreateRequest(await readJsonBody(req));
      const outcome = await service.conversations.startCreate(request);
      return json(normalizeAgentRuntimeConversationTurnAcceptedResponse({
        protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
        ...outcome,
      }), outcome.accepted ? 202 : 200, responseHeaders);
    }
    const conversationRoute = url.pathname.match(
      /^\/api\/agent-runtime\/conversations\/([A-Za-z0-9_-]{8,128})\/(continue|events|history|steer|interrupt|archive|unarchive|delete)$/,
    );
    const questionRoute = url.pathname.match(
      /^\/api\/agent-runtime\/conversations\/([A-Za-z0-9_-]{8,128})\/question(?:\/(answer))?$/,
    );
    if (questionRoute) {
      if (!service.conversations
        || !service.conversations.questionStatus
        || !service.conversations.answerQuestion) {
        throw new AgentRuntimeHttpError(
          'AGENT_RUNTIME_CONVERSATIONS_UNAVAILABLE',
          '지속형 대화 런타임을 준비하지 못했습니다.',
          503,
        );
      }
      const conversationId = questionRoute[1]!;
      if (!questionRoute[2]) {
        method(req, 'GET');
        noSearch(url);
        return json(normalizeAgentRuntimeConversationQuestionStatusResponse(
          service.conversations.questionStatus(conversationId),
        ), 200, responseHeaders);
      }
      method(req, 'POST');
      noSearch(url);
      const request = normalizeAgentRuntimeConversationQuestionAnswerRequest(await readJsonBody(req));
      if (request.conversationId !== conversationId) {
        throw new AgentRuntimeHttpError('INVALID_REQUEST', '지속형 대화 식별자가 일치하지 않습니다.');
      }
      return json(normalizeAgentRuntimeConversationQuestionAnswerResponse(
        service.conversations.answerQuestion(request),
      ), 200, responseHeaders);
    }
    if (conversationRoute) {
      if (!service.conversations) {
        throw new AgentRuntimeHttpError(
          'AGENT_RUNTIME_CONVERSATIONS_UNAVAILABLE',
          '지속형 대화 런타임을 준비하지 못했습니다.',
          503,
        );
      }
      const conversationId = conversationRoute[1]!;
      const action = conversationRoute[2]!;
      if (action === 'events') {
        method(req, 'GET');
        const outcome = service.conversations.readEvents({
          protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
          conversationId,
          after: eventCursor(url),
        });
        return json(normalizeAgentRuntimeConversationEventsResponse(outcome), 200, responseHeaders);
      }
      method(req, 'POST');
      noSearch(url);
      const body = await readJsonBody(req);
      if (action === 'continue') {
        const request = normalizeAgentRuntimeConversationContinueRequest(body);
        if (request.conversationId !== conversationId) {
          throw new AgentRuntimeHttpError('INVALID_REQUEST', '지속형 대화 식별자가 일치하지 않습니다.');
        }
        const outcome = await service.conversations.startContinue(request);
        return json(normalizeAgentRuntimeConversationTurnAcceptedResponse({
          protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
          ...outcome,
        }), outcome.accepted ? 202 : 200, responseHeaders);
      }
      if (action === 'history') {
        const request = normalizeAgentRuntimeConversationHistoryRequest(body);
        if (request.conversationId !== conversationId) {
          throw new AgentRuntimeHttpError('INVALID_REQUEST', '지속형 대화 식별자가 일치하지 않습니다.');
        }
        const outcome = await service.conversations.history(request);
        return json(normalizeAgentRuntimeConversationHistoryResponse({
          protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
          ...outcome,
        }), 200, responseHeaders);
      }
      if (action === 'steer') {
        const request = normalizeAgentRuntimeConversationSteerRequest(body);
        if (request.conversationId !== conversationId) {
          throw new AgentRuntimeHttpError('INVALID_REQUEST', '지속형 대화 식별자가 일치하지 않습니다.');
        }
        return json(normalizeAgentRuntimeConversationSummary(
          await service.conversations.steer(request),
        ), 200, responseHeaders);
      }
      if (action === 'interrupt') {
        const request = normalizeAgentRuntimeConversationInterruptRequest(body);
        if (request.conversationId !== conversationId) {
          throw new AgentRuntimeHttpError('INVALID_REQUEST', '지속형 대화 식별자가 일치하지 않습니다.');
        }
        return json(normalizeAgentRuntimeConversationSummary(
          await service.conversations.interrupt(request),
        ), 200, responseHeaders);
      }
      if (action === 'archive' || action === 'unarchive') {
        const request = normalizeAgentRuntimeConversationMutationRequest(body);
        if (request.conversationId !== conversationId) {
          throw new AgentRuntimeHttpError('INVALID_REQUEST', '지속형 대화 식별자가 일치하지 않습니다.');
        }
        return json(normalizeAgentRuntimeConversationSummary(
          await service.conversations.setArchived(request, action === 'archive'),
        ), 200, responseHeaders);
      }
      const request = normalizeAgentRuntimeConversationDeleteRequest(body);
      if (request.conversationId !== conversationId) {
        throw new AgentRuntimeHttpError('INVALID_REQUEST', '지속형 대화 식별자가 일치하지 않습니다.');
      }
      const outcome = await service.conversations.delete(request);
      return json(normalizeAgentRuntimeConversationDeleteResponse({
        protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
        ...outcome,
      }), 200, responseHeaders);
    }
    if (url.pathname === `${AGENT_RUNTIME_HTTP_PREFIX}/capabilities`) {
      method(req, 'GET');
      noSearch(url);
      return json(normalizeAgentRuntimeCapabilitiesResponse(await service.capabilities()), 200, responseHeaders);
    }
    if (url.pathname === `${AGENT_RUNTIME_HTTP_PREFIX}/readiness`) {
      method(req, 'GET');
      noSearch(url);
      if (!service.readiness) {
        throw new AgentRuntimeHttpError(
          'AGENT_RUNTIME_READINESS_UNAVAILABLE',
          '에이전트 런타임 준비 상태를 확인하지 못했습니다.',
          503,
        );
      }
      return json(
        normalizeAgentRuntimeReadinessDiagnostic(await service.readiness()),
        200,
        responseHeaders,
      );
    }
    if (url.pathname === `${AGENT_RUNTIME_HTTP_PREFIX}/targets`) {
      method(req, 'GET');
      noSearch(url);
      if (!service.targets) {
        throw new AgentRuntimeHttpError(
          'AGENT_RUNTIME_TARGETS_UNAVAILABLE',
          '에이전트 실행 대상 목록을 준비하지 못했습니다.',
          503,
        );
      }
      return json(normalizeAgentRuntimeTargetsResponse(await service.targets()), 200, responseHeaders);
    }
    if (url.pathname === `${AGENT_RUNTIME_HTTP_PREFIX}/tasks`) {
      method(req, 'GET');
      noSearch(url);
      return json(normalizeAgentTaskListResponse(await service.listTasks()), 200, responseHeaders);
    }
    if (url.pathname === `${AGENT_RUNTIME_HTTP_PREFIX}/tasks/start`) {
      method(req, 'POST');
      noSearch(url);
      const request = startRequest(await readJsonBody(req));
      return json(normalizeAgentTaskStartResponse(await service.startTask(request)), 202, responseHeaders);
    }
    const events = url.pathname.match(/^\/api\/agent-runtime\/tasks\/([A-Za-z0-9_-]{8,128})\/events$/);
    if (events) {
      method(req, 'GET');
      const taskId = events[1]!;
      if (!TASK_ID_RE.test(taskId)) throw new AgentRuntimeHttpError('TASK_NOT_FOUND', '작업을 찾지 못했습니다.', 404);
      return json(normalizeAgentTaskEventsResponse(await service.readEvents(taskId, eventCursor(url))), 200, responseHeaders);
    }
    const cancel = url.pathname.match(/^\/api\/agent-runtime\/tasks\/([A-Za-z0-9_-]{8,128})\/cancel$/);
    if (cancel) {
      method(req, 'POST');
      noSearch(url);
      const request = cancelRequest(await readJsonBody(req));
      return json(normalizeAgentTaskCancelResponse(await service.cancelTask(cancel[1]!, request)), 200, responseHeaders);
    }
    throw new AgentRuntimeHttpError('ROUTE_NOT_FOUND', '에이전트 런타임 경로를 찾지 못했습니다.', 404);
  } catch (error) {
    const questionProtocol = url.pathname.endsWith('/question')
      || url.pathname.endsWith('/question/answer');
    if (error instanceof AgentRuntimeHttpError) {
      return errorResponse(
        error,
        responseHeaders,
        questionProtocol
          ? AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION
          : url.pathname.startsWith(`${AGENT_RUNTIME_HTTP_PREFIX}/conversations`)
          ? AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION
          : AGENT_RUNTIME_PROTOCOL_VERSION,
      );
    }
    const conversationError = conversationHttpError(error);
    if (conversationError) {
      return errorResponse(
        conversationError,
        responseHeaders,
        questionProtocol
          ? AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION
          : AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      );
    }
    console.error('[AgentRuntime] request failed:', error);
    return errorResponse(new AgentRuntimeHttpError(
      'AGENT_RUNTIME_INTERNAL',
      '에이전트 런타임 요청을 처리하지 못했습니다.',
      500,
    ), responseHeaders, questionProtocol
      ? AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION
      : url.pathname.startsWith(`${AGENT_RUNTIME_HTTP_PREFIX}/conversations`)
        ? AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION
        : AGENT_RUNTIME_PROTOCOL_VERSION);
  }
}
