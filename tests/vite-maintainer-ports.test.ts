import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'vite';

test('screen fixtures coexist with an occupied port while ordinary development still refuses it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atz-vite-port-'));
  const owner = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => new Response('original owner')});
  const servers: Awaited<ReturnType<typeof createServer>>[] = [];
  try {
    const options = {configFile: join(import.meta.dir, '../vite.config.ts'), root, cacheDir: join(root, '.cache'),
      logLevel: 'silent' as const, optimizeDeps: {noDiscovery: true, include: [], entries: []},
      server: {host: '127.0.0.1', port: owner.port!}};
    const fixture = await createServer({...options, mode: 'maintainer-test'}); servers.push(fixture);
    await fixture.listen();
    const address = fixture.httpServer!.address();
    expect(typeof address).toBe('object');
    expect((address as {port: number}).port).not.toBe(owner.port);
    const development = await createServer({...options, mode: 'development'}); servers.push(development);
    await expect(development.listen()).rejects.toThrow('already in use');
    expect(await fetch(`http://127.0.0.1:${owner.port}/`).then(r => r.text())).toBe('original owner');
  } finally {
    for (const server of servers) await server.close();
    owner.stop(true); rmSync(root, {recursive: true, force: true});
  }
}, 15_000);
