import { expect, test } from 'bun:test';
import {
  isTasklistImageName,
  isWindowsImageRunning,
  tasklistImageMatchCount,
  tasklistImageQueryArgs,
} from '../src/windowsTasklist';
import { codexTuiSurfacePresence } from '../src/codexProcessPresence';

/** Measured shapes from tasklist on Windows 11 26100. */
const PRESENT = '"bun.exe","42448","Console","2","882,172 K"\r\n';
const ABSENT = 'INFO: No tasks are running which match the specified criteria.\r\n';

test('the query filters by image name and drops the header row', () => {
  const args = tasklistImageQueryArgs('codex.exe');
  expect(args).toContain('/FI');
  expect(args[args.indexOf('/FI') + 1]).toBe('IMAGENAME eq codex.exe');
  expect(args).toContain('/FO');
  expect(args[args.indexOf('/FO') + 1]).toBe('CSV');
  // Without /NH the header row would be counted as a process.
  expect(args).toContain('/NH');
});

test('a corrupted image name is refused instead of reaching tasklist', () => {
  for (const image of ['', 'codex', 'codex.exe ', 'a b.exe', '..\\evil.exe', 'x.exe;calc', 'x'.repeat(80) + '.exe']) {
    expect(isTasklistImageName(image)).toBe(false);
    expect(() => tasklistImageQueryArgs(image)).toThrow();
    expect(tasklistImageMatchCount(PRESENT, image)).toBe(0);
  }
  expect(isTasklistImageName('codex.exe')).toBe(true);
  expect(isTasklistImageName('CODEX.EXE')).toBe(true);
});

test('only quoted CSV rows for the asked image are counted', () => {
  expect(tasklistImageMatchCount(PRESENT, 'bun.exe')).toBe(1);
  expect(tasklistImageMatchCount(PRESENT + PRESENT, 'bun.exe')).toBe(2);
  // A different image must not match even though the row is well formed.
  expect(tasklistImageMatchCount(PRESENT, 'codex.exe')).toBe(0);
  expect(tasklistImageMatchCount('"CODEX.EXE","1","Console","2","1 K"', 'codex.exe')).toBe(1);
});

test('the no-match sentence never counts, in any language', () => {
  expect(tasklistImageMatchCount(ABSENT, 'codex.exe')).toBe(0);
  // tasklist exits 0 for a no-match, and a localized Windows may translate the
  // sentence, so nothing about it may be parsed.
  for (const localized of [
    'INFO: 지정한 조건에 맞는 작업이 실행되고 있지 않습니다.',
    'INFORMATION : aucune tâche en cours ne correspond.',
    'codex.exe steht nicht in der Liste',
  ]) {
    expect(tasklistImageMatchCount(localized, 'codex.exe')).toBe(0);
  }
});

test('an unreadable listing is not an absence', () => {
  // A denial reported as `false` would call a live process gone.
  expect(isWindowsImageRunning(null, 'codex.exe')).toBeNull();
  expect(isWindowsImageRunning(undefined, 'codex.exe')).toBeNull();
  expect(isWindowsImageRunning(ABSENT, 'codex.exe')).toBe(false);
  expect(isWindowsImageRunning(PRESENT, 'bun.exe')).toBe(true);
  // A runaway listing is bounded rather than scanned in full.
  expect(tasklistImageMatchCount('"bun.exe","1"\n'.repeat(200_000), 'bun.exe')).toBe(0);
});

test('only the conclusive direction changes a session row', () => {
  // No codex.exe at all is the one claim Windows can make, and it is the one
  // that clears a finished session.
  expect(codexTuiSurfacePresence('stopped')).toBe('gone');
  // A match may be a helper process (app-server, code-mode-host, mcp-server all
  // run as codex.exe), so the row must be left alone -- not hidden.
  expect(codexTuiSurfacePresence('unverified')).toBe('not-applicable');
  expect(codexTuiSurfacePresence('running')).toBe('not-applicable');
});
