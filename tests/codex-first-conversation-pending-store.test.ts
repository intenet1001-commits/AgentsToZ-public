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
