import type { LocalOnboardingStatus } from './onboardingConnectionView';
import { ONBOARDING_TOOLS, type OnboardingToolsResponse } from './onboardingInfrastructure';

/** Each result includes JSON decoding in its deadline; a failed tools scan must
 * not discard a successful device read (or preserve an old green status). */
export async function readOnboardingDashboard(base: string, force: boolean, signal: AbortSignal, fetcher = fetch) {
  const read = async (path: string) => {
    const response = await fetcher(`${base}${path}`, { cache: 'no-store', signal });
    if (!response.ok) throw new Error('ONBOARDING_STATUS_UNAVAILABLE');
    return response.json();
  };
  const [tools, device] = await Promise.allSettled([
    read(`/api/onboarding/tools${force ? '?refresh=1' : ''}`).then((body: OnboardingToolsResponse) => {
      if (!body || !['mac', 'windows', 'linux'].includes(body.platform) || !Array.isArray(body.diagnostics)
        || !Number.isFinite(Date.parse(body.checkedAt))
        || (body.runtimeMode !== undefined && !['packaged', 'source', 'remote'].includes(body.runtimeMode))) throw new Error('ONBOARDING_TOOLS_INVALID');
      const states = ['ready', 'needs-login', 'missing', 'unknown', 'manual', 'not-applicable'];
      const ids = new Set(ONBOARDING_TOOLS.map(tool => tool.id));
      if (body.diagnostics.some(item => !item || typeof item !== 'object')) throw new Error('ONBOARDING_TOOLS_INVALID');
      body.diagnostics = body.diagnostics.filter(item => ids.has(item.id)).map(item => (
        states.includes(item.state) ? item : { id: item.id, state: 'unknown' }
      ));
      return body;
    }),
    read('/api/onboarding/status').then((body: LocalOnboardingStatus) => {
      if (!body || !['fresh', 'configured-unregistered', 'additional-pending', 'registered'].includes(body.stage)
        || typeof body.hasSupabaseConfig !== 'boolean' || typeof body.hasDeviceIdentity !== 'boolean'
        || typeof body.localAdminPresent !== 'boolean') throw new Error('ONBOARDING_DEVICE_INVALID');
      return body;
    }),
  ]);
  return {
    tools: tools.status === 'fulfilled' ? tools.value : null,
    device: device.status === 'fulfilled' ? device.value : null,
    incomplete: tools.status === 'rejected' || device.status === 'rejected',
  };
}
