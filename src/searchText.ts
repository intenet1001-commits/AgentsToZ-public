import {convertHangulToQwerty, convertQwertyToHangul, getChoseong} from 'es-hangul';

/**
 * macOS 파일 이름에서 흔한 분해형 한글(NFD)과 IME 입력의 완성형 한글(NFC),
 * 호환 폭 문자를 모두 같은 검색 문자열로 만든다.
 */
export function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}

const INITIALS = /^[ㄱ-ㅎ\s]+$/;

/** Match the visible text, its Hangul initials, and either keyboard layout. */
export function matchesSearchText(value: string, rawQuery: string): boolean {
  const text = normalizeSearchText(value);
  const query = rawQuery.trim().normalize('NFC').toLocaleLowerCase();
  if (!query) return true;
  const variants = new Set([query]);
  if (/[a-z]/i.test(query)) variants.add(convertQwertyToHangul(query));
  if (/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(query)) variants.add(convertHangulToQwerty(query));
  const initials = [...text].map(char => getChoseong(char) || char).join('');
  return [...variants].some(variant =>
    text.includes(normalizeSearchText(variant)) || (INITIALS.test(variant) && initials.includes(variant)));
}
