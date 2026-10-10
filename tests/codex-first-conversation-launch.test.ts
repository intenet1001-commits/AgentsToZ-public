import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  CODEX_FIRST_TURN_CREATED_OPEN_FAILED,
  CODEX_FIRST_TURN_RECOVERY_UNVERIFIED,
  CodexFirstConversationLaunchCoordinator,
  type CodexFirstConversationPendingStore,
} from '../src/codexFirstConversationLaunch';

class MemoryPendingStore implements CodexFirstConversationPendingStore {
  readonly entries = new Map<string, string>();

  load(projectKey: string): string | null {
    return this.entries.get(projectKey) ?? null;
  }

  save(projectKey: string, threadId: string): void {
    this.entries.set(projectKey, threadId);
  }

  clear(projectKey: string): void {
    this.entries.delete(projectKey);
  }
}

describe('remote Codex first-conversation launch coordination', () => {
  test('requires exact project readiness but supports drafts whose ID is persisted only after Return', () => {
    const source = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
    const start = source.indexOf('async function createCodexDesktopProjectConversation');
    const end = source.indexOf('/** Only a session ID parsed from Claude Code', start);
    const createConversation = source.slice(start, end);
    expect(createConversation).toContain('if (!projectReady)');
    expect(createConversation).not.toContain('if (!projectReady.projectTaskId)');
    expect(createConversation).toContain('return submitCodexDesktopDraft({');
    expect(createConversation).toContain('store: remoteCodexSubmissionFence');
    expect(createConversation).toContain('retainCreatedThread: input.retainCreatedThread');
    expect(createConversation).toContain('findCreatedThread: () => waitForFreshChatGptProjectConversation(');
    expect(source).toContain('create: retainCreatedThread => createCodexDesktopProjectConversation({folderPath, projectName, retainCreatedThread})');
    expect(source).toContain('await prepareProjectCodexApp(workingPath, target.name)');
  });

  test('creates once and opens the exact resulting thread', async () => {
    const coordinator = new CodexFirstConversationLaunchCoordinator();
    const opened: string[] = [];
    const result = await coordinator.createAndOpen({
      projectKey: '/project',
      createConversation: async () => ({ threadId: 'thread-1' }),
      openThread: threadId => opened.push(threadId),
    });
    expect(result).toEqual({ threadId: 'thread-1', reusedCreatedThread: false });
    expect(opened).toEqual(['thread-1']);
  });

  test('surfaces an open failure and retries the same durable thread without duplication', async () => {
    const coordinator = new CodexFirstConversationLaunchCoordinator();
    let createCount = 0;
    let failOpen = true;
    const createConversation = async () => ({ threadId: `thread-${++createCount}` });
    const openThread = () => {
      if (failOpen) throw new Error('URL handler unavailable');
    };

    await expect(coordinator.createAndOpen({
      projectKey: '/project', createConversation, openThread,
    })).rejects.toMatchObject({
      code: CODEX_FIRST_TURN_CREATED_OPEN_FAILED,
      reusedCreatedThread: false,
      message: expect.stringContaining('새 대화 없이 방금 대화를 다시 엽니다'),
    });
    failOpen = false;
    await expect(coordinator.createAndOpen({
      projectKey: '/project', createConversation, openThread,
    })).resolves.toEqual({ threadId: 'thread-1', reusedCreatedThread: true });
    expect(createCount).toBe(1);
  });

  test('retains the discovered thread before final verification can fail', async () => {
    const coordinator = new CodexFirstConversationLaunchCoordinator();
    let createCount = 0;
    let finalizeCount = 0;
    const createConversation = async () => ({ threadId: `thread-${++createCount}` });
    const finalizeConversation = async () => {
      finalizeCount += 1;
      if (finalizeCount === 1) throw new Error('turn still completing');
    };

    await expect(coordinator.createAndOpen({
      projectKey: '/project',
      createConversation,
      finalizeConversation,
      openThread: () => {},
    })).rejects.toThrow('turn still completing');
    await expect(coordinator.createAndOpen({
      projectKey: '/project',
      createConversation,
      finalizeConversation,
      openThread: () => {},
    })).resolves.toEqual({ threadId: 'thread-1', reusedCreatedThread: true });
    expect(createCount).toBe(1);
    expect(finalizeCount).toBe(2);
  });

  test('reuses a durably retained thread when the creator throws after dispatch', async () => {
    const store = new MemoryPendingStore();
    const threadId = '2c923dc0-2693-4c4f-8dd5-5c79da7ec10f';
    let createCount = 0;
    const createConversation = async (retainCreatedThread: (created: string) => void) => {
      createCount += 1;
      retainCreatedThread(threadId);
      throw new Error('project metadata still settling');
    };

    const firstCoordinator = new CodexFirstConversationLaunchCoordinator(store);
    await expect(firstCoordinator.createAndOpen({
      projectKey: '/project',
      createConversation,
      openThread: () => {},
    })).rejects.toThrow('project metadata still settling');
    expect(store.entries.get('/project')).toBe(threadId);

    const opened: string[] = [];
    const secondCoordinator = new CodexFirstConversationLaunchCoordinator(store);
    await expect(secondCoordinator.createAndOpen({
      projectKey: '/project',
      createConversation,
      verifyRecoveredConversation: async recovered => (
        recovered === threadId ? 'verified' : 'unavailable'
      ),
      openThread: recovered => opened.push(recovered),
    })).resolves.toEqual({ threadId, reusedCreatedThread: true });
    expect(createCount).toBe(1);
    expect(opened).toEqual([threadId]);
    expect(store.entries.size).toBe(0);
  });

  test('recovers and verifies the exact thread after a sidecar restart', async () => {
    const store = new MemoryPendingStore();
    const threadId = '2c923dc0-2693-4c4f-8dd5-5c79da7ec10f';
    let createCount = 0;
    const createConversation = async () => {
      createCount += 1;
      return { threadId };
    };
    const firstCoordinator = new CodexFirstConversationLaunchCoordinator(store);
    await expect(firstCoordinator.createAndOpen({
      projectKey: '/project',
      createConversation,
      finalizeConversation: async () => { throw new Error('sidecar stopping'); },
      openThread: () => {},
    })).rejects.toThrow('sidecar stopping');

    const opened: string[] = [];
    const secondCoordinator = new CodexFirstConversationLaunchCoordinator(store);
    await expect(secondCoordinator.createAndOpen({
      projectKey: '/project',
      createConversation,
      verifyRecoveredConversation: async recovered => (
        recovered === threadId ? 'verified' : 'unavailable'
      ),
      openThread: recovered => opened.push(recovered),
    })).resolves.toEqual({ threadId, reusedCreatedThread: true });
    expect(createCount).toBe(1);
    expect(opened).toEqual([threadId]);
    expect(store.entries.size).toBe(0);
  });

  test('refuses an unverified recovered thread instead of creating a duplicate', async () => {
    const store = new MemoryPendingStore();
    store.save('/project', '2c923dc0-2693-4c4f-8dd5-5c79da7ec10f');
    let createCount = 0;
    const coordinator = new CodexFirstConversationLaunchCoordinator(store);

    await expect(coordinator.createAndOpen({
      projectKey: '/project',
      createConversation: async () => ({ threadId: `thread-${++createCount}` }),
      verifyRecoveredConversation: async () => 'unavailable',
      openThread: () => {},
    })).rejects.toMatchObject({ code: CODEX_FIRST_TURN_RECOVERY_UNVERIFIED });
    expect(createCount).toBe(0);
  });

  test('clears a positively missing recovered thread before creating a replacement', async () => {
    const store = new MemoryPendingStore();
    store.save('/project', '2c923dc0-2693-4c4f-8dd5-5c79da7ec10f');
    let createCount = 0;
    const coordinator = new CodexFirstConversationLaunchCoordinator(store);

    await expect(coordinator.createAndOpen({
      projectKey: '/project',
      createConversation: async () => ({ threadId: `thread-${++createCount}` }),
      verifyRecoveredConversation: async () => 'missing',
      openThread: () => {},
    })).resolves.toEqual({ threadId: 'thread-1', reusedCreatedThread: false });
    expect(createCount).toBe(1);
    expect(store.entries.size).toBe(0);
  });

  test('coalesces concurrent presses for one project', async () => {
    const coordinator = new CodexFirstConversationLaunchCoordinator();
    let createCount = 0;
    const createConversation = async () => {
      createCount += 1;
      await Bun.sleep(5);
      return { threadId: 'thread-shared' };
    };
    const openThread = () => {};
    const first = coordinator.createAndOpen({ projectKey: '/project', createConversation, openThread });
    const second = coordinator.createAndOpen({ projectKey: '/project', createConversation, openThread });
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(createCount).toBe(1);
  });
});
