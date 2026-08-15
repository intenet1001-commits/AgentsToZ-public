import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface RuntimeTemplateHost {
  moduleDir?: string;
  execPath?: string;
  exists?: (path: string) => boolean;
}

/**
 * Resolve templates both from source and from a Bun standalone sidecar.
 *
 * Bun compiled modules report `import.meta.dir` under `/$bunfs/root`; files read
 * dynamically are not embedded there. Packaged Tauri resources therefore live
 * beside the sidecar executable under `templates/<name>`.
 */
export function resolveRuntimeTemplateDir(
  name: string,
  {
    moduleDir = import.meta.dir,
    execPath = process.execPath,
    exists = existsSync,
  }: RuntimeTemplateHost = {},
): string {
  const sourceDir = join(moduleDir, 'templates', name);
  if (exists(sourceDir)) return sourceDir;

  const bundledDir = join(dirname(execPath), 'templates', name);
  if (exists(bundledDir)) return bundledDir;

  return sourceDir;
}
