import { existsSync, readFileSync } from 'node:fs';
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
  /** Functional source commit accepted by a desktop release-source gate, when present. */
  sourceCommit: string;
  /** True for live-default-HEAD builds, false for an explicit local test override, null otherwise. */
  sourcePublished: boolean | null;
}

export interface CreateBuildInfoOptions {
  root?: string;
  command?: BuildCommand;
  now?: Date;
  /**
   * Desktop bundles must always prove that build-number.json and Tauri agree.
   * The standalone portal upload intentionally excludes src-tauri; it may skip
   * only a missing config, while still rejecting a mismatch whenever present.
   */
  tauriVersionPolicy?: 'required' | 'if-present';
  /** Injectable for tests; defaults to the real build environment. */
  env?: Record<string, string | undefined>;
}

const projectRoot = dirname(fileURLToPath(import.meta.url));

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * The commit this bundle was built from.
 *
 * The desktop release gate sets `AGENTSTOZ_RELEASE_SOURCE_SHA` and stays the
 * authority when present. Vercel builds the portal on its own and never sets
 * it, which left every deployed bundle stamped with an empty commit — so
 * "is the deploy out?" could not be answered from the page. `VERCEL_GIT_COMMIT_SHA`
 * fills exactly that gap and nothing more.
 */
function resolveSourceCommit(env: Record<string, string | undefined>): string {
  for (const candidate of [env.AGENTSTOZ_RELEASE_SOURCE_SHA, env.VERCEL_GIT_COMMIT_SHA]) {
    if (SHA_RE.test(candidate ?? '')) return candidate!;
  }
  return '';
}

/**
 * Produces the same static metadata for the Tauri frontend and the standalone
 * portal. Keeping this at Vite-config time means the packaged app also works
 * offline and Vercel's direct `vite build` command cannot skip the metadata.
 */
export function createBuildInfo({
  root = projectRoot,
  command = 'build',
  now = new Date(),
  tauriVersionPolicy = 'required',
  env = process.env,
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
  if (existsSync(tauriConfigPath)) {
    const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, 'utf8')) as {
      version?: unknown;
    };
    if (tauriConfig.version !== version) {
      throw new Error(
        `Build version mismatch: build-number.json is ${version}, but tauri.conf.json is ${String(tauriConfig.version)}`,
      );
    }
  } else if (tauriVersionPolicy === 'required') {
    throw new Error(`Missing required Tauri version source: ${tauriConfigPath}`);
  }

  if (Number.isNaN(now.getTime())) {
    throw new Error('Invalid build timestamp');
  }

  return {
    buildNumber,
    version,
    builtAt: now.toISOString(),
    mode: command === 'serve' ? 'development' : 'production',
    sourceCommit: resolveSourceCommit(env),
    sourcePublished: env.AGENTSTOZ_RELEASE_SOURCE_STATUS === 'published'
      ? true
      : env.AGENTSTOZ_RELEASE_SOURCE_STATUS === 'unpublished'
        ? false
        : null,
  };
}
