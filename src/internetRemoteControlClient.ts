import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './lib/env';
import {
  INTERNET_REMOTE_CONTROL_PATHS,
  normalizeInternetRemoteControllerOrigin,
  normalizeInternetRemoteControlEnableResponse,
  normalizeInternetRemoteControlStatusEnvelope,
  normalizeInternetRemoteControlStatusResponse,
  type InternetRemoteControlEnableResult,
  type InternetRemoteControlPath,
  type InternetRemoteControlStatus,
  type InternetRemoteControlStatusResponse,
} from './internetRemoteControlContract';

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
);

function responseError(payload: unknown, status: number): Error & { code?: string } {
  const body = asObject(payload);
  const message = typeof body?.error === 'string' && body.error.trim()
    ? body.error.trim()
    : typeof body?.message === 'string' && body.message.trim()
      ? body.message.trim()
      : `외부 인터넷 원격제어 요청에 실패했습니다. (${status})`;
  const error = new Error(message) as Error & { code?: string };
  if (typeof body?.code === 'string' && body.code.trim()) error.code = body.code.trim();
  return error;
}

async function request(path: InternetRemoteControlPath, body: JsonObject = {}): Promise<unknown> {
  let status: number;
  let payload: unknown;
  const useNativeBridge = isTauri() && String(import.meta.env.DEV) !== 'true';
  if (useNativeBridge) {
    // The installed app owns a bundled sidecar and proves the exact TCP peer
    // before sending its private capability. `tauri dev` instead shares the
    // source API launched by Vite's parent process, before Rust can hand it a
    // capability, so development uses Vite's same-origin /api proxy.
    const proxied = asObject(await invoke<unknown>('remote_control_management_request', {
      path,
      method: 'POST',
      body,
    }));
    const proxiedStatus = proxied?.status;
    if (!Number.isInteger(proxiedStatus)
      || (proxiedStatus as number) < 100
      || (proxiedStatus as number) > 599
      || !Object.prototype.hasOwnProperty.call(proxied ?? {}, 'body')) {
      throw new Error('외부 원격제어 sidecar 보안 응답을 확인하지 못했습니다.');
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
  if (status < 200 || status >= 300) throw responseError(payload, status);
  return payload;
}

function exactSessionId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error('외부 원격제어 세션 ID가 올바르지 않습니다.');
  }
  return value;
}

export interface InternetRemoteControlApi {
  status(): Promise<InternetRemoteControlStatusResponse>;
  enable(controllerOrigin: string): Promise<InternetRemoteControlEnableResult>;
  /** Mint one more single-use QR so another phone can connect. */
  issuePairing(): Promise<InternetRemoteControlEnableResult>;
  approveSession(
    sessionId: string,
    expectedSasCode: string,
    grantTaskScope: boolean,
    grantConversationScope?: boolean,
  ): Promise<InternetRemoteControlStatus>;
  updateSessionScopes(
    sessionId: string,
    grantTaskScope: boolean,
    grantConversationScope: boolean,
  ): Promise<InternetRemoteControlStatus>;
  revokeSession(sessionId: string): Promise<InternetRemoteControlStatus>;
  disable(): Promise<InternetRemoteControlStatus>;
}

export const internetRemoteControlApi: InternetRemoteControlApi = {
  async status() {
    return normalizeInternetRemoteControlStatusEnvelope(
      await request(INTERNET_REMOTE_CONTROL_PATHS.status),
    );
  },

  async enable(controllerOrigin: string) {
    const normalizedOrigin = normalizeInternetRemoteControllerOrigin(controllerOrigin);
    return normalizeInternetRemoteControlEnableResponse(
      await request(INTERNET_REMOTE_CONTROL_PATHS.enable, { controllerOrigin: normalizedOrigin }),
    );
  },

  async issuePairing() {
    return normalizeInternetRemoteControlEnableResponse(
      await request(INTERNET_REMOTE_CONTROL_PATHS.issuePairing, {}),
    );
  },

  async approveSession(
    sessionId: string,
    expectedSasCode: string,
    grantTaskScope: boolean,
    grantConversationScope = false,
  ) {
    if (!/^\d{6}$/u.test(expectedSasCode)) throw new Error('휴대폰과 일치하는 6자리 확인 코드가 필요합니다.');
    if (typeof grantTaskScope !== 'boolean') throw new Error('Codex 작업 권한 선택이 올바르지 않습니다.');
    if (typeof grantConversationScope !== 'boolean') throw new Error('지속형 대화 권한 선택이 올바르지 않습니다.');
    return normalizeInternetRemoteControlStatusResponse(
      await request(INTERNET_REMOTE_CONTROL_PATHS.approveSession, {
        sessionId: exactSessionId(sessionId),
        expectedSasCode,
        grantTaskScope,
        grantConversationScope,
      }),
    );
  },

  async revokeSession(sessionId: string) {
    return normalizeInternetRemoteControlStatusResponse(
      await request(INTERNET_REMOTE_CONTROL_PATHS.revokeSession, {
        sessionId: exactSessionId(sessionId),
      }),
    );
  },

  async updateSessionScopes(
    sessionId: string,
    grantTaskScope: boolean,
    grantConversationScope: boolean,
  ) {
    if (typeof grantTaskScope !== 'boolean') throw new Error('Codex 작업 권한 선택이 올바르지 않습니다.');
    if (typeof grantConversationScope !== 'boolean') throw new Error('지속형 대화 권한 선택이 올바르지 않습니다.');
    return normalizeInternetRemoteControlStatusResponse(
      await request(INTERNET_REMOTE_CONTROL_PATHS.updateSessionScopes, {
        sessionId: exactSessionId(sessionId),
        grantTaskScope,
        grantConversationScope,
      }),
    );
  },

  async disable() {
    return normalizeInternetRemoteControlStatusResponse(
      await request(INTERNET_REMOTE_CONTROL_PATHS.disable),
    );
  },
};
