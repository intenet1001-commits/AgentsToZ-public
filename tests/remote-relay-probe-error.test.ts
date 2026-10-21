import {afterEach,describe,expect,test} from 'bun:test';
import {mkdtempSync,chmodSync,writeFileSync,rmSync,realpathSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AiTerminalService} from '../src/aiTerminalService';
import {createAiTerminalRemoteGateway} from '../src/aiTerminalRemoteGateway';
import type {RemoteControlGateway} from '../src/remoteControlCore';
import {AI_TERMINAL_REQUEST_INVALID_CODE,type AiTerminalRequest} from '../src/aiTerminalProtocol';
import {resolveVerifiedRemoteTargetAuthorities,type RemoteTargetDirectory} from '../src/remoteControlTargetAuthorities';
import {terminalRelayHarness} from './fixtures/terminalRelayHarness';

/**
 * w2-followups #22: an older forwarding Mac refuses a read-only probe it cannot parse (`recent`, `status`, the
 * capability `list`). The caller handles that refusal (it falls back to a plain start), so the controller must not keep
 * the refusal as its standing #error — the portal shows `status().error` as a relay failure until the next request.
 * A snapshot read was the only probe cleared before. A refused request that is not a probe keeps its error.
 */
const disposals:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const f of disposals.splice(0).reverse())await f();});
const request=(r:Record<string,unknown>):AiTerminalRequest=>({...r,requestId:crypto.randomUUID()}) as AiTerminalRequest;
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'relay-probe-')),cli=join(dir,'cli');
 writeFileSync(cli,'#!/bin/sh\nwhile IFS= read -r line; do :; done\n');chmodSync(cli,0o755);
 const service=new AiTerminalService({resolveTarget:async id=>{if(id!=='project-runtime-123')throw new Error('unregistered');return{cwd:dir}},executable:()=>cli});
 disposals.push(async()=>{await service.shutdown();rmSync(dir,{recursive:true,force:true})});
 const gateway:RemoteControlGateway={listRegisteredProjects:()=>[{internalId:'private-project',name:'Fixture project',port:null,command:null,kind:'main',folderPath:dir,status:'unknown',actions:['folder.open']}],executeRegisteredProjectAction:()=>{}};
 const directory=(path:string):RemoteTargetDirectory=>{try{const canonical=realpathSync(path),info=statSync(canonical);return info.isDirectory()?{status:'found',path:canonical,dev:info.dev,ino:info.ino}:{status:'missing'};}catch{return{status:'unknown'};}};
 const remote=createAiTerminalRemoteGateway({service,active:()=>true,resolve:async bindings=>resolveVerifiedRemoteTargetAuthorities(bindings,[{targetId:'project-runtime-123',cwd:dir}],directory,(a,b)=>a.path===b.path&&a.dev===b.dev&&a.ino===b.ino)});
 return{service,gateway,remote};
}
const ptyDescribe=process.platform==='win32'?describe.skip:describe;
ptyDescribe('relay controller after an unparsed read-only probe',()=>{
 // The host here parses every real request, so the refusal is produced the way an older Mac produces it: a request it
 // cannot normalize (an extra key) is answered `{type:'error', code: TERMINAL_REQUEST_INVALID}` before anything runs.
 const probes:[string,Record<string,unknown>][]=[
  ['recent',{operation:'submission',submission:{phase:'recent',fromNewerClient:true}}],
  ['status',{operation:'submission',submission:{phase:'status',id:'abcdefgh-1234',fromNewerClient:true}}],
  ['capability list',{operation:'list',capabilities:true,fromNewerClient:true}],
 ];
 for(const [name,body] of probes)test(`a refused ${name} probe does not leave a standing relay error`,async()=>{
  const f=fixture(),h=await terminalRelayHarness(f.gateway,f.remote);disposals.push(async()=>{await h.host.disable()});
  await h.connect();f.service.setRemoteAccess(h.owner,true);
  const refused=await h.controller.sendTerminal(request(body)).then(()=>null,error=>error);
  expect(refused?.code).toBe(AI_TERMINAL_REQUEST_INVALID_CODE);
  expect(h.controller.status().error).toBeNull();
 },15000);
 test('a refused request that is not a read-only probe still reports its error',async()=>{
  const f=fixture(),h=await terminalRelayHarness(f.gateway,f.remote);disposals.push(async()=>{await h.host.disable()});
  await h.connect();f.service.setRemoteAccess(h.owner,true);
  const refused=await h.controller.sendTerminal(request({operation:'input',sessionId:'abcdefgh-1234',data:'x',fromNewerClient:true})).then(()=>null,error=>error);
  expect(refused?.code).toBe(AI_TERMINAL_REQUEST_INVALID_CODE);
  expect(h.controller.status().error).toBeTruthy();
 },15000);
});
