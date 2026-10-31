import {assertComputerUseBuildOutput} from './computerUseBuildOutput';
import {prepareControlSigningProfile} from './computerUseSigningProfile';
import {assertNotaryAccepted,assertNotarizedGatekeeperVerdict,notaryLogIssues,parseNotarySubmission,type NotarySubmission} from '../src/macOSDeveloperIdBuild';
import {checkMacOSNotary,notaryAuthArgs,type CheckProcessResult,type CheckRunner,type NotaryCheckStatus,type NotaryOptions} from '../src/macOSNotaryPreflight';
// Builds AgentsToZ Control.app, the signed sibling app that alone holds the Accessibility permission for computer use
// and runs the engine in its own process (native/computer-use/CONTRACT.md). Build only: it never installs, never
// registers or starts the LaunchAgent (no launchctl, no SMAppService), never requests a permission, and never chooses
// a signing identity itself. It resolves only the explicitly supplied --sign value to one valid certificate fingerprint.
//
//   bun scripts/build-computer-use-control-app.ts [--output <abs path>/AgentsToZ Control.app] [--bundle-version 0.1]
//       [--debug]                                     structure check only, debug build, unsigned
//       [--sign <identity> --profile <Developer ID provisioning profile>]   hardened runtime + secure timestamp
//       [--timestamp=none]                            local-only signature without a timestamp server: never notarizable
//       [--notarize --notary-profile <existing notarytool keychain profile> [--notary-keychain <abs keychain path>]]
//
// Unsigned output is for checking the bundle's structure; it is not runnable as the helper (the main app's bridge
// requires the team's Developer ID signature, CONTRACT.md section 2). Signing needs both an explicit identity and the
// provisioning profile that grants the keychain access group of the approval key. A signed build always asks for a
// secure timestamp (Apple's notary service rejects code without one; `--timestamp` is accepted and is the default).
// `--timestamp=none` is an explicit local-only opt-out and the result says it is not notarizable.
//
// `--notarize` is opt-in and the only network step. It reuses the read-only notary preflight
// (src/macOSNotaryPreflight.ts, `bun check-macos-notary.ts`): a locked-session lookup failure, a missing profile and an
// Apple 401 are reported apart, and a lookup failure is never treated as a deleted credential. It never creates,
// stores or changes a credential and never prints one. It submits with `--wait`, staples, validates the ticket,
// checks Gatekeeper and writes a JSON receipt next to the app. An unconfirmed submission is never sent again on its own.
import {spawnSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, isAbsolute, join, resolve} from 'node:path';
import {CONTROL_AGENT_PLIST, CONTROL_APP_NAME, CONTROL_BUNDLE_ID, CONTROL_EXECUTABLE, CONTROL_HELPER_REQUIREMENT, CONTROL_PRODUCT,
  controlEntitlements, controlInfoPlist, controlLaunchAgentPlist} from './computerUseControlBundle';

const packagePath = resolve(import.meta.dir, '..', 'native', 'computer-use');

export type ControlTimestamp = 'secure' | 'none';
export interface ControlBuildOptions {
  readonly appPath: string;
  readonly version: string;
  readonly debug: boolean;
  readonly identity?: string;
  readonly profile?: string;
  /** Only meaningful for a signed build. */
  readonly timestamp: ControlTimestamp;
  /** Present only with --notarize. */
  readonly notary?: NotaryOptions;
}

export function parseControlBuildArgs(args: readonly string[], defaultAppPath: string): ControlBuildOptions {
  let appPath = defaultAppPath;
  let version = '0.1';
  let identity: string | undefined, profile: string | undefined, notaryProfile: string | undefined, notaryKeychain: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--output') {
      appPath = args[++i] ?? '';
      if (!isAbsolute(appPath) || basename(appPath) !== `${CONTROL_APP_NAME}.app`) throw Error('Invalid AgentsToZ Control output path');
    } else if (arg === '--bundle-version') version = args[++i] ?? '';
    else if (arg === '--sign') identity = args[++i];
    else if (arg === '--profile') profile = args[++i];
    else if (arg === '--notary-profile') notaryProfile = args[++i] ?? '';
    else if (arg === '--notary-keychain') notaryKeychain = args[++i] ?? '';
    else if (!['--debug', '--timestamp', '--timestamp=none', '--notarize'].includes(arg)) throw Error(`Unsupported AgentsToZ Control build option: ${arg}`);
  }
  const debug = args.includes('--debug');
  if ((identity === undefined) !== (profile === undefined)) throw Error('--sign and --profile go together');
  if (identity !== undefined && (debug || !identity.trim())) throw Error('A signed build is a release build with an explicit identity');
  if (profile !== undefined && (!isAbsolute(profile) || !existsSync(profile))) throw Error('The provisioning profile must be an existing absolute path');
  if (args.includes('--timestamp') && args.includes('--timestamp=none')) throw Error('Choose --timestamp or --timestamp=none, not both');
  const timestamp: ControlTimestamp = args.includes('--timestamp=none') ? 'none' : 'secure';
  if (timestamp === 'none' && identity === undefined) throw Error('--timestamp=none applies only to a signed build');
  const notarize = args.includes('--notarize');
  if (!notarize && (notaryProfile !== undefined || notaryKeychain !== undefined)) throw Error('--notary-profile and --notary-keychain go with --notarize');
  let notary: NotaryOptions | undefined;
  if (notarize) {
    if (identity === undefined) throw Error('--notarize needs a signed build (--sign and --profile)');
    if (timestamp === 'none') throw Error('--notarize needs a secure timestamp: a --timestamp=none build is never notarizable');
    if (notaryProfile === undefined) throw Error('--notarize needs --notary-profile <existing notarytool keychain profile>');
    notary = Object.freeze({profile: notaryProfile, ...(notaryKeychain === undefined ? {} : {keychain: notaryKeychain})});
    notaryAuthArgs(notary); // a malformed profile name or a relative keychain path stops here, before anything runs
  }
  return Object.freeze({appPath, version, debug, identity, profile, timestamp, notary});
}

export function controlCodesignArguments(identity: string, entitlementsPath: string, appPath: string, timestamp: ControlTimestamp): string[] {
  return ['--force', '--options', 'runtime', timestamp === 'secure' ? '--timestamp' : '--timestamp=none',
    '--identifier', CONTROL_BUNDLE_ID, '--entitlements', entitlementsPath, '--sign', identity, appPath];
}

/**
 * Reads `codesign --display --verbose=4`. A secure timestamp prints `Timestamp=`; a signature made with
 * `--timestamp=none` prints only `Signed Time=`, which Apple's notary service rejects.
 */
export function readControlSignature(display: string): {secureTimestamp: string | null; cdHash: string} {
  const lines = display.split(/\r?\n/u);
  const values = (prefix: string) => lines.filter(line => line.startsWith(prefix)).map(line => line.slice(prefix.length));
  const cdHashes = values('CDHash=');
  if (cdHashes.length !== 1 || !/^[0-9a-f]{40}$/u.test(cdHashes[0]!)) throw Error('codesign printed no single CDHash for AgentsToZ Control');
  const timestamps = values('Timestamp=');
  const secure = timestamps.length === 1 && timestamps[0]!.length > 0 && !/^(?:none|not set)$/iu.test(timestamps[0]!);
  return {secureTimestamp: secure ? timestamps[0]! : null, cdHash: cdHashes[0]!};
}

export function controlBuildSummary(input: {appPath: string; configuration: string; signed: boolean; timestamp: ControlTimestamp;
  secureTimestamp?: string | null; receiptPath?: string}) {
  const secureTimestamp = input.signed && !!input.secureTimestamp;
  const notarizable = secureTimestamp && input.timestamp === 'secure';
  const notarized = notarizable && input.receiptPath !== undefined;
  const manual = 'installation, LaunchAgent registration and the Accessibility permission are separate, manual steps.';
  return {app: input.appPath, bundleId: CONTROL_BUNDLE_ID, executable: CONTROL_EXECUTABLE, configuration: input.configuration,
    signed: input.signed, secureTimestamp, notarizable, notarized, ...(notarized ? {notaryReceipt: input.receiptPath} : {}),
    launchAgent: `Contents/Library/LaunchAgents/${CONTROL_AGENT_PLIST}`,
    note: notarized ? `Signed, notarized and stapled; ${manual}`
      : notarizable ? `Signed with a secure timestamp, not notarized (opt in with --notarize --notary-profile <profile>); ${manual}`
      : input.signed ? 'Signed for local checks only (--timestamp=none): not notarizable; Apple rejects a signature without a secure timestamp.'
      : 'Unsigned structure build: not runnable as the helper.'};
}

// What each preflight status means (`finding`) and, while nothing has been uploaded yet, what to do next
// (`beforeUpload`). The wording follows src/macOSNotaryPreflight.ts: a missing item is not evidence of deletion, and
// nothing here registers, replaces or prints a credential. After an upload whose outcome is unknown only `finding` is
// used: this script always builds and uploads, so "run the build again" would send a second upload.
const NOTARY_PREFLIGHT_ADVICE: Readonly<Record<Exclude<NotaryCheckStatus, 'ready'>, {finding: string; beforeUpload: string}>> = Object.freeze({
  'session-locked-profile-unavailable': {finding: 'the screen is locked and the existing notary profile could not be read; this does not show that the profile was deleted, so do not register it again.',
    beforeUpload: 'Unlock the Mac normally and run the build again.'},
  'profile-unavailable': {finding: 'notarytool found no item for this profile in this login session. That alone does not show that it was deleted: check where it was originally stored (pass --notary-keychain for a file keychain) and that this is the same login session.',
    beforeUpload: ''},
  'apple-auth-rejected': {finding: 'Apple rejected the stored credential (HTTP 401). Review the Apple credential.', beforeUpload: 'This build changed nothing.'},
  'keychain-interaction-required': {finding: 'the keychain needs interaction before notarytool can read the profile. Resolve it in the login session; this build never prompts.',
    beforeUpload: ''},
  'lookup-timeout': {finding: 'notarytool timed out while checking the profile. Check the tool and the network.', beforeUpload: 'Then run the build again.'},
  'lookup-failed': {finding: 'notarytool could not check the profile. Check the tool and the network.', beforeUpload: 'Then run the build again.'},
  'invalid-response': {finding: 'notarytool returned an unreadable answer while checking the profile. Check the tool.', beforeUpload: 'Then run the build again.'},
});

type NotaryPreflight = ReturnType<typeof checkMacOSNotary>;
export type ControlNotaryCheckMoment = 'before-upload' | 'after-unconfirmed-upload';
export function controlNotaryPreflightError(result: NotaryPreflight, stage: string, moment: ControlNotaryCheckMoment = 'before-upload'): Error {
  const advice = result.status === 'ready' ? {finding: 'the profile is ready.', beforeUpload: ''} : NOTARY_PREFLIGHT_ADVICE[result.status];
  const next = moment === 'before-upload' ? advice.beforeUpload
    : 'Once that is resolved, look up the earlier upload with `xcrun notarytool history` before anything else.';
  return Error([`Notary preflight ${result.status} (${result.nextStep}): ${advice.finding}`, next, stage].filter(Boolean).join(' '));
}

/** The receipt and the notary log sit next to the built app. */
export function controlNotaryPaths(appPath: string): {receipt: string; log: string} {
  const base = join(dirname(appPath), CONTROL_APP_NAME);
  return {receipt: `${base}.notary-receipt.json`, log: `${base}.notary-log.json`};
}

export function assertControlNotaryOutputFree(appPath: string): void {
  const paths = controlNotaryPaths(appPath);
  if (existsSync(paths.receipt) || existsSync(paths.log)) {
    throw Error('A notarization receipt or log already sits next to this output; choose a new output directory (an old receipt is never replaced).');
  }
}

/** One notarization step, without a shell or prompt. Only `notarytool submit --wait` may run long. */
export const runControlNotaryProcess: CheckRunner = (command, args) => {
  const submit = args[0] === 'notarytool' && args[1] === 'submit';
  const quick = command === '/usr/bin/osascript' || (args[0] === 'notarytool' && args[1] === 'history');
  const result = spawnSync(command, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: submit ? 65 * 60_000 : quick ? 20_000 : 10 * 60_000, maxBuffer: 4 * 1024 * 1024});
  return {status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '',
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'};
};

export interface ControlNotaryInput {
  readonly appPath: string;
  readonly version: string;
  readonly cdHash: string;
  readonly secureTimestamp: string;
  readonly notary: NotaryOptions;
  /** Private scratch directory for the upload archive. */
  readonly workDir: string;
}

export interface ControlNotaryReceipt {
  readonly schemaVersion: 1;
  readonly app: string;
  readonly bundleId: string;
  readonly version: string;
  readonly cdHash: string;
  readonly secureTimestamp: string;
  readonly notary: {readonly storage: NotaryPreflight['storage']; readonly submissionId: string; readonly status: 'Accepted';
    readonly issues: readonly string[]; readonly log: string | null};
  readonly stapled: true;
  readonly gatekeeper: string;
  readonly installed: false;
  readonly completedAt: string;
}

const SUBMISSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function must(result: CheckProcessResult, label: string, context?: string): string {
  if (result.status !== 0 || result.timedOut) {
    throw Error(`${context ? `${context}, but ` : ''}${label} failed (exit ${result.status ?? 'none'}${result.timedOut ? ', timed out' : ''}):\n${result.stderr.trim()}`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

/**
 * Notarizes an already signed and verified Control app: preflight right before the upload, `notarytool submit --wait`
 * with exactly the auth arguments the preflight confirmed, the notary log, staple and validate, the helper requirement
 * again, and Gatekeeper's `source=Notarized Developer ID`. The receipt is written only after all of that passed.
 */
export function notarizeControlApp(input: ControlNotaryInput, run: CheckRunner = runControlNotaryProcess,
  log: (line: string) => void = line => console.error(line)): ControlNotaryReceipt {
  assertControlNotaryOutputFree(input.appPath);
  const paths = controlNotaryPaths(input.appPath);
  // The build can take minutes and the screen may lock meanwhile: check the existing profile again just before uploading.
  const check = checkMacOSNotary(input.notary, run);
  if (!check.ready) throw controlNotaryPreflightError(check, `Nothing was submitted; the signed app is at ${input.appPath}.`);
  const auth = check.authArgs;

  const archive = join(input.workDir, `${CONTROL_APP_NAME}.zip`);
  let submitted: CheckProcessResult;
  try {
    must(run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', input.appPath, archive]), 'ditto (notary archive)');
    log('[control] notarizing AgentsToZ Control (notarytool submit --wait)…');
    submitted = run('/usr/bin/xcrun', ['notarytool', 'submit', archive, ...auth, '--wait', '--timeout', '60m', '--output-format', 'json']);
  } finally {rmSync(archive, {force: true});}

  let submission: NotarySubmission | undefined;
  try {submission = parseNotarySubmission(submitted.stdout);} catch {submission = undefined;}
  if (!submission?.status || (submission.id !== undefined && !SUBMISSION_ID.test(submission.id))) {
    // The outcome is unknown and Apple may already hold the upload, so it is never sent again from here. A read-only
    // recheck tells a locked session or a rejected credential apart from a network or tool failure. Its advice must not
    // say "run the build again": a new build uploads again.
    const recheck = checkMacOSNotary(input.notary, run);
    throw Error([
      `notarytool submit did not confirm a result (exit ${submitted.status ?? 'none'}${submitted.timedOut ? ', timed out' : ''}).`,
      'Apple may still have received the upload: look it up with `xcrun notarytool history` and the same profile before submitting again.',
      recheck.ready ? 'The profile itself is still readable.' : controlNotaryPreflightError(recheck, '', 'after-unconfirmed-upload').message,
      `The signed app stays at ${input.appPath}. Running this build with --notarize again uploads again, so do that only after the history shows that Apple did not receive this upload.`,
    ].join(' '));
  }
  let notaryLog = '';
  if (submission.id) {
    const fetched = run('/usr/bin/xcrun', ['notarytool', 'log', submission.id, ...auth, paths.log]);
    notaryLog = fetched.status === 0 && existsSync(paths.log) ? readFileSync(paths.log, 'utf8') : '(notary log unavailable)';
  }
  let submissionId: string;
  try {submissionId = assertNotaryAccepted(submission, notaryLog);}
  catch (error) {
    throw Error(`${error instanceof Error ? error.message : error}\nThis build never submits again on its own; follow the submission with \`xcrun notarytool info\` and the same profile.`);
  }
  const issues = notaryLogIssues(notaryLog);
  for (const issue of issues) log(`[control] notary ${issue}`);
  const accepted = `Notarization was accepted (${submissionId}); do not submit it again`;

  must(run('/usr/bin/xcrun', ['stapler', 'staple', input.appPath]), 'stapler staple', accepted);
  must(run('/usr/bin/xcrun', ['stapler', 'validate', input.appPath]), 'stapler validate', accepted);
  // The main app's bridge accepts the helper only under this requirement; stapling must not have changed that.
  must(run('/usr/bin/codesign', ['--verify', '--strict', '-R', `=${CONTROL_HELPER_REQUIREMENT}`, input.appPath]), 'codesign --verify after stapling', accepted);
  const assessment = must(run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '-vv', input.appPath]), 'spctl --assess', accepted);
  let gatekeeper: string;
  try {gatekeeper = assertNotarizedGatekeeperVerdict(assessment, 'AgentsToZ Control');}
  catch (error) {throw Error(`${accepted}, but ${error instanceof Error ? error.message : error}`);}

  const receipt: ControlNotaryReceipt = Object.freeze({
    schemaVersion: 1, app: input.appPath, bundleId: CONTROL_BUNDLE_ID, version: input.version, cdHash: input.cdHash,
    secureTimestamp: input.secureTimestamp,
    notary: Object.freeze({storage: check.storage, submissionId, status: 'Accepted' as const, issues, log: existsSync(paths.log) ? paths.log : null}),
    stapled: true, gatekeeper, installed: false, completedAt: new Date().toISOString(),
  });
  writeFileSync(paths.receipt, `${JSON.stringify(receipt, null, 2)}\n`, {mode: 0o600, flag: 'wx'});
  log(`[control] notarized and stapled (${submissionId}); receipt ${paths.receipt}`);
  return receipt;
}

function run(command: string[], output: 'stdout' | 'all' = 'stdout'): string {
  const result = Bun.spawnSync(command, {stdout: 'pipe', stderr: 'pipe'});
  if (result.exitCode !== 0) throw Error(`${command.join(' ')} failed:\n${result.stderr.toString()}`);
  return output === 'all' ? `${result.stdout.toString()}\n${result.stderr.toString()}` : result.stdout.toString().trim();
}

function main(): void {
  const options = parseControlBuildArgs(process.argv.slice(2), join(packagePath, '.build', `${CONTROL_APP_NAME}.app`));
  const {appPath, identity, profile} = options;
  const info = controlInfoPlist(options.version);
  const configuration = options.debug ? 'debug' : 'release';
  // Refuse the wrong App ID/profile before compiling or creating an install candidate. Never renew a profile,
  // alter a team/account, or substitute Screen's keychain entitlement to make this check pass.
  let profileBytes:Buffer | undefined, signingFingerprint:string | undefined;
  if(profile!==undefined && identity!==undefined){
    // Decode and retain one immutable byte snapshot, then embed those exact bytes after compilation.
    // Resolve names once to a unique valid fingerprint and use that same fingerprint in codesign.
    const prepared=prepareControlSigningProfile(readFileSync(profile),identity);
    profileBytes=prepared.profileBytes;
    signingFingerprint=prepared.signingFingerprint;
  }
  if (options.notary) {
    if (process.platform !== 'darwin') throw Error('--notarize requires macOS');
    assertControlNotaryOutputFree(appPath);
    // Fail before compiling when the existing profile cannot be read. The same check runs again right before upload.
    const check = checkMacOSNotary(options.notary);
    if (!check.ready) throw controlNotaryPreflightError(check, 'Nothing was built or submitted.');
  }
  if (identity !== undefined && options.timestamp === 'none') {
    console.error('[control] --timestamp=none: local-only signature without a secure timestamp. Apple notarization rejects this build; it is not notarizable.');
  }
  const build = ['swift', 'build', '-c', configuration, '--package-path', packagePath, '--disable-automatic-resolution'];
  run([...build, '--product', CONTROL_PRODUCT]);
  const binPath = run([...build, '--show-bin-path']);

  assertComputerUseBuildOutput(appPath,packagePath);
  mkdirSync(appPath,{mode:0o700});
  const contents = join(appPath, 'Contents');
  mkdirSync(join(contents, 'MacOS'), {recursive: true});
  mkdirSync(join(contents,'Resources'),{recursive:true});
  cpSync(join(packagePath,'THIRD-PARTY-NOTICES.txt'),join(contents,'Resources','THIRD-PARTY-NOTICES.txt'));
  mkdirSync(join(contents, 'Library', 'LaunchAgents'), {recursive: true});
  cpSync(join(binPath, CONTROL_PRODUCT), join(contents, 'MacOS', CONTROL_EXECUTABLE));
  writeFileSync(join(contents, 'Info.plist'), info);
  writeFileSync(join(contents, 'Library', 'LaunchAgents', CONTROL_AGENT_PLIST), controlLaunchAgentPlist());
  for (const plist of [join(contents, 'Info.plist'), join(contents, 'Library', 'LaunchAgents', CONTROL_AGENT_PLIST)]) run(['plutil', '-lint', plist]);

  let signed = false;
  let secureTimestamp: string | null = null;
  let receiptPath: string | undefined;
  if (identity !== undefined && profile !== undefined) {
    if (!profileBytes || !signingFingerprint) throw Error('Control signing preflight did not complete');
    writeFileSync(join(contents, 'embedded.provisionprofile'),profileBytes);
    const scratch = mkdtempSync(join(tmpdir(), 'agentstoz-control-'));
    try {
      const entitlements = join(scratch, 'entitlements.plist');
      writeFileSync(entitlements, controlEntitlements());
      run(['codesign', ...controlCodesignArguments(signingFingerprint, entitlements, appPath, options.timestamp)]);
      run(['codesign', '--verify', '--strict', appPath]);
      // The main app's bridge accepts the helper only under this requirement; fail the build rather than ship one it refuses.
      run(['codesign', '--verify', '-R', `=${CONTROL_HELPER_REQUIREMENT}`, appPath]);
      const signature = readControlSignature(run(['codesign', '--display', '--verbose=4', appPath], 'all'));
      if (options.timestamp === 'secure' && !signature.secureTimestamp) {
        throw Error('codesign recorded no secure timestamp (only a local signing time); the build is not notarizable. Check the timestamp server and build again.');
      }
      secureTimestamp = signature.secureTimestamp;
      signed = true;
      if (options.notary && secureTimestamp) {
        notarizeControlApp({appPath, version: options.version, cdHash: signature.cdHash, secureTimestamp, notary: options.notary, workDir: scratch});
        receiptPath = controlNotaryPaths(appPath).receipt;
      }
    } finally {rmSync(scratch, {recursive: true, force: true});}
  }
  console.log(JSON.stringify(controlBuildSummary({appPath, configuration, signed, timestamp: options.timestamp, secureTimestamp, receiptPath})));
}

if (import.meta.main) main();
