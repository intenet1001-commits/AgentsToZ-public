import {cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {screenBundleBuildEnvironment} from './stageScreenControlBundle';
import type {CommunityBuildConfig} from './scripts/communityBuildConfig';
import {assertSealedCommunityBuildConfig,writeCommunityBuildSnapshot} from './scripts/mainCommunityBuildConfig';

export const VIEWER_HELPER_BUNDLE_PATH = 'Contents/Helpers/AgentsToZ Viewer.app';
export const VIEWER_HELPER_IDENTIFIER = 'com.intenet.agentstozbycs.viewer';
export const VIEWER_HELPER_TEAM = 'DA8QKAQ2C9';
export const VIEWER_HELPER_REQUIREMENT = `identifier "${VIEWER_HELPER_IDENTIFIER}" and anchor apple generic`
  + ' and certificate 1[field.1.2.840.113635.100.6.2.6] exists'
  + ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
  + ` and certificate leaf[subject.OU] = "${VIEWER_HELPER_TEAM}"`;

export function viewerBundleEntitlements(): string {
  const application = `${VIEWER_HELPER_TEAM}.${VIEWER_HELPER_IDENTIFIER}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>com.apple.application-identifier</key><string>${application}</string>
<key>com.apple.developer.team-identifier</key><string>${VIEWER_HELPER_TEAM}</string>
<key>keychain-access-groups</key><array><string>${application}</string></array>
</dict></plist>`;
}

/** No capture, Accessibility, JIT or Screen keychain grants belong to the human Viewer. */
export function assertViewerBundleEntitlements(xml: string): void {
  const plists = [...xml.matchAll(/<plist\b[^>]*>([\s\S]*?)<\/plist>/gu)];
  let body = plists.length === 1 ? plists[0]![1]!.trim() : '';
  if (!/^<dict>[\s\S]*<\/dict>$/u.test(body)) throw Error('Viewer entitlements are unreadable');
  body = body.slice(6, -7);
  const application = `${VIEWER_HELPER_TEAM}.${VIEWER_HELPER_IDENTIFIER}`.replaceAll('.', '\\.');
  for (const pattern of [
    `<key>com\\.apple\\.application-identifier</key>\\s*<string>${application}</string>`,
    `<key>com\\.apple\\.developer\\.team-identifier</key>\\s*<string>${VIEWER_HELPER_TEAM}</string>`,
    `<key>keychain-access-groups</key>\\s*<array>\\s*<string>${application}</string>\\s*</array>`,
  ]) {
    const regex = new RegExp(pattern, 'gu');
    if ([...body.matchAll(regex)].length !== 1) throw Error('Viewer keychain identity changed');
    body = body.replace(regex, '');
  }
  if (body.trim()) throw Error('Unexpected Viewer entitlement');
}

/** Stages a signed payload only; never launches, installs or approves a Viewer session. */
export async function stageViewerControlBundle(options: {
  appBundlePath: string; projectRoot?: string; version: string; signingIdentity: string; communityConfig?:CommunityBuildConfig;
}): Promise<{helperAppPath: string}> {
  if (process.platform !== 'darwin') throw Error('Viewer bundling requires macOS');
  if (!/^\d+\.\d+\.\d+$/.test(options.version)) throw Error('Invalid Viewer release version');
  const root = resolve(options.projectRoot ?? import.meta.dir), main = resolve(options.appBundlePath);
  if (!main.endsWith('.app') || !lstatSync(main).isDirectory() || lstatSync(main).isSymbolicLink()) throw Error('Viewer destination must be a real app bundle');
  const scratch = mkdtempSync(join(tmpdir(), 'agentstoz-viewer-payload-'));
  try {
    const built = join(scratch, 'AgentsToZViewer.app');
    const args=[process.execPath, '--env-file=/dev/null', join(root, 'scripts/build-viewer-app.ts'),
      '--bundle-version', options.version, '--output', built, '--sign', options.signingIdentity];
    const communitySnapshot=writeCommunityBuildSnapshot(join(scratch,'community-public.json'),options.communityConfig);
    if(communitySnapshot)args.push('--community-config',communitySnapshot);
    const child = Bun.spawn(args,
      {cwd: scratch, env: screenBundleBuildEnvironment(process.env), stdin: 'ignore', stdout: 'inherit', stderr: 'inherit'});
    if (await child.exited !== 0) throw Error('Signed Viewer build failed; no incomplete Viewer payload can ship');
    const helpers = join(main, 'Contents/Helpers'), helperAppPath = join(main, VIEWER_HELPER_BUNDLE_PATH);
    if (existsSync(helpers) && (!lstatSync(helpers).isDirectory() || lstatSync(helpers).isSymbolicLink())) throw Error('Viewer helper parent must be a real directory');
    mkdirSync(helpers, {recursive: true});
    if (existsSync(helperAppPath)) throw Error('Viewer payload already exists; rebuild a fresh main app');
    cpSync(built, helperAppPath, {recursive: true, dereference: false});
    assertSealedCommunityBuildConfig(join(helperAppPath,'Contents/Info.plist'),options.communityConfig);
    return {helperAppPath};
  } finally { rmSync(scratch, {recursive: true, force: true}); }
}
