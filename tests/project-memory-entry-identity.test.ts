import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectProjectMemory,
  initializeProjectMemory,
  installIncomingProjectMemoryContent,
  markProjectMemoryRemembered,
  readMemoryDocument,
  recordProjectMemoryFeedback,
  upgradeProjectMemoryAgent,
  writeMemoryDocument,
} from '../project-memory-server';
import { parseProjectMemoryEntries } from '../src/projectMemoryRecall';
import { CURRENT_PROJECT_MEMORY_VERSION } from '../src/projectMemoryVersion';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempProject(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

// 버전 번호를 리터럴로 박으면 올바른 버전 업이 이 테스트를 빨갛게 만든다.
// 검사하려는 것은 "설치본에 현재 버전 마커가 박힌다"이지 "그 번호가 11이다"가 아니다.
test('the memory upgrade stamps the current version and stabilizes legacy entry identities exactly once', () => {
  const root = tempProject('memory-entry-upgrade-');
  const status = initializeProjectMemory({ folderPath: root, projectName: 'Identity demo', autoBackup: false });
  const memoryPath = join(root, status.config!.sourcePath);
  const agentInstructions = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  const rememberSkill = readFileSync(join(root, '.agents', 'skills', 'remember-session', 'SKILL.md'), 'utf8');
  expect(agentInstructions).toContain(`memory-agent-version:${CURRENT_PROJECT_MEMORY_VERSION}`);
  expect(agentInstructions).toContain('memory-entry-id');
  expect(agentInstructions).toContain('Never remove or regenerate');
  expect(rememberSkill).toContain('Never remove or regenerate an existing entry ID');
  writeFileSync(memoryPath, '# Project Core Memory\n\n## Key Decisions\n\n### Duplicate\nFirst.\n\n### Duplicate\nSecond.\n');

  const first = upgradeProjectMemoryAgent({ folderPath: root });
  const stabilized = readMemoryDocument(root, memoryPath);
  const entries = parseProjectMemoryEntries(stabilized);
  const backupDir = join(root, '.agent-memory', 'backups');
  const backupsAfterFirst = existsSync(backupDir) ? readdirSync(backupDir) : [];
  const rollbackBackups = backupsAfterFirst.filter(name => /^CORE-.*\.md$/.test(name));

  expect(first.entryIdsStabilized).toBe(true);
  expect(entries).toHaveLength(2);
  expect(entries.every(entry => entry.identitySource === 'explicit')).toBe(true);
  expect(new Set(entries.map(entry => entry.entryId)).size).toBe(2);
  expect(rollbackBackups).toHaveLength(1);
  expect(readFileSync(join(backupDir, rollbackBackups[0]!), 'utf8')).not.toContain('memory-entry-id');
  expect(readFileSync(join(backupDir, 'identity-last-good.md'), 'utf8')).toContain('memory-entry-id');

  const second = upgradeProjectMemoryAgent({ folderPath: root });
  expect(second.entryIdsStabilized).toBe(false);
  expect(readMemoryDocument(root, memoryPath)).toBe(stabilized);
  expect(readdirSync(backupDir)).toEqual(backupsAfterFirst);
});

test('incoming legacy content is backed up exactly, migrated before install, and never reports current while incomplete', () => {
  const root = tempProject('memory-entry-incoming-');
  const initialized = initializeProjectMemory({ folderPath: root, projectName: 'Remote legacy' });
  const memoryPath = join(root, initialized.config!.sourcePath);
  const legacy = '# Project Core Memory\n\n## Key Decisions\n\n### Remote legacy\nDurable remote fact.\n';
  writeFileSync(memoryPath, legacy);

  expect(detectProjectMemory(root).memoryAgent.updateAvailable).toBe(true);

  const migrated = installIncomingProjectMemoryContent({ root, memoryPath, content: legacy });
  expect(migrated.entryIdsMigrated).toBe(true);
  expect(migrated.migrationRequiredPush).toBe(true);
  expect(readFileSync(migrated.migrationBackupPath!, 'utf8')).toBe(legacy);
  expect(readMemoryDocument(root, memoryPath)).toMatch(/<!-- memory-entry-id:[0-9a-f]{24} -->/);
  expect(detectProjectMemory(root).memoryAgent.updateAvailable).toBe(false);

  const second = installIncomingProjectMemoryContent({
    root,
    memoryPath,
    content: readMemoryDocument(root, memoryPath),
  });
  expect(second.entryIdsMigrated).toBe(false);
  expect(second.migrationBackupPath).toBeNull();
});

test('incoming CRLF v11 content is treated as a byte migration with an exact rollback backup', () => {
  const root = tempProject('memory-entry-crlf-incoming-');
  const initialized = initializeProjectMemory({ folderPath: root, projectName: 'Remote CRLF' });
  const memoryPath = join(root, initialized.config!.sourcePath);
  const entryId = 'a'.repeat(24);
  const incoming = [
    '# Project Core Memory',
    '',
    '## Key Decisions',
    '',
    '### Existing v11 entry',
    `<!-- memory-entry-id:${entryId} -->`,
    'Durable remote fact.',
    '',
  ].join('\r\n');

  const migrated = installIncomingProjectMemoryContent({ root, memoryPath, content: incoming });
  expect(migrated.entryIdsMigrated).toBe(true);
  expect(migrated.migrationRequiredPush).toBe(true);
  expect(readFileSync(migrated.migrationBackupPath!, 'utf8')).toBe(incoming);
  expect(readMemoryDocument(root, memoryPath)).toBe(incoming.replace(/\r\n/g, '\n'));
});

test('server repair recovers a dropped ID after a title and section move from the last known-good document', () => {
  const root = tempProject('memory-entry-recovery-');
  const initialized = initializeProjectMemory({ folderPath: root, projectName: 'Identity recovery' });
  const memoryPath = join(root, initialized.config!.sourcePath);
  const entryId = 'd'.repeat(24);
  const previous = `# Project Core Memory\n\n## Key Decisions\n\n### Original title\n<!-- memory-entry-id:${entryId} -->\nDurable meaning.\n`;
  writeMemoryDocument(root, memoryPath, previous);

  // Simulate an external AI editing the source files directly and dropping only
  // the identity marker while it moves the still-identical durable statement.
  writeFileSync(memoryPath, '# Project Core Memory\n\n## Active Constraints\n\n### Renamed title\nDurable meaning.\n');

  const repaired = upgradeProjectMemoryAgent({ folderPath: root });
  const [entry] = parseProjectMemoryEntries(readMemoryDocument(root, memoryPath));
  expect(repaired.entryIdsStabilized).toBe(true);
  expect(entry?.entryId).toBe(entryId);
  expect(entry?.title).toBe('Renamed title');
  expect(entry?.section).toBe('Active Constraints');
});

test('ordinary AI update uses the last known-good identity document before replacing it', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'project-memory-server.ts'), 'utf8');
  const start = source.indexOf('export async function updateProjectMemory');
  const end = source.indexOf('\nfunction loadPortalConfig', start);
  const body = source.slice(start, end);

  expect(body).toContain('const previousIdentity = identityRecoverySnapshot(root)');
  expect(body).toContain('?? (hasCompleteProjectMemoryEntryIds(current) ? current : undefined)');
  expect(body).toContain('const candidate = targetedSection && targetedTitle');
  expect(body).toContain('replaceProjectMemorySection(');
  expect(body).toContain('stabilizeProjectMemoryEntryIds(candidate, previousIdentity)');
});

test('mark-remembered refreshes last-good identity after a direct remember-session edit', () => {
  const root = tempProject('memory-entry-direct-remember-');
  const initialized = initializeProjectMemory({ folderPath: root, projectName: 'Direct remember identity' });
  const memoryPath = join(root, initialized.config!.sourcePath);
  const directId = 'f'.repeat(24);
  const directEntry = `\n## Key Decisions\n\n### Added directly\n<!-- memory-entry-id:${directId} -->\nNew durable decision.\n`;
  writeFileSync(memoryPath, `${readMemoryDocument(root, memoryPath).trimEnd()}${directEntry}`);

  markProjectMemoryRemembered({ folderPath: root, narrative: 'direct remember edit' });
  const recoveryPath = join(root, '.agent-memory', 'backups', 'identity-last-good.md');
  expect(readFileSync(recoveryPath, 'utf8')).toContain(`memory-entry-id:${directId}`);

  writeFileSync(memoryPath, readMemoryDocument(root, memoryPath).replace(`<!-- memory-entry-id:${directId} -->\n`, ''));
  upgradeProjectMemoryAgent({ folderPath: root });
  const recovered = parseProjectMemoryEntries(readMemoryDocument(root, memoryPath))
    .find(entry => entry.title === 'Added directly');
  expect(recovered?.entryId).toBe(directId);
});

test('server rejects feedback recorded against a stale content version of the same logical entry', () => {
  const root = tempProject('memory-feedback-version-');
  const initialized = initializeProjectMemory({ folderPath: root, projectName: 'Feedback version' });
  const memoryPath = join(root, initialized.config!.sourcePath);
  const entryId = 'e'.repeat(24);
  writeMemoryDocument(root, memoryPath, `# Project Core Memory\n\n## Key Decisions\n\n### Stable rule\n<!-- memory-entry-id:${entryId} -->\nRequire review.\n`);
  const original = parseProjectMemoryEntries(readMemoryDocument(root, memoryPath))[0]!;

  const recorded = recordProjectMemoryFeedback({
    folderPath: root,
    entryKey: entryId,
    contentVersionHash: original.contentVersionHash,
    kind: 'confirmed',
  });
  expect(recorded.event.contentVersionHash).toBe(original.contentVersionHash);

  writeMemoryDocument(root, memoryPath, `# Project Core Memory\n\n## Key Decisions\n\n### Stable rule\n<!-- memory-entry-id:${entryId} -->\nSkip review.\n`);
  expect(() => recordProjectMemoryFeedback({
    folderPath: root,
    entryKey: entryId,
    contentVersionHash: original.contentVersionHash,
    kind: 'confirmed',
  })).toThrow(/본문 버전/);
});
