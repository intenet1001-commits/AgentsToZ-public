/**
 * Platform detection for renderer code.
 *
 * `navigator.platform` is the most reliable signal inside both WebView2 (the
 * Windows Tauri webview) and WKWebView, and it is also what the deployed web
 * portal sees. `process.platform` is NOT usable here: the renderer has no Node
 * process, and the deployed portal runs on whatever machine opened the browser.
 *
 * ⚠️ Keep one definition. This started as a local helper inside `App.tsx`; a
 * second copy in another panel would drift and the two surfaces would disagree
 * about the same machine.
 */
export function isWindowsClient(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (navigator.platform) return navigator.platform.toLowerCase().startsWith('win');
  return navigator.userAgent.toLowerCase().includes('win');
}

/**
 * What to call the machine the app is running on, in user-facing Korean. The
 * voice and remote-control panels said "이 Mac" unconditionally, which on
 * Windows reads as "this feature belongs to some other computer".
 */
export function thisMachineLabel(windows = isWindowsClient()): string {
  return windows ? '이 PC' : '이 Mac';
}

/** The app that holds the local settings, named for the platform in use. */
export function localAppLabel(windows = isWindowsClient()): string {
  return windows ? 'Windows 앱' : 'Mac 앱';
}

/** OS credential store name, for text that explains where a key is kept. */
export function clientSecretStoreLabel(windows = isWindowsClient()): string {
  return windows ? 'Windows 자격 증명 관리자' : 'Mac Keychain';
}
