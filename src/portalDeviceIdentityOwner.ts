const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PortalIdentityRuntime = 'tauri' | 'web';

export interface ResolvePortalDeviceIdentityInput {
  runtime: PortalIdentityRuntime;
  portalDeviceId?: string | null;
  createId: () => string;
  getBrowserDeviceId: () => string;
}

export interface ResolvedPortalDeviceIdentity {
  deviceId: string;
  needsPersist: boolean;
}

function validDeviceId(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return UUID_RE.test(normalized) ? normalized : null;
}

/**
 * Keeps native and browser identities in separate authoritative stores.
 *
 * - Tauri: portal.json is authoritative; browser storage is never consulted.
 * - Browser/deployed web: portal-device-id is authoritative; a cached portal
 *   payload may be updated to match it, but can never replace it.
 */
export function resolvePortalDeviceIdentity(
  input: ResolvePortalDeviceIdentityInput,
): ResolvedPortalDeviceIdentity {
  const portalDeviceId = validDeviceId(input.portalDeviceId);

  if (input.runtime === 'tauri') {
    if (portalDeviceId) return { deviceId: portalDeviceId, needsPersist: false };
    const generated = validDeviceId(input.createId());
    if (!generated) throw new Error('새 Tauri device ID가 올바른 UUID가 아닙니다.');
    return { deviceId: generated, needsPersist: true };
  }

  const browserDeviceId = validDeviceId(input.getBrowserDeviceId());
  if (!browserDeviceId) throw new Error('브라우저 device ID가 올바른 UUID가 아닙니다.');
  return {
    deviceId: browserDeviceId,
    needsPersist: portalDeviceId !== browserDeviceId,
  };
}
