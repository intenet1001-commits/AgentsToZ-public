import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {captureWorkroomImage, handleWorkroomImageRequest, isWorkroomImagePath, pruneWorkroomImages, saveWorkroomImage, workroomCaptureArgs, workroomImageKind, workroomImageRoot} from '../src/workroomImages';
import {WORKROOM_CAPTURE_SHORTCUTS, workroomCaptureShortcut, workroomImageFiles, workroomImageMessage} from '../src/workroomImageAttachments';
import {normalizeWorkroomImageResponse} from '../src/workroomImageClient';
import {terminalRequestTimeoutMs} from '../src/aiTerminalRequestPolicy';

// VOC 2026-10-02 "캡쳐해서 넣기": images for a Workroom request are saved on the Mac and named by path.
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true}); });
const appData = () => { const dir = mkdtempSync(join(tmpdir(), 'agentstoz-images-')); dirs.push(dir); return dir; };
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);

describe('saving a pasted image', () => {
  test('the bytes decide the kind, not a name or MIME type', () => {
    expect(workroomImageKind(PNG)).toBe('png');
    expect(workroomImageKind(JPEG)).toBe('jpeg');
    expect(workroomImageKind(new TextEncoder().encode('GIF89a....'))).toBe('gif');
    expect(workroomImageKind(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('webp');
    expect(workroomImageKind(new TextEncoder().encode('#!/bin/sh\nrm -rf /'))).toBeNull();
  });

  test('a file in today\'s folder of the app data, private, never overwriting', () => {
    const dir = appData(), now = new Date(2026, 9, 2, 15, 30, 12);
    const first = saveWorkroomImage(dir, PNG, now), second = saveWorkroomImage(dir, PNG, now);
    expect(first.path).not.toBe(second.path);
    expect(dirname(first.path)).toBe(join(workroomImageRoot(dir), '2026-10-02'));
    expect(first.path).toMatch(/\/153012-[0-9a-f]{8}\.png$/);
    expect(statSync(first.path).mode & 0o777).toBe(0o600);
    expect(isWorkroomImagePath(dir, first.path)).toBe(true);
    expect(isWorkroomImagePath(dir, join(dir, 'ports.json'))).toBe(false);
    expect(() => saveWorkroomImage(dir, new TextEncoder().encode('not an image'))).toThrow('이미지만');
    expect(() => saveWorkroomImage(dir, new Uint8Array(0))).toThrow('15MB');
  });

  test('day folders older than two weeks go away on the next save; other files stay', () => {
    const dir = appData(), root = workroomImageRoot(dir);
    for (const day of ['2026-09-10', '2026-09-17', '2026-09-18', '2026-10-01']) mkdirSync(join(root, day), {recursive: true});
    writeFileSync(join(root, 'README.txt'), 'keep');
    expect(pruneWorkroomImages(dir, new Date(2026, 9, 2, 9, 0, 0))).toBe(2);
    expect(readdirSync(root).sort()).toEqual(['2026-09-18', '2026-10-01', 'README.txt']);
  });

  test('the request handler accepts exactly save or capture', async () => {
    const dir = appData(), host = {appDataDir: dir, run: async () => 1};
    const saved = await handleWorkroomImageRequest(host, {operation: 'save', data: Buffer.from(PNG).toString('base64')});
    expect('path' in saved && existsSync(saved.path)).toBe(true);
    expect('path' in saved && saved.thumbnail).toBeUndefined();
    for (const body of [null, [], {operation: 'save'}, {operation: 'save', data: 'not base64!'}, {operation: 'save', data: 'aGk=', path: '/etc/x'},
      {operation: 'capture', mode: 'everything'}, {operation: 'capture', mode: 'region', path: '/tmp/x.png'}, {operation: 'delete'}]) {
      await expect(handleWorkroomImageRequest(host, body)).rejects.toThrow();
    }
  });
});

describe('screen capture', () => {
  test('silent screencapture: region and window are interactive, screen is the main display', () => {
    expect(workroomCaptureArgs('region', '/x.png')).toEqual(['/usr/sbin/screencapture', '-x', '-i', '/x.png']);
    expect(workroomCaptureArgs('window', '/x.png')).toEqual(['/usr/sbin/screencapture', '-x', '-i', '-W', '-o', '/x.png']);
    expect(workroomCaptureArgs('screen', '/x.png')).toEqual(['/usr/sbin/screencapture', '-x', '-m', '/x.png']);
  });

  test.skipIf(process.platform !== 'darwin')('a capture lands in the image folder; Esc is a cancel, not an error', async () => {
    const dir = appData(), calls: string[][] = [];
    const host = {appDataDir: dir, run: async (argv: string[]) => {
      calls.push(argv);
      if (argv[0] === '/usr/sbin/screencapture') writeFileSync(argv.at(-1)!, PNG);
      if (argv[0] === '/usr/bin/sips') writeFileSync(argv.at(-1)!, JPEG);
      return 0;
    }};
    const image = await captureWorkroomImage(host, 'region');
    expect(image && isWorkroomImagePath(dir, image.path)).toBe(true);
    expect(image?.thumbnail?.startsWith('data:image/jpeg;base64,')).toBe(true);
    // The thumbnail is temporary.
    expect(readdirSync(dirname(image!.path)).filter(name => name.endsWith('.thumb.jpg'))).toEqual([]);
    expect(calls[0]!.slice(0, 3)).toEqual(['/usr/sbin/screencapture', '-x', '-i']);
    const cancelled = await handleWorkroomImageRequest({appDataDir: dir, run: async () => 1}, {operation: 'capture', mode: 'window'});
    expect(cancelled).toEqual({cancelled: true});
    // Without screen-recording permission the file is not a PNG: say what to allow, keep nothing.
    await expect(captureWorkroomImage({appDataDir: dir, run: async argv => { writeFileSync(argv.at(-1)!, 'x'); return 0; }}, 'screen')).rejects.toThrow('화면 기록');
  });

  test('a capture may wait for the person; saving a paste may not', () => {
    expect(terminalRequestTimeoutMs('/api/agent-runtime/terminals/images', {operation: 'capture', mode: 'region'})).toBe(310_000);
    expect(terminalRequestTimeoutMs('/api/agent-runtime/terminals/images', {operation: 'save', data: ''})).toBe(30_000);
  });
});

describe('the request the CLI receives', () => {
  test('one absolute path per line under a header that tells the AI to open them', () => {
    expect(workroomImageMessage('이 화면 버그 고쳐줘  ', ['/a/1.png', '/a/2.png'])).toBe('이 화면 버그 고쳐줘\n\n[첨부 이미지 2개 — 각 파일을 열어 확인하세요]\n/a/1.png\n/a/2.png');
    expect(workroomImageMessage('', ['/a/1.png'])).toBe('[첨부 이미지 1개 — 각 파일을 열어 확인하세요]\n/a/1.png');
    expect(workroomImageMessage('그대로', [])).toBe('그대로');
  });

  test('only image files on a paste become attachments', () => {
    expect(workroomImageFiles([{type: 'text/plain'}, {type: 'image/png'}, {type: 'image/svg+xml'}, {type: 'image/jpeg'}])).toEqual([1, 3]);
    expect(workroomImageFiles(null)).toEqual([]);
  });

  test('⌥⌘ digits pick a capture; other chords do nothing', () => {
    const key = (code: string, extra: Partial<{metaKey: boolean; altKey: boolean; shiftKey: boolean; ctrlKey: boolean}> = {}) => ({code, metaKey: true, altKey: true, shiftKey: false, ctrlKey: false, ...extra});
    expect(workroomCaptureShortcut(key(WORKROOM_CAPTURE_SHORTCUTS.region.code))).toBe('region');
    expect(workroomCaptureShortcut(key('Digit5'))).toBe('window');
    expect(workroomCaptureShortcut(key('Digit3'))).toBe('screen');
    expect(workroomCaptureShortcut(key('Digit4', {shiftKey: true}))).toBeNull();
    expect(workroomCaptureShortcut(key('Digit4', {altKey: false}))).toBeNull();
    expect(workroomCaptureShortcut(key('KeyV'))).toBeNull();
  });

  test('the page accepts only a well-formed host answer', () => {
    expect(normalizeWorkroomImageResponse({cancelled: true})).toBeNull();
    expect(normalizeWorkroomImageResponse({path: '/x/1.png', name: '1.png', bytes: 10})).toEqual({path: '/x/1.png', name: '1.png', bytes: 10});
    for (const bad of [{path: 'relative.png', name: 'x', bytes: 1}, {path: '/x\n/y', name: 'x', bytes: 1}, {path: '/x', name: 'x', bytes: 1, thumbnail: 'javascript:alert(1)'}, {cancelled: true, path: '/x'}]) {
      expect(() => normalizeWorkroomImageResponse(bad)).toThrow();
    }
  });
});
