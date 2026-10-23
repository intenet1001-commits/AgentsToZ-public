import {test, expect} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexAutoRememberCoordinator} from '../src/codexAutoRememberCoordinator';
import {summarizeCodexRolloutLines} from '../src/codexRolloutSummary';
import type {CodexAutoRememberObservation} from '../src/codexAutoRememberContract';

const at = (n: number) => new Date(Date.UTC(2026,9,22,0,0,n)).toISOString();
const row = (usedPercent: number, n: number, complete = false): CodexAutoRememberObservation => ({
  sessionId:'fixture-session', cwd:'/fixture/project', usedPercent, capturedAt:at(n),
  turnState:complete?'complete':'running', turnId:'turn-one', turnCompletedAt:complete?at(n+1):null,
});
async function fixture(run: (f: {
  set: (observation: CodexAutoRememberObservation) => void; restart: () => void;
  tick: () => Promise<void>; status: () => ReturnType<CodexAutoRememberCoordinator['status']>;
  calls: number[]; fail: () => void; enable: (enabled: boolean) => void;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(),'compaction-checkpoint-'));
  let observation = row(71,1), failed = false;
  const calls: number[] = [];
  const deps = {stateFile:join(root,'state.json'), now:()=>new Date(at(0)), listObservations:()=>[observation],
    resolveProject:()=>({projectId:'project',projectName:'Fixture',projectRoot:'/fixture/project'}),
    inspectMemory:()=>({exists:true,needsRemember:true,autoBackup:true}),
    checkpoint:async({threshold}:{threshold:number})=>{calls.push(threshold);
      if(failed)throw Object.assign(new Error('not started'),{autoRememberNotStarted:true});
      return {localSaved:true,remoteBackedUp:false,backupError:'backup conflict'};},
  };
  let coordinator = new CodexAutoRememberCoordinator(deps);
  coordinator.setEnabled(true);
  try {await run({set:value=>{observation=value;},restart:()=>{coordinator=new CodexAutoRememberCoordinator(deps);},
    tick:()=>coordinator.tick(),status:()=>coordinator.status(),calls,fail:()=>{failed=true;},enable:value=>{coordinator.setEnabled(value);}});}
  finally {rmSync(root,{recursive:true,force:true});}
}

test('running 70% crossing survives compaction and restart; a request is never a save receipt',async()=>{
  await fixture(async f=>{
    await f.tick();
    expect(f.calls).toEqual([]);
    expect(f.status().sessions[0]).toMatchObject({phase:'waiting-for-turn',pendingUsedPercent:71,lastCheckpointAt:null});
    f.restart(); f.set(row(12,2)); await f.tick();
    expect(f.calls).toEqual([]);
    expect(f.status().sessions[0]?.nextThreshold).toBe(70);
    f.set(row(12,3,true)); await f.tick(); f.restart(); await f.tick();
    expect(f.calls).toEqual([70]);
    expect(f.status().sessions[0]).toMatchObject({lastCheckpointThreshold:70,backupWarning:'backup conflict'});
    // The next context cycle may grow again, without reusing old peak evidence.
    f.set({...row(71,5,true),turnId:'turn-two'}); await f.tick();
    expect(f.calls).toEqual([70,70]);
  });
});

test('a bounded rollout retains pre-compaction usage when compaction occurred between polls',async()=>{
  await fixture(async f=>{
    const token = (n:number, used:number) => JSON.stringify({type:'event_msg',timestamp:at(n),payload:{type:'token_count',info:{last_token_usage:{total_tokens:used},model_context_window:100}}});
    const summary = summarizeCodexRolloutLines([token(1,89),JSON.stringify({type:'compacted',timestamp:at(2),payload:{message:'private'}}),token(3,12)]);
    expect(summary.usagePeak?.usedPercent).toBe(89);
    expect(JSON.stringify(summary)).not.toContain('private');
    f.set({...row(12,3,true),usagePeaks:summary.usagePeaks}); await f.tick(); await f.tick();
    expect(f.calls).toEqual([75]);
    f.set({...row(12,6,true),turnId:'turn-two',usagePeaks:[...summary.usagePeaks!,{usedPercent:71,capturedAt:at(5)}]});
    await f.tick(); expect(f.calls).toEqual([75,70]);
  });
});

test('hard failure cannot start a second AI call on a higher threshold of the same completed turn',async()=>{
  await fixture(async f=>{
    f.fail(); f.set(row(71,1,true)); await f.tick();
    f.restart(); f.set(row(91,2,true)); await f.tick();
    expect(f.calls).toEqual([70]);
    expect(f.status().sessions[0]?.phase).toBe('failed');
  });
});

test('a pending crossing cannot move to another project or agent, or execute while disabled',async()=>{
  await fixture(async f=>{
    await f.tick(); f.set({...row(12,2,true),cwd:'/other/project'}); await f.tick();
    expect(f.status().sessions[0]?.phase).toBe('recovery-required');
    expect(f.calls).toEqual([]);
    f.enable(false); f.set(row(91,3,true)); await f.tick(); expect(f.calls).toEqual([]);
  });
});
