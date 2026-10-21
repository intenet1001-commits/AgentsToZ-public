import { describe, expect, test } from 'bun:test';

import {
  APPLE_CONTAINER_API_SERVER_PATH,
  APPLE_CONTAINER_CLI_PATH,
  APPLE_CONTAINER_CODESIGN_PATH,
  APPLE_CONTAINER_PROBE_MAX_OUTPUT_BYTES,
  APPLE_CONTAINER_RUNTIME_APP_ROOT,
  APPLE_CONTAINER_RUNTIME_INSTALL_ROOT,
  APPLE_CONTAINER_RUNTIME_LOG_ROOT,
  APPLE_CONTAINER_RUNTIME_RELEASE_ROOT,
  APPLE_CONTAINER_SW_VERS_PATH,
  APPLE_CONTAINER_TEAM_IDENTIFIER,
  APPLE_CONTAINER_TESTED_RELEASES,
  probeAppleContainerRuntimeDependencyCapability,
  type AppleContainerCommandResult,
  type AppleContainerRuntimeFileFingerprint,
  type AppleContainerRuntimeFileStat,
  type AppleContainerRuntimeProbeDependencies,
  type AppleContainerRuntimeProbeOptions,
} from '../src/appleContainerRuntime';

const CLI_COMMIT = 'a9a62e28f6beb88940122a3d7b286f2d5ae8053a';
const SERVER_COMMIT = CLI_COMMIT;

function versionOutput(overrides: {
  cliVersion?: string;
  cliCommit?: string;
  serverVersion?: string;
  serverBuild?: string;
  serverCommit?: string;
  includeServer?: boolean;
  extraCli?: Record<string, unknown>;
} = {}): string {
  const serverVersion = overrides.serverVersion ?? '1.3.1';
  const serverBuild = overrides.serverBuild ?? 'release';
  const serverCommit = overrides.serverCommit ?? SERVER_COMMIT;
  return JSON.stringify([
    {
      appName: 'container',
      buildType: 'release',
      commit: overrides.cliCommit ?? CLI_COMMIT,
      version: overrides.cliVersion ?? '1.3.1',
      ...overrides.extraCli,
    },
    ...(overrides.includeServer === false ? [] : [{
      appName: 'container-apiserver',
      buildType: serverBuild,
      commit: serverCommit,
      version: `container-apiserver version ${serverVersion} (build: ${serverBuild}, commit: ${serverCommit.slice(0, 7)})`,
    }]),
  ]);
}

function statusOutput(overrides: {
  status?: string;
  appRoot?: string;
  installRoot?: string;
  apiVersion?: string;
  apiBuild?: string;
  apiCommit?: string;
  logRoot?: string | null;
  extra?: Record<string, unknown>;
} = {}): string {
  const apiVersion = overrides.apiVersion ?? '1.3.1';
  const apiBuild = overrides.apiBuild ?? 'release';
  const apiCommit = overrides.apiCommit ?? SERVER_COMMIT;
  return JSON.stringify({
    status: overrides.status ?? 'running',
    appRoot: overrides.appRoot ?? APPLE_CONTAINER_RUNTIME_APP_ROOT,
    installRoot: overrides.installRoot ?? APPLE_CONTAINER_RUNTIME_INSTALL_ROOT,
    ...(overrides.logRoot === null
      ? {}
      : { logRoot: overrides.logRoot ?? APPLE_CONTAINER_RUNTIME_LOG_ROOT }),
    apiServerVersion: `container-apiserver version ${apiVersion} (build: ${apiBuild}, commit: ${apiCommit.slice(0, 7)})`,
    apiServerCommit: apiCommit,
    apiServerBuild: apiBuild,
    apiServerAppName: 'container-apiserver',
    ...overrides.extra,
  });
}

interface FakeStatShape {
  kind: 'file' | 'directory' | 'symlink';
  dev: bigint;
  ino: bigint;
  size: bigint;
  mode: bigint;
  uid: bigint;
  nlink: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

function fakeStat(shape: FakeStatShape): AppleContainerRuntimeFileStat {
  return {
    isFile: () => shape.kind === 'file',
    isDirectory: () => shape.kind === 'directory',
    isSymbolicLink: () => shape.kind === 'symlink',
    dev: shape.dev,
    ino: shape.ino,
    size: shape.size,
    mode: shape.mode,
    uid: shape.uid,
    nlink: shape.nlink,
    mtimeNs: shape.mtimeNs,
    ctimeNs: shape.ctimeNs,
  };
}

function copyShape(shape: FakeStatShape, overrides: Partial<FakeStatShape> = {}): FakeStatShape {
  return { ...shape, ...overrides };
}

interface FakeCall {
  executable: string;
  args: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
  env: Readonly<Record<string, string>>;
}

class FakeAppleContainerHost implements AppleContainerRuntimeProbeDependencies {
  readonly files = new Map<string, FakeStatShape>();
  readonly canonical = new Map<string, string>();
  readonly hashes = new Map<string, string>();
  readonly calls: FakeCall[] = [];
  versionResult: AppleContainerCommandResult = success(versionOutput());
  statusResult: AppleContainerCommandResult = success(statusOutput());
  codesignResult: AppleContainerCommandResult = success('');
  macOSVersionResult: AppleContainerCommandResult = success('26.0\n');
  mutateAfterStatus = false;

  constructor() {
    this.addDirectory('/', 1n);
    this.addDirectory('/usr', 2n);
    this.addDirectory('/usr/local', 3n);
    this.addDirectory('/usr/local/bin', 4n);
    this.addFile(APPLE_CONTAINER_CLI_PATH, 5n);
    this.addFile(APPLE_CONTAINER_API_SERVER_PATH, 6n);
    this.hashes.set(
      APPLE_CONTAINER_CLI_PATH,
      APPLE_CONTAINER_TESTED_RELEASES[0]!.cli.sha256,
    );
    this.hashes.set(
      APPLE_CONTAINER_API_SERVER_PATH,
      APPLE_CONTAINER_TESTED_RELEASES[0]!.apiServer.sha256,
    );
  }

  addDirectory(path: string, ino: bigint): void {
    this.files.set(path, {
      kind: 'directory',
      dev: 1n,
      ino,
      size: 256n,
      mode: 0o040755n,
      uid: 0n,
      nlink: 2n,
      mtimeNs: 1_000_000_000n,
      ctimeNs: 1_000_000_001n,
    });
    this.canonical.set(path, path);
  }

  addFile(path: string, ino: bigint): void {
    this.files.set(path, {
      kind: 'file',
      dev: 1n,
      ino,
      size: 20_000_000n,
      mode: 0o100755n,
      uid: 0n,
      nlink: 1n,
      mtimeNs: 1_000_000_000n,
      ctimeNs: 1_000_000_001n,
    });
    this.canonical.set(path, path);
  }

  async lstat(path: string): Promise<AppleContainerRuntimeFileStat> {
    const shape = this.files.get(path);
    if (!shape) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return fakeStat(shape);
  }

  async realpath(path: string): Promise<string> {
    const canonical = this.canonical.get(path);
    if (!canonical) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return canonical;
  }

  async sha256File(
    path: string,
    _expected: AppleContainerRuntimeFileFingerprint,
  ): Promise<string> {
    const hash = this.hashes.get(path);
    if (!hash) throw new Error('hash unavailable');
    return hash;
  }

  async run(
    executable: string,
    args: readonly string[],
    options: {
      timeoutMs: number;
      maxOutputBytes: number;
      env: Readonly<Record<string, string>>;
    },
  ): Promise<AppleContainerCommandResult> {
    this.calls.push({ executable, args: [...args], ...options });
    if (executable === APPLE_CONTAINER_SW_VERS_PATH
      && args.join(' ') === '-productVersion') return this.macOSVersionResult;
    if (executable === APPLE_CONTAINER_CODESIGN_PATH) return this.codesignResult;
    if (executable === APPLE_CONTAINER_CLI_PATH
      && args.join(' ') === 'system version --format json') return this.versionResult;
    if (executable === APPLE_CONTAINER_CLI_PATH
      && args.join(' ') === 'system status --format json') {
      if (this.mutateAfterStatus) {
        const current = this.files.get(APPLE_CONTAINER_CLI_PATH)!;
        this.files.set(APPLE_CONTAINER_CLI_PATH, copyShape(current, {
          ino: current.ino + 100n,
          ctimeNs: current.ctimeNs + 1n,
        }));
      }
      return this.statusResult;
    }
    return failure(127, 'unexpected command');
  }
}

function success(stdout: string): AppleContainerCommandResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false, outputTruncated: false };
}

function failure(exitCode: number | null, stderr = ''): AppleContainerCommandResult {
  return { exitCode, stdout: '', stderr, timedOut: false, outputTruncated: false };
}

const SUPPORTED_HOST = Object.freeze({
  platform: 'darwin' as const,
  arch: 'arm64' as const,
  macOSVersion: '26.0.1',
});

async function probe(
  host: FakeAppleContainerHost,
  options: AppleContainerRuntimeProbeOptions = SUPPORTED_HOST,
) {
  return probeAppleContainerRuntimeDependencyCapability(options, host);
}

describe('Apple Container runtime dependency capability probe', () => {
  test('requires escape E2E after exact signed release and compatible service checks', async () => {
    const host = new FakeAppleContainerHost();
    const capability = await probe(host);

    expect(capability).toEqual({
      schemaVersion: 1,
      kind: 'apple-container-vm',
      ready: false,
      reason: 'self-test-required',
    });
    expect(Object.keys(capability).sort()).toEqual(['kind', 'ready', 'reason', 'schemaVersion']);
    expect(JSON.stringify(capability)).not.toContain('/usr/local');
    expect(JSON.stringify(capability)).not.toContain('commit');

    const containerCalls = host.calls.filter(call => call.executable === APPLE_CONTAINER_CLI_PATH);
    expect(containerCalls.map(call => call.args)).toEqual([
      ['system', 'version', '--format', 'json'],
      ['system', 'status', '--format', 'json'],
    ]);
    expect(containerCalls.every(call => call.maxOutputBytes === APPLE_CONTAINER_PROBE_MAX_OUTPUT_BYTES))
      .toBe(true);
    expect(containerCalls.every(call => call.env.CONTAINER_DEBUG === undefined)).toBe(true);
    expect(containerCalls.every(call => Object.keys(call.env).sort().join(',')
      === 'LANG,LC_ALL,PATH')).toBe(true);

    const signatureCalls = host.calls.filter(call => call.executable === APPLE_CONTAINER_CODESIGN_PATH);
    expect(signatureCalls).toHaveLength(2);
    expect(signatureCalls[0]?.args).toEqual([
      '--verify',
      '--strict',
      '-R',
      `=anchor apple generic and certificate leaf[subject.OU] = "${APPLE_CONTAINER_TEAM_IDENTIFIER}" and identifier "com.apple.container.cli"`,
      APPLE_CONTAINER_CLI_PATH,
    ]);
    expect(signatureCalls[1]?.args.at(-1)).toBe(APPLE_CONTAINER_API_SERVER_PATH);

    expect(APPLE_CONTAINER_RUNTIME_RELEASE_ROOT).toBe(
      '/Library/Application Support/com.intenet.agentstozbycs/agent-runtime/apple-container/1.3.1',
    );
  });

  test('reads the host product version through an exact bounded argv call when it is not injected', async () => {
    const host = new FakeAppleContainerHost();
    const capability = await probeAppleContainerRuntimeDependencyCapability({
      platform: 'darwin',
      arch: 'arm64',
    }, host);

    expect(capability).toMatchObject({ ready: false, reason: 'self-test-required' });
    expect(host.calls[0]).toMatchObject({
      executable: APPLE_CONTAINER_SW_VERS_PATH,
      args: ['-productVersion'],
      maxOutputBytes: APPLE_CONTAINER_PROBE_MAX_OUTPUT_BYTES,
    });

    const failed = new FakeAppleContainerHost();
    failed.macOSVersionResult = { ...failure(1, 'private host detail'), stdout: '' };
    expect(await probeAppleContainerRuntimeDependencyCapability({
      platform: 'darwin',
      arch: 'arm64',
    }, failed)).toMatchObject({ ready: false, reason: 'host-degraded' });
  });

  test('rejects non-macOS, non-arm64, old macOS, and malformed host versions before file inspection', async () => {
    for (const options of [
      { platform: 'linux' as const, arch: 'arm64' as const, macOSVersion: '26.0.1' },
      { platform: 'darwin' as const, arch: 'x64' as const, macOSVersion: '26.0.1' },
      { platform: 'darwin' as const, arch: 'arm64' as const, macOSVersion: '15.7.1' },
    ]) {
      const host = new FakeAppleContainerHost();
      expect(await probe(host, options)).toMatchObject({
        kind: null,
        ready: false,
        reason: 'platform-unsupported',
      });
      expect(host.calls).toHaveLength(0);
    }

    const malformed = new FakeAppleContainerHost();
    expect(await probe(malformed, {
      platform: 'darwin',
      arch: 'arm64',
      macOSVersion: '26.0 beta',
    })).toMatchObject({ ready: false, reason: 'host-degraded' });
    expect(malformed.calls).toHaveLength(0);
  });

  test('uses only the two exact /usr/local release paths and fails when either is absent', async () => {
    const missingCli = new FakeAppleContainerHost();
    missingCli.files.delete(APPLE_CONTAINER_CLI_PATH);
    missingCli.canonical.delete(APPLE_CONTAINER_CLI_PATH);
    // An unrelated PATH-like binary must never become a fallback candidate.
    missingCli.addFile('/opt/homebrew/bin/container', 99n);
    expect(await probe(missingCli)).toMatchObject({
      ready: false,
      reason: 'dependency-missing',
    });
    expect(missingCli.calls).toHaveLength(0);

    const missingServer = new FakeAppleContainerHost();
    missingServer.files.delete(APPLE_CONTAINER_API_SERVER_PATH);
    missingServer.canonical.delete(APPLE_CONTAINER_API_SERVER_PATH);
    expect(await probe(missingServer)).toMatchObject({
      ready: false,
      reason: 'dependency-missing',
    });
    expect(missingServer.calls).toHaveLength(0);
  });

  test('rejects symlink, non-regular, non-root-owned, writable, and redirected identities', async () => {
    const mutations: Array<(host: FakeAppleContainerHost) => void> = [
      host => {
        const file = host.files.get(APPLE_CONTAINER_CLI_PATH)!;
        host.files.set(APPLE_CONTAINER_CLI_PATH, copyShape(file, { kind: 'symlink', mode: 0o120777n }));
      },
      host => {
        const file = host.files.get(APPLE_CONTAINER_API_SERVER_PATH)!;
        host.files.set(APPLE_CONTAINER_API_SERVER_PATH, copyShape(file, { kind: 'directory' }));
      },
      host => {
        const file = host.files.get(APPLE_CONTAINER_CLI_PATH)!;
        host.files.set(APPLE_CONTAINER_CLI_PATH, copyShape(file, { uid: 501n }));
      },
      host => {
        const file = host.files.get(APPLE_CONTAINER_API_SERVER_PATH)!;
        host.files.set(APPLE_CONTAINER_API_SERVER_PATH, copyShape(file, { mode: 0o100775n }));
      },
      host => {
        const file = host.files.get(APPLE_CONTAINER_CLI_PATH)!;
        host.files.set(APPLE_CONTAINER_CLI_PATH, copyShape(file, { nlink: 2n }));
      },
      host => {
        const directory = host.files.get('/usr/local/bin')!;
        host.files.set('/usr/local/bin', copyShape(directory, { mode: 0o040757n }));
      },
      host => {
        const directory = host.files.get('/usr/local')!;
        host.files.set('/usr/local', copyShape(directory, { kind: 'symlink', mode: 0o120777n }));
        host.canonical.set('/usr/local', '/private/redirected-local');
      },
    ];

    for (const mutate of mutations) {
      const host = new FakeAppleContainerHost();
      mutate(host);
      expect(await probe(host)).toMatchObject({
        ready: false,
        reason: 'binary-identity-unverified',
      });
      expect(host.calls).toHaveLength(0);
    }
  });

  test('requires both exact 1.3.1 package hashes and both code signatures', async () => {
    expect(APPLE_CONTAINER_TESTED_RELEASES).toHaveLength(1);
    expect(APPLE_CONTAINER_TESTED_RELEASES[0]).toMatchObject({
      version: '1.3.1',
      sourceCommit: CLI_COMMIT,
    });

    const badHash = new FakeAppleContainerHost();
    badHash.hashes.set(APPLE_CONTAINER_CLI_PATH, '0'.repeat(64));
    expect(await probe(badHash)).toMatchObject({
      ready: false,
      reason: 'binary-identity-unverified',
    });
    expect(badHash.calls).toHaveLength(0);

    const badSignature = new FakeAppleContainerHost();
    badSignature.codesignResult = failure(1, '/private/path must not escape');
    const capability = await probe(badSignature);
    expect(capability).toMatchObject({
      ready: false,
      reason: 'binary-identity-unverified',
    });
    expect(JSON.stringify(capability)).not.toContain('/private/path');
    expect(badSignature.calls.some(call => call.executable === APPLE_CONTAINER_CLI_PATH)).toBe(false);
  });

  test('allows only exact bounded version JSON and the tested 1.3.1 CLI version', async () => {
    const unsupported = new FakeAppleContainerHost();
    unsupported.versionResult = success(versionOutput({ cliVersion: '1.3.2' }));
    expect(await probe(unsupported)).toMatchObject({
      ready: false,
      reason: 'version-unsupported',
    });
    expect(unsupported.calls.some(call => call.args.join(' ') === 'system status --format json'))
      .toBe(false);

    const wrongCommit = new FakeAppleContainerHost();
    wrongCommit.versionResult = success(versionOutput({
      cliCommit: '0'.repeat(40),
    }));
    expect(await probe(wrongCommit)).toMatchObject({
      ready: false,
      reason: 'version-unsupported',
    });

    for (const result of [
      success('{not-json'),
      success(versionOutput({ extraCli: { localPath: '/private/leak' } })),
      { ...success(versionOutput()), outputTruncated: true },
      { ...success(versionOutput()), timedOut: true },
      { ...success(versionOutput()), stderr: 'unexpected warning' },
      success(' '.repeat(APPLE_CONTAINER_PROBE_MAX_OUTPUT_BYTES + 1)),
    ]) {
      const host = new FakeAppleContainerHost();
      host.versionResult = result;
      expect(await probe(host)).toMatchObject({
        ready: false,
        reason: 'dependency-unhealthy',
      });
    }
  });

  test('requires a present compatible API server in both version and status responses', async () => {
    const absent = new FakeAppleContainerHost();
    absent.versionResult = success(versionOutput({ includeServer: false }));
    expect(await probe(absent)).toMatchObject({ ready: false, reason: 'service-unhealthy' });

    const mismatchedVersion = new FakeAppleContainerHost();
    mismatchedVersion.versionResult = success(versionOutput({ serverVersion: '1.3.0' }));
    expect(await probe(mismatchedVersion)).toMatchObject({
      ready: false,
      reason: 'version-unsupported',
    });

    const mismatchedServerCommit = new FakeAppleContainerHost();
    mismatchedServerCommit.versionResult = success(versionOutput({
      serverCommit: '0'.repeat(40),
    }));
    expect(await probe(mismatchedServerCommit)).toMatchObject({
      ready: false,
      reason: 'version-unsupported',
    });

    const mismatchedStatus = new FakeAppleContainerHost();
    mismatchedStatus.statusResult = success(statusOutput({ apiCommit: '7654321'.repeat(5) + '76543' }));
    expect(await probe(mismatchedStatus)).toMatchObject({
      ready: false,
      reason: 'version-unsupported',
    });
  });

  test('fails closed on non-running, nonzero, malformed, extended, or oversized status output', async () => {
    for (const result of [
      success(statusOutput({ status: 'not running' })),
      success(statusOutput({ appRoot: '/Users/runtime-test/.container' })),
      success(statusOutput({ installRoot: '/tmp/user-install' })),
      success(statusOutput({ logRoot: '/tmp/user-logs' })),
      success(statusOutput({ logRoot: null })),
      failure(1, 'apiserver unavailable at /private/socket'),
      success('{not-json'),
      success(statusOutput({ extra: { logRoot: null } })),
      success(statusOutput({ extra: { credential: 'secret' } })),
      { ...success(statusOutput()), outputTruncated: true },
      { ...success(statusOutput()), stderr: 'unexpected warning' },
      success(' '.repeat(APPLE_CONTAINER_PROBE_MAX_OUTPUT_BYTES + 1)),
    ]) {
      const host = new FakeAppleContainerHost();
      host.statusResult = result;
      const capability = await probe(host);
      expect(capability).toMatchObject({ ready: false, reason: 'service-unhealthy' });
      expect(Object.keys(capability).sort()).toEqual(['kind', 'ready', 'reason', 'schemaVersion']);
      expect(JSON.stringify(capability)).not.toContain('private');
      expect(JSON.stringify(capability)).not.toContain('credential');
    }
  });

  test('revalidates both immutable file identities after the read-only CLI probes', async () => {
    const host = new FakeAppleContainerHost();
    host.mutateAfterStatus = true;
    expect(await probe(host)).toMatchObject({
      ready: false,
      reason: 'binary-identity-unverified',
    });
  });
});
