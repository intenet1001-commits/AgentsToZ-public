// Runs inside a fake CLI, i.e. inside a Workroom PTY that AgentsToZ started, like an AI that drives
// Workrooms. It talks JSON-RPC to the real agentstoz_use MCP server over stdio and gives that server
// only a Codex-like filtered environment (no AGENTSTOZ_WORKROOM_* variables), so the host can only
// recognize the caller from its process ancestry. Each call's result is appended to
// <script>.out.jsonl as it arrives; <script>.done marks the end.
// Usage: bun workroom-mcp-script-client.ts <script.json>
import {appendFileSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const [scriptPath] = process.argv.slice(2) as [string];
const calls = JSON.parse(readFileSync(scriptPath, 'utf8')) as {name: string; args: Record<string, unknown>}[];
const home = process.env.HOME!;
const server = Bun.spawn([process.execPath, join(import.meta.dir, '..', '..', 'agentstoz-use-mcp-server.ts')], {
  cwd: home,
  env: {
    PATH: process.env.PATH ?? '',
    HOME: home,
    APP_DATA_DIR: process.env.APP_DATA_DIR ?? '',
    AGENTSTOZ_USE_ENDPOINT: `http://127.0.0.1:${process.env.API_PORT}/api/agentstoz-use/action`,
  },
  stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
});
const stdin = server.stdin as import('bun').FileSink;
const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
const decoder = new TextDecoder();
let buffer = '', nextId = 1;

async function request(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  stdin.write(`${JSON.stringify({jsonrpc: '2.0', id, method, params})}\n`);
  await stdin.flush();
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id === id) return message;
      continue;
    }
    const chunk = await reader.read();
    if (chunk.done) throw new Error('the MCP server closed');
    buffer += decoder.decode(chunk.value, {stream: true});
  }
}

try {
  await request('initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'workroom-script', version: '1'}});
  stdin.write(`${JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'})}\n`);
  for (const call of calls) {
    const message = await request('tools/call', {name: `agentstoz_use_${call.name}`, arguments: call.args});
    const payload = message.result?.structuredContent ?? JSON.parse(message.result?.content?.[0]?.text ?? 'null');
    appendFileSync(`${scriptPath}.out.jsonl`, `${JSON.stringify({name: call.name, isError: message.result?.isError === true, payload})}\n`);
  }
} catch (error) {
  appendFileSync(`${scriptPath}.out.jsonl`, `${JSON.stringify({name: 'client-error', isError: true, payload: String(error)})}\n`);
} finally {
  writeFileSync(`${scriptPath}.done`, 'done');
  try { stdin.end(); } catch { /* already closed */ }
  server.kill();
  await server.exited;
}
