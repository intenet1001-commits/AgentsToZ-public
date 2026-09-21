import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PrivateRemoteTerminalGrantStore} from '../src/remoteTerminalGrantStore';
import {remoteTerminalGrantValid,remoteTerminalGrantAllowsTarget,REMOTE_TERMINAL_GRANT_TTL_MS,type RemoteTerminalGrant} from '../src/remoteTerminalGrant';
import {AiTerminalService} from '../src/aiTerminalService';
import {createAiTerminalRemoteGateway} from '../src/aiTerminalRemoteGateway';
const now=Date.parse('2026-09-10T00:00:00Z');
function grant():RemoteTerminalGrant{return {hostId:'host',controllerId:'phone',scope:{kind:'targets',targetIds:['target']},grantedAt:new Date(now).toISOString(),expiresAt:new Date(now+REMOTE_TERMINAL_GRANT_TTL_MS).toISOString(),revision:1,revokedAt:null};}
test('remoteTerminalGrant_sameDeviceReconnect_reusesExplicitGrant',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'terminal-grants-'));try{
 const first=new PrivateRemoteTerminalGrantStore(dir),g=grant();g.hostId=first.hostId;
 expect(await first.update(g,null)).toBe(true);
 const restarted=new PrivateRemoteTerminalGrantStore(dir);expect(restarted.hostId).toBe(first.hostId);
 expect(remoteTerminalGrantValid(await restarted.find(g.hostId,g.controllerId),g,now+REMOTE_TERMINAL_GRANT_TTL_MS-60000)).toBe(true);
 expect(await restarted.update({...g,revision:2,revokedAt:new Date(now+1000).toISOString()},1)).toBe(true);
 expect(await first.update({...g,revision:2},1)).toBe(false);
 expect(remoteTerminalGrantValid(await first.find(g.hostId,g.controllerId),g,now+2000)).toBe(false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('remoteTerminalGrant_changedBindingOrExpiry_requiresNewConsent',()=>{
 const g=grant();expect(remoteTerminalGrantValid(g,g,now+REMOTE_TERMINAL_GRANT_TTL_MS)).toBe(false);
 expect(remoteTerminalGrantValid(g,{...g,controllerId:'other'},now)).toBe(false);
 expect(remoteTerminalGrantValid(g,{...g,hostId:'other'},now)).toBe(false);
 expect(remoteTerminalGrantValid(g,{...g,expiresAt:new Date(now+1).toISOString()},now+1)).toBe(false);
 const root={...g,scope:{kind:'controller-created-projects' as const,workspaceRoots:[{workspaceRootId:'root',identityHash:'inode'}]}};
 const evidence={controllerId:'phone',workspaceRootId:'root',identityHash:'inode',registered:true};
 expect(remoteTerminalGrantAllowsTarget(root,'new',evidence)).toBe(true);
 for(const bad of [{...evidence,controllerId:'other'},{...evidence,identityHash:'replaced'},{...evidence,registered:false}])expect(remoteTerminalGrantAllowsTarget(root,'new',bad)).toBe(false);
});
test('remoteTerminalGrant_legacySessionScope_doesNotMigrateConsent',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'terminal-grants-'));try{const store=new PrivateRemoteTerminalGrantStore(dir);expect(await store.find('host','phone')).toBe(null);writeFileSync(store.path,'broken',{mode:0o600});await expect(store.update(grant(),null)).rejects.toThrow();}finally{rmSync(dir,{recursive:true,force:true});}
});
test('remoteTerminalGrant_revokedDuringAwait_blocksQueuedIO',async()=>{
 const service=new AiTerminalService({resolveTarget:async()=>{throw new Error('must not spawn')},executable:()=>''});
 let live=true,release!:()=>void;const ready=new Promise<void>(r=>release=r);
 const remote=createAiTerminalRemoteGateway({service,active:()=>true,resolve:async()=>{await ready;return[]},consent:async()=>({targetIds:new Set(),isActive:()=>live})});
 const pending=remote({operation:'list',requestId:'request-123'},[],'socket-1');live=false;release();await expect(pending).rejects.toThrow('허용');await service.shutdown();
});
test('remoteReconnect_newSocketEpoch_rejectsOldSocket',async()=>{
 const service=new AiTerminalService({resolveTarget:async()=>{throw new Error('must not spawn')},executable:()=>''});
 let current=1;
 const remote=createAiTerminalRemoteGateway({service,active:()=>true,resolve:async()=>[],consent:async()=>({targetIds:new Set(),isActive:()=>true})});
 current=2;await expect(remote({operation:'list',requestId:'request-old'},[],'same-device',()=>current===1)).rejects.toThrow('종료');
 expect((await remote({operation:'list',requestId:'request-new'},[],'same-device',()=>current===2)).sessions).toEqual([]);expect(service.remoteAllowed('same-device')).toBe(false);await service.shutdown();
});
test('durable consent is checked after the actual checkout await, before starting a CLI',async()=>{
 let release!:()=>void,entered!:()=>void,live=true,spawnChecks=0;
 const waiting=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
 const service=new AiTerminalService({resolveTarget:async()=>{entered();await waiting;return {cwd:tmpdir()}},executable:()=>{spawnChecks++;return '/bin/sh'}});
 const remote=createAiTerminalRemoteGateway({service,active:()=>true,resolve:async()=>[{controlId:'control-target',runtimeTargetId:'target-runtime'}],consent:async()=>({targetIds:new Set(['target-runtime']),isActive:()=>live})});
 const operation=remote({operation:'start',requestId:'request-start-123',targetId:'control-target',agent:'codex',cols:80,rows:24},[],'new-socket');
 await started;live=false;release();await expect(operation).rejects.toThrow('해제');expect(spawnChecks).toBe(0);await service.shutdown();
});
test('device request identity fences a lost start and input response across socket replacement',async()=>{
 let finish!:(code:number)=>void,eof=()=>{},spawns=0,writes=0;
 const exited=new Promise<number>(r=>finish=r);
 const service=new AiTerminalService({resolveTarget:async()=>({cwd:tmpdir()}),executable:()=>'/bin/sh',spawn:(_args,options)=>{spawns++;eof=(options.terminal as {exit:()=>void}).exit;return{pid:123,exited,kill:()=>{},terminal:{write:()=>++writes,resize:()=>{},close:()=>{}}}},signalGroup:()=>{eof();finish(0)}});
 const remote=createAiTerminalRemoteGateway({service,active:()=>true,resolve:async()=>[{controlId:'control-target',runtimeTargetId:'target-runtime'}],consent:async()=>({requestOwner:'device:host:phone',targetIds:new Set(['target-runtime']),isActive:()=>true})});
 const start={operation:'start' as const,requestId:'start-request',targetId:'control-target',agent:'codex' as const,cols:80,rows:24};
 try{
 const first=await remote(start,[],'socket-first');const second=await remote(start,[],'socket-second');expect(second.session!.id).toBe(first.session!.id);expect(spawns).toBe(1);
 const input={operation:'input' as const,requestId:'input-request',sessionId:first.session!.id,data:'hello'};
 await remote(input,[],'socket-first');await remote(input,[],'socket-second');expect(writes).toBe(1);
 }finally{await service.shutdown();}
});
test('two independent processes contend for one durable grant revision',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'terminal-grant-processes-'));
 try{
  const initial=new PrivateRemoteTerminalGrantStore(dir),g=grant();await initial.update(g,null);
  const module=join(import.meta.dir,'../src/remoteTerminalGrantStore.ts');
  const source=`import {PrivateRemoteTerminalGrantStore} from ${JSON.stringify(module)};const input=JSON.parse(await Bun.stdin.text());const store=new PrivateRemoteTerminalGrantStore(input.dir);const result=await store.update(input.grant,1);process.stdout.write(JSON.stringify({result,hostId:store.hostId}));`;
  const children=[1,2].map(()=>Bun.spawn([process.execPath,'-e',source],{stdin:'pipe',stdout:'pipe',stderr:'pipe'}));
  children.forEach(child=>{child.stdin.write(JSON.stringify({dir,grant:{...g,revision:2}}));child.stdin.end();});
  const outputs=await Promise.all(children.map(async child=>{const [output,error,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);expect(error).toBe('');expect(code).toBe(0);return JSON.parse(output);}));
  expect(outputs.filter(o=>o.result)).toHaveLength(1);expect(outputs[0].hostId).toBe(outputs[1].hostId);expect(initial.current(g.hostId,g.controllerId)?.revision).toBe(2);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('concurrent first readers publish one complete host identity',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'terminal-host-identity-'));
 try{
  const module=join(import.meta.dir,'../src/remoteTerminalGrantStore.ts');
  const source=`import {PrivateRemoteTerminalGrantStore} from ${JSON.stringify(module)};const dir=await Bun.stdin.text();process.stdout.write(new PrivateRemoteTerminalGrantStore(dir).hostId);`;
  const children=Array.from({length:8},()=>Bun.spawn([process.execPath,'-e',source],{stdin:'pipe',stdout:'pipe',stderr:'pipe'}));
  children.forEach(child=>{child.stdin.write(dir);child.stdin.end();});
  const identities=await Promise.all(children.map(async child=>{
   const [output,error,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
   expect(code).toBe(0);expect(error).toBe('');expect(output).toMatch(/^[A-Za-z0-9_-]{43}$/);return output;
  }));
  expect(new Set(identities).size).toBe(1);
  expect(new PrivateRemoteTerminalGrantStore(dir).hostId).toBe(identities[0]!);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
