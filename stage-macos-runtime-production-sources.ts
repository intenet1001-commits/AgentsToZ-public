import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveMacOSRuntimeProductionBuildIdentity,
  type MacOSRuntimeProductionBuildIdentityResolution,
} from './src/macOSRuntimeProductionCanary';
import { generateMacOSRuntimeProductionPinnedSources } from './src/macOSRuntimeProductionSourcePin';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const nativePackageRoot = join(projectRoot, 'src-tauri', 'native', 'macos-runtime');
const scratchPrefix = 'agentstoz-runtime-production-sources-';

const swiftContractRelative = join(
  'Sources',
  'RuntimeBrokerProtocol',
  'Contract.swift',
);
const swiftSelfTestRelative = join(
  'Sources',
  'RuntimeBrokerProtocolSelfTest',
  'main.swift',
);

export interface MacOSRuntimeProductionSourceStage {
  readonly schemaVersion: 1;
  readonly kind: 'macos-runtime-production-source-stage';
  readonly scratchRoot: string;
  readonly packageRoot: string;
  readonly objectiveCClientBridgePath: string;
  readonly typescriptSigningProbePath: string;
  readonly pinnedSourceDigest: string;
  readonly sourceFilesPinned: 4;
  readonly repositoryModified: false;
  readonly productionArtifactBuilt: false;
  readonly productionArtifactSigned: false;
  readonly authoritative: false;
  readonly reusable: false;
  readonly ready: false;
}

export interface MacOSRuntimeProductionSourceStageOptions {
  readonly sourcePackageRoot: string;
  readonly typescriptSigningProbePath: string;
  readonly scratchParent: string;
}

function exactDirectory(path: string): string {
  const canonical = realpathSync(path);
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== path) {
    throw new Error('macOS runtime production source directory rejected');
  }
  return canonical;
}

function assertContained(parent: string, candidate: string): void {
  const value = relative(resolve(parent), resolve(candidate));
  if (value === '' || value === '..' || value.startsWith(`..${sep}`)) {
    throw new Error('macOS runtime production source path escaped scratch root');
  }
}

function exactSourceFile(path: string): void {
  const metadata = lstatSync(path);
  if (!metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || realpathSync(path) !== path) {
    throw new Error('macOS runtime production source file rejected');
  }
}

function copySourceFile(source: string, destination: string): void {
  exactSourceFile(source);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
  chmodSync(destination, 0o400);
}

function copySourceTree(sourceRoot: string, destinationRoot: string): void {
  exactDirectory(sourceRoot);
  mkdirSync(destinationRoot, { mode: 0o700 });
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    const source = join(sourceRoot, entry.name);
    const destination = join(destinationRoot, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error('macOS runtime production source symlink rejected');
    }
    if (entry.isDirectory()) {
      copySourceTree(source, destination);
    } else if (entry.isFile()) {
      copySourceFile(source, destination);
    } else {
      throw new Error('macOS runtime production source entry rejected');
    }
  }
}

function sha256(values: readonly string[]): string {
  const hash = createHash('sha256');
  for (const value of values) {
    const bytes = Buffer.from(value, 'utf8');
    const size = Buffer.allocUnsafe(8);
    size.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(size);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function overwritePinnedSource(path: string, value: string): void {
  exactSourceFile(path);
  chmodSync(path, 0o600);
  writeFileSync(path, value, { encoding: 'utf8' });
  chmodSync(path, 0o400);
}

export function stageMacOSRuntimeProductionSourcesForTest(
  resolution: Readonly<MacOSRuntimeProductionBuildIdentityResolution>,
  options: Readonly<MacOSRuntimeProductionSourceStageOptions>,
): Readonly<MacOSRuntimeProductionSourceStage> {
  const sourcePackage = exactDirectory(options.sourcePackageRoot);
  const scratchParent = exactDirectory(options.scratchParent);
  exactSourceFile(options.typescriptSigningProbePath);
  const sourcePackageName = basename(sourcePackage);
  if (sourcePackageName !== 'macos-runtime') {
    throw new Error('macOS runtime production package name rejected');
  }

  const originalSwiftContract = readFileSync(
    join(sourcePackage, swiftContractRelative),
    'utf8',
  );
  const originalSwiftSelfTest = readFileSync(
    join(sourcePackage, swiftSelfTestRelative),
    'utf8',
  );
  const originalObjectiveC = readFileSync(
    join(sourcePackage, 'ClientBridge', 'RuntimeBrokerClientBridge.m'),
    'utf8',
  );
  const originalTypescript = readFileSync(options.typescriptSigningProbePath, 'utf8');
  // Validate the canary result and all four checked-in sentinels before the
  // first filesystem mutation. A rejected identity creates no scratch tree.
  const pinned = generateMacOSRuntimeProductionPinnedSources(resolution, {
    swiftContract: originalSwiftContract,
    swiftProtocolSelfTest: originalSwiftSelfTest,
    objectiveCClientBridge: originalObjectiveC,
    typescriptSigningProbe: originalTypescript,
  });

  const scratchRoot = realpathSync(mkdtempSync(join(scratchParent, scratchPrefix)));
  const stagedPackage = join(scratchRoot, 'macos-runtime');
  const generatedRoot = join(scratchRoot, 'Generated');
  assertContained(scratchRoot, stagedPackage);
  assertContained(scratchRoot, generatedRoot);
  try {
    mkdirSync(generatedRoot, { mode: 0o700 });
    copySourceFile(join(sourcePackage, 'Package.swift'), join(stagedPackage, 'Package.swift'));
    copySourceTree(join(sourcePackage, 'Sources'), join(stagedPackage, 'Sources'));
    copySourceTree(join(sourcePackage, 'Config'), join(stagedPackage, 'Config'));
    copySourceTree(join(sourcePackage, 'ClientBridge'), join(stagedPackage, 'ClientBridge'));

    const stagedSwiftContract = join(stagedPackage, swiftContractRelative);
    const stagedSwiftSelfTest = join(stagedPackage, swiftSelfTestRelative);
    const stagedObjectiveC = join(generatedRoot, 'RuntimeBrokerClientBridge.m');
    const stagedTypescript = join(generatedRoot, 'macOSRuntimeBrokerSigning.ts');
    for (const path of [
      stagedSwiftContract,
      stagedSwiftSelfTest,
      stagedObjectiveC,
      stagedTypescript,
    ]) {
      assertContained(scratchRoot, path);
    }
    overwritePinnedSource(stagedSwiftContract, pinned.swiftContract);
    overwritePinnedSource(stagedSwiftSelfTest, pinned.swiftProtocolSelfTest);
    writeFileSync(stagedObjectiveC, pinned.objectiveCClientBridge, {
      encoding: 'utf8',
      mode: 0o400,
    });
    writeFileSync(stagedTypescript, pinned.typescriptSigningProbe, {
      encoding: 'utf8',
      mode: 0o400,
    });
    const digest = sha256([
      pinned.swiftContract,
      pinned.swiftProtocolSelfTest,
      pinned.objectiveCClientBridge,
      pinned.typescriptSigningProbe,
    ]);
    return Object.freeze({
      schemaVersion: 1,
      kind: 'macos-runtime-production-source-stage',
      scratchRoot,
      packageRoot: stagedPackage,
      objectiveCClientBridgePath: stagedObjectiveC,
      typescriptSigningProbePath: stagedTypescript,
      pinnedSourceDigest: digest,
      sourceFilesPinned: 4,
      repositoryModified: false,
      productionArtifactBuilt: false,
      productionArtifactSigned: false,
      authoritative: false,
      reusable: false,
      ready: false,
    });
  } catch (cause) {
    rmSync(scratchRoot, { recursive: true, force: true });
    throw cause;
  }
}

export function removeMacOSRuntimeProductionSourceStage(
  stage: Readonly<MacOSRuntimeProductionSourceStage>,
  scratchParent = realpathSync(tmpdir()),
): void {
  const parent = exactDirectory(scratchParent);
  const canonicalRoot = realpathSync(stage.scratchRoot);
  if (dirname(canonicalRoot) !== parent
    || !basename(canonicalRoot).startsWith(scratchPrefix)
    || stage.packageRoot !== join(canonicalRoot, 'macos-runtime')
    || stage.objectiveCClientBridgePath
      !== join(canonicalRoot, 'Generated', 'RuntimeBrokerClientBridge.m')
    || stage.typescriptSigningProbePath
      !== join(canonicalRoot, 'Generated', 'macOSRuntimeBrokerSigning.ts')) {
    throw new Error('macOS runtime production source cleanup rejected');
  }
  rmSync(canonicalRoot, { recursive: true, force: false });
}

export async function stageMacOSRuntimeProductionSources(): Promise<
  Readonly<MacOSRuntimeProductionSourceStage>
> {
  const resolution = await resolveMacOSRuntimeProductionBuildIdentity();
  return stageMacOSRuntimeProductionSourcesForTest(resolution, {
    sourcePackageRoot: realpathSync(nativePackageRoot),
    typescriptSigningProbePath: realpathSync(
      join(projectRoot, 'src', 'macOSRuntimeBrokerSigning.ts'),
    ),
    scratchParent: realpathSync(tmpdir()),
  });
}
