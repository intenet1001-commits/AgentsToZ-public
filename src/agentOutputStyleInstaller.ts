import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { withSharedOutputStyle } from './agentOutputStyle';

export type DeviceOutputStyleTarget = 'claude' | 'codex' | 'antigravity' | 'agy' | 'hermes';

/**
 * agy (Antigravity CLI) keeps its global customizations in ~/.gemini/config/; its bundled docs name
 * `rules/` or a standalone `GEMINI.md` there as always-on global rules. ~/.gemini/GEMINI.md is not
 * one of them. The folder is agy's own: when it is absent agy is not installed, and creating it
 * here would make an absent agy look installed.
 */
export function agyGlobalConfigDir(home: string): string | null {
  const path = join(home, '.gemini', 'config');
  try { return statSync(path).isDirectory() ? path : null; } catch { return null; }
}

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
  const agyConfig = agyGlobalConfigDir(input.home);
  if (agyConfig) targets.push(['agy', join(agyConfig, 'GEMINI.md')]);
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
