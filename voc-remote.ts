import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { VocRecord } from './src/vocAnchor';

export const DEFAULT_VOC_DAILY_LIMIT = 10;
export const MAX_VOC_DAILY_LIMIT = 100;
export const MAX_VOC_COMMENT_LENGTH = 4_000;
export const VOC_INSTALLATION_FILENAME = 'voc-installation.json';

export type VocDelivery =
  | { status: 'sent'; remaining: number; dailyLimit: number }
  | { status: 'sent'; unlimited: true }
  | { status: 'rate_limited'; remaining: 0; dailyLimit: number }
  | { status: 'disabled'; dailyLimit?: number }
  | { status: 'blocked'; scope: 'voc' | 'app'; dailyLimit?: number }
  | { status: 'unconfigured' }
  | { status: 'failed'; error: string };

const configuredEndpointCandidate = (env: NodeJS.ProcessEnv): string => {
  const override = env.AGENTSTOZ_VOC_ENDPOINT ?? env.VITE_VOC_ENDPOINT;
  if (typeof override === 'string' && override.trim().toLowerCase() === 'off') return '';
  return String(override ?? '').trim();
};

export function normalizeVocEndpoint(candidate: string): string | null {
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname.replace(/\/+$/, '') !== '/functions/v1/submit-voc') return null;
    return `${url.origin}/functions/v1/submit-voc`;
  } catch {
    return null;
  }
}

export function configuredVocEndpoint(env: NodeJS.ProcessEnv = process.env): string | null {
  return normalizeVocEndpoint(configuredEndpointCandidate(env));
}

export function vocReceiverSupabaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const endpoint = configuredVocEndpoint(env);
  return endpoint ? new URL(endpoint).origin : null;
}

function normalizeSupabaseProjectOrigin(candidate: string): string | null {
  try {
    const url = new URL(candidate.trim());
    if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname.replace(/\/+$/, '') !== '') return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 관리자 우회는 저장소 이름이나 기기 이름이 아니라 **정확한 receiver 프로젝트**에만 묶는다.
 * GitHub owner 문자열은 누구나 로컬에서 바꿀 수 있고, 다른 Supabase 프로젝트의
 * service_role도 이 수집함의 관리자 증거가 될 수 없다.
 */
export function isVocReceiverProject(
  portalSupabaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const receiver = vocReceiverSupabaseUrl(env);
  return !!receiver
    && normalizeSupabaseProjectOrigin(portalSupabaseUrl) === normalizeSupabaseProjectOrigin(receiver);
}

export function readOrCreateVocInstallationId(appDataDir: string): string {
  const path = join(appDataDir, VOC_INSTALLATION_FILENAME);
  if (existsSync(path)) {
    try {
      const id = String(JSON.parse(readFileSync(path, 'utf8'))?.installationId ?? '').trim();
      if (/^[0-9a-f-]{36}$/i.test(id)) return id;
    } catch { /* replace malformed local identity */ }
  }
  mkdirSync(dirname(path), { recursive: true });
  const installationId = crypto.randomUUID();
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify({ installationId })}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return installationId;
}

const shortError = (value: unknown): string =>
  (value instanceof Error ? value.message : String(value)).replace(/\s+/g, ' ').trim().slice(0, 240) || 'unknown error';

export async function submitRemoteVoc(params: {
  appDataDir: string;
  record: VocRecord;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<VocDelivery> {
  const endpoint = configuredVocEndpoint(params.env);
  if (!endpoint) return { status: 'unconfigured' };
  try {
    const response = await (params.fetchImpl ?? fetch)(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Info': 'AgentsToZ_byCS' },
      body: JSON.stringify({
        installationId: readOrCreateVocInstallationId(params.appDataDir),
        record: params.record,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    const dailyLimit = Math.max(1, Math.min(MAX_VOC_DAILY_LIMIT, Number(body.dailyLimit) || DEFAULT_VOC_DAILY_LIMIT));
    if (response.status === 429 || body.reason === 'rate_limited') {
      return { status: 'rate_limited', remaining: 0, dailyLimit };
    }
    if (body.reason === 'disabled') return { status: 'disabled', dailyLimit };
    if (body.reason === 'voc_blocked' || body.reason === 'app_blocked') {
      return { status: 'blocked', scope: body.reason === 'app_blocked' ? 'app' : 'voc', dailyLimit };
    }
    if (!response.ok || body.accepted !== true) {
      return { status: 'failed', error: `HTTP ${response.status}` };
    }
    return {
      status: 'sent',
      dailyLimit,
      remaining: Math.max(0, Math.min(dailyLimit, Number(body.remaining) || 0)),
    };
  } catch (error) {
    return { status: 'failed', error: shortError(error) };
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * receiver 프로젝트의 service_role을 가진 로컬 관리자만 쓰는 무제한 경로.
 * 브라우저나 Edge Function에는 키를 건네지 않고 로컬 sidecar가 service-role 전용 RPC를
 * 직접 호출한다. 공개 설치본은 이 함수에 도달할 자격증명이 없어 기존 한도를 그대로 쓴다.
 */
export async function submitUnlimitedVoc(params: {
  appDataDir: string;
  record: VocRecord;
  serviceRoleKey: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<VocDelivery> {
  const baseUrl = vocReceiverSupabaseUrl(params.env);
  if (!baseUrl) return { status: 'unconfigured' };
  try {
    const installationId = readOrCreateVocInstallationId(params.appDataDir);
    const response = await (params.fetchImpl ?? fetch)(`${baseUrl}/rest/v1/rpc/portmgr_submit_voc_admin`, {
      method: 'POST',
      headers: serviceHeaders(params.serviceRoleKey),
      body: JSON.stringify({
        p_id: params.record.id,
        p_device_hash: await sha256Hex(installationId),
        p_app_version: params.record.appVersion,
        p_tab: params.record.tab,
        p_anchor: params.record.anchor,
        p_comment: params.record.comment,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => null) as unknown;
    const row = Array.isArray(body) ? body[0] : body as Record<string, unknown> | null;
    const reason = String(row?.reason ?? '');
    if (reason === 'disabled') return { status: 'disabled' };
    if (reason === 'voc_blocked' || reason === 'app_blocked') {
      return { status: 'blocked', scope: reason === 'app_blocked' ? 'app' : 'voc' };
    }
    if (!response.ok || row?.accepted !== true) {
      return { status: 'failed', error: `관리자 VOC 저장 실패 (HTTP ${response.status})` };
    }
    return { status: 'sent', unlimited: true };
  } catch (error) {
    return { status: 'failed', error: shortError(error) };
  }
}

export interface VocRemoteAccess {
  configured: boolean;
  blocked: boolean;
  scope: 'voc' | 'app' | null;
  expiresAt?: string;
}

export async function checkRemoteVocAccess(params: {
  appDataDir: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<VocRemoteAccess> {
  const endpoint = configuredVocEndpoint(params.env);
  if (!endpoint) return { configured: false, blocked: false, scope: null };
  const response = await (params.fetchImpl ?? fetch)(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client-Info': 'AgentsToZ_byCS' },
    body: JSON.stringify({
      action: 'check',
      installationId: readOrCreateVocInstallationId(params.appDataDir),
    }),
    signal: AbortSignal.timeout(8_000),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(`VOC 접근 상태 확인 실패 (HTTP ${response.status})`);
  const scope = body.scope === 'app' ? 'app' : body.scope === 'voc' ? 'voc' : null;
  return {
    configured: true,
    blocked: body.blocked === true && scope !== null,
    scope,
    expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : undefined,
  };
}

export interface VocAdminSettings {
  configured: boolean;
  accepting: boolean;
  dailyLimit: number;
  updatedAt?: string;
}

/** receiver URL 일치 + 실제 service_role REST 접근 성공을 모두 확인한다. */
export async function verifyVocAdminContext(params: {
  portalSupabaseUrl: string;
  serviceRoleKey: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  if (!params.serviceRoleKey.trim() || !isVocReceiverProject(params.portalSupabaseUrl, params.env)) return false;
  try {
    const settings = await loadVocAdminSettings({
      serviceRoleKey: params.serviceRoleKey,
      env: params.env,
      fetchImpl: params.fetchImpl,
    });
    return settings.configured === true;
  } catch {
    return false;
  }
}

function serviceHeaders(serviceRoleKey: string): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };
}

export async function loadVocAdminSettings(params: {
  serviceRoleKey: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<VocAdminSettings> {
  const baseUrl = vocReceiverSupabaseUrl(params.env);
  if (!baseUrl) return { configured: false, accepting: false, dailyLimit: DEFAULT_VOC_DAILY_LIMIT };
  const response = await (params.fetchImpl ?? fetch)(
    `${baseUrl}/rest/v1/portmgr_voc_settings?id=eq.default&select=accepting,daily_device_limit,updated_at`,
    { headers: serviceHeaders(params.serviceRoleKey), signal: AbortSignal.timeout(10_000) },
  );
  const rows = await response.json().catch(() => []) as Array<Record<string, unknown>>;
  if (!response.ok || !rows[0]) throw new Error(`VOC 설정 조회 실패 (HTTP ${response.status})`);
  return {
    configured: true,
    accepting: rows[0].accepting === true,
    dailyLimit: Number(rows[0].daily_device_limit) || DEFAULT_VOC_DAILY_LIMIT,
    updatedAt: typeof rows[0].updated_at === 'string' ? rows[0].updated_at : undefined,
  };
}

export async function updateVocAdminSettings(params: {
  serviceRoleKey: string;
  accepting: boolean;
  dailyLimit: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<VocAdminSettings> {
  const baseUrl = vocReceiverSupabaseUrl(params.env);
  if (!baseUrl) throw new Error('VOC 수집 엔드포인트가 빌드에 설정되지 않았습니다.');
  const dailyLimit = Math.trunc(Number(params.dailyLimit));
  if (dailyLimit < 1 || dailyLimit > MAX_VOC_DAILY_LIMIT) {
    throw new Error(`하루 전송 한도는 1~${MAX_VOC_DAILY_LIMIT} 사이여야 합니다.`);
  }
  const response = await (params.fetchImpl ?? fetch)(`${baseUrl}/rest/v1/portmgr_voc_settings?id=eq.default`, {
    method: 'PATCH',
    headers: { ...serviceHeaders(params.serviceRoleKey), Prefer: 'return=representation' },
    body: JSON.stringify({ accepting: params.accepting, daily_device_limit: dailyLimit, updated_at: new Date().toISOString() }),
    signal: AbortSignal.timeout(10_000),
  });
  const rows = await response.json().catch(() => []) as Array<Record<string, unknown>>;
  if (!response.ok || !rows[0]) throw new Error(`VOC 설정 저장 실패 (HTTP ${response.status})`);
  return {
    configured: true,
    accepting: rows[0].accepting === true,
    dailyLimit: Number(rows[0].daily_device_limit) || dailyLimit,
    updatedAt: typeof rows[0].updated_at === 'string' ? rows[0].updated_at : undefined,
  };
}

export async function upsertVocDeviceBlock(params: {
  serviceRoleKey: string;
  deviceHash: string;
  scope: 'voc' | 'app';
  operatorNote?: string;
  expiresAt?: string | null;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const baseUrl = vocReceiverSupabaseUrl(params.env);
  if (!baseUrl) throw new Error('VOC 수집 엔드포인트가 빌드에 설정되지 않았습니다.');
  const deviceHash = params.deviceHash.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(deviceHash)) throw new Error('단말 해시는 64자리 16진수여야 합니다.');
  const expiresAt = params.expiresAt?.trim() || null;
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) throw new Error('차단 만료 시각이 올바르지 않습니다.');
  const response = await (params.fetchImpl ?? fetch)(`${baseUrl}/rest/v1/portmgr_voc_blocklist?on_conflict=device_hash`, {
    method: 'POST',
    headers: { ...serviceHeaders(params.serviceRoleKey), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      device_hash: deviceHash,
      scope: params.scope,
      operator_note: String(params.operatorNote ?? '').trim().slice(0, 500),
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`단말 차단 저장 실패 (HTTP ${response.status})`);
}

export async function removeVocDeviceBlock(params: {
  serviceRoleKey: string;
  deviceHash: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const baseUrl = vocReceiverSupabaseUrl(params.env);
  if (!baseUrl) throw new Error('VOC 수집 엔드포인트가 빌드에 설정되지 않았습니다.');
  const deviceHash = params.deviceHash.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(deviceHash)) throw new Error('단말 해시는 64자리 16진수여야 합니다.');
  const response = await (params.fetchImpl ?? fetch)(
    `${baseUrl}/rest/v1/portmgr_voc_blocklist?device_hash=eq.${deviceHash}`,
    {
      method: 'DELETE',
      headers: serviceHeaders(params.serviceRoleKey),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) throw new Error(`단말 차단 해제 실패 (HTTP ${response.status})`);
}
