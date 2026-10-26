import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const SCREEN_HELPER_BUNDLE_PATH = 'Contents/Helpers/AgentsToZ Screen.app';
export const SCREEN_HELPER_IDENTIFIER = 'com.intenet.agentstozbycs.screen';
export const SCREEN_HELPER_TEAM = 'DA8QKAQ2C9';
export const SCREEN_HELPER_REQUIREMENT = `identifier "${SCREEN_HELPER_IDENTIFIER}" and anchor apple generic`
  + ' and certificate 1[field.1.2.840.113635.100.6.2.6] exists'
  + ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
  + ` and certificate leaf[subject.OU] = "${SCREEN_HELPER_TEAM}"`;

export interface ScreenControlBundleOptions {
  appBundlePath: string;
  projectRoot?: string;
  version: string;
  signingIdentity?: string;
  timestamp?: boolean;
}

/** Public packages must never inherit a private Screen push endpoint or unrelated service credentials. */
export function screenBundleBuildEnvironment(inherited: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['HOME', 'PATH', 'TMPDIR', 'DEVELOPER_DIR', 'SDKROOT']) if (inherited[key]) env[key] = inherited[key]!;
  return env;
}

export function assertScreenBundleEntitlements(xml: string): void {
  const plists = [...xml.matchAll(/<plist\b[^>]*>([\s\S]*?)<\/plist>/gu)];
  let body = plists.length === 1 ? plists[0]![1]!.trim() : '';
  if (!/^<dict>[\s\S]*<\/dict>$/u.test(body)) throw Error('Screen entitlements are unreadable');
  body = body.slice(6, -7);
  const application = `${SCREEN_HELPER_TEAM}.${SCREEN_HELPER_IDENTIFIER}`.replaceAll('.', '\\.');
  for (const pattern of [
    `<key>com\\.apple\\.application-identifier</key>\\s*<string>${application}</string>`,
    `<key>com\\.apple\\.developer\\.team-identifier</key>\\s*<string>${SCREEN_HELPER_TEAM}</string>`,
    `<key>keychain-access-groups</key>\\s*<array>\\s*<string>${application}</string>\\s*</array>`,
  ]) {
    const regex = new RegExp(pattern, 'gu');
    if ([...body.matchAll(regex)].length !== 1) throw Error('Screen keychain identity changed');
    body = body.replace(regex, '');
  }
  if (body.trim()) throw Error('Unexpected Screen entitlement');
}

/** Carries the independent, signed Screen app as an installation payload. Never launches it inside the GUI bundle. */
export async function stageScreenControlBundle(options: ScreenControlBundleOptions): Promise<{ helperAppPath: string }> {
  if (process.platform !== 'darwin') throw Error('Screen bundling requires macOS');
  if (!/^\d+\.\d+\.\d+$/.test(options.version)) throw Error('Invalid Screen release version');
  const root = resolve(options.projectRoot ?? import.meta.dir);
  const main = resolve(options.appBundlePath);
  if (!main.endsWith('.app') || !lstatSync(main).isDirectory() || lstatSync(main).isSymbolicLink()) throw Error('Screen destination must be a real app bundle');
  const scratch = mkdtempSync(join(tmpdir(), 'agentstoz-screen-payload-'));
  const built = join(scratch, 'AgentsToZ Screen.app');
  try {
    const args = [process.execPath, '--env-file=/dev/null', join(root, 'scripts/build-screen-app.ts'), '--bundle-version', options.version, '--output', built];
    if (options.timestamp !== false) args.push('--timestamp');
    const child = Bun.spawn(args, {
      cwd: scratch,
      env: { ...screenBundleBuildEnvironment(process.env), ...(options.signingIdentity ? { SCREEN_SIGN_IDENTITY: options.signingIdentity } : {}) },
      stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
    });
    if (await child.exited !== 0) throw Error('Signed Screen companion build failed; no incomplete main app can ship');
    const helperAppPath = join(main, SCREEN_HELPER_BUNDLE_PATH);
    const helpers = join(main, 'Contents/Helpers');
    if (existsSync(helpers) && (!lstatSync(helpers).isDirectory() || lstatSync(helpers).isSymbolicLink())) throw Error('Screen helper parent is not a real directory');
    mkdirSync(helpers, { recursive: true });
    if (existsSync(helperAppPath)) {
      if (lstatSync(helperAppPath).isSymbolicLink()) throw Error('Screen helper destination cannot be a symbolic link');
      rmSync(helperAppPath, { recursive: true });
    }
    cpSync(built, helperAppPath, { recursive: true, dereference: false });
    const verified = Bun.spawnSync(['codesign', '--verify', '--deep', '--strict', `-R=${SCREEN_HELPER_REQUIREMENT}`, helperAppPath], { stdout: 'pipe', stderr: 'pipe' });
    if (verified.exitCode !== 0) throw Error(`Bundled Screen signature rejected: ${verified.stderr.toString()}`);
    const version = Bun.spawnSync(['/usr/bin/plutil', '-extract', 'CFBundleVersion', 'raw', '-o', '-', join(helperAppPath, 'Contents/Info.plist')], { stdout: 'pipe', stderr: 'pipe' });
    if (version.exitCode !== 0 || version.stdout.toString().trim() !== options.version) throw Error('Bundled Screen version differs from main app');
    console.log(`[screen-bundle] signed Screen ${options.version} included for independent installation`);
    return { helperAppPath };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
