import {describe, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {evaluateBenchmark, fingerprintBenchmarkProtocol, parseBenchmarkManifest, type BenchmarkTrial} from '../src/voiceRemoteBenchmark';
import {benchmarkSpecHash, buildBenchmarkProtocol, nextOperatorStep, type BenchmarkProtocolSpec} from '../src/voiceBenchmarkProtocol';
import {VOICE_EVAL_CORPUS} from '../src/voiceEvalCorpus';
import {main as protocolCli} from '../scripts/voice-benchmark-protocol';

import {benchmarkSpec, epoch, h} from './fixtures/voice-benchmark-spec';
/** Drive the operator steps to completion, as a careful operator would. */
function runSchedule(spec: BenchmarkProtocolSpec, tamper?: (trials: BenchmarkTrial[]) => void) {
  const protocol = buildBenchmarkProtocol(spec), protocolHash = fingerprintBenchmarkProtocol(protocol);
  const trials: BenchmarkTrial[] = [];let now = epoch + 1000;
  for (let guard = 0; guard < 5000; guard++) {
    const step = nextOperatorStep(protocol, trials, now);
    if (step.kind === 'complete') break;
    if (step.kind === 'wait') {now = step.until;continue;}
    if (step.kind !== 'run') throw Error('unexpected ' + JSON.stringify(step));
    const g = protocol.groups.find(g => g.id === step.groupId)!, c = protocol.cases.find(c => c.id === step.caseId)!;
    const sustained = g.metric === 'sustained-1h';
    trials.push({
      attemptId: step.pairId + '_' + step.side, pairId: step.pairId, groupId: g.id, caseId: c.id, side: step.side, protocolHash,
      ...protocol.products[step.side], inputHash: c.inputHash,
      workloadHash: g.workloadHash, contextHash: g.contextHash, environmentHash: g.environmentHash, methodHash: g.methodHash,
      clockHash: g.clockHash, transport: g.transport, condition: g.condition,
      startedAt: now, outcome: 'ok', latencyMs: sustained ? null : step.side === 'candidate' ? 300 : 500,
      elapsedMs: sustained ? 3_600_000 : 2000, effortCount: step.side === 'candidate' ? 1 : 2, retryCount: 0, manualCommit: false, cleanup: 'confirmed',
      semantics: {verdict: 'correct', source: 'deterministic', expectedFactsHash: c.expectedFactsHash, evidenceHash: h(600)},
      violations: [], proof: {surface: step.side === 'candidate' ? 'agentstoz-native' : 'codex-native', physicalDevice: true,
        physicalMicrophone: g.domain === 'voice', authenticated: true, taskStateObserved: true, captureHash: h(700)},
    });
    now += sustained ? 3_600_000 : 2000;
  }
  tamper?.(trials);
  return {protocol, trials, evaluation: evaluateBenchmark({schemaVersion: 1, protocol, trials})};
}

describe('benchmark protocol sealer', () => {
  test('a sealed protocol with zero trials parses and every metric is NOT_RUN', () => {
    const protocol = buildBenchmarkProtocol(benchmarkSpec());
    expect(() => parseBenchmarkManifest({schemaVersion: 1, protocol, trials: []})).not.toThrow();
    const e = evaluateBenchmark({schemaVersion: 1, protocol, trials: []});
    expect(e.groups).toHaveLength(8);
    expect(e.groups.every(g => g.status === 'NOT_RUN')).toBe(true);
    expect(e.status).toBe('NOT_RUN');
    // ceil(30 / 0.8) = 38 latency pairs; ceil(1 / 0.8) = 2 sustained pairs. A voice group without an explicit
    // case list covers the whole corpus once (66 distinct cases) so the 20-per-language gate is reachable.
    expect(protocol.groups.find(g => g.metric === 'workflow')!.pairs).toHaveLength(38);
    expect(protocol.groups.find(g => g.metric === 'response')!.pairs).toHaveLength(VOICE_EVAL_CORPUS.items.length);
    expect(protocol.groups.find(g => g.metric === 'interrupt')!.pairs).toHaveLength(38);
    expect(protocol.groups.find(g => g.metric === 'sustained-1h')!.pairs).toHaveLength(2);
  });
  test('voice groups rotate through the corpus so every language reaches 20 distinct cases', () => {
    const {evaluation} = runSchedule(benchmarkSpec());
    expect(evaluation.voiceCorpus.ko).toBeGreaterThanOrEqual(20);
    expect(evaluation.voiceCorpus.en).toBeGreaterThanOrEqual(20);
    expect(evaluation.voiceCorpus.mixed).toBeGreaterThanOrEqual(20);
  });
  test('parity: even pairs start with the candidate, odd pairs with the reference; the evaluator agrees', () => {
    const protocol = buildBenchmarkProtocol(benchmarkSpec());
    const first = nextOperatorStep(protocol, [], epoch + 1);
    expect(first).toMatchObject({kind: 'run', pairIndex: 0, side: 'candidate', latestStartAt: null});
    const {evaluation} = runSchedule(benchmarkSpec());
    expect(evaluation.groups.flatMap(g => g.reasons)).not.toContain('PAIRED_ORDER_OR_WINDOW_MISMATCH');
    expect(evaluation.groups.every(g => g.status === 'PASS')).toBe(true);
    const flipped = runSchedule(benchmarkSpec(), trials => {
      const a = trials.find(t => t.pairId.endsWith('_1') && t.side === 'candidate')!;
      const b = trials.find(t => t.pairId === a.pairId && t.side === 'reference')!;
      [a.startedAt, b.startedAt] = [b.startedAt, a.startedAt];
    });
    expect(flipped.evaluation.groups.flatMap(g => g.reasons)).toContain('PAIRED_ORDER_OR_WINDOW_MISMATCH');
  });
  test('the second side must start after the first ends and within the window', () => {
    const protocol = buildBenchmarkProtocol(benchmarkSpec());
    const pair = protocol.groups[0]!.pairs[0]!, started = epoch + 5000;
    const firstTrial = {pairId: pair.id, side: 'candidate' as const, startedAt: started, elapsedMs: 2000};
    expect(nextOperatorStep(protocol, [firstTrial], started + 1000)).toMatchObject({kind: 'wait', until: started + 2000});
    expect(nextOperatorStep(protocol, [firstTrial], started + 600_000)).toMatchObject({kind: 'run', side: 'reference', latestStartAt: started + 600_000});
    expect(nextOperatorStep(protocol, [firstTrial], started + 600_001)).toMatchObject({kind: 'refused', reason: 'WINDOW_EXPIRED', pairId: pair.id});
    expect(nextOperatorStep(protocol, [{...firstTrial, side: 'reference'}], started + 3000)).toMatchObject({kind: 'refused', reason: 'ORDER_VIOLATED'});
    expect(nextOperatorStep(protocol, [], epoch - 1)).toMatchObject({kind: 'refused', reason: 'BEFORE_SEAL'});
    expect(nextOperatorStep(protocol, [{...firstTrial, pairId: 'nope'}], started)).toMatchObject({kind: 'refused', reason: 'UNKNOWN_TRIAL'});
  });
  test('spec errors are refused before sealing', () => {
    const short = benchmarkSpec();short.groups[0]!.plannedPairs = 29;
    expect(() => buildBenchmarkProtocol(short)).toThrow('BENCHMARK_PLANNED_PAIRS_TOO_FEW');
    const dupe = benchmarkSpec();dupe.cases[1]!.inputHash = dupe.cases[0]!.inputHash;
    expect(() => buildBenchmarkProtocol(dupe)).toThrow('BENCHMARK_VOICE_INPUT_DUPLICATE');
    const eps = benchmarkSpec();eps.expectedPairSuccess = 0;
    expect(() => buildBenchmarkProtocol(eps)).toThrow();
    const unknownCase = benchmarkSpec();unknownCase.groups[1]!.caseIds = ['missing-case'];
    expect(() => buildBenchmarkProtocol(unknownCase)).toThrow();
  });
  test('the fingerprint and spec hash are stable across key order', () => {
    const spec = benchmarkSpec();
    const reordered = JSON.parse(JSON.stringify(spec, Object.keys(spec).reverse()));
    for (const k of Object.keys(spec)) if (!(k in reordered)) reordered[k] = (spec as any)[k];
    const shuffle = (o: any): any => Array.isArray(o) ? o.map(shuffle) : o && typeof o === 'object'
      ? Object.fromEntries(Object.entries(o).reverse().map(([k, v]) => [k, shuffle(v)])) : o;
    expect(fingerprintBenchmarkProtocol(buildBenchmarkProtocol(shuffle(spec))))
      .toBe(fingerprintBenchmarkProtocol(buildBenchmarkProtocol(spec)));
    expect(benchmarkSpecHash(shuffle(spec))).toBe(benchmarkSpecHash(spec));
  });
  test('CLI writes a private protocol file and prints only counts and hashes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-protocol-'));
    try {
      writeFileSync(join(dir, 'spec.json'), JSON.stringify(benchmarkSpec()));
      const lines: string[] = [];
      const code = await protocolCli(['--spec', join(dir, 'spec.json'), '--out', join(dir, 'protocol.json')], line => lines.push(line));
      expect(code).toBe(0);
      expect(statSync(join(dir, 'protocol.json')).mode & 0o777).toBe(0o600);
      const written = JSON.parse(readFileSync(join(dir, 'protocol.json'), 'utf8'));
      expect(() => parseBenchmarkManifest(written)).not.toThrow();
      const printed = JSON.parse(lines.join(''));
      expect(Object.keys(printed).sort()).toEqual(['cases', 'fingerprint', 'groups', 'plannedPairs', 'specHash']);
      expect(printed.fingerprint).toBe(fingerprintBenchmarkProtocol(written.protocol));
      expect(await protocolCli(['--spec', join(dir, 'spec.json'), '--out', join(dir, 'protocol.json')], () => {})).toBe(65);
    } finally {rmSync(dir, {recursive: true, force: true});}
  });
});
