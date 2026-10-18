// Isolated UI fixture: no real account, CLI, device or remote service access.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OnboardingProgressStore } from '../src/onboardingProgressStore';
import { handleOnboardingProgress } from '../src/onboardingProgressHttp';
import { diagnoseOnboardingDevice } from '../src/onboardingDiagnosis';
import type { OnboardingToolDiagnostic } from '../src/onboardingInfrastructure';
const dir = mkdtempSync(join(tmpdir(), 'onboarding-preview-'));
const store = new OnboardingProgressStore(dir);
const built = await Bun.build({ entrypoints: ['tests/fixtures/onboarding-infrastructure/panel.tsx'], target: 'browser', format: 'esm', define: { 'process.env.NODE_ENV': '"development"' } });
if (!built.success) throw new Error('Fixture build failed');
const js = await built.outputs[0]!.text();
const css = process.env.ONBOARDING_UI_CSS ? await Bun.file(process.env.ONBOARDING_UI_CSS).text() : '';
let failed = false;
const diagnostics: OnboardingToolDiagnostic[] = [
  { id: 'api', installed: true, state: 'ready' },
  { id: 'git', installed: true, state: 'ready' },
  { id: 'supabase', installed: true, authenticated: true, state: 'ready' },
  { id: 'codex', installed: true, authenticated: true, authenticationEvidence: 'cached', state: 'ready' },
  { id: 'claude', installed: true, state: 'ready' },
  { id: 'vercel', installed: true, state: 'unknown' },
];
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async req => {
  const path = new URL(req.url).pathname;
  if (path === '/__fixture/failure' && req.method === 'POST') { failed = !failed; return Response.json({ failed }); }
  if (path === '/api/onboarding/progress') return handleOnboardingProgress(req, { store: () => store, platform: 'mac', diagnose: async () => diagnostics });
  if (path === '/api/onboarding/tools') return failed ? new Response('unavailable', { status: 503 }) : Response.json({ platform: 'mac', runtimeMode: 'packaged', checkedAt: new Date().toISOString(), cacheTtlMs: 30_000, diagnostics });
  if (path === '/api/onboarding/status') return failed ? new Response('unavailable', { status: 503 }) : Response.json({
    ...diagnoseOnboardingDevice({ supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'sample-public', deviceId: 'sample', localAdminPresent: true }),
    deviceName: 'Example Mac · test user', supabaseReachable: true, lastSuccessfulPushAt: '2026-09-13T00:00:00.000Z',
  });
  if (path === '/panel.js') return new Response(js, { headers: { 'Content-Type': 'text/javascript' } });
  return new Response(`<html data-app-theme="dark"><head><style>${css}</style><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/panel.js"></script></body></html>`, { headers: { 'Content-Type': 'text/html' } });
} });
console.log(`ONBOARDING_PREVIEW=http://127.0.0.1:${server.port}`);
function close() { server.stop(true); store.close(); rmSync(dir, { recursive: true, force: true }); process.exit(0); }
process.on('SIGINT', close); process.on('SIGTERM', close);
