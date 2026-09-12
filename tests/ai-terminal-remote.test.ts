import {afterEach,describe,expect,test} from 'bun:test';
import {mkdtempSync,chmodSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir,networkInterfaces} from 'node:os';
import {join} from 'node:path';
import {AiTerminalService} from '../src/aiTerminalService';
import {createAiTerminalRemoteGateway} from '../src/aiTerminalRemoteGateway';
import {RemoteControlLanServer,isPrivateRemoteControlIpv4} from '../src/remoteControlLanServer';
import {REMOTE_CONTROL_PROTOCOL_VERSION,type RemoteControlGateway} from '../src/remoteControlCore';
import {normalizeRemoteTerminalResult} from '../src/remoteControlTerminalProtocol';
import type {AiTerminalRequest} from '../src/aiTerminalProtocol';
import {terminalRelayHarness} from './fixtures/terminalRelayHarness';
import {encryptRemoteControlRelayEnvelope} from '../src/remoteControlRelayCrypto';
import {REMOTE_CONTROL_RELAY_SCHEMA_VERSION} from '../src/remoteControlRelayContract';
const disposals:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const f of disposals.splice(0).reverse())await f();});
const request=(r:Omit<AiTerminalRequest,'requestId'>):AiTerminalRequest=>({...r,requestId:crypto.randomUUID()});
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'terminal-remote-')),cli=join(dir,'cli');
 writeFileSync(cli,'#!/bin/sh\nstty -echo\nprintf "REMOTE_READY\\n"\nwhile IFS= read -r line; do printf "RESULT:%s\\n" "$line"; done\n');chmodSync(cli,0o755);
 const service=new AiTerminalService({resolveTarget:async id=>{if(id!=='project-runtime-123')throw new Error('unregistered');return{cwd:dir}},executable:()=>cli});
 disposals.push(async()=>{await service.shutdown();rmSync(dir,{recursive:true,force:true})});
 let present=true;
 const gateway:RemoteControlGateway={listRegisteredProjects:()=>present?[{internalId:'private-project',name:'Fixture project',port:null,command:null,kind:'main',folderPath:dir,status:'unknown',actions:['folder.open']}]:[],executeRegisteredProjectAction:()=>{}};
 const remote=createAiTerminalRemoteGateway({service,active:()=>present,resolve:async bindings=>bindings.map(b=>({controlId:b.controlId,runtimeTargetId:'project-runtime-123'}))});
 return{service,gateway,remote,remove(){present=false}};
}

describe('AI terminal through real remote transports',()=>{
 test('an encrypted terminal command cannot bridge a missing sender sequence',async()=>{
  const f=fixture(),h=await terminalRelayHarness(f.gateway,f.remote);disposals.push(async()=>{await h.host.disable()});
  await h.connect();f.service.setRemoteAccess(h.owner,true);
  const snapshot=h.controller.snapshot()!;
  const envelope=await encryptRemoteControlRelayEnvelope({key:snapshot.sendKey,metadata:{schemaVersion:REMOTE_CONTROL_RELAY_SCHEMA_VERSION,messageId:crypto.randomUUID(),sessionId:snapshot.claim.sessionId,controllerId:snapshot.claim.controllerId,sequence:snapshot.sendSequence+2,expiresAt:new Date(Date.now()+60_000).toISOString()},plaintext:new TextEncoder().encode(JSON.stringify({type:'terminal.request',sessionToken:snapshot.sessionToken,request:request({operation:'start',targetId:h.controller.status().projects[0]!.controlId,agent:'codex',cols:80,rows:24})}))});
  await h.phoneTransport.sendEnvelope(snapshot.claim.hostId,snapshot.claim.sessionId,envelope);
  await expect(h.host.pollNow()).rejects.toThrow();
  expect((await f.service.perform(request({operation:'list'}))).sessions).toEqual([]);
 },15000);
 test('day 29 host and controller restarts retain the same approval; day 30 expires',async()=>{
  let clock=Date.now();const f=fixture(),h=await terminalRelayHarness(f.gateway,f.remote,{now:()=>clock});
  disposals.push(async()=>{await h.host.disable()});await h.connect();f.service.setRemoteAccess(h.owner,true);
  const original=h.controller.snapshot()!;
  clock+=29*24*3600_000;
  await h.restartHost();
  const restored=h.restore(original);await restored.refresh();
  expect(restored.status().state).toBe('online');
  expect(restored.snapshot()!.claim.sessionId).toBe(original.claim.sessionId);
  expect(restored.snapshot()!.claim.expiresAt).toBe(original.claim.expiresAt);
  expect((await restored.sendTerminal(request({operation:'list'}))).sessions).toEqual([]);
  clock=Date.parse(original.claim.expiresAt);await restored.refresh();
  expect(restored.status().state).toBe('closed');expect(restored.snapshot()).toBeNull();
 },15000);
 for(const delivered of [false,true])test(`expired uncertain input retains approval without replay (delivered=${delivered})`,async()=>{
  let clock=Date.now();const f=fixture(),h=await terminalRelayHarness(f.gateway,f.remote,{now:()=>clock});
  disposals.push(async()=>{await h.host.disable()});await h.connect();f.service.setRemoteAccess(h.owner,true);
  const before=h.controller.snapshot()!;
  const target=h.controller.status().projects[0]!.controlId;
  const started=await h.controller.sendTerminal(request({operation:'start',targetId:target,agent:'codex',cols:80,rows:24}));
  const id=started.session!.id;
  for(let n=0;n<30;n++){const read=await f.service.perform(request({operation:'read',sessionId:id,after:0}));if(read.chunks?.some(c=>c.text.includes('REMOTE_READY')))break;await Bun.sleep(20);}
  const sentBefore=h.hostInbox.length;
  h.losePhoneReply();await expect(h.controller.sendTerminal(request({operation:'input',sessionId:id,data:'UNCERTAIN_PROBE\r'}))).rejects.toThrow('reply lost');
  if(delivered){await h.host.pollNow();await Bun.sleep(100);}
  clock+=11*60_000;
  let restored=h.restore(h.controller.snapshot());
  if(!delivered){
    h.losePhoneReply();await expect(restored.refresh()).rejects.toThrow('reply lost');
    const interrupted=restored.snapshot()!;
    expect(interrupted.pendingOutbound?.sequence).toBe(interrupted.sendSequence+1);
    expect(interrupted.sessionToken).toBe('');
    restored=h.restore(interrupted);
  }
  await restored.refresh();
  expect(restored.status().state).toBe('online');expect(restored.snapshot()!.claim.sessionId).toBe(before.claim.sessionId);
  expect(restored.snapshot()!.claim.expiresAt).toBe(before.claim.expiresAt);
  expect(f.service.remoteAllowed(h.owner)).toBe(true);
  const read=await restored.sendTerminal(request({operation:'read',sessionId:id,after:0}));
  const text=read.chunks!.map(c=>c.text).join('');
  if(delivered)expect(text).toContain('RESULT:UNCERTAIN_PROBE');
  expect((text.match(/RESULT:UNCERTAIN_PROBE/g)??[]).length).toBe(delivered?1:0);
  expect(h.hostInbox).toHaveLength(sentBefore+3); // uncertain input, checkpoint, read
 },15000);
 test('two remote hosts keep consent, sessions, reconnection and revocation independent', async()=>{
  const a=fixture(), b=fixture();
  const first=await terminalRelayHarness(a.gateway,a.remote), second=await terminalRelayHarness(b.gateway,b.remote);
  disposals.push(async()=>{await first.host.disable();await second.host.disable()});
  await first.connect();await second.connect();
  a.service.setRemoteAccess(first.owner,true);
  await expect(second.controller.sendTerminal(request({operation:'list'}))).rejects.toThrow('허용');
  b.service.setRemoteAccess(second.owner,true);
  const left=await first.controller.sendTerminal(request({operation:'start',targetId:first.controller.status().projects[0]!.controlId,agent:'claude',cols:80,rows:24}));
  const right=await second.controller.sendTerminal(request({operation:'start',targetId:second.controller.status().projects[0]!.controlId,agent:'codex',cols:80,rows:24}));
  expect(left.session!.id).not.toBe(right.session!.id);
  await expect(second.controller.sendTerminal(request({operation:'input',sessionId:left.session!.id,data:'wrong-host\r'}))).rejects.toThrow();
  const restored=first.restore(first.controller.snapshot());await restored.refresh();
  expect((await restored.sendTerminal(request({operation:'list'}))).sessions!.map(s=>s.id)).toEqual([left.session!.id]);
  await first.host.revokeSession(first.sessionId);await restored.refresh();
  expect(restored.status().state).not.toBe('online');
  expect((await second.controller.sendTerminal(request({operation:'list'}))).sessions!.map(s=>s.id)).toEqual([right.session!.id]);
  expect((await b.service.perform(request({operation:'list'}))).sessions![0]!.agent).toBe('codex');
 },15000);
 test('E2EE host + phone: separate consent, real PTY, lost response, restore and revoke',async()=>{
  const f=fixture(),h=await terminalRelayHarness(f.gateway,f.remote);disposals.push(async()=>{await h.host.disable()});
  await h.connect();expect(h.controller.status().state).toBe('online');
  await expect(h.controller.sendTerminal(request({operation:'list'}))).rejects.toThrow('허용');
  f.service.setRemoteAccess(h.owner,true);
  const refresh=h.controller.refresh();const listed=h.controller.sendTerminal(request({operation:'list'}));await refresh;expect((await listed).sessions).toEqual([]);
  const target=h.controller.status().projects[0]!.controlId;
  const start=request({operation:'start',targetId:target,agent:'codex',cols:80,rows:24});
  const begun=await h.controller.sendTerminal(start);const id=begun.session!.id;
  expect(begun.session!.targetId).toBe(target);expect(JSON.stringify(begun)).not.toContain('project-runtime-123');
  const untilOutput=async(text:string)=>{for(let n=0;n<200;n++){const r=await h.controller.sendTerminal(request({operation:'read',sessionId:id,after:0}));if(r.chunks!.map(c=>c.text).join('').includes(text))return r;await Bun.sleep(15)}throw new Error('missing '+text)};
  await untilOutput('REMOTE_READY');
  const input=request({operation:'input',sessionId:id,data:'secret-terminal-text\r'});
  h.loseHostReply();await expect(h.controller.sendTerminal(input)).rejects.toThrow('fixture host reply lost');
  await h.controller.refresh();
  // Semantic retry is a new encrypted envelope carrying the same request fence.
  await h.controller.sendTerminal(input);
  const read=await untilOutput('RESULT:secret-terminal-text');
  expect(read.chunks!.map(c=>c.text).join('')).toContain('RESULT:secret-terminal-text');
  expect(read.chunks!.map(c=>c.text).join('').match(/RESULT:secret-terminal-text/g)).toHaveLength(1);
  expect(h.ciphertexts()).not.toContain('secret-terminal-text');expect(h.ciphertexts()).not.toContain('terminal.request');
  const restored=h.restore(h.controller.snapshot());await restored.refresh();
  expect((await restored.sendTerminal(request({operation:'list'}))).sessions![0]!.id).toBe(id);
  f.service.setRemoteAccess(h.owner,false);
  await expect(restored.sendTerminal(request({operation:'input',sessionId:id,data:'forbidden\r'}))).rejects.toThrow('허용');
  await h.host.revokeSession(h.sessionId);await restored.refresh();expect(restored.status().state).not.toBe('online');
 },15000);

 test('LAN WebSocket: pairs, rejects cross-socket tokens, runs PTY and revokes on disconnect',async()=>{
  const address=Object.values(networkInterfaces()).flat().find(i=>i?.family==='IPv4'&&isPrivateRemoteControlIpv4(i.address))?.address;
  if(!address){console.info('LAN real-socket test unavailable: no RFC1918 interface');return;}
  const f=fixture();const server=new RemoteControlLanServer({bindAddress:address,hostName:'Fixture Mac',gateway:f.gateway,terminalGateway:f.remote});
  disposals.push(async()=>{server.stop()});const started=server.start();
  const origin='http://'+started.status.listener!.host+':'+started.status.listener!.port;
  const connect=async()=>{const socket=new WebSocket(origin.replace('http:','ws:')+'/remote/ws',{headers:{Origin:origin}} as any);const inbox:any[]=[];socket.addEventListener('message',e=>inbox.push(JSON.parse(String(e.data))));await new Promise<void>((resolve,reject)=>{socket.onopen=()=>resolve();socket.onerror=()=>reject(new Error('connect failed'))});disposals.push(async()=>{socket.close()});return{socket,async exchange(value:unknown){socket.send(JSON.stringify(value));for(let i=0;i<400;i++){if(inbox.length)return inbox.shift();await Bun.sleep(5)}throw new Error('reply timeout')}}};
  const phone=await connect();const token=new URL(started.pairing.pairingUrl).hash.slice(1);
  const ready=await phone.exchange({type:'controller.pair',protocolVersion:REMOTE_CONTROL_PROTOCOL_VERSION,token:new URLSearchParams(token).get('pair')});expect(ready.type).toBe('session.ready');
  const remote=(r:AiTerminalRequest)=>phone.exchange({type:'terminal.request',sessionToken:ready.sessionToken,request:r});
  expect((await remote(request({operation:'list'}))).ok).toBe(false);
  const owner='lan:'+server.status().sessions[0]!.id;f.service.setRemoteAccess(owner,true);
  const startedSession=await remote(request({operation:'start',targetId:ready.projects[0].controlId,agent:'claude',cols:80,rows:24}));normalizeRemoteTerminalResult(startedSession);const id=startedSession.body.session.id;
  // PTY startup and output delivery are asynchronous, particularly during a full build.
  // Wait for real readiness/output, with a bounded failure, rather than a 30ms scheduling assumption.
  const untilOutput=async(text:string)=>{
    for(let n=0;n<20;n++){
      const result=await remote(request({operation:'read',sessionId:id,after:0}));
      normalizeRemoteTerminalResult(result);
      if(result.body.chunks.map((c:any)=>c.text).join('').includes(text))return result;
      await Bun.sleep(200);
    }
    throw new Error('missing terminal output: '+text);
  };
  await untilOutput('REMOTE_READY');
  await remote(request({operation:'input',sessionId:id,data:'lan-typed\r'}));
  const read=await untilOutput('RESULT:lan-typed');expect(read.body.chunks.map((c:any)=>c.text).join('')).toContain('RESULT:lan-typed');
  const stranger=await connect();expect((await stranger.exchange({type:'terminal.request',sessionToken:ready.sessionToken,request:request({operation:'close',sessionId:id})})).ok).toBe(false);
  expect((await fetch(origin+'/api/agent-runtime/terminals')).status).toBe(404);
  expect((await fetch(origin+'/remote/xterm.js')).status).toBe(200);
  // A dropped socket is a locked phone, not a revoked device: the session stays listed and
  // restorable so the owner does not have to walk back to the Mac for a new QR. What must not
  // survive is privileged access — the session reports connected:false, which is what
  // aiTerminalConnections() filters on, and reconnecting mints a new management id so the
  // terminal grant given to the previous connection cannot come back with it.
  phone.socket.close();await Bun.sleep(50);
  const away=server.status().sessions;expect(away).toHaveLength(1);expect(away[0]!.connected).toBe(false);
  const retry=await connect();
  const restored=await retry.exchange({type:'session.restore',protocolVersion:REMOTE_CONTROL_PROTOCOL_VERSION,sessionToken:ready.sessionToken});
  expect(restored.type).toBe('session.restored');
  const back=server.status().sessions;expect(back).toHaveLength(1);expect(back[0]!.connected).toBe(true);
  expect('lan:'+back[0]!.id).not.toBe(owner);expect(f.service.remoteAllowed('lan:'+back[0]!.id)).toBe(false);
  // Revoking is still a real end: the session goes and its token stops restoring.
  server.revokeSession(back[0]!.id);expect(server.status().sessions).toHaveLength(0);
  const afterRevoke=await connect();
  expect((await afterRevoke.exchange({type:'session.restore',protocolVersion:REMOTE_CONTROL_PROTOCOL_VERSION,sessionToken:ready.sessionToken})).type).toBe('error');
  expect((await f.service.perform(request({operation:'list'}))).sessions![0]!.state).toBe('running');
 },15000);
});
