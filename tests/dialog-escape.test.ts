import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { isDialogDismissKey } from '../src/dialogEscape';

describe('dialog Escape dismissal', () => {
  test('plain Escape dismisses', () => {
    expect(isDialogDismissKey({ key: 'Escape', defaultPrevented: false, isComposing: false })).toBe(true);
  });
  test('Escape during IME composition only cancels the composition', () => {
    expect(isDialogDismissKey({ key: 'Escape', defaultPrevented: false, isComposing: true })).toBe(false);
    expect(isDialogDismissKey({ key: 'Escape', defaultPrevented: false, isComposing: false, keyCode: 229 })).toBe(false);
  });
  test('an Escape another handler consumed, or any other key, does not dismiss', () => {
    expect(isDialogDismissKey({ key: 'Escape', defaultPrevented: true, isComposing: false })).toBe(false);
    expect(isDialogDismissKey({ key: 'Enter', defaultPrevented: false, isComposing: false })).toBe(false);
  });
  test('the new-project dialog uses this rule', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const start = app.indexOf('if (!showNewProjectModal) return;');
    expect(start).toBeGreaterThan(-1);
    expect(app.slice(start, start + 400)).toContain('if (!isDialogDismissKey(event)) return;');
  });
});
