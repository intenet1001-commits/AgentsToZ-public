// Runs inside a fake orchestrator CLI, i.e. inside a Workroom PTY that AgentsToZ started.
// It drives another agent's Workroom exactly as an AI would: by talking JSON-RPC to the
// real agentstoz_use MCP server over stdio, which calls the real (isolated) API.
// Usage: bun workroom-orchestrator-client.ts <workerAgent> <portId> <nonce>
import {join} from 'node:path';

const [workerAgent, portId, nonce] = process.argv.slice(2) as [string, string, string];
const home = process.env.HOME!;
const server = Bun.spawn([process.execPath, join(import.meta.dir, '..', '..', 'agentstoz-use-mcp-server.ts')], {
  // A neutral cwd: no project .env or bunfig reaches the MCP server.
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

async function tool(name: string, args: Record<string, unknown>): Promise<any> {
  const message = await request('tools/call', {name: `agentstoz_use_${name}`, arguments: args});
  if (message.error || message.result?.isError !== false) {
    throw new Error(`${name}: ${message.result?.content?.[0]?.text ?? JSON.stringify(message.error)}`);
  }
  return message.result.structuredContent;
}

/** The recommended loop: wait until the worker is quiet, then read its plain tail. */
async function untilTail(sessionId: string, text: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const waited = await tool('wait_workroom_session', {portId, sessionId, idleMs: 1_000, timeoutMs: 8_000});
    if (waited.waitResult === 'exited') throw new Error(`the ${workerAgent} worker exited`);
    const read = await tool('read_workroom_session', {portId, sessionId, view: 'tail'});
    if (read.text.includes(text)) return;
  }
  throw new Error(`the ${workerAgent} worker never printed ${text}`);
}

try {
  const initialized = await request('initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'nested-orchestrator', version: '1'}});
  if (!initialized.result) throw new Error('initialize failed');
  stdin.write(`${JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'})}\n`);
  const started = await tool('start_workroom_session', {portId, agent: workerAgent, requestId: `start_${nonce}`, instruction: nonce, foreground: false});
  const sessionId: string = started.session.id;
  if (started.session.agent !== workerAgent) throw new Error(`started ${started.session.agent}, not ${workerAgent}`);
  await untilTail(sessionId, `GOT:${workerAgent}:${nonce}`);
  await tool('send_workroom_instruction', {portId, sessionId, requestId: `send_${nonce}`, instruction: `second-${nonce}`});
  await untilTail(sessionId, `GOT:${workerAgent}:second-${nonce}`);
  const closed = await tool('close_workroom_session', {portId, sessionId, requestId: `close_${nonce}`});
  if (closed.session.state !== 'exited') throw new Error(`close left the worker ${closed.session.state}`);
  console.log(`RELAY:${nonce}:${sessionId}`);
} catch (error) {
  console.log(`FAIL:${nonce}:${(error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300)}`);
} finally {
  try { stdin.end(); } catch { /* already closed */ }
  server.kill();
  await server.exited;
}
