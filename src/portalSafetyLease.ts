import { isDeployedWeb, isTauri } from './lib/env';
import {
  portalLocalMetadataFingerprint,
  runPortalDataWriteExclusive,
} from './portalLocalMetadata';

export interface PortalSafetyLease {
  metadata: Record<string, unknown>;
  fingerprint: string;
}

interface PortalSafetyLeaseOptions {
  deployedWeb?: boolean;
  tauri?: boolean;
  fetchImpl?: typeof fetch;
  onReleaseError?: (error: unknown) => void;
  /** Test-only timing override; production derives a bounded cadence from the server TTL. */
  renewIntervalMs?: number;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function leaseTtlMs(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 100 && Number(value) <= 86_400_000
    ? Number(value)
    : null;
}

function renewalDelayMs(expiresInMs: number, override: number | undefined): number {
  if (override !== undefined) {
    if (!Number.isSafeInteger(override) || override < 1) {
      throw new Error('프로젝트 숨김 안전 잠금 갱신 간격이 올바르지 않습니다.');
    }
    return override;
  }
  return Math.max(1_000, Math.min(30_000, Math.floor(expiresInMs / 3)));
}

async function runWithPortalSafetyLease<T>(
  portalData: unknown,
  operation: (lease: PortalSafetyLease) => T | Promise<T>,
  options: PortalSafetyLeaseOptions,
): Promise<T> {
  const deployedWeb = options.deployedWeb ?? isDeployedWeb();
  if (deployedWeb) {
    const metadata = objectRecord(portalData) ?? {};
    return operation({
      metadata,
      fingerprint: portalLocalMetadataFingerprint(metadata),
    });
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.tauri ?? isTauri()) ? 'http://127.0.0.1:3001' : '';
  const acquireResponse = await fetchImpl(`${baseUrl}/api/portal/safety-lease/acquire`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!acquireResponse.ok) {
    throw new Error(`프로젝트 숨김 안전 잠금을 얻지 못했습니다 (HTTP ${acquireResponse.status}).`);
  }

  const payload = objectRecord(await acquireResponse.json().catch(() => null));
  const token = typeof payload?.token === 'string' ? payload.token : '';
  if (!/^[0-9a-f]{64}$/.test(token)) {
    throw new Error('프로젝트 숨김 안전 잠금 응답이 올바르지 않습니다. 실행 중인 AgentsToZ를 업데이트해 주세요.');
  }

  const renewalState: { ownershipError: Error | null } = { ownershipError: null };
  try {
    const metadata = objectRecord(payload?.metadata);
    const fingerprint = typeof payload?.fingerprint === 'string' ? payload.fingerprint : '';
    const expiresInMs = leaseTtlMs(payload?.expiresInMs);
    if (payload?.success !== true || !metadata || !fingerprint || expiresInMs === null) {
      throw new Error('프로젝트 숨김 안전 잠금 응답이 올바르지 않습니다. 실행 중인 AgentsToZ를 업데이트해 주세요.');
    }
    if (portalLocalMetadataFingerprint(metadata) !== fingerprint) {
      throw new Error('프로젝트 숨김 안전정보가 잠금 응답과 일치하지 않습니다.');
    }

    const renewEveryMs = renewalDelayMs(expiresInMs, options.renewIntervalMs);
    const retryEveryMs = Math.min(renewEveryMs, 5_000);
    let stopped = false;
    let renewalTimer: ReturnType<typeof setTimeout> | null = null;
    let renewalInFlight: Promise<void> | null = null;
    let retryAfterFailure = false;

    const scheduleRenewal = (delayMs: number) => {
      if (stopped || renewalState.ownershipError) return;
      renewalTimer = setTimeout(() => {
        renewalTimer = null;
        renewalInFlight = (async () => {
          try {
            const renewResponse = await fetchImpl(`${baseUrl}/api/portal/safety-lease/renew`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token }),
            });
            const renewPayload = objectRecord(await renewResponse.json().catch(() => null));
            const renewedTtlMs = leaseTtlMs(renewPayload?.expiresInMs);
            if (!renewResponse.ok || renewPayload?.success !== true || typeof renewPayload.renewed !== 'boolean' || renewedTtlMs === null) {
              throw new Error(
                renewResponse.ok
                  ? '프로젝트 숨김 안전 잠금 갱신 응답이 올바르지 않습니다.'
                  : `프로젝트 숨김 안전 잠금 갱신 HTTP ${renewResponse.status}`,
              );
            }
            if (!renewPayload.renewed) {
              renewalState.ownershipError = new Error('프로젝트 숨김 안전 잠금이 작업 중 만료되었거나 소유권을 잃었습니다.');
              return;
            }
            retryAfterFailure = false;
          } catch {
            // A short network interruption need not surrender a still-owned
            // lease. Retry well inside the server TTL; release remains the
            // final ownership check if the operation finishes first.
            retryAfterFailure = true;
          }
        })().finally(() => {
          renewalInFlight = null;
          if (!stopped && !renewalState.ownershipError) {
            scheduleRenewal(retryAfterFailure ? retryEveryMs : renewEveryMs);
          }
        });
      }, delayMs);
    };

    scheduleRenewal(renewEveryMs);
    try {
      return await operation({ metadata, fingerprint });
    } finally {
      stopped = true;
      if (renewalTimer) clearTimeout(renewalTimer);
      // Do not race a late renew against release. A renew that started while
      // the operation still held the lease must settle before token teardown.
      if (renewalInFlight) await renewalInFlight;
    }
  } finally {
    try {
      const releaseResponse = await fetchImpl(`${baseUrl}/api/portal/safety-lease/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const releasePayload = objectRecord(await releaseResponse.json().catch(() => null));
      if (!releaseResponse.ok || releasePayload?.released !== true) {
        options.onReleaseError?.(new Error(
          renewalState.ownershipError?.message ?? (releaseResponse.ok
            ? '프로젝트 숨김 안전 잠금이 작업 완료 전에 만료되었거나 소유권을 잃었습니다.'
            : `프로젝트 숨김 안전 잠금 해제 HTTP ${releaseResponse.status}`),
        ));
      } else if (renewalState.ownershipError) {
        options.onReleaseError?.(renewalState.ownershipError);
      }
    } catch (error) {
      // The server also expires leases. A release response can be lost after
      // the protected mutation committed, so never turn success into a false
      // failure; report it and let the bounded expiry recover the lock.
      options.onReleaseError?.(renewalState.ownershipError ?? error);
    }
  }
}

/**
 * Serialize renderer mutations with portal.json marker writes in every local
 * process. The deployed portal has no local sidecar/marker file and therefore
 * uses its already-loaded configuration without attempting a localhost lease.
 */
export async function withPortalSafetyLease<T>(
  portalData: unknown,
  operation: (lease: PortalSafetyLease) => T | Promise<T>,
  options: PortalSafetyLeaseOptions = {},
): Promise<T> {
  return runPortalDataWriteExclusive(
    () => runWithPortalSafetyLease(portalData, operation, options),
  );
}
