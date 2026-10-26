import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertScreenBundleEntitlements, screenBundleBuildEnvironment } from '../stageScreenControlBundle';
import {
  assertNotaryAccepted,
  assertNotarizedGatekeeperVerdict,
  assertTeamAnchoredDesignatedRequirement,
  classifyDeveloperIdMachO,
  DEVELOPER_ID_ENTITLEMENT_KEYS,
  developerIdCodesignArguments,
  developerIdEntitlementsPlist,
  entitlementKeys,
  findMachOFiles,
  freshDmgs,
  notaryAuthArguments,
  parseNotarySubmission,
  planDeveloperIdSigning,
  readNotaryApiKey,
  resolveMacOSCargoTargetDir,
} from '../src/macOSDeveloperIdBuild';

const buildScript = readFileSync(new URL('../build-macos.ts', import.meta.url), 'utf8');
const voiceEntitlements = readFileSync(new URL('../src-tauri/Voice.entitlements', import.meta.url), 'utf8');
const infoPlist = readFileSync(new URL('../src-tauri/Info.plist', import.meta.url), 'utf8');

const R = 'Contents/Resources/resources/';
const CEF = 'Contents/Frameworks/Chromium Embedded Framework.framework';
const helper = (variant: string) => `Contents/Frameworks/app Helper${variant}.app/Contents/MacOS/app Helper${variant}`;
// The Mach-O layout of the embedded-browser app installed on 2026-10-25.
const BROWSER_APP_MACHO = [
  'Contents/MacOS/app',
  `${R}agentstoz-api-sidecar`, `${R}agentstoz-use-mcp`, `${R}agentstoz-agent-runtime-guard`, `${R}agentstoz-kmsg`,
  'Contents/Library/LaunchServices/com.intenet.agentstozbycs.runtime-broker',
  'Contents/Library/LaunchServices/com.intenet.agentstozbycs.runtime-dedicated-worker-fixture',
  `${CEF}/Chromium Embedded Framework`,
  `${CEF}/Libraries/libcef_sandbox.dylib`, `${CEF}/Libraries/libvk_swiftshader.dylib`, `${CEF}/Libraries/libvulkan.dylib`,
  helper(''), helper(' (GPU)'), helper(' (Renderer)'), helper(' (Plugin)'), helper(' (Alerts)'),
];
const FINGERPRINT = 'A'.repeat(40);
const codesignInput = {
  appBundlePath: '/build/AgentsToZ_byCS.app',
  certificateFingerprint: FINGERPRINT,
  entitlementPaths: { gui: '/work/gui.entitlements', jit: '/work/jit.entitlements' },
};

describe('Developer ID signing plan', () => {
  test('Screen packaging excludes private endpoints and accepts only its exact keychain grants', () => {
    expect(screenBundleBuildEnvironment({ HOME: '/home/builder', PATH: '/bin', AGENTSTOZ_SCREEN_PUSH_URL: 'https://private.invalid', SECRET: 'not-inherited' }))
      .toEqual({ HOME: '/home/builder', PATH: '/bin' });
    const app = 'DA8QKAQ2C9.com.intenet.agentstozbycs.screen';
    const xml = `<plist version="1.0"><dict><key>com.apple.application-identifier</key><string>${app}</string><key>com.apple.developer.team-identifier</key><string>DA8QKAQ2C9</string><key>keychain-access-groups</key><array><string>${app}</string></array></dict></plist>`;
    expect(() => assertScreenBundleEntitlements(xml)).not.toThrow();
    expect(() => assertScreenBundleEntitlements(xml.replace(`<array><string>${app}</string>`, '<array><string>foreign.group</string>'))).toThrow();
    expect(() => assertScreenBundleEntitlements(xml.replace('</array>', '<string>extra.group</string></array>'))).toThrow();
    expect(() => assertScreenBundleEntitlements(xml.replace('</dict>', '<key>unexpected</key><true/></dict>'))).toThrow();
  });
  test('gives each piece only its own entitlements', () => {
    expect(classifyDeveloperIdMachO('Contents/MacOS/app')).toEqual({ path: '', kind: 'app', entitlements: 'gui' });
    for (const [name, identifier] of [
      ['agentstoz-api-sidecar', 'com.intenet.agentstozbycs.sidecar.api'],
      ['agentstoz-use-mcp', 'com.intenet.agentstozbycs.sidecar.use-mcp'],
      ['agentstoz-agent-runtime-guard', 'com.intenet.agentstozbycs.sidecar.runtime-guard'],
    ]) {
      // bun-compiled: JavaScriptCore JIT and bun:ffi need allow-jit under the hardened runtime.
      expect(classifyDeveloperIdMachO(R + name)).toEqual({ path: R + name, kind: 'executable', identifier, entitlements: 'jit' });
    }
    expect(classifyDeveloperIdMachO(`${R}agentstoz-kmsg`).entitlements).toBe('none');
    expect(classifyDeveloperIdMachO('Contents/Library/LaunchServices/com.intenet.agentstozbycs.runtime-broker'))
      .toEqual({ path: 'Contents/Library/LaunchServices/com.intenet.agentstozbycs.runtime-broker', kind: 'executable', identifier: 'com.intenet.agentstozbycs.runtime-broker', entitlements: 'none' });
    expect(classifyDeveloperIdMachO(`${CEF}/Chromium Embedded Framework`)).toEqual({ path: CEF, kind: 'framework', entitlements: 'none' });
    expect(classifyDeveloperIdMachO(`${CEF}/Libraries/libvulkan.dylib`)).toEqual({ path: `${CEF}/Libraries/libvulkan.dylib`, kind: 'library', entitlements: 'none' });
    // Chrome signs its own helpers the same way: only Renderer (V8) and GPU (SwiftShader) JIT.
    expect(classifyDeveloperIdMachO(helper(' (Renderer)'))).toEqual({ path: 'Contents/Frameworks/app Helper (Renderer).app', kind: 'helper-app', entitlements: 'jit' });
    expect(classifyDeveloperIdMachO(helper(' (GPU)')).entitlements).toBe('jit');
    for (const variant of ['', ' (Plugin)', ' (Alerts)']) expect(classifyDeveloperIdMachO(helper(variant)).entitlements).toBe('none');
  });

  test('refuses a Mach-O nobody planned a policy for instead of guessing one', () => {
    expect(() => classifyDeveloperIdMachO(`${R}some-new-binary`)).toThrow('Unplanned Mach-O');
    expect(() => classifyDeveloperIdMachO('Contents/Frameworks/app Helper (GPU).app/Contents/MacOS/other')).toThrow('Unplanned Mach-O');
    expect(() => classifyDeveloperIdMachO(`${CEF}/Libraries/nested/libx.dylib`)).toThrow('Unplanned Mach-O');
  });

  test('signs inside-out: loose executables, dylibs, framework, helpers, then the app', () => {
    const plan = planDeveloperIdSigning(BROWSER_APP_MACHO);
    expect(plan).toHaveLength(BROWSER_APP_MACHO.length);
    const kinds = plan.map(target => target.kind);
    expect(kinds.at(-1)).toBe('app');
    const firstIndex = (kind: string) => kinds.indexOf(kind as never);
    const lastIndex = (kind: string) => kinds.lastIndexOf(kind as never);
    expect(lastIndex('executable')).toBeLessThan(firstIndex('library'));
    expect(lastIndex('library')).toBeLessThan(firstIndex('framework'));
    expect(firstIndex('framework')).toBeLessThan(firstIndex('helper-app'));
    expect(lastIndex('helper-app')).toBeLessThan(firstIndex('app'));
    // The plain (no embedded browser) app has no framework and no helpers.
    expect(planDeveloperIdSigning(BROWSER_APP_MACHO.filter(path => !path.startsWith('Contents/Frameworks/'))).map(t => t.kind))
      .toEqual(['executable', 'executable', 'executable', 'executable', 'executable', 'executable', 'app']);
  });

  test('rejects an incomplete bundle', () => {
    expect(() => planDeveloperIdSigning(BROWSER_APP_MACHO.filter(path => path !== 'Contents/MacOS/app'))).toThrow('Contents/MacOS/app');
    expect(() => planDeveloperIdSigning(BROWSER_APP_MACHO.filter(path => path !== `${CEF}/Chromium Embedded Framework`))).toThrow('must ship together');
  });

  test('preserves the independently signed Screen payload without treating it as a Chromium helper', () => {
    const path = 'Contents/Helpers/AgentsToZ Screen.app';
    const plan = planDeveloperIdSigning(['Contents/MacOS/app', `${path}/Contents/MacOS/AgentsToZScreen`]);
    expect(plan).toEqual([
      { path, kind: 'screen-app', entitlements: 'none' },
      { path: '', kind: 'app', entitlements: 'gui' },
    ]);
    expect(() => developerIdCodesignArguments(plan[0]!, codesignInput)).toThrow('never re-signed');
    expect(() => classifyDeveloperIdMachO(`${path}/Contents/MacOS/unreviewed`)).toThrow('Unplanned Mach-O');
  });

  test('every signature has the hardened runtime and a secure timestamp; only the GUI gets the GUI plist', () => {
    for (const target of planDeveloperIdSigning(BROWSER_APP_MACHO)) {
      const args = developerIdCodesignArguments(target, codesignInput);
      expect(args.slice(0, 6)).toEqual(['--force', '--sign', FINGERPRINT, '--options', 'runtime', '--timestamp']);
      expect(args.at(-1)).toBe(target.path ? `${codesignInput.appBundlePath}/${target.path}` : codesignInput.appBundlePath);
      expect(args.includes('/work/gui.entitlements')).toBe(target.kind === 'app');
      expect(args.includes('/work/jit.entitlements')).toBe(target.entitlements === 'jit');
      expect(args.includes('--requirements')).toBe(target.kind === 'app');
      expect(args).not.toContain('--deep');
      expect(args).not.toContain('--preserve-metadata=entitlements');
    }
    const app = developerIdCodesignArguments(classifyDeveloperIdMachO('Contents/MacOS/app'), codesignInput);
    const requirement = app[app.indexOf('--requirements') + 1]!;
    expect(requirement.startsWith('=designated => identifier "com.intenet.agentstozbycs" and anchor apple generic')).toBe(true);
    expect(requirement).toContain('certificate leaf[subject.OU] = "DA8QKAQ2C9"');
    expect(() => developerIdCodesignArguments(classifyDeveloperIdMachO('Contents/MacOS/app'), { ...codesignInput, certificateFingerprint: 'Developer ID Application' })).toThrow();
  });

  test('the GUI keeps every existing entitlement, adds Apple Events, and Info.plist explains both', () => {
    const existing = entitlementKeys(voiceEntitlements);
    expect(existing.length).toBeGreaterThan(0);
    for (const key of existing) expect(DEVELOPER_ID_ENTITLEMENT_KEYS.gui).toContain(key);
    expect(DEVELOPER_ID_ENTITLEMENT_KEYS.gui).toContain('com.apple.security.automation.apple-events');
    expect(infoPlist).toContain('<key>NSMicrophoneUsageDescription</key>');
    expect(infoPlist).toContain('<key>NSAppleEventsUsageDescription</key>');
    expect(entitlementKeys(developerIdEntitlementsPlist('gui'))).toEqual([...DEVELOPER_ID_ENTITLEMENT_KEYS.gui].sort());
    expect(entitlementKeys(developerIdEntitlementsPlist('jit'))).toEqual(['com.apple.security.cs.allow-jit']);
    for (const kind of ['jit', 'none'] as const) {
      expect(DEVELOPER_ID_ENTITLEMENT_KEYS[kind]).not.toContain('com.apple.security.device.audio-input');
      expect(DEVELOPER_ID_ENTITLEMENT_KEYS[kind]).not.toContain('com.apple.security.automation.apple-events');
    }
  });
});

describe('Developer ID verification helpers', () => {
  test('accepts only a Team ID anchored designated requirement', () => {
    const notarized = 'Executable=/x/AgentsToZ_byCS.app/Contents/MacOS/app\ndesignated => identifier "com.intenet.agentstozbycs" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = DA8QKAQ2C9\n';
    expect(assertTeamAnchoredDesignatedRequirement(notarized)).toStartWith('designated => identifier "com.intenet.agentstozbycs"');
    // Today's ad-hoc requirement — the one any same-identifier code can satisfy.
    expect(() => assertTeamAnchoredDesignatedRequirement('designated => identifier "com.intenet.agentstozbycs"')).toThrow('Team ID');
    expect(() => assertTeamAnchoredDesignatedRequirement(notarized.replace('DA8QKAQ2C9', 'ZZZZZZZZZZ'))).toThrow('Team ID');
    expect(() => assertTeamAnchoredDesignatedRequirement(notarized.replace('DA8QKAQ2C9', 'DA8QKAQ2C99'))).toThrow('Team ID');
  });

  test('reads the notary result and refuses anything but Accepted', () => {
    const accepted = parseNotarySubmission('Conducting pre-submission checks…\n{"id":"0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e","status":"Accepted","message":"Processing complete"}');
    expect(assertNotaryAccepted(accepted, '')).toBe('0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e');
    const invalid = parseNotarySubmission('{"id":"0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e","status":"Invalid","message":"Processing complete"}');
    expect(() => assertNotaryAccepted(invalid, '{"issues":[{"message":"The executable does not have the hardened runtime enabled."}]}'))
      .toThrow('hardened runtime');
    expect(() => assertNotaryAccepted(parseNotarySubmission('{"status":"Accepted"}'), '')).toThrow('no submission id');
    expect(() => parseNotarySubmission('Error: HTTP status code: 401')).toThrow('no JSON');
  });

  test('requires Gatekeeper to see notarized Developer ID code', () => {
    expect(assertNotarizedGatekeeperVerdict('/x/AgentsToZ_byCS.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: A (DA8QKAQ2C9)\n', 'app'))
      .toContain('source=Notarized Developer ID');
    expect(() => assertNotarizedGatekeeperVerdict('/x/AgentsToZ_byCS.app: accepted\nsource=Developer ID\n', 'app')).toThrow('notarized');
    expect(() => assertNotarizedGatekeeperVerdict('/x/AgentsToZ_byCS.app: rejected\nsource=Notarized Developer ID\n', 'app')).toThrow('notarized');
  });

  test('uses the App Store Connect team key by path and never reads the key itself', () => {
    const home = '/Users/someone';
    const config = `${home}/.appstoreconnect/agentstoz-asc.json`;
    const key = `${home}/.appstoreconnect/private_keys/AuthKey_ABCDE12345.p8`;
    const fs = (files: Record<string, string | true>) => ({
      existsSync: (path: string) => path in files,
      readFileSync: (path: string) => {
        if (path !== config) throw new Error(`read of ${path}`);
        return files[path] as string;
      },
    });
    const good = readNotaryApiKey(home, fs({ [config]: '{"keyId":"ABCDE12345","issuerId":"69a6de7e-1111-2222-3333-444455556666"}', [key]: true }));
    expect(notaryAuthArguments(good)).toEqual(['--key', key, '--key-id', 'ABCDE12345', '--issuer', '69a6de7e-1111-2222-3333-444455556666']);
    expect(() => readNotaryApiKey(home, fs({}))).toThrow('agentstoz-asc.json');
    expect(() => readNotaryApiKey(home, fs({ [config]: '{"keyId":"../../x","issuerId":"69a6de7e-1111-2222-3333-444455556666"}', [key]: true }))).toThrow('keyId');
    expect(() => readNotaryApiKey(home, fs({ [config]: '{"keyId":"ABCDE12345","issuerId":"69a6de7e-1111-2222-3333-444455556666"}' }))).toThrow('key is missing');
  });

  test('finds Mach-O files by magic, not by name', () => {
    const root = mkdtempSync(join(tmpdir(), 'devid-macho-'));
    try {
      const app = join(root, 'AgentsToZ_byCS.app');
      mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
      mkdirSync(join(app, 'Contents/Resources/resources/templates'), { recursive: true });
      writeFileSync(join(app, 'Contents/MacOS/app'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]));
      writeFileSync(join(app, 'Contents/Resources/resources/agentstoz-kmsg'), Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]));
      writeFileSync(join(app, 'Contents/Resources/resources/templates/run.py'), '#!/usr/bin/env python3\n');
      writeFileSync(join(app, 'Contents/Info.plist'), '<plist/>');
      expect(findMachOFiles(app)).toEqual(['Contents/MacOS/app', 'Contents/Resources/resources/agentstoz-kmsg']);
      const dmgDir = join(root, 'dmg');
      mkdirSync(dmgDir);
      writeFileSync(join(dmgDir, 'AgentsToZ_byCS_1_aarch64.dmg'), '');
      writeFileSync(join(dmgDir, 'rw.1.AgentsToZ_byCS_1_aarch64.dmg'), '');
      expect(freshDmgs(dmgDir, 0)).toEqual([join(dmgDir, 'AgentsToZ_byCS_1_aarch64.dmg')]);
      expect(freshDmgs(dmgDir, Date.now() + 60_000)).toEqual([]);
      expect(freshDmgs(join(root, 'missing'), 0)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('build-macos.ts --developer-id wiring', () => {
  test('resolves the Cargo target dir: override, Developer ID sibling, unchanged default', () => {
    expect(resolveMacOSCargoTargetDir({}, '/Users/u', false)).toBe('/Users/u/cargo-targets/portmanager');
    expect(resolveMacOSCargoTargetDir({ AGENTSTOZ_CARGO_TARGET_DIR: '' }, '/Users/u', false)).toBe('/Users/u/cargo-targets/portmanager');
    expect(resolveMacOSCargoTargetDir({}, '/Users/u', true)).toBe('/Users/u/cargo-targets/portmanager-devid');
    expect(resolveMacOSCargoTargetDir({ AGENTSTOZ_CARGO_TARGET_DIR: '/tmp/t/../t2' }, '/Users/u', true)).toBe('/tmp/t2');
    expect(() => resolveMacOSCargoTargetDir({ AGENTSTOZ_CARGO_TARGET_DIR: 'relative/dir' }, '/Users/u', false)).toThrow('absolute');
    expect(buildScript).not.toContain('join(homedir(), "cargo-targets", "portmanager")');
    expect(buildScript).toContain('resolveMacOSCargoTargetDir(process.env, homedir(), developerId)');
  });

  test('is opt-in: the default keeps its ad-hoc signature and identifier-only requirement', () => {
    expect(buildScript).toContain('"--developer-id"');
    expect(buildScript).toContain('const developerIdPreflight = developerId ? await preflightDeveloperId() : undefined;');
    // The preflight runs before anything mutates the checkout or spends a build.
    expect(buildScript.indexOf('await preflightDeveloperId()')).toBeLessThan(buildScript.indexOf('await $`bun update-version.ts`'));
    const devidBranch = buildScript.indexOf('if (developerIdPreflight) {\n    // Opt-in only');
    const adhocBranch = buildScript.indexOf("const stableRequirement = '=designated => identifier \"com.intenet.agentstozbycs\"'");
    expect(devidBranch).toBeGreaterThan(buildScript.indexOf('stageMacOSRuntimeDevelopmentBundle({'));
    expect(adhocBranch).toBeGreaterThan(devidBranch);
    const elseBranch = buildScript.indexOf('} else {', devidBranch);
    expect(elseBranch).toBeGreaterThan(devidBranch);
    expect(elseBranch).toBeLessThan(adhocBranch);
    // Nothing ad-hoc runs on the Developer ID branch; every ad-hoc command stays on the default one.
    expect(buildScript.slice(devidBranch, elseBranch)).not.toContain('--sign -');
    expect(buildScript.slice(elseBranch, adhocBranch)).toContain('codesign --force --deep --sign - ${browserStage.frameworkPath}');
  });
});
