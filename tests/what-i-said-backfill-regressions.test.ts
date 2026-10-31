import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeProjectSlug } from '../src/sessionTranscript';
import { runWhatISaidExplicitBackfill } from '../src/whatISaidExplicitBackfill';
import { collectWhatISaidTranscripts, type WhatISaidTranscriptCollectionResult } from '../src/whatISaidTranscriptCollector';
import { enableWhatISaidCapture, listWhatISaidEntries, readWhatISaidTranscriptCursor } from '../src/whatISaidStore';

// Explicit past-conversation import boundaries (survey probes of 2026-10-28,
// ported). Every request here is a fresh runner call, the same as a click.

const temporaryRoots: string[] = [];
const KEY = Buffer.alloc(32, 0x51);
const NOW = '2026-08-30T12:10:00Z';
const SNAPSHOT_IDENTITY = 'what-i-said-backfill-codex-snapshot-v1';

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function setup() {
  const parent = mkdtempSync(join(tmpdir(), 'agentstoz-what-i-said-backfill-'));
  temporaryRoots.push(parent);
  const paths = {
    projectRoot: join(parent, 'main'),
    unrelatedRoot: join(parent, 'unrelated'),
    appDataDir: join(parent, 'app-data'),
    claudeProjectsDir: join(parent, 'claude-projects'),
    codexSessionsDir: join(parent, 'codex-sessions'),
  };
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  const input = { ...paths, memoryId: 'backfill-memory', key: KEY };
  enableWhatISaidCapture({ ...input, retention: 'forever', now: '2026-08-30T10:00:00Z' });
  return input;
}

type Input = ReturnType<typeof setup>;

/** A Codex rollout whose first-line header is padded like real session instructions. */
function writeCodex(input: Input, file: string, message: string, headerPadding: number): string {
  const directory = join(input.codexSessionsDir, '2026', '08', '30');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, file);
  writeFileSync(path, [
    JSON.stringify({ type: 'session_meta', timestamp: '2026-08-30T11:50:00Z', payload: { cwd: input.projectRoot, instructions: 'x'.repeat(headerPadding) } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-08-29T08:00:00Z', payload: { type: 'user_message', message } }),
  ].join('\n') + '\n');
  const fresh = new Date('2026-08-30T12:05:00Z');
  utimesSync(path, fresh, fresh);
  return path;
}

function claudeFile(input: Input, name: string, body: string): string {
  const directory = join(input.claudeProjectsDir, claudeProjectSlug(input.projectRoot));
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, body);
  const fresh = new Date('2026-08-30T12:05:00Z');
  utimesSync(path, fresh, fresh);
  return path;
}

const claudeRecord = (root: string, timestamp: string, text: string) =>
  JSON.stringify({ type: 'user', cwd: root, timestamp, message: { content: text } }) + '\n';

/** One explicit request, wired like the local API: later passes continue the same request. */
function request(input: Input, options: { scanByteBudget?: number; maxPasses?: number; signal?: AbortSignal; afterPass?: () => void; now?: string } = {}) {
  let passes = 0;
  return runWhatISaidExplicitBackfill(async (deadlineAt, pass) => {
    passes++;
    const result = collectWhatISaidTranscripts({
      ...input, worktreeRoots: [input.projectRoot], now: options.now ?? NOW, backfill: true,
      backfillContinuation: pass > 0, scanDeadlineAt: deadlineAt,
      ...(options.scanByteBudget !== undefined ? { scanByteBudget: options.scanByteBudget } : {}),
    });
    options.afterPass?.();
    return result;
  }, { yieldControl: async () => {}, ...(options.maxPasses !== undefined ? { maxPasses: options.maxPasses } : {}), ...(options.signal ? { signal: options.signal } : {}) })
    .then(result => ({ result, passes }));
}

const complete = (result: WhatISaidTranscriptCollectionResult | null) =>
  !!result && result.scanAdvanced && !result.hasMore && result.unreadable === 0;

describe('What-I-said explicit backfill completion', () => {
  // Eight owned files whose header snapshot reads cost about 1.47 KB each
  // (11.8 KB in all, the whole small file). The budgets put that total at
  // about 18%, 45%, 72%, 90% and 118% of one pass. Before 2026-10-28 every
  // request at 65% or more ended 'uncertain' and never completed.
  for (const budget of [65_536, 26_000, 16_384, 13_000, 10_000]) {
    test(`a request completes when Codex headers are large against a ${budget}-byte budget`, async () => {
      const input = setup();
      for (let index = 0; index < 8; index++) writeCodex(input, `header-${index}.jsonl`, `header-${index}`, 1_200);
      const { result } = await request(input, { scanByteBudget: budget });
      expect(result?.verificationUncertain).toBeUndefined();
      expect(complete(result)).toBe(true);
      expect(result?.stored).toBe(8);
      expect(listWhatISaidEntries({ ...input, now: NOW }).items).toHaveLength(8);
    });
  }

  test('one-pass requests progress monotonically to completion instead of alternating with empty reads', async () => {
    const input = setup();
    for (let index = 0; index < 8; index++) writeCodex(input, `click-${index}.jsonl`, `click-${index}`, 1_200);
    const outcomes: WhatISaidTranscriptCollectionResult[] = [];
    for (let click = 0; click < 30; click++) {
      const { result } = await request(input, { scanByteBudget: 10_000, maxPasses: 1 });
      outcomes.push(result!);
      expect(result!.verificationUncertain).toBeUndefined();
      expect(result!.bytesRead).toBeGreaterThan(0);
      if (complete(result)) break;
    }
    expect(complete(outcomes.at(-1)!)).toBe(true);
    expect(outcomes.length).toBeGreaterThan(1);
    expect(listWhatISaidEntries({ ...input, now: NOW }).items).toHaveLength(8);
  });

  test('a request that ends during verification resumes it on the next request without reading again', async () => {
    const input = setup();
    for (let index = 0; index < 8; index++) writeCodex(input, `resume-${index}.jsonl`, `resume-${index}`, 1_200);
    const controller = new AbortController();
    const snapshotPhase = () => {
      const cursor = readWhatISaidTranscriptCursor({ ...input, agent: 'codex', sourceIdentity: SNAPSHOT_IDENTITY });
      return { phase: cursor?.fileIdentity.split(':')[1], checked: cursor?.lineNumber ?? 0 };
    };
    const first = await request(input, {
      scanByteBudget: 10_000,
      afterPass: () => { const { phase, checked } = snapshotPhase(); if (phase === 'v' && checked > 0) controller.abort(); },
      signal: controller.signal,
    });
    expect(controller.signal.aborted).toBe(true);
    expect(complete(first.result)).toBe(false);
    expect(first.result?.stored).toBe(8);
    const checked = snapshotPhase().checked;
    // Baseline and reading stay done; only the remaining verification runs.
    const second = await request(input, { scanByteBudget: 10_000 });
    expect(second.passes).toBe(1);
    expect(complete(second.result)).toBe(true);
    expect(second.result).toMatchObject({ stored: 0, duplicates: 0 });
    expect(second.result!.bytesRead).toBeLessThan(10_000);
    expect(checked).toBeGreaterThan(0);
  });
});

describe('What-I-said explicit backfill boundaries', () => {
  test('an interrupted import never lets ordinary capture read before consent or move its cursor; resuming deduplicates', () => {
    const input = setup();
    let body = '';
    for (let index = 0; index < 100; index++) body += claudeRecord(input.projectRoot, '2026-08-29T08:00:00Z', `pre-${index}-${'y'.repeat(400)}`);
    const file = claudeFile(input, 'history.jsonl', body);
    const common = { ...input, worktreeRoots: [input.projectRoot], now: NOW };
    expect(collectWhatISaidTranscripts(common).stored).toBe(0);
    const ordinaryCursor = () => readWhatISaidTranscriptCursor({ ...input, agent: 'claude', sourceIdentity: realpathSync(file) });
    const before = ordinaryCursor();
    const partial = collectWhatISaidTranscripts({ ...common, backfill: true, scanByteBudget: 8192 });
    expect(partial.hasMore).toBe(true);
    expect(partial.stored).toBeGreaterThan(0);
    expect(ordinaryCursor()).toEqual(before);
    // Ordinary capture after the interruption: still nothing from before consent.
    const ordinary = collectWhatISaidTranscripts({ ...common, now: '2026-08-30T12:11:00Z' });
    expect(ordinary.stored).toBe(0);
    expect(ordinary.skippedBeforeEnabled).toBe(0);
    expect(ordinaryCursor()).toEqual(before);
    expect(listWhatISaidEntries({ ...input, now: '2026-08-30T12:11:01Z', limit: 200 }).items).toHaveLength(partial.stored);
    appendFileSync(file, claudeRecord(input.projectRoot, '2026-08-30T12:11:30Z', 'post-consent'));
    expect(collectWhatISaidTranscripts({ ...common, now: '2026-08-30T12:12:00Z' }).stored).toBe(1);
    let more = true;
    let rounds = 0;
    let stored = partial.stored;
    let duplicates = 0;
    while (more && rounds++ < 40) {
      const result = collectWhatISaidTranscripts({ ...common, now: '2026-08-30T12:13:00Z', backfill: true, scanByteBudget: 8192 });
      more = result.hasMore;
      stored += result.stored;
      duplicates += result.duplicates;
    }
    expect(more).toBe(false);
    expect(stored).toBe(100);
    // The post-consent row is read again by the import and deduplicated.
    expect(duplicates).toBe(1);
    expect(listWhatISaidEntries({ ...input, now: '2026-08-30T12:14:00Z', limit: 200 }).items).toHaveLength(101);
  });

  test('a file larger than the default 8 MiB budget completes within one explicit request', async () => {
    const input = setup();
    const parts: string[] = [];
    for (let index = 0; index < 1_300; index++) parts.push(claudeRecord(input.projectRoot, '2026-08-29T08:00:00Z', `big-${index}-${'z'.repeat(10_000)}`));
    claudeFile(input, 'big.jsonl', parts.join(''));
    expect(collectWhatISaidTranscripts({ ...input, worktreeRoots: [input.projectRoot], now: NOW }).stored).toBe(0);
    const { result, passes } = await request(input);
    expect(passes).toBeGreaterThan(1);
    expect(result).toMatchObject({ stored: 1_300, hasMore: false, scanAdvanced: true });
  }, 30_000);

  test('a request aborted mid-way resumes on the next request without duplicates', async () => {
    const input = setup();
    let body = '';
    for (let index = 0; index < 60; index++) body += claudeRecord(input.projectRoot, '2026-08-29T08:00:00Z', `abort-${index}-${'q'.repeat(400)}`);
    claudeFile(input, 'history.jsonl', body);
    const controller = new AbortController();
    let pass = 0;
    const first = await request(input, { scanByteBudget: 4096, signal: controller.signal, afterPass: () => { if (++pass === 2) controller.abort(); } });
    expect(first.passes).toBe(2);
    expect(first.result).toMatchObject({ hasMore: true, scanAdvanced: false });
    const second = await request(input, { scanByteBudget: 4096 });
    expect(second.result).toMatchObject({ hasMore: false, scanAdvanced: true, duplicates: 0 });
    expect(first.result!.stored + second.result!.stored).toBe(60);
  });
});
