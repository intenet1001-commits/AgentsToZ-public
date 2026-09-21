import { BROWSER_PREFERENCE_KEY, readPreferredBrowser, savePreferredBrowser, type PreferredBrowser } from './browserPreference';
import { isDeployedWeb } from './lib/env';
import React, { useEffect, useRef, useState } from 'react';
import { Palette, X } from 'lucide-react';
import { applyAppTheme, APP_THEME_STORAGE_KEY, normalizeAppTheme, readAppTheme, saveAppTheme } from './appAppearance';

export function AppearanceSettings({ language }: { language: 'ko' | 'en' }) {
  const [theme, setTheme] = useState(readAppTheme);
  const [browser, setBrowser] = useState(readPreferredBrowser);
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(true);
  const dialog = useRef<HTMLDialogElement>(null);
  const ko = language === 'ko';
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key === BROWSER_PREFERENCE_KEY || event.key === null) setBrowser(readPreferredBrowser());
      if (event.key !== APP_THEME_STORAGE_KEY && event.key !== null) return;
      const next = normalizeAppTheme(event.newValue); setTheme(next); applyAppTheme(next);
    };
    window.addEventListener('storage', update);
    return () => window.removeEventListener('storage', update);
  }, []);
  useEffect(() => {
    if (open) dialog.current?.showModal(); else dialog.current?.close();
  }, [open]);
  return <>
    <button type="button" onClick={() => setOpen(true)} title={ko ? '앱 설정' : 'App settings'}
      aria-label={ko ? '앱 설정' : 'App settings'} data-testid="appearance-settings"
      className="rounded-lg border border-zinc-700 bg-[var(--bg-card)] p-1.5 text-zinc-300 hover:text-zinc-100">
      <Palette className="h-3.5 w-3.5" />
    </button>
    <dialog ref={dialog} onCancel={() => setOpen(false)} onClose={() => setOpen(false)}
      aria-labelledby="appearance-heading" className="workspace-appearance-dialog whitespace-normal w-[min(440px,calc(100vw-32px))] max-h-[calc(100dvh-32px)] overflow-y-auto rounded-2xl border border-zinc-800 bg-[var(--bg-card)] p-6 text-zinc-100 shadow-[var(--dialog-shadow)] backdrop:bg-[var(--dialog-scrim)]">
      <div className="mb-5 flex items-center justify-between">
        <h2 id="appearance-heading" className="text-base font-semibold">{ko ? '앱 설정' : 'App settings'}</h2>
        <button autoFocus onClick={() => setOpen(false)} aria-label={ko ? '닫기' : 'Close'}
          className="grid h-[30px] w-[30px] place-items-center rounded-lg text-[var(--ink-3)] hover:bg-[var(--sunken)] hover:text-[var(--ink)]"><X className="h-4 w-4" /></button>
      </div>
      <fieldset>
        <legend className="mb-2.5">{ko ? '테마' : 'Theme'}</legend>
        {(['gray', 'dark'] as const).map(value => <label key={value} className="relative flex cursor-pointer text-left">
          <input type="radio" name="app-theme" value={value} checked={theme === value} onChange={() => { setTheme(value); setSaved(saveAppTheme(value)); }} />
          <span aria-hidden="true" className={`workspace-theme-preview ${value === 'gray' ? 'workspace-theme-preview--light' : 'workspace-theme-preview--dark'}`}><i /><i /><i /></span>
          <span className="text-[12.5px] font-bold text-[var(--ink)]">{value === 'gray' ? (ko ? '밝은 회색 · 기본' : 'Light gray · Default') : (ko ? '어두운 테마' : 'Dark')}
            <span className="mt-0.5 block text-[11.5px] font-medium text-[var(--ink-3)]">{value === 'gray' ? (ko ? '부드러운 회색 배경 · 검은 글씨' : 'Soft gray surfaces · black text') : (ko ? '따뜻한 검은 배경' : 'Warm near-black surfaces')}</span>
          </span>
        </label>)}
      </fieldset>
      {!isDeployedWeb() && <div className="mt-5 border-t border-[var(--line)] pt-5">
        <label htmlFor="preferred-browser" className="mb-2.5 block">{ko ? '기본 브라우저' : 'Default browser'}</label>
        <select id="preferred-browser" data-testid="preferred-browser" value={browser}
          onChange={event => { const next = event.target.value as PreferredBrowser; setBrowser(next); setSaved(savePreferredBrowser(next)); }}
          className="w-full rounded-lg border border-zinc-700 bg-[var(--bg-input)] px-3 py-2 text-sm text-zinc-100">
          <option value="ego-lite">Ego Lite{ko ? ' · 기본 (macOS)' : ' · Default (macOS)'}</option>
          <option value="chrome">Google Chrome</option>
          <option value="system">{ko ? '시스템 기본 브라우저' : 'System default browser'}</option>
        </select>
        <p className="mt-2 text-[11.5px] leading-5 text-[var(--ink-3)]">{ko ? '앱에서 여는 웹사이트와 localhost에 적용됩니다. 배포·GitHub용 Chrome 계정 프로필을 별도로 선택한 경우 그 프로필을 우선합니다.' : 'Applies to websites and localhost opened from the app. An explicitly selected Chrome account profile takes priority for deployment and GitHub links.'}</p>
      </div>}
      <p role="status" className="mt-4 text-[11.5px] text-[var(--ink-3)]">{saved ? (ko ? '변경 즉시 적용되며 이 기기에 저장됩니다.' : 'Changes apply immediately and are saved on this device.') : (ko ? '이번 창에는 적용했습니다. 저장 공간에 접근할 수 없어 다음 실행에는 유지되지 않을 수 있습니다.' : 'Applied for this window. Storage is unavailable; the setting may not persist.')}</p>
    </dialog>
  </>;
}
