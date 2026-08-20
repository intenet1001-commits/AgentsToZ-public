import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { VocRecord } from './src/vocAnchor';

export const DEFAULT_VOC_DAILY_LIMIT = 10;
export const MAX_VOC_DAILY_LIMIT = 100;
export const MAX_VOC_COMMENT_LENGTH = 4_000;
export const VOC_INSTALLATION_FILENAME = 'voc-installation.json';
/** Public by design. Forks may override it or set VITE_VOC_ENDPOINT=off. */
export const OFFICIAL_VOC_ENDPOINT = 'https://fvkmkqhavlqmltowwpfc.supabase.co/functions/v1/submit-voc';

export type VocDelivery =
  | { status: 'sent'; remaining: number; dailyLimit: number }
  | { status: 'rate_limited'; remaining: 0; dailyLimit: number }
  | { status: 'disabled'; dailyLimit?: number }
  | { status: 'blocked'; scope: 'voc' | 'app'; dailyLimit?: number }
  | { status: 'unconfigured' }
  | { status: 'failed'; error: string };

const configuredEndpointCandidate = (env: NodeJS.ProcessEnv): string => {
  const override = env.AGENTSTOZ_VOC_ENDPOINT ?? env.VITE_VOC_ENDPOINT;
  if (typeof override === 'string' && override.trim().toLowerCase() === 'off') return '';
  return String(override ?? OFFICIAL_VOC_ENDPOINT).trim();
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
