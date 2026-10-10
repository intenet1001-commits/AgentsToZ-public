import { expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUIDE_CONTENT } from '../src/guide/guideContent';

// See ui-glossary.test.ts: .pathname yields "/D:/..." on Windows.
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
function files(dir = SRC): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : /\.tsx?$/.test(name) ? [full] : [];
  });
}

test('every static data-help-key has a guide entry (no «버튼이에요» fallback)', () => {
  const keys = new Set(files().flatMap(file =>
    [...readFileSync(file, 'utf8').matchAll(/data-help-key="([^"]+)"/g)].map(match => match[1]!)));
  const missing = [...keys].filter(key => !GUIDE_CONTENT[key]).sort();
  expect(missing).toEqual([]);
});

test('guide copy matches the current UI', () => {
  // Folder bookmarks moved to the 프로젝트·폴더 tab; bookmarks are URL-only.
  expect(GUIDE_CONTENT['tab-portal']!.body).not.toContain('폴더');
  // The redesigned project list has no «빈 카드».
  expect(GUIDE_CONTENT['tab-ports']!.tip ?? '').not.toContain('빈 카드');
});

test('guide mode is session-only, like VOC mode', () => {
  const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');
  // Persisted guide mode reopened the app with every click intercepted.
  expect(app).not.toContain("localStorage.setItem('pm-guide-mode'");
  expect(app).not.toContain("localStorage.getItem('pm-guide-mode')");
});
