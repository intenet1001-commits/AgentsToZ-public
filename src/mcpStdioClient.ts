import type {McpServerEntry} from './csDutyAgent';

/**
 * Calls one tool of a stdio MCP server once and exits — used only to fill pickers (KakaoTalk room list,
 * Slack conversations) from the same servers the duty session will use. Runs in a neutral cwd (`/`) so a
 * project `.env` never reaches it, and always kills its own child.
 */
export async function callMcpToolOnce(entry: McpServerEntry, tool: string, args: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
  const child = Bun.spawn([entry.command, ...(entry.args ?? [])], {
    cwd: '/', env: {...process.env, ...(entry.env ?? {})} as Record<string, string>,
    stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
  });
  const send = (message: unknown) => { child.stdin.write(JSON.stringify(message) + '\n'); child.stdin.flush(); };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    const nextResponse = async (id: number): Promise<Record<string, unknown>> => {
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (!line) continue;
          let message: Record<string, unknown>;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.id === id) return message;
          continue;
        }
        const {value, done} = await reader.read();
        if (done) throw new Error('MCP 서버가 응답 없이 끝났습니다.');
        buffered += decoder.decode(value, {stream: true});
        if (buffered.length > 4_000_000) throw new Error('MCP 응답이 너무 큽니다.');
      }
    };
    const work = (async () => {
      send({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'agentstoz', version: '1'}}});
      const init = await nextResponse(1);
      if (init.error) throw new Error('MCP 서버를 시작하지 못했습니다.');
      send({jsonrpc: '2.0', method: 'notifications/initialized'});
      send({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: tool, arguments: args}});
      const response = await nextResponse(2);
      const result = response.result as {content?: {type: string; text?: string}[]; isError?: boolean} | undefined;
      const text = result?.content?.find(part => part.type === 'text')?.text ?? '';
      let payload: unknown = text;
      try { payload = JSON.parse(text); } catch { /* plain text result */ }
      if (response.error || result?.isError) {
        const message = (payload as {error?: {message?: string} | string})?.error;
        throw new Error(typeof message === 'string' ? message : message?.message || `MCP 도구 ${tool}이(가) 실패했습니다.`);
      }
      return payload;
    })();
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('MCP 서버가 제때 답하지 않았습니다.')), timeoutMs); });
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    try { child.stdin.end(); } catch { /* already closed */ }
    child.kill();
  }
}
