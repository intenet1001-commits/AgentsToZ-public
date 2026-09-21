export type AppTheme = 'gray' | 'dark';
export const APP_THEME_STORAGE_KEY = 'agentstoz-appearance-theme';
export function normalizeAppTheme(value: unknown): AppTheme { return value === 'dark' ? 'dark' : 'gray'; }
export function readAppTheme(): AppTheme {
  try { return normalizeAppTheme(localStorage.getItem(APP_THEME_STORAGE_KEY)); } catch { return 'gray'; }
}
export function applyAppTheme(theme: AppTheme): void {
  document.documentElement.dataset.appTheme = theme;
}
export function saveAppTheme(theme: AppTheme): boolean {
  applyAppTheme(theme);
  try { localStorage.setItem(APP_THEME_STORAGE_KEY, theme); return true; } catch { return false; }
}
