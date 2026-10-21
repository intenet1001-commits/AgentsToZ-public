import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  createReadStream,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { executeMacOSBaseAppPipeline } from './macOSBaseAppPipeline';
import { inspectMacOSBaseBundle } from './macOSBaseAppSigning';
import { notaryAuthArgs, type NotaryOptions } from './macOSNotaryPreflight';
import { verifyReleaseSource } from '../releaseSourceGuard';
import {
  resolveMacOSRuntimeProductionBuildIdentity,
  type MacOSRuntimeProductionBuildIdentityResolution,
} from './macOSRuntimeProductionCanary';
import { validMacOSRuntimeProductionIdentity } from './macOSRuntimeProductionSigningPlan';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const VERSION = /^[1-9][0-9]*\.0\.0$/u;

type ArtifactKind = 'app' | 'dmg';

export interface MacOSDirectDistributionOptions extends NotaryOptions {
  readonly version: string;
}

interface BaseReceipt {
  readonly mode: 'developer-id-base';
  readonly result: 'signed-awaiting-notarization';
  readonly appSigned: true;
  readonly notarized: false;
  readonly installed: false;
  readonly ready: false;
  readonly sourceSha: string;
  readonly appBundlePath: string;
  readonly bundleDigest: string;
  readonly signingIdentity: {
    readonly certificateFingerprint: string;
    readonly teamIdentifier: string;
    readonly commonName: string;
  };
}

export interface DirectDistributionPaths {
  readonly outputRoot: string;
  readonly appArchivePath: string;
  readonly dmgPath: string;
  readonly finalReceiptPath: string;
}

interface NotaryReceipt {
  readonly submissionId: string;
  readonly logSha256: string;
}

export interface MacOSDirectDistributionDependencies {
  buildBase(): Promise<BaseReceipt>;
  resolveIdentity(): Promise<Readonly<MacOSRuntimeProductionBuildIdentityResolution>>;
  revalidateSource(sourceSha: string): void;
  preparePaths(base: Readonly<BaseReceipt>, version: string): DirectDistributionPaths;
  packageApp(appPath: string, archivePath: string): Promise<void>;
  notarize(kind: ArtifactKind, artifactPath: string, outputRoot: string, options: NotaryOptions): Promise<NotaryReceipt>;
  stapleAndValidate(kind: ArtifactKind, path: string): Promise<void>;
  createDmg(appPath: string, dmgPath: string, outputRoot: string): Promise<void>;
  signAndVerifyDmg(identity: Readonly<MacOSRuntimeProductionBuildIdentityResolution>, dmgPath: string): Promise<void>;
  verifyMountedDistribution(appPath: string, dmgPath: string, outputRoot: string): Promise<{ appManifestSha256: string; appCdHash: string }>;
  hashFile(path: string): Promise<string>;
  writeFinalReceipt(path: string, receipt: Readonly<Record<string, unknown>>): void;
}

export function planMacOSNotaryCommands(input: {
  artifactPath: string;
  submissionId: string;
  logPath: string;
  authArgs: readonly string[];
}): readonly (readonly string[])[] {
  if (!canonical(input.artifactPath) || !canonical(input.logPath) || !UUID.test(input.submissionId)
    || input.authArgs.length < 2 || input.authArgs.some(value => !value || /[\u0000-\u001f\u007f]/u.test(value))) {
    throw new Error('notary command input rejected');
  }
  const auth = [...input.authArgs];
  return Object.freeze([
    Object.freeze(['notarytool', 'submit', input.artifactPath, ...auth, '--output-format', 'json', '--no-progress']),
    Object.freeze(['notarytool', 'wait', input.submissionId, ...auth, '--timeout', '30m', '--output-format', 'json', '--no-progress']),
    Object.freeze(['notarytool', 'info', input.submissionId, ...auth, '--output-format', 'json', '--no-progress']),
    Object.freeze(['notarytool', 'log', input.submissionId, input.logPath, ...auth, '--no-progress']),
  ]);
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  if (!text || text.includes('\0') || Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error(`${label} response rejected`);
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`${label} response rejected`);
  }
}

export function parseAcceptedNotaryResponse(text: string, expectedId: string): { id: string; status: 'Accepted' } {
  if (!UUID.test(expectedId)) throw new Error('notary submission id rejected');
  const value = parseJsonObject(text, 'notary');
  if (value.id !== expectedId || value.status !== 'Accepted') throw new Error('notary submission was not accepted');
  return { id: expectedId, status: 'Accepted' };
}

export function parseSubmittedNotaryResponse(text: string): { id: string; status: 'Submitted' | 'In Progress' | 'Accepted' } {
  const value = parseJsonObject(text, 'notary submit');
  if (typeof value.id !== 'string' || !UUID.test(value.id)
    || (value.status !== undefined && value.status !== 'In Progress' && value.status !== 'Accepted')) {
    throw new Error('notary submit response rejected');
  }
  return { id: value.id, status: value.status ?? 'Submitted' };
}

export function parseAcceptedNotaryLog(text: string, expectedId: string): Record<string, unknown> {
  if (!UUID.test(expectedId)) throw new Error('notary submission id rejected');
  const log = parseJsonObject(text, 'notary log');
  if (log.jobId !== expectedId || log.status !== 'Accepted'
    || (log.issues !== null && (!Array.isArray(log.issues) || log.issues.length > 0))) {
    throw new Error('notary log was not accepted');
  }
  return log;
}

function canonical(path: string): boolean {
  return isAbsolute(path) && resolve(path) === path && !/[\u0000-\u001f\u007f]/u.test(path);
}

interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

function runBounded(executable: string, args: readonly string[], timeoutMs: number): CommandResult {
  const result = spawnSync(executable, [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      HOME: process.env.HOME,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: 'C',
      LC_ALL: 'C',
    },
  });
  return {
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
  };
}

function requireSuccess(result: CommandResult, label: string): string {
  if (result.exitCode !== 0 || result.timedOut || result.stdout.includes('\0') || result.stderr.includes('\0')
    || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 4 * 1024 * 1024) {
    throw new Error(`${label} failed`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

async function sha256File(path: string): Promise<string> {
  if (!canonical(path) || realpathSync(path) !== path || !lstatSync(path).isFile()) throw new Error('artifact path rejected');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function writePrivateJson(path: string, value: unknown): void {
  if (!canonical(path) || existsSync(path)) throw new Error('receipt path rejected');
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}

async function notarizeArtifact(kind: ArtifactKind, artifactPath: string, outputRoot: string, options: NotaryOptions): Promise<NotaryReceipt> {
  if (!canonical(artifactPath) || !canonical(outputRoot) || realpathSync(outputRoot) !== outputRoot
    || !lstatSync(outputRoot).isDirectory() || realpathSync(artifactPath) !== artifactPath || !lstatSync(artifactPath).isFile()) {
    throw new Error(`${kind} notarization path rejected`);
  }
  const auth = notaryAuthArgs(options);
  const submitArgs = ['notarytool', 'submit', artifactPath, ...auth, '--output-format', 'json', '--no-progress'];
  const submitResult = runBounded('/usr/bin/xcrun', submitArgs, 10 * 60_000);
  requireSuccess(submitResult, `${kind} notary submit`);
  const submitted = parseSubmittedNotaryResponse(submitResult.stdout);
  const artifactSha256 = await sha256File(artifactPath);
  const pendingPath = join(outputRoot, `${kind}-notary-${submitted.id}.submission.json`);
  writePrivateJson(pendingPath, {
    schemaVersion: 1,
    artifact: kind,
    submissionId: submitted.id,
    submittedStatus: submitted.status,
    artifactSha256,
    accepted: false,
  });

  const logPath = join(outputRoot, `${kind}-notary-${submitted.id}.log.json`);
  const commands = planMacOSNotaryCommands({ artifactPath, submissionId: submitted.id, logPath, authArgs: auth });
  let waitResult: CommandResult;
  try {
    waitResult = runBounded('/usr/bin/xcrun', commands[1]!, 31 * 60_000);
    requireSuccess(waitResult, `${kind} notary wait; submission ${submitted.id}`);
    parseAcceptedNotaryResponse(waitResult.stdout, submitted.id);
  } catch {
    throw new Error(`${kind} notarization remains unconfirmed; submissionId=${submitted.id}`);
  }
  const infoResult = runBounded('/usr/bin/xcrun', commands[2]!, 60_000);
  requireSuccess(infoResult, `${kind} notary info`);
  parseAcceptedNotaryResponse(infoResult.stdout, submitted.id);

  if (existsSync(logPath)) throw new Error(`${kind} notary log path already exists`);
  const logResult = runBounded('/usr/bin/xcrun', commands[3]!, 60_000);
  requireSuccess(logResult, `${kind} notary log`);
  if (!existsSync(logPath) || realpathSync(logPath) !== logPath || !lstatSync(logPath).isFile()
    || lstatSync(logPath).size > 4 * 1024 * 1024) throw new Error(`${kind} notary log rejected`);
  chmodSync(logPath, 0o600);
  parseAcceptedNotaryLog(readFileSync(logPath, 'utf8'), submitted.id);
  const logSha256 = await sha256File(logPath);
  const acceptedPath = join(outputRoot, `${kind}-notary-${submitted.id}.accepted.json`);
  writePrivateJson(acceptedPath, {
    schemaVersion: 1,
    artifact: kind,
    submissionId: submitted.id,
    artifactSha256,
    logSha256,
    accepted: true,
  });
  return { submissionId: submitted.id, logSha256 };
}

function prepareDistributionPaths(base: Readonly<BaseReceipt>, version: string): DirectDistributionPaths {
  if (!VERSION.test(version) || !SOURCE_SHA.test(base.sourceSha) || !SHA256.test(base.bundleDigest) || !canonical(base.appBundlePath)
    || !base.appBundlePath.endsWith('/release/bundle/macos/AgentsToZ_byCS.app')
    || realpathSync(base.appBundlePath) !== base.appBundlePath || !lstatSync(base.appBundlePath).isDirectory()) {
    throw new Error('direct distribution base receipt rejected');
  }
  const outputRoot = dirname(dirname(dirname(dirname(base.appBundlePath))));
  if (realpathSync(outputRoot) !== outputRoot || !lstatSync(outputRoot).isDirectory()) throw new Error('distribution output root rejected');
  const versionLabel = version.split('.')[0]!;
  const paths = {
    outputRoot,
    appArchivePath: join(outputRoot, `AgentsToZ_byCS_${versionLabel}_arm64-notary.zip`),
    dmgPath: join(outputRoot, `AgentsToZ_byCS_${versionLabel}_arm64.dmg`),
    finalReceiptPath: join(outputRoot, 'direct-distribution.receipt.json'),
  };
  if (Object.values(paths).some(path => !canonical(path))
    || [paths.appArchivePath, paths.dmgPath, paths.finalReceiptPath].some(existsSync)) throw new Error('distribution output already exists');
  return Object.freeze(paths);
}

async function packageApp(appPath: string, archivePath: string): Promise<void> {
  inspectMacOSBaseBundle(appPath);
  requireSuccess(runBounded('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--all-architectures', appPath], 60_000), 'pre-archive app codesign');
  requireSuccess(runBounded('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, archivePath], 5 * 60_000), 'app notary archive');
  if (!existsSync(archivePath) || realpathSync(archivePath) !== archivePath || !lstatSync(archivePath).isFile()) throw new Error('app archive missing');
}

async function stapleAndValidate(kind: ArtifactKind, path: string): Promise<void> {
  requireSuccess(runBounded('/usr/bin/xcrun', ['stapler', 'staple', path], 5 * 60_000), `${kind} staple`);
  requireSuccess(runBounded('/usr/bin/xcrun', ['stapler', 'validate', path], 60_000), `${kind} staple validation`);
}

async function createDmg(appPath: string, dmgPath: string, outputRoot: string): Promise<void> {
  const stage = join(outputRoot, 'dmg-stage');
  if (existsSync(stage) || existsSync(dmgPath)) throw new Error('DMG staging path already exists');
  mkdirSync(stage, { mode: 0o700 });
  try {
    const stagedApp = join(stage, 'AgentsToZ_byCS.app');
    const sourceManifest = await bundleManifestDigest(appPath);
    requireSuccess(runBounded('/usr/bin/ditto', [appPath, stagedApp], 5 * 60_000), 'DMG app staging');
    requireSuccess(runBounded('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--all-architectures', stagedApp], 60_000), 'staged app codesign');
    if (await bundleManifestDigest(stagedApp) !== sourceManifest) throw new Error('staged app manifest differs from source app');
    symlinkSync('/Applications', join(stage, 'Applications'));
    requireSuccess(runBounded('/usr/bin/hdiutil', [
      'create', '-fs', 'HFS+', '-volname', 'AgentsToZ_byCS', '-srcfolder', stage,
      '-format', 'UDZO', '-ov', dmgPath,
    ], 10 * 60_000), 'DMG creation');
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  if (!existsSync(dmgPath) || realpathSync(dmgPath) !== dmgPath || !lstatSync(dmgPath).isFile()) throw new Error('DMG output missing');
}

async function bundleManifestDigest(appPath: string): Promise<string> {
  if (!canonical(appPath) || !appPath.endsWith('/AgentsToZ_byCS.app')
    || realpathSync(appPath) !== appPath || !lstatSync(appPath).isDirectory()) throw new Error('app manifest root rejected');
  const entries: Array<{ path: string; full: string; size: number }> = [];
  let totalBytes = 0;
  const walk = (relative: string): void => {
    const directory = join(appPath, relative);
    const children = readdirSync(directory, { withFileTypes: true });
    if (children.length > 256) throw new Error('app manifest directory limit exceeded');
    for (const child of children) {
      const path = relative ? `${relative}/${child.name}` : child.name;
      const full = join(appPath, path);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink() || realpathSync(full) !== full) throw new Error('app manifest link rejected');
      if (stat.isDirectory()) walk(path);
      else {
        if (!stat.isFile() || stat.size > 1024 * 1024 * 1024) throw new Error('app manifest file rejected');
        totalBytes += stat.size;
        if (totalBytes > 3 * 1024 * 1024 * 1024 || entries.length >= 2048) throw new Error('app manifest limit exceeded');
        entries.push({ path, full, size: stat.size });
      }
    }
  };
  walk('');
  const manifest = createHash('sha256');
  for (const entry of entries.sort((a, b) => a.path.localeCompare(b.path))) {
    const file = createHash('sha256');
    for await (const chunk of createReadStream(entry.full)) file.update(chunk);
    manifest.update(JSON.stringify([entry.path, entry.size, file.digest('hex')]) + '\n');
  }
  return manifest.digest('hex');
}

function verifyDmgSignatureInspection(output: string, identity: Readonly<MacOSRuntimeProductionBuildIdentityResolution>): void {
  const key = identity.identity!;
  const lines = output.split(/\r?\n/u);
  const authorities = lines.filter(line => line.startsWith('Authority=')).map(line => line.slice(10));
  const teams = lines.filter(line => line.startsWith('TeamIdentifier=')).map(line => line.slice(15));
  const timestamps = lines.filter(line => line.startsWith('Timestamp=')).map(line => line.slice(10));
  if (authorities.join('\n') !== [key.commonName, 'Developer ID Certification Authority', 'Apple Root CA'].join('\n')
    || teams.length !== 1 || teams[0] !== key.teamIdentifier || timestamps.length !== 1 || !timestamps[0]
    || /^(?:none|not set)$/iu.test(timestamps[0]!)) throw new Error('DMG signature inspection rejected');
}

async function signAndVerifyDmg(identity: Readonly<MacOSRuntimeProductionBuildIdentityResolution>, dmgPath: string): Promise<void> {
  if (!validMacOSRuntimeProductionIdentity(identity)) throw new Error('DMG signing identity rejected');
  const key = identity.identity!;
  requireSuccess(runBounded('/usr/bin/codesign', ['--force', '--sign', key.certificateFingerprint, '--timestamp', dmgPath], 60_000), 'DMG signing');
  requireSuccess(runBounded('/usr/bin/codesign', ['--verify', '--strict', '--verbose=4', dmgPath], 60_000), 'DMG signature verification');
  const inspected = requireSuccess(runBounded('/usr/bin/codesign', ['--display', '--verbose=4', dmgPath], 60_000), 'DMG signature inspection');
  verifyDmgSignatureInspection(inspected, identity);
}

function signatureIdentity(path: string): { identifier: string; team: string; cdHash: string } {
  const output = requireSuccess(runBounded('/usr/bin/codesign', ['--display', '--verbose=4', path], 60_000), 'mounted app signature inspection');
  const exact = (prefix: string, pattern: RegExp): string => {
    const values = output.split(/\r?\n/u).filter(line => line.startsWith(prefix)).map(line => line.slice(prefix.length));
    if (values.length !== 1 || !pattern.test(values[0]!)) throw new Error('mounted app signature identity rejected');
    return values[0]!;
  };
  return {
    identifier: exact('Identifier=', /^[A-Za-z0-9.-]{1,200}$/u),
    team: exact('TeamIdentifier=', /^[A-Z0-9]{10}$/u),
    cdHash: exact('CDHash=', /^[0-9a-f]{40}$/u),
  };
}

async function verifyMountedDistribution(appPath: string, dmgPath: string, outputRoot: string): Promise<{ appManifestSha256: string; appCdHash: string }> {
  const mount = join(outputRoot, 'mounted-dmg');
  if (existsSync(mount)) throw new Error('DMG mount path already exists');
  mkdirSync(mount, { mode: 0o700 });
  let attached = false;
  const sourceManifest = await bundleManifestDigest(appPath);
  const sourceIdentity = signatureIdentity(appPath);
  try {
    requireSuccess(runBounded('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmgPath], 3 * 60_000), 'DMG mount');
    attached = true;
    const mountedApp = join(mount, 'AgentsToZ_byCS.app');
    if (!existsSync(mountedApp) || !lstatSync(mountedApp).isDirectory()) throw new Error('mounted app missing');
    requireSuccess(runBounded('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--all-architectures', mountedApp], 60_000), 'mounted app codesign');
    requireSuccess(runBounded('/usr/bin/xcrun', ['stapler', 'validate', mountedApp], 60_000), 'mounted app staple validation');
    requireSuccess(runBounded('/usr/bin/xcrun', ['stapler', 'validate', dmgPath], 60_000), 'DMG staple validation');
    requireSuccess(runBounded('/usr/bin/codesign', ['--verify', '--strict', '--verbose=4', dmgPath], 60_000), 'final DMG codesign');
    requireSuccess(runBounded('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', mountedApp], 60_000), 'mounted app Gatekeeper assessment');
    requireSuccess(runBounded('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', dmgPath], 60_000), 'DMG Gatekeeper assessment');
    const mountedIdentity = signatureIdentity(mountedApp);
    if (JSON.stringify(sourceIdentity) !== JSON.stringify(mountedIdentity)) throw new Error('mounted app signature differs from source app');
    if (await bundleManifestDigest(mountedApp) !== sourceManifest) throw new Error('mounted app manifest differs from source app');
  } finally {
    if (attached) requireSuccess(runBounded('/usr/bin/hdiutil', ['detach', mount], 60_000), 'DMG detach');
    rmSync(mount, { recursive: true, force: true });
  }
  return { appManifestSha256: sourceManifest, appCdHash: sourceIdentity.cdHash };
}

function sameSigningIdentity(
  left: Readonly<BaseReceipt['signingIdentity']>,
  right: Readonly<NonNullable<MacOSRuntimeProductionBuildIdentityResolution['identity']>>,
): boolean {
  return left.certificateFingerprint === right.certificateFingerprint
    && left.teamIdentifier === right.teamIdentifier
    && left.commonName === right.commonName;
}

function revalidatePublicSource(expectedSha: string): void {
  if (!SOURCE_SHA.test(expectedSha)) throw new Error('release source SHA rejected');
  const projectRoot = realpathSync(join(import.meta.dir, '..'));
  const git = (args: string[]) => {
    const result = spawnSync('/usr/bin/git', args, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 1024 * 1024 });
    return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  const remotes = git(['remote']);
  if (remotes.exitCode !== 0 || remotes.stdout.trim() !== 'origin') throw new Error('direct distribution checkout must have only its public origin');
  const source = verifyReleaseSource({ runGit: git });
  if (source.headSha !== expectedSha || source.remoteHeadSha !== expectedSha || source.unpublishedOverride
    || !/^(?:https:\/\/github\.com\/|git@github\.com:)intenet1001-commits\/AgentsToZ-public(?:\.git)?$/u.test(source.remoteUrl)) {
    throw new Error('direct distribution source changed');
  }
}

export async function executeMacOSDirectDistributionForTest(
  options: MacOSDirectDistributionOptions,
  dependencies: MacOSDirectDistributionDependencies,
) {
  notaryAuthArgs(options);
  if (!VERSION.test(options.version)) throw new Error('distribution version rejected');
  const base = await dependencies.buildBase();
  if (base.mode !== 'developer-id-base' || base.result !== 'signed-awaiting-notarization'
    || !base.appSigned || base.notarized || base.installed || base.ready || !SOURCE_SHA.test(base.sourceSha)
    || !SHA256.test(base.bundleDigest)) {
    throw new Error('base signing receipt rejected');
  }
  const identity = await dependencies.resolveIdentity();
  if (!validMacOSRuntimeProductionIdentity(identity)) throw new Error('Developer ID identity revalidation failed');
  if (!sameSigningIdentity(base.signingIdentity, identity.identity!)) throw new Error('Developer ID identity changed after app signing');
  const paths = dependencies.preparePaths(base, options.version);
  dependencies.revalidateSource(base.sourceSha);
  await dependencies.packageApp(base.appBundlePath, paths.appArchivePath);
  const appNotary = await dependencies.notarize('app', paths.appArchivePath, paths.outputRoot, options);
  await dependencies.stapleAndValidate('app', base.appBundlePath);
  dependencies.revalidateSource(base.sourceSha);
  await dependencies.createDmg(base.appBundlePath, paths.dmgPath, paths.outputRoot);
  await dependencies.signAndVerifyDmg(identity, paths.dmgPath);
  const dmgNotary = await dependencies.notarize('dmg', paths.dmgPath, paths.outputRoot, options);
  await dependencies.stapleAndValidate('dmg', paths.dmgPath);
  const mounted = await dependencies.verifyMountedDistribution(base.appBundlePath, paths.dmgPath, paths.outputRoot);
  dependencies.revalidateSource(base.sourceSha);
  const dmgSha256 = await dependencies.hashFile(paths.dmgPath);
  if (!SHA256.test(dmgSha256) || !SHA256.test(mounted.appManifestSha256) || !/^[0-9a-f]{40}$/u.test(mounted.appCdHash)
    || !UUID.test(appNotary.submissionId) || !UUID.test(dmgNotary.submissionId)
    || !SHA256.test(appNotary.logSha256) || !SHA256.test(dmgNotary.logSha256)) throw new Error('distribution evidence rejected');
  const receipt = Object.freeze({
    schemaVersion: 1,
    mode: 'developer-id-base',
    result: 'notarized-dmg-awaiting-install-test',
    sourceSha: base.sourceSha,
    appBundleDigest: base.bundleDigest,
    version: options.version,
    architecture: 'arm64',
    appBundlePath: base.appBundlePath,
    dmgPath: paths.dmgPath,
    dmgSha256,
    appManifestSha256: mounted.appManifestSha256,
    appCdHash: mounted.appCdHash,
    appNotarySubmissionId: appNotary.submissionId,
    appNotaryLogSha256: appNotary.logSha256,
    dmgNotarySubmissionId: dmgNotary.submissionId,
    dmgNotaryLogSha256: dmgNotary.logSha256,
    appNotarized: true,
    appStapled: true,
    dmgSigned: true,
    dmgNotarized: true,
    dmgStapled: true,
    gatekeeperAssessed: true,
    installed: false,
    published: false,
    ready: false,
  } as const);
  dependencies.writeFinalReceipt(paths.finalReceiptPath, receipt);
  return receipt;
}

export async function executeMacOSDirectDistribution(options: NotaryOptions) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('direct distribution supports Apple Silicon macOS only');
  const projectRoot = realpathSync(join(import.meta.dir, '..'));
  const config = JSON.parse(readFileSync(join(projectRoot, 'src-tauri/tauri.conf.json'), 'utf8')) as { version?: unknown };
  if (typeof config.version !== 'string' || !VERSION.test(config.version)) throw new Error('release version rejected');
  return executeMacOSDirectDistributionForTest({ ...options, version: config.version }, {
    buildBase: executeMacOSBaseAppPipeline,
    resolveIdentity: resolveMacOSRuntimeProductionBuildIdentity,
    revalidateSource: revalidatePublicSource,
    preparePaths: prepareDistributionPaths,
    packageApp,
    notarize: notarizeArtifact,
    stapleAndValidate,
    createDmg,
    signAndVerifyDmg,
    verifyMountedDistribution,
    hashFile: sha256File,
    writeFinalReceipt: writePrivateJson,
  });
}
