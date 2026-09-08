import { createHash } from 'node:crypto';

import { normalizeAgentRuntimeCapabilitiesResponse } from './agentRuntimeApiContract';
import {
  normalizeAgentRuntimeConversationEventsResponse,
  normalizeAgentRuntimeConversationHistoryResponse,
  normalizeAgentRuntimeConversationTurnAcceptedResponse,
} from './agentRuntimeConversationApiContract';
import type { AgentRuntimeConversationHttpService, AgentRuntimeHttpService } from './agentRuntimeHttp';
import {
  AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT,
  AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
  type AgentRuntimeConversationSummary,
} from './agentRuntimeConversationProtocol';
import { AgentRuntimeConversationServiceError } from './agentRuntimeConversationService';
import type { RemoteControlTaskTargetBinding } from './remoteControlCore';
import type { RemoteControlTaskTargetAuthority } from './remoteControlTaskGateway';
import {
  REMOTE_CONTROL_CONVERSATION_HISTORY_TEXT_BYTES,
  REMOTE_CONTROL_CONVERSATION_MAX_PROMPT_BYTES,
  REMOTE_CONTROL_CONVERSATION_MAX_SERIALIZED_BYTES,
  REMOTE_CONTROL_CONVERSATION_PAGE_LIMIT,
  REMOTE_CONTROL_CONVERSATION_V1_ADAPTER_ID,
  normalizeRemoteControlConversationRequest,
  normalizeRemoteControlConversationResult,
  projectRemoteControlConversationCapability,
  projectRemoteControlConversationEvent,
  projectRemoteControlConversationSummary,
  type RemoteControlConversationHistoryMessage,
  type RemoteControlConversationEvent,
  type RemoteControlConversationRequest,
  type RemoteControlConversationResult,
} from './remoteControlConversationProtocol';
import { REMOTE_CONTROL_TASK_TRANSPORT_VERSION } from './remoteControlTaskProtocol';

const ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const CURSOR_RE = /^(conversation_models|conversations|history)_([a-f0-9]{16})_([0-9a-z]{1,8})$/;
const RESULT_ENVELOPE_RESERVE_BYTES = 700;

export interface RemoteControlConversationGatewayOptions {
  service: AgentRuntimeHttpService;
  resolveTargetAuthorities(
    bindings: readonly RemoteControlTaskTargetBinding[],
  ): Promise<readonly RemoteControlTaskTargetAuthority[]>;
}

export class RemoteControlConversationGatewayError extends Error {
  constructor(
    readonly code: string,
    readonly publicMessage: string,
    readonly retryable: boolean,
  ) {
    super(publicMessage);
    this.name = 'RemoteControlConversationGatewayError';
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

type CursorKind = 'conversation_models' | 'conversations' | 'history';

function pageCursor(kind: CursorKind, revision: string, offset: number): string {
  return `${kind}_${revision.slice(0, 16)}_${offset.toString(36)}`;
}

function cursorOffset(
  value: string | null,
  kind: CursorKind,
  revision: string,
): number {
  if (value === null) return 0;
  const match = value.match(CURSOR_RE);
  if (!match || match[1] !== kind || match[2] !== revision.slice(0, 16)) {
    throw new RemoteControlConversationGatewayError(
      'REMOTE_CONTROL_CONVERSATION_CURSOR_STALE',
      '대화 목록 또는 기록이 변경되었습니다. 첫 페이지부터 다시 불러오세요.',
      true,
    );
  }
  const offset = Number.parseInt(match[3]!, 36);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RemoteControlConversationGatewayError(
      'REMOTE_CONTROL_CONVERSATION_CURSOR_INVALID',
      '대화 목록 위치가 올바르지 않습니다.',
      false,
    );
  }
  return offset;
}

function exactAuthorities(
  bindings: readonly RemoteControlTaskTargetBinding[],
  authorities: readonly RemoteControlTaskTargetAuthority[],
): RemoteControlTaskTargetAuthority[] {
  const allowedControls = new Set(bindings.map(binding => binding.controlId));
  const controls = new Set<string>();
  const targets = new Set<string>();
  const result: RemoteControlTaskTargetAuthority[] = [];
  for (const authority of authorities) {
    if (!authority || typeof authority !== 'object'
      || !/^[A-Za-z0-9_-]{43}$/.test(authority.controlId)
      || !ID_RE.test(authority.runtimeTargetId)
      || !allowedControls.has(authority.controlId)
      || controls.has(authority.controlId)
      || targets.has(authority.runtimeTargetId)) {
      throw new RemoteControlConversationGatewayError(
        'REMOTE_CONTROL_CONVERSATION_TARGET_STATUS_UNKNOWN',
        '프로젝트 대화 대상을 안전하게 확인하지 못했습니다.',
        true,
      );
    }
    controls.add(authority.controlId);
    targets.add(authority.runtimeTargetId);
    result.push({ ...authority });
  }
  return result;
}

function publicFailure(error: unknown): RemoteControlConversationGatewayError {
  if (error instanceof RemoteControlConversationGatewayError) return error;
  if (error instanceof AgentRuntimeConversationServiceError) {
    return new RemoteControlConversationGatewayError(
      error.code,
      error.message,
      ['AGENT_RUNTIME_CONVERSATION_BUSY', 'AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT']
        .includes(error.code),
    );
  }
  return new RemoteControlConversationGatewayError(
    'REMOTE_CONTROL_CONVERSATION_FAILED',
    '이 Mac에서 지속형 대화 요청을 처리하지 못했습니다.',
    true,
  );
}

function conversationService(
  service: AgentRuntimeHttpService,
): AgentRuntimeConversationHttpService {
  if (!service.conversations) {
    throw new RemoteControlConversationGatewayError(
      'REMOTE_CONTROL_CONVERSATIONS_UNAVAILABLE',
      '이 Mac의 지속형 대화 런타임을 준비하지 못했습니다.',
      true,
    );
  }
  return service.conversations;
}

function boundedUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return { text: value, truncated: false };
  const suffix = '…';
  const suffixBytes = encoder.encode(suffix).byteLength;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, middle)).byteLength + suffixBytes <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let prefix = value.slice(0, low);
  if (prefix.length > 0) {
    const last = prefix.charCodeAt(prefix.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
  }
  return { text: `${prefix}${suffix}`, truncated: true };
}

export class RemoteControlConversationGateway {
  readonly #service: AgentRuntimeHttpService;
  readonly #resolveTargetAuthorities: RemoteControlConversationGatewayOptions['resolveTargetAuthorities'];

  constructor(options: RemoteControlConversationGatewayOptions) {
    this.#service = options.service;
    this.#resolveTargetAuthorities = options.resolveTargetAuthorities;
  }

  async perform(
    requestValue: unknown,
    bindings: readonly RemoteControlTaskTargetBinding[],
  ): Promise<RemoteControlConversationResult> {
    const request = normalizeRemoteControlConversationRequest(requestValue);
    try {
      const result = await this.#perform(request, bindings);
      return normalizeRemoteControlConversationResult({
        type: 'conversations.result',
        protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
        conversationProtocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
        operationId: request.operationId,
        operation: request.operation,
        ok: true,
        result,
      });
    } catch (error) {
      const failure = publicFailure(error);
      return normalizeRemoteControlConversationResult({
        type: 'conversations.result',
        protocolVersion: REMOTE_CONTROL_TASK_TRANSPORT_VERSION,
        conversationProtocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
        operationId: request.operationId,
        operation: request.operation,
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

  async #visibleAll(
    bindings: readonly RemoteControlTaskTargetBinding[],
  ): Promise<Array<{ conversation: AgentRuntimeConversationSummary; controlId: string }>> {
    const authorities = await this.#authorities(bindings);
    const controlByTarget = new Map(authorities.map(authority => (
      [authority.runtimeTargetId, authority.controlId] as const
    )));
    const local = conversationService(this.#service).list(true);
    return local.flatMap(conversation => {
      const controlId = controlByTarget.get(conversation.targetId);
      return controlId ? [{ conversation, controlId }] : [];
    });
  }

  async #visible(
    bindings: readonly RemoteControlTaskTargetBinding[],
    archivedOnly: boolean,
  ): Promise<Array<{ conversation: AgentRuntimeConversationSummary; controlId: string }>> {
    return (await this.#visibleAll(bindings)).filter(({ conversation }) => (
      archivedOnly ? conversation.state === 'archived' : conversation.state !== 'archived'
    ));
  }

  async #selected(
    bindings: readonly RemoteControlTaskTargetBinding[],
    conversationId: string,
  ): Promise<{ conversation: AgentRuntimeConversationSummary; controlId: string }> {
    const selected = (await this.#visibleAll(bindings)).find(item => (
      item.conversation.conversationId === conversationId
    ));
    if (!selected) {
      throw new RemoteControlConversationGatewayError(
        'REMOTE_CONTROL_CONVERSATION_NOT_FOUND',
        '현재 연결에서 볼 수 있는 대화가 아닙니다.',
        false,
      );
    }
    return selected;
  }

  async #perform(
    request: RemoteControlConversationRequest,
    bindings: readonly RemoteControlTaskTargetBinding[],
  ): Promise<unknown> {
    const service = conversationService(this.#service);
    switch (request.operation) {
      case 'capabilities': {
        const local = normalizeAgentRuntimeCapabilitiesResponse(await (
          this.#service.conversationCapabilities?.() ?? this.#service.capabilities()
        ));
        return {
          adapters: local.adapters
            .filter(adapter => adapter.adapterId === REMOTE_CONTROL_CONVERSATION_V1_ADAPTER_ID)
            .map(projectRemoteControlConversationCapability),
          limits: {
            maxPromptBytes: Math.min(
              local.limits.maxPromptBytes,
              REMOTE_CONTROL_CONVERSATION_MAX_PROMPT_BYTES,
            ),
          },
        };
      }
      case 'models.list': {
        const local = normalizeAgentRuntimeCapabilitiesResponse(await (
          this.#service.conversationCapabilities?.() ?? this.#service.capabilities()
        ));
        const codex = local.adapters.find(adapter => (
          adapter.adapterId === REMOTE_CONTROL_CONVERSATION_V1_ADAPTER_ID
        ));
        if (!codex) {
          throw new RemoteControlConversationGatewayError(
            'REMOTE_CONTROL_CONVERSATION_ADAPTER_NOT_FOUND',
            'Codex 지속형 대화 실행기를 찾지 못했습니다.',
            false,
          );
        }
        const revision = digest(codex.models);
        const catalogId = `catalog_${revision.slice(0, 40)}`;
        if (request.payload.catalogId !== null && request.payload.catalogId !== catalogId) {
          throw new RemoteControlConversationGatewayError(
            'REMOTE_CONTROL_CONVERSATION_CATALOG_STALE',
            '모델 목록이 변경되었습니다. 첫 페이지부터 다시 불러오세요.',
            true,
          );
        }
        const offset = cursorOffset(request.payload.cursor, 'conversation_models', revision);
        if (offset > codex.models.length) {
          throw new RemoteControlConversationGatewayError(
            'REMOTE_CONTROL_CONVERSATION_CURSOR_INVALID',
            '모델 목록 위치가 올바르지 않습니다.',
            false,
          );
        }
        const models = codex.models.slice(offset, offset + REMOTE_CONTROL_CONVERSATION_PAGE_LIMIT);
        const nextOffset = offset + models.length;
        return {
          catalogId,
          cursor: request.payload.cursor,
          nextCursor: nextOffset < codex.models.length
            ? pageCursor('conversation_models', revision, nextOffset)
            : null,
          models,
        };
      }
      case 'conversations.list': {
        const visible = await this.#visible(bindings, request.payload.archivedOnly);
        const revision = digest(visible.map(item => ({
          conversationId: item.conversation.conversationId,
          revision: item.conversation.revision,
          updatedAt: item.conversation.updatedAt,
          controlId: item.controlId,
        })));
        const offset = cursorOffset(request.payload.cursor, 'conversations', revision);
        if (offset > visible.length) {
          throw new RemoteControlConversationGatewayError(
            'REMOTE_CONTROL_CONVERSATION_CURSOR_INVALID',
            '대화 목록 위치가 올바르지 않습니다.',
            false,
          );
        }
        const page = visible.slice(offset, offset + REMOTE_CONTROL_CONVERSATION_PAGE_LIMIT);
        const nextOffset = offset + page.length;
        return {
          archivedOnly: request.payload.archivedOnly,
          cursor: request.payload.cursor,
          nextCursor: nextOffset < visible.length
            ? pageCursor('conversations', revision, nextOffset)
            : null,
          conversations: page.map(item => (
            projectRemoteControlConversationSummary(item.conversation, item.controlId)
          )),
        };
      }
      case 'conversations.start': {
        const authority = (await this.#authorities(bindings)).find(item => (
          item.controlId === request.payload.controlId
        ));
        if (!authority) {
          throw new RemoteControlConversationGatewayError(
            'REMOTE_CONTROL_CONVERSATION_TARGET_NOT_FOUND',
            '현재 연결에서 대화할 수 있는 프로젝트가 아닙니다.',
            false,
          );
        }
        const outcome = normalizeAgentRuntimeConversationTurnAcceptedResponse({
          protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
          ...await service.startCreate({
            protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
            requestId: request.payload.requestId,
            targetId: authority.runtimeTargetId,
            adapterId: request.payload.adapterId,
            modelId: request.payload.modelId,
            historyRetentionConsent: AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT,
            initialPrompt: request.payload.prompt,
          }),
        });
        return {
          duplicate: outcome.duplicate,
          conversation: projectRemoteControlConversationSummary(outcome.conversation, authority.controlId),
        };
      }
      case 'conversations.continue': {
        const selected = await this.#selected(bindings, request.payload.conversationId);
        const outcome = normalizeAgentRuntimeConversationTurnAcceptedResponse({
          protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
          ...await service.startContinue({
            protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
            requestId: request.payload.requestId,
            conversationId: request.payload.conversationId,
            expectedRevision: request.payload.expectedRevision,
            prompt: request.payload.prompt,
          }),
        });
        return {
          duplicate: outcome.duplicate,
          conversation: projectRemoteControlConversationSummary(outcome.conversation, selected.controlId),
        };
      }
      case 'conversations.events': {
        await this.#selected(bindings, request.payload.conversationId);
        const local = normalizeAgentRuntimeConversationEventsResponse(service.readEvents({
          protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
          conversationId: request.payload.conversationId,
          after: request.payload.after,
        }));
        const events: RemoteControlConversationEvent[] = [];
        for (const event of local.events.slice(0, REMOTE_CONTROL_CONVERSATION_PAGE_LIMIT)) {
          const projected = projectRemoteControlConversationEvent(event);
          const candidate = [...events, projected];
          if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength
            > REMOTE_CONTROL_CONVERSATION_MAX_SERIALIZED_BYTES - RESULT_ENVELOPE_RESERVE_BYTES) break;
          events.push(projected);
        }
        if (local.events.length > 0 && events.length === 0) {
          throw new RemoteControlConversationGatewayError(
            'REMOTE_CONTROL_CONVERSATION_EVENT_TOO_LARGE',
            '대화 진행 기록 한 건이 원격 전송 한도를 초과했습니다.',
            false,
          );
        }
        return {
          conversationId: request.payload.conversationId,
          after: request.payload.after,
          nextCursor: events.at(-1)?.seq ?? request.payload.after,
          events,
        };
      }
      case 'conversations.history': {
        await this.#selected(bindings, request.payload.conversationId);
        const local = normalizeAgentRuntimeConversationHistoryResponse({
          protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
          ...await service.history({
            protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
            conversationId: request.payload.conversationId,
            expectedRevision: request.payload.expectedRevision,
          }),
        });
        const flattened = local.history.turns.flatMap(turn => turn.messages).map(message => {
          const bounded = boundedUtf8(message.text, REMOTE_CONTROL_CONVERSATION_HISTORY_TEXT_BYTES);
          return {
            message: {
              messageId: message.messageId,
              role: message.role,
              phase: message.phase,
              text: bounded.text,
            } satisfies RemoteControlConversationHistoryMessage,
            truncated: bounded.truncated,
          };
        });
        const revision = digest({
          conversationId: request.payload.conversationId,
          revision: request.payload.expectedRevision,
          messages: flattened.map(item => item.message),
        });
        const offset = cursorOffset(request.payload.cursor, 'history', revision);
        if (offset > flattened.length) {
          throw new RemoteControlConversationGatewayError(
            'REMOTE_CONTROL_CONVERSATION_CURSOR_INVALID',
            '대화 기록 위치가 올바르지 않습니다.',
            false,
          );
        }
        const messages: RemoteControlConversationHistoryMessage[] = [];
        let transportTruncated = false;
        for (const item of flattened.slice(offset, offset + REMOTE_CONTROL_CONVERSATION_PAGE_LIMIT)) {
          const candidate = [...messages, item.message];
          if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength
            > REMOTE_CONTROL_CONVERSATION_MAX_SERIALIZED_BYTES - RESULT_ENVELOPE_RESERVE_BYTES) break;
          messages.push(item.message);
          transportTruncated ||= item.truncated;
        }
        if (offset < flattened.length && messages.length === 0) {
          throw new RemoteControlConversationGatewayError(
            'REMOTE_CONTROL_CONVERSATION_HISTORY_TOO_LARGE',
            '대화 기록 한 건이 원격 전송 한도를 초과했습니다.',
            false,
          );
        }
        const nextOffset = offset + messages.length;
        return {
          conversationId: request.payload.conversationId,
          revision: request.payload.expectedRevision,
          cursor: request.payload.cursor,
          nextCursor: nextOffset < flattened.length
            ? pageCursor('history', revision, nextOffset)
            : null,
          truncated: local.history.truncated || transportTruncated,
          filtered: true,
          messages,
        };
      }
      case 'conversations.steer': {
        const selected = await this.#selected(bindings, request.payload.conversationId);
        const conversation = await service.steer({
          protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
          requestId: request.payload.requestId,
          conversationId: request.payload.conversationId,
          expectedRevision: request.payload.expectedRevision,
          expectedTurnId: request.payload.expectedTurnId,
          prompt: request.payload.prompt,
        });
        return { conversation: projectRemoteControlConversationSummary(conversation, selected.controlId) };
      }
      case 'conversations.interrupt': {
        const selected = await this.#selected(bindings, request.payload.conversationId);
        const conversation = await service.interrupt({
          protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
          requestId: request.payload.requestId,
          conversationId: request.payload.conversationId,
          expectedRevision: request.payload.expectedRevision,
          expectedTurnId: request.payload.expectedTurnId,
        });
        return { conversation: projectRemoteControlConversationSummary(conversation, selected.controlId) };
      }
      case 'conversations.archive':
      case 'conversations.unarchive': {
        const selected = await this.#selected(bindings, request.payload.conversationId);
        const conversation = await service.setArchived({
          protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
          requestId: request.payload.requestId,
          conversationId: request.payload.conversationId,
          expectedRevision: request.payload.expectedRevision,
        }, request.operation === 'conversations.archive');
        return { conversation: projectRemoteControlConversationSummary(conversation, selected.controlId) };
      }
    }
  }
}
