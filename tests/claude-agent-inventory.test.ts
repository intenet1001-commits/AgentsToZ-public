import { describe, expect, test } from 'bun:test';
import {
  claudeAgentRuntimeFacts,
  claudeAgentSurfacePresence,
  hasTerminalLaunchEvidence,
  resolveClaudeAgentInventory,
  parseClaudeAgentInventory,
  UNAVAILABLE_CLAUDE_AGENT_INVENTORY,
} from '../src/claudeAgentInventory';
import { visibleContextSessions } from '../src/contextSessionVisibility';

const WORKING = '46051106-29a5-4fc4-ab89-32d5f3a10a28';
const BLOCKED = 'a0a93f86-4303-49d0-97fe-022811e63a5d';
const DONE = 'db7b2b12-ee21-4c50-8edc-bb7f09172042';
const FAILED = 'fc7682c4-3a77-4599-96d0-bcd06a43aa63';
const UNLISTED = 'd859d82b-3a6e-41b8-96cf-52ed096cfc68';

// Shape taken verbatim from `claude agents --json --all`.
const listing = [
  { pid: 78917, id: '46051106', cwd: '/repo', kind: 'background', sessionId: WORKING, name: 'a', status: 'busy', state: 'working' },
  { id: 'a0a93f86', cwd: '/repo', kind: 'background', sessionId: BLOCKED, name: 'b', state: 'blocked' },
  { id: 'db7b2b12', cwd: '/repo', kind: 'background', sessionId: DONE, name: 'c', state: 'done' },
  { id: 'fc7682c4', cwd: '/repo', kind: 'background', sessionId: FAILED, name: 'd', state: 'failed' },
];

describe('claude background agent inventory', () => {
  test('parses background sessions and keeps their pid only while running', () => {
    const inventory = parseClaudeAgentInventory(listing);
    expect(inventory.kind).toBe('listed');
    if (inventory.kind !== 'listed') return;
    expect(inventory.entries.size).toBe(4);
    expect(inventory.entries.get(WORKING)).toMatchObject({ state: 'working', pid: 78917 });
    expect(inventory.entries.get(BLOCKED)).toMatchObject({ state: 'blocked', pid: null });
  });

  test('a blocked agent is live because that is exactly when the user wants it', () => {
    const inventory = parseClaudeAgentInventory(listing);
    expect(claudeAgentSurfacePresence(inventory, WORKING)).toBe('live');
    expect(claudeAgentSurfacePresence(inventory, BLOCKED)).toBe('live');
    expect(claudeAgentRuntimeFacts(inventory, BLOCKED).backgroundAgent).toBe(true);
  });

  test('finished agents are gone, and stop being described as background agents', () => {
    const inventory = parseClaudeAgentInventory(listing);
    expect(claudeAgentSurfacePresence(inventory, DONE)).toBe('gone');
    expect(claudeAgentSurfacePresence(inventory, FAILED)).toBe('gone');
    expect(claudeAgentRuntimeFacts(inventory, DONE).backgroundAgent).toBe(false);
  });

  test('an unlisted session is left to the other probes, never called gone', () => {
    const inventory = parseClaudeAgentInventory(listing);
    expect(claudeAgentSurfacePresence(inventory, UNLISTED)).toBe('not-applicable');
    expect(claudeAgentRuntimeFacts(inventory, UNLISTED).backgroundAgent).toBe(false);
  });

  test('an agent cleared from Agent View does not come back as an unidentifiable row', () => {
    const inventory = parseClaudeAgentInventory(listing);
    // Nothing but a background agent writes a snapshot with no terminal at all.
    expect(claudeAgentSurfacePresence(inventory, UNLISTED, { hasTerminalEvidence: false })).toBe('gone');
    // A terminal session absent from the listing is simply not this probe's business.
    expect(claudeAgentSurfacePresence(inventory, UNLISTED, { hasTerminalEvidence: true })).toBe('not-applicable');
    // An unreadable listing still proves nothing either way.
    expect(claudeAgentSurfacePresence(UNAVAILABLE_CLAUDE_AGENT_INVENTORY, UNLISTED, { hasTerminalEvidence: false }))
      .toBe('not-applicable');
  });

  test('a brief listing failure does not flicker finished agents back into the list', () => {
    const good = parseClaudeAgentInventory(listing);
    const remembered = { at: 1_000, inventory: good };
    // Within the grace period the last good answer keeps the row hidden.
    const held = resolveClaudeAgentInventory(UNAVAILABLE_CLAUDE_AGENT_INVENTORY, remembered, 6_000, 60_000);
    expect(claudeAgentSurfacePresence(held, DONE)).toBe('gone');
    // Past it, we stop claiming anything rather than trusting a stale listing.
    const expired = resolveClaudeAgentInventory(UNAVAILABLE_CLAUDE_AGENT_INVENTORY, remembered, 90_000, 60_000);
    expect(expired.kind).toBe('unavailable');
    // A fresh listing always wins, and an unavailable memory is never used.
    expect(resolveClaudeAgentInventory(good, null, 5_000, 60_000)).toBe(good);
    expect(resolveClaudeAgentInventory(
      UNAVAILABLE_CLAUDE_AGENT_INVENTORY,
      { at: 1_000, inventory: UNAVAILABLE_CLAUDE_AGENT_INVENTORY },
      2_000,
      60_000,
    ).kind).toBe('unavailable');
  });

  test('reads terminal evidence from any of the launch fields', () => {
    expect(hasTerminalLaunchEvidence({ orcaWorktreeId: 'wt' })).toBe(true);
    expect(hasTerminalLaunchEvidence({ cmuxWorkspaceId: 'ws' })).toBe(true);
    expect(hasTerminalLaunchEvidence({ cmuxSurfaceId: 'sf' })).toBe(true);
    expect(hasTerminalLaunchEvidence({ termProgram: 'iTerm.app' })).toBe(true);
    // The background agent shape, verbatim from a captured snapshot.
    expect(hasTerminalLaunchEvidence({
      cmuxWorkspaceId: null, cmuxSurfaceId: null, orcaWorktreeId: null, termProgram: null,
    })).toBe(false);
    expect(hasTerminalLaunchEvidence(null)).toBe(false);
  });

  test('an unavailable listing never claims anything', () => {
    // Regression: `unverified` is hidden by the panel, so returning it here
    // erased every plain-terminal Claude row whenever the CLI call failed.
    expect(claudeAgentSurfacePresence(UNAVAILABLE_CLAUDE_AGENT_INVENTORY, WORKING)).toBe('not-applicable');
    expect(parseClaudeAgentInventory(null).kind).toBe('unavailable');
    expect(parseClaudeAgentInventory({ sessions: [] }).kind).toBe('unavailable');
  });

  test('a failing agent listing leaves ordinary sessions visible', () => {
    const rows = [
      { state: 'active' as const, surfacePresence: claudeAgentSurfacePresence(UNAVAILABLE_CLAUDE_AGENT_INVENTORY, UNLISTED) },
      { state: 'idle' as const, surfacePresence: claudeAgentSurfacePresence(UNAVAILABLE_CLAUDE_AGENT_INVENTORY, WORKING) },
    ];
    expect(visibleContextSessions(rows)).toHaveLength(2);
  });

  test('finished agents are the only rows this probe removes', () => {
    const inventory = parseClaudeAgentInventory(listing);
    const rows = [WORKING, BLOCKED, DONE, FAILED, UNLISTED].map(sessionId => ({
      state: 'active' as const,
      surfacePresence: claudeAgentSurfacePresence(inventory, sessionId),
    }));
    expect(visibleContextSessions(rows)).toHaveLength(3);
  });

  test('ignores malformed ids and unknown states', () => {
    const inventory = parseClaudeAgentInventory([
      { kind: 'background', sessionId: 'not-a-uuid', state: 'working' },
      { kind: 'background', sessionId: BLOCKED, state: 'hibernating' },
      { kind: 'cloud', sessionId: DONE },
    ]);
    if (inventory.kind !== 'listed') throw new Error('expected a listing');
    expect(inventory.entries.size).toBe(1);
    expect(claudeAgentSurfacePresence(inventory, BLOCKED)).toBe('unverified');
  });

  test('a running terminal session counts as live without becoming a background agent', () => {
    // Verbatim interactive shape: a pid, a name, and no state field at all.
    const inventory = parseClaudeAgentInventory([
      { pid: 50160, cwd: '/repo', kind: 'interactive', sessionId: UNLISTED, name: 'shadowloop-ca' },
    ]);
    expect(claudeAgentSurfacePresence(inventory, UNLISTED, { hasTerminalEvidence: true })).toBe('live');
    // Dropping these rows made a running terminal session look like an ended one.
    expect(claudeAgentSurfacePresence(inventory, UNLISTED, { hasTerminalEvidence: false })).toBe('live');
    // It has its own window, so it must not be sent to Agent View.
    expect(claudeAgentRuntimeFacts(inventory, UNLISTED).backgroundAgent).toBe(false);
  });

  test('an interactive record wins over a finished background duplicate', () => {
    const inventory = parseClaudeAgentInventory([
      { kind: 'background', sessionId: WORKING, state: 'done' },
      { kind: 'interactive', sessionId: WORKING, pid: 4242 },
    ]);
    expect(claudeAgentSurfacePresence(inventory, WORKING)).toBe('live');
  });

  test('a live duplicate wins over a stale one for the same session', () => {
    const inventory = parseClaudeAgentInventory([
      { kind: 'background', sessionId: WORKING, state: 'done' },
      { kind: 'background', sessionId: WORKING, state: 'working', pid: 4242 },
    ]);
    expect(claudeAgentSurfacePresence(inventory, WORKING)).toBe('live');
  });
});
