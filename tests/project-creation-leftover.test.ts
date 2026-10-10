import { expect, test } from 'bun:test';
import {
  CREATION_ATTEMPT_DIRECTORY,
  canReclaimCreationLeftover,
  creationAttempt,
  creationAttemptFileName,
  creationFolderExistsMessage,
  findCreationAttempt,
  isSameFolderPath,
  parseCreationAttempt,
} from '../src/projectCreationLeftover';

const ID = '81511366-4512-4ff1-bfe8-0c0aa78163f3';
const FOLDER = 'D:\\work\\AgentsToZ-OPS';
const record = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ ...creationAttempt(ID, FOLDER), ...overrides });

test('an attempt record round-trips', () => {
  const attempt = parseCreationAttempt(record());
  expect(attempt).not.toBeNull();
  expect(attempt!.projectId).toBe(ID);
  expect(attempt!.folderPath).toBe(FOLDER);
});

test('the record lives in app data, never inside the project folder', () => {
  // A marker file inside the folder was committed by the initial snapshot and
  // then deleted, leaving a brand-new repository dirty (`D .agentstoz-creating.json`).
  expect(CREATION_ATTEMPT_DIRECTORY).toBe('project-creation');
  expect(CREATION_ATTEMPT_DIRECTORY.includes('/')).toBe(false);
  expect(CREATION_ATTEMPT_DIRECTORY.includes('\\')).toBe(false);
});

test('the file name comes from the project UUID and nothing else', () => {
  expect(creationAttemptFileName(ID)).toBe(`${ID}.json`);
  // A non-UUID would be a path-injection surface in a file name.
  for (const bad of ['', 'a/b', '..', 'x'.repeat(80), 'not-a-uuid']) {
    expect(() => creationAttemptFileName(bad)).toThrow();
  }
});

test('anything malformed is absent, never a licence to move a folder', () => {
  for (const raw of [
    null, undefined, 42, '', '{', '[]', 'null', '"text"',
    JSON.stringify({}),
    record({ schemaVersion: 2 }),
    record({ projectId: 'not-a-uuid' }),
    record({ folderPath: '' }),
    record({ startedAt: 'yesterday' }),
    // An extra field means something else wrote it.
    record({ extra: true }),
    'x'.repeat(8192),
  ]) {
    expect(parseCreationAttempt(raw as never)).toBeNull();
  }
});

test('the same folder is recognized across separator and case differences', () => {
  expect(isSameFolderPath('D:\\work\\AgentsToZ-OPS', 'd:\\WORK\\AgentsToZ-OPS\\')).toBe(true);
  expect(isSameFolderPath('/Users/x/ops', '/Users/x/ops/')).toBe(true);
  expect(isSameFolderPath('/Users/x/ops', '/Users/x/ops-backup')).toBe(false);
});

test('only the record naming this folder is found', () => {
  const records = [null, 'garbage', record({ folderPath: 'D:\\work\\other' }), record()];
  expect(findCreationAttempt(records, FOLDER)?.projectId).toBe(ID);
  expect(findCreationAttempt(records, 'D:\\work\\unrelated')).toBeNull();
  expect(findCreationAttempt([], FOLDER)).toBeNull();
});

test('a folder with no record is never reclaimed', () => {
  // The dead end was annoying; deleting a user folder of the same name would be
  // far worse, so the record is mandatory.
  expect(canReclaimCreationLeftover({
    attempt: null, registeredProjectIds: [], registeredFolderPaths: [], folderPath: FOLDER,
  })).toBe(false);
});

test('a leftover from a failed attempt is reclaimable', () => {
  expect(canReclaimCreationLeftover({
    attempt: parseCreationAttempt(record()),
    registeredProjectIds: ['other-id'],
    registeredFolderPaths: ['D:\\work\\something-else'],
    folderPath: FOLDER,
  })).toBe(true);
});

test('a registered project is never reclaimed, by id or by path', () => {
  // Registration is the commit point: the project list already references it.
  expect(canReclaimCreationLeftover({
    attempt: parseCreationAttempt(record()),
    registeredProjectIds: [ID], registeredFolderPaths: [], folderPath: FOLDER,
  })).toBe(false);

  // A stale record plus a different id must still be refused when the path is live.
  expect(canReclaimCreationLeftover({
    attempt: parseCreationAttempt(record()),
    registeredProjectIds: ['other-id'],
    registeredFolderPaths: ['d:\\WORK\\AgentsToZ-OPS\\'],
    folderPath: FOLDER,
  })).toBe(false);
});

test('the blocked message names the folder and says what to do', () => {
  // The old text named no path, so the user had nothing to act on.
  const reclaimable = creationFolderExistsMessage(FOLDER, true);
  expect(reclaimable).toContain(FOLDER);
  expect(reclaimable).toMatch(/닫은 뒤 다시 시도/);

  const foreign = creationFolderExistsMessage(FOLDER, false);
  expect(foreign).toContain(FOLDER);
  expect(foreign).toMatch(/이미 있습니다/);
});
