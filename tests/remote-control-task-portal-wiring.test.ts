import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const portal = readFileSync(new URL('../src/remote-control-portal-main.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/remote-control-portal.css', import.meta.url), 'utf8');
const api = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');

describe('mobile E2EE Codex task console', () => {
  test('offers model/project selection, start, timeline, refresh, and cancel on the selected Mac', () => {
    expect(portal).toContain('data-testid="remote-codex-task-console"');
    expect(portal).toContain('AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED && (');
    expect(portal).toContain('data-testid="remote-task-capability-pending"');
    expect(portal).toContain('data-testid="remote-task-host-update-required"');
    expect(portal).toContain('if (!status.supportedFeatures?.includes(REMOTE_CONTROL_TASK_SCOPE)) return;');
    expect(portal).toContain("controller.sendTask('capabilities', {})");
    expect(portal).toContain("controller.sendTask('models.list'");
    expect(portal).toContain("controller.sendTask('tasks.start'");
    expect(portal).toContain("controller.sendTask('tasks.list'");
    expect(portal).toContain("controller.sendTask('tasks.events'");
    expect(portal).toContain("controller.sendTask('tasks.cancel'");
    expect(portal).toContain('REMOTE_TASK_ACTIVE_POLL_MS = 3_000');
    expect(portal).toContain('REMOTE_TASK_TIMELINE_EVENT_LIMIT = 32');
    expect(portal).toContain('readRemoteTaskEventWindow');
    expect(portal).toContain('catalogId: firstPage.catalogId');
    expect(portal).toContain('cursor: nextModelCursor');
    expect(portal).toContain('lastLoadedSeq');
    expect(portal).toContain('작업 진행 기록{selectedTaskStatus && remoteTaskIsActive(selectedTaskStatus) ? \' · 자동 확인 중\' : \'\'}');
    expect(portal).toContain('프로젝트·워크트리');
    expect(portal).toContain('위험 권한 우회 모드는 사용할 수 없습니다');
    expect(portal).toContain("remoteFeatureBlocker(taskError, 'REMOTE_CONTROL_TASK_SCOPE_REQUIRED')");
    expect(portal).toContain("taskPanel.blocker === 'host-update'");
    expect(portal).toContain('현재 production에서는 안전 격리가 준비되기 전까지 새 Codex 작업 실행을 제공하지 않습니다.');
    expect(css).toContain('.remote-task-console');
    expect(css).toContain('.remote-task-timeline');
  });

  test('keeps task UI state isolated by host instead of carrying it across Mac switches', () => {
    expect(portal).toContain('taskPanelsByHostRef');
    expect(portal).toContain('taskPanelsByHostRef.current.get(hostId)');
    expect(portal).toContain('taskPanelsByHostRef.current.set(hostId, next)');
    expect(portal).toContain('taskPanelsByHostRef.current.delete(hostId)');
    expect(portal).toContain('loadRemoteTaskEvents(startResult.task.taskId, controller, hostId)');
    expect(portal).toContain('loadRemoteTaskEvents(task.taskId, controller, hostId)');
  });
});

describe('server-side remote task authority join', () => {
  test('joins session control IDs to fresh runtime targets by canonical directory identity', () => {
    expect(api).toContain('resolveRemoteControlTaskTargetAuthorities');
    expect(api).toContain('await loadAgentRuntimeTargetInventory()');
    expect(api).toContain('sameRegisteredDirectory(requested, candidate.directory)');
    expect(api).toContain('taskGateway: remoteControlTaskGateway');
    expect(api).not.toContain('runtimeTargetId: binding.target.internalId');
  });
});
