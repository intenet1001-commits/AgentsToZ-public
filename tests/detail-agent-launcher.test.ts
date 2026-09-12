import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const rustSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

describe('project detail agent launcher', () => {
  test('every agent gets the same run/new pair, not just Claude', () => {
    for (const agent of ['claude', 'codex', 'agy', 'hermes']) {
      expect(appSource).toContain(`data-testid={\`detail-\${entry.agent}-run\`}`);
      expect(appSource).toContain(`data-testid={\`detail-\${entry.agent}-new\`}`);
      expect(appSource).toContain(`agent: '${agent}' as const`);
    }
  });

  test('the new-window button forces a new session for Codex and agy', () => {
    expect(appSource).toContain('openCodexMain(sel, undefined, false, true)');
    expect(appSource).toContain('openAntigravityMain(sel, undefined, false, true)');
    // Plain 실행 must stay reuse-or-new.
    expect(appSource).toContain('run: () => openCodexMain(sel),');
    expect(appSource).toContain('run: () => openAntigravityMain(sel),');
  });

  test('Hermes has the same project run/new controls', () => {
    expect(appSource).toContain('run: () => openHermesMain(sel),');
    expect(appSource).toContain('fresh: () => openHermesMain(sel, undefined, true)');
    expect(appSource).toContain('data-testid="project-hermes-agent"');
    expect(appSource).toContain('data-testid="worktree-hermes-agent"');
  });

  test('the reuse rule is stated once from the shared policy', () => {
    expect(appSource).toContain('describeAgentLaunchPolicy({ terminalApp, orcaLaunchMode, tmuxMode })');
    expect(appSource).toContain('data-launch-reuse={agentLaunchPolicy.reuse}');
  });

  test('force-new reaches tmux through both the API server and the Tauri command', () => {
    // Without kill-session, `new-session -d … ; attach` would silently reuse.
    expect(apiSource).toContain("const killFirst = fresh === true ? `tmux kill-session -t '${esc}' 2>/dev/null; ` : '';");
    expect(apiSource.match(/killFirst\}tmux new-session/g)?.length).toBe(2);
    expect(rustSource).toContain('fn open_tmux_codex(session_name: String, folder_path: Option<String>, worktree_path: Option<String>, bypass: Option<bool>, terminal_app: Option<String>, fresh: Option<bool>)');
    expect(rustSource).toContain('fn open_tmux_agy(session_name: String, folder_path: Option<String>, worktree_path: Option<String>, bypass: Option<bool>, terminal_app: Option<String>, fresh: Option<bool>)');
    expect(rustSource).toContain('let kill_prefix = if fresh {');
  });

  test('the Orca launch carries the same intent for all three agents', () => {
    expect(appSource).toContain("callOrca('codex', item, context.worktreePath, isNew)");
    expect(appSource).toContain("callOrca('agy', item, context.worktreePath, isNew)");
  });
});
