import { describe, expect, test } from 'bun:test';
import {
  isDropPositionInside,
  isPhysicalPositionInside,
  normalizeFileUri,
  pathlessDropMessage,
  shouldUseBrowserDropFallback,
} from '../src/FolderDropZone';

describe('FolderDropZone path normalization', () => {
  test('decodes a macOS file URI with spaces', () => {
    expect(normalizeFileUri('file:///Users/demo/My%20Manual.md'))
      .toBe('/Users/demo/My Manual.md');
  });

  test('skips uri-list comments and uses the first real path', () => {
    expect(normalizeFileUri('# dragged file\nfile:///Users/demo/logs/session.log\n'))
      .toBe('/Users/demo/logs/session.log');
  });

  test('normalizes a Windows file URI without the leading slash', () => {
    expect(normalizeFileUri('file:///C:/Users/demo/project/run.cmd'))
      .toBe('C:/Users/demo/project/run.cmd');
  });

  test('accepts absolute plain-text paths', () => {
    expect(normalizeFileUri('/Users/demo/project')).toBe('/Users/demo/project');
    expect(normalizeFileUri('C:\\Users\\demo\\project')).toBe('C:\\Users\\demo\\project');
  });

  test('rejects relative paths and non-file URLs', () => {
    expect(normalizeFileUri('docs/manual.md')).toBeNull();
    expect(normalizeFileUri('https://example.com/manual.md')).toBeNull();
    expect(normalizeFileUri('# comment only')).toBeNull();
  });

  test('maps Tauri physical drag coordinates through Retina scale', () => {
    const rect = { left: 100, right: 500, top: 200, bottom: 260 };
    expect(isPhysicalPositionInside({ x: 400, y: 440 }, rect, 2)).toBe(true);
    expect(isPhysicalPositionInside({ x: 80, y: 440 }, rect, 2)).toBe(false);
    expect(isPhysicalPositionInside({ x: 400, y: 600 }, rect, 2)).toBe(false);
  });

  test('a macOS drop (view points) lands inside the box on a Retina display at app zoom 1 and 1.25; Windows (physical) too', () => {
    // A FolderDropZone at CSS (100..500, 200..260); the user drops on its centre, CSS (300, 230).
    const rect = { left: 100, right: 500, top: 200, bottom: 260 };
    for (const zoom of [1, 1.25]) {
      const mac = { unit: 'logical' as const, scaleFactor: 2, logicalWidth: 1000, cssWidth: 1000 / zoom };
      expect(isDropPositionInside({ x: 300 * zoom, y: 230 * zoom }, rect, mac)).toBe(true);
      // The old physical/DPR model put this drop at half its place, outside the box.
      expect(isPhysicalPositionInside({ x: 300 * zoom, y: 230 * zoom }, rect, 2)).toBe(false);
      const win = { unit: 'physical' as const, scaleFactor: 1.5, logicalWidth: 1000, cssWidth: 1000 / zoom };
      expect(isDropPositionInside({ x: 300 * zoom * 1.5, y: 230 * zoom * 1.5 }, rect, win)).toBe(true);
    }
    expect(isDropPositionInside({ x: 50, y: 230 }, rect, { unit: 'logical', scaleFactor: 2, logicalWidth: 0, cssWidth: 0 })).toBe(false);
  });

  test('ignores the duplicate pathless browser drop in Tauri instead of opening a picker', () => {
    expect(shouldUseBrowserDropFallback(true)).toBe(false);
    expect(shouldUseBrowserDropFallback(false)).toBe(true);
  });

  test('explains a pathless web drop without implying that a picker opens automatically', () => {
    expect(pathlessDropMessage('file')).toBe(
      '브라우저가 파일의 실제 경로를 제공하지 않았습니다. 오른쪽 선택 버튼을 사용해주세요.',
    );
    expect(pathlessDropMessage('folder')).toContain('폴더의 실제 경로');
  });
});
