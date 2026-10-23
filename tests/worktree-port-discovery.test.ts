import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorktreePortDiscovery, runWorktreeLsof, WORKTREE_LSOF_MAX_PIDS, WORKTREE_LSOF_MAX_PORTS, WORKTREE_LSOF_OUTPUT_BYTES,
} from '../src/worktreePortDiscovery';

const listen = (pid: string, ...ports: number[]) => `p${pid}\0\n${ports.map(port => `n*:${port}\0\n`).join('')}`;
const directory = (pid: string, cwd: string) => `p${pid}\0\nfcwd\0n${cwd}\0\n`;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('coalesces concurrent probes, keeps folder/slot filters independent, and releases completed snapshots', async () => {
  const entered = deferred(); const release = deferred(); let calls = 0;
  const scan = createWorktreePortDiscovery({ executable: 'fixture', run: async args => {
    calls++;
    if (args.includes('-iTCP:10001-59999')) {
      entered.resolve(); await release.promise;
      return listen('101', 24285, 19000, 18000) + listen('202', 19000, 10025);
    }
    expect(args).toContain('101,202');
    return directory('101', '/projects/one') + directory('202', '/projects/two/child');
  } });
  const pending = Promise.all([
    scan.findPort('/projects/one', 9000), scan.findPort('/projects/one', 8000),
    scan.findPort('/projects/two', null), scan.findPort('/projects/missing', 9000),
  ]);
  await entered.promise;
  expect(calls).toBe(1);
  release.resolve();
  expect(await pending).toEqual([19000, 18000, 10025, null]);
  expect(calls).toBe(2);
  await scan.findPort('/projects/one', 9000);
  expect(calls).toBe(4);
});

test('serves HTTP health while a shared port snapshot is waiting', async () => {
  const entered = deferred(); const release = deferred(); let calls = 0; let completed = 0;
  const scan = createWorktreePortDiscovery({ executable: 'fixture', run: async args => {
    calls++;
    if (args.includes('-iTCP:10001-59999')) { entered.resolve(); await release.promise; return listen('101', 19000); }
    return directory('101', '/worktree');
  } });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    if (new URL(request.url).pathname === '/health') return Response.json({ ok: true });
    const port = await scan.findPort('/worktree', 9000); completed++;
    return Response.json({ port });
  } });
  const pending = Promise.all(Array.from({ length: 8 }, () => fetch(`http://127.0.0.1:${server.port}/probe`).then(r => r.json())));
  try {
    await entered.promise;
    const response = await fetch(`http://127.0.0.1:${server.port}/health`, { signal: AbortSignal.timeout(1000) });
    expect(response.status).toBe(200); expect(completed).toBe(0); expect(calls).toBe(1);
    release.resolve();
    expect(await pending).toEqual(Array(8).fill({ port: 19000 }));
    expect(calls).toBe(2);
  } finally { release.resolve(); await pending; await server.stop(true); }
});

test('requires the exact cwd or its child and does not trim NUL-delimited directory names', async () => {
  for (const [cwd, folder, expected] of [
    ['/a/wt', '/a/wt', 19000], ['/a/wt/child', '/a/wt', 19000],
    ['/a', '/a/wt', null], ['/a/wt-evil', '/a/wt', null],
    ['/a/한글 공백\n끝 ', '/a/한글 공백\n끝 ', 19000],
    ['/a/한글 공백\n끝 ', '/a/한글 공백\n끝', null],
  ] as const) {
    const scan = createWorktreePortDiscovery({ executable: 'fixture', run: async args => args.includes('-d')
      ? directory('101', cwd) : listen('101', 19000) });
    expect(await scan.findPort(folder, 9000)).toBe(expected);
  }
});

test('rejects invalid PID attribution, missing cwd descriptors, deleted cwd, and non-candidate ports', async () => {
  const scan = createWorktreePortDiscovery({ executable: 'fixture', run: async args => args.includes('-d')
    ? directory('101', '/worktree') + `p202\0\nf1\0n/worktree\0\n` + directory('303', '/worktree (deleted)')
    : listen('101', 24285) + listen('-1', 19000) + listen('12x', 19000) + listen('2147483648', 19000)
      + listen('202', 19000) + listen('303', 19000) });
  expect(await scan.findPort('/worktree', 9000)).toBeNull();
  expect(await scan.findPort('/worktree', null)).toBeNull();
});

test('bounds PID/output budgets and never uses partial failed scans or retains rejected snapshots', async () => {
  let mode: 'pids' | 'ports' | 'bytes' | 'failed' | 'ok' = 'pids'; let calls = 0;
  const scan = createWorktreePortDiscovery({ executable: 'fixture', run: async args => {
    calls++;
    if (args.includes('-d')) return directory('101', '/worktree');
    if (mode === 'pids') return Array.from({ length: WORKTREE_LSOF_MAX_PIDS + 1 }, (_, index) => listen(String(index + 1), 19000)).join('');
    if (mode === 'ports') return listen('101', ...Array.from({ length: WORKTREE_LSOF_MAX_PORTS + 1 }, (_, index) => 10001 + index));
    if (mode === 'bytes') return 'x'.repeat(WORKTREE_LSOF_OUTPUT_BYTES + 1);
    if (mode === 'failed') throw new Error('probe failed after partial output');
    return listen('101', 19000);
  } });
  await expect(scan.findPort('/worktree', 9000)).rejects.toThrow('OUTPUT_LIMIT');
  mode = 'ports'; await expect(scan.findPort('/worktree', 9000)).rejects.toThrow('OUTPUT_LIMIT');
  mode = 'bytes'; await expect(scan.findPort('/worktree', 9000)).rejects.toThrow('OUTPUT_LIMIT');
  mode = 'failed'; await expect(scan.findPort('/worktree', 9000)).rejects.toThrow('probe failed');
  mode = 'ok'; expect(await scan.findPort('/worktree', 9000)).toBe(19000);
  expect(calls).toBe(6);
});

test('rejects a truncated NUL field instead of returning a partial match', async () => {
  const scan = createWorktreePortDiscovery({ executable: 'fixture', run: async () => 'p101\0n*:19000' });
  await expect(scan.findPort('/worktree', 9000)).rejects.toThrow('INVALID_OUTPUT');
});

test('real asynchronous probe kills timeout/oversize children and does not return their partial output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'worktree-probe-cleanup-'));
  const assertExited = (pidFile: string) => {
    const childPid = Number(readFileSync(pidFile, 'utf8'));
    expect(Number.isInteger(childPid) && childPid > 1 && childPid !== process.pid).toBe(true);
    expect(() => process.kill(childPid, 0)).toThrow();
  };
  const recordPid = (file: string) => `require('node:fs').writeFileSync(${JSON.stringify(file)}, String(process.pid));`;
  const started = performance.now();
  let ticks = 0; const timer = setInterval(() => ticks++, 5);
  try {
    const pidFile = join(root, 'timeout.pid');
    await expect(runWorktreeLsof(process.execPath, ['-e', recordPid(pidFile) + 'process.stdout.write("p101\\0n*:19000\\0"); setInterval(() => {}, 1000);'], { timeoutMs: 500 }))
      .rejects.toThrow('TIMEOUT');
    assertExited(pidFile);
    expect(ticks).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(2000);
    for (const stream of ['stdout', 'stderr']) {
      const overflowPid = join(root, `${stream}.pid`);
      await expect(runWorktreeLsof(process.execPath, ['-e', recordPid(overflowPid) + `process.${stream}.write("x".repeat(65536)); setInterval(() => {}, 1000);`], { maxBufferBytes: 1024 }))
        .rejects.toThrow('OUTPUT_LIMIT');
      assertExited(overflowPid);
    }
    expect(await runWorktreeLsof(process.execPath, ['-e', 'process.exit(1)'])).toBe('');
  } finally { clearInterval(timer); rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === 'win32')('actual lsof finds a fixture listener in a Korean directory with spaces using two probes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'worktree-port-discovery-'));
  const cwd = join(root, '한글 작업 폴더'); mkdirSync(cwd);
  const child = Bun.spawn([process.execPath, '-e', `
    let server;
    for (let attempt = 0; attempt < 100 && !server; attempt++) {
      try { server = Bun.serve({ hostname: '127.0.0.1', port: 19000 + Math.floor(Math.random() * 1000), fetch: () => new Response('fixture') }); }
      catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
    }
    if (!server) throw new Error('No available fixture port');
    console.log(server.port);
  `], { cwd, stdout: 'pipe', stderr: 'pipe' });
  try {
    const reader = child.stdout.getReader();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const first = await Promise.race([
      reader.read(), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Fixture startup timed out')), 3000); }),
    ]).finally(() => { clearTimeout(timeout); reader.releaseLock(); });
    const port = Number(new TextDecoder().decode(first.value).trim());
    expect(port).toBeGreaterThanOrEqual(19000); expect(port).toBeLessThan(20000);
    const executable = ['/usr/sbin/lsof', '/usr/bin/lsof'].find(path => existsSync(path)) ?? 'lsof';
    let calls = 0;
    const scan = createWorktreePortDiscovery({ executable, run: args => { calls++; return runWorktreeLsof(executable, args); } });
    expect(await scan.findPort(realpathSync(cwd), port % 10000)).toBe(port);
    expect(calls).toBe(2);
  } finally {
    child.kill('SIGKILL'); await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test('the API route delegates to asynchronous discovery without synchronous lsof', () => {
  const api = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
  const route = api.slice(api.indexOf('if (url.pathname === "/api/find-worktree-port"'), api.indexOf('if (url.pathname === "/api/open-add-command"'));
  expect(route).toContain('await worktreePortDiscovery.findPort(folderPath, mainPort)');
  expect(route).not.toContain('spawnSync');
});
