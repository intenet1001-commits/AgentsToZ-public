import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

describe('app root background', () => {
  test('html and body are painted, so scrolled-past areas are not white', () => {
    // The dark ground came from a React container sized to its content. Any
    // area the webview drew outside it fell through to the browser default:
    // scrolling 「내가 한 말」 to the end left the bottom of the window solid
    // white (reproduced on the installed v332 build, and photographed by the
    // user on v331). Painting the root elements is what closes that gap.
    const rule = css.slice(css.indexOf('html,\nbody {'), css.indexOf('html,\nbody {') + 200);
    expect(rule).toContain('background-color: var(--bg-base)');
    expect(rule).toContain('color-scheme: dark');
    // The token must exist, or the rule silently paints nothing.
    expect(css).toMatch(/--bg-base:\s*#[0-9a-fA-F]{6};/);
  });
});
