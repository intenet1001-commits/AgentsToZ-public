import { normalizeHttpsExactOrigin } from './portalDeployUrl';

/**
 * The public AgentsToZ web client. It is the controller origin a Mac uses when
 * its owner has no web portal of their own (「앱으로만 원격제어」).
 *
 * Why an origin is still needed at all: the relay pairing URL is
 * `<origin>/remote/#<bootstrap>`, and the iPhone app keys its bundled portal
 * (`portalOrigin`, WK store key `bundled:<origin>`) by that origin. The app
 * never loads this address — it opens its own bundled portal with the QR's
 * `supabase` bootstrap, so every self-hosted Mac that shares this default still
 * lands on its *own* Supabase. Only a phone CAMERA scan opens the web page, and
 * that page refuses a QR whose Supabase is not its own (`portalForeignPairing`).
 *
 * Keep this the only place the literal lives.
 */
export const DEFAULT_REMOTE_CONTROLLER_ORIGIN = 'https://agentstoz-guide.vercel.app';

export function isDefaultRemoteControllerOrigin(value: unknown): boolean {
  return normalizeHttpsExactOrigin(value) === DEFAULT_REMOTE_CONTROLLER_ORIGIN;
}

/**
 * The origin an enable request should use: what the operator typed, else the
 * web portal this Mac already knows about, else the public default. A value
 * that was supplied but is not an exact HTTPS origin is NOT silently replaced —
 * it returns null so the caller rejects it.
 */
export function resolveRemoteControllerOrigin(
  requested: unknown,
  configured: string | null,
): string | null {
  if (requested !== undefined && requested !== null && !(typeof requested === 'string' && requested.trim() === '')) {
    return normalizeHttpsExactOrigin(requested);
  }
  return normalizeHttpsExactOrigin(configured) ?? DEFAULT_REMOTE_CONTROLLER_ORIGIN;
}
