import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';

type CopyState = 'idle' | 'copying' | 'copied' | 'error';

/** Keep feedback beside the action, including when its containing panel scrolls. */
export function ClipboardCopyButton({ value, label, copiedLabel, copyingLabel, successMessage, errorMessage, className, disabled, testId }: {
  value: string;
  label: string;
  copiedLabel: string;
  copyingLabel: string;
  successMessage: string;
  errorMessage: string;
  className?: string;
  disabled?: boolean;
  testId?: string;
}) {
  const [state, setState] = useState<CopyState>('idle');
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const inFlight = useRef(false);

  useEffect(() => {
    setState('idle');
    inFlight.current = false;
    // A key can be rotated or its card removed while the clipboard is pending.
    return () => { generation.current += 1; };
  }, [value]);

  const copy = async () => {
    if (disabled || !value || inFlight.current) return;
    const currentGeneration = generation.current;
    inFlight.current = true;
    setAttempt(current => current + 1);
    setState('copying');
    try {
      // Call in the click's user activation; do not defer clipboard access.
      await navigator.clipboard.writeText(value);
      if (generation.current === currentGeneration) setState('copied');
    } catch {
      if (generation.current === currentGeneration) setState('error');
    } finally {
      if (generation.current === currentGeneration) inFlight.current = false;
    }
  };

  return <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
    <button type="button" className={className} aria-label={label} title={label}
      data-testid={testId} disabled={disabled || !value || state === 'copying'}
      onClick={() => void copy()}>
      {state === 'copied' ? <Check className="h-3.5 w-3.5 shrink-0 text-[var(--ok)]" aria-hidden="true" />
        : state === 'copying' ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
          : <Copy className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
      {state === 'copied' ? copiedLabel : state === 'copying' ? copyingLabel : label}
    </button>
    <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      <span key={attempt}>{state === 'copied' ? successMessage : state === 'copying' ? copyingLabel : ''}</span>
    </span>
    {state === 'error' && <span role="alert" className="max-w-full break-words text-xs text-[var(--danger)]">{errorMessage}</span>}
  </span>;
}
