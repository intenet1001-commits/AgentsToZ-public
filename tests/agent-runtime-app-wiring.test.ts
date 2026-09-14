import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

describe('agent runtime App wiring', () => {
  test('lazy-loads Runtime immediately after Projects in the keyboard tab order', () => {
    expect(appSource).toContain(
      "const AgentRuntimePanel = lazy(() => import('./AgentRuntimePanel')",
    );
    expect(appSource).toContain(
      "const TOP_LEVEL_TABS: readonly TopLevelTab[] = ['ports', 'runtime', 'terminal', 'portal', 'memory', 'what-i-said'];",
    );
    expect(appSource).toContain('data-testid="top-level-runtime-tab"');
    expect(appSource).toContain('data-top-level-tab="runtime"');
    expect(appSource).toContain('aria-controls="top-level-runtime-panel"');
    expect(appSource).toContain("{lang === 'ko' ? 'AI 작업' : 'AI Tasks'}");
    const runtimeTabStart = appSource.indexOf('id="tab-runtime"');
    const portalTabStart = appSource.indexOf('id="tab-terminal"', runtimeTabStart);
    const runtimeTab = appSource.slice(runtimeTabStart, portalTabStart);
    expect(runtimeTab).toContain('<Sparkles className="w-3.5 h-3.5" />');
    expect(runtimeTab).not.toContain('<SquareTerminal');
  });

  test('keeps the panel mounted after first entry and passes only opaque project metadata', () => {
    expect(appSource).toContain('const [runtimeHasMounted, setRuntimeHasMounted] = useState(false);');
    expect(appSource).toContain("if (activeTab === 'runtime') setRuntimeHasMounted(true);");
    expect(appSource).toContain("(runtimeHasMounted || activeTab === 'runtime')");
    expect(appSource).toContain('id="top-level-runtime-panel"');
    expect(appSource).toContain('role="tabpanel"');
    expect(appSource).toContain('aria-labelledby="tab-runtime"');

    const projectionStart = appSource.indexOf('const agentRuntimeProjects = useMemo');
    const projectionEnd = appSource.indexOf('const searchFilteredPorts', projectionStart);
    expect(projectionStart).toBeGreaterThan(-1);
    expect(projectionEnd).toBeGreaterThan(projectionStart);
    const projection = appSource.slice(projectionStart, projectionEnd);
    expect(projection).toContain('/^[A-Za-z0-9_-]+$/.test(project.id)');
    expect(projection).toContain('project.folderPath.trim().length > 0');
    expect(projection).toContain('project.worktreePath.trim().length > 0');
    expect(projection).toContain('isUsableRootPath(project.folderPath.trim())');
    expect(projection).toContain('isUsableRootPath(project.worktreePath.trim())');
    expect(projection).toContain('targetId: project.id');
    expect(projection).toContain("scope: 'main' | 'worktree'");

    const invocation = appSource.match(/<AgentRuntimePanel\s+[\s\S]*?\/>/)?.[0] ?? '';
    expect(invocation).not.toBe('');
    expect(invocation).toContain('projects={agentRuntimeProjects}');
    expect(invocation).toContain('entryRequest={agentRuntimeEntryRequest}');
    expect(invocation).toContain('onManageProject={openAgentRuntimeProjectManager}');
    expect(invocation).toContain("onOpenMemory={() => setActiveTab('memory')}");
    expect(invocation).toContain("onOpenWhatISaid={() => setActiveTab('what-i-said')}");
    expect(invocation).not.toContain('folderPath');
    expect(invocation).not.toContain('worktreePath');
  });

  test('preserves the existing external launcher surfaces', () => {
    for (const launcherAnchor of [
      'const openCodexMain = async',
      'const openClaudeMain = async',
      'const openAntigravityMain = async',
      "terminalOptionDefaults(app, orcaLaunchMode)",
      "terminalApp === 'orca'",
      "API.openTerminalCodex",
      "API.openTerminalHermes",
    ]) {
      expect(appSource).toContain(launcherAnchor);
    }
  });

  test('separates the app-native project conversation from external app launchers', () => {
    expect(appSource).toContain('data-testid="detail-agentstoz-conversation"');
    expect(appSource).toContain('AgentsToZ에서 대화');
    expect(appSource).toContain("surface: 'conversations'");
    expect(appSource).toContain("setActiveTab('runtime')");
    expect(appSource).toContain('<details data-testid="detail-provider-apps"');
    expect(appSource).toContain('다른 앱·새 대화 열기');
    expect(appSource).toContain('testId="detail-project-launch"');
    expect(appSource).toContain('Codex 앱에서 열기');
    expect(appSource).toContain('Hermes 앱에서 열기');
  });
});
