import { describe, expect, test } from 'bun:test';

const portal = await Bun.file(new URL('../src/remote-control-portal-main.tsx', import.meta.url)).text();
const css = await Bun.file(new URL('../src/remote-control-portal.css', import.meta.url)).text();

describe('mobile E2EE persistent Codex conversation console', () => {
  test('exposes the app-like lifecycle over the dedicated conversation envelope', () => {
    expect(portal).toContain('data-testid="remote-codex-conversation-console"');
    expect(portal).toContain('<span><strong>저장된 Codex 대화</strong><small>대화 기록 읽기</small></span>');
    expect(portal).toContain('이 화면은 Codex와 대화하는 단일 원격 진입점입니다.');
    expect(portal).toContain('프로젝트 장기기억에는 대화 원문 전체를 복사하지 않으며');
    expect(portal).toContain('별도로 켠 What I Said 수집 정책은 그대로 적용됩니다.');
    expect(portal).toContain('50·75·90% 도달·턴 완료·등록 프로젝트 변경 조건을 모두 충족하면');
    expect(portal).toContain('검증된 결정·결과 요약만 장기기억에 저장합니다.');
    expect(portal).not.toContain('<strong>에이전트 대화</strong>');
    expect(portal).toContain('remoteConversationAdapterLabel(conversation.adapterId)');
    expect(portal).toContain('remoteConversationAdapterLabel(selectedConversation.adapterId)');
    expect(portal).toContain("case 'conversation.turn.started': return '에이전트가 응답을 시작했습니다.'");
    expect(portal).toContain("controller.sendConversation('capabilities', {})");
    expect(portal).toContain("controller.sendConversation('models.list'");
    expect(portal).toContain("controller.sendConversation('conversations.list'");
    expect(portal).toContain("controller.sendConversation('conversations.events'");
    expect(portal).toContain("controller.sendConversation('conversations.history'");
    expect(portal).toContain("controller.sendConversation('conversations.start'");
    expect(portal).toContain("controller.sendConversation('conversations.continue'");
    expect(portal).toContain("controller.sendConversation('conversations.steer'");
    expect(portal).toContain("controller.sendConversation('conversations.interrupt'");
    expect(portal).toContain("controller.sendConversation('conversations.archive'");
    expect(portal).toContain("controller.sendConversation('conversations.unarchive'");
    expect(portal).toContain("remoteFeatureBlocker(\n          conversationError,\n          'REMOTE_CONTROL_CONVERSATION_SCOPE_REQUIRED'");
    expect(portal).toContain("conversationPanel.blocker === 'host-update'");
    expect(portal).toContain('업데이트 후 이 기기의 대화 권한만 켜면 됩니다.');
    expect(portal).toContain('remoteConversationIntentFingerprint(');
    expect(portal).toContain('requestIdForRemoteConversationIntent(fingerprint)');
    expect(portal).toContain('recoverAgentRuntimePendingRequestId(window.localStorage, digest)');
    expect(portal).toContain('persistAgentRuntimePendingRequest(window.localStorage, digest, requestId)');
    expect(portal).toContain('clearRemoteConversationIntent(fingerprint, requestId)');
    expect(portal).not.toContain("requestId: crypto.randomUUID(),\n      });\n      if (!response.ok)");
    expect(portal).toContain('showRemoteConversationArchive(true)');
    expect(portal).toContain('response.result.catalogId !== catalogId');
    expect(portal).toContain('remoteConversationEventText(event)');
    expect(portal).toContain('eventCursor: after');
    expect(portal).toContain('pendingPrompts: Array<');
    expect(portal).toContain('나 · 전송됨');
    expect(portal).toContain('selectedPendingPrompts.length === 0');
    expect(portal).toContain('historyTruncated: boolean');
    expect(portal).toContain('historyFiltered: boolean');
    expect(portal).toContain('query: string');
    expect(portal).toContain('visibleRemoteConversations.map');
    expect(portal).toContain('프로젝트·AI·모델·상태 검색');
    expect(portal).toContain('검색과 일치하는 대화가 없습니다.');
    expect(portal).toContain('remoteConversationSidebarRef.current?.scrollIntoView');
    expect(portal).toContain("window.matchMedia('(max-width: 619px)').matches");
    expect(portal).toContain('remoteConversationMainRef.current?.scrollIntoView');
    expect(portal).toContain('historyTruncated ||= response.result.truncated');
    expect(portal).toContain('historyFiltered ||= response.result.filtered');
    expect(portal).toContain('sameConversation ? previous?.historyTruncated ?? false : false');
    expect(portal).toContain('sameConversation ? previous?.historyFiltered ?? false : false');
    expect(portal).toContain('data-testid="remote-conversation-history-boundary"');
    expect(portal).toContain('data-testid="remote-conversation-unknown-boundary"');
    expect(portal).toContain('자동 재실행을 중단했습니다.');
    expect(portal).toContain('syncError: string');
    expect(portal).toContain('conversationPanel.error || conversationPanel.syncError');
    expect(portal).toContain('busy: true, syncError:');
    expect(portal).not.toContain('busy: true, error: \'\' }));\n    try {\n      const conversations:');
    expect(portal.match(/busy: true, error: mutationError/g)?.length).toBe(4);
    expect(portal).toContain('Keep the composer locked until the host projects its fresh');
    expect(portal.match(/await refreshRemoteConversationList\(/g)?.length)
      .toBeGreaterThanOrEqual(4);
    expect(css).toContain('.remote-conversation-event--artifact');
    expect(css).toContain('.remote-conversation-history-boundary');
    expect(css).toContain('.remote-conversation-unknown-boundary');
    expect(css).toContain('.remote-conversation-message--pending');
    expect(css).toContain('.remote-conversation-search input');
    expect(css).toContain('.remote-conversation-list-jump { display: flex; min-height: 44px;');
  });

  test('makes retention and authority boundaries explicit instead of presenting a raw terminal', () => {
    expect(portal).toContain('프로젝트 파일을 바꾸는 작업 모드는 안전 격리 완료 전까지 제공하지 않습니다.');
    expect(portal).toContain('프로젝트 장기기억에는 대화 원문 전체를 복사하지 않으며');
    expect(portal).toContain('Mac에서 자동 체크포인트를 켜고');
    expect(portal).toContain('historyRetentionConsent: AGENT_RUNTIME_CONVERSATION_HISTORY_CONSENT');
    expect(portal).not.toContain('dangerously-bypass-approvals-and-sandbox');
    expect(portal).not.toContain('<iframe');
    expect(portal).not.toContain("localStorage.setItem('pendingPrompts'");
  });

  test('does not mislabel a closed installed-runtime gate as a mobile permission problem', () => {
    expect(portal).toContain("type RemoteFeatureBlocker = 'scope' | 'runtime' | 'host-update' | 'unknown' | null");
    expect(portal).toContain("if (token.includes(scopeCode)) return 'scope'");
    expect(portal).toContain("blocker: 'runtime'");
    expect(portal).toContain('권한 문제는 아닙니다. 이 Mac 설치본의 Codex 런타임과 안전성 게이트');
  });

  test('probes host capabilities before enabling conversation controls and explains legacy hosts', () => {
    expect(portal).toContain('await hostController.probeSupportedFeatures()');
    expect(portal).toContain('await controller.probeSupportedFeatures(true)');
    expect(portal).toContain('status.supportedFeatures === null');
    expect(portal).toContain('data-testid="remote-conversation-capability-pending"');
    expect(portal).toContain('data-testid="remote-conversation-host-update-required"');
    expect(portal).toContain('아래 기본 프로젝트 제어는 계속 사용할 수 있습니다.');
    expect(portal).toContain('if (!status.supportedFeatures?.includes(REMOTE_CONTROL_CONVERSATION_SCOPE)) return;');
  });

  test('keeps UI state isolated per host and puts the conversation itself first on phones', () => {
    expect(portal).toContain('conversationPanelsByHostRef.current.set(hostId, next)');
    expect(portal).toContain('conversationPanelsByHostRef.current.delete(hostId)');
    expect(portal.match(/if \(selectedHostIdRef\.current === hostId\) \{/g)?.length)
      .toBeGreaterThanOrEqual(3);
    expect(css).toContain('.remote-conversation-main { order: -1; }');
    expect(css).toContain('max-height: 46dvh');
  });
});
