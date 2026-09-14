import {expect, test} from 'bun:test';
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('filtered Bun discovery stays inside tests and ignores release application links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentstoz-test-discovery-'));
  try {
    const tests = join(root, 'tests');
    const stage = join(root, 'release', 'dmg-stage');
    const applications = join(root, 'application-fixture');
    await Promise.all([mkdir(tests), mkdir(stage, {recursive: true}), mkdir(applications)]);
    await writeFile(join(root, 'bunfig.toml'), await readFile(new URL('../bunfig.toml', import.meta.url)));
    await writeFile(join(tests, 'discovery-sentinel.test.ts'),
      "import {test,expect} from 'bun:test';test('allowed sentinel',()=>expect(1).toBe(1));\n");
    await writeFile(join(applications, 'discovery-sentinel.test.ts'),
      "throw new Error('UNWANTED_APPLICATION_TRAVERSAL');\n");
    await symlink(applications, join(stage, 'Applications'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const args of [['test', 'discovery-sentinel'], ['test', '--cwd', 'tests', 'discovery-sentinel']]) {
      const child = Bun.spawn([process.execPath, ...args], {cwd: root, stdout: 'pipe', stderr: 'pipe'});
      const deadline = setTimeout(() => child.kill(), 5_000);
      try {
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect(exit).toBe(0);
        expect(stdout + stderr).toContain('1 pass');
        expect(stdout + stderr).not.toContain('UNWANTED_APPLICATION_TRAVERSAL');
      } finally { clearTimeout(deadline); }
    }
  } finally { await rm(root, {recursive: true, force: true}); }
}, 15_000);
