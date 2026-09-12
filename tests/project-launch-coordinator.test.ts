import {describe, expect, test} from 'bun:test';
import {CodexFirstConversationLaunchCoordinator} from '../src/codexFirstConversationLaunch';
import {openProjectCodexWorkspace, type ProjectCodexLaunchDependencies} from '../src/projectLaunchCoordinator';
import {projectCodexPrimaryAction} from '../src/projectLaunchPolicy';
import {ProjectWorkroomLauncher} from '../src/projectLaunchWorkroom';
import type {AiTerminalRequest, AiTerminalSummary} from '../src/aiTerminalProtocol';

function codexFixture() {
  const calls:string[]=[];
  const deps:ProjectCodexLaunchDependencies={coordinator:new CodexFirstConversationLaunchCoordinator(),latest:()=>({state:'none'}),verify:async()=> 'verified' as const,create:async retain=>{calls.push('create');retain('thread-1');return{threadId:'thread-1'};},finalize:async id=>{calls.push('finalize:'+id);},open:async id=>{calls.push('open:'+id);}};
  return {deps,calls};
}
const session=(targetId='project-1',agent:'codex'|'claude'='codex'):AiTerminalSummary=>({id:'session-1',targetId,agent,state:'running',createdAt:'2026-09-10T00:00:00Z',exitCode:null,cols:100,rows:28});

describe('project Codex first/continue entry',()=>{
  test('positive absence prepares once and reports OS delivery separately from GUI selection',async()=>{
    const f=codexFixture();const [a,b]=await Promise.all([openProjectCodexWorkspace('project-1',f.deps),openProjectCodexWorkspace('project-1',f.deps)]);
    expect(a).toEqual(b);expect(f.calls).toEqual(['create','finalize:thread-1','open:thread-1']);
    expect(a).toEqual({mode:'prepared',projectConfirmed:true,deliveryRequested:true,selectionVerified:false});
  });
  test('confirmed existing exact thread only reopens; unavailable metadata or wrong binding never creates',async()=>{
    const f=codexFixture();f.deps.latest=()=>({state:'found',sessionId:'old-thread'});
    expect(await openProjectCodexWorkspace('project-1',f.deps)).toMatchObject({mode:'reopened',selectionVerified:false});expect(f.calls).toEqual(['open:old-thread']);
    f.deps.verify=async()=> 'missing' as const;await expect(openProjectCodexWorkspace('project-1',f.deps)).rejects.toMatchObject({code:'CODEX_PROJECT_CONNECTION_UNAVAILABLE'});
    f.deps.latest=()=>({state:'unavailable'});await expect(openProjectCodexWorkspace('project-1',f.deps)).rejects.toMatchObject({code:'CODEX_PROJECT_CONNECTION_UNAVAILABLE'});
    expect(f.calls).toEqual(['open:old-thread']);expect(projectCodexPrimaryAction('unavailable',true).intent).toBe('check');
  });
  test('async OS failure retains first thread and finalizes it even when metadata now shows it',async()=>{
    const f=codexFixture();let fail=true;f.deps.open=async id=>{f.calls.push('open:'+id);await Promise.resolve();if(fail)throw Error('OS rejected');};
    await expect(openProjectCodexWorkspace('project-1',f.deps)).rejects.toMatchObject({code:'CODEX_FIRST_TURN_CREATED_OPEN_FAILED'});
    fail=false;f.deps.latest=()=>({state:'found',sessionId:'thread-1'});
    await openProjectCodexWorkspace('project-1',f.deps);expect(f.calls.filter(c=>c==='create')).toHaveLength(1);expect(f.calls.filter(c=>c==='finalize:thread-1')).toHaveLength(2);
  });
});

describe('project Workroom entry',()=>{
  test('reconnects exact running target and agent without spawning a second CLI',async()=>{
    const requests:AiTerminalRequest[]=[];const launcher=new ProjectWorkroomLauncher(async r=>{requests.push(r);return{sessions:[session('other'),session('project-1','claude'),session()]};});
    expect(await launcher.open('project-1','codex')).toEqual(session());expect(requests.map(r=>r.operation)).toEqual(['list']);
  });
  test('coalesces clicks and retries an uncertain start with the same id',async()=>{
    const starts:string[]=[];let fail=true;const launcher=new ProjectWorkroomLauncher(async r=>{
      if(r.operation==='list')return{sessions:[]};starts.push(r.requestId);if(fail)throw Error('lost response');return{session:session()};
    });
    const a=launcher.open('project-1','codex'),b=launcher.open('project-1','codex');expect(a).toBe(b);
    await expect(a).rejects.toThrow('lost response');fail=false;await launcher.open('project-1','codex');expect(starts).toHaveLength(2);expect(starts[0]).toBe(starts[1]);
  });
  test('a received rejection permits retry after CLI setup while metadata errors never launch',async()=>{
    const starts:string[]=[];let fail=true;const launcher=new ProjectWorkroomLauncher(async r=>{
      if(r.operation==='list')return{sessions:[]};starts.push(r.requestId);if(fail)throw Object.assign(Error('CLI missing'),{serverRejected:true});return{session:session()};
    });
    await expect(launcher.open('project-1','codex')).rejects.toThrow('CLI missing');fail=false;await launcher.open('project-1','codex');expect(starts[0]).not.toBe(starts[1]);
    const bad=new ProjectWorkroomLauncher(async()=>{throw Error('inventory offline');});await expect(bad.open('project-1','codex')).rejects.toThrow('inventory offline');
  });
});
