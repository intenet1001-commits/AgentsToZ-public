import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat as nodeLstat,
  open as nodeOpen,
  readdir as nodeReaddir,
  realpath as nodeRealpath,
} from 'node:fs/promises';
import { dirname, isAbsolute, normalize } from 'node:path';

import {
  APPLE_CONTAINER_TEAM_IDENTIFIER,
  APPLE_CONTAINER_TESTED_RELEASES,
} from './appleContainerRuntime';

/**
 * Read-only identity qualification for the complete Apple Container 1.3.1
 * installer payload used by AgentsToZ.
 *
 * Provenance: the inventory and binary hashes below were measured from the
 * notarized `container-1.3.1-installer-signed.pkg` whose SHA-256 is
 * a7c1b9d7927d30875f2f6c7bd1d0cb06c2daa6ca57ce9e90a5144e898fdf54a8.
 * The ten non-Mach-O file hashes also match source tag 1.3.1 at commit
 * a9a62e28f6beb88940122a3d7b286f2d5ae8053a exactly.
 *
 * This proof does not authorize a task and can never make containment ready.
 * It also MUST NOT be composed directly with the existing appleContainerRuntime
 * version/status probe to unlock the canary: that probe does not yet establish
 * exact appRoot/installRoot, absence of same-UID service re-registration or
 * user `container-plugins`/configuration, trusted kernel/vminit identity, or a
 * separate-UID broker. Those prerequisites need their own fail-closed proof;
 * only then may this payload proof, the runtime probe, registry ownership and
 * adversarial lifecycle tests be combined by a future outer orchestrator.
 */

export const APPLE_CONTAINER_INSTALL_PAYLOAD_RELEASE = '1.3.1' as const;
export const APPLE_CONTAINER_INSTALL_PAYLOAD_SOURCE_COMMIT =
  'a9a62e28f6beb88940122a3d7b286f2d5ae8053a' as const;
export const APPLE_CONTAINER_INSTALL_PAYLOAD_PROOF_VERSION =
  'agentstoz-apple-container-install-payload-v1' as const;
export const APPLE_CONTAINER_INSTALL_PAYLOAD_FILE_COUNT = 17;
export const APPLE_CONTAINER_INSTALL_PAYLOAD_MACHO_COUNT = 7;
export const APPLE_CONTAINER_INSTALL_PAYLOAD_STATIC_COUNT = 10;

const CODESIGN_PATH = '/usr/bin/codesign';
const CODESIGN_TIMEOUT_MS = 5_000;
const CODESIGN_MAX_OUTPUT_BYTES = 32 * 1024;
const HASH_BUFFER_BYTES = 1024 * 1024;
const MAX_PAYLOAD_FILE_BYTES = 128 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 64;
const MAX_DIRECTORY_ENTRY_BYTES = 255;

type ArtifactKind = 'mach-o' | 'static';

interface AppleContainerInstallArtifact {
  readonly path: string;
  readonly kind: ArtifactKind;
  readonly size: number;
  readonly sha256: string;
  readonly executable: boolean;
  readonly signingIdentifier?: string;
}

interface ExactDirectoryInventory {
  readonly path: string;
  readonly entries: readonly string[];
}

function artifact(
  path: string,
  kind: ArtifactKind,
  size: number,
  sha256: string,
  options: { executable?: boolean; signingIdentifier?: string } = {},
): Readonly<AppleContainerInstallArtifact> {
  return Object.freeze({
    path,
    kind,
    size,
    sha256,
    executable: options.executable ?? kind === 'mach-o',
    ...(options.signingIdentifier === undefined
      ? {}
      : { signingIdentifier: options.signingIdentifier }),
  });
}

const INSTALL_ARTIFACTS: readonly Readonly<AppleContainerInstallArtifact>[] = Object.freeze([
  artifact(
    '/usr/local/bin/container',
    'mach-o',
    68_084_304,
    'c6f8ef172248f7b8a30fa3e502359bba678bc993991c37b848dbead1914e86b1',
    { signingIdentifier: 'com.apple.container.cli' },
  ),
  artifact(
    '/usr/local/bin/container-apiserver',
    'mach-o',
    62_901_952,
    'ace7e2200c4302b7184e29f4063d346305869202c8bda794eaae0613e39f79e2',
    { signingIdentifier: 'com.apple.container.apiserver' },
  ),
  artifact(
    '/usr/local/bin/uninstall-container.sh',
    'static',
    2_700,
    '51a840ab040bec9855ac66ad7c27b3b48771f69e779cb6d614895a3185a3dbb9',
    { executable: true },
  ),
  artifact(
    '/usr/local/bin/update-container.sh',
    'static',
    5_230,
    'd7c11bde8814f9ee1b6ecb27067d627cb780cc89c1ed300fc9b755c214be9dd3',
    { executable: true },
  ),
  artifact(
    '/usr/local/libexec/container/plugins/container-core-images/bin/container-core-images',
    'mach-o',
    62_157_136,
    '89bd502b4c914a08dbca68350dbf6bad331acc510e9b83245f757a583cc388fc',
    { signingIdentifier: 'com.apple.container.container-core-images' },
  ),
  artifact(
    '/usr/local/libexec/container/plugins/container-core-images/config.toml',
    'static',
    266,
    '89ebf5415177298d36f4c67c8c03db26fac1377b428f30a5ccf96407d8f63f9d',
  ),
  artifact(
    '/usr/local/libexec/container/plugins/container-network-vmnet/bin/container-network-vmnet',
    'mach-o',
    60_495_488,
    'fcc48b3c1f393025df004de378704d69db7d06da9695ec44f291b8b2a65dd8f3',
    { signingIdentifier: 'com.apple.container.container-network-vmnet' },
  ),
  artifact(
    '/usr/local/libexec/container/plugins/container-network-vmnet/config.toml',
    'static',
    198,
    '7ec0d522dcf9c9bc78b1e0843916bd0a98cfec45ef5b35f04fb8407ecda3db3e',
  ),
  artifact(
    '/usr/local/libexec/container/plugins/container-runtime-linux/bin/container-runtime-linux',
    'mach-o',
    62_586_368,
    '9528b7c70f5f84a3318ed5616d20bd5247af9672502cae6278f6ea52b2d69369',
    { signingIdentifier: 'com.apple.container.container-runtime-linux' },
  ),
  artifact(
    '/usr/local/libexec/container/plugins/container-runtime-linux/config.toml',
    'static',
    198,
    'd609af652f3e0224cb7f0cef315f873081506d010d2d1a8ff33508980e3427a7',
  ),
  artifact(
    '/usr/local/libexec/container/plugins/k8s/bin/k8s',
    'mach-o',
    63_530_128,
    '80fec989cc35dd43935156cce81d786e5348446e195c7820a538f9b71f5567f5',
    { signingIdentifier: 'com.apple.container.k8s' },
  ),
  artifact(
    '/usr/local/libexec/container/plugins/k8s/config.toml',
    'static',
    92,
    '4b190947dd6fdadb9463b0210d19c25b1d086ddff00a0685027d29e99facab95',
  ),
  artifact(
    '/usr/local/libexec/container/plugins/k8s/resources/kindnet.yaml',
    'static',
    3_057,
    '9bb5cbeb75c07664b438a6dd3bb8f038e024cdebca3d945c5d02da5f2f2f781a',
  ),
  artifact(
    '/usr/local/libexec/container/plugins/machine-apiserver/bin/machine-apiserver',
    'mach-o',
    62_482_528,
    '94424e93d4a0f10cfcf6297d7d1d5a302eebc789b1c9449df2250062cb912659',
    { signingIdentifier: 'com.apple.container.machine-apiserver' },
  ),
  artifact(
    '/usr/local/libexec/container/plugins/machine-apiserver/config.toml',
    'static',
    281,
    '819edb0d3c20517e8a56e11a9623b3804c6821d3920da3fa66d989f766103b6a',
  ),
  artifact(
    '/usr/local/libexec/container/plugins/machine-apiserver/resources/create-user.sh',
    'static',
    1_794,
    'bdbb3ceef02861b2b270ac403aa32320db6f23a0042dfde24c6a1275eca82f7b',
    { executable: true },
  ),
  artifact(
    '/usr/local/libexec/container/plugins/machine-apiserver/resources/init',
    'static',
    2_736,
    '77a7f83faca9f8656ef129d8f91ddc4e770c80478d07b805a2530b9a902bf15a',
    { executable: true },
  ),
]);

function directory(path: string, entries: readonly string[]): Readonly<ExactDirectoryInventory> {
  return Object.freeze({ path, entries: Object.freeze([...entries].sort()) });
}

/** Dedicated plugin roots are closed inventories; unexpected plugins fail qualification. */
const EXACT_DIRECTORIES: readonly Readonly<ExactDirectoryInventory>[] = Object.freeze([
  directory('/usr/local/libexec/container', ['plugins']),
  directory('/usr/local/libexec/container/plugins', [
    'container-core-images',
    'container-network-vmnet',
    'container-runtime-linux',
    'k8s',
    'machine-apiserver',
  ]),
  directory('/usr/local/libexec/container/plugins/container-core-images', ['bin', 'config.toml']),
  directory('/usr/local/libexec/container/plugins/container-core-images/bin', ['container-core-images']),
  directory('/usr/local/libexec/container/plugins/container-network-vmnet', ['bin', 'config.toml']),
  directory('/usr/local/libexec/container/plugins/container-network-vmnet/bin', ['container-network-vmnet']),
  directory('/usr/local/libexec/container/plugins/container-runtime-linux', ['bin', 'config.toml']),
  directory('/usr/local/libexec/container/plugins/container-runtime-linux/bin', ['container-runtime-linux']),
  directory('/usr/local/libexec/container/plugins/k8s', ['bin', 'config.toml', 'resources']),
  directory('/usr/local/libexec/container/plugins/k8s/bin', ['k8s']),
  directory('/usr/local/libexec/container/plugins/k8s/resources', ['kindnet.yaml']),
  directory('/usr/local/libexec/container/plugins/machine-apiserver', [
    'bin',
    'config.toml',
    'resources',
  ]),
  directory('/usr/local/libexec/container/plugins/machine-apiserver/bin', ['machine-apiserver']),
  directory('/usr/local/libexec/container/plugins/machine-apiserver/resources', [
    'create-user.sh',
    'init',
  ]),
]);

export interface AppleContainerInstallPayloadFileStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly size: number | bigint;
  readonly mode: number | bigint;
  readonly uid: number | bigint;
  readonly gid: number | bigint;
  readonly nlink: number | bigint;
  readonly mtimeNs?: number | bigint;
  readonly ctimeNs?: number | bigint;
  readonly mtimeMs?: number | bigint;
  readonly ctimeMs?: number | bigint;
}

export interface AppleContainerInstallPayloadFingerprint {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mode: number;
  readonly uid: string;
  readonly gid: string;
  readonly nlink: string;
  readonly mtime: string;
  readonly ctime: string;
}

export interface AppleContainerMachOSignatureIdentity {
  readonly valid: boolean;
  readonly teamIdentifier: string;
  readonly signingIdentifier: string;
}

export interface AppleContainerInstallPayloadDependencies {
  lstat(path: string): Promise<AppleContainerInstallPayloadFileStat>;
  realpath(path: string): Promise<string>;
  sha256File(
    path: string,
    expected: AppleContainerInstallPayloadFingerprint,
  ): Promise<string>;
  readDirectory(
    path: string,
    expected: AppleContainerInstallPayloadFingerprint,
  ): Promise<readonly string[]>;
  verifyMachOSignature(
    path: string,
    expectedFile: AppleContainerInstallPayloadFingerprint,
    expectedIdentity: Readonly<{
      teamIdentifier: typeof APPLE_CONTAINER_TEAM_IDENTIFIER;
      signingIdentifier: string;
    }>,
  ): Promise<AppleContainerMachOSignatureIdentity>;
}

export interface AppleContainerInstallPayloadOptions {
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
}

export interface AppleContainerInstallPayloadProof {
  readonly version: typeof APPLE_CONTAINER_INSTALL_PAYLOAD_PROOF_VERSION;
  readonly kind: 'apple-container-install-payload';
  readonly release: typeof APPLE_CONTAINER_INSTALL_PAYLOAD_RELEASE;
  readonly scope: 'identity-only';
  readonly result: 'verified';
  readonly ready: false;
}

export type AppleContainerInstallPayloadErrorCode =
  | 'APPLE_CONTAINER_INSTALL_PAYLOAD_PLATFORM_UNSUPPORTED'
  | 'APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED';

export class AppleContainerInstallPayloadError extends Error {
  constructor(readonly code: AppleContainerInstallPayloadErrorCode) {
    // Never reflect an artifact path, hash, signing identity, stat, or command output.
    super(code);
    this.name = 'AppleContainerInstallPayloadError';
  }
}

function fail(code: AppleContainerInstallPayloadErrorCode): never {
  throw new AppleContainerInstallPayloadError(code);
}

function asNonnegativeBigInt(value: number | bigint): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
  }
  return BigInt(value);
}

function statTime(
  nanoseconds: number | bigint | undefined,
  milliseconds: number | bigint | undefined,
): string {
  if (nanoseconds !== undefined) return `ns:${asNonnegativeBigInt(nanoseconds)}`;
  if (milliseconds !== undefined) return `ms:${asNonnegativeBigInt(milliseconds)}`;
  return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
}

function fingerprint(
  info: AppleContainerInstallPayloadFileStat,
): Readonly<AppleContainerInstallPayloadFingerprint> {
  const mode = asNonnegativeBigInt(info.mode);
  if (mode > 0o177777n) return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
  return Object.freeze({
    dev: asNonnegativeBigInt(info.dev).toString(),
    ino: asNonnegativeBigInt(info.ino).toString(),
    size: asNonnegativeBigInt(info.size).toString(),
    mode: Number(mode),
    uid: asNonnegativeBigInt(info.uid).toString(),
    gid: asNonnegativeBigInt(info.gid).toString(),
    nlink: asNonnegativeBigInt(info.nlink).toString(),
    mtime: statTime(info.mtimeNs, info.mtimeMs),
    ctime: statTime(info.ctimeNs, info.ctimeMs),
  });
}

function sameFingerprint(
  left: AppleContainerInstallPayloadFingerprint,
  right: AppleContainerInstallPayloadFingerprint,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.mtime === right.mtime
    && left.ctime === right.ctime;
}

function pathChain(path: string): readonly string[] {
  if (!isAbsolute(path) || normalize(path) !== path || path.normalize('NFC') !== path) {
    return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
  }
  const chain: string[] = [];
  let cursor = path;
  while (true) {
    chain.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return chain.reverse();
}

async function inspectPath(
  path: string,
  leafKind: 'file' | 'directory',
  dependencies: AppleContainerInstallPayloadDependencies,
  expectedSize?: number,
  executable = false,
): Promise<Readonly<AppleContainerInstallPayloadFingerprint>> {
  const chain = pathChain(path);
  let leaf: Readonly<AppleContainerInstallPayloadFingerprint> | null = null;
  for (let index = 0; index < chain.length; index += 1) {
    const component = chain[index];
    if (component === undefined) return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
    let info: AppleContainerInstallPayloadFileStat;
    let canonical: string;
    try {
      [info, canonical] = await Promise.all([
        dependencies.lstat(component),
        dependencies.realpath(component),
      ]);
    } catch {
      return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
    }
    const observed = fingerprint(info);
    const isLeaf = index === chain.length - 1;
    if (canonical !== component
      || info.isSymbolicLink()
      || observed.uid !== '0'
      || observed.gid !== '0'
      || (observed.mode & 0o022) !== 0
      || (!isLeaf && !info.isDirectory())
      || (isLeaf && leafKind === 'directory' && !info.isDirectory())
      || (isLeaf && leafKind === 'file' && (
        !info.isFile()
        || observed.nlink !== '1'
        || expectedSize === undefined
        || observed.size !== String(expectedSize)
        || expectedSize < 1
        || expectedSize > MAX_PAYLOAD_FILE_BYTES
        || (executable && (observed.mode & 0o111) === 0
      )))) {
      return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
    }
    if (isLeaf) leaf = observed;
  }
  return leaf ?? fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
}

function exactDirectoryEntries(value: readonly string[], expected: readonly string[]): boolean {
  if (!Array.isArray(value) || value.length > MAX_DIRECTORY_ENTRIES) return false;
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string'
      || entry.length < 1
      || entry === '.'
      || entry === '..'
      || entry.normalize('NFC') !== entry
      || /[\/\0\r\n]/.test(entry)
      || Buffer.byteLength(entry, 'utf8') > MAX_DIRECTORY_ENTRY_BYTES
      || seen.has(entry)) return false;
    seen.add(entry);
    normalized.push(entry);
  }
  normalized.sort();
  return normalized.length === expected.length
    && normalized.every((entry, index) => entry === expected[index]);
}

function assertManifestMatchesRuntimeRelease(): void {
  if (INSTALL_ARTIFACTS.length !== APPLE_CONTAINER_INSTALL_PAYLOAD_FILE_COUNT
    || INSTALL_ARTIFACTS.filter(value => value.kind === 'mach-o').length
      !== APPLE_CONTAINER_INSTALL_PAYLOAD_MACHO_COUNT
    || INSTALL_ARTIFACTS.filter(value => value.kind === 'static').length
      !== APPLE_CONTAINER_INSTALL_PAYLOAD_STATIC_COUNT
    || new Set(INSTALL_ARTIFACTS.map(value => value.path)).size !== INSTALL_ARTIFACTS.length) {
    return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
  }
  for (const entry of INSTALL_ARTIFACTS) {
    if (pathChain(entry.path).length < 4
      || entry.size < 1
      || entry.size > MAX_PAYLOAD_FILE_BYTES
      || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || (entry.kind === 'mach-o') !== (entry.signingIdentifier !== undefined)) {
      return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
    }
  }
  const release = APPLE_CONTAINER_TESTED_RELEASES.find(candidate =>
    candidate.version === APPLE_CONTAINER_INSTALL_PAYLOAD_RELEASE
      && candidate.sourceCommit === APPLE_CONTAINER_INSTALL_PAYLOAD_SOURCE_COMMIT
      && candidate.teamIdentifier === APPLE_CONTAINER_TEAM_IDENTIFIER);
  const cli = INSTALL_ARTIFACTS.find(entry => entry.path === '/usr/local/bin/container');
  const apiServer = INSTALL_ARTIFACTS.find(
    entry => entry.path === '/usr/local/bin/container-apiserver',
  );
  if (!release || !cli || !apiServer
    || release.cli.path !== cli.path
    || release.cli.sha256 !== cli.sha256
    || release.cli.signingIdentifier !== cli.signingIdentifier
    || release.apiServer.path !== apiServer.path
    || release.apiServer.sha256 !== apiServer.sha256
    || release.apiServer.signingIdentifier !== apiServer.signingIdentifier) {
    return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
  }
}

async function verifyExactDirectory(
  inventory: Readonly<ExactDirectoryInventory>,
  dependencies: AppleContainerInstallPayloadDependencies,
): Promise<Readonly<AppleContainerInstallPayloadFingerprint>> {
  const before = await inspectPath(inventory.path, 'directory', dependencies);
  let entries: readonly string[];
  try {
    entries = await dependencies.readDirectory(inventory.path, before);
  } catch {
    return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
  }
  if (!exactDirectoryEntries(entries, inventory.entries)) {
    return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
  }
  const after = await inspectPath(inventory.path, 'directory', dependencies);
  if (!sameFingerprint(before, after)) {
    return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
  }
  return after;
}

async function verifyArtifact(
  artifactIdentity: Readonly<AppleContainerInstallArtifact>,
  dependencies: AppleContainerInstallPayloadDependencies,
): Promise<Readonly<AppleContainerInstallPayloadFingerprint>> {
  const before = await inspectPath(
    artifactIdentity.path,
    'file',
    dependencies,
    artifactIdentity.size,
    artifactIdentity.executable,
  );
  let sha256: string;
  try {
    sha256 = await dependencies.sha256File(artifactIdentity.path, before);
  } catch {
    return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
  }
  if (sha256 !== artifactIdentity.sha256) {
    return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
  }
  if (artifactIdentity.kind === 'mach-o') {
    const signingIdentifier = artifactIdentity.signingIdentifier;
    if (signingIdentifier === undefined) return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
    let signature: AppleContainerMachOSignatureIdentity;
    try {
      signature = await dependencies.verifyMachOSignature(
        artifactIdentity.path,
        before,
        Object.freeze({
          teamIdentifier: APPLE_CONTAINER_TEAM_IDENTIFIER,
          signingIdentifier,
        }),
      );
    } catch {
      return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
    }
    if (signature === null
      || typeof signature !== 'object'
      || signature.valid !== true
      || signature.teamIdentifier !== APPLE_CONTAINER_TEAM_IDENTIFIER
      || signature.signingIdentifier !== signingIdentifier) {
      return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
    }
  }
  const after = await inspectPath(
    artifactIdentity.path,
    'file',
    dependencies,
    artifactIdentity.size,
    artifactIdentity.executable,
  );
  if (!sameFingerprint(before, after)) {
    return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
  }
  return after;
}

function strictUtf8(value: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
  }
}

function runCodesign(args: readonly string[]): Promise<Readonly<{ stdout: string; stderr: string }>> {
  return new Promise((resolveRun, rejectRun) => {
    execFile(CODESIGN_PATH, [...args], {
      cwd: '/',
      encoding: 'buffer',
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      killSignal: 'SIGKILL',
      maxBuffer: CODESIGN_MAX_OUTPUT_BYTES,
      shell: false,
      timeout: CODESIGN_TIMEOUT_MS,
      windowsHide: true,
    }, (cause, stdout, stderr) => {
      if (cause) {
        rejectRun(new Error('codesign verification failed'));
        return;
      }
      try {
        resolveRun(Object.freeze({
          stdout: strictUtf8(Buffer.from(stdout)),
          stderr: strictUtf8(Buffer.from(stderr)),
        }));
      } catch {
        rejectRun(new Error('codesign output invalid'));
      }
    });
  });
}

function codesignRequirement(signingIdentifier: string): string {
  return `=anchor apple generic and certificate leaf[subject.OU] = "${APPLE_CONTAINER_TEAM_IDENTIFIER}" and identifier "${signingIdentifier}"`;
}

function parseCodesignIdentity(output: string): Readonly<AppleContainerMachOSignatureIdentity> {
  const identifiers = output.split('\n').filter(line => line.startsWith('Identifier='));
  const teams = output.split('\n').filter(line => line.startsWith('TeamIdentifier='));
  if (identifiers.length !== 1 || teams.length !== 1) {
    return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
  }
  return Object.freeze({
    valid: true,
    signingIdentifier: identifiers[0]!.slice('Identifier='.length),
    teamIdentifier: teams[0]!.slice('TeamIdentifier='.length),
  });
}

async function defaultSha256File(
  path: string,
  expected: AppleContainerInstallPayloadFingerprint,
): Promise<string> {
  const descriptor = await nodeOpen(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const beforeInfo = await descriptor.stat({ bigint: true });
    const before = fingerprint(beforeInfo);
    if (!beforeInfo.isFile()
      || !sameFingerprint(before, expected)
      || beforeInfo.size < 1n
      || beforeInfo.size > BigInt(MAX_PAYLOAD_FILE_BYTES)) {
      return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let offset = 0n;
    while (offset < beforeInfo.size) {
      const remaining = beforeInfo.size - offset;
      const length = Number(remaining > BigInt(buffer.byteLength)
        ? BigInt(buffer.byteLength)
        : remaining);
      const { bytesRead } = await descriptor.read(buffer, 0, length, Number(offset));
      if (bytesRead < 1) return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
      hash.update(buffer.subarray(0, bytesRead));
      offset += BigInt(bytesRead);
    }
    const after = fingerprint(await descriptor.stat({ bigint: true }));
    if (!sameFingerprint(before, after)) {
      return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
    }
    return hash.digest('hex');
  } finally {
    await descriptor.close();
  }
}

const defaultDependencies: AppleContainerInstallPayloadDependencies = {
  lstat: async path => nodeLstat(path, { bigint: true }),
  realpath: nodeRealpath,
  sha256File: defaultSha256File,
  readDirectory: async (path, expected) => {
    const before = fingerprint(await nodeLstat(path, { bigint: true }));
    if (!sameFingerprint(before, expected)) {
      return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
    }
    const entries = await nodeReaddir(path);
    const after = fingerprint(await nodeLstat(path, { bigint: true }));
    if (!sameFingerprint(before, after)) {
      return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
    }
    return Object.freeze(entries);
  },
  verifyMachOSignature: async (path, _expectedFile, expectedIdentity) => {
    await runCodesign([
      '--verify',
      '--strict',
      '-R',
      codesignRequirement(expectedIdentity.signingIdentifier),
      path,
    ]);
    const details = await runCodesign(['-d', '--verbose=4', path]);
    return parseCodesignIdentity(`${details.stdout}\n${details.stderr}`);
  },
};

function publicProof(): Readonly<AppleContainerInstallPayloadProof> {
  return Object.freeze({
    version: APPLE_CONTAINER_INSTALL_PAYLOAD_PROOF_VERSION,
    kind: 'apple-container-install-payload',
    release: APPLE_CONTAINER_INSTALL_PAYLOAD_RELEASE,
    scope: 'identity-only',
    result: 'verified',
    ready: false,
  });
}

/**
 * Verifies all 17 regular files and the closed, dedicated plugin directory
 * inventory. It performs no install, service, image, VM, container, or canary
 * mutation. All failures collapse to stable non-reflective error codes.
 */
export async function verifyAppleContainerInstallPayload(
  options: AppleContainerInstallPayloadOptions = {},
  dependencies: AppleContainerInstallPayloadDependencies = defaultDependencies,
): Promise<Readonly<AppleContainerInstallPayloadProof>> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== 'darwin' || arch !== 'arm64') {
    return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_PLATFORM_UNSUPPORTED');
  }
  try {
    assertManifestMatchesRuntimeRelease();
    const directoryFingerprints = new Map<string, AppleContainerInstallPayloadFingerprint>();
    for (const inventory of EXACT_DIRECTORIES) {
      directoryFingerprints.set(
        inventory.path,
        await verifyExactDirectory(inventory, dependencies),
      );
    }
    const artifactFingerprints = new Map<string, AppleContainerInstallPayloadFingerprint>();
    for (const artifactIdentity of INSTALL_ARTIFACTS) {
      artifactFingerprints.set(
        artifactIdentity.path,
        await verifyArtifact(artifactIdentity, dependencies),
      );
    }

    // Close the cross-artifact race window: every file and dedicated directory
    // must retain the exact identity observed after its individual verification.
    for (const artifactIdentity of INSTALL_ARTIFACTS) {
      const expected = artifactFingerprints.get(artifactIdentity.path);
      const observed = await inspectPath(
        artifactIdentity.path,
        'file',
        dependencies,
        artifactIdentity.size,
        artifactIdentity.executable,
      );
      if (!expected || !sameFingerprint(expected, observed)) {
        return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
      }
    }
    for (const inventory of EXACT_DIRECTORIES) {
      const expected = directoryFingerprints.get(inventory.path);
      if (!expected) return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
      const observed = await verifyExactDirectory(inventory, dependencies);
      if (!sameFingerprint(expected, observed)) {
        return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
      }
    }
    return publicProof();
  } catch (cause) {
    if (cause instanceof AppleContainerInstallPayloadError) throw cause;
    return fail('APPLE_CONTAINER_INSTALL_PAYLOAD_UNVERIFIED');
  }
}
