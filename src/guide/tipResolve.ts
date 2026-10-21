import { getGuideEntry, hasGuideEntry, type GuideEntry } from './guideContent';

/**
 * Single source of truth for "what should the tooltip say about this element?".
 *
 * Both tooltip surfaces read from here so they can never disagree:
 *  - the always-on hover tooltip (TitleTipHost)
 *  - guide mode's overlay tooltip (GuideMode)
 *
 * Content is tiered. A curated `data-help-key` entry always wins over the raw
 * `title` attribute, which is why enabling guide mode is no longer required to
 * reach the ~60 written explanations — plain hover surfaces them too.
 */

export type TipSource = 'curated' | 'title' | 'auto';

export interface ResolvedTip {
  /** Element the tooltip is anchored to. */
  el: HTMLElement;
  title: string;
  body: string;
  hint?: string;
  source: TipSource;
}

/** Elements worth explaining even when nobody tagged them with data-help-key. */
export const INTERACTIVE_SELECTOR =
  'button, a[href], input, select, textarea, summary, [role="button"], [role="tab"], [role="menuitem"], [role="switch"], [contenteditable="true"]';

function clean(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Walks the parent chain to determine if an element is actually rendered.
 * `getComputedStyle(el)` only returns the element's own values, so a button
 * inside an `opacity-0` wrapper still reports `opacity: '1'`. We check
 * ancestors to catch wrappers that hide their children.
 */
export function isElementVisible(el: HTMLElement): boolean {
  const native = (el as unknown as { checkVisibility?: (opts: object) => boolean }).checkVisibility;
  if (typeof native === 'function') {
    try {
      return native.call(el, { checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true });
    } catch {
      // fall through to the manual walk
    }
  }
  let cur: HTMLElement | null = el;
  while (cur) {
    const s = window.getComputedStyle(cur);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
    cur = cur.parentElement;
  }
  return true;
}

function curatedFor(el: HTMLElement): (GuideEntry & { keyEl: HTMLElement }) | null {
  const keyEl = el.closest<HTMLElement>('[data-help-key]');
  const key = keyEl?.dataset.helpKey;
  if (!keyEl || !key || !hasGuideEntry(key)) return null;
  return { ...getGuideEntry(key), keyEl };
}

/**
 * Best-effort explanation for an element with neither a curated entry nor a title.
 * Used only by guide mode, where clicking must never come back empty.
 */
function autoFor(el: HTMLElement): ResolvedTip {
  const titleAttr = clean(el.getAttribute('title'));
  const ariaLabel = clean(el.getAttribute('aria-label'));
  const placeholder = clean(el.getAttribute('placeholder'));
  const text = clean(el.textContent).slice(0, 48);

  const name = ariaLabel || text || placeholder || titleAttr || '이 요소';
  const detail =
    titleAttr && titleAttr !== name
      ? titleAttr
      : placeholder && placeholder !== name
        ? `입력란이에요. 안내 문구: “${placeholder}”`
        : '';

  const tag = el.tagName.toLowerCase();
  const kind =
    tag === 'input' || tag === 'textarea' ? '입력란'
      : tag === 'select' ? '선택 메뉴'
        : tag === 'a' ? '링크'
          : tag === 'button' || el.getAttribute('role') === 'button' ? '버튼'
            : '클릭할 수 있는 항목';

  return {
    el,
    title: name,
    body: detail || `${kind}이에요. 가이드 모드를 끄고 누르면 실제로 동작해요.`,
    hint: '아직 자세한 설명이 등록되지 않아 화면 정보로 자동 안내하고 있어요.',
    source: 'auto',
  };
}

/**
 * @param allowAuto guide mode passes true so a click always yields something;
 *                  plain hover passes false so untagged controls stay quiet.
 * @param titleOf   how to read the title attribute. TitleTipHost temporarily removes
 *                  the attribute to beat the native tooltip, so it supplies the
 *                  borrowed value instead of letting us re-read the DOM.
 */
export function resolveTip(
  el: HTMLElement,
  { allowAuto, titleOf }: { allowAuto: boolean; titleOf?: (el: HTMLElement) => string | null },
): ResolvedTip | null {
  const curated = curatedFor(el);
  if (curated) {
    return {
      el: curated.keyEl,
      title: curated.title,
      body: curated.body,
      hint: curated.tip,
      source: 'curated',
    };
  }

  const titleEl = el.closest<HTMLElement>('[title]') ?? el;
  const raw = clean(titleOf ? titleOf(titleEl) : titleEl.getAttribute('title'));
  if (raw) {
    return { el: titleEl, title: raw, body: '', source: 'title' };
  }

  return allowAuto ? autoFor(el) : null;
}
