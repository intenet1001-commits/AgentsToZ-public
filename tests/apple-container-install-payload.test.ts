import { describe, expect, test } from 'bun:test';

import {
  APPLE_CONTAINER_INSTALL_PAYLOAD_FILE_COUNT,
  APPLE_CONTAINER_INSTALL_PAYLOAD_MACHO_COUNT,
  APPLE_CONTAINER_INSTALL_PAYLOAD_PROOF_VERSION,
  APPLE_CONTAINER_INSTALL_PAYLOAD_RELEASE,
  APPLE_CONTAINER_INSTALL_PAYLOAD_STATIC_COUNT,
  AppleContainerInstallPayloadError,
  verifyAppleContainerInstallPayload,
  type AppleContainerInstallPayloadDependencies,
  type AppleContainerInstallPayloadFileStat,
  type AppleContainerInstallPayloadFingerprint,
  type AppleContainerMachOSignatureIdentity,
} from '../src/appleContainerInstallPayload';
import { APPLE_CONTAINER_TEAM_IDENTIFIER } from '../src/appleContainerRuntime';

const FILES = new Map<string, Readonly<{ size: number; sha256: string }>>([
  ['/usr/local/bin/container', {
    size: 68_084_304,
    sha256: 'c6f8ef172248f7b8a30fa3e502359bba678bc993991c37b848dbead1914e86b1',
  }],
  ['/usr/local/bin/container-apiserver', {
    size: 62_901_952,
    sha256: 'ace7e2200c4302b7184e29f4063d346305869202c8bda794eaae0613e39f79e2',
  }],
  ['/usr/local/bin/uninstall-container.sh', {
    size: 2_700,
    sha256: '51a840ab040bec9855ac66ad7c27b3b48771f69e779cb6d614895a3185a3dbb9',
  }],
  ['/usr/local/bin/update-container.sh', {
    size: 5_230,
    sha256: 'd7c11bde8814f9ee1b6ecb27067d627cb780cc89c1ed300fc9b755c214be9dd3',
  }],
  ['/usr/local/libexec/container/plugins/container-core-images/bin/container-core-images', {
    size: 62_157_136,
    sha256: '89bd502b4c914a08dbca68350dbf6bad331acc510e9b83245f757a583cc388fc',
  }],
  ['/usr/local/libexec/container/plugins/container-core-images/config.toml', {
    size: 266,
    sha256: '89ebf5415177298d36f4c67c8c03db26fac1377b428f30a5ccf96407d8f63f9d',
  }],
  ['/usr/local/libexec/container/plugins/container-network-vmnet/bin/container-network-vmnet', {
    size: 60_495_488,
    sha256: 'fcc48b3c1f393025df004de378704d69db7d06da9695ec44f291b8b2a65dd8f3',
  }],
  ['/usr/local/libexec/container/plugins/container-network-vmnet/config.toml', {
    size: 198,
    sha256: '7ec0d522dcf9c9bc78b1e0843916bd0a98cfec45ef5b35f04fb8407ecda3db3e',
  }],
  ['/usr/local/libexec/container/plugins/container-runtime-linux/bin/container-runtime-linux', {
    size: 62_586_368,
    sha256: '9528b7c70f5f84a3318ed5616d20bd5247af9672502cae6278f6ea52b2d69369',
  }],
  ['/usr/local/libexec/container/plugins/container-runtime-linux/config.toml', {
    size: 198,
    sha256: 'd609af652f3e0224cb7f0cef315f873081506d010d2d1a8ff33508980e3427a7',
  }],
  ['/usr/local/libexec/container/plugins/k8s/bin/k8s', {
    size: 63_530_128,
    sha256: '80fec989cc35dd43935156cce81d786e5348446e195c7820a538f9b71f5567f5',
  }],
  ['/usr/local/libexec/container/plugins/k8s/config.toml', {
    size: 92,
    sha256: '4b190947dd6fdadb9463b0210d19c25b1d086ddff00a0685027d29e99facab95',
  }],
  ['/usr/local/libexec/container/plugins/k8s/resources/kindnet.yaml', {
    size: 3_057,
    sha256: '9bb5cbeb75c07664b438a6dd3bb8f038e024cdebca3d945c5d02da5f2f2f781a',
  }],
  ['/usr/local/libexec/container/plugins/machine-apiserver/bin/machine-apiserver', {
    size: 62_482_528,
    sha256: '94424e93d4a0f10cfcf6297d7d1d5a302eebc789b1c9449df2250062cb912659',
  }],
  ['/usr/local/libexec/container/plugins/machine-apiserver/config.toml', {
    size: 281,
    sha256: '819edb0d3c20517e8a56e11a9623b3804c6821d3920da3fa66d989f766103b6a',
  }],
  ['/usr/local/libexec/container/plugins/machine-apiserver/resources/create-user.sh', {
    size: 1_794,
    sha256: 'bdbb3ceef02861b2b270ac403aa32320db6f23a0042dfde24c6a1275eca82f7b',
  }],
  ['/usr/local/libexec/container/plugins/machine-apiserver/resources/init', {
    size: 2_736,
    sha256: '77a7f83faca9f8656ef129d8f91ddc4e770c80478d07b805a2530b9a902bf15a',
  }],
]);

const SIGNATURES = new Map<string, string>([
  ['/usr/local/bin/container', 'com.apple.container.cli'],
  ['/usr/local/bin/container-apiserver', 'com.apple.container.apiserver'],
  [
    '/usr/local/libexec/container/plugins/container-core-images/bin/container-core-images',
    'com.apple.container.container-core-images',
  ],
  [
    '/usr/local/libexec/container/plugins/container-network-vmnet/bin/container-network-vmnet',
    'com.apple.container.container-network-vmnet',
  ],
  [
    '/usr/local/libexec/container/plugins/container-runtime-linux/bin/container-runtime-linux',
    'com.apple.container.container-runtime-linux',
  ],
  ['/usr/local/libexec/container/plugins/k8s/bin/k8s', 'com.apple.container.k8s'],
  [
    '/usr/local/libexec/container/plugins/machine-apiserver/bin/machine-apiserver',
    'com.apple.container.machine-apiserver',
  ],
]);

const DIRECTORIES = new Map<string, readonly string[]>([
  ['/usr/local/libexec/container', ['plugins']],
  ['/usr/local/libexec/container/plugins', [
    'container-core-images',
    'container-network-vmnet',
    'container-runtime-linux',
    'k8s',
    'machine-apiserver',
  ]],
  ['/usr/local/libexec/container/plugins/container-core-images', ['bin', 'config.toml']],
  ['/usr/local/libexec/container/plugins/container-core-images/bin', ['container-core-images']],
  ['/usr/local/libexec/container/plugins/container-network-vmnet', ['bin', 'config.toml']],
  ['/usr/local/libexec/container/plugins/container-network-vmnet/bin', ['container-network-vmnet']],
  ['/usr/local/libexec/container/plugins/container-runtime-linux', ['bin', 'config.toml']],
  ['/usr/local/libexec/container/plugins/container-runtime-linux/bin', ['container-runtime-linux']],
  ['/usr/local/libexec/container/plugins/k8s', ['bin', 'config.toml', 'resources']],
  ['/usr/local/libexec/container/plugins/k8s/bin', ['k8s']],
  ['/usr/local/libexec/container/plugins/k8s/resources', ['kindnet.yaml']],
  ['/usr/local/libexec/container/plugins/machine-apiserver', ['bin', 'config.toml', 'resources']],
  ['/usr/local/libexec/container/plugins/machine-apiserver/bin', ['machine-apiserver']],
  ['/usr/local/libexec/container/plugins/machine-apiserver/resources', ['create-user.sh', 'init']],
]);

interface StatOverride {
  readonly type?: 'file' | 'directory' | 'symlink';
  readonly size?: number;
  readonly mode?: number;
  readonly uid?: number;
  readonly gid?: number;
  readonly nlink?: number;
  readonly mtimeNs?: number;
}

class FakePayloadHost implements AppleContainerInstallPayloadDependencies {
  readonly hashes: string[] = [];
  readonly signatures: string[] = [];
  readonly directoryReads: string[] = [];
  readonly lstatCalls = new Map<string, number>();
  readonly statOverrides = new Map<string, StatOverride>();
  readonly canonicalOverrides = new Map<string, string>();
  readonly hashOverrides = new Map<string, string>();
  readonly signatureOverrides = new Map<string, AppleContainerMachOSignatureIdentity>();
  readonly directoryOverrides = new Map<string, readonly string[]>();
  readonly missingPaths = new Set<string>();
  readonly mtime = new Map<string, number>();
  mutateAfterHashPath: string | null = null;
  #nextInode = 100;
  readonly #inodes = new Map<string, number>();

  #inode(path: string): number {
    let value = this.#inodes.get(path);
    if (value === undefined) {
      value = this.#nextInode++;
      this.#inodes.set(path, value);
    }
    return value;
  }

  async lstat(path: string): Promise<AppleContainerInstallPayloadFileStat> {
    this.lstatCalls.set(path, (this.lstatCalls.get(path) ?? 0) + 1);
    if (this.missingPaths.has(path)) {
      throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
    }
    const artifact = FILES.get(path);
    const override = this.statOverrides.get(path);
    const type = override?.type ?? (artifact === undefined ? 'directory' : 'file');
    const isFile = type === 'file';
    const isDirectory = type === 'directory';
    return {
      isFile: () => isFile,
      isDirectory: () => isDirectory,
      isSymbolicLink: () => type === 'symlink',
      dev: 1,
      ino: this.#inode(path),
      size: override?.size ?? artifact?.size ?? 0,
      mode: override?.mode ?? (isFile ? 0o100755 : 0o040755),
      uid: override?.uid ?? 0,
      gid: override?.gid ?? 0,
      nlink: override?.nlink ?? (isFile ? 1 : 2),
      mtimeNs: override?.mtimeNs ?? this.mtime.get(path) ?? 1,
      ctimeNs: 1,
    };
  }

  async realpath(path: string): Promise<string> {
    return this.canonicalOverrides.get(path) ?? path;
  }

  async sha256File(
    path: string,
    expected: AppleContainerInstallPayloadFingerprint,
  ): Promise<string> {
    expect(expected.ino).toBe(String(this.#inode(path)));
    this.hashes.push(path);
    if (this.mutateAfterHashPath === path) this.mtime.set(path, 2);
    return this.hashOverrides.get(path) ?? FILES.get(path)?.sha256 ?? '';
  }

  async readDirectory(
    path: string,
    expected: AppleContainerInstallPayloadFingerprint,
  ): Promise<readonly string[]> {
    expect(expected.ino).toBe(String(this.#inode(path)));
    this.directoryReads.push(path);
    return this.directoryOverrides.get(path) ?? DIRECTORIES.get(path) ?? [];
  }

  async verifyMachOSignature(
    path: string,
    expectedFile: AppleContainerInstallPayloadFingerprint,
    expectedIdentity: Readonly<{ teamIdentifier: 'UPBK2H6LZM'; signingIdentifier: string }>,
  ): Promise<AppleContainerMachOSignatureIdentity> {
    expect(expectedFile.ino).toBe(String(this.#inode(path)));
    const knownSigningIdentifier = SIGNATURES.get(path);
    if (knownSigningIdentifier === undefined) throw new Error('unknown signature fixture');
    expect(expectedIdentity).toEqual({
      teamIdentifier: APPLE_CONTAINER_TEAM_IDENTIFIER,
      signingIdentifier: knownSigningIdentifier,
    });
    this.signatures.push(path);
    return this.signatureOverrides.get(path) ?? {
      valid: true,
      teamIdentifier: APPLE_CONTAINER_TEAM_IDENTIFIER,
      signingIdentifier: knownSigningIdentifier,
    };
  }
}

async function expectPayloadError(
  operation: Promise<unknown>,
  code: 'APPLE_CONTAINER_INSTALL_PAYLOAD_PLATFORM_UNSUPPORTED'
    | 'APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED' =
      'APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED',
  privateValues: readonly string[] = [],
): Promise<void> {
  try {
    await operation;
    throw new Error(`expected ${code}`);
  } catch (cause) {
    expect(cause).toBeInstanceOf(AppleContainerInstallPayloadError);
    expect((cause as AppleContainerInstallPayloadError).code).toBe(code);
    expect(String(cause)).toBe(`AppleContainerInstallPayloadError: ${code}`);
    for (const value of privateValues) expect(String(cause)).not.toContain(value);
  }
}

describe('Apple Container complete install payload identity', () => {
  test('verifies all signed-package files, all Mach-O identities, and the closed plugin tree', async () => {
    const host = new FakePayloadHost();
    const proof = await verifyAppleContainerInstallPayload(
      { platform: 'darwin', arch: 'arm64' },
      host,
    );

    expect(proof).toEqual({
      version: APPLE_CONTAINER_INSTALL_PAYLOAD_PROOF_VERSION,
      kind: 'apple-container-install-payload',
      release: APPLE_CONTAINER_INSTALL_PAYLOAD_RELEASE,
      scope: 'identity-only',
      result: 'verified',
      ready: false,
    });
    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.keys(proof).sort()).toEqual([
      'kind', 'ready', 'release', 'result', 'scope', 'version',
    ]);
    expect(APPLE_CONTAINER_INSTALL_PAYLOAD_FILE_COUNT).toBe(17);
    expect(APPLE_CONTAINER_INSTALL_PAYLOAD_MACHO_COUNT).toBe(7);
    expect(APPLE_CONTAINER_INSTALL_PAYLOAD_STATIC_COUNT).toBe(10);
    expect(host.hashes).toHaveLength(FILES.size);
    expect(new Set(host.hashes)).toEqual(new Set(FILES.keys()));
    expect(host.signatures).toHaveLength(SIGNATURES.size);
    expect(new Set(host.signatures)).toEqual(new Set(SIGNATURES.keys()));
    expect(host.directoryReads).toHaveLength(DIRECTORIES.size * 2);
    expect(new Set(host.directoryReads)).toEqual(new Set(DIRECTORIES.keys()));

    const serialized = JSON.stringify(proof);
    expect(serialized).not.toContain('/usr/local');
    expect(serialized).not.toContain('sha256');
    expect(serialized).not.toContain(APPLE_CONTAINER_TEAM_IDENTIFIER);
    expect(serialized).not.toContain('com.apple.container.cli');
    for (const file of FILES.values()) expect(serialized).not.toContain(file.sha256);
  });

  test('fails closed for path, ownership, permission, type, hardlink, and race violations', async () => {
    const target = '/usr/local/bin/container';
    const ancestor = '/usr/local/libexec';
    const cases: Array<(host: FakePayloadHost) => void> = [
      host => { host.missingPaths.add(target); },
      host => { host.statOverrides.set(target, { type: 'symlink' }); },
      host => { host.statOverrides.set(ancestor, { type: 'symlink' }); },
      host => { host.statOverrides.set(target, { nlink: 2 }); },
      host => { host.statOverrides.set(target, { uid: 501 }); },
      host => { host.statOverrides.set(target, { gid: 20 }); },
      host => { host.statOverrides.set(ancestor, { mode: 0o040775 }); },
      host => { host.statOverrides.set(target, { size: FILES.get(target)!.size + 1 }); },
      host => { host.statOverrides.set(target, { mode: 0o100644 }); },
      host => { host.canonicalOverrides.set(ancestor, '/private/replaced-libexec'); },
      host => { host.mutateAfterHashPath = target; },
    ];

    for (const mutate of cases) {
      const host = new FakePayloadHost();
      mutate(host);
      await expectPayloadError(
        verifyAppleContainerInstallPayload({ platform: 'darwin', arch: 'arm64' }, host),
        'APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED',
        [target, ancestor, FILES.get(target)!.sha256],
      );
    }
  });

  test('rejects any wrong payload hash or Mach-O signature identity', async () => {
    const target = '/usr/local/libexec/container/plugins/k8s/bin/k8s';
    const cases: Array<(host: FakePayloadHost) => void> = [
      host => { host.hashOverrides.set(target, '0'.repeat(64)); },
      host => {
        host.signatureOverrides.set(target, {
          valid: false,
          teamIdentifier: APPLE_CONTAINER_TEAM_IDENTIFIER,
          signingIdentifier: SIGNATURES.get(target)!,
        });
      },
      host => {
        host.signatureOverrides.set(target, {
          valid: true,
          teamIdentifier: 'ATTACKERTEAM',
          signingIdentifier: SIGNATURES.get(target)!,
        });
      },
      host => {
        host.signatureOverrides.set(target, {
          valid: true,
          teamIdentifier: APPLE_CONTAINER_TEAM_IDENTIFIER,
          signingIdentifier: 'com.attacker.plugin',
        });
      },
    ];

    for (const mutate of cases) {
      const host = new FakePayloadHost();
      mutate(host);
      await expectPayloadError(
        verifyAppleContainerInstallPayload({ platform: 'darwin', arch: 'arm64' }, host),
        'APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED',
        [target, SIGNATURES.get(target)!, FILES.get(target)!.sha256],
      );
    }
  });

  test('rejects extra, missing, duplicate, traversal, or malformed plugin inventory entries', async () => {
    const pluginRoot = '/usr/local/libexec/container/plugins';
    const expected = DIRECTORIES.get(pluginRoot)!;
    const cases: readonly (readonly string[])[] = [
      [...expected, 'attacker-plugin'],
      expected.slice(1),
      [...expected, expected[0]!],
      [...expected.slice(1), '..'],
      [...expected.slice(1), 'nested/plugin'],
      [...expected.slice(1), `bad\0entry`],
    ];
    for (const entries of cases) {
      const host = new FakePayloadHost();
      host.directoryOverrides.set(pluginRoot, entries);
      await expectPayloadError(
        verifyAppleContainerInstallPayload({ platform: 'darwin', arch: 'arm64' }, host),
        'APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED',
        [pluginRoot, 'attacker-plugin'],
      );
    }
  });

  test('rejects unsupported hosts before reading any install path', async () => {
    for (const options of [
      { platform: 'linux' as const, arch: 'arm64' as const },
      { platform: 'darwin' as const, arch: 'x64' as const },
    ]) {
      const host = new FakePayloadHost();
      await expectPayloadError(
        verifyAppleContainerInstallPayload(options, host),
        'APPLE_CONTAINER_INSTALL_PAYLOAD_PLATFORM_UNSUPPORTED',
      );
      expect(host.lstatCalls.size).toBe(0);
      expect(host.hashes).toHaveLength(0);
      expect(host.signatures).toHaveLength(0);
    }
  });
});
