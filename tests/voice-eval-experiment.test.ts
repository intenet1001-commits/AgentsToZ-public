import {describe, expect, test} from 'bun:test';
import {
  EXPERIMENT_GATES, analyzeExperiment, buildExperimentPlan, decideExperiment, experimentPlanHash, mcnemarExactP, mulberry32,
  pairedDifferenceInterval, wilsonInterval, type ExperimentTrialResult,
} from '../src/voiceEvalExperiment';
import {VOICE_EVAL_CORPUS} from '../src/voiceEvalCorpus';

const ko = VOICE_EVAL_CORPUS.items.filter(i => i.lang === 'ko').map(i => i.id);
const en = VOICE_EVAL_CORPUS.items.filter(i => i.lang === 'en').map(i => i.id);
const mixed = VOICE_EVAL_CORPUS.items.filter(i => i.lang === 'mixed').map(i => i.id);
const spec = (seed = 42) => ({
  seed, caseIds: [...ko, ...en, ...mixed], reps: 1, variants: ['clean', 'pink10'] as const,
  voices: {ko: ['Yuna', 'Eddy (Korean (South Korea))', 'Flo (Korean (South Korea))'], en: ['Samantha', 'Fred', 'Albert'],
    mixed: ['Yuna', 'Eddy (Korean (South Korea))', 'Flo (Korean (South Korea))']},
  baseline: 'nr-near', conditions: [{id: 'nr-near', audio: {noiseReduction: 'near_field' as const}},
    {id: 'nr-far', audio: {noiseReduction: 'far_field' as const}}],
});

describe('seeded, counterbalanced schedule', () => {
  test('same seed, same schedule; another seed, another order', () => {
    expect(buildExperimentPlan(spec(42))).toEqual(buildExperimentPlan(spec(42)));
    expect(buildExperimentPlan(spec(43)).trials.map(t => t.trialId)).not.toEqual(buildExperimentPlan(spec(42)).trials.map(t => t.trialId));
    expect([mulberry32(1)(), mulberry32(1)()]).toEqual([mulberry32(1)(), mulberry32(1)()]);
  });
  test('an A/A duplicate of the baseline is added and every case meets every condition equally', () => {
    const plan = buildExperimentPlan(spec());
    expect(plan.conditions.map(c => c.id)).toEqual(['nr-near', 'nr-far', 'nr-near~aa']);
    expect(plan.conditions[2]!.audio).toEqual(plan.conditions[0]!.audio);
    const counts = new Map<string, number>();
    for (const t of plan.trials) counts.set(t.caseId + '|' + t.condition, (counts.get(t.caseId + '|' + t.condition) ?? 0) + 1);
    for (const id of spec().caseIds) {
      const per = plan.conditions.map(c => counts.get(id + '|' + c.id));
      expect(new Set(per).size).toBe(1);
      expect(per[0]).toBe(3 * 2);
    }
  });
  test('ABBA: every second block runs the conditions in reverse order', () => {
    const plan = buildExperimentPlan(spec());
    const blocks = [...new Set(plan.trials.map(t => t.blockId))];
    const order = (b: string) => plan.trials.filter(t => t.blockId === b).sort((x, y) => x.position - y.position).map(t => t.condition);
    for (let i = 0; i + 1 < blocks.length; i += 2) expect(order(blocks[i + 1]!)).toEqual([...order(blocks[i]!)].reverse());
    expect(experimentPlanHash(plan)).toBe(experimentPlanHash(buildExperimentPlan(spec())));
  });
});

describe('statistics', () => {
  test('exact McNemar matches hand-computed values', () => {
    expect(mcnemarExactP(8, 1)).toBeCloseTo(0.0390625, 9);
    expect(mcnemarExactP(0, 0)).toBe(1);
    expect(mcnemarExactP(5, 5)).toBe(1);
    expect(mcnemarExactP(10, 0)).toBeCloseTo(2 / 1024, 12);
  });
  test('exact McNemar stays correct for large pooled runs (no 2^-n underflow)', () => {
    expect(mcnemarExactP(538, 538)).toBe(1);
    expect(mcnemarExactP(1000, 1000)).toBe(1);
    expect(mcnemarExactP(600, 600)).toBe(1);
    const p = mcnemarExactP(600, 500);
    expect(p).toBeGreaterThan(0.002);expect(p).toBeLessThan(0.004);
    expect(mcnemarExactP(5, 5)).toBe(1);
    expect(mcnemarExactP(8, 1)).toBeCloseTo(0.0390625, 9);
  });
  test('Wilson interval and paired difference interval', () => {
    const w = wilsonInterval(15, 20);
    expect(w.low).toBeCloseTo(0.5313, 3);expect(w.high).toBeCloseTo(0.8881, 3);
    expect(wilsonInterval(0, 0)).toEqual({estimate: null, low: null, high: null});
    const d = pairedDifferenceInterval(2, 12, 100);
    expect(d.estimate).toBeCloseTo(0.10, 9);
    expect(d.low!).toBeLessThan(0.10);expect(d.high!).toBeGreaterThan(0.10);
  });
});

/** Results for a plan: the candidate fixes `gain` of KO baseline failures; A/A agrees except `aaNoise` flips. */
function results(plan: ReturnType<typeof buildExperimentPlan>, opts: {koBaseCorrect: number; gain: number; aaFlip?: number; invalidEvery?: number}) {
  const out: ExperimentTrialResult[] = [];let n = 0;
  const rng = mulberry32(7);
  const baseOk = new Map<string, boolean>();
  for (const t of plan.trials) {
    const lang = VOICE_EVAL_CORPUS.items.find(i => i.id === t.caseId)!.lang;
    if (!baseOk.has(t.blockId)) baseOk.set(t.blockId, rng() < (lang === 'ko' ? opts.koBaseCorrect : 0.9));
    const base = baseOk.get(t.blockId)!;
    let ok = base;
    if (t.condition === 'nr-far' && lang === 'ko' && !base && rng() < opts.gain) ok = true;
    if (t.condition === 'nr-near~aa' && opts.aaFlip && rng() < opts.aaFlip) ok = !ok;
    n++;
    out.push({trialId: t.trialId, verdict: opts.invalidEvery && n % opts.invalidEvery === 0 ? 'invalid' : ok ? 'correct' : 'wrong'});
  }
  return out;
}

describe('pre-registered decision', () => {
  test('a strong Korean gain with stable English/mixed and quiet A/A is only a candidate for physical confirmation', () => {
    const plan = buildExperimentPlan(spec());
    const analysis = analyzeExperiment(plan, results(plan, {koBaseCorrect: 0.6, gain: 0.8, aaFlip: 0.02}), 'nr-far');
    expect(analysis.languages.ko.validPairs).toBeGreaterThanOrEqual(EXPERIMENT_GATES.minValidKoPairs);
    const decision = decideExperiment(analysis);
    expect(decision.decision).toBe('candidate-for-physical-confirmation');
  });
  test('no gain is no-change; too little evidence is insufficient; never "ship"', () => {
    const plan = buildExperimentPlan(spec());
    expect(decideExperiment(analyzeExperiment(plan, results(plan, {koBaseCorrect: 0.6, gain: 0, aaFlip: 0.02}), 'nr-far')).decision).toBe('no-change');
    const small = buildExperimentPlan({...spec(), caseIds: ko.slice(0, 10)});
    const tooSmall = decideExperiment(analyzeExperiment(small, results(small, {koBaseCorrect: 0.6, gain: 0.8}), 'nr-far'));
    expect(tooSmall.decision).toBe('insufficient-evidence');
    expect(tooSmall.reasons).toContain('TOO_FEW_KO_ITEMS');
    const twoVoices = buildExperimentPlan({...spec(), voices: {...spec().voices, ko: ['Yuna', 'Flo (Korean (South Korea))']}});
    expect(decideExperiment(analyzeExperiment(twoVoices, results(twoVoices, {koBaseCorrect: 0.6, gain: 0.8}), 'nr-far')).reasons).toContain('TOO_FEW_VOICES');
    for (let seed = 1; seed < 6; seed++) {
      const p = buildExperimentPlan(spec(seed));
      const d = decideExperiment(analyzeExperiment(p, results(p, {koBaseCorrect: Math.random(), gain: Math.random(), aaFlip: Math.random()}), 'nr-far'));
      expect(['insufficient-evidence', 'no-change', 'candidate-for-physical-confirmation']).toContain(d.decision);
    }
  });
  test('invalid trials stay in the denominator and are reported, not dropped', () => {
    const plan = buildExperimentPlan(spec());
    const analysis = analyzeExperiment(plan, results(plan, {koBaseCorrect: 0.6, gain: 0.8, invalidEvery: 7}), 'nr-far');
    const near = analysis.languages.ko.conditions['nr-near']!;
    expect(near.invalid).toBeGreaterThan(0);
    expect(near.attempts).toBe(plan.trials.filter(t => t.condition === 'nr-near' && ko.includes(t.caseId)).length);
    expect(analysis.languages.ko.invalidPairs).toBeGreaterThan(0);
    // A noisy A/A (run-to-run variance above the effect) blocks the candidate.
    const noisy = analyzeExperiment(plan, results(plan, {koBaseCorrect: 0.6, gain: 0.8, aaFlip: 0.5}), 'nr-far');
    expect(decideExperiment(noisy).reasons).toContain('AA_DISCORDANCE_NOT_BELOW_AB');
    expect(() => analyzeExperiment(plan, [{trialId: 'nope', verdict: 'correct'}], 'nr-far')).toThrow();
  });
  test('a candidate that fails to produce valid trials is penalised, not filtered out', () => {
    // Enough repetitions that half of the KO pairs alone still clear the valid-pair gate.
    const plan = buildExperimentPlan({...spec(), reps: 4});
    const strong = results(plan, {koBaseCorrect: 0.6, gain: 0.8, aaFlip: 0.02});
    expect(decideExperiment(analyzeExperiment(plan, strong, 'nr-far')).decision).toBe('candidate-for-physical-confirmation');
    // Same data, but the candidate (e.g. noise reduction suppressing VAD) is invalid in every second KO block.
    const koBlocks = [...new Set(plan.trials.filter(t => t.lang === 'ko').map(t => t.blockId))];
    const broken = new Set(koBlocks.filter((_, i) => i % 2 === 0));
    const trialById = new Map(plan.trials.map(t => [t.trialId, t]));
    const asymmetric = strong.map(r => {
      const t = trialById.get(r.trialId)!;
      return t.condition === 'nr-far' && broken.has(t.blockId) ? {...r, verdict: 'invalid'} : r;
    });
    const analysis = analyzeExperiment(plan, asymmetric, 'nr-far');
    const decision = decideExperiment(analysis);
    expect(decision.decision).toBe('no-change');
    expect(decision.reasons).toContain('CANDIDATE_INVALID_RATE_HIGHER');
    // Candidate-only invalid pairs count against the candidate in the paired comparison.
    expect(analysis.languages.ko.candidateInvalidPairs).toBe(broken.size);
    expect(analysis.languages.ko.gain.estimate!).toBeLessThan(0);
    // Invalid trials on both sides alike do not trip the asymmetry gate.
    const symmetric = strong.map(r => {
      const t = trialById.get(r.trialId)!;
      return (t.condition === 'nr-far' || t.condition === 'nr-near') && t.lang === 'ko' && broken.has(t.blockId) && koBlocks.indexOf(t.blockId) % 8 === 0
        ? {...r, verdict: 'invalid'} : r;
    });
    expect(decideExperiment(analyzeExperiment(plan, symmetric, 'nr-far')).reasons).not.toContain('CANDIDATE_INVALID_RATE_HIGHER');
  });
  test('the asymmetry gate holds even when the baseline mostly fails', () => {
    const plan = buildExperimentPlan({...spec(), reps: 4});
    const strong = results(plan, {koBaseCorrect: 0.1, gain: 0.8, aaFlip: 0.02});
    const koBlocks = [...new Set(plan.trials.filter(t => t.lang === 'ko').map(t => t.blockId))];
    const broken = new Set(koBlocks.filter((_, i) => i % 2 === 0));
    const trialById = new Map(plan.trials.map(t => [t.trialId, t]));
    const asymmetric = strong.map(r => {
      const t = trialById.get(r.trialId)!;
      return t.condition === 'nr-far' && broken.has(t.blockId) ? {...r, verdict: 'invalid'} : r;
    });
    expect(decideExperiment(analyzeExperiment(plan, asymmetric, 'nr-far')).reasons).toContain('CANDIDATE_INVALID_RATE_HIGHER');
  });
});
