import {romanize} from 'es-hangul';

/**
 * Find an English-named project by how it sounds in Korean: 「쉐도우루프」, 「섀도루프」 and 「ㅅㄷㅇㄹㅍ」
 * all find ShadowLoop. There is no reliable English→Hangul transliteration (쉐/섀 are both right), so
 * this goes the other way: the Korean query is romanized and both sides are reduced to a **consonant
 * skeleton** — vowels and glides dropped, sounds Korean merges put in one class (p/b/f/v, t/d, r/l …).
 * The same reducer runs on both sides, so a spelling quirk that hits one hits the other.
 *
 * Skeletons shorter than three consonants are not compared: two consonants match half the list.
 */
const MIN_SKELETON = 3;

/** Korean initial consonant → its sound class. ㅇ is silent at the start of a syllable. */
const CHOSEONG_CLASS: Record<string, string> = {
  'ㄱ':'K','ㄲ':'K','ㄴ':'N','ㄷ':'T','ㄸ':'T','ㄹ':'L','ㅁ':'M','ㅂ':'P','ㅃ':'P','ㅅ':'S','ㅆ':'S',
  'ㅇ':'','ㅈ':'J','ㅉ':'J','ㅊ':'J','ㅋ':'K','ㅌ':'T','ㅍ':'P','ㅎ':'H',
};
const SINGLE_CLASS: Record<string, string> = {
  b:'P',p:'P',f:'P',v:'P',d:'T',t:'T',k:'K',q:'K',g:'K',j:'J',z:'J',s:'S',l:'L',r:'L',m:'M',n:'N',h:'H',
};
const VOWEL = /[aeiouyw]/;

interface SkeletonUnit {cls: string; batchim: boolean}

/**
 * Latin letters (an English name, or a romanized Korean query) → consonant classes. Soft c/g
 * (`agent`, `city`) is English spelling only — romanized 그·게 are hard, so `english` turns it off.
 * `batchim` marks a consonant between a vowel and a consonant (proje·c·t): Korean writes it as a
 * final, so it has no initial of its own and an initials-only query may leave it out.
 */
function skeletonUnits(text: string, english: boolean): SkeletonUnit[] {
  const s = text.normalize('NFKC').toLowerCase().replace(/[^a-z]/g, '');
  const out: SkeletonUnit[] = [];
  const push = (cls: string, start: number, end: number) => {
    if (!cls) return;
    const batchim = start > 0 && VOWEL.test(s[start - 1]!) && !VOWEL.test(s[end] ?? '');
    const last = out[out.length - 1];
    if (last && last.cls === cls) { last.batchim = batchim; return; }
    out.push({cls, batchim});
  };
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]!, next = s[i + 1] ?? '';
    if (VOWEL.test(c)) continue;
    const pair = c + next;
    // `gn` reads as n (design 디자인, sign 사인).
    const digraph = ({sh:'S',ch:'J',th:'T',ph:'P',gh:'',ck:'K',...(english ? {gn:'N'} : {})} as Record<string,string>)[pair];
    if (digraph !== undefined) { push(digraph, i, i + 2); i += 1; continue; }
    // English r before a consonant or at the end is silent in a Korean reading: board → 보드, tracker → 트래커.
    if (c === 'r' && english && !VOWEL.test(next)) continue;
    if (c === 'x') { push('K', i, i); push('S', i, i + 1); continue; }
    if (c === 'c') { push(english && /[eiy]/.test(next) ? 'S' : 'K', i, i + 1); continue; }
    // English s between vowels is voiced and Korean writes it ㅈ (design 디자인, user 유저, music 뮤직) — but not
    // before a silent final e (base 베이스, case 케이스).
    if (c === 's' && english && i > 0 && VOWEL.test(s[i - 1]!) && VOWEL.test(next) && !(next === 'e' && i + 2 >= s.length)) { push('J', i, i + 1); continue; }
    if (c === 'g' && english && /[eiy]/.test(next)) { push('J', i, i + 1); continue; }
    push(SINGLE_CLASS[c] ?? '', i, i + 1);
  }
  return out;
}

export function consonantSkeleton(text: string, english = true): string {
  return skeletonUnits(text, english).map(unit => unit.cls).join('');
}

const HANGUL = /[가-힣ㄱ-ㅎ]/;
const ONLY_CHOSEONG = /^[ㄱ-ㅎ\s]+$/;

/** Bounded memo: the same query runs against every project on every keystroke; romanizing it each time cost 4–6ms per filter. */
function memo<T>(cache: Map<string, T>, key: string, make: () => T): T {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = make();
  if (cache.size >= 500) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
}
const querySkeletons = new Map<string, string>();
const queryVowels = new Map<string, boolean>();
const wordUnits = new Map<string, {raw: string[]; units: SkeletonUnit[][]}>();

/** A Korean query's skeleton: initials map directly, syllables go through romanization. */
export function hangulQuerySkeleton(query: string): string {
  return memo(querySkeletons, query, () => computeQuerySkeleton(query));
}
function computeQuerySkeleton(query: string): string {
  const q = query.normalize('NFC').trim();
  if (!q || !HANGUL.test(q)) return '';
  if (ONLY_CHOSEONG.test(q)) {
    let out = '';
    for (const ch of q.replace(/\s+/g, '')) {
      const cls = CHOSEONG_CLASS[ch] ?? '';
      if (cls && out[out.length - 1] !== cls) out += cls;
    }
    return out;
  }
  let romanized = '';
  try { romanized = romanize(q.replace(/[^가-힣\s]/g, ' ')); } catch { return ''; }
  return consonantSkeleton(romanized, false);
}

function queryStartsWithVowel(query: string): boolean {
  return memo(queryVowels, query, () => computeQueryStartsWithVowel(query));
}
function computeQueryStartsWithVowel(query: string): boolean {
  const q = query.normalize('NFC').trim();
  if (ONLY_CHOSEONG.test(q)) return q.startsWith('ㅇ');
  try { return /^[aeiouwy]/.test(romanize(q.replace(/[^가-힣\s]/g, ' ').trim())); } catch { return false; }
}

/** The words a name is read as: separators, camelCase and digits all break words. */
function wordsOf(text: string): string[] {
  return text.normalize('NFKC').replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-z]+/).filter(Boolean);
}
/** Words read in a row: a repeated class across the boundary is one sound (Web App → P). */
const joinUnits = (parts: readonly SkeletonUnit[][]) => parts.reduce<SkeletonUnit[]>((out, part) =>
  out.length && part.length && out[out.length - 1]!.cls === part[0]!.cls ? [...out, ...part.slice(1)] : [...out, ...part], []);
const MAX_WORDS = 5;

/**
 * Does this Latin text sound like the Korean query? Matches are anchored to whole words — consonants
 * run together across word boundaries, and an unanchored skeleton matched 「트래커」 to «Data Workflow»
 * (T + LKPL). A syllable query must equal a run of whole words, or begin one word (typing a prefix).
 * Initials carry no final consonants (프로젝트 → ㅍㄹㅈㅌ, «project» also has a K), so they may skip one.
 */
export function matchesPhoneticName(text: string, query: string): boolean {
  if (!/[a-z]/i.test(text)) return false;
  const wanted = hangulQuerySkeleton(query);
  if (wanted.length < MIN_SKELETON) return false;
  const initials = ONLY_CHOSEONG.test(query.trim());
  // A reading begins with ㅇ exactly when the word begins with a vowel sound (Outlook → 아웃룩, web → 웹):
  // without this «Outlook» and 「트래커」 share TLK and match.
  const queryOpensWithVowel = queryStartsWithVowel(query);
  const {raw, units: words} = memo(wordUnits, text, () => { const raw = wordsOf(text); return {raw, units: raw.map(word => skeletonUnits(word, true))}; });
  for (let i = 0; i < words.length; i += 1) {
    if (/^[aeiouwy]/i.test(raw[i]!) !== queryOpensWithVowel) continue;
    // Typing the start of a word matches only once there is enough of it: a three-consonant prefix matched
    // unrelated words (블로그 → progress, 클로드 → Graduate, 스킬 → Scoring — 2026-10-06 review).
    if (!initials && wanted.length >= 4 && words[i]!.map(unit => unit.cls).join('').startsWith(wanted)) return true;
    for (let j = i; j < Math.min(words.length, i + MAX_WORDS); j += 1) {
      const run = joinUnits(words.slice(i, j + 1));
      const plain = run.map(unit => unit.cls).join('');
      if (plain === wanted) return true;
      if (initials && run.length === wanted.length + 1 && run.some((unit, skip) => unit.batchim
        && plain.slice(0, skip) + plain.slice(skip + 1) === wanted)) return true;
      if (run.length > wanted.length + 1) break;
    }
  }
  return false;
}
