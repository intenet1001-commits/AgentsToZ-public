import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentRuntimeClient } from '../src/agentRuntimeClient';
import type { AgentRuntimeCapabilitiesResponse } from '../src/agentRuntimeApiContract';
import {
  AgentRuntimeConversationView,
  conversationEventText,
  conversationIntentFingerprint,
  conversationStateFromEvent,
} from '../src/AgentRuntimeConversationView';
import { AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION } from '../src/agentRuntimeConversationProtocol';
import { AGENT_RUNTIME_PROTOCOL_VERSION } from '../src/agentRuntimeProtocol';

const source = readFileSync(
  new URL('../src/AgentRuntimeConversationView.tsx', import.meta.url),
  'utf8',
);

const client = new AgentRuntimeClient({
  tauri: false,
  development: true,
  fetchImpl: async () => new Response('{}'),
});

const capabilities: AgentRuntimeCapabilitiesResponse = {
  protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
  adapters: [{
    adapterId: 'codex',
    label: 'Codex',
    availability: 'unavailable',
    models: [],
    features: {
      structuredProgress: true,
      questions: false,
      approvals: false,
      cancellation: true,
    },
  }],
  limits: { maxPromptBytes: 65_536, maxConcurrentTasks: 1 },
};

describe('AgentRuntimeConversationView', () => {
  test('renders an app-native conversation shell with explicit memory and terminal boundaries', () => {
    const markup = renderToStaticMarkup(
      <AgentRuntimeConversationView
        visible
        client={client}
        capabilities={capabilities}
        codexAdapterVerified
        targets={[{
          targetId: 'target_12345678',
          projectTargetId: 'target_12345678',
          label: 'AgentsToZ',
          scope: 'main',
          branch: 'main',
          locked: false,
          worktreeCapable: true,
        }]}
        onManageProject={() => undefined}
        onOpenMemory={() => undefined}
        onOpenWhatISaid={() => undefined}
      />,
    );
    expect(markup).toContain('data-testid="agent-runtime-conversation-view"');
    expect(markup).toContain('새 대화');
    expect(markup).toContain('프로젝트·AI·모델·상태 검색');
    expect(markup).toContain('대화 목록');
    expect(source).toContain("scrollIntoView({ behavior: 'smooth', block: 'start' })");
    // Responsive placement and selection scrolling are exercised by the browser smoke test.
    expect(source).toContain('conversationMainRef.current?.scrollIntoView');
    expect(source).toContain('visibleConversations.map');
    expect(source).toContain('검색과 일치하는 대화가 없습니다.');
    expect(markup).toContain('프로젝트 대화 시작');
    expect(markup).toContain('data-testid="conversation-create-composer"');
    expect(markup).toContain('<details open="" data-testid="conversation-composer-disclosure"');
    expect(markup).toContain('메시지 입력 · 읽기 전용');
    expect(markup).toContain('rows="1"');
    expect(markup).toContain('min-h-11 max-h-32');
    expect(markup).toContain('data-testid="conversation-composer-help"');
    expect(markup).not.toContain('data-testid="conversation-turn-composer"');
    expect(source).toContain("max-w-3xl space-y-3");
    expect(source).toContain("sm:grid-cols-2");
    expect(markup).toContain('작성한 초안은 현재 화면을 전환해도 유지되지만 전송·장기 저장되지 않습니다');
    expect(markup).toContain('AI 실행기');
    expect(markup).toContain('Codex · CLI 확인 · 읽기 전용 연결 중');
    expect(markup).toContain('읽기 전용 모델 연결 확인 중');
    expect(markup).toContain('공통 대화 화면을 사용하되 실행·모델·고유 기능은 각 adapter가 검증된 뒤 열립니다');
    expect(source).toContain('이 Mac의 {adapterLabel(selectedAdapterId)}에 대화 기록 보존');
    expect(markup).toContain('AgentsToZ 장기기억과는 별개입니다');
    expect(markup).toContain('원문 프롬프트를 런타임 SQLite나 원격 상태 이벤트에 복제하지 않습니다');
    expect(source).toContain('나 · 전송됨');
    expect(source).toContain('selectedPendingPrompts.map');
    expect(source).toContain('const permanentlyDelete = async () =>');
    expect(source).toContain('confirmPermanentDeletion: true');
    expect(source).toContain('이 Mac의 ${adapterLabel(selectedConversation.adapterId)} 대화 기록도 함께 삭제');
    expect(source).toContain('영구 삭제…');
    expect(source).toContain('data-testid="conversation-history-boundary"');
    expect(source).toContain('data-testid="conversation-unknown-boundary"');
    expect(source).toContain('data-testid="conversation-question-card"');
    expect(source).toContain('승인 요청 아님');
    expect(source).toContain('답변은 현재 Codex 프로세스에만 전달되며');
    expect(source).toContain('client.answerConversationQuestion({');
    expect(source).toContain('자동 재실행을 중단했습니다.');
    expect(source).toContain("selectedConversation?.state !== 'idle'");
    expect(source).toContain("selectedConversation?.state !== 'running'");
    expect(source).toContain('상태 확인 전에는 같은 대화에 새 지시를 보낼 수 없습니다.');
    expect(source).toContain('htmlFor="agent-runtime-conversation-prompt"');
    expect(source).toContain('id="agent-runtime-conversation-prompt"');
    expect(source).toContain('>대화 지시</label>');
    expect(source).toContain('data-kind={event.payload.kind}');
    expect(source).toContain('ARTIFACT_STYLES[event.payload.kind]');
    expect(source).toContain('도구 호출·명령·비공개 추론은 제외하고');
    expect(source).toContain('기록 한도 때문에 최근 대화 일부만 표시합니다');
    expect(source).toContain('adapterId: selectedAdapterId');
    expect(source).toContain('adapterLabel(conversation.adapterId)');
    expect(source).toContain('adapterLabel(selectedConversation?.adapterId ?? selectedAdapterId)');
    expect(source).toContain("conversation.state === 'running'");
    expect(source).toContain('onActiveCountChange?.(0)');
    expect(source).toContain('}].slice(-8)');
    expect(markup).toContain('터미널형 실행기 선택은 외부 CLI 열기와 장애 복구를 위한 보조 수단');
    expect(markup).toContain('data-testid="conversation-surface-boundary"');
    expect(markup).toContain('AgentsToZ 앱 대화 · 기본');
    expect(markup).toContain('cmux · Orca · iTerm · Terminal · 보조');
    expect(markup).toContain('현재는 독립 CLI 실행입니다');
    expect(markup).toContain('같은 대화 넘겨받기는 세션 소유권 검증 후 별도로 제공합니다');
    expect(markup).toContain('프로젝트·워크트리·외부 CLI 관리');
    expect(markup).toContain('장기기억 관리 열기');
    expect(markup).toContain('내가 한 말 연결 원칙');
    expect(markup).toContain('발화 원장을 대화에 자동 주입하지 않습니다');
    expect(markup).toContain('내가 한 말 원장 열기');
    expect(markup.match(/<button type="submit"[^>]*>/)?.[0] ?? '').toContain('disabled=""');
    for (const forbidden of ['folderPath', 'worktreePath', 'providerThreadId', 'providerTurnId', 'stdout', 'stderr']) {
      expect(markup).not.toContain(forbidden);
    }
  });

  test('advertises a verified conversation as tool-free read-only execution', () => {
    const available: AgentRuntimeCapabilitiesResponse = {
      ...capabilities,
      adapters: [{
        ...capabilities.adapters[0]!,
        label: 'Codex · 읽기 전용',
        availability: 'available',
        models: [{ modelId: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', isDefault: true }],
        features: {
          structuredProgress: true,
          questions: true,
          approvals: false,
          cancellation: true,
        },
      }],
    };
    const markup = renderToStaticMarkup(
      <AgentRuntimeConversationView
        visible
        client={client}
        capabilities={available}
        codexAdapterVerified
        targets={[{
          targetId: 'target_12345678',
          projectTargetId: 'target_12345678',
          label: 'AgentsToZ',
          scope: 'main',
          branch: 'main',
          locked: false,
          worktreeCapable: true,
        }]}
      />,
    );
    expect(markup).toContain('Codex · 읽기 전용');
    expect(markup).toContain('현재 대화는 읽기 전용·도구 없음 모드입니다.');
    expect(markup).toContain('파일 탐색·수정과 명령 실행 도구는 사용할 수 없습니다.');
    expect(markup).not.toContain('읽기 전용 Codex 연결을 확인하는 동안');
  });

  test('uses distinct prompt-free durable receipt fingerprints for conversation actions', () => {
    const create = conversationIntentFingerprint(
      'create', 'target_12345678', 1, 'codex', 'gpt-5.6-sol', '검토해줘.',
    );
    expect(conversationIntentFingerprint(
      'create', 'target_12345678', 1, 'codex', 'gpt-5.6-sol', '검토해줘.',
    )).toBe(create);
    expect(conversationIntentFingerprint(
      'continue', 'target_12345678', 1, 'codex', 'gpt-5.6-sol', '검토해줘.',
    )).not.toBe(create);
    expect(conversationIntentFingerprint(
      'steer', 'target_12345678', 2, 'codex', 'gpt-5.6-sol', '검토해줘.',
    )).not.toBe(create);
    expect(conversationIntentFingerprint(
      'archive', 'conversation_12345678', 4, 'codex', 'gpt-5.6-sol', '',
    )).not.toBe(conversationIntentFingerprint(
      'unarchive', 'conversation_12345678', 4, 'codex', 'gpt-5.6-sol', '',
    ));
    expect(conversationIntentFingerprint(
      'delete', 'conversation_12345678', 4, 'codex', 'gpt-5.6-sol', '',
    )).not.toBe(create);
    expect(conversationIntentFingerprint(
      'create', 'target_12345678', 1, 'claude', 'gpt-5.6-sol', '검토해줘.',
    )).not.toBe(create);
    expect(source).toContain('digestAgentRuntimeStartIntent(fingerprint)');
    expect(source).toContain('recoverAgentRuntimePendingRequestId(storage, intentDigest)');
    expect(source).toContain('clearAgentRuntimePendingRequest(storage, requestId)');
    expect(source).toContain('const { requestId, storage } = await requestIdForIntent(fingerprint)');
    expect(source).not.toContain("requestId: createAgentRuntimeRequestId(),\n        conversationId: selectedConversation.conversationId");
  });

  test('projects only semantic event types into public conversation states', () => {
    const base = {
      protocolVersion: AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION,
      conversationId: 'conversation_12345678',
      seq: 1,
      revision: 2,
      turnId: 'turn_12345678',
      createdAt: '2026-09-05T00:00:00.000Z',
    } as const;
    expect(conversationStateFromEvent({ ...base, type: 'conversation.turn.started' })).toBe('running');
    expect(conversationStateFromEvent({ ...base, type: 'conversation.turn.completed' })).toBe('idle');
    expect(conversationStateFromEvent({ ...base, type: 'conversation.turn.interrupted' })).toBe('idle');
    expect(conversationStateFromEvent({ ...base, type: 'conversation.turn.unknown' })).toBe('unknown');
    const progress = {
      ...base,
      type: 'conversation.progress' as const,
      payload: { summary: '계획을 갱신했습니다.', phase: 'planning' },
    };
    expect(conversationStateFromEvent(progress)).toBeNull();
    expect(conversationEventText(progress)).toBe('계획을 갱신했습니다.');
    expect(source).toContain('lifecycle.revision >= latestSummary.revision');
  });

  test('resets list and event navigation when returning from another conversation or the archive', () => {
    expect(source).toContain('eventCursorRef.current.delete(selectedConversationId)');
    expect(source).toContain('const startNew = () => {\n    setArchivedOnly(false);');
  });

  test('does not let a stale history request clear the next conversation loading state', () => {
    expect(source).toContain('let stopped = false;\n    setHistoryLoading(true);');
    expect(source).toContain('if (!stopped) setHistoryLoading(false);');
    expect(source).toContain('stopped = true;\n      controller.abort();');
  });

  test('does not let background polling overwrite or cross-clear a provider-boundary action error', () => {
    expect(source).toContain("const [listSyncError, setListSyncError] = useState('');");
    expect(source).toContain("const [historySyncError, setHistorySyncError] = useState('');");
    expect(source).toContain("const [eventSyncError, setEventSyncError] = useState('');");
    expect(source).toContain("const [questionSyncError, setQuestionSyncError] = useState('');");
    expect(source).toContain("setListSyncError('');");
    expect(source).toContain("setHistorySyncError('');");
    expect(source).toContain("setEventSyncError('');");
    expect(source).toContain("setQuestionSyncError('');");
    expect(source).toContain('setListSyncError(readableError(cause))');
    expect(source).toContain('setHistorySyncError(readableError(cause))');
    expect(source).toContain('setEventSyncError(readableError(cause))');
    expect(source).toContain('setQuestionSyncError(readableError(cause))');
    expect(source).toContain('const visibleError = error || questionSyncError || eventSyncError || historySyncError || listSyncError;');
    expect(source).toContain('const reconcileAfterMutationFailure = async (preferredConversationId: string | null) =>');
    expect(source).toContain('This refresh never clears `error`');
    expect(source.match(/await reconcileAfterMutationFailure\(/g)?.length).toBe(4);
    expect(source).not.toContain('setError(readableError(cause));\n      } finally {\n        if (!stopped) timer = setTimeout(');
    expect(source).not.toContain("replaceConversations(response.conversations);\n          setSelectedConversationId(current => (\n            current && response.conversations.some(item => item.conversationId === current)\n              ? current\n              : null\n          ));\n        }\n        setError('');");
  });
});
