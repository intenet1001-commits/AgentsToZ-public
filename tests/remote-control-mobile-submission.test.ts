/**
 * The LAN QR page's whole-request submission client, held against the TypeScript client it mirrors.
 *
 * The page is a plain script served over HTTP: it cannot import `submitWorkroomDraft`, so it embeds its own copy
 * with `toString()`. A second implementation can drift from the first. These tests run the shipped copy (built
 * standalone, exactly as the page builds it) and the TypeScript client side by side against the same fake host and
 * require the same requests, in the same order, with the same bytes — and the same refusals.
 */
import {describe, expect, test} from 'bun:test';
import {lanWorkroomSubmissionClient, REMOTE_CONTROL_MOBILE_JS} from '../src/remoteControlMobilePage';
import {projectCreationIntentFingerprint} from '../src/projectLaunchIntent';
import {submissionDigest, validateSubmissionText, normalizeWorkroomSubmission, type WorkroomSubmissionReceipt} from '../src/workroomSubmissionProtocol';
import {submitWorkroomDraft, readPendingSubmission, writePendingSubmission, pendingSubmissionKey, WORKROOM_SUBMISSION_UNSUPPORTED_NOTICE, WorkroomSubmissionUnsupportedError, draftAfterWrittenStatus, pendingAfterStatus, SUBMISSION_UNPARSED_MESSAGES, readPendingLaunch, writePendingLaunch, pendingLaunchKey, launchNeverStarted} from '../src/workroomSubmissionClient';
import {COMMUNITY_CONTROL_TERMINAL_ONLY_ERROR} from '../src/agentDialogueControl';
import {normalizeAiTerminalRequest} from '../src/aiTerminalProtocol';

/** The factory as the page builds it: from its source text alone, with no access to this module's scope. */
function standaloneClient() {
  const factory = new Function(`return (${lanWorkroomSubmissionClient.toString()});`)() as typeof lanWorkroomSubmissionClient;
  const sha256Hex = new Function(`return (${projectCreationIntentFingerprint.toString()});`)() as (text: string) => string;
  return factory({sha256Hex, terminalOnlyError: COMMUNITY_CONTROL_TERMINAL_ONLY_ERROR, unsupportedNotice: WORKROOM_SUBMISSION_UNSUPPORTED_NOTICE, unparsedMessages: SUBMISSION_UNPARSED_MESSAGES});
}

class MemoryStorage {
  #items = new Map<string, string>();
  get length() { return this.#items.size; }
  key(index: number) { return [...this.#items.keys()][index] ?? null; }
  getItem(key: string) { return this.#items.get(key) ?? null; }
  setItem(key: string, value: string) { this.#items.set(key, String(value)); }
  removeItem(key: string) { this.#items.delete(key); }
  clear() { this.#items.clear(); }
}

/** A host that answers like the terminal service: prepared until the committing chunk, then written. */
function fakeHost(options: {loseAckAt?: number; finalState?: WorkroomSubmissionReceipt['state']; epochChangeAt?: number; firstError?: string} = {}) {
  const requests: unknown[] = [];
  // The host keeps one input revision per record: every receipt of one submission repeats it.
  const revision = 7;
  const request = async (value: any) => {
    // Every request must survive the host's own strict parser.
    normalizeAiTerminalRequest({...value, requestId: 'golden-request'});
    requests.push(value);
    const index = requests.length - 1;
    if (index === 0 && options.firstError) throw new Error(options.firstError);
    if (options.loseAckAt === index) throw new Error('응답을 확인하지 못했습니다. 입력이 전달되었을 수 있으므로 화면을 확인하세요.');
    const command = value.submission;
    const last = command.phase === 'single' || command.commit === true || (command.phase === 'begin' && command.chunks === 1);
    const epoch = options.epochChangeAt === index ? 'epoch-changed' : 'epoch-0001';
    return {submission: {id: command.id, storeId: 'store-0001', epoch, revision, state: last ? (options.finalState ?? 'written') : 'prepared'}};
  };
  return {request, requests};
}

async function both(text: string, references?: string[], hostOptions: Parameters<typeof fakeHost>[0] = {}) {
  const id = 'lan-' + 'a'.repeat(32), sessionId = 'session-0001';
  const ts = fakeHost(hostOptions), lan = fakeHost(hostOptions);
  const tsPrepared: unknown[] = [], lanPrepared: unknown[] = [];
  const tsResult = await submitWorkroomDraft({id, sessionId, text, references, request: ts.request as never, prepared: receipt => tsPrepared.push(receipt)}).then(value => ({value}), error => ({error: (error as Error).message}));
  const lanResult = await standaloneClient().submit({id, sessionId, text, references, request: lan.request, prepared: receipt => lanPrepared.push(receipt)}).then(value => ({value}), error => ({error: (error as Error).message}));
  return {ts, lan, tsResult, lanResult, tsPrepared, lanPrepared};
}

const encode = (text: string) => new TextEncoder().encode(text);

describe('LAN page submission client', () => {
  test('the page bundle embeds the standalone client, the hash and the status helpers', () => {
    expect(REMOTE_CONTROL_MOBILE_JS).toContain(lanWorkroomSubmissionClient.toString());
    expect(REMOTE_CONTROL_MOBILE_JS).toContain(draftAfterWrittenStatus.toString());
    expect(REMOTE_CONTROL_MOBILE_JS).toContain(pendingAfterStatus.toString());
    // Built from its text alone, it works: no reference to this module's scope.
    expect(typeof standaloneClient().submit).toBe('function');
  });

  test('the HTTP-safe SHA-256 equals the protocol digest for Korean, emoji and a 24,000-byte request', () => {
    const sha256Hex = new Function(`return (${projectCreationIntentFingerprint.toString()});`)() as (text: string) => string;
    for (const text of ['ab\r', '한글 요청을 보냅니다\r', '😀👍🏽 emoji 🇰🇷\r', '한'.repeat(7999) + '\r', 'x'.repeat(23999) + '\r', '가😀'.repeat(3428) + '\r']) {
      expect(encode(text).length).toBeLessThanOrEqual(24000);
      expect(sha256Hex(text)).toBe(submissionDigest(encode(text)));
    }
  });

  test('golden: the same request sequence as submitWorkroomDraft, single through six chunks', async () => {
    const texts = [
      'ab\r',
      '한글 요청\r',
      'x'.repeat(3999) + '\r', // exactly one chunk
      'x'.repeat(4000) + '\r', // 4,001 bytes: begin + one committing chunk
      '한'.repeat(1400) + '😀\r', // a chunk boundary inside a multi-byte character
      '가😀'.repeat(3428) + '\r', // 23,997 bytes, six chunks
      'x'.repeat(23999) + '\r', // the maximum
    ];
    for (const text of texts) {
      for (const references of [undefined, ['project-0001', 'project-0002']]) {
        const run = await both(text, references);
        expect(run.lanResult).toEqual(run.tsResult);
        expect(run.lan.requests).toEqual(run.ts.requests);
        expect(run.lanPrepared).toEqual(run.tsPrepared);
        expect('value' in run.lanResult && run.lanResult.value.state).toBe('written');
        for (const request of run.lan.requests as any[]) expect(normalizeWorkroomSubmission(request.submission)).toEqual(request.submission);
      }
    }
  });

  test('golden: refusals and unknown outcomes match, and never continue past them', async () => {
    const big = '한'.repeat(5000) + '\r';
    for (const options of [{loseAckAt: 0}, {loseAckAt: 2}, {epochChangeAt: 2}, {finalState: 'unknown' as const}, {finalState: 'held' as const}]) {
      const run = await both(big, undefined, options);
      expect(run.lanResult).toEqual(run.tsResult);
      expect(run.lan.requests).toEqual(run.ts.requests);
    }
    const lost = await both(big, undefined, {loseAckAt: 1});
    expect('error' in lost.lanResult).toBe(true);
    // After the lost ack nothing more is sent — no later chunk, and never a raw `input`.
    expect(lost.lan.requests).toHaveLength(2);
    expect((lost.lan.requests as any[]).every(request => request.operation === 'submission')).toBe(true);
  });

  test('an older receiver that refuses the first request is reported as unsupported; after an answer it is not', async () => {
    const first = await both('hello\r', undefined, {firstError: COMMUNITY_CONTROL_TERMINAL_ONLY_ERROR});
    expect(first.tsResult).toEqual({error: WORKROOM_SUBMISSION_UNSUPPORTED_NOTICE});
    expect(first.lanResult).toEqual({error: WORKROOM_SUBMISSION_UNSUPPORTED_NOTICE});
    const client = standaloneClient();
    const refused = await client.submit({id: 'lan-' + 'b'.repeat(32), sessionId: 'session-0001', text: 'hello\r', request: async () => { throw new Error(COMMUNITY_CONTROL_TERMINAL_ONLY_ERROR); }}).catch(error => error);
    expect(refused.unsupported).toBe(true);
    expect(await submitWorkroomDraft({id: 'lan-' + 'b'.repeat(32), sessionId: 'session-0001', text: 'hello\r', request: async () => { throw new Error(COMMUNITY_CONTROL_TERMINAL_ONLY_ERROR); }, prepared() {}}).catch(error => error)).toBeInstanceOf(WorkroomSubmissionUnsupportedError);
    // The same sentence after the host already answered is an ordinary failure: something may have been prepared.
    let calls = 0;
    const later = await client.submit({id: 'lan-' + 'c'.repeat(32), sessionId: 'session-0001', text: '한'.repeat(2000) + '\r', request: async (value: any) => {
      if (calls++ === 0) return {submission: {id: value.submission.id, storeId: 'store-0001', epoch: 'epoch-0001', revision: 1, state: 'prepared'}};
      throw new Error(COMMUNITY_CONTROL_TERMINAL_ONLY_ERROR);
    }}).catch(error => error);
    expect(later.unsupported).toBeUndefined();
    expect(later.message).toBe(COMMUNITY_CONTROL_TERMINAL_ONLY_ERROR);
  });

  test('the same text is refused with the same sentence before anything is sent', async () => {
    const client = standaloneClient();
    for (const text of ['a', 'no enter', 'two\rlines\r', 'bell\x07\r', 'x'.repeat(24000) + '\r', '\ud800\r']) {
      const expected = (() => { try { validateSubmissionText(text); return null; } catch (error) { return (error as Error).message; } })();
      expect(expected).not.toBeNull();
      const sent: unknown[] = [];
      const error = await client.submit({id: 'lan-' + 'd'.repeat(32), sessionId: 'session-0001', text, request: async (value: unknown) => { sent.push(value); return {}; }}).catch(e => e);
      expect(error.message).toBe(expected);
      expect(sent).toEqual([]);
    }
  });

  test('a receipt for another request or a malformed receipt stops the client', async () => {
    const client = standaloneClient();
    const other = await client.submit({id: 'lan-' + 'e'.repeat(32), sessionId: 'session-0001', text: 'hi\r', request: async () => ({submission: {id: 'someone-else-01', storeId: 'store-0001', epoch: 'epoch-0001', revision: 1, state: 'written'}})}).catch(e => e);
    expect(other.message).toBe('다른 요청의 제출 영수증입니다. 자동으로 다시 보내지 않습니다.');
    const malformed = await client.submit({id: 'lan-' + 'e'.repeat(32), sessionId: 'session-0001', text: 'hi\r', request: async () => ({submission: {id: 'lan-' + 'e'.repeat(32), storeId: 'store-0001', epoch: 'epoch-0001', revision: 1, state: 'written', extra: 1}})}).catch(e => e);
    expect(malformed.message).toBe('제출 영수증을 확인하지 못했습니다. 자동으로 다시 보내지 않습니다.');
  });

  test('status asks once for the same id and refuses a receipt from another store', async () => {
    const client = standaloneClient();
    const sent: any[] = [];
    const pending = {id: 'lan-' + 'f'.repeat(32), sessionId: 'session-0001', receipt: {id: 'lan-' + 'f'.repeat(32), storeId: 'store-0001', epoch: 'epoch-0001', revision: 2, state: 'prepared' as const}};
    const receipt = await client.status({pending, request: async (value: any) => { sent.push(value); return {submission: {...pending.receipt, revision: 3, state: 'written'}}; }});
    expect(receipt.state).toBe('written');
    expect(sent).toEqual([{operation: 'submission', sessionId: 'session-0001', submission: {phase: 'status', id: pending.id}}]);
    expect(() => normalizeAiTerminalRequest({...sent[0], requestId: 'status-request'})).not.toThrow();
    const moved = await client.status({pending, request: async () => ({submission: {...pending.receipt, storeId: 'store-other'}})}).catch(e => e);
    expect(moved.message).toBe('같은 호스트의 제출 기록을 확인하지 못했습니다. 자동으로 다시 보내지 않습니다.');
  });

  test('pending records interoperate with the TypeScript store, including the 32-record limit', () => {
    const client = standaloneClient();
    const storage = new MemoryStorage();
    expect(client.key('lan', 'session-0001')).toBe(pendingSubmissionKey('lan', 'session-0001'));
    const record = {id: 'lan-' + '1'.repeat(32), sessionId: 'session-0001', receipt: {id: 'lan-' + '1'.repeat(32), storeId: 'store-0001', epoch: 'epoch-0001', revision: 1, state: 'prepared' as const}};
    client.write(storage as unknown as Storage, client.key('lan', 'session-0001'), record);
    expect(readPendingSubmission(storage, pendingSubmissionKey('lan', 'session-0001'))).toEqual(record);
    writePendingSubmission(storage as unknown as Storage, pendingSubmissionKey('lan', 'session-0002'), {...record, sessionId: 'session-0002', receipt: null});
    expect(client.read(storage, client.key('lan', 'session-0002'))).toEqual({...record, sessionId: 'session-0002', receipt: null});
    for (let i = 3; i <= 32; i++) client.write(storage as unknown as Storage, client.key('lan', 'session-' + String(i).padStart(4, '0')), {...record, sessionId: 'session-' + String(i).padStart(4, '0'), receipt: null});
    const tsFull = (() => { try { writePendingSubmission(storage as unknown as Storage, pendingSubmissionKey('lan', 'session-0099'), {...record, receipt: null}); return null; } catch (e) { return (e as Error).message; } })();
    const lanFull = (() => { try { client.write(storage as unknown as Storage, client.key('lan', 'session-0099'), {...record, receipt: null}); return null; } catch (e) { return (e as Error).message; } })();
    expect(lanFull).not.toBeNull();
    expect(lanFull).toBe(tsFull);
    // Overwriting an existing record is still allowed at the limit, and clearing one removes it.
    client.write(storage as unknown as Storage, client.key('lan', 'session-0001'), null);
    expect(client.read(storage, client.key('lan', 'session-0001'))).toBeNull();
    // A tampered record is refused by both, with the same sentence.
    storage.setItem(client.key('lan', 'session-0003'), JSON.stringify({...record, extra: true}));
    const tsBad = (() => { try { readPendingSubmission(storage, pendingSubmissionKey('lan', 'session-0003')); return null; } catch (e) { return (e as Error).message; } })();
    const lanBad = (() => { try { client.read(storage, client.key('lan', 'session-0003')); return null; } catch (e) { return (e as Error).message; } })();
    expect(lanBad).toBe(tsBad);
    expect(lanBad).not.toBeNull();
  });
});

// w2-followups #14: the LAN page's `@` route opens a new session through a launch receipt, mirroring submitWorkroomDraft.
describe('LAN page launch client', () => {
  const LAUNCH = {targetId: 'target-0001', agent: 'claude', cols: 90, rows: 30};
  function launchHost(options: {finalState?: WorkroomSubmissionReceipt['state']; loseAckAt?: number; switchSessionAt?: number; firstError?: string} = {}) {
    const requests: unknown[] = [];
    const request = async (value: any) => {
      normalizeAiTerminalRequest({...value, requestId: 'golden-request'});
      requests.push(value);
      const index = requests.length - 1;
      if (index === 0 && options.firstError) throw new Error(options.firstError);
      if (options.loseAckAt === index) throw new Error('응답을 확인하지 못했습니다. 입력이 전달되었을 수 있으므로 화면을 확인하세요.');
      const command = value.submission;
      const last = command.phase === 'single' || command.commit === true || (command.phase === 'begin' && command.chunks === 1);
      const sessionId = options.switchSessionAt === index ? 'session-other-01' : 'session-launch-01';
      return {submission: {id: command.id, storeId: 'store-0001', epoch: 'epoch-0001', revision: 4, state: last ? (options.finalState ?? 'written') : 'prepared', sessionId, targetId: 'target-0001', agent: 'claude'}};
    };
    return {request, requests};
  }
  async function bothLaunch(text: string, options: Parameters<typeof launchHost>[0] = {}) {
    const id = 'lan-' + 'a'.repeat(32);
    const ts = launchHost(options), lan = launchHost(options);
    const tsResult = await submitWorkroomDraft({id, text, launch: LAUNCH as never, request: ts.request as never, prepared() {}}).then(value => ({value}), error => ({error: (error as Error).message}));
    const lanResult = await standaloneClient().submit({id, text, launch: LAUNCH, request: lan.request}).then(value => ({value}), error => ({error: (error as Error).message, unsupported: (error as {unsupported?: boolean}).unsupported}));
    return {ts, lan, tsResult: tsResult as any, lanResult: lanResult as any};
  }

  test('golden: the same launch requests as submitWorkroomDraft, with no sessionId on any phase', async () => {
    for (const text of ['ab\r', '한글 요청\r', 'x'.repeat(4000) + '\r', '가😀'.repeat(3428) + '\r']) {
      const run = await bothLaunch(text);
      expect(run.lanResult).toEqual(run.tsResult);
      expect(run.lan.requests).toEqual(run.ts.requests);
      for (const request of run.lan.requests as any[]) {
        expect(request.sessionId).toBeUndefined();
        expect(normalizeWorkroomSubmission(request.submission)).toEqual(request.submission);
      }
      expect((run.lan.requests[0] as any).submission.launch).toEqual(LAUNCH);
      expect('value' in run.lanResult && run.lanResult.value.sessionId).toBe('session-launch-01');
    }
  });

  test('golden: unknown outcomes, lost answers and a receipt naming another session stop both clients alike', async () => {
    const big = '한'.repeat(5000) + '\r';
    for (const options of [{finalState: 'unknown' as const}, {finalState: 'rejected' as const}, {loseAckAt: 1}, {switchSessionAt: 1}]) {
      const run = await bothLaunch(big, options);
      expect(run.lanResult).toEqual(run.tsResult);
      expect(run.lan.requests).toEqual(run.ts.requests);
    }
  });

  test('a path that cannot parse a launch is unsupported before anything ran, in both clients', async () => {
    for (const message of SUBMISSION_UNPARSED_MESSAGES) {
      const run = await bothLaunch('hello\r', {firstError: message});
      expect(run.tsResult).toEqual({error: WORKROOM_SUBMISSION_UNSUPPORTED_NOTICE});
      expect(run.lanResult).toEqual({error: WORKROOM_SUBMISSION_UNSUPPORTED_NOTICE, unsupported: true});
    }
    // The same sentence for an ordinary submission (a session already runs) is not "unsupported": it is an error.
    const client = standaloneClient();
    const plain = await client.submit({id: 'lan-' + 'b'.repeat(32), sessionId: 'session-0001', text: 'hello\r', request: async () => { throw new Error(SUBMISSION_UNPARSED_MESSAGES[1]); }}).catch(error => error);
    expect(plain.unsupported).toBeUndefined();
  });

  test('a launch receipt is refused for an ordinary submission, and an ordinary receipt for a launch', async () => {
    const client = standaloneClient();
    const launchReceipt = {id: 'lan-' + 'c'.repeat(32), storeId: 'store-0001', epoch: 'epoch-0001', revision: 1, state: 'written', sessionId: 'session-launch-01', targetId: 'target-0001', agent: 'claude'};
    const ordinary = await client.submit({id: launchReceipt.id, sessionId: 'session-0001', text: 'hi\r', request: async () => ({submission: launchReceipt})}).catch(e => e);
    expect(ordinary.message).toBe('다른 요청의 제출 영수증입니다. 자동으로 다시 보내지 않습니다.');
    const {sessionId: _s, targetId: _t, agent: _a, ...plainReceipt} = launchReceipt;
    const launch = await client.submit({id: launchReceipt.id, text: 'hi\r', launch: LAUNCH, request: async () => ({submission: plainReceipt})}).catch(e => e);
    expect(launch.message).toBe('새 세션 시작 영수증을 확인하지 못했습니다. 자동으로 다시 보내지 않습니다.');
    // Half a launch receipt is malformed.
    const half = await client.submit({id: launchReceipt.id, text: 'hi\r', launch: LAUNCH, request: async () => ({submission: {...plainReceipt, sessionId: 'session-launch-01'}})}).catch(e => e);
    expect(half.message).toBe('제출 영수증을 확인하지 못했습니다. 자동으로 다시 보내지 않습니다.');
  });

  test('launch status carries no sessionId; never-started matches launchNeverStarted', async () => {
    const client = standaloneClient();
    const sent: any[] = [];
    const pending = {id: 'lan-' + 'd'.repeat(32), targetId: 'target-0001', agent: 'claude', receipt: null};
    const result = await client.launchStatus({pending, request: async (value: any) => { sent.push(value); return {submission: {id: pending.id, storeId: 'store-0001', epoch: 'epoch-0001', revision: 2, state: 'written', sessionId: 'session-launch-01', targetId: 'target-0001', agent: 'claude'}, session: {id: 'session-launch-01'}}; }});
    expect(sent).toEqual([{operation: 'submission', submission: {phase: 'status', id: pending.id}}]);
    expect(() => normalizeAiTerminalRequest({...sent[0], requestId: 'status-request'})).not.toThrow();
    expect(result.receipt.sessionId).toBe('session-launch-01');
    expect(result.session).toEqual({id: 'session-launch-01'});
    for (const state of ['prepared', 'write_started', 'written', 'unknown', 'rejected', 'held'] as const) {
      const value = {id: pending.id, storeId: 'store-0001', epoch: 'epoch-0001', revision: 0, state};
      expect(client.neverStarted(value)).toBe(launchNeverStarted(value));
    }
  });

  test('pending launch records interoperate with the TypeScript store, and tampering is refused alike', () => {
    const client = standaloneClient();
    const storage = new MemoryStorage();
    expect(client.launchKey('lan')).toBe(pendingLaunchKey('lan'));
    const record = {id: 'lan-' + 'e'.repeat(32), targetId: 'target-0001', agent: 'claude', receipt: {id: 'lan-' + 'e'.repeat(32), storeId: 'store-0001', epoch: 'epoch-0001', revision: 1, state: 'unknown' as const, sessionId: 'session-launch-01', targetId: 'target-0001', agent: 'claude' as const}};
    client.writeLaunch(storage, client.launchKey('lan'), record);
    expect(readPendingLaunch(storage, pendingLaunchKey('lan'))).toEqual(record as never);
    writePendingLaunch(storage, pendingLaunchKey('lan:ref'), {...record, receipt: null} as never);
    expect(client.readLaunch(storage, client.launchKey('lan:ref'))).toEqual({...record, receipt: null});
    for (const bad of [{...record, extra: 1}, {...record, targetId: null}, {...record, agent: 'gpt'}]) {
      storage.setItem(client.launchKey('bad'), JSON.stringify(bad));
      const ts = (() => { try { readPendingLaunch(storage, pendingLaunchKey('bad')); return null; } catch (e) { return (e as Error).message; } })();
      const lan = (() => { try { client.readLaunch(storage, client.launchKey('bad')); return null; } catch (e) { return (e as Error).message; } })();
      expect(lan).not.toBeNull();
      expect(lan).toBe(ts);
    }
    client.writeLaunch(storage, client.launchKey('lan'), null);
    expect(client.readLaunch(storage, client.launchKey('lan'))).toBeNull();
  });
});
