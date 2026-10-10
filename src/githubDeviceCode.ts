/**
 * The one-time device code `gh auth login --web` prints.
 *
 * Only this value may be read out of the CLI's output. Everything else it
 * writes -- account names, config paths, error responses, any credential
 * fallback notice -- is discarded, so no login detail can reach a log or a UI
 * through this path.
 *
 * ⚠️ Two platforms run the login in different owners (the packaged guard on
 * macOS, the Job Object supervisor on Windows) but they must recognise the same
 * output. Keep this pattern here, not copied into each owner: a drifted copy
 * would silently stop surfacing the code on one platform while the other kept
 * working, and the user would just see a login that never shows a code.
 */
export const GITHUB_DEVICE_CODE_PATTERN = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/;

/** Bounded tail kept while scanning, so a chatty CLI cannot grow memory. */
export const GITHUB_DEVICE_CODE_TAIL_CHARS = 2048;

/** The code, or null when this chunk of output does not contain one. */
export function githubDeviceCodeFrom(output: string): string | null {
  if (typeof output !== 'string') return null;
  const match = output.match(GITHUB_DEVICE_CODE_PATTERN);
  return match ? match[1]! : null;
}
