import {test,expect} from 'bun:test';
import {claudeAutoRememberObservation} from '../src/claudeAutoRememberObservation';
import {CodexAutoRememberCoordinator} from '../src/codexAutoRememberCoordinator';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const snapshot={sessionId:'claude-session-123',cwd:'/tmp/project',capturedAt:'2026-09-06T01:00:03Z',contextWindow:{used_percentage:51}};
const row={sessionId:snapshot.sessionId,type:'assistant',uuid:'complete-turn-123',timestamp:'2026-09-06T01:00:02Z',message:{stop_reason:'end_turn'}};
test('Claude completion must match measured session and cannot come from tools, sidechains or a stale statusline',()=>{
  expect(claudeAutoRememberObservation(snapshot,JSON.stringify(row))?.turnState).toBe('complete');
  for(const invalid of [{...row,type:'user'},{...row,message:{stop_reason:'tool_use'}},{...row,isSidechain:true},{...row,sessionId:'different-session'}]) {
    expect(claudeAutoRememberObservation(snapshot,JSON.stringify(invalid))?.turnState).not.toBe('complete');
  }
  expect(claudeAutoRememberObservation({...snapshot,capturedAt:'2026-09-06T01:00:01Z'},JSON.stringify(row))?.turnState).not.toBe('complete');
  expect(claudeAutoRememberObservation(snapshot,JSON.stringify(row)+'\n{"partial":')?.turnState).toBe('unknown');
  expect(claudeAutoRememberObservation(snapshot,JSON.stringify(row)+'\n'+JSON.stringify({...row,type:'user'}))?.turnState).toBe('running');
  expect(claudeAutoRememberObservation({...snapshot,contextWindow:{}},JSON.stringify(row))).toBeNull();
});
test('Claude 50% shares the completed-turn checkpoint fence and survives restart without duplicate saving',async()=>{
  const root=mkdtempSync(join(tmpdir(),'claude-checkpoint-'));let calls=0;
  let observation=claudeAutoRememberObservation(snapshot,JSON.stringify({...row,type:'user'}))!;
  const dependencies={stateFile:join(root,'state.json'),now:()=>new Date('2026-09-06T01:00:00Z'),listObservations:()=>[observation],
    resolveProject:()=>({projectId:'project',projectName:'Fixture',projectRoot:'/tmp/project'}),
    inspectMemory:()=>({exists:true,needsRemember:true,autoBackup:true}),
    checkpoint:async()=>{calls++;return {localSaved:true,remoteBackedUp:true}}};
  try {
    const coordinator=new CodexAutoRememberCoordinator(dependencies);coordinator.setEnabled(true);
    await coordinator.tick();expect(calls).toBe(0);
    observation=claudeAutoRememberObservation(snapshot,JSON.stringify(row))!;
    await coordinator.tick();await coordinator.tick();expect(calls).toBe(1);
    await new CodexAutoRememberCoordinator(dependencies).tick();expect(calls).toBe(1);
  } finally {rmSync(root,{recursive:true,force:true});}
});
