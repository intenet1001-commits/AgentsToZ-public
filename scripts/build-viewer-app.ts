import {cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, isAbsolute, join, resolve} from 'node:path';
import {communityBuildConfigPlistEntry,readCommunityBuildConfig} from './communityBuildConfig';
import {assertIndependentHelperSigningProfile, decodeControlSigningProfile, readComputerUseSigningProfileMetadata,
  resolveControlSigningIdentityFingerprint} from './computerUseSigningProfile';
import {assertViewerBundleEntitlements, VIEWER_HELPER_IDENTIFIER, VIEWER_HELPER_REQUIREMENT,
  VIEWER_HELPER_TEAM, viewerBundleEntitlements} from '../stageViewerControlBundle';

export function parseViewerBuildOptions(args: readonly string[], root = resolve(import.meta.dir, '..')) {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--community-qa' && !values.has(flag)) { values.set(flag, 'true'); continue; }
    if (!['--sign', '--profile', '--output', '--bundle-version', '--community-config'].includes(flag) || values.has(flag)) throw Error('Unsupported or repeated Viewer build option');
    const value = args[++i];
    if (!value || value.startsWith('--')) throw Error(`Viewer build option needs a value: ${flag}`);
    values.set(flag, value);
  }
  const identity = values.get('--sign'), version = values.get('--bundle-version');
  const output = values.get('--output'), profile = values.get('--profile')
    ?? join(root, 'native/screen-control/App/AgentsToZ_Viewer_Developer_ID.provisionprofile');
  if (!identity || identity.trim() !== identity) throw Error('Choose an explicit Viewer Developer ID signing identity');
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw Error('Viewer needs a three-part bundle version');
  if (!output || !isAbsolute(output) || basename(output) !== 'AgentsToZViewer.app') throw Error('Viewer needs an absolute AgentsToZViewer.app output');
  if (!isAbsolute(profile)) throw Error('Viewer profile must be an absolute path');
  if (values.has('--community-qa') && values.has('--community-config')) throw Error('Community QA and public configuration cannot be combined');
  const communityConfig = values.has('--community-config') ? readCommunityBuildConfig(resolve(values.get('--community-config')!)) : undefined;
  return {identity, version, output, profile, ...(values.has('--community-qa') ? {communityQA: true} : {}), ...(communityConfig ? {communityConfig} : {})};
}

function run(command: string[]): string {
  const result = Bun.spawnSync(command, {stdout: 'pipe', stderr: 'pipe'});
  if (!result.success) throw Error(`${command[0]} failed while building Viewer: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

export function prepareViewerSigningProfile(identity: string,
  profile = join(resolve(import.meta.dir, '..'), 'native/screen-control/App/AgentsToZ_Viewer_Developer_ID.provisionprofile')) {
  if (!existsSync(profile)) throw Error('H1: dedicated Viewer Developer ID profile is missing; no Swift build was started');
  const profileBytes = readFileSync(profile);
  const fingerprint = resolveControlSigningIdentityFingerprint(identity, run(['security', 'find-identity', '-v', '-p', 'codesigning']));
  assertIndependentHelperSigningProfile(readComputerUseSigningProfileMetadata(decodeControlSigningProfile(profileBytes)), fingerprint,
    {bundleId: VIEWER_HELPER_IDENTIFIER, teamId: VIEWER_HELPER_TEAM, label: 'Viewer'});
  return {profileBytes, fingerprint};
}

export function buildViewerApp(args: readonly string[]) {
  if (process.platform !== 'darwin') throw Error('Viewer build requires macOS');
  const root = resolve(import.meta.dir, '..'), options = parseViewerBuildOptions(args, root);
  // H1 is a real prerequisite. Never reuse Screen's profile or fall back to an ad-hoc signature.
  if (!existsSync(options.profile)) throw Error('H1: dedicated Viewer Developer ID profile is missing; no Swift build was started');
  if (existsSync(options.output)) throw Error('Viewer output already exists; choose a fresh output directory');
  const parent = dirname(options.output);
  if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) throw Error('Viewer output parent must be a real directory');
  const {profileBytes, fingerprint} = prepareViewerSigningProfile(options.identity, options.profile);
  const packagePath = join(root, 'native/screen-control');
  run(['swift', 'build', '-c', 'release', '--package-path', packagePath, '--product', 'AgentsToZViewer',
    ...(options.communityQA ? ['-Xswiftc', '-DSCREEN_COMMUNITY_QA'] : [])]);
  const bin = run(['swift', 'build', '-c', 'release', '--package-path', packagePath, '--show-bin-path']).trim();
  const scratch = mkdtempSync(join(tmpdir(), 'agentstoz-viewer-sign-'));
  const app = join(scratch, 'AgentsToZViewer.app'), contents = join(app, 'Contents');
  try {
    mkdirSync(join(contents, 'MacOS'), {recursive: true});
    cpSync(join(bin, 'AgentsToZViewer'), join(contents, 'MacOS/AgentsToZViewer'));
    writeFileSync(join(contents, 'embedded.provisionprofile'), profileBytes);
    writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${VIEWER_HELPER_IDENTIFIER}</string>
<key>CFBundleName</key><string>AgentsToZ Viewer</string>
<key>CFBundleExecutable</key><string>AgentsToZViewer</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>${options.version}</string>
<key>CFBundleShortVersionString</key><string>${options.version}</string>
${options.communityQA ? '<key>AgentsToZScreenCommunityQA</key><true/>' : ''}
${communityBuildConfigPlistEntry(options.communityConfig)}
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSLocalNetworkUsageDescription</key><string>Connect to a Mac you registered to view its screen.</string>
<key>NSBonjourServices</key><array><string>_atzscreen._tcp</string></array>
</dict></plist>`);
    const entitlements = join(scratch, 'entitlements.plist');
    writeFileSync(entitlements, viewerBundleEntitlements());
    run(['codesign', '--force', '--options', 'runtime', '--timestamp', '--identifier', VIEWER_HELPER_IDENTIFIER,
      '--entitlements', entitlements, '--sign', fingerprint, app]);
    run(['codesign', '--verify', '--deep', '--strict', `-R=${VIEWER_HELPER_REQUIREMENT}`, app]);
    assertViewerBundleEntitlements(run(['codesign', '--display', '--entitlements', '-', '--xml', app]));
    const signature = Bun.spawnSync(['codesign', '--display', '--verbose=4', app], {stdout: 'pipe', stderr: 'pipe'});
    if (!signature.success || !/^Timestamp=/m.test(signature.stderr.toString() + signature.stdout.toString())) throw Error('Viewer signature has no secure timestamp');
    mkdirSync(options.output);
    cpSync(app, options.output, {recursive: true, dereference: false});
    console.log(`Signed Viewer ${options.version}: ${options.output} (notarization and installation remain separate)`);
  } finally { rmSync(scratch, {recursive: true, force: true}); }
}

if (import.meta.main) buildViewerApp(process.argv.slice(2));
