import type { IScannerControls } from '@zxing/browser';

/**
 * The live part of the portal's QR scanner (PortalRemoteQrScanner), kept apart from React so the
 * camera request, the decode hints and the "nothing has decoded" timer can be tested directly.
 *
 * Measured on iPhone 17 Pro (iOS 26.6, WKWebView): asked only for the rear camera, WebKit returned a
 * 480×640 track. The Mac's pairing QR carries ~862 characters (a dense QR), so each module was
 * ~1–2 px and zxing never decoded it — while the same QR decoded from a 642×642 still. The page said
 * nothing, so the user just kept pointing the phone.
 */

/** Same words as the scanner's photo button, so the hint names something the user can see. */
export const PORTAL_QR_PHOTO_LABEL = 'QR 사진 선택';

/**
 * A 1080p-class rear camera. `ideal`, never `exact`/`min`: a camera without such a mode must still
 * open (an `exact` miss is an OverconstrainedError, and the user would lose the live scanner).
 * Width/height are given as the landscape sensor size; WebKit rotates the track for a portrait page.
 */
export const PORTAL_QR_CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
};

/** How long a live camera may decode nothing before the scanner says what to try. */
export const PORTAL_QR_SLOW_SCAN_MS = 8_000;

export const PORTAL_QR_SLOW_SCAN_HINT =
  `아직 QR을 읽지 못했습니다. 휴대폰을 더 가까이 대어 QR이 사각형을 가득 채우게 하거나, 아래 「${PORTAL_QR_PHOTO_LABEL}」을 이용하세요.`;

/** The slice of @zxing/browser + @zxing/library the scanner uses (injected so tests can fake it). */
export interface PortalQrZxing {
  BrowserQRCodeReader: new (hints?: Map<never, unknown>, options?: PortalQrReaderOptions) => PortalQrReader;
  DecodeHintType: { POSSIBLE_FORMATS: number; TRY_HARDER: number };
  BarcodeFormat: { QR_CODE: number };
}

export interface PortalQrReaderOptions {
  delayBetweenScanAttempts?: number;
  delayBetweenScanSuccess?: number;
}

export interface PortalQrResult { getText(): string }

export interface PortalQrReader {
  decodeFromConstraints(
    constraints: MediaStreamConstraints,
    video: HTMLVideoElement,
    callback: (result: PortalQrResult | undefined, error: unknown, controls: IScannerControls) => void,
  ): Promise<IScannerControls>;
  decodeFromImageUrl(url: string): Promise<PortalQrResult>;
}

/** One dense QR, looked for carefully: QR only, and try harder (scan every row for finder patterns). */
export function portalQrDecodeHints(zxing: Pick<PortalQrZxing, 'DecodeHintType' | 'BarcodeFormat'>): Map<number, unknown> {
  return new Map<number, unknown>([
    [zxing.DecodeHintType.POSSIBLE_FORMATS, [zxing.BarcodeFormat.QR_CODE]],
    [zxing.DecodeHintType.TRY_HARDER, true],
  ]);
}

/** Every reader the scanner makes — camera and photo — carries the same hints. */
export function createPortalQrReader(zxing: PortalQrZxing, options?: PortalQrReaderOptions): PortalQrReader {
  return new zxing.BrowserQRCodeReader(portalQrDecodeHints(zxing) as Map<never, unknown>, options);
}

/** Loaded only when the scanner opens; both packages already share the scanner's lazy chunk. */
export async function loadPortalQrZxing(): Promise<PortalQrZxing> {
  const [browser, library] = await Promise.all([import('@zxing/browser'), import('@zxing/library')]);
  return {
    BrowserQRCodeReader: browser.BrowserQRCodeReader as unknown as PortalQrZxing['BrowserQRCodeReader'],
    DecodeHintType: library.DecodeHintType,
    BarcodeFormat: library.BarcodeFormat,
  };
}

export interface PortalQrTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const browserTimers: PortalQrTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface PortalQrCameraScan {
  /** Settles when the stream is live (rejects with the camera's error when it cannot start). */
  ready: Promise<void>;
  /** Stops the scan loop and the hint timer. Safe before `ready` settles and more than once. */
  stop(): void;
}

/**
 * Start the live scan. The "nothing decoded" wait starts only once the stream is live (a permission
 * prompt does not count) and restarts on every decode, so the hint means "no QR read for the last
 * N seconds". It never closes the scanner — that stays the user's choice.
 */
export function startPortalQrCameraScan(options: {
  reader: PortalQrReader;
  video: HTMLVideoElement;
  onDecoded(text: string): void;
  onSlow(): void;
  slowAfterMs?: number;
  timers?: PortalQrTimers;
}): PortalQrCameraScan {
  const { reader, video, onDecoded, onSlow, slowAfterMs = PORTAL_QR_SLOW_SCAN_MS, timers = browserTimers } = options;
  let stopped = false;
  let live = false;
  let controls: IScannerControls | null = null;
  let timer: unknown = null;
  const disarm = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  const arm = () => {
    disarm();
    if (stopped || !live) return;
    timer = timers.set(() => {
      timer = null;
      if (!stopped) onSlow();
    }, slowAfterMs);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    disarm();
    controls?.stop();
  };
  const ready = reader.decodeFromConstraints(PORTAL_QR_CAMERA_CONSTRAINTS, video, (result, _error, current) => {
    // A frame can decode before `decodeFromConstraints` settles; keep its controls so stop() works.
    controls ??= current;
    if (stopped || !result) return;
    arm();
    onDecoded(result.getText());
  }).then(resolved => {
    controls = resolved;
    if (stopped) { resolved.stop(); return; }
    live = true;
    arm();
  });
  return { ready, stop };
}
