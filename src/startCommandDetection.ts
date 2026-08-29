/**
 * Some projects have no manifest at their root: the runnable parts live in
 * subfolders (frontend/, backend/, …) and a platform-native launcher at the root
 * starts them together. Failing to look for it left such a project
 * with "실행할 파일 또는 터미널 명령어가 등록되지 않았습니다" and no way forward
 * short of typing the command by hand.
 *
 * Manifests still win. This only answers when nothing else did, so no project
 * that runs today changes behaviour.
 */

/** Names that read as "start this project", used only to break a tie. */
const LAUNCHER_NAME_RE = /(실행|start|run|dev|launch|serve)/i;

/** Helpers this app installs for its own workflow, never a project's start. */
const APP_HELPER_NAME_RE = /(포트에추가|add-?port|install)/i;

export type CommandLauncherReason = 'single' | 'conventional' | 'ambiguous' | 'none';

export interface CommandLauncherPick {
  /** File name to run, or null when there is nothing unambiguous to pick. */
  fileName: string | null;
  reason: CommandLauncherReason;
}

export type CommandLauncherPlatform = 'win32' | 'unix';

/**
 * Guessing between several launchers could start the wrong one, so ambiguity
 * yields null rather than a coin flip.
 */
export function pickCommandLauncher(
  fileNames: readonly string[],
  platform: CommandLauncherPlatform = process.platform === 'win32' ? 'win32' : 'unix',
): CommandLauncherPick {
  const launcherExtension = platform === 'win32'
    ? /\.(?:bat|cmd|ps1)$/i
    : /\.(?:command|sh)$/i;
  const candidates = fileNames
    .filter(name => launcherExtension.test(name))
    .filter(name => !APP_HELPER_NAME_RE.test(name))
    .sort();
  if (candidates.length === 0) return { fileName: null, reason: 'none' };
  if (candidates.length === 1) return { fileName: candidates[0]!, reason: 'single' };

  const conventional = candidates.filter(name => LAUNCHER_NAME_RE.test(name));
  if (conventional.length === 1) return { fileName: conventional[0]!, reason: 'conventional' };
  return { fileName: null, reason: 'ambiguous' };
}
