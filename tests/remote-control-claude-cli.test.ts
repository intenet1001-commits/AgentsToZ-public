import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { REGISTERED_PROJECT_ACTIONS } from '../src/remoteControlCore';
import { registeredRemoteControlTarget } from '../src/remoteControlProcessGateway';
import { remoteControlActionLabel } from '../src/RemoteControlProjectCard';
import { remoteControlExternalLaunchRoute } from '../src/remoteControlExternalLaunchRoute';
import { REMOTE_CONTROL_MOBILE_JS } from '../src/remoteControlMobilePage';

const API_SERVER = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');

/**
 * Claude Code is a CLI, not a URL-handler app.
 *
 * `app.claude` opened `claude://code/new?folder=...`, but the `claude:` scheme
 * is owned by Claude Desktop (com.anthropic.claudefordesktop) — Claude Code
 * registers `claude-cli:` instead. macOS therefore handed the link to Claude
 * Desktop, which does not understand `code/new` and silently discarded the
 * folder. `open` still exited 0, so the phone was told the action succeeded
 * while nothing opened, and a worktree card looked like it opened the main
 * project. Claude Code is reached through the Orca CLI action instead.
 */
describe('remote control opens Claude Code through the Orca CLI, not a deep link', () => {
  test('app.claude is not an offered action on any surface', () => {
    expect([...REGISTERED_PROJECT_ACTIONS]).not.toContain('app.claude');
    expect(REMOTE_CONTROL_MOBILE_JS).not.toContain('"app.claude"');
  });

  test('agent.claude remains the Claude Code entry point and names the CLI surface', () => {
    expect([...REGISTERED_PROJECT_ACTIONS]).toContain('agent.claude');
    expect(remoteControlActionLabel('agent.claude')).toContain('Claude');
    expect(REMOTE_CONTROL_MOBILE_JS).toContain('"agent.claude"');
  });

  test('the Claude deep link is gone from the remote-control action router', () => {
    // Legacy paired clients can still send app.claude, but its fixed route is
    // the Claude CLI in Orca; app.codex / app.hermes retain desktop routes.
    expect(remoteControlExternalLaunchRoute('app.claude')).toEqual({
      surface: 'orca-agent', endpoint: '/api/open-orca-agent', agent: 'claude',
    });
    expect(API_SERVER).toContain('remoteControlExternalLaunchRoute(action)');
    expect(API_SERVER).not.toContain('claude://code/new');
    expect([...REGISTERED_PROJECT_ACTIONS]).toContain('app.codex');
    expect([...REGISTERED_PROJECT_ACTIONS]).toContain('app.hermes');
  });

  test('a worktree card offers the Orca Claude action bound to the worktree path', async () => {
    const target = await registeredRemoteControlTarget({
      row: {
        id: 'wt-1',
        name: 'Project · feature',
        folderPath: '/',
        worktreePath: '/',
      },
      observedRunning: null,
      detectStart: async () => ({ command: null, framework: null }) as never,
    });
    expect(target?.kind).toBe('worktree');
    expect(target?.actions).toContain('agent.claude');
    expect(target?.actions).not.toContain('app.claude');
  });
});
