import React, { useEffect, useRef, useState } from 'react';
import { TipBubble } from './TipBubble';
import { resolveTip, type ResolvedTip } from '../guide/tipResolve';

/**
 * The always-on hover tooltip.
 *
 * WHY THIS EXISTS: Tauri's webview (WKWebView on macOS, WebView2 on Windows) does
 * not draw HTML `title` tooltips — the host application is expected to render them
 * and neither wry nor Tauri does. Every `title="..."` hint in this app therefore
 * works in the browser and silently does nothing in the desktop build.
 *
 * It also serves the curated guide content: if the hovered element carries a
 * `data-help-key` with a written entry, that richer explanation is shown instead of
 * the terse `title`. Before this, those ~60 explanations were reachable only by
 * toggling guide mode, so most users never saw them.
 *
 * Mount once, near the root. Suspended while guide mode is on — the guide overlay
 * covers the page and runs its own hit-testing, so the two never compete.
 */

const SHOW_DELAY_MS = 130;
// Under the guide-mode band (2147483000+) so guide mode stays on top, over app modals.
const Z = 2147482000;

export function TitleTipHost({ suspended = false }: { suspended?: boolean }) {
  const [tip, setTip] = useState<ResolvedTip | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  // Element whose `title` we currently hold, so we can put it back.
  const borrowed = useRef<{ el: Element; title: string } | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (suspended) return;

    const restore = () => {
      const b = borrowed.current;
      if (b && b.el.isConnected && !b.el.getAttribute('title')) {
        b.el.setAttribute('title', b.title);
      }
      borrowed.current = null;
    };
    const clearTimer = () => {
      if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    };
    const hide = () => {
      clearTimer();
      restore();
      setTip(null);
      setRect(null);
    };

    const arm = (el: Element) => {
      if (borrowed.current?.el === el) return;
      const title = el.getAttribute('title');
      hide();

      // Take the attribute immediately: the native tooltip fires ~1s later, and we
      // must win that race or the user sees both in the browser.
      if (title && title.trim()) {
        borrowed.current = { el, title };
        el.removeAttribute('title');
      }
      const resolved = resolveTip(el as HTMLElement, {
        allowAuto: false,
        titleOf: node => (node === el ? title : node.getAttribute('title')),
      });
      if (!resolved) return;

      timer.current = window.setTimeout(() => {
        if (!resolved.el.isConnected) return hide();
        setTip(resolved);
        setRect(resolved.el.getBoundingClientRect());
      }, SHOW_DELAY_MS);
    };

    const onOver = (e: MouseEvent) => {
      const t = e.target;
      // Icon buttons usually report their SVG/path as the event target. SVGElement is
      // an Element but not an HTMLElement, so restricting this check to HTMLElement
      // made most icon tooltips silently fail.
      if (!(t instanceof Element)) return;
      if (t.closest('[data-guide-ui="1"]')) return;
      const el = t.closest('[title], [data-help-key]');
      if (!el) {
        if (borrowed.current && !borrowed.current.el.contains(t)) hide();
        else if (!borrowed.current && tip) hide();
        return;
      }
      arm(el);
    };

    const onOut = (e: MouseEvent) => {
      const anchor = borrowed.current?.el ?? tip?.el;
      if (!anchor) return;
      const to = e.relatedTarget;
      if (to instanceof Node && anchor.contains(to)) return;
      hide();
    };

    const onFocus = (e: FocusEvent) => {
      const t = e.target;
      if (t instanceof Element) {
        const el = t.closest('[title], [data-help-key]');
        if (el) arm(el);
      }
    };

    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };

    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
    document.addEventListener('focusin', onFocus, true);
    document.addEventListener('focusout', hide, true);
    document.addEventListener('mousedown', hide, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);

    return () => {
      hide();
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('mouseout', onOut, true);
      document.removeEventListener('focusin', onFocus, true);
      document.removeEventListener('focusout', hide, true);
      document.removeEventListener('mousedown', hide, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
    };
    // `tip` is intentionally excluded: re-binding listeners on every hover would
    // drop the in-flight one. The handlers read it through the closure only for
    // the anchor fallback, which tolerates a stale value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suspended]);

  // Guide mode taking over mid-hover must not leave a bubble stranded.
  useEffect(() => {
    if (suspended) { setTip(null); setRect(null); }
  }, [suspended]);

  if (suspended || !tip || !rect) return null;
  return <TipBubble tip={tip} rect={rect} zIndex={Z} />;
}
