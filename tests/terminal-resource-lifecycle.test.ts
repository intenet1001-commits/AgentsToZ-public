import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AiTerminalService, AI_TERMINAL_MAX_PENDING_MUTATIONS, AI_TERMINAL_MAX_REQUEST_HISTORY, type AiTerminalDependencies} from '../src/aiTerminalService';
import type {AiTerminalRequest} from '../src/aiTerminalProtocol';

// No OS child, signal, API, controller, or user project is touched by these tests.
const cleanup: (()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
let requestNumber=0;
const request=(r:Omit<AiTerminalRequest,'requestId'>):AiTerminalRequest=>({...r,requestId:'resource-request-'+(++requestNumber)});
const targetId='resource-fixture-project';
function fixture() {
  const cwd=mkdtempSync(join(tmpdir(),'agentstoz-terminal-resources-'));
  let gate:Promise<void>|undefined, resolutionError:Error|undefined, spawnCount=0;
  const processes=new Map<number,{exit:()=>void;writes:string[];signals:string[]}>();
  const dependencies:AiTerminalDependencies={
    resolveTarget:async()=>{await gate;if(resolutionError)throw resolutionError;return{cwd};},
    executable:()=>'/fixture/no-executable-is-started',
    spawn:(_args,options)=>{
      const terminal=options.terminal as {exit:()=>void};
      let finish!:(code:number)=>void;
      const exited=new Promise<number>(resolve=>{finish=resolve;});
      const process={exit:()=>{terminal.exit();finish(0);},writes:[] as string[],signals:[] as string[]};
      const pid=++spawnCount;processes.set(pid,process);
      return {pid,exited,kill:()=>{throw new Error('No real process may be signaled');},terminal:{
        write:(data:string)=>{process.writes.push(data);return data.length;},resize:()=>{},close:()=>{},
      }};
    },
    signalGroup:(pid,signal)=>{const process=processes.get(pid)!;process.signals.push(signal);process.exit();},
  };
  const service=new AiTerminalService(dependencies);
  cleanup.push(async()=>{gate=undefined;await service.shutdown();rmSync(cwd,{recursive:true});});
  return {service,processes,setGate:(next:Promise<void>|undefined)=>{gate=next;},setResolutionError:(next:Error|undefined)=>{resolutionError=next;},
    start:async()=>(await service.perform(request({operation:'start',targetId,agent:'codex',cols:80,rows:24}))).session!.id};
}

test('100,000 accepted requests retain exactly-once input, always allow close, and release capacity for another session',async()=>{
  const {service,processes,start}=fixture();const id=await start();
  const first=request({operation:'input',sessionId:id,data:'once'});
  await service.perform(first);
  for(let n=2;n<AI_TERMINAL_MAX_REQUEST_HISTORY;n++)await service.perform(request({operation:'input',sessionId:id,data:'x'}));
  const writes=processes.get(1)!.writes;
  expect(writes).toHaveLength(AI_TERMINAL_MAX_REQUEST_HISTORY-1);
  await service.perform(first);expect(writes).toHaveLength(AI_TERMINAL_MAX_REQUEST_HISTORY-1);
  await expect(service.perform({...first,data:'different'})).rejects.toThrow('같은 요청 ID');
  await expect(service.perform(request({operation:'input',sessionId:id,data:'over capacity'}))).rejects.toThrow('세션을 종료');
  const closed=await service.perform(request({operation:'close',sessionId:id}));expect(closed.session?.state).toBe('exited');
  // Removed input retry records cannot write into an exited terminal.
  await expect(service.perform(first)).rejects.toThrow('종료된 터미널');
  expect(writes).toHaveLength(AI_TERMINAL_MAX_REQUEST_HISTORY-1);
  const next=await start();await service.perform(request({operation:'input',sessionId:next,data:'capacity recovered'}));
  expect(processes.get(2)!.writes).toEqual(['capacity recovered']);
},10_000);

test('close bypasses a saturated, stalled mutation queue and fences every late write',async()=>{
  const f=fixture();const id=await f.start();
  let release!:()=>void;f.setGate(new Promise<void>(resolve=>{release=resolve;}));
  const first=request({operation:'input',sessionId:id,data:'0'});
  const pending=[f.service.perform(first)];
  for(let n=1;n<AI_TERMINAL_MAX_PENDING_MUTATIONS;n++)pending.push(f.service.perform(request({operation:'input',sessionId:id,data:String(n)})));
  pending.push(f.service.perform(first));
  const outcomes=Promise.allSettled(pending);
  const rejected=request({operation:'input',sessionId:id,data:'not accepted'});
  await expect(f.service.perform(rejected)).rejects.toThrow('처리 중인 터미널 입력');
  const closeA=f.service.perform(request({operation:'close',sessionId:id}));
  const closeB=f.service.perform(request({operation:'close',sessionId:id}));
  await expect(f.service.perform(request({operation:'resize',sessionId:id,cols:90,rows:25}))).rejects.toThrow('종료 중');
  expect((await f.service.perform(request({operation:'list'}))).sessions).toHaveLength(1);
  // The target resolver is still held. Closing must actually signal the PTY,
  // not merely accept a close behind the unresolved input promise.
  expect((await Promise.race([closeA,Bun.sleep(250).then(()=>{throw new Error('close waited for the stalled resolver');})])).session?.state).toBe('exited');
  expect((await closeB).session?.state).toBe('exited');
  release();f.setGate(undefined);
  expect((await outcomes).every(result=>result.status==='rejected')).toBe(true);
  expect(f.processes.get(1)!.writes).toEqual([]);
  expect(f.processes.get(1)!.signals).toEqual(['SIGTERM']);
});

test('a rejected execution proof keeps its fingerprint fence and exact failure on retries',async()=>{
  const f=fixture();const id=await f.start();
  f.setResolutionError(new Error('fixture registration removed'));
  const failed=request({operation:'input',sessionId:id,data:'must not execute'});
  await expect(f.service.perform(failed)).rejects.toThrow('registration removed');
  f.setResolutionError(undefined);
  await expect(f.service.perform(failed)).rejects.toThrow('registration removed');
  await expect(f.service.perform({...failed,data:'modified retry'})).rejects.toThrow('같은 요청 ID');
  await f.service.perform(request({operation:'input',sessionId:id,data:'fresh request'}));
  expect(f.processes.get(1)!.writes).toEqual(['fresh request']);
});

test('natural exit releases input records but never permits an old start request to spawn again',async()=>{
  const f=fixture();const start=request({operation:'start',targetId,agent:'codex',cols:80,rows:24});
  const id=(await f.service.perform(start)).session!.id;
  const input=request({operation:'input',sessionId:id,data:'before exit'});await f.service.perform(input);
  f.processes.get(1)!.exit();
  for(let n=0;n<20;n++){if((await f.service.perform(request({operation:'list'}))).sessions![0]!.state==='exited')break;await Promise.resolve();}
  await expect(f.service.perform(input)).rejects.toThrow('종료된 터미널');
  await f.service.perform(start);expect(f.processes.size).toBe(1);
  await expect(f.service.perform({...start,cols:81})).rejects.toThrow('같은 요청 ID');
});
