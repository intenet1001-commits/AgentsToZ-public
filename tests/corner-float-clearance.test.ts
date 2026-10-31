import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORNER_FLOAT_GAP, CORNER_FLOAT_MIN_POPOVER, CORNER_FLOAT_SELECTOR, cornerFloatTop, popoverPlacement } from '../src/cornerFloatClearance';

// Click sweep 2026-11-01 (1440×900, 화면 배율 125%): 「실행 도구」 opened down to y 880 while the dock sat at x 965–1415,
// y 738–875 — its 권한 우회 toggle and 빌드 menu were under the dock.
const dock = { left: 965, right: 1415, top: 738, width: 450, height: 137 };
const toolsSpan = { left: 879, right: 1392 };
const root = join(import.meta.dir, '..');

describe('corner float clearance', () => {
  test('only furniture sharing the popover columns counts', () => {
    expect(cornerFloatTop(toolsSpan, [dock])).toBe(738);
    expect(cornerFloatTop({ left: 340, right: 860 }, [dock])).toBeNull();
    expect(cornerFloatTop(toolsSpan, [{ ...dock, width: 0, height: 0 }])).toBeNull();
    expect(cornerFloatTop(toolsSpan, [dock, { left: 1100, right: 1415, top: 600, width: 315, height: 120 }])).toBe(600);
  });

  test('a popover with room above the dock ends above it', () => {
    expect(popoverPlacement({ panelTop: 140, span: toolsSpan, windowHeight: 900, scale: 1.25, boxes: [dock] }))
      .toEqual({ bottom: 738 - CORNER_FLOAT_GAP, overDock: false });
  });

  test('no furniture below means the window edge', () => {
    expect(popoverPlacement({ panelTop: 140, span: { left: 340, right: 860 }, windowHeight: 900, scale: 1.25, boxes: [dock] }))
      .toEqual({ bottom: 900 - CORNER_FLOAT_GAP, overDock: false });
  });

  test('an expanded dock that leaves too little room is gone over, not squeezed under', () => {
    const tall = { ...dock, top: 140 + CORNER_FLOAT_MIN_POPOVER * 1.25 + CORNER_FLOAT_GAP - 1, height: 400 };
    expect(popoverPlacement({ panelTop: 140, span: toolsSpan, windowHeight: 900, scale: 1.25, boxes: [tall] }))
      .toEqual({ bottom: 900 - CORNER_FLOAT_GAP, overDock: true });
    const justEnough = { ...tall, top: tall.top + 1 };
    expect(popoverPlacement({ panelTop: 140, span: toolsSpan, windowHeight: 900, scale: 1.25, boxes: [justEnough] }).overDock).toBe(false);
  });

  test('the over-dock rule drops the dock under the project header layer', () => {
    const css = readFileSync(join(root, 'src/components/AgentsToZVoiceDock.css'), 'utf8');
    const header = readFileSync(join(root, 'src/workspaceDesign.css'), 'utf8');
    const rule = css.match(/body:has\(\.workspace-tools\[open\]\[data-over-dock="true"\]\)[^{]*\{\s*z-index:\s*(\d+)/);
    const headerZ = header.match(/\[data-testid="project-main-header"\][^{]*\{[^}]*z-index:\s*(\d+)/);
    expect(rule).not.toBeNull();
    expect(headerZ).not.toBeNull();
    expect(Number(rule![1])).toBeLessThan(Number(headerZ![1]));
    // Both corner floats step down; the full-screen caption view is a modal and stays on top.
    expect(rule![0]).toContain('.az-voice-dock:not(.az-voice-dock--fullscreen)');
    expect(rule![0]).toContain('.az-notices--floating');
    expect(CORNER_FLOAT_SELECTOR).toBe('.az-voice-dock:not(.az-voice-dock--fullscreen), .az-notices--floating');
  });

  test('WorkspaceTools sizes its popover around the dock', () => {
    const source = readFileSync(join(root, 'src/components/WorkspaceTools.tsx'), 'utf8');
    expect(source).toContain('popoverPlacement(');
    expect(source).toContain('cornerFloatBoxes()');
    expect(source).toMatch(/dataset\.overDock = 'true'/);
  });
});
