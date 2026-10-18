/**
 * 업데이트 뒤 작업 세션 이어 열기 (w14): the real terminal service. A graceful shutdown must not turn a session our own
 * shutdown killed into 「종료됨」 (R1); a running session is verified about a minute after its first request, before any
 * crash (R2); a session started with the approval bypass comes back without it. Fake PTY children, no CLI.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkroomConversationService } from '../src/workroomConversationService';
import { WORKROOM_HISTORY_VERSION } from '../src/workroomConversationProtocol';
import { AiTerminalService } from '../src/aiTerminalService';
import { claudeProjectSlugCandidates } from '../src/sessionTranscript';

const directories: string[] = [];
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const c of closers.splice(0).reverse()) { try { await c(); } catch { /* closed */ } } for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); });
const request = (operation: string, body: object = {}) => ({ protocolVersion: WORKROOM_HISTORY_VERSION, operation, ...body });

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workroom-restart-shutdown-'))); directories.push(root);
  const cwd = join(root, 'project'), provider = join(root, '.claude'); mkdirSync(cwd); mkdirSync(provider);
  const env = { HOME: root, CLAUDE_CONFIG_DIR: provider };
  const save = (id: string) => { const dir = join(provider, 'projects', claudeProjectSlugCandidates(cwd)[0]!); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, id + '.jsonl'), JSON.stringify({ type: 'user', message: { content: 'fixture only' } }) + '\n'); };
  const args: string[][] = [];
  /** One boot: a fresh journal, terminal service and fake PTY. A child ends as soon as any signal reaches it. */
  const boot = () => {
    const children = new Map<number, () => void>();
    let terminals!: AiTerminalService;
    const history = new WorkroomConversationService({
      appDataDir: root, platform: 'darwin', tickMs: 0, build: '700', processAlive: () => false,
      contexts: () => terminals.historySessions(), prepare: r => terminals.prepareHistoryContext(r),
      assertNoWriter: async () => {}, resolveBinding: async c => c.providerConversationId ?? null,
      launch: (r, requestId, cols, rows, historyResume) => terminals.perform({ operation: 'start', requestId, targetId: r.targetId, agent: r.agent, accountId: r.accountId, cols, rows }, undefined, { historyResume }),
    });
    terminals = new AiTerminalService({
      history, env, headlessScreen: false, activitySampler: false, resolveTarget: async () => ({ cwd }), executable: () => '/fixture/claude',
      signalGroup: pid => children.get(pid)?.(),
      spawn: (command, options: any) => {
        args.push(command); let finish!: (code: number) => void; const exited = new Promise<number>(resolve => { finish = resolve; });
        const pid = 600_000 + args.length; let ended = false;
        const end = () => { if (ended) return; ended = true; options.terminal.exit(); finish(0); };
        children.set(pid, end);
        return { pid, exited, kill: end, terminal: { write: () => 1, resize: () => {}, close: () => {} } };
      },
    });
    let stopped = false;
    const stop = async () => { if (stopped) return; stopped = true; await terminals.shutdown(); await history.shutdown(); };
    closers.push(stop);
    return { history, terminals, stop };
  };
  return { root, cwd, env, save, args, boot };
}

test('sessions our own shutdown ended come back as 앱 재시작으로 끊김, verified and in the offer (R1)', async () => {
  const f = fixture(), first = f.boot();
  const a = (await first.terminals.perform({ operation: 'start', requestId: randomUUID(), targetId: 'project-target-001', agent: 'claude', cols: 100, rows: 30, prompt: 'fixture request' })).session!;
  const b = (await first.terminals.perform({ operation: 'start', requestId: randomUUID(), targetId: 'project-target-001', agent: 'claude', cols: 100, rows: 30, prompt: 'second request' })).session!;
  f.save(a.id); f.save(b.id);
  await first.stop();
  const second = f.boot();
  const listed = await second.history.perform(request('list', { archived: false }));
  expect(listed.records!.map(r => r.state)).toEqual(['detached', 'detached']);
  expect(listed.records!.every(r => r.binding === 'verified')).toBe(true);
  const offer = (await second.history.perform(request('restart.list'))).restart!;
  expect(offer.rows.map(r => r.availability).sort()).toEqual(['ready', 'ready']);
  expect(offer.update).toBe(false);
  expect(f.args).toHaveLength(2); // listing launched nothing
});

test('a running session is verified at the next liveness tick once it has had input, before any exit (R2)', async () => {
  const f = fixture(), current = f.boot();
  const session = (await current.terminals.perform({ operation: 'start', requestId: randomUUID(), targetId: 'project-target-001', agent: 'claude', cols: 100, rows: 30 })).session!;
  f.save(session.id);
  await current.history.tick();
  const list = async () => (await current.history.perform(request('list', { archived: false }))).records![0]!;
  // No request yet: the tick spends nothing on it (the list's own opportunistic probe is not what is measured here).
  const journal = current.history.submissionJournal();
  expect(journal.forSession(session.id)?.binding).toBe('unverified');
  await current.terminals.perform({ operation: 'input', requestId: randomUUID(), sessionId: session.id, data: 'hello\r' });
  await current.history.tick();
  expect(journal.forSession(session.id)?.binding).toBe('verified');
  expect((await list()).state).toBe('running');
});

test('a session started with the approval bypass is marked, and comes back without it', async () => {
  const f = fixture(), first = f.boot();
  const started = (await first.terminals.perform({ operation: 'start', requestId: randomUUID(), targetId: 'project-target-001', agent: 'claude', cols: 100, rows: 30, prompt: 'bypassed request', bypassPermissions: true })).session!;
  f.save(started.id);
  expect(f.args[0]).toContain('bypassPermissions');
  await first.stop();
  const second = f.boot();
  const offer = (await second.history.perform(request('restart.list'))).restart!;
  const row = offer.rows[0]!;
  expect(row.bypass).toBe(true); expect(row.availability).toBe('ready');
  const review = await second.history.perform(request('resume.review', { storeInstanceId: second.history.storeId(), conversationId: row.id, expectedRevision: row.revision }));
  expect(review.review?.available).toBe(true);
  const result = await second.history.perform(request('resume.execute', { storeInstanceId: second.history.storeId(), conversationId: row.id, expectedRevision: review.review!.revision, reviewId: review.review!.id, requestId: randomUUID(), cols: 100, rows: 30 }));
  expect(result.resume?.state).toBe('completed');
  expect(f.args).toHaveLength(2);
  expect(f.args[1]).toContain('--resume'); expect(f.args[1]).toContain(started.id);
  expect(f.args[1]).not.toContain('bypassPermissions'); expect(f.args[1]).not.toContain('bypassed request');
  // The new session's own fact says it runs without the bypass.
  await second.stop();
  const third = f.boot();
  const again = (await third.history.perform(request('restart.list'))).restart!;
  expect(again.rows[0]!.bypass).toBe(false);
});
