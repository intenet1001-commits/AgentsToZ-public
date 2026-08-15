import { describe, expect, test } from 'bun:test';
import { isClaudeBgAvailable, terminalOptionDefaults, tmuxReach } from '../src/terminalDefaults';

describe('terminal option defaults', () => {
  test.each(['cmux', 'iterm', 'terminal'] as const)(
    '%s defaults Claude bg and permission bypass to ON',
    (app) => {
      expect(terminalOptionDefaults(app)).toEqual({
        bgMode: true,
        tmuxMode: true,
        bypassPermissions: true,
      });
    },
  );

  test('Orca Floating defaults Claude --bg to ON', () => {
    expect(terminalOptionDefaults('orca')).toEqual({
      bgMode: true,
      tmuxMode: false,
      bypassPermissions: true,
    });
  });

  test('Orca worktree-owned terminal defaults Claude bg to OFF', () => {
    expect(terminalOptionDefaults('orca', 'worktree')).toEqual({
      bgMode: false,
      tmuxMode: false,
      bypassPermissions: true,
    });
  });

  test('Windows terminals retain their platform-specific safe defaults', () => {
    expect(terminalOptionDefaults('wsl')).toEqual({ bgMode: true, tmuxMode: true, bypassPermissions: false });
    expect(terminalOptionDefaults('powershell')).toEqual({ bgMode: false, tmuxMode: false, bypassPermissions: false });
  });

  test('Claude --bg is available on every selected management surface except Orca worktree and PowerShell', () => {
    expect(isClaudeBgAvailable('cmux', 'floating')).toBe(true);
    expect(isClaudeBgAvailable('iterm', 'floating')).toBe(true);
    expect(isClaudeBgAvailable('terminal', 'floating')).toBe(true);
    expect(isClaudeBgAvailable('orca', 'floating')).toBe(true);
    expect(isClaudeBgAvailable('orca', 'worktree')).toBe(false);
    expect(isClaudeBgAvailable('powershell', 'floating')).toBe(false);
  });
});

describe('tmux toggle reach', () => {
  test.each(['cmux', 'iterm', 'terminal'] as const)(
    '%s with Claude bg ON routes only Codex/agy through tmux',
    (app) => {
      expect(tmuxReach(app, true)).toBe('codex-agy');
    },
  );

  test.each(['cmux', 'iterm', 'terminal'] as const)(
    '%s with Claude bg OFF routes every agent through tmux',
    (app) => {
      expect(tmuxReach(app, false)).toBe('all');
    },
  );

  test('the worktree surface only gates Orca, so cmux keeps its bg-driven reach', () => {
    expect(tmuxReach('cmux', true, 'worktree')).toBe('codex-agy');
  });

  test('terminals without a tmux path report no reach', () => {
    expect(tmuxReach('orca', false)).toBe('none');
    expect(tmuxReach('orca', true, 'worktree')).toBe('none');
    expect(tmuxReach('powershell', false)).toBe('none');
  });

  test('WSL forces tmux regardless of the toggle', () => {
    expect(tmuxReach('wsl', true)).toBe('codex-agy');
    expect(tmuxReach('wsl', false)).toBe('all');
  });
});
