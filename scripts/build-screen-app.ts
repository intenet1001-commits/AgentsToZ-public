// Builds AgentsToZ Screen.app: the separate bundle that alone holds screen recording and Accessibility permission
// (DESIGN S0-5). `bun scripts/build-screen-app.ts [--notarize] [--install]` → native/screen-control/.build/AgentsToZ Screen.app
// (git-ignored); `--install` also replaces /Applications/AgentsToZ Screen.app and opens it in the menu bar.
// Signs with SCREEN_SIGN_IDENTITY, or the first "Developer ID Application" identity in the keychain. A real identity,
// not ad-hoc: TCC ties the permissions to the designated requirement, and an ad-hoc one changes with every build.
// The Developer ID provisioning profile grants the app its own keychain access group, where it keeps its identity key
// and registered devices (DESIGN 「보안 원칙」 2·3).
// `--notarize` signs with a secure timestamp, submits to Apple's notary service and staples the ticket, so Gatekeeper
// opens a downloaded copy without a warning. It uses the same App Store Connect team API key as the iOS scripts:
// ~/.appstoreconnect/agentstoz-asc.json = { "keyId": "…", "issuerId": "…" } and ~/.appstoreconnect/private_keys/AuthKey_<keyId>.p8.
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {basename, isAbsolute, join, resolve} from 'node:path';
// Notifications and remote stop: off unless AGENTSTOZ_SCREEN_PUSH_URL is set (DESIGN 「알림·원격 차단」).
import {screenPushPlistEntry} from './screenPushEndpoint';

const packagePath = resolve(import.meta.dir, '..', 'native', 'screen-control');
const teamID = 'DA8QKAQ2C9';
const bundleID = 'com.intenet.agentstozbycs.screen';
let appPath = join(packagePath, '.build', 'AgentsToZ Screen.app');
const installedPath = '/Applications/AgentsToZ Screen.app';
const profilePath = join(packagePath, 'App', 'AgentsToZ_Screen_Developer_ID.provisionprofile');
const args = process.argv.slice(2);
let bundleVersion = '0.2';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--bundle-version') {
    bundleVersion = args[++i] ?? '';
    if (!/^\d+\.\d+(?:\.\d+)?$/.test(bundleVersion)) throw Error('Invalid Screen bundle version');
  } else if (args[i] === '--output') {
    appPath = args[++i] ?? '';
    if (!isAbsolute(appPath) || basename(appPath) !== 'AgentsToZ Screen.app') throw Error('Invalid Screen app output');
  } else if (!['--notarize', '--install', '--timestamp'].includes(args[i]!)) {
    throw Error(`Unsupported Screen build option: ${args[i]}`);
  }
}

function run(command: string[]): string {
  const result = Bun.spawnSync(command, {stdout: 'pipe', stderr: 'pipe'});
  if (result.exitCode !== 0) throw Error(`${command.join(' ')} failed:\n${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function signingIdentity(): string {
  if (process.env.SCREEN_SIGN_IDENTITY) return process.env.SCREEN_SIGN_IDENTITY;
  const line = run(['security', 'find-identity', '-v', '-p', 'codesigning']).split('\n')
    .find(entry => entry.includes('"Developer ID Application:'));
  const hash = line?.trim().split(/\s+/)[1];
  if (!hash) throw Error('No "Developer ID Application" identity; set SCREEN_SIGN_IDENTITY');
  return hash;
}

// Checked before building, so a mistyped endpoint fails at once instead of building an app with it off.
const pushEntry = screenPushPlistEntry(process.env.AGENTSTOZ_SCREEN_PUSH_URL);
run(['swift', 'build', '-c', 'release', '--package-path', packagePath, '--product', 'AgentsToZScreen']);
const binPath = run(['swift', 'build', '-c', 'release', '--package-path', packagePath, '--show-bin-path']);

rmSync(appPath, {recursive: true, force: true});
mkdirSync(join(appPath, 'Contents', 'MacOS'), {recursive: true});
cpSync(join(binPath, 'AgentsToZScreen'), join(appPath, 'Contents', 'MacOS', 'AgentsToZScreen'));
cpSync(profilePath, join(appPath, 'Contents', 'embedded.provisionprofile'));
writeFileSync(join(appPath, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${bundleID}</string>
  <key>CFBundleName</key><string>AgentsToZ Screen</string>
  <key>CFBundleDisplayName</key><string>AgentsToZ Screen</string>
  <key>CFBundleExecutable</key><string>AgentsToZScreen</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${bundleVersion}</string>
  <key>CFBundleVersion</key><string>${bundleVersion === '0.2' ? '2' : bundleVersion}</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSLocalNetworkUsageDescription</key><string>Your registered iPhone or iPad connects to this Mac using nearby Wi‑Fi to view and control the screen.</string>
  <key>NSBonjourServices</key><array><string>_atzscreen._tcp</string></array>
${pushEntry}</dict>
</plist>
`);

const entitlements = join(mkdtempSync(join(tmpdir(), 'agentstoz-screen-')), 'entitlements.plist');
writeFileSync(entitlements, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.application-identifier</key><string>${teamID}.${bundleID}</string>
  <key>com.apple.developer.team-identifier</key><string>${teamID}</string>
  <key>keychain-access-groups</key><array><string>${teamID}.${bundleID}</string></array>
</dict>
</plist>
`);

const notarize = process.argv.includes('--notarize');

function notaryAuthArgs(): string[] {
  const configPath = join(homedir(), '.appstoreconnect', 'agentstoz-asc.json');
  if (!existsSync(configPath)) throw Error(`--notarize needs ${configPath} with a keyId and an issuerId`);
  const {keyId, issuerId} = JSON.parse(readFileSync(configPath, 'utf8')) as {keyId?: string; issuerId?: string};
  if (!keyId || !/^[A-Z0-9]{8,12}$/.test(keyId) || !issuerId || !/^[0-9a-f-]{36}$/i.test(issuerId))
    throw Error(`${configPath} needs a keyId and an issuerId.`);
  const keyPath = join(homedir(), '.appstoreconnect', 'private_keys', `AuthKey_${keyId}.p8`);
  if (!existsSync(keyPath)) throw Error(`App Store Connect key is missing: ${keyPath}`);
  return ['--key', keyPath, '--key-id', keyId, '--issuer', issuerId];
}

// The notary service refuses a signature without a secure timestamp; local builds skip the timestamp server.
run(['codesign', '--force', '--options', 'runtime', notarize || args.includes('--timestamp') ? '--timestamp' : '--timestamp=none', '--identifier', bundleID,
  '--entitlements', entitlements, '--sign', signingIdentity(), appPath]);
run(['codesign', '--verify', '--strict', appPath]);
const requirement = Bun.spawnSync(['codesign', '-d', '-r-', appPath], {stdout: 'pipe', stderr: 'pipe'});
console.log(appPath);
console.log((requirement.stdout.toString() + requirement.stderr.toString()).split('\n').find(line => line.startsWith('designated')) ?? '');

if (notarize) {
  const archive = join(mkdtempSync(join(tmpdir(), 'agentstoz-screen-notary-')), 'AgentsToZ Screen.zip');
  run(['ditto', '-c', '-k', '--keepParent', appPath, archive]);
  // --wait returns when Apple has decided; a rejected submission still exits 0, so read the status.
  const submission = JSON.parse(run(['xcrun', 'notarytool', 'submit', archive, ...notaryAuthArgs(), '--wait',
    '--timeout', '30m', '--output-format', 'json'])) as {id?: string; status?: string};
  if (submission.status !== 'Accepted') {
    const log = submission.id ? Bun.spawnSync(['xcrun', 'notarytool', 'log', submission.id, ...notaryAuthArgs()],
      {stdout: 'pipe', stderr: 'pipe'}).stdout.toString() : '';
    throw Error(`Notarization ${submission.status ?? 'failed'} (${submission.id ?? 'no id'})\n${log}`);
  }
  run(['xcrun', 'stapler', 'staple', appPath]);
  rmSync(archive, {force: true});
  console.log(`notarized ${submission.id}`);
  const assessment = Bun.spawnSync(['spctl', '--assess', '--type', 'execute', '-vv', appPath], {stdout: 'pipe', stderr: 'pipe'});
  const verdict = (assessment.stdout.toString() + assessment.stderr.toString()).trim();
  if (assessment.exitCode !== 0) throw Error(`Gatekeeper refused the notarized app:\n${verdict}`);
  console.log(verdict);
}

if (process.argv.includes('--install')) {
  // Quit the running copy by its own PID only, then replace and reopen it.
  const executable = join(installedPath, 'Contents', 'MacOS', 'AgentsToZScreen');
  const running = Bun.spawnSync(['pgrep', '-f', `^${executable}$`], {stdout: 'pipe'}).stdout.toString().trim();
  for (const pid of running.split('\n').filter(Boolean)) process.kill(Number(pid), 'SIGTERM');
  rmSync(installedPath, {recursive: true, force: true});
  run(['ditto', appPath, installedPath]);
  run(['open', installedPath]);
  console.log(`installed ${installedPath}`);
}
