import { describe, expect, test } from 'bun:test';
import {
  PORTAL_QR_CAMERA_CONSTRAINTS,
  PORTAL_QR_PHOTO_LABEL,
  PORTAL_QR_SLOW_SCAN_HINT,
  PORTAL_QR_SLOW_SCAN_MS,
  createPortalQrReader,
  portalQrDecodeHints,
  startPortalQrCameraScan,
  type PortalQrReader,
  type PortalQrZxing,
} from '../src/portalQrCameraScan';

// Measured on iPhone 17 Pro (iOS 26.6, WKWebView): with only `facingMode` the live track was
// 480×640. The Mac's pairing QR carries ~862 characters, so each module was ~1–2 px and zxing never
// decoded it — and the page said nothing, so the user kept pointing the phone. The same QR decoded
// from a 642×642 still. These tests pin the three parts of the fix: ask for a large stream, tell
// zxing it is looking for one dense QR, and say something when nothing has decoded for a while.

type Callback = Parameters<PortalQrReader['decodeFromConstraints']>[2];

function fakeTimers() {
  let next = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    pending,
    set: (fn: () => void, ms: number) => { const id = next++; pending.set(id, { fn, ms }); return id; },
    clear: (id: unknown) => { pending.delete(id as number); },
    fireAll() { const due = [...pending.values()]; pending.clear(); for (const timer of due) timer.fn(); },
  };
}

function fakeReader() {
  const calls: MediaStreamConstraints[] = [];
  let callback: Callback | null = null;
  let resolve!: (controls: { stop(): void }) => void;
  let reject!: (error: unknown) => void;
  const controls = { stopped: 0, stop() { this.stopped += 1; } };
  const reader: PortalQrReader = {
    decodeFromConstraints(constraints, _video, cb) {
      calls.push(constraints);
      callback = cb;
      return new Promise((ok, fail) => { resolve = ok as never; reject = fail; });
    },
    decodeFromImageUrl: async () => ({ getText: () => '' }),
  };
  return {
    reader, calls, controls,
    live: () => resolve(controls),
    fail: (error: unknown) => reject(error),
    frame: (text?: string) => callback!(text === undefined ? undefined : { getText: () => text }, undefined, controls),
  };
}

const video = {} as HTMLVideoElement;
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('portal QR camera stream', () => {
  test('asks for a 1080p-class rear camera, as an ideal so cameras that cannot comply still open', () => {
    const constraints = PORTAL_QR_CAMERA_CONSTRAINTS;
    expect(constraints.audio).toBe(false);
    const videoConstraints = constraints.video as MediaTrackConstraints;
    expect(videoConstraints.facingMode).toEqual({ ideal: 'environment' });
    expect((videoConstraints.width as ConstrainULongRange).ideal).toBeGreaterThanOrEqual(1920);
    expect((videoConstraints.height as ConstrainULongRange).ideal).toBeGreaterThanOrEqual(1080);
    // `exact`/`min` would make a phone without such a mode fail with OverconstrainedError.
    for (const value of [videoConstraints.width, videoConstraints.height, videoConstraints.facingMode]) {
      expect(Object.keys(value as object)).toEqual(['ideal']);
    }
  });

  test('the live scan passes exactly those constraints to the reader', async () => {
    const fake = fakeReader();
    const timers = fakeTimers();
    const scan = startPortalQrCameraScan({ reader: fake.reader, video, onDecoded: () => {}, onSlow: () => {}, timers });
    expect(fake.calls).toEqual([PORTAL_QR_CAMERA_CONSTRAINTS]);
    fake.live();
    await scan.ready;
    scan.stop();
  });
});

describe('portal QR decode hints', () => {
  const zxing = () => {
    const made: Array<{ hints: Map<unknown, unknown> | undefined; options: unknown }> = [];
    class BrowserQRCodeReader {
      constructor(hints?: Map<unknown, unknown>, options?: unknown) { made.push({ hints, options }); }
      decodeFromConstraints = async () => ({ stop() {} });
      decodeFromImageUrl = async () => ({ getText: () => '' });
    }
    const library = {
      BrowserQRCodeReader: BrowserQRCodeReader as unknown as PortalQrZxing['BrowserQRCodeReader'],
      DecodeHintType: { POSSIBLE_FORMATS: 2, TRY_HARDER: 3 },
      BarcodeFormat: { QR_CODE: 11 },
    } satisfies PortalQrZxing;
    return { library, made };
  };

  test('QR only, and try harder: a dense pairing QR has small modules', () => {
    const { library } = zxing();
    const hints = portalQrDecodeHints(library);
    expect(hints.get(library.DecodeHintType.TRY_HARDER)).toBe(true);
    expect(hints.get(library.DecodeHintType.POSSIBLE_FORMATS)).toEqual([library.BarcodeFormat.QR_CODE]);
  });

  test('every reader the scanner makes carries those hints (camera and photo)', () => {
    const { library, made } = zxing();
    createPortalQrReader(library, { delayBetweenScanAttempts: 120, delayBetweenScanSuccess: 500 });
    createPortalQrReader(library);
    expect(made).toHaveLength(2);
    for (const { hints } of made) {
      expect(hints?.get(library.DecodeHintType.TRY_HARDER)).toBe(true);
      expect(hints?.get(library.DecodeHintType.POSSIBLE_FORMATS)).toEqual([library.BarcodeFormat.QR_CODE]);
    }
    expect(made[0]?.options).toEqual({ delayBetweenScanAttempts: 120, delayBetweenScanSuccess: 500 });
  });
});

describe('portal QR scan that reads nothing says so', () => {
  test('nothing decoded for the whole wait: the hint is shown once, and the scanner is not closed', async () => {
    const fake = fakeReader();
    const timers = fakeTimers();
    let slow = 0;
    const scan = startPortalQrCameraScan({ reader: fake.reader, video, onDecoded: () => {}, onSlow: () => { slow += 1; }, timers });
    // The permission prompt and camera start-up do not count: nothing is armed until the stream is live.
    expect(timers.pending.size).toBe(0);
    fake.live();
    await scan.ready;
    expect([...timers.pending.values()].map(timer => timer.ms)).toEqual([PORTAL_QR_SLOW_SCAN_MS]);
    expect(PORTAL_QR_SLOW_SCAN_MS).toBe(8_000);
    // Frames that decode nothing are not activity.
    fake.frame(); fake.frame();
    timers.fireAll();
    expect(slow).toBe(1);
    expect(fake.controls.stopped).toBe(0);
    scan.stop();
    expect(fake.controls.stopped).toBe(1);
  });

  test('a decode hands the text over and restarts the wait instead of showing the hint', async () => {
    const fake = fakeReader();
    const timers = fakeTimers();
    const texts: string[] = [];
    let slow = 0;
    const scan = startPortalQrCameraScan({ reader: fake.reader, video, onDecoded: text => texts.push(text), onSlow: () => { slow += 1; }, timers });
    fake.live();
    await scan.ready;
    const [armed] = [...timers.pending.keys()] as [number];
    fake.frame('https://portal.example/remote/#pair=x');
    expect(texts).toEqual(['https://portal.example/remote/#pair=x']);
    expect(timers.pending.has(armed)).toBe(false);
    expect([...timers.pending.values()].map(timer => timer.ms)).toEqual([PORTAL_QR_SLOW_SCAN_MS]);
    scan.stop();
    expect(timers.pending.size).toBe(0);
    timers.fireAll();
    expect(slow).toBe(0);
  });

  test('a frame that decodes before the stream promise settles still counts', async () => {
    const fake = fakeReader();
    const timers = fakeTimers();
    const texts: string[] = [];
    const scan = startPortalQrCameraScan({ reader: fake.reader, video, onDecoded: text => texts.push(text), onSlow: () => {}, timers });
    fake.frame('early');
    expect(texts).toEqual(['early']);
    fake.live();
    await scan.ready;
    scan.stop();
    expect(fake.controls.stopped).toBe(1);
  });

  test('stopping before the camera is live stops it as soon as it starts, and arms nothing', async () => {
    const fake = fakeReader();
    const timers = fakeTimers();
    let slow = 0;
    const scan = startPortalQrCameraScan({ reader: fake.reader, video, onDecoded: () => {}, onSlow: () => { slow += 1; }, timers });
    scan.stop();
    fake.live();
    await scan.ready;
    expect(fake.controls.stopped).toBe(1);
    expect(timers.pending.size).toBe(0);
    fake.frame('late');
    timers.fireAll();
    expect(slow).toBe(0);
  });

  test('a camera that fails to start rejects and arms nothing', async () => {
    const fake = fakeReader();
    const timers = fakeTimers();
    const scan = startPortalQrCameraScan({ reader: fake.reader, video, onDecoded: () => {}, onSlow: () => {}, timers });
    const error = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    fake.fail(error);
    await expect(scan.ready).rejects.toBe(error);
    await settle();
    expect(timers.pending.size).toBe(0);
  });

  test('the hint is short, non-blocking advice that names the photo option the scanner shows', () => {
    expect(PORTAL_QR_PHOTO_LABEL).toBe('QR 사진 선택');
    expect(PORTAL_QR_SLOW_SCAN_HINT).toContain(`「${PORTAL_QR_PHOTO_LABEL}」`);
    expect(PORTAL_QR_SLOW_SCAN_HINT).toMatch(/가까이/);
    expect(PORTAL_QR_SLOW_SCAN_HINT.length).toBeLessThan(120);
  });
});
