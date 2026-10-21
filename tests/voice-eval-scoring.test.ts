import {describe, expect, test} from 'bun:test';
import {
  extractSpokenNumbers, normalizeSpokenNumbers, scoreAnswer, scoreDelivered, VOICE_EVAL_SCORER_HASH,
} from '../src/voiceEvalScoring';
import {VOICE_EVAL_CORPUS, type VoiceEvalItem} from '../src/voiceEvalCorpus';

const item = (id: string): VoiceEvalItem => {
  const found = VOICE_EVAL_CORPUS.items.find(i => i.id === id);
  if (!found) throw Error('missing corpus item ' + id);
  return found;
};

describe('spoken number normalizer', () => {
  test.each([
    ['열다섯', 15], ['십오', 15], ['삼백이십일', 321], ['fifteen', 15], ['2,026', 2026],
    ['이천이십육', 2026], ['만 이천', 12000], ['스물하나', 21], ['아흔아홉', 99],
    ['three hundred twenty-one', 321], ['two thousand twenty six', 2026], ['2만 5천', 25000],
    ['일백', 100], ['백만', 1_000_000], ['twelve', 12], ['영', 0], ['zero', 0],
  ])('%s → %d', (text, value) => {
    expect(normalizeSpokenNumbers(text)).toEqual([value]);
  });

  test('a single Sino syllable needs a word boundary and a numeric suffix', () => {
    // Particles, "this", "work", "slowly" and "yes" are not numbers.
    expect(normalizeSpokenNumbers('답이 맞습니다')).toEqual([]);
    expect(normalizeSpokenNumbers('천천히 세어 주세요')).toEqual([]);
    expect(normalizeSpokenNumbers('네, 알겠습니다')).toEqual([]);
    expect(normalizeSpokenNumbers('사이에 있습니다')).toEqual([]);
    expect(normalizeSpokenNumbers('한국어로 답합니다')).toEqual([]);
    expect(normalizeSpokenNumbers('열어 주세요')).toEqual([]);
    // A copula right after digits is not "two".
    expect(normalizeSpokenNumbers('15이고요')).toEqual([15]);
    expect(normalizeSpokenNumbers('답은 팔입니다')).toEqual([8]);
    expect(normalizeSpokenNumbers('세 개')).toEqual([3]);
  });

  test('common words that look like a digit plus a particle or counter are not numbers', () => {
    // "this time" (이 + 번): a single Sino digit does not take a native-usage counter.
    expect(normalizeSpokenNumbers('답은 15입니다. 이번 문제 쉬웠죠')).toEqual([15]);
    // "apple" (사 + 과): 과 only follows a consonant; after 사 it would be 와.
    expect(normalizeSpokenNumbers('사과 다섯 개 중에 정답은 7이에요, 사과')).toEqual([5, 7]);
    expect(normalizeSpokenNumbers('오이 두 개')).toEqual([2]);
    expect(normalizeSpokenNumbers('일시 정지했어요')).toEqual([]);
    expect(normalizeSpokenNumbers('일가 친척')).toEqual([]);
    // Grammatical forms still count.
    expect(normalizeSpokenNumbers('사와 오')).toEqual([4, 5]);
    expect(normalizeSpokenNumbers('칠과 팔')).toEqual([7, 8]);
    expect(normalizeSpokenNumbers('이가 아니라 사는')).toEqual([2, 4]);
    expect(normalizeSpokenNumbers('삼십 개')).toEqual([30]);
    expect(normalizeSpokenNumbers('일 단계')).toEqual([1]);
  });

  test('numbers keep their order of appearance', () => {
    expect(normalizeSpokenNumbers('7 더하기 8은 15입니다.')).toEqual([7, 8, 15]);
    expect(normalizeSpokenNumbers('칠 더하기 팔은 열다섯이에요')).toEqual([7, 8, 15]);
    expect(extractSpokenNumbers('commit 세 개랑 push 4개').map(n => n.value)).toEqual([3, 4]);
  });
});

describe('answer scorer (last number in the final response)', () => {
  const sum = item('ko-num-01');
  test('observed strings', () => {
    expect(sum.expected.answer).toBe(15);
    expect(scoreAnswer(['12입니다.'], sum)).toBe('wrong');
    expect(scoreAnswer(['정답은 15입니다.'], sum)).toBe('correct');
    // Record 4 of source-client-stop-791: the transcript lost the 8, the spoken answer was right.
    expect(scoreAnswer(['7 더하기 8은 15입니다.'], sum)).toBe('correct');
    expect(scoreAnswer(['열다섯입니다.'], sum)).toBe('correct');
    expect(scoreAnswer([], sum)).toBe('no-answer');
    expect(scoreAnswer(['', '  '], sum)).toBe('no-answer');
    expect(scoreAnswer(['잘 모르겠어요'], sum)).toBe('wrong');
    // Only the final response counts.
    expect(scoreAnswer(['15입니다.', '아니요, 16입니다.'], sum)).toBe('wrong');
    // A short closing remark after the correct answer does not change it.
    expect(scoreAnswer(['답은 15입니다. 이번 문제 쉬웠죠'], sum)).toBe('correct');
  });
  test('a trap value names the failure mode', () => {
    const negation = item('ko-neg-01');
    expect(negation.expected.answer).toBe(1);
    expect(scoreAnswer(['15'], negation)).toBe('trap:negation-dropped');
    expect(scoreAnswer(['1입니다'], negation)).toBe('correct');
    const pause = item('ko-pause-01');
    expect(scoreAnswer(['15입니다'], pause)).toBe('trap:early-turn-end');
    expect(scoreAnswer(['12입니다'], pause)).toBe('correct');
  });
});

describe('delivered-text scorer (relay mode)', () => {
  test('operands in order and every required term group', () => {
    const negation = item('ko-neg-01');
    expect(scoreDelivered('팔 더하기 칠 말고 팔 빼기 칠은?', negation).verdict).toBe('exact');
    expect(scoreDelivered('8 더하기 7 말고 8 빼기 7은?', negation).verdict).toBe('exact');
    // The negation vanished: the workroom AI would compute the wrong thing.
    const dropped = scoreDelivered('팔 더하기 칠 팔 빼기 칠은?', negation);
    expect(dropped.verdict).toBe('missing-term');
    expect(dropped.missingTerms.length).toBe(1);
    expect(scoreDelivered('8 더하기 은?', negation).verdict).toBe('missing-number');
    expect(scoreDelivered('   ', negation).verdict).toBe('empty');
  });
  test('names may be written in either script', () => {
    const named = VOICE_EVAL_CORPUS.items.find(i => i.category === 'names' && i.lang === 'mixed')!;
    const said = named.segments.map(s => s.text).join(' ');
    expect(scoreDelivered(said, named).verdict).toBe('exact');
  });
  test('the scorer identity is a pinned digest', () => {
    expect(VOICE_EVAL_SCORER_HASH).toMatch(/^[a-f0-9]{64}$/);
  });
});
