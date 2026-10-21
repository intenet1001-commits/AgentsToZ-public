export const CODEX_FIRST_TURN_CREATED_OPEN_FAILED = 'CODEX_FIRST_TURN_CREATED_OPEN_FAILED' as const;
export const CODEX_FIRST_TURN_RECOVERY_UNVERIFIED = 'CODEX_FIRST_TURN_RECOVERY_UNVERIFIED' as const;

export type CodexFirstConversationRecoveryStatus = 'verified' | 'missing' | 'unavailable';

export interface CodexFirstConversationPendingStore {
  load(projectKey: string): string | null;
  save(projectKey: string, threadId: string): void;
  clear(projectKey: string): void;
}

export class CodexFirstConversationOpenError extends Error {
  readonly code = CODEX_FIRST_TURN_CREATED_OPEN_FAILED;

  constructor(
    readonly reusedCreatedThread: boolean,
    options?: { cause?: unknown },
  ) {
    super(
      reusedCreatedThread
        ? '첫 Codex 대화는 이미 생성되어 있지만 Codex 앱에서 열지 못했습니다. Codex 앱 상태를 확인한 뒤 같은 버튼으로 다시 시도하세요.'
        : '첫 Codex 대화는 생성했지만 Codex 앱에서 열지 못했습니다. Codex 앱 상태를 확인한 뒤 같은 버튼을 다시 누르면 새 대화 없이 방금 대화를 다시 엽니다.',
      options,
    );
    this.name = 'CodexFirstConversationOpenError';
  }
}

export class CodexFirstConversationRecoveryError extends Error {
  readonly code = CODEX_FIRST_TURN_RECOVERY_UNVERIFIED;

  constructor() {
    super('이전에 만든 Codex 대화가 정확한 프로젝트에 연결되어 있는지 확인하지 못했습니다. Codex 앱을 완전히 연 뒤 같은 버튼으로 다시 시도하세요.');
    this.name = 'CodexFirstConversationRecoveryError';
  }
}

export interface CodexFirstConversationLaunchResult {
  threadId: string;
  reusedCreatedThread: boolean;
}

/**
 * Makes the remote “create and open” action retry-safe. Once Codex durably
 * creates a thread, an OS deep-link failure is surfaced to the controller and
 * the next press retries that exact thread instead of creating a duplicate.
 */
export class CodexFirstConversationLaunchCoordinator {
  readonly #pendingThreadByProject = new Map<string, string>();
  readonly #inflightByProject = new Map<string, Promise<CodexFirstConversationLaunchResult>>();
  readonly #pendingStore: CodexFirstConversationPendingStore | null;

  constructor(pendingStore: CodexFirstConversationPendingStore | null = null) {
    this.#pendingStore = pendingStore;
  }

  hasPending(projectKey: string): boolean {
    return this.#pendingThreadByProject.has(projectKey) || this.#inflightByProject.has(projectKey)
      || !!this.#pendingStore?.load(projectKey);
  }

  createAndOpen(input: {
    projectKey: string;
    /** The creator must call this as soon as an already-created thread is
     * known, before any later metadata verification that can time out. */
    createConversation: (
      retainCreatedThread: (threadId: string) => void,
    ) => Promise<{ threadId: string }>;
    /** Runs after the durable thread id is retained, so a failed verification
     * retry cannot create a second conversation in the same sidecar process. */
    finalizeConversation?: (threadId: string) => Promise<void>;
    /** A sidecar restart may recover a durable thread id. Re-open it only after
     * metadata proves that it still belongs to this exact project. */
    verifyRecoveredConversation?: (
      threadId: string,
    ) => Promise<CodexFirstConversationRecoveryStatus>;
    openThread: (threadId: string) => unknown;
  }): Promise<CodexFirstConversationLaunchResult> {
    const inflight = this.#inflightByProject.get(input.projectKey);
    if (inflight) return inflight;
    const task = this.#createAndOpen(input).finally(() => {
      if (this.#inflightByProject.get(input.projectKey) === task) {
        this.#inflightByProject.delete(input.projectKey);
      }
    });
    this.#inflightByProject.set(input.projectKey, task);
    return task;
  }

  async #createAndOpen(input: {
    projectKey: string;
    createConversation: (
      retainCreatedThread: (threadId: string) => void,
    ) => Promise<{ threadId: string }>;
    finalizeConversation?: (threadId: string) => Promise<void>;
    verifyRecoveredConversation?: (
      threadId: string,
    ) => Promise<CodexFirstConversationRecoveryStatus>;
    openThread: (threadId: string) => unknown;
  }): Promise<CodexFirstConversationLaunchResult> {
    let threadId = this.#pendingThreadByProject.get(input.projectKey);
    let recoveredFromStore = false;
    if (!threadId && this.#pendingStore) {
      threadId = this.#pendingStore.load(input.projectKey) ?? undefined;
      recoveredFromStore = !!threadId;
      if (threadId) this.#pendingThreadByProject.set(input.projectKey, threadId);
    }

    if (threadId && recoveredFromStore) {
      const recoveryStatus = input.verifyRecoveredConversation
        ? await input.verifyRecoveredConversation(threadId)
        : 'unavailable';
      if (recoveryStatus === 'missing') {
        this.#pendingStore?.clear(input.projectKey);
        this.#pendingThreadByProject.delete(input.projectKey);
        threadId = undefined;
        recoveredFromStore = false;
      } else if (recoveryStatus !== 'verified') {
        throw new CodexFirstConversationRecoveryError();
      }
    }

    const reusedCreatedThread = !!threadId;
    if (!threadId) {
      let retainedByCreator: string | null = null;
      const retainCreatedThread = (createdThreadId: string): void => {
        const retained = this.#pendingThreadByProject.get(input.projectKey);
        if (retained && retained !== createdThreadId) {
          throw new Error('Codex creator reported conflicting thread IDs.');
        }
        // Keep the in-process fence even if the durable write itself fails.
        // A same-process retry can then retry the write without creating a
        // second already-dispatched desktop conversation.
        this.#pendingThreadByProject.set(input.projectKey, createdThreadId);
        this.#pendingStore?.save(input.projectKey, createdThreadId);
        retainedByCreator = createdThreadId;
      };
      const conversation = await input.createConversation(retainCreatedThread);
      threadId = conversation.threadId;
      if (retainedByCreator && retainedByCreator !== threadId) {
        throw new Error('Codex creator returned a different thread ID after retention.');
      }
      if (!retainedByCreator) retainCreatedThread(threadId);
    } else {
      // Re-saving repairs an earlier same-process write failure without
      // creating another thread.
      this.#pendingStore?.save(input.projectKey, threadId);
    }
    await input.finalizeConversation?.(threadId);
    try {
      await input.openThread(threadId);
    } catch (cause) {
      throw new CodexFirstConversationOpenError(reusedCreatedThread, { cause });
    }
    this.#pendingStore?.clear(input.projectKey);
    if (this.#pendingThreadByProject.get(input.projectKey) === threadId) {
      this.#pendingThreadByProject.delete(input.projectKey);
    }
    return { threadId, reusedCreatedThread };
  }
}
