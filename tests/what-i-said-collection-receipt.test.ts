import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginWhatISaidCollection, finishWhatISaidCollection, configureWhatISaidCapture, setWhatISaidRetention,
  captureWhatISaidWithheldTranscriptRecord, captureWhatISaidPrompt, softDeleteWhatISaidEntries, purgeWhatISaidEntries,
  probeWhatISaidCollectionReadOnly, readWhatISaidStatus, whatISaidDatabasePath } from '../src/whatISaidStore';
import { collectWhatISaidTranscripts, whatISaidCollectionScope } from '../src/whatISaidTranscriptCollector';
import { bracketUserMemoryHistoryScan, listUserInstructionHistory } from '../src/userMemoryHistoryServer';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'collection-receipt-')); roots.push(root);
  const input = { projectRoot: join(root, 'project'), appDataDir: join(root, 'data'), memoryId: 'receipt-memory',
    claudeProjectsDir: join(root, 'claude'), codexSessionsDir: join(root, 'codex'), key: Buffer.alloc(32, 8), now: '2026-10-29T00:00:00Z' };
  for (const path of [input.projectRoot, input.appDataDir, input.claudeProjectsDir, input.codexSessionsDir]) mkdirSync(path);
  configureWhatISaidCapture({ ...input, enabled: true, retention: 'forever', analysisAllowed: false });
  return input;
}
const complete = { complete: true, unreadable: 0, withheld: 0, scannedFrom: '2026-10-22T00:00:00Z', scannedThrough: '2026-10-29T00:00:00Z' };

test('history revision stays stable for inserts but changes atomically for deletion and purge', () => {
  const input = fixture(), scope = whatISaidCollectionScope(input);
  const first = captureWhatISaidPrompt({ ...input, agent: 'codex', sourceIdentity: 'fixture.jsonl', sourceEventIdentity: '1', recordedAt: input.now, text: 'one' });
  expect(first.stored).toBe(true);
  collectWhatISaidTranscripts({ ...input, now: '2026-10-29T00:00:01Z' });
  const revision = () => probeWhatISaidCollectionReadOnly({ ...input, scope })!.revision;
  const before = revision();
  const beforePage = probeWhatISaidCollectionReadOnly({ ...input, scope })!;
  const second = captureWhatISaidPrompt({ ...input, agent: 'codex', sourceIdentity: 'fixture.jsonl', sourceEventIdentity: '2', recordedAt: input.now, text: 'two' });
  expect(second.stored).toBe(true);
  expect(revision()).toBe(before);
  expect(bracketUserMemoryHistoryScan(beforePage, probeWhatISaidCollectionReadOnly({ ...input, scope }))).toMatchObject({ complete: true });
  expect(softDeleteWhatISaidEntries({ ...input, ids: [first.id!] }).softDeleted).toBe(1);
  const afterDelete = revision(); expect(afterDelete).not.toBe(before);
  expect(bracketUserMemoryHistoryScan(beforePage, probeWhatISaidCollectionReadOnly({ ...input, scope }))).toMatchObject({ complete: false, mutationChanged: true });
  expect(purgeWhatISaidEntries({ ...input, ids: [first.id!] }).purged).toBe(1);
  expect(revision()).not.toBe(afterDelete);
  expect(probeWhatISaidCollectionReadOnly({ ...input, scope })?.complete).toBe(true);
});

test('a read-only probe guards an expiry across independent SQLite reads without changing retention or reading content', async () => {
  const input = fixture(), scope = whatISaidCollectionScope(input);
  setWhatISaidRetention({ ...input, retention: 30 });
  expect(captureWhatISaidPrompt({ ...input, agent: 'codex', sourceIdentity: 'expiry.jsonl', sourceEventIdentity: '1', recordedAt: input.now, text: 'protected' }).stored).toBe(true);
  const before = readFileSync(whatISaidDatabasePath(input));
  const active = probeWhatISaidCollectionReadOnly({ ...input, scope, now: input.now })!;
  expect(active.nextExpiryAt).toBe('2026-11-28T00:00:00.000Z');
  const afterExpiry = probeWhatISaidCollectionReadOnly({ ...input, scope, now: '2026-11-28T00:00:00Z' })!;
  expect(afterExpiry.nextExpiryAt).toBeNull();
  expect(afterExpiry.revision).toBe(active.revision); // Time alone does not mutate the DB epoch.
  const bracket = bracketUserMemoryHistoryScan(active, afterExpiry)!;
  expect(bracket.nextExpiryAt).toBe(active.nextExpiryAt); // The earlier probe's bound survives the crossing.
  const page = await listUserInstructionHistory({ memoryId: input.memoryId,
    start: '2026-10-22T00:00:00Z', end: '2026-10-29T00:00:00Z',
    now: () => Date.parse('2026-11-28T00:00:00Z'),
    list: async () => ({ items: [], hasMore: false, scan: { ...bracket, complete: true, scannedThrough: '2026-10-29T00:00:00Z' } }) });
  expect(page).toMatchObject({ complete: false, hits: [], nextCursor: null, coverage: { retentionGuard: 'expired' } });
  expect(page.incomplete).toContain('retention-expired');
  const reversed = bracketUserMemoryHistoryScan({ ...active, observedAt: 2 }, { ...afterExpiry, observedAt: 1 })!;
  expect(reversed.clockGuard).toBe('reversed');
  const reversedPage = await listUserInstructionHistory({ memoryId: input.memoryId,
    start: '2026-10-22T00:00:00Z', end: '2026-10-29T00:00:00Z', now: () => Date.parse('2026-10-29T00:00:01Z'),
    list: async () => ({ items: [{ id: 'fixture', seq: '1', memoryId: input.memoryId, recordedAt: '2026-10-24T00:00:00Z', text: 'fixture' }],
      hasMore: false, scan: { ...reversed, complete: true, scannedThrough: '2026-10-29T00:00:00Z' } }) });
  expect(reversedPage).toMatchObject({ complete: false, hits: [], nextCursor: null, coverage: { clockGuard: 'reversed' } });
  expect(reversedPage.incomplete).toContain('clock-reversed');
  expect(readFileSync(whatISaidDatabasePath(input)).equals(before)).toBe(true);
});

test('a current scan receipt preserves and discloses past withheld receipts without claiming complete historical capture', () => {
  const input = fixture();
  captureWhatISaidWithheldTranscriptRecord({ ...input, agent: 'codex', sourceIdentity: 'old.jsonl', sourceEventIdentity: '1', recordBytes: 100, reason: 'record-malformed' });
  const scan = collectWhatISaidTranscripts(input);
  expect(scan.withheld).toBe(0);
  expect(probeWhatISaidCollectionReadOnly({ ...input, scope: whatISaidCollectionScope(input) })).toMatchObject({ complete: true, withheld: 0, historicalWithheld: 1 });
  expect(readWhatISaidStatus(input).counts.withheld).toBe(1);
});

test('only a finalized collector produces a durable receipt, including across a new process', () => {
  const input = fixture(), scope = whatISaidCollectionScope(input);
  expect(probeWhatISaidCollectionReadOnly({ ...input, scope })?.complete).toBeUndefined();
  const result = collectWhatISaidTranscripts(input);
  expect(result.scanAdvanced).toBe(true);
  expect(probeWhatISaidCollectionReadOnly({ ...input, scope })).toMatchObject({ complete: true, unreadable: 0, withheld: 0 });
  const before = readFileSync(whatISaidDatabasePath(input));
  const read = Bun.spawnSync(['bun', '-e', `import {probeWhatISaidCollectionReadOnly} from './src/whatISaidStore';
    process.stdout.write(JSON.stringify(probeWhatISaidCollectionReadOnly(JSON.parse(process.argv[1]))));`,
    JSON.stringify({ appDataDir: input.appDataDir, projectRoot: input.projectRoot, memoryId: input.memoryId, scope })], { cwd: join(import.meta.dir, '..') });
  expect(read.exitCode).toBe(0); expect(JSON.parse(read.stdout.toString())).toMatchObject({ complete: true });
  expect(readFileSync(whatISaidDatabasePath(input)).equals(before)).toBe(true);
  expect(probeWhatISaidCollectionReadOnly({ ...input, scope: 'f'.repeat(64) })?.complete).toBeUndefined();
});

test('in-progress, failed, overlapping, and consent ABA scans cannot reuse an older successful proof', () => {
  const input = fixture(), scope = whatISaidCollectionScope(input);
  collectWhatISaidTranscripts(input);
  const older = beginWhatISaidCollection(input)!;
  expect(probeWhatISaidCollectionReadOnly({ ...input, scope })?.complete).toBeUndefined();
  const newer = beginWhatISaidCollection(input)!;
  expect(finishWhatISaidCollection({ ...input, ticket: older, scope, result: complete })).toBe(false);
  expect(finishWhatISaidCollection({ ...input, ticket: newer, scope, result: { ...complete, complete: false, unreadable: 1 } })).toBe(true);
  expect(probeWhatISaidCollectionReadOnly({ ...input, scope })).toMatchObject({ complete: false, unreadable: 1 });
  const ticket = beginWhatISaidCollection(input)!;
  const revision = probeWhatISaidCollectionReadOnly({ ...input, scope })!.revision;
  setWhatISaidRetention({ ...input, retention: 30 }); setWhatISaidRetention({ ...input, retention: 'forever' });
  expect(probeWhatISaidCollectionReadOnly({ ...input, scope })!.revision).not.toBe(revision);
  expect(finishWhatISaidCollection({ ...input, ticket, scope, result: complete })).toBe(false);
  collectWhatISaidTranscripts(input);
  expect(() => collectWhatISaidTranscripts({ ...input, scanByteBudget: -1 })).toThrow();
  expect(probeWhatISaidCollectionReadOnly({ ...input, scope })?.complete).toBeUndefined();
  const partial = collectWhatISaidTranscripts({ ...input, scanShouldStop: () => true });
  expect(partial.hasMore).toBe(true);
  expect(probeWhatISaidCollectionReadOnly({ ...input, scope })).toMatchObject({ complete: false });
});

test('v6 timestamps are not collection proof and a read never migrates an older database', () => {
  const input = fixture(); collectWhatISaidTranscripts(input);
  const db = new Database(whatISaidDatabasePath(input));
  db.exec(`ALTER TABLE what_i_said_settings DROP COLUMN collection_epoch;
    ALTER TABLE what_i_said_settings DROP COLUMN collection_attempt;
    ALTER TABLE what_i_said_settings DROP COLUMN collection_receipt;
    UPDATE what_i_said_settings SET schema_version = 6; PRAGMA user_version = 6;`); db.close();
  const before = readFileSync(whatISaidDatabasePath(input));
  expect(probeWhatISaidCollectionReadOnly({ ...input, scope: whatISaidCollectionScope(input) })).toBeNull();
  expect(readFileSync(whatISaidDatabasePath(input)).equals(before)).toBe(true);
  readWhatISaidStatus(input); // A normal store operation performs the lossless v6→v7 migration.
  expect(probeWhatISaidCollectionReadOnly({ ...input, scope: whatISaidCollectionScope(input) })?.complete).toBeUndefined();
  collectWhatISaidTranscripts(input);
  expect(probeWhatISaidCollectionReadOnly({ ...input, scope: whatISaidCollectionScope(input) })?.complete).toBe(true);
});
