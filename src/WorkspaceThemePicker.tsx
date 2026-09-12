import React, { useEffect, useRef, useState } from 'react';
import { SunMoon } from 'lucide-react';
import { APP_THEME_STORAGE_KEY, applyAppTheme } from './appAppearance';

type Preference = 'system' | 'gray' | 'dark';
export function readWorkspaceTheme(): Preference {
  try {
    const stored = localStorage.getItem(APP_THEME_STORAGE_KEY);
    return stored === 'gray' || stored === 'dark' ? stored : 'system';
  } catch { return 'system'; }
}

export function WorkspaceThemePicker() {
  const [preference, setPreference] = useState(readWorkspaceTheme);
  const picker = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOutside = (event: Event) => {
      const element = picker.current;
      if (element?.open && event.target instanceof Node && !element.contains(event.target)) {
        // Do not cancel the event or move focus: the tapped control must still work.
        element.open = false;
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !picker.current?.open) return;
      event.preventDefault();
      picker.current.open = false;
      picker.current.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', closeOutside, true);
    document.addEventListener('focusin', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true);
      document.removeEventListener('focusin', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => applyAppTheme(preference === 'system' ? media.matches ? 'dark' : 'gray' : preference);
    apply();
    media.addEventListener('change', apply);
    const sync = (event: StorageEvent) => {
      if (event.key === APP_THEME_STORAGE_KEY || event.key === null) setPreference(readWorkspaceTheme());
    };
    window.addEventListener('storage', sync);
    return () => { media.removeEventListener('change', apply); window.removeEventListener('storage', sync); };
  }, [preference]);
  return <details ref={picker} className="workspace-theme">
    <summary aria-label="화면 설정" title="화면 설정"><SunMoon aria-hidden="true" /><span className="sr-only">화면 설정</span></summary>
    <div role="group" aria-label="화면 테마">
      {([['system', '기기 설정 따름'], ['gray', '밝게'], ['dark', '어둡게']] as const).map(([value, label]) =>
        <button key={value} type="button" aria-pressed={preference === value} onClick={() => {
          setPreference(value);
          try { localStorage.setItem(APP_THEME_STORAGE_KEY, value); } catch { /* Current screen still follows the choice. */ }
          if (picker.current) {
            picker.current.open = false;
            picker.current.querySelector('summary')?.focus();
          }
        }}>{label}</button>)}
    </div>
  </details>;
}
