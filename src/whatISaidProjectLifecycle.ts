export interface WhatISaidProjectRegistration {
  folderPath?: string;
  worktreePath?: string;
}

export interface WhatISaidProjectRemovalResult {
  ok: boolean;
  folderPath: string | null;
  error?: unknown;
}

export const whatISaidProjectLocalPath = (project: WhatISaidProjectRegistration): string | null => {
  const worktreePath = typeof project.worktreePath === 'string' ? project.worktreePath.trim() : '';
  if (worktreePath) return worktreePath;
  const folderPath = typeof project.folderPath === 'string' ? project.folderPath.trim() : '';
  return folderPath || null;
};

export function whatISaidProjectPathChanged(
  previous: WhatISaidProjectRegistration,
  next: WhatISaidProjectRegistration,
): boolean {
  return whatISaidProjectLocalPath(previous) !== whatISaidProjectLocalPath(next);
}

/**
 * Project registration and external-app feed sharing have separate consent, but a
 * registration deletion is a privacy boundary: an old feed access key must not
 * silently revive if the same memory lineage is registered again later.
 */
export async function revokeWhatISaidBeforeProjectRemoval(
  project: WhatISaidProjectRegistration,
  revoke: (folderPath: string | null) => Promise<unknown>,
): Promise<WhatISaidProjectRemovalResult> {
  const folderPath = whatISaidProjectLocalPath(project);
  try {
    await revoke(folderPath);
    return { ok: true, folderPath };
  } catch (error) {
    return { ok: false, folderPath, error };
  }
}
