/**
 * 업데이트 뒤 작업 세션 이어 열기 (w14): the host side. A restart turns the rows a dead boot left `running` into one
 * offer; dismissing or finishing it is final; an alive boot (a second sidecar on the same data folder) is not detached;
 * a Codex row with no thread id is bound only from exactly one rollout; an unknown resume can be settled by a person.
 * Real SQLite journals in a temp folder, fixture transcripts and rollouts. No CLI, app or network.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { WorkroomConversationJournal, type WorkroomJournalOptions } from '../src/workroomConversationJournal';
import { WorkroomConversationService } from '../src/workroomConversationService';
import { workroomSessionContext } from '../src/workroomConversationIdentity';
import { WORKROOM_HISTORY_VERSION, WORKROOM_RESUME_UNSETTLED_REASON, normalizeWorkroomHistoryRequest, normalizeWorkroomHistoryResult } from '../src/workroomConversationProtocol';
import { claudeProjectSlugCandidates } from '../src/sessionTranscript';
import { createRemoteWorkroomHistoryHost } from '../src/workroomHistoryRemoteHost';
import { resumeRestartRows, type RestartBatchAdapter } from '../src/workroomRestartBatch';
import type { WorkroomSessionContext } from '../src/workroomConversationHost';
import type { AiTerminalAgent } from '../src/aiTerminalProtocol';

const BOOT_A = 'boot-aaaa-0001', BOOT_B = 'boot-bbbb-0002', BOOT_C = 'boot-cccc-0003', BOOT_D = 'boot-dddd-0004';
const directories: string[] = [];
const closers: (() => unknown)[] = [];
afterEach(async () => { for (const c of closers.splice(0).reverse()) { try { await c(); } catch { /* already closed */ } } for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workroom-restart-'))); directories.push(root);
  const cwd = join(root, 'project'), claudeHome = join(root, '.claude'), codexHome = join(root, '.codex');
  mkdirSync(cwd); mkdirSync(claudeHome); mkdirSync(codexHome);
  const env = { HOME: root, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome };
  let clock = Date.parse('2026-10-16T01:00:00.000Z');
  const now = () => new Date(clock).toISOString();
  const context = (agent: AiTerminalAgent = 'claude', extra: Partial<WorkroomSessionContext> = {}, accountId = 'host-default') => {
    const summary = { id: randomUUID(), targetId: 'project-target-001', agent, state: 'running' as const, createdAt: now(), exitCode: null, cols: 100, rows: 30, accountId };
    return { ...workroomSessionContext(summary, cwd, env, false, agent === 'claude' ? summary.id : undefined), ...extra };
  };
  const ended = (c: WorkroomSessionContext): WorkroomSessionContext => ({ ...c, summary: { ...c.summary, state: 'exited' } });
  const saveClaude = (id: string) => { const dir = join(claudeHome, 'projects', claudeProjectSlugCandidates(cwd)[0]!); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, id + '.jsonl'), JSON.stringify({ type: 'user', message: { content: 'fixture only' } }) + '\n'); };
  const pad = (n: number) => String(n).padStart(2, '0');
  const rollout = (id: string, at: number, options: { cwd?: string; userTurn?: boolean } = {}) => {
    const d = new Date(at), dir = join(codexHome, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
    mkdirSync(dir, { recursive: true });
    const name = `rollout-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${id}.jsonl`;
    const meta = { type: 'session_meta', payload: { id, cwd: options.cwd ?? cwd, timestamp: d.toISOString(), source: 'cli', originator: 'codex-tui', base_instructions: 'x'.repeat(30_000) } };
    writeFileSync(join(dir, name), JSON.stringify(meta) + '\n' + (options.userTurn === false ? '' : JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'fixture' } }) + '\n'));
  };
  const open = (bootId: string, options: WorkroomJournalOptions = {}) => {
    const journal = new WorkroomConversationJournal(root, now, bootId, { build: '700', pid: 4_000_000, alive: () => false, ...options });
    closers.push(() => journal.close());
    return journal;
  };
  return { root, cwd, env, claudeHome, codexHome, context, ended, saveClaude, rollout, open, now, advance: (ms: number) => { clock += ms; }, at: () => clock };
}
type Fixture = ReturnType<typeof fixture>;
const offerRows = (root: string) => {
  const db = new Database(join(root, 'workroom-history-v1', 'history.sqlite'), { readonly: true });
  try { return db.query('SELECT offer_id,state FROM workroom_restart_offers ORDER BY created_at').all() as { offer_id: string; state: string }[]; } finally { db.close(); }
};
const request = (operation: string, body: object = {}) => ({ protocolVersion: WORKROOM_HISTORY_VERSION, operation, ...body });
function service(f: Fixture, journal: WorkroomConversationJournal, options: { contexts?: () => WorkroomSessionContext[]; launchFailure?: boolean; prepare?: (record: any) => WorkroomSessionContext } = {}) {
  let launches = 0;
  const history = new WorkroomConversationService({
    appDataDir: f.root, journal, platform: 'darwin', contexts: options.contexts ?? (() => []), tickMs: 0,
    prepare: async record => options.prepare?.(record) ?? { ...workroomSessionContext({ id: record.sessionId, targetId: record.targetId, agent: record.agent, state: 'exited', createdAt: record.createdAt, exitCode: null, cols: 100, rows: 30, accountId: record.accountId }, f.cwd, f.env, false) },
    assertNoWriter: async () => {},
    launch: async (_record, _requestId, _cols, _rows, binding) => {
      const summary = { id: randomUUID(), targetId: _record.targetId, agent: _record.agent, state: 'running' as const, createdAt: f.now(), exitCode: null, cols: 100, rows: 30, accountId: _record.accountId };
      const context = workroomSessionContext(summary, f.cwd, f.env, false, binding.resume.conversationId);
      await binding.validate(context); binding.launching(); launches++;
      if (options.launchFailure) throw new Error('fixture crash after spawn');
      journal.started(context, binding.logicalConversationId); return { session: context.summary };
    },
  });
  closers.push(() => history.shutdown());
  return { history, launches: () => launches };
}

describe('restart offer — journal', () => {
  test('the running rows of a dead boot become one open offer; a third open adds none', () => {
    const f = fixture(), a = f.open(BOOT_A);
    const r1 = a.started(f.context()), r2 = a.started(f.context());
    const doneContext = f.context(), done = a.started(doneContext); a.observe(f.ended(doneContext), null);
    a.close(); f.advance(5_000);
    const b = f.open(BOOT_B, { build: '701' });
    expect(b.get(r1.id).state).toBe('detached'); expect(b.get(r2.id).state).toBe('detached'); expect(b.get(done.id).state).toBe('ended');
    const offer = b.restartOffer()!;
    expect([...offer.conversationIds].sort()).toEqual([r1.id, r2.id].sort());
    expect(offer.update).toBe(true); expect(offer.state).toBe('open');
    b.close(); f.advance(5_000);
    const c = f.open(BOOT_C, { build: '701' });
    expect(c.restartOffer()?.offerId).toBe(offer.offerId);
    expect(offerRows(f.root)).toHaveLength(1);
  });
  test('a crash with the same build is not an update', () => {
    const f = fixture(), a = f.open(BOOT_A); a.started(f.context()); a.close();
    expect(f.open(BOOT_B).restartOffer()?.update).toBe(false);
  });
  test('dismiss is idempotent, refused at a stale revision, and never resurrected by a later open', () => {
    const f = fixture(), a = f.open(BOOT_A); a.started(f.context()); a.close();
    const b = f.open(BOOT_B), offer = b.restartOffer()!;
    expect(() => b.dismissOffer(offer.offerId, offer.revision + 5, 'dismiss-request-0001')).toThrow();
    expect(b.restartOffer()?.state).toBe('open');
    b.dismissOffer(offer.offerId, offer.revision, 'dismiss-request-0002');
    expect(b.restartOffer()).toBeNull();
    expect(() => b.dismissOffer(offer.offerId, offer.revision, 'dismiss-request-0002')).not.toThrow();
    // Another window dismissing the same, already dismissed offer is not an error either.
    expect(() => b.dismissOffer(offer.offerId, offer.revision, 'dismiss-request-0003')).not.toThrow();
    b.close();
    expect(f.open(BOOT_C).restartOffer()).toBeNull();
    expect(offerRows(f.root).map(r => r.state)).toEqual(['dismissed']);
  });
  test('a newer restart supersedes the open offer and carries its still detached rows; old offers expire', () => {
    const f = fixture(), a = f.open(BOOT_A), r1 = a.started(f.context()); a.close(); f.advance(1_000);
    const b = f.open(BOOT_B), first = b.restartOffer()!;
    const r3 = b.started(f.context()); // B dies without closing: not alive (pid gone), never closed
    f.advance(1_000);
    const c = f.open(BOOT_C), second = c.restartOffer()!;
    expect(second.offerId).not.toBe(first.offerId);
    expect([...second.conversationIds].sort()).toEqual([r1.id, r3.id].sort());
    expect(offerRows(f.root).map(r => r.state)).toEqual(['superseded', 'open']);
    f.advance(73 * 3600_000);
    expect(c.restartOffer()).toBeNull();
    expect(offerRows(f.root).map(r => r.state)).toEqual(['superseded', 'expired']);
  });
  test('archived and restricted rows are detached but never offered', () => {
    const f = fixture(), a = f.open(BOOT_A);
    const kept = a.started(f.context()), archived = a.started(f.context()), duty = a.started({ ...f.context(), restricted: true });
    a.mutate(archived.id, archived.revision, 'archive-request-001', 'archive'); a.close();
    const b = f.open(BOOT_B);
    expect(b.get(archived.id).state).toBe('detached'); expect(b.get(duty.id).state).toBe('detached');
    expect(b.restartOffer()!.conversationIds).toEqual([kept.id]);
  });
  test('thirty running rows of a dead boot are all detached and the journal stays usable', () => {
    const f = fixture(), a = f.open(BOOT_A);
    const ids = Array.from({ length: 30 }, () => a.started(f.context()).id); a.close();
    const b = f.open(BOOT_B);
    expect(ids.every(id => b.get(id).state === 'detached')).toBe(true);
    expect(b.list(false).records).toHaveLength(30);
    expect(b.restartOffer()!.conversationIds).toHaveLength(30);
  });
  test('rows of an alive boot stay running; the next check detaches them once that boot is gone', () => {
    const f = fixture(); let aAlive = true;
    const a = f.open(BOOT_A, { pid: 4_242_424 }), r = a.started(f.context()); // never closed: a second sidecar still running
    const b = f.open(BOOT_B, { alive: pid => pid === 4_242_424 && aAlive });
    expect(b.get(r.id).state).toBe('running'); expect(b.restartOffer()).toBeNull();
    aAlive = false; b.detachStale();
    expect(b.get(r.id).state).toBe('detached'); expect(b.restartOffer()!.conversationIds).toEqual([r.id]);
  });
  test('a boot whose heartbeat is older than 150 s is dead even when its pid answers', () => {
    const f = fixture(), a = f.open(BOOT_A, { pid: 4_242_425 }), r = a.started(f.context());
    f.advance(151_000);
    const b = f.open(BOOT_B, { alive: () => true });
    expect(b.get(r.id).state).toBe('detached');
  });
  test('the boot table and side tables leave the conversation body and the schema version alone', () => {
    const f = fixture(), a = f.open(BOOT_A), r = a.started({ ...f.context(), bypass: true }); a.close();
    const db = new Database(join(f.root, 'workroom-history-v1', 'history.sqlite'), { readonly: true });
    try {
      expect((db.query('SELECT version FROM workroom_meta').get() as { version: number }).version).toBe(2);
      const body = JSON.parse((db.query('SELECT body FROM workroom_conversations WHERE id=?').get(r.id) as { body: string }).body);
      expect(Object.keys(body)).not.toContain('bypass');
      expect((db.query('SELECT bypass FROM workroom_session_facts WHERE session_id=?').get(r.sessionId) as { bypass: number }).bypass).toBe(1);
    } finally { db.close(); }
  });
});

describe('restart offer — service', () => {
  test('restart.list answers the offer; a row resumed elsewhere leaves it, and nothing actionable marks it done', async () => {
    const f = fixture(), a = f.open(BOOT_A);
    const claude = a.started(f.context()); f.saveClaude(claude.sessionId);
    const hermes = a.started(f.context('hermes')); a.close();
    const b = f.open(BOOT_B), { history } = service(f, b);
    const listed = normalizeWorkroomHistoryResult(await history.perform(request('restart.list')));
    const rows = listed.restart!.rows;
    expect(rows.find(r => r.id === claude.id)?.availability).toBe('ready');
    expect(rows.find(r => r.id === hermes.id)?.availability).toBe('unsupported');
    expect(Object.keys(rows[0]!).sort()).toEqual(['accountLabel', 'agent', 'availability', 'bypass', 'createdAt', 'id', 'revision', 'targetId', 'title', 'updatedAt']);
    // A probe proved the transcript: the row is verified now and the next list needs no probe.
    expect(b.get(claude.id).binding).toBe('verified');
    // Only the Hermes row is left: nothing to open, so the offer is done and the banner goes away.
    b.started({ ...f.context(), summary: { ...f.context().summary, id: randomUUID() } }, claude.id);
    expect((await history.perform(request('restart.list'))).restart).toBeNull();
    expect(offerRows(f.root).map(r => r.state)).toEqual(['done']);
  });
  test('cold resume is a Mac feature: elsewhere no offer is shown, and it is kept for later', async () => {
    const f = fixture(), a = f.open(BOOT_A), r = a.started(f.context()); f.saveClaude(r.sessionId); a.close();
    const b = f.open(BOOT_B);
    const windows = new WorkroomConversationService({ appDataDir: f.root, journal: b, platform: 'win32', tickMs: 0, contexts: () => [], prepare: async () => { throw new Error('unexpected'); }, launch: async () => { throw new Error('unexpected'); } });
    closers.push(() => windows.shutdown());
    expect((await windows.perform(request('restart.list'))).restart).toBeNull();
    expect(offerRows(f.root).map(row => row.state)).toEqual(['open']);
  });
  test('a Claude row whose transcript has no user turn is unsaved, and the outcome is cached per revision', async () => {
    const f = fixture(), a = f.open(BOOT_A), empty = a.started(f.context()), saved = a.started(f.context()); f.saveClaude(saved.sessionId); a.close();
    const b = f.open(BOOT_B); let prepares = 0;
    const { history } = service(f, b, { prepare: record => { prepares++; return workroomSessionContext({ id: record.sessionId, targetId: record.targetId, agent: record.agent, state: 'exited', createdAt: record.createdAt, exitCode: null, cols: 100, rows: 30, accountId: record.accountId }, f.cwd, f.env, false); } });
    const first = (await history.perform(request('restart.list'))).restart!;
    expect(first.rows.find(r => r.id === empty.id)?.availability).toBe('unsaved');
    const before = prepares;
    await history.perform(request('restart.list'));
    expect(prepares).toBe(before); // cached: no second probe
  });
  test('resume.settle clears an unknown resume after a person checked; refused while prepared and at a stale revision; idempotent', async () => {
    const f = fixture(), a = f.open(BOOT_A), c = f.context(), r = a.started(c); f.saveClaude(r.sessionId);
    a.observe(f.ended(c), r.sessionId);
    const row = a.get(r.id); a.prepareResume(row.id, row.revision, 'resume-request-0001', { fixture: true });
    expect(() => a.settleResume(row.id, a.get(row.id).revision, 'settle-request-0001')).toThrow();
    a.close();
    const b = f.open(BOOT_B), pending = b.get(r.id);
    expect(pending.pendingResumeId).toBe('resume-request-0001'); expect(b.receipt('resume-request-0001')?.state).toBe('unknown');
    const { history } = service(f, b);
    const review = await history.perform(request('resume.review', { storeInstanceId: b.storeInstanceId, conversationId: r.id, expectedRevision: pending.revision }));
    expect(review.review?.available).toBe(false); expect(review.review?.reason).toBe(WORKROOM_RESUME_UNSETTLED_REASON);
    await expect(history.perform(request('resume.settle', { storeInstanceId: b.storeInstanceId, conversationId: r.id, expectedRevision: pending.revision + 1, requestId: 'settle-request-0002' }))).rejects.toThrow();
    const settled = await history.perform(request('resume.settle', { storeInstanceId: b.storeInstanceId, conversationId: r.id, expectedRevision: pending.revision, requestId: 'settle-request-0003' }));
    const again = await history.perform(request('resume.settle', { storeInstanceId: b.storeInstanceId, conversationId: r.id, expectedRevision: pending.revision, requestId: 'settle-request-0003' }));
    expect(settled.record?.revision).toBe(again.record?.revision!);
    expect(b.get(r.id).pendingResumeId).toBeNull(); expect(b.receipt('resume-request-0001')?.state).toBe('unknown');
    const after = b.get(r.id);
    expect((await history.perform(request('resume.review', { storeInstanceId: b.storeInstanceId, conversationId: r.id, expectedRevision: after.revision }))).review?.available).toBe(true);
  });
  test('the request and result shapes are strict and additive', () => {
    expect(normalizeWorkroomHistoryRequest(request('restart.list')).operation).toBe('restart.list');
    expect(() => normalizeWorkroomHistoryRequest(request('restart.list', { path: '/tmp' }))).toThrow();
    expect(() => normalizeWorkroomHistoryRequest(request('restart.dismiss', { storeInstanceId: randomUUID(), offerId: randomUUID(), expectedRevision: 1 }))).toThrow();
    expect(() => normalizeWorkroomHistoryRequest(request('resume.settle', { storeInstanceId: randomUUID(), conversationId: randomUUID(), expectedRevision: 1, requestId: randomUUID(), bypassPermissions: true }))).toThrow();
    const row = { id: randomUUID(), targetId: 'project-target-001', agent: 'claude', title: '', accountLabel: '현재 CLI 계정', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revision: 2, availability: 'ready', bypass: null };
    const base = { protocolVersion: WORKROOM_HISTORY_VERSION, storeInstanceId: 'store-instance-001' };
    const restart = { offerId: randomUUID(), revision: 1, createdAt: new Date().toISOString(), update: true, more: false, rows: [row] };
    expect(normalizeWorkroomHistoryResult({ ...base, restart }).restart?.rows).toHaveLength(1);
    expect(normalizeWorkroomHistoryResult({ ...base, restart: null }).restart).toBeNull();
    for (const bad of [{ ...restart, path: '/x' }, { ...restart, rows: [{ ...row, sessionId: 'x' }] }, { ...restart, rows: [{ ...row, availability: 'maybe' }] }, { ...restart, rows: [{ ...row, providerConversationId: 'x' }] }])
      expect(() => normalizeWorkroomHistoryResult({ ...base, restart: bad })).toThrow();
  });
});

describe('Codex rows with no thread id', () => {
  /** A Codex session created at T0+5 s on boot A, which was last seen at T0+30 s and closed; boot B opens at `openAt`. */
  function codexRow(f: Fixture, openAt = 60_000, options: { dropBoot?: boolean } = {}) {
    const t0 = f.at(), a = f.open(BOOT_A); f.advance(5_000);
    const row = a.started(f.context('codex'));
    // A Claude row that can be opened keeps the offer listed whatever the Codex row turns out to be.
    const keeper = a.started(f.context()); f.saveClaude(keeper.sessionId);
    f.advance(25_000); a.close();
    if (options.dropBoot) { const db = new Database(join(f.root, 'workroom-history-v1', 'history.sqlite')); db.query('DELETE FROM workroom_boots WHERE boot_id=?').run(BOOT_A); db.close(); }
    f.advance(openAt - 30_000);
    return { t0, row };
  }
  const listRow = async (f: Fixture, journal: WorkroomConversationJournal, id: string) => {
    const { history } = service(f, journal);
    return { history, row: (await history.perform(request('restart.list'))).restart?.rows.find(r => r.id === id) };
  };
  test('exactly one rollout of that folder and time window binds the row and opens review', async () => {
    const f = fixture(), { t0, row } = codexRow(f); const id = randomUUID(); f.rollout(id, t0 + 20_000);
    const b = f.open(BOOT_B), { history, row: listed } = await listRow(f, b, row.id);
    expect(listed?.availability).toBe('ready');
    const bound = b.get(row.id); expect(bound.providerConversationId).toBe(id); expect(bound.binding).toBe('verified');
    expect((await history.perform(request('resume.review', { storeInstanceId: b.storeInstanceId, conversationId: row.id, expectedRevision: bound.revision }))).review?.available).toBe(true);
  });
  test('the review itself derives the thread for an ended row and returns the new revision', async () => {
    const f = fixture(), { t0, row } = codexRow(f); const id = randomUUID(); f.rollout(id, t0 + 20_000);
    const b = f.open(BOOT_B), before = b.get(row.id), { history } = service(f, b);
    const review = await history.perform(request('resume.review', { storeInstanceId: b.storeInstanceId, conversationId: row.id, expectedRevision: before.revision }));
    expect(review.review?.available).toBe(true); expect(review.review?.revision).toBe(before.revision + 1);
  });
  test('two rollouts are ambiguous and the review says so; nothing is bound', async () => {
    const f = fixture(), { t0, row } = codexRow(f); f.rollout(randomUUID(), t0 + 15_000); f.rollout(randomUUID(), t0 + 20_000);
    const b = f.open(BOOT_B), { history, row: listed } = await listRow(f, b, row.id);
    expect(listed?.availability).toBe('ambiguous'); expect(b.get(row.id).providerConversationId).toBeNull();
    const review = await history.perform(request('resume.review', { storeInstanceId: b.storeInstanceId, conversationId: row.id, expectedRevision: b.get(row.id).revision }));
    expect(review.review?.available).toBe(false); expect(review.review?.reason).toContain('여럿');
  });
  test('a rollout already bound to another conversation is not a candidate', async () => {
    const f = fixture(), { t0, row } = codexRow(f); const mine = randomUUID(), theirs = randomUUID();
    f.rollout(mine, t0 + 15_000); f.rollout(theirs, t0 + 20_000);
    const b = f.open(BOOT_B), otherContext = f.context('codex'), other = b.started(otherContext); b.observe(f.ended(otherContext), theirs);
    expect(b.get(other.id).providerConversationId).toBe(theirs);
    const { row: listed } = await listRow(f, b, row.id);
    expect(listed?.availability).toBe('ready'); expect(b.get(row.id).providerConversationId).toBe(mine);
  });
  test('a rollout after the boot was last seen (+70 s) is ignored', async () => {
    const f = fixture(), { t0, row } = codexRow(f, 300_000); f.rollout(randomUUID(), t0 + 150_000);
    const b = f.open(BOOT_B), { row: listed } = await listRow(f, b, row.id);
    expect(listed?.availability).toBe('unsaved');
  });
  test('a rollout with no user turn proves nothing', async () => {
    const f = fixture(), { t0, row } = codexRow(f); f.rollout(randomUUID(), t0 + 20_000, { userTurn: false });
    const b = f.open(BOOT_B), { row: listed } = await listRow(f, b, row.id);
    expect(listed?.availability).toBe('unsaved');
  });
  test('a boot from before this release has no upper bound: legacy, never a guess', async () => {
    const f = fixture(), { t0, row } = codexRow(f, 60_000, { dropBoot: true }); f.rollout(randomUUID(), t0 + 20_000);
    const b = f.open(BOOT_B), { row: listed } = await listRow(f, b, row.id);
    expect(listed?.availability).toBe('legacy'); expect(b.get(row.id).providerConversationId).toBeNull();
  });
});

describe('batch resume is exactly-once', () => {
  function batchFixture(options: { launchFailure?: boolean } = {}) {
    const f = fixture(), a = f.open(BOOT_A);
    const rows = [a.started(f.context()), a.started(f.context())]; for (const r of rows) f.saveClaude(r.sessionId); a.close();
    const b = f.open(BOOT_B), s = service(f, b, options);
    const adapter = (lose = () => false): RestartBatchAdapter => ({
      review: async row => (await s.history.perform(request('resume.review', { storeInstanceId: b.storeInstanceId, conversationId: row.id, expectedRevision: row.revision }))).review!,
      execute: async (row, review, requestId) => {
        try {
          const result = await s.history.perform(request('resume.execute', { storeInstanceId: b.storeInstanceId, conversationId: row.id, expectedRevision: review.revision, reviewId: review.id, requestId, cols: 100, rows: 30 }));
          if (lose()) return { kind: 'lost', message: 'response lost' };
          return { kind: 'answer', state: result.resume!.state, ...(result.resume?.session ? { sessionId: result.resume.session.id } : {}) };
        } catch (error) { return { kind: 'refused', message: (error as Error).message }; }
      },
    });
    return { f, b, s, adapter, list: async () => (await s.history.perform(request('restart.list'))).restart };
  }
  test('two windows pressing at once launch each row once', async () => {
    const x = batchFixture(), offer = (await x.list())!;
    const runnable = offer.rows.filter(r => r.availability === 'ready' || r.availability === 'check');
    expect(runnable).toHaveLength(2);
    const [first, second] = await Promise.all([resumeRestartRows(runnable, x.adapter()), resumeRestartRows(runnable, x.adapter())]);
    expect(x.s.launches()).toBe(2);
    expect(first.opened.length + second.opened.length).toBe(2);
    expect(await x.list()).toBeNull(); // every row is running again: done
  });
  test('a lost response stops the batch; a later list never executes anything', async () => {
    const x = batchFixture({ launchFailure: true }), offer = (await x.list())!;
    let calls = 0;
    const result = await resumeRestartRows(offer.rows, x.adapter(() => ++calls === 1));
    expect(result.stopped?.row.id).toBe(offer.rows[0]!.id); expect(result.opened).toHaveLength(0);
    expect(x.s.launches()).toBe(1);
    const after = (await x.list())!;
    expect(after.rows.find(r => r.id === offer.rows[0]!.id)?.availability).toBe('pending');
    await x.list(); expect(x.s.launches()).toBe(1);
  });
});

describe('phone history uses the same availability (R3)', () => {
  test('a detached, unverified Claude row is resumable on the phone; no grant still says no', async () => {
    const f = fixture(), a = f.open(BOOT_A), r = a.started(f.context()); f.saveClaude(r.sessionId); a.close();
    const b = f.open(BOOT_B), { history } = service(f, b);
    expect(b.get(r.id).binding).toBe('unverified'); expect(b.get(r.id).state).toBe('detached');
    const host = createRemoteWorkroomHistoryHost(history);
    const list = (canResume: boolean) => host({ action: 'history.list', history: {} }, 'project-target-001', 'device:h:c', { canResume, accountSelect: false, allowed: () => true });
    expect((await list(true)).records![0]!.resumable).toBe(true);
    expect((await list(false)).records![0]!.resumable).toBe(false);
  });
});
