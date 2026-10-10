/**
 * Windows URL-protocol presence.
 *
 * macOS proves a desktop app exists by finding its bundle (`/Applications/...
 * Info.plist`, then a Spotlight query). Windows has no equivalent for a Store
 * app: ChatGPT and Codex ship as AppX packages whose executables live under a
 * protected `WindowsApps` path that cannot be probed with `existsSync`.
 *
 * What IS observable, and is exactly what matters before opening a deep link, is
 * whether the OS has a handler registered for the scheme. Measured on Windows 11
 * 26100 with both apps installed: `HKCU\Software\Classes\codex` and
 * `...\chatgpt` carry a `URL Protocol` value, while an unregistered scheme
 * returns exit 1 (~115ms per query).
 *
 * ⚠️ Previously `codexDesktopAppAvailable()` short-circuited to `true` for every
 * non-macOS platform. That made the Codex remote action claim the desktop app
 * was present on a Windows machine that had never installed it, so the failure
 * surfaced later as an unrelated deep-link error.
 */

/** Schemes this app may ask about. A scheme never comes from a request body. */
export type WindowsUrlScheme = 'codex' | 'chatgpt' | 'claude';

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]{0,31}$/;

export function isPinnedWindowsUrlScheme(value: string): value is WindowsUrlScheme {
  return SCHEME_PATTERN.test(value) && (value === 'codex' || value === 'chatgpt' || value === 'claude');
}

/**
 * Registry key for a scheme in one hive. Per-user registrations (HKCU) are what
 * an AppX or a per-user installer writes, so HKCU is checked first.
 */
export function windowsUrlProtocolKey(hive: 'HKCU' | 'HKLM', scheme: string): string {
  if (!SCHEME_PATTERN.test(scheme)) throw new Error('pinned url scheme');
  return `${hive}\\Software\\Classes\\${scheme}`;
}

export function windowsUrlProtocolQueryArgs(hive: 'HKCU' | 'HKLM', scheme: string): readonly string[] {
  return ['query', windowsUrlProtocolKey(hive, scheme), '/v', 'URL Protocol'];
}

/** Hives in probe order. */
export const WINDOWS_URL_PROTOCOL_HIVES = ['HKCU', 'HKLM'] as const;

/**
 * `reg query` exits 0 only when the key and the value both exist, so the exit
 * code alone answers the question and no localized output is parsed.
 */
export function isWindowsUrlProtocolRegistered(exitCodes: readonly (number | null)[]): boolean {
  return exitCodes.some(code => code === 0);
}
