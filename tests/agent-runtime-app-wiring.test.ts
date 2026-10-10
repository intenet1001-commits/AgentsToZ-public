import {describe,expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {workroomProjectsFromPorts} from '../src/workroomProjects';

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
    // The projection lives in src/workroomProjects.ts so Workroom pop-out windows list the same targets.
    expect(appSource).toContain('const agentRuntimeProjects = useMemo(() => workroomProjectsFromPorts(ports), [ports]);');
    // Behavioural, not a source grep: the list carries opaque ids only and needs a usable local path.
    const rows=workroomProjectsFromPorts([
      {id:'good-project-1',name:'Good',folderPath:'/Users/me/good'},
      {id:'bad id/../x',name:'Bad',folderPath:'/Users/me/bad'},
      {id:'relative-path-1',name:'Rel',folderPath:'relative/path'},
      {id:'good-project-1',name:'Dup',folderPath:'/Users/me/dup'},
      {id:'worktree-row-1',name:'WT',worktreePath:'/Users/me/good/worktrees/a',worktreeParentId:'good-project-1'},
    ]);
    expect(rows).toEqual([
      {targetId:'good-project-1',projectTargetId:'good-project-1',label:'Good',scope:'main',worktreeCapable:false},
      {targetId:'worktree-row-1',projectTargetId:'good-project-1',label:'WT',scope:'worktree',worktreeCapable:true},
    ]);
    expect(JSON.stringify(rows)).not.toContain('/Users/');
    expect(appSource).toMatch(/<AiTerminalPanel\b[^>]*projects=\{agentRuntimeProjects\}/);
  });

  test('routes project drafts and conversations to Workroom without auto-running them',()=>{
    expect(appSource).toContain('const openWorkroomDraft=(targetId:string,title:string,prompt:string)=>{setTerminalEntry(');
    expect(appSource).toContain("setActiveTab('terminal')");
    expect(appSource).not.toContain("setActiveTab('runtime')");
  });

  test('keeps a single Workroom entry point in the project detail panel',()=>{
    // 「이 프로젝트에서 작업 · 워크룸에서 작업」(ProjectLaunchActions) already opens the
    // same Workroom tab for the same project, and it additionally lets the user pick
    // the agent. The separate 「프로젝트 대화 기록 · AgentsToZ에서 대화」 card sent the
    // identical setTerminalEntry({targetId}) + setActiveTab('terminal') pair with no
    // agent, so it was a strictly weaker duplicate of the same destination.
    expect(appSource).not.toContain('data-testid="detail-agentstoz-conversation"');
    expect(appSource).not.toContain('data-testid="desktop-project-app-panel"');
    expect(appSource).not.toContain('openAgentsToZConversation');
    expect(appSource).not.toContain('AgentsToZ에서 대화');
    expect(appSource).toContain('<ProjectLaunchActions');
    expect(appSource).toContain('onWorkroom={agent => openProjectTerminal(sel, agent, undefined, undefined, true)}');
  });

  test('preserves external launchers independently from Workroom',()=>{
    for(const anchor of ['const openCodexMain = async','const openClaudeMain = async','const openAntigravityMain = async',"terminalOptionDefaults(app, orcaLaunchMode)","terminalApp === 'orca'",'API.openTerminalCodex','API.openTerminalHermes','<details data-testid="detail-provider-apps"','Codex 앱에서 열기','Hermes 앱에서 열기'])expect(appSource).toContain(anchor);
  });
});
