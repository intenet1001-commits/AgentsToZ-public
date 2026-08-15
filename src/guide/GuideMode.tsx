import React, { useEffect, useRef, useState, useCallback } from 'react';
import { GraduationCap, X } from 'lucide-react';
import { TipBubble } from '../components/TipBubble';
import { isElementVisible, resolveTip, type ResolvedTip } from './tipResolve';
import { findTargetAt } from './pickTarget';

interface GuideOverlayProps {
  guideMode: boolean;
  setGuideMode: (v: boolean) => void;
}

const BANNER_H = 36;

/**
 * Layering. The overlay MUST sit above every app layer it is meant to intercept,
 * otherwise clicks land on the real UI and guide mode silently does nothing.
 * App layers today: modals 9500, card context menu 9998/9999, toasts 10000.
 * We therefore park guide mode in its own band well above all of them.
 */
export const GUIDE_Z = {
  overlay: 2147483000,
  halo: 2147483001,
  banner: 2147483002,
  tooltip: 2147483003,
} as const;

/**
 * Guide mode is a *safe exploration* mode: the overlay swallows every click so the
 * user can poke at destructive buttons (강제 재실행, 삭제) and only get an explanation.
 *
 * Explanations follow the pointer — the overlay blocks the app's own hover events,
 * so if guide mode waited for clicks the user would have to click all ~70 controls
 * one by one to read what is otherwise available by sweeping the mouse. Clicking
 * pins the current bubble so it survives moving the mouse away.
 */
export function GuideOverlay({ guideMode, setGuideMode }: GuideOverlayProps) {
  const [hover, setHover] = useState<ResolvedTip | null>(null);
  const [pinned, setPinned] = useState<ResolvedTip | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const active = pinned ?? hover;

  const clearAll = useCallback(() => {
    setHover(null);
    setPinned(null);
    setRect(null);
  }, []);

  // Body class for the calm baseline markers
  useEffect(() => {
    if (guideMode) {
      document.body.classList.add('guide-mode-active');
    } else {
      document.body.classList.remove('guide-mode-active');
      clearAll();
    }
    return () => { document.body.classList.remove('guide-mode-active'); };
  }, [guideMode, clearAll]);

  /**
   * Anchor rects are re-read continuously while a bubble is up. Snapshotting the
   * rect at hover time left the tooltip stranded after any scroll or layout change.
   */
  useEffect(() => {
    if (!active) return;
    const same = (a: DOMRect | null, b: DOMRect) =>
      !!a && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;

    const sync = () => {
      if (!active.el.isConnected || !isElementVisible(active.el)) return clearAll();
      const r = active.el.getBoundingClientRect();
      setRect(prev => (same(prev, r) ? prev : r));
    };

    // rAF keeps up with animated layouts; scroll/resize cover the case where rAF is
    // throttled because the window is unfocused. `capture: true` is required to catch
    // inner scroll containers, which do not bubble.
    let raf = 0;
    const loop = () => { sync(); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    document.addEventListener('scroll', sync, true);
    window.addEventListener('resize', sync);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('scroll', sync, true);
      window.removeEventListener('resize', sync);
    };
  }, [active, clearAll]);

  const handleMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = findTargetAt(e.clientX, e.clientY);
    if (!target) {
      if (hover) setHover(null);
      return;
    }
    if (hover?.el === target) return;
    const resolved = resolveTip(target, { allowAuto: true });
    if (!resolved) { setHover(null); return; }
    setHover(resolved);
    if (!pinned) setRect(resolved.el.getBoundingClientRect());
  }, [hover, pinned]);

  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = findTargetAt(e.clientX, e.clientY);
    if (!target) { setPinned(null); return; }
    const resolved = resolveTip(target, { allowAuto: true });
    if (!resolved) { setPinned(null); return; }
    // Clicking the already-pinned element unpins it.
    setPinned(prev => (prev?.el === resolved.el ? null : resolved));
    setRect(resolved.el.getBoundingClientRect());
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (pinned) { e.stopPropagation(); setPinned(null); }
      else if (hover) setHover(null);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [pinned, hover, clearAll]);

  if (!guideMode) return null;

  const haloRect = rect;

  return (
    <>
      <div
        className="guide-mode-banner"
        data-guide-ui="1"
        style={{
          position: 'fixed', top: 0, left: 0, right: 0, height: BANNER_H, boxSizing: 'border-box',
          zIndex: GUIDE_Z.banner, background: '#0d1413', color: '#e6f2f0', padding: '8px 14px',
          display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, fontWeight: 500,
          borderBottom: '1px solid rgba(94,234,212,0.3)', fontFamily: 'Inter Tight, system-ui, sans-serif',
        }}
      >
        <GraduationCap size={14} style={{ color: '#5eead4' }} />
        <span style={{ color: '#8ca39f' }}>
          <span style={{ color: '#5eead4', fontWeight: 600 }}>안전 탐색 모드</span>
          <span style={{ marginLeft: 8 }}>
            마우스를 올리면 설명이 나오고, 클릭하면 설명이 고정돼요. 실제 동작은 일어나지 않아요.
          </span>
        </span>
        <span style={{ flex: 1 }} />
        <button
          onClick={() => setGuideMode(false)}
          style={{
            background: 'transparent', border: '1px solid rgba(94,234,212,0.4)', padding: '3px 10px',
            borderRadius: 5, fontSize: 11.5, fontWeight: 500, cursor: 'pointer', color: '#5eead4',
            display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'inherit',
          }}
        >
          <X size={11} />
          끄기
        </button>
      </div>

      <div
        data-guide-ui="1"
        onClick={handleClick}
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
        style={{
          position: 'fixed', top: BANNER_H, left: 0, right: 0, bottom: 0,
          zIndex: GUIDE_Z.overlay, cursor: hover ? 'help' : 'crosshair', background: 'transparent',
        }}
      />

      {haloRect && (
        <div
          data-guide-ui="1"
          style={{
            position: 'fixed',
            top: haloRect.top - 3, left: haloRect.left - 3,
            width: haloRect.width + 6, height: haloRect.height + 6,
            border: `1.5px solid ${pinned ? '#5eead4' : 'rgba(94,234,212,0.75)'}`,
            borderRadius: 7,
            boxShadow: '0 0 0 4px rgba(94,234,212,0.12), 0 4px 14px rgba(94,234,212,0.18)',
            pointerEvents: 'none', zIndex: GUIDE_Z.halo,
          }}
        />
      )}

      {active && rect && (
        <TipBubble
          tip={active}
          rect={rect}
          zIndex={GUIDE_Z.tooltip}
          topBoundary={BANNER_H}
          pinned={!!pinned}
          onClose={() => setPinned(null)}
        />
      )}
    </>
  );
}
