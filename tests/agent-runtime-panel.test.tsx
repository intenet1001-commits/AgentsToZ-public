import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentRuntimeAdapterCapability } from '../src/agentRuntimeApiContract';
import {
  AGENT_RUNTIME_DANGEROUS_MODE_ENABLED,
  AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED,
  AGENT_RUNTIME_PROTOCOL_VERSION,
} from '../src/agentRuntimeProtocol';
import {
  AgentRuntimePanel,
  agentRuntimeCancellationNotice,
  agentRuntimeFailureRecovery,
  agentRuntimeStartFingerprint,
  mergeAgentRuntimeTargets,
  reconcileAgentRuntimeModelSelection,
} from '../src/AgentRuntimePanel';

const panelSource = readFileSync(new URL('../src/AgentRuntimePanel.tsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

describe('AgentRuntimePanel initial surface', () => {
  test('opens on conversations and keeps both surfaces mounted so drafts survive tab switches', () => {
    expect(panelSource).toContain("useState<'tasks' | 'conversations'>('conversations')");
    expect(panelSource).toContain("hidden={surfaceMode !== 'tasks'}");
    expect(panelSource).toContain("hidden={surfaceMode !== 'conversations'}");
    expect(panelSource).not.toContain("{surfaceMode === 'tasks' ? (");
  });

  test('keeps task and conversation activity counts semantically separate', () => {
    expect(panelSource).toContain('const [activeConversationCount, setActiveConversationCount] = useState(0)');
    expect(panelSource).toContain('`응답 중 ${activeConversationCount}개`');
    expect(panelSource).toContain('`진행 중 ${activeTaskCount}개`');
    expect(panelSource).toContain('onActiveCountChange={setActiveConversationCount}');
  });
  test('uses a deterministic in-memory fingerprint for start idempotency', () => {
    const first = agentRuntimeStartFingerprint('target_12345678', 'codex', 'gpt-5.6-sol', 'workspace-write', '테스트해줘.');
    expect(agentRuntimeStartFingerprint('target_12345678', 'codex', 'gpt-5.6-sol', 'workspace-write', '테스트해줘.')).toBe(first);
    expect(agentRuntimeStartFingerprint('target_12345678', 'codex', 'gpt-5.6-sol', 'workspace-write', '다시 테스트해줘.')).not.toBe(first);
    expect(agentRuntimeStartFingerprint('target_87654321', 'codex', 'gpt-5.6-sol', 'workspace-write', '테스트해줘.')).not.toBe(first);
    expect(agentRuntimeStartFingerprint('target_12345678', 'codex', 'gpt-5.6-terra', 'workspace-write', '테스트해줘.')).not.toBe(first);
    expect(agentRuntimeStartFingerprint(
      'target_12345678',
      'codex',
      'gpt-5.6-sol',
      'dangerously-bypass-approvals-and-sandbox',
      '테스트해줘.',
    )).not.toBe(first);
  });

  test('selects the live default once, preserves transient state, and requires choice after removal', () => {
    const available: AgentRuntimeAdapterCapability = {
      adapterId: 'codex',
      label: 'Codex',
      availability: 'available',
      models: [
        { modelId: 'gpt-5.6-terra', label: 'Terra', isDefault: false },
        { modelId: 'gpt-5.6-sol', label: 'Sol', isDefault: true },
      ],
      features: { structuredProgress: true, questions: false, approvals: false, cancellation: true },
    };
    const initial = reconcileAgentRuntimeModelSelection(null, 'codex', available);
    expect(initial).toEqual({ adapterId: 'codex', modelId: 'gpt-5.6-sol', requiresExplicitChoice: false });
    expect(reconcileAgentRuntimeModelSelection(initial, 'codex', {
      ...available,
      availability: 'unknown',
      models: [],
    })).toBe(initial);
    const removed = reconcileAgentRuntimeModelSelection(initial, 'codex', {
      ...available,
      models: [{ modelId: 'gpt-5.6-terra', label: 'Terra', isDefault: true }],
    });
    expect(removed).toEqual({ adapterId: 'codex', modelId: '', requiresExplicitChoice: true });
    expect(reconcileAgentRuntimeModelSelection(removed, 'codex', available)).toBe(removed);
  });

  test('renders nothing while hidden', () => {
    expect(renderToStaticMarkup(
      <AgentRuntimePanel visible={false} projects={[]} />,
    )).toBe('');
  });

  test('renders an accessible responsive semantic task surface without execution internals', () => {
    const markup = renderToStaticMarkup(
      <AgentRuntimePanel
        visible
        projects={[
          {
            targetId: 'target_12345678', label: 'AgentsToZ', scope: 'main',
            worktreeCapable: true,
          },
          {
            targetId: 'target_87654321', projectTargetId: 'target_12345678',
            label: '안전성 검증', scope: 'worktree', branch: 'runtime',
          },
        ]}
        onManageProject={() => undefined}
      />,
    );
    expect(markup).toContain('data-testid="agent-runtime-panel"');
    expect(markup).toContain('aria-labelledby="agent-runtime-title"');
    expect(markup).toContain('새 에이전트 작업');
    expect(markup).toContain('작업 함');
    expect(markup).toContain('작업 타임라인');
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('>작업</button>');
    expect(markup).toContain('>대화</button>');
    expect(markup).toContain('id="agent-runtime-tasks-tab"');
    expect(markup).toContain('aria-controls="agent-runtime-tasks-panel"');
    expect(markup).toContain('id="agent-runtime-tasks-panel"');
    expect(markup).toContain('role="tabpanel"');
    expect(markup).toContain('aria-labelledby="agent-runtime-tasks-tab"');
    expect(panelSource).toContain('aria-controls="agent-runtime-conversations-panel"');
    expect(panelSource).toContain('aria-labelledby="agent-runtime-conversations-tab"');
    expect(panelSource).toContain("event.key === 'ArrowLeft' || event.key === 'Home'");
    expect(panelSource).toContain("event.key === 'ArrowRight' || event.key === 'End'");
    expect(panelSource).toContain('onKeyDown={switchSurfaceFromKeyboard}');
    expect(panelSource).toContain("tabIndex={surfaceMode === 'tasks' ? 0 : -1}");
    expect(panelSource).toContain('<AgentRuntimeConversationView');
    expect(panelSource).toContain('Codex 준비됨 · OS 실행 격리 대기');
    expect(panelSource).toContain('codexAdapterVerified={codexAdapterVerified}');
    expect(markup).toContain('AgentsToZ · 기본');
    expect(markup).toContain('안전성 검증 · Git 워크트리 · runtime');
    expect(markup).toContain('워크트리 만들기·관리');
    expect(markup).toContain('프로젝트 화면의 워크트리 관리에서 안전하게 만듭니다');
    expect(markup).toContain('dangerously-bypass-approvals-and-sandbox');
    expect(markup).toContain('파일을 바꾸는 런타임 작업은 안정성 게이트로 일시 중지했습니다.');
    expect(markup).toContain('Codex 대화는 별도의 읽기 전용 경계에서 사용할 수 있습니다.');
    expect(markup).toContain('OS 격리 검증 대기:');
    expect(markup).toContain('구조화 실행기 구현 전:');
    expect(markup).toContain('일반 작업공간 모드에서도 분리된 자식 프로세스');
    expect(markup).toContain('분리된 백그라운드 프로세스까지 종료를 증명하는 OS 강제 격리');
    expect(markup).toContain('원격 세션에도 이 권한을 전달하지 않습니다');
    expect(markup).toContain('min-[960px]:grid-cols-');
    expect(markup).toContain('id="agent-runtime-task-detail"');
    expect(markup).toContain('tabindex="-1"');
    for (const forbidden of ['stdout', 'stderr', 'cwd', 'folderPath', 'worktreePath', 'command', 'pid']) {
      expect(markup).not.toContain(forbidden);
    }
  });

  test('shows dangerous mode as disabled until OS containment covers detached descendants', () => {
    const markup = renderToStaticMarkup(
      <AgentRuntimePanel
        visible
        projects={[{
          targetId: 'target_12345678',
          label: 'AgentsToZ',
          scope: 'main',
          worktreeCapable: true,
        }]}
      />,
    );
    const checkbox = markup.match(/<input type="checkbox"[^>]*>/)?.[0] ?? '';

    expect(AGENT_RUNTIME_DANGEROUS_MODE_ENABLED).toBe(false);
    expect(AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED).toBe(false);
    expect(panelSource).toContain(
      'CLIENT_MANAGED_EXECUTION_ENABLED\n      && selectedTargetId',
    );
    expect(panelSource).toContain(
      'disabled={!CLIENT_DANGEROUS_MODE_ENABLED || !selectedModel || starting}',
    );
    expect(checkbox).toContain('disabled=""');
    expect(checkbox).not.toContain('checked=""');
    expect(markup).toContain('현재 비활성화되어 있습니다.');
    expect(markup).toContain('분리된 백그라운드 프로세스까지 종료를 증명하는 OS 강제 격리');
    expect(markup).toContain('기본 작업공간 모드를 포함한 새 실행 전체');
    expect(panelSource).toContain('로컬 개발 테스트 모드 · 파일 수정과 전체 접근 실행 허용');
    expect(panelSource).toContain('모바일 원격 테스트는 workspace-write만 허용');
    expect(panelSource).toContain('모바일 원격에는 이 권한을 전달하지 않습니다');
  });

  test('retains the last server-confirmed targets only for an incomplete refresh', () => {
    const confirmed = [{
      targetId: 'target_12345678',
      projectTargetId: 'target_12345678',
      label: 'AgentsToZ',
      scope: 'main' as const,
      branch: 'main',
      locked: false,
      worktreeCapable: true,
    }];
    expect(mergeAgentRuntimeTargets(confirmed, [], false)).toEqual(confirmed);
    expect(mergeAgentRuntimeTargets(confirmed, [], true)).toEqual([]);
  });

  test('describes cancellation honestly for each returned lifecycle outcome', () => {
    expect(agentRuntimeCancellationNotice('running')).toContain('일부 변경은 이미 적용');
    expect(agentRuntimeCancellationNotice('running')).toContain('최종 상태는 이벤트');
    expect(agentRuntimeCancellationNotice('cancelled')).toContain('취소 전에 적용된 일부 변경');
    expect(agentRuntimeCancellationNotice('succeeded')).toContain('이미 완료');
    expect(agentRuntimeCancellationNotice('succeeded')).toContain('자동으로 되돌리지');
    expect(agentRuntimeCancellationNotice('failed')).toContain('이미 실패로 종료');
    expect(agentRuntimeCancellationNotice('unknown')).toContain('최종 상태를 확인 중');
  });

  test('turns opaque Codex terminal failures into safe, actionable recovery guidance', () => {
    const common = {
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      taskId: 'task_12345678',
      seq: 2,
      occurredAt: '2026-09-05T00:00:00.000Z',
    };
    const generic = agentRuntimeFailureRecovery([{
      ...common,
      type: 'task.failed',
      payload: { code: 'CODEX_TASK_FAILED', message: '실패', retryable: false },
    }]);
    expect(generic?.title).toContain('완료하지 못했습니다');
    expect(generic?.guidance).toContain('원문 요청은 안전을 위해 자동 복원하지 않습니다');
    const uncertain = agentRuntimeFailureRecovery([{
      ...common,
      type: 'task.failed',
      payload: {
        code: 'CODEX_PROCESS_TERMINATION_UNCONFIRMED',
        message: '종료 확인 실패',
        retryable: false,
      },
    }]);
    expect(uncertain?.title).toContain('자동 재실행을 막았습니다');
    expect(uncertain?.guidance).toContain('같은 요청을 자동 반복하지 말고');
    expect(agentRuntimeFailureRecovery([])).toBeNull();
    expect(panelSource).toContain('data-testid="agent-runtime-failure-recovery"');
    expect(panelSource).toContain('준비 상태 다시 확인');
    expect(panelSource).toContain('새 작업으로 준비');
  });

  test('offers an in-place readiness refresh without treating diagnostics as execution authority', () => {
    expect(panelSource).toContain('const refreshReadiness = useCallback(async () =>');
    expect(panelSource).toContain('실행 준비 상태를 확인하지 못했습니다.');
    expect(panelSource).toContain('실행 준비 현황 ·');
    expect(panelSource).toContain('이 화면에서 사용자가 설정할 항목이 아닙니다');
    expect(panelSource).toContain('아래 결과는 읽기 전용 진단이며 실행 권한으로 사용되지 않습니다');
  });

  test('keeps mobile feedback above the two-column body and moves focus to selected task detail', () => {
    const feedback = panelSource.indexOf('data-testid="agent-runtime-feedback"');
    const grid = panelSource.indexOf('min-[960px]:grid-cols-');
    expect(feedback).toBeGreaterThan(-1);
    expect(grid).toBeGreaterThan(feedback);
    expect(panelSource).toContain("window.matchMedia('(max-width: 959px)').matches");
    expect(panelSource).toContain('detail.focus({ preventScroll: true });');
    expect(panelSource).toContain("detail.scrollIntoView({ behavior: 'smooth', block: 'start' });");
  });

  test('keeps a copyable AgentsToZ diagnostic id on task detail without exposing provider ids', () => {
    expect(panelSource).toContain('data-testid="agent-runtime-diagnostic-id"');
    expect(panelSource).toContain('진단 ID');
    expect(panelSource).toContain('navigator.clipboard?.writeText');
    expect(panelSource).toContain('copyDiagnosticId(activeTask.taskId)');
    expect(panelSource).not.toContain('activeTask.threadId');
    expect(panelSource).not.toContain('activeTask.turnId');
  });

  test('opens the existing parent project and expanded worktree manager from Runtime', () => {
    const start = appSource.indexOf('const openAgentRuntimeProjectManager = useCallback(');
    const end = appSource.indexOf('const searchFilteredPorts = useMemo(', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const integration = appSource.slice(start, end);
    expect(integration).toContain("setActiveTab('ports')");
    expect(integration).toContain("setPortViewMode('terminal')");
    const localOnlySelectionFence = integration.indexOf('selectedWorktreeRemoteLoadRef.current =');
    expect(localOnlySelectionFence).toBeGreaterThan(-1);
    expect(localOnlySelectionFence).toBeLessThan(integration.indexOf('setV4SelectedId(project.id)'));
    expect(integration).toContain('setV4SelectedId(project.id)');
    expect(integration).toContain('next.add(project.id)');
    expect(integration).toContain('expandedWorktreeIdsRef.current = next');
    expect(integration).toContain('loadWorktrees(project.id, project.folderPath');
    expect(integration).toContain('fetchRemote: false');
    expect(integration).toContain('setPendingAgentRuntimeProjectTargetId(projectTargetId)');
    expect(appSource).toContain('if (isLoading || !pendingAgentRuntimeProjectTargetId) return;');
    expect(appSource).toContain('openAgentRuntimeProjectManager(targetId)');
    expect(appSource).toContain('onManageProject={openAgentRuntimeProjectManager}');
  });

  test('fences list snapshots both before and after successful start and cancel mutations', () => {
    const startBegin = panelSource.indexOf('setStarting(true);');
    const startRequest = panelSource.indexOf('const response = await client.start({', startBegin);
    const startCommit = panelSource.indexOf('const nextTasks = upsertTask(', startRequest);
    const cancelBegin = panelSource.indexOf('setCancellingTaskId(task.taskId);');
    const cancelRequest = panelSource.indexOf('const response = await client.cancel(', cancelBegin);
    const cancelCommit = panelSource.indexOf('replaceTasks(upsertTask(', cancelRequest);
    expect(startBegin).toBeGreaterThan(-1);
    expect(startRequest).toBeGreaterThan(startBegin);
    expect(startCommit).toBeGreaterThan(startRequest);
    expect(cancelBegin).toBeGreaterThan(startCommit);
    expect(cancelRequest).toBeGreaterThan(cancelBegin);
    expect(cancelCommit).toBeGreaterThan(cancelRequest);
    expect(panelSource.slice(startBegin, startRequest)).toContain('taskMutationEpochRef.current += 1;');
    expect(panelSource.slice(startRequest, startCommit)).toContain('taskMutationEpochRef.current += 1;');
    expect(panelSource.slice(cancelBegin, cancelRequest)).toContain('taskMutationEpochRef.current += 1;');
    expect(panelSource.slice(cancelRequest, cancelCommit)).toContain('taskMutationEpochRef.current += 1;');
  });
});
