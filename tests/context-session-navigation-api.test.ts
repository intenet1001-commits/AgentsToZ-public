import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('../src/components/AiUsagePanel.tsx', import.meta.url), 'utf8');

describe('context-session navigation API guardrails', () => {
  const endpointStart = apiSource.indexOf('/api/context-sessions/navigate');
  const endpointEnd = apiSource.indexOf('// Live context-window readings', endpointStart);
  const endpoint = apiSource.slice(endpointStart, endpointEnd);

  test('accepts only sessionId and sourceAgent from the browser', () => {
    expect(endpointStart).toBeGreaterThan(-1);
    expect(endpoint).toContain('sessionId?: unknown; sourceAgent?: unknown');
    expect(endpoint).not.toMatch(/body\.(?:cwd|handle|url|surfaceId|workspaceId)/);
    expect(panelSource).toContain("body: JSON.stringify({ sessionId: session.sessionId, sourceAgent: session.sourceAgent })");
  });

  test('opens an existing ChatGPT Codex thread, never a new task', () => {
    expect(endpoint).toContain('codex://threads/${sessionId}');
    expect(endpoint).not.toContain('codex://threads/new');
    expect(endpoint).toContain('isRecordedChatGptCodexSession(sessionId)');
  });

  test('uses no creation or input-sending path while focusing an existing Orca session', () => {
    const focusStart = apiSource.indexOf('async function focusOrcaWorktreeContextSession');
    const focusEnd = apiSource.indexOf('async function revealOrcaFloatingContextSession', focusStart);
    const focus = apiSource.slice(focusStart, focusEnd);
    expect(focus).toContain("['terminal', 'show', '--terminal', live.handle]");
    expect(focus).toContain("['terminal', 'switch', '--terminal', live.handle]");
    expect(focus).not.toContain("['terminal', 'create'");
    expect(focus).not.toContain("['terminal', 'send'");
  });
});
