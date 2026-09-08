import {afterEach, describe, expect, test} from 'bun:test';
import {mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync, statSync, realpathSync, renameSync, mkdirSync, symlinkSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AiTerminalService, bindAiTerminalTarget, aiTerminalRegistrationEvidence, type AiTerminalResolvedTarget} from '../src/aiTerminalService';
import {resolveRegisteredAgentRuntimeTarget} from '../src/agentRuntimeTargetResolver';
import {normalizeAiTerminalRequest,normalizeAiTerminalResponse,type AiTerminalRequest} from '../src/aiTerminalProtocol';
import {normalizeRemoteTerminalRequest,normalizeRemoteTerminalResult} from '../src/remoteControlTerminalProtocol';
import {splitTerminalInput} from '../src/aiTerminalInput';
import {REMOTE_CONTROL_MOBILE_JS} from '../src/remoteControlMobilePage';

const services: AiTerminalService[]=[];const dirs:string[]=[];
afterEach(async()=>{await Promise.all(services.splice(0).map(s=>s.shutdown()));for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const req=(r:Omit<AiTerminalRequest,'requestId'>):AiTerminalRequest=>({...r,requestId:crypto.randomUUID()});
const targetId='project-fixture-123';
function fixture(script?:string, options: {maxBufferChars?:number;resolveTarget?:(id:string)=>Promise<AiTerminalResolvedTarget>;rememberEnded?:ConstructorParameters<typeof AiTerminalService>[0]['rememberEnded'];activity?:(cwd:string)=>void}={}) {
 const dir=mkdtempSync(join(tmpdir(),'agentstoz-pty-'));dirs.push(dir);
 const executable=join(dir,'cli');
 writeFileSync(executable,script??`#!/bin/sh
stty -echo
printf 'READY:%s:%s:%s\\n' "$(test -t 0 && echo tty)" "$PWD" "$(stty size)"
while IFS= read -r line; do
  if [ "$line" = size ]; then stty size; elif [ "$line" = quit ]; then exit 0; else printf 'GOT:%s\\n' "$line"; fi
done
`);chmodSync(executable,0o755);
 const service=new AiTerminalService({resolveTarget:options.resolveTarget??(async id=>{if(id!==targetId)throw new Error('unregistered');return{cwd:dir}}),executable:()=>executable,maxBufferChars:options.maxBufferChars,rememberEnded:options.rememberEnded,activity:options.activity});services.push(service);
 return {service,dir,executable};
}
async function output(service:AiTerminalService,id:string,contains:string) {
 const deadline=Date.now()+4000;let text='',cursor=0;
 while(Date.now()<deadline){const r=await service.perform(req({operation:'read',sessionId:id,after:cursor}));normalizeAiTerminalResponse(r);for(const c of r.chunks??[]){text+=c.text;cursor=c.seq;}if(text.includes(contains))return text;await Bun.sleep(15);}
 throw new Error('Missing output '+contains+': '+text);
}
const start=(service:AiTerminalService)=>service.perform(req({operation:'start',targetId,agent:'codex',cols:80,rows:24}));

describe('embedded AI terminal with real PTYs',()=>{
 test('successful Workroom activity hints contain only the bound root and capture failures cannot break input',async()=>{
  const roots:string[]=[];
  const {service,dir}=fixture(undefined,{activity:cwd=>{roots.push(cwd);throw Error('capture unavailable');}});
  const id=(await start(service)).session!.id;await output(service,id,'READY');
  expect(roots).toEqual([realpathSync(dir)]);
  await service.perform(req({operation:'resize',sessionId:id,cols:90,rows:30}));
  expect(roots).toHaveLength(1);
  await service.perform(req({operation:'input',sessionId:id,data:'private user words\r'}));
  await output(service,id,'GOT:private user words');
  expect(roots).toEqual([realpathSync(dir),realpathSync(dir)]);
  await service.perform(req({operation:'close',sessionId:id}));
  expect(roots).toEqual([realpathSync(dir),realpathSync(dir),realpathSync(dir)]);
  await expect(service.perform(req({operation:'input',sessionId:id,data:'after exit'}))).rejects.toThrow();
  expect(roots).toHaveLength(3);
 });
 test('registration evidence also tracks a folder alias when worktreePath takes execution priority',()=>{
  const dir=mkdtempSync(join(tmpdir(),'agentstoz-registry-evidence-'));dirs.push(dir);
  const first=join(dir,'first'),second=join(dir,'second'),linked=join(dir,'folder-link');mkdirSync(first);mkdirSync(second);symlinkSync(first,linked);
  const rows=[{id:targetId,folderPath:linked,worktreePath:second}];
  const before=aiTerminalRegistrationEvidence(rows);
  unlinkSync(linked);symlinkSync(second,linked);
  expect(aiTerminalRegistrationEvidence(rows)).not.toBe(before);
 });
 for (const mode of ['selected-path-retarget','other-path-becomes-alias'] as const) {
  test(`the live registered resolver rejects ${mode} without a ports.json edit`,async()=>{
   let binding:AiTerminalResolvedTarget|undefined;let fullResolutions=0;
   const {service,dir}=fixture(undefined,{resolveTarget:async id=>binding??=await bindAiTerminalTarget(async()=>{
    fullResolutions++;
    const resolved=resolveRegisteredAgentRuntimeTarget(id,JSON.parse(readFileSync(registry,'utf8')));
    if(!resolved.ok)throw new Error(resolved.error);
    return resolved;
   },target=>{const stat=statSync(target.cwd);return `${target.cwd}:${stat.dev}:${stat.ino}`;},async()=>
    aiTerminalRegistrationEvidence(JSON.parse(readFileSync(registry,'utf8'))))});
   const other=join(dir,'other');mkdirSync(other);
   const selectedLink=join(dir,'selected-link'),otherLink=join(dir,'other-link');
   symlinkSync(dir,selectedLink);symlinkSync(other,otherLink);
   const registry=join(dir,'registered.json');
   const rows=[{id:targetId,folderPath:selectedLink},...(mode==='other-path-becomes-alias'?[{id:'other-project-fixture',folderPath:otherLink}]:[])];
   writeFileSync(registry,JSON.stringify(rows));const original=readFileSync(registry,'utf8');
   const id=(await start(service)).session!.id;await output(service,id,'READY');
   await service.perform(req({operation:'input',sessionId:id,data:'BEFORE_CHANGE\r'}));
   expect(fullResolutions).toBe(2);
   const changedLink=mode==='selected-path-retarget'?selectedLink:otherLink;
   unlinkSync(changedLink);symlinkSync(mode==='selected-path-retarget'?other:dir,changedLink);
   await expect(service.perform(req({operation:'input',sessionId:id,data:'WRONG_CHECKOUT\r'}))).rejects.toThrow();
   expect(fullResolutions).toBe(3);expect(readFileSync(registry,'utf8')).toBe(original);
   expect(await output(service,id,'GOT:BEFORE_CHANGE')).not.toContain('WRONG_CHECKOUT');
  });
 }
 test('reuses an unchanged checkout proof while checking every input and rejects registration revocation',async()=>{
  let proofs=0,checks=0,revision=0,registered=true;let binding:AiTerminalResolvedTarget|undefined;
  const {service,dir}=fixture(undefined,{resolveTarget:async()=>binding??=await bindAiTerminalTarget(async()=>{
   proofs++;if(!registered)throw new Error('registration removed');return{cwd:dir};
  },target=>{checks++;const s=statSync(target.cwd);return `${realpathSync(target.cwd)}:${s.dev}:${s.ino}`;},()=>String(revision))});
  const id=(await start(service)).session!.id;await output(service,id,'READY');
  for(let n=0;n<20;n++)await service.perform(req({operation:'input',sessionId:id,data:`한글${n}\r`}));
  expect(await output(service,id,'GOT:한글19')).toContain('GOT:한글0');
  expect(proofs).toBe(2);expect(checks).toBeGreaterThanOrEqual(22);
  registered=false;revision++;
  await expect(service.perform(req({operation:'input',sessionId:id,data:'AFTER_REVOKE\r'}))).rejects.toThrow('registration removed');
  registered=true;revision++;
  await service.perform(req({operation:'input',sessionId:id,data:'AFTER_RESTORE\r'}));
  expect(await output(service,id,'GOT:AFTER_RESTORE')).not.toContain('AFTER_REVOKE');
  expect(proofs).toBe(4);
 });
 test('a replacement checkout at the same pathname cannot inherit a running terminal binding',async()=>{
  let binding:AiTerminalResolvedTarget|undefined;
  const {service,dir}=fixture(undefined,{resolveTarget:async()=>binding??=await bindAiTerminalTarget(async()=>({cwd:dir}),target=>{
   const s=statSync(target.cwd);return `${realpathSync(target.cwd)}:${s.dev}:${s.ino}`;
  },()=> 'registry-unchanged')});
  const id=(await start(service)).session!.id;await output(service,id,'READY');
  const previous=dir+'-previous';renameSync(dir,previous);dirs.push(previous);mkdirSync(dir);
  await expect(service.perform(req({operation:'input',sessionId:id,data:'REPLACEMENT\r'}))).rejects.toThrow('경로');
 });
 test('a changing initial proof and a revoked remote permission both fail before a PTY write',async()=>{
  let revision=0,calls=0;
  await expect(bindAiTerminalTarget(async()=>{if(++calls===2)revision++;return{cwd:tmpdir()};},t=>t.cwd,()=>String(revision))).rejects.toThrow('상태가 변경');
  let binding:AiTerminalResolvedTarget|undefined;let pause:Promise<void>|undefined;let entered!:()=>void;let release!:()=>void;
  const {service,dir}=fixture(undefined,{resolveTarget:async()=>binding??=await bindAiTerminalTarget(async()=>{
   entered?.();await pause;return{cwd:dir};
  },t=>t.cwd,()=>String(revision))});
  const id=(await start(service)).session!.id;await output(service,id,'READY');
  const authority={owner:'internet:proof-refresh',targets:new Set([targetId])};service.setRemoteAccess(authority.owner,true);
  const resolving=new Promise<void>(r=>{entered=r});pause=new Promise<void>(r=>{release=r});revision++;
  const result=service.perform(req({operation:'input',sessionId:id,data:'REVOKED_PROOF\r'}),authority).then(()=>null,e=>e);
  await resolving;service.setRemoteAccess(authority.owner,false);release();
  expect((await result)?.message).toContain('해제');
  expect(JSON.stringify(await service.perform(req({operation:'read',sessionId:id,after:0})))).not.toContain('REVOKED_PROOF');
 });
 test('close refuses to lose an unsaved queue request and normal shutdown records every session',async()=>{
  let refuse=true;const jobs:string[]=[];
  const {service}=fixture(undefined,{rememberEnded:job=>{if(refuse)throw new Error('queue unavailable');jobs.push(job.sessionId)}});
  const id=(await start(service)).session!.id;await output(service,id,'READY');
  await expect(service.perform(req({operation:'close',sessionId:id}))).rejects.toThrow('queue unavailable');
  expect((await service.perform(req({operation:'list'}))).sessions![0]!.state).toBe('running');
  refuse=false;await service.perform(req({operation:'close',sessionId:id}));expect(jobs).toContain(id);
  const second=(await start(service)).session!.id;await service.shutdown();expect(jobs).toContain(second);
 });
 test('opens a TTY in its registered cwd, orders input, resizes and exits',async()=>{
  const {service,dir}=fixture();const id=(await start(service)).session!.id;
  expect(await output(service,id,'READY:tty:')).toContain(dir);
  await Promise.all(['one','two','three'].map(data=>service.perform(req({operation:'input',sessionId:id,data:data+'\r'}))));
  expect(await output(service,id,'GOT:three')).toMatch(/GOT:one[\s\S]*GOT:two[\s\S]*GOT:three/);
  await service.perform(req({operation:'resize',sessionId:id,cols:110,rows:33}));
  await service.perform(req({operation:'input',sessionId:id,data:'size\r'}));expect(await output(service,id,'33 110')).toContain('33 110');
  const closed=await service.perform(req({operation:'close',sessionId:id}));expect(closed.session?.state).toBe('exited');
  await expect(service.perform(req({operation:'input',sessionId:id,data:'no'}))).rejects.toThrow('종료');
 });
 test('deduplicates starts and input, and refuses request ID reuse with different data',async()=>{
  const {service}=fixture();const request=req({operation:'start',targetId,agent:'codex',cols:80,rows:24});
  const both=await Promise.all([service.perform(request),service.perform(request)]);expect(both[0]!.session!.id).toBe(both[1]!.session!.id);
  const id=both[0]!.session!.id;await output(service,id,'READY');
  const input=req({operation:'input',sessionId:id,data:'exactly-once\r'});await Promise.all([service.perform(input),service.perform(input)]);
  expect((await output(service,id,'GOT:exactly-once')).match(/GOT:exactly-once/g)?.length).toBe(1);
  await expect(service.perform({...input,data:'different\r'})).rejects.toThrow('같은 요청');
 });
 test('denies remote access by default, scopes targets, fences revoked queued input',async()=>{
  let pause:Promise<void>|undefined;let release!:()=>void;let resolving!:()=>void;
  const {service,dir}=fixture(undefined,{resolveTarget:async()=>{resolving?.();await pause;return{cwd:dir}}});
  const id=(await start(service)).session!.id;await output(service,id,'READY');
  const authority={owner:'internet:controller-1',targets:new Set([targetId])};
  await expect(service.perform(req({operation:'list'}),authority)).rejects.toThrow('허용');
  service.setRemoteAccess(authority.owner,true);
  expect((await service.perform(req({operation:'list'}),authority)).sessions).toHaveLength(1);
  await expect(service.perform(req({operation:'read',sessionId:id,after:0}),{...authority,targets:new Set()})).rejects.toThrow('접근');
  const entered=new Promise<void>(r=>{resolving=r});pause=new Promise(r=>{release=r});
  const pending=service.perform(req({operation:'input',sessionId:id,data:'REVOKED\r'}),authority);const outcome=pending.then(()=>null,e=>e);
  await entered;service.setRemoteAccess(authority.owner,false);service.setRemoteAccess(authority.owner,true);release();expect((await outcome)?.message).toContain('해제');pause=undefined;
  const r=await service.perform(req({operation:'read',sessionId:id,after:0}));expect(JSON.stringify(r)).not.toContain('REVOKED');
  service.setRemoteAccess(authority.owner,false);await expect(service.perform(req({operation:'close',sessionId:id}),authority)).rejects.toThrow('허용');
 });
 test('bounds replay while preserving final output after process exit',async()=>{
  const {service}=fixture('#!/bin/sh\nhead -c 60000 /dev/zero | tr "\\000" x\nprintf "END_OF_OUTPUT\\n"\n',{maxBufferChars:10000});
  const id=(await start(service)).session!.id;await output(service,id,'END_OF_OUTPUT');
  const first=await service.perform(req({operation:'read',sessionId:id,after:0}));expect(first.truncated).toBe(true);expect(first.chunks!.length).toBeLessThanOrEqual(4);
  expect(await output(service,id,'END_OF_OUTPUT')).toContain('END_OF_OUTPUT');
 });
 test('keeps escape-heavy output under the encrypted relay plaintext limit',async()=>{
  const {service}=fixture('#!/bin/sh\nhead -c 40000 /dev/zero\nprintf END\n');const id=(await start(service)).session!.id;await output(service,id,'END');
  let cursor=0;for(let n=0;n<100;n++){const r=await service.perform(req({operation:'read',sessionId:id,after:cursor}));expect(new TextEncoder().encode(JSON.stringify({type:'terminal.result',requestId:crypto.randomUUID(),ok:true,body:r})).length).toBeLessThan(11000);cursor=r.nextCursor!;if(!r.hasMore)break;}
 });
 test('passes prompt as one argument without shell interpolation or authority environment',async()=>{
  const {service,dir}=fixture('#!/bin/sh\nprintf "ARG1:%s\\nARG2:%s\\n" "$1" "$2"\n');
  const marker=join(dir,'injected');const prompt='quoted " $(touch '+marker+') ; echo nope';
  const id=(await service.perform(req({operation:'start',targetId,agent:'codex',cols:80,rows:24,prompt}))).session!.id;
  expect(await output(service,id,'ARG2:')).toContain(prompt);expect(existsSync(marker)).toBe(false);
 });
 test('fails closed if registered directory changes after session creation',async()=>{
  let other=false;const {service,dir}=fixture(undefined,{resolveTarget:async()=>({cwd:other?tmpdir():dir})});
  const id=(await start(service)).session!.id;other=true;
  await expect(service.perform(req({operation:'input',sessionId:id,data:'bad\r'}))).rejects.toThrow('경로');
  expect((await service.perform(req({operation:'close',sessionId:id}))).session?.state).toBe('exited');
 });
});

describe('terminal protocol and mobile browser payload',()=>{
 test('rejects path, shell, environment, unknown agents and oversized input',()=>{
  const r=req({operation:'start',targetId,agent:'codex',cols:80,rows:24});
  for(const extra of [{cwd:'/tmp'},{command:'sh'},{env:{}},{agent:'bash'},{cols:999}])expect(()=>normalizeAiTerminalRequest({...r,...extra})).toThrow();
  expect(()=>normalizeAiTerminalRequest(req({operation:'input',sessionId:'session-fixture',data:'한'.repeat(1400)}))).toThrow();
  expect(()=>normalizeRemoteTerminalRequest({type:'terminal.request',sessionToken:'a'.repeat(43),request:r,capability:'forged'})).toThrow();
  expect(()=>normalizeRemoteTerminalResult({type:'terminal.result',requestId:r.requestId,ok:true,body:{sessions:[{id:'raw',cwd:'/secret'}]}})).toThrow();
 });
 test('Korean/emoji paste splits without truncation and each wire frame remains within its bound',()=>{
  const text='가나다🐳😀'.repeat(2000);const chunks=splitTerminalInput(text);expect(chunks.join('')).toBe(text);
  expect(chunks.every(c=>new TextEncoder().encode(c).length<=4096)).toBe(true);
  expect(splitTerminalInput('\0'.repeat(12000)).every(c=>new TextEncoder().encode(JSON.stringify(c)).length<8000)).toBe(true);
 });
 test('the exact shipped LAN JavaScript parses with terminal key escapes',()=>{
  expect(()=>new Function(REMOTE_CONTROL_MOBILE_JS)).not.toThrow();
  expect(REMOTE_CONTROL_MOBILE_JS).toContain("['terminal-enter','\\r']");
 });
});
