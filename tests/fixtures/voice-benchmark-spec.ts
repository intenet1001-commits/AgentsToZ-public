import {VOICE_EVAL_CORPUS, publicBenchmarkCases} from '../../src/voiceEvalCorpus';
import {BENCHMARK_REQUIRED_METRICS, type BenchmarkProtocolSpec} from '../../src/voiceBenchmarkProtocol';
import {DEFAULT_TIMING_PARAMS, timingClockHash, timingMethodHash} from '../../src/voiceBenchmarkTiming';

/** Invented operator spec for contract tests only; never a product measurement. */
export const h = (n: number) => n.toString(16).padStart(64, '0');
export const epoch = 1792011000000;
export function benchmarkSpec(): BenchmarkProtocolSpec {
  const voiceCases = publicBenchmarkCases(VOICE_EVAL_CORPUS, new Map(VOICE_EVAL_CORPUS.items.map((item, i) => [item.id, h(1000 + i)])));
  const hashes = {workloadHash: h(400), contextHash: h(401), environmentHash: h(402), methodHash: h(403), clockHash: h(404)};
  return {
    id: 'protocol_spec_fixture', sealedAt: epoch, comparison: 'native-product', expectedPairSuccess: 0.8,
    products: {
      candidate: {version: '791.0.0', artifactHash: h(500), sourceHash: h(501), settingsHash: h(502)},
      reference: {version: '0.162.1', artifactHash: h(510), sourceHash: h(511), settingsHash: h(512)},
    },
    cases: [...voiceCases, {id: 'remote_main', domain: 'remote', language: 'none', inputHash: h(900), expectedFactsHash: h(901)}],
    groups: BENCHMARK_REQUIRED_METRICS.map(({domain, metric}) => ({
      domain, metric, condition: 'normal', transport: domain === 'voice' ? 'webrtc' : 'relay', ...hashes,
      // Voice timing is sealed to the acoustic analyzer's method and clock definitions.
      ...(domain === 'voice' ? {methodHash: timingMethodHash(DEFAULT_TIMING_PARAMS), clockHash: timingClockHash(metric)} : {}),
      ...(metric === 'interrupt' || metric === 'resume'
        ? {caseIds: VOICE_EVAL_CORPUS.items.filter(i => i.category === 'interruption').map(i => i.id)} : {}),
    })),
  };
}
