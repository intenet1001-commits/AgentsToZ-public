import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

test('secondary panels are lazy-loaded instead of inflating the initial app bundle', () => {
  expect(app).toContain("const PortalManager = lazy(() => import('./PortalManager'));");
  expect(app).toContain("const AiUsagePanel = lazy(() => import('./components/AiUsagePanel').then");
  expect(app).toContain("const GuideOverlay = lazy(() => import('./guide/GuideMode').then");
  expect(app).toContain("const ProjectMemoryPanel = lazy(() => import('./ProjectMemoryPanel').then");
  expect(app).toContain("const { projectMemoryApi } = await import('./ProjectMemoryPanel');");
  expect(app).toContain('const [portalHasMounted, setPortalHasMounted] = useState(false);');
});

test('portal state is retained after its first on-demand mount', () => {
  expect(app).toContain("activeTab === 'portal' || openPortalSettings");
  expect(app).toContain('portalHasMounted || activeTab === \'portal\' || openPortalSettings');
});
