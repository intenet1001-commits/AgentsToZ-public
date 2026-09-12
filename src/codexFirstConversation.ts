import { basename } from 'node:path';

export const CODEX_REMOTE_FIRST_MESSAGE =
  'AgentsToZ 원격 연결을 위해 이 프로젝트의 첫 Codex 대화를 시작합니다. 파일을 읽거나 수정하거나 명령·도구를 실행하지 말고 “원격 작업을 시작할 준비가 됐습니다.”라고만 답하세요.';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_TIMEOUT_MS = 90_000;

type RpcId = number;
type JsonRecord = Record<string, unknown>;

export type CodexFirstConversationErrorCode =
  | 'CODEX_APP_SERVER_UNAVAILABLE'
  | 'CODEX_APP_SERVER_PROTOCOL_FAILED'
  | 'CODEX_DESKTOP_APP_OPEN_FAILED'
  | 'CODEX_DESKTOP_AUTOMATION_PERMISSION_DENIED'
  | 'CODEX_DESKTOP_PROCESS_NOT_FOUND'
  | 'CODEX_DESKTOP_COMPOSER_NOT_READY'
  | 'CODEX_DESKTOP_SUBMISSION_UNCERTAIN'
  | 'CODEX_PROJECT_ASSIGNMENT_FAILED'
  | 'CODEX_PROJECT_METADATA_UNAVAILABLE'
  | 'CODEX_PROJECT_SELECTION_TIMEOUT'
  | 'CODEX_THREAD_PERSISTENCE_TIMEOUT'
  | 'CODEX_FIRST_TURN_FAILED'
  | 'CODEX_FIRST_TURN_TIMEOUT';

export class CodexFirstConversationError extends Error {
  constructor(
    readonly code: CodexFirstConversationErrorCode,
    readonly publicMessage: string,
    options?: { cause?: unknown },
  ) {
    super(publicMessage, options);
    this.name = 'CodexFirstConversationError';
  }
}

export interface CodexFirstConversationResult {
  threadId: string;
  turnId: string;
  title: string;
}

interface WritablePipe {
  write(chunk: string | Uint8Array): unknown;
  flush?(): unknown;
  end?(): unknown;
}

interface CodexAppServerProcess {
  stdin: WritablePipe;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): unknown;
}

export type SpawnCodexAppServer = (
  command: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    stdin: 'pipe';
    stdout: 'pipe';
    stderr: 'pipe';
  },
) => CodexAppServerProcess;

interface PendingRequest {
  resolve(value: JsonRecord): void;
  reject(error: Error): void;
}

interface NotificationWaiter {
  predicate(message: JsonRecord): boolean;
  resolve(value: JsonRecord): void;
  reject(error: Error): void;
}

const asRecord = (value: unknown): JsonRecord | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null
);

class CodexJsonLineRpc {
  #nextId = 1;
  #pending = new Map<RpcId, PendingRequest>();
  #waiters = new Set<NotificationWaiter>();
  #notifications: JsonRecord[] = [];
  #closed = false;
  #failure: Error | null = null;
  #stderr = '';
  readonly #pump: Promise<void>;
  readonly #stderrPump: Promise<void>;

  constructor(readonly process: CodexAppServerProcess) {
    this.#pump = this.#readStdout();
    this.#stderrPump = this.#readStderr();
    void process.exited.then((code) => {
      if (!this.#closed && code !== 0) {
        this.#fail(new CodexFirstConversationError(
          'CODEX_APP_SERVER_UNAVAILABLE',
          'Codex 대화 서버가 시작 중 종료되었습니다.',
        ));
      }
    });
  }

  async request(method: string, params: JsonRecord, timeoutAt: number): Promise<JsonRecord> {
    if (this.#failure) throw this.#failure;
    if (this.#closed) throw new CodexFirstConversationError(
      'CODEX_APP_SERVER_UNAVAILABLE',
      'Codex 대화 서버 연결이 닫혔습니다.',
    );
    const id = this.#nextId++;
    const response = new Promise<JsonRecord>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#write({ method, id, params });
    return this.#until(response, timeoutAt);
  }

  notify(method: string, params: JsonRecord): void {
    this.#write({ method, params });
  }

  async waitFor(
    predicate: (message: JsonRecord) => boolean,
    timeoutAt: number,
  ): Promise<JsonRecord> {
    if (this.#failure) throw this.#failure;
    const existingIndex = this.#notifications.findIndex(predicate);
    if (existingIndex >= 0) return this.#notifications.splice(existingIndex, 1)[0]!;
    const response = new Promise<JsonRecord>((resolve, reject) => {
      this.#waiters.add({ predicate, resolve, reject });
    });
    return this.#until(response, timeoutAt);
  }

  stderrTail(): string {
    return this.#stderr.slice(-2_000);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try { this.process.stdin.end?.(); } catch {}
    const exited = await Promise.race([
      this.process.exited.then(() => true).catch(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 1_500)),
    ]);
    if (!exited) {
      try { this.process.kill('SIGTERM'); } catch {}
    }
    await Promise.allSettled([this.#pump, this.#stderrPump]);
  }

  async #until<T>(promise: Promise<T>, timeoutAt: number): Promise<T> {
    const remaining = timeoutAt - Date.now();
    if (remaining <= 0) throw new CodexFirstConversationError(
      'CODEX_FIRST_TURN_TIMEOUT',
      'Codex 첫 대화 생성 시간이 초과되었습니다.',
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new CodexFirstConversationError(
            'CODEX_FIRST_TURN_TIMEOUT',
            'Codex 첫 대화 생성 시간이 초과되었습니다.',
          )), remaining);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  #write(message: JsonRecord): void {
    try {
      this.process.stdin.write(`${JSON.stringify(message)}\n`);
      this.process.stdin.flush?.();
    } catch (error) {
      const failure = new CodexFirstConversationError(
        'CODEX_APP_SERVER_UNAVAILABLE',
        'Codex 대화 서버에 요청을 보내지 못했습니다.',
        { cause: error },
      );
      this.#fail(failure);
      throw failure;
    }
  }

  async #readStdout(): Promise<void> {
    const reader = this.process.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) this.#acceptLine(line);
          newline = buffer.indexOf('\n');
        }
        if (done) break;
      }
      if (buffer.trim()) this.#acceptLine(buffer.trim());
      if (!this.#closed) this.#fail(new CodexFirstConversationError(
        'CODEX_APP_SERVER_UNAVAILABLE',
        'Codex 대화 서버 연결이 예기치 않게 종료되었습니다.',
      ));
    } catch (error) {
      if (!this.#closed) this.#fail(error instanceof Error ? error : new Error(String(error)));
    } finally {
      reader.releaseLock();
    }
  }

  async #readStderr(): Promise<void> {
    const reader = this.process.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (value) this.#stderr = `${this.#stderr}${decoder.decode(value, { stream: !done })}`.slice(-4_000);
        if (done) break;
      }
    } catch { /* stdout and exit status own the public failure */ }
    finally { reader.releaseLock(); }
  }

  #acceptLine(line: string): void {
    let message: JsonRecord;
    try {
      message = asRecord(JSON.parse(line)) ?? (() => { throw new Error('not an object'); })();
    } catch (error) {
      this.#fail(new CodexFirstConversationError(
        'CODEX_APP_SERVER_PROTOCOL_FAILED',
        'Codex 대화 서버가 올바르지 않은 응답을 보냈습니다.',
        { cause: error },
      ));
      return;
    }
    if (typeof message.id === 'number' && !message.method) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      const error = asRecord(message.error);
      if (error) {
        pending.reject(new CodexFirstConversationError(
          'CODEX_APP_SERVER_PROTOCOL_FAILED',
          typeof error.message === 'string'
            ? `Codex가 첫 대화 요청을 거절했습니다: ${error.message.slice(0, 240)}`
            : 'Codex가 첫 대화 요청을 거절했습니다.',
        ));
        return;
      }
      pending.resolve(asRecord(message.result) ?? {});
      return;
    }
    // A server-initiated request would require an approval, elicitation, or
    // another interactive capability. The fixed first-message turn must never
    // silently answer one on the user's behalf.
    if (message.id !== undefined && typeof message.method === 'string') {
      this.#fail(new CodexFirstConversationError(
        'CODEX_FIRST_TURN_FAILED',
        'Codex 첫 대화가 추가 확인을 요청해 안전하게 중단했습니다.',
      ));
      return;
    }
    for (const waiter of this.#waiters) {
      if (!waiter.predicate(message)) continue;
      this.#waiters.delete(waiter);
      waiter.resolve(message);
      return;
    }
    this.#notifications.push(message);
    if (this.#notifications.length > 256) this.#notifications.shift();
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters.clear();
  }
}

export function projectConversationTitle(projectName: string, folderPath: string): string {
  const name = projectName.trim() || basename(folderPath) || '프로젝트';
  return `AgentsToZ · ${name.slice(0, 72)} · 원격 시작`;
}

/**
 * A Codex Desktop-created task already owns the UI's local-project assignment.
 * Use app-server only after that assignment exists: give the task its stable
 * title and verify that the UI-submitted first turn finished durably.
 */
export async function finalizeCodexDesktopFirstConversation(input: {
  codexPath: string;
  folderPath: string;
  projectName: string;
  threadId: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  spawn?: SpawnCodexAppServer;
}): Promise<CodexFirstConversationResult> {
  if (!UUID_RE.test(input.threadId)) {
    throw new CodexFirstConversationError(
      'CODEX_APP_SERVER_PROTOCOL_FAILED',
      'Codex가 올바른 프로젝트 대화 ID를 기록하지 않았습니다.',
    );
  }
  const spawn = input.spawn ?? ((command, options) => Bun.spawn(command, options) as unknown as CodexAppServerProcess);
  let process: CodexAppServerProcess;
  try {
    process = spawn(
      [input.codexPath, 'app-server', '--listen', 'stdio://'],
      {
        cwd: input.folderPath,
        env: input.env ?? processEnv(),
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
  } catch (error) {
    throw new CodexFirstConversationError(
      'CODEX_APP_SERVER_UNAVAILABLE',
      'Codex CLI의 대화 서버를 시작하지 못했습니다.',
      { cause: error },
    );
  }

  const rpc = new CodexJsonLineRpc(process);
  const timeoutAt = Date.now() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const title = projectConversationTitle(input.projectName, input.folderPath);
  try {
    await rpc.request('initialize', {
      clientInfo: {
        name: 'agentstoz_bycs',
        title: 'AgentsToZ by CS',
        version: '1.0.0',
      },
      capabilities: null,
    }, timeoutAt);
    rpc.notify('initialized', {});
    while (Date.now() < timeoutAt) {
      const verified = await rpc.request(
        'thread/read',
        { threadId: input.threadId, includeTurns: true },
        timeoutAt,
      );
      const verifiedThread = asRecord(verified.thread);
      const turns = Array.isArray(verifiedThread?.turns) ? verifiedThread.turns : [];
      const latestTurn = [...turns].reverse().map(asRecord).find((turn): turn is JsonRecord => !!turn);
      const turnId = typeof latestTurn?.id === 'string' ? latestTurn.id : '';
      if (UUID_RE.test(turnId) && latestTurn?.status === 'completed') {
        // Run the explicit name after completion so Codex's automatic title
        // generation cannot race and overwrite the stable remote label.
        await rpc.request('thread/name/set', { threadId: input.threadId, name: title }, timeoutAt);
        await rpc.request('thread/unsubscribe', { threadId: input.threadId }, timeoutAt).catch(() => ({}));
        return { threadId: input.threadId, turnId, title };
      }
      if (latestTurn && latestTurn.status !== 'inProgress') {
        throw new CodexFirstConversationError(
          'CODEX_FIRST_TURN_FAILED',
          'Codex 프로젝트의 첫 메시지가 완료되지 않았습니다.',
        );
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new CodexFirstConversationError(
      'CODEX_FIRST_TURN_TIMEOUT',
      'Codex 프로젝트의 첫 메시지 완료 확인 시간이 초과되었습니다.',
    );
  } catch (error) {
    if (error instanceof CodexFirstConversationError) throw error;
    throw new CodexFirstConversationError(
      'CODEX_FIRST_TURN_FAILED',
      'Codex 프로젝트의 첫 대화를 확인하지 못했습니다.',
      { cause: error },
    );
  } finally {
    await rpc.close();
  }
}

export async function createCodexFirstConversation(input: {
  codexPath: string;
  folderPath: string;
  projectName: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  spawn?: SpawnCodexAppServer;
}): Promise<CodexFirstConversationResult> {
  const spawn = input.spawn ?? ((command, options) => Bun.spawn(command, options) as unknown as CodexAppServerProcess);
  let process: CodexAppServerProcess;
  try {
    process = spawn(
      [input.codexPath, 'app-server', '--listen', 'stdio://'],
      {
        cwd: input.folderPath,
        env: input.env ?? processEnv(),
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
  } catch (error) {
    throw new CodexFirstConversationError(
      'CODEX_APP_SERVER_UNAVAILABLE',
      'Codex CLI의 대화 서버를 시작하지 못했습니다.',
      { cause: error },
    );
  }

  const rpc = new CodexJsonLineRpc(process);
  const timeoutAt = Date.now() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let threadId = '';
  try {
    await rpc.request('initialize', {
      clientInfo: {
        name: 'agentstoz_bycs',
        title: 'AgentsToZ by CS',
        version: '1.0.0',
      },
      // Required by the current app-server InitializeParams contract. `null`
      // means this minimal bridge does not claim any optional client feature.
      capabilities: null,
    }, timeoutAt);
    rpc.notify('initialized', {});

    const started = await rpc.request('thread/start', {
      cwd: input.folderPath,
      ephemeral: false,
      serviceName: 'agentstoz_bycs',
      threadSource: 'agentstoz_remote_first_message',
    }, timeoutAt);
    const thread = asRecord(started.thread);
    threadId = typeof thread?.id === 'string' ? thread.id : '';
    if (!UUID_RE.test(threadId) || thread?.ephemeral === true) {
      throw new CodexFirstConversationError(
        'CODEX_APP_SERVER_PROTOCOL_FAILED',
        'Codex가 영구 대화 ID를 반환하지 않았습니다.',
      );
    }

    const title = projectConversationTitle(input.projectName, input.folderPath);
    await rpc.request('thread/name/set', { threadId, name: title }, timeoutAt);
    const turnStarted = await rpc.request('turn/start', {
      threadId,
      // Current Codex UserInput requires the UI span list even when the fixed
      // plain-text message has no mentions or other rich elements.
      input: [{ type: 'text', text: CODEX_REMOTE_FIRST_MESSAGE, text_elements: [] }],
      cwd: input.folderPath,
    }, timeoutAt);
    const turn = asRecord(turnStarted.turn);
    const turnId = typeof turn?.id === 'string' ? turn.id : '';
    if (!UUID_RE.test(turnId)) {
      throw new CodexFirstConversationError(
        'CODEX_APP_SERVER_PROTOCOL_FAILED',
        'Codex가 첫 메시지의 실행 ID를 반환하지 않았습니다.',
      );
    }

    const completed = await rpc.waitFor((message) => {
      if (message.method !== 'turn/completed') return false;
      const params = asRecord(message.params);
      const completedTurn = asRecord(params?.turn);
      return params?.threadId === threadId && completedTurn?.id === turnId;
    }, timeoutAt);
    const completedTurn = asRecord(asRecord(completed.params)?.turn);
    if (completedTurn?.status !== 'completed') {
      throw new CodexFirstConversationError(
        'CODEX_FIRST_TURN_FAILED',
        'Codex 첫 메시지가 완료되지 않았습니다.',
      );
    }

    const verified = await rpc.request('thread/read', { threadId, includeTurns: true }, timeoutAt);
    const verifiedThread = asRecord(verified.thread);
    const turns = Array.isArray(verifiedThread?.turns) ? verifiedThread.turns : [];
    const persisted = turns.some(candidate => {
      const row = asRecord(candidate);
      return row?.id === turnId && row.status === 'completed';
    });
    if (!persisted) {
      throw new CodexFirstConversationError(
        'CODEX_APP_SERVER_PROTOCOL_FAILED',
        'Codex 첫 대화가 저장되었는지 확인하지 못했습니다.',
      );
    }

    await rpc.request('thread/unsubscribe', { threadId }, timeoutAt).catch(() => ({}));
    return { threadId, turnId, title };
  } catch (error) {
    if (error instanceof CodexFirstConversationError) throw error;
    throw new CodexFirstConversationError(
      'CODEX_FIRST_TURN_FAILED',
      'Codex 첫 대화를 만들지 못했습니다.',
      { cause: error },
    );
  } finally {
    await rpc.close();
  }
}

function processEnv(): Record<string, string | undefined> {
  return { ...process.env };
}
