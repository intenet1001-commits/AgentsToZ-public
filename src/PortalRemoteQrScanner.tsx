import React, { useCallback, useEffect, useRef, useState } from 'react';
import { portalOrigin } from './portalRuntimeConfig';
import { Camera, Image as ImageIcon, Loader2, ScanLine, X } from 'lucide-react';
import { PortalRemoteQrError, normalizePortalRemoteQr } from './portalRemoteQr';
import {
  PORTAL_QR_PHOTO_LABEL,
  PORTAL_QR_SLOW_SCAN_HINT,
  createPortalQrReader,
  loadPortalQrZxing,
  startPortalQrCameraScan,
  type PortalQrCameraScan,
} from './portalQrCameraScan';

interface PortalRemoteQrScannerProps {
  open: boolean;
  onClose: () => void;
  onDetected?: (target: string) => Promise<void> | void;
}

function cameraFailureMessage(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error
    ? String((error as { name?: unknown }).name ?? '')
    : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return '카메라 권한이 꺼져 있습니다. 권한을 허용하거나 아래에서 QR 사진을 선택하세요.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return '사용할 수 있는 카메라를 찾지 못했습니다. 아래에서 QR 사진을 선택하세요.';
  }
  return '카메라를 시작하지 못했습니다. 아래의 QR 사진 선택은 그대로 사용할 수 있습니다.';
}

/**
 * Why a decoded QR was not accepted. A refusal of the QR itself says so; the app's own Korean reason (「연결 준비
 * 중입니다…」) passes through; anything else (a storage write that failed) asks to scan again — the QR was not the
 * problem, so it does not send the user to the Mac for a new one first.
 */
export function portalQrAcceptFailureMessage(error: unknown): string {
  if (error instanceof PortalRemoteQrError) return error.message;
  if (error instanceof Error && /[가-힣]/.test(error.message)) return error.message;
  return 'QR을 처리하지 못했습니다. 잠시 후 다시 스캔하세요. 계속되면 Mac에서 새 QR을 발급하세요.';
}

/** A refused value is not tried again while it stays in view: a refusal of the QR itself for as long as the scanner is
 *  open, any other failure (not ready yet, storage) for this long — then the same QR is tried again, once per interval
 *  for as long as it stays in view (the live scan decodes about every 500 ms), so a transient app-side failure heals by
 *  itself. Checked in tests/portal-qr-scanner-retry.e2e.mjs. */
export const PORTAL_QR_RETRY_AFTER_MS = 2_500;

export function PortalRemoteQrScanner({ open, onClose, onDetected }: PortalRemoteQrScannerProps) {
  const detectedRef = useRef(onDetected);
  detectedRef.current = onDetected;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scanRef = useRef<PortalQrCameraScan | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const acceptedRef = useRef(false);
  const refusedRef = useRef<{ value: string; until: number } | null>(null);
  const [cameraState, setCameraState] = useState<'idle' | 'starting' | 'ready' | 'failed'>('idle');
  // Bumped to start the live camera again after a photo (which stops it first) was not accepted.
  const [cameraRun, setCameraRun] = useState(0);
  const [message, setMessage] = useState('');
  const [photoBusy, setPhotoBusy] = useState(false);
  // A live camera that has decoded nothing for a while: say what to try instead of staying silent.
  const [slowScan, setSlowScan] = useState(false);

  const stopCamera = useCallback(() => {
    scanRef.current?.stop();
    scanRef.current = null;
    setSlowScan(false);
    const stream = videoRef.current?.srcObject;
    if (stream instanceof MediaStream) stream.getTracks().forEach(track => track.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  /**
   * True when the QR was accepted. The live camera keeps running while it is being accepted (`acceptedRef` drops the
   * decodes in between) and stops only on success: stopping it first left a refused QR — another Supabase project, a
   * vault not ready yet — with a black preview that looked like it was still scanning.
   */
  const acceptScannedValue = useCallback(async (rawValue: string): Promise<boolean> => {
    if (acceptedRef.current) return false;
    const refused = refusedRef.current;
    if (refused && refused.value === rawValue && Date.now() < refused.until) return false;
    try {
      const target = normalizePortalRemoteQr(rawValue, portalOrigin());
      acceptedRef.current = true;
      // Same-origin navigation keeps the Home Screen web app and its existing
      // Supabase login session. `/remote/` removes the fragment immediately.
      const detected = detectedRef.current;
      if (detected) await detected(target);
      refusedRef.current = null;
      stopCamera();
      if (!detected) window.location.assign(target);
      return true;
    } catch (error) {
      acceptedRef.current = false;
      refusedRef.current = { value: rawValue, until: error instanceof PortalRemoteQrError ? Infinity : Date.now() + PORTAL_QR_RETRY_AFTER_MS };
      setMessage(portalQrAcceptFailureMessage(error));
      return false;
    }
  }, [stopCamera]);

  useEffect(() => {
    if (!open) {
      stopCamera();
      setCameraState('idle');
      setMessage('');
      return;
    }
    acceptedRef.current = false;
    refusedRef.current = null;
    setMessage('');
  }, [open, stopCamera]);

  useEffect(() => {
    if (!open) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraState('failed');
      setMessage('이 홈 화면 앱에서는 실시간 카메라를 열 수 없습니다. QR 사진을 선택해 주세요.');
      return;
    }

    let active = true;
    setCameraState('starting');
    void loadPortalQrZxing().then(async zxing => {
      if (!active || !videoRef.current) return;
      const scan = startPortalQrCameraScan({
        reader: createPortalQrReader(zxing, { delayBetweenScanAttempts: 120, delayBetweenScanSuccess: 500 }),
        video: videoRef.current,
        onDecoded: text => {
          if (!active) return;
          setSlowScan(false);
          void acceptScannedValue(text);
        },
        onSlow: () => { if (active) setSlowScan(true); },
      });
      scanRef.current = scan;
      await scan.ready;
      if (!active) {
        scan.stop();
        return;
      }
      setCameraState('ready');
    }).catch(error => {
      if (!active) return;
      stopCamera();
      setCameraState('failed');
      setMessage(cameraFailureMessage(error));
    });

    return () => {
      active = false;
      stopCamera();
    };
  }, [acceptScannedValue, open, stopCamera, cameraRun]);

  const readPhoto = async (file: File | undefined) => {
    if (!file) return;
    // The photo picker may need the camera: the live scan pauses, and comes back unless the photo was accepted.
    const resumeCamera = cameraState !== 'failed';
    stopCamera();
    setPhotoBusy(true);
    setMessage('');
    const objectUrl = URL.createObjectURL(file);
    let accepted = false;
    try {
      const result = await createPortalQrReader(await loadPortalQrZxing()).decodeFromImageUrl(objectUrl);
      // A photo is a deliberate choice: try it even if the same QR was refused from the live camera a moment ago.
      refusedRef.current = null;
      accepted = await acceptScannedValue(result.getText());
    } catch (error) {
      if (error instanceof PortalRemoteQrError) setMessage(error.message);
      else setMessage('사진에서 AgentsToZ 원격제어 QR을 찾지 못했습니다.');
    } finally {
      URL.revokeObjectURL(objectUrl);
      setPhotoBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (!accepted && resumeCamera) setCameraRun(value => value + 1);
    }
  };

  if (!open) return null;

  return (
    <div className="portal-qr-scanner-backdrop" role="presentation" onClick={onClose}>
      <section
        className="portal-qr-scanner"
        role="dialog"
        aria-modal="true"
        aria-labelledby="portal-qr-scanner-title"
        onClick={event => event.stopPropagation()}
      >
        <header className="portal-qr-scanner__header">
          <div>
            <p>HOME SCREEN APP</p>
            <h2 id="portal-qr-scanner-title">원격제어 QR 스캔</h2>
          </div>
          <button type="button" aria-label="QR 스캐너 닫기" onClick={onClose}><X aria-hidden="true" /></button>
        </header>

        <div className="portal-qr-scanner__camera">
          <video ref={videoRef} muted playsInline aria-label="QR 스캔 카메라 미리보기" />
          <div className="portal-qr-scanner__guide" aria-hidden="true"><span /></div>
          {cameraState === 'starting' && (
            <div className="portal-qr-scanner__camera-state" role="status">
              <Loader2 className="animate-spin" aria-hidden="true" />카메라 여는 중…
            </div>
          )}
          {cameraState === 'failed' && (
            <div className="portal-qr-scanner__camera-state">
              <Camera aria-hidden="true" />실시간 카메라를 사용할 수 없습니다
            </div>
          )}
        </div>
        {slowScan && cameraState === 'ready' && (
          <p className="portal-qr-scanner__slow" role="status" data-testid="portal-qr-scanner-slow-hint">
            {PORTAL_QR_SLOW_SCAN_HINT}
          </p>
        )}

        <p className="portal-qr-scanner__help">
          Mac의 AgentsToZ에 표시된 외부 인터넷 QR을 사각형 안에 맞추세요. 영상과 사진은 이 기기에서만 처리됩니다.
        </p>
        {message && <div className="portal-qr-scanner__message" role="alert">{message}</div>}

        <input
          ref={fileInputRef}
          className="sr-only"
          type="file"
          accept="image/*"
          aria-label={PORTAL_QR_PHOTO_LABEL}
          onChange={event => void readPhoto(event.target.files?.[0])}
        />
        <button
          type="button"
          className="portal-qr-scanner__photo"
          disabled={photoBusy}
          onClick={() => fileInputRef.current?.click()}
        >
          {photoBusy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <ImageIcon aria-hidden="true" />}
          {photoBusy ? 'QR 읽는 중…' : PORTAL_QR_PHOTO_LABEL}
        </button>

        <div className="portal-qr-scanner__security">
          <ScanLine aria-hidden="true" />
          <span>현재 개인 포털에서 발급된 30일·1회용 AgentsToZ QR만 허용합니다.</span>
        </div>
      </section>
    </div>
  );
}
