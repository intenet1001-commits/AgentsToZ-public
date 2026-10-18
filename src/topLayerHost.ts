import { useEffect, useState } from 'react';

/**
 * 화면 전체를 덮는 오버레이(VOC·가이드)를 어디에 붙일지 정한다.
 *
 * 모달 `<dialog>`(`showModal()`)는 **top layer**에 올라가서 z-index와 상관없이 문서의
 * 다른 모든 것 위에 그려지고, 그 바깥은 전부 inert(클릭·포커스 불가)가 된다. 그래서
 * `document.body`에 붙인 오버레이는 z 2^31이어도 모달 아래에 깔려 보이지 않았다 —
 * ⌘/Ctrl+Shift+V가 "켜지긴 했는데 안 뜨는" 팝업이 정확히 그 경우였다(자주 쓰는 프롬프트·
 * 화면 설정·워크룸 종료 저장·CS 대직). 모달 안에 붙여야 top layer 안에서 그려지고 클릭도 받는다.
 *
 * 가장 위의 모달을 고른다: 포커스가 든 모달 → 없으면 문서상 마지막으로 열린 모달.
 */
export function pickOverlayHost(doc: Document): HTMLElement {
  const modals = Array.from(doc.querySelectorAll<HTMLDialogElement>('dialog[open]')).filter(isModalDialog);
  if (modals.length === 0) return doc.body;
  const focused = doc.activeElement instanceof Element ? doc.activeElement.closest('dialog') : null;
  if (focused && modals.includes(focused as HTMLDialogElement)) return focused as HTMLElement;
  return modals[modals.length - 1] ?? doc.body;
}

function isModalDialog(dialog: HTMLDialogElement): boolean {
  try { return dialog.matches(':modal'); } catch { return false; } // :modal 미지원 엔진은 비모달로 본다
}

/** active 동안 모달이 열리고 닫히는 것을 따라 오버레이 호스트를 갱신한다. */
export function useOverlayHost(active: boolean): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!active || typeof document === 'undefined') { setHost(null); return; }
    const update = () => setHost(prev => {
      const next = pickOverlayHost(document);
      return prev === next ? prev : next;
    });
    update();
    // 모달의 열림/닫힘은 `open` 속성으로 드러난다. 모달이 DOM에서 통째로 빠지는 경우도 본다.
    const observer = new MutationObserver(update);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    document.addEventListener('close', update, true);
    return () => { observer.disconnect(); document.removeEventListener('close', update, true); };
  }, [active]);
  return host;
}
