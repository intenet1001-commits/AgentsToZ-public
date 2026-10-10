import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './lib/env';
import {
  QR_REMOTE_CONTROL_PATHS,
  normalizeQrRemoteControlInterfaces,
  normalizeQrRemoteControlPairingIssue,
  normalizeQrRemoteControlStatus,
  type QrRemoteControlInterface,
  type QrRemoteControlPairingIssue,
  type QrRemoteControlPath,
  type QrRemoteControlStatus,
} from './qrRemoteControlContract';

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
);

const errorFromPayload = (payload: unknown, status: number): Error & { code?: string } => {
  const body = asObject(payload);
  const message = typeof body?.error === 'string' && body.error.trim()
    ? body.error.trim()
    : typeof body?.message === 'string' && body.message.trim()
      ? body.message.trim()
      : `QR 원격제어 요청에 실패했습니다. (${status})`;
  const error = new Error(message) as Error & { code?: string };
  if (typeof body?.code === 'string' && body.code.trim()) error.code = body.code.trim();
  return error;
};

async function remoteControlManagementRequest<T>(path: QrRemoteControlPath, body: JsonObject = {}): Promise<T> {
  let status: number;
  let payload: unknown;
  const useNativeBridge = isTauri() && String(import.meta.env.DEV) !== 'true';
  if (useNativeBridge) {
    // This command has its own sidecar capability and route allowlist. It must
    // never share the What-I-said management command, header, or secret. In
    // `tauri dev`, Vite's same-origin /api proxy owns the source API instead.
    const proxied = asObject(await invoke<unknown>('remote_control_management_request', {
      path,
      method: 'POST',
      body,
    }));
    const proxiedStatus = proxied?.status;
    if (!Number.isInteger(proxiedStatus)
      || (proxiedStatus as number) < 100 || (proxiedStatus as number) > 599
      || !Object.prototype.hasOwnProperty.call(proxied ?? {}, 'body')) {
      throw new Error('QR 원격제어 보안 응답을 확인하지 못했습니다.');
    }
    status = proxiedStatus as number;
    payload = proxied!.body;
  } else {
    const response = await fetch(path, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    status = response.status;
    payload = await response.json().catch(() => ({}));
  }
  if (status < 200 || status >= 300) throw errorFromPayload(payload, status);
  return payload as T;
}

export interface QrRemoteControlApi {
  status(): Promise<QrRemoteControlStatus>;
  interfaces(): Promise<QrRemoteControlInterface[]>;
  enable(interfaceAddress: string): Promise<QrRemoteControlStatus>;
  rotatePairing(): Promise<QrRemoteControlPairingIssue>;
  revokeSession(sessionId: string): Promise<QrRemoteControlStatus>;
  revokeAllSessions(): Promise<QrRemoteControlStatus>;
  disable(): Promise<QrRemoteControlStatus>;
}

export const qrRemoteControlApi: QrRemoteControlApi = {
  async status() {
    return normalizeQrRemoteControlStatus(
      await remoteControlManagementRequest(QR_REMOTE_CONTROL_PATHS.status),
    );
  },

  async interfaces() {
    return normalizeQrRemoteControlInterfaces(
      await remoteControlManagementRequest(QR_REMOTE_CONTROL_PATHS.interfaces),
    );
  },

  async enable(interfaceAddress: string) {
    return normalizeQrRemoteControlStatus(
      await remoteControlManagementRequest(QR_REMOTE_CONTROL_PATHS.enable, { interfaceAddress }),
    );
  },

  async rotatePairing() {
    return normalizeQrRemoteControlPairingIssue(
      await remoteControlManagementRequest(QR_REMOTE_CONTROL_PATHS.rotatePairing),
    );
  },

  async revokeSession(sessionId: string) {
    await remoteControlManagementRequest(QR_REMOTE_CONTROL_PATHS.revokeSession, { sessionId });
    return qrRemoteControlApi.status();
  },

  async revokeAllSessions() {
    await remoteControlManagementRequest(QR_REMOTE_CONTROL_PATHS.revokeSession, { all: true });
    return qrRemoteControlApi.status();
  },

  async disable() {
    return normalizeQrRemoteControlStatus(
      await remoteControlManagementRequest(QR_REMOTE_CONTROL_PATHS.disable),
    );
  },
};
