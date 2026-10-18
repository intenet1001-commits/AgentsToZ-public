import {describe, expect, test} from 'bun:test';
import {
  VOICE_EVAL_CORPUS, canonicalJson, corpusHash, expectedFactsHash, publicBenchmarkCases, validateVoiceEvalCorpus,
  type VoiceEvalCorpus,
} from '../src/voiceEvalCorpus';
import {normalizeSpokenNumbers} from '../src/voiceEvalScoring';

const clone = (): VoiceEvalCorpus => JSON.parse(JSON.stringify(VOICE_EVAL_CORPUS));
const normalized = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

describe('one shared offline corpus', () => {
  test('at least 20 distinct items per language and unique ids', () => {
    const counts = {ko: 0, en: 0, mixed: 0};
    for (const item of VOICE_EVAL_CORPUS.items) counts[item.lang]++;
    expect(counts.ko).toBeGreaterThanOrEqual(20);
    expect(counts.en).toBeGreaterThanOrEqual(20);
    expect(counts.mixed).toBeGreaterThanOrEqual(20);
    expect(new Set(VOICE_EVAL_CORPUS.items.map(i => i.id)).size).toBe(VOICE_EVAL_CORPUS.items.length);
    expect(() => validateVoiceEvalCorpus(VOICE_EVAL_CORPUS)).not.toThrow();
  });

  test('texts are pairwise distinct after normalization', () => {
    const seen = new Set<string>();
    for (const item of VOICE_EVAL_CORPUS.items) {
      const key = normalized(item.segments.map(s => s.text).join('') + (item.bargeIn?.segments.map(s => s.text).join('') ?? ''));
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  test('every language covers numbers, negation, long pause, interruption and project/AI names', () => {
    for (const lang of ['ko', 'en', 'mixed'] as const) {
      const categories = new Set(VOICE_EVAL_CORPUS.items.filter(i => i.lang === lang).map(i => i.category));
      for (const category of ['numbers', 'negation', 'long-pause', 'interruption', 'names'] as const)
        expect([lang, categories.has(category)]).toEqual([lang, true]);
    }
  });

  test('items are internally consistent with the scorer', () => {
    for (const item of VOICE_EVAL_CORPUS.items) {
      expect(Number.isInteger(item.expected.answer)).toBe(true);
      // The spoken operands are what the scorer recovers from the item's own text (relay delivery).
      const spoken = normalizeSpokenNumbers(item.segments.map(s => s.text).join(' ') + ' ' +
        (item.bargeIn?.segments.map(s => s.text).join(' ') ?? ''));
      let at = 0;
      for (const operand of item.expected.operands) {
        const found = spoken.indexOf(operand, at);
        expect([item.id, operand, found >= 0]).toEqual([item.id, operand, true]);
        at = found + 1;
      }
      for (const trap of item.traps) expect(trap.value).not.toBe(item.expected.answer);
      if (item.category === 'long-pause') expect(item.segments.some(s => (s.pauseAfterMs ?? 0) >= 2000)).toBe(true);
      if (item.category === 'interruption') expect(item.bargeIn).toBeDefined();
      expect(item.expected.terms.length + item.expected.operands.length).toBeGreaterThan(0);
    }
  });

  test('hashes are deterministic, key-order independent and change with any text', () => {
    const a = corpusHash(VOICE_EVAL_CORPUS), b = corpusHash(clone());
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(b).toBe(a);
    const changed = clone();
    changed.items[3]!.segments[0]!.text += '요';
    expect(corpusHash(changed)).not.toBe(a);
    const first = VOICE_EVAL_CORPUS.items[0]!;
    expect(expectedFactsHash(first)).toBe(expectedFactsHash(JSON.parse(JSON.stringify(first))));
    expect(canonicalJson({b: 1, a: [2, {d: 1, c: 0}]})).toBe('{"a":[2,{"c":0,"d":1}],"b":1}');
    const facts = new Set(VOICE_EVAL_CORPUS.items.map(expectedFactsHash));
    expect(facts.size).toBe(VOICE_EVAL_CORPUS.items.length);
  });

  test('the public case list carries no text, paths or keys', () => {
    const inputs = new Map(VOICE_EVAL_CORPUS.items.map((item, i) => [item.id, (i + 1).toString(16).padStart(64, '0')]));
    const cases = publicBenchmarkCases(VOICE_EVAL_CORPUS, inputs);
    expect(cases).toHaveLength(VOICE_EVAL_CORPUS.items.length);
    expect(Object.keys(cases[0]!).sort()).toEqual(['domain', 'expectedFactsHash', 'id', 'inputHash', 'language']);
    const json = JSON.stringify(cases);
    for (const item of VOICE_EVAL_CORPUS.items) for (const s of item.segments) expect(json.includes(s.text)).toBe(false);
    expect(json).not.toMatch(/\/Users\/|\.wav|\.aiff|sk-/);
    expect(() => publicBenchmarkCases(VOICE_EVAL_CORPUS, new Map())).toThrow();
    const duplicate = new Map(inputs);duplicate.set(VOICE_EVAL_CORPUS.items[1]!.id, inputs.get(VOICE_EVAL_CORPUS.items[0]!.id)!);
    expect(() => publicBenchmarkCases(VOICE_EVAL_CORPUS, duplicate)).toThrow();
  });

  test('validation rejects duplicates, missing facts and traps equal to the answer', () => {
    const dup = clone();dup.items[1]!.id = dup.items[0]!.id;
    expect(() => validateVoiceEvalCorpus(dup)).toThrow();
    const trap = clone();trap.items.find(i => i.traps.length)!.traps[0]!.value = trap.items.find(i => i.traps.length)!.expected.answer;
    expect(() => validateVoiceEvalCorpus(trap)).toThrow();
    const same = clone();same.items[1]!.segments = JSON.parse(JSON.stringify(same.items[0]!.segments));
    expect(() => validateVoiceEvalCorpus(same)).toThrow();
  });
});
