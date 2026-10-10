#!/usr/bin/env bun
/**
 * Install the app this Mac just built onto another Mac over SSH — the same bundle, not a rebuild.
 *
 *   bun scripts/install-remote-mac.ts <ssh-host> [--force]
 *
 * Rebuilding on the other Mac took ~10 minutes, needed its own PATH fixes (node missing over SSH)
 * and produced a different number for the same source. Copying the signed bundle is faster and is
 * byte-for-byte what this Mac runs.
 *
 * Safety: quitting the app ends any Workroom CLI it runs, so the install refuses while the remote
 * sidecar has Workroom children unless --force. The new bundle is unpacked and its signature
 * verified in a staging folder before the installed app is touched.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const APP_NAME = 'AgentsToZ_byCS.app';
export const BUNDLE_ID = 'com.intenet.agentstozbycs';
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,120}$/;
const ZIP_RE = /^\/tmp\/agentstoz-install-[0-9a-z.-]{1,80}\.zip$/;

export function validSshHost(value: string | undefined): string {
  if (!value || !HOST_RE.test(value)) throw new Error('usage: bun scripts/install-remote-mac.ts <ssh-host> [--force]');
  return value;
}

/**
 * Counts Workroom CLIs under the remote sidecar. A Workroom runs on a PTY; the sidecar's short-lived
 * helpers (git, lsof) have no terminal, so only children with a TTY count — the first probe of 3호
 * reported one session that was a git call already gone when looked at.
 */
export function remoteSessionProbeScript(): string {
  return [
    'set -u',
    `app=$(pgrep -f "${APP_NAME}/Contents/MacOS/app" | head -1)`,
    'echo "arch=$(uname -m)"',
    'if [ -z "$app" ]; then echo "app=none"; echo "sessions=0"; exit 0; fi',
    'echo "app=$app"',
    'n=0; for sidecar in $(pgrep -P "$app"); do for child in $(pgrep -P "$sidecar"); do',
    '  tty=$(ps -o tty= -p "$child" 2>/dev/null | tr -d " "); case "$tty" in ""|"??") continue;; esac',
    '  n=$((n+1)); ps -o pid=,etime=,command= -p "$child" | cut -c1-140 | sed "s/^/session: /"',
    'done; done',
    'echo "sessions=$n"',
  ].join('\n');
}

export interface RemoteInstallLayout {
  /** Where the app lives. Only tests point this anywhere but /Applications. */
  applications: string;
  healthUrl: string;
  /** Seconds to wait for the relaunched sidecar before rolling back. */
  healthWaitSeconds: number;
}

const DEFAULT_LAYOUT: RemoteInstallLayout = {
  applications: '/Applications',
  healthUrl: 'http://127.0.0.1:3001/api/health',
  healthWaitSeconds: 40,
};

const SAFE_PATH_RE = /^\/[A-Za-z0-9._\/-]{1,300}$/;
const HEALTH_URL_RE = /^http:\/\/127\.0\.0\.1:\d{2,5}\/api\/health$/;

/**
 * Swap the installed app for the uploaded bundle without ever leaving the Mac app-less.
 *
 * It used to `rm -rf` the installed app and then copy the new one in: a failed copy (full disk) left
 * no app at all, and a new app whose sidecar never came up was still reported as installed. Now the
 * new bundle is copied to a hidden name on the same volume first, the old app is moved (not deleted)
 * to a backup, and the swap is two renames. If the swap fails or the relaunched app does not answer
 * its health check, the old app is put back and relaunched and the script exits non-zero.
 * The backup is kept on success, next to the in-app installer's (`.AgentsToZ_byCS-backups`).
 */
export function remoteInstallScript(zipPath: string, layout: Partial<RemoteInstallLayout> = {}): string {
  if (!ZIP_RE.test(zipPath)) throw new Error('unexpected remote archive path');
  const { applications, healthUrl, healthWaitSeconds } = { ...DEFAULT_LAYOUT, ...layout };
  if (!SAFE_PATH_RE.test(applications) || applications.includes('..')) throw new Error('unexpected applications folder');
  if (!HEALTH_URL_RE.test(healthUrl)) throw new Error('unexpected health URL');
  if (!Number.isInteger(healthWaitSeconds) || healthWaitSeconds < 1 || healthWaitSeconds > 300) throw new Error('unexpected health wait');
  const relaunch = `env -u SSH_CLIENT -u SSH_CONNECTION -u SSH_TTY open -b ${BUNDLE_ID}`;
  return [
    'set -eu',
    `zip='${zipPath}'`,
    `apps='${applications}'`,
    `dest="$apps/${APP_NAME}"`,
    'token="$(date +%Y%m%d%H%M%S)-$$"',
    'incoming="$apps/.AgentsToZ_byCS-incoming-$token.app"',
    'backups="$apps/.AgentsToZ_byCS-backups"',
    'backup="$backups/AgentsToZ_byCS-remote-$token.app"',
    'stage=$(mktemp -d /tmp/agentstoz-install.XXXXXX)',
    'trap \'rm -rf "$stage" "$zip" "$incoming"\' EXIT',
    'ditto -x -k "$zip" "$stage"',
    `codesign --verify --deep --strict "$stage/${APP_NAME}"`,
    `/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "$stage/${APP_NAME}/Contents/Info.plist" | grep -qx '${BUNDLE_ID}'`,
    // Copy onto the destination volume while the old app still runs, so the swap below is two renames.
    `ditto "$stage/${APP_NAME}" "$incoming"`,
    'quit_app() {',
    `  app=$(pgrep -f "${APP_NAME}/Contents/MacOS/app" | head -1 || true)`,
    '  if [ -n "$app" ]; then kill -TERM "$app" 2>/dev/null || true; for i in $(seq 1 30); do kill -0 "$app" 2>/dev/null || break; sleep 1; done; fi',
    '}',
    'healthy() {',
    `  for i in $(seq 1 ${healthWaitSeconds}); do curl -fs -m 2 '${healthUrl}' >/dev/null 2>&1 && return 0; sleep 1; done`,
    '  return 1',
    '}',
    'restore() {',
    '  [ "$had_app" -eq 1 ] || return 0',
    '  [ -e "$backup" ] || { echo "rollback=failed backup-missing"; return 1; }',
    '  [ ! -e "$dest" ] || mv "$dest" "$incoming"',
    '  if mv "$backup" "$dest"; then echo "rollback=restored"; else echo "rollback=failed backup=$backup"; return 1; fi',
    '}',
    'quit_app',
    'had_app=0',
    'if [ -e "$dest" ]; then mkdir -p "$backups"; mv "$dest" "$backup"; had_app=1; fi',
    'if ! mv "$incoming" "$dest"; then',
    '  echo "install=failed activate"',
    `  restore && ${relaunch} || true`,
    '  exit 40',
    'fi',
    // `open` hands the app this SSH shell's environment; without SSH_* the app (and its Workroom CLIs) is local.
    `${relaunch} || true`,
    'if ! healthy; then',
    '  echo "sidecar=down"',
    '  quit_app',
    '  if [ "$had_app" -eq 1 ]; then',
    `    restore && ${relaunch} || true`,
    '    healthy && echo "previous=up" || echo "previous=down"',
    '  fi',
    '  exit 50',
    'fi',
    `echo "installed=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$dest/Contents/Info.plist")"`,
    'echo "sidecar=up"',
    'if [ "$had_app" -eq 1 ]; then echo "backup=$backup"; fi',
  ].join('\n');
}

function run(command: string, args: string[], input?: string) {
  const result = spawnSync(command, args, { input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { code: result.status ?? 1, out: result.stdout ?? '', err: result.stderr ?? '' };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const host = validSshHost(args.find(arg => !arg.startsWith('--')));
  const app = join(homedir(), 'cargo-targets', 'portmanager', 'release', 'bundle', 'macos', APP_NAME);
  if (!existsSync(app)) throw new Error(`No built app at ${app} — run bun run tauri:build first.`);
  const version = run('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleShortVersionString', join(app, 'Contents', 'Info.plist')]).out.trim();
  const localArch = run('uname', ['-m']).out.trim();
  console.log(`[install-remote-mac] ${APP_NAME} v${version} (${localArch}) → ${host}`);

  const probe = run('ssh', ['-o', 'ConnectTimeout=10', host, 'bash', '-s'], remoteSessionProbeScript());
  if (probe.code !== 0) throw new Error(`Could not reach ${host}: ${probe.err.trim()}`);
  const field = (name: string) => probe.out.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1] ?? '';
  if (field('arch') !== localArch) throw new Error(`${host} is ${field('arch') || 'unknown'}, this build is ${localArch}.`);
  const sessions = Number(field('sessions') || 0);
  if (sessions > 0 && !force) {
    console.error(probe.out.split('\n').filter(line => line.startsWith('session: ')).join('\n'));
    throw new Error(`${host} has ${sessions} running Workroom process(es); quitting the app would end them. Re-run with --force to install anyway.`);
  }

  const work = mkdtempSync(join(tmpdir(), 'agentstoz-remote-install-'));
  try {
    const zip = join(work, 'app.zip');
    const pack = run('ditto', ['-c', '-k', '--keepParent', app, zip]);
    if (pack.code !== 0) throw new Error(`ditto failed: ${pack.err.trim()}`);
    const remoteZip = `/tmp/agentstoz-install-${version.toLowerCase()}.zip`;
    const copy = run('scp', ['-q', zip, `${host}:${remoteZip}`]);
    if (copy.code !== 0) throw new Error(`scp failed: ${copy.err.trim()}`);
    const install = run('ssh', [host, 'bash', '-s'], remoteInstallScript(remoteZip));
    process.stdout.write(install.out);
    if (install.code !== 0) throw new Error(`install failed on ${host}: ${install.err.trim()}`);
    if (!install.out.includes(`installed=${version}`)) throw new Error(`${host} reports a different installed version.`);
    console.log(`[install-remote-mac] ✅ ${host} now runs v${version}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
