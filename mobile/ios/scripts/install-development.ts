import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { installedDevelopmentTeams, resolveDevelopmentTeam } from './signingTeam';
import { deriveBuildNumber, gitRunner, readBuildNumberFile } from '../../../buildVersion';

const root = resolve(import.meta.dir, '../../..');
const deviceIndex = process.argv.indexOf('--device');
const device = deviceIndex >= 0 ? process.argv[deviceIndex + 1] : undefined;
if (!device || !/^[0-9a-f-]{20,64}$/i.test(device)) {
  throw new Error('Usage: bun mobile/ios/scripts/install-development.ts --device <connected-device-id>');
}
const teamIndex = process.argv.indexOf('--team');
const requestedTeam = teamIndex >= 0 ? process.argv[teamIndex + 1] : undefined;
const bundleIndex=process.argv.indexOf('--bundle');
const bundleId=bundleIndex>=0?process.argv[bundleIndex+1]:'com.intenet.agentstoz.mobile.dev';
if(!['com.intenet.agentstoz.mobile','com.intenet.agentstoz.mobile.dev'].includes(bundleId??''))
  throw new Error('--bundle must identify the existing AgentsToZ main or development app.');
// Several teams are normal on this Mac; the shared rule prefers the TestFlight team.
const { team: developmentTeam, source: teamSource } = resolveDevelopmentTeam(installedDevelopmentTeams(), requestedTeam);
console.log(`Signing with Apple Development team ${developmentTeam} (${teamSource})`);
const git = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
const sourceCommit = new TextDecoder().decode(git.stdout).trim();
if (git.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error('A Git source commit is required.');
const status = Bun.spawnSync(['git', 'status', '--porcelain', '--', 'mobile/ios'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
if (status.exitCode !== 0 || status.stdout.length > 0) throw new Error('Commit the iOS source before creating a physical-device build.');
// Same number as a desktop build of this commit — counted from git, not read from a bump commit (buildVersion.ts).
const versionResult = deriveBuildNumber(readBuildNumberFile(root), gitRunner(root));
if (!versionResult.ok) throw new Error(`Invalid shared build number: ${versionResult.reason}`);
const { buildNumber } = versionResult;
if (!Number.isInteger(buildNumber) || buildNumber < 1) throw new Error('Invalid shared build number.');
const date = new Date();
const pad = (value: number) => String(value).padStart(2, '0');
const uniqueBuild = `${String(date.getUTCFullYear()).slice(-2)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
const derived = join(root, 'mobile/ios/build/USBDevelopment');
rmSync(derived, { recursive: true, force: true });
mkdirSync(derived, { recursive: true });

// Optional App Store Connect API key, kept outside the repository. Xcode 26 can show a signed-in
// account in Settings while its build system still reports "No Accounts"; a team API key lets
// -allowProvisioningUpdates regenerate profiles (e.g. after an App Group is added) without it.
// ~/.appstoreconnect/agentstoz-asc.json = { "keyId": "…", "issuerId": "…" } and the key at
// ~/.appstoreconnect/private_keys/AuthKey_<keyId>.p8.
function appStoreConnectAuthArgs(): string[] {
  const home = process.env.HOME ?? '';
  const configPath = join(home, '.appstoreconnect/agentstoz-asc.json');
  if (!existsSync(configPath)) return [];
  const { keyId, issuerId } = JSON.parse(readFileSync(configPath, 'utf8')) as { keyId?: string; issuerId?: string };
  if (!keyId || !/^[A-Z0-9]{8,12}$/.test(keyId) || !issuerId || !/^[0-9a-f-]{36}$/i.test(issuerId))
    throw new Error(`${configPath} needs a keyId and an issuerId.`);
  const keyPath = join(home, '.appstoreconnect/private_keys', `AuthKey_${keyId}.p8`);
  if (!existsSync(keyPath)) throw new Error(`App Store Connect key is missing: ${keyPath}`);
  console.log(`Provisioning with App Store Connect API key ${keyId}`);
  return ['-authenticationKeyPath', keyPath, '-authenticationKeyID', keyId, '-authenticationKeyIssuerID', issuerId];
}

async function command(args: string[], timeoutMs = 600_000) {
  const child = Bun.spawn(args, { cwd: root, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
  const timeout = setTimeout(() => child.kill(), timeoutMs);
  try {
    const exit = await child.exited;
    if (exit !== 0) throw new Error(`${args[0]} failed with exit ${exit}`);
  } finally { clearTimeout(timeout); }
}

// The app bundles the portal; build it from this commit so the device never gets a stale copy.
await command(['bun', join(root, 'mobile/ios/scripts/build-portal-web.ts')], 300_000);
// AGENTSTOZ_APP_BUNDLE_ID, not PRODUCT_BUNDLE_IDENTIFIER: a global bundle id would also rename
// the embedded share extension (`<app>.share`) to the app's own id and fail embedding. The
// App Group (`group.<app>`) follows the same setting.
await command([
  'xcodebuild', '-project', 'mobile/ios/AgentsToZMobile.xcodeproj', '-scheme', 'AgentsToZMobile',
  '-configuration', 'Debug', '-destination', `id=${device}`, '-derivedDataPath', derived,
  '-allowProvisioningUpdates', ...appStoreConnectAuthArgs(), `AGENTSTOZ_APP_BUNDLE_ID=${bundleId}`,
  `DEVELOPMENT_TEAM=${developmentTeam}`,
  `AGENTSTOZ_DISPLAY_NAME=${bundleId==='com.intenet.agentstoz.mobile'?'AgentsToZ':'AgentsToZ 개발'}`, 'AGENTSTOZ_RELEASE_CHANNEL=usb-development',
  `AGENTSTOZ_SOURCE_COMMIT=${sourceCommit}`, `MARKETING_VERSION=${buildNumber}.0.0`,
  `CURRENT_PROJECT_VERSION=${uniqueBuild}`, 'build',
]);
const app = join(derived, 'Build/Products/Debug-iphoneos/AgentsToZMobile.app');
if (!existsSync(app)) throw new Error('Signed iPhone application was not produced.');
await command(['xcrun', 'devicectl', 'device', 'install', 'app', '--device', device, app], 120_000);
await command(['xcrun', 'devicectl', 'device', 'process', 'launch', '--device', device, bundleId!], 60_000);
console.log(JSON.stringify({ installed: true, bundleId, developmentTeam, version: `${buildNumber}.0.0`, build: uniqueBuild, sourceCommit }));
