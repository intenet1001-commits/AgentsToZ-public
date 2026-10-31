import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import { isModalLayerTarget } from '../dialogEscape';
import { cornerFloatBoxes, popoverPlacement } from '../cornerFloatClearance';

/** Native disclosure keeps less frequent actions together without removing them. */
export function WorkspaceTools({ label, compact = false, children }: {
  label: string; compact?: boolean; children: ReactNode;
}) {
  const root = useRef<HTMLDetailsElement>(null);
  const fitPanel = useCallback(() => {
    if (!root.current?.open) return;
    const panel = root.current.querySelector<HTMLElement>(':scope > .workspace-tools-panel');
    if (!panel || getComputedStyle(panel).position !== 'absolute') return;
    const rect = panel.getBoundingClientRect();
    const scale = rect.width / panel.offsetWidth;
    if (!scale) return;
    // getBoundingClientRect includes the browser's app transform; max-height uses logical px.
    const opensAbove = rect.bottom <= root.current.getBoundingClientRect().top;
    // Opening down, the list ends above the voice dock in the bottom-right corner rather than under it (the rest
    // scrolls); with no room left above an expanded dock it keeps the window's height and goes over the dock.
    const placement = opensAbove ? null : popoverPlacement({
      panelTop: rect.top, span: rect, windowHeight: window.innerHeight, scale, boxes: cornerFloatBoxes(),
    });
    if (placement?.overDock) root.current.dataset.overDock = 'true'; else delete root.current.dataset.overDock;
    const available = (placement ? placement.bottom - rect.top : rect.bottom - 12) / scale;
    panel.style.maxHeight = `${Math.max(0, Math.min(620, available))}px`;
  }, []);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!root.current || !(event.target instanceof Node) || root.current.contains(event.target)) return;
      // A dialog opened from this panel renders outside it; pressing inside that dialog (or its scrim) is not
      // leaving the panel, so the panel must still be there when the dialog closes.
      if (event.target instanceof Element && isModalLayerTarget(event.target)) return;
      root.current.open = false;
    };
    document.addEventListener('pointerdown', close);
    window.addEventListener('resize', fitPanel);
    const resize = new ResizeObserver(fitPanel);
    if (root.current) resize.observe(root.current);
    if (root.current?.parentElement) resize.observe(root.current.parentElement);
    const zoom = new MutationObserver(fitPanel);
    const appRoot = document.getElementById('root');
    if (appRoot) zoom.observe(appRoot, { attributes: true, attributeFilter: ['style'] });
    // The dock republishes --voice-dock-offset on <html> whenever it grows or shrinks (captions, a draft, notices).
    zoom.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    return () => {
      document.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', fitPanel);
      resize.disconnect();
      zoom.disconnect();
    };
  }, [fitPanel]);
  return <details ref={root} className={`workspace-tools${compact ? ' workspace-tools--compact' : ''}`}
    onToggle={event => { if (event.target === event.currentTarget) fitPanel(); }}
    onKeyDown={event => {
      if (event.key === 'Escape') {
        event.stopPropagation(); event.currentTarget.open = false;
        event.currentTarget.querySelector('summary')?.focus();
      }
    }}>
    <summary><SlidersHorizontal aria-hidden="true" /><span>{label}</span><ChevronDown aria-hidden="true" /></summary>
    <div className="workspace-tools-panel" aria-label={label}>{children}</div>
  </details>;
}
