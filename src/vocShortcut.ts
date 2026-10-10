/**
 * ⌘/Ctrl+Shift+V 판정 — 물리 키(`code`)로 본다.
 *
 * `key`로 보면 한글 입력 상태에서 같은 키가 'ㅍ'이 되고, 조합 중이면 'Process'가 되어
 * 단축키가 조용히 무시됐다. 팝업 안의 글 상자에 한글을 치다가 누르는 것이 이 단축키의
 * 가장 흔한 쓰임이라 그 경우가 정확히 "특정 팝업에서만 안 뜬다"로 보였다.
 * `code`가 없는 오래된 이벤트만 `key`로 폴백한다.
 */
export function isVocShortcut(e: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'key' | 'code' | 'repeat'>): boolean {
  if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey || e.repeat) return false;
  if (e.code) return e.code === 'KeyV';
  return typeof e.key === 'string' && e.key.toLowerCase() === 'v';
}
