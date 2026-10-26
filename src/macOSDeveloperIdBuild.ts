/**
 * Opt-in Developer ID signing, notarization and stapling for the main macOS app:
 * `bun build-macos.ts --developer-id` (see docs/claude/build-release.md). Without the flag
 * nothing here runs and the app keeps its ad-hoc signature with the identifier-only requirement.
 *
 * Why: the identifier-only requirement can be imitated by any ad-hoc code that takes the same
 * identifier (docs/design/screen-control-2026-10-24/DESIGN.md, S0-7 and decision 1). A Developer ID
 * signature puts the Team ID anchor into the designated requirement.
 *
 * Every Mach-O in the bundle is signed inside-out with the hardened runtime, a secure timestamp and
 * only the entitlements that piece needs. An unknown Mach-O stops the build instead of being signed
 * with a guessed policy.
 */
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { MACOS_BASE_CODEX_ACCESSIBILITY_HELPER_IDENTIFIER, MACOS_BASE_KMSG_IDENTIFIER } from './macOSBaseAppSigning';
import {
  MACOS_RUNTIME_PRODUCTION_API_SIDECAR_IDENTIFIER,
  MACOS_RUNTIME_PRODUCTION_GUARD_IDENTIFIER,
  MACOS_RUNTIME_PRODUCTION_USE_MCP_IDENTIFIER,
} from './macOSRuntimeProductionAppSigningPlan';
import { resolveMacOSRuntimeProductionIdentity } from './macOSRuntimeProductionIdentity';
import { assertScreenBundleEntitlements, SCREEN_HELPER_BUNDLE_PATH, SCREEN_HELPER_IDENTIFIER, SCREEN_HELPER_REQUIREMENT } from '../stageScreenControlBundle';

export const DEVELOPER_ID_TEAM_IDENTIFIER = 'DA8QKAQ2C9';
export const DEVELOPER_ID_APP_IDENTIFIER = 'com.intenet.agentstozbycs';
/** Cargo target dir of the regular build; a Developer ID build defaults to its own sibling. */
export const DEFAULT_MACOS_TARGET_DIRNAME = 'portmanager';
export const DEVELOPER_ID_MACOS_TARGET_DIRNAME = 'portmanager-devid';
/** Environment override for the Cargo target dir of `build-macos.ts`. Must be absolute. */
export const MACOS_TARGET_DIR_ENV = 'AGENTSTOZ_CARGO_TARGET_DIR';

/** Developer ID Certification Authority (intermediate) and Developer ID Application (leaf) markers. */
const DEVELOPER_ID_CA_OID = '1.2.840.113635.100.6.2.6';
const DEVELOPER_ID_APPLICATION_OID = '1.2.840.113635.100.6.1.13';

/**
 * Entitlements by piece. Each nested executable keeps its own set; the GUI set is never applied
 * to a helper (that would widen the helper's permissions).
 *
 * - gui: microphone for the voice dock (getUserMedia in the WebView, the existing
 *   src-tauri/Voice.entitlements) and Apple Events: the app and its sidecar run osascript against
 *   Terminal, iTerm, System Events, Orca and ChatGPT. TCC attributes those events to the app, and a
 *   hardened app without this entitlement is refused without a prompt. Screen recording
 *   (screencapture) and Accessibility (kmsg, System Events keystrokes) are TCC grants with no
 *   hardened-runtime entitlement. The Mac app does not use the camera (the QR camera scanner is
 *   the phone portal) and Info.plist has no camera usage string, so there is no camera entitlement.
 * - jit: bun-compiled sidecars and the Chromium Renderer/GPU helpers (V8, SwiftShader; Chrome signs
 *   its own helpers the same way). Measured 2026-10-25 on a Developer ID + hardened-runtime copy of
 *   the runtime guard: without allow-jit JavaScriptCore silently drops to its interpreter (a hot
 *   loop took 6.15 s instead of 0.14 s) and `bun:ffi` (src/localMetadataFile.ts) throws; allow-jit
 *   alone fixes both, so allow-unsigned-executable-memory and disable-library-validation are not
 *   needed.
 * - none: everything else (kmsg, the runtime broker and fixture, the Chromium framework and its
 *   dylibs, the base/Plugin/Alerts helpers).
 */
export type DeveloperIdEntitlementKind = 'gui' | 'jit' | 'none';
export const DEVELOPER_ID_ENTITLEMENT_KEYS: Readonly<Record<DeveloperIdEntitlementKind, readonly string[]>> = Object.freeze({
  gui: Object.freeze(['com.apple.security.automation.apple-events', 'com.apple.security.device.audio-input']),
  jit: Object.freeze(['com.apple.security.cs.allow-jit']),
  none: Object.freeze([]),
});

export function developerIdEntitlementsPlist(kind: Exclude<DeveloperIdEntitlementKind, 'none'>): string {
  const body = DEVELOPER_ID_ENTITLEMENT_KEYS[kind].map(key => `<key>${key}</key><true/>`).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + `<plist version="1.0"><dict>${body}</dict></plist>\n`;
}

/** Requirement that only this team's Developer ID signature with this identifier satisfies. */
export function developerIdRequirement(identifier: string, team = DEVELOPER_ID_TEAM_IDENTIFIER): string {
  return `identifier "${identifier}" and anchor apple generic`
    + ` and certificate 1[field.${DEVELOPER_ID_CA_OID}] exists`
    + ` and certificate leaf[field.${DEVELOPER_ID_APPLICATION_OID}] exists`
    + ` and certificate leaf[subject.OU] = "${team}"`;
}

/** Any code signed by this team's Developer ID, whatever its identifier. */
export function developerIdTeamRequirement(team = DEVELOPER_ID_TEAM_IDENTIFIER): string {
  return `anchor apple generic and certificate 1[field.${DEVELOPER_ID_CA_OID}] exists`
    + ` and certificate leaf[field.${DEVELOPER_ID_APPLICATION_OID}] exists`
    + ` and certificate leaf[subject.OU] = "${team}"`;
}

/** Checks the `designated =>` line of `codesign -d -r-`: identifier plus the Team ID anchor. */
export function assertTeamAnchoredDesignatedRequirement(output: string, identifier = DEVELOPER_ID_APP_IDENTIFIER, team = DEVELOPER_ID_TEAM_IDENTIFIER): string {
  const line = output.split(/\r?\n/u).find(entry => entry.startsWith('designated => '));
  if (!line) throw new Error('codesign printed no designated requirement');
  const required = [
    `identifier "${identifier}"`,
    'anchor apple generic',
    `certificate 1[field.${DEVELOPER_ID_CA_OID}]`,
    `certificate leaf[field.${DEVELOPER_ID_APPLICATION_OID}]`,
  ];
  const teamAnchored = new RegExp(`certificate leaf\\[subject\\.OU\\] = "?${team}"?(?:\\s|$)`, 'u').test(line);
  if (!teamAnchored || required.some(part => !line.includes(part))) {
    throw new Error(`designated requirement is not anchored to Team ID ${team}: ${line}`);
  }
  return line;
}

export type DeveloperIdTargetKind = 'executable' | 'library' | 'framework' | 'helper-app' | 'screen-app' | 'app';
export interface DeveloperIdSigningTarget {
  /** Path given to codesign, relative to the app bundle ('' is the app itself). */
  readonly path: string;
  readonly kind: DeveloperIdTargetKind;
  /** Explicit identifier for a loose executable without its own Info.plist (bun names them a.out). */
  readonly identifier?: string;
  readonly entitlements: DeveloperIdEntitlementKind;
}

const RESOURCES = 'Contents/Resources/resources/';
const LAUNCH_SERVICES = 'Contents/Library/LaunchServices/';
const CEF_FRAMEWORK = 'Contents/Frameworks/Chromium Embedded Framework.framework';
const LOOSE_EXECUTABLES: Readonly<Record<string, { identifier: string; entitlements: DeveloperIdEntitlementKind }>> = Object.freeze({
  [`${RESOURCES}agentstoz-api-sidecar`]: { identifier: MACOS_RUNTIME_PRODUCTION_API_SIDECAR_IDENTIFIER, entitlements: 'jit' },
  [`${RESOURCES}agentstoz-use-mcp`]: { identifier: MACOS_RUNTIME_PRODUCTION_USE_MCP_IDENTIFIER, entitlements: 'jit' },
  [`${RESOURCES}agentstoz-agent-runtime-guard`]: { identifier: MACOS_RUNTIME_PRODUCTION_GUARD_IDENTIFIER, entitlements: 'jit' },
  [`${RESOURCES}agentstoz-kmsg`]: { identifier: MACOS_BASE_KMSG_IDENTIFIER, entitlements: 'none' },
  [`${RESOURCES}agentstoz-codex-accessibility-helper`]: { identifier: MACOS_BASE_CODEX_ACCESSIBILITY_HELPER_IDENTIFIER, entitlements: 'none' },
  [`${LAUNCH_SERVICES}com.intenet.agentstozbycs.runtime-broker`]: { identifier: 'com.intenet.agentstozbycs.runtime-broker', entitlements: 'none' },
  [`${LAUNCH_SERVICES}com.intenet.agentstozbycs.runtime-dedicated-worker-fixture`]: {
    identifier: 'com.intenet.agentstozbycs.runtime-dedicated-worker-fixture', entitlements: 'none',
  },
});
const HELPER_EXECUTABLE = /^Contents\/Frameworks\/(app Helper(?: \((GPU|Renderer|Plugin|Alerts)\))?)\.app\/Contents\/MacOS\/(.+)$/u;
const CEF_LIBRARY = new RegExp(`^${CEF_FRAMEWORK.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/Libraries/([^/]+\\.dylib)$`, 'u');

/** Maps one Mach-O found in the bundle to what codesign signs for it. */
export function classifyDeveloperIdMachO(relativePath: string): DeveloperIdSigningTarget {
  if (relativePath === 'Contents/MacOS/app') return { path: '', kind: 'app', entitlements: 'gui' };
  if (relativePath === `${SCREEN_HELPER_BUNDLE_PATH}/Contents/MacOS/AgentsToZScreen`) {
    return { path: SCREEN_HELPER_BUNDLE_PATH, kind: 'screen-app', entitlements: 'none' };
  }
  const loose = LOOSE_EXECUTABLES[relativePath];
  if (loose) return { path: relativePath, kind: 'executable', identifier: loose.identifier, entitlements: loose.entitlements };
  if (relativePath === `${CEF_FRAMEWORK}/Chromium Embedded Framework`) return { path: CEF_FRAMEWORK, kind: 'framework', entitlements: 'none' };
  if (CEF_LIBRARY.test(relativePath)) return { path: relativePath, kind: 'library', entitlements: 'none' };
  const helper = HELPER_EXECUTABLE.exec(relativePath);
  if (helper && helper[3] === helper[1]) {
    const variant = helper[2];
    return {
      path: `Contents/Frameworks/${helper[1]}.app`,
      kind: 'helper-app',
      entitlements: variant === 'Renderer' || variant === 'GPU' ? 'jit' : 'none',
    };
  }
  throw new Error(`Unplanned Mach-O in the app bundle: ${relativePath} — add it to the Developer ID signing plan (src/macOSDeveloperIdBuild.ts) with its own entitlements.`);
}

const SIGNING_ORDER: readonly DeveloperIdTargetKind[] = ['executable', 'library', 'framework', 'helper-app', 'screen-app', 'app'];

/** Inside-out order: loose executables, framework dylibs, the framework, helper apps, then the app. */
export function planDeveloperIdSigning(machOPaths: readonly string[]): readonly DeveloperIdSigningTarget[] {
  const byPath = new Map<string, DeveloperIdSigningTarget>();
  for (const path of machOPaths) {
    const target = classifyDeveloperIdMachO(path);
    byPath.set(target.path, target);
  }
  const targets = [...byPath.values()];
  if (targets.filter(target => target.kind === 'app').length !== 1) throw new Error('The app executable Contents/MacOS/app is missing.');
  const hasFramework = targets.some(target => target.kind === 'framework');
  const hasHelpers = targets.some(target => target.kind === 'helper-app');
  if (hasFramework !== hasHelpers) throw new Error('Embedded Chromium is incomplete: the framework and its helper apps must ship together.');
  return Object.freeze(targets
    .sort((a, b) => SIGNING_ORDER.indexOf(a.kind) - SIGNING_ORDER.indexOf(b.kind) || a.path.localeCompare(b.path))
    .map(target => Object.freeze(target)));
}

export interface DeveloperIdCodesignInput {
  readonly appBundlePath: string;
  readonly certificateFingerprint: string;
  readonly entitlementPaths: Readonly<Record<'gui' | 'jit', string>>;
}

export function developerIdCodesignArguments(target: DeveloperIdSigningTarget, input: DeveloperIdCodesignInput): readonly string[] {
  if (target.kind === 'screen-app') throw new Error('The independently signed Screen app must be preserved, never re-signed by the GUI pipeline');
  if (!/^[0-9A-F]{40}$/u.test(input.certificateFingerprint)) throw new Error('Developer ID certificate fingerprint rejected');
  return Object.freeze([
    '--force', '--sign', input.certificateFingerprint, '--options', 'runtime', '--timestamp',
    ...(target.identifier ? ['--identifier', target.identifier] : []),
    ...(target.entitlements === 'none' ? [] : ['--entitlements', input.entitlementPaths[target.entitlements]]),
    ...(target.kind === 'app' ? ['--requirements', `=designated => ${developerIdRequirement(DEVELOPER_ID_APP_IDENTIFIER)}`] : []),
    target.path ? join(input.appBundlePath, target.path) : input.appBundlePath,
  ]);
}

const MACH_O_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

function isMachO(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const header = Buffer.alloc(4);
    return readSync(fd, header, 0, 4, 0) === 4 && MACH_O_MAGICS.has(header.readUInt32BE(0));
  } finally { closeSync(fd); }
}

/** Every regular Mach-O file in the bundle, relative to it. Symlinks are not followed. */
export function findMachOFiles(appBundlePath: string): readonly string[] {
  const found: string[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(join(appBundlePath, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && isMachO(join(appBundlePath, path))) found.push(path);
    }
  };
  walk('');
  return Object.freeze(found.sort());
}

/** Keys of an XML entitlements plist as printed by `codesign -d --entitlements - --xml`. */
export function entitlementKeys(xml: string): readonly string[] {
  return Object.freeze([...xml.matchAll(/<key>([^<]+)<\/key>/gu)].map(match => match[1]!).sort());
}

export interface NotaryApiKey { readonly keyPath: string; readonly keyId: string; readonly issuerId: string }

/**
 * The App Store Connect team API key the iOS and Screen scripts already use:
 * ~/.appstoreconnect/agentstoz-asc.json = { keyId, issuerId } and private_keys/AuthKey_<keyId>.p8.
 * Only the path of the key is handed to notarytool; its contents are never read or printed here.
 */
export function readNotaryApiKey(home = homedir(), fs: { existsSync(path: string): boolean; readFileSync(path: string, encoding: 'utf8'): string } = { existsSync, readFileSync }): NotaryApiKey {
  const configPath = join(home, '.appstoreconnect', 'agentstoz-asc.json');
  if (!fs.existsSync(configPath)) throw new Error(`--developer-id needs ${configPath} with a keyId and an issuerId`);
  let parsed: { keyId?: unknown; issuerId?: unknown };
  try { parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { throw new Error(`${configPath} is not valid JSON`); }
  const { keyId, issuerId } = parsed;
  if (typeof keyId !== 'string' || !/^[A-Z0-9]{8,12}$/u.test(keyId) || typeof issuerId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(issuerId)) {
    throw new Error(`${configPath} needs a keyId and an issuerId.`);
  }
  const keyPath = join(home, '.appstoreconnect', 'private_keys', `AuthKey_${keyId}.p8`);
  if (!fs.existsSync(keyPath)) throw new Error(`App Store Connect key is missing: ${keyPath}`);
  return Object.freeze({ keyPath, keyId, issuerId });
}

export function notaryAuthArguments(key: NotaryApiKey): readonly string[] {
  return Object.freeze(['--key', key.keyPath, '--key-id', key.keyId, '--issuer', key.issuerId]);
}

export interface NotarySubmission { readonly id?: string; readonly status?: string; readonly message?: string }

/** `notarytool submit --wait --output-format json`. A rejected submission still exits 0, so read the status. */
export function parseNotarySubmission(stdout: string): NotarySubmission {
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error('notarytool printed no JSON result');
  let value: unknown;
  try { value = JSON.parse(stdout.slice(start)); } catch { throw new Error('notarytool printed an unreadable JSON result'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('notarytool printed an unexpected result');
  const record = value as Record<string, unknown>;
  const text = (key: string) => typeof record[key] === 'string' ? record[key] as string : undefined;
  return Object.freeze({ id: text('id'), status: text('status'), message: text('message') });
}

export function assertNotaryAccepted(submission: NotarySubmission, log: string): string {
  if (submission.status === 'Accepted' && submission.id) return submission.id;
  throw new Error(`Notarization ${submission.status ?? 'failed'} (${submission.id ?? 'no submission id'})${submission.message ? `: ${submission.message}` : ''}\n${log}`);
}

/** Issues Apple reported even for an accepted submission (warnings). */
export function notaryLogIssues(log: string): readonly string[] {
  try {
    const parsed = JSON.parse(log) as { issues?: Array<{ path?: string; message?: string; severity?: string }> | null };
    return Object.freeze((parsed.issues ?? []).map(issue => `${issue.severity ?? 'issue'}: ${issue.path ?? ''} ${issue.message ?? ''}`.trim()));
  } catch { return Object.freeze([]); }
}

export function assertNotarizedGatekeeperVerdict(output: string, label: string): string {
  if (!/: accepted$/mu.test(output) || !output.includes('source=Notarized Developer ID')) {
    throw new Error(`Gatekeeper did not accept ${label} as notarized Developer ID code:\n${output}`);
  }
  return output.trim();
}

/** AGENTSTOZ_CARGO_TARGET_DIR wins; otherwise a Developer ID build never lands in the regular build's directory. */
export function resolveMacOSCargoTargetDir(env: Readonly<Record<string, string | undefined>>, home: string, developerId: boolean): string {
  const override = env[MACOS_TARGET_DIR_ENV];
  if (override !== undefined && override !== '') {
    if (!isAbsolute(override)) throw new Error(`${MACOS_TARGET_DIR_ENV} must be an absolute path`);
    return resolve(override);
  }
  return join(home, 'cargo-targets', developerId ? DEVELOPER_ID_MACOS_TARGET_DIRNAME : DEFAULT_MACOS_TARGET_DIRNAME);
}

export interface DeveloperIdSigningIdentity { readonly certificateFingerprint: string; readonly commonName: string; readonly teamIdentifier: string }

export interface DeveloperIdPreflight { readonly identity: DeveloperIdSigningIdentity; readonly notaryKey: NotaryApiKey }

/** Fails before the long build when the identity, the notary key or the Xcode tools are missing. */
export async function preflightDeveloperId(): Promise<DeveloperIdPreflight> {
  if (process.platform !== 'darwin') throw new Error('--developer-id requires macOS');
  const resolution = await resolveMacOSRuntimeProductionIdentity();
  const identity = resolution.identity;
  if (!identity) throw new Error(`No usable "Developer ID Application" identity in the keychain (${resolution.diagnostic.reason})`);
  if (identity.teamIdentifier !== DEVELOPER_ID_TEAM_IDENTIFIER) {
    throw new Error(`The keychain's Developer ID identity belongs to team ${identity.teamIdentifier}, not ${DEVELOPER_ID_TEAM_IDENTIFIER}`);
  }
  const notaryKey = readNotaryApiKey();
  for (const tool of ['notarytool', 'stapler']) run(['xcrun', '--find', tool], `xcrun --find ${tool}`);
  return Object.freeze({ identity, notaryKey });
}

function run(command: readonly string[], label: string): string {
  const result = Bun.spawnSync([...command], { stdout: 'pipe', stderr: 'pipe' });
  const output = result.stdout.toString() + result.stderr.toString();
  if (result.exitCode !== 0) throw new Error(`${label} failed (exit ${result.exitCode}):\n${output.trim()}`);
  return output;
}

export interface DeveloperIdReleaseOptions {
  readonly appBundlePath: string;
  /** Scratch directory for entitlements, archives, notary logs and the receipt; recreated each run. */
  readonly workDir: string;
  readonly preflight: DeveloperIdPreflight;
  /** DMGs Tauri made in this build. Each is replaced by one made from the notarized app. */
  readonly dmgPaths: readonly string[];
  readonly log?: (line: string) => void;
}

export interface DeveloperIdReceipt {
  readonly appBundlePath: string;
  readonly designatedRequirement: string;
  readonly appSubmissionId: string;
  readonly signed: readonly { path: string; entitlements: DeveloperIdEntitlementKind }[];
  readonly gatekeeper: string;
  readonly dmgs: readonly { path: string; submissionId: string; gatekeeper: string }[];
}

function notarize(artifact: string, label: string, options: DeveloperIdReleaseOptions): string {
  const auth = notaryAuthArguments(options.preflight.notaryKey);
  const log = options.log ?? console.log;
  log(`[developer-id] notarizing ${label} (notarytool submit --wait)…`);
  const result = Bun.spawnSync(['xcrun', 'notarytool', 'submit', artifact, ...auth, '--wait', '--timeout', '60m', '--output-format', 'json'], { stdout: 'pipe', stderr: 'pipe' });
  const stdout = result.stdout.toString();
  let submission: NotarySubmission;
  try { submission = parseNotarySubmission(stdout); } catch (error) {
    throw new Error(`notarytool submit for ${label} failed (exit ${result.exitCode}): ${error instanceof Error ? error.message : error}\n${result.stderr.toString().trim()}`);
  }
  let notaryLog = '';
  if (submission.id) {
    const logPath = join(options.workDir, `notary-${label}.json`);
    const fetched = Bun.spawnSync(['xcrun', 'notarytool', 'log', submission.id, ...auth, logPath], { stdout: 'pipe', stderr: 'pipe' });
    notaryLog = fetched.exitCode === 0 && existsSync(logPath)
      ? readFileSync(logPath, 'utf8')
      : `(notary log unavailable: ${(fetched.stdout.toString() + fetched.stderr.toString()).trim()})`;
  }
  const id = assertNotaryAccepted(submission, notaryLog);
  for (const issue of notaryLogIssues(notaryLog)) log(`[developer-id] notary ${label} ${issue}`);
  log(`[developer-id] ${label}: notarization Accepted (${id})`);
  return id;
}

function stapleAndValidate(path: string, label: string, log: (line: string) => void): void {
  run(['xcrun', 'stapler', 'staple', path], `stapler staple ${label}`);
  run(['xcrun', 'stapler', 'validate', path], `stapler validate ${label}`);
  log(`[developer-id] ${label}: ticket stapled and validated`);
}

function verifyEntitlements(path: string, expected: DeveloperIdEntitlementKind, label: string): void {
  const result = Bun.spawnSync(['codesign', '--display', '--entitlements', '-', '--xml', path], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`codesign could not read the entitlements of ${label}`);
  const actual = entitlementKeys(result.stdout.toString());
  const wanted = [...DEVELOPER_ID_ENTITLEMENT_KEYS[expected]].sort();
  if (actual.join('\n') !== wanted.join('\n')) {
    throw new Error(`${label} has entitlements [${actual.join(', ')}], expected [${wanted.join(', ')}]`);
  }
}

function makeDmg(appBundlePath: string, dmgPath: string, options: DeveloperIdReleaseOptions): void {
  const stage = join(options.workDir, 'dmg-root');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  run(['ditto', appBundlePath, join(stage, 'AgentsToZ_byCS.app')], 'ditto (DMG staging)');
  symlinkSync('/Applications', join(stage, 'Applications'));
  const temporary = join(options.workDir, 'AgentsToZ_byCS.dmg');
  rmSync(temporary, { force: true });
  run(['hdiutil', 'create', '-volname', 'AgentsToZ_byCS', '-srcfolder', stage, '-fs', 'HFS+', '-format', 'UDZO', '-ov', temporary], 'hdiutil create');
  rmSync(stage, { recursive: true, force: true });
  run(['codesign', '--force', '--sign', options.preflight.identity.certificateFingerprint, '--timestamp', temporary], 'codesign (DMG)');
  run(['codesign', '--verify', '--strict', `-R=${developerIdTeamRequirement()}`, temporary], 'codesign --verify (DMG)');
  rmSync(dmgPath, { force: true });
  renameSync(temporary, dmgPath);
}

/**
 * Signs every piece of the app inside-out and checks the result: deep/strict validity, the Team ID
 * anchor on each piece, each piece's exact entitlements and the app's designated requirement.
 * `workDir` must exist; the entitlement plists are written there.
 */
export function signAndVerifyDeveloperIdApp(app: string, workDir: string, identity: DeveloperIdSigningIdentity, log: (line: string) => void = console.log) {
  const entitlementPaths = { gui: join(workDir, 'gui.entitlements'), jit: join(workDir, 'jit.entitlements') } as const;
  writeFileSync(entitlementPaths.gui, developerIdEntitlementsPlist('gui'));
  writeFileSync(entitlementPaths.jit, developerIdEntitlementsPlist('jit'));

  // No blanket `xattr -c` here: Tauri already cleared the bundle before its own signature, the
  // staged runtime files are read-only (0500/0400), and codesign itself refuses Finder-info
  // "detritus" with a clear message, exactly as it does for the ad-hoc build.
  const plan = planDeveloperIdSigning(findMachOFiles(app));
  log(`[developer-id] signing ${plan.length} pieces as "${identity.commonName}" (hardened runtime, secure timestamp)`);
  for (const target of plan) {
    if (target.kind === 'screen-app') {
      verifyPreservedScreenApp(join(app, target.path));
      log('[developer-id] preserving independent Screen signature and keychain entitlements');
      continue;
    }
    run(['codesign', ...developerIdCodesignArguments(target, { appBundlePath: app, certificateFingerprint: identity.certificateFingerprint, entitlementPaths })],
      `codesign ${target.path || 'AgentsToZ_byCS.app'}`);
    log(`[developer-id]   ${target.path || 'AgentsToZ_byCS.app'} (${target.entitlements === 'none' ? 'no entitlements' : `${target.entitlements} entitlements`})`);
  }

  run(['codesign', '--verify', '--deep', '--strict', '--verbose=2', app], 'codesign --verify --deep --strict');
  for (const target of plan) {
    const path = target.path ? join(app, target.path) : app;
    if (target.kind === 'screen-app') {
      verifyPreservedScreenApp(path);
      continue;
    }
    // Loose executables are sealed as resources, so --deep does not check their own signatures.
    run(['codesign', '--verify', '--strict', `-R=${developerIdTeamRequirement()}`, path], `codesign --verify ${target.path || 'app'}`);
    verifyEntitlements(path, target.entitlements, target.path || 'AgentsToZ_byCS.app');
  }
  const designatedRequirement = assertTeamAnchoredDesignatedRequirement(run(['codesign', '--display', '-r-', app], 'codesign -d -r-'));
  log(`[developer-id] ${designatedRequirement}`);
  return Object.freeze({ plan, designatedRequirement });
}

function verifyPreservedScreenApp(path: string): void {
  run(['codesign', '--verify', '--deep', '--strict', `-R=${SCREEN_HELPER_REQUIREMENT}`, path], 'verify independent Screen app');
  assertTeamAnchoredDesignatedRequirement(run(['codesign', '--display', '-r-', path], 'Screen designated requirement'), SCREEN_HELPER_IDENTIFIER);
  const xml = run(['codesign', '--display', '--entitlements', '-', '--xml', path], 'Screen entitlements');
  assertScreenBundleEntitlements(xml);
}

/**
 * Signs every piece of the staged app, notarizes and staples it, and replaces this build's DMGs
 * with signed, notarized and stapled ones made from that app.
 */
export function signNotarizeAndStaple(options: DeveloperIdReleaseOptions): DeveloperIdReceipt {
  const log = options.log ?? console.log;
  const app = options.appBundlePath;
  rmSync(options.workDir, { recursive: true, force: true });
  mkdirSync(options.workDir, { recursive: true, mode: 0o700 });
  const { plan, designatedRequirement } = signAndVerifyDeveloperIdApp(app, options.workDir, options.preflight.identity, log);

  const archive = join(options.workDir, 'AgentsToZ_byCS.zip');
  run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', app, archive], 'ditto (notary archive)');
  const appSubmissionId = notarize(archive, 'app', options);
  rmSync(archive, { force: true });
  const screen = join(app, SCREEN_HELPER_BUNDLE_PATH);
  // The outer submission issues a ticket for nested code too. Carry Screen's own ticket
  // when the signed payload is copied out as an independent app on another Mac.
  if (existsSync(screen)) stapleAndValidate(screen, 'screen', log);
  stapleAndValidate(app, 'app', log);
  run(['codesign', '--verify', '--deep', '--strict', app], 'verify app after companion stapling');
  const gatekeeper = assertNotarizedGatekeeperVerdict(run(['spctl', '--assess', '--type', 'execute', '-vv', app], 'spctl --assess (app)'), 'the app');
  log(`[developer-id] ${gatekeeper.replace(/\n/gu, ' | ')}`);

  const dmgs: { path: string; submissionId: string; gatekeeper: string }[] = [];
  for (const dmgPath of options.dmgPaths) {
    makeDmg(app, dmgPath, options);
    const submissionId = notarize(dmgPath, 'dmg', options);
    stapleAndValidate(dmgPath, 'dmg', log);
    const verdict = assertNotarizedGatekeeperVerdict(
      run(['spctl', '--assess', '--type', 'open', '--context', 'context:primary-signature', '-vv', dmgPath], 'spctl --assess (dmg)'), 'the DMG');
    dmgs.push({ path: dmgPath, submissionId, gatekeeper: verdict });
  }

  const receipt: DeveloperIdReceipt = Object.freeze({
    appBundlePath: app,
    designatedRequirement,
    appSubmissionId,
    signed: Object.freeze(plan.map(target => ({ path: target.path || '.', entitlements: target.entitlements }))),
    gatekeeper,
    dmgs: Object.freeze(dmgs),
  });
  writeFileSync(join(options.workDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

/** DMGs Tauri wrote during this build (not its rw.* scratch images). */
export function freshDmgs(dmgDir: string, sinceMs: number): readonly string[] {
  if (!existsSync(dmgDir)) return Object.freeze([]);
  return Object.freeze(readdirSync(dmgDir)
    .filter(name => name.endsWith('.dmg') && !name.startsWith('rw.'))
    .map(name => join(dmgDir, name))
    .filter(path => lstatSync(path).isFile() && lstatSync(path).mtimeMs >= sinceMs)
    .sort());
}
