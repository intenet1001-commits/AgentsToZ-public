import {test,expect} from 'bun:test';
import {WorkroomSharedShell,parseSharedShellRequest} from '../src/workroomSharedShell';
import type {AiTerminalSummary} from '../src/aiTerminalProtocol';

const sessionId='workroom-1234',targetId='project-1234';
const parent:AiTerminalSummary={id:sessionId,targetId,agent:'codex',state:'running',createdAt:new Date().toISOString(),exitCode:null,cols:80,rows:24};
test('shared shell keeps user and expressly allowed AI on one PTY with fenced retries',async()=>{
  const writes:string[]=[];let emit:((_pty:unknown,data:Uint8Array)=>void)|undefined,exit!: (code:number)=>void,allowed=true,valid=true;
  const service=new WorkroomSharedShell({
    resolveTarget:async()=>({cwd:'/tmp',revalidate:async()=>{if(!valid)throw Error('changed checkout');return {cwd:'/tmp'}}}),
    runningSession:id=>allowed&&id===sessionId?parent:null,
    spawn:(_args,options)=>{emit=(options.terminal as {data:typeof emit}).data;return {pid:12345,terminal:{write:(data:string)=>{writes.push(data);return data.length},resize:()=>{},close:()=>{}},exited:new Promise<number>(resolve=>{exit=resolve}),kill:()=>{}}},
    signalGroup:()=>exit(0),env:{HOME:'/tmp'},
  });
  const base={sessionId,targetId};
  const shellId=(await service.perform({operation:'shell.start',...base,cols:80,rows:20})).shell!.id;
  expect((await service.perform({operation:'shell.status',...base})).shell?.aiAllowed).toBe(false);
  await service.perform({operation:'shell.input',...base,shellId,requestId:'user-1234',data:'pwd\r'});
  expect(writes).toEqual(['pwd\r']);
  await expect(service.aiCommand({...base,requestId:'ai-12345',command:'ls'})).rejects.toThrow('허용되지');
  await service.perform({operation:'shell.allow-ai',...base,enabled:true});
  await service.aiCommand({...base,requestId:'ai-12345',command:'ls'});
  await service.aiCommand({...base,requestId:'ai-12345',command:'ls'});
  expect(writes).toEqual(['pwd\r','ls\r']);
  await service.perform({operation:'shell.input',...base,shellId,requestId:'user-2345',data:'echo partial'});
  await expect(service.aiCommand({...base,requestId:'ai-23456',command:'date'})).rejects.toThrow('입력 중');
  await service.perform({operation:'shell.input',...base,shellId,requestId:'user-3456',data:'\x15'});
  await expect(service.aiCommand({...base,requestId:'ai-12345',command:'cat'})).rejects.toThrow('같은 요청 ID');
  emit?.(null,new TextEncoder().encode('shell output\r\n'));
  expect(service.aiRead({...base,after:0}).chunks.map(chunk=>chunk.text).join('')).toContain('shell output');
  await service.perform({operation:'shell.allow-ai',...base,enabled:false});
  await expect(service.aiCommand({...base,requestId:'ai-56789',command:'ls'})).rejects.toThrow('허용되지');
  valid=false;
  await expect(service.perform({operation:'shell.input',...base,shellId,requestId:'user-5678',data:'echo nope\r'})).rejects.toThrow('changed checkout');
  expect(writes).toEqual(['pwd\r','ls\r','echo partial','\x15']);
  valid=true;allowed=false;
  await expect(service.perform({operation:'shell.allow-ai',...base,enabled:true})).rejects.toThrow('실행 중인');
  await service.perform({operation:'shell.close',...base});
  await service.shutdown();
});

test('shared-shell wire refuses paths, oversized input and unlisted operations',()=>{
  const base={sessionId,targetId};
  expect(()=>parseSharedShellRequest({operation:'shell.start',...base,cols:80,rows:20,cwd:'/tmp'})).toThrow();
  expect(()=>parseSharedShellRequest({operation:'shell.input',...base,requestId:'user-1234',data:'pwd\r'})).toThrow();
  expect(()=>parseSharedShellRequest({operation:'shell.input',...base,shellId:'shell-1234',requestId:'user-1234',data:'x'.repeat(4097)})).toThrow();
  expect(()=>parseSharedShellRequest({operation:'shell.exec',...base,command:'whoami'})).toThrow();
});

test('an in-flight input for a closed shell cannot write into its replacement',async()=>{
  const writes:string[]=[];let exit!: (code:number)=>void;
  const service=new WorkroomSharedShell({
    resolveTarget:async()=>({cwd:'/tmp'}),runningSession:id=>id===sessionId?parent:null,
    spawn:()=>({pid:12345,terminal:{write:(data:string)=>{writes.push(data);return data.length},resize:()=>{},close:()=>{}},exited:new Promise<number>(resolve=>{exit=resolve}),kill:()=>{}}),
    signalGroup:()=>exit(0),env:{HOME:'/tmp'},
  });
  const base={sessionId,targetId};
  try{
    const first=await service.perform({operation:'shell.start',...base,cols:80,rows:20});
    const oldShellId=first.shell?.id;
    expect(oldShellId).toBeTruthy();
    await service.perform({operation:'shell.close',...base});
    const second=await service.perform({operation:'shell.start',...base,cols:80,rows:20});
    expect(second.shell?.id).not.toBe(oldShellId);
    await expect(service.perform({operation:'shell.input',...base,shellId:oldShellId,requestId:'stale-1234',data:'wrong\r'})).rejects.toThrow('셸');
    await service.perform({operation:'shell.input',...base,shellId:second.shell?.id,requestId:'fresh-1234',data:'right\r'});
    expect(writes).toEqual(['right\r']);
  }finally{await service.perform({operation:'shell.close',...base}).catch(()=>{});await service.shutdown();}
});

test('the real Mac PTY runs a command and drains its output',async()=>{
  if(process.platform!=='darwin')return;
  const service=new WorkroomSharedShell({
    resolveTarget:async()=>({cwd:'/tmp'}),runningSession:id=>id===sessionId?parent:null,
    env:{HOME:'/tmp',PATH:'/usr/bin:/bin:/usr/sbin:/sbin',TERM:'xterm-256color'},
  });
  const base={sessionId,targetId};
  try{
    const shellId=(await service.perform({operation:'shell.start',...base,cols:80,rows:20})).shell!.id;
    await service.perform({operation:'shell.input',...base,shellId,requestId:'real-user-1234',data:'printf %s "shared-shell-pty-" "ok"\r'});
    const deadline=Date.now()+5000;let output='';
    while(Date.now()<deadline){
      const page=await service.perform({operation:'shell.read',...base,after:0});
      if(!('chunks' in page))throw Error('공용 셸 출력 응답이 없습니다.');
      output=(page.chunks as {text:string}[]).map(chunk=>chunk.text).join('');
      if(output.includes('shared-shell-pty-ok'))break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    expect(output).toContain('shared-shell-pty-ok');
  }finally{await service.perform({operation:'shell.close',...base}).catch(()=>{});await service.shutdown();}
});
