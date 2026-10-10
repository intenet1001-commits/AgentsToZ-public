import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';

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
    const available = (opensAbove ? rect.bottom - 12 : window.innerHeight - rect.top - 12) / scale;
    panel.style.maxHeight = `${Math.max(0, Math.min(620, available))}px`;
  }, []);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (root.current && event.target instanceof Node && !root.current.contains(event.target)) root.current.open = false;
    };
    document.addEventListener('pointerdown', close);
    window.addEventListener('resize', fitPanel);
    const resize = new ResizeObserver(fitPanel);
    if (root.current) resize.observe(root.current);
    if (root.current?.parentElement) resize.observe(root.current.parentElement);
    const zoom = new MutationObserver(fitPanel);
    const appRoot = document.getElementById('root');
    if (appRoot) zoom.observe(appRoot, { attributes: true, attributeFilter: ['style'] });
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
