import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// At the app's default 1000×1050 window the 내가 한 말 library started ~2,060px
// down, under the settings column, and the 장기기억 list sat under a three-card
// orientation block. Core content first; long help collapses.
const said = readFileSync(new URL('../src/WhatISaidPanel.tsx', import.meta.url), 'utf8');
const memory = readFileSync(new URL('../src/PortalMemoryDirectory.tsx', import.meta.url), 'utf8');

test('내가 한 말: the library column comes first when the layout is one column', () => {
  expect(said).toContain('data-testid="what-i-said-library-column"');
  expect(said).toMatch(/data-testid="what-i-said-library-column"[^>]*className="[^"]*order-first[^"]*lg:order-none/);
  // The same-user trust paragraph is help, not the first thing on the screen.
  expect(said).toMatch(/<details[^>]*data-testid="what-i-said-same-user-trust"/);
});

test('장기기억: the orientation is collapsible help and points at the setup section', () => {
  expect(memory).toMatch(/<details[^>]*data-testid="portal-memory-orientation"/);
  expect(memory).toContain('id="portal-memory-setup"');
  expect(memory).toContain('data-testid="portal-memory-jump-setup"');
  // The card no longer says «아래에서 시작» without a way to get there.
  expect(memory).not.toContain('아래 ‘이 기기 연결 설정’에서 시작합니다');
});

test('장기기억: the collapsed orientation says it can be opened', () => {
  // The summary is display:flex, which hides the browser's ▸ marker. Without a
  // visible hint a beginner cannot tell the closed card opens.
  expect(memory).toMatch(/<details[^>]*data-testid="portal-memory-orientation"[^>]*className="group /);
  const summary = memory.slice(memory.indexOf('data-testid="portal-memory-orientation"'));
  const summaryBlock = summary.slice(0, summary.indexOf('</summary>'));
  expect(summaryBlock).toContain('data-testid="portal-memory-orientation-toggle-hint"');
  expect(summaryBlock).toContain('group-open:hidden">펼치기');
  expect(summaryBlock).toContain('group-open:inline">접기');
});
