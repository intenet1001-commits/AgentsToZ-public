import type { MacOSRuntimeProductionBuildIdentityResolution } from './macOSRuntimeProductionCanary';

const SWIFT_CONTRACT_SENTINEL =
  'public static let productionTeamIdentifier: String? = nil';
const SWIFT_SELF_TEST_IDENTITY_SENTINEL =
  'RuntimeBrokerBuildIdentity.productionTeamIdentifier == nil,';
const SWIFT_SELF_TEST_VALIDATION_SENTINEL =
  'RuntimeBrokerSecurityRequirements.validatedProductionTeamIdentifier() == nil else {';
const OBJECTIVE_C_SENTINEL =
  'static NSString *const AgentsToZProductionTeamIdentifier = nil;';
const TYPESCRIPT_SENTINEL =
  'const MACOS_RUNTIME_BROKER_GENERATED_TEAM_IDENTIFIER: string | null = null;';

export interface MacOSRuntimeProductionSourceInputs {
  readonly swiftContract: string;
  readonly swiftProtocolSelfTest: string;
  readonly objectiveCClientBridge: string;
  readonly typescriptSigningProbe: string;
}

/** Build-private generated sources. These strings contain the public Team ID. */
export interface MacOSRuntimeProductionPinnedSources {
  readonly schemaVersion: 1;
  readonly kind: 'macos-runtime-production-pinned-sources';
  readonly swiftContract: string;
  readonly swiftProtocolSelfTest: string;
  readonly objectiveCClientBridge: string;
  readonly typescriptSigningProbe: string;
  readonly sourceFilesPinned: 4;
  readonly identityFingerprintEmbedded: false;
  readonly certificateNameEmbedded: false;
  readonly runtimeAuthorityGranted: false;
}

function validTeamIdentifier(value: string): boolean {
  return /^[A-Z0-9]{10}$/u.test(value)
    && new Set(value).size > 1
    && !new Set([
      'ABCDEFGHIJ', '1234567890', 'TEAMID1234', 'YOURTEAMID', 'XXXXXXXXXX',
    ]).has(value);
}

function exactReplace(
  source: string,
  sentinel: string,
  replacement: string,
): string {
  const first = source.indexOf(sentinel);
  if (first < 0 || source.indexOf(sentinel, first + sentinel.length) >= 0) {
    throw new Error('macOS runtime production source sentinel rejected');
  }
  const result = `${source.slice(0, first)}${replacement}${source.slice(first + sentinel.length)}`;
  if (result.includes(sentinel)) {
    throw new Error('macOS runtime production source pin failed');
  }
  return result;
}

function verifiedTeamIdentifier(
  resolution: Readonly<MacOSRuntimeProductionBuildIdentityResolution>,
): string {
  const identity = resolution.identity;
  if (resolution.diagnostic.result !== 'snapshot-verified'
    || resolution.diagnostic.reason !== 'canary-snapshot-verified'
    || resolution.diagnostic.authoritative !== false
    || resolution.diagnostic.reusable !== false
    || resolution.diagnostic.ready !== false
    || identity === null
    || !validTeamIdentifier(identity.teamIdentifier)
    || !/^[0-9A-F]{40}$/u.test(identity.certificateFingerprint)
    || !new RegExp(
      `^Developer ID Application: [^\\u0000-\\u001F\\u007F]{1,300} \\(${identity.teamIdentifier}\\)$`,
      'u',
    ).test(identity.commonName)) {
    throw new Error('macOS runtime production build identity rejected');
  }
  return identity.teamIdentifier;
}

/**
 * Generates an all-or-nothing source set for a scratch build tree. It accepts
 * no raw Team ID and performs no writes; the production wrapper must obtain the
 * resolution from the private-key canary and write only into its own temp tree.
 */
export function generateMacOSRuntimeProductionPinnedSources(
  resolution: Readonly<MacOSRuntimeProductionBuildIdentityResolution>,
  sources: Readonly<MacOSRuntimeProductionSourceInputs>,
): Readonly<MacOSRuntimeProductionPinnedSources> {
  const teamIdentifier = verifiedTeamIdentifier(resolution);
  const swiftContract = exactReplace(
    sources.swiftContract,
    SWIFT_CONTRACT_SENTINEL,
    `public static let productionTeamIdentifier: String? = "${teamIdentifier}"`,
  );
  let swiftProtocolSelfTest = exactReplace(
    sources.swiftProtocolSelfTest,
    SWIFT_SELF_TEST_IDENTITY_SENTINEL,
    `RuntimeBrokerBuildIdentity.productionTeamIdentifier == "${teamIdentifier}",`,
  );
  swiftProtocolSelfTest = exactReplace(
    swiftProtocolSelfTest,
    SWIFT_SELF_TEST_VALIDATION_SENTINEL,
    `RuntimeBrokerSecurityRequirements.validatedProductionTeamIdentifier() == "${teamIdentifier}" else {`,
  );
  const objectiveCClientBridge = exactReplace(
    sources.objectiveCClientBridge,
    OBJECTIVE_C_SENTINEL,
    `static NSString *const AgentsToZProductionTeamIdentifier = @"${teamIdentifier}";`,
  );
  const typescriptSigningProbe = exactReplace(
    sources.typescriptSigningProbe,
    TYPESCRIPT_SENTINEL,
    `const MACOS_RUNTIME_BROKER_GENERATED_TEAM_IDENTIFIER: string | null = "${teamIdentifier}";`,
  );

  const generated = [
    swiftContract,
    swiftProtocolSelfTest,
    objectiveCClientBridge,
    typescriptSigningProbe,
  ];
  if (generated.some(value => value.includes(resolution.identity!.certificateFingerprint)
    || value.includes(resolution.identity!.commonName))) {
    throw new Error('macOS runtime private identity leaked into generated source');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'macos-runtime-production-pinned-sources',
    swiftContract,
    swiftProtocolSelfTest,
    objectiveCClientBridge,
    typescriptSigningProbe,
    sourceFilesPinned: 4,
    identityFingerprintEmbedded: false,
    certificateNameEmbedded: false,
    runtimeAuthorityGranted: false,
  });
}
