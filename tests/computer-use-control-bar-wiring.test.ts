import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';

// Source-level contract complements the pure click tests without opening a real AppKit window or posting input.
test('hand-back requires this pill tracking its own mouse and refuses accessibility presses',()=>{
  const view=readFileSync(new URL('../native/computer-use/Sources/AgentsToZControl/ControlBarView.swift',import.meta.url),'utf8');
  const bar=readFileSync(new URL('../native/computer-use/Sources/AgentsToZControl/ControlBar.swift',import.meta.url),'utf8');
  expect(view).toContain('private(set) var tracksOwnMouseDown = false');
  expect(view).toMatch(/override func mouseDown\(with event: NSEvent\)[\s\S]*?tracksOwnMouseDown = true[\s\S]*?defer \{ tracksOwnMouseDown = false \}[\s\S]*?super\.mouseDown\(with: event\)/);
  expect(view).toMatch(/override func accessibilityPerformPress\(\) -> Bool \{[\s\S]*?guard !requiresPhysicalHandBack else \{ refusedAccessibilityPress\?\(\); return false \}/);
  expect(bar).toContain('view.primary.requiresPhysicalHandBack = owner == .person');
  expect(bar).toContain('ownMouseDown: button.tracksOwnMouseDown');
  expect(bar).toContain('inButton: button.bounds.contains(button.convert(event.locationInWindow, from: nil)), clickCount: event.clickCount');
});
