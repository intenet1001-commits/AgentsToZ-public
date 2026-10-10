import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

test('secondary panels are lazy-loaded instead of inflating the initial app bundle', () => {
  // 북마크 탭은 유휴 시간에 미리 받지만(src/lazyTabPreload.ts) 여전히 동적 import 다 — 초기 번들에 들지 않는다.
  expect(app).toContain("const portalManagerModule = preloadableModule(() => import('./PortalManager'));");
  expect(app).toContain('const PortalManager = lazy(portalManagerModule.factory);');
  // `import type`은 컴파일 때 지워지므로 번들에 들지 않는다 — 값 import만 막는다.
  expect(app).not.toMatch(/^import\s+(?!type\b)[^;]*from\s+['"]\.\/PortalManager['"]/m);
  expect(app).toContain('useEffect(() => scheduleIdlePreload(IDLE_PRELOADED_TABS), []);');
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
