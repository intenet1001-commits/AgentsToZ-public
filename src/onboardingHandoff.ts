export interface OnboardingHandoff {
  version: 1 | 2 | 3;
  supabaseUrl: string;
  supabaseAnonKey: string;
  deviceId?: string;
  deviceName?: string;
  passwordHash?: string;
  freshDeviceRequired?: boolean;
}

const SUPABASE_PROJECT_URL = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.supabase\.co$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Supabase의 legacy anon JWT와 신규 publishable key만 클라이언트 전달을 허용한다. */
export function isPublicSupabaseClientKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const key = value.trim();
  if (key.length > 8192) return false;
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return true;
  const parts = key.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
  try {
    const decode = (part: string) => {
      const encoded = part.replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
        Uint8Array.from(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')), c => c.charCodeAt(0)),
      ));
    };
    const header = decode(parts[0]!);
    const payload = decode(parts[1]!);
    // This is a disclosure guard, not JWT authentication. The selected Supabase
    // endpoint must still verify the key. In particular, never export service_role.
    return !!header && !Array.isArray(header) && header.alg === 'HS256'
      && !!payload && !Array.isArray(payload) && payload.role === 'anon';
  } catch { return false; }
}

export function createDesktopDeviceInvite(input: {
  supabaseUrl: string;
  supabaseAnonKey: string;
  suggestedDeviceName: string;
}): string {
  const url = input.supabaseUrl.trim();
  const key = input.supabaseAnonKey.trim();
  const deviceName = input.suggestedDeviceName.trim();
  if (!SUPABASE_PROJECT_URL.test(url)) throw new Error('URL 형식이 잘못되었습니다');
  if (!isPublicSupabaseClientKey(key)) throw new Error('Anon/publishable Key 형식이 잘못되었습니다');
  if (!deviceName) throw new Error('새 단말 이름을 입력하세요');
  return JSON.stringify({
    v: 3,
    type: 'portmgr-device-invite',
    url,
    key,
    deviceName,
  });
}

export function parseOnboardingHandoff(raw: string): OnboardingHandoff {
  if (typeof raw !== 'string' || raw.length > 16384) throw new Error('연결 정보가 너무 큽니다');
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('클립보드 내용이 JSON이 아닙니다');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('portmanager onboarding 형식이 아닙니다');
  }

  const isV1 = payload.v === 1 && payload.type === 'portmanager-setup';
  const isV2 = payload.v === 2 && payload.type === 'portmgr-onboard';
  const isV3 = payload.v === 3 && payload.type === 'portmgr-device-invite';
  if (!isV1 && !isV2 && !isV3) {
    throw new Error('portmanager onboarding 형식이 아닙니다');
  }

  const url = typeof payload.url === 'string' ? payload.url.trim() : '';
  const key = typeof payload.key === 'string' ? payload.key.trim() : '';
  if (!SUPABASE_PROJECT_URL.test(url)) {
    throw new Error('URL 형식이 잘못되었습니다');
  }
  if (!isPublicSupabaseClientKey(key)) {
    throw new Error('Anon/publishable Key 형식이 잘못되었습니다');
  }

  const rawDeviceId = isV3 ? undefined : isV2 ? payload.deviceId : payload.device;
  const deviceId = typeof rawDeviceId === 'string' ? rawDeviceId.trim() : '';
  if (deviceId && !UUID.test(deviceId)) {
    throw new Error('단말 ID 형식이 잘못되었습니다');
  }
  const deviceName = typeof payload.deviceName === 'string' ? payload.deviceName.trim() : '';
  const passwordHash = isV1 && typeof payload.pwHash === 'string' ? payload.pwHash : '';

  return {
    version: isV3 ? 3 : isV2 ? 2 : 1,
    supabaseUrl: url,
    supabaseAnonKey: key,
    ...(deviceId ? { deviceId } : {}),
    ...(deviceName ? { deviceName } : {}),
    ...(passwordHash ? { passwordHash } : {}),
    ...(isV3 ? { freshDeviceRequired: true } : {}),
  };
}
