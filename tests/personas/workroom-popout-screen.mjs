/** Run the real Workroom pop-out screen checks against an owned, synthetic Vite host. */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';

const root = resolve(import.meta.dirname, '../..');
const scratch = mkdtempSync(join(tmpdir(), 'agentstoz-persona-popout-'));
const emptyEnv = join(scratch, 'empty-env');
mkdirSync(emptyEnv);

// Bun loads .env by default. Keep credentials and personal origins out of the fixture.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('VITE_')) delete process.env[key];
}
process.env.VITE_SUPABASE_URL = 'https://workspace-fixture.supabase.co';
process.env.VITE_SUPABASE_ANON_KEY = 'fixture-anon-key';

let vite;
let child;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  child?.kill('SIGTERM');
  await vite?.close();
  rmSync(scratch, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void close().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143)); });
}

try {
  vite = await createServer({
    configFile: join(root, 'vite.config.ts'),
    root,
    envDir: emptyEnv,
    mode: 'maintainer-test',
    cacheDir: join(scratch, 'node_modules/.vite'),
    logLevel: 'warn',
    plugins: [{
      name: 'persona-deny-live-api',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (!request.url?.startsWith('/api/')) return next();
          response.statusCode = 503;
          response.end('Unmocked fixture API rejected');
        });
      },
    }],
    server: { host: '127.0.0.1', port: 0, strictPort: false, watch: { ignored: ['**/.agentstoz/**'] } },
  });
  await vite.listen();
  const address = vite.httpServer?.address();
  if (!address || typeof address === 'string' || address.port === 3001) throw Error('Invalid owned fixture address');
  const origin = `http://127.0.0.1:${address.port}`;

  child = spawn('node', ['tests/workroom-popout.e2e.mjs'], {
    cwd: root,
    env: { ...process.env, WORKROOM_TEST_ORIGIN: origin },
    stdio: 'inherit',
  });
  const exitCode = await new Promise(resolve => {
    child.once('error', () => resolve(127));
    child.once('exit', code => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
} finally {
  await close();
}
