import React, { useEffect, useRef, useState } from 'react';
import { Lightbulb, Pin, Wand2, X } from 'lucide-react';
import type { ResolvedTip } from '../guide/tipResolve';

/**
 * The one tooltip bubble in the app. Both the always-on hover tooltip and guide
 * mode render through this, so the two surfaces cannot drift apart visually or
 * in their positioning behaviour.
 *
 * A short `title`-only tip renders as a single plain line; a curated entry renders
 * with its heading and hint. Same component, different density.
 */

const GAP = 8;
const RICH_W = 288;
const PLAIN_MAX_W = 340;

export function TipBubble({
  tip,
  rect,
  zIndex,
  topBoundary = 0,
  pinned = false,
  onClose,
}: {
  tip: ResolvedTip;
  /** Live viewport rect of the anchor element. */
  rect: DOMRect;
  zIndex: number;
  /** Lowest y the bubble may occupy — guide mode reserves its banner strip. */
  topBoundary?: number;
  pinned?: boolean;
  onClose?: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const rich = tip.source !== 'title';
  const [size, setSize] = useState({ w: rich ? RICH_W : PLAIN_MAX_W, h: 44 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    if (w !== size.w || h !== size.h) setSize({ w, h });
  });

  const vw = window.innerWidth, vh = window.innerHeight;
  let top = rect.bottom + GAP;
  let placement: 'below' | 'above' = 'below';
  if (top + size.h > vh - 8 && rect.top - GAP - size.h > topBoundary + 8) {
    top = rect.top - GAP - size.h;
    placement = 'above';
  }
  top = Math.max(topBoundary + 8, Math.min(top, vh - size.h - 8));
  const left = Math.max(8, Math.min(rect.left + rect.width / 2 - size.w / 2, vw - size.w - 8));

  const arrowLeft = Math.max(10, Math.min(rect.left + rect.width / 2 - left - 5, size.w - 20));
  const arrowVisible =
    (placement === 'below' && Math.abs(top - (rect.bottom + GAP)) < 1) ||
    (placement === 'above' && Math.abs(top - (rect.top - GAP - size.h)) < 1);

  return (
    <div
      ref={ref}
      data-guide-ui="1"
      data-testid="tip-bubble"
      data-tip-source={tip.source}
      role="tooltip"
      style={{
        position: 'fixed',
        top,
        left,
        ...(rich ? { width: RICH_W } : { maxWidth: PLAIN_MAX_W, width: 'max-content' }),
        zIndex,
        background: '#141a19',
        border: '1px solid rgba(94,234,212,0.28)',
        borderRadius: rich ? 12 : 8,
        padding: rich ? '13px 15px 14px' : '8px 10px',
        boxShadow: '0 12px 36px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,0,0,0.4)',
        color: '#e6f2f0',
        fontSize: rich ? 12.5 : 11.5,
        lineHeight: 1.55,
        whiteSpace: rich ? 'normal' : 'pre-line',
        // A pinned bubble must stay interactive so its close button works; an
        // unpinned one must never eat the pointer or it flickers against hover.
        pointerEvents: pinned ? 'auto' : 'none',
        fontFamily: 'Inter Tight, system-ui, sans-serif',
        animation: 'guide-tip-in 0.15s cubic-bezier(0.25, 0.1, 0.25, 1)',
      }}
    >
      {rich ? (
        <>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: tip.body ? 7 : 0 }}>
            <span style={{ flex: 1, fontWeight: 600, color: '#5eead4', fontSize: 13.5, letterSpacing: -0.1 }}>
              {tip.title}
            </span>
            {tip.source === 'auto' && (
              <span
                style={{
                  display: 'flex', alignItems: 'center', gap: 3, fontSize: 9.5, color: '#5b7a75',
                  border: '1px solid rgba(94,234,212,0.2)', borderRadius: 4, padding: '1px 5px',
                  flexShrink: 0, marginTop: 1,
                }}
              >
                <Wand2 size={9} /> 자동
              </span>
            )}
            {pinned && (
              <span style={{ display: 'flex', alignItems: 'center', color: '#5b7a75', flexShrink: 0, marginTop: 2 }}>
                <Pin size={10} />
              </span>
            )}
            {pinned && onClose && (
              <button
                onClick={onClose}
                aria-label="닫기"
                style={{
                  background: 'transparent', border: 'none', color: '#5b6663', cursor: 'pointer',
                  padding: 2, display: 'flex', alignItems: 'center',
                }}
              >
                <X size={13} />
              </button>
            )}
          </div>
          {tip.body && <div style={{ color: '#b5c4c1', marginBottom: tip.hint ? 9 : 0 }}>{tip.body}</div>}
          {tip.hint && (
            <div
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 7,
                background: 'rgba(94,234,212,0.06)', borderLeft: '2px solid rgba(94,234,212,0.45)',
                borderRadius: 4, padding: '7px 10px', color: '#8fd3c7', fontSize: 11.5, lineHeight: 1.5,
              }}
            >
              <Lightbulb size={11} style={{ marginTop: 2.5, flexShrink: 0, opacity: 0.85 }} />
              <span>{tip.hint}</span>
            </div>
          )}
        </>
      ) : (
        <span style={{ color: '#d5e3e0' }}>{tip.title}</span>
      )}

      {arrowVisible && (
        <div
          style={{
            position: 'absolute',
            left: arrowLeft,
            ...(placement === 'below'
              ? { top: -5, borderBottom: '5px solid rgba(94,234,212,0.28)' }
              : { bottom: -5, borderTop: '5px solid rgba(94,234,212,0.28)' }),
            width: 0, height: 0,
            borderLeft: '5px solid transparent',
            borderRight: '5px solid transparent',
          }}
        />
      )}
    </div>
  );
}
