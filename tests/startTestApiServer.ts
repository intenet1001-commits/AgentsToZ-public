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
  entrypoint?: string;
}): Promise<{ baseUrl: string; child: Bun.Subprocess }> {
  const failures: string[] = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = nextCandidatePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const childEnv: Record<string, string | undefined> = {
      ...input.env,
      API_PORT: String(port),
    };
    // A test that replaces HOME owns a disposable profile. Codex Desktop can
    // itself be launched by the installed sidecar and therefore pass its real
    // APP_DATA_DIR to the test runner; inheriting that value would silently
    // make an otherwise isolated API child read and mutate production data.
    // Explicit fixture overrides remain intact because their value differs
    // from the parent process value.
    if (childEnv.HOME !== process.env.HOME) {
      const capabilityNames = [
        'PORTMGR_AGENT_RUNTIME_CAPABILITY',
        'PORTMGR_ONBOARDING_CAPABILITY',
        'PORTMGR_REMOTE_CONTROL_CAPABILITY',
        'PORTMGR_WHAT_I_SAID_CAPABILITY',
      ];
      const hasExplicitFixtureAuthority = capabilityNames.some(name =>
        childEnv[name] !== undefined && childEnv[name] !== process.env[name]
      );
      for (const name of [
        'APP_DATA_DIR',
        'PORTMGR_BUNDLED_SIDECAR',
        'PORTMGR_PARENT_PID',
        ...capabilityNames,
      ]) {
        if (childEnv[name] !== process.env[name]) continue;
        if (name === 'APP_DATA_DIR' || !hasExplicitFixtureAuthority) delete childEnv[name];
      }
    }
    const child = Bun.spawn([process.execPath, input.entrypoint ?? 'api-server.ts'], {
      cwd: input.cwd,
      env: childEnv,
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
