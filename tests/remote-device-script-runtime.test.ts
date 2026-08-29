import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('force rotation survives a project-config disk phase failure and resumes before revocation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentstoz-rotation-'));
  roots.push(root);
  const configDir = join(root, '.config', 'agentstoz');
  const projectsDir = join(configDir, 'projects');
  const binDir = join(root, 'bin');
  const curlLog = join(root, 'curl.log');
  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const oldId = '00000000-0000-4000-8000-000000000001';
  const newId = '00000000-0000-4000-8000-000000000002';
  const baseConfig = {
    schema_version: 2,
    supabase_url: 'https://project.supabase.co',
    anon_key: 'public-anon',
    device_id: oldId,
    credential: 'old-credential',
    memory_id: '',
    device_name: 'Hermes AWS',
    environment_kind: 'aws',
    project_path: '',
    workspace_root: join(root, 'projects'),
    rotation_from_device_id: '',
  };
  writeFileSync(join(configDir, 'remote-device.json'), `${JSON.stringify(baseConfig)}\n`);
  writeFileSync(join(projectsDir, 'legacy.json'), '{not-json');

  const fakeCurl = join(binDir, 'curl');
  writeFileSync(fakeCurl, `#!/usr/bin/env bash
set -euo pipefail
url="\${!#}"
case "$url" in
  *127.0.0.1:3001/api/health)
    exit 22
    ;;
  *portmgr_claim_remote_host_enrollment)
    printf '%s' '[{"device_id":"${newId}","device_credential":"new-credential","device_name":"Hermes AWS","previous_device_id":"${oldId}"}]'
    ;;
  *portmgr_finalize_remote_device_rotation)
    printf '%s\n' finalize >> "$CURL_LOG"
    printf '%s' '[]'
    ;;
  *portmgr_report_remote_device_inventory)
    printf '%s' '[{"project_count":0}]'
    ;;
  *) printf '%s' '{}' ;;
esac
`);
  chmodSync(fakeCurl, 0o700);
  const fakeSystemctl = join(binDir, 'systemctl');
  writeFileSync(fakeSystemctl, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(fakeSystemctl, 0o700);
  const script = join(import.meta.dir, '..', 'public', 'agentstoz-remote-device.sh');
  const env = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: join(root, '.config'),
    PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    CURL_LOG: curlLog,
  };
  const first = Bun.spawnSync([
    'bash', script,
    '--token', 'ab'.repeat(32),
    '--supabase-url', 'https://project.supabase.co',
    '--anon-key', 'public-anon',
    '--name', 'Hermes AWS',
    '--environment', 'aws',
    '--workspace-root', join(root, 'projects'),
    '--force-new-device',
  ], { env, stdout: 'pipe', stderr: 'pipe' });
  expect(first.exitCode).not.toBe(0);
  const persisted = JSON.parse(readFileSync(join(configDir, 'remote-device.json'), 'utf8'));
  expect(persisted).toMatchObject({
    device_id: newId,
    credential: 'new-credential',
    rotation_from_device_id: oldId,
  });
  expect(Bun.file(curlLog).size).toBe(0);
  const installedScript = join(configDir, 'agentstoz-remote-device.sh');
  expect(readFileSync(installedScript, 'utf8')).toContain('AGENT_VERSION="4"');

  writeFileSync(join(projectsDir, 'legacy.json'), `${JSON.stringify(baseConfig)}\n`);
  const resumed = Bun.spawnSync(['bash', installedScript, '--sync'], {
    env, stdout: 'pipe', stderr: 'pipe',
  });
  expect(resumed.exitCode).toBe(0);
  expect(readFileSync(curlLog, 'utf8').trim()).toBe('finalize');
  expect(JSON.parse(readFileSync(join(configDir, 'remote-device.json'), 'utf8')).rotation_from_device_id).toBe('');
  expect(JSON.parse(readFileSync(join(projectsDir, 'legacy.json'), 'utf8')).device_id).toBe(newId);
}, 15_000);

test('successful host registration installs a syntactically valid, non-overlapping status runner', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentstoz-status-runner-'));
  roots.push(root);
  const binDir = join(root, 'fake-bin');
  const localBinDir = join(root, 'local-bin');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(localBinDir, { recursive: true });
  const deviceId = '00000000-0000-4000-8000-000000000010';
  const fakeCurl = join(binDir, 'curl');
  writeFileSync(fakeCurl, `#!/usr/bin/env bash
set -euo pipefail
url="\${!#}"
case "$url" in
  *127.0.0.1:3001/api/health)
    exit 22
    ;;
  *portmgr_claim_remote_host_enrollment)
    printf '%s' '[{"device_id":"${deviceId}","device_credential":"credential","device_name":"AWS"}]'
    ;;
  *portmgr_report_remote_device_inventory)
    printf '%s' '[{"project_count":0}]'
    ;;
  *) printf '%s' '[]' ;;
esac
`);
  chmodSync(fakeCurl, 0o700);
  const fakeSystemctl = join(binDir, 'systemctl');
  writeFileSync(fakeSystemctl, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(fakeSystemctl, 0o700);
  const script = join(import.meta.dir, '..', 'public', 'agentstoz-remote-device.sh');
  const env = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: join(root, '.config'),
    AGENTSTOZ_BIN_DIR: localBinDir,
    PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
  };
  const registered = Bun.spawnSync([
    'bash', script,
    '--token', 'cd'.repeat(32),
    '--supabase-url', 'https://project.supabase.co',
    '--anon-key', 'public-anon',
    '--name', 'AWS',
    '--environment', 'aws',
    '--workspace-root', join(root, 'projects'),
  ], { env, stdout: 'pipe', stderr: 'pipe' });
  expect(registered.exitCode).toBe(0);
  const statusCommand = join(localBinDir, 'agentstoz-status');
  const statusSource = readFileSync(statusCommand, 'utf8');
  expect(statusSource).toContain('flock -n 9');
  expect(statusSource).toContain('mkdir "$lock_dir"');
  expect(Bun.spawnSync(['bash', '-n', statusCommand]).exitCode).toBe(0);
});

test('minimal Ubuntu host can register and report Bun readiness before Git is installed', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentstoz-minimal-host-'));
  roots.push(root);
  const binDir = join(root, 'minimal-bin');
  const bunDir = join(root, '.bun', 'bin');
  const reportLog = join(root, 'curl-arguments.log');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(bunDir, { recursive: true });

  // Give the script only its host-registration dependencies. In particular,
  // there is intentionally no Git binary anywhere on PATH.
  for (const [name, source] of [
    ['python3', '/usr/bin/python3'],
    ['mkdir', '/bin/mkdir'],
    ['chmod', '/bin/chmod'],
    ['hostname', '/bin/hostname'],
    ['uname', '/usr/bin/uname'],
    ['install', '/usr/bin/install'],
    ['mktemp', '/usr/bin/mktemp'],
    ['mv', '/bin/mv'],
  ] as const) symlinkSync(source, join(binDir, name));
  writeFileSync(join(bunDir, 'bun'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bunDir, 'bun'), 0o700);

  const deviceId = '00000000-0000-4000-8000-000000000020';
  const fakeCurl = join(binDir, 'curl');
  writeFileSync(fakeCurl, `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$@" >> "$REPORT_LOG"
url="\${!#}"
case "$url" in
  *127.0.0.1:3001/api/health)
    printf '%s' '{"ok":true,"service":"agentstoz-api","schemaVersion":10}'
    ;;
  *portmgr_claim_remote_host_enrollment)
    printf '%s' '[{"device_id":"${deviceId}","device_credential":"credential","device_name":"AWS"}]'
    ;;
  *portmgr_report_remote_device_inventory)
    printf '%s' '[{"project_count":0}]'
    ;;
  *) printf '%s' '[]' ;;
esac
`);
  chmodSync(fakeCurl, 0o700);

  const script = join(import.meta.dir, '..', 'public', 'agentstoz-remote-device.sh');
  const registered = Bun.spawnSync([
    '/bin/bash', script,
    '--token', 'ef'.repeat(32),
    '--supabase-url', 'https://project.supabase.co',
    '--anon-key', 'public-anon',
    '--name', 'AWS',
    '--environment', 'aws',
    '--workspace-root', join(root, 'projects'),
  ], {
    env: {
      HOME: root,
      XDG_CONFIG_HOME: join(root, '.config'),
      AGENTSTOZ_BIN_DIR: join(root, 'local-bin'),
      PATH: binDir,
      REPORT_LOG: reportLog,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect(registered.exitCode).toBe(0);
  expect(registered.stdout.toString()).toContain('Bun 준비 · AgentsToZ API 실행 중');
  expect(readFileSync(reportLog, 'utf8')).toContain('4|b1a1h0');
  expect(Bun.which('git', { PATH: binDir })).toBeNull();
});
