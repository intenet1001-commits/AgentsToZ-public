import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type JsonObject = Record<string, any>;

const cwd = process.cwd();
const modePath = join(cwd, 'fake-codex-mode.txt');
const statePath = join(cwd, 'fake-codex-state.json');
const mode = readFileSync(modePath, 'utf8').trim();
if (mode !== 'hold' && mode !== 'success') process.exit(64);

const descendantExecutable = readFileSync(
  join(cwd, 'fake-codex-descendant-path.txt'),
  'utf8',
).trim();
const descendantReadyPath = join(cwd, 'fake-codex-descendant-ready.txt');
const descendantTermPath = join(cwd, 'fake-codex-descendant-term.txt');
try { unlinkSync(descendantReadyPath); } catch {}
try { unlinkSync(descendantTermPath); } catch {}
const descendant = Bun.spawn([descendantExecutable, descendantReadyPath, descendantTermPath], {
  stdin: 'ignore',
  stdout: 'ignore',
  stderr: 'ignore',
  detached: false,
});
const descendantReadyDeadline = performance.now() + 2_000;
while (!existsSync(descendantReadyPath) && performance.now() < descendantReadyDeadline) {
  await Bun.sleep(5);
}
if (!existsSync(descendantReadyPath)
  || Number(readFileSync(descendantReadyPath, 'utf8')) !== descendant.pid) {
  try { descendant.kill('SIGKILL'); } catch {}
  process.exit(70);
}
const invocationId = randomUUID();
const threadId = randomUUID();
const turnId = randomUUID();

function persistState(phase: 'booting' | 'holding' | 'completed'): void {
  writeFileSync(statePath, JSON.stringify({
    invocationId,
    guardPid: process.ppid,
    providerPid: process.pid,
    descendantPid: descendant.pid,
    threadId,
    turnId,
    phase,
  }), { mode: 0o600 });
}

function send(value: JsonObject): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function handle(message: JsonObject): void {
  const id = message.id;
  const params = message.params && typeof message.params === 'object'
    ? message.params as JsonObject
    : {};
  switch (message.method) {
    case 'initialize':
      send({ id, result: { userAgent: 'agentstoz-e2e-fake' } });
      return;
    case 'initialized':
      return;
    case 'config/read':
      send({ id, result: { config: { mcp_servers: {} }, origins: {}, layers: [] } });
      return;
    case 'thread/start': {
      const danger = params.sandbox === 'danger-full-access';
      send({
        id,
        result: {
          cwd,
          runtimeWorkspaceRoots: [cwd],
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          model: params.model,
          reasoningEffort: params.config?.model_reasoning_effort ?? null,
          sandbox: danger ? { type: 'dangerFullAccess' } : {
            type: 'workspaceWrite',
            writableRoots: [],
            networkAccess: false,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
          },
          thread: { id: threadId, sessionId: threadId, cwd, ephemeral: true },
        },
      });
      return;
    }
    case 'turn/start': {
      send({ id, result: { turn: { id: turnId, status: 'inProgress' } } });
      persistState(mode === 'hold' ? 'holding' : 'completed');
      send({
        method: 'turn/started',
        params: { threadId, turn: { id: turnId, status: 'inProgress' } },
      });
      if (mode === 'success') {
        const finalItem = {
          type: 'agentMessage',
          id: 'item-final',
          phase: 'final_answer',
          text: '격리된 수직 통합 작업을 완료했습니다.',
        };
        send({
          method: 'item/completed',
          params: { threadId, turnId, item: finalItem },
        });
        send({
          method: 'turn/completed',
          params: {
            threadId,
            turn: { id: turnId, status: 'completed', error: null, items: [finalItem] },
          },
        });
      }
      return;
    }
    case 'thread/unsubscribe':
      send({ id, result: { status: 'unsubscribed' } });
      return;
    default:
      if (id !== undefined) {
        send({ id, error: { code: -32601, message: 'unsupported test method' } });
      }
  }
}

persistState('booting');
const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
let buffered = '';
try {
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    buffered += decoder.decode(next.value, { stream: true });
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) handle(JSON.parse(line) as JsonObject);
      newline = buffered.indexOf('\n');
    }
  }
} finally {
  reader.releaseLock();
}

// The process guard owns descendant cleanup. Exiting here deliberately leaves
// the child alive long enough for the guard's PGID proof to be exercised.
process.exit(0);
