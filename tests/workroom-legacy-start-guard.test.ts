/**
 * w2-followups #15 (plan S3-2 item 9): an interim guard for hosts without launch receipts.
 *
 * A plain `start` whose answer was lost may still have opened the CLI with the request. Retrying the same request then
 * opens a second CLI that runs it again. Until every host has terminal-start-submission-v1, the panel keeps a digest of
 * a failed start (target, AI, prompt — never the prompt itself) and the session ids it already knew; when the same
 * request is retried and a new session for that target and AI has appeared since, it asks before starting another.
 */
import {describe, expect, test} from 'bun:test';
import {
  FAILED_LEGACY_START_TTL_MS,
  failedLegacyStartKey,
  legacyStartDigest,
  legacyStartRetryConfirmation,
  readFailedLegacyStart,
  forgetFailedLegacyStart,
  rememberFailedLegacyStart,
  sessionOpenedSinceFailedStart,
  legacyStartGuard,
  legacyRouteRetryConfirmation,
  legacyRouteRetryHeldReceipt,
  legacyRouteSuspects,
  legacyRouteSessionSendConfirmation,
  legacyRouteSessionSendHeld,
} from '../src/workroomLegacyStartGuard';
import type {AiTerminalSummary} from '../src/aiTerminalProtocol';
import {projectCreationIntentFingerprint} from '../src/projectLaunchIntent';

class MemoryStorage {
  items = new Map<string, string>();
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, String(value)); }
  removeItem(key: string) { this.items.delete(key); }
}
const session = (id: string, targetId = 'target-0001', agent: AiTerminalSummary['agent'] = 'codex', state: AiTerminalSummary['state'] = 'running'): AiTerminalSummary =>
  ({id, targetId, agent, state, createdAt: '2026-10-15T00:00:00Z', exitCode: state === 'running' ? null : 0, cols: 100, rows: 28});
const attempt = {targetId: 'target-0001', agent: 'codex' as const, prompt: '배포 로그를 확인해 줘'};

describe('legacy start guard', () => {
  test('the record keeps a digest, never the prompt, and reads back within its lifetime', () => {
    const storage = new MemoryStorage(), now = 1_000_000;
    rememberFailedLegacyStart(storage, 'scope', {...attempt, knownSessionIds: ['known-0001'], at: now});
    const raw = storage.getItem(failedLegacyStartKey('scope'))!;
    expect(raw).not.toContain('배포');
    expect(raw).toContain(legacyStartDigest(attempt.targetId, attempt.agent, attempt.prompt));
    expect(readFailedLegacyStart(storage, 'scope', now + 1000)?.knownSessionIds).toEqual(['known-0001']);
    expect(readFailedLegacyStart(storage, 'scope', now + FAILED_LEGACY_START_TTL_MS + 1)).toBeNull();
    expect(readFailedLegacyStart(storage, 'other-scope', now)).toBeNull();
  });

  test('a session for the same target and AI that appeared after the failed start asks first', () => {
    const storage = new MemoryStorage(), now = 1_000_000;
    rememberFailedLegacyStart(storage, 'scope', {...attempt, knownSessionIds: ['known-0001'], at: now});
    const record = readFailedLegacyStart(storage, 'scope', now)!;
    const opened = sessionOpenedSinceFailedStart(record, attempt, [session('known-0001'), session('opened-0001')]);
    expect(opened?.id).toBe('opened-0001');
    expect(legacyStartRetryConfirmation('Fixture', 'Codex')).toContain('새 세션을 하나 더');
  });

  test('nothing new, another prompt, another target, another AI or an exited session never asks', () => {
    const now = 1_000_000;
    const storage = new MemoryStorage();
    rememberFailedLegacyStart(storage, 'scope', {...attempt, knownSessionIds: ['known-0001'], at: now});
    const record = readFailedLegacyStart(storage, 'scope', now)!;
    expect(sessionOpenedSinceFailedStart(record, attempt, [session('known-0001')])).toBeNull();
    expect(sessionOpenedSinceFailedStart(record, {...attempt, prompt: '다른 요청'}, [session('opened-0001')])).toBeNull();
    expect(sessionOpenedSinceFailedStart(record, attempt, [session('opened-0001', 'target-0002')])).toBeNull();
    expect(sessionOpenedSinceFailedStart(record, attempt, [session('opened-0001', 'target-0001', 'claude')])).toBeNull();
    expect(sessionOpenedSinceFailedStart(record, attempt, [session('opened-0001', 'target-0001', 'codex', 'exited')])).toBeNull();
  });

  test('a malformed or unreadable record reads as none, and a throwing storage does not throw', () => {
    const storage = new MemoryStorage();
    storage.setItem(failedLegacyStartKey('scope'), '{"v":1,"targetId":"x"}');
    expect(readFailedLegacyStart(storage, 'scope', 0)).toBeNull();
    storage.setItem(failedLegacyStartKey('scope'), 'not json');
    expect(readFailedLegacyStart(storage, 'scope', 0)).toBeNull();
    const broken = {getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); }};
    expect(readFailedLegacyStart(broken, 'scope', 0)).toBeNull();
    expect(() => rememberFailedLegacyStart(broken, 'scope', {...attempt, knownSessionIds: [], at: 0})).not.toThrow();
    expect(() => rememberFailedLegacyStart(broken, 'scope', null)).not.toThrow();
  });

  test('the known-session list is bounded', () => {
    const storage = new MemoryStorage();
    const ids = Array.from({length: 200}, (_, index) => `session-${String(index).padStart(4, '0')}`);
    rememberFailedLegacyStart(storage, 'scope', {...attempt, knownSessionIds: ids, at: 0});
    expect(readFailedLegacyStart(storage, 'scope', 0)!.knownSessionIds.length).toBeLessThanOrEqual(64);
  });

  // Review 2026-10-15 (finding 1): one slot per scope, and any successful start cleared it — so a successful start of
  // another request erased the failed start of the first, and retrying that first request no longer asked.
  test('a successful start of another request keeps the failed record of the first', () => {
    const storage = new MemoryStorage(), now = 1_000_000;
    rememberFailedLegacyStart(storage, 'scope', {...attempt, knownSessionIds: ['known-0001'], at: now});
    const other = {targetId: 'target-0002', agent: 'claude' as const, prompt: '다른 프로젝트 요청'};
    forgetFailedLegacyStart(storage, 'scope', other);
    const record = readFailedLegacyStart(storage, 'scope', now, attempt);
    expect(record).not.toBeNull();
    expect(sessionOpenedSinceFailedStart(record!, attempt, [session('known-0001'), session('opened-0001')])?.id).toBe('opened-0001');
    // The successful start of the same request settles it.
    forgetFailedLegacyStart(storage, 'scope', attempt);
    expect(readFailedLegacyStart(storage, 'scope', now, attempt)).toBeNull();
  });

  test('two failed requests are both remembered, each found by its own request', () => {
    const storage = new MemoryStorage(), now = 1_000_000;
    const other = {targetId: 'target-0002', agent: 'claude' as const, prompt: '다른 프로젝트 요청'};
    rememberFailedLegacyStart(storage, 'scope', {...attempt, knownSessionIds: ['known-0001'], at: now});
    rememberFailedLegacyStart(storage, 'scope', {...other, knownSessionIds: ['known-0002'], at: now + 1});
    expect(readFailedLegacyStart(storage, 'scope', now, attempt)?.knownSessionIds).toEqual(['known-0001']);
    expect(readFailedLegacyStart(storage, 'scope', now, other)?.knownSessionIds).toEqual(['known-0002']);
    // Failing the same request again replaces only its own record.
    rememberFailedLegacyStart(storage, 'scope', {...attempt, knownSessionIds: ['known-0003'], at: now + 2});
    expect(readFailedLegacyStart(storage, 'scope', now, attempt)?.knownSessionIds).toEqual(['known-0003']);
    expect(readFailedLegacyStart(storage, 'scope', now, other)?.knownSessionIds).toEqual(['known-0002']);
    // Bounded: the oldest record goes first.
    for (let i = 0; i < 20; i++) rememberFailedLegacyStart(storage, 'scope', {targetId: 'target-0003', agent: 'codex', prompt: '요청 ' + i, knownSessionIds: [], at: now + 10 + i});
    expect(readFailedLegacyStart(storage, 'scope', now, attempt)).toBeNull();
    expect(readFailedLegacyStart(storage, 'scope', now, {targetId: 'target-0003', agent: 'codex', prompt: '요청 19'})).not.toBeNull();
  });

  // w4 L1: the LAN QR page cannot import this module; it embeds the guard with `toString()`. Built from its text alone,
  // with the page's own SHA-256, it must read and write the very records the panel does (one format, one digest).
  test('the guard builds from its own text alone, with the same digest and records as the module', () => {
    const factory = new Function(`return (${legacyStartGuard.toString()});`)() as typeof legacyStartGuard;
    const sha256Hex = new Function(`return (${projectCreationIntentFingerprint.toString()});`)() as (text: string) => string;
    const lan = factory({sha256Hex}), storage = new MemoryStorage(), now = 1_000_000;
    expect(lan.digest(attempt.targetId, attempt.agent, attempt.prompt)).toBe(legacyStartDigest(attempt.targetId, attempt.agent, attempt.prompt));
    lan.remember(storage, 'lan', {...attempt, knownSessionIds: ['known-0001'], at: now});
    expect(storage.getItem(failedLegacyStartKey('lan'))).not.toContain('배포');
    expect(readFailedLegacyStart(storage, 'lan', now, attempt)?.knownSessionIds).toEqual(['known-0001']);
    const record = lan.read(storage, 'lan', now, attempt)!;
    expect(lan.openedSince(record, attempt, [session('known-0001'), session('opened-0001')])?.id).toBe('opened-0001');
    expect(lan.read(storage, 'lan', now + FAILED_LEGACY_START_TTL_MS + 1, attempt)).toBeNull();
    lan.forget(storage, 'lan', attempt);
    expect(readFailedLegacyStart(storage, 'lan', now, attempt)).toBeNull();
    // Storage that refuses is ignored: the guard is advisory.
    const broken = {getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); }};
    expect(() => lan.remember(broken, 'lan', {...attempt, knownSessionIds: [], at: now})).not.toThrow();
    expect(lan.read(broken, 'lan', now, attempt)).toBeNull();
  });

  test('an @ route retry names the session that opened and keeps the draft when declined', () => {
    const confirm = new Function(`return (${legacyRouteRetryConfirmation.toString()});`)() as typeof legacyRouteRetryConfirmation;
    const held = new Function(`return (${legacyRouteRetryHeldReceipt.toString()});`)() as typeof legacyRouteRetryHeldReceipt;
    const message = confirm('Beta', 'Claude Code', 'Beta · claude #2');
    expect(message).toContain('‘Beta’에 새 Claude Code 세션');
    expect(message).toContain('받는 세션: Beta · claude #2');
    expect(message).toContain('같은 메시지를 다시 전달할까요?');
    expect(confirm('Beta', 'Claude Code')).not.toContain('받는 세션');
    const receipt = held('Beta', 'Claude Code', 'Beta · claude #2');
    expect(receipt).toContain('보내지 않았습니다');
    expect(receipt).toContain('작성 중인 내용은 유지했습니다');
  });
});

// w4 review, finding 1: declining the retry question (or a lost start answer) leaves the draft — and a session that may
// already run it. Choosing that session clears the @ chip, so its protection cannot ride on the chip: this page keeps
// which sessions of that target and AI were known when the handoff went out, and a send of the same draft into any
// other one asks first. Self-contained, because the LAN page embeds it.
describe('sessions a lost @ handoff may have reached', () => {
  const handoff = {scope: 'scope-a', targetId: 'target-0002', agent: 'claude', draft: '배포 로그를 확인해 줘', label: 'Beta'};
  test('a session not known when the handoff went out is a suspect, for that scope, target, AI and draft only', () => {
    const suspects = legacyRouteSuspects(), now = 1_000_000;
    suspects.add({...handoff, knownSessionIds: ['known-0001'], at: now});
    const send = {scope: 'scope-a', targetId: 'target-0002', agent: 'claude', draft: '배포 로그를 확인해 줘', sessionId: 'opened-0001'};
    expect(suspects.find(send, now)).toMatchObject({label: 'Beta', targetId: 'target-0002'});
    expect(suspects.find({...send, sessionId: 'known-0001'}, now)).toBeNull();
    for (const other of [{scope: 'scope-b'}, {targetId: 'target-0003'}, {agent: 'codex'}, {draft: '다른 요청'}]) expect(suspects.find({...send, ...other}, now)).toBeNull();
    expect(suspects.find(send, now + FAILED_LEGACY_START_TTL_MS + 1)).toBeNull();
    suspects.clear(handoff);
    expect(suspects.find(send, now)).toBeNull();
  });

  test('a second failure keeps the sessions known at the first one, so an earlier suspect stays one', () => {
    const suspects = legacyRouteSuspects(), now = 1_000_000;
    suspects.add({...handoff, knownSessionIds: ['known-0001'], at: now});
    suspects.add({...handoff, knownSessionIds: ['known-0001', 'opened-0001'], at: now + 1000});
    expect(suspects.find({...handoff, sessionId: 'opened-0001'}, now + 1000)).not.toBeNull();
    expect(suspects.find({...handoff, sessionId: 'known-0001'}, now + 1000)).toBeNull();
  });

  test('it builds from its own text alone, bounded in size, and the wording names the session and keeps the draft', () => {
    const factory = new Function(`return (${legacyRouteSuspects.toString()});`)() as typeof legacyRouteSuspects;
    const suspects = factory(), now = 1_000_000;
    for (let i = 0; i < 40; i++) suspects.add({...handoff, draft: `요청 ${i}`, knownSessionIds: [], at: now});
    expect(suspects.find({...handoff, draft: '요청 0', sessionId: 'opened-0001'}, now)).toBeNull();
    expect(suspects.find({...handoff, draft: '요청 39', sessionId: 'opened-0001'}, now)).not.toBeNull();
    const confirm = new Function(`return (${legacyRouteSessionSendConfirmation.toString()});`)() as typeof legacyRouteSessionSendConfirmation;
    const held = new Function(`return (${legacyRouteSessionSendHeld.toString()});`)() as typeof legacyRouteSessionSendHeld;
    const message = confirm('Beta', 'Claude Code', 'Beta · claude #2');
    expect(message).toContain('‘Beta’');
    expect(message).toContain('Beta · claude #2');
    expect(message).toContain('이미 받았을 수 있습니다');
    expect(message).toContain('취소하면 보내지 않고');
    const receipt = held('Beta', 'Claude Code');
    expect(receipt).toContain('보내지 않았습니다');
    expect(receipt).toContain('작성 중인 내용은 유지했습니다');
  });
});
