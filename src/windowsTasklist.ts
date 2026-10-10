/**
 * Windows process presence by image name.
 *
 * macOS answers "is any Codex CLI running" with `/bin/ps -Ao command=`, which
 * gives full command lines. Windows has no cheap equivalent: `tasklist` lists
 * image names only, and `Get-CimInstance Win32_Process` carries CommandLine but
 * costs ~1527ms and returns `null` for processes the user may not inspect
 * (measured — the first three rows were all null). So command-line matching is
 * not available here and must not be faked.
 *
 * Measured on Windows 11 26100:
 *   tasklist /FI "IMAGENAME eq codex.exe" /FO CSV /NH   → 428 ms
 *   tasklist (unfiltered)                               → 1320 ms, 421 rows
 *
 * ⚠️ Never parse tasklist's prose. With no match it prints a single
 * informational sentence that a localized Windows may translate, yet it still
 * exits 0 — so neither the exit code nor the message decides anything. A real
 * match is a quoted CSV row whose first field is the image name, and counting
 * those rows is locale-proof.
 */

/** An image name is a pinned constant in this app; this rejects a corrupted one. */
export function isTasklistImageName(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,64}\.exe$/i.test(value);
}

export function tasklistImageQueryArgs(image: string): readonly string[] {
  if (!isTasklistImageName(image)) throw new Error('pinned image name');
  // /NH drops the header row, so every remaining CSV row is a process.
  return ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'];
}

/**
 * Number of processes reported for `image`. Only a quoted CSV row whose first
 * field matches counts, so the no-match sentence contributes nothing in any
 * language.
 */
export function tasklistImageMatchCount(output: string, image: string): number {
  if (typeof output !== 'string' || !isTasklistImageName(image)) return 0;
  // A runaway listing is bounded rather than scanned in full.
  if (output.length > 1_000_000) return 0;
  const wanted = image.toLowerCase();
  let count = 0;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('"')) continue;
    const first = line.slice(1, line.indexOf('"', 1) === -1 ? undefined : line.indexOf('"', 1));
    if (first.toLowerCase() === wanted) count++;
  }
  return count;
}

/**
 * `null` output means the listing could not be read -- a denial, not an absence.
 * Returning `false` there would report a live process as gone.
 */
export function isWindowsImageRunning(output: string | null | undefined, image: string): boolean | null {
  if (typeof output !== 'string') return null;
  return tasklistImageMatchCount(output, image) > 0;
}
