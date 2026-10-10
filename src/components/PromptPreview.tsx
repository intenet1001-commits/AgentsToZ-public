import { useCallback, useEffect, useId, useRef, useState, type FocusEvent, type MouseEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { PREVIEW_LINES, promptPreview } from '../promptLibrary';

/**
 * 프롬프트 버튼 위에 올리거나(마우스) 초점을 두거나(키보드) 길게 누르면(터치) 본문을 미리 보여준다.
 *
 * `title` 툴팁을 쓰지 않는 이유: Tauri 웹뷰는 title을 그리지 않고(TitleTipHost가 대신 그린다),
 * 그 말풍선은 한 줄짜리라 여러 줄 프롬프트를 담지 못한다. 그래서 이 버튼들에는 title을 두지 않고
 * 이 팝오버 하나만 뜨게 한다. 처음 여섯 줄이 보이는 높이이고, 전체는 안에서 스크롤한다.
 * 팝오버 위로 마우스를 옮기면 닫히지 않으므로 긴 본문도 끝까지 읽을 수 있다.
 */
const SHOW_DELAY_MS = 250;
const HIDE_DELAY_MS = 150;
const LONG_PRESS_MS = 500;
const WIDTH = 448;
const GAP = 6;

type Open = { key: string; title: string; body: string; hint: string; rect: DOMRect; container: Element };

export function usePromptPreview() {
  const [open, setOpen] = useState<Open | null>(null);
  const showTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const pressTimer = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const id = useId();

  const clear = (timer: { current: number | null }) => { if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; } };
  const hide = useCallback(() => { clear(showTimer); clear(hideTimer); setOpen(null); }, []);
  const scheduleHide = () => { clear(showTimer); clear(hideTimer); hideTimer.current = window.setTimeout(() => setOpen(null), HIDE_DELAY_MS); };
  const show = (anchor: Element, key: string, title: string, body: string, hint: string, delay: number) => {
    clear(hideTimer); clear(showTimer);
    const run = () => {
      if (!anchor.isConnected) return;
      // A modal <dialog> sits in the top layer; a popover outside it would render underneath.
      setOpen({ key, title, body, hint, rect: anchor.getBoundingClientRect(), container: anchor.closest('dialog') ?? document.body });
    };
    if (delay <= 0) run(); else showTimer.current = window.setTimeout(run, delay);
  };

  useEffect(() => () => { clear(showTimer); clear(hideTimer); clear(pressTimer); }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') hide(); };
    const onScroll = (event: Event) => { if (!(event.target instanceof Node && document.getElementById(id)?.contains(event.target))) hide(); };
    const onOutside = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && document.getElementById(id)?.contains(event.target)) return;
      if (event.pointerType === 'touch') hide();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', onScroll, true);
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('pointerdown', onOutside, true);
      window.removeEventListener('resize', hide);
    };
  }, [open, hide, id]);

  /** Spread onto a button. `key` must be unique per entry. */
  const bind = (key: string, title: string, body: string, hint = '누르면 복사됩니다') => ({
    'aria-describedby': open?.key === key ? id : undefined,
    onMouseEnter: (event: MouseEvent<HTMLElement>) => show(event.currentTarget, key, title, body, hint, SHOW_DELAY_MS),
    onMouseLeave: scheduleHide,
    onFocus: (event: FocusEvent<HTMLElement>) => { if (event.currentTarget.matches(':focus-visible')) show(event.currentTarget, key, title, body, hint, 0); },
    onBlur: scheduleHide,
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      // A mouse click acts (copy/open); the preview has served its purpose.
      if (event.pointerType !== 'touch') { hide(); return; }
      const anchor = event.currentTarget;
      clear(pressTimer);
      pressTimer.current = window.setTimeout(() => { suppressClick.current = true; show(anchor, key, title, body, hint, 0); }, LONG_PRESS_MS);
    },
    onPointerUp: () => clear(pressTimer),
    onPointerCancel: () => clear(pressTimer),
    onContextMenu: (event: MouseEvent<HTMLElement>) => { if (suppressClick.current) event.preventDefault(); },
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      // A long press opens the preview; it must not also copy.
      if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); }
    },
  });

  let popover = null;
  if (open) {
    const { truncated, lines } = promptPreview(open.body);
    const width = Math.min(WIDTH, window.innerWidth - 24);
    const left = Math.max(12, Math.min(open.rect.left, window.innerWidth - width - 12));
    const below = window.innerHeight - open.rect.bottom > 220;
    const position = below ? { top: open.rect.bottom + GAP } : { bottom: window.innerHeight - open.rect.top + GAP };
    popover = createPortal(
      <div id={id} role="tooltip" data-testid="prompt-preview" data-truncated={truncated ? 'true' : 'false'}
        onMouseEnter={() => clear(hideTimer)} onMouseLeave={scheduleHide}
        className="rounded-xl border border-[var(--line)] bg-[var(--raised)] p-3 text-[var(--ink)] shadow-2xl"
        style={{ position: 'fixed', left, width, zIndex: 2147482500, ...position }}>
        <p className="mb-1 truncate text-xs font-semibold">{open.title || '제목 없는 프롬프트'}</p>
        <pre data-testid="prompt-preview-body" tabIndex={0} aria-label="프롬프트 전체 내용"
          className="overflow-y-auto whitespace-pre-wrap break-words font-sans text-xs text-[var(--ink-2)] [overflow-wrap:anywhere]"
          style={{ maxHeight: `calc(${PREVIEW_LINES} * 1.5em)`, lineHeight: 1.5, margin: 0 }}>{open.body}</pre>
        <p className="mt-1 text-[11px] text-[var(--ink-3)]">
          {truncated ? `전체 ${lines}줄 · 안에서 스크롤하면 나머지가 보입니다 · ${open.hint}` : open.hint}
        </p>
      </div>, open.container);
  }
  return { bind, popover, hide };
}
