import {
  RemoteControlRelayContractError,
  isRemoteControlRelayPairingExpired,
  parseRemoteControlRelayPairingUrl,
} from './remoteControlRelayContract';

const MAX_SCANNED_QR_LENGTH = 4 * 1024;

export type PortalRemoteQrFailure =
  | 'EMPTY'
  | 'TOO_LARGE'
  | 'INVALID'
  | 'WRONG_PORTAL'
  | 'EXPIRED';

export class PortalRemoteQrError extends Error {
  constructor(readonly failure: PortalRemoteQrFailure, message: string) {
    super(message);
    this.name = 'PortalRemoteQrError';
  }
}

/**
 * Accept only a current AgentsToZ one-use pairing QR issued for this exact
 * personal portal origin. The fragment stays in-memory and is handed directly
 * to `/remote/`, whose bootstrap script removes it before application imports
 * or network activity.
 */
export function normalizePortalRemoteQr(
  value: unknown,
  portalOrigin: string,
  now = Date.now(),
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PortalRemoteQrError('EMPTY', 'QR 코드에 연결 주소가 없습니다.');
  }
  const scanned = value.trim();
  if (scanned.length > MAX_SCANNED_QR_LENGTH) {
    throw new PortalRemoteQrError('TOO_LARGE', 'QR 코드가 허용된 크기를 넘었습니다.');
  }

  let parsed: ReturnType<typeof parseRemoteControlRelayPairingUrl>;
  try {
    parsed = parseRemoteControlRelayPairingUrl(scanned);
  } catch (error) {
    if (error instanceof RemoteControlRelayContractError) {
      throw new PortalRemoteQrError('INVALID', 'AgentsToZ 원격제어 QR이 아닙니다.');
    }
    throw error;
  }

  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(portalOrigin).origin;
  } catch {
    throw new PortalRemoteQrError('INVALID', '현재 포털 주소를 확인할 수 없습니다.');
  }
  if (new URL(parsed.controllerUrl).origin !== expectedOrigin) {
    throw new PortalRemoteQrError('WRONG_PORTAL', '다른 배포본에서 발급한 QR은 이 포털에서 열 수 없습니다.');
  }
  if (isRemoteControlRelayPairingExpired(parsed.bootstrap, now)) {
    throw new PortalRemoteQrError('EXPIRED', '이 QR은 만료되었습니다. Mac에서 새 QR을 발급해 주세요.');
  }
  return scanned;
}
