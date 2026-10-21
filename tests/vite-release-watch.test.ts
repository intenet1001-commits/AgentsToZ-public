import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import viteConfig from '../vite.config';

const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
async function eventually(probe: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (probe()) return;
    await delay(20);
  }
  throw new Error(description);
}
const inside = (path: string, root: string) => path === root || path.startsWith(`${root}${sep}`);
function watchedPaths(server: ViteDevServer): string[] {
  return Object.entries(server.watcher.getWatched()).flatMap(([directory, names]) =>
    [resolve(directory), ...names.map(name => resolve(directory, name))]);
}

test('the actual Vite watcher excludes existing/new release symlinks while source changes remain watched', async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'agentstoz-vite-release-watch-')));
  const root = join(scratch, 'project');
  const release = join(root, 'release');
  const apps = join(scratch, 'synthetic-apps');
  const appResources = join(apps, 'Synthetic.app', 'Contents', 'Resources');
  const shared = join(scratch, 'synthetic-source');
  const stage = join(release, 'v407', 'dmg-stage');
  const source = join(root, 'src', 'main.ts');
  const sharedSource = join(shared, 'shared.ts');
  const releaseNotes = join(root, 'release-notes', 'guide.md');
  let server: ViteDevServer | undefined;
  try {
    for (const directory of [stage, appResources, shared, join(root, 'src'), join(root, 'release-notes')]) mkdirSync(directory, { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
    writeFileSync(source, 'export const main = 1;\n');
    writeFileSync(sharedSource, 'export const shared = 1;\n');
    writeFileSync(releaseNotes, 'Source release notes.\n');
    writeFileSync(join(stage, 'manifest.txt'), 'Synthetic release metadata.\n');
    writeFileSync(join(appResources, 'index.html'), '<p>Synthetic application.</p>\n');
    symlinkSync(apps, join(stage, 'Applications'), process.platform === 'win32' ? 'junction' : 'dir');
    symlinkSync(shared, join(root, 'src', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');

    // Use the production configuration's exact watcher options and Vite's
    // actual bundled watcher. The root, cache and every symlink target are
    // disposable synthetic paths; no real Applications directory is visited.
    const production = await viteConfig({ command: 'serve', mode: 'test' });
    server = await createServer({
      configFile: false, root, envFile: false, publicDir: false,
      cacheDir: join(scratch, 'vite-cache'), logLevel: 'silent',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, ws: false, hmr: false, watch: production.server?.watch },
    });
    const currentServer = server;
    const observed: Array<{ event: string; path: string }> = [];
    const errors: unknown[] = [];
    server.watcher.on('all', (event, path) => observed.push({ event, path: resolve(path) }));
    server.watcher.on('error', error => errors.push(error));
    await eventually(() => {
      const paths = watchedPaths(currentServer);
      return paths.includes(source) && paths.includes(releaseNotes)
        && (paths.includes(sharedSource) || paths.includes(join(root, 'src', 'linked', 'shared.ts')));
    }, 'The real Vite watcher did not discover the synthetic source tree.');
    await delay(150);
    const excluded = () => watchedPaths(currentServer).filter(path => inside(path, release) || inside(path, apps));
    expect(excluded()).toEqual([]);
    expect(server.httpServer).toBeNull();
    expect(server.watcher.options.followSymlinks).not.toBe(false);

    writeFileSync(join(stage, 'manifest.txt'), 'Changed synthetic release metadata.\n');
    writeFileSync(join(appResources, 'index.html'), '<p>Changed synthetic application.</p>\n');
    const laterStage = join(release, 'v999', 'dmg-stage');
    mkdirSync(laterStage, { recursive: true });
    symlinkSync(apps, join(laterStage, 'Applications'), process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(join(laterStage, 'manifest.txt'), 'A release created after watcher startup.\n');
    writeFileSync(source, 'export const main = 2;\n');
    writeFileSync(sharedSource, 'export const shared = 2;\n');
    writeFileSync(releaseNotes, 'Changed source release notes.\n');
    await eventually(() => {
      const changed = observed.filter(item => item.event === 'change').map(item => item.path);
      return changed.includes(source) && changed.includes(releaseNotes)
        && (changed.includes(sharedSource) || changed.includes(join(root, 'src', 'linked', 'shared.ts')));
    }, 'Ordinary source files and source symlinks stopped producing change events.');
    // Include one normal watcher delivery window after positive source events.
    await delay(250);
    expect(excluded()).toEqual([]);
    expect(observed.filter(item => inside(item.path, release) || inside(item.path, apps))).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await server?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 15_000);
