import type { ChannelProbeResult } from './channelHealth';

/**
 * Runs the registered agentstoz_use MCP executable once, the way an AI would,
 * and calls only the read-only `agentstoz_use_list_projects` tool. The child is
 * this probe's own process and is always ended afterwards; MCP processes that
 * AIs started are never touched.
 */
export const CHANNEL_PROBE_TOOL = 'agentstoz_use_list_projects';

export async function probeAgentsToZUseMcp(options: {
  command: string[];
  env: Record<string, string>;
  cwd: string;
  timeoutMs?: number;
  now?: () => Date;
}): Promise<ChannelProbeResult> {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 10_000;
  const failure = (error: string, serverVersion: string | null = null): ChannelProbeResult =>
    ({ ok: false, checkedAt: now().toISOString(), serverVersion, projectCount: null, error });

  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(options.command, {
      cwd: options.cwd,
      env: options.env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
    });
  } catch {
    return failure('제어 도구를 실행하지 못했습니다.');
  }
  const stdin = child.stdin as import('bun').FileSink;
  const send = (message: unknown) => { stdin.write(`${JSON.stringify(message)}\n`); stdin.flush(); };

  let serverVersion: string | null = null;
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const readResponse = async (id: number): Promise<Record<string, any> | null> => {
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line) as Record<string, any>;
          if (message.id === id) return message;
        } catch { /* not JSON-RPC; keep reading */ }
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) return null;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
  try {
    const exchange = (async (): Promise<ChannelProbeResult> => {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agentstoz-channel-health', version: '1' } } });
      const init = await readResponse(1);
      if (!init) return failure('제어 도구가 시작 직후 종료됐습니다.');
      if (init.error) return failure('제어 도구가 초기화 요청을 거절했습니다.');
      serverVersion = typeof init.result?.serverInfo?.version === 'string' ? init.result.serverInfo.version : null;
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: CHANNEL_PROBE_TOOL, arguments: {} } });
      const call = await readResponse(2);
      if (!call) return failure('제어 도구가 응답 전에 종료됐습니다.', serverVersion);
      if (call.error || call.result?.isError !== false) {
        return failure(probeErrorText(call), serverVersion);
      }
      const projects = call.result?.structuredContent?.projects;
      return { ok: true, checkedAt: now().toISOString(), serverVersion, projectCount: Array.isArray(projects) ? projects.length : null, error: null };
    })();
    const outcome = await Promise.race([exchange, deadline]);
    return outcome === 'timeout' ? failure(`${Math.round(timeoutMs / 1000)}초 안에 응답이 없었습니다.`, serverVersion) : outcome;
  } catch {
    return failure('제어 도구와 통신하지 못했습니다.', serverVersion);
  } finally {
    clearTimeout(timer);
    try { stdin.end(); } catch { /* already closed */ }
    try { child.kill(); } catch { /* already exited */ }
    try { reader.releaseLock(); } catch { /* pending read */ }
  }
}

/** Plain-language reasons for failures a beginner can act on. */
function friendlyProbeError(raw: string): string {
  if (raw.includes('AGENTSTOZ_CONTROLLER_PORT_ID')) {
    return 'AgentsToZ 운영 프로필이 연결돼 있지 않아 도구를 쓸 수 없습니다. 운영 프로필 패널에서 프로필을 먼저 준비하세요.';
  }
  if (/fetch failed|ECONNREFUSED|Unable to connect/i.test(raw)) return 'AgentsToZ 앱의 로컬 서버에 닿지 못했습니다.';
  return raw;
}

function probeErrorText(message: Record<string, any>): string {
  return friendlyProbeError(rawProbeErrorText(message));
}

function rawProbeErrorText(message: Record<string, any>): string {
  const text = message.result?.content?.[0]?.text;
  if (typeof text === 'string') {
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim().slice(0, 200);
    } catch { /* plain text */ }
  }
  if (typeof message.error?.message === 'string') return message.error.message.slice(0, 200);
  return '제어 도구가 오류를 돌려줬습니다.';
}
