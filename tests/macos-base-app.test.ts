import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MACOS_BASE_CODE, MACOS_BASE_EMPTY_ENTITLEMENTS, MACOS_BASE_REQUIRED_FILES, inspectMacOSBaseBundle, planMacOSBaseAppSigning, signMacOSBaseApp, verifyMacOSBaseSignatureInspection } from '../src/macOSBaseAppSigning';
import { executeMacOSBaseAppPipelineForTest, macOSBaseBuildEnvironment, planMacOSBaseBuild, type MacOSBasePipelineDependencies } from '../src/macOSBaseAppPipeline';
import type { MacOSRuntimeProductionBuildIdentityResolution } from '../src/macOSRuntimeProductionCanary';
import { planSidecarBuild } from '../build-sidecar';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const identity = (): MacOSRuntimeProductionBuildIdentityResolution => ({
  diagnostic: { schemaVersion: 1, kind: 'macos-runtime-production-signing-canary', scope: 'build-key-possession-snapshot-only', result: 'snapshot-verified', reason: 'canary-snapshot-verified', authoritative: false, reusable: false, ready: false },
  identity: { certificateFingerprint: 'A'.repeat(40), teamIdentifier: 'Q1W2E3R4T5', commonName: 'Developer ID Application: Example (Q1W2E3R4T5)' },
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentstoz-base-test-'))); roots.push(root);
  const app = join(root, 'AgentsToZ_byCS.app');
  for (const path of MACOS_BASE_REQUIRED_FILES) { mkdirSync(dirname(join(app, path)), { recursive: true }); writeFileSync(join(app, path), 'fixture'); }
  const header = Buffer.alloc(8); header.writeUInt32LE(0xfeedfacf); header.writeUInt32LE(0x0100000c, 4);
  for (const code of MACOS_BASE_CODE) writeFileSync(join(app, code.path), header);
  const entitlements = join(root, 'empty.plist'); writeFileSync(entitlements, MACOS_BASE_EMPTY_ENTITLEMENTS);
  return { root, app, entitlements };
}
function inspection(app: string, code: typeof MACOS_BASE_CODE[number]) {
  return [`Executable=${join(app, code.path)}`, `Identifier=${code.identifier}`,
    `Format=${code.path === 'Contents/MacOS/app' ? 'app bundle with ' : ''}Mach-O thin (arm64)`,
    'CodeDirectory v=20500 size=800 flags=0x10000(runtime) hashes=1+7 location=embedded',
    'Hash type=sha256 size=32', 'CandidateCDHashFull sha256=' + 'a'.repeat(64), 'Signature size=9000',
    'Authority=' + identity().identity!.commonName, 'Authority=Developer ID Certification Authority', 'Authority=Apple Root CA',
    'TeamIdentifier=Q1W2E3R4T5', 'Timestamp=Sep 7, 2026 at 12:00:00', '<plist version="1.0"><dict/></plist>'].join('\n');
}

test('base build cannot inherit production pins, signing secrets or auto-loaded local settings', () => {
  const env = macOSBaseBuildEnvironment({ HOME: '/home/test', PATH: '/usr/bin', AGENTSTOZ_MACOS_RUNTIME_CLIENT_BRIDGE_SOURCE: '/foreign/bridge', RUSTFLAGS: '--cfg hacked', APPLE_CERTIFICATE_PASSWORD: 'secret', VITE_SUPABASE_SERVICE_ROLE_KEY: 'secret', NODE_OPTIONS: '--require bad' });
  expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'LC_ALL', 'MACOSX_DEPLOYMENT_TARGET', 'PATH']);
  const plan = planMacOSBaseBuild('/project', '/base/candidate', 'a'.repeat(40), env);
  expect(plan.map(c => c.executable)).toEqual(['/project/node_modules/.bin/vite', '/project/node_modules/.bin/tauri']);
  expect(plan[1]!.args).toContain('--no-sign');
  const config = JSON.parse(plan[1]!.args.at(-1)!);
  expect(config.bundle.resources.every((path: string) => !path.includes('*') && !path.includes('runtime-broker'))).toBeTrue();
  expect(config.bundle.macOS).toEqual({ signingIdentity: null, entitlements: null, minimumSystemVersion: '13.0' });
  const sidecars = planSidecarBuild({ kind: 'macos-developer-id-base' }, { platform: 'darwin', arch: 'arm64' });
  expect(sidecars.productionTeamIdentifierEmbedded).toBeFalse();
  for (const command of sidecars.commands) {
    expect(command.args).toContain('--no-compile-autoload-dotenv'); expect(command.args).toContain('--no-compile-autoload-bunfig');
    expect(command.args.join(' ')).not.toContain('__AGENTSTOZ_MACOS_RUNTIME_PRODUCTION_TEAM_IDENTIFIER__');
  }
  expect(() => planSidecarBuild({ kind: 'macos-developer-id-base' }, { platform: 'darwin', arch: 'x64' })).toThrow();
});

test('base bundle inventory rejects helpers, unexpected resources, symlinks, missing code and wrong architecture', () => {
  for (const invalid of ['helper', 'secret', 'symlink', 'missing', 'architecture']) {
    const { app, root } = fixture();
    expect(inspectMacOSBaseBundle(app)).toHaveLength(MACOS_BASE_REQUIRED_FILES.length);
    if (invalid === 'helper') { mkdirSync(join(app, 'Contents/Library')); writeFileSync(join(app, 'Contents/Library/runtime-broker'), 'bad'); }
    if (invalid === 'secret') writeFileSync(join(app, 'Contents/Resources/.env'), 'bad');
    const code = join(app, MACOS_BASE_CODE[0]!.path);
    if (invalid === 'symlink') { unlinkSync(code); symlinkSync(join(root, 'empty.plist'), code); }
    if (invalid === 'missing') unlinkSync(code);
    if (invalid === 'architecture') writeFileSync(code, Buffer.alloc(8));
    expect(() => inspectMacOSBaseBundle(app)).toThrow();
  }
});

test('base signing is inside-out, never ad-hoc, and requires actual canary evidence', () => {
  const { app, entitlements } = fixture();
  const plan = planMacOSBaseAppSigning(identity(), app, entitlements);
  expect(plan.filter(c => c.operation === 'sign').map(c => c.args.at(-1)))
    .toEqual([...MACOS_BASE_CODE.slice(0, 3).map(c => join(app, c.path)), app]);
  for (const c of plan.filter(c => c.operation === 'sign')) { expect(c.args).not.toContain('--deep'); expect(c.args).toContain('--timestamp'); }
  expect(() => planMacOSBaseAppSigning({ ...identity(), identity: null }, app, entitlements)).toThrow();
  expect(() => planMacOSBaseAppSigning(identity(), app, join(app, 'entitlements'))).toThrow();
  expect(() => planMacOSBaseAppSigning(identity(), app + '/../AgentsToZ_byCS.app', entitlements)).toThrow();
});

test('inspection requires a correct Developer ID chain, timestamp, runtime, empty entitlements and architecture on every binary', () => {
  const { app } = fixture();
  for (const code of MACOS_BASE_CODE) {
    const valid = inspection(app, code);
    expect(() => verifyMacOSBaseSignatureInspection(valid, app, code, identity())).not.toThrow();
    for (const invalid of [
      valid.replace('TeamIdentifier=Q1W2E3R4T5', 'TeamIdentifier=X1X2X3X4X5'),
      valid.replace('0x10000(runtime)', '0x2(adhoc)'), valid.replace('Timestamp=Sep 7, 2026 at 12:00:00', 'Timestamp=none'),
      valid.replace('<dict/>', '<dict><key>com.apple.security.get-task-allow</key><true/></dict>'),
      valid.replace('(arm64)', '(x86_64)'), valid.replace('Developer ID Certification Authority', 'Untrusted Authority'),
      valid + '\nTeamIdentifier=Q1W2E3R4T5', valid.replace('Signature size=9000', 'Signature=adhoc'),
    ]) expect(() => verifyMacOSBaseSignatureInspection(invalid, app, code, identity())).toThrow();
  }
});

test('signing fails at each command boundary without returning a successful receipt or falling back', async () => {
  const { app, entitlements } = fixture();
  const plan = planMacOSBaseAppSigning(identity(), app, entitlements);
  for (let failAt = 0; failAt < plan.length; failAt++) {
    let calls = 0;
    await expect(signMacOSBaseApp(identity(), app, entitlements, { runCodesign: async () => {
      const index = calls++; const command = plan[index]!;
      return { exitCode: index === failAt ? 1 : 0, stdout: command.operation === 'inspect' ? inspection(app, command.code) : '', stderr: '', timedOut: false, outputTruncated: false };
    } })).rejects.toThrow();
    expect(calls).toBe(failAt + 1);
  }
});

test('verified signing creates a digest and remains explicitly unnotarized and uninstalled', async () => {
  const { app, entitlements } = fixture();
  const plan = planMacOSBaseAppSigning(identity(), app, entitlements); let index = 0;
  const result = await signMacOSBaseApp(identity(), app, entitlements, { runCodesign: async () => {
    const command = plan[index++]!;
    return { exitCode: 0, stdout: command.operation === 'inspect' ? inspection(app, command.code) : '', stderr: '', timedOut: false, outputTruncated: false };
  } });
  expect(result).toMatchObject({ mode: 'developer-id-base', nestedCodeSigned: 3, enhancedRuntimeEnabled: false, notarized: false, installed: false, ready: false });
  expect(result.bundleDigest).toMatch(/^[0-9a-f]{64}$/);
});

test('base pipeline rejects unpublished/private/moving sources before issuing a release receipt', async () => {
  for (const fault of ['unpublished', 'private', 'changed-before-sign', 'changed-after-sign', 'sign-failed', 'stale-app', 'canary', 'none']) {
    const { root } = fixture(); let sourceChecks = 0; let signCalls = 0; let commands = 0;
    const source = { headSha: 'a'.repeat(40), remoteHeadSha: 'a'.repeat(40), currentBranch: 'main', remote: 'origin', remoteUrl: 'https://github.com/intenet1001-commits/AgentsToZ-public.git', defaultBranch: 'main', unpublishedOverride: false };
    const dependencies: MacOSBasePipelineDependencies = {
      verifySource: () => { sourceChecks++; return { ...source,
        unpublishedOverride: fault === 'unpublished', remoteUrl: fault === 'private' ? 'https://github.com/owner/private.git' : source.remoteUrl,
        ...((fault === 'changed-before-sign' && sourceChecks === 2 || fault === 'changed-after-sign' && sourceChecks === 3) ? { headSha: 'b'.repeat(40), remoteHeadSha: 'b'.repeat(40) } : {}),
      }; },
      resolveIdentity: async () => fault === 'canary' ? { ...identity(), identity: null } : identity(), createTarget: () => root,
      buildSidecars: async () => {}, run: async () => { commands++; }, assertFresh: () => { if (fault === 'stale-app') throw Error('stale'); }, now: () => 100,
      sign: async () => { signCalls++; if (fault === 'sign-failed') throw Error('sign failed'); return { schemaVersion: 1, mode: 'developer-id-base', result: 'signed-awaiting-notarization', appSigned: true, nestedCodeSigned: 3, bundleDigest: 'a'.repeat(64), enhancedRuntimeEnabled: false, notarized: false, installed: false, ready: false }; },
    };
    if (fault === 'none') {
      const receipt = await executeMacOSBaseAppPipelineForTest(root, dependencies);
      expect(JSON.parse(readFileSync(join(root, 'developer-id-base.receipt.json'), 'utf8'))).toEqual(receipt);
      expect(sourceChecks).toBe(3); expect(commands).toBe(2); expect(signCalls).toBe(1);
    } else {
      await expect(executeMacOSBaseAppPipelineForTest(root, dependencies)).rejects.toThrow();
      expect(() => readFileSync(join(root, 'developer-id-base.receipt.json'))).toThrow();
      if (['unpublished', 'private', 'canary'].includes(fault)) expect(commands).toBe(0);
      if (fault === 'changed-before-sign' || fault === 'stale-app') expect(signCalls).toBe(0);
    }
  }
});
