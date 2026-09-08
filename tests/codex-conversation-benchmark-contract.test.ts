import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const benchmark = readFileSync(
  new URL('../benchmark-codex-conversation.ts', import.meta.url),
  'utf8',
);

describe('Codex conversation live benchmark contract', () => {
  test('is explicit opt-in, workspace-write only, and deletes its retained thread', () => {
    expect(benchmark).toContain("process.argv[2] !== '--live'");
    expect(benchmark).toContain("executionMode: 'workspace-write'");
    expect(benchmark).toContain("action: 'delete'");
    expect(benchmark).toContain('providerThreadDeleted: true');
    expect(benchmark).not.toContain('dangerously-bypass-approvals-and-sandbox');
  });

  test('publishes phase timings without publishing provider IDs or local paths', () => {
    expect(benchmark).toContain('identityInspectionMs: identityMs');
    expect(benchmark).toContain('compatibilityInspectionMs: inspectionMs');
    expect(benchmark).toContain('coldRetainedTurn: first.timing');
    expect(benchmark).toContain('resumedRetainedTurn: resumed.timing');
    expect(benchmark).not.toContain('providerThreadId,\n      promptOrTranscriptRetainedByAgentsToZ');
    expect(benchmark).toContain('promptOrTranscriptRetainedByAgentsToZ: false');
    expect(benchmark).toContain('managedExecutionAuthorized: false');
  });
});
