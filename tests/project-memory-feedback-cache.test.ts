import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendProjectMemoryFeedback, appendProjectMemoryFeedbackBatch, feedbackFile,
  projectMemoryFeedbackCacheUsage, readProjectMemoryFeedback, resetProjectMemoryFeedbackCache,
  type ProjectMemoryFeedbackInput,
} from '../src/projectMemoryFeedback';
import { __setProjectMemoryDurabilityFaultForTests } from '../src/projectMemoryDurability';

const roots: string[] = [];
afterEach(() => {
  resetProjectMemoryFeedbackCache();
  __setProjectMemoryDurabilityFaultForTests(null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() { const value = mkdtempSync(join(tmpdir(), 'feedback-budget-')); roots.push(value); return value; }
function event(i: number): ProjectMemoryFeedbackInput {
  return { id: `event-${i}`, memoryId: 'memory-1', entryKey: 'a'.repeat(24), kind: 'confirmed',
    recordedAt: '2026-01-01T00:00:00.000Z', evidence: 'x'.repeat(500) };
}

test('feedback cache bounds roots and bytes, while eviction preserves the authoritative files', () => {
  const parent = root(), locations: string[] = [];
  for (let i = 0; i < 40; i++) {
    const dir = join(parent, String(i)); mkdirSync(dir); locations.push(dir);
    appendProjectMemoryFeedback(dir, event(i));
  }
  expect(projectMemoryFeedbackCacheUsage().roots).toBe(32);
  const firstPath = feedbackFile(locations[0]!), before = readFileSync(firstPath, 'utf8');
  expect(readProjectMemoryFeedback(locations[0]!)[0]?.id).toBe('event-0');
  expect(readFileSync(firstPath, 'utf8')).toBe(before);
  resetProjectMemoryFeedbackCache();
  for (const dir of locations.slice(0, 8)) {
    appendProjectMemoryFeedbackBatch(dir, Array.from({ length: 1_000 }, (_, i) => event(100 + i)));
    const usage = projectMemoryFeedbackCacheUsage();
    expect(usage.estimatedBytes).toBeLessThanOrEqual(usage.maxBytes);
  }
  expect(projectMemoryFeedbackCacheUsage().roots).toBeLessThan(8);
});

test('oversized feedback stays readable, deduplicates batches and refreshes after external changes', () => {
  const dir = root(), events = Array.from({ length: 8_000 }, (_, i) => event(i));
  expect(appendProjectMemoryFeedbackBatch(dir, events).appended).toBe(events.length);
  expect(projectMemoryFeedbackCacheUsage().roots).toBe(0);
  expect(readProjectMemoryFeedback(dir)).toHaveLength(events.length);
  expect(projectMemoryFeedbackCacheUsage().roots).toBe(0);
  const before = readFileSync(feedbackFile(dir), 'utf8');
  expect(appendProjectMemoryFeedbackBatch(dir, events)).toMatchObject({ appended: 0, duplicate: 8_000 });
  expect(readFileSync(feedbackFile(dir), 'utf8')).toBe(before);
  appendFileSync(feedbackFile(dir), JSON.stringify(event(9_000)) + '\n');
  expect(readProjectMemoryFeedback(dir)).toHaveLength(8_001);
  writeFileSync(feedbackFile(dir), JSON.stringify(event(0)) + '\n');
  expect(readProjectMemoryFeedback(dir)).toHaveLength(1);
  expect(projectMemoryFeedbackCacheUsage().roots).toBe(1);
  expect(appendProjectMemoryFeedbackBatch(dir, [event(0), event(1), event(1)])).toMatchObject({ appended: 1, duplicate: 2 });
  expect(readProjectMemoryFeedback(dir)).toHaveLength(2);
});

test('batch validates before writing and invalidates speculative state after an uncertain fsync', () => {
  const dir = root();
  appendProjectMemoryFeedback(dir, event(0));
  const before = readFileSync(feedbackFile(dir), 'utf8');
  expect(() => appendProjectMemoryFeedbackBatch(dir, [event(1), { ...event(2), entryKey: 'invalid' }])).toThrow();
  expect(readFileSync(feedbackFile(dir), 'utf8')).toBe(before);
  __setProjectMemoryDurabilityFaultForTests((phase, path) => {
    if (phase === 'file' && path.endsWith('events.jsonl')) throw new Error('uncertain fsync');
  });
  expect(() => appendProjectMemoryFeedbackBatch(dir, [event(1), event(2)])).toThrow('uncertain fsync');
  expect(projectMemoryFeedbackCacheUsage().roots).toBe(0);
  __setProjectMemoryDurabilityFaultForTests(null);
  expect(appendProjectMemoryFeedbackBatch(dir, [event(1), event(2)])).toMatchObject({ appended: 0, duplicate: 2 });
  expect(readProjectMemoryFeedback(dir)).toHaveLength(3);
  const result = appendProjectMemoryFeedback(dir, event(3));
  result.event.evidence = 'caller mutation';
  expect(readProjectMemoryFeedback(dir).find(item => item.id === result.event.id)?.evidence).toBe('x'.repeat(500));
});
