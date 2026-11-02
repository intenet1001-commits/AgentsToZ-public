import {expect, test} from 'bun:test';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildViewerApp, parseViewerBuildOptions} from '../scripts/build-viewer-app';
import {assertIndependentHelperSigningProfile} from '../scripts/computerUseSigningProfile';
import {assertViewerBundleEntitlements, VIEWER_HELPER_BUNDLE_PATH, VIEWER_HELPER_IDENTIFIER,
  VIEWER_HELPER_TEAM, viewerBundleEntitlements} from '../stageViewerControlBundle';
import {classifyDeveloperIdMachO, developerIdCodesignArguments, planDeveloperIdSigning} from '../src/macOSDeveloperIdBuild';

const fingerprint = 'A'.repeat(40), id = `${VIEWER_HELPER_TEAM}.${VIEWER_HELPER_IDENTIFIER}`;

test('the staged Viewer filename matches the native installer lookup so its launch button is available', () => {
  const rust = readFileSync(join(import.meta.dir, '../src-tauri/src/screen_helper.rs'), 'utf8');
  const helper = rust.match(/const fn viewer\(\) -> Helper \{([\s\S]*?)\n\}/u)?.[1];
  const appName = helper?.match(/app_name: "([^"\n]+)"/u)?.[1];
  expect(appName).toBeDefined();
  // The Rust installer and status query use this exact filename. A separately signed app under a
  // different name is invisible to both, leaving bundled=false and hiding the work-mode button.
  expect(VIEWER_HELPER_BUNDLE_PATH).toBe(`Contents/Helpers/${appName}`);
});

test('Viewer cannot inherit Screen identity, extra keychain groups or capture/input privileges', () => {
  const xml = viewerBundleEntitlements();
  expect(() => assertViewerBundleEntitlements(xml)).not.toThrow();
  for (const changed of [
    xml.replaceAll(VIEWER_HELPER_IDENTIFIER, 'com.intenet.agentstozbycs.screen'),
    xml.replace('</array>', '<string>DA8QKAQ2C9.*</string></array>'),
    xml.replace('</dict>', '<key>com.apple.security.cs.allow-jit</key><true/></dict>'),
    xml + xml,
  ]) expect(() => assertViewerBundleEntitlements(changed)).toThrow();
});

test('Viewer profile must grant its own App ID and contain the selected signing certificate', () => {
  const identity = {bundleId: VIEWER_HELPER_IDENTIFIER, teamId: VIEWER_HELPER_TEAM, label: 'Viewer'};
  const p = {TeamIdentifier: [VIEWER_HELPER_TEAM], ProvisionsAllDevices: true, ExpirationDate: '2030-01-01T00:00:00Z',
    DeveloperCertificateSHA1: [fingerprint], Entitlements: {'com.apple.application-identifier': id,
      'com.apple.developer.team-identifier': VIEWER_HELPER_TEAM, 'keychain-access-groups': [VIEWER_HELPER_TEAM + '.*']}};
  expect(assertIndependentHelperSigningProfile(p, fingerprint, identity)).toMatchObject({bundleId: VIEWER_HELPER_IDENTIFIER});
  for (const changed of [
    {...p, Entitlements: {...p.Entitlements, 'com.apple.application-identifier': `${VIEWER_HELPER_TEAM}.com.intenet.agentstozbycs.screen`}},
    {...p, DeveloperCertificateSHA1: ['B'.repeat(40)]},
    {...p, ProvisionedDevices: ['development-device']},
    {...p, ExpirationDate: '2020-01-01'},
  ]) expect(() => assertIndependentHelperSigningProfile(changed, fingerprint, identity)).toThrow();
});

test('main Developer ID pipeline preserves the independently signed Viewer and refuses unknown nested binaries', () => {
  const target = classifyDeveloperIdMachO(`${VIEWER_HELPER_BUNDLE_PATH}/Contents/MacOS/AgentsToZViewer`);
  expect(target).toEqual({path: VIEWER_HELPER_BUNDLE_PATH, kind: 'viewer-app', entitlements: 'none'});
  expect(planDeveloperIdSigning(['Contents/MacOS/app', `${VIEWER_HELPER_BUNDLE_PATH}/Contents/MacOS/AgentsToZViewer`])).toEqual([
    target, {path: '', kind: 'app', entitlements: 'gui'},
  ]);
  expect(() => developerIdCodesignArguments(target, {appBundlePath: '/tmp/app.app', certificateFingerprint: fingerprint,
    entitlementPaths: {gui: '/tmp/gui', jit: '/tmp/jit'}})).toThrow('never re-signed');
  expect(() => classifyDeveloperIdMachO(`${VIEWER_HELPER_BUNDLE_PATH}/Contents/MacOS/foreign`)).toThrow('Unplanned Mach-O');
  expect(() => classifyDeveloperIdMachO('Contents/Helpers/AgentsToZInputProbe.app/Contents/MacOS/AgentsToZInputProbe'))
    .toThrow('Unplanned Mach-O');
});

test('Viewer build options reject installation, ad-hoc fallback, duplicates and output aliases', () => {
  const args = ['--sign', fingerprint, '--output', '/tmp/AgentsToZViewer.app', '--bundle-version', '1.2.3'];
  expect(parseViewerBuildOptions(args).version).toBe('1.2.3');
  for (const extra of [['--install'], ['--timestamp=none'], ['--sign', '-'], ['--notarize']]) {
    expect(() => parseViewerBuildOptions([...args, ...extra])).toThrow();
  }
  expect(() => parseViewerBuildOptions(args.filter(x => x !== '--sign' && x !== fingerprint))).toThrow('explicit Viewer');
  expect(() => parseViewerBuildOptions(args.map(x => x === '/tmp/AgentsToZViewer.app' ? '/tmp/Other.app' : x))).toThrow('absolute AgentsToZViewer.app');
});

test.skipIf(process.platform !== 'darwin')('missing H1 profile fails before compilation, keychain lookup or creating output', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'viewer-profile-missing-'));
  try {
    const output = join(scratch, 'AgentsToZViewer.app');
    expect(() => buildViewerApp(['--sign', fingerprint, '--output', output, '--bundle-version', '1.2.3',
      '--profile', join(scratch, 'missing.provisionprofile')])).toThrow('H1:');
    expect(existsSync(output)).toBe(false);
  } finally { rmSync(scratch, {recursive: true, force: true}); }
});
