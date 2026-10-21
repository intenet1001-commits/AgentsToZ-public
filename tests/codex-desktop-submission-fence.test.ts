import { expect, test } from 'bun:test';
import { submitCodexDesktopDraft } from '../src/codexDesktopSubmissionFence';

function fixture() {
  const pending = new Map<string, string>();
  return {
    load: (key: string) => pending.get(key) ?? null,
    save: (key: string, id: string) => { pending.set(key, id); },
    clear: (key: string) => { pending.delete(key); },
  };
}

test('a selected-project draft without a prior ID is fenced before submit and retained after persistence', async () => {
  const store = fixture();
  const events: string[] = [];
  const result = await submitCodexDesktopDraft({
    store, projectKey: '/project',
    submit: async () => { expect(store.load('/project')).not.toBeNull(); events.push('submit'); return { ok: true }; },
    findCreatedThread: async () => { events.push('persist'); return 'new-thread'; },
    retainCreatedThread: id => { expect(store.load('/project')).not.toBeNull(); events.push(`retain:${id}`); },
  });
  expect(result.threadId).toBe('new-thread');
  expect(events).toEqual(['submit', 'persist', 'retain:new-thread']);
  expect(store.load('/project')).toBeNull();
});

test('an unknown persisted result does not send the prompt a second time', async () => {
  const store = fixture();
  let submissions = 0;
  const input = {
    store, projectKey: '/project',
    submit: async () => { submissions++; return { ok: true as const }; },
    findCreatedThread: async () => null,
    retainCreatedThread: () => {},
  };
  await expect(submitCodexDesktopDraft(input)).rejects.toMatchObject({ code: 'CODEX_THREAD_PERSISTENCE_TIMEOUT' });
  await expect(submitCodexDesktopDraft(input)).rejects.toMatchObject({ code: 'CODEX_DESKTOP_SUBMISSION_UNCERTAIN' });
  expect(submissions).toBe(1);
});

test('a proven pre-submit permission denial can be retried after permission is fixed', async () => {
  const store = fixture();
  await expect(submitCodexDesktopDraft({
    store, projectKey: '/project',
    submit: async () => ({ ok: false, code: 'CODEX_DESKTOP_AUTOMATION_PERMISSION_DENIED', error: 'denied' }),
    findCreatedThread: async () => { throw new Error('must not run'); },
    retainCreatedThread: () => {},
  })).rejects.toMatchObject({ code: 'CODEX_DESKTOP_AUTOMATION_PERMISSION_DENIED' });
  expect(store.load('/project')).toBeNull();
});

test('an automation timeout keeps the fence even without a thread ID', async () => {
  const store = fixture();
  await expect(submitCodexDesktopDraft({
    store, projectKey: '/project',
    submit: async () => ({ ok: false, code: 'CODEX_DESKTOP_SUBMISSION_UNCERTAIN', error: 'timeout' }),
    findCreatedThread: async () => null,
    retainCreatedThread: () => {},
  })).rejects.toMatchObject({ code: 'CODEX_DESKTOP_SUBMISSION_UNCERTAIN' });
  expect(store.load('/project')).not.toBeNull();
});
