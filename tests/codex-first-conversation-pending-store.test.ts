import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodexFirstConversationPendingStoreError,
  FileCodexFirstConversationPendingStore,
} from '../src/codexFirstConversationPendingStore';

const THREAD_ID = '2c923dc0-2693-4c4f-8dd5-5c79da7ec10f';

describe('Codex first-conversation pending store', () => {
  test('capacity refuses new receipts without evicting uncertain first conversations', () => {
    const appDataDir = mkdtempSync(join(tmpdir(), 'agentstoz-codex-pending-'));
    try {
      const store = new FileCodexFirstConversationPendingStore(appDataDir);
      for (let index = 0; index < 128; index++) store.save(`project-${index}`, THREAD_ID);
      expect(() => store.save('project-overflow', THREAD_ID)).toThrow(CodexFirstConversationPendingStoreError);
      expect(store.load('project-0')).toBe(THREAD_ID);
      store.save('project-0', THREAD_ID);
      store.clear('project-127');
      store.save('project-overflow', THREAD_ID);
      expect(store.load('project-overflow')).toBe(THREAD_ID);
    } finally { rmSync(appDataDir, {recursive: true, force: true}); }
  });
  test('atomically retains only a project fingerprint and thread id with private permissions', () => {
    const appDataDir = mkdtempSync(join(tmpdir(), 'agentstoz-codex-pending-'));
    try {
      const projectKey = '/private/projects/customer-secret';
      const store = new FileCodexFirstConversationPendingStore(appDataDir);
      store.save(projectKey, THREAD_ID);

      const file = join(appDataDir, 'remote-control', 'codex-first-conversation-pending.json');
      const serialized = readFileSync(file, 'utf8');
      expect(serialized).not.toContain(projectKey);
      expect(serialized).not.toContain('AgentsToZ 원격 연결');
      expect(serialized).toContain(createHash('sha256').update(projectKey).digest('hex'));
      expect(serialized).toContain(THREAD_ID);
      expect(lstatSync(file).mode & 0o077).toBe(0);
      expect(store.load(projectKey)).toBe(THREAD_ID);

      store.clear(projectKey);
      expect(store.load(projectKey)).toBeNull();
    } finally {
      rmSync(appDataDir, { recursive: true, force: true });
    }
  });

  test('rejects a symlinked recovery file instead of following it', () => {
    const appDataDir = mkdtempSync(join(tmpdir(), 'agentstoz-codex-pending-'));
    try {
      const remoteControlDir = join(appDataDir, 'remote-control');
      const target = join(appDataDir, 'target.json');
      writeFileSync(target, '{"schemaVersion":1,"entries":{}}');
      mkdirSync(remoteControlDir, { recursive: true });
      symlinkSync(target, join(remoteControlDir, 'codex-first-conversation-pending.json'));
      const store = new FileCodexFirstConversationPendingStore(appDataDir);
      expect(() => store.load('/project')).toThrow(CodexFirstConversationPendingStoreError);
    } finally {
      rmSync(appDataDir, { recursive: true, force: true });
    }
  });
});
