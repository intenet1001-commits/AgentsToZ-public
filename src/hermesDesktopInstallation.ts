import { join } from 'node:path';

/**
 * Known Hermes Desktop executable locations. Hermes' own installer keeps the
 * app under ~/.hermes rather than /Applications, so it must remain discoverable
 * after the app exits and no running process can reveal its executable path.
 */
export function hermesDesktopExecutableCandidates(
  homeDirectory: string,
  platform: NodeJS.Platform,
  architecture: string,
): string[] {
  if (platform !== 'darwin') return [];
  const candidates = [
    '/Applications/Hermes.app/Contents/MacOS/Hermes',
    join(homeDirectory, 'Applications', 'Hermes.app', 'Contents', 'MacOS', 'Hermes'),
  ];
  const managedRelease = architecture === 'arm64'
    ? 'mac-arm64'
    : architecture === 'x64'
      ? 'mac-x64'
      : null;
  if (managedRelease) {
    candidates.push(join(
      homeDirectory,
      '.hermes',
      'hermes-agent',
      'apps',
      'desktop',
      'release',
      managedRelease,
      'Hermes.app',
      'Contents',
      'MacOS',
      'Hermes',
    ));
  }
  return candidates;
}

/**
 * Match the complete Electron user-data argument. A plain substring check can
 * confuse two project keys when one happens to prefix the other, causing an
 * unrelated Hermes window to be accepted as the launch receiver.
 */
export function hermesDesktopCommandUsesUserDataDir(
  command: string,
  userDataDirectory: string,
): boolean {
  const escaped = userDataDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:^|\\s)--user-data-dir(?:=|\\s+)(?:"${escaped}"|'${escaped}'|${escaped})(?=\\s|$)`,
  ).test(command);
}
