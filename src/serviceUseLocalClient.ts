import { isTauri } from './lib/env';
import { localWorkroomTransport } from './aiTerminalClient';

/** This Mac's /api/service-memory routes. A phone or another device's channel never calls them. */
export async function postServiceUse(action: string, body: Record<string, unknown>) {
  const response = await fetch(`${isTauri() ? 'http://127.0.0.1:3001' : ''}/api/service-memory/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || result.success !== true) throw Error(result.error || 'USE 준비 상태를 확인하지 못했습니다.');
  return result;
}

/** The code says which installed connector issued it, not the project's display name. A code with neither prefix keeps the old name rule. */
export function serviceUseConnectRoute(code: string, projectName: string): 'connect-shadowloop' | 'connect-app' {
  const value = code.trim();
  return value.startsWith('SLUSE1.') ? 'connect-shadowloop' : value.startsWith('ATZUSE1.') ? 'connect-app' : projectName.toLowerCase() === 'shadowloop' ? 'connect-shadowloop' : 'connect-app';
}

/** Approved phone names for the exact current app scope (Mac-local status). Never part of execution identity. */
export async function localUsePhones(portId: string, serviceKey: string): Promise<{ id: string; name: string }[]> {
  const result = await postServiceUse('use-status', { portId, serviceKey });
  if (!Array.isArray(result.phones)) return [];
  return result.phones.slice(0, 256).filter((p: unknown): p is { id: string; name: string } => !!p && typeof p === 'object'
    && typeof (p as { id?: unknown }).id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test((p as { id: string }).id)
    && typeof (p as { name?: unknown }).name === 'string' && !!(p as { name: string }).name.trim())
    .map((p: { id: string; name: string }) => ({ id: p.id, name: p.name.slice(0, 80) }));
}

/**
 * Phone names only for a conversation that runs on this Mac's own Workroom transport (the local owner). A phone's,
 * another Mac's or a test transport gets none, so its form keeps the free-text ID field.
 */
export function localUsePhonesFor(transport: unknown): typeof localUsePhones | undefined {
  return transport === localWorkroomTransport ? localUsePhones : undefined;
}
