import type { RemoteControlTaskTargetBinding } from './remoteControlCore';
import type { RemoteControlTaskTargetAuthority } from './remoteControlTaskGateway';

export type RemoteTargetDirectory =
  | { status: 'found'; path: string; dev: number; ino: number }
  | { status: 'missing' | 'unknown' };
type FoundDirectory = RemoteTargetDirectory & { status: 'found' };

/** Omit only unresolved identities; one stale registration cannot block other projects. */
export function resolveVerifiedRemoteTargetAuthorities(
  bindings: readonly RemoteControlTaskTargetBinding[],
  targets: readonly { targetId: string; cwd: string }[],
  directory: (path: string) => RemoteTargetDirectory,
  sameDirectory: (left: FoundDirectory, right: FoundDirectory) => boolean,
): RemoteControlTaskTargetAuthority[] {
  const candidates = targets.map(target => ({ target, directory: directory(target.cwd) }));
  const resolved: RemoteControlTaskTargetAuthority[] = [];
  for (const binding of bindings) {
    const requested = directory(binding.target.worktreePath || binding.target.folderPath || '');
    if (requested.status !== 'found') continue;
    const matches = candidates.filter(candidate => candidate.directory.status === 'found'
      && sameDirectory(requested, candidate.directory));
    if (matches.length !== 1) continue;
    resolved.push({ controlId: binding.controlId, runtimeTargetId: matches[0]!.target.targetId });
  }
  // Never pick an arbitrary winner when multiple remote identities resolve to
  // one runtime target, or when a malformed input repeats a control identity.
  const controls = new Map<string, number>();
  const runtimes = new Map<string, number>();
  for (const item of resolved) {
    controls.set(item.controlId, (controls.get(item.controlId) ?? 0) + 1);
    runtimes.set(item.runtimeTargetId, (runtimes.get(item.runtimeTargetId) ?? 0) + 1);
  }
  return resolved.filter(item => controls.get(item.controlId) === 1 && runtimes.get(item.runtimeTargetId) === 1);
}
