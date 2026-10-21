import {describe, expect, test} from 'bun:test';
import {evaluateBenchmark} from '../src/voiceRemoteBenchmark';
import {buildBenchmarkProtocol, nextOperatorStep, type ScheduledTrial} from '../src/voiceBenchmarkProtocol';
import {
  assembleBenchmarkManifest, physicalMicrophoneFromRoute, type CaptureRecord, type ScoreSheetRow,
} from '../src/voiceBenchmarkAssembler';
import {VOICE_EVAL_SCORER_HASH} from '../src/voiceEvalScoring';
import {timingMethodHash, DEFAULT_TIMING_PARAMS, type CaptureTiming} from '../src/voiceBenchmarkTiming';
import {benchmarkSpec, epoch, h} from './fixtures/voice-benchmark-spec';

const timing = (latencyMs: number): CaptureTiming => ({separation: 'separate-tracks', anchorMs: 300, stimulusEndMs: 2300,
  response: {kind: 'response', latencyMs, onsetMs: 2300 + latencyMs},
  interrupt: {kind: 'stopped', latencyMs, stopMs: 5000}, resume: {kind: 'resumed', latencyMs}, methodHash: timingMethodHash(DEFAULT_TIMING_PARAMS)});
interface Options {candidateMs?: number; referenceMs?: number; edit?: (c: CaptureRecord) => CaptureRecord | null; score?: boolean}
/** A full, honestly scheduled run: captures plus a deterministic scoring sheet. */
function run(options: Options = {}) {
  const spec = benchmarkSpec(), protocol = buildBenchmarkProtocol(spec);
  const captures: CaptureRecord[] = [], sheet: ScoreSheetRow[] = [], scheduled: ScheduledTrial[] = [];
  let now = epoch + 1000;
  for (let guard = 0; guard < 5000; guard++) {
    const step = nextOperatorStep(protocol, scheduled, now);
    if (step.kind === 'complete') break;
    if (step.kind === 'wait') {now = step.until;continue;}
    if (step.kind !== 'run') throw Error(JSON.stringify(step));
    const g = protocol.groups.find(g => g.id === step.groupId)!, c = protocol.cases.find(c => c.id === step.caseId)!;
    const sustained = g.metric === 'sustained-1h', elapsedMs = sustained ? 3_600_000 : 2000;
    const ms = step.side === 'candidate' ? options.candidateMs ?? 300 : options.referenceMs ?? 500;
    const attemptId = step.pairId + '_' + step.side;
    const record: CaptureRecord = {
      attemptId, pairId: step.pairId, side: step.side, startedAt: now, elapsedMs, outcome: 'ok',
      timing: g.domain === 'voice' ? timing(ms) : null, latencyMs: g.domain === 'remote' && !sustained ? ms : null,
      effortCount: step.side === 'candidate' ? 1 : 2, retryCount: 0, manualCommit: false, cleanup: 'confirmed', violations: [],
      inputRoute: g.domain === 'voice' ? {kind: 'external-microphone', deviceName: 'USB Audio Device'} : {kind: 'none'},
      device: {physical: true}, operator: {authenticated: true, taskStateObserved: true}, captureHash: h(700),
    };
    scheduled.push({pairId: step.pairId, side: step.side, startedAt: now, elapsedMs});
    const edited = options.edit ? options.edit(record) : record;
    if (edited) captures.push(edited);
    // A capture that was never recorded cannot be scored either.
    if (edited && options.score !== false) sheet.push({attemptId, verdict: 'correct', source: 'deterministic',
      expectedFactsHash: c.expectedFactsHash, evidenceHash: h(600), scorerHash: VOICE_EVAL_SCORER_HASH});
    now += elapsedMs;
  }
  const manifest = assembleBenchmarkManifest({protocol, captures, sheet, deterministicScorerHash: VOICE_EVAL_SCORER_HASH});
  return {manifest, evaluation: evaluateBenchmark(manifest)};
}
const reasons = (e: ReturnType<typeof evaluateBenchmark>, metric: string) => e.groups.find(g => g.metric === metric)!.reasons;

describe('benchmark trial assembler', () => {
  test('a complete honest run passes or fails on the latency ratio alone', () => {
    const pass = run({candidateMs: 300, referenceMs: 500});
    expect(pass.evaluation.groups.every(g => g.status === 'PASS')).toBe(true);
    expect(pass.evaluation.status).toBe('PASS');
    const slow = run({candidateMs: 400, referenceMs: 500});
    expect(slow.evaluation.status).toBe('FAIL');
    expect(reasons(slow.evaluation, 'response')).toEqual(['LATENCY_TARGET_MISSED']);
  });
  test('virtual input can never claim a physical microphone', () => {
    expect(physicalMicrophoneFromRoute({kind: 'external-microphone', deviceName: 'BlackHole 2ch'})).toBe(false);
    expect(physicalMicrophoneFromRoute({kind: 'external-microphone', deviceName: 'Loopback Audio'})).toBe(false);
    expect(physicalMicrophoneFromRoute({kind: 'virtual', deviceName: 'MacBook Pro Microphone'})).toBe(false);
    expect(physicalMicrophoneFromRoute({kind: 'file-injection'})).toBe(false);
    expect(physicalMicrophoneFromRoute({kind: 'built-in-microphone', deviceName: 'MacBook Pro Microphone'})).toBe(true);
    const virtual = run({edit: c => c.pairId === 'p0_0' && c.side === 'candidate'
      ? {...c, inputRoute: {kind: 'external-microphone', deviceName: 'BlackHole 16ch'}} : c});
    expect(virtual.manifest.trials.find(t => t.attemptId === 'p0_0_candidate')!.proof.physicalMicrophone).toBe(false);
    expect(reasons(virtual.evaluation, 'response')).toContain('NATIVE_PROOF_INCOMPLETE');
  });
  test('authenticated and task-state proof are never assumed', () => {
    const unattested = run({edit: c => c.pairId === 'p3_0' ? {...c, operator: {}} : c});
    const trial = unattested.manifest.trials.find(t => t.attemptId === 'p3_0_candidate')!;
    expect(trial.proof.authenticated).toBe(false);
    expect(trial.proof.taskStateObserved).toBe(false);
    expect(reasons(unattested.evaluation, 'workflow')).toContain('NATIVE_PROOF_INCOMPLETE');
  });
  test('an unscored success stays unscored and gives no latency statistics', () => {
    const unscored = run({score: false});
    const group = unscored.evaluation.groups.find(g => g.metric === 'response')!;
    expect(group.reasons).toContain('SEMANTICS_UNVERIFIED');
    expect(group.latency).toBeNull();
    expect(unscored.manifest.trials[0]!.semantics).toEqual({verdict: 'unscored', source: null, expectedFactsHash: null, evidenceHash: null});
  });
  test('a dropped reference capture is a missing planned attempt', () => {
    const dropped = run({edit: c => c.pairId === 'p0_3' && c.side === 'reference' ? null : c});
    expect(reasons(dropped.evaluation, 'response')).toContain('PLANNED_ATTEMPT_MISSING');
  });
  test('manual commit blocks admission', () => {
    const manual = run({edit: c => c.pairId === 'p0_2' ? {...c, manualCommit: true} : c});
    expect(reasons(manual.evaluation, 'response')).toContain('MANUAL_COMMIT');
  });
  test('a timeout stays in the failure denominator with a null latency', () => {
    const timedOut = run({edit: c => c.pairId === 'p0_4' && c.side === 'candidate' ? {...c, outcome: 'timeout', timing: null} : c});
    const trial = timedOut.manifest.trials.find(t => t.attemptId === 'p0_4_candidate')!;
    expect(trial.latencyMs).toBeNull();
    const group = timedOut.evaluation.groups.find(g => g.metric === 'response')!;
    expect(group.failures.candidate).toBe(1);
    expect(group.transportErrors.candidate).toBe(1);
    expect(group.status).toBe('FAIL');
  });
  test('a missing onset never becomes latency 0', () => {
    const silent = run({edit: c => c.pairId === 'p0_1' && c.side === 'reference'
      ? {...c, timing: {...c.timing!, response: {kind: 'no-response', latencyMs: null}}} : c});
    const trial = silent.manifest.trials.find(t => t.attemptId === 'p0_1_reference')!;
    expect(trial.latencyMs).toBeNull();
    expect(silent.manifest.trials.some(t => t.latencyMs === 0)).toBe(false);
    expect(reasons(silent.evaluation, 'response')).toContain('TIMING_UNCONFIRMED');
    const overlap = run({edit: c => c.pairId === 'p0_1' && c.side === 'reference'
      ? {...c, timing: {...c.timing!, response: {kind: 'overlap', latencyMs: null}}} : c});
    expect(overlap.manifest.trials.find(t => t.attemptId === 'p0_1_reference')!.latencyMs).toBeNull();
  });
  test('deterministic scoring requires the pinned scorer; voice latency cannot be typed in', () => {
    const spec = benchmarkSpec(), protocol = buildBenchmarkProtocol(spec);
    const base: CaptureRecord = {attemptId: 'p0_0_candidate', pairId: 'p0_0', side: 'candidate', startedAt: epoch + 1, elapsedMs: 2000,
      outcome: 'ok', timing: timing(300), latencyMs: null, effortCount: 1, retryCount: 0, manualCommit: false, cleanup: 'confirmed',
      violations: [], inputRoute: {kind: 'built-in-microphone'}, device: {physical: true}, operator: {}, captureHash: h(1)};
    const row: ScoreSheetRow = {attemptId: 'p0_0_candidate', verdict: 'correct', source: 'deterministic',
      expectedFactsHash: protocol.cases[0]!.expectedFactsHash, evidenceHash: h(2), scorerHash: h(3)};
    expect(() => assembleBenchmarkManifest({protocol, captures: [base], sheet: [row], deterministicScorerHash: VOICE_EVAL_SCORER_HASH}))
      .toThrow('ASSEMBLER_SCORER_NOT_PINNED');
    expect(() => assembleBenchmarkManifest({protocol, captures: [base], sheet: [{...row, scorerHash: VOICE_EVAL_SCORER_HASH}]}))
      .toThrow('ASSEMBLER_SCORER_NOT_PINNED');
    expect(() => assembleBenchmarkManifest({protocol, captures: [{...base, latencyMs: 250}], sheet: []}))
      .toThrow('ASSEMBLER_VOICE_LATENCY_NOT_MEASURED');
    expect(() => assembleBenchmarkManifest({protocol, captures: [{...base, pairId: 'nope'}], sheet: []})).toThrow('ASSEMBLER_UNKNOWN_PAIR');
    // Timing measured with other analyzer parameters than the sealed method is refused.
    expect(() => assembleBenchmarkManifest({protocol, captures: [{...base, timing: {...timing(300), methodHash: h(4)}}], sheet: []}))
      .toThrow('ASSEMBLER_TIMING_METHOD_MISMATCH');
    expect(() => assembleBenchmarkManifest({protocol, captures: [base], sheet: [{...row, source: 'human', attemptId: 'other'}]}))
      .toThrow('ASSEMBLER_UNKNOWN_ATTEMPT');
    const human = assembleBenchmarkManifest({protocol, captures: [base], sheet: [{...row, source: 'human', scorerHash: undefined}]});
    expect(human.trials[0]!.semantics.source).toBe('human');
  });
});
