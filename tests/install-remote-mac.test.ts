import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remoteInstallScript, remoteSessionProbeScript, validSshHost } from '../scripts/install-remote-mac';

// 3호 used to rebuild the same commit itself (~10 min, node missing over SSH, its own version number).
describe('installing this Mac’s build on another Mac', () => {
  test('only a plain ssh host name reaches the command line', () => {
    expect(validSshHost('jumpremote')).toBe('jumpremote');
    expect(validSshHost('cs-work@10.0.0.5')).toBe('cs-work@10.0.0.5');
    for (const bad of [undefined, '', '-oProxyCommand=x', 'host;rm -rf /', 'a b']) expect(() => validSshHost(bad)).toThrow();
  });

  test('the installed app is moved aside only after the new bundle unpacked and verified', () => {
    const script = remoteInstallScript('/tmp/agentstoz-install-627.0.0.zip');
    const verify = script.indexOf('codesign --verify');
    const bundleCheck = script.indexOf("grep -qx 'com.intenet.agentstozbycs'");
    const backup = script.indexOf('mv "$dest" "$backup"');
    expect(script.startsWith('set -eu')).toBe(true);
    expect(verify).toBeGreaterThan(-1);
    expect(bundleCheck).toBeGreaterThan(verify);
    expect(backup).toBeGreaterThan(bundleCheck);
    expect(script).not.toContain('rm -rf "$dest"');
    expect(script).toContain('kill -TERM');
    expect(() => remoteInstallScript('/tmp/x.zip; rm -rf ~')).toThrow();
    expect(() => remoteInstallScript('/tmp/agentstoz-install-1.zip', { applications: "/Applications'; rm -rf ~; '" })).toThrow();
    expect(() => remoteInstallScript('/tmp/agentstoz-install-1.zip', { healthUrl: 'http://evil.example/api/health' })).toThrow();
  });

  test('the relaunched app does not inherit this SSH session (Workroom agy lost its keychain login)', () => {
    const launch = remoteInstallScript('/tmp/agentstoz-install-627.0.0.zip').split('\n').find(line => line.includes('open -b'));
    expect(launch).toContain('env -u SSH_CLIENT -u SSH_CONNECTION -u SSH_TTY open -b');
  });

  test('both remote scripts are valid shell', () => {
    for (const script of [remoteSessionProbeScript(), remoteInstallScript('/tmp/agentstoz-install-627.0.0.zip')]) {
      expect(spawnSync('bash', ['-n'], { input: script }).status).toBe(0);
    }
  });

  test('the session probe counts Workroom processes under the sidecar so a live session is not killed', () => {
    const probe = remoteSessionProbeScript();
    expect(probe).toContain('pgrep -P "$sidecar"');
    expect(probe).toContain('"??") continue');
    expect(probe).toContain('echo "sessions=$n"');
  });

  // The script used to `rm -rf` the installed app before copying the new one: a failed copy or a new
  // app whose sidecar never answered left the other Mac without a working app and no way back.
  describe('running the install script against a scratch Applications folder', () => {
    const roots: string[] = [];
    afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

    function plist(version: string): string {
      return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.intenet.agentstozbycs</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>`;
    }

    function makeApp(parent: string, version: string) {
      const contents = join(parent, 'AgentsToZ_byCS.app', 'Contents');
      mkdirSync(join(contents, 'MacOS'), { recursive: true });
      writeFileSync(join(contents, 'Info.plist'), plist(version));
      writeFileSync(join(contents, 'MacOS', 'app'), version);
    }

    function stub(bin: string, name: string, body: string) {
      writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    }

    /** `healthyVersion` is the installed version whose sidecar answers; any other version stays down. */
    function setup(opts: { oldVersion?: string; healthyVersion: string; signatureOk?: boolean }) {
      const root = mkdtempSync(join(tmpdir(), 'agentstoz-remote-install-test-'));
      roots.push(root);
      const apps = join(root, 'Applications');
      const bin = join(root, 'bin');
      const source = join(root, 'source');
      mkdirSync(apps); mkdirSync(bin); mkdirSync(source);
      if (opts.oldVersion) makeApp(apps, opts.oldVersion);
      makeApp(source, '2.0.0');
      const zip = `/tmp/agentstoz-install-test-${randomUUID().slice(0, 8)}.zip`;
      roots.push(zip);
      expect(spawnSync('ditto', ['-c', '-k', '--keepParent', join(source, 'AgentsToZ_byCS.app'), zip]).status).toBe(0);
      const opens = join(root, 'opens.log');
      stub(bin, 'codesign', opts.signatureOk === false ? 'exit 1' : 'exit 0');
      stub(bin, 'pgrep', 'exit 1');
      stub(bin, 'open', `echo "open ssh=\${SSH_CONNECTION:-none} $*" >> '${opens}'`);
      stub(bin, 'curl', `[ "$(cat '${join(apps, 'AgentsToZ_byCS.app', 'Contents', 'MacOS', 'app')}' 2>/dev/null)" = '${opts.healthyVersion}' ]`);
      const run = () => spawnSync('bash', ['-s'], {
        input: remoteInstallScript(zip, { applications: apps, healthWaitSeconds: 1 }),
        encoding: 'utf8',
        env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin`, SSH_CONNECTION: '10.0.0.9 5 10.0.0.1 22', HOME: root },
      });
      const installed = () => readFileSync(join(apps, 'AgentsToZ_byCS.app', 'Contents', 'MacOS', 'app'), 'utf8');
      const leftovers = () => readdirSync(apps).filter(name => name.startsWith('.AgentsToZ_byCS-incoming'));
      const backups = () => existsSync(join(apps, '.AgentsToZ_byCS-backups')) ? readdirSync(join(apps, '.AgentsToZ_byCS-backups')) : [];
      return { run, installed, leftovers, backups, zip, opens: () => existsSync(opens) ? readFileSync(opens, 'utf8') : '' };
    }

    test('a healthy new app replaces the old one, which is kept as a backup', () => {
      const t = setup({ oldVersion: '1.0.0', healthyVersion: '2.0.0' });
      const result = t.run();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('installed=2.0.0');
      expect(result.stdout).toContain('sidecar=up');
      expect(t.installed()).toBe('2.0.0');
      expect(t.backups()).toHaveLength(1);
      expect(t.leftovers()).toEqual([]);
      expect(existsSync(t.zip)).toBe(false);
      expect(t.opens()).toBe('open ssh=none -b com.intenet.agentstozbycs\n');
    });

    test('a new app whose sidecar never answers is rolled back to the old one and relaunched', () => {
      const t = setup({ oldVersion: '1.0.0', healthyVersion: '1.0.0' });
      const result = t.run();
      expect(result.status).toBe(50);
      expect(result.stdout).toContain('sidecar=down');
      expect(result.stdout).toContain('rollback=restored');
      expect(result.stdout).toContain('previous=up');
      expect(result.stdout).not.toContain('installed=');
      expect(t.installed()).toBe('1.0.0');
      expect(t.backups()).toEqual([]);
      expect(t.leftovers()).toEqual([]);
      expect(t.opens().trim().split('\n')).toHaveLength(2);
    });

    test('a bundle that fails its signature check never touches the installed app', () => {
      const t = setup({ oldVersion: '1.0.0', healthyVersion: '2.0.0', signatureOk: false });
      const result = t.run();
      expect(result.status).not.toBe(0);
      expect(t.installed()).toBe('1.0.0');
      expect(t.backups()).toEqual([]);
      expect(t.leftovers()).toEqual([]);
      expect(t.opens()).toBe('');
    });

    test('a first install with nothing to roll back to still reports the failed health check', () => {
      const t = setup({ healthyVersion: 'none' });
      const result = t.run();
      expect(result.status).toBe(50);
      expect(result.stdout).toContain('sidecar=down');
      expect(result.stdout).not.toContain('rollback=');
      expect(t.installed()).toBe('2.0.0');
    });
  });
});
