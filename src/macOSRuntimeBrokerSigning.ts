import { execFile } from 'node:child_process';
import { lstat as nodeLstat, realpath as nodeRealpath } from 'node:fs/promises';

export const MACOS_RUNTIME_BROKER_SIGNING_PROOF_VERSION = 2 as const;
export const MACOS_RUNTIME_BROKER_CODESIGN_PATH = '/usr/bin/codesign' as const;
export const MACOS_RUNTIME_BROKER_APP_IDENTIFIER = 'com.intenet.agentstozbycs' as const;
export const MACOS_RUNTIME_BROKER_IDENTIFIER =
  'com.intenet.agentstozbycs.runtime-broker' as const;
export const MACOS_RUNTIME_BROKER_APP_BUNDLE_PATH =
  '/Applications/AgentsToZ_byCS.app' as const;
export const MACOS_RUNTIME_BROKER_APP_EXECUTABLE_PATH =
  '/Applications/AgentsToZ_byCS.app/Contents/MacOS/app' as const;
export const MACOS_RUNTIME_BROKER_EXECUTABLE_PATH =
  '/Applications/AgentsToZ_byCS.app/Contents/Library/LaunchServices/com.intenet.agentstozbycs.runtime-broker' as const;
export const MACOS_RUNTIME_BROKER_CLIENT_ENTITLEMENT =
  'com.intenet.agentstozbycs.runtime-broker.client' as const;
export const MACOS_RUNTIME_BROKER_SERVICE_ENTITLEMENT =
  'com.intenet.agentstozbycs.runtime-broker.service' as const;
export const MACOS_RUNTIME_BROKER_DEVELOPER_ID_APPLICATION_OID =
  '1.2.840.113635.100.6.1.13' as const;
export const MACOS_RUNTIME_BROKER_DEVELOPER_ID_ISSUER_OID =
  '1.2.840.113635.100.6.2.6' as const;
export const MACOS_RUNTIME_BROKER_CLIENT_ENTITLEMENT_VALUE = 'client-v1' as const;
export const MACOS_RUNTIME_BROKER_SERVICE_ENTITLEMENT_VALUE = 'service-v1' as const;
/** Replaced only in the build-private scratch copy used by source-pin tests. */
const MACOS_RUNTIME_BROKER_GENERATED_TEAM_IDENTIFIER: string | null = null;
/**
 * Bun's production sidecar compiler replaces this identifier with the Team ID
 * obtained from the private-key canary. Development builds leave it undefined.
 * Neither path reads argv or the environment at runtime, and this diagnostic
 * pin is never sufficient to authorize the broker channel by itself.
 */
declare const __AGENTSTOZ_MACOS_RUNTIME_PRODUCTION_TEAM_IDENTIFIER__: string | undefined;
export const MACOS_RUNTIME_BROKER_PRODUCTION_TEAM_IDENTIFIER: string | null =
  typeof __AGENTSTOZ_MACOS_RUNTIME_PRODUCTION_TEAM_IDENTIFIER__ === 'string'
    ? __AGENTSTOZ_MACOS_RUNTIME_PRODUCTION_TEAM_IDENTIFIER__
    : MACOS_RUNTIME_BROKER_GENERATED_TEAM_IDENTIFIER;
export const MACOS_RUNTIME_BROKER_CODESIGN_TIMEOUT_MS = 5_000 as const;
export const MACOS_RUNTIME_BROKER_CODESIGN_MAX_OUTPUT_BYTES = 64 * 1024;

const HARDENED_RUNTIME_CODE_DIRECTORY_FLAG = 0x1_0000n;
const AD_HOC_CODE_DIRECTORY_FLAG = 0x2n;
const MAX_TEAM_IDENTIFIER_BYTES = 10;

export type MacOSRuntimeBrokerSigningMode =
  | 'production'
  | 'development-ad-hoc'
  | 'unavailable';

export type MacOSRuntimeBrokerSigningResult =
  | 'snapshot-verified'
  | 'development-only'
  | 'not-verified';

export type MacOSRuntimeBrokerSigningReason =
  | 'static-signature-snapshot-verified'
  | 'development-ad-hoc-signing'
  | 'platform-unsupported'
  | 'app-bundle-missing'
  | 'app-executable-missing'
  | 'broker-helper-missing'
  | 'bundle-path-unverified'
  | 'signature-unverified'
  | 'signing-mode-mismatch'
  | 'production-team-unconfigured'
  | 'production-team-unverified'
  | 'developer-id-unverified'
  | 'hardened-runtime-required'
  | 'secure-timestamp-required'
  | 'channel-entitlement-unverified';

/**
 * A verified value is deliberately not a containment-readiness capability.
 * It proves only the code-signing half of a future authenticated broker
 * channel; ownership, launchd state, protocol authorization, cleanup and the
 * detached-descendant canary remain independent gates.
 */
export interface MacOSRuntimeBrokerSigningProof {
  readonly schemaVersion: typeof MACOS_RUNTIME_BROKER_SIGNING_PROOF_VERSION;
  readonly kind: 'macos-runtime-broker-signing';
  readonly scope: 'static-signature-snapshot-only';
  readonly mode: MacOSRuntimeBrokerSigningMode;
  readonly result: MacOSRuntimeBrokerSigningResult;
  readonly reason: MacOSRuntimeBrokerSigningReason;
  /** Path-based static inspection is never a live authorization decision. */
  readonly authoritative: false;
  /** A snapshot must never be cached as a capability or registry/TCB input. */
  readonly reusable: false;
  readonly ready: false;
}

export interface MacOSRuntimeBrokerSigningFileStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly mode: number | bigint;
  readonly size: number | bigint;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly uid: number | bigint;
  readonly gid: number | bigint;
  readonly nlink: number | bigint;
  readonly ctimeMs: number | bigint;
}

export interface MacOSRuntimeBrokerCodesignResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
}

export interface MacOSRuntimeBrokerSigningDependencies {
  lstat(path: string): Promise<MacOSRuntimeBrokerSigningFileStat>;
  realpath(path: string): Promise<string>;
  /** The implementation must execute only /usr/bin/codesign, without a shell. */
  runCodesign(
    args: readonly string[],
    options: {
      readonly timeoutMs: number;
      readonly maxOutputBytes: number;
      readonly env: Readonly<Record<string, string>>;
    },
  ): Promise<MacOSRuntimeBrokerCodesignResult>;
}

export interface MacOSRuntimeBrokerSigningOptions {
  readonly platform?: NodeJS.Platform;
}

/** Explicitly test-only injection surface; production callers must not use it. */
export interface MacOSRuntimeBrokerSigningTestOptions
  extends MacOSRuntimeBrokerSigningOptions {
  readonly testOnlyPinnedProductionTeamIdentifier?: string;
}

interface ParsedSignature {
  readonly mode: 'production' | 'development-ad-hoc';
  readonly teamIdentifier: string | null;
  readonly hardenedRuntime: boolean;
  readonly hasSecureTimestamp: boolean;
  readonly authorities: readonly string[];
  readonly entitlements: ReadonlyMap<string, string>;
  readonly cdHash: string;
}

interface FixedPathSnapshot {
  readonly path: string;
  readonly kind: 'directory' | 'file';
  readonly fingerprint: string;
}

interface PlistNode {
  readonly name: string;
  text: string;
  readonly children: PlistNode[];
}

class SigningPreflightFailure extends Error {
  constructor(readonly reason: MacOSRuntimeBrokerSigningReason) {
    super(reason);
    this.name = 'SigningPreflightFailure';
  }
}

function fail(reason: MacOSRuntimeBrokerSigningReason): never {
  throw new SigningPreflightFailure(reason);
}

function proof(
  mode: MacOSRuntimeBrokerSigningMode,
  result: MacOSRuntimeBrokerSigningResult,
  reason: MacOSRuntimeBrokerSigningReason,
): Readonly<MacOSRuntimeBrokerSigningProof> {
  return Object.freeze({
    schemaVersion: MACOS_RUNTIME_BROKER_SIGNING_PROOF_VERSION,
    kind: 'macos-runtime-broker-signing',
    scope: 'static-signature-snapshot-only',
    mode,
    result,
    reason,
    authoritative: false,
    reusable: false,
    ready: false,
  });
}

function unavailable(reason: MacOSRuntimeBrokerSigningReason) {
  return proof('unavailable', 'not-verified', reason);
}

function isMissingPathError(cause: unknown): boolean {
  if (cause === null || typeof cause !== 'object') return false;
  const code = (cause as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function numeric(value: number | bigint): bigint {
  if (typeof value === 'bigint') return value;
  if (!Number.isSafeInteger(value) || value < 0) return fail('bundle-path-unverified');
  return BigInt(value);
}

async function verifyFixedPath(
  path: string,
  kind: 'directory' | 'file',
  missingReason: MacOSRuntimeBrokerSigningReason,
  dependencies: MacOSRuntimeBrokerSigningDependencies,
): Promise<Readonly<FixedPathSnapshot>> {
  let stat: MacOSRuntimeBrokerSigningFileStat;
  let canonical: string;
  try {
    stat = await dependencies.lstat(path);
    canonical = await dependencies.realpath(path);
  } catch (cause) {
    if (isMissingPathError(cause)) return fail(missingReason);
    return fail('bundle-path-unverified');
  }
  if (stat.isSymbolicLink()
    || (kind === 'file' ? !stat.isFile() : !stat.isDirectory())
    || canonical !== path) {
    return fail('bundle-path-unverified');
  }
  const mode = numeric(stat.mode);
  if ((mode & 0o6022n) !== 0n) return fail('bundle-path-unverified');
  if (kind === 'file') {
    const size = numeric(stat.size);
    if (size < 1n
      || (mode & 0o111n) === 0n
      || (mode & 0o6000n) !== 0n
      || numeric(stat.nlink) !== 1n) {
      return fail('bundle-path-unverified');
    }
  }
  const fingerprint = [
    numeric(stat.dev),
    numeric(stat.ino),
    numeric(stat.uid),
    numeric(stat.gid),
    numeric(stat.mode),
    numeric(stat.nlink),
    numeric(stat.size),
    numeric(stat.ctimeMs),
  ].join(':');
  return Object.freeze({ path, kind, fingerprint });
}

async function reverifyFixedPath(
  snapshot: Readonly<FixedPathSnapshot>,
  dependencies: MacOSRuntimeBrokerSigningDependencies,
): Promise<void> {
  const current = await verifyFixedPath(
    snapshot.path,
    snapshot.kind,
    'bundle-path-unverified',
    dependencies,
  );
  if (current.fingerprint !== snapshot.fingerprint) {
    return fail('bundle-path-unverified');
  }
}

function boundedOutput(result: MacOSRuntimeBrokerCodesignResult): string {
  if (result.exitCode !== 0
    || result.timedOut
    || result.outputTruncated
    || typeof result.stdout !== 'string'
    || typeof result.stderr !== 'string') {
    return fail('signature-unverified');
  }
  const bytes = Buffer.byteLength(result.stdout, 'utf8')
    + Buffer.byteLength(result.stderr, 'utf8');
  if (bytes > MACOS_RUNTIME_BROKER_CODESIGN_MAX_OUTPUT_BYTES
    || result.stdout.includes('\0')
    || result.stderr.includes('\0')) {
    return fail('signature-unverified');
  }
  return `${result.stdout}\n${result.stderr}`;
}

async function codesign(
  args: readonly string[],
  dependencies: MacOSRuntimeBrokerSigningDependencies,
): Promise<string> {
  let result: MacOSRuntimeBrokerCodesignResult;
  try {
    result = await dependencies.runCodesign(Object.freeze([...args]), Object.freeze({
      timeoutMs: MACOS_RUNTIME_BROKER_CODESIGN_TIMEOUT_MS,
      maxOutputBytes: MACOS_RUNTIME_BROKER_CODESIGN_MAX_OUTPUT_BYTES,
      env: Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }),
    }));
  } catch {
    return fail('signature-unverified');
  }
  return boundedOutput(result);
}

function exactLine(output: string, prefix: string): string {
  const matches = output
    .split(/\r?\n/u)
    .filter(line => line.startsWith(prefix));
  if (matches.length !== 1) return fail('signature-unverified');
  const value = matches[0]!.slice(prefix.length);
  if (value.length < 1 || Buffer.byteLength(value, 'utf8') > 1_024) {
    return fail('signature-unverified');
  }
  return value;
}

function codeDirectoryFlags(output: string): bigint {
  const lines = output
    .split(/\r?\n/u)
    .filter(line => line.startsWith('CodeDirectory '));
  if (lines.length !== 1) return fail('signature-unverified');
  const match = /(?:^|\s)flags=0x([0-9a-fA-F]+)(?:\([^\r\n]*\))?(?:\s|$)/u.exec(lines[0]!);
  if (match === null) return fail('signature-unverified');
  try {
    return BigInt(`0x${match[1]!}`);
  } catch {
    return fail('signature-unverified');
  }
}

function decodeXmlText(value: string): string {
  const decoded = value.replace(
    /&(?:amp|lt|gt|quot|apos);/gu,
    entity => ({
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&apos;': "'",
    })[entity]!,
  );
  if (decoded.includes('&')) return fail('channel-entitlement-unverified');
  return decoded;
}

function parsePlistXml(xml: string): PlistNode {
  let source = xml.trim();
  source = source.replace(
    /^<\?xml version="1\.0" encoding="UTF-8"\?>\s*/u,
    '',
  );
  source = source.replace(
    /^<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "https?:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">\s*/u,
    '',
  );

  const allowed = new Set([
    'plist', 'dict', 'array', 'key', 'string', 'true', 'false',
    'integer', 'real', 'data', 'date',
  ]);
  const stack: PlistNode[] = [];
  let root: PlistNode | null = null;
  let offset = 0;
  const tokenPattern = /<[^>]+>|[^<]+/gu;
  for (const match of source.matchAll(tokenPattern)) {
    if (match.index !== offset) return fail('channel-entitlement-unverified');
    offset += match[0].length;
    const token = match[0];
    if (!token.startsWith('<')) {
      const parent = stack.at(-1);
      if (parent === undefined) {
        if (token.trim().length !== 0) return fail('channel-entitlement-unverified');
      } else if (parent.name === 'key' || parent.name === 'string'
        || parent.name === 'integer' || parent.name === 'real'
        || parent.name === 'data' || parent.name === 'date') {
        parent.text += token;
      } else if (token.trim().length !== 0) {
        return fail('channel-entitlement-unverified');
      }
      continue;
    }

    const close = /^<\/([a-z]+)>$/u.exec(token);
    if (close !== null) {
      const current = stack.pop();
      if (current === undefined || current.name !== close[1]) {
        return fail('channel-entitlement-unverified');
      }
      continue;
    }

    const selfClosing = /^<(true|false)\s*\/>$/u.exec(token);
    if (selfClosing !== null) {
      const node: PlistNode = { name: selfClosing[1]!, text: '', children: [] };
      const parent = stack.at(-1);
      if (parent === undefined) {
        if (root !== null) return fail('channel-entitlement-unverified');
        root = node;
      } else {
        parent.children.push(node);
      }
      continue;
    }

    const open = /^<([a-z]+)(?: version="1\.0")?>$/u.exec(token);
    if (open === null || !allowed.has(open[1]!)) {
      return fail('channel-entitlement-unverified');
    }
    if (open[1] === 'plist' && token !== '<plist version="1.0">') {
      return fail('channel-entitlement-unverified');
    }
    if (open[1] !== 'plist' && token !== `<${open[1]}>`) {
      return fail('channel-entitlement-unverified');
    }
    const node: PlistNode = { name: open[1]!, text: '', children: [] };
    const parent = stack.at(-1);
    if (parent === undefined) {
      if (root !== null) return fail('channel-entitlement-unverified');
      root = node;
    } else {
      parent.children.push(node);
    }
    stack.push(node);
  }
  if (offset !== source.length || stack.length !== 0 || root === null) {
    return fail('channel-entitlement-unverified');
  }
  return root;
}

function topLevelEntitlements(output: string): ReadonlyMap<string, string> {
  const xmlStart = output.indexOf('<?xml');
  const plistStart = output.indexOf('<plist');
  const start = xmlStart >= 0 ? xmlStart : plistStart;
  const endMarker = '</plist>';
  const end = output.indexOf(endMarker, start);
  const firstPlist = output.indexOf('<plist', start);
  const secondPlist = output.indexOf('<plist', firstPlist + '<plist'.length);
  if (start < 0 || firstPlist < 0 || end < 0
    || (secondPlist >= 0 && secondPlist < end)) {
    return fail('channel-entitlement-unverified');
  }
  const root = parsePlistXml(output.slice(start, end + endMarker.length));
  if (root.name !== 'plist' || root.children.length !== 1) {
    return fail('channel-entitlement-unverified');
  }
  const dictionary = root.children[0]!;
  if (dictionary.name !== 'dict' || dictionary.children.length % 2 !== 0) {
    return fail('channel-entitlement-unverified');
  }
  const result = new Map<string, string>();
  for (let index = 0; index < dictionary.children.length; index += 2) {
    const keyNode = dictionary.children[index]!;
    const valueNode = dictionary.children[index + 1]!;
    if (keyNode.name !== 'key' || keyNode.children.length !== 0) {
      return fail('channel-entitlement-unverified');
    }
    const key = decodeXmlText(keyNode.text);
    if (key.length < 1 || key.length > 256 || result.has(key)) {
      return fail('channel-entitlement-unverified');
    }
    if (valueNode.children.length !== 0) {
      return fail('channel-entitlement-unverified');
    }
    if (valueNode.name === 'true' || valueNode.name === 'false') {
      if (valueNode.text.trim().length !== 0) {
        return fail('channel-entitlement-unverified');
      }
      result.set(key, `boolean:${valueNode.name}`);
    } else if (valueNode.name === 'string') {
      result.set(key, `string:${decodeXmlText(valueNode.text)}`);
    } else {
      return fail('channel-entitlement-unverified');
    }
  }
  return result;
}

function parseSignature(
  output: string,
  expectedPath: string,
  expectedIdentifier: string,
  expectedFormat: string,
): ParsedSignature {
  if (exactLine(output, 'Executable=') !== expectedPath
    || exactLine(output, 'Identifier=') !== expectedIdentifier
    || exactLine(output, 'Format=') !== expectedFormat
    || exactLine(output, 'Hash type=') !== 'sha256 size=32') {
    return fail('signature-unverified');
  }
  const cdHash = exactLine(output, 'CandidateCDHashFull sha256=');
  if (!/^[a-f0-9]{64}$/u.test(cdHash)) return fail('signature-unverified');
  const flags = codeDirectoryFlags(output);
  const signatureLines = output
    .split(/\r?\n/u)
    .filter(line => /^Signature(?:=| )/u.test(line));
  const teamValue = exactLine(output, 'TeamIdentifier=');
  const adHoc = signatureLines.length === 1
    && signatureLines[0] === 'Signature=adhoc'
    && teamValue === 'not set'
    && (flags & AD_HOC_CODE_DIRECTORY_FLAG) !== 0n;
  if (adHoc) {
    return Object.freeze({
      mode: 'development-ad-hoc',
      teamIdentifier: null,
      hardenedRuntime: (flags & HARDENED_RUNTIME_CODE_DIRECTORY_FLAG) !== 0n,
      hasSecureTimestamp: false,
      authorities: Object.freeze([]),
      entitlements: topLevelEntitlements(output),
      cdHash,
    });
  }
  if (signatureLines.length !== 1
    || !/^Signature size=[1-9][0-9]*$/u.test(signatureLines[0]!)
    || signatureLines.some(line => line === 'Signature=adhoc')
    || teamValue === 'not set'
    || (flags & AD_HOC_CODE_DIRECTORY_FLAG) !== 0n) {
    return fail('signature-unverified');
  }
  const timestamps = output
    .split(/\r?\n/u)
    .filter(line => line.startsWith('Timestamp='))
    .map(line => line.slice('Timestamp='.length));
  const authorities = output
    .split(/\r?\n/u)
    .filter(line => line.startsWith('Authority='))
    .map(line => line.slice('Authority='.length));
  return Object.freeze({
    mode: 'production',
    teamIdentifier: teamValue,
    hardenedRuntime: (flags & HARDENED_RUNTIME_CODE_DIRECTORY_FLAG) !== 0n,
    hasSecureTimestamp: timestamps.length === 1
      && timestamps[0]!.length > 0
      && !/^(?:none|not set)$/iu.test(timestamps[0]!),
    authorities: Object.freeze(authorities),
    entitlements: topLevelEntitlements(output),
    cdHash,
  });
}

function validPinnedTeamIdentifier(value: string | undefined): value is string {
  if (value === undefined
    || Buffer.byteLength(value, 'utf8') !== MAX_TEAM_IDENTIFIER_BYTES
    || !/^[A-Z0-9]{10}$/u.test(value)
    || /^([A-Z0-9])\1{9}$/u.test(value)) {
    return false;
  }
  return !new Set([
    'ABCDEFGHIJ', '1234567890', 'TEAMID1234', 'YOURTEAMID', 'XXXXXXXXXX',
  ]).has(value);
}

function verifyDeveloperIdAuthority(
  signature: ParsedSignature,
  expectedTeamIdentifier: string,
): void {
  if (signature.authorities.length !== 3
    || signature.authorities[1] !== 'Developer ID Certification Authority'
    || signature.authorities[2] !== 'Apple Root CA') {
    return fail('developer-id-unverified');
  }
  const leaf = /^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/u
    .exec(signature.authorities[0]!);
  if (leaf === null || leaf[1] !== expectedTeamIdentifier) {
    return fail('developer-id-unverified');
  }
}

function requireRoleEntitlement(
  signature: ParsedSignature,
  required: string,
  requiredValue: string,
): void {
  if (signature.entitlements.size !== 1
    || signature.entitlements.get(required) !== `string:${requiredValue}`) {
    return fail('channel-entitlement-unverified');
  }
}

function developerIdRequirement(identifier: string, teamIdentifier: string): string {
  return `=anchor apple generic and certificate 1[field.${MACOS_RUNTIME_BROKER_DEVELOPER_ID_ISSUER_OID}] exists and certificate leaf[field.${MACOS_RUNTIME_BROKER_DEVELOPER_ID_APPLICATION_OID}] exists and certificate leaf[subject.OU] = "${teamIdentifier}" and identifier "${identifier}"`;
}

async function inspectSignature(
  path: string,
  identifier: string,
  expectedFormat: string,
  dependencies: MacOSRuntimeBrokerSigningDependencies,
): Promise<ParsedSignature> {
  await codesign([
    '--verify', '--strict', '--all-architectures', '--verbose=4', path,
  ], dependencies);
  const details = await codesign([
    '--display', '--verbose=4', '--entitlements', '-', '--xml', path,
  ], dependencies);
  return parseSignature(details, path, identifier, expectedFormat);
}

async function verifyProductionRequirement(
  path: string,
  identifier: string,
  teamIdentifier: string,
  dependencies: MacOSRuntimeBrokerSigningDependencies,
): Promise<void> {
  try {
    await codesign([
      '--verify',
      '--strict',
      '--all-architectures',
      '--verbose=4',
      '-R',
      developerIdRequirement(identifier, teamIdentifier),
      path,
    ], dependencies);
  } catch {
    return fail('developer-id-unverified');
  }
}

async function verifyWholeAppBundle(
  dependencies: MacOSRuntimeBrokerSigningDependencies,
): Promise<void> {
  await codesign([
    '--verify',
    '--deep',
    '--strict',
    '--all-architectures',
    '--verbose=4',
    MACOS_RUNTIME_BROKER_APP_BUNDLE_PATH,
  ], dependencies);
}

function strictUtf8(value: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw new Error('codesign output invalid');
  }
}

async function defaultRunCodesign(
  args: readonly string[],
  options: {
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly env: Readonly<Record<string, string>>;
  },
): Promise<MacOSRuntimeBrokerCodesignResult> {
  return new Promise(resolveRun => {
    execFile(MACOS_RUNTIME_BROKER_CODESIGN_PATH, [...args], {
      cwd: '/',
      encoding: 'buffer',
      env: { ...options.env },
      killSignal: 'SIGKILL',
      maxBuffer: options.maxOutputBytes,
      shell: false,
      timeout: options.timeoutMs,
      windowsHide: true,
    }, (cause, stdout, stderr) => {
      if (cause) {
        resolveRun(Object.freeze({
          exitCode: typeof cause.code === 'number' ? cause.code : null,
          stdout: '',
          stderr: '',
          timedOut: cause.killed === true,
          outputTruncated: cause.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        }));
        return;
      }
      try {
        const stdoutText = strictUtf8(Buffer.from(stdout));
        const stderrText = strictUtf8(Buffer.from(stderr));
        const outputTruncated = Buffer.byteLength(stdoutText, 'utf8')
          + Buffer.byteLength(stderrText, 'utf8') > options.maxOutputBytes;
        resolveRun(Object.freeze({
          exitCode: 0,
          stdout: outputTruncated ? '' : stdoutText,
          stderr: outputTruncated ? '' : stderrText,
          timedOut: false,
          outputTruncated,
        }));
      } catch {
        resolveRun(Object.freeze({
          exitCode: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          outputTruncated: true,
        }));
      }
    });
  });
}

const defaultDependencies: MacOSRuntimeBrokerSigningDependencies = Object.freeze({
  lstat: async (path: string) => nodeLstat(path, { bigint: true }),
  realpath: nodeRealpath,
  runCodesign: defaultRunCodesign,
});

/**
 * Performs a read-only, fail-closed static signing snapshot. No result from
 * this function can enable the agent runtime; the snapshot is explicitly
 * non-authoritative/non-reusable and `ready` is literally typed as false.
 * Production authorization belongs to the native SMAppService + public live
 * XPC peer-requirement channel and broker-owned TCB proof.
 */
async function verifyMacOSRuntimeBrokerSigningSnapshot(
  platform: NodeJS.Platform,
  pinnedProductionTeamIdentifier: string | null | undefined,
  dependencies: MacOSRuntimeBrokerSigningDependencies,
): Promise<Readonly<MacOSRuntimeBrokerSigningProof>> {
  if (platform !== 'darwin') {
    return unavailable('platform-unsupported');
  }
  try {
    const bundleSnapshot = await verifyFixedPath(
      MACOS_RUNTIME_BROKER_APP_BUNDLE_PATH,
      'directory',
      'app-bundle-missing',
      dependencies,
    );
    const appSnapshot = await verifyFixedPath(
      MACOS_RUNTIME_BROKER_APP_EXECUTABLE_PATH,
      'file',
      'app-executable-missing',
      dependencies,
    );
    const brokerSnapshot = await verifyFixedPath(
      MACOS_RUNTIME_BROKER_EXECUTABLE_PATH,
      'file',
      'broker-helper-missing',
      dependencies,
    );

    await verifyWholeAppBundle(dependencies);
    await Promise.all([
      reverifyFixedPath(bundleSnapshot, dependencies),
      reverifyFixedPath(appSnapshot, dependencies),
      reverifyFixedPath(brokerSnapshot, dependencies),
    ]);
    const app = await inspectSignature(
      MACOS_RUNTIME_BROKER_APP_EXECUTABLE_PATH,
      MACOS_RUNTIME_BROKER_APP_IDENTIFIER,
      'app bundle with Mach-O thin (arm64)',
      dependencies,
    );
    await reverifyFixedPath(appSnapshot, dependencies);
    const broker = await inspectSignature(
      MACOS_RUNTIME_BROKER_EXECUTABLE_PATH,
      MACOS_RUNTIME_BROKER_IDENTIFIER,
      'Mach-O thin (arm64)',
      dependencies,
    );
    await reverifyFixedPath(brokerSnapshot, dependencies);

    if (app.mode !== broker.mode) return unavailable('signing-mode-mismatch');
    if (app.mode === 'development-ad-hoc') {
      return proof(
        'development-ad-hoc',
        'development-only',
        'development-ad-hoc-signing',
      );
    }

    const pinnedTeam = pinnedProductionTeamIdentifier ?? undefined;
    if (!validPinnedTeamIdentifier(pinnedTeam)) {
      return unavailable('production-team-unconfigured');
    }
    if (app.teamIdentifier !== pinnedTeam || broker.teamIdentifier !== pinnedTeam) {
      return unavailable('production-team-unverified');
    }
    verifyDeveloperIdAuthority(app, pinnedTeam);
    verifyDeveloperIdAuthority(broker, pinnedTeam);
    if (!app.hardenedRuntime || !broker.hardenedRuntime) {
      return unavailable('hardened-runtime-required');
    }
    if (!app.hasSecureTimestamp || !broker.hasSecureTimestamp) {
      return unavailable('secure-timestamp-required');
    }
    requireRoleEntitlement(
      app,
      MACOS_RUNTIME_BROKER_CLIENT_ENTITLEMENT,
      MACOS_RUNTIME_BROKER_CLIENT_ENTITLEMENT_VALUE,
    );
    requireRoleEntitlement(
      broker,
      MACOS_RUNTIME_BROKER_SERVICE_ENTITLEMENT,
      MACOS_RUNTIME_BROKER_SERVICE_ENTITLEMENT_VALUE,
    );
    await verifyProductionRequirement(
      MACOS_RUNTIME_BROKER_APP_EXECUTABLE_PATH,
      MACOS_RUNTIME_BROKER_APP_IDENTIFIER,
      pinnedTeam,
      dependencies,
    );
    await reverifyFixedPath(appSnapshot, dependencies);
    await verifyProductionRequirement(
      MACOS_RUNTIME_BROKER_EXECUTABLE_PATH,
      MACOS_RUNTIME_BROKER_IDENTIFIER,
      pinnedTeam,
      dependencies,
    );
    await Promise.all([
      reverifyFixedPath(bundleSnapshot, dependencies),
      reverifyFixedPath(appSnapshot, dependencies),
      reverifyFixedPath(brokerSnapshot, dependencies),
    ]);
    // cdHash is intentionally parsed and constrained above, but never exposed
    // as a reusable capability. The native broker TCB proof will bind hashes.
    if (app.cdHash === broker.cdHash) return unavailable('signature-unverified');
    return proof(
      'production',
      'snapshot-verified',
      'static-signature-snapshot-verified',
    );
  } catch (cause) {
    if (cause instanceof SigningPreflightFailure) return unavailable(cause.reason);
    return unavailable('signature-unverified');
  }
}

export async function verifyMacOSRuntimeBrokerSigningPreflight(
  options: MacOSRuntimeBrokerSigningOptions = {},
): Promise<Readonly<MacOSRuntimeBrokerSigningProof>> {
  return verifyMacOSRuntimeBrokerSigningSnapshot(
    options.platform ?? process.platform,
    MACOS_RUNTIME_BROKER_PRODUCTION_TEAM_IDENTIFIER,
    defaultDependencies,
  );
}

/**
 * Dependency and Team-ID injection exists solely for deterministic unit tests.
 * Its result is still non-authoritative, non-reusable and never ready.
 */
export async function verifyMacOSRuntimeBrokerSigningPreflightForTest(
  options: MacOSRuntimeBrokerSigningTestOptions,
  dependencies: MacOSRuntimeBrokerSigningDependencies,
): Promise<Readonly<MacOSRuntimeBrokerSigningProof>> {
  return verifyMacOSRuntimeBrokerSigningSnapshot(
    options.platform ?? process.platform,
    options.testOnlyPinnedProductionTeamIdentifier,
    dependencies,
  );
}
