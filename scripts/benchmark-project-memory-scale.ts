import { spawnSync } from 'node:child_process';
import { closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Synthetic source only. Fixture generation and every measured operation run in
// separate processes. Stream accepts 1M; deliberately opt in to all-history APIs.
// bun scripts/benchmark-project-memory-scale.ts 10000 100000 1000000 --body-bytes=1024
// bun scripts/benchmark-project-memory-scale.ts 100000 --modes=stream,read,recall --body-bytes=1024
const script = fileURLToPath(import.meta.url);
const phase = process.argv[2];
if (phase === '--generate') {
  const [root, countArg, bodyArg] = process.argv.slice(3), count = Number(countArg), bodyBytes = Number(bodyArg);
  const { initializeProjectMemory, buildProjectMemoryJournalEntry, renderProjectMemoryJournalEntry } = await import('../project-memory-server');
  initializeProjectMemory({ folderPath: root!, projectName: 'Synthetic scale fixture', agent: 'codex' });
  const dir = join(root!, '.agent-memory/journal');
  // This disposable synthetic fixture excludes initialization's real journal entry.
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const path = join(dir, '2026-01.md'), fd = openSync(path, 'w');
  let lastHash = '', bodyTotal = 0, buffered = '';
  try {
    for (let i = 0; i < count; i++) {
      const prefix = `Synthetic ${i} ${i === count - 1 ? 'phoenixledger' : 'ordinary'} 검증 기록 `;
      const narrative = prefix + 'x'.repeat(Math.max(0, bodyBytes - Buffer.byteLength(prefix)));
      const entry = buildProjectMemoryJournalEntry({ recordedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(), narrative });
      lastHash = entry.entryHash; bodyTotal += Buffer.byteLength(entry.body);
      buffered += renderProjectMemoryJournalEntry(entry) + '\n';
      if (i % 500 === 499) { writeFileSync(fd, buffered); buffered = ''; }
    }
    if (buffered) writeFileSync(fd, buffered);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  writeFileSync(join(root!, 'fixture.json'), JSON.stringify({ count, bodyBytes, bodyTotal, fileBytes: statSync(path).size, lastHash }));
} else if (phase === '--measure') {
  const [root, mode] = process.argv.slice(3), fixture = JSON.parse(readFileSync(join(root!, 'fixture.json'), 'utf8'));
  const baselineRss = process.memoryUsage().rss, start = performance.now();
  let elapsedMs = 0, warmMs: number | undefined, records = 0, metrics: unknown;
  if (mode === 'stream') {
    const { streamProjectMemoryJournalFile } = await import('../src/projectMemoryJournalStream');
    const measured = { bytesRead: 0, records: 0, maxBufferedBytes: 0 };
    let lastHash = '';
    for (const entry of streamProjectMemoryJournalFile(join(root!, '.agent-memory/journal/2026-01.md'), { metrics: measured })) { records++; lastHash = entry.entryHash; }
    if (lastHash !== fixture.lastHash) throw new Error('Streaming lost final evidence');
    metrics = measured;
    elapsedMs = performance.now() - start;
  } else {
    const { readProjectMemoryJournal, recallProjectMemory } = await import('../project-memory-server');
    if (mode === 'read') {
      records = readProjectMemoryJournal(root!).length;
      elapsedMs = performance.now() - start;
    } else if (mode === 'recall') {
      const recall = () => recallProjectMemory({ folderPath: root!, appDataDir: join(root!, 'cache'), query: 'phoenixledger' });
      const cold = recall(); elapsedMs = performance.now() - start;
      const warmStart = performance.now(), warm = recall(); warmMs = performance.now() - warmStart;
      if (cold.journalHits[0]?.entryHash !== fixture.lastHash || warm.journalHits[0]?.entryHash !== fixture.lastHash) throw new Error('Recall lost final evidence');
      records = cold.journalSearch.indexedEntries;
    } else throw new Error('Unknown measurement');
  }
  if (records !== fixture.count) throw new Error(`Incomplete records: ${records}/${fixture.count}`);
  // Bun 1.3.14 on macOS reports bytes here, cross-checked with /usr/bin/time -l.
  // Other runtime/platform units need their own calibration.
  console.log(JSON.stringify({ mode, ...fixture, records, elapsedMs: Math.round(elapsedMs),
    ...(warmMs === undefined ? {} : { warmMs: Math.round(warmMs) }), metrics,
    baselineRssBytes: baselineRss, runtimeMaxRSS: process.resourceUsage().maxRSS,
    maxRssUnit: process.platform === 'darwin' && Bun.version === '1.3.14' ? 'bytes' : 'runtime-dependent',
    runtime: Bun.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model }));
} else {
  const args = process.argv.slice(2), sizes = args.filter(a => !a.startsWith('--')).map(Number);
  if (!sizes.length) sizes.push(10_000, 100_000);
  const bodyBytes = Number(args.find(a => a.startsWith('--body-bytes='))?.split('=')[1] ?? 1024);
  const modes = (args.find(a => a.startsWith('--modes='))?.split('=')[1] ?? 'stream').split(',');
  if (sizes.some(n => !Number.isSafeInteger(n) || n < 1 || n > 1_000_000)
    || !Number.isSafeInteger(bodyBytes) || bodyBytes < 64 || bodyBytes > 8192
    || modes.some(m => !['stream', 'read', 'recall'].includes(m))) throw new Error('Invalid size, body budget or modes');
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 600_000, maxBuffer: 1024 * 1024 });
    if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr ?? `Worker exit ${result.status}`);
    process.stdout.write(result.stdout);
  };
  for (const size of sizes) {
    const root = mkdtempSync(join(tmpdir(), 'agentstoz-memory-scale-'));
    try {
      run(['--generate', root, String(size), String(bodyBytes)]);
      for (const mode of modes) run(['--measure', root, mode]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
}
