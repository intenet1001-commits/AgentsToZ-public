import { win32 } from 'node:path';

export interface WindowsHermesExecutableCandidateInput {
  localAppData?: string | null;
  hermesHome?: string | null;
}

/**
 * Executable locations guaranteed by Hermes' official Windows installer.
 * Current installers expose `<HERMES_HOME>/hermes-agent/bin/hermes.exe` and
 * older releases used `venv/Scripts/hermes.exe`. A running AgentsToZ process
 * may predate either PATH update, so both persisted layouts are probed.
 */
export function windowsHermesExecutableCandidates(
  input: WindowsHermesExecutableCandidateInput,
): string[] {
  const roots = [
    input.hermesHome?.trim(),
    input.localAppData?.trim()
      ? win32.join(input.localAppData.trim(), 'hermes')
      : null,
  ].filter((value): value is string => !!value);
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const root of roots) {
    for (const parts of [
      ['hermes-agent', 'bin', 'hermes.exe'],
      ['hermes-agent', 'venv', 'Scripts', 'hermes.exe'],
    ]) {
      const candidate = win32.join(root, ...parts);
      const key = candidate.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }
  }
  return candidates;
}
