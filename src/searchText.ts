/**
 * macOS 파일 이름에서 흔한 분해형 한글(NFD)과 IME 입력의 완성형 한글(NFC),
 * 호환 폭 문자를 모두 같은 검색 문자열로 만든다.
 */
export function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}
