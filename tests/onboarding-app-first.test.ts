import { describe, expect, test } from 'bun:test';
import { connectionSummary, toolReadiness } from '../src/onboardingConnectionView';
import { diagnoseOnboardingDevice } from '../src/onboardingDiagnosis';
import { readOnboardingDashboard } from '../src/onboardingDashboardClient';
import { buildPreparationHandoff } from '../src/onboardingAssistantHandoff';
import type { OnboardingProgress } from '../src/onboardingProgress';

const device = { ...diagnoseOnboardingDevice({ supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'public', deviceId: 'sample', localAdminPresent: true }),
  supabaseReachable: true, lastSuccessfulPushAt: '2026-09-13T00:00:00.000Z' };
const progress: OnboardingProgress = {
  schemaVersion: 1, recipeVersion: 1, runId: '00000000-0000-4000-8000-000000000001', revision: '00000000-0000-4000-8000-000000000002',
  platform: 'mac', updatedAt: '2026-09-13T00:00:00.000Z', operation: null,
  steps: [{ tool: 'codex', state: 'configured', checkedAt: '2026-09-13T00:00:00.000Z' }],
};

describe('app-first onboarding evidence and handoff', () => {
  test('historical push never overrides offline or unknown connectivity', () => {
    expect(connectionSummary(device, 'first').ready).toBe(true);
    expect(connectionSummary({ ...device, supabaseReachable: false }, 'first').ready).toBe(false);
    expect(connectionSummary({ ...device, supabaseReachable: null }, 'first').ready).toBe(false);
    expect(connectionSummary({ ...device, lastSuccessfulPushAt: 'bad date' }, 'first').ready).toBe(false);
    expect(connectionSummary(device, 'first').detail).toContain('별도로 확인');
  });
  test('AI version and cached login are not authenticated or task-ready evidence', () => {
    for (const id of ['codex', 'claude', 'hermes', 'antigravity'] as const) {
      expect(toolReadiness({ id, installed: true, state: 'ready' }).verified).toBe(false);
      expect(toolReadiness({ id, installed: true, authenticated: true, authenticationEvidence: 'cached', state: 'ready' }).verified).toBe(false);
    }
    expect(toolReadiness({ id: 'supabase', installed: true, authenticated: true, state: 'ready' }).label).toBe('설치·로그인 확인');
    expect(toolReadiness({ id: 'git', installed: true, state: 'ready' }).verified).toBe(true);
    expect(toolReadiness({ id: 'codex', state: 'ready' }).state).toBe('unknown');
  });
  test('failed tools JSON still keeps independent device evidence', async () => {
    const fetcher = (async (url: string) => url.includes('/tools') ? new Response('<html>old helper</html>') : Response.json(device)) as typeof fetch;
    const result = await readOnboardingDashboard('', true, new AbortController().signal, fetcher);
    expect(result.tools).toBeNull(); expect(result.device).toEqual(device); expect(result.incomplete).toBe(true);
  });
  test('failed device read does not discard successful tool scan', async () => {
    const tools = { platform: 'mac' as const, runtimeMode: 'packaged' as const, checkedAt: progress.updatedAt, cacheTtlMs: 1000, diagnostics: [] };
    const fetcher = (async (url: string) => url.includes('/tools') ? Response.json(tools) : new Response('', { status: 503 })) as typeof fetch;
    const result = await readOnboardingDashboard('', false, new AbortController().signal, fetcher);
    expect(result.tools).toEqual(tools); expect(result.device).toBeNull(); expect(result.incomplete).toBe(true);
  });
  test('future tool states become unknown rather than crashing or claiming readiness', async () => {
    const tools = { platform: 'mac', checkedAt: progress.updatedAt, diagnostics: [{ id: 'codex', state: 'future-success' }, { id: 'future-tool', state: 'ready' }] };
    const fetcher = (async (url: string) => Response.json(url.includes('/tools') ? tools : device)) as typeof fetch;
    const result = await readOnboardingDashboard('', false, new AbortController().signal, fetcher);
    expect(result.tools?.diagnostics).toEqual([{ id: 'codex', state: 'unknown' }]);
  });
  test('handoff resumes the existing run, never turns copy into successful evidence', () => {
    const before = JSON.stringify(progress);
    const prompt = buildPreparationHandoff(progress, 'chatgpt');
    expect(prompt).toContain(progress.runId); expect(prompt).toContain(progress.revision);
    expect(prompt).toContain('configured'); expect(prompt).toContain('AI 작업 후 다시 확인');
    expect(prompt).toContain('개발자의 Supabase'); expect(JSON.stringify(progress)).toBe(before);
    expect(() => buildPreparationHandoff({ ...progress, token: 'must-not-copy' } as OnboardingProgress, 'claude')).toThrow();
    const resumed = buildPreparationHandoff({ ...progress, revision: '00000000-0000-4000-8000-000000000003' }, 'claude');
    expect(resumed).toContain(progress.runId); expect(resumed).not.toContain(progress.revision);
  });
});
