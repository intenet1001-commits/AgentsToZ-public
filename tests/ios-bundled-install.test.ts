import {expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

test('iOS packaging rejects an incomplete workspace before replacing the app resources', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentstoz-ios-bundle-'));
  try {
    const destination = join(root, 'out/App.app/web');
    mkdirSync(destination, {recursive: true});
    writeFileSync(join(destination, 'previous'), 'keep until inputs validate');
    const script = resolve(import.meta.dir, '../mobile/ios/scripts/copy-bundled-portal.sh');
    const env = {...process.env, SRCROOT: root, TARGET_BUILD_DIR: join(root, 'out'), UNLOCALIZED_RESOURCES_FOLDER_PATH: 'App.app'};
    const missing = Bun.spawnSync(['/bin/sh', script], {env, stdout: 'pipe', stderr: 'pipe'});
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stdout.toString()).toContain('error: bundled portal missing');
    expect(readFileSync(join(destination, 'previous'), 'utf8')).toBe('keep until inputs validate');
    mkdirSync(join(root, 'build/portal-web/remote'), {recursive: true});
    writeFileSync(join(root, 'build/portal-web/remote/index.html'), '<html>only one file</html>');
    const incomplete = Bun.spawnSync(['/bin/sh', script], {env, stdout: 'pipe', stderr: 'pipe'});
    expect(incomplete.exitCode).not.toBe(0);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
