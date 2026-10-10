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
  expect(app).toContain('<AiTerminalPanel bypassPermissions={bypassPermissions} onBypassPermissionsChange={setBypassPermissions}');
});
test('bypass is an explicit start-only boolean and older callers keep CLI defaults',()=>{
  expect(normalizeAiTerminalRequest(start).bypassPermissions).toBeUndefined();
  for(const bypassPermissions of [true,false]) expect(normalizeAiTerminalRequest({...start,bypassPermissions}).bypassPermissions).toBe(bypassPermissions);
  for(const bypassPermissions of ['true',1,null]) expect(()=>normalizeAiTerminalRequest({...start,bypassPermissions})).toThrow();
  expect(()=>normalizeAiTerminalRequest({operation:'input',requestId:'request-fixture',sessionId:'session-fixture',data:'x',bypassPermissions:true})).toThrow();
});
test('each CLI receives permission flags before an option-looking prompt, with exactly one Hermes chat command',()=>{
  const prompt='--dangerously-do-not-parse-this-as-a-flag';
  expect(aiTerminalLaunchArgs('codex','session-fixture',prompt,true)).toEqual(['-c','tui.status_line=["context-remaining"]','--dangerously-bypass-approvals-and-sandbox','--',prompt]);
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
