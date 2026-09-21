import {describe,expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

const appSource=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');

describe('Workroom-first App wiring',()=>{
  test('removes the redundant AI Work tab while retaining OPS memory entry points',()=>{
    expect(appSource).toContain("const TOP_LEVEL_TABS: readonly TopLevelTab[] = ['ports', 'terminal', 'portal', 'memory', 'what-i-said'];");
    expect(appSource).not.toContain('id="tab-runtime"');
    expect(appSource).not.toContain('id="top-level-runtime-panel"');
    expect(appSource).not.toContain('<AiWorkRequestPanel');
    expect(appSource).not.toContain('<AgentRuntimePanel');
    expect(appSource).toContain('data-testid="control-profile-open"');
    expect(appSource).toContain('AgentsToZ OPS · 운영 기억 확인');
  });

  test('preserves opaque target discovery for the Workroom',()=>{
    const start=appSource.indexOf('const agentRuntimeProjects = useMemo');
    const end=appSource.indexOf('const searchFilteredPorts',start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const projection=appSource.slice(start,end);
    expect(projection).toContain('/^[A-Za-z0-9_-]+$/.test(project.id)');
    expect(projection).toContain('isUsableRootPath(project.folderPath.trim())');
    expect(projection).toContain('isUsableRootPath(project.worktreePath.trim())');
    expect(projection).toContain('targetId: project.id');
    expect(appSource).toContain('<AiTerminalPanel projects={agentRuntimeProjects}');
  });

  test('routes project drafts and conversations to Workroom without auto-running them',()=>{
    expect(appSource).toContain('const openWorkroomDraft=(targetId:string,title:string,prompt:string)=>{setTerminalEntry(');
    expect(appSource).toContain("setActiveTab('terminal')");
    expect(appSource).toContain('setTerminalEntry({nonce:++runtimeEntryNonceRef.current,targetId:project.id});');
    expect(appSource).not.toContain("setActiveTab('runtime')");
    expect(appSource).toContain('data-testid="detail-agentstoz-conversation"');
  });

  test('preserves external launchers independently from Workroom',()=>{
    for(const anchor of ['const openCodexMain = async','const openClaudeMain = async','const openAntigravityMain = async',"terminalOptionDefaults(app, orcaLaunchMode)","terminalApp === 'orca'",'API.openTerminalCodex','API.openTerminalHermes','<details data-testid="detail-provider-apps"','Codex 앱에서 열기','Hermes 앱에서 열기'])expect(appSource).toContain(anchor);
  });
});
