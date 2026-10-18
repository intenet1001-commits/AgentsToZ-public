import { describe, expect, test } from 'bun:test';
import {
  describeAgentLaunchPolicy,
  resolveAgentLaunchSurface,
} from '../src/agentLaunchPolicy';

describe('agent launch policy', () => {
  test('maps each header selection to the surface that actually runs the agent', () => {
    expect(resolveAgentLaunchSurface({ terminalApp: 'orca', orcaLaunchMode: 'floating' })).toBe('orca-floating');
    expect(resolveAgentLaunchSurface({ terminalApp: 'orca', orcaLaunchMode: 'worktree' })).toBe('orca-worktree');
    expect(resolveAgentLaunchSurface({ terminalApp: 'cmux' })).toBe('cmux');
    expect(resolveAgentLaunchSurface({ terminalApp: 'iterm', tmuxMode: true })).toBe('tmux');
    expect(resolveAgentLaunchSurface({ terminalApp: 'iterm', tmuxMode: false })).toBe('terminal');
    expect(resolveAgentLaunchSurface({ terminalApp: 'terminal', tmuxMode: true })).toBe('tmux');
    expect(resolveAgentLaunchSurface({ terminalApp: 'powershell' })).toBe('terminal');
  });

  test('only surfaces that can find an existing window promise reuse', () => {
    expect(describeAgentLaunchPolicy({ terminalApp: 'orca', orcaLaunchMode: 'floating' }).reuse).toBe('reuse-or-new');
    expect(describeAgentLaunchPolicy({ terminalApp: 'iterm', tmuxMode: true }).reuse).toBe('reuse-or-new');
    // Orca worktree terminals and cmux workspaces are created fresh every time.
    expect(describeAgentLaunchPolicy({ terminalApp: 'orca', orcaLaunchMode: 'worktree' }).reuse).toBe('always-new');
    expect(describeAgentLaunchPolicy({ terminalApp: 'cmux' }).reuse).toBe('always-new');
    expect(describeAgentLaunchPolicy({ terminalApp: 'iterm', tmuxMode: false }).reuse).toBe('always-new');
  });

  test('the summary states the rule the same way for all three agents', () => {
    const reusing = describeAgentLaunchPolicy({ terminalApp: 'orca', orcaLaunchMode: 'floating' });
    expect(reusing.summary).toContain('창이 있으면 기존 창, 없으면 새 창');
    expect(reusing.summary).toContain('Claude·Codex·agy 공통');

    // Where reuse is impossible the UI must not imply otherwise.
    const alwaysNew = describeAgentLaunchPolicy({ terminalApp: 'cmux' });
    expect(alwaysNew.summary).toContain('모두 새 창을 만듭니다');
    expect(alwaysNew.summary).not.toContain('있으면 기존 창');
    expect(alwaysNew.runTitle).toContain('실행할 때마다 새 창');
  });
});
