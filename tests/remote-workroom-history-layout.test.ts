import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RemoteWorkroomHistoryPanel } from '../src/RemoteWorkroomHistoryPanel';

/**
 * The phone portal mounts the Workroom history BESIDE .ai-terminal-panel, so `.ai-terminal-panel …` rules never reach it.
 * Unstyled, its project select took its widest option's width and the page scrolled sideways on an iPhone 13 Pro Max
 * (2026-10-16), and 「불러오기」 was a ~45×19pt target. The real measurement is tests/remote-workroom-history-layout.e2e.mjs
 * (Chromium + WebKit, not part of `bun test`); this keeps the rules it depends on from silently disappearing.
 */
const css = readFileSync(join(import.meta.dir, '../src/AiTerminalPanel.css'), 'utf8');
const portalCss = readFileSync(join(import.meta.dir, '../src/remote-control-portal.css'), 'utf8');
const source = readFileSync(join(import.meta.dir, '../src/RemoteWorkroomHistoryPanel.tsx'), 'utf8');
/** Every declaration block whose selector list contains `needle` (top level or inside a media block). */
const blocks = (sheet: string, needle: string) => [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, selector]) => (selector ?? "").includes(needle)).map(([, selector, body]) => ({ selector: (selector ?? "").trim(), body: body ?? "" }));

describe('phone Workroom history layout contract', () => {
  test('the history root carries the panel tokens itself', () => {
    const tokens = blocks(css, '').find(b => b.body.includes('--at-surface:') && b.body.includes('--at-line:'));
    expect(tokens?.selector).toContain('.ai-terminal-history');
  });

  test('the shared select rule reaches the history and clips instead of widening the page', () => {
    const select = blocks(css, '.ai-terminal-history) .ai-terminal-select').find(b => b.body.includes('appearance: none'));
    expect(select?.body).toContain('max-width: 100%');
    expect(select?.body).toContain('min-width: 0');
    expect(select?.body).toContain('overflow: hidden');
    expect(blocks(css, '.ai-terminal-history .ai-terminal-select').some(b => b.body.includes('width: 100%'))).toBe(true);
    const controls = blocks(css, '.ai-terminal-history-controls').find(b => b.body.includes('grid-template-columns'));
    expect(controls?.body).toContain('minmax(0, 1fr)');
  });

  test('buttons are the panel buttons, 44px on a phone width or a coarse pointer', () => {
    expect(blocks(css, '.ai-terminal-history) .ai-terminal-btn').some(b => b.body.includes('border-radius: 8px'))).toBe(true);
    const start = css.indexOf('@media (max-width: 640px), (pointer: coarse) {\n  .ai-terminal-history');
    expect(start).toBeGreaterThan(-1);
    const phone = css.slice(start, css.indexOf('\n}', start));
    expect(phone).toMatch(/\.ai-terminal-history \.ai-terminal-btn \{[^}]*min-height: 44px/);
    expect(phone).toMatch(/\.ai-terminal-history \.ai-terminal-select \{[^}]*min-height: 44px; font-size: 16px/);
    expect(phone).toMatch(/\.ai-terminal-history > summary \{[^}]*min-height: 44px/);
  });

  test('the portal reads it at the Workroom sizes, and the component loads its own sheet', () => {
    expect(portalCss).toContain('.remote-workroom-content :is(.ai-terminal-panel,.ai-terminal-history) :is(.ai-terminal-btn');
    expect(source).toContain("import './AiTerminalPanel.css';");
  });

  test('the select and 「불러오기」 sit in the grid row; titles and the refusal use the wrapping classes', () => {
    const html = renderToStaticMarkup(createElement(RemoteWorkroomHistoryPanel, {
      available: true, visible: true, online: true, host: 'host-0123456789',
      projects: [{ targetId: 'control_1234', label: '아주긴한글프로젝트이름'.repeat(8) }], transport: async () => { throw new Error('unused'); }, storage: null,
    }));
    expect(html).toMatch(/class="ai-terminal-history-controls"><label class="ai-terminal-history-field"><span>프로젝트<\/span><select class="ai-terminal-select"/);
    expect(html).toContain('data-testid="remote-workroom-history-load"');
    expect(source).toContain('className="ai-terminal-hint ai-terminal-history-message"');
    expect(source).toContain('className="ai-terminal-history-warning"');
    expect(source.match(/className="ai-terminal-history-title"/g)?.length).toBe(2);
  });
});
