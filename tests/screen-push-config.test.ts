import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { screenPushEndpoint, screenPushPlistEntry } from '../scripts/screenPushEndpoint';

// AgentsToZ Screen notifications and remote stop are OFF unless configured (DESIGN 「알림·원격 차단」): no endpoint
// means the Mac sends and polls nothing, and the phone asks for no notification permission and registers nothing.
// The current TestFlight archive builds unchanged. These read the committed sources; they build and sign nothing.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const plist = (path: string) => {
  const child = Bun.spawnSync(['plutil', '-convert', 'json', '-o', '-', new URL(`../${path}`, import.meta.url).pathname], { stdout: 'pipe', stderr: 'pipe' });
  if (child.exitCode !== 0) throw Error('plist unreadable: ' + path);
  return JSON.parse(child.stdout.toString()) as Record<string, any>;
};

test('the Mac app gets an endpoint only from AGENTSTOZ_SCREEN_PUSH_URL, and only a plain https one', () => {
  for (const off of [undefined, '', '   ']) {
    expect(screenPushEndpoint(off)).toBeNull();
    expect(screenPushPlistEntry(off)).toBe('');
  }
  const url = 'https://project.supabase.co/functions/v1/screen-push';
  expect(screenPushEndpoint(` ${url} `)).toBe(url);
  expect(screenPushPlistEntry(url)).toBe(`  <key>AgentsToZScreenPushURL</key><string>${url}</string>\n`);
  for (const bad of ['http://project.supabase.co/x', 'https://user:pw@project.supabase.co/x', 'https://project.supabase.co/x?key=1',
    'https://project.supabase.co/x#frag', 'https://project.supabase.co/<x>', 'project.supabase.co/x', `https://a.co/${'x'.repeat(520)}`]) {
    expect(() => screenPushEndpoint(bad)).toThrow('AGENTSTOZ_SCREEN_PUSH_URL');
  }
  const build = read('scripts/build-screen-app.ts');
  // Checked before the long build, and written into Info.plist from that one value.
  expect(build.indexOf('const pushEntry = screenPushPlistEntry(process.env.AGENTSTOZ_SCREEN_PUSH_URL);'))
    .toBeLessThan(build.indexOf("run(['swift', 'build'"));
  expect(build).toContain('${pushEntry}</dict>');
  expect(read('native/screen-control/Sources/ScreenHost/ScreenPush.swift')).toContain('bundle.object(forInfoDictionaryKey: "AgentsToZScreenPushURL")');
});

test('the iPhone app: no endpoint and no push entitlement unless a build asks for both', () => {
  const app = plist('mobile/ios/App/AgentsToZMobile.entitlements');
  expect(app['aps-environment']).toBeUndefined(); // today's TestFlight archive signs exactly as before
  const push = plist('mobile/ios/App/AgentsToZMobile.push.entitlements');
  expect(push).toEqual({ ...app, 'aps-environment': 'development' }); // Xcode's App Store export turns it into production
  expect(plist('mobile/ios/App/Info.plist').AgentsToZScreenPushURL).toBe('$(AGENTSTOZ_SCREEN_PUSH_URL)');
  const project = read('mobile/ios/AgentsToZMobile.xcodeproj/project.pbxproj');
  expect(project).not.toContain('AGENTSTOZ_SCREEN_PUSH_URL'); // undefined → empty → off
  expect(project).not.toContain('AgentsToZMobile.push.entitlements');
  expect(project).not.toContain('com.apple.Push');
  // A build opts in with AGENTSTOZ_APP_ENTITLEMENTS, which only the app reads. A command-line CODE_SIGN_ENTITLEMENTS
  // would reach every target, and the share extension's App ID has no push.
  const configs = project.split('\n').filter(line => line.includes('isa = XCBuildConfiguration;'));
  const appConfigs = configs.filter(line => line.includes('PRODUCT_BUNDLE_IDENTIFIER = "$(AGENTSTOZ_APP_BUNDLE_ID)";'));
  expect(appConfigs).toHaveLength(2);
  for (const line of appConfigs) {
    expect(line).toContain('AGENTSTOZ_APP_ENTITLEMENTS = App/AgentsToZMobile.entitlements; CODE_SIGN_ENTITLEMENTS = "$(AGENTSTOZ_APP_ENTITLEMENTS)";');
  }
  expect(configs.filter(line => line.includes('AGENTSTOZ_APP_ENTITLEMENTS'))).toEqual(appConfigs);
  const sources = project.split('\n').find(line => line.startsWith('878A52FC5FF6A57D50B7B870 = {'))!;
  for (const [file, build] of [['ScreenPushRegistration.swift', 'F5A000000000000000000002'], ['ScreenRemoteStopMenu.swift', 'F5A000000000000000000004']] as const) {
    expect(project).toContain(`path = "${file}"`);
    expect(sources).toContain(build);
  }
});

test('the iPhone app asks for notifications and APNs only from the push files, behind the endpoint', () => {
  const swift = (name: string) => read(`mobile/ios/App/${name}`);
  const registration = swift('ScreenPushRegistration.swift');
  for (const name of ['AgentsToZMobileApp.swift', 'RemoteHomeView.swift', 'ScreenMacsSection.swift', 'ScreenViewerView.swift', 'ScreenRegistrationSheet.swift', 'ScreenRemoteStopMenu.swift']) {
    expect(swift(name)).not.toMatch(/requestAuthorization|registerForRemoteNotifications/);
  }
  // At launch: nothing unless configured, and then only a token refresh for a device that already subscribed.
  const launch = registration.slice(registration.indexOf('didFinishLaunchingWithOptions'));
  expect(launch.indexOf('guard ScreenPushConfig.isEnabled else { return true }')).toBeLessThan(launch.indexOf('registerForRemoteNotifications'));
  expect(launch).toContain('if !ScreenPushTokens.load().isEmpty { application.registerForRemoteNotifications() }');
  // Permission is asked only inside 「알림 받기」, which needs an endpoint first.
  const subscribe = registration.slice(registration.indexOf('func subscribe('), registration.indexOf('func unsubscribe('));
  expect(subscribe.indexOf('guard ScreenPushConfig.isEnabled')).toBeLessThan(subscribe.indexOf('requestAuthorization'));
  expect(swift('ScreenRemoteStopMenu.swift')).toMatch(/var body: some View \{\n\s+if ScreenPushConfig\.isEnabled \{/);
  // Every remote stop and every subscription is approved with Face ID on that Mac's device key.
  expect(registration.match(/FaceIDApprovedSigner\.approve\(dataRepresentation: mac\.deviceKey/g)).toHaveLength(2);
});
