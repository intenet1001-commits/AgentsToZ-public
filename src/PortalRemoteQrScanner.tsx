import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { IScannerControls } from '@zxing/browser';
import { Camera, Image as ImageIcon, Loader2, ScanLine, X } from 'lucide-react';
import { PortalRemoteQrError, normalizePortalRemoteQr } from './portalRemoteQr';

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

export function PortalRemoteQrScanner({ open, onClose, onDetected }: PortalRemoteQrScannerProps) {
  const detectedRef = useRef(onDetected);
  detectedRef.current = onDetected;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const acceptedRef = useRef(false);
  const [cameraState, setCameraState] = useState<'idle' | 'starting' | 'ready' | 'failed'>('idle');
  const [message, setMessage] = useState('');
  const [photoBusy, setPhotoBusy] = useState(false);

  const stopCamera = useCallback(() => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    const stream = videoRef.current?.srcObject;
    if (stream instanceof MediaStream) stream.getTracks().forEach(track => track.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const acceptScannedValue = useCallback(async (rawValue: string) => {
    if (acceptedRef.current) return;
    try {
      const target = normalizePortalRemoteQr(rawValue, window.location.origin);
      acceptedRef.current = true;
      stopCamera();
      // Same-origin navigation keeps the Home Screen web app and its existing
      // Supabase login session. `/remote/` removes the fragment immediately.
      if (detectedRef.current) await detectedRef.current(target);
      else window.location.assign(target);
    } catch (error) {
      acceptedRef.current = false;
      setMessage(error instanceof PortalRemoteQrError
        ? error.message
        : 'QR을 확인하지 못했습니다. AgentsToZ에서 새로 발급한 QR을 사용하세요.');
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
    setMessage('');
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraState('failed');
      setMessage('이 홈 화면 앱에서는 실시간 카메라를 열 수 없습니다. QR 사진을 선택해 주세요.');
      return;
    }

    let active = true;
    setCameraState('starting');
    void import('@zxing/browser').then(async ({ BrowserQRCodeReader }) => {
      if (!active || !videoRef.current) return;
      const reader = new BrowserQRCodeReader(undefined, {
        delayBetweenScanAttempts: 120,
        delayBetweenScanSuccess: 500,
      });
      const controls = await reader.decodeFromConstraints(
        { audio: false, video: { facingMode: { ideal: 'environment' } } },
        videoRef.current,
        (result, _error, currentControls) => {
          if (!active || !result) return;
          controlsRef.current = currentControls;
          acceptScannedValue(result.getText());
        },
      );
      if (!active) {
        controls.stop();
        return;
      }
      controlsRef.current = controls;
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
  }, [acceptScannedValue, open, stopCamera]);

  const readPhoto = async (file: File | undefined) => {
    if (!file) return;
    stopCamera();
    setPhotoBusy(true);
    setMessage('');
    const objectUrl = URL.createObjectURL(file);
    try {
      const { BrowserQRCodeReader } = await import('@zxing/browser');
      const result = await new BrowserQRCodeReader().decodeFromImageUrl(objectUrl);
      acceptScannedValue(result.getText());
    } catch (error) {
      if (error instanceof PortalRemoteQrError) setMessage(error.message);
      else setMessage('사진에서 AgentsToZ 원격제어 QR을 찾지 못했습니다.');
    } finally {
      URL.revokeObjectURL(objectUrl);
      setPhotoBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
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

        <p className="portal-qr-scanner__help">
          Mac의 AgentsToZ에 표시된 외부 인터넷 QR을 사각형 안에 맞추세요. 영상과 사진은 이 기기에서만 처리됩니다.
        </p>
        {message && <div className="portal-qr-scanner__message" role="alert">{message}</div>}

        <input
          ref={fileInputRef}
          className="sr-only"
          type="file"
          accept="image/*"
          capture="environment"
          aria-label="QR 사진 선택"
          onChange={event => void readPhoto(event.target.files?.[0])}
        />
        <button
          type="button"
          className="portal-qr-scanner__photo"
          disabled={photoBusy}
          onClick={() => fileInputRef.current?.click()}
        >
          {photoBusy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <ImageIcon aria-hidden="true" />}
          {photoBusy ? 'QR 읽는 중…' : '카메라 촬영·QR 사진으로 열기'}
        </button>

        <div className="portal-qr-scanner__security">
          <ScanLine aria-hidden="true" />
          <span>현재 개인 포털에서 발급된 30일·1회용 AgentsToZ QR만 허용합니다.</span>
        </div>
      </section>
    </div>
  );
}
