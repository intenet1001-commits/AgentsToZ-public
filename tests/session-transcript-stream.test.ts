import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractCodexExcerpts, extractOwnedClaudeSessionExcerpts, renderSessionContext, type SessionExcerpt } from '../src/sessionTranscript';
import { BoundedSessionContext, collectSessionTranscriptFile, SESSION_TRANSCRIPT_MAX_RECORD_BYTES, visitBoundedSessionJsonl } from '../src/sessionTranscriptStream';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temporaryRoot() { const root = mkdtempSync(join(tmpdir(), 'agentstoz-transcript-stream-')); roots.push(root); return root; }
const line = (value: unknown) => JSON.stringify(value);
const rendered = (excerpts: SessionExcerpt[], budget: number) => renderSessionContext([...excerpts].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)), budget);

test('online context matches the old sorted suffix for unsorted timestamps, equal timestamps, long messages and cutoff barriers', () => {
  let seed = 1234567;
  const random = () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return seed >>> 0; };
  for (const budget of [1, 75, 250, 4_000, 48_000]) {
    const context = new BoundedSessionContext(budget), excerpts: SessionExcerpt[] = [];
    for (let i = 0; i < 250; i++) {
      const excerpt: SessionExcerpt = { role: random() % 2 ? 'user' : 'assistant', recordedAt: ['', '2026-09-07T00:00:01Z', '2026-09-06T00:00:01Z'][random() % 3]!, text: `메시지 ${i} ` + '한😀'.repeat(random() % 2_000) };
      excerpts.push(excerpt); context.add(excerpt);
      expect(context.retainedBytes).toBeLessThanOrEqual(budget);
      expect(context.render()).toBe(rendered(excerpts, budget));
    }
    expect(context.excerpts).toBe(excerpts.length);
  }
  const cutoff = new BoundedSessionContext(100);
  const rows: SessionExcerpt[] = [
    { role: 'user', recordedAt: 'b', text: 'x'.repeat(85) },
    { role: 'user', recordedAt: 'c', text: 'y'.repeat(60) },
    { role: 'user', recordedAt: 'a', text: 'old' },
  ];
  rows.forEach(row => cutoff.add(row)); expect(cutoff.render()).toBe(rendered(rows, 100));
});

test('JSONL streaming preserves split UTF-8, CRLF and EOF, skips oversized and malformed UTF-8 records, and keeps later lines', () => {
  const root = temporaryRoot(), path = join(root, 'input.jsonl');
  writeFileSync(path, Buffer.concat([
    Buffer.from('한글😀\r\n' + 'x'.repeat(35) + '\n'), Buffer.from([0xff, 10]), Buffer.from('마지막 줄'),
  ]));
  const lines: string[] = []; let unreadable = 0;
  visitBoundedSessionJsonl(path, value => lines.push(value), () => unreadable++, { chunkBytes: 5, maxRecordBytes: 32 });
  expect(lines).toEqual(['한글😀', '마지막 줄']); expect(unreadable).toBe(2);
  expect(() => visitBoundedSessionJsonl(path, () => { throw new Error('caller failure'); }, () => {}, { chunkBytes: 5 })).toThrow('caller failure');
  // Repeated successful reads after the exceptional callback exercise the same
  // descriptor lifecycle without needing platform-specific /proc inspection.
  for (let i = 0; i < 20; i++) visitBoundedSessionJsonl(path, () => {}, () => {});
});

test('a transcript scan ignores appends beyond its snapshot and reports a concurrent truncation', () => {
  const root = temporaryRoot(), path = join(root, 'changing.jsonl');
  writeFileSync(path, 'first\nsecond\n');
  const appended: string[] = []; let unreadable = 0;
  visitBoundedSessionJsonl(path, value => { appended.push(value); if (value === 'first') appendFileSync(path, 'third\n'); }, () => unreadable++, { chunkBytes: 6 });
  expect(appended).toEqual(['first', 'second']); expect(unreadable).toBe(0);
  const truncated: string[] = [];
  visitBoundedSessionJsonl(path, value => { truncated.push(value); if (value === 'first') truncateSync(path, 6); }, () => unreadable++, { chunkBytes: 6 });
  expect(truncated).toEqual(['first']); expect(unreadable).toBe(1);
});

test('streamed Claude and Codex extraction preserves ownership, since filtering, skipped wrappers and chronological rendering', () => {
  const root = temporaryRoot(), owned = join(root, 'owned'), other = join(root, 'other'); mkdirSync(owned); mkdirSync(other);
  const claude = [
    line({ type: 'user', cwd: owned, timestamp: '2026-09-07T00:00:02Z', message: { content: '이어서 처리해 주세요' } }),
    line({ type: 'assistant', cwd: owned, timestamp: '2026-09-07T00:00:01Z', message: { content: [{ type: 'tool_use', name: 'ignored' }, { type: 'text', text: '한글 응답😀' }] } }),
    line({ type: 'user', cwd: other, timestamp: '2026-09-07T00:00:03Z', message: { content: 'foreign' } }),
    line({ type: 'user', message: { content: 'missing cwd' } }), '{bad json',
    line({ type: 'user', cwd: owned, timestamp: '2026-09-06T00:00:01Z', message: { content: 'old' } }),
    line({ type: 'user', cwd: owned, message: { content: '<system-reminder>ignored' } }),
  ];
  const codex = [
    line({ type: 'event_msg', timestamp: '2026-09-07T00:00:02Z', payload: { type: 'agent_message', message: '같은 시각의 다음 답' } }),
    line({ type: 'event_msg', timestamp: '2026-09-06T00:00:01Z', payload: { type: 'user_message', message: 'old' } }),
    line({ type: 'event_msg', payload: { type: 'agent_reasoning', message: 'ignored' } }),
  ];
  const sinceIso = '2026-09-07T00:00:00Z', expected = extractOwnedClaudeSessionExcerpts(claude, sinceIso, [owned]);
  const context = new BoundedSessionContext(48_000), claudePath = join(root, 'claude.jsonl'), codexPath = join(root, 'codex.jsonl');
  writeFileSync(claudePath, claude.join('\n')); writeFileSync(codexPath, codex.join('\r\n') + '\r\n');
  expect(collectSessionTranscriptFile({ path: claudePath, agent: 'claude', sinceIso, exactRoots: [owned], context })).toEqual({ unreadable: expected.unreadable, ownershipRejected: expected.ownershipRejected });
  collectSessionTranscriptFile({ path: codexPath, agent: 'codex', sinceIso, exactRoots: [owned], context });
  expect(context.render()).toBe(rendered([...expected.excerpts, ...extractCodexExcerpts(codex, sinceIso)], 48_000));
});

test('a large transcript and an oversized tool record retain bounded context and do not hide the final Korean message', () => {
  const root = temporaryRoot(), path = join(root, 'large.jsonl');
  writeFileSync(path, '{"tool":"' + 'x'.repeat(SESSION_TRANSCRIPT_MAX_RECORD_BYTES + 100) + '"}\n');
  for (let i = 0; i < 1_000; i++) appendFileSync(path, line({ type: 'event_msg', timestamp: `2026-09-07T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`, payload: { type: 'agent_message', message: `${i} ` + 'x'.repeat(8_000) } }) + '\n');
  appendFileSync(path, line({ type: 'event_msg', timestamp: '2026-09-07T01:00:00Z', payload: { type: 'user_message', message: '마지막 결론을 기억해 주세요😀' } }));
  const context = new BoundedSessionContext(48_000);
  const result = collectSessionTranscriptFile({ path, agent: 'codex', sinceIso: null, exactRoots: [root], context });
  expect(result.unreadable).toBe(1); expect(context.excerpts).toBe(1_001);
  expect(context.retainedBytes).toBeLessThanOrEqual(48_000);
  expect(context.render()).toContain('마지막 결론을 기억해 주세요😀');
  expect(context.render().includes(']\n0 xxxxx')).toBe(false);
});

test.each(['claude-oversized', 'codex-owned-invalid', 'codex-unowned-invalid'] as const)('session-end guard distinguishes owned incomplete input from unowned headers: %s', async scenario => {
  const home = temporaryRoot(), project = join(home, 'project'), memory = join(project, '.agent-memory');
  mkdirSync(memory, { recursive: true });
  const source = '# Project Core Memory\n\n## Key Decisions\n\nKeep prior memory intact.\n';
  const config = JSON.stringify({ schemaVersion: 1, memoryId: '9ee1a4c0-1e60-44c8-9d98-afd5aa667e1e', sourcePath: '.agent-memory/CORE.md', agent: 'claude', autoBackup: false, lastRememberedAt: '2026-09-06T00:00:00Z', lastRememberedActivityFingerprint: 'unchanged-baseline' });
  writeFileSync(join(memory, 'CORE.md'), source); writeFileSync(join(memory, 'config.json'), config);
  const claudeDir = join(home, '.claude/projects', realpathSync(project).replace(/[/_.]/g, '-'));
  mkdirSync(claudeDir, { recursive: true });
  if (scenario === 'claude-oversized') {
    writeFileSync(join(claudeDir, 'incomplete.jsonl'), 'x'.repeat(SESSION_TRANSCRIPT_MAX_RECORD_BYTES + 1) + '\n');
  } else {
    const codexDir = join(home, '.codex/sessions'); mkdirSync(codexDir, { recursive: true });
    const header = line({ type: 'session_meta', payload: { cwd: realpathSync(project) } });
    const message = line({ type: 'event_msg', timestamp: '2026-09-07T00:00:00Z', payload: { type: 'user_message', message: 'owned message' } });
    writeFileSync(join(codexDir, 'rollout-owned.jsonl'), header + '\n' + (scenario === 'codex-owned-invalid' ? '{broken json\n' : message + '\n'));
    writeFileSync(join(codexDir, 'rollout-unknown.jsonl'), '{unreadable header\n');
  }
  const serverModule = new URL('../project-memory-server.ts', import.meta.url).href;
  const script = join(home, 'probe.ts');
  writeFileSync(script, `
    import { sessionEndProjectMemory } from ${JSON.stringify(serverModule)};
    import { existsSync, readFileSync } from 'node:fs';
    import { join } from 'node:path';
    const project = process.argv[2]!;
    Bun.spawn = (() => { throw new Error('UNEXPECTED_PROVIDER_SPAWN'); }) as typeof Bun.spawn;
    const original = Bun.spawnSync;
    Bun.spawnSync = ((...args: any[]) => {
      if (Array.isArray(args[0]) && args[0][0] === 'git') return (original as any)(...args);
      throw new Error('UNEXPECTED_SYNC_SPAWN');
    }) as typeof Bun.spawnSync;
    let code = 'NO_ERROR';
    try { await sessionEndProjectMemory({ folderPath: project, autoBackup: false, portalDataFile: join(project, 'unused-portal.json') }); }
    catch (error: any) { code = error.code ?? error.message; }
    console.log(JSON.stringify({code, core: readFileSync(join(project, '.agent-memory/CORE.md'), 'utf8'), config: readFileSync(join(project, '.agent-memory/config.json'), 'utf8'), journalCreated: existsSync(join(project, '.agent-memory/journal'))}));
  `);
  const child = Bun.spawn([process.execPath, script, project], {
    env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'appdata'), XDG_CONFIG_HOME: join(home, '.config') },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit, stderr).toBe(0);
  expect(JSON.parse(stdout)).toEqual({
    code: scenario === 'codex-unowned-invalid' ? 'UNEXPECTED_PROVIDER_SPAWN' : 'PROJECT_MEMORY_TRANSCRIPT_INCOMPLETE',
    core: source, config, journalCreated: false,
  });
}, 30_000);
