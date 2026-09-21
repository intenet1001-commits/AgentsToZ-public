import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { withSharedOutputStyle } from './agentOutputStyle';

export type DeviceOutputStyleTarget = 'claude' | 'codex' | 'antigravity' | 'hermes';

export interface DeviceOutputStyleInstallResult {
  target: DeviceOutputStyleTarget;
  path: string;
  changed: boolean;
}

/**
 * Install the same machine-wide response contract into each supported agent's
 * official global instruction surface. Hermes is conditional because creating
 * ~/.hermes by itself would make an absent CLI look partially installed.
 */
export function installDeviceSharedOutputStyle(input: {
  home: string;
  hermesHome?: string | null;
}): DeviceOutputStyleInstallResult[] {
  const targets: Array<[DeviceOutputStyleTarget, string]> = [
    ['claude', join(input.home, '.claude', 'CLAUDE.md')],
    ['codex', join(input.home, '.codex', 'AGENTS.md')],
    ['antigravity', join(input.home, '.gemini', 'GEMINI.md')],
  ];
  if (input.hermesHome) targets.push(['hermes', join(input.hermesHome, 'SOUL.md')]);

  return targets.map(([target, path]) => {
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const next = withSharedOutputStyle(existing);
    if (next !== existing) atomicWritePreservingSymlink(path, next);
    return { target, path, changed: next !== existing };
  });
}

function atomicWritePreservingSymlink(path: string, content: string): void {
  const destination = existsSync(path) && lstatSync(path).isSymbolicLink()
    ? realpathSync(path)
    : path;
  mkdirSync(dirname(destination), { recursive: true });
  const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, destination);
  } catch (error) {
    try { unlinkSync(temp); } catch {}
    throw error;
  }
}
