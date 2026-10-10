import { describe, expect, test } from 'bun:test';
import { resolveVerifiedRemoteTargetAuthorities, type RemoteTargetDirectory } from '../src/remoteControlTargetAuthorities';
import type { RemoteControlTaskTargetBinding } from '../src/remoteControlCore';

const binding = (controlId: string, folderPath: string): RemoteControlTaskTargetBinding => ({
  controlId, target: { internalId: controlId, name: controlId, folderPath, kind: 'main', port: null, command: null, status: 'unknown', actions: [] },
});
const directories = new Map<string, RemoteTargetDirectory>([
  ['/valid', { status: 'found', path: '/valid', dev: 1, ino: 10 }],
  ['/ambiguous', { status: 'found', path: '/ambiguous', dev: 1, ino: 20 }],
  ['/unknown', { status: 'unknown' }],
  ['/missing', { status: 'missing' }],
  ['/unlisted', { status: 'found', path: '/unlisted', dev: 1, ino: 30 }],
]);
const directory = (path: string) => directories.get(path) ?? { status: 'missing' as const };
const same = (a: RemoteTargetDirectory & { status: 'found' }, b: RemoteTargetDirectory & { status: 'found' }) => a.path === b.path && a.dev === b.dev && a.ino === b.ino;

describe('remote runtime authority from an incomplete project inventory', () => {
  test('a valid project remains usable beside unavailable and unlisted registrations', () => {
    const result = resolveVerifiedRemoteTargetAuthorities([
      binding('unknown-control', '/unknown'), binding('valid-control', '/valid'),
      binding('missing-control', '/missing'), binding('unlisted-control', '/unlisted'),
    ], [{ targetId: 'valid-runtime', cwd: '/valid' }], directory, same);
    expect(result).toEqual([{ controlId: 'valid-control', runtimeTargetId: 'valid-runtime' }]);
    expect(JSON.stringify(result)).not.toContain('/valid');
  });

  test('ambiguous directories and aliases never gain authority or block an unrelated target', () => {
    const targets = [{ targetId: 'valid-runtime', cwd: '/valid' },
      { targetId: 'ambiguous-one', cwd: '/ambiguous' }, { targetId: 'ambiguous-two', cwd: '/ambiguous' }];
    expect(resolveVerifiedRemoteTargetAuthorities([binding('good', '/valid'), binding('bad', '/ambiguous')], targets, directory, same))
      .toEqual([{ controlId: 'good', runtimeTargetId: 'valid-runtime' }]);
    expect(resolveVerifiedRemoteTargetAuthorities([binding('one', '/valid'), binding('two', '/valid')], targets, directory, same)).toEqual([]);
  });

  test('a changed directory inode does not match an earlier inventory identity', () => {
    let reads = 0;
    expect(resolveVerifiedRemoteTargetAuthorities([binding('good', '/valid')], [{ targetId: 'runtime', cwd: '/valid' }],
      () => ({ status: 'found', path: '/valid', dev: 1, ino: ++reads }), same)).toEqual([]);
  });
});
