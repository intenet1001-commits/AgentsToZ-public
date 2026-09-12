import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import viteConfig from '../vite.config';
import portalConfig from '../vite.portal.config';
import guideConfig from '../vite.guide.config';

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}${sep}`);

test('cold Vite discovery scans real page entries and excludes release symlinks independently of the watcher', async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'agentstoz-vite-dependency-scan-')));
  const root = join(scratch, 'project');
  const apps = join(scratch, 'synthetic-apps');
  const stage = join(root, 'release', 'v999', 'dmg-stage');
  const archivedHtml = join(root, 'docs', 'handoff', 'index.html');
  const appHtml = join(apps, 'Fixture.app', 'Contents', 'Resources', 'index.html');
  let server: ViteDevServer | undefined;
  try {
    const production = await viteConfig({ command: 'serve', mode: 'test' });
    const portal = await portalConfig({ command: 'serve', mode: 'test' });
    const guide = await guideConfig({ command: 'serve', mode: 'test' });
    const entryFiles = ['index.html', 'portal.html', 'setup.html', 'remote/index.html', 'guide.html'];
    // Cover the default desktop page and every explicit portal/guide entry.
    const explicitInputs = [portal, guide].flatMap(config => Object.values(config.build!.rollupOptions!.input!));
    expect(production.optimizeDeps?.entries).toEqual(entryFiles);
    expect(new Set(entryFiles)).toEqual(new Set(['index.html', ...explicitInputs]));

    for (const directory of [stage, dirname(appHtml), dirname(archivedHtml), join(root, 'src')]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
    const sourceFiles = entryFiles.map((_, index) => join(root, 'src', `entry-${index}.js`));
    for (const [index, entry] of entryFiles.entries()) {
      const html = join(root, entry);
      mkdirSync(dirname(html), { recursive: true });
      const script = relative(dirname(html), sourceFiles[index]!).split(sep).join('/');
      writeFileSync(html, `<script type="module" src="./${script}"></script>\n`);
      writeFileSync(sourceFiles[index]!, `export const page = ${index};\n`);
    }
    writeFileSync(appHtml, '<script type="module">export const installedApp = true;</script>\n');
    writeFileSync(archivedHtml, '<script type="module">export const archivedDocument = true;</script>\n');
    symlinkSync(apps, join(stage, 'Applications'), process.platform === 'win32' ? 'junction' : 'dir');

    async function scan(entries: NonNullable<typeof production.optimizeDeps>['entries'], cacheName: string) {
      const loaded = new Set<string>();
      server = await createServer({
        configFile: false, root, envFile: false, publicDir: false,
        cacheDir: join(scratch, cacheName), logLevel: 'silent',
        optimizeDeps: {
          entries,
          // The synthetic source has no third-party dependencies. Keep real
          // discovery enabled and observe its actual esbuild load attempts.
          include: [],
          esbuildOptions: { plugins: [{
            name: 'record-synthetic-discovery',
            setup(build) {
              build.onLoad({ filter: /\.(?:html|js)$/ }, args => {
                loaded.add(resolve(args.path));
                return undefined;
              });
            },
          }] },
        },
        server: { middlewareMode: true, ws: false, hmr: false, watch: production.server?.watch },
      });
      const optimizer = server.environments.client!.depsOptimizer!;
      await optimizer.init();
      await optimizer.scanProcessing;
      expect(server.httpServer).toBeNull();
      await server.close();
      server = undefined;
      return [...loaded];
    }

    const limited = await scan(production.optimizeDeps!.entries, 'configured-cold-cache');
    for (const entry of entryFiles) expect(limited).toContain(join(root, entry));
    for (const source of sourceFiles) expect(limited).toContain(source);
    expect(limited.filter(path => inside(path, apps) || inside(path, join(root, 'release')))).toEqual([]);
    expect(limited).not.toContain(archivedHtml);

    // Prove this fixture exercises the independent bug: watcher exclusions
    // alone still let default dependency discovery read the synthetic app.
    const unrestricted = await scan(undefined, 'default-cold-cache');
    expect(unrestricted.some(path => inside(path, apps) || inside(path, join(stage, 'Applications')))).toBe(true);
    expect(unrestricted).toContain(archivedHtml);
  } finally {
    await server?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 15_000);
