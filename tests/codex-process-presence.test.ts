import { describe, expect, test } from 'bun:test';
import {
  codexTuiRuntimeState,
  codexTuiSurfacePresence,
  isCodexTuiProcessLine,
} from '../src/codexProcessPresence';
import { visibleContextSessions } from '../src/contextSessionVisibility';

// Verbatim `ps -Ao command` lines from a machine running the ChatGPT app with
// no Codex CLI session open — the case that used to leave a dead row behind.
const CHATGPT_APP_LINES = [
  '/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled',
  '/Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host',
  '/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/151.0.7922.71/Helpers/browser_crashpad_handler --monitor-self',
  '/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/151.0.7922.71/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer) --type=renderer',
];

describe('Codex CLI process presence', () => {
  test('does not mistake ChatGPT app processes for a CLI session', () => {
    for (const line of CHATGPT_APP_LINES) {
      expect(isCodexTuiProcessLine(line)).toBe(false);
    }
    expect(codexTuiRuntimeState(CHATGPT_APP_LINES)).toBe('stopped');
  });

  test('recognizes a real CLI session however it was installed', () => {
    expect(isCodexTuiProcessLine('/opt/homebrew/bin/codex')).toBe(true);
    expect(isCodexTuiProcessLine('/Users/me/.local/bin/codex --search')).toBe(true);
    expect(isCodexTuiProcessLine('codex')).toBe(true);
    expect(codexTuiRuntimeState([...CHATGPT_APP_LINES, '/opt/homebrew/bin/codex'])).toBe('running');
  });

  test('ignores non-interactive Codex runs', () => {
    expect(isCodexTuiProcessLine('/opt/homebrew/bin/codex exec "do the thing"')).toBe(false);
  });

  test('a name that merely contains codex is not the executable', () => {
    expect(isCodexTuiProcessLine('/usr/bin/tail -f /Users/me/.codex/sessions/rollout.jsonl')).toBe(false);
    expect(isCodexTuiProcessLine('/Users/me/bin/codexify --watch')).toBe(false);
  });

  test('only a conclusively empty process list removes a row', () => {
    expect(codexTuiRuntimeState(null)).toBe('unverified');
    expect(codexTuiSurfacePresence('stopped')).toBe('gone');
    // Regression: `unverified` is hidden by the panel, so a running CLI used to
    // take the one genuinely live session off the list along with the dead ones.
    expect(codexTuiSurfacePresence('running')).toBe('not-applicable');
    expect(codexTuiSurfacePresence('unverified')).toBe('not-applicable');
  });

  test('a live CLI session stays visible while a CLI is running', () => {
    const rows = ['running', 'unverified', 'stopped'].map(state => ({
      state: 'active' as const,
      surfacePresence: codexTuiSurfacePresence(state as Parameters<typeof codexTuiSurfacePresence>[0]),
    }));
    expect(visibleContextSessions(rows)).toHaveLength(2);
  });
});
