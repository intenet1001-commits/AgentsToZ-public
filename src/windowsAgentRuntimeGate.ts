/**
 * Whether the Windows Agent Runtime is turned on, and the containment launcher
 * that makes it possible.
 *
 * The Agent Runtime refused to run on Windows because a Job Object alone is not
 * a security boundary — measured, and recorded in
 * `docs/agent-runtime-containment.md`: a normal-integrity process inside a
 * kill-on-close job created processes outside it through WMI, the task scheduler
 * and the running explorer. `agentstoz-windows-contain` closes that by running
 * the provider at low integrity with per-launch staging, and the guard keeps
 * doing every protocol and policy job it already did.
 *
 * ⚠️ **Off unless a marker file exists, and that is the whole point.** The
 * containment is measured, but turning a provider loose on a user's machine is
 * their decision and not a side effect of an upgrade. Without the marker the
 * Windows behaviour is exactly what it was: the guard command resolves to
 * nothing and the Agent Runtime reports itself unavailable.
 *
 * The marker lives beside the guard registry, which is app-private and already
 * permission-checked — not in an environment variable, which a parent process or
 * a shell profile could set without anyone deciding anything.
 */

import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Created by hand to turn the Windows Agent Runtime on. Contents are ignored. */
export const WINDOWS_AGENT_RUNTIME_MARKER = 'agent-runtime-windows.enabled';

/** The containment launcher, beside the packaged sidecar. */
export const WINDOWS_CONTAINMENT_LAUNCHER = 'agentstoz-windows-contain.exe';

/**
 * Executables that live in the packaged resources directory beside the launcher.
 *
 * ⚠️ Both names are needed because **two different processes** ask this question.
 * The sidecar asks while deciding whether the guard command resolves at all; the
 * guard asks again, from its own process, while deciding what to spawn the
 * provider through. Matching only the sidecar meant the guard -- whose own
 * `execPath` is `agentstoz-agent-runtime-guard.exe` -- never found the launcher
 * and refused every Windows launch, with the marker and the launcher both in
 * place. All three ship side by side, so either neighbour is the same evidence.
 */
const PACKAGED_NEIGHBOUR_NAME_RE =
  /^agentstoz-(?:api-sidecar|agent-runtime-guard)(?:\.exe)?$/i;

/** A regular file, not a directory or a dangling link. */
function regularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether the marker beside `registryDatabasePath` is present.
 *
 * Takes the registry path rather than an app-data directory because that is what
 * a caller already holds, and because the registry's own directory has already
 * been checked for private ownership — the marker inherits that.
 */
export function windowsAgentRuntimeEnabled(
  registryDatabasePath: string | null | undefined,
  platform: string = process.platform,
): boolean {
  if (platform !== 'win32') return false;
  if (typeof registryDatabasePath !== 'string' || registryDatabasePath.length === 0) return false;
  return regularFile(join(dirname(registryDatabasePath), WINDOWS_AGENT_RUNTIME_MARKER));
}

/**
 * The containment launcher's path, or null.
 *
 * Only looked for beside a **packaged** sidecar or guard. A source run has no
 * launcher built next to it, and silently falling back to a `cargo` build output
 * would mean shipping behaviour that depends on a developer's target directory.
 */
export function windowsContainmentLauncher(
  execPath: string = process.execPath,
  platform: string = process.platform,
): string | null {
  if (platform !== 'win32') return null;
  if (!PACKAGED_NEIGHBOUR_NAME_RE.test(basename(execPath))) return null;
  const candidate = join(dirname(execPath), WINDOWS_CONTAINMENT_LAUNCHER);
  return regularFile(candidate) ? candidate : null;
}

/**
 * The launch id the launcher stages under.
 *
 * ⚠️ Reaches the filesystem as a directory name, and the launcher refuses
 * anything but a plain id, so it is built here rather than taken from a caller.
 * The reservation's own launch id is a UUID; this keeps only its hex so the same
 * launch is recognisable in a staging path without widening the character set.
 */
export function windowsStagingLaunchId(reservationLaunchId: string): string {
  const compact = reservationLaunchId.replace(/[^0-9a-fA-F]/g, '').slice(0, 32);
  if (compact.length < 8) throw new Error('A launch id is required for Windows staging.');
  return `launch-${compact.toLowerCase()}`;
}

/**
 * Whether a provider working directory is absolute for this platform.
 *
 * The POSIX guard checks `startsWith('/')`, which no Windows path satisfies.
 * A UNC path is accepted; a drive-relative path like `C:work` is not, because it
 * resolves against a per-drive current directory the guard deliberately does not
 * have.
 */
export function isAbsoluteProviderCwd(value: string, platform: string = process.platform): boolean {
  if (platform !== 'win32') return value.startsWith('/');
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}
