import { describe, expect, test } from 'bun:test';
import { classifyClaudeSessionOrigin, classifyCodexSessionOrigin } from '../src/sessionOrigin';

describe('session origin classification', () => {
  test('distinguishes Orca floating and worktree Claude sessions', () => {
    expect(classifyClaudeSessionOrigin({ orcaWorktreeId: 'global-floating-terminal' }).surfaceLabel).toBe('Orca 플로팅');
    expect(classifyClaudeSessionOrigin({ orcaWorktreeId: 'wt-feature' })).toMatchObject({
      surfaceLabel: 'Orca 워크트리',
      surfaceDetail: 'wt-feature',
    });
  });

  test('prefers Orca over cmux and identifies cmux', () => {
    expect(classifyClaudeSessionOrigin({ orcaWorktreeId: 'wt-a', cmuxWorkspaceId: 'ws-a' }).surfaceKind).toBe('orca-worktree');
    expect(classifyClaudeSessionOrigin({ cmuxWorkspaceId: 'ws-a' })).toMatchObject({ surfaceKind: 'cmux', surfaceDetail: 'ws-a' });
  });

  test('identifies a Claude desktop entrypoint without losing its surface', () => {
    expect(classifyClaudeSessionOrigin({ claudeCodeEntrypoint: 'claude-desktop', cmuxWorkspaceId: 'ws-a' })).toMatchObject({
      clientLabel: 'Claude 앱',
      surfaceKind: 'cmux',
    });
  });

  test('identifies ChatGPT desktop Codex and CLI fallback', () => {
    expect(classifyCodexSessionOrigin({ originator: 'Codex Desktop', source: 'vscode' })).toMatchObject({
      clientLabel: 'ChatGPT 앱 · Codex',
      surfaceKind: 'desktop-app',
      surfaceLabel: 'ChatGPT 데스크탑',
    });
    expect(classifyCodexSessionOrigin({ originator: 'codex-tui', source: 'cli', cwd: '/repo' })).toMatchObject({
      clientLabel: 'Codex CLI',
      surfaceKind: 'unknown',
    });
  });

  test('names the editor a Codex CLI session was launched from', () => {
    // Orca exports TERM_PROGRAM=Orca, so `vscode` really is a VS Code family host.
    expect(classifyCodexSessionOrigin({
      originator: 'codex-tui',
      source: 'vscode',
      cwd: '/Users/me/work/nhdesign4-marketplace',
    })).toMatchObject({ clientLabel: 'Codex CLI', surfaceKind: 'vscode', surfaceLabel: 'VS Code 계열 터미널' });
  });

  test('an Orca cwd still outranks the editor hint', () => {
    expect(classifyCodexSessionOrigin({
      originator: 'codex-tui',
      source: 'vscode',
      cwd: '/Users/me/Library/Application Support/orca/floating',
    }).surfaceKind).toBe('orca-floating');
  });

  test('a background agent is named, not reported as an unidentified terminal', () => {
    // The daemon inherits no terminal environment, so every launch field is null.
    const empty = { orcaWorktreeId: null, cmuxWorkspaceId: null, termProgram: null, claudeCodeEntrypoint: 'cli' };
    expect(classifyClaudeSessionOrigin(empty).surfaceLabel).toBe('실행 위치 미확인');
    expect(classifyClaudeSessionOrigin(empty, { backgroundAgent: true })).toMatchObject({
      clientLabel: 'Claude Code',
      surfaceKind: 'claude-bg-agent',
      surfaceLabel: '백그라운드 에이전트',
    });
  });

  test('a background agent that did inherit a pane keeps the more precise surface', () => {
    expect(classifyClaudeSessionOrigin(
      { orcaWorktreeId: 'wt-feature', orcaPaneKey: 'pane-1' },
      { backgroundAgent: true },
    ).surfaceKind).toBe('orca-worktree');
  });
});
