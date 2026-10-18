import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProjectMemoryJournalEntry, renderProjectMemoryJournalEntry } from '../project-memory-server';
import { MAX_JOURNAL_RECORD_BYTES, streamProjectMemoryJournalFile } from '../src/projectMemoryJournalStream';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function source(text: string) {
  const root = mkdtempSync(join(tmpdir(), 'journal-stream-')); roots.push(root);
  const path = join(root, '2026-09.md'); writeFileSync(path, text); return path;
}
const entry = (narrative: string) => buildProjectMemoryJournalEntry({ recordedAt: '2026-09-01T12:34:56Z', agent: 'codex', narrative });

test('UTF-8 boundaries, corrupt frame and torn tail preserve later verified evidence', () => {
  const a = entry('한글 🔎 첫 기록'), b = entry('두 번째 기록');
  const path = source(`${renderProjectMemoryJournalEntry(a)}\n<!-- entry-v2:broken -->\n${renderProjectMemoryJournalEntry(b)}\n<!-- entry-v2:torn`);
  const metrics = { bytesRead: 0, records: 0, maxBufferedBytes: 0 };
  expect([...streamProjectMemoryJournalFile(path, { chunkBytes: 1, metrics })]).toEqual([a, b]);
  expect(metrics.bytesRead).toBe(Buffer.byteLength(readFileSync(path, 'utf8')));
  expect(metrics.records).toBe(2);
});

test('both legacy layouts preserve verified summary, inert marker prose and unverified history', () => {
  const a = entry('한글 근거\n<!-- entry:abcdef -->\nnot a timestamp');
  const summary = `<!-- summary:${Buffer.from(a.summary).toString('base64url')} -->`;
  for (const headingFirst of [false, true]) {
    const mark = `<!-- entry:${a.entryHash} -->`, head = `## ${a.recordedAt} · codex`;
    const first = headingFirst ? `${head}\n${mark}` : `${mark}\n${head}`;
    const path = source(`# Journal\n${first}\n${summary}\n${a.body}\n\n<!-- entry:1234abcd -->\n## 2020-01-01T00:00:00Z · claude\nold evidence\n`);
    expect([...streamProjectMemoryJournalFile(path, { chunkBytes: 7 })]).toEqual([a, {
      entryHash: '1234abcd', recordedAt: '2020-01-01T00:00:00Z', agent: 'claude', headCommit: null,
      summary: 'old evidence', body: 'old evidence', integrity: 'legacy-unverified',
    }]);
  }
});

test('v2 precedes legacy candidates in a mixed file just as the previous reader did', () => {
  const current = entry('verified frame');
  const path = source(`<!-- entry:abc12345 -->\n## 2020-01-01T00:00:00Z\nold body\n${renderProjectMemoryJournalEntry(current)}\n`);
  const rows = [...streamProjectMemoryJournalFile(path)];
  expect(rows[0]).toEqual(current);
  expect(rows[1]!.body).toContain(renderProjectMemoryJournalEntry(current));
});

test('oversized newline-free input fails explicitly and never alters source bytes', () => {
  const text = 'x'.repeat(MAX_JOURNAL_RECORD_BYTES + 1), path = source(text);
  expect(() => [...streamProjectMemoryJournalFile(path)]).toThrow('읽기 예산');
  expect(readFileSync(path, 'utf8')).toBe(text);
});

test('a writer changing the file during streaming prevents a complete generation', () => {
  const path = source(`${renderProjectMemoryJournalEntry(entry('one'))}\n`);
  const it = streamProjectMemoryJournalFile(path);
  expect(it.next().done).toBe(false);
  appendFileSync(path, `${renderProjectMemoryJournalEntry(entry('two'))}\n`);
  expect(() => it.next()).toThrow('변경');
});
