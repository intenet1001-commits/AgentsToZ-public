import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const panelSource = readFileSync(new URL('../src/components/AiUsagePanel.tsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');

describe('Codex rate-limit UI contract', () => {
  test('shows both used and remaining percentages', () => {
    expect(panelSource).toContain("% 사용 ·");
    expect(panelSource).toContain("100 - limit!.used_percent!");
  });

  test('labels rollout fallback responses as session-log data', () => {
    expect(apiSource).toContain("source: 'session-log'");
    expect(panelSource).toContain("json.source === 'session-log'");
  });
});
