/**
 * 업데이트 뒤 작업 세션 이어 열기 (w14) — the regressions of its review (exactly-once and truthfulness). Each test is a
 * reviewer's repro made deterministic: two rows of one provider conversation are opened once; a running Codex that never
 * spoke never takes a neighbour's rollout (tick, shutdown); a derivation is joint; `ready` is said only after this Mac
 * checked the fingerprints; the phone never says 「이어 열기」 from the row alone; a dismissal of a superseded offer keeps
 * its rows closed; a concurrent list never moves a reviewed row; a project that cannot be prepared is not counted; an
 * offer of sessions that can never be reopened is shown once; the phone is told whether it may close the offer and how
 * many sessions it may not see. Real SQLite journals in a temp folder, fixture transcripts and rollouts. No CLI or network.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, unlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkroomConversationJournal, WORKROOM_PROVIDER_BUSY, type WorkroomJournalOptions } from '../src/workroomConversationJournal';
import { WorkroomConversationService } from '../src/workroomConversationService';
import { workroomSessionContext } from '../src/workroomConversationIdentity';
import { WORKROOM_HISTORY_VERSION, normalizeWorkroomHistoryResult } from '../src/workroomConversationProtocol';
import { claudeProjectSlugCandidates } from '../src/sessionTranscript';
import { createRemoteWorkroomHistoryHost, type RemoteHistoryAccess } from '../src/workroomHistoryRemoteHost';
import { REMOTE_HISTORY_NOT_RECORDED, remoteHistoryOutcomeText } from '../src/remoteWorkroomHistoryClient';
import { restartRowLabeler, RESTART_AVAILABILITY_PHRASE } from '../src/workroomRestartText';
import type { WorkroomSessionContext } from '../src/workroomConversationHost';
import type { AiTerminalAgent } from '../src/aiTerminalProtocol';

const BOOT_A = 'boot-aaaa-0001', BOOT_B = 'boot-bbbb-0002', BOOT_C = 'boot-cccc-0003';
const TARGET = 'project-target-001', CONTROL = 'control_' + 'T'.repeat(36);
const directories: string[] = [];
const closers: (() => unknown)[] = [];
afterEach(async () => { for (const c of closers.splice(0).reverse()) { try { await c(); } catch { /* already closed */ } } for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workroom-restart-review-'))); directories.push(root);
  const cwd = join(root, 'project'), claudeHome = join(root, '.claude'), codexHome = join(root, '.codex');
  mkdirSync(cwd); mkdirSync(claudeHome); mkdirSync(codexHome);
  const env = { HOME: root, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome };
  let clock = Date.parse('2026-10-16T01:00:00.000Z');
  const now = () => new Date(clock).toISOString();
  const context = (agent: AiTerminalAgent = 'claude', extra: Partial<WorkroomSessionContext> = {}) => {
    const summary = { id: randomUUID(), targetId: TARGET, agent, state: 'running' as const, createdAt: now(), exitCode: null, cols: 100, rows: 30, accountId: 'host-default' };
    return { ...workroomSessionContext(summary, cwd, env, false, agent === 'claude' ? summary.id : undefined), ...extra };
  };
  const ended = (c: WorkroomSessionContext): WorkroomSessionContext => ({ ...c, summary: { ...c.summary, state: 'exited' } });
  const saveClaude = (id: string) => { const dir = join(claudeHome, 'projects', claudeProjectSlugCandidates(cwd)[0]!); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, id + '.jsonl'), JSON.stringify({ type: 'user', message: { content: 'fixture only' } }) + '\n'); };
  const pad = (n: number) => String(n).padStart(2, '0');
  const rollout = (id: string, at: number) => {
    const d = new Date(at), dir = join(codexHome, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
    mkdirSync(dir, { recursive: true });
    const name = `rollout-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${id}.jsonl`;
    const meta = { type: 'session_meta', payload: { id, cwd, timestamp: d.toISOString(), source: 'cli', originator: 'codex-tui' } };
    writeFileSync(join(dir, name), JSON.stringify(meta) + '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'fixture' } }) + '\n');
  };
  const open = (bootId: string, options: WorkroomJournalOptions = {}) => {
    const journal = new WorkroomConversationJournal(root, now, bootId, { build: '700', pid: 4_000_000, alive: () => false, ...options });
    closers.push(() => journal.close());
    return journal;
  };
  return { root, cwd, env, codexHome, context, ended, saveClaude, rollout, open, now, advance: (ms: number) => { clock += ms; }, at: () => clock };
}
type Fixture = ReturnType<typeof fixture>;
const request = (operation: string, body: object = {}) => ({ protocolVersion: WORKROOM_HISTORY_VERSION, operation, ...body });
function service(f: Fixture, journal: WorkroomConversationJournal, options: { prepare?: (record: any) => WorkroomSessionContext; contexts?: () => WorkroomSessionContext[] } = {}) {
  const launched: string[] = [];
  const history = new WorkroomConversationService({
    appDataDir: f.root, journal, platform: 'darwin', contexts: options.contexts ?? (() => []), tickMs: 0, assertNoWriter: async () => {},
    prepare: async record => options.prepare?.(record) ?? workroomSessionContext({ id: record.sessionId, targetId: record.targetId, agent: record.agent, state: 'exited', createdAt: record.createdAt, exitCode: null, cols: 100, rows: 30, accountId: record.accountId }, f.cwd, f.env, false),
    launch: async (record, _requestId, _cols, _rows, binding) => {
      const summary = { id: randomUUID(), targetId: record.targetId, agent: record.agent, state: 'running' as const, createdAt: f.now(), exitCode: null, cols: 100, rows: 30, accountId: record.accountId };
      const context = workroomSessionContext(summary, f.cwd, f.env, false, binding.resume.conversationId);
      await binding.validate(context); binding.launching(); launched.push(binding.resume.conversationId);
      journal.started(context, binding.logicalConversationId); return { session: context.summary };
    },
  });
  closers.push(() => history.shutdown());
  return { history, launched };
}
const press = async (history: WorkroomConversationService, journal: WorkroomConversationJournal, id: string, revision: number, requestId: string) => {
  const review = (await history.perform(request('resume.review', { storeInstanceId: journal.storeInstanceId, conversationId: id, expectedRevision: revision }))).review!;
  if (!review.available) return 'unavailable';
  try { return (await history.perform(request('resume.execute', { storeInstanceId: journal.storeInstanceId, conversationId: id, expectedRevision: review.revision, reviewId: review.id, requestId, cols: 100, rows: 30 }))).resume!.state; }
  catch (error) { return 'refused: ' + (error as Error).message; }
};

describe('exactly once per provider conversation (review finding 1)', () => {
  test('two rows that name one Codex thread: two windows pressing at once launch it once', async () => {
    const f = fixture(), a = f.open(BOOT_A), thread = randomUUID();
    const first = f.context('codex'), second = f.context('codex');
    const r1 = a.started(first), r2 = a.started(second);
    f.rollout(thread, f.at() + 1_000);
    // A Codex `/resume` inside the second session reopened the first one's thread: both rows name it.
    a.observe(first, thread); a.observe(second, thread);
    a.close(); f.advance(30_000);
    const b = f.open(BOOT_B), { history, launched } = service(f, b);
    const rows = (await history.perform(request('restart.list'))).restart!.rows;
    const outcomes = await Promise.all(rows.map((row, index) => press(history, b, row.id, row.revision, 'request-window-000' + index)));
    expect(launched.filter(id => id === thread)).toHaveLength(1);
    expect(outcomes.filter(o => o === 'completed')).toHaveLength(1);
    expect(outcomes.some(o => o.includes(WORKROOM_PROVIDER_BUSY))).toBe(true);
    // The other row now says where its conversation is, instead of 「이어 열 수 있음」.
    const other = [r1, r2].map(r => b.get(r.id)).find(r => r.state !== 'running')!;
    expect(history.availability(other)).toBe('open-elsewhere');
  });
  test('the reservation refuses a row whose conversation another row holds (prepared, or an unknown outcome)', () => {
    const f = fixture(), a = f.open(BOOT_A), thread = randomUUID();
    const first = f.context('codex'), second = f.context('codex');
    const r1 = a.started(first), r2 = a.started(second); f.rollout(thread, f.at() + 1_000);
    a.observe(f.ended(first), thread); a.observe(f.ended(second), thread);
    const one = a.get(r1.id); a.prepareResume(one.id, one.revision, 'resume-request-0001', { fixture: 1 });
    expect(() => a.prepareResume(r2.id, a.get(r2.id).revision, 'resume-request-0002', { fixture: 2 })).toThrow(WORKROOM_PROVIDER_BUSY);
    a.close();
    // After a restart the first is `unknown`: it may have opened the conversation, so the second is still refused.
    const b = f.open(BOOT_B);
    expect(b.receipt('resume-request-0001')?.state).toBe('unknown');
    expect(() => b.prepareResume(r2.id, b.get(r2.id).revision, 'resume-request-0003', { fixture: 3 })).toThrow(WORKROOM_PROVIDER_BUSY);
  });
});

describe('a Codex row is bound only from evidence that is its own (review findings 2 and 3)', () => {
  test('a running Codex that never sent a message is not bound to a neighbour\'s rollout — not by the tick, not at shutdown', async () => {
    const f = fixture(), a = f.open(BOOT_A), t0 = f.at();
    const ownerContext = f.context('codex'); a.started(ownerContext);
    f.advance(10_000);
    // Only Enter on the folder-trust screen: input, no message, no thread lock. A pgid nothing runs as: lsof finds no lock.
    const idleContext = { ...f.context('codex'), processGroup: 2_147_480, submitted: true }, idle = a.started(idleContext);
    f.advance(10_000); const theirs = randomUUID(); f.rollout(theirs, t0 + 20_000); a.observe(ownerContext, theirs);
    const sidecar = new WorkroomConversationService({ appDataDir: f.root, journal: a, platform: 'darwin', tickMs: 0, contexts: () => [idleContext],
      prepare: async () => { throw new Error('unused'); }, launch: async () => { throw new Error('unused'); } });
    await sidecar.tick();
    expect(a.get(idle.id).providerConversationId).toBeNull();
    await sidecar.ended(idleContext); // the shutdown capture of a session still running
    expect(a.get(idle.id).providerConversationId).toBeNull();
    a.close(); f.advance(30_000);
    const b = f.open(BOOT_B), { history } = service(f, b);
    const rows = (await history.perform(request('restart.list'))).restart!.rows;
    expect(rows.find(r => r.id === idle.id)?.availability).toBe('unsaved'); // its only candidate is the owner's
    expect(b.get(idle.id).providerConversationId).toBeNull();
  });
  test('an ended Codex session is not bound from the folder and time window at its exit; the joint derivation decides later', async () => {
    const f = fixture(), a = f.open(BOOT_A), t0 = f.at();
    const ownerContext = f.context('codex', { submitted: true }), owner = a.started(ownerContext);
    f.advance(5_000);
    const idleContext = f.context('codex', { submitted: false }), idle = a.started(idleContext);
    const mine = randomUUID(); f.rollout(mine, t0 + 15_000); f.advance(20_000);
    const sidecar = new WorkroomConversationService({ appDataDir: f.root, journal: a, platform: 'darwin', tickMs: 0, contexts: () => [],
      prepare: async () => { throw new Error('unused'); }, launch: async () => { throw new Error('unused'); } });
    await sidecar.ended({ ...f.ended(idleContext), exitedAt: f.now() });
    expect(a.get(idle.id).providerConversationId).toBeNull();
    a.close(); f.advance(30_000);
    const b = f.open(BOOT_B), { history } = service(f, b);
    const rows = (await history.perform(request('restart.list'))).restart!.rows;
    expect(rows.find(r => r.id === owner.id)?.availability).toBe('ready');
    expect(b.get(owner.id).providerConversationId).toBe(mine);
  });
  test('the session that got input takes the one rollout; the one that got none is unsaved and competes with nobody', async () => {
    const f = fixture(), a = f.open(BOOT_A), t0 = f.at();
    const owner = a.started(f.context('codex', { submitted: false }));          // B: older, sends the first request later
    f.advance(5_000);
    const idle = a.started(f.context('codex', { submitted: false }));           // A: newer, never used
    const sidecar = new WorkroomConversationService({ appDataDir: f.root, journal: a, platform: 'darwin', tickMs: 0, contexts: () => [],
      prepare: async () => { throw new Error('unused'); }, launch: async () => { throw new Error('unused'); } });
    sidecar.input(owner.sessionId);                                            // the first keystroke of B
    const conversation = randomUUID(); f.rollout(conversation, t0 + 15_000);
    const keeper = a.started(f.context()); f.saveClaude(keeper.sessionId);
    f.advance(25_000); a.close(); f.advance(30_000);
    const b = f.open(BOOT_B), { history } = service(f, b);
    const rows = (await history.perform(request('restart.list'))).restart!.rows;
    expect(rows.find(r => r.id === owner.id)?.availability).toBe('ready');
    expect(b.get(owner.id).providerConversationId).toBe(conversation);
    expect(rows.find(r => r.id === idle.id)?.availability).toBe('unsaved');
    expect(b.get(idle.id).providerConversationId).toBeNull();
  });
  test('without input facts (an earlier build) two overlapping rows are both ambiguous: never the owner unsaved, never a guess', async () => {
    const f = fixture(), a = f.open(BOOT_A), t0 = f.at();
    const owner = a.started(f.context('codex'));
    f.advance(5_000);
    const idle = a.started(f.context('codex'));
    const conversation = randomUUID(); f.rollout(conversation, t0 + 15_000);
    const keeper = a.started(f.context()); f.saveClaude(keeper.sessionId);
    f.advance(25_000); a.close(); f.advance(30_000);
    const b = f.open(BOOT_B), { history } = service(f, b);
    const rows = (await history.perform(request('restart.list'))).restart!.rows;
    expect(rows.find(r => r.id === owner.id)?.availability).toBe('ambiguous');
    expect(rows.find(r => r.id === idle.id)?.availability).toBe('ambiguous');
    expect(b.get(owner.id).providerConversationId).toBeNull(); expect(b.get(idle.id).providerConversationId).toBeNull();
  });
});

describe('ready is said only after a check of this Mac now (review findings 4, 5, 6, 12)', () => {
  test('a verified row whose CLI credentials were rewritten is account-changed: not counted, not resumable on the phone, and the reason is true', async () => {
    const f = fixture(), auth = join(f.codexHome, 'auth.json'); writeFileSync(auth, '{"tokens":"fixture"}');
    const a = f.open(BOOT_A), c = f.context('codex'), row = a.started(c), thread = randomUUID();
    f.rollout(thread, f.at() + 1_000); a.observe(c, thread);
    expect(a.get(row.id).binding).toBe('verified');
    f.advance(20_000); a.close(); f.advance(10_000);
    unlinkSync(auth); writeFileSync(auth, '{"tokens":"fixture"}'); utimesSync(auth, new Date(), new Date(Date.now() + 5_000)); // a token refresh
    const b = f.open(BOOT_B), { history } = service(f, b);
    const offered = (await history.perform(request('restart.list'))).restart!.rows.find(r => r.id === row.id)!;
    expect(offered.availability).toBe('account-changed');
    const phone = (await createRemoteWorkroomHistoryHost(history)({ action: 'history.list', history: { detail: true } }, TARGET, 'device:h:c', { canResume: true, accountSelect: false, allowed: () => true })).records![0]!;
    expect(phone.resumable).toBe(false); expect(phone.why).toBe('account-changed');
    const review = (await history.perform(request('resume.review', { storeInstanceId: b.storeInstanceId, conversationId: row.id, expectedRevision: b.get(row.id).revision }))).review!;
    expect(review.available).toBe(false);
    // Following the advice must be possible: a login rewrites the same file, so 「다시 로그인」 would never help.
    expect(review.reason).not.toContain('다시 로그인'); expect(review.reason).toContain('resume');
  });
  test('the phone list checks before it says 이어 열기: a Claude row with no saved turn is unsaved, and a review keeps that answer', async () => {
    const f = fixture(), a = f.open(BOOT_A);
    // Ten rows that never got a request: more than one list checks (eight), so the last two reach the phone unchecked.
    const rows = Array.from({ length: 10 }, () => { const c = f.context(), r = a.started(c); f.advance(1_000); a.observe(f.ended(c), null); return r; });
    a.close();
    const b = f.open(BOOT_B), { history } = service(f, b), host = createRemoteWorkroomHistoryHost(history);
    const list = async () => (await host({ action: 'history.list', history: { detail: true } }, TARGET, 'device:h:c', { canResume: true, accountSelect: false, allowed: () => true })).records!;
    const first = await list();
    expect(first.filter(r => r.why === 'unsaved')).toHaveLength(8);
    const unchecked = first.find(r => r.why !== 'unsaved')!;
    const review = (await history.perform(request('resume.review', { storeInstanceId: b.storeInstanceId, conversationId: unchecked.id, expectedRevision: unchecked.revision }))).review!;
    expect(review.available).toBe(false);
    const again = (await list()).find(r => r.id === unchecked.id)!;
    expect(again.resumable).toBe(false); expect(again.why).toBe('unsaved');
    expect(rows).toHaveLength(10);
  });
  test('a row this Mac cannot prepare (unregistered project, removed account) is unprepared: shown with why, not counted', async () => {
    const f = fixture(), a = f.open(BOOT_A), r = a.started(f.context()); f.saveClaude(r.sessionId); a.close();
    const b = f.open(BOOT_B), { history } = service(f, b, { prepare: () => { throw new Error('선택한 프로젝트를 찾을 수 없습니다.'); } });
    const first = (await history.perform(request('restart.list'))).restart!;
    expect(first.rows[0]!.availability).toBe('unprepared');
    expect(RESTART_AVAILABILITY_PHRASE.unprepared).not.toContain('이어 열 수 있');
    // Nothing in it can be opened and nothing was reopened: it stays, once, so a person learns why (until closed).
    const second = (await history.perform(request('restart.list'))).restart!;
    expect(second.offerId).toBe(first.offerId); expect(second.rows[0]!.availability).toBe('unprepared');
    await history.perform(request('restart.dismiss', { storeInstanceId: b.storeInstanceId, offerId: first.offerId, expectedRevision: first.revision, requestId: 'dismiss-request-0001' }));
    expect((await history.perform(request('restart.list'))).restart).toBeNull();
  });
});

describe('the offer of sessions that can never be reopened, and the saved list (review finding 18)', () => {
  test('a restart that ended only Hermes and agy sessions shows them once with why; the saved list says why with no 이어 열기', async () => {
    const f = fixture(), a = f.open(BOOT_A);
    const hermes = a.started(f.context('hermes')), agy = a.started(f.context('agy')); a.close();
    const b = f.open(BOOT_B), { history } = service(f, b);
    const offer = (await history.perform(request('restart.list'))).restart!;
    expect(offer.rows.map(r => r.availability)).toEqual(['unsupported', 'unsupported']);
    const listed = normalizeWorkroomHistoryResult(await history.perform(request('list', { archived: false, detail: true })));
    expect(listed.availability).toEqual({ [hermes.id]: 'unsupported', [agy.id]: 'unsupported' });
    // Without `detail` the answer keeps its old shape (an older client never sees the new key).
    expect('availability' in (await history.perform(request('list', { archived: false })))).toBe(false);
  });
});

describe('closing and concurrent lists (review findings 9 and 10)', () => {
  test('「닫기」 on an offer a newer restart superseded keeps its rows closed; the newer rows stay', async () => {
    const f = fixture(), a = f.open(BOOT_A), r1 = a.started(f.context()); f.saveClaude(r1.sessionId); a.close(); f.advance(5_000);
    const b = f.open(BOOT_B), { history } = service(f, b);
    const shown = (await history.perform(request('restart.list'))).restart!;
    const other = f.open(BOOT_C), r3 = other.started(f.context()); f.saveClaude(r3.sessionId); // a second sidecar ends
    await history.perform(request('restart.list')); // another window's focus: a newer offer carries r1
    const answer = (await history.perform(request('restart.dismiss', { storeInstanceId: b.storeInstanceId, offerId: shown.offerId, expectedRevision: shown.revision, requestId: 'dismiss-request-0001' }))).restart;
    expect(answer?.rows.map(r => r.id)).toEqual([r3.id]);
    expect((await history.perform(request('restart.list'))).restart?.rows.map(r => r.id)).toEqual([r3.id]);
    // Idempotent: the same press again changes nothing.
    await history.perform(request('restart.dismiss', { storeInstanceId: b.storeInstanceId, offerId: shown.offerId, expectedRevision: shown.revision, requestId: 'dismiss-request-0001' }));
    expect((await history.perform(request('restart.list'))).restart?.rows.map(r => r.id)).toEqual([r3.id]);
  });
  test('a list in another window does not move a row a batch already reviewed', async () => {
    const f = fixture(), a = f.open(BOOT_A);
    for (let i = 0; i < 10; i++) { const r = a.started(f.context()); f.saveClaude(r.sessionId); f.advance(1_000); }
    a.close(); f.advance(5_000);
    const b = f.open(BOOT_B), { history } = service(f, b);
    const offer = (await history.perform(request('restart.list'))).restart!;
    const late = offer.rows.find(r => r.availability === 'check')!;
    const review = (await history.perform(request('resume.review', { storeInstanceId: b.storeInstanceId, conversationId: late.id, expectedRevision: late.revision }))).review!;
    expect(review.available).toBe(true);
    await history.perform(request('restart.list'));
    const result = await history.perform(request('resume.execute', { storeInstanceId: b.storeInstanceId, conversationId: late.id, expectedRevision: review.revision, reviewId: review.id, requestId: 'request-late-000001', cols: 100, rows: 30 }));
    expect(result.resume?.state).toBe('completed');
  });
});

describe('the phone is told what is true (review findings 7, 8, 13, 14)', () => {
  const access = (o: Partial<RemoteHistoryAccess> = {}): RemoteHistoryAccess => ({ canResume: true, accountSelect: false, allowed: () => true, targets: new Set([TARGET]), controlIds: new Map([[TARGET, CONTROL]]), ...o });
  test('whether the phone may close it is the Mac\'s answer: a read-only phone is never offered 닫기, even for pending rows', async () => {
    const f = fixture(), a = f.open(BOOT_A), r = a.started(f.context()); f.saveClaude(r.sessionId); a.close(); f.advance(5_000);
    const b = f.open(BOOT_B); b.prepareResume(r.id, b.get(r.id).revision, 'resume-request-0001', { fixture: true }); b.close(); f.advance(5_000);
    const c = f.open(BOOT_C), { history } = service(f, c), host = createRemoteWorkroomHistoryHost(history);
    const readOnly = (await host({ action: 'history.restart', history: {} }, TARGET, 'device:h:c', access({ canResume: false }))).restart!;
    expect(readOnly.rows.map(row => row.availability)).toEqual(['pending']);
    expect(readOnly.closable).toBe(false);
    expect((await host({ action: 'history.restart', history: {} }, TARGET, 'device:h:c', access())).restart!.closable).toBe(true);
    const partial = (await host({ action: 'history.restart', history: {} }, TARGET, 'device:h:c', access({ controlIds: new Map() }))).restart;
    expect(partial).toBeNull(); // nothing of it is this phone's
  });
  test('a phone that may not read history learns how many sessions of its projects, never which', async () => {
    const f = fixture(), a = f.open(BOOT_A);
    for (const title of ['비밀 작업', '다른 작업']) { const r = a.mutate(a.started(f.context()).id, 1, 'rename-' + randomUUID(), 'rename', title); f.saveClaude(r.sessionId); }
    a.close(); f.advance(5_000);
    const b = f.open(BOOT_B), { history } = service(f, b), host = createRemoteWorkroomHistoryHost(history);
    const countOnly = (await host({ action: 'history.restart', history: {} }, TARGET, 'device:h:c', access({ canRead: false, canResume: false }))).restart!;
    expect(countOnly).toMatchObject({ rows: [], unlisted: 2, closable: false, complete: false });
    expect(JSON.stringify(countOnly)).not.toContain('작업');
    await expect(host({ action: 'history.list', history: {} }, TARGET, 'device:h:c', access({ canRead: false }))).rejects.toThrow('워크룸 대화 기록 보기');
  });
  test('rows carry when the session started; two of one project and AI are told apart by it', async () => {
    const f = fixture(), a = f.open(BOOT_A);
    for (let i = 0; i < 2; i++) { const r = a.started(f.context()); f.saveClaude(r.sessionId); f.advance(3_600_000); }
    a.close(); f.advance(5_000);
    const b = f.open(BOOT_B), { history } = service(f, b), host = createRemoteWorkroomHistoryHost(history);
    const rows = (await host({ action: 'history.restart', history: {} }, TARGET, 'device:h:c', access())).restart!.rows;
    expect(rows.every(row => Number.isFinite(Date.parse(row.createdAt)))).toBe(true);
    const label = restartRowLabeler(rows, () => '알파 · Claude Code');
    expect(new Set(rows.map(label)).size).toBe(2);
    expect(label(rows[0]!)).toMatch(/^알파 · Claude Code \(\d+월 \d+일 \d\d:\d\d 시작\)$/);
    expect(restartRowLabeler([rows[0]!], () => '알파 · Claude Code')(rows[0]!)).toBe('알파 · Claude Code');
  });
  test('a request the Mac has no record of is said about the request, never about the conversation', () => {
    const text = remoteHistoryOutcomeText({ kind: 'not-recorded' });
    expect(text).toBe(REMOTE_HISTORY_NOT_RECORDED);
    expect(text).not.toContain('대화는 열리지 않았습니다');
    expect(text).toContain('이 요청으로는');
  });
});
