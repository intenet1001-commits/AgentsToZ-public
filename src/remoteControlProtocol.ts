/** Browser-safe inner protocol identifier shared by LAN and Internet transports. */
export const REMOTE_CONTROL_PROTOCOL_VERSION = 'agentstoz-local-v7' as const;

/**
 * Capabilities returned by the authenticated, encrypted
 * `protocol.capabilities` read action. `session.ready` deliberately remains a
 * frozen v7 message: older controllers reject additive ready keys.
 *
 * Unknown, well-formed names are retained so a newer host can add a capability
 * without making an older portal reject the response. Callers enable only the
 * exact feature names they understand.
 */
export const REMOTE_CONTROL_SUPPORTED_FEATURE_LIMIT = 8;
export const REMOTE_CONTROL_SUPPORTED_FEATURE_NAME_MAX_LENGTH = 40;
export type RemoteControlSupportedFeature = string;

const REMOTE_CONTROL_SUPPORTED_FEATURE_RE = /^[a-z][a-z0-9.-]{0,39}$/;

export function normalizeRemoteControlSupportedFeatures(
  value: unknown,
): RemoteControlSupportedFeature[] {
  if (!Array.isArray(value) || value.length > REMOTE_CONTROL_SUPPORTED_FEATURE_LIMIT) {
    throw new Error('REMOTE_CONTROL_SUPPORTED_FEATURES_INVALID');
  }
  const features: string[] = [];
  const seen = new Set<string>();
  for (const feature of value) {
    if (typeof feature !== 'string'
      || feature.length > REMOTE_CONTROL_SUPPORTED_FEATURE_NAME_MAX_LENGTH
      || !REMOTE_CONTROL_SUPPORTED_FEATURE_RE.test(feature)
      || seen.has(feature)) {
      throw new Error('REMOTE_CONTROL_SUPPORTED_FEATURES_INVALID');
    }
    seen.add(feature);
    features.push(feature);
  }
  return features;
}

/**
 * How many phones may control one Mac at the same time.
 *
 * Lives here, not in remoteControlCore, because the desktop QR dialog states
 * the cap in its copy and remoteControlCore imports node:crypto — pulling that
 * into the browser bundle blanked the whole dialog (caught by the smoke run,
 * not by unit tests).
 *
 * Each session already carries its own opaque control-ID namespace, rate
 * window and in-flight guard, so holding several is bookkeeping rather than a
 * relaxed boundary. The cap exists so repeated pairings cannot grow memory
 * without bound.
 */
export const REMOTE_CONTROL_MAX_SESSIONS = 8;
