const usedPorts = new Set<number>();

function nextCandidatePort(): number {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const port = 20_000 + Math.floor(Math.random() * 40_000);
    if (!usedPorts.has(port)) {
      usedPorts.add(port);
      return port;
    }
  }
  throw new Error('테스트용 API 포트 후보를 만들지 못했습니다.');
}
async function pipeText(pipe: Bun.Subprocess['stderr']): Promise<string> {
  if (!pipe || typeof pipe === 'number') return '';
  return new Response(pipe as ReadableStream).text().catch(() => '');
}

/**
 * Start the real API on a bounded random loopback port. Fixed test ranges can
 * remain in TIME_WAIT after interrupted suites, so EADDRINUSE is retried with
 * a new candidate instead of turning into a ten-second false failure.
 */
export async function startTestApiServer(input: {
  cwd: string;
  env: Record<string, string | undefined>;
}): Promise<{ baseUrl: string; child: Bun.Subprocess }> {
  const failures: string[] = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = nextCandidatePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = Bun.spawn([process.execPath, 'api-server.ts'], {
      cwd: input.cwd,
      env: { ...input.env, API_PORT: String(port) },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let exitCode: number | null = null;
    void child.exited.then(code => { exitCode = code; });

    for (let healthAttempt = 0; healthAttempt < 200; healthAttempt += 1) {
      if (exitCode !== null) break;
      try {
        if ((await fetch(`${baseUrl}/api/health`)).ok) return { baseUrl, child };
      } catch { /* keep waiting for the child or its exit code */ }
      await Bun.sleep(50);
    }

    if (exitCode === null) {
      try { child.kill(); } catch {}
      exitCode = await child.exited.catch(() => null);
    }
    const stderr = await pipeText(child.stderr);
    if (/EADDRINUSE|port .* in use/i.test(stderr)) {
      failures.push(`${port}: in use`);
      continue;
    }
    throw new Error(`isolated API server did not become ready (exit=${exitCode}): ${stderr.slice(-2_000)}`);
  }
  throw new Error(`isolated API server could not reserve a loopback port (${failures.join(', ')})`);
}
