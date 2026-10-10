import {expect, test} from 'bun:test';
import {textConversationTargets} from '../src/conversationTargetDirectory';
import {resolveProjectRoles} from '../src/projectRole';
import {isSameFolderPath} from '../src/projectCreationLeftover';
import {cachedPythonResolver} from '../src/pythonExecutable';

// Review findings from merging the Windows branch into main (2026-10-08).

test('the conversation directory and the sidebar give a clone named after the repository the same role', () => {
  const row = {id: 'clone', name: 'AgentsToZ_byCS-win', folderPath: '/Users/x/AgentsToZ_byCS-win', githubUrl: 'https://github.com/example-owner/AgentsToZ_byCS'};
  const sidebar = resolveProjectRoles([row]).get('clone');
  const directory = textConversationTargets([row], {available: new Set(['clone'])}).find(entry => entry.id === 'clone')?.role;
  expect(sidebar).toBe('dev');
  expect(directory).toBe(sidebar);
});

test('folder identity ignores case only where the file system does', () => {
  expect(isSameFolderPath('/Users/x/Foo', '/Users/x/foo', 'darwin')).toBe(true);
  expect(isSameFolderPath('C:\\Work\\Foo', 'c:\\work\\foo\\', 'win32')).toBe(true);
  // Linux is case-sensitive: a stale record for `Foo` must not let the app move the user's own `foo` aside.
  expect(isSameFolderPath('/home/x/Foo', '/home/x/foo', 'linux')).toBe(false);
  expect(isSameFolderPath('/home/x/foo/', '/home/x/foo', 'linux')).toBe(true);
});

test('a Python that is not there is looked for again later; a found one is kept', () => {
  let now = 0, calls = 0, answer: string | null = null;
  const resolve = cachedPythonResolver(() => { calls += 1; return answer; }, () => now);
  expect(resolve()).toBe(null);
  expect(resolve()).toBe(null);
  expect(calls).toBe(1);
  now += 61_000;
  answer = '/usr/bin/python3';
  expect(resolve()).toBe('/usr/bin/python3');
  now += 10_000_000;
  expect(resolve()).toBe('/usr/bin/python3');
  expect(calls).toBe(2);
});
