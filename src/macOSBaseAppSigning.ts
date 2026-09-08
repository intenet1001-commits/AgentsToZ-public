import { createHash } from 'node:crypto';
import { closeSync, createReadStream, lstatSync, openSync, readSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { MacOSRuntimeProductionBuildIdentityResolution } from './macOSRuntimeProductionCanary';
import { validMacOSRuntimeProductionIdentity } from './macOSRuntimeProductionSigningPlan';
import { runMacOSAppCodesign, type MacOSRuntimeProductionAppSigningExecutorDependencies } from './macOSRuntimeProductionAppSigningExecutor';
import {
  MACOS_RUNTIME_BROKER_APP_IDENTIFIER,
  MACOS_RUNTIME_BROKER_DEVELOPER_ID_APPLICATION_OID,
  MACOS_RUNTIME_BROKER_DEVELOPER_ID_ISSUER_OID,
} from './macOSRuntimeBrokerSigning';
import {
  MACOS_RUNTIME_PRODUCTION_API_SIDECAR_IDENTIFIER,
  MACOS_RUNTIME_PRODUCTION_USE_MCP_IDENTIFIER,
  MACOS_RUNTIME_PRODUCTION_GUARD_IDENTIFIER,
} from './macOSRuntimeProductionAppSigningPlan';

export const MACOS_BASE_EMPTY_ENTITLEMENTS = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict/></plist>\n';
const RESOURCE_ROOT = 'Contents/Resources/resources/';
export const MACOS_BASE_CODE = Object.freeze([
  { path: RESOURCE_ROOT + 'agentstoz-api-sidecar', identifier: MACOS_RUNTIME_PRODUCTION_API_SIDECAR_IDENTIFIER },
  { path: RESOURCE_ROOT + 'agentstoz-use-mcp', identifier: MACOS_RUNTIME_PRODUCTION_USE_MCP_IDENTIFIER },
  { path: RESOURCE_ROOT + 'agentstoz-agent-runtime-guard', identifier: MACOS_RUNTIME_PRODUCTION_GUARD_IDENTIFIER },
  { path: 'Contents/MacOS/app', identifier: MACOS_RUNTIME_BROKER_APP_IDENTIFIER },
].map(code => Object.freeze(code)));
// Deliberately exact: a new template or native executable needs a reviewed policy change.
export const MACOS_BASE_REQUIRED_FILES = Object.freeze([
  ...MACOS_BASE_CODE.map(code => code.path),
  'Contents/Info.plist', 'Contents/Resources/icon.icns',
  RESOURCE_ROOT + 'windows-process-supervisor.ps1',
  ...['memory-status', 'memory-start', 'memory-stop', 'project-start', 'memory-unlink',
    'project-from-memory', 'project-clone', 'memory-link', 'remember-session', 'hermes-open', 'memory-sync']
    .map(name => `${RESOURCE_ROOT}templates/hermes/${name}/SKILL.md`),
  RESOURCE_ROOT + 'templates/hermes-plugin/agentstoz-memory-menu/__init__.py',
  RESOURCE_ROOT + 'templates/hermes-plugin/agentstoz-memory-menu/plugin.yaml',
]);
const OPTIONAL_FILES = ['Contents/_CodeSignature/CodeResources', 'Contents/PkgInfo'];

function canonicalPath(path: string): boolean {
  return isAbsolute(path) && resolve(path) === path && !/[\u0000-\u001F\u007F]/u.test(path);
}

/** No fixture, privileged helper, symlink, wildcard resource or extra Mach-O can be sealed. */
export function inspectMacOSBaseBundle(app: string): readonly string[] {
  if (!canonicalPath(app) || !app.endsWith('/AgentsToZ_byCS.app')
    || realpathSync(app) !== app || !lstatSync(app).isDirectory()) throw new Error('base bundle root rejected');
  const allowed = new Set([...MACOS_BASE_REQUIRED_FILES, ...OPTIONAL_FILES]);
  const found: string[] = [];
  let totalBytes = 0;
  function walk(relative: string): void {
    const entries = readdirSync(join(app, relative), { withFileTypes: true });
    if (entries.length > 64) throw new Error('base bundle inventory limit exceeded');
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      const full = join(app, path);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink() || realpathSync(full) !== full) throw new Error('base bundle link rejected');
      if (stat.isDirectory()) {
        if (![...allowed].some(file => file.startsWith(path + '/'))) throw new Error('base bundle directory rejected');
        walk(path);
      } else {
        if (!stat.isFile() || !allowed.has(path) || stat.size > 512 * 1024 * 1024) throw new Error('base bundle file rejected');
        totalBytes += stat.size;
        if (totalBytes > 2 * 1024 * 1024 * 1024) throw new Error('base bundle size rejected');
        found.push(path);
      }
    }
  }
  walk('');
  if (MACOS_BASE_REQUIRED_FILES.some(path => !found.includes(path))) throw new Error('base bundle file missing');
  for (const code of MACOS_BASE_CODE) {
    const fd = openSync(join(app, code.path), 'r');
    try {
      const header = Buffer.alloc(8);
      if (readSync(fd, header, 0, 8, 0) !== 8 || header.readUInt32LE(0) !== 0xfeedfacf
        || header.readUInt32LE(4) !== 0x0100000c) throw new Error('base executable requires thin arm64 Mach-O');
    } finally { closeSync(fd); }
  }
  return Object.freeze(found.sort());
}

export interface MacOSBaseSigningCommand {
  readonly operation: 'sign' | 'verify' | 'inspect';
  readonly code: typeof MACOS_BASE_CODE[number];
  readonly args: readonly string[];
}

export function planMacOSBaseAppSigning(identity: Readonly<MacOSRuntimeProductionBuildIdentityResolution>, app: string, entitlements: string): readonly MacOSBaseSigningCommand[] {
  if (!validMacOSRuntimeProductionIdentity(identity)) throw new Error('base signing identity rejected');
  if (!canonicalPath(app) || !app.endsWith('/AgentsToZ_byCS.app') || !canonicalPath(entitlements)
    || entitlements === app || entitlements.startsWith(app + '/')) throw new Error('base signing path rejected');
  const key = identity.identity!;
  return Object.freeze(MACOS_BASE_CODE.flatMap(code => {
    const target = code.path === 'Contents/MacOS/app' ? app : join(app, code.path);
    const requirement = '=anchor apple generic'
      + ` and certificate 1[field.${MACOS_RUNTIME_BROKER_DEVELOPER_ID_ISSUER_OID}] exists`
      + ` and certificate leaf[field.${MACOS_RUNTIME_BROKER_DEVELOPER_ID_APPLICATION_OID}] exists`
      + ` and certificate leaf[subject.OU] = "${key.teamIdentifier}" and identifier "${code.identifier}"`;
    return [
      { operation: 'sign' as const, code, args: ['--force', '--sign', key.certificateFingerprint, '--options', 'runtime', '--timestamp', '--identifier', code.identifier, '--entitlements', entitlements, target] },
      { operation: 'verify' as const, code, args: ['--verify', '--strict', '--all-architectures', ...(target === app ? ['--deep'] : []), '-R', requirement, target] },
      { operation: 'inspect' as const, code, args: ['--display', '--verbose=4', '--entitlements', '-', '--xml', target] },
    ].map(command => Object.freeze({ ...command, args: Object.freeze(command.args) }));
  }));
}

export function verifyMacOSBaseSignatureInspection(output: string, app: string, code: typeof MACOS_BASE_CODE[number], identity: Readonly<MacOSRuntimeProductionBuildIdentityResolution>): void {
  const lines = output.split(/\r?\n/u);
  const exact = (prefix: string): string => {
    const values = lines.filter(line => line.startsWith(prefix));
    if (values.length !== 1) throw new Error('base signature inspection rejected');
    return values[0]!.slice(prefix.length);
  };
  const key = identity.identity!;
  const isApp = code.path === 'Contents/MacOS/app';
  const flags = /(?:^|\s)flags=0x([0-9a-f]+)(?:\([^\r\n]*\))?(?:\s|$)/iu.exec(exact('CodeDirectory '));
  const flagValue = flags ? BigInt('0x' + flags[1]) : 0n;
  const authorities = lines.filter(line => line.startsWith('Authority=')).map(line => line.slice(10));
  const timestamp = exact('Timestamp=');
  const signature = lines.filter(line => /^Signature(?:=| )/u.test(line));
  // The compiled Bun computation/SQLite/file probe passes without exceptions.
  // Full sidecar and app runtime smoke remains a separate release gate. Inherited debug/JIT/broker entitlements are rejected.
  if (exact('Executable=') !== join(app, code.path) || exact('Identifier=') !== code.identifier
    || exact('Format=') !== `${isApp ? 'app bundle with ' : ''}Mach-O thin (arm64)`
    || exact('TeamIdentifier=') !== key.teamIdentifier || exact('Hash type=') !== 'sha256 size=32'
    || !/^[0-9a-f]{64}$/u.test(exact('CandidateCDHashFull sha256='))
    || signature.length !== 1 || !/^Signature size=[1-9][0-9]*$/u.test(signature[0]!)
    || authorities.join('\n') !== [key.commonName, 'Developer ID Certification Authority', 'Apple Root CA'].join('\n')
    || (flagValue & 0x10000n) === 0n || (flagValue & 2n) !== 0n
    || !timestamp || /^(?:none|not set)$/iu.test(timestamp)
    || /<key\b/u.test(output) || !/<dict\s*\/\s*>|<dict>\s*<\/dict>/u.test(output)) {
    throw new Error('base signature inspection rejected');
  }
}

export async function signMacOSBaseApp(identity: Readonly<MacOSRuntimeProductionBuildIdentityResolution>, app: string, entitlements: string,
  dependencies: MacOSRuntimeProductionAppSigningExecutorDependencies = { runCodesign: runMacOSAppCodesign }) {
  const commands = planMacOSBaseAppSigning(identity, app, entitlements);
  inspectMacOSBaseBundle(app);
  for (const command of commands) {
    if (command.operation === 'sign') {
      inspectMacOSBaseBundle(app);
      if (realpathSync(entitlements) !== entitlements || !lstatSync(entitlements).isFile()
        || readFileSync(entitlements, 'utf8') !== MACOS_BASE_EMPTY_ENTITLEMENTS) throw new Error('base entitlements rejected');
    }
    const result = await dependencies.runCodesign(command.args, {
      timeoutMs: 20_000, maxOutputBytes: 64 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    });
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.exitCode !== 0 || result.timedOut || result.outputTruncated || output.includes('\0')
      || Buffer.byteLength(output) > 64 * 1024) throw new Error(`base ${command.operation} failed`);
    if (command.operation === 'inspect') verifyMacOSBaseSignatureInspection(output, app, command.code, identity);
  }
  const files = inspectMacOSBaseBundle(app);
  const digest = createHash('sha256');
  for (const path of files) {
    const fileHash = createHash('sha256');
    for await (const chunk of createReadStream(join(app, path))) fileHash.update(chunk);
    digest.update(JSON.stringify([path, fileHash.digest('hex')]) + '\n');
  }
  return Object.freeze({ schemaVersion: 1, mode: 'developer-id-base', result: 'signed-awaiting-notarization',
    appSigned: true, nestedCodeSigned: 3, bundleDigest: digest.digest('hex'),
    enhancedRuntimeEnabled: false, notarized: false, installed: false, ready: false } as const);
}
