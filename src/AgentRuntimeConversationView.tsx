import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';

import type {
  AgentRuntimeAdapterCapability,
  AgentRuntimeCapabilitiesResponse,
  AgentRuntimeTarget,
} from './agentRuntimeApiContract';
import type { AgentRuntimeConversationHistoryResponse } from './agentRuntimeConversationApiContract';
import {
  AgentRuntimeClient,
  AgentRuntimeClientError,
  createAgentRuntimeRequestId,
} from '../packages/runtime-sdk/client';
import {
  AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT,
  AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
  type AgentRuntimeConversationArtifactKind,
  type AgentRuntimeConversationEvent,
  type AgentRuntimeConversationState,
  type AgentRuntimeConversationSummary,
} from './agentRuntimeConversationProtocol';
import {
  BUILTIN_AGENT_RUNTIME_LABELS,
  type BuiltinAgentRuntimeId,
} from './agentRuntimeRegistry';
import {
  AGENT_RUNTIME_READ_ONLY_CONVERSATIONS_ENABLED,
  AGENT_RUNTIME_MAX_PROMPT_BYTES,
} from './agentRuntimeProtocol';
import {
  clearAgentRuntimePendingRequest,
  digestAgentRuntimeStartIntent,
  persistAgentRuntimePendingRequest,
  recoverAgentRuntimePendingRequestId,
  type AgentRuntimePendingStartStorage,
} from './agentRuntimePendingStart';
import { matchesAgentRuntimeConversationSearch } from './agentRuntimeConversationSearch';
import {
  AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
  type AgentRuntimeConversationPendingQuestion,
} from './agentRuntimeConversationQuestionProtocol';

const CONVERSATION_REFRESH_MS = 4_000;
const ACTIVE_EVENT_REFRESH_MS = 1_000;
const IDLE_EVENT_REFRESH_MS = 4_000;

const STATE_LABELS: Readonly<Record<AgentRuntimeConversationState, string>> = {
  idle: '대화 가능',
  running: '응답 중',
  archived: '보관됨',
  unknown: '상태 확인 필요',
};

const STATE_STYLES: Readonly<Record<AgentRuntimeConversationState, string>> = {
  idle: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200',
  running: 'border-teal-400/25 bg-teal-400/10 text-teal-200',
  archived: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-300',
  unknown: 'border-amber-400/25 bg-amber-400/10 text-amber-100',
};

const ARTIFACT_STYLES: Readonly<Record<AgentRuntimeConversationArtifactKind, string>> = {
  diff: 'border-sky-400/20 bg-sky-400/[0.06] text-sky-200',
  test: 'border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-200',
  commit: 'border-amber-400/20 bg-amber-400/[0.06] text-amber-100',
  memory: 'border-fuchsia-400/20 bg-fuchsia-400/[0.06] text-fuchsia-200',
  other: 'border-violet-400/15 bg-violet-400/[0.06] text-violet-200',
};

const EVENT_LABELS = {
  'conversation.turn.started': '에이전트가 응답을 시작했습니다.',
  'conversation.turn.completed': '응답이 완료되었습니다.',
  'conversation.turn.interrupted': '응답을 중단했습니다. 중단 전 변경은 남아 있을 수 있습니다.',
  'conversation.turn.unknown': '실행 경계가 끊겨 최종 상태를 자동 판단하지 않았습니다.',
} as const;

export function conversationEventText(event: AgentRuntimeConversationEvent): string {
  if (event.type === 'conversation.progress') return event.payload.summary;
  if (event.type === 'conversation.artifact.summary') {
    return `${event.payload.label} · ${event.payload.summary}`;
  }
  return EVENT_LABELS[event.type];
}

export interface AgentRuntimeConversationViewProps {
  visible: boolean;
  client: AgentRuntimeClient;
  capabilities: AgentRuntimeCapabilitiesResponse | null;
  targets: readonly AgentRuntimeTarget[];
  codexAdapterVerified?: boolean;
  preferredTargetId?: string | null;
  preferredTargetNonce?: number | null;
  onManageProject?: (projectTargetId: string) => void;
  onOpenMemory?: () => void;
  onOpenWhatISaid?: () => void;
  onActiveCountChange?: (count: number) => void;
}

interface PendingPrompt {
  requestId: string;
  conversationId: string;
  text: string;
}

function readableError(error: unknown): string {
  if (error instanceof AgentRuntimeClientError) return error.message;
  return '지속형 대화 상태를 확인하지 못했습니다.';
}

function isAborted(error: unknown): boolean {
  return error instanceof AgentRuntimeClientError
    && error.code === 'AGENT_RUNTIME_REQUEST_ABORTED';
}

function formatConversationTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

function promptBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function pendingStorage(): AgentRuntimePendingStartStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function upsertConversation(
  conversations: readonly AgentRuntimeConversationSummary[],
  conversation: AgentRuntimeConversationSummary,
): AgentRuntimeConversationSummary[] {
  return [conversation, ...conversations.filter(candidate => (
    candidate.conversationId !== conversation.conversationId
  ))].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export function conversationIntentFingerprint(
  kind: 'create' | 'continue' | 'steer' | 'interrupt' | 'archive' | 'unarchive' | 'delete',
  identity: string,
  revision: number,
  adapterId: BuiltinAgentRuntimeId,
  modelId: string,
  prompt: string,
): string {
  return JSON.stringify(['conversation', kind, identity, revision, adapterId, modelId, prompt]);
}

export function conversationStateFromEvent(
  event: AgentRuntimeConversationEvent,
): AgentRuntimeConversationState | null {
  switch (event.type) {
    case 'conversation.turn.started': return 'running';
    case 'conversation.turn.completed':
    case 'conversation.turn.interrupted': return 'idle';
    case 'conversation.turn.unknown': return 'unknown';
    case 'conversation.progress':
    case 'conversation.artifact.summary': return null;
  }
}

function defaultConversationModel(capability: AgentRuntimeAdapterCapability | null): string {
  return capability?.models.find(model => model.isDefault)?.modelId
    ?? capability?.models[0]?.modelId
    ?? '';
}

export function AgentRuntimeConversationView({
  visible,
  client,
  capabilities,
  targets,
  codexAdapterVerified = false,
  preferredTargetId = null,
  preferredTargetNonce = null,
  onManageProject,
  onOpenMemory,
  onOpenWhatISaid,
  onActiveCountChange,
}: AgentRuntimeConversationViewProps) {
  const [archivedOnly, setArchivedOnly] = useState(false);
  const [conversationQuery, setConversationQuery] = useState('');
  const [conversations, setConversations] = useState<AgentRuntimeConversationSummary[]>([]);
  const conversationsRef = useRef<AgentRuntimeConversationSummary[]>([]);
  const mutationEpochRef = useRef(0);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [creating, setCreating] = useState(true);
  const [selectedTargetId, setSelectedTargetId] = useState(targets[0]?.targetId ?? '');
  const appliedPreferredTargetNonceRef = useRef<number | null>(null);
  const [selectedAdapterId, setSelectedAdapterId] = useState<BuiltinAgentRuntimeId>('codex');
  const selectedCapability = capabilities?.adapters.find(
    adapter => adapter.adapterId === selectedAdapterId,
  ) ?? null;
  const [selectedModelId, setSelectedModelId] = useState('');
  const [historyConsent, setHistoryConsent] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [history, setHistory] = useState<AgentRuntimeConversationHistoryResponse | null>(null);
  const [events, setEvents] = useState<AgentRuntimeConversationEvent[]>([]);
  const eventCursorRef = useRef(new Map<string, number>());
  const conversationListRef = useRef<HTMLElement | null>(null);
  const conversationMainRef = useRef<HTMLElement | null>(null);
  const [pendingPrompts, setPendingPrompts] = useState<PendingPrompt[]>([]);
  const pendingRequestRef = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [listSyncError, setListSyncError] = useState('');
  const [historySyncError, setHistorySyncError] = useState('');
  const [eventSyncError, setEventSyncError] = useState('');
  const [questionSyncError, setQuestionSyncError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingQuestion, setPendingQuestion] = useState<AgentRuntimeConversationPendingQuestion | null>(null);
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, {
    optionId: string | null;
    text: string;
  }>>({});
  const [answeringQuestion, setAnsweringQuestion] = useState(false);
  const questionAnswerRequestRef = useRef<{ questionRequestId: string; requestId: string } | null>(null);

  const replaceConversations = useCallback((next: AgentRuntimeConversationSummary[]) => {
    conversationsRef.current = next;
    setConversations(next);
  }, []);

  const activeConversationCount = useMemo(() => conversations.filter(conversation => (
    conversation.state === 'running'
  )).length, [conversations]);
  const visibleConversations = useMemo(() => {
    return conversations.filter(conversation => (
      matchesAgentRuntimeConversationSearch(conversation, conversationQuery)
    ));
  }, [conversationQuery, conversations]);

  useEffect(() => {
    onActiveCountChange?.(activeConversationCount);
  }, [activeConversationCount, onActiveCountChange]);

  useEffect(() => () => onActiveCountChange?.(0), [onActiveCountChange]);

  useEffect(() => {
    if (preferredTargetId && preferredTargetNonce !== null
      && appliedPreferredTargetNonceRef.current !== preferredTargetNonce
      && targets.some(target => target.targetId === preferredTargetId)) {
      appliedPreferredTargetNonceRef.current = preferredTargetNonce;
      setSelectedTargetId(preferredTargetId);
      setCreating(true);
      return;
    }
    if (targets.some(target => target.targetId === selectedTargetId)) return;
    setSelectedTargetId(targets[0]?.targetId ?? '');
  }, [preferredTargetId, preferredTargetNonce, selectedTargetId, targets]);

  useEffect(() => {
    if (selectedCapability?.availability !== 'available') {
      setSelectedModelId('');
      return;
    }
    if (selectedCapability.models.some(model => model.modelId === selectedModelId)) return;
    setSelectedModelId(defaultConversationModel(selectedCapability));
  }, [selectedCapability, selectedModelId]);

  useEffect(() => {
    if (!visible) return undefined;
    const controller = new AbortController();
    let stopped = false;
    let refreshing = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = async (initial: boolean) => {
      if (stopped || refreshing) return;
      refreshing = true;
      const mutationEpoch = mutationEpochRef.current;
      if (initial) setListLoading(true);
      try {
        const response = await client.conversations(archivedOnly, { signal: controller.signal });
        if (stopped) return;
        if (mutationEpoch === mutationEpochRef.current) {
          replaceConversations(response.conversations);
          setSelectedConversationId(current => (
            current && response.conversations.some(item => item.conversationId === current)
              ? current
              : null
          ));
        }
        setListSyncError('');
      } catch (cause) {
        if (!stopped && !isAborted(cause)) setListSyncError(readableError(cause));
      } finally {
        refreshing = false;
        if (initial && !stopped) setListLoading(false);
        if (!stopped) timer = setTimeout(() => void refresh(false), CONVERSATION_REFRESH_MS);
      }
    };
    void refresh(true);
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [archivedOnly, client, replaceConversations, visible]);

  const selectedConversation = selectedConversationId
    ? conversations.find(item => item.conversationId === selectedConversationId) ?? null
    : null;
  const selectedConversationCapability = selectedConversation
    ? capabilities?.adapters.find(
      adapter => adapter.adapterId === selectedConversation.adapterId,
    ) ?? null
    : null;
  const adapterLabel = useCallback((adapterId: BuiltinAgentRuntimeId): string => (
    capabilities?.adapters.find(candidate => candidate.adapterId === adapterId)?.label
      ?? BUILTIN_AGENT_RUNTIME_LABELS[adapterId]
  ), [capabilities]);
  const selectedTarget = targets.find(target => target.targetId === (
    creating ? selectedTargetId : selectedConversation?.targetId
  )) ?? null;

  useEffect(() => {
    setEvents([]);
    if (selectedConversationId) eventCursorRef.current.delete(selectedConversationId);
    setHistory(null);
    setHistorySyncError('');
    setEventSyncError('');
    setQuestionSyncError('');
    setPendingQuestion(null);
    setQuestionAnswers({});
    questionAnswerRequestRef.current = null;
    setError('');
  }, [selectedConversationId]);

  useEffect(() => {
    if (creating || !selectedConversation
      || selectedConversation.state !== 'running') {
      setPendingQuestion(null);
      setQuestionAnswers({});
      questionAnswerRequestRef.current = null;
      return undefined;
    }
    // Visibility pauses observation, while the same running question and its
    // answer draft remain mounted until the server reports a different question.
    if (!visible) return undefined;
    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const conversationId = selectedConversation.conversationId;
    const refresh = async () => {
      try {
        const response = await client.conversationQuestion(conversationId, {
          signal: controller.signal,
        });
        if (stopped) return;
        setPendingQuestion(current => {
          if (current?.questionRequestId === response.question?.questionRequestId) return current;
          setQuestionAnswers({});
          questionAnswerRequestRef.current = null;
          return response.question;
        });
        setQuestionSyncError('');
      } catch (cause) {
        if (!stopped && !isAborted(cause)) setQuestionSyncError(readableError(cause));
      } finally {
        if (!stopped) timer = setTimeout(() => void refresh(), ACTIVE_EVENT_REFRESH_MS);
      }
    };
    void refresh();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [client, creating, selectedConversation?.conversationId, selectedConversation?.state, visible]);

  useEffect(() => {
    if (!visible || creating || !selectedConversation) return undefined;
    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const conversationId = selectedConversation.conversationId;
    let cursor = eventCursorRef.current.get(conversationId) ?? 0;
    const refresh = async () => {
      try {
        const batch: AgentRuntimeConversationEvent[] = [];
        let pageCursor = cursor;
        for (let page = 0; page < 6; page += 1) {
          const response = await client.conversationEvents(conversationId, pageCursor, {
            signal: controller.signal,
          });
          if (response.nextCursor < pageCursor) throw new Error('CONVERSATION_EVENT_CURSOR_REGRESSED');
          batch.push(...response.events);
          pageCursor = response.nextCursor;
          if (response.events.length < 100) break;
        }
        if (stopped) return;
        cursor = pageCursor;
        eventCursorRef.current.set(conversationId, cursor);
        if (batch.length > 0) {
          setEvents(current => [...current, ...batch].slice(-64));
          const lifecycle = [...batch].reverse().find(event => (
            event.type !== 'conversation.progress'
            && event.type !== 'conversation.artifact.summary'
          ));
          const latestSummary = conversationsRef.current.find(item => (
            item.conversationId === conversationId
          ));
          // Archive/unarchive mutations may be newer than the last semantic
          // turn event. Never let cursor replay roll a newer summary backward.
          const nextState = lifecycle ? conversationStateFromEvent(lifecycle) : null;
          if (latestSummary && lifecycle && nextState
            && lifecycle.revision >= latestSummary.revision) {
            replaceConversations(upsertConversation(
              conversationsRef.current,
              {
                ...latestSummary,
                state: nextState,
                activeTurnId: lifecycle.type === 'conversation.turn.started' ? lifecycle.turnId : null,
                revision: lifecycle.revision,
                updatedAt: lifecycle.createdAt,
              },
            ));
          }
        }
        setEventSyncError('');
      } catch (cause) {
        if (!stopped && !isAborted(cause)) setEventSyncError(readableError(cause));
      } finally {
        if (!stopped) timer = setTimeout(
          () => void refresh(),
          selectedConversation.state === 'running'
            ? ACTIVE_EVENT_REFRESH_MS
            : IDLE_EVENT_REFRESH_MS,
        );
      }
    };
    void refresh();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [
    client,
    creating,
    replaceConversations,
    selectedConversation?.conversationId,
    selectedConversation?.state,
    visible,
  ]);

  useEffect(() => {
    if (!visible || creating || !selectedConversation
      || (selectedConversation.state !== 'idle' && selectedConversation.state !== 'archived')
      || !AGENT_RUNTIME_READ_ONLY_CONVERSATIONS_ENABLED
      || selectedConversationCapability?.availability !== 'available') return undefined;
    const controller = new AbortController();
    let stopped = false;
    setHistoryLoading(true);
    void client.conversationHistory({
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      conversationId: selectedConversation.conversationId,
      expectedRevision: selectedConversation.revision,
    }, { signal: controller.signal }).then(
      response => {
        if (stopped) return;
        setHistory(response);
        setPendingPrompts(current => current.filter(candidate => (
          candidate.conversationId !== selectedConversation.conversationId
        )));
        setHistorySyncError('');
      },
      cause => {
        if (!stopped && !isAborted(cause)) setHistorySyncError(readableError(cause));
      },
    ).finally(() => {
      if (!stopped) setHistoryLoading(false);
    });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [
    client,
    selectedConversationCapability?.availability,
    creating,
    selectedConversation?.conversationId,
    selectedConversation?.revision,
    selectedConversation?.state,
    visible,
  ]);

  const maxPromptBytes = capabilities?.limits.maxPromptBytes ?? AGENT_RUNTIME_MAX_PROMPT_BYTES;
  const bytes = promptBytes(prompt);
  const activeCapability = creating ? selectedCapability : selectedConversationCapability;
  const executionAvailable = Boolean(
    AGENT_RUNTIME_READ_ONLY_CONVERSATIONS_ENABLED
      && activeCapability?.availability === 'available',
  );
  const canCreate = creating
    && executionAvailable
    && Boolean(selectedTarget && !selectedTarget.locked && selectedModelId
      && historyConsent && prompt.trim() && bytes <= maxPromptBytes && !mutating);
  const canContinue = !creating
    && executionAvailable
    && selectedConversation?.state === 'idle'
    && Boolean(prompt.trim() && bytes <= maxPromptBytes && !mutating);
  const canSteer = !creating
    && executionAvailable
    && selectedConversation?.state === 'running'
    && Boolean(selectedConversation.activeTurnId && prompt.trim()
      && bytes <= maxPromptBytes && !mutating);

  const requestIdForIntent = async (fingerprint: string): Promise<{
    requestId: string;
    storage: AgentRuntimePendingStartStorage | null;
  }> => {
    const intentDigest = await digestAgentRuntimeStartIntent(fingerprint);
    const storage = pendingStorage();
    if (!pendingRequestRef.current || pendingRequestRef.current.fingerprint !== fingerprint) {
      const recovered = storage
        ? recoverAgentRuntimePendingRequestId(storage, intentDigest)
        : null;
      pendingRequestRef.current = {
        fingerprint,
        requestId: recovered ?? createAgentRuntimeRequestId(),
      };
      if (storage && !recovered) {
        try {
          persistAgentRuntimePendingRequest(storage, intentDigest, pendingRequestRef.current.requestId);
        } catch {
          // The server receipt remains authoritative; persistence only lets a
          // user retry the exact lifecycle intent after a lost response.
        }
      }
    }
    return { requestId: pendingRequestRef.current.requestId, storage };
  };

  const reconcileAfterMutationFailure = async (preferredConversationId: string | null) => {
    // Keep the surrounding mutation's busy lock until the host has projected
    // the durable post-boundary state. This refresh never clears `error`.
    mutationEpochRef.current += 1;
    try {
      const response = await client.conversations(archivedOnly);
      replaceConversations(response.conversations);
      setSelectedConversationId(current => {
        const preferred = preferredConversationId
          && response.conversations.some(item => item.conversationId === preferredConversationId)
          ? preferredConversationId
          : null;
        return preferred ?? (current && response.conversations.some(item => (
          item.conversationId === current
        )) ? current : response.conversations[0]?.conversationId ?? null);
      });
      setListSyncError('');
    } catch (cause) {
      if (!isAborted(cause)) setListSyncError(readableError(cause));
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canCreate && !canContinue && !canSteer) return;
    setMutating(true);
    mutationEpochRef.current += 1;
    setError('');
    setNotice('');
    try {
      if (canSteer && selectedConversation?.activeTurnId) {
        const fingerprint = conversationIntentFingerprint(
          'steer',
          selectedConversation.conversationId,
          selectedConversation.revision,
          selectedConversation.adapterId,
          selectedConversation.modelId,
          prompt,
        );
        const intentDigest = await digestAgentRuntimeStartIntent(fingerprint);
        const storage = pendingStorage();
        if (!pendingRequestRef.current || pendingRequestRef.current.fingerprint !== fingerprint) {
          const recovered = storage
            ? recoverAgentRuntimePendingRequestId(storage, intentDigest)
            : null;
          pendingRequestRef.current = {
            fingerprint,
            requestId: recovered ?? createAgentRuntimeRequestId(),
          };
          if (storage && !recovered) {
            try {
              persistAgentRuntimePendingRequest(storage, intentDigest, pendingRequestRef.current.requestId);
            } catch {
              // Server receipt remains authoritative when local storage is unavailable.
            }
          }
        }
        const requestId = pendingRequestRef.current.requestId;
        const next = await client.steerConversation({
          protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
          requestId,
          conversationId: selectedConversation.conversationId,
          expectedRevision: selectedConversation.revision,
          expectedTurnId: selectedConversation.activeTurnId,
          prompt,
        });
        mutationEpochRef.current += 1;
        replaceConversations(upsertConversation(conversationsRef.current, next));
        setPendingPrompts(current => [...current, {
          requestId,
          conversationId: selectedConversation.conversationId,
          text: prompt,
        }].slice(-8));
        setPrompt('');
        pendingRequestRef.current = null;
        if (storage) clearAgentRuntimePendingRequest(storage, requestId);
        setNotice('현재 응답에 추가 지시를 전달했습니다.');
        return;
      }

      const identity = creating ? selectedTargetId : selectedConversation!.conversationId;
      const revision = creating ? 1 : selectedConversation!.revision;
      const modelId = creating ? selectedModelId : selectedConversation!.modelId;
      const adapterId = creating ? selectedAdapterId : selectedConversation!.adapterId;
      const fingerprint = conversationIntentFingerprint(
        creating ? 'create' : 'continue', identity, revision, adapterId, modelId, prompt,
      );
      const intentDigest = await digestAgentRuntimeStartIntent(fingerprint);
      const storage = pendingStorage();
      if (!pendingRequestRef.current || pendingRequestRef.current.fingerprint !== fingerprint) {
        const recovered = storage
          ? recoverAgentRuntimePendingRequestId(storage, intentDigest)
          : null;
        pendingRequestRef.current = {
          fingerprint,
          requestId: recovered ?? createAgentRuntimeRequestId(),
        };
        if (storage && !recovered) {
          try {
            persistAgentRuntimePendingRequest(storage, intentDigest, pendingRequestRef.current.requestId);
          } catch {
            // The server-side request receipt remains authoritative. Browser
            // persistence only adds reload recovery for an uncertain response.
          }
        }
      }
      const requestId = pendingRequestRef.current.requestId;
      const response = creating
        ? await client.startConversation({
          protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
          requestId,
          targetId: selectedTargetId,
          adapterId: selectedAdapterId,
          modelId: selectedModelId,
          historyRetentionConsent: AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT,
          initialPrompt: prompt,
        })
        : await client.continueConversation({
          protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
          requestId,
          conversationId: selectedConversation!.conversationId,
          expectedRevision: selectedConversation!.revision,
          prompt,
        });
      mutationEpochRef.current += 1;
      replaceConversations(upsertConversation(conversationsRef.current, response.conversation));
      setSelectedConversationId(response.conversation.conversationId);
      setCreating(false);
      setPendingPrompts(current => [...current, {
        requestId,
        conversationId: response.conversation.conversationId,
        text: prompt,
      }].slice(-8));
      setPrompt('');
      setHistoryConsent(false);
      pendingRequestRef.current = null;
      if (storage) clearAgentRuntimePendingRequest(storage, requestId);
      setNotice(response.duplicate
        ? '이미 접수된 대화 요청으로 이동했습니다.'
        : '대화 요청을 접수했습니다. 이 화면을 닫아도 실행 상태는 유지됩니다.');
    } catch (cause) {
      if (!isAborted(cause)) {
        setError(readableError(cause));
        await reconcileAfterMutationFailure(selectedConversation?.conversationId ?? null);
      }
    } finally {
      setMutating(false);
    }
  };

  const interrupt = async () => {
    if (!selectedConversation?.activeTurnId || selectedConversation.state !== 'running') return;
    setMutating(true);
    setError('');
    try {
      const fingerprint = conversationIntentFingerprint(
        'interrupt',
        selectedConversation.conversationId,
        selectedConversation.revision,
        selectedConversation.adapterId,
        selectedConversation.modelId,
        selectedConversation.activeTurnId,
      );
      const intentDigest = await digestAgentRuntimeStartIntent(fingerprint);
      const storage = pendingStorage();
      if (!pendingRequestRef.current || pendingRequestRef.current.fingerprint !== fingerprint) {
        const recovered = storage
          ? recoverAgentRuntimePendingRequestId(storage, intentDigest)
          : null;
        pendingRequestRef.current = {
          fingerprint,
          requestId: recovered ?? createAgentRuntimeRequestId(),
        };
        if (storage && !recovered) {
          try {
            persistAgentRuntimePendingRequest(storage, intentDigest, pendingRequestRef.current.requestId);
          } catch {
            // Server receipt remains authoritative when local storage is unavailable.
          }
        }
      }
      const requestId = pendingRequestRef.current.requestId;
      const next = await client.interruptConversation({
        protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
        requestId,
        conversationId: selectedConversation.conversationId,
        expectedRevision: selectedConversation.revision,
        expectedTurnId: selectedConversation.activeTurnId,
      });
      mutationEpochRef.current += 1;
      replaceConversations(upsertConversation(conversationsRef.current, next));
      pendingRequestRef.current = null;
      if (storage) clearAgentRuntimePendingRequest(storage, requestId);
      setNotice('중단을 확인했습니다. 중단 전에 적용된 변경은 남아 있을 수 있습니다.');
    } catch (cause) {
      if (!isAborted(cause)) {
        setError(readableError(cause));
        await reconcileAfterMutationFailure(selectedConversation.conversationId);
      }
    } finally {
      setMutating(false);
    }
  };

  const toggleArchive = async () => {
    if (!selectedConversation || selectedConversation.state === 'running'
      || selectedConversation.state === 'unknown') return;
    setMutating(true);
    setError('');
    try {
      const action = selectedConversation.state === 'archived' ? 'unarchive' : 'archive';
      const fingerprint = conversationIntentFingerprint(
        action,
        selectedConversation.conversationId,
        selectedConversation.revision,
        selectedConversation.adapterId,
        selectedConversation.modelId,
        '',
      );
      const { requestId, storage } = await requestIdForIntent(fingerprint);
      const next = await client.setConversationArchived({
        protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
        requestId,
        conversationId: selectedConversation.conversationId,
        expectedRevision: selectedConversation.revision,
      }, selectedConversation.state !== 'archived');
      pendingRequestRef.current = null;
      if (storage) clearAgentRuntimePendingRequest(storage, requestId);
      mutationEpochRef.current += 1;
      replaceConversations(conversationsRef.current.filter(item => (
        item.conversationId !== selectedConversation.conversationId
      )));
      setPendingPrompts(current => current.filter(candidate => (
        candidate.conversationId !== selectedConversation.conversationId
      )));
      setSelectedConversationId(null);
      setCreating(false);
      setNotice(next.state === 'archived' ? '대화를 보관했습니다.' : '대화를 복원했습니다.');
    } catch (cause) {
      if (!isAborted(cause)) {
        setError(readableError(cause));
        await reconcileAfterMutationFailure(selectedConversation.conversationId);
      }
    } finally {
      setMutating(false);
    }
  };

  const permanentlyDelete = async () => {
    if (!selectedConversation || selectedConversation.state !== 'archived' || mutating) return;
    if (typeof window === 'undefined' || !window.confirm(
      `“${selectedConversation.projectLabel}” 대화를 영구 삭제할까요?\n\n이 Mac의 ${adapterLabel(selectedConversation.adapterId)} 대화 기록도 함께 삭제되며 되돌릴 수 없습니다.`,
    )) return;
    setMutating(true);
    setError('');
    setNotice('');
    try {
      const fingerprint = conversationIntentFingerprint(
        'delete',
        selectedConversation.conversationId,
        selectedConversation.revision,
        selectedConversation.adapterId,
        selectedConversation.modelId,
        '',
      );
      const { requestId, storage } = await requestIdForIntent(fingerprint);
      await client.deleteConversation({
        protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
        requestId,
        conversationId: selectedConversation.conversationId,
        expectedRevision: selectedConversation.revision,
        confirmPermanentDeletion: true,
      });
      pendingRequestRef.current = null;
      if (storage) clearAgentRuntimePendingRequest(storage, requestId);
      mutationEpochRef.current += 1;
      replaceConversations(conversationsRef.current.filter(item => (
        item.conversationId !== selectedConversation.conversationId
      )));
      setPendingPrompts(current => current.filter(candidate => (
        candidate.conversationId !== selectedConversation.conversationId
      )));
      eventCursorRef.current.delete(selectedConversation.conversationId);
      setSelectedConversationId(null);
      setHistory(null);
      setEvents([]);
      setNotice('대화와 provider 기록을 영구 삭제했습니다.');
    } catch (cause) {
      if (!isAborted(cause)) {
        setError(readableError(cause));
        await reconcileAfterMutationFailure(selectedConversation.conversationId);
      }
    } finally {
      setMutating(false);
    }
  };

  const answerPendingQuestion = async () => {
    if (!pendingQuestion || answeringQuestion) return;
    const answers = pendingQuestion.questions.map(question => {
      const selected = questionAnswers[question.questionId];
      if (!selected) return null;
      if (selected.optionId) {
        return { questionId: question.questionId, optionId: selected.optionId, text: null };
      }
      const text = selected.text.trim();
      return text ? { questionId: question.questionId, optionId: null, text } : null;
    });
    if (answers.some(answer => answer === null)) {
      setError('Codex가 요청한 모든 질문에 답해 주세요.');
      return;
    }
    if (!questionAnswerRequestRef.current
      || questionAnswerRequestRef.current.questionRequestId !== pendingQuestion.questionRequestId) {
      questionAnswerRequestRef.current = {
        questionRequestId: pendingQuestion.questionRequestId,
        requestId: createAgentRuntimeRequestId(),
      };
    }
    setAnsweringQuestion(true);
    setError('');
    try {
      await client.answerConversationQuestion({
        protocolVersion: AGENT_RUNTIME_CONVERSATION_QUESTION_PROTOCOL_VERSION,
        requestId: questionAnswerRequestRef.current.requestId,
        conversationId: pendingQuestion.conversationId,
        questionRequestId: pendingQuestion.questionRequestId,
        expectedRevision: pendingQuestion.revision,
        expectedTurnId: pendingQuestion.turnId,
        answers: answers.filter(answer => answer !== null),
      });
      setPendingQuestion(null);
      setQuestionAnswers({});
      questionAnswerRequestRef.current = null;
      setNotice('답변을 Codex의 현재 응답에 전달했습니다.');
    } catch (cause) {
      if (!isAborted(cause)) setError(readableError(cause));
    } finally {
      setAnsweringQuestion(false);
    }
  };

  const selectConversation = (conversationId: string) => {
    setCreating(false);
    setSelectedConversationId(conversationId);
    setPrompt('');
    if (typeof window !== 'undefined' && conversationMainRef.current
      && window.getComputedStyle(conversationMainRef.current).order === '1') {
      window.requestAnimationFrame(() => conversationMainRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      }));
    }
  };

  const startNew = () => {
    setArchivedOnly(false);
    setCreating(true);
    setSelectedConversationId(null);
    setPrompt('');
    setHistory(null);
    setEvents([]);
    setError('');
    setNotice('');
  };

  const historyMessages = useMemo(
    () => history?.history.turns.flatMap(turn => turn.messages) ?? [],
    [history],
  );
  const selectedPendingPrompts = useMemo(
    () => selectedConversation
      ? pendingPrompts.filter(candidate => (
          candidate.conversationId === selectedConversation.conversationId
        ))
      : [],
    [pendingPrompts, selectedConversation],
  );
  const canAnswerQuestion = Boolean(pendingQuestion
    && !answeringQuestion
    && pendingQuestion.questions.every(question => {
      const answer = questionAnswers[question.questionId];
      if (!answer) return false;
      if (answer.optionId) return question.options?.some(option => option.optionId === answer.optionId);
      return question.allowOther && Boolean(answer.text.trim());
    }));
  const visibleError = error || questionSyncError || eventSyncError || historySyncError || listSyncError;
  const renderComposer = (embedded: boolean) => (
    <details open data-testid="conversation-composer-disclosure" className="border-t border-[rgb(var(--surface-highlight-rgb))]/[0.07]">
      <summary className="cursor-pointer px-4 py-2 text-xs text-zinc-400 hover:text-zinc-100">
        메시지 입력 · 읽기 전용{prompt ? ' · 작성 중' : ''}
      </summary>
    <form
      onSubmit={submit}
      className="px-3 pb-3"
      aria-label="지속형 대화 입력"
      data-testid={embedded ? 'conversation-create-composer' : 'conversation-turn-composer'}
    >
      <label htmlFor="agent-runtime-conversation-prompt" className="sr-only">대화 지시</label>
      <textarea
        id="agent-runtime-conversation-prompt"
        value={prompt}
        onChange={event => setPrompt(event.target.value)}
        disabled={mutating || (!creating && selectedConversation?.state !== 'idle'
          && selectedConversation?.state !== 'running')}
        rows={1}
        placeholder={selectedConversation?.state === 'unknown'
          ? '상태 확인 전에는 같은 대화에 새 지시를 보낼 수 없습니다.'
          : selectedConversation?.state === 'archived'
            ? '대화를 복원한 뒤 이어갈 수 있습니다.'
            : selectedConversation?.state === 'running'
              ? '현재 응답에 추가할 지시를 입력하세요.'
              : `${adapterLabel(selectedConversation?.adapterId ?? selectedAdapterId)}에 요청할 내용을 입력하세요.`}
        className="min-h-11 max-h-32 w-full resize-y rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/10 bg-[rgb(var(--surface-shade-rgb))]/25 px-3 py-2 text-sm leading-6 text-zinc-100 outline-none placeholder:text-[var(--text-dim)] focus:border-teal-300/50 focus:ring-2 focus:ring-teal-300/10 disabled:opacity-50"
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <div className="order-2 flex min-w-0 w-full flex-wrap items-center gap-x-3 gap-y-2 sm:order-1 sm:w-0 sm:flex-1">
          <span className={bytes > maxPromptBytes ? 'text-[10px] text-rose-300' : 'text-[10px] text-zinc-500'}>
            {bytes.toLocaleString()} / {maxPromptBytes.toLocaleString()} bytes
          </span>
          {creating && executionAvailable ? (
            <label className="flex min-h-10 items-center gap-2 rounded-lg border border-[rgb(var(--surface-highlight-rgb))]/10 bg-[rgb(var(--surface-shade-rgb))]/15 px-3 text-[11px] text-zinc-300">
              <input
                type="checkbox"
                checked={historyConsent}
                onChange={event => setHistoryConsent(event.target.checked)}
                disabled={!executionAvailable || mutating}
                className="h-4 w-4 accent-teal-400"
              />
              이 Mac의 {adapterLabel(selectedAdapterId)}에 대화 기록 보존
            </label>
          ) : null}
        </div>
        <div className="order-1 flex w-full gap-2 sm:order-2 sm:w-auto">
          {selectedConversation?.state === 'running' ? (
            <button
              type="button"
              onClick={() => void interrupt()}
              disabled={mutating || !executionAvailable}
              className="min-h-11 flex-1 rounded-xl border border-rose-400/25 bg-rose-400/[0.06] px-3 py-2 text-xs font-semibold text-rose-200 disabled:opacity-50 sm:flex-none"
            >
              응답 중단
            </button>
          ) : null}
          <button
            type="submit"
            disabled={!canCreate && !canContinue && !canSteer}
            className="min-h-11 flex-1 rounded-xl bg-teal-400 px-4 py-2 text-xs font-semibold text-[var(--text-on-accent)] hover:bg-teal-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400 sm:flex-none"
          >
            {mutating ? '처리 중…' : creating ? '새 대화 시작' : selectedConversation?.state === 'running' ? '추가 지시' : '이어가기'}
          </button>
        </div>
      </div>
      {!executionAvailable ? (
        <p role="status" className="mt-2 text-[10px] leading-4 text-amber-100">
          읽기 전용 Codex 연결을 확인하는 동안 시작 버튼은 잠깁니다. 작성한 초안은 현재 화면을 전환해도 유지되지만 전송·장기 저장되지 않습니다.
        </p>
      ) : null}
      <details className="mt-2 text-[10px] text-zinc-500" data-testid="conversation-composer-help">
        <summary className="cursor-pointer">대화 권한·기록 안내</summary>
      {executionAvailable ? (
        <p role="status" className="mt-2 text-[10px] leading-4 text-teal-100/70">
          현재 대화는 읽기 전용·도구 없음 모드입니다. Codex는 대화에 답변하지만 파일 탐색·수정과 명령 실행 도구는 사용할 수 없습니다. 파일 수정·명령 실행은 권한이 분리된 작업 탭에서 수행합니다.
        </p>
      ) : null}
      {creating ? (
        <p className="mt-2 text-[10px] leading-4 text-zinc-500">
          기록 보존은 AgentsToZ 장기기억과는 별개입니다. 원문 프롬프트를 런타임 SQLite나 원격 상태 이벤트에 복제하지 않습니다.
        </p>
      ) : null}
      </details>
    </form>
    </details>
  );

  return (
    <div data-testid="agent-runtime-conversation-view" className="runtime-conversation-layout min-w-0">
      {(visibleError || notice) ? (
        <div className="space-y-2 border-b border-[rgb(var(--surface-highlight-rgb))]/[0.07] px-4 py-3 sm:px-6">
          {visibleError ? <p role="alert" className="rounded-xl border border-rose-400/20 bg-rose-400/[0.07] px-3 py-2 text-xs text-rose-200">{visibleError}</p> : null}
          {notice ? <p role="status" className="rounded-xl border border-teal-400/20 bg-teal-400/[0.06] px-3 py-2 text-xs text-teal-100">{notice}</p> : null}
        </div>
      ) : null}

      <div className="runtime-conversation-grid grid min-w-0">
        <aside
          ref={conversationListRef}
          className="runtime-conversation-list order-2 min-w-0 border-b border-[rgb(var(--surface-highlight-rgb))]/[0.07] p-4 sm:p-5"
          aria-label="대화 목록"
        >
          <button
            type="button"
            onClick={startNew}
            className={`${creating ? 'runtime-conversation-wide-only hidden' : 'block'} min-h-11 w-full rounded-xl bg-teal-400 px-3 py-2 text-sm font-semibold text-[var(--text-on-accent)] transition hover:bg-teal-300 focus:outline-none focus:ring-2 focus:ring-teal-200`}
          >
            새 대화
          </button>
          <div className="mt-4 flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-zinc-200">{archivedOnly ? '보관한 대화' : '최근 대화'}</h3>
            <button
              type="button"
              onClick={() => {
                setArchivedOnly(current => !current);
                setSelectedConversationId(null);
                setCreating(false);
              }}
              className="min-h-9 rounded-lg border border-[rgb(var(--surface-highlight-rgb))]/10 px-2.5 py-1 text-[11px] text-zinc-400 hover:bg-[rgb(var(--surface-highlight-rgb))]/[0.04]"
            >
              {archivedOnly ? '최근 보기' : '보관함'}
            </button>
          </div>
          <label className="mt-3 block">
            <span className="sr-only">대화 검색</span>
            <input
              type="search"
              value={conversationQuery}
              onChange={event => setConversationQuery(event.target.value)}
              placeholder="프로젝트·AI·모델·상태 검색"
              className="min-h-10 w-full rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/10 bg-[rgb(var(--surface-shade-rgb))]/20 px-3 text-xs text-zinc-200 outline-none placeholder:text-[var(--text-dim)] focus:border-teal-300/40"
            />
          </label>
          {conversations.length === 0 ? (
            <p className="mt-3 rounded-xl border border-dashed border-[rgb(var(--surface-highlight-rgb))]/10 px-3 py-6 text-center text-xs leading-5 text-zinc-500">
              {listLoading ? '대화를 불러오는 중입니다.' : archivedOnly ? '보관한 대화가 없습니다.' : '아직 대화가 없습니다.'}
            </p>
          ) : visibleConversations.length === 0 ? (
            <p className="mt-3 rounded-xl border border-dashed border-[rgb(var(--surface-highlight-rgb))]/10 px-3 py-6 text-center text-xs leading-5 text-zinc-500">
              검색과 일치하는 대화가 없습니다.
            </p>
          ) : (
            <ul className="mt-3 max-h-[38rem] space-y-2 overflow-y-auto pr-1">
              {visibleConversations.map(conversation => (
                <li key={conversation.conversationId}>
                  <button
                    type="button"
                    onClick={() => selectConversation(conversation.conversationId)}
                    aria-pressed={!creating && selectedConversationId === conversation.conversationId}
                    className={`min-h-16 w-full rounded-xl border p-3 text-left transition focus:outline-none focus:ring-2 focus:ring-teal-300/30 ${!creating && selectedConversationId === conversation.conversationId
                      ? 'border-teal-300/35 bg-teal-300/[0.08]'
                      : 'border-[rgb(var(--surface-highlight-rgb))]/[0.07] bg-[rgb(var(--surface-shade-rgb))]/15 hover:border-[rgb(var(--surface-highlight-rgb))]/15'}`}
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium text-zinc-200">{conversation.projectLabel}</span>
                        <span className="mt-1 block truncate text-[10px] text-zinc-500">
                          {adapterLabel(conversation.adapterId)} · {conversation.modelId} · {formatConversationTime(conversation.updatedAt)}
                        </span>
                      </span>
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[9px] ${STATE_STYLES[conversation.state]}`}>
                        {STATE_LABELS[conversation.state]}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <main
          ref={conversationMainRef}
          className="runtime-conversation-main order-1 flex min-h-[34rem] min-w-0 flex-col border-b border-[rgb(var(--surface-highlight-rgb))]/[0.07]"
        >
          <div className="border-b border-[rgb(var(--surface-highlight-rgb))]/[0.07] px-4 py-2 sm:px-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-zinc-100">
                  {creating ? '프로젝트 대화 시작' : selectedConversation?.projectLabel ?? '대화를 선택하세요'}
                </h3>
                <p className="mt-1 hidden text-[11px] text-zinc-500 sm:block">
                  {creating
                    ? `새 ${adapterLabel(selectedAdapterId)} 대화 · 프로젝트와 워크트리 맥락을 고정한 지속형 세션`
                    : selectedConversation
                      ? `${adapterLabel(selectedConversation.adapterId)} · ${selectedConversation.modelId}`
                      : '최근 대화에서 이어갈 세션을 선택할 수 있습니다.'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => conversationListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                  className="min-h-10 rounded-lg border border-[rgb(var(--surface-highlight-rgb))]/10 px-3 py-2 text-[11px] text-zinc-300 hover:bg-[rgb(var(--surface-highlight-rgb))]/[0.04] runtime-conversation-compact-only"
                >
                  대화 목록
                </button>
                {selectedConversation ? (
                  <>
                  <span className={`rounded-full border px-2.5 py-1 text-[10px] ${STATE_STYLES[selectedConversation.state]}`}>
                    {STATE_LABELS[selectedConversation.state]}
                  </span>
                  <button
                    type="button"
                    onClick={startNew}
                    className="min-h-10 rounded-lg border border-[rgb(var(--surface-highlight-rgb))]/10 px-3 py-2 text-[11px] text-zinc-300 hover:bg-[rgb(var(--surface-highlight-rgb))]/[0.04] runtime-conversation-compact-only"
                  >
                    새 대화
                  </button>
                  </>
                ) : null}
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 sm:px-6" aria-live="polite">
            {creating ? (
              <div className="mx-auto max-w-3xl space-y-3 rounded-2xl border border-[rgb(var(--surface-highlight-rgb))]/[0.08] bg-[rgb(var(--surface-highlight-rgb))]/[0.025] p-4 sm:p-5">
                <details className="rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/[0.08] bg-[rgb(var(--surface-shade-rgb))]/15 px-3 py-2">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-left marker:hidden">
                    <span className="min-w-0">
                      <span className="block text-xs font-semibold text-zinc-200">대화 설정</span>
                      <span className="mt-0.5 block truncate text-[10px] text-zinc-500">
                        {selectedTarget?.label ?? '프로젝트 미선택'} · {adapterLabel(selectedAdapterId)} · {
                          selectedCapability?.models.find(model => model.modelId === selectedModelId)?.label
                            ?? (codexAdapterVerified ? '읽기 전용 모델 확인 중' : '모델 미선택')
                        }
                      </span>
                    </span>
                    <span className="shrink-0 text-[11px] font-medium text-teal-200">변경</span>
                  </summary>
                  <div
                    className="mt-3 grid gap-3 border-t border-[rgb(var(--surface-highlight-rgb))]/[0.07] pt-3 sm:grid-cols-2"
                    aria-label="공통 대화 화면을 사용하되 실행·모델·고유 기능은 각 adapter가 검증된 뒤 열립니다."
                  >
                  <label className="block text-xs font-medium text-zinc-300 sm:col-span-2">
                    프로젝트·워크트리
                    <select
                      value={selectedTargetId}
                      onChange={event => setSelectedTargetId(event.target.value)}
                      disabled={mutating || targets.length === 0}
                      className="mt-1.5 min-h-11 w-full rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/10 bg-[rgb(var(--surface-shade-rgb))]/25 px-3 text-sm text-zinc-100 disabled:opacity-50"
                    >
                      {targets.length === 0 ? <option value="">등록된 프로젝트 없음</option> : null}
                      {targets.map(target => (
                        <option key={target.targetId} value={target.targetId} disabled={target.locked}>
                          {target.label} · {target.scope === 'worktree' ? 'Git 워크트리' : '기본'}
                          {target.branch ? ` · ${target.branch}` : ''}{target.locked ? ' · 잠김' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-xs font-medium text-zinc-300">
                    AI 실행기
                    <select
                      value={selectedAdapterId}
                      onChange={event => setSelectedAdapterId(event.target.value as BuiltinAgentRuntimeId)}
                      disabled={mutating}
                      className="mt-1.5 min-h-11 w-full rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/10 bg-[rgb(var(--surface-shade-rgb))]/25 px-3 text-sm text-zinc-100 disabled:opacity-50"
                    >
                      {(capabilities?.adapters ?? []).map(adapter => (
                        <option
                          key={adapter.adapterId}
                          value={adapter.adapterId}
                          disabled={adapter.availability !== 'available'}
                        >
                          {adapter.label}{adapter.availability === 'available'
                            ? ''
                            : adapter.adapterId === 'codex' && codexAdapterVerified
                              ? ' · CLI 확인 · 읽기 전용 연결 중'
                              : ' · 현재 사용 불가'}
                        </option>
                      ))}
                      {!capabilities?.adapters.length ? <option value="codex">Codex · 상태 확인 중</option> : null}
                    </select>
                  </label>
                  <label className="block text-xs font-medium text-zinc-300">
                    모델
                    <select
                      value={selectedModelId}
                      onChange={event => setSelectedModelId(event.target.value)}
                      disabled={mutating || selectedCapability?.availability !== 'available'}
                      className="mt-1.5 min-h-11 w-full rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/10 bg-[rgb(var(--surface-shade-rgb))]/25 px-3 text-sm text-zinc-100 disabled:opacity-50"
                    >
                      {!selectedModelId ? (
                        <option value="">
                          {selectedAdapterId === 'codex' && codexAdapterVerified
                            ? '읽기 전용 모델 연결 확인 중'
                            : `실행 가능한 ${adapterLabel(selectedAdapterId)} 모델 없음`}
                        </option>
                      ) : null}
                      {selectedCapability?.models.map(model => (
                        <option key={model.modelId} value={model.modelId}>{model.label}{model.isDefault ? ' · 기본' : ''}</option>
                      ))}
                    </select>
                  </label>
                  </div>
                </details>
                {renderComposer(true)}
              </div>
            ) : !selectedConversation ? (
              <div className="flex min-h-72 items-center justify-center rounded-2xl border border-dashed border-[rgb(var(--surface-highlight-rgb))]/10 px-5 text-center text-xs leading-5 text-zinc-500">
                최근 대화를 선택하거나 새 대화를 시작하세요.
              </div>
            ) : (
              <>
                {selectedConversation.state === 'unknown' ? (
                  <div
                    data-testid="conversation-unknown-boundary"
                    role="status"
                    className="mx-auto w-full max-w-lg rounded-xl border border-amber-300/25 bg-amber-300/[0.07] px-4 py-3 text-xs leading-5 text-amber-100"
                  >
                    <p className="font-semibold">자동 재실행을 중단했습니다.</p>
                    <p className="mt-1 text-amber-100/75">
                      연결 경계에서 provider 반영 여부를 증명할 수 없습니다. 새 지시·보관·삭제는 잠겨 있으며,
                      이 Mac에서 원래 AI 기록을 확인하기 전 같은 작업을 다시 보내지 않습니다.
                    </p>
                  </div>
                ) : null}
                {pendingQuestion ? (
                  <section
                    data-testid="conversation-question-card"
                    className="mx-auto w-full max-w-xl rounded-2xl border border-amber-300/25 bg-amber-300/[0.07] p-4 text-amber-50"
                    aria-labelledby="conversation-question-title"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-200/70">Codex question</p>
                        <h4 id="conversation-question-title" className="mt-1 text-sm font-semibold">작업을 계속하려면 답변이 필요합니다</h4>
                      </div>
                      <span className="rounded-full border border-amber-200/20 px-2 py-1 text-[10px] text-amber-100">
                        승인 요청 아님
                      </span>
                    </div>
                    <div className="mt-4 space-y-4">
                      {pendingQuestion.questions.map(question => {
                        const selected = questionAnswers[question.questionId];
                        return (
                          <fieldset key={question.questionId} className="rounded-xl border border-amber-100/10 bg-[rgb(var(--surface-shade-rgb))]/15 p-3">
                            <legend className="px-1 text-[11px] font-semibold text-amber-100">{question.header}</legend>
                            <p className="mt-1 text-xs leading-5 text-zinc-200">{question.question}</p>
                            {question.options ? (
                              <div className="mt-3 space-y-2">
                                {question.options.map(option => (
                                  <label key={option.optionId} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-[rgb(var(--surface-highlight-rgb))]/[0.08] bg-[rgb(var(--surface-shade-rgb))]/20 px-3 py-2.5 text-xs text-zinc-200 has-[:checked]:border-amber-300/35 has-[:checked]:bg-amber-300/[0.08]">
                                    <input
                                      type="radio"
                                      name={question.questionId}
                                      checked={selected?.optionId === option.optionId}
                                      onChange={() => setQuestionAnswers(current => ({
                                        ...current,
                                        [question.questionId]: { optionId: option.optionId, text: '' },
                                      }))}
                                      disabled={answeringQuestion}
                                      className="mt-0.5 h-4 w-4 accent-amber-300"
                                    />
                                    <span>
                                      <span className="block font-medium">{option.label}</span>
                                      {option.description ? <span className="mt-0.5 block text-[11px] leading-4 text-zinc-500">{option.description}</span> : null}
                                    </span>
                                  </label>
                                ))}
                              </div>
                            ) : null}
                            {question.allowOther ? (
                              <label className="mt-3 block text-[11px] text-zinc-400">
                                {question.options ? '직접 입력' : '답변'}
                                <textarea
                                  value={selected?.optionId === null ? selected.text : ''}
                                  onChange={event => setQuestionAnswers(current => ({
                                    ...current,
                                    [question.questionId]: { optionId: null, text: event.target.value },
                                  }))}
                                  disabled={answeringQuestion}
                                  rows={2}
                                  className="mt-1.5 min-h-16 w-full resize-y rounded-lg border border-[rgb(var(--surface-highlight-rgb))]/10 bg-[rgb(var(--surface-shade-rgb))]/25 px-3 py-2 text-xs leading-5 text-zinc-100 outline-none focus:border-amber-300/40"
                                />
                              </label>
                            ) : null}
                          </fieldset>
                        );
                      })}
                    </div>
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[10px] leading-4 text-amber-100/60">답변은 현재 Codex 프로세스에만 전달되며 대화 이벤트나 장기기억에 복제하지 않습니다.</p>
                      <button
                        type="button"
                        onClick={() => void answerPendingQuestion()}
                        disabled={!canAnswerQuestion}
                        className="min-h-11 rounded-xl bg-amber-300 px-4 py-2 text-xs font-semibold text-[var(--text-on-accent)] hover:bg-amber-200 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
                      >
                        {answeringQuestion ? '전달 중…' : '답변 전달'}
                      </button>
                    </div>
                  </section>
                ) : null}
                {historyLoading ? <p className="text-center text-xs text-zinc-500">대화 기록을 불러오는 중입니다.</p> : null}
                {history && (history.history.filtered || history.history.truncated) ? (
                  <div
                    data-testid="conversation-history-boundary"
                    className="mx-auto w-full max-w-lg rounded-xl border border-amber-300/15 bg-amber-300/[0.05] px-3 py-2 text-[10px] leading-4 text-amber-100/75"
                  >
                    {history.history.filtered
                      ? '도구 호출·명령·비공개 추론은 제외하고 사용자와 AI의 대화만 표시합니다.'
                      : null}
                    {history.history.filtered && history.history.truncated ? ' ' : null}
                    {history.history.truncated
                      ? '기록 한도 때문에 최근 대화 일부만 표시합니다.'
                      : null}
                  </div>
                ) : null}
                {historyMessages.map(message => (
                  <article
                    key={message.messageId}
                    className={`max-w-[92%] rounded-2xl px-4 py-3 text-sm leading-6 ${message.role === 'user'
                      ? 'ml-auto bg-teal-400 text-[var(--text-on-accent)]'
                      : 'mr-auto border border-[rgb(var(--surface-highlight-rgb))]/[0.08] bg-[rgb(var(--surface-highlight-rgb))]/[0.04] text-zinc-200'}`}
                  >
                    {message.phase === 'commentary' ? <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">진행 설명</p> : null}
                    <p className="whitespace-pre-wrap break-words">{message.text}</p>
                  </article>
                ))}
                {selectedPendingPrompts.map(pendingPrompt => (
                  <article
                    key={pendingPrompt.requestId}
                    className="ml-auto max-w-[92%] rounded-2xl border border-teal-200/40 bg-teal-400 px-4 py-3 text-sm leading-6 text-[var(--text-on-accent)]"
                  >
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-800/65">나 · 전송됨</p>
                    <p className="whitespace-pre-wrap break-words">{pendingPrompt.text}</p>
                  </article>
                ))}
                {events.slice(-8).map(event => event.type === 'conversation.artifact.summary' ? (
                  <article
                    key={event.seq}
                    data-kind={event.payload.kind}
                    className={`mx-auto w-full max-w-lg rounded-xl border px-3 py-2 text-xs text-zinc-300 ${ARTIFACT_STYLES[event.payload.kind]}`}
                  >
                    <p className="text-[10px] font-semibold uppercase tracking-wide">{event.payload.label}</p>
                    <p className="mt-1 leading-5 text-zinc-300">{event.payload.summary}</p>
                  </article>
                ) : (
                  <p key={event.seq} className={`mx-auto max-w-lg rounded-full border px-3 py-1.5 text-center text-[10px] ${event.type === 'conversation.progress'
                    ? 'border-teal-400/15 bg-teal-400/[0.06] text-teal-200'
                    : 'border-[rgb(var(--surface-highlight-rgb))]/[0.08] bg-[rgb(var(--surface-shade-rgb))]/20 text-zinc-500'}`}>
                    {conversationEventText(event)}
                  </p>
                ))}
                {selectedConversation.state !== 'unknown'
                  && historyMessages.length === 0 && selectedPendingPrompts.length === 0 && events.length === 0 ? (
                  <div className="flex min-h-64 items-center justify-center text-center text-xs leading-5 text-zinc-500">
                    {executionAvailable
                      ? '이 대화의 구조화된 기록을 불러오고 있습니다.'
                      : `대화 메타데이터는 보존되어 있습니다. 읽기 전용 ${adapterLabel(selectedConversation?.adapterId ?? selectedAdapterId)} 연결이 복구되면 기록을 다시 읽습니다.`}
                  </div>
                ) : null}
              </>
            )}
          </div>

          {!creating && selectedConversation ? renderComposer(false) : null}
        </main>

        <aside className="order-3 min-w-0 space-y-4 p-4 sm:p-5" aria-label="대화 컨텍스트">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-teal-300">Session context</p>
            <h3 className="mt-1 text-sm font-semibold text-zinc-100">프로젝트 맥락</h3>
          </div>
          {selectedTarget ? (
            <div className="rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/[0.08] bg-[rgb(var(--surface-highlight-rgb))]/[0.025] p-3">
              <p className="truncate text-xs font-medium text-zinc-200">{selectedTarget.label}</p>
              <p className="mt-1 text-[11px] leading-5 text-zinc-500">
                {selectedTarget.scope === 'worktree' ? 'Git 워크트리' : '기본 프로젝트'}
                {selectedTarget.branch ? ` · ${selectedTarget.branch}` : ''}
              </p>
              {onManageProject ? (
                <button
                  type="button"
                  onClick={() => onManageProject(selectedTarget.projectTargetId)}
                  className="mt-3 min-h-10 w-full rounded-lg border border-teal-300/20 bg-teal-300/[0.05] px-3 py-2 text-xs text-teal-100"
                >
                  {selectedTarget.scope === 'worktree'
                    ? '이 워크트리·외부 CLI 관리'
                    : '프로젝트·워크트리·외부 CLI 관리'}
                </button>
              ) : null}
            </div>
          ) : (
            <p className="rounded-xl border border-dashed border-[rgb(var(--surface-highlight-rgb))]/10 px-3 py-5 text-center text-xs text-zinc-500">프로젝트를 선택하세요.</p>
          )}
          {selectedConversation && !creating ? (
            <div className="rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/[0.08] bg-[rgb(var(--surface-shade-rgb))]/20 p-3 text-[11px] leading-5 text-zinc-500">
              <p>업데이트 {formatConversationTime(selectedConversation.updatedAt)}</p>
              <p>대화 리비전 {selectedConversation.revision}</p>
              <p>원격에는 의미 상태와 공개 ID만 전달합니다.</p>
              {(selectedConversation.state === 'idle' || selectedConversation.state === 'archived') ? (
                <button
                  type="button"
                  onClick={() => void toggleArchive()}
                  disabled={mutating || !executionAvailable}
                  className="mt-3 min-h-10 w-full rounded-lg border border-[rgb(var(--surface-highlight-rgb))]/10 px-3 py-2 text-xs text-zinc-300 disabled:opacity-50"
                >
                  {selectedConversation.state === 'archived' ? '대화 복원' : '대화 보관'}
                </button>
              ) : null}
              {selectedConversation.state === 'archived' ? (
                <button
                  type="button"
                  onClick={() => void permanentlyDelete()}
                  disabled={mutating || !executionAvailable}
                  className="mt-2 min-h-10 w-full rounded-lg border border-rose-400/20 bg-rose-400/[0.04] px-3 py-2 text-xs text-rose-200 disabled:opacity-50"
                >
                  영구 삭제…
                </button>
              ) : null}
            </div>
          ) : null}
          <div
            data-testid="conversation-surface-boundary"
            className="rounded-xl border border-teal-400/15 bg-teal-400/[0.035] p-3 text-[11px] leading-5"
          >
            <p className="font-semibold text-teal-100">대화 표면</p>
            <div className="mt-2 space-y-2">
              <div className="rounded-lg border border-teal-300/15 bg-teal-300/[0.05] px-2.5 py-2">
                <p className="font-medium text-teal-100">AgentsToZ 앱 대화 · 기본</p>
                <p className="text-zinc-500">지속 세션, 워크트리, 모바일 상태의 정본입니다.</p>
              </div>
              <div className="rounded-lg border border-[rgb(var(--surface-highlight-rgb))]/[0.07] bg-[rgb(var(--surface-shade-rgb))]/20 px-2.5 py-2">
                <p className="font-medium text-zinc-300">cmux · Orca · iTerm · Terminal · 보조</p>
                <p className="text-zinc-500">현재는 독립 CLI 실행입니다. 같은 대화 넘겨받기는 세션 소유권 검증 후 별도로 제공합니다.</p>
              </div>
            </div>
          </div>
          <div className="rounded-xl border border-violet-400/15 bg-violet-400/[0.04] p-3 text-[11px] leading-5 text-violet-100/70">
            <p className="font-semibold text-violet-100">장기기억 연결 원칙</p>
            <p className="mt-1">대화 원문 전체를 장기기억으로 자동 저장하지 않습니다. 세션 종료 시 검토된 결정·맥락만 별도 기억 흐름으로 연결합니다.</p>
            {onOpenMemory ? (
              <button
                type="button"
                onClick={onOpenMemory}
                className="mt-3 min-h-10 w-full rounded-lg border border-violet-300/20 bg-violet-300/[0.05] px-3 py-2 text-xs font-medium text-violet-100"
              >
                장기기억 관리 열기
              </button>
            ) : null}
          </div>
          <div className="rounded-xl border border-sky-400/15 bg-sky-400/[0.035] p-3 text-[11px] leading-5 text-sky-100/70">
            <p className="font-semibold text-sky-100">내가 한 말 연결 원칙</p>
            <p className="mt-1">발화 원장을 대화에 자동 주입하지 않습니다. 향후 선택한 항목만 출처·권한·폐기 범위를 확인해 명시적으로 첨부합니다.</p>
            {onOpenWhatISaid ? (
              <button
                type="button"
                onClick={onOpenWhatISaid}
                className="mt-3 min-h-10 w-full rounded-lg border border-sky-300/20 bg-sky-300/[0.05] px-3 py-2 text-xs font-medium text-sky-100"
              >
                내가 한 말 원장 열기
              </button>
            ) : null}
          </div>
          <p className="text-[10px] leading-4 text-zinc-600">
            터미널형 실행기 선택은 외부 CLI 열기와 장애 복구를 위한 보조 수단으로 유지합니다. 이 화면의 정본은 구조화된 대화 상태입니다.
          </p>
        </aside>
      </div>
    </div>
  );
}

export default AgentRuntimeConversationView;
