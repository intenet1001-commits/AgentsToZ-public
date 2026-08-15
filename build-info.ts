import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type BuildCommand = 'build' | 'serve';
export type BuildMode = 'production' | 'development';

export interface BuildInfo {
  buildNumber: number;
  version: string;
  /** ISO-8601 UTC timestamp recorded when Vite starts building this bundle. */
  builtAt: string;
  mode: BuildMode;
}

export interface CreateBuildInfoOptions {
  root?: string;
  command?: BuildCommand;
  now?: Date;
}

const projectRoot = dirname(fileURLToPath(import.meta.url));

/**
 * Produces the same static metadata for the Tauri frontend and the standalone
 * portal. Keeping this at Vite-config time means the packaged app also works
 * offline and Vercel's direct `vite build` command cannot skip the metadata.
 */
export function createBuildInfo({
  root = projectRoot,
  command = 'build',
  now = new Date(),
}: CreateBuildInfoOptions = {}): BuildInfo {
  const buildNumberPath = join(root, 'build-number.json');
  const tauriConfigPath = join(root, 'src-tauri', 'tauri.conf.json');
  const { buildNumber } = JSON.parse(readFileSync(buildNumberPath, 'utf8')) as {
    buildNumber?: unknown;
  };

  if (typeof buildNumber !== 'number' || !Number.isInteger(buildNumber) || buildNumber < 0) {
    throw new Error(`Invalid buildNumber in ${buildNumberPath}`);
  }

  const version = `${buildNumber}.0.0`;
  const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, 'utf8')) as {
    version?: unknown;
  };
  if (tauriConfig.version !== version) {
    throw new Error(
      `Build version mismatch: build-number.json is ${version}, but tauri.conf.json is ${String(tauriConfig.version)}`,
    );
  }

  if (Number.isNaN(now.getTime())) {
    throw new Error('Invalid build timestamp');
  }

  return {
    buildNumber,
    version,
    builtAt: now.toISOString(),
    mode: command === 'serve' ? 'development' : 'production',
  };
}
