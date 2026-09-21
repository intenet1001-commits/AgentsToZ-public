import { expect, test } from 'bun:test';
import { resolvePrimaryProject } from '../src/primaryProject';

const repository = 'https://github.com/example/AgentsToZ-public';
const publicClone = { id: 'public', folderPath: '/projects/AgentsToZ-public', githubUrl: repository };
const development = { id: 'development', folderPath: '/projects/AgentsToZ_byCS' };

test('a public clone listed first does not replace the development shortcut', () => {
  expect(resolvePrimaryProject([publicClone, development], repository)).toBe(development);
  expect(resolvePrimaryProject([development, publicClone], repository)).toBe(development);
});

test('Windows and trailing separators still identify the development root', () => {
  const windows = { ...development, folderPath: 'C:\\projects\\AgentsToZ_byCS\\' };
  expect(resolvePrimaryProject([publicClone, windows], repository)).toBe(windows);
});

test('public-only installs retain a shortcut through normalized repository metadata', () => {
  const renamed = { id: 'renamed', folderPath: '/projects/custom-name', githubUrls: [repository + '.git'] };
  expect(resolvePrimaryProject([renamed], repository)).toBe(renamed);
  expect(resolvePrimaryProject([{ folderPath: '/projects/unrelated' }], repository)).toBeNull();
  expect(resolvePrimaryProject([{}], '')).toBeNull();
});
