import { randomUUID } from 'node:crypto';

import {
  AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED,
} from './agentRuntimeProtocol';
import {
  normalizeAgentRuntimeConversationContinueRequest,
  normalizeAgentRuntimeConversationCreateRequest,
  normalizeAgentRuntimeConversationDeleteRequest,
  normalizeAgentRuntimeConversationEventsRequest,
  normalizeAgentRuntimeConversationHistoryRequest,
  normalizeAgentRuntimeConversationInterruptRequest,
  normalizeAgentRuntimeConversationMutationRequest,
  normalizeAgentRuntimeConversationSteerRequest,
  type AgentRuntimeConversationContinueRequest,
  type AgentRuntimeConversationCreateRequest,
  type AgentRuntimeConversationDeleteRequest,
  type AgentRuntimeConversationEvent,
  type AgentRuntimeConversationEventsRequest,
  type AgentRuntimeConversationHistoryRequest,
  type AgentRuntimeConversationInterruptRequest,
  type AgentRuntimeConversationMutationRequest,
  type AgentRuntimeConversationSteerRequest,
  type AgentRuntimeConversationSummary,
} from './agentRuntimeConversationProtocol';
import {
  AgentRuntimeConversationJournal,
  AgentRuntimeConversationJournalError,
} from './agentRuntimeConversationJournal';
import {
  inspectCodexConversation,
  mutateCodexConversation,
  readCodexConversationHistory,
  runCodexConversationTurn,
  CodexAgentRuntimeError,
  type CodexAgentProviderIds,
  type CodexAgentTaskEventDraft,
  type CodexConversationInspection,
  type CodexConversationHistory,
  type CodexConversationExecutionMode,
  type CodexConversationLiveControl,
  type CodexConversationTurnResult,
  type InspectCodexConversationInput,
  type MutateCodexConversationInput,
  type ReadCodexConversationHistoryInput,
  type RunCodexConversationTurnInput,
  type CodexConversationUserInputRequest,
  type CodexConversationUserInputResponse,
} from './codexAgentRuntime';
import {
  AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
  normalizeAgentRuntimeConversationQuestionAnswerRequest,
  type AgentRuntimeConversationPendingQuestion,
  type AgentRuntimeConversationQuestionAnswerRequest,
  type AgentRuntimeConversationQuestionAnswerResponse,
  type AgentRuntimeConversationQuestionStatusResponse,
} from './agentRuntimeConversationQuestionProtocol';
import type {
  AcquireAgentRuntimeWorkspaceLease,
  AgentRuntimeResolvedRuntime,
  AgentRuntimeResolvedTarget,
  ResolveAgentRuntime,
  ResolveAgentRuntimeTarget,
} from './agentRuntimeService';

export interface AgentRuntimeConversationTurnOutcome {
  duplicate: boolean;
  conversation: AgentRuntimeConversationSummary;
  /** Null on an idempotent retry whose prior provider result is not duplicated locally. */
  finalSummary: string | null;
}

export interface AgentRuntimeConversationTurnAcceptedOutcome {
  duplicate: boolean;
  /** True only after the provider turn binding is durable and execution is live. */
  accepted: boolean;
  conversation: AgentRuntimeConversationSummary;
}

export interface AgentRuntimeConversationDeleteOutcome {
  conversationId: string;
  deleted: true;
  duplicate: boolean;
}

export interface AgentRuntimeConversationHistoryOutcome {
  conversation: AgentRuntimeConversationSummary;
  history: CodexConversationHistory;
}

export interface AgentRuntimeConversationEventsOutcome {
  protocolVersion: AgentRuntimeConversationEventsRequest['protocolVersion'];
  conversationId: string;
  after: number;
  nextCursor: number;
  events: AgentRuntimeConversationEvent[];
}

export type RunCodexConversation = (
  input: RunCodexConversationTurnInput,
) => Promise<CodexConversationTurnResult>;

export type InspectCodexConversation = (
  input: InspectCodexConversationInput,
) => Promise<CodexConversationInspection>;

export type MutateCodexConversation = (
  input: MutateCodexConversationInput,
) => Promise<{ action: MutateCodexConversationInput['action'] }>;

export type ReadCodexConversationHistory = (
  input: ReadCodexConversationHistoryInput,
) => Promise<CodexConversationHistory>;

export interface AgentRuntimeConversationServiceDependencies {
  journal: AgentRuntimeConversationJournal;
  resolveTarget: ResolveAgentRuntimeTarget;
  resolveRuntime: ResolveAgentRuntime;
  acquireWorkspaceLease: AcquireAgentRuntimeWorkspaceLease;
  managedExecutionEnabled?: boolean;
  /** Conversation-only execution gate; does not authorize task starts. */
  executionEnabled?: boolean;
  executionMode?: CodexConversationExecutionMode;
  runCodexConversation?: RunCodexConversation;
  inspectCodexConversation?: InspectCodexConversation;
  mutateCodexConversation?: MutateCodexConversation;
  readCodexConversationHistory?: ReadCodexConversationHistory;
  createTurnId?: () => string;
  createQuestionId?: () => string;
  questionTimeoutMs?: number;
  shutdownWaitMs?: number;
  /** Schedule consent-gated transcript collection; never receives prompt text. */
  onTurnSettled?: (projectRoot: string) => void;
}

interface ActiveConversationProviderOperation {
  controller: AbortController;
  settled: Promise<void>;
  settle: () => void;
}

export class AgentRuntimeConversationServiceError extends Error {
  constructor(
    readonly code:
      | 'AGENT_RUNTIME_CONVERSATION_EXECUTION_HELD'
      | 'AGENT_RUNTIME_CONVERSATION_SHUTTING_DOWN'
      | 'AGENT_RUNTIME_CONVERSATION_NOT_FOUND'
      | 'AGENT_RUNTIME_CONVERSATION_REQUEST_CONFLICT'
      | 'AGENT_RUNTIME_CONVERSATION_REQUEST_INDETERMINATE'
      | 'AGENT_RUNTIME_CONVERSATION_BUSY'
      | 'AGENT_RUNTIME_CONVERSATION_TARGET_UNKNOWN'
      | 'AGENT_RUNTIME_CONVERSATION_RUNTIME_UNKNOWN'
      | 'AGENT_RUNTIME_CONVERSATION_ADAPTER_UNAVAILABLE'
      | 'AGENT_RUNTIME_CONVERSATION_MODEL_UNAVAILABLE'
      | 'AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT'
      | 'AGENT_RUNTIME_CONVERSATION_QUESTION_NOT_FOUND'
      | 'AGENT_RUNTIME_CONVERSATION_QUESTION_CONFLICT'
      | 'AGENT_RUNTIME_CONVERSATION_INVALID_CURSOR'
      | 'AGENT_RUNTIME_CONVERSATION_CLEANUP_UNCONFIRMED',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AgentRuntimeConversationServiceError';
  }
}

function serviceError(
  code: AgentRuntimeConversationServiceError['code'],
  message: string,
  cause?: unknown,
): AgentRuntimeConversationServiceError {
  return new AgentRuntimeConversationServiceError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function translateConversationJournalError(cause: unknown): never {
  if (cause instanceof AgentRuntimeConversationJournalError) {
    if (cause.code === 'AGENT_RUNTIME_CONVERSATION_NOT_FOUND') {
      throw serviceError('AGENT_RUNTIME_CONVERSATION_NOT_FOUND', '지속형 대화를 찾지 못했습니다.', cause);
    }
    if (cause.code === 'AGENT_RUNTIME_CONVERSATION_REQUEST_CONFLICT'
      || cause.code === 'AGENT_RUNTIME_CONVERSATION_REQUEST_RETIRED') {
      throw serviceError(
        'AGENT_RUNTIME_CONVERSATION_REQUEST_CONFLICT',
        '같은 요청 ID가 다른 지속형 대화 작업에 이미 사용되었습니다.',
        cause,
      );
    }
    if (cause.code === 'AGENT_RUNTIME_CONVERSATION_REQUEST_INDETERMINATE') {
      throw serviceError(
        'AGENT_RUNTIME_CONVERSATION_REQUEST_INDETERMINATE',
        '이 지속형 대화 요청의 provider 반영 여부를 확인할 수 없습니다.',
        cause,
      );
    }
    if (cause.code === 'AGENT_RUNTIME_CONVERSATION_REVISION_CONFLICT'
      || cause.code === 'AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT') {
      throw serviceError(
        'AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT',
        '지속형 대화 상태가 다른 단말에서 변경됐습니다. 새로 고친 뒤 다시 시도하세요.',
        cause,
      );
    }
  }
  throw cause;
}

function validTarget(value: AgentRuntimeResolvedTarget, expectedTargetId: string): boolean {
  return !!value
    && value.targetId === expectedTargetId
    && typeof value.projectLabel === 'string'
    && !!value.projectLabel.trim()
    && value.projectLabel.length <= 120
    && typeof value.cwd === 'string'
    && (value.cwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value.cwd))
    && !/[\u0000\r\n]/.test(value.cwd);
}

function selectedRuntimeModel(runtime: AgentRuntimeResolvedRuntime, modelId: string) {
  if (!runtime
    || typeof runtime.executable !== 'string'
    || runtime.executableIdentity?.path !== runtime.executable
    || !Array.isArray(runtime.models)) return null;
  const model = runtime.models.find(candidate => candidate.modelId === modelId);
  if (!model
    || typeof model.providerModel !== 'string'
    || typeof model.reasoningEffort !== 'string') return null;
  return model;
}

function conversationSemanticDraft(draft: CodexAgentTaskEventDraft) {
  return draft.type === 'task.progress'
    ? { type: 'conversation.progress' as const, payload: draft.payload }
    : { type: 'conversation.artifact.summary' as const, payload: draft.payload };
}

export class AgentRuntimeConversationService {
  readonly #journal: AgentRuntimeConversationJournal;
  readonly #resolveTarget: ResolveAgentRuntimeTarget;
  readonly #resolveRuntime: ResolveAgentRuntime;
  readonly #acquireWorkspaceLease: AcquireAgentRuntimeWorkspaceLease;
  readonly #executionEnabled: boolean;
  readonly #executionMode: CodexConversationExecutionMode;
  readonly #runCodexConversation: RunCodexConversation;
  readonly #inspectCodexConversation: InspectCodexConversation;
  readonly #mutateCodexConversation: MutateCodexConversation;
  readonly #readCodexConversationHistory: ReadCodexConversationHistory;
  readonly #createTurnId: () => string;
  readonly #createQuestionId: () => string;
  readonly #questionTimeoutMs: number;
  readonly #shutdownWaitMs: number;
  readonly #onTurnSettled: ((projectRoot: string) => void) | undefined;
  readonly #activeTurns = new Map<string, {
    turnId: string;
    controller: AbortController;
    control: CodexConversationLiveControl | null;
    settled: Promise<void>;
    settle: () => void;
  }>();
  readonly #activeProviderOperations = new Set<ActiveConversationProviderOperation>();
  readonly #detachedTurns = new Set<Promise<void>>();
  readonly #pendingQuestions = new Map<string, {
    publicQuestion: AgentRuntimeConversationPendingQuestion;
    providerQuestionIds: Map<string, string>;
    providerOptionLabels: Map<string, Map<string, string>>;
    resolve: (response: CodexConversationUserInputResponse) => void;
    reject: (cause: Error) => void;
  }>();
  readonly #answeredQuestionRequests = new Map<string, {
    conversationId: string;
    questionRequestId: string;
  }>();
  #shuttingDown = false;
  #shutdownPromise: Promise<void> | null = null;

  constructor(dependencies: AgentRuntimeConversationServiceDependencies) {
    this.#journal = dependencies.journal;
    this.#resolveTarget = dependencies.resolveTarget;
    this.#resolveRuntime = dependencies.resolveRuntime;
    this.#acquireWorkspaceLease = dependencies.acquireWorkspaceLease;
    this.#executionEnabled = dependencies.executionEnabled
      ?? dependencies.managedExecutionEnabled
      ?? AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED;
    this.#executionMode = dependencies.executionMode ?? 'workspace-write';
    this.#runCodexConversation = dependencies.runCodexConversation ?? runCodexConversationTurn;
    this.#inspectCodexConversation = dependencies.inspectCodexConversation ?? inspectCodexConversation;
    this.#mutateCodexConversation = dependencies.mutateCodexConversation ?? mutateCodexConversation;
    this.#readCodexConversationHistory = dependencies.readCodexConversationHistory
      ?? readCodexConversationHistory;
    this.#createTurnId = dependencies.createTurnId ?? (() => `turn_${randomUUID()}`);
    this.#createQuestionId = dependencies.createQuestionId ?? (() => randomUUID().replaceAll('-', '_'));
    this.#questionTimeoutMs = dependencies.questionTimeoutMs ?? 30 * 60_000;
    this.#shutdownWaitMs = dependencies.shutdownWaitMs ?? 5_000;
    this.#onTurnSettled = dependencies.onTurnSettled;
    // Opening the durable journal never implies that a pre-crash in-memory
    // provider boundary still exists. Recovery fences formerly running turns
    // and exact-revision prepared turn/lifecycle receipts until fresh provider
    // evidence can reconcile the retained thread.
    this.#journal.reconcileInterruptedTurns();
  }

  list(includeArchived = false): AgentRuntimeConversationSummary[] {
    return this.#journal.list(includeArchived);
  }

  questionStatus(conversationId: string): AgentRuntimeConversationQuestionStatusResponse {
    const conversation = this.#journal.get(conversationId);
    if (!conversation) {
      throw serviceError('AGENT_RUNTIME_CONVERSATION_NOT_FOUND', '지속형 대화를 찾지 못했습니다.');
    }
    return {
      protocolVersion: AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
      conversationId,
      question: this.#pendingQuestions.get(conversationId)?.publicQuestion ?? null,
    };
  }

  answerQuestion(
    rawRequest: AgentRuntimeConversationQuestionAnswerRequest,
  ): AgentRuntimeConversationQuestionAnswerResponse {
    const request = normalizeAgentRuntimeConversationQuestionAnswerRequest(rawRequest);
    const answered = this.#answeredQuestionRequests.get(request.requestId);
    if (answered) {
      if (answered.conversationId !== request.conversationId
        || answered.questionRequestId !== request.questionRequestId) {
        throw serviceError(
          'AGENT_RUNTIME_CONVERSATION_QUESTION_CONFLICT',
          '같은 요청 ID가 다른 대화 질문에 이미 사용되었습니다.',
        );
      }
      return {
        protocolVersion: AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
        requestId: request.requestId,
        conversationId: request.conversationId,
        questionRequestId: request.questionRequestId,
        accepted: true,
        duplicate: true,
      };
    }
    const pending = this.#pendingQuestions.get(request.conversationId);
    if (!pending || pending.publicQuestion.questionRequestId !== request.questionRequestId) {
      throw serviceError(
        'AGENT_RUNTIME_CONVERSATION_QUESTION_NOT_FOUND',
        '현재 답변을 기다리는 대화 질문을 찾지 못했습니다.',
      );
    }
    const publicQuestion = pending.publicQuestion;
    const current = this.#journal.get(request.conversationId);
    if (!current
      || current.state !== 'running'
      || current.activeTurnId !== request.expectedTurnId
      || current.activeTurnId !== publicQuestion.turnId
      || current.revision !== request.expectedRevision
      || current.revision !== publicQuestion.revision
      || Date.parse(publicQuestion.expiresAt) <= Date.now()) {
      throw serviceError(
        'AGENT_RUNTIME_CONVERSATION_QUESTION_CONFLICT',
        '대화 질문의 실행 상태가 변경됐습니다. 질문을 새로 확인하세요.',
      );
    }
    if (request.answers.length !== publicQuestion.questions.length) {
      throw serviceError(
        'AGENT_RUNTIME_CONVERSATION_QUESTION_CONFLICT',
        '모든 질문에 한 번씩 답해야 합니다.',
      );
    }
    const response: CodexConversationUserInputResponse = { answers: Object.create(null) };
    for (const question of publicQuestion.questions) {
      const answer = request.answers.find(candidate => candidate.questionId === question.questionId);
      const providerQuestionId = pending.providerQuestionIds.get(question.questionId);
      if (!answer || !providerQuestionId) {
        throw serviceError(
          'AGENT_RUNTIME_CONVERSATION_QUESTION_CONFLICT',
          '질문과 답변 식별자가 일치하지 않습니다.',
        );
      }
      let providerAnswer: string;
      if (answer.optionId !== null) {
        providerAnswer = pending.providerOptionLabels
          .get(question.questionId)?.get(answer.optionId) ?? '';
        if (!providerAnswer) {
          throw serviceError(
            'AGENT_RUNTIME_CONVERSATION_QUESTION_CONFLICT',
            '선택한 질문 답변을 찾지 못했습니다.',
          );
        }
      } else {
        if (!question.allowOther || answer.text === null) {
          throw serviceError(
            'AGENT_RUNTIME_CONVERSATION_QUESTION_CONFLICT',
            '이 질문에는 직접 입력한 답변을 사용할 수 없습니다.',
          );
        }
        providerAnswer = answer.text;
      }
      response.answers[providerQuestionId] = { answers: [providerAnswer] };
    }
    this.#pendingQuestions.delete(request.conversationId);
    this.#answeredQuestionRequests.set(request.requestId, {
      conversationId: request.conversationId,
      questionRequestId: request.questionRequestId,
    });
    while (this.#answeredQuestionRequests.size > 128) {
      const oldest = this.#answeredQuestionRequests.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.#answeredQuestionRequests.delete(oldest);
    }
    pending.resolve(response);
    return {
      protocolVersion: AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
      requestId: request.requestId,
      conversationId: request.conversationId,
      questionRequestId: request.questionRequestId,
      accepted: true,
      duplicate: false,
    };
  }

  readEvents(
    rawRequest: AgentRuntimeConversationEventsRequest,
  ): AgentRuntimeConversationEventsOutcome {
    const request = normalizeAgentRuntimeConversationEventsRequest(rawRequest);
    const current = this.#journal.get(request.conversationId);
    if (!current) {
      throw serviceError('AGENT_RUNTIME_CONVERSATION_NOT_FOUND', '지속형 대화를 찾지 못했습니다.');
    }
    const latest = this.#journal.latestEventSeq(request.conversationId);
    if (request.after > latest) {
      throw serviceError(
        'AGENT_RUNTIME_CONVERSATION_INVALID_CURSOR',
        '대화 이벤트 cursor가 현재 기록보다 앞서 있습니다.',
      );
    }
    const events = this.#journal.readEvents(request.conversationId, request.after);
    return {
      protocolVersion: request.protocolVersion,
      conversationId: request.conversationId,
      after: request.after,
      nextCursor: events.at(-1)?.seq ?? request.after,
      events,
    };
  }

  async history(
    rawRequest: AgentRuntimeConversationHistoryRequest,
  ): Promise<AgentRuntimeConversationHistoryOutcome> {
    this.#assertExecutionEnabled();
    const request = normalizeAgentRuntimeConversationHistoryRequest(rawRequest);
    const current = this.#journal.getPrivate(request.conversationId);
    if (!current) {
      throw serviceError('AGENT_RUNTIME_CONVERSATION_NOT_FOUND', '지속형 대화를 찾지 못했습니다.');
    }
    this.#assertCodexAdapter(current.summary.adapterId);
    if (current.summary.revision !== request.expectedRevision
      || (current.summary.state !== 'idle' && current.summary.state !== 'archived')
      || !current.providerThreadId) {
      throw serviceError(
        'AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT',
        '대화 기록을 읽기 전에 최신 대화 상태를 다시 확인하세요.',
      );
    }
    const target = await this.#resolveValidatedTarget(current.summary.targetId);
    const lease = await this.#acquireWorkspaceLease(target);
    if (!lease) {
      throw serviceError('AGENT_RUNTIME_CONVERSATION_BUSY', '이 프로젝트에서 다른 작업이 실행 중입니다.');
    }
    let operation: ActiveConversationProviderOperation | null = null;
    let releaseConfirmed = false;
    try {
      if (lease.revalidate && !await lease.revalidate()) {
        throw serviceError('AGENT_RUNTIME_CONVERSATION_TARGET_UNKNOWN', '프로젝트 상태가 변경됐습니다.');
      }
      const runtime = await this.#resolveRuntime('codex', { fresh: true });
      if (!runtime) {
        throw serviceError('AGENT_RUNTIME_CONVERSATION_RUNTIME_UNKNOWN', 'Codex 실행 파일을 사용할 수 없습니다.');
      }
      operation = this.#beginProviderOperation();
      const history = await this.#readCodexConversationHistory({
        codexExecutable: runtime.executable,
        codexExecutableIdentity: runtime.executableIdentity,
        cwd: target.cwd,
        providerThreadId: current.providerThreadId,
        conversationId: current.summary.conversationId,
        executionMode: this.#executionMode,
        signal: operation.controller.signal,
      });
      const latest = this.#journal.getPrivate(request.conversationId);
      if (!latest
        || latest.summary.revision !== request.expectedRevision
        || latest.providerThreadId !== current.providerThreadId
        || history.status !== 'idle') {
        throw serviceError(
          'AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT',
          '대화 기록을 읽는 동안 상태가 변경됐습니다.',
        );
      }
      return { conversation: latest.summary, history };
    } finally {
      try {
        try {
          releaseConfirmed = await lease.release();
        } catch {
          releaseConfirmed = false;
        }
        if (!releaseConfirmed) {
          throw serviceError(
            'AGENT_RUNTIME_CONVERSATION_CLEANUP_UNCONFIRMED',
            '프로젝트 작업 잠금 해제를 확인하지 못했습니다.',
          );
        }
      } finally {
        if (operation) this.#finishProviderOperation(operation);
      }
    }
  }

  async create(
    rawRequest: AgentRuntimeConversationCreateRequest,
  ): Promise<AgentRuntimeConversationTurnOutcome> {
    return this.#create(rawRequest);
  }

  async startCreate(
    rawRequest: AgentRuntimeConversationCreateRequest,
  ): Promise<AgentRuntimeConversationTurnAcceptedOutcome> {
    return this.#startDetached(onRunning => this.#create(rawRequest, onRunning));
  }

  async #create(
    rawRequest: AgentRuntimeConversationCreateRequest,
    onRunning?: (summary: AgentRuntimeConversationSummary) => void,
  ): Promise<AgentRuntimeConversationTurnOutcome> {
    this.#assertExecutionEnabled();
    const request = normalizeAgentRuntimeConversationCreateRequest(rawRequest);
    this.#assertCodexAdapter(request.adapterId);
    let existing: ReturnType<AgentRuntimeConversationJournal['findByCreateRequest']>;
    try {
      existing = this.#journal.findByCreateRequest(request);
    } catch (cause) {
      return translateConversationJournalError(cause);
    }
    if (existing) {
      if (existing.summary.state === 'running'
        || existing.summary.state === 'idle'
        || existing.summary.state === 'archived'
        || !existing.providerThreadId) {
        return {
          duplicate: true,
          conversation: existing.summary,
          finalSummary: null,
        };
      }
      const target = await this.#resolveValidatedTarget(existing.summary.targetId);
      const reconciled = await this.#reconcileBoundConversation(
        existing.summary.conversationId,
        target,
        existing.summary.revision,
      );
      return { duplicate: true, conversation: reconciled, finalSummary: null };
    }
    const target = await this.#resolveValidatedTarget(request.targetId);
    const created = this.#journal.create(request, target.projectLabel);
    if (created.duplicate) {
      if (created.conversation.summary.state === 'running'
        || created.conversation.summary.state === 'idle'
        || created.conversation.summary.state === 'archived') {
        return {
          duplicate: true,
          conversation: created.conversation.summary,
          finalSummary: null,
        };
      }
      if (!created.conversation.providerThreadId) {
        // A process/transport loss may have happened after provider acceptance
        // but before the private binding became durable. Blind replay would
        // create a second retained provider thread.
        return {
          duplicate: true,
          conversation: created.conversation.summary,
          finalSummary: null,
        };
      }
      const reconciled = await this.#reconcileBoundConversation(
        created.conversation.summary.conversationId,
        target,
        created.conversation.summary.revision,
      );
      return { duplicate: true, conversation: reconciled, finalSummary: null };
    }
    return this.#runTurn({
      conversationId: created.conversation.summary.conversationId,
      target,
      modelId: request.modelId,
      prompt: request.initialPrompt,
      providerThreadId: null,
      duplicate: created.duplicate,
      onRunning,
    });
  }

  async continue(
    rawRequest: AgentRuntimeConversationContinueRequest,
  ): Promise<AgentRuntimeConversationTurnOutcome> {
    return this.#continue(rawRequest);
  }

  async startContinue(
    rawRequest: AgentRuntimeConversationContinueRequest,
  ): Promise<AgentRuntimeConversationTurnAcceptedOutcome> {
    return this.#startDetached(onRunning => this.#continue(rawRequest, onRunning));
  }

  async #continue(
    rawRequest: AgentRuntimeConversationContinueRequest,
    onRunning?: (summary: AgentRuntimeConversationSummary) => void,
  ): Promise<AgentRuntimeConversationTurnOutcome> {
    this.#assertExecutionEnabled();
    const request = normalizeAgentRuntimeConversationContinueRequest(rawRequest);
    const existing = this.#journal.getPrivate(request.conversationId);
    if (existing) this.#assertCodexAdapter(existing.summary.adapterId);
    let prepared: ReturnType<AgentRuntimeConversationJournal['prepareContinue']>;
    try {
      prepared = this.#journal.prepareContinue(request);
    } catch (cause) {
      return translateConversationJournalError(cause);
    }
    if (prepared.duplicate) {
      if (prepared.indeterminate) {
        throw serviceError(
          'AGENT_RUNTIME_CONVERSATION_REQUEST_INDETERMINATE',
          '이 대화 turn 요청의 Codex 반영 여부를 확인할 수 없어 자동 재실행을 중단했습니다.',
        );
      }
      return {
        duplicate: true,
        conversation: prepared.conversation.summary,
        finalSummary: null,
      };
    }
    const current = prepared.conversation;
    const publicTurnId = this.#createTurnId();
    try {
      const target = await this.#resolveValidatedTarget(current.summary.targetId);
      return await this.#runTurn({
        conversationId: current.summary.conversationId,
        target,
        modelId: current.summary.modelId,
        prompt: request.prompt,
        providerThreadId: current.providerThreadId,
        duplicate: false,
        onRunning,
        publicTurnId,
        turnRequestId: request.requestId,
      });
    } catch (cause) {
      // A prepared request is durable before any provider call. If the exact
      // boundary that failed cannot prove non-acceptance, retire it as unknown
      // instead of replaying the user's prompt under the same request id.
      try {
        this.#journal.markRequestedTurnUnknown(
          current.summary.conversationId,
          request.requestId,
          publicTurnId,
        );
      } catch {
        // Preserve the primary execution error. The journal method is
        // idempotent when #runTurn already recorded the unknown outcome.
      }
      throw cause;
    }
  }

  async setArchived(
    rawRequest: AgentRuntimeConversationMutationRequest,
    archived: boolean,
  ): Promise<AgentRuntimeConversationSummary> {
    this.#assertExecutionEnabled();
    const request = normalizeAgentRuntimeConversationMutationRequest(rawRequest);
    const lifecycleIntent = {
      requestId: request.requestId,
      conversationId: request.conversationId,
      expectedRevision: request.expectedRevision,
      action: archived ? 'archive' as const : 'unarchive' as const,
    };
    try {
      const prior = this.#journal.findLifecycleMutation(lifecycleIntent);
      if (prior?.indeterminate) {
        throw serviceError(
          'AGENT_RUNTIME_CONVERSATION_REQUEST_INDETERMINATE',
          '이 대화 상태 변경의 provider 반영 여부를 확인할 수 없습니다.',
        );
      }
      if (prior?.conversation) return prior.conversation.summary;
    } catch (cause) {
      return translateConversationJournalError(cause);
    }
    const current = this.#journal.getPrivate(request.conversationId);
    if (!current) {
      throw serviceError('AGENT_RUNTIME_CONVERSATION_NOT_FOUND', '지속형 대화를 찾지 못했습니다.');
    }
    this.#assertCodexAdapter(current.summary.adapterId);
    const expectedState = archived ? 'idle' : 'archived';
    if (current.summary.revision !== request.expectedRevision
      || current.summary.state !== expectedState
      || !current.providerThreadId) {
      throw serviceError(
        'AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT',
        '지속형 대화 보관 상태가 다른 단말에서 변경됐습니다.',
      );
    }
    const target = await this.#resolveValidatedTarget(current.summary.targetId);
    const lease = await this.#acquireWorkspaceLease(target);
    if (!lease) {
      throw serviceError('AGENT_RUNTIME_CONVERSATION_BUSY', '이 프로젝트에서 다른 작업이 실행 중입니다.');
    }
    let releaseConfirmed = false;
    let operation: ActiveConversationProviderOperation | null = null;
    try {
      if (lease.revalidate && !await lease.revalidate()) {
        throw serviceError('AGENT_RUNTIME_CONVERSATION_TARGET_UNKNOWN', '프로젝트 상태가 변경됐습니다.');
      }
      const runtime = await this.#resolveRuntime('codex', { fresh: true });
      if (!runtime) {
        throw serviceError('AGENT_RUNTIME_CONVERSATION_RUNTIME_UNKNOWN', 'Codex 실행 파일을 사용할 수 없습니다.');
      }
      let prepared: ReturnType<AgentRuntimeConversationJournal['prepareLifecycleMutation']>;
      try {
        prepared = this.#journal.prepareLifecycleMutation(lifecycleIntent);
      } catch (cause) {
        return translateConversationJournalError(cause);
      }
      if (prepared.indeterminate) {
        throw serviceError(
          'AGENT_RUNTIME_CONVERSATION_REQUEST_INDETERMINATE',
          '이 대화 상태 변경의 provider 반영 여부를 확인할 수 없습니다.',
        );
      }
      if (prepared.duplicate && prepared.conversation) {
        return prepared.conversation.summary;
      }
      operation = this.#beginProviderOperation();
      try {
        await this.#mutateCodexConversation({
          codexExecutable: runtime.executable,
          codexExecutableIdentity: runtime.executableIdentity,
          cwd: target.cwd,
          providerThreadId: current.providerThreadId,
          action: lifecycleIntent.action,
          executionMode: this.#executionMode,
          signal: operation.controller.signal,
        });
        return this.#journal.completeLifecycleArchiveMutation(lifecycleIntent).summary;
      } catch (cause) {
        try {
          this.#journal.markLifecycleMutationIndeterminate(lifecycleIntent);
        } catch {
          // Keep the provider-boundary failure as the primary error. A prepared
          // receipt still prevents replay after restart even if marking fails.
        }
        throw serviceError(
          'AGENT_RUNTIME_CONVERSATION_REQUEST_INDETERMINATE',
          '대화 상태 변경의 provider 반영 여부를 확인할 수 없어 자동 재시도를 중단했습니다.',
          cause,
        );
      }
    } finally {
      try {
        try {
          releaseConfirmed = await lease.release();
        } catch {
          releaseConfirmed = false;
        }
        if (!releaseConfirmed) {
          throw serviceError(
            'AGENT_RUNTIME_CONVERSATION_CLEANUP_UNCONFIRMED',
            '프로젝트 작업 잠금 해제를 확인하지 못했습니다.',
          );
        }
      } finally {
        if (operation) this.#finishProviderOperation(operation);
      }
    }
  }

  async delete(
    rawRequest: AgentRuntimeConversationDeleteRequest,
  ): Promise<AgentRuntimeConversationDeleteOutcome> {
    this.#assertExecutionEnabled();
    const request = normalizeAgentRuntimeConversationDeleteRequest(rawRequest);
    if (this.#journal.isDeleteFinalized(request.conversationId, request.requestId)) {
      return { conversationId: request.conversationId, deleted: true, duplicate: true };
    }
    const lifecycleIntent = {
      requestId: request.requestId,
      conversationId: request.conversationId,
      expectedRevision: request.expectedRevision,
      action: 'delete' as const,
    };
    try {
      const prior = this.#journal.findLifecycleMutation(lifecycleIntent);
      if (prior?.indeterminate) {
        throw serviceError(
          'AGENT_RUNTIME_CONVERSATION_REQUEST_INDETERMINATE',
          '이 대화 삭제의 provider 반영 여부를 확인할 수 없습니다.',
        );
      }
      if (prior?.duplicate && prior.conversation === null) {
        return { conversationId: request.conversationId, deleted: true, duplicate: true };
      }
    } catch (cause) {
      return translateConversationJournalError(cause);
    }
    const current = this.#journal.getPrivate(request.conversationId);
    if (!current) {
      throw serviceError('AGENT_RUNTIME_CONVERSATION_NOT_FOUND', '지속형 대화를 찾지 못했습니다.');
    }
    this.#assertCodexAdapter(current.summary.adapterId);
    if (current.summary.revision !== request.expectedRevision
      || (current.summary.state !== 'idle' && current.summary.state !== 'archived')
      || !current.providerThreadId) {
      throw serviceError(
        'AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT',
        '실행 중이거나 변경된 지속형 대화는 영구 삭제할 수 없습니다.',
      );
    }
    const target = await this.#resolveValidatedTarget(current.summary.targetId);
    const lease = await this.#acquireWorkspaceLease(target);
    if (!lease) {
      throw serviceError('AGENT_RUNTIME_CONVERSATION_BUSY', '이 프로젝트에서 다른 작업이 실행 중입니다.');
    }
    let releaseConfirmed = false;
    let operation: ActiveConversationProviderOperation | null = null;
    try {
      if (lease.revalidate && !await lease.revalidate()) {
        throw serviceError('AGENT_RUNTIME_CONVERSATION_TARGET_UNKNOWN', '프로젝트 상태가 변경됐습니다.');
      }
      const runtime = await this.#resolveRuntime('codex', { fresh: true });
      if (!runtime) {
        throw serviceError('AGENT_RUNTIME_CONVERSATION_RUNTIME_UNKNOWN', 'Codex 실행 파일을 사용할 수 없습니다.');
      }
      let prepared: ReturnType<AgentRuntimeConversationJournal['prepareLifecycleMutation']>;
      try {
        prepared = this.#journal.prepareLifecycleMutation(lifecycleIntent);
      } catch (cause) {
        return translateConversationJournalError(cause);
      }
      if (prepared.indeterminate) {
        throw serviceError(
          'AGENT_RUNTIME_CONVERSATION_REQUEST_INDETERMINATE',
          '이 대화 삭제의 provider 반영 여부를 확인할 수 없습니다.',
        );
      }
      if (prepared.duplicate && prepared.conversation === null) {
        return { conversationId: request.conversationId, deleted: true, duplicate: true };
      }
      operation = this.#beginProviderOperation();
      try {
        await this.#mutateCodexConversation({
          codexExecutable: runtime.executable,
          codexExecutableIdentity: runtime.executableIdentity,
          cwd: target.cwd,
          providerThreadId: current.providerThreadId,
          action: 'delete',
          executionMode: this.#executionMode,
          signal: operation.controller.signal,
        });
        const finalized = this.#journal.finalizeDelete(
          request.conversationId,
          request.expectedRevision,
          request.requestId,
        );
        this.#journal.completeDeleteLifecycleReceipt(lifecycleIntent);
        return {
          conversationId: request.conversationId,
          deleted: true,
          duplicate: finalized.duplicate,
        };
      } catch (cause) {
        if (!this.#journal.isDeleteFinalized(request.conversationId, request.requestId)) {
          try {
            this.#journal.markLifecycleMutationIndeterminate(lifecycleIntent);
          } catch {
            // The prepared receipt is itself the durable replay barrier.
          }
          throw serviceError(
            'AGENT_RUNTIME_CONVERSATION_REQUEST_INDETERMINATE',
            '대화 삭제의 provider 반영 여부를 확인할 수 없어 자동 재시도를 중단했습니다.',
            cause,
          );
        }
        // The tombstone is the deletion authority. If receipt finalization alone
        // failed, report the deletion that this invocation durably completed.
        return { conversationId: request.conversationId, deleted: true, duplicate: false };
      }
    } finally {
      try {
        try {
          releaseConfirmed = await lease.release();
        } catch {
          releaseConfirmed = false;
        }
        if (!releaseConfirmed) {
          throw serviceError(
            'AGENT_RUNTIME_CONVERSATION_CLEANUP_UNCONFIRMED',
            '프로젝트 작업 잠금 해제를 확인하지 못했습니다.',
          );
        }
      } finally {
        if (operation) this.#finishProviderOperation(operation);
      }
    }
  }

  async steer(
    rawRequest: AgentRuntimeConversationSteerRequest,
  ): Promise<AgentRuntimeConversationSummary> {
    this.#assertExecutionEnabled();
    const request = normalizeAgentRuntimeConversationSteerRequest(rawRequest);
    return this.#applyLiveControl({
      requestId: request.requestId,
      conversationId: request.conversationId,
      expectedRevision: request.expectedRevision,
      expectedTurnId: request.expectedTurnId,
      action: 'steer',
      prompt: request.prompt,
    });
  }

  async interrupt(
    rawRequest: AgentRuntimeConversationInterruptRequest,
  ): Promise<AgentRuntimeConversationSummary> {
    this.#assertExecutionEnabled();
    const request = normalizeAgentRuntimeConversationInterruptRequest(rawRequest);
    return this.#applyLiveControl({
      requestId: request.requestId,
      conversationId: request.conversationId,
      expectedRevision: request.expectedRevision,
      expectedTurnId: request.expectedTurnId,
      action: 'interrupt',
    });
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shuttingDown = true;
    for (const active of this.#activeTurns.values()) active.controller.abort();
    for (const active of this.#activeProviderOperations) active.controller.abort();
    this.#shutdownPromise = (async () => {
      const active = [
        ...this.#activeTurns.values(),
        ...this.#activeProviderOperations,
      ];
      const settled = await Promise.all([
        ...active.map(entry => this.#waitBounded(entry.settled)),
        ...[...this.#detachedTurns].map(operation => this.#waitBounded(operation)),
      ]);
      if (settled.some(value => !value)
        || this.#activeTurns.size > 0
        || this.#activeProviderOperations.size > 0
        || this.#detachedTurns.size > 0) {
        throw new Error('AGENT_RUNTIME_CONVERSATION_SHUTDOWN_INCOMPLETE');
      }
    })();
    return this.#shutdownPromise;
  }

  forceAbortNow(): void {
    this.#shuttingDown = true;
    for (const active of this.#activeTurns.values()) active.controller.abort();
    for (const active of this.#activeProviderOperations) active.controller.abort();
  }

  async #runTurn(input: {
    conversationId: string;
    target: AgentRuntimeResolvedTarget;
    modelId: string;
    prompt: string;
    providerThreadId: string | null;
    duplicate: boolean;
    onRunning?: (summary: AgentRuntimeConversationSummary) => void;
    publicTurnId?: string;
    turnRequestId?: string;
  }): Promise<AgentRuntimeConversationTurnOutcome> {
    const currentConversation = this.#journal.getPrivate(input.conversationId);
    if (!currentConversation) {
      throw serviceError('AGENT_RUNTIME_CONVERSATION_NOT_FOUND', '지속형 대화를 찾지 못했습니다.');
    }
    this.#assertCodexAdapter(currentConversation.summary.adapterId);
    const lease = await this.#acquireWorkspaceLease(input.target);
    if (!lease) {
      throw serviceError('AGENT_RUNTIME_CONVERSATION_BUSY', '이 프로젝트에서 다른 작업이 실행 중입니다.');
    }
    let releaseConfirmed = false;
    let activeExecution: {
      turnId: string;
      controller: AbortController;
      control: CodexConversationLiveControl | null;
      settled: Promise<void>;
      settle: () => void;
    } | null = null;
    try {
      if (lease.revalidate && !await lease.revalidate()) {
        throw serviceError(
          'AGENT_RUNTIME_CONVERSATION_TARGET_UNKNOWN',
          '프로젝트 작업 대상이 잠금 중 변경됐습니다.',
        );
      }
      const runtime = await this.#resolveRuntime('codex', { fresh: true });
      const selected = runtime && selectedRuntimeModel(runtime, input.modelId);
      if (!runtime) {
        throw serviceError(
          'AGENT_RUNTIME_CONVERSATION_RUNTIME_UNKNOWN',
          'Codex 실행 파일을 사용할 수 없습니다.',
        );
      }
      if (!selected) {
        throw serviceError(
          'AGENT_RUNTIME_CONVERSATION_MODEL_UNAVAILABLE',
          '선택한 Codex 모델을 사용할 수 없습니다.',
        );
      }
      if (lease.revalidate && !await lease.revalidate()) {
        throw serviceError(
          'AGENT_RUNTIME_CONVERSATION_TARGET_UNKNOWN',
          '프로젝트 작업 대상이 실행 직전에 변경됐습니다.',
        );
      }

      let revision = this.#journal.getPrivate(input.conversationId)?.summary.revision ?? 0;
      const publicTurnId = input.publicTurnId ?? this.#createTurnId();
      let runningNotified = false;
      if (this.#shuttingDown) {
        throw serviceError(
          'AGENT_RUNTIME_CONVERSATION_SHUTTING_DOWN',
          '지속형 대화 런타임이 종료 중입니다.',
        );
      }
      if (this.#activeTurns.has(input.conversationId)) {
        throw serviceError(
          'AGENT_RUNTIME_CONVERSATION_BUSY',
          '이 지속형 대화에서 다른 turn이 실행 중입니다.',
        );
      }
      let settle!: () => void;
      const settled = new Promise<void>(resolve => { settle = resolve; });
      activeExecution = {
        turnId: publicTurnId,
        controller: new AbortController(),
        control: null,
        settled,
        settle,
      };
      this.#activeTurns.set(input.conversationId, activeExecution);
      const bindProviderIds = (ids: CodexAgentProviderIds): void => {
        const current = this.#journal.getPrivate(input.conversationId);
        if (!current) {
          throw serviceError('AGENT_RUNTIME_CONVERSATION_NOT_FOUND', '지속형 대화를 찾지 못했습니다.');
        }
        if (ids.threadId !== current.providerThreadId) {
          if (current.providerThreadId !== null) {
            throw serviceError(
              'AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT',
              'Codex 대화 식별자가 기존 연결과 일치하지 않습니다.',
            );
          }
          revision = this.#journal.bindProviderThread(
            input.conversationId,
            current.summary.revision,
            ids.threadId,
          ).summary.revision;
        }
        if (ids.turnId) {
          const beforeTurn = this.#journal.getPrivate(input.conversationId)!;
          const running = input.turnRequestId
            ? this.#journal.beginRequestedTurn(
              input.conversationId,
              input.turnRequestId,
              beforeTurn.summary.revision,
              publicTurnId,
              ids.turnId,
            )
            : this.#journal.beginTurn(
              input.conversationId,
              beforeTurn.summary.revision,
              publicTurnId,
              ids.turnId,
            );
          revision = running.summary.revision;
        }
      };

      let result: CodexConversationTurnResult;
      try {
        result = await this.#runCodexConversation({
          conversationId: input.conversationId,
          providerThreadId: input.providerThreadId,
          codexExecutable: runtime.executable,
          codexExecutableIdentity: runtime.executableIdentity,
          cwd: input.target.cwd,
          model: selected.providerModel,
          reasoningEffort: selected.reasoningEffort,
          executionMode: this.#executionMode,
          prompt: input.prompt,
          emit: draft => {
            const current = this.#journal.getPrivate(input.conversationId);
            // Provider shutdown can race a user interrupt. Once the journal no
            // longer owns this exact running turn, discard late semantic output.
            if (!current
              || current.summary.state !== 'running'
              || current.summary.activeTurnId !== publicTurnId) return;
            this.#journal.appendSemanticEvent(
              input.conversationId,
              current.summary.revision,
              publicTurnId,
              conversationSemanticDraft(draft),
            );
          },
          bindProviderIds,
          signal: activeExecution.controller.signal,
          requestUserInput: request => this.#awaitUserInput(
            input.conversationId,
            publicTurnId,
            activeExecution!.controller.signal,
            request,
          ),
          registerLiveControl: control => {
            const existing = this.#activeTurns.get(input.conversationId);
            if (existing !== activeExecution || existing.control !== null) {
              throw serviceError(
                'AGENT_RUNTIME_CONVERSATION_BUSY',
                '이 지속형 대화의 실행 제어권이 이미 사용 중입니다.',
              );
            }
            activeExecution!.control = control;
            const running = this.#journal.get(input.conversationId);
            if (!running
              || running.state !== 'running'
              || running.activeTurnId !== publicTurnId) {
              throw serviceError(
                'AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT',
                '지속형 대화의 실행 상태와 제어 연결이 일치하지 않습니다.',
              );
            }
            if (!runningNotified) {
              runningNotified = true;
              input.onRunning?.(running);
            }
            return () => {
              const current = this.#activeTurns.get(input.conversationId);
              if (current === activeExecution && current.control === control) current.control = null;
            };
          },
        });
      } catch (cause) {
        const failed = this.#journal.getPrivate(input.conversationId);
        if (failed
          && failed.summary.state === 'running'
          && failed.summary.activeTurnId === publicTurnId
          && cause instanceof CodexAgentRuntimeError
          && cause.code === 'CODEX_TASK_INTERRUPTED') {
          if (input.turnRequestId) {
            this.#journal.finishRequestedTurn(
              input.conversationId,
              input.turnRequestId,
              failed.summary.revision,
              publicTurnId,
              'interrupted',
            );
          } else {
            this.#journal.finishTurn(
              input.conversationId,
              failed.summary.revision,
              publicTurnId,
              'interrupted',
            );
          }
        } else if (failed && failed.summary.state !== 'unknown' && failed.summary.state !== 'archived') {
          if (input.turnRequestId) {
            this.#journal.markRequestedTurnUnknown(
              input.conversationId,
              input.turnRequestId,
              publicTurnId,
            );
          } else {
            this.#journal.markUnknown(input.conversationId, failed.summary.revision);
          }
        }
        throw cause;
      }
      const running = this.#journal.getPrivate(input.conversationId);
      if (!running || running.summary.state !== 'running'
        || running.summary.activeTurnId !== publicTurnId
        || running.providerThreadId !== result.threadId
        || running.providerTurnId !== result.turnId) {
        throw serviceError(
          'AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT',
          'Codex 대화 완료 상태를 안전하게 연결하지 못했습니다.',
        );
      }
      revision = running.summary.revision;
      const finished = input.turnRequestId
        ? this.#journal.finishRequestedTurn(
          input.conversationId,
          input.turnRequestId,
          revision,
          publicTurnId,
          'succeeded',
        )
        : this.#journal.finishTurn(input.conversationId, revision, publicTurnId);
      return {
        duplicate: input.duplicate,
        conversation: finished.summary,
        finalSummary: result.finalSummary,
      };
    } finally {
      try {
        try {
          releaseConfirmed = await lease.release();
        } catch {
          releaseConfirmed = false;
        }
        if (!releaseConfirmed) {
          throw serviceError(
            'AGENT_RUNTIME_CONVERSATION_CLEANUP_UNCONFIRMED',
            '프로젝트 작업 잠금 해제를 확인하지 못했습니다.',
          );
        }
      } finally {
        if (activeExecution) {
          const current = this.#activeTurns.get(input.conversationId);
          if (current === activeExecution) this.#activeTurns.delete(input.conversationId);
          activeExecution.settle();
          // The provider has stopped writing its retained transcript. Collection
          // is optional and must not turn a completed/interrupted turn into a
          // failed request that could cause the user to send the prompt twice.
          try { this.#onTurnSettled?.(input.target.cwd); } catch { /* best effort */ }
        }
      }
    }
  }

  async #awaitUserInput(
    conversationId: string,
    publicTurnId: string,
    signal: AbortSignal,
    providerRequest: CodexConversationUserInputRequest,
  ): Promise<CodexConversationUserInputResponse> {
    const current = this.#journal.get(conversationId);
    const active = this.#activeTurns.get(conversationId);
    if (!current
      || current.state !== 'running'
      || current.activeTurnId !== publicTurnId
      || !active
      || active.turnId !== publicTurnId
      || signal.aborted
      || this.#pendingQuestions.has(conversationId)) {
      throw serviceError(
        'AGENT_RUNTIME_CONVERSATION_QUESTION_CONFLICT',
        'Codex 질문과 현재 대화 실행 상태가 일치하지 않습니다.',
      );
    }

    const providerQuestionIds = new Map<string, string>();
    const providerOptionLabels = new Map<string, Map<string, string>>();
    const publicQuestions = providerRequest.questions.map(providerQuestion => {
      const questionId = `question_${this.#createQuestionId()}`;
      providerQuestionIds.set(questionId, providerQuestion.id);
      const optionLabels = new Map<string, string>();
      const options = providerQuestion.options?.map(providerOption => {
        const optionId = `option_${this.#createQuestionId()}`;
        optionLabels.set(optionId, providerOption.label);
        return {
          optionId,
          label: providerOption.label,
          description: providerOption.description,
        };
      }) ?? null;
      providerOptionLabels.set(questionId, optionLabels);
      return {
        questionId,
        header: providerQuestion.header,
        question: providerQuestion.question,
        options,
        allowOther: providerQuestion.allowOther,
      };
    });
    const publicQuestion: AgentRuntimeConversationPendingQuestion = {
      protocolVersion: AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
      questionRequestId: `question_request_${this.#createQuestionId()}`,
      conversationId,
      turnId: publicTurnId,
      revision: current.revision,
      expiresAt: new Date(Date.now() + Math.max(1, this.#questionTimeoutMs)).toISOString(),
      questions: publicQuestions,
    };

    return await new Promise<CodexConversationUserInputResponse>((resolve, reject) => {
      let settled = false;
      const finish = (
        outcome: { response: CodexConversationUserInputResponse } | { error: Error },
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        const pending = this.#pendingQuestions.get(conversationId);
        if (pending?.publicQuestion.questionRequestId === publicQuestion.questionRequestId) {
          this.#pendingQuestions.delete(conversationId);
        }
        if ('response' in outcome) resolve(outcome.response);
        else reject(outcome.error);
      };
      const onAbort = () => finish({ error: new Error('Codex 질문 대기가 중단되었습니다.') });
      const timer = setTimeout(() => finish({
        error: serviceError(
          'AGENT_RUNTIME_CONVERSATION_QUESTION_CONFLICT',
          'Codex 질문 응답 시간이 만료되었습니다.',
        ),
      }), Math.max(1, this.#questionTimeoutMs));
      timer.unref?.();
      this.#pendingQuestions.set(conversationId, {
        publicQuestion,
        providerQuestionIds,
        providerOptionLabels,
        resolve: response => finish({ response }),
        reject: error => finish({ error }),
      });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  async #reconcileBoundConversation(
    conversationId: string,
    target: AgentRuntimeResolvedTarget,
    expectedRevision: number,
  ): Promise<AgentRuntimeConversationSummary> {
    const current = this.#journal.getPrivate(conversationId);
    if (!current?.providerThreadId) {
      throw serviceError('AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT', 'Codex 대화 연결을 확인하지 못했습니다.');
    }
    this.#assertCodexAdapter(current.summary.adapterId);
    if (current.summary.state === 'idle' || current.summary.state === 'archived') {
      return current.summary;
    }
    if (current.summary.revision !== expectedRevision || current.summary.state !== 'unknown') {
      throw serviceError('AGENT_RUNTIME_CONVERSATION_STATE_CONFLICT', '지속형 대화 상태가 변경됐습니다.');
    }
    // A status probe still starts a fresh app-server child in the target
    // workspace. Serialize it with turns and mutations so reconciliation can
    // neither race another controller nor observe a replaced worktree.
    const lease = await this.#acquireWorkspaceLease(target);
    if (!lease) {
      throw serviceError('AGENT_RUNTIME_CONVERSATION_BUSY', '이 프로젝트에서 다른 작업이 실행 중입니다.');
    }
    let releaseConfirmed = false;
    let operation: ActiveConversationProviderOperation | null = null;
    try {
      if (lease.revalidate && !await lease.revalidate()) {
        throw serviceError('AGENT_RUNTIME_CONVERSATION_TARGET_UNKNOWN', '프로젝트 상태가 변경됐습니다.');
      }
      const runtime = await this.#resolveRuntime('codex', { fresh: true });
      if (!runtime) {
        throw serviceError('AGENT_RUNTIME_CONVERSATION_RUNTIME_UNKNOWN', 'Codex 실행 파일을 사용할 수 없습니다.');
      }
      if (lease.revalidate && !await lease.revalidate()) {
        throw serviceError('AGENT_RUNTIME_CONVERSATION_TARGET_UNKNOWN', '프로젝트 상태가 확인 중 변경됐습니다.');
      }
      operation = this.#beginProviderOperation();
      const inspected = await this.#inspectCodexConversation({
        codexExecutable: runtime.executable,
        codexExecutableIdentity: runtime.executableIdentity,
        cwd: target.cwd,
        providerThreadId: current.providerThreadId,
        executionMode: this.#executionMode,
        signal: operation.controller.signal,
      });
      if (inspected.status !== 'idle') {
        throw serviceError(
          'AGENT_RUNTIME_CONVERSATION_BUSY',
          inspected.status === 'active'
            ? 'Codex 대화가 아직 실행 중입니다.'
            : 'Codex 대화 상태를 확인하지 못했습니다.',
        );
      }
      return this.#journal.confirmProviderIdle(
        conversationId,
        expectedRevision,
        current.providerThreadId,
      ).summary;
    } finally {
      try {
        try {
          releaseConfirmed = await lease.release();
        } catch {
          releaseConfirmed = false;
        }
        if (!releaseConfirmed) {
          throw serviceError(
            'AGENT_RUNTIME_CONVERSATION_CLEANUP_UNCONFIRMED',
            '프로젝트 작업 잠금 해제를 확인하지 못했습니다.',
          );
        }
      } finally {
        if (operation) this.#finishProviderOperation(operation);
      }
    }
  }

  async #applyLiveControl(input: {
    requestId: string;
    conversationId: string;
    expectedRevision: number;
    expectedTurnId: string;
    action: 'steer' | 'interrupt';
    prompt?: string;
  }): Promise<AgentRuntimeConversationSummary> {
    const current = this.#journal.getPrivate(input.conversationId);
    if (current) this.#assertCodexAdapter(current.summary.adapterId);
    const prepared = this.#journal.prepareLiveControl(input);
    if (prepared.duplicate) {
      if (prepared.indeterminate) {
        throw serviceError(
          'AGENT_RUNTIME_CONVERSATION_REQUEST_INDETERMINATE',
          '이 제어 요청의 Codex 반영 여부를 확인할 수 없습니다. 대화 상태를 새로 확인하세요.',
        );
      }
      return prepared.conversation;
    }
    const live = this.#activeTurns.get(input.conversationId);
    if (!live || live.turnId !== input.expectedTurnId || !live.control) {
      this.#journal.markLiveControlIndeterminate(input);
      throw serviceError(
        'AGENT_RUNTIME_CONVERSATION_REQUEST_INDETERMINATE',
        '이 Mac이 활성 Codex 대화 turn의 제어 연결을 소유하고 있지 않습니다.',
      );
    }
    try {
      if (input.action === 'steer') await live.control.steer(input.prompt!);
      else await live.control.interrupt();
      return this.#journal.completeLiveControl(input);
    } catch (cause) {
      this.#journal.markLiveControlIndeterminate(input);
      throw serviceError(
        'AGENT_RUNTIME_CONVERSATION_REQUEST_INDETERMINATE',
        input.action === 'steer'
          ? 'Codex 추가 지시의 반영 여부를 확인할 수 없습니다.'
          : 'Codex 중단 요청의 반영 여부를 확인할 수 없습니다.',
        cause,
      );
    }
  }

  async #resolveValidatedTarget(targetId: string): Promise<AgentRuntimeResolvedTarget> {
    try {
      const target = await this.#resolveTarget(targetId);
      if (!validTarget(target, targetId)) throw new Error('invalid target');
      return target;
    } catch (cause) {
      throw serviceError(
        'AGENT_RUNTIME_CONVERSATION_TARGET_UNKNOWN',
        '등록된 프로젝트 작업 대상을 확인하지 못했습니다.',
        cause,
      );
    }
  }

  #assertExecutionEnabled(): void {
    if (!this.#executionEnabled) {
      throw serviceError(
        'AGENT_RUNTIME_CONVERSATION_EXECUTION_HELD',
        'OS 비탈출 격리 검증이 끝날 때까지 지속형 Codex 실행을 시작하지 않습니다.',
      );
    }
    if (this.#shuttingDown) {
      throw serviceError(
        'AGENT_RUNTIME_CONVERSATION_SHUTTING_DOWN',
        '지속형 대화 런타임이 종료 중입니다.',
      );
    }
  }

  #assertCodexAdapter(adapterId: string): void {
    if (adapterId !== 'codex') {
      throw serviceError(
        'AGENT_RUNTIME_CONVERSATION_ADAPTER_UNAVAILABLE',
        '선택한 AI 실행기는 아직 지속형 대화를 지원하지 않습니다.',
      );
    }
  }

  async #waitBounded(promise: Promise<void>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise.then(() => true, () => true),
        new Promise<false>(resolve => {
          timer = setTimeout(() => resolve(false), this.#shutdownWaitMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #startDetached(
    operation: (
      onRunning: (summary: AgentRuntimeConversationSummary) => void,
    ) => Promise<AgentRuntimeConversationTurnOutcome>,
  ): Promise<AgentRuntimeConversationTurnAcceptedOutcome> {
    this.#assertExecutionEnabled();
    let resolved = false;
    let resolveAccepted!: (outcome: AgentRuntimeConversationTurnAcceptedOutcome) => void;
    let rejectAccepted!: (cause: unknown) => void;
    const accepted = new Promise<AgentRuntimeConversationTurnAcceptedOutcome>((resolve, reject) => {
      resolveAccepted = resolve;
      rejectAccepted = reject;
    });
    const completion = operation(summary => {
      if (resolved) return;
      resolved = true;
      resolveAccepted({ duplicate: false, accepted: true, conversation: summary });
    });
    let settlement!: Promise<void>;
    settlement = completion.then(
      outcome => {
        if (!resolved) {
          resolved = true;
          resolveAccepted({
            duplicate: outcome.duplicate,
            accepted: false,
            conversation: outcome.conversation,
          });
        }
      },
      cause => {
        if (!resolved) {
          resolved = true;
          rejectAccepted(cause);
        }
      },
    ).finally(() => {
      this.#detachedTurns.delete(settlement);
    });
    this.#detachedTurns.add(settlement);
    return accepted;
  }

  #beginProviderOperation(): ActiveConversationProviderOperation {
    if (this.#shuttingDown) {
      throw serviceError(
        'AGENT_RUNTIME_CONVERSATION_SHUTTING_DOWN',
        '지속형 대화 런타임이 종료 중입니다.',
      );
    }
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const operation = {
      controller: new AbortController(),
      settled,
      settle,
    };
    this.#activeProviderOperations.add(operation);
    return operation;
  }

  #finishProviderOperation(operation: ActiveConversationProviderOperation): void {
    this.#activeProviderOperations.delete(operation);
    operation.settle();
  }
}

export function isAgentRuntimeConversationJournalConflict(
  error: unknown,
): error is AgentRuntimeConversationJournalError {
  return error instanceof AgentRuntimeConversationJournalError;
}
