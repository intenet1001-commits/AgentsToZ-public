import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { CodexFirstConversationPendingStore } from './codexFirstConversationLaunch';

const SCHEMA_VERSION = 1 as const;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_ENTRIES = 128;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;

interface PendingEntry {
  threadId: string;
  createdAt: string;
}

interface PendingRegistry {
  schemaVersion: typeof SCHEMA_VERSION;
  entries: Record<string, PendingEntry>;
}

export class CodexFirstConversationPendingStoreError extends Error {
  readonly code = 'CODEX_FIRST_TURN_RECOVERY_STORE_FAILED' as const;

  constructor() {
    super('이전에 만든 Codex 대화의 안전한 재시도 정보를 확인하거나 저장하지 못했습니다. 새 대화를 중복 생성하지 않도록 실행을 중단했습니다.');
    this.name = 'CodexFirstConversationPendingStoreError';
  }
}

function projectFingerprint(projectKey: string): string {
  return createHash('sha256').update(projectKey, 'utf8').digest('hex');
}

function emptyRegistry(): PendingRegistry {
  return { schemaVersion: SCHEMA_VERSION, entries: {} };
}

function normalizeRegistry(value: unknown): PendingRegistry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CodexFirstConversationPendingStoreError();
  }
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== SCHEMA_VERSION
    || !raw.entries || typeof raw.entries !== 'object' || Array.isArray(raw.entries)) {
    throw new CodexFirstConversationPendingStoreError();
  }
  const entries = Object.entries(raw.entries as Record<string, unknown>);
  if (entries.length > MAX_ENTRIES) throw new CodexFirstConversationPendingStoreError();
  const normalized: Record<string, PendingEntry> = {};
  for (const [key, value] of entries) {
    if (!HASH_RE.test(key) || !value || typeof value !== 'object' || Array.isArray(value)) {
      throw new CodexFirstConversationPendingStoreError();
    }
    const entry = value as Record<string, unknown>;
    if (Object.keys(entry).length !== 2
      || !UUID_RE.test(String(entry.threadId ?? ''))
      || typeof entry.createdAt !== 'string'
      || !Number.isFinite(Date.parse(entry.createdAt))) {
      throw new CodexFirstConversationPendingStoreError();
    }
    normalized[key] = {
      threadId: String(entry.threadId),
      createdAt: new Date(Date.parse(entry.createdAt)).toISOString(),
    };
  }
  return { schemaVersion: SCHEMA_VERSION, entries: normalized };
}

/**
 * Stores no project path or prompt: only a SHA-256 project fingerprint and the
 * already public-shaped thread UUID. The fixed app-data file is mode 0600 and
 * every replacement is atomic.
 */
export class FileCodexFirstConversationPendingStore implements CodexFirstConversationPendingStore {
  readonly #directory: string;
  readonly #file: string;

  constructor(appDataDir: string) {
    this.#directory = join(appDataDir, 'remote-control');
    this.#file = join(this.#directory, 'codex-first-conversation-pending.json');
  }

  load(projectKey: string): string | null {
    return this.#read().entries[projectFingerprint(projectKey)]?.threadId ?? null;
  }

  save(projectKey: string, threadId: string): void {
    if (!UUID_RE.test(threadId)) throw new CodexFirstConversationPendingStoreError();
    const registry = this.#read();
    const key = projectFingerprint(projectKey);
    if (!registry.entries[key] && Object.keys(registry.entries).length >= MAX_ENTRIES) {
      // Uncertain submissions are safety fences, never an LRU cache.
      throw new CodexFirstConversationPendingStoreError();
    }
    registry.entries[key] = {
      threadId,
      createdAt: new Date().toISOString(),
    };
    this.#write(registry);
  }

  clear(projectKey: string): void {
    const registry = this.#read();
    const key = projectFingerprint(projectKey);
    if (!registry.entries[key]) return;
    delete registry.entries[key];
    this.#write(registry);
  }

  #read(): PendingRegistry {
    try {
      const stat = lstatSync(this.#file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) {
        throw new CodexFirstConversationPendingStoreError();
      }
      return normalizeRegistry(JSON.parse(readFileSync(this.#file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return emptyRegistry();
      if (error instanceof CodexFirstConversationPendingStoreError) throw error;
      throw new CodexFirstConversationPendingStoreError();
    }
  }

  #write(registry: PendingRegistry): void {
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    chmodSync(this.#directory, 0o700);
    const temporary = `${this.#file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      renameSync(temporary, this.#file);
      chmodSync(this.#file, 0o600);
    } catch {
      try { unlinkSync(temporary); } catch { /* best-effort temp cleanup */ }
      throw new CodexFirstConversationPendingStoreError();
    }
  }
}
