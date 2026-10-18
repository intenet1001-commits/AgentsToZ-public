export const BROWSER_PREFERENCE_KEY = 'agentstoz-default-browser';
export const BROWSER_PREFERENCE_EVENT = 'agentstoz-browser-preference-changed';
export type PreferredBrowser = 'ego-lite' | 'chrome' | 'system';
export function normalizePreferredBrowser(value: unknown): PreferredBrowser {
  return value === 'chrome' || value === 'system' ? value : 'ego-lite';
}
let current: PreferredBrowser | undefined;
export function readPreferredBrowser(): PreferredBrowser {
  if (current) return current;
  try { return normalizePreferredBrowser(localStorage.getItem(BROWSER_PREFERENCE_KEY)); }
  catch { return current ?? 'ego-lite'; }
}
export function savePreferredBrowser(value: PreferredBrowser): boolean {
  current = value;
  let saved = true;
  try { localStorage.setItem(BROWSER_PREFERENCE_KEY, value); current = undefined; } catch { saved = false; }
  window.dispatchEvent(new CustomEvent(BROWSER_PREFERENCE_EVENT, { detail: value }));
  return saved;
}
export function browserDisplayName(browser: PreferredBrowser): string {
  return browser === 'ego-lite' ? 'Ego Lite' : browser === 'chrome' ? 'Chrome' : '시스템 기본 브라우저';
}
