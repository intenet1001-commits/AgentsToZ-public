import {afterEach, expect, spyOn, test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RemoteControlLanServer, REMOTE_CONTROL_LAN_MAX_QUEUED_BYTES, REMOTE_CONTROL_LAN_MAX_QUEUED_MESSAGES} from '../src/remoteControlLanServer';
import {REMOTE_CONTROL_PROTOCOL_VERSION} from '../src/remoteControlCore';
import type {RemoteControlRegisteredTarget} from '../src/remoteControlProcessGateway';
import type {RemoteTerminalGateway} from '../src/remoteControlTerminalProtocol';
import {AiTerminalService} from '../src/aiTerminalService';
import {createAiTerminalRemoteGateway} from '../src/aiTerminalRemoteGateway';

// Capture the real Bun handlers without binding any interface or using a real
// controller. The fake socket deliberately delays its native close callback.
const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const fn of cleanup.splice(0))fn();});
function fixture(terminalGateway?:RemoteTerminalGateway,project?:RemoteControlRegisteredTarget) {
  let options:any,now=Date.now(),release!:()=>void,lists=0;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const server=new RemoteControlLanServer({bindAddress:'10.99.99.99',hostName:'Resource fixture',now:()=>now,terminalGateway,gateway:{
    listRegisteredProjects:async()=>{lists++;await gate;return project?[project]:[];},
    executeRegisteredProjectAction:()=>{throw new Error('No project action is permitted in this fixture');},
  }});
  const serve=spyOn(Bun,'serve').mockImplementation(((value:any)=>{options=value;return{port:41001,stop:()=>{}};}) as any);
  let started:ReturnType<typeof server.start>;
  try {started=server.start();} finally {serve.mockRestore();}
  cleanup.push(()=>{release();server.stop();});
  const sent:any[]=[],closed:{code:number;reason:string}[]=[];
  const socket:any={data:undefined,send:(data:string)=>{sent.push(JSON.parse(data));},close:(code:number,reason:string)=>{closed.push({code,reason});}};
  options.fetch(new Request('http://10.99.99.99:41001/remote/ws',{headers:{host:'10.99.99.99:41001',origin:'http://10.99.99.99:41001'}}),{
    upgrade:(_request:Request,value:any)=>{socket.data=value.data;return true;},
  });
  options.websocket.open(socket);
  const pair=()=>options.websocket.message(socket,JSON.stringify({type:'controller.pair',protocolVersion:REMOTE_CONTROL_PROTOCOL_VERSION,
    token:new URLSearchParams(new URL(started.pairing.pairingUrl).hash.slice(1)).get('pair')}));
  return {server,socket,sent,closed,pair,release,options,lists:()=>lists,
    send:(raw:string|Buffer)=>options.websocket.message(socket,raw),advance:()=>{now+=1_100;}};
}

test('a stalled pairing cannot retain thousands of frames before the ingress rate check',async()=>{
  const f=fixture();f.pair();expect(f.lists()).toBe(1);
  for(let n=0;n<5_000;n++)f.send(Buffer.alloc(8192,65));
  expect(f.closed).toEqual([{code:1008,reason:'RATE_LIMITED'}]);
  expect(f.socket.data.pendingMessages).toHaveLength(0);expect(f.socket.data.pendingBytes).toBe(0);
  expect(f.sent.map(row=>row.code)).toEqual(['RATE_LIMITED']);
  f.release();await f.socket.data.messageQueue;
  expect(f.server.status().sessions).toHaveLength(0);
  expect(f.sent).toHaveLength(1); // No ready result after the connection was closed.
});

test('slow requests across rate windows are capped by queued count',async()=>{
  const f=fixture();f.pair();
  for(let n=0;n<REMOTE_CONTROL_LAN_MAX_QUEUED_MESSAGES;n++){f.advance();f.send(' '.repeat(1024));}
  expect(f.closed).toHaveLength(0);expect(f.socket.data.pendingMessages).toHaveLength(REMOTE_CONTROL_LAN_MAX_QUEUED_MESSAGES);
  f.advance();f.send(' ');
  expect(f.closed[0]?.reason).toBe('REQUEST_QUEUE_FULL');expect(f.socket.data.pendingMessages).toHaveLength(0);
  f.release();await f.socket.data.messageQueue;expect(f.server.status().sessions).toHaveLength(0);
});

test('slow requests also respect a byte budget independent of queued frame count',async()=>{
  const f=fixture();f.pair();
  for(let n=0;n<REMOTE_CONTROL_LAN_MAX_QUEUED_BYTES/(16*1024);n++){f.advance();f.send(Buffer.alloc(16*1024));}
  expect(f.socket.data.pendingBytes).toBe(REMOTE_CONTROL_LAN_MAX_QUEUED_BYTES);expect(f.closed).toHaveLength(0);
  f.advance();f.send(' ');expect(f.closed[0]?.reason).toBe('REQUEST_QUEUE_FULL');expect(f.socket.data.pendingBytes).toBe(0);
  f.release();await f.socket.data.messageQueue;
});

test('16 KiB payload errors occur before queueing with a separate 32 KiB native transport ceiling',()=>{
  const f=fixture();expect(f.options.websocket.maxPayloadLength).toBe(32*1024);
  f.send(Buffer.alloc(16*1024+1));
  expect(f.closed[0]?.reason).toBe('MESSAGE_TOO_LARGE');expect(f.lists()).toBe(0);expect(f.socket.data.pendingMessages).toHaveLength(0);
});

test('stop immediately drops queued input even when the native socket close callback is delayed',async()=>{
  const f=fixture();f.pair();f.send('queued fixture input');
  expect(f.socket.data.pendingMessages).toHaveLength(1);
  f.server.stop();expect(f.socket.data.pendingMessages).toHaveLength(0);expect(f.socket.data.pendingBytes).toBe(0);
  f.release();await f.socket.data.messageQueue;
  expect(f.server.status().enabled).toBe(false);expect(f.sent).toHaveLength(0);
});

for(const reason of ['disconnect','rate overflow','queue overflow'] as const){
  test(`LAN ${reason} revokes an input awaiting checkout proof even while the old terminal grant remains set`,async()=>{
    const cwd=mkdtempSync(join(tmpdir(),'agentstoz-disconnect-fence-'));
    let release!:()=>void,entered!:()=>void,finish!:(code:number)=>void,eof!:()=>void;
    const proofEntered=new Promise<void>(resolve=>{entered=resolve;});
    const held=new Promise<void>(resolve=>{release=resolve;});
    const writes:string[]=[];
    const service=new AiTerminalService({
      resolveTarget:async()=>({cwd,revalidate:async()=>{entered();await held;return{cwd};}}),
      executable:()=>'/fixture/no-process-started',
      spawn:(_args,options)=>{
        eof=(options.terminal as {exit:()=>void}).exit;
        return {pid:1,exited:new Promise<number>(resolve=>{finish=resolve;}),kill:()=>{},terminal:{
          write:(data:string)=>{writes.push(data);return data.length;},resize:()=>{},close:()=>{},
        }};
      },
      signalGroup:()=>{eof();finish(0);},
    });
    let server:RemoteControlLanServer|undefined;
    const remote=createAiTerminalRemoteGateway({service,
      active:owner=>server?.status().sessions.some(session=>'lan:'+session.id===owner)??false,
      resolve:async bindings=>bindings.map(binding=>({controlId:binding.controlId,runtimeTargetId:'fixture-runtime-project'})),
    });
    const f=fixture(remote,{internalId:'fixture-private-project',name:'Fixture project',port:null,command:null,kind:'main',folderPath:cwd,status:'unknown',actions:['folder.open']});
    server=f.server;
    try {
      f.release();f.pair();await f.socket.data.messageQueue;
      const ready=f.sent.find(message=>message.type==='session.ready');expect(ready).toBeDefined();
      const owner='lan:'+f.server.status().sessions[0]!.id;service.setRemoteAccess(owner,true);
      const begun=await service.perform({requestId:'disconnect-start-fixture',operation:'start',targetId:'fixture-runtime-project',agent:'codex',cols:80,rows:24});
      f.advance();f.send(JSON.stringify({type:'terminal.request',sessionToken:ready.sessionToken,request:{
        requestId:'disconnect-input-fixture',operation:'input',sessionId:begun.session!.id,data:'must not reach PTY',
      }}));
      await proofEntered;
      if(reason==='disconnect')f.options.websocket.close(f.socket);
      else if(reason==='rate overflow')for(let i=0;i<10;i++)f.send(' ');
      else for(let i=0;i<=REMOTE_CONTROL_LAN_MAX_QUEUED_MESSAGES;i++){f.advance();f.send(' ');}
      expect(f.server.status().sessions).toHaveLength(0);
      // The bug was the stale service grant surviving the LAN session removal.
      expect(service.remoteAllowed(owner)).toBe(true);
      release();await f.socket.data.messageQueue;
      expect(writes).toEqual([]);
      expect(f.sent.filter(message=>message.type==='terminal.result')).toHaveLength(0);
      await expect(remote({requestId:'disconnected-retry-fixture',operation:'input',sessionId:begun.session!.id,data:'retry'},[],owner)).rejects.toThrow('허용');
    } finally {release();f.server.stop();await service.shutdown();rmSync(cwd,{recursive:true});}
  });
}
