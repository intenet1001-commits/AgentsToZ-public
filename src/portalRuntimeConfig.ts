/**
 * The portal normally learns its Supabase project from the web build (VITE_*) and treats its
 * own address as the portal address. When the iPhone app bundles the portal it serves it from
 * `agentstoz-app://portal/`, so the app injects both instead:
 *
 *   window.agentstozBundledPortal = { portalOrigin, supabaseUrl, supabaseAnonKey }
 *
 * `portalOrigin` is the https portal the QR was issued for; pairing and the QR scanner compare
 * against it exactly as the web page compares against its own origin. Values come from the Mac's
 * QR (public anon key only). Anything malformed is ignored and the page falls back to the build.
 */
export interface PortalRuntimeConfig {
  portalOrigin: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
}

const httpsOrigin = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length > 256) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash && value === url.origin ? url.origin : null;
  } catch {
    return null;
  }
};
const PUBLIC_KEY = /^(?:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|sb_publishable_[A-Za-z0-9_-]+)$/;

export function readPortalRuntimeConfig(target: unknown = typeof window === 'undefined' ? undefined : window): PortalRuntimeConfig | null {
  const raw = (target as { agentstozBundledPortal?: unknown } | undefined)?.agentstozBundledPortal;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'portalOrigin,supabaseAnonKey,supabaseUrl') return null;
  const portalOrigin = httpsOrigin(value.portalOrigin);
  const supabaseUrl = httpsOrigin(value.supabaseUrl);
  const key = value.supabaseAnonKey;
  if (!portalOrigin || !supabaseUrl || typeof key !== 'string' || key.length < 20 || key.length > 1024 || !PUBLIC_KEY.test(key)) return null;
  return Object.freeze({ portalOrigin, supabaseUrl, supabaseAnonKey: key });
}

const RUNTIME = readPortalRuntimeConfig();

/** True inside the iPhone app's bundled portal. */
export const PORTAL_IS_BUNDLED = RUNTIME !== null;
export const PORTAL_SUPABASE_URL = RUNTIME?.supabaseUrl ?? ((import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() ?? '');
export const PORTAL_SUPABASE_ANON_KEY = RUNTIME?.supabaseAnonKey ?? ((import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() ?? '');

/** The https portal address this page acts for: its own origin on the web, the QR's in the app. */
export function portalOrigin(): string {
  return RUNTIME?.portalOrigin ?? window.location.origin;
}
