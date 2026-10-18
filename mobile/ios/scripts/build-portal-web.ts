/** Build the portal that the iPhone app bundles (served at agentstoz-app://portal/).
 * No VITE_SUPABASE_* values: the app injects the QR's Supabase project at runtime. */
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dir, '../../..');
const out = resolve(root, 'mobile/ios/build/portal-web');
rmSync(out, { recursive: true, force: true });
const env = { ...process.env, VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' };
const child = Bun.spawnSync([resolve(root, 'node_modules/.bin/vite'), 'build', '--config', 'vite.portal.config.ts', '--outDir', out, '--emptyOutDir'], { cwd: root, env, stdout: 'inherit', stderr: 'inherit' });
if (child.exitCode !== 0) throw new Error(`portal build failed (exit ${child.exitCode})`);
if (!(await Bun.file(resolve(out, 'remote/index.html')).exists())) throw new Error('portal build has no remote/index.html');
console.log(`bundled portal ready: ${out}`);
