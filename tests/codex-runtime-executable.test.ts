import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CODEX_RUNTIME_MACOS_IDENTIFIER,
  CODEX_RUNTIME_MACOS_TEAM_ID,
  CodexRuntimeExecutableError,
  assertCodexRuntimeExecutableIdentityCurrent,
  codexRuntimeExecutableRevision,
  createCodexRuntimeExecutableCache,
  hashCodexRuntimeExecutableFileSync,
  isCodexRuntimeExecutableIdentity,
  resolveCodexRuntimeExecutable,
  runCodexRuntimeInspectionCommand,
  type CodexRuntimeCommandResult,
  type CodexRuntimeExecutableDependencies,
  type CodexRuntimeExecutableIdentity,
  type CodexRuntimeHostStat,
} from '../src/codexRuntimeExecutable';

const INSPECTION_TREE_FIXTURE = new URL(
  './fixtures/codex-runtime-inspection-tree.ts',
  import.meta.url,
).pathname;
const FIFO_WRITER_FIXTURE = new URL(
  './fixtures/codex-runtime-fifo-writer.ts',
  import.meta.url,
).pathname;

const HOME = '/Users/runtime-test';
const USER_CODEX = '/opt/agentstoz-test/bin/codex';
const CHATGPT_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex';
const CODEX_APP_CODEX = '/Applications/Codex.app/Contents/Resources/codex';
const MACHO_PREFIX = Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe]);
const ELF_PREFIX = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46]);

interface FakeFile {
  file: boolean;
  mode: number;
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  text: string;
  prefix: Uint8Array;
  sha256: string;
}

class FakeRuntimeHost implements CodexRuntimeExecutableDependencies {
  readonly files = new Map<string, FakeFile>();
  readonly links = new Map<string, string>();
  readonly signed = new Set<string>();
  readonly versions = new Map<string, string>();
  readonly calls: Array<{ executable: string; args: readonly string[] }> = [];
  readonly hashCalls = new Map<string, number>();
  nextInode = 100;

  addFile(path: string, input: Partial<FakeFile> = {}): void {
    const text = input.text ?? '';
    this.files.set(path, {
      file: input.file ?? true,
      mode: input.mode ?? 0o100755,
      dev: input.dev ?? '42',
      ino: input.ino ?? String(this.nextInode++),
      size: input.size ?? String(Math.max(4, Buffer.byteLength(text))),
      mtimeNs: input.mtimeNs ?? '1000000000',
      ctimeNs: input.ctimeNs ?? '1000000001',
      text,
      prefix: input.prefix ?? MACHO_PREFIX,
      sha256: input.sha256 ?? 'a'.repeat(64),
    });
  }

  addNative(
    path: string,
    input: { version?: string; sha256?: string; prefix?: Uint8Array; signed?: boolean } = {},
  ): void {
    this.addFile(path, {
      sha256: input.sha256,
      prefix: input.prefix,
      size: '200000000',
    });
    this.versions.set(path, input.version ?? '0.148.0');
    if (input.signed !== false) this.signed.add(path);
  }

  replaceNative(
    path: string,
    input: { version: string; sha256: string },
  ): void {
    const previous = this.files.get(path);
    if (!previous) throw new Error(`missing fake file: ${path}`);
    this.files.set(path, {
      ...previous,
      ino: String(this.nextInode++),
      ctimeNs: String(BigInt(previous.ctimeNs) + 1n),
      sha256: input.sha256,
    });
    this.versions.set(path, input.version);
  }

  async realpath(path: string): Promise<string> {
    const canonical = this.links.get(path) ?? path;
    if (!this.files.has(canonical)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return canonical;
  }

  async lstat(path: string): Promise<CodexRuntimeHostStat> {
    if (this.links.has(path)) {
      return {
        isFile: () => false,
        dev: '42',
        ino: '99',
        size: '1',
        mode: 0o120777,
        mtimeNs: '1000000000',
        ctimeNs: '1000000001',
      };
    }
    return this.stat(path);
  }

  async stat(path: string): Promise<CodexRuntimeHostStat> {
    const file = this.files.get(path);
    if (!file) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return {
      isFile: () => file.file,
      dev: file.dev,
      ino: file.ino,
      size: file.size,
      mode: file.mode,
      mtimeNs: file.mtimeNs,
      ctimeNs: file.ctimeNs,
    };
  }

  async readTextFile(
    path: string,
    maxBytes: number,
    _expectedStat: CodexRuntimeExecutableIdentity['stat'],
  ): Promise<string> {
    const file = this.files.get(path);
    if (!file || Buffer.byteLength(file.text) > maxBytes) throw new Error('invalid bounded read');
    return file.text;
  }

  async readFilePrefix(
    path: string,
    maxBytes: number,
    _expectedStat: CodexRuntimeExecutableIdentity['stat'],
  ): Promise<Uint8Array> {
    const file = this.files.get(path);
    if (!file) throw new Error('missing prefix');
    return file.prefix.slice(0, maxBytes);
  }

  async sha256File(
    path: string,
    _expectedStat: CodexRuntimeExecutableIdentity['stat'],
  ): Promise<string> {
    const file = this.files.get(path);
    if (!file) throw new Error('missing hash target');
    this.hashCalls.set(path, (this.hashCalls.get(path) ?? 0) + 1);
    return file.sha256;
  }

  async run(executable: string, args: readonly string[]): Promise<CodexRuntimeCommandResult> {
    this.calls.push({ executable, args: [...args] });
    if (executable === '/usr/bin/codesign') {
      return this.signed.has(args.at(-1) ?? '')
        ? { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        : { exitCode: 1, stdout: '', stderr: 'untrusted', timedOut: false };
    }
    const version = this.versions.get(executable);
    return version
      ? { exitCode: 0, stdout: `codex-cli ${version}\n`, stderr: '', timedOut: false }
      : { exitCode: 127, stdout: '', stderr: 'unavailable', timedOut: false };
  }
}

function resolveOptions(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'darwin' as const,
    arch: 'arm64' as const,
    homeDir: HOME,
    pathEnv: '',
    userCandidatePaths: [USER_CODEX],
    cache: createCodexRuntimeExecutableCache(),
    ...overrides,
  };
}

function packageMetadata(version = '0.148.0') {
  return JSON.stringify({
    name: '@openai/codex',
    version,
    license: 'Apache-2.0',
    bin: { codex: 'bin/codex.js' },
    repository: {
      type: 'git',
      url: 'git+https://github.com/openai/codex.git',
      directory: 'codex-cli',
    },
    optionalDependencies: {
      '@openai/codex-darwin-arm64': `npm:@openai/codex@${version}-darwin-arm64`,
    },
  });
}

function platformPackageMetadata(version = '0.148.0') {
  return JSON.stringify({
    name: '@openai/codex',
    version: `${version}-darwin-arm64`,
    license: 'Apache-2.0',
    os: ['darwin'],
    cpu: ['arm64'],
    repository: {
      type: 'git',
      url: 'git+https://github.com/openai/codex.git',
      directory: 'codex-cli',
    },
  });
}

function expectRuntimeError(cause: unknown, code: CodexRuntimeExecutableError['code']): void {
  expect(cause).toBeInstanceOf(CodexRuntimeExecutableError);
  expect((cause as CodexRuntimeExecutableError).code).toBe(code);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

describe('Codex runtime executable identity', () => {
  test('prefers a verified user-installed native and returns a complete signed identity', async () => {
    const host = new FakeRuntimeHost();
    host.addNative(USER_CODEX, { version: '0.148.0', sha256: '1'.repeat(64) });
    host.addNative(CHATGPT_CODEX, { version: '0.149.0-alpha.4.3', sha256: '2'.repeat(64) });

    const identity = await resolveCodexRuntimeExecutable(resolveOptions(), host);

    expect(identity).toMatchObject({
      path: USER_CODEX,
      source: 'standalone-native',
      version: '0.148.0',
      sha256: '1'.repeat(64),
      signing: {
        platform: 'darwin',
        teamId: CODEX_RUNTIME_MACOS_TEAM_ID,
        identifier: CODEX_RUNTIME_MACOS_IDENTIFIER,
      },
      stat: {
        dev: '42',
        size: '200000000',
        mode: 0o100755,
        mtimeNs: '1000000000',
        ctimeNs: '1000000001',
      },
    });
    expect(identity?.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(isCodexRuntimeExecutableIdentity(identity)).toBe(true);
    expect(host.calls.some(call => call.executable === CHATGPT_CODEX)).toBe(false);
    const codesign = host.calls.find(call => call.executable === '/usr/bin/codesign');
    expect(codesign?.args).toContain('=anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2" and identifier "codex"');
    expect(codesign?.args.at(-1)).toBe(USER_CODEX);

    expect(isCodexRuntimeExecutableIdentity({ ...identity, unexpected: true })).toBe(false);
    expect(isCodexRuntimeExecutableIdentity({ ...identity, revision: '0'.repeat(64) })).toBe(false);
    const { revision: _revision, ...unsignedBundleBase } = {
      ...identity!,
      source: 'chatgpt-bundled' as const,
      signing: null,
    };
    expect(isCodexRuntimeExecutableIdentity({
      ...unsignedBundleBase,
      revision: codexRuntimeExecutableRevision(unsignedBundleBase),
    })).toBe(false);
  });

  test('uses app-bundled binaries only as explicit fallback when standalone is absent', async () => {
    const chatGpt = new FakeRuntimeHost();
    chatGpt.addNative(CHATGPT_CODEX, { version: '0.149.0-alpha.4.3' });
    chatGpt.addNative(CODEX_APP_CODEX, { version: '0.147.0' });
    const fromChatGpt = await resolveCodexRuntimeExecutable(resolveOptions(), chatGpt);
    expect(fromChatGpt).toMatchObject({ path: CHATGPT_CODEX, source: 'chatgpt-bundled' });
    expect(chatGpt.calls.some(call => call.executable === CODEX_APP_CODEX)).toBe(false);

    const codexApp = new FakeRuntimeHost();
    codexApp.addNative(CODEX_APP_CODEX, { version: '0.147.0' });
    const fromCodexApp = await resolveCodexRuntimeExecutable(resolveOptions(), codexApp);
    expect(fromCodexApp).toMatchObject({ path: CODEX_APP_CODEX, source: 'codex-app-bundled' });
  });

  test('defers a standalone-path alias to an app bundle until real standalone candidates are exhausted', async () => {
    const withStandalone = new FakeRuntimeHost();
    withStandalone.links.set(USER_CODEX, CHATGPT_CODEX);
    withStandalone.addNative(CHATGPT_CODEX, { version: '0.149.0-alpha.4.3' });
    withStandalone.addNative('/usr/local/bin/codex', { version: '0.148.0' });

    const standalone = await resolveCodexRuntimeExecutable(resolveOptions(), withStandalone);
    expect(standalone).toMatchObject({
      path: '/usr/local/bin/codex',
      source: 'standalone-native',
      version: '0.148.0',
    });
    expect(withStandalone.calls.some(call => call.executable === CHATGPT_CODEX)).toBe(false);

    const bundleOnly = new FakeRuntimeHost();
    bundleOnly.links.set(USER_CODEX, CHATGPT_CODEX);
    bundleOnly.addNative(CHATGPT_CODEX, { version: '0.149.0-alpha.4.3' });
    const fallback = await resolveCodexRuntimeExecutable(resolveOptions(), bundleOnly);
    expect(fallback).toMatchObject({
      path: CHATGPT_CODEX,
      source: 'chatgpt-bundled',
      version: '0.149.0-alpha.4.3',
    });

    const exactBundlePreference = new FakeRuntimeHost();
    exactBundlePreference.addNative(CHATGPT_CODEX, { version: '0.149.0-alpha.4.3' });
    const exactFallback = await resolveCodexRuntimeExecutable(resolveOptions({
      userCandidatePaths: [CHATGPT_CODEX],
    }), exactBundlePreference);
    expect(exactFallback).toMatchObject({
      path: CHATGPT_CODEX,
      source: 'chatgpt-bundled',
      version: '0.149.0-alpha.4.3',
    });
  });

  test('fails closed when a standalone symlink retargets to a bundle during inspection', async () => {
    const host = new FakeRuntimeHost();
    host.addNative(USER_CODEX, { version: '0.148.0' });
    host.addNative(CHATGPT_CODEX, { version: '0.149.0-alpha.4.3' });
    const ordinaryRealpath = host.realpath.bind(host);
    let candidateRealpathCalls = 0;
    host.realpath = async path => {
      if (path === USER_CODEX) {
        candidateRealpathCalls += 1;
        return candidateRealpathCalls === 1 ? USER_CODEX : CHATGPT_CODEX;
      }
      return ordinaryRealpath(path);
    };

    await expect(resolveCodexRuntimeExecutable(resolveOptions(), host)).rejects.toMatchObject({
      code: 'CODEX_RUNTIME_EXECUTABLE_CHANGED',
      retryable: true,
    });
    expect(host.calls.some(call => call.executable === CHATGPT_CODEX)).toBe(false);
  });

  test('unwraps only the exact official npm package layout to its signed vendor native', async () => {
    const host = new FakeRuntimeHost();
    const launcherLink = `${HOME}/.local/bin/codex`;
    const packageRoot = `${HOME}/.local/lib/node_modules/@openai/codex`;
    const launcher = `${packageRoot}/bin/codex.js`;
    const platformRoot = `${packageRoot}/node_modules/@openai/codex-darwin-arm64`;
    const native = `${platformRoot}/vendor/aarch64-apple-darwin/bin/codex`;
    host.links.set(launcherLink, launcher);
    host.addFile(launcher, { text: '#!/usr/bin/env node', prefix: Uint8Array.from([0x23, 0x21]) });
    host.addFile(`${packageRoot}/package.json`, { text: packageMetadata(), mode: 0o100644 });
    host.addFile(`${platformRoot}/package.json`, { text: platformPackageMetadata(), mode: 0o100644 });
    host.addNative(native, { version: '0.148.0', sha256: '3'.repeat(64) });

    const identity = await resolveCodexRuntimeExecutable(resolveOptions({
      userCandidatePaths: [],
    }), host);

    expect(identity).toMatchObject({
      path: native,
      source: 'standalone-npm',
      version: '0.148.0',
      sha256: '3'.repeat(64),
    });
    expect(host.calls.some(call => call.executable === launcher)).toBe(false);
    expect(host.calls.some(call => call.executable === native && call.args[0] === '--version')).toBe(true);
  });

  test('rejects a present arbitrary JavaScript shim without silently using the bundle', async () => {
    const host = new FakeRuntimeHost();
    const launcherLink = `${HOME}/.local/bin/codex`;
    host.links.set(launcherLink, '/tmp/untrusted/bin/codex.js');
    host.addFile('/tmp/untrusted/bin/codex.js', {
      text: '#!/usr/bin/env node',
      prefix: Uint8Array.from([0x23, 0x21]),
    });
    host.addNative(CHATGPT_CODEX, { version: '0.149.0-alpha.4.3' });

    try {
      await resolveCodexRuntimeExecutable(resolveOptions({ userCandidatePaths: [] }), host);
      throw new Error('expected arbitrary shim rejection');
    } catch (cause) {
      expectRuntimeError(cause, 'CODEX_RUNTIME_NPM_LAUNCHER_INVALID');
    }
    expect(host.calls.some(call => call.executable === CHATGPT_CODEX)).toBe(false);
  });

  test('fails closed on an unverifiable signature, non-native file, or version mismatch', async () => {
    const cases = [
      {
        prepare(host: FakeRuntimeHost) {
          host.addNative(USER_CODEX, { signed: false });
        },
        code: 'CODEX_RUNTIME_EXECUTABLE_SIGNATURE_INVALID' as const,
      },
      {
        prepare(host: FakeRuntimeHost) {
          host.addNative(USER_CODEX, { prefix: Uint8Array.from([0x23, 0x21, 0x2f, 0x62]) });
        },
        code: 'CODEX_RUNTIME_EXECUTABLE_NOT_NATIVE' as const,
      },
      {
        prepare(host: FakeRuntimeHost) {
          host.addNative(USER_CODEX, { version: 'not-semver' });
        },
        code: 'CODEX_RUNTIME_EXECUTABLE_VERSION_INVALID' as const,
      },
      {
        prepare(host: FakeRuntimeHost) {
          host.addNative(USER_CODEX);
          host.files.get(USER_CODEX)!.size = String(1024 * 1024 * 1024 + 1);
        },
        code: 'CODEX_RUNTIME_EXECUTABLE_HASH_INVALID' as const,
      },
    ];
    for (const testCase of cases) {
      const host = new FakeRuntimeHost();
      testCase.prepare(host);
      host.addNative(CHATGPT_CODEX);
      try {
        await resolveCodexRuntimeExecutable(resolveOptions(), host);
        throw new Error('expected inspection rejection');
      } catch (cause) {
        expectRuntimeError(cause, testCase.code);
      }
      expect(host.calls.some(call => call.executable === CHATGPT_CODEX)).toBe(false);
    }
  });

  test('keys cache and concurrent inspection by stat revision and invalidates an atomic replacement', async () => {
    const host = new FakeRuntimeHost();
    const cache = createCodexRuntimeExecutableCache();
    const options = resolveOptions({ cache });
    host.addNative(USER_CODEX, { version: '0.148.0', sha256: '4'.repeat(64) });

    const first = await resolveCodexRuntimeExecutable(options, host);
    const cached = await resolveCodexRuntimeExecutable(options, host);
    expect(cached).toEqual(first);
    expect(host.hashCalls.get(USER_CODEX)).toBe(1);
    expect(host.calls.filter(call => call.executable === '/usr/bin/codesign')).toHaveLength(1);

    const [freshA, freshB] = await Promise.all([
      resolveCodexRuntimeExecutable({ ...options, fresh: true }, host),
      resolveCodexRuntimeExecutable({ ...options, fresh: true }, host),
    ]);
    expect(freshA).toEqual(freshB);
    expect(host.hashCalls.get(USER_CODEX)).toBe(2);
    expect(host.calls.filter(call => call.executable === '/usr/bin/codesign')).toHaveLength(2);

    host.replaceNative(USER_CODEX, { version: '0.149.0', sha256: '5'.repeat(64) });
    const updated = await resolveCodexRuntimeExecutable(options, host);
    expect(updated).toMatchObject({ path: USER_CODEX, version: '0.149.0', sha256: '5'.repeat(64) });
    expect(updated?.revision).not.toBe(first?.revision);
    expect(host.hashCalls.get(USER_CODEX)).toBe(3);
    expect(cache.identities.has(first!.revision)).toBe(true);
    expect(cache.identities.has(updated!.revision)).toBe(true);
  });

  test('partitions a shared stat cache by platform and signing policy', async () => {
    const host = new FakeRuntimeHost();
    const cache = createCodexRuntimeExecutableCache();
    host.addNative(USER_CODEX, {
      prefix: ELF_PREFIX,
      signed: false,
      sha256: '9'.repeat(64),
    });

    const linux = await resolveCodexRuntimeExecutable({
      platform: 'linux',
      arch: 'arm64',
      homeDir: HOME,
      pathEnv: '',
      userCandidatePaths: [USER_CODEX],
      cache,
    }, host);
    expect(linux?.signing).toBeNull();

    host.files.get(USER_CODEX)!.prefix = MACHO_PREFIX;
    host.signed.add(USER_CODEX);
    const darwin = await resolveCodexRuntimeExecutable({
      ...resolveOptions(),
      cache,
    }, host);

    expect(darwin?.signing).toEqual({
      platform: 'darwin',
      teamId: CODEX_RUNTIME_MACOS_TEAM_ID,
      identifier: CODEX_RUNTIME_MACOS_IDENTIFIER,
    });
    expect(host.calls.filter(call => call.executable === '/usr/bin/codesign')).toHaveLength(1);
  });

  test('fails closed on a dangling standalone link and an invalid explicit candidate path', async () => {
    const dangling = new FakeRuntimeHost();
    dangling.links.set(USER_CODEX, '/missing/native/codex');
    dangling.addNative(CHATGPT_CODEX);

    await expect(resolveCodexRuntimeExecutable(resolveOptions(), dangling)).rejects.toMatchObject({
      code: 'CODEX_RUNTIME_EXECUTABLE_PATH_INVALID',
      retryable: true,
    });
    expect(dangling.calls.some(call => call.executable === CHATGPT_CODEX)).toBe(false);

    const invalid = new FakeRuntimeHost();
    invalid.addNative(CHATGPT_CODEX);
    await expect(resolveCodexRuntimeExecutable(resolveOptions({
      userCandidatePaths: ['relative/codex'],
    }), invalid)).rejects.toMatchObject({
      code: 'CODEX_RUNTIME_EXECUTABLE_PATH_INVALID',
      retryable: false,
    });
    expect(invalid.calls.some(call => call.executable === CHATGPT_CODEX)).toBe(false);
  });

  test('keeps Linux available with ELF hash/version identity and no invented signing proof', async () => {
    const host = new FakeRuntimeHost();
    host.addNative('/usr/local/bin/codex', {
      version: '0.148.0',
      sha256: '6'.repeat(64),
      prefix: ELF_PREFIX,
      signed: false,
    });

    const identity = await resolveCodexRuntimeExecutable({
      platform: 'linux',
      arch: 'x64',
      homeDir: '/home/runtime-test',
      pathEnv: '',
      userCandidatePaths: ['/usr/local/bin/codex'],
      cache: createCodexRuntimeExecutableCache(),
    }, host);

    expect(identity).toMatchObject({
      path: '/usr/local/bin/codex',
      source: 'standalone-native',
      signing: null,
      version: '0.148.0',
      sha256: '6'.repeat(64),
    });
    expect(isCodexRuntimeExecutableIdentity(identity)).toBe(true);
    expect(host.calls.some(call => call.executable === '/usr/bin/codesign')).toBe(false);
  });

  test.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('synchronous spawn-boundary assertion rehashes content even when all stat fields match', async () => {
    const host = new FakeRuntimeHost();
    // The synchronous production guard validates this host's platform. A
    // mocked Mach-O signing identity is intentionally invalid on Linux.
    host.addNative(USER_CODEX, {
      sha256: '7'.repeat(64),
      prefix: process.platform === 'linux' ? ELF_PREFIX : MACHO_PREFIX,
    });
    const identity = await resolveCodexRuntimeExecutable(resolveOptions({
      platform: process.platform,
    }), host) as CodexRuntimeExecutableIdentity;
    const fakeFile = host.files.get(USER_CODEX)!;
    const stat = (): CodexRuntimeHostStat => ({
      isFile: () => true,
      dev: fakeFile.dev,
      ino: fakeFile.ino,
      size: fakeFile.size,
      mode: fakeFile.mode,
      mtimeNs: fakeFile.mtimeNs,
      ctimeNs: fakeFile.ctimeNs,
    });

    expect(() => assertCodexRuntimeExecutableIdentityCurrent(identity, {
      realpathSync: () => USER_CODEX,
      statSync: stat,
      sha256FileSync: () => identity.sha256,
    })).not.toThrow();

    expect(() => assertCodexRuntimeExecutableIdentityCurrent(identity, {
      realpathSync: () => USER_CODEX,
      statSync: stat,
      sha256FileSync: () => '8'.repeat(64),
    })).toThrow(expect.objectContaining({
      code: 'CODEX_RUNTIME_EXECUTABLE_CHANGED',
      retryable: true,
    }));
  });

  test.skipIf(process.platform === 'win32')(
    'synchronous guard hashing rejects a replaced FIFO without blocking on a writer',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'agentstoz-codex-fifo-'));
      const fifoPath = join(root, 'codex');
      const mkfifo = Bun.which('mkfifo');
      expect(mkfifo).toBeTruthy();
      expect(Bun.spawnSync([mkfifo!, fifoPath]).exitCode).toBe(0);
      const info = statSync(fifoPath, { bigint: true });
      const delayedWriter = Bun.spawn([
        process.execPath,
        FIFO_WRITER_FIXTURE,
        fifoPath,
      ], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
      const startedAt = performance.now();
      try {
        expect(() => hashCodexRuntimeExecutableFileSync(fifoPath, {
          dev: info.dev.toString(),
          ino: info.ino.toString(),
          // Keep the size inside the executable hash bound. The opened fd must
          // still be rejected because it is not a regular file.
          size: '1',
          mode: Number(info.mode) | 0o111,
          mtimeNs: info.mtimeNs.toString(),
          ctimeNs: info.ctimeNs.toString(),
        })).toThrow();
        expect(performance.now() - startedAt).toBeLessThan(500);
      } finally {
        delayedWriter.kill('SIGKILL');
        await delayedWriter.exited;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test('inspection runner reaps an inherited-pipe descendant after the direct child exits', async () => {
    const result = await runCodexRuntimeInspectionCommand(
      process.execPath,
      [INSPECTION_TREE_FIXTURE, 'exit-with-descendant'],
      {
        timeoutMs: 2_000,
        maxOutputBytes: 4_096,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      },
    );
    const descendantPid = Number(/descendant=(\d+)/.exec(result.stdout)?.[1]);

    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(Number.isSafeInteger(descendantPid) && descendantPid > 0).toBe(true);
    expect(processExists(descendantPid)).toBe(false);
  });

  test('inspection timeout escalates and confirms the whole process group is gone', async () => {
    const result = await runCodexRuntimeInspectionCommand(
      process.execPath,
      [INSPECTION_TREE_FIXTURE, 'hang-with-descendant'],
      {
        timeoutMs: 100,
        maxOutputBytes: 4_096,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      },
    );
    const pids = /parent=(\d+) descendant=(\d+)/.exec(result.stdout);
    const parentPid = Number(pids?.[1]);
    const descendantPid = Number(pids?.[2]);

    expect(result.timedOut).toBe(true);
    expect(Number.isSafeInteger(parentPid) && parentPid > 0).toBe(true);
    expect(Number.isSafeInteger(descendantPid) && descendantPid > 0).toBe(true);
    expect(processExists(parentPid)).toBe(false);
    expect(processExists(descendantPid)).toBe(false);
  });

  test('does not accept a late child exit when the parent event loop passed the deadline', async () => {
    const running = runCodexRuntimeInspectionCommand(
      process.execPath,
      [INSPECTION_TREE_FIXTURE, 'delayed-success'],
      {
        timeoutMs: 20,
        maxOutputBytes: 4_096,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      },
    );
    const blockedUntil = performance.now() + 150;
    while (performance.now() < blockedUntil) {
      // Deliberately keep the timer and child-exit callbacks queued together.
    }

    const result = await running;
    expect(result.timedOut).toBe(true);
  });

  test('keeps timeout cleanup bounded when the wall clock does not advance', async () => {
    const originalDateNow = Date.now;
    const startedAt = performance.now();
    Date.now = () => 1;
    try {
      const result = await runCodexRuntimeInspectionCommand(
        process.execPath,
        [INSPECTION_TREE_FIXTURE, 'hang-with-descendant'],
        {
          timeoutMs: 20,
          maxOutputBytes: 4_096,
          env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
        },
      );
      expect(result.timedOut).toBe(true);
      expect(performance.now() - startedAt).toBeLessThan(1_500);
    } finally {
      Date.now = originalDateNow;
    }
  });
});
