// Runs inside a fake member CLI, i.e. inside the member Workroom PTY AgentsToZ started for a team.
// It reports exactly as a member AI would: JSON-RPC to the real agentstoz_use MCP server over stdio,
// whose caller headers let the host see which Workroom is reporting.
// Usage: bun team-member-report-client.ts <teamId> <memberId> <reportAsMemberId?>
import {join} from 'node:path';

const [teamId, memberId, reportAs] = process.argv.slice(2) as [string, string, string | undefined];
const home = process.env.HOME!;
const server = Bun.spawn([process.execPath, join(import.meta.dir, '..', '..', 'agentstoz-use-mcp-server.ts')], {
  cwd: home,
  env: {PATH: process.env.PATH ?? '', HOME: home, APP_DATA_DIR: process.env.APP_DATA_DIR ?? '',
    AGENTSTOZ_USE_ENDPOINT: `http://127.0.0.1:${process.env.API_PORT}/api/agentstoz-use/action`},
  stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
});
const stdin = server.stdin as import('bun').FileSink;
const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
const decoder = new TextDecoder();
let buffer = '', nextId = 1;
async function request(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  stdin.write(`${JSON.stringify({jsonrpc: '2.0', id, method, params})}\n`); await stdin.flush();
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline >= 0) { const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1); if (!line) continue; const message = JSON.parse(line); if (message.id === id) return message; continue; }
    const chunk = await reader.read(); if (chunk.done) throw new Error('the MCP server closed');
    buffer += decoder.decode(chunk.value, {stream: true});
  }
}
try {
  await request('initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'team-member', version: '1'}});
  stdin.write(`${JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'})}\n`);
  const message = await request('tools/call', {name: 'agentstoz_use_report_team_task', arguments: {teamId, memberId: reportAs || memberId, status: 'done', summary: `${memberId}: committed team-work.txt; checks passed`}});
  const failed = message.error || message.result?.isError !== false;
  console.log(failed ? `REFUSED:${(message.result?.content?.[0]?.text ?? JSON.stringify(message.error)).replace(/\s+/g, ' ').slice(0, 200)}` : `REPORTED:${reportAs || memberId}`);
} finally {
  try { stdin.end(); } catch { /* already closed */ }
  server.kill(); await server.exited;
}
