import { describe, expect, test } from 'bun:test';
import {
  CODEX_REMOTE_FIRST_MESSAGE,
  CodexFirstConversationError,
  createCodexFirstConversation,
  finalizeCodexDesktopFirstConversation,
  type SpawnCodexAppServer,
} from '../src/codexFirstConversation';

const THREAD_ID = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const TURN_ID = '0199a213-81c0-7800-8aa1-bbab2a035a54';

function fakeAppServer(options: {
  turnStatus?: 'completed' | 'failed';
  requestApproval?: boolean;
} = {}): {
  spawn: SpawnCodexAppServer;
  requests: Array<Record<string, any>>;
  command: string[];
} {
  const requests: Array<Record<string, any>> = [];
  const command: string[] = [];
  const spawn: SpawnCodexAppServer = (nextCommand) => {
    command.push(...nextCommand);
    let stdoutController: ReadableStreamDefaultController<Uint8Array>;
    let stderrController: ReadableStreamDefaultController<Uint8Array>;
    let resolveExit!: (code: number) => void;
    let closed = false;
    const encoder = new TextEncoder();
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) { stdoutController = controller; },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) { stderrController = controller; },
    });
    const exited = new Promise<number>(resolve => { resolveExit = resolve; });
    const emit = (value: Record<string, unknown>) => {
      if (!closed) stdoutController.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
    };
    const finish = (code = 0) => {
      if (closed) return;
      closed = true;
      stdoutController.close();
      stderrController.close();
      resolveExit(code);
    };
    const stdin = {
      write(chunk: string | Uint8Array) {
        const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
        for (const line of text.trim().split('\n')) {
          if (!line) continue;
          const request = JSON.parse(line) as Record<string, any>;
          requests.push(request);
          if (request.method === 'initialize') emit({ id: request.id, result: { userAgent: 'fake' } });
          else if (request.method === 'thread/start') emit({
            id: request.id,
            result: { thread: { id: THREAD_ID, sessionId: THREAD_ID, ephemeral: false } },
          });
          else if (request.method === 'thread/name/set') emit({ id: request.id, result: {} });
          else if (request.method === 'turn/start') {
            emit({ id: request.id, result: { turn: { id: TURN_ID, status: 'inProgress' } } });
            if (options.requestApproval) {
              emit({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: THREAD_ID } });
            } else {
              emit({
                method: 'turn/completed',
                params: {
                  threadId: THREAD_ID,
                  turn: { id: TURN_ID, status: options.turnStatus ?? 'completed' },
                },
              });
            }
          } else if (request.method === 'thread/read') emit({
            id: request.id,
            result: {
              thread: {
                id: THREAD_ID,
                turns: [{ id: TURN_ID, status: options.turnStatus ?? 'completed' }],
              },
            },
          });
          else if (request.method === 'thread/unsubscribe') emit({
            id: request.id,
            result: { status: 'unsubscribed' },
          });
        }
      },
      flush() {},
      end() { finish(); },
    };
    return {
      stdin,
      stdout,
      stderr,
      exited,
      kill() { finish(143); },
    };
  };
  return { spawn, requests, command };
}

describe('Codex first-conversation bridge', () => {
  test('names and verifies a Codex Desktop-created project thread without creating another thread', async () => {
    const fake = fakeAppServer();
    const result = await finalizeCodexDesktopFirstConversation({
      codexPath: '/Applications/ChatGPT.app/Contents/Resources/codex',
      folderPath: '/Users/test/Product',
      projectName: 'Product',
      threadId: THREAD_ID,
      spawn: fake.spawn,
      timeoutMs: 2_000,
    });

    expect(result).toEqual({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      title: 'AgentsToZ · Product · 원격 시작',
    });
    expect(fake.requests.map(request => request.method)).toEqual([
      'initialize',
      'initialized',
      'thread/read',
      'thread/name/set',
      'thread/unsubscribe',
    ]);
    expect(fake.requests.some(request => request.method === 'thread/start')).toBe(false);
    expect(fake.requests.some(request => request.method === 'turn/start')).toBe(false);
  });

  test('creates, names, completes, and re-reads one persistent fixed-message thread', async () => {
    const fake = fakeAppServer();
    const result = await createCodexFirstConversation({
      codexPath: '/Applications/ChatGPT.app/Contents/Resources/codex',
      folderPath: '/Users/test/Product',
      projectName: 'Product',
      spawn: fake.spawn,
      timeoutMs: 2_000,
    });

    expect(result).toEqual({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      title: 'AgentsToZ · Product · 원격 시작',
    });
    expect(fake.command).toEqual([
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      'app-server',
      '--listen',
      'stdio://',
    ]);
    expect(fake.requests.map(request => request.method)).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'thread/name/set',
      'turn/start',
      'thread/read',
      'thread/unsubscribe',
    ]);
    const initialize = fake.requests.find(request => request.method === 'initialize')!;
    expect(initialize.params.capabilities).toBeNull();
    const threadStart = fake.requests.find(request => request.method === 'thread/start')!;
    expect(threadStart.params).toEqual({
      cwd: '/Users/test/Product',
      ephemeral: false,
      serviceName: 'agentstoz_bycs',
      threadSource: 'agentstoz_remote_first_message',
    });
    const turnStart = fake.requests.find(request => request.method === 'turn/start')!;
    expect(turnStart.params).toEqual({
      threadId: THREAD_ID,
      input: [{ type: 'text', text: CODEX_REMOTE_FIRST_MESSAGE, text_elements: [] }],
      cwd: '/Users/test/Product',
    });
    expect(JSON.stringify(fake.requests)).not.toContain('workspace-write');
    expect(JSON.stringify(fake.requests)).not.toContain('danger-full-access');
  });

  test('fails closed instead of answering a server-side approval request', async () => {
    const fake = fakeAppServer({ requestApproval: true });
    await expect(createCodexFirstConversation({
      codexPath: 'codex',
      folderPath: '/Users/test/Product',
      projectName: 'Product',
      spawn: fake.spawn,
      timeoutMs: 2_000,
    })).rejects.toMatchObject({
      code: 'CODEX_FIRST_TURN_FAILED',
    } satisfies Partial<CodexFirstConversationError>);
    expect(fake.requests.some(request => request.id === 99 && request.result)).toBe(false);
  });

  test('does not report a failed first turn as a created conversation', async () => {
    const fake = fakeAppServer({ turnStatus: 'failed' });
    await expect(createCodexFirstConversation({
      codexPath: 'codex',
      folderPath: '/Users/test/Product',
      projectName: 'Product',
      spawn: fake.spawn,
      timeoutMs: 2_000,
    })).rejects.toMatchObject({
      code: 'CODEX_FIRST_TURN_FAILED',
    } satisfies Partial<CodexFirstConversationError>);
    expect(fake.requests.some(request => request.method === 'thread/read')).toBe(false);
  });
});
