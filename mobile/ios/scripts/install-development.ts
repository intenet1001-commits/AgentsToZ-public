import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { appleDevelopmentIdentityLabels, appleTeamIdentifierFromSubject } from './signingTeam';

const root = resolve(import.meta.dir, '../../..');
const deviceIndex = process.argv.indexOf('--device');
const device = deviceIndex >= 0 ? process.argv[deviceIndex + 1] : undefined;
if (!device || !/^[0-9a-f-]{20,64}$/i.test(device)) {
  throw new Error('Usage: bun mobile/ios/scripts/install-development.ts --device <connected-device-id>');
}
const teamIndex = process.argv.indexOf('--team');
const requestedTeam = teamIndex >= 0 ? process.argv[teamIndex + 1] : undefined;
if (requestedTeam && !/^[A-Z0-9]{10}$/.test(requestedTeam)) throw new Error('--team must be a 10-character Apple Team ID.');
const bundleIndex=process.argv.indexOf('--bundle');
const bundleId=bundleIndex>=0?process.argv[bundleIndex+1]:'com.intenet.agentstoz.mobile.dev';
if(!['com.intenet.agentstoz.mobile','com.intenet.agentstoz.mobile.dev'].includes(bundleId??''))
  throw new Error('--bundle must identify the existing AgentsToZ main or development app.');
const identities = Bun.spawnSync(['security', 'find-identity', '-v', '-p', 'codesigning'], { stdout: 'pipe', stderr: 'pipe' });
if (identities.exitCode !== 0) throw new Error('Apple Development signing identities could not be inspected.');
const identityText = new TextDecoder().decode(identities.stdout);
const teams = [...new Set(appleDevelopmentIdentityLabels(identityText).flatMap(label => {
  const certificate = Bun.spawnSync(['security', 'find-certificate', '-p', '-c', label], { stdout: 'pipe', stderr: 'pipe' });
  if (certificate.exitCode !== 0 || certificate.stdout.length === 0) return [];
  try {
    const team = appleTeamIdentifierFromSubject(new X509Certificate(certificate.stdout).subject);
    return team ? [team] : [];
  } catch { return []; }
}))];
const developmentTeam = requestedTeam ?? (teams.length === 1 ? teams[0] : undefined);
if (!developmentTeam || !teams.includes(developmentTeam)) {
  throw new Error(teams.length > 1
    ? 'Several Apple Development teams are installed. Retry with --team <team-id>.'
    : 'A matching Apple Development signing identity is required.');
}
const git = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
const sourceCommit = new TextDecoder().decode(git.stdout).trim();
if (git.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error('A Git source commit is required.');
const status = Bun.spawnSync(['git', 'status', '--porcelain', '--', 'mobile/ios'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
if (status.exitCode !== 0 || status.stdout.length > 0) throw new Error('Commit the iOS source before creating a physical-device build.');
const { buildNumber } = await Bun.file(join(root, 'build-number.json')).json() as { buildNumber: number };
if (!Number.isInteger(buildNumber) || buildNumber < 1) throw new Error('Invalid shared build number.');
const date = new Date();
const pad = (value: number) => String(value).padStart(2, '0');
const uniqueBuild = `${String(date.getUTCFullYear()).slice(-2)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
const derived = join(root, 'mobile/ios/build/USBDevelopment');
rmSync(derived, { recursive: true, force: true });
mkdirSync(derived, { recursive: true });

async function command(args: string[], timeoutMs = 600_000) {
  const child = Bun.spawn(args, { cwd: root, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
  const timeout = setTimeout(() => child.kill(), timeoutMs);
  try {
    const exit = await child.exited;
    if (exit !== 0) throw new Error(`${args[0]} failed with exit ${exit}`);
  } finally { clearTimeout(timeout); }
}

await command([
  'xcodebuild', '-project', 'mobile/ios/AgentsToZMobile.xcodeproj', '-scheme', 'AgentsToZMobile',
  '-configuration', 'Debug', '-destination', `id=${device}`, '-derivedDataPath', derived,
  '-allowProvisioningUpdates', `PRODUCT_BUNDLE_IDENTIFIER=${bundleId}`,
  `DEVELOPMENT_TEAM=${developmentTeam}`,
  `AGENTSTOZ_DISPLAY_NAME=${bundleId==='com.intenet.agentstoz.mobile'?'AgentsToZ':'AgentsToZ 개발'}`, 'AGENTSTOZ_RELEASE_CHANNEL=usb-development',
  `AGENTSTOZ_SOURCE_COMMIT=${sourceCommit}`, `MARKETING_VERSION=${buildNumber}.0.0`,
  `CURRENT_PROJECT_VERSION=${uniqueBuild}`, 'build',
]);
const app = join(derived, 'Build/Products/Debug-iphoneos/AgentsToZMobile.app');
if (!existsSync(app)) throw new Error('Signed iPhone application was not produced.');
await command(['xcrun', 'devicectl', 'device', 'install', 'app', '--device', device, app], 120_000);
await command(['xcrun', 'devicectl', 'device', 'process', 'launch', '--device', device, bundleId!], 60_000);
console.log(JSON.stringify({ installed: true, bundleId, version: `${buildNumber}.0.0`, build: uniqueBuild, sourceCommit }));
