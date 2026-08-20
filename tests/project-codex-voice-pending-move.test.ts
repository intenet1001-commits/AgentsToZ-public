import { describe, expect, test } from 'bun:test';
import {
  selectProjectCodexVoiceThread,
  selectPendingProjectCodexVoiceThread,
} from '../src/projectCodexVoice';
import type { ContextSessionMetadata } from '../src/contextSessionMetadata';

const SESSION_ID = '019fe081-198e-7a10-ad90-c0a50d31410d';
const SHADOWLOOP = '/Users/gwanli/product_2026/ShadowLoop';
const SCRATCH = '/Users/gwanli/Documents/Codex/2026-08-08/realtime-voice-chat-3';

const candidate = {
  sessionId: SESSION_ID,
  originator: 'Codex Desktop',
  threadSource: 'realtime_voice',
  modifiedAtMs: 100,
};

// Real shape read from ~/.codex/.codex-global-state.json: the assignment points
// at ShadowLoop with pendingCoreUpdate:true, while the workspace state keeps
// applied.cwd in the scratch directory and only pending.cwd is the project.
const metadata = (over: Record<string, unknown> = {}): ReadonlyMap<string, ContextSessionMetadata> => new Map([[
  SESSION_ID,
  {
    threadTitle: 'voice',
    projectHint: {
      name: 'ShadowLoop',
      path: SHADOWLOOP,
      source: 'chatgpt-local-project',
      moveState: 'pending',
      appliedPath: SCRATCH,
      pendingPath: SHADOWLOOP,
      ...over,
    },
  } as ContextSessionMetadata,
]]);

describe('voice threads whose project move was never applied', () => {
  // The user asked a scratch voice chat to move into a project and watched it
  // move. The assignment is real; the execution folder never followed.
  test('a pending move is found and reports where execution actually is', () => {
    const found = selectPendingProjectCodexVoiceThread(SHADOWLOOP, [candidate], metadata());
    expect(found?.sessionId).toBe(SESSION_ID);
    expect(found?.appliedPath).toBe(SCRATCH);
  });

  test('an applied move is not reported as pending', () => {
    expect(selectPendingProjectCodexVoiceThread(SHADOWLOOP, [candidate], metadata({ moveState: 'applied' }))).toBeNull();
  });

  test('a pending move toward another project does not match', () => {
    expect(selectPendingProjectCodexVoiceThread('/Users/gwanli/product_2026/vibe2', [candidate], metadata())).toBeNull();
  });

  // Resuming it must never be presented as a project-scoped session: writes
  // would land in the scratch directory.
  test('the applied selector still refuses a pending move', () => {
    expect(selectProjectCodexVoiceThread(SHADOWLOOP, [candidate], metadata())).toBeNull();
  });

  test('a thread with no project hint at all is not a pending move', () => {
    const bare = new Map([[SESSION_ID, { threadTitle: 'voice', projectHint: null } as ContextSessionMetadata]]);
    expect(selectPendingProjectCodexVoiceThread(SHADOWLOOP, [candidate], bare)).toBeNull();
  });
});
