import {expect,test} from 'bun:test';
import {aiTerminalLaunchArgs} from '../src/aiTerminalLaunchArgs';
import {normalizeAiTerminalRequest, type AiTerminalRequest} from '../src/aiTerminalProtocol';
import {ProjectWorkroomLauncher} from '../src/projectLaunchWorkroom';
import {readFileSync} from 'node:fs';

const start:AiTerminalRequest={operation:'start',requestId:'request-fixture',targetId:'project-fixture',agent:'codex',cols:80,rows:24};
test('both project-card entry paths forward the same desktop permission preference',()=>{
  const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
  expect(app).toContain('projectWorkroomLauncher.current!.open(targetId, agent, bypassPermissions)');
  expect(app).toContain('agent, cols: 100, rows: 28, prompt, bypassPermissions}');
  // Directory/visibility props may precede the permission preference. Check the
  // actual opening tag so a JSX prop reorder cannot masquerade as lost authority.
  const panel=app.match(/<AiTerminalPanel\b[\s\S]*?\/>/)?.[0]??'';
  expect(panel).toContain('bypassPermissions={bypassPermissions}');
  expect(panel).toContain('onBypassPermissionsChange={setBypassPermissions}');
});
test('bypass is an explicit start-only boolean',()=>{
  expect(normalizeAiTerminalRequest(start).bypassPermissions).toBeUndefined();
  for(const bypassPermissions of [true,false]) expect(normalizeAiTerminalRequest({...start,bypassPermissions}).bypassPermissions).toBe(bypassPermissions);
  for(const bypassPermissions of ['true',1,null]) expect(()=>normalizeAiTerminalRequest({...start,bypassPermissions})).toThrow();
  expect(()=>normalizeAiTerminalRequest({operation:'input',requestId:'request-fixture',sessionId:'session-fixture',data:'x',bypassPermissions:true})).toThrow();
});
test('each CLI receives permission flags before an option-looking prompt, with exactly one Hermes chat command',()=>{
  const prompt='--dangerously-do-not-parse-this-as-a-flag';
  expect(aiTerminalLaunchArgs('codex','session-fixture',prompt,true)).toEqual(['-c','tui.status_line=["model-with-reasoning","context-remaining"]','--dangerously-bypass-approvals-and-sandbox','--',prompt]);
  expect(aiTerminalLaunchArgs('claude','session-fixture',prompt,true)).toEqual(['--session-id','session-fixture','--permission-mode','bypassPermissions','--',prompt]);
  expect(aiTerminalLaunchArgs('hermes','session-fixture',prompt,true)).toEqual(['chat','--yolo','-q',prompt]);
  expect(aiTerminalLaunchArgs('hermes','session-fixture',undefined,true)).toEqual(['chat','--yolo']);
  expect(aiTerminalLaunchArgs('hermes','session-fixture',undefined,false)).toEqual(['chat']);
  expect(aiTerminalLaunchArgs('agy','session-fixture',prompt,true)).toEqual(['--dangerously-skip-permissions','-i',prompt]);
  for(const agent of ['codex','claude','hermes','agy'] as const){
    expect(aiTerminalLaunchArgs(agent,'session-fixture',undefined,false).some(arg=>/dangerously|yolo|bypassPermissions/.test(arg))).toBe(false);
    expect(aiTerminalLaunchArgs(agent,'session-fixture')).toEqual(aiTerminalLaunchArgs(agent,'session-fixture',undefined,false));
  }
});
test('an uncertain card launch retries its original permission payload after the preference changes',async()=>{
  const starts:AiTerminalRequest[]=[];
  const launcher=new ProjectWorkroomLauncher(async request=>{
    if(request.operation==='list')return {sessions:[]};
    starts.push(request);throw Error('response lost');
  });
  await expect(launcher.open('project-fixture','codex',true)).rejects.toThrow();
  await expect(launcher.open('project-fixture','codex',false)).rejects.toThrow();
  expect(starts).toHaveLength(2);expect(starts[0]).toEqual(starts[1]);expect(starts[1]!.bypassPermissions).toBe(true);
});
test('「에포트 자동」: the chosen level rides each CLI\'s own launch flag; omitted, the arguments are byte-identical (w16)',()=>{
  const prompt='--looks-like-a-flag';
  expect(aiTerminalLaunchArgs('claude','session-fixture',prompt,false,null,null,false,'high')).toEqual(['--session-id','session-fixture','--permission-mode','default','--effort','high','--',prompt]);
  expect(aiTerminalLaunchArgs('claude','session-fixture',prompt,true,null,null,false,'low')).toEqual(['--session-id','session-fixture','--permission-mode','bypassPermissions','--effort','low','--',prompt]);
  expect(aiTerminalLaunchArgs('claude','session-fixture',undefined,false,{agent:'claude',conversationId:'conversation-fixture'},null,false,'medium')).toEqual(['--resume','conversation-fixture','--permission-mode','default','--effort','medium']);
  expect(aiTerminalLaunchArgs('codex','session-fixture',prompt,false,null,null,false,'high')).toEqual(['-c','tui.status_line=["model-with-reasoning","context-remaining"]','-c','model_reasoning_effort="high"','--ask-for-approval','on-request','--sandbox','workspace-write','--',prompt]);
  expect(aiTerminalLaunchArgs('codex','session-fixture',undefined,false,{agent:'codex',conversationId:'thread-fixture'},null,true,'medium')).toEqual(['--dangerously-bypass-hook-trust','resume','thread-fixture','-c','tui.status_line=["model-with-reasoning","context-remaining"]','-c','model_reasoning_effort="medium"','--ask-for-approval','on-request','--sandbox','workspace-write']);
  expect(aiTerminalLaunchArgs('hermes','session-fixture',prompt,false,null,null,false,'high')).toEqual(['chat','--reasoning','high','-q',prompt]);
  expect(aiTerminalLaunchArgs('hermes','session-fixture',prompt,true,null,null,false,'low')).toEqual(['chat','--reasoning','low','--yolo','-q',prompt]);
  // Antigravity couples effort to a model variant: never passed.
  expect(aiTerminalLaunchArgs('agy','session-fixture',prompt,true,null,null,false,'high')).toEqual(aiTerminalLaunchArgs('agy','session-fixture',prompt,true));
  // A restricted (CS duty) launch keeps its own rules untouched.
  const profile={permissionMode:'dontAsk' as const,tools:['Read'],allowedTools:['Read(./**)'],disallowedTools:[]};
  expect(aiTerminalLaunchArgs('claude','session-fixture',prompt,false,null,profile,false,'high')).toEqual(aiTerminalLaunchArgs('claude','session-fixture',prompt,false,null,profile));
  for(const agent of ['codex','claude','hermes','agy'] as const){
    expect(aiTerminalLaunchArgs(agent,'session-fixture',prompt,false,null,null,false,null)).toEqual(aiTerminalLaunchArgs(agent,'session-fixture',prompt,false));
    expect(aiTerminalLaunchArgs(agent,'session-fixture',prompt,false,null,null,false,undefined)).toEqual(aiTerminalLaunchArgs(agent,'session-fixture',prompt,false));
  }
});
