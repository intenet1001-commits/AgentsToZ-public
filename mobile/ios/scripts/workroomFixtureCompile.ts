/** The one compile recipe for the iPhone fixtures that embed the shipped LANWorkroomView:
 * check-workroom.ts, prepare-workroom-persona-device.ts and check-common-memory-device.ts.
 *
 * It used to be copied by hand into all three scripts, and that is how they broke: LANWorkroomView gained
 * `import ScreenControlCore` for 「Mac 화면」 and no copy followed (`no such module 'ScreenControlCore'`).
 * tests/ios-workroom-fixture-compile.test.ts now checks every local-package import and every App type the
 * listed files reach against this list.
 *
 * Swift 6, as the app target (SWIFT_VERSION 6.0) and both local packages (tools 6.0) are built. Every swiftc
 * call keeps Clang's and Swift's module caches inside the caller's build folder: the shared per-user cache
 * (`getconf DARWIN_USER_CACHE_DIR`/clang/ModuleCache) is outside the emulator sandbox's writable roots and is
 * shared between runs. */
import {readdirSync} from 'node:fs';
import {arch} from 'node:os';
import {join} from 'node:path';

export const WORKROOM_FIXTURE_SWIFT_VERSION = '6';

/** Local Swift packages, compiled as static modules in dependency order (sources are relative to the repo root). */
export const WORKROOM_FIXTURE_MODULES: readonly {readonly name: string; readonly sources: string}[] = Object.freeze([
  Object.freeze({name: 'AgentsToZCore', sources: 'mobile/ios/AgentsToZCore/Sources/AgentsToZCore'}),
  Object.freeze({name: 'ScreenControlCore', sources: 'native/screen-control/Sources/ScreenControlCore'}),
]);

/** App files compiled next to each probe. The Screen files are what LANWorkroomView's 「Mac 화면」 sheet reaches;
 * the fixtures never open that sheet. */
export const WORKROOM_FIXTURE_APP_SOURCES: readonly string[] = Object.freeze([
  'mobile/ios/App/PortalSchemeHandler.swift',
  'mobile/ios/App/WorkroomStoreWipe.swift',
  'mobile/ios/App/LANWorkroomView.swift',
  'mobile/ios/App/ScreenMacsSection.swift',
  'mobile/ios/App/CommunityActions.swift',
  'mobile/ios/App/CommunityActionsView.swift',
  'mobile/ios/App/ScreenCommunityDevices.swift',
  'mobile/ios/App/ScreenCommunityUseSession.swift',
  'mobile/ios/App/ScreenUnifiedEnrollment.swift',
  'mobile/ios/App/ScreenMacStore.swift',
  'mobile/ios/App/ScreenRegistrationSheet.swift',
  'mobile/ios/App/ScreenRemoteStopMenu.swift',
  'mobile/ios/App/ScreenPushRegistration.swift',
  'mobile/ios/App/ScreenViewerView.swift',
  'mobile/ios/App/QRScannerSheet.swift',
]);

/** The probe (the `@main` test app) of each fixture script. */
export const WORKROOM_FIXTURE_PROBES = Object.freeze({
  workroom: 'mobile/ios/scripts/fixtures/WorkroomProbe.swift',
  persona: 'mobile/ios/scripts/fixtures/WorkroomPersonaProbe.swift',
  commonMemory: 'mobile/ios/scripts/fixtures/CommonMemoryProbe.swift',
} as const);
export type WorkroomFixtureProbe = keyof typeof WORKROOM_FIXTURE_PROBES;

export function workroomFixtureTarget(platform: 'device' | 'simulator', cpu: string = arch()): string {
  return platform === 'device' ? 'arm64-apple-ios17.0' : `${cpu === 'arm64' ? 'arm64' : 'x86_64'}-apple-ios17.0-simulator`;
}

export function workroomFixtureSdk(platform: 'device' | 'simulator'): 'iphoneos' | 'iphonesimulator' {
  return platform === 'device' ? 'iphoneos' : 'iphonesimulator';
}

export interface WorkroomFixtureCompileInput {
  root: string;
  /** `xcrun --sdk <sdk> --show-sdk-path` */
  sdkPath: string;
  target: string;
  /** Scratch folder for the static modules and the module cache. */
  buildDir: string;
  probe: WorkroomFixtureProbe;
  /** The executable inside the .app folder. */
  output: string;
  /**
   * The caller already runs inside a Seatbelt sandbox (the emulator lane). swiftc normally runs macro plugins (the SDK's
   * `@Observable`) under its own sandbox-exec, and a sandboxed process cannot apply another one: the plugin server then
   * answers malformed and the compile fails. `-disable-sandbox` drops only that inner layer; the outer one stays.
   */
  nestedInSandbox?: boolean;
}

function swiftFiles(root: string, dir: string): string[] {
  return readdirSync(join(root, dir)).filter(name => name.endsWith('.swift')).sort().map(name => join(root, dir, name));
}

/** The swiftc argv lists, to run in order: each local module, then the probe app. */
export function workroomFixtureCompileCommands(input: WorkroomFixtureCompileInput): string[][] {
  const common = ['-target', input.target, '-sdk', input.sdkPath, '-swift-version', WORKROOM_FIXTURE_SWIFT_VERSION,
    '-module-cache-path', join(input.buildDir, 'ModuleCache'), ...(input.nestedInSandbox ? ['-disable-sandbox'] : [])];
  const modules = WORKROOM_FIXTURE_MODULES.map(module => ['xcrun', 'swiftc', '-parse-as-library', '-emit-library', '-static', '-emit-module',
    '-module-name', module.name, ...common, ...swiftFiles(input.root, module.sources),
    '-o', join(input.buildDir, `lib${module.name}.a`), '-emit-module-path', join(input.buildDir, `${module.name}.swiftmodule`)]);
  const app = ['xcrun', 'swiftc', '-parse-as-library', ...common, '-I', input.buildDir, '-L', input.buildDir,
    ...WORKROOM_FIXTURE_MODULES.map(module => `-l${module.name}`),
    ...WORKROOM_FIXTURE_APP_SOURCES.map(path => join(input.root, path)), join(input.root, WORKROOM_FIXTURE_PROBES[input.probe]),
    '-o', input.output];
  return [...modules, app];
}
