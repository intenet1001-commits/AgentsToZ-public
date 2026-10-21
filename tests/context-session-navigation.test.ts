import { describe, expect, test } from 'bun:test';
import { resolveClaudeSessionNavigation, resolveCodexSessionNavigation } from '../src/contextSessionNavigation';
import { classifyCodexSessionOrigin } from '../src/sessionOrigin';

describe('context-session navigation capability', () => {
  test('uses the exact ChatGPT Codex thread route only for desktop-origin sessions', () => {
    const desktop = classifyCodexSessionOrigin({ originator: 'Codex Desktop' });
    expect(resolveCodexSessionNavigation(desktop)).toMatchObject({
      available: true,
      kind: 'chatgpt-thread',
      exact: true,
      actionLabel: '창으로 이동',
    });

    const cli = classifyCodexSessionOrigin({ originator: 'codex-tui', cwd: '/repo' });
    expect(resolveCodexSessionNavigation(cli)).toMatchObject({ available: false, kind: null });
  });

  test('requires both cmux identifiers before offering an exact focus action', () => {
    expect(resolveClaudeSessionNavigation({
      cmuxWorkspaceId: 'e5c91f89-a5ec-4422-99d1-598c6b95f8b9',
      cmuxSurfaceId: 'ce2596b4-9e07-4b77-8e4a-e48bce3c97e7',
    })).toMatchObject({ available: true, kind: 'cmux-surface', exact: true });

    expect(resolveClaudeSessionNavigation({
      cmuxWorkspaceId: 'e5c91f89-a5ec-4422-99d1-598c6b95f8b9',
    })).toMatchObject({ available: false, kind: null });
  });

  test('keeps Orca floating navigation explicitly workspace-scoped', () => {
    expect(resolveClaudeSessionNavigation({
      orcaWorktreeId: 'global-floating-terminal',
      orcaPaneKey: 'tab:pane',
    })).toMatchObject({
      available: true,
      kind: 'orca-floating-workspace',
      exact: false,
      actionLabel: '플로팅 열기',
    });
  });

  test('does not guess generic terminal, iTerm, VS Code, or partial Orca locations', () => {
    for (const context of [
      {},
      { termProgram: 'iTerm.app' },
      { termProgram: 'vscode' },
      { orcaWorktreeId: 'repo::/worktree' },
    ]) {
      expect(resolveClaudeSessionNavigation(context)).toMatchObject({ available: false, kind: null });
    }
  });

  test('offers Agent View for a background agent instead of refusing to navigate', () => {
    expect(resolveClaudeSessionNavigation({}, { backgroundAgent: true })).toMatchObject({
      available: true,
      kind: 'claude-agent-view',
      exact: false,
      actionLabel: '에이전트 뷰 열기',
    });
  });

  test('a background agent with a real pane keeps the exact terminal target', () => {
    expect(resolveClaudeSessionNavigation(
      { orcaWorktreeId: 'repo::/worktree', orcaPaneKey: 'tab:pane' },
      { backgroundAgent: true },
    )).toMatchObject({ kind: 'orca-worktree-terminal', exact: true });
  });
});
