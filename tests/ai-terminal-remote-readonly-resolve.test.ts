import {expect,test} from 'bun:test';
import {createAiTerminalRemoteGateway} from '../src/aiTerminalRemoteGateway';

// A phone with the Workroom open polls output every ~1.5s; resolving targets walks every registered
// project (manifests, lsof, `git worktree list`) and kept the sidecar near 90% CPU. Only read-only
// polling may use a cached resolution; anything that acts must resolve fresh.
test('only output reads and session lists are marked read-only for target resolution', async () => {
  const calls:{op:string;readOnly:boolean|undefined}[]=[];
  let op='';
  const gateway=createAiTerminalRemoteGateway({
    service:{remoteAllowed:()=>true,perform:async()=>({sessions:[]})} as any,
    active:()=>true,
    resolve:async(_bindings,readOnly)=>{calls.push({op,readOnly});return [{controlId:'control_1234',runtimeTargetId:'runtime_1234'}];},
  });
  for(const operation of ['list','read','start','input','close','resize']){
    op=operation;
    const request:any={requestId:'request_'+operation.padEnd(8,'x'),operation,...(operation==='start'?{targetId:'control_1234',agent:'codex'}:{}),...(operation!=='list'&&operation!=='start'?{sessionId:'session_12345678'}:{})};
    await gateway(request,[],'owner').catch(()=>{});
  }
  expect(calls.map(c=>[c.op,c.readOnly])).toEqual([['list',true],['read',true],['start',false],['input',false],['close',false],['resize',false]]);
});
