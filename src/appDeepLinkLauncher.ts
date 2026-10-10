/** Open a desktop URL handler without blocking Bun's API event loop. */
export async function runAppDeepLinkCommand(
  command: string[],
  fallbackError: string,
  options: {
    timeoutMs?: number;
    spawn?: (command: string[]) => {exited: Promise<number>; stderr: ReadableStream<Uint8Array>; kill(signal: string): void};
  } = {},
): Promise<void> {
  const spawn = options.spawn ?? ((args: string[]) => Bun.spawn(args, {stdout: 'ignore', stderr: 'pipe'}));
  const child = spawn(command);
  const detail = new Response(child.stderr).text().catch(() => '');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), options.timeoutMs ?? 5_000);
  });
  let exitCode: number | null;
  try {
    exitCode = await Promise.race([child.exited, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (exitCode === null) {
    try { child.kill('SIGKILL'); } catch { /* The launcher may have exited at the deadline. */ }
    await child.exited.catch(() => null);
  }
  if (exitCode !== 0) throw new Error((await detail).trim() || fallbackError);
}
