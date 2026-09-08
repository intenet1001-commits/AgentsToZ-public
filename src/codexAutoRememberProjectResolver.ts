import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { CodexAutoRememberProject, CodexAutoRememberProjectResolver } from './codexAutoRememberCoordinator';
import {
  createRegisteredProjectMemoryResolver,
  type RegisteredProjectMemoryCandidate,
} from './projectMemoryProjectResolver';

interface MemoryIdentity {
  exists: boolean;
  projectRoot: string;
  config: { memoryId: string } | null;
}

export interface AutoRememberProjectResolverDependencies {
  readRegistered(): Promise<readonly RegisteredProjectMemoryCandidate[]>;
  detectIdentity(path: string): Promise<MemoryIdentity>;
}

async function canonicalDirectory(path: unknown): Promise<string | null> {
  if (typeof path !== 'string' || !isAbsolute(path.trim())) return null;
  try {
    const canonical = await realpath(path.trim());
    if (!(await stat(canonical)).isDirectory()) return null;
    // Match the shared registered-project resolver's macOS path convention.
    return process.platform === 'darwin' && canonical.startsWith('/private/')
      ? canonical.slice('/private'.length) : canonical;
  } catch {
    return null;
  }
}

async function readRegistrationSnapshot(deps: AutoRememberProjectResolverDependencies) {
  // Copy only identity fields; do not retain commands, environment or UI state.
  const rows = (await deps.readRegistered()).map(row => ({
    id: row.id, name: row.name, folderPath: row.folderPath,
    worktreePath: row.worktreePath, worktreeParentId: row.worktreeParentId,
  }));
  const aliases = await Promise.all(rows.map(async row => [
    await canonicalDirectory(row.folderPath), await canonicalDirectory(row.worktreePath),
  ]));
  return {
    rows,
    paths: [...new Set(aliases.flat().filter((path): path is string => path !== null))],
    // Include both raw paths and their live symlink destinations. A changed
    // registration invalidates this tick, rather than granting stale authority.
    signature: JSON.stringify([rows, aliases]),
  };
}

/**
 * One tick's identity-only discovery. No document/activity reads and no cache
 * survive the tick. Child git processes are asynchronous and limited to four.
 * Returned projects must be revalidated inside the workspace lease before save.
 */
export async function prepareAutoRememberProjectResolver(
  deps: AutoRememberProjectResolverDependencies,
): Promise<CodexAutoRememberProjectResolver> {
  const snapshot = await readRegistrationSnapshot(deps);
  const identities = new Map<string, MemoryIdentity | null>();
  const detect = async (path: string): Promise<MemoryIdentity | null> => {
    try {
      const identity = await deps.detectIdentity(path);
      const root = await canonicalDirectory(identity.projectRoot);
      return root ? { ...identity, projectRoot: root } : null;
    } catch {
      // An unreadable git family is not a standalone initialized project.
      return null;
    }
  };
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, snapshot.paths.length) }, async () => {
    while (cursor < snapshot.paths.length) {
      const path = snapshot.paths[cursor++]!;
      identities.set(path, await detect(path));
    }
  }));
  const isCurrent = async () => (await readRegistrationSnapshot(deps)).signature === snapshot.signature;
  if (!await isCurrent()) return async () => null;
  const memoryRoot = (alias: string) => {
    const identity = identities.get(alias);
    return identity?.exists && identity.config?.memoryId ? identity.projectRoot : null;
  };
  const resolveRegistered = createRegisteredProjectMemoryResolver(snapshot.rows, memoryRoot, { requireInitialized: true });

  return async observation => {
    const cwd = await canonicalDirectory(observation.cwd);
    if (!cwd) return null;
    // Unpersisted linked worktrees still use the shared resolver's Git-family
    // proof. Resolve their identity once, rather than treating any child as safe.
    if (!identities.has(cwd)) identities.set(cwd, await detect(cwd));
    if (!await isCurrent()) return null;
    const identity = identities.get(cwd);
    if (!identity?.exists || !identity.config?.memoryId) return null;
    const resolution = resolveRegistered(cwd);
    if (!resolution.ok || resolution.canonicalPath !== identity.projectRoot) return null;
    const memoryId = identity.config.memoryId;
    const project: CodexAutoRememberProject = {
      projectId: resolution.id,
      projectName: resolution.name,
      projectRoot: resolution.canonicalPath,
      memoryId,
      validateRegistration: async () => {
        // Called under the save lease: rebuild all alias/lineage evidence fresh,
        // so relinking a different row cannot create a hidden ambiguous family.
        if (!await isCurrent()) return false;
        const freshResolver = await prepareAutoRememberProjectResolver(deps);
        const current = await freshResolver(observation);
        return current !== null && current.projectId === project.projectId
          && current.projectRoot === project.projectRoot && current.memoryId === memoryId;
      },
    };
    return project;
  };
}
