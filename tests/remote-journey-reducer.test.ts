import {describe, expect, test} from 'bun:test';
import {
  parseRemoteJourneyLog, reduceRemoteJourney, remoteJourneyCaptureRecord, remoteJourneyClockHash, remoteJourneyMethodHash,
  RemoteJourneyInputError, type RemoteJourneyEvent, type RemoteJourneyLog,
} from '../src/remoteJourneyReducer';
import {assembleBenchmarkManifest} from '../src/voiceBenchmarkAssembler';
import {buildBenchmarkProtocol} from '../src/voiceBenchmarkProtocol';
import {evaluateBenchmark} from '../src/voiceRemoteBenchmark';
import {benchmarkSpec, epoch, h} from './fixtures/voice-benchmark-spec';

/** Golden event logs for the candidate-side remote journey. Invented timings; never a product measurement. */
const T = epoch + 10_000, NONCE = 'n7Kq2Lm9Xa', TARGET = 'ctl-project-a';
const D1 = h(1), D2 = h(2);
const log = (events: RemoteJourneyEvent[], extra: Partial<RemoteJourneyLog> = {}): RemoteJourneyLog =>
  ({schemaVersion: 1, metric: 'workflow', nonce: NONCE, deadlineMs: 120_000, events, ...extra});
const tap = (t: number, target = 'workroom-send'): RemoteJourneyEvent => ({t: T + t, kind: 'tap', target});
const draft = (t: number, digest: string | null, intentional = false): RemoteJourneyEvent => ({t: T + t, kind: 'draft', digest, intentional});
const submit = (t: number, submissionId: string | null, draftDigest = D1, targetId = TARGET): RemoteJourneyEvent =>
  ({t: T + t, kind: 'submit', submissionId, draftDigest, targetId});
const receipt = (t: number, submissionId: string | null, state: 'written' | 'unknown' | 'rejected' | 'held' | 'prepared', storeId: string | null = 'store-0001', targetId: string | null = TARGET): RemoteJourneyEvent =>
  ({t: T + t, kind: 'receipt', submissionId, storeId, state, targetId});
const answer = (t: number, count = 1, nonce = NONCE): RemoteJourneyEvent => ({t: T + t, kind: 'answer', nonce, count});

/** Open the Workroom (2 taps), write the draft, send (1 tap), written receipt, nonce answer. */
const canonical = (): RemoteJourneyEvent[] => [
  tap(0, 'tab-workroom'), tap(400, 'workroom-session'), draft(900, D1), tap(1_000), submit(1_000, 'sub-00000001'),
  receipt(1_600, 'sub-00000001', 'written'), draft(1_700, null), answer(4_000),
];

describe('remote journey reducer — golden logs', () => {
  test('a canonical journey gives effort = taps + re-entries and latency from journey start to the nonce answer', () => {
    const r = reduceRemoteJourney(log(canonical()));
    expect(r).toEqual({outcome: 'ok', latencyMs: 4_000, elapsedMs: 4_000, startedAt: T, effortCount: 3, retryCount: 0,
      violations: [], taskStateObserved: true, reasons: []});
  });

  test('re-entries count as effort; a lock-return latency runs from the perturbation end to the answer of a request sent after it', () => {
    const r = reduceRemoteJourney(log([
      tap(0, 'tab-workroom'), draft(500, D1),
      {t: T + 1_000, kind: 'perturb', phase: 'start', cause: 'lock'}, {t: T + 1_100, kind: 'disconnect', cause: 'lock'},
      {t: T + 8_000, kind: 'perturb', phase: 'end', cause: 'lock'}, {t: T + 8_500, kind: 'reentry', reason: 'lock'},
      {t: T + 9_000, kind: 'reconnect'}, tap(9_100), submit(9_100, 'sub-00000001'), receipt(9_400, 'sub-00000001', 'written'), answer(9_800),
    ], {metric: 'lock-return'}));
    expect(r.effortCount).toBe(3);
    expect(r.latencyMs).toBe(1_800);
    expect(r.outcome).toBe('ok');
    expect(r.violations).toEqual([]);
    expect(r.reasons).toEqual([]);
  });

  test('a recovery answer to a request sent before the perturbation ended measures nothing about recovery', () => {
    // The CLI answered while the phone was locked; the answer is first seen right after the human says "done".
    const before = reduceRemoteJourney(log([
      tap(0, 'tab-workroom'), draft(500, D1), tap(600), submit(600, 'sub-00000001'),
      {t: T + 1_000, kind: 'perturb', phase: 'start', cause: 'lock'}, {t: T + 21_000, kind: 'perturb', phase: 'end', cause: 'lock'},
      receipt(21_000, 'sub-00000001', 'written'), answer(21_000),
    ], {metric: 'lock-return'}));
    expect(before.outcome).toBe('ok');
    expect(before.latencyMs).toBeNull();
    expect(before.reasons).toContain('SUBMIT_BEFORE_RECOVERY');
    // An answer already observed before the end (Mac app quit after it answered) is not a recovery either.
    const answered = reduceRemoteJourney(log([
      tap(0), draft(10, D1), submit(20, 'sub-00000001'), receipt(300, 'sub-00000001', 'written'), answer(2_000),
      {t: T + 3_000, kind: 'perturb', phase: 'start', cause: 'host-restart'}, {t: T + 30_000, kind: 'perturb', phase: 'end', cause: 'host-restart'},
      {t: T + 30_100, kind: 'reconnect'},
    ], {metric: 'host-restart'}));
    expect(answered.latencyMs).toBeNull();
    expect(answered.reasons).toContain('ANSWER_BEFORE_RECOVERY');
    expect(answered.reasons).not.toContain('PERTURBATION_END_MISSING');
  });

  test('a recovery metric without a recorded perturbation end has no latency, not a guessed one', () => {
    const r = reduceRemoteJourney(log(canonical(), {metric: 'wifi-change'}));
    expect(r.latencyMs).toBeNull();
    expect(r.reasons).toContain('PERTURBATION_END_MISSING');
  });

  test('a double tap that reuses one submission and one receipt is a retry, never a duplicate action', () => {
    const r = reduceRemoteJourney(log([
      tap(0, 'tab-workroom'), draft(500, D1), tap(600), submit(600, 'sub-00000001'), tap(650), submit(650, 'sub-00000001'),
      receipt(1_200, 'sub-00000001', 'written'), receipt(1_300, 'sub-00000001', 'written'), answer(3_000),
    ]));
    expect(r.violations).toEqual([]);
    expect(r.retryCount).toBe(1);
    expect(r.effortCount).toBe(3);
  });

  test('two written receipts from one tap give duplicate-action', () => {
    const r = reduceRemoteJourney(log([
      tap(0, 'tab-workroom'), draft(500, D1), tap(600), submit(600, 'sub-00000001'),
      receipt(1_200, 'sub-00000001', 'written', 'store-0001'), receipt(1_250, 'sub-00000001', 'written', 'store-0002'), answer(3_000),
    ]));
    expect(r.violations).toEqual(['duplicate-action']);
  });

  test('two submission ids that both reach written for one nonce give duplicate-action', () => {
    const r = reduceRemoteJourney(log([
      tap(0), submit(0, 'sub-00000001'), receipt(500, 'sub-00000001', 'unknown', null),
      tap(2_000), submit(2_000, 'sub-00000002'), receipt(2_500, 'sub-00000002', 'written', 'store-0002'),
      receipt(2_600, 'sub-00000001', 'written', 'store-0001'), answer(4_000),
    ]));
    expect(r.violations).toEqual(['duplicate-action']);
    expect(r.retryCount).toBe(1);
  });

  test('the nonce answered twice on screen gives duplicate-action even without receipt ids', () => {
    const r = reduceRemoteJourney(log([tap(0), draft(10, D1), submit(20, null), receipt(500, null, 'written', null), answer(2_000), answer(2_500, 2)]));
    expect(r.violations).toEqual(['duplicate-action']);
  });

  test('a missing answer gives outcome timeout with null latency', () => {
    const r = reduceRemoteJourney(log([tap(0), draft(10, D1), submit(20, 'sub-00000001'), receipt(500, 'sub-00000001', 'written'), {t: T + 130_000, kind: 'tap', target: 'workroom-session'}]));
    expect(r.outcome).toBe('timeout');
    expect(r.latencyMs).toBeNull();
    expect(r.taskStateObserved).toBe(false);
  });

  test('an answer after the deadline is a timeout', () => {
    const r = reduceRemoteJourney(log([tap(0), draft(10, D1), submit(20, 'sub-00000001'), receipt(500, 'sub-00000001', 'written'), answer(121_000)]));
    expect(r.outcome).toBe('timeout');
    expect(r.latencyMs).toBeNull();
  });

  test('a refused request without an answer is an error, not a timeout', () => {
    const r = reduceRemoteJourney(log([tap(0), draft(10, D1), submit(20, 'sub-00000001'), receipt(500, 'sub-00000001', 'rejected', null)]));
    expect(r.outcome).toBe('error');
  });

  test('an answer seen before any submit is not this journey\'s answer', () => {
    const r = reduceRemoteJourney(log([tap(0), answer(100), draft(200, D1), submit(300, 'sub-00000001')]));
    expect(r.outcome).toBe('timeout');
    expect(r.reasons).toContain('ANSWER_BEFORE_SUBMIT');
  });
});

describe('remote journey reducer — draft and grant safety', () => {
  test('an unsent draft cleared across a reconnect gives draft-lost', () => {
    const r = reduceRemoteJourney(log([
      tap(0), draft(500, D1), {t: T + 600, kind: 'disconnect', cause: 'wifi'}, {t: T + 5_000, kind: 'reconnect'},
      {t: T + 5_100, kind: 'reentry', reason: 'reconnect'}, draft(5_200, null),
    ]));
    expect(r.violations).toEqual(['draft-lost']);
  });

  test('an uncertain submission that keeps its draft is not draft-lost', () => {
    const r = reduceRemoteJourney(log([
      tap(0), draft(500, D1), tap(600), submit(600, 'sub-00000001'), receipt(900, 'sub-00000001', 'unknown', null), draft(1_000, D1),
    ]));
    expect(r.violations).toEqual([]);
  });

  test('an uncertain submission whose draft is cleared gives draft-lost', () => {
    const r = reduceRemoteJourney(log([
      tap(0), draft(500, D1), tap(600), submit(600, 'sub-00000001'), receipt(900, 'sub-00000001', 'unknown', null), draft(1_000, null),
    ]));
    expect(r.violations).toEqual(['draft-lost']);
  });

  test('the legacy input path (no submission record) empties the composer by sending: that clear is not draft-lost', () => {
    // An older Mac without terminal-submission-v1: the panel sends and clears at once, no pending record exists.
    const r = reduceRemoteJourney(log([tap(0), draft(500, D1), tap(600), submit(600, null), draft(700, null), {t: T + 130_000, kind: 'reconnect'}]));
    expect(r.outcome).toBe('timeout');
    expect(r.violations).toEqual([]);
    // The discharge is tied to the digest that was sent: a different draft cleared later is still lost.
    expect(reduceRemoteJourney(log([tap(0), draft(500, D1), submit(600, null), draft(700, null), draft(800, D2), draft(900, null)])).violations)
      .toEqual(['draft-lost']);
    // A legacy submit of the draft before it reappeared does not discharge the reappeared copy.
    expect(reduceRemoteJourney(log([tap(0), draft(100, D1), submit(200, null), draft(300, null), draft(400, D1), draft(500, null)])).violations)
      .toEqual(['draft-lost']);
  });

  test('a draft restored after a reload is not lost, and a deliberate rewrite discharges the old draft', () => {
    expect(reduceRemoteJourney(log([tap(0), draft(500, D1), draft(800, null), {t: T + 900, kind: 'reentry', reason: 'relaunch'}, draft(1_000, D1)])).violations).toEqual([]);
    expect(reduceRemoteJourney(log([tap(0), draft(500, D1), draft(800, D2, true)])).violations).toEqual([]);
  });

  test('a written draft cleared by the client is delivered, not lost', () => {
    expect(reduceRemoteJourney(log(canonical())).violations).toEqual([]);
  });

  test('a grant revoked mid-trial followed by refused input gives no grant-bypass', () => {
    const r = reduceRemoteJourney(log([
      tap(0), draft(100, D1), {t: T + 200, kind: 'gate', grant: 'revoked'}, tap(300), submit(300, 'sub-00000001'),
      receipt(600, 'sub-00000001', 'rejected', null), draft(700, D1),
    ]));
    expect(r.violations).toEqual([]);
    expect(r.outcome).toBe('error');
  });

  test('accepted input after a revoke gives grant-bypass', () => {
    const r = reduceRemoteJourney(log([
      tap(0), draft(100, D1), {t: T + 200, kind: 'gate', grant: 'revoked'}, tap(300), submit(300, 'sub-00000001'),
      receipt(600, 'sub-00000001', 'written'), answer(2_000),
    ]));
    expect(r.violations).toEqual(['grant-bypass']);
  });

  test('input sent before the revoke and written after is not attributed as a bypass, and a re-grant ends the revoke', () => {
    expect(reduceRemoteJourney(log([tap(0), draft(10, D1), submit(20, 'sub-00000001'), {t: T + 30, kind: 'gate', grant: 'revoked'},
      receipt(600, 'sub-00000001', 'written'), answer(2_000)])).violations).toEqual([]);
    expect(reduceRemoteJourney(log([tap(0), draft(10, D1), {t: T + 15, kind: 'gate', grant: 'revoked'}, {t: T + 18, kind: 'gate', grant: 'granted'},
      submit(20, 'sub-00000001'), receipt(600, 'sub-00000001', 'written'), answer(2_000)])).violations).toEqual([]);
  });

  test('an answer after an untracked submit during a revoke is not attributed while an earlier request is unanswered', () => {
    const r = reduceRemoteJourney(log([
      tap(0), draft(10, D1), submit(20, null, D1), {t: T + 25, kind: 'gate', grant: 'revoked'},
      draft(26, D2, true), submit(28, null, D2), answer(30_000),
    ]));
    expect(r.violations).toEqual([]);
    expect(r.reasons).toContain('BYPASS_UNATTRIBUTABLE');
    // Nothing earlier is outstanding (the first request was answered before the revoke): the later answer is evidence.
    expect(reduceRemoteJourney(log([
      tap(0), draft(10, D1), submit(20, null, D1), answer(500), {t: T + 600, kind: 'gate', grant: 'revoked'},
      draft(700, D2, true), submit(800, null, D2), answer(30_000, 2),
    ])).violations).toContain('grant-bypass');
    // With no earlier submit at all, an untracked submit while revoked that is answered is a bypass.
    expect(reduceRemoteJourney(log([
      tap(0), draft(10, D1), {t: T + 15, kind: 'gate', grant: 'revoked'}, submit(20, null, D1), answer(2_000),
    ])).violations).toEqual(['grant-bypass']);
  });

  test('a receipt naming another target gives wrong-target', () => {
    const r = reduceRemoteJourney(log([tap(0), draft(10, D1), submit(20, 'sub-00000001'), receipt(600, 'sub-00000001', 'written', 'store-0001', 'ctl-project-b'), answer(2_000)]));
    expect(r.violations).toEqual(['wrong-target']);
  });
});

describe('remote journey log admission', () => {
  test('unknown keys, out-of-order time, unknown kinds and malformed values are refused', () => {
    const bad: unknown[] = [
      {...log(canonical()), extra: 1},
      log([tap(100), tap(0)]),
      log([{t: T, kind: 'swipe'} as unknown as RemoteJourneyEvent]),
      log([{...tap(0), note: 'x'} as unknown as RemoteJourneyEvent]),
      log([submit(0, 'bad id with spaces')]),
      log([answer(0, 0)]),
      log([]),
      {...log(canonical()), metric: 'response'},
      {...log(canonical()), nonce: 'short'},
      '{not json',
    ];
    for (const value of bad) expect(() => parseRemoteJourneyLog(value)).toThrow(RemoteJourneyInputError);
  });

  test('a valid log round-trips through JSON text', () => {
    const value = log(canonical());
    expect(parseRemoteJourneyLog(JSON.stringify(value))).toEqual(value);
  });

  test('method and clock hashes are stable, sealed per metric and distinct from the voice clocks', () => {
    expect(remoteJourneyMethodHash()).toMatch(/^[a-f0-9]{64}$/);
    expect(remoteJourneyClockHash('workflow')).not.toBe(remoteJourneyClockHash('lock-return'));
    expect(remoteJourneyClockHash('workflow')).toBe(remoteJourneyClockHash('workflow'));
  });
});

describe('remote journey → benchmark assembler', () => {
  test('a reduced journey becomes a remote capture whose violations and task proof reach the evaluator', () => {
    const protocol = buildBenchmarkProtocol(benchmarkSpec());
    const group = protocol.groups.find(g => g.metric === 'workflow')!, pair = group.pairs[0]!;
    const duplicate = reduceRemoteJourney(log([
      tap(0), draft(500, D1), tap(600), submit(600, 'sub-00000001'),
      receipt(1_200, 'sub-00000001', 'written', 'store-0001'), receipt(1_250, 'sub-00000001', 'written', 'store-0002'), answer(3_000),
    ]));
    const capture = remoteJourneyCaptureRecord(duplicate, {attemptId: pair.id + '_candidate', pairId: pair.id, side: 'candidate',
      cleanup: 'confirmed', captureHash: h(77), physicalDevice: true, authenticated: true});
    expect(capture.inputRoute).toEqual({kind: 'none'});
    expect(capture.timing).toBeNull();
    expect(capture.manualCommit).toBe(false);
    const manifest = assembleBenchmarkManifest({protocol, captures: [capture], sheet: []});
    const trial = manifest.trials[0]!;
    expect(trial.violations).toEqual(['duplicate-action']);
    expect(trial.latencyMs).toBe(3_000);
    expect(trial.effortCount).toBe(2);
    expect(trial.proof.taskStateObserved).toBe(true);
    expect(trial.proof.physicalMicrophone).toBe(false);
    const evaluation = evaluateBenchmark(manifest);
    expect(evaluation.groups.find(g => g.metric === 'workflow')!.reasons).toContain('UNSAFE_OUTCOME');
  });

  test('task state is never attested by the reducer for an unanswered journey', () => {
    const reduced = reduceRemoteJourney(log([tap(0), draft(10, D1), submit(20, 'sub-00000001'), receipt(500, 'sub-00000001', 'written')]));
    const capture = remoteJourneyCaptureRecord(reduced, {attemptId: 'a1', pairId: 'p1', side: 'candidate', cleanup: 'unknown', captureHash: null,
      physicalDevice: true, authenticated: true});
    expect(capture.operator.taskStateObserved).toBe(false);
    expect(capture.startedAt).toBe(T);
  });
});
