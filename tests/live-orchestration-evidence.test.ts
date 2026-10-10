import {describe, expect, test} from 'bun:test';
import {exactMarkerLineCount, hasExactMarkerLine} from '../docs/handoffs/2026-09-29-orchestration/e2e-orch';

describe('live orchestration evidence', () => {
  test('does not mistake a marker embedded in the submitted prompt for an agent response', () => {
    const marker = 'ONE-ABC12';
    const promptEcho = `› 파일을 수정하지 말고 정확히 ${marker} 한 줄만 출력해.`;
    expect(hasExactMarkerLine(promptEcho, marker)).toBe(false);
    expect(exactMarkerLineCount(`${promptEcho}\n• ${marker}`, marker)).toBe(1);
  });

  test('requires exactly one standalone response line', () => {
    const marker = 'THREE-Z9X8W';
    expect(exactMarkerLineCount(`⏺ ${marker}\nstatus: done`, marker)).toBe(1);
    expect(exactMarkerLineCount(`${marker}\n- ${marker}`, marker)).toBe(2);
    expect(exactMarkerLineCount(`prefix ${marker}\n${marker} suffix`, marker)).toBe(0);
  });

  test('recognizes a standalone Hermes TUI response before its right border', () => {
    const marker = 'PONG-HERMES';
    const screen = ` ❯ output exactly ${marker}                                      ┃\n    ${marker}                                                   ┃`;
    expect(exactMarkerLineCount(screen, marker)).toBe(1);
    expect(hasExactMarkerLine(screen, marker)).toBe(true);
  });

  test('recognizes a standalone Hermes TUI response between vertical borders', () => {
    const marker = 'PONG-HERMES-BORDERED';
    expect(exactMarkerLineCount(` │  ${marker}                                      ┃`, marker)).toBe(1);
  });
});
