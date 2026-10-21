export const MACOS_RUNTIME_BROKER_FIXTURE_PROOF_VERSION = 1 as const;
export const MACOS_RUNTIME_BROKER_FIXTURE_PROTOCOL =
  'bounded-stdio-challenge-v1' as const;

export interface MacOSRuntimeBrokerFixtureProof {
  readonly schemaVersion: typeof MACOS_RUNTIME_BROKER_FIXTURE_PROOF_VERSION;
  readonly kind: 'macos-runtime-broker-harmless-fixture';
  readonly mode: 'development-same-uid';
  readonly result: 'passed';
  readonly protocol: typeof MACOS_RUNTIME_BROKER_FIXTURE_PROTOCOL;
  readonly workerIdentity: 'same-effective-user-and-group-only';
  readonly serviceRegistered: false;
  readonly accountCreated: false;
  readonly containerInvoked: false;
  readonly authoritative: false;
  readonly reusable: false;
  readonly ready: false;
}

const FIXTURE_PROOF_KEYS = Object.freeze([
  'accountCreated',
  'authoritative',
  'containerInvoked',
  'kind',
  'mode',
  'protocol',
  'ready',
  'result',
  'reusable',
  'schemaVersion',
  'serviceRegistered',
  'workerIdentity',
] as const);

function isExactRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Object.keys(value).sort();
  return keys.length === FIXTURE_PROOF_KEYS.length
    && keys.every((key, index) => key === FIXTURE_PROOF_KEYS[index]);
}

/**
 * Strictly decodes the public output of the privilege-free native fixture.
 * The proof is deliberately typed as non-authoritative, non-reusable and not
 * ready, so it cannot be promoted to an agent-runtime execution capability.
 */
export function normalizeMacOSRuntimeBrokerFixtureProof(
  value: unknown,
): Readonly<MacOSRuntimeBrokerFixtureProof> {
  if (!isExactRecord(value)
    || value.schemaVersion !== MACOS_RUNTIME_BROKER_FIXTURE_PROOF_VERSION
    || value.kind !== 'macos-runtime-broker-harmless-fixture'
    || value.mode !== 'development-same-uid'
    || value.result !== 'passed'
    || value.protocol !== MACOS_RUNTIME_BROKER_FIXTURE_PROTOCOL
    || value.workerIdentity !== 'same-effective-user-and-group-only'
    || value.serviceRegistered !== false
    || value.accountCreated !== false
    || value.containerInvoked !== false
    || value.authoritative !== false
    || value.reusable !== false
    || value.ready !== false) {
    throw new Error('macOS runtime broker fixture proof rejected');
  }
  return Object.freeze({
    schemaVersion: MACOS_RUNTIME_BROKER_FIXTURE_PROOF_VERSION,
    kind: 'macos-runtime-broker-harmless-fixture',
    mode: 'development-same-uid',
    result: 'passed',
    protocol: MACOS_RUNTIME_BROKER_FIXTURE_PROTOCOL,
    workerIdentity: 'same-effective-user-and-group-only',
    serviceRegistered: false,
    accountCreated: false,
    containerInvoked: false,
    authoritative: false,
    reusable: false,
    ready: false,
  });
}

export function parseMacOSRuntimeBrokerFixtureProofLine(
  stdout: string,
): Readonly<MacOSRuntimeBrokerFixtureProof> {
  if (Buffer.byteLength(stdout, 'utf8') > 4_096
    || !stdout.endsWith('\n')
    || stdout.slice(0, -1).includes('\n')) {
    throw new Error('macOS runtime broker fixture output rejected');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(0, -1));
  } catch {
    throw new Error('macOS runtime broker fixture output rejected');
  }
  const proof = normalizeMacOSRuntimeBrokerFixtureProof(parsed);
  const canonical = JSON.stringify(proof, [...FIXTURE_PROOF_KEYS]);
  if (stdout !== `${canonical}\n`) {
    throw new Error('macOS runtime broker fixture output rejected');
  }
  return proof;
}
