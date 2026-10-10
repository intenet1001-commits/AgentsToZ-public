import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import {
  CODEX_RUNTIME_MACOS_IDENTIFIER,
  CODEX_RUNTIME_MACOS_TEAM_ID,
  CODEX_RUNTIME_WINDOWS_PUBLISHER,
  codexRuntimeExecutableRevision,
  isCodexRuntimeExecutableIdentity,
  isCodexRuntimeExecutableIdentityForPlatform,
  resolveCodexRuntimeExecutable,
} from '../src/codexRuntimeExecutable';

/** Windows reports mode 666 for every file: there is no execute bit. */
const WINDOWS_MODE = 0o666;
const POSIX_MODE = 0o755;

const stat = (mode: number) => ({
  dev: '3',
  ino: '281474976710700',
  size: '358650672',
  mode,
  mtimeNs: '1759500000000000000',
  ctimeNs: '1759500000000000000',
});

const withRevision = (identity: Record<string, unknown>) => ({
  ...identity,
  revision: codexRuntimeExecutableRevision(identity as never),
});

const windowsIdentity = (overrides: Record<string, unknown> = {}) => withRevision({
  path: 'C:\\Users\\x\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe',
  source: 'standalone-native',
  version: '0.146.0',
  sha256: 'bc343ba420dc2e2e9f59e6fc5e5bf0aae1cd8c771fc319665241fc9c0271fddb',
  stat: stat(WINDOWS_MODE),
  signing: { platform: 'win32', publisher: CODEX_RUNTIME_WINDOWS_PUBLISHER },
  ...overrides,
});

const macIdentity = (overrides: Record<string, unknown> = {}) => withRevision({
  path: '/opt/homebrew/bin/codex',
  source: 'standalone-native',
  version: '0.146.0',
  sha256: 'a'.repeat(64),
  stat: stat(POSIX_MODE),
  signing: {
    platform: 'darwin',
    teamId: CODEX_RUNTIME_MACOS_TEAM_ID,
    identifier: CODEX_RUNTIME_MACOS_IDENTIFIER,
  },
  ...overrides,
});

test('a Windows identity needs Authenticode, and nothing else stands in for it', () => {
  const identity = windowsIdentity();
  expect(isCodexRuntimeExecutableIdentity(identity)).toBe(true);
  expect(isCodexRuntimeExecutableIdentityForPlatform(identity, 'win32')).toBe(true);

  // ⚠️ Unsigned is refused. Windows has no execute bit and no notarisation, so
  // the publisher is the only thing separating the real binary from any other
  // file of that name -- and Linux's "hash and version are the identity" answer
  // does not transfer, because there the file at least had to be executable.
  const unsigned = windowsIdentity({ signing: null });
  expect(isCodexRuntimeExecutableIdentityForPlatform(unsigned, 'win32')).toBe(false);

  // A different publisher is a different signer. `OpenAI, Inc.` is what the
  // winget metadata says, and pinning it rejected the genuine binary during the
  // onboarding work -- so it must not be accepted here either.
  for (const publisher of ['OpenAI, Inc.', 'openai opco, llc', '', 'OpenAI OpCo, LLC ']) {
    const wrong = windowsIdentity({ signing: { platform: 'win32', publisher } });
    expect(isCodexRuntimeExecutableIdentity(wrong)).toBe(false);
    expect(isCodexRuntimeExecutableIdentityForPlatform(wrong, 'win32')).toBe(false);
  }
  // An extra field means something else wrote it.
  const extra = windowsIdentity({
    signing: { platform: 'win32', publisher: CODEX_RUNTIME_WINDOWS_PUBLISHER, thumbprint: 'x' },
  });
  expect(isCodexRuntimeExecutableIdentity(extra)).toBe(false);
});

test('Windows mode 666 is accepted only for a win32-signed identity', () => {
  // Measured this session: Windows reports 666 for files and directories alike,
  // so the POSIX 0o111 check rejected every Windows binary. The exemption is
  // tied to being win32-signed rather than to a platform argument, because the
  // portable validator does not take one -- and a mode-666 identity that claims
  // no signature stays rejected.
  expect(isCodexRuntimeExecutableIdentity(windowsIdentity())).toBe(true);
  expect(isCodexRuntimeExecutableIdentity(windowsIdentity({ signing: null }))).toBe(false);
  expect(isCodexRuntimeExecutableIdentity(macIdentity({ stat: stat(WINDOWS_MODE) }))).toBe(false);
  // And a POSIX identity still has to be executable.
  expect(isCodexRuntimeExecutableIdentity(macIdentity({ stat: stat(0o644) }))).toBe(false);
});

test('a platform never accepts another platform signature', () => {
  const windows = windowsIdentity();
  const mac = macIdentity();
  const linux = withRevision({
    path: '/usr/local/bin/codex',
    source: 'standalone-native',
    version: '0.146.0',
    sha256: 'b'.repeat(64),
    stat: stat(POSIX_MODE),
    signing: null,
  });

  expect(isCodexRuntimeExecutableIdentityForPlatform(windows, 'darwin')).toBe(false);
  expect(isCodexRuntimeExecutableIdentityForPlatform(windows, 'linux')).toBe(false);
  expect(isCodexRuntimeExecutableIdentityForPlatform(mac, 'win32')).toBe(false);
  expect(isCodexRuntimeExecutableIdentityForPlatform(linux, 'win32')).toBe(false);
  // Unchanged: darwin needs a darwin signature, linux needs none.
  expect(isCodexRuntimeExecutableIdentityForPlatform(mac, 'darwin')).toBe(true);
  expect(isCodexRuntimeExecutableIdentityForPlatform(linux, 'linux')).toBe(true);
});

test('the app-bundled sources have no Windows meaning', () => {
  // They name a binary embedded in a macOS .app. Accepting one on Windows would
  // mean adopting a layout nothing here has measured.
  for (const source of ['chatgpt-bundled', 'codex-app-bundled']) {
    const identity = windowsIdentity({ source });
    expect(isCodexRuntimeExecutableIdentityForPlatform(identity, 'win32')).toBe(false);
  }
  expect(isCodexRuntimeExecutableIdentityForPlatform(windowsIdentity({ source: 'standalone-npm' }), 'win32'))
    .toBe(true);
});

test('adding Windows did not change a darwin or linux revision', () => {
  // The revision is a cache and profile key, so a formula change would churn
  // every macOS entry. This reimplements the formula as it was before Windows
  // existed and insists the result is still byte-identical.
  const legacy = (identity: Record<string, any>) => createHash('sha256').update([
    'agentstoz-codex-executable-v1',
    identity.path,
    identity.source,
    identity.version,
    identity.sha256,
    identity.stat.dev,
    identity.stat.ino,
    identity.stat.size,
    String(identity.stat.mode),
    identity.stat.mtimeNs,
    identity.stat.ctimeNs,
    identity.signing?.platform ?? '',
    identity.signing?.teamId ?? '',
    identity.signing?.identifier ?? '',
  ].join('\0')).digest('hex');

  const mac = macIdentity();
  expect(codexRuntimeExecutableRevision(mac as never)).toBe(legacy(mac));

  const linux = withRevision({
    path: '/usr/local/bin/codex',
    source: 'standalone-native',
    version: '0.146.0',
    sha256: 'c'.repeat(64),
    stat: stat(POSIX_MODE),
    signing: null,
  });
  expect(codexRuntimeExecutableRevision(linux as never)).toBe(legacy(linux));

  // The Windows publisher does participate, so two binaries differing only by
  // signer are different identities.
  const windows = windowsIdentity();
  expect(codexRuntimeExecutableRevision(windows as never)).not.toBe(legacy(windows));
});

test('no Windows identity can be produced yet, and the resolver says so', async () => {
  // The policy is in place; resolution is not. Until the resolver can read an
  // Authenticode publisher and walk the Windows install layout, nothing can hand
  // a win32 identity to a provider spawn -- which is the safe order to build
  // this in, and is asserted so it is not mistaken for a working path.
  await expect(resolveCodexRuntimeExecutable({ platform: 'win32' } as never))
    .rejects.toMatchObject({ code: 'CODEX_RUNTIME_EXECUTABLE_UNSUPPORTED_PLATFORM' });
});
