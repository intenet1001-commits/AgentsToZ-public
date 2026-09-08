import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEMORY_DOCUMENT_PENDING, memoryDocumentRecoveryStatus, recoverMemoryDocumentTransaction,
  writeMemoryDocumentTransaction, type MemoryDocumentContext } from '../src/memoryDocumentTransaction';
import { detectProjectMemory, markProjectMemoryRemembered, readMemoryDocument, recoverProjectMemoryDocument,
  writeMemoryDocument } from '../project-memory-server';
import { canCreateFileSymlinks } from './fs-test-capabilities';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'document-recovery-')));
  mkdirSync(join(root, '.agent-memory/notes'), { recursive: true });
  writeFileSync(join(root, '.agent-memory/config.json'), JSON.stringify({ schemaVersion: 1, memoryId: 'memory-1', sourcePath: '.agent-memory/CORE.md', agent: 'codex' }));
  writeFileSync(join(root, '.agent-memory/CORE.md'), '# Project Core Memory\nBefore\n');
  writeFileSync(join(root, '.agent-memory/notes/old.md'), 'old note');
  const context: MemoryDocumentContext = { root, memoryId: 'memory-1', primaryPath: '.agent-memory/CORE.md', safePath: path => join(root, path) };
  const changes = [
    { path: '.agent-memory/notes/new.md', content: 'new note' },
    { path: '.agent-memory/notes/old.md', content: null },
    { path: '.agent-memory/CORE.md', content: '# Project Core Memory\nAfter\n' },
  ];
  return { root, context, changes, clean: () => rmSync(root, { recursive: true, force: true }) };
}

for (const interruption of [0, 1, 2]) {
  test(`recovery completes a real multi-file interruption after file ${interruption} without AI`, () => {
    const f = fixture();
    try {
      expect(() => writeMemoryDocumentTransaction(f.context, f.changes, { afterFile: index => {
        if (index === interruption) throw new Error('simulated process interruption');
      } })).toThrow('interruption');
      const status = detectProjectMemory(f.root);
      expect(status.documentRecovery?.state).toBe('ready');
      expect(status.contentHash).toBeNull();
      expect(() => readMemoryDocument(f.root, join(f.root, '.agent-memory/CORE.md'))).toThrow('복구');
      expect(() => writeMemoryDocument(f.root, join(f.root, '.agent-memory/CORE.md'), '# Project Core Memory\nOther')).toThrow('복구');
      expect(() => markProjectMemoryRemembered({ folderPath: f.root })).toThrow('복구');
      const result = recoverProjectMemoryDocument({ folderPath: f.root, transactionId: status.documentRecovery!.transactionId! });
      expect(result).toEqual({ success: true, documentRecovered: true, sessionCompletionVerified: false });
      expect(readFileSync(join(f.root, '.agent-memory/notes/new.md'), 'utf8')).toBe('new note');
      expect(existsSync(join(f.root, '.agent-memory/notes/old.md'))).toBe(false);
      expect(readMemoryDocument(f.root, join(f.root, '.agent-memory/CORE.md'))).toBe('# Project Core Memory\nAfter\n');
      expect(existsSync(join(f.root, MEMORY_DOCUMENT_PENDING))).toBe(false);
    } finally { f.clean(); }
  });
}

test('external edits cause conflict without touching any remaining file or deleting evidence', () => {
  const f = fixture();
  try {
    expect(() => writeMemoryDocumentTransaction(f.context, f.changes, { afterFile: () => { throw new Error('stop'); } })).toThrow();
    writeFileSync(join(f.root, '.agent-memory/CORE.md'), 'new external edit');
    const status = memoryDocumentRecoveryStatus(f.context);
    expect(status.state).toBe('conflict');
    expect(() => recoverProjectMemoryDocument({ folderPath: f.root, transactionId: status.transactionId! })).toThrow('다른 수정');
    expect(readFileSync(join(f.root, '.agent-memory/CORE.md'), 'utf8')).toBe('new external edit');
    expect(existsSync(join(f.root, '.agent-memory/notes/old.md'))).toBe(true);
    expect(existsSync(join(f.root, MEMORY_DOCUMENT_PENDING))).toBe(true);
  } finally { f.clean(); }
});

test('an abruptly exited writer leaves a durable manifest recoverable by another process', async () => {
  const f = fixture();
  try {
    const script = join(f.root, 'interrupted.ts');
    writeFileSync(script, `
      import {join} from 'node:path';
      import {writeMemoryDocumentTransaction} from ${JSON.stringify(join(import.meta.dir, '../src/memoryDocumentTransaction.ts'))};
      const root=process.argv[2];
      writeMemoryDocumentTransaction({root,memoryId:'memory-1',primaryPath:'.agent-memory/CORE.md',safePath:p=>join(root,p)},
        ${JSON.stringify(f.changes)}, {afterFile(){process.exit(97);}});
    `);
    const child = Bun.spawn([process.execPath, script, f.root], { stdout: 'ignore', stderr: 'pipe' });
    expect(await child.exited).toBe(97);
    const status = detectProjectMemory(f.root).documentRecovery!;
    expect(status.state).toBe('ready');
    expect(status.appliedFiles).toBe(1);
    recoverProjectMemoryDocument({ folderPath: f.root, transactionId: status.transactionId! });
    expect(readFileSync(join(f.root, '.agent-memory/CORE.md'), 'utf8')).toContain('After');
  } finally { f.clean(); }
});

test('a stale transaction ID and changed memory identity cannot authorize recovery', () => {
  const f = fixture();
  try {
    expect(() => writeMemoryDocumentTransaction(f.context, f.changes, { afterFile: () => { throw new Error('stop'); } })).toThrow();
    expect(() => recoverMemoryDocumentTransaction(f.context, 'stale')).toThrow('대상이 변경');
    expect(memoryDocumentRecoveryStatus({ ...f.context, memoryId: 'another-memory' }).state).toBe('invalid');
    expect(() => recoverMemoryDocumentTransaction({ ...f.context, memoryId: 'another-memory' }, memoryDocumentRecoveryStatus(f.context).transactionId!)).toThrow();
    expect(existsSync(join(f.root, '.agent-memory/notes/old.md'))).toBe(true);
  } finally { f.clean(); }
});

test('malformed/future manifests and oversized proposals preserve original files', () => {
  const f = fixture();
  try {
    expect(() => writeMemoryDocumentTransaction(f.context, [{ path: '.agent-memory/CORE.md', content: 'x'.repeat(2 * 1024 * 1024 + 1) }])).toThrow();
    expect(existsSync(join(f.root, MEMORY_DOCUMENT_PENDING))).toBe(false);
    mkdirSync(join(f.root, '.agent-memory/backups'), { recursive: true });
    for (const content of ['{truncated', '{"version":999}']) {
      writeFileSync(join(f.root, MEMORY_DOCUMENT_PENDING), content);
      expect(detectProjectMemory(f.root).documentRecovery?.state).toBe('invalid');
      expect(() => writeMemoryDocument(f.root, join(f.root, '.agent-memory/CORE.md'), '# Project Core Memory\nOverwrite')).toThrow();
      expect(readFileSync(join(f.root, '.agent-memory/CORE.md'), 'utf8')).toContain('Before');
    }
  } finally { f.clean(); }
});

(canCreateFileSymlinks ? test : test.skip)('a substituted note symlink cannot write outside the project during recovery', () => {
  const f = fixture();
  const external = realpathSync(mkdtempSync(join(tmpdir(), 'document-outside-')));
  try {
    expect(() => writeMemoryDocumentTransaction(f.context, f.changes, { afterFile: () => { throw new Error('stop'); } })).toThrow();
    const id = memoryDocumentRecoveryStatus(f.context).transactionId!;
    writeFileSync(join(external, 'outside.md'), 'outside');
    rmSync(join(f.root, '.agent-memory/notes/old.md'));
    symlinkSync(join(external, 'outside.md'), join(f.root, '.agent-memory/notes/old.md'));
    expect(() => recoverProjectMemoryDocument({ folderPath: f.root, transactionId: id })).toThrow();
    expect(readFileSync(join(external, 'outside.md'), 'utf8')).toBe('outside');
  } finally { f.clean(); rmSync(external, { recursive: true, force: true }); }
});
