import {isPublicSupabaseClientKey} from './onboardingHandoff';
import type {RemoteControlRelaySupabaseConfig} from './remoteControlRelayContract';

/**
 * The Supabase project to put in a remote-control QR. Only the PUBLIC key may leave the Mac:
 * it must pass the anon/publishable check (which decodes a JWT's role) and must not equal the
 * service_role key. Anything doubtful returns null and the QR omits it (web-portal fallback).
 */
export function pairingSupabaseConfig(portal: Record<string, unknown> | null, serviceRoleKey: string | null, normalizeUrl: (raw: string) => string): RemoteControlRelaySupabaseConfig | null {
  if (!portal) return null;
  const rawUrl = typeof portal.supabaseUrl === 'string' ? portal.supabaseUrl.trim() : '';
  const anonKey = typeof portal.supabaseAnonKey === 'string' ? portal.supabaseAnonKey.trim() : '';
  if (!rawUrl || !isPublicSupabaseClientKey(anonKey) || (serviceRoleKey && anonKey === serviceRoleKey.trim())) return null;
  try {
    const url = new URL(normalizeUrl(rawUrl));
    return url.protocol === 'https:' ? {url: url.origin, anonKey} : null;
  } catch {
    return null;
  }
}
