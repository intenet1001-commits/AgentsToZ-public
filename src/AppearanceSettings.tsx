import {OnboardingAppDataSection} from './OnboardingAppDataSection';
import {PlatformCliSettings} from './PlatformCliSettings';
import {MacCliAccountSwitcher} from './PlatformAccountSwitcher';
import {AppLanguagePicker} from './useAppLanguage';
import {isAppLanguagePersisted,subscribeAppLanguage,t,type Lang} from './i18n';
import { BROWSER_PREFERENCE_KEY, readPreferredBrowser, savePreferredBrowser, type PreferredBrowser } from './browserPreference';
import { isDeployedWeb } from './lib/env';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {createPortal} from 'react-dom';
import { Palette, X } from 'lucide-react';
import { applyAppTheme, APP_THEME_STORAGE_KEY, normalizeAppTheme, readAppTheme, saveAppTheme } from './appAppearance';

export function AppearanceSettings({ language, projects = [],onOpenData }: { language: Lang; projects?: {id:string;name:string}[];onOpenData?:()=>void }) {
  const [theme, setTheme] = useState(readAppTheme);
  const [browser, setBrowser] = useState(readPreferredBrowser);
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(true);
  const languageSaved = useSyncExternalStore(subscribeAppLanguage,isAppLanguagePersisted,()=>true);
  const dialog = useRef<HTMLDialogElement>(null);
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
    <button type="button" onClick={() => setOpen(true)} title={t(language,'appSettings')}
      aria-label={t(language,'appSettings')} data-testid="appearance-settings"
      className="rounded-lg border border-zinc-700 bg-[var(--bg-card)] p-1.5 text-zinc-300 hover:text-zinc-100">
      <Palette className="h-3.5 w-3.5" />
    </button>
    {/* A sidebar-owned modal made Mac WebKit retain the sibling body's AX exclusion
        after close. Keep the native modal in the document's top-level host. */}
    {typeof document !== 'undefined' && createPortal(<dialog ref={dialog} onCancel={() => setOpen(false)} onClose={event => {
      // A queued close event belongs to the previous opening if already reopened.
      if (!event.currentTarget.open) setOpen(false);
    }}
      aria-labelledby="appearance-heading" className="workspace-appearance-dialog whitespace-normal w-[min(440px,calc(100vw-32px))] max-h-[calc(100dvh-32px)] overflow-y-auto rounded-2xl border border-zinc-800 bg-[var(--bg-card)] p-6 text-zinc-100 shadow-[var(--dialog-shadow)] backdrop:bg-[var(--dialog-scrim)]">
      <div className="mb-5 flex items-center justify-between">
        <h2 id="appearance-heading" className="text-base font-semibold">{t(language,'appSettings')}</h2>
        <button autoFocus onClick={() => setOpen(false)} aria-label={t(language,'close')}
          className="grid h-[30px] w-[30px] place-items-center rounded-lg text-[var(--ink-3)] hover:bg-[var(--sunken)] hover:text-[var(--ink)]"><X className="h-4 w-4" /></button>
      </div>
      <AppLanguagePicker/>
      <fieldset>
        <legend className="mb-2.5">{t(language,'theme')}</legend>
        {(['gray', 'dark'] as const).map(value => <label key={value} className="relative flex cursor-pointer text-left">
          <input type="radio" name="app-theme" value={value} checked={theme === value} onChange={() => { setTheme(value); setSaved(saveAppTheme(value)); }} />
          <span aria-hidden="true" className={`workspace-theme-preview ${value === 'gray' ? 'workspace-theme-preview--light' : 'workspace-theme-preview--dark'}`}><i /><i /><i /></span>
          <span className="text-[12.5px] font-bold text-[var(--ink)]">{value === 'gray' ? (t(language,'lightTheme')) : (t(language,'darkTheme'))}
            <span className="mt-0.5 block text-[11.5px] font-medium text-[var(--ink-3)]">{value === 'gray' ? (t(language,'lightThemeDescription')) : (t(language,'darkThemeDescription'))}</span>
          </span>
        </label>)}
      </fieldset>
      {!isDeployedWeb() && <div className="mt-5 border-t border-[var(--line)] pt-5">
        <label htmlFor="preferred-browser" className="mb-2.5 block">{t(language,'defaultBrowser')}</label>
        <select id="preferred-browser" data-testid="preferred-browser" value={browser}
          onChange={event => { const next = event.target.value as PreferredBrowser; setBrowser(next); setSaved(savePreferredBrowser(next)); }}
          className="w-full rounded-lg border border-zinc-700 bg-[var(--bg-input)] px-3 py-2 text-sm text-zinc-100">
          <option value="ego-lite">Ego Lite · {t(language,'defaultMacOS')}</option>
          <option value="chrome">Google Chrome</option>
          <option value="system">{t(language,'systemBrowser')}</option>
        </select>
        <p className="mt-2 text-[11.5px] leading-5 text-[var(--ink-3)]">{t(language,'browserPreferenceHelp')}</p>
      </div>}
      {open && !isDeployedWeb() && <OnboardingAppDataSection language={language} onOpen={onOpenData?()=>{setOpen(false);onOpenData();}:undefined}/>}
      {open && !isDeployedWeb() && <MacCliAccountSwitcher language={language}/>}
      {open && !isDeployedWeb() && <PlatformCliSettings language={language} projects={projects}/>}

      <p role="status" className="mt-4 text-[11.5px] text-[var(--ink-3)]">{saved && languageSaved ? (t(language,'savedPreference')) : (t(language,'preferenceNotSaved'))}</p>
    </dialog>, document.body)}
  </>;
}
