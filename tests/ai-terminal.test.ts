import {afterEach, describe, expect, test} from 'bun:test';
import {mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync, statSync, realpathSync, renameSync, mkdirSync, symlinkSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AiTerminalService, AI_TERMINAL_WINDOWS_UNSUPPORTED, aiTerminalWindowsStartBlocked, bindAiTerminalTarget, aiTerminalRegistrationEvidence, writeAiTerminalInput, type AiTerminalResolvedTarget} from '../src/aiTerminalService';
import {resolveRegisteredAgentRuntimeTarget} from '../src/agentRuntimeTargetResolver';
import {AI_TERMINAL_PROMPT_REFERENCES_TOO_LARGE_ERROR,normalizeAiTerminalRequest,normalizeAiTerminalResponse,type AiTerminalRequest} from '../src/aiTerminalProtocol';
import {AiTerminalScreen} from '../src/aiTerminalScreen';
import {normalizeRemoteTerminalRequest,normalizeRemoteTerminalResult} from '../src/remoteControlTerminalProtocol';
import {createTerminalCompositionOverlapFilter,createTerminalHangulInputFallback,splitTerminalInput} from '../src/aiTerminalInput';
import {REMOTE_CONTROL_MOBILE_JS} from '../src/remoteControlMobilePage';

const services: AiTerminalService[]=[];const dirs:string[]=[];
afterEach(async()=>{await Promise.all(services.splice(0).map(s=>s.shutdown()));for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const req=(r:Omit<AiTerminalRequest,'requestId'>):AiTerminalRequest=>({...r,requestId:crypto.randomUUID()});
/**
 * The fake CLIs below are POSIX shell scripts (`stty`, `read`, `/dev/zero`), so
 * Windows cannot execute one at all: CreateProcess fails with error 193
 * (ERROR_BAD_EXE_FORMAT) before any service logic runs, which turned every case
 * here into a red failure that hid real regressions. These cases cover the
 * service's ordering, fences and permission checks -- not the PTY backend, which
 * `tests/windows-pty.test.ts` exercises against a real ConPTY session (output,
 * input echo, resize, exit code, tree kill). Skipped with a reason rather than
 * failed, so Windows still reports honestly.
 */
const posixCli = process.platform !== 'win32';
const ptyTest = posixCli ? test : test.skip;
const ptyDescribe = posixCli ? describe : describe.skip;
const targetId='project-fixture-123';
function fixture(script?:string, options: {maxBufferChars?:number;resolveTarget?:(id:string)=>Promise<AiTerminalResolvedTarget>;rememberEnded?:ConstructorParameters<typeof AiTerminalService>[0]['rememberEnded'];activity?:(cwd:string)=>void;verifySavedBeforeClose?:ConstructorParameters<typeof AiTerminalService>[0]['verifySavedBeforeClose']}={}) {
 const dir=mkdtempSync(join(tmpdir(),'agentstoz-pty-'));dirs.push(dir);
 const executable=join(dir,'cli');
 writeFileSync(executable,script??`#!/bin/sh
stty -echo
printf 'READY:%s:%s:%s\\n' "$(test -t 0 && echo tty)" "$PWD" "$(stty size)"
while IFS= read -r line; do
  if [ "$line" = size ]; then stty size; elif [ "$line" = quit ]; then exit 0; else printf 'GOT:%s\\n' "$line"; fi
done
`);chmodSync(executable,0o755);
 const service=new AiTerminalService({resolveTarget:options.resolveTarget??(async id=>{if(id!==targetId)throw new Error('unregistered');return{cwd:dir}}),executable:()=>executable,maxBufferChars:options.maxBufferChars,rememberEnded:options.rememberEnded,activity:options.activity,verifySavedBeforeClose:options.verifySavedBeforeClose});services.push(service);
 return {service,dir,executable};
}
async function output(service:AiTerminalService,id:string,contains:string) {
 const deadline=Date.now()+4000;let text='',cursor=0;
 while(Date.now()<deadline){const r=await service.perform(req({operation:'read',sessionId:id,after:cursor}));normalizeAiTerminalResponse(r);for(const c of r.chunks??[]){text+=c.text;cursor=c.seq;}if(text.includes(contains))return text;await Bun.sleep(15);}
 throw new Error('Missing output '+contains+': '+text);
}
const start=(service:AiTerminalService)=>service.perform(req({operation:'start',targetId,agent:'codex',cols:80,rows:24}));

ptyTest('voice host environment key is not inherited by a Workroom CLI',async()=>{
 const {dir,executable}=fixture('#!/bin/sh\nprintf "VOICE_KEY:%s\\n" "${AGENTSTOZ_VOICE_API_KEY-unset}"\nread line\n');
 const service=new AiTerminalService({resolveTarget:async()=>({cwd:dir}),executable:()=>executable,env:{...process.env,AGENTSTOZ_VOICE_API_KEY:'fixture-host-secret'}});services.push(service);
 const id=(await start(service)).session!.id;const text=await output(service,id,'VOICE_KEY:unset');expect(text).not.toContain('fixture-host-secret');
});

test('every CLI receives pasted instructions before a separate Enter',async()=>{
 const writes:string[]=[];const terminal={write:(data:string)=>{writes.push(data);return data.length;}};
 await writeAiTerminalInput('hermes',terminal,'한글 지시\r');
 expect(writes).toEqual(['한글 지시','\r']);
 writes.length=0;await writeAiTerminalInput('agy',terminal,'READY\r');expect(writes).toEqual(['READY','\r']);
 writes.length=0;await writeAiTerminalInput('codex',terminal,'한 번에\r');expect(writes).toEqual(['한 번에','\r']);
 writes.length=0;await writeAiTerminalInput('claude',terminal,'Claude\r');expect(writes).toEqual(['Claude','\r']);
 writes.length=0;await writeAiTerminalInput('codex',terminal,'\r');expect(writes).toEqual(['\r']);
 // Multi-line text is one bracketed paste only when the CLI's screen turned bracketed paste on.
 writes.length=0;await writeAiTerminalInput('claude',terminal,'첫 줄\n둘째 줄\r',{bracketedPaste:true});expect(writes).toEqual(['\x1b[200~첫 줄\r둘째 줄\x1b[201~','\r']);
 writes.length=0;await writeAiTerminalInput('claude',terminal,'첫 줄\n둘째 줄\r',{bracketedPaste:false});expect(writes).toEqual(['첫 줄\n둘째 줄','\r']);
});

ptyDescribe('multi-line Workroom input follows the CLI screen (2026-09-29)',()=>{
 // Raw mode first, then the ready line: every byte the service writes is captured unchanged.
 const capture=(enable:boolean,bytes:number)=>`#!/bin/sh\nstty raw -echo\nprintf '${enable?'\\033[?2004h':''}PASTE_READY\\r\\n'\nhead -c ${bytes} > "$PWD/pasted"\nprintf 'CAPTURED\\r\\n'\nsleep 5\n`;
 test('a CLI that turned bracketed paste on receives one paste and then a separate Enter',async()=>{
  const {service,dir}=fixture(capture(true,30));
  const id=(await start(service)).session!.id;await output(service,id,'PASTE_READY');
  await service.perform(req({operation:'input',sessionId:id,data:'line one\nline two\r'}));
  await output(service,id,'CAPTURED');
  expect(readFileSync(join(dir,'pasted'),'utf8')).toBe('\x1b[200~line one\rline two\x1b[201~\r');
  await service.perform(req({operation:'close',sessionId:id}));
 });
 test('without the CLI turning it on, the bytes stay exactly as before',async()=>{
  const {service,dir}=fixture(capture(false,18));
  const id=(await start(service)).session!.id;await output(service,id,'PASTE_READY');
  await service.perform(req({operation:'input',sessionId:id,data:'line one\nline two\r'}));
  await output(service,id,'CAPTURED');
  expect(readFileSync(join(dir,'pasted'),'utf8')).toBe('line one\nline two\r');
  await service.perform(req({operation:'close',sessionId:id}));
 });
});

ptyDescribe('embedded AI terminal with real PTYs',()=>{
 test('explicit bypass reaches each real PTY argv and changing it cannot replay the same start ID',async()=>{
  const {service,dir}=fixture('#!/bin/sh\nprintf "%s\\n" "$@" > "$PWD/launch-args"\nprintf "ARGS_READY\\n"\nread line\n');
  const flags={codex:'--dangerously-bypass-approvals-and-sandbox',claude:'bypassPermissions',hermes:'--yolo',agy:'--dangerously-skip-permissions'};
  for(const agent of ['codex','claude','hermes','agy'] as const){
   const request=req({operation:'start',targetId,agent,cols:80,rows:24,bypassPermissions:true,prompt:'fixture task'});
   const result=await service.perform(request);await output(service,result.session!.id,'ARGS_READY');
   expect(readFileSync(join(dir,'launch-args'),'utf8').split('\n')).toContain(flags[agent]);
   await expect(service.perform({...request,bypassPermissions:false})).rejects.toThrow();
   await service.perform(req({operation:'close',sessionId:result.session!.id}));
  }
 });
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
  const {service,dir}=fixture('#!/bin/sh\nprintf "ARG1:%s\\nARG2:%s\\nARG3:%s\\nARG4:%s\\n" "$1" "$2" "$3" "$4"\n');
  const marker=join(dir,'injected');const prompt='quoted " $(touch '+marker+') ; echo nope';
  const id=(await service.perform(req({operation:'start',targetId,agent:'codex',cols:80,rows:24,prompt}))).session!.id;
  expect(await output(service,id,'ARG4:')).toContain(prompt);expect(existsSync(marker)).toBe(false);
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
 test('macOS WKWebView compatibility jamo are assembled without changing normal terminal input',()=>{
  const input=createTerminalHangulInputFallback();
  for(const character of 'ㄱㅏㄴㅡㄹㅏ')expect(input.push(character)).toEqual({ready:'',pending:true});
  expect(input.flush()).toBe('가느라');
  expect(input.push('ㅎㅏㄴㄱㅡㄹ ')).toEqual({ready:'한글 ',pending:false});
  expect(input.push('ㅇㅏㄴㄴㅕㅇㅎㅏㅅㅔㅇㅛ\r')).toEqual({ready:'안녕하세요\r',pending:false});
  expect(input.push('ㄷㅏㄺ ')).toEqual({ready:'닭 ',pending:false});
  expect(input.push('한글 English 🙂🚀\u001b[A')).toEqual({ready:'한글 English 🙂🚀\u001b[A',pending:false});
  expect(input.push('ㅋㅋㅋ ')).toEqual({ready:'ㅋㅋㅋ ',pending:false});
  expect(input.flush()).toBe('');
 });
 test('an adjacent xterm IME suffix overlap is retracted only inside its short composition window',()=>{
  let time=100;
  const input=createTerminalCompositionOverlapFilter(()=>time);
  expect(input.push('🙂🚀')).toEqual({data:'🙂🚀',retract:''});
  time+=12;
  expect(input.push('영🙂🚀')).toEqual({data:'영🙂🚀',retract:'🙂🚀'});
  time+=100;
  expect(input.push('다영🙂🚀')).toEqual({data:'다영🙂🚀',retract:''});
  time+=1;
  expect(input.push('a')).toEqual({data:'a',retract:''});
  expect(input.push('b')).toEqual({data:'b',retract:''});
 });
 test('the exact shipped LAN JavaScript parses with terminal key escapes',()=>{
  expect(()=>new Function(REMOTE_CONTROL_MOBILE_JS)).not.toThrow();
  expect(REMOTE_CONTROL_MOBILE_JS).toContain("['terminal-enter','\\r']");
 });
});

ptyTest('explicit skip suppresses exit and shutdown memory hooks without deleting records',async()=>{
 const jobs:string[]=[];const {service}=fixture(undefined,{rememberEnded:s=>jobs.push(s.sessionId)});
 const id=(await start(service)).session!.id;await output(service,id,'READY');
 await service.perform(req({operation:'close',sessionId:id,memoryPolicy:'skip'}));await service.shutdown();expect(jobs).toEqual([]);
});
ptyTest('save-before-close keeps CLI alive on failed verification and closes once after verified input revision',async()=>{
 let allow=false,verifiedRevision=-1;const jobs:string[]=[];
 const {service}=fixture(undefined,{rememberEnded:s=>jobs.push(s.sessionId),verifySavedBeforeClose:async(s,id,owner)=>{expect(id).toBe('receipt-1234');expect(owner).toBe('local');verifiedRevision=s.inputRevision;if(!allow)throw Error('unconfirmed');}});
 const id=(await start(service)).session!.id;await output(service,id,'READY');
 await expect(service.perform(req({operation:'close',sessionId:id,memoryPolicy:'saved',saveRequestId:'receipt-1234'}))).rejects.toThrow('unconfirmed');
 expect(service.inspectSession(id,targetId).state).toBe('running');expect(jobs).toEqual([]);
 await service.perform(req({operation:'input',sessionId:id,data:'hello\r'}));allow=true;
 expect((await service.perform(req({operation:'close',sessionId:id,memoryPolicy:'saved',saveRequestId:'receipt-1234'}))).session?.state).toBe('exited');expect(verifiedRevision).toBe(1);expect(jobs).toEqual([]);
});
test('close protocol requires an exact receipt only for saved policy',()=>{
 for(const extra of [{memoryPolicy:'saved'},{memoryPolicy:'skip',saveRequestId:'receipt-1234'},{memoryPolicy:'unknown'},{saveRequestId:'receipt-1234'}])expect(()=>normalizeAiTerminalRequest(req({operation:'close',sessionId:'session-1234',...extra} as any))).toThrow();
});

ptyDescribe('Workroom # project references (VOC 2026-09-24)',()=>{
 test('the host appends the verified folder of each referenced project before Enter',async()=>{
  const refDir=mkdtempSync(join(tmpdir(),'agentstoz-ref-'));dirs.push(refDir);
  let dir='';
  const {service,dir:own}=fixture(undefined,{resolveTarget:async id=>{if(id===targetId)return{cwd:dir};if(id==='ref-project-1')return{cwd:refDir};throw new Error('unregistered');}});
  dir=own;
  const id=(await start(service)).session!.id;await output(service,id,'READY');
  await service.perform(req({operation:'input',sessionId:id,data:'make a new page\r',references:['ref-project-1']}));
  const text=await output(service,id,'GOT:make a new page');
  const line=text.split('\n').find(l=>l.includes('GOT:make a new page'))!;
  expect(line).toContain('참고 프로젝트');
  expect(line).toContain(realpathSync(refDir));
  await expect(service.perform(req({operation:'input',sessionId:id,data:'x\r',references:['not-registered']}))).rejects.toThrow('참고할 프로젝트');
  await service.perform(req({operation:'close',sessionId:id}));
 });
 // Updated 2026-09-29: a prompt-carrying start also accepts references (an @ route that opens a new
 // session hands its # references over with the first request), so this is no longer "input only".
 test('references are validated as a bounded list of opaque ids on input and on a prompt-carrying start',()=>{
  const base={operation:'input',requestId:'request-1234',sessionId:'session-1234',data:'hi'};
  expect(normalizeAiTerminalRequest({...base,references:['project-aaaa','project-bbbb']}).references).toEqual(['project-aaaa','project-bbbb']);
  for(const references of [[],['../etc'],Array.from({length:9},(_,i)=>`project-${i}xxxx`),['project-aaaa','project-aaaa'],'project-aaaa'])
   expect(()=>normalizeAiTerminalRequest({...base,references})).toThrow();
  expect(()=>normalizeAiTerminalRequest({operation:'resize',requestId:'request-1234',sessionId:'session-1234',cols:80,rows:24,references:['project-aaaa']})).toThrow();
  const startBase={operation:'start',requestId:'request-1234',targetId:'project-target',agent:'codex',cols:80,rows:24};
  expect(normalizeAiTerminalRequest({...startBase,prompt:'task',references:['project-aaaa']}).references).toEqual(['project-aaaa']);
  // References describe a request; without one there is nothing to attach them to.
  expect(()=>normalizeAiTerminalRequest({...startBase,references:['project-aaaa']})).toThrow('참고할 프로젝트');
  for(const references of [[],['../etc'],'project-aaaa'])expect(()=>normalizeAiTerminalRequest({...startBase,prompt:'task',references})).toThrow();
 });
 test('a new session started with a request receives the verified folders of its references in that request',async()=>{
  const refDir=mkdtempSync(join(tmpdir(),'agentstoz-ref-'));dirs.push(refDir);
  let dir='';
  const {service,dir:own}=fixture('#!/bin/sh\nprintf "%s\\n" "$@" > "$PWD/launch-args"\nprintf "ARGS_READY\\n"\nread line\n',{resolveTarget:async id=>{if(id===targetId)return{cwd:dir};if(id==='ref-project-1')return{cwd:refDir};throw new Error('unregistered');}});
  dir=own;
  const started=await service.perform(req({operation:'start',targetId,agent:'claude',cols:80,rows:24,prompt:'make a new page',references:['ref-project-1',targetId]}));
  await output(service,started.session!.id,'ARGS_READY');
  const prompt=readFileSync(join(dir,'launch-args'),'utf8').split('\n').find(line=>line.startsWith('make a new page'))!;
  expect(prompt).toContain('참고 프로젝트');
  expect(prompt).toContain(realpathSync(refDir));
  // The session's own folder is not listed as a reference to itself.
  expect(prompt).not.toContain(realpathSync(dir));
  await expect(service.perform(req({operation:'start',targetId,agent:'claude',cols:80,rows:24,prompt:'x',references:['not-registered']}))).rejects.toThrow('참고할 프로젝트');
  await service.perform(req({operation:'close',sessionId:started.session!.id}));
 });
});

// Review L1 (2026-09-29): the input path gained awaits (reference folders, then the screen parser for
// a multi-line paste) after its remote-permission check. A permission revoked during either wait
// must still stop the write, the way the start path already re-checks after its own wait.
ptyDescribe('remote input re-checks its permission after every wait before the PTY write',()=>{
 test('after waiting for the screen to decide on a bracketed paste',async()=>{
  const {service}=fixture();
  const id=(await start(service)).session!.id;await output(service,id,'READY');
  const authority={owner:'internet:screen-wait',targets:new Set([targetId])};service.setRemoteAccess(authority.owner,true);
  const original=AiTerminalScreen.prototype.settledModes;
  let entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  AiTerminalScreen.prototype.settledModes=async function(this:AiTerminalScreen){entered();await gate;return original.call(this);};
  try{
   const pending=service.perform(req({operation:'input',sessionId:id,data:'SCREEN_WAIT_ONE\nSCREEN_WAIT_TWO\r'}),authority).then(()=>null,e=>e);
   await waiting;service.setRemoteAccess(authority.owner,false);release();
   expect((await pending)?.message).toContain('해제');
  }finally{AiTerminalScreen.prototype.settledModes=original;}
  await service.perform(req({operation:'input',sessionId:id,data:'LOCAL_MARKER\r'}));await output(service,id,'GOT:LOCAL_MARKER');
  expect(JSON.stringify(await service.perform(req({operation:'read',sessionId:id,after:0})))).not.toContain('SCREEN_WAIT');
 });
 test('after resolving # reference folders',async()=>{
  const refDir=mkdtempSync(join(tmpdir(),'agentstoz-ref-wait-'));dirs.push(refDir);
  let dir='',pause:Promise<void>|undefined,entered:(()=>void)|undefined;
  const {service,dir:own}=fixture(undefined,{resolveTarget:async id=>{if(id===targetId)return{cwd:dir};if(id==='ref-project-1'){entered?.();await pause;return{cwd:refDir};}throw new Error('unregistered');}});
  dir=own;
  const id=(await start(service)).session!.id;await output(service,id,'READY');
  const authority={owner:'internet:reference-wait',targets:new Set([targetId,'ref-project-1'])};service.setRemoteAccess(authority.owner,true);
  const resolving=new Promise<void>(resolve=>{entered=resolve;});let release!:()=>void;pause=new Promise<void>(resolve=>{release=resolve;});
  const pending=service.perform(req({operation:'input',sessionId:id,data:'REFERENCE_WAIT\r',references:['ref-project-1']}),authority).then(()=>null,e=>e);
  await resolving;service.setRemoteAccess(authority.owner,false);release();
  expect((await pending)?.message).toContain('해제');
  pause=undefined;
  await service.perform(req({operation:'input',sessionId:id,data:'LOCAL_MARKER\r'}));await output(service,id,'GOT:LOCAL_MARKER');
  expect(JSON.stringify(await service.perform(req({operation:'read',sessionId:id,after:0})))).not.toContain('REFERENCE_WAIT');
 });
});

// Review L3 (2026-09-29): the host appends the reference folders to a start's first request after the
// protocol's 24,000-byte check, so a request that fit could launch the CLI with a larger one.
ptyTest('a first request that reference folders push over 24,000 bytes is refused before anything starts',async()=>{
 const refDir=mkdtempSync(join(tmpdir(),'agentstoz-ref-overflow-'));dirs.push(refDir);
 let dir='';
 const {service,dir:own}=fixture('#!/bin/sh\ntouch "$PWD/spawned"\nread line\n',{resolveTarget:async id=>{if(id===targetId)return{cwd:dir};if(id==='ref-project-1')return{cwd:refDir};throw new Error('unregistered');}});
 dir=own;
 const prompt='a'.repeat(24_000-16);
 expect(normalizeAiTerminalRequest(req({operation:'start',targetId,agent:'claude',cols:80,rows:24,prompt,references:['ref-project-1']})).prompt).toBe(prompt);
 await expect(service.perform(req({operation:'start',targetId,agent:'claude',cols:80,rows:24,prompt,references:['ref-project-1']}))).rejects.toThrow(AI_TERMINAL_PROMPT_REFERENCES_TOO_LARGE_ERROR);
 await Bun.sleep(100);
 expect(existsSync(join(dir,'spawned'))).toBe(false);
 expect((await service.perform(req({operation:'list'}))).sessions).toEqual([]);
 // The same request without the references still starts.
 const started=await service.perform(req({operation:'start',targetId,agent:'claude',cols:80,rows:24,prompt}));
 expect(started.session?.state).toBe('running');
 await service.perform(req({operation:'close',sessionId:started.session!.id}));
});

test('Windows start is refused only when its PTY runtime is missing',()=>{
 // Windows Workroom sessions are supported now: `spawnWindowsPty` drives ConPTY
 // through node-pty loaded from disk beside the sidecar, so this can no longer
 // be checked by pretending to be win32 -- on a machine that has the runtime
 // (every Windows machine running the app) nothing would refuse, and on macOS
 // the installed package makes it look available too. The gate is a pure
 // decision instead, and the real backend is covered by tests/windows-pty.test.ts.
 expect(aiTerminalWindowsStartBlocked({platform:'win32',injectedSpawn:false,ptyAvailable:false})).toBe(true);
 expect(aiTerminalWindowsStartBlocked({platform:'win32',injectedSpawn:false,ptyAvailable:true})).toBe(false);
 // An injected spawn must win, or every fake-child test above would start
 // refusing when the suite runs on Windows.
 expect(aiTerminalWindowsStartBlocked({platform:'win32',injectedSpawn:true,ptyAvailable:false})).toBe(false);
 for(const platform of ['darwin','linux'])
  expect(aiTerminalWindowsStartBlocked({platform,injectedSpawn:false,ptyAvailable:false})).toBe(false);
 // The message is about a broken install, so it must not send the user to
 // PowerShell or WSL the way the old "not supported yet" text did.
 expect(AI_TERMINAL_WINDOWS_UNSUPPORTED).toContain('런타임을 찾지 못했습니다');
 expect(AI_TERMINAL_WINDOWS_UNSUPPORTED).not.toContain('PowerShell');
 expect(AI_TERMINAL_WINDOWS_UNSUPPORTED).not.toContain('WSL');
});

ptyDescribe('agentstoz_use orchestration views and input (host-only)',()=>{
 test('multi-line submissions become one bracketed paste only when asked and only for plain multi-line text',async()=>{
  const writes:string[]=[];const terminal={write:(data:string)=>{writes.push(data);return data.length;}};
  await writeAiTerminalInput('claude',terminal,'line one\nline two\r',{bracketedPaste:true});
  expect(writes).toEqual(['\x1b[200~line one\rline two\x1b[201~','\r']);
  writes.length=0;await writeAiTerminalInput('claude',terminal,'single line\r',{bracketedPaste:true});expect(writes).toEqual(['single line','\r']);
  writes.length=0;await writeAiTerminalInput('codex',terminal,'already\x1b[200~pasted\nx\x1b[201~\r',{bracketedPaste:true});expect(writes).toEqual(['already\x1b[200~pasted\nx\x1b[201~','\r']);
  writes.length=0;await writeAiTerminalInput('hermes',terminal,'line one\nline two\r',{bracketedPaste:false});expect(writes).toEqual(['line one\nline two','\r']);
  // A multi-line part without Enter (an early chunk of a >4 KiB composer message) is still one paste,
  // otherwise its raw LF would submit the first line alone. It gets no Enter of its own.
  writes.length=0;await writeAiTerminalInput('agy',terminal,'line one\nline two',{bracketedPaste:true});expect(writes).toEqual(['\x1b[200~line one\rline two\x1b[201~']);
 });
 test('the service decides bracketed paste from the CLI screen, so every input path shares it',async()=>{
  // ESC is shown as ^ so the paste brackets are visible in plain output.
  const echo='while IFS= read -r line; do printf "GOT:%s\\n" "$line" | tr "\\033" "^"; done\n';
  const paste=fixture('#!/bin/sh\nstty -echo\nprintf "\\033[?2004hPASTE_READY\\n"\n'+echo);
  const pasteId=(await start(paste.service)).session!.id;await output(paste.service,pasteId,'PASTE_READY');
  await paste.service.perform(req({operation:'input',sessionId:pasteId,data:'첫 줄\n둘째 줄\r'}));
  const pasted=await output(paste.service,pasteId,'GOT:둘째 줄^[201~');
  expect(pasted).toContain('GOT:^[200~첫 줄');
  await paste.service.perform(req({operation:'input',sessionId:pasteId,data:'한 줄\r'}));
  expect(await output(paste.service,pasteId,'GOT:한 줄')).not.toContain('^[200~한 줄');
  const plain=fixture('#!/bin/sh\nstty -echo\nprintf "PLAIN_READY\\n"\n'+echo);
  const plainId=(await start(plain.service)).session!.id;await output(plain.service,plainId,'PLAIN_READY');
  await plain.service.perform(req({operation:'input',sessionId:plainId,data:'첫 줄\n둘째 줄\r'}));
  const typed=await output(plain.service,plainId,'GOT:둘째 줄');
  expect(typed).toContain('GOT:첫 줄');expect(typed).not.toContain('^[');
 });
 test('lastOutputAt, plain tail and screen rows stay host-only and never change the wire summary',async()=>{
  const {service}=fixture('#!/bin/sh\nstty -echo\nprintf "ARMED\\n"\nread first\nprintf "\\033[1;32mREADY\\033[0m:%s\\n" "$first"\nwhile IFS= read -r line; do printf "GOT:%s\\n" "$line"; done\n');
  const id=(await start(service)).session!.id;
  // No PTY callback can run between the start and this synchronous read.
  expect(service.inspectSession(id,targetId).lastOutputAt).toBeNull();
  await output(service,id,'ARMED');
  const armed=service.inspectSession(id,targetId);
  expect(armed.lastOutputAt).toBeLessThanOrEqual(Date.now());
  await service.perform(req({operation:'input',sessionId:id,data:'hello\r'}));await output(service,id,'READY');
  const inspected=service.inspectSession(id,targetId);
  expect(inspected.lastOutputAt).toBeGreaterThanOrEqual(armed.lastOutputAt!);expect(inspected.lastOutputAt).toBeLessThanOrEqual(Date.now());
  expect(await service.outputTail(id,targetId,armed.outputCursor)).toEqual({text:'READY:hello',nextCursor:inspected.outputCursor,truncated:false});
  expect(await service.outputTail(id,targetId)).toEqual({text:'ARMED\nREADY:hello',nextCursor:inspected.outputCursor,truncated:false});
  await service.perform(req({operation:'input',sessionId:id,data:'second\r'}));await output(service,id,'GOT:second');
  expect((await service.outputTail(id,targetId,inspected.outputCursor)).text).toBe('GOT:second');
  const screen=await service.screenText(id,targetId);
  expect(screen?.rows.slice(0,3)).toEqual(['ARMED','READY:hello','GOT:second']);
  expect(screen).toMatchObject({cols:80,cursorRow:3,cursorCol:0,alternate:false});
  expect(screen?.rows).toHaveLength(24);
  expect(await service.inputModes(id,targetId)).toEqual({bracketedPaste:false,applicationCursorKeys:false});
  const read=await service.perform(req({operation:'read',sessionId:id,after:0}));
  expect(Object.keys(read.session!).sort()).toEqual(['agent','cols','createdAt','exitCode','id','rows','state','targetId']);
  expect(()=>normalizeAiTerminalResponse(read)).not.toThrow();
  expect(()=>service.inspectSession(id,'another-target-1234')).toThrow();
  await expect(service.outputTail(id,'another-target-1234')).rejects.toThrow();
  await expect(service.screenText(id,'another-target-1234')).rejects.toThrow();
  await service.perform(req({operation:'close',sessionId:id}));
 });
 test('a tail read is bounded, marks omitted output and keeps its cursor',async()=>{
  const {service}=fixture('#!/bin/sh\ni=0\nwhile [ $i -lt 1500 ]; do printf "line-%04d abcdefghijklmnopqrstuvwxyz\\n" $i; i=$((i+1)); done\nprintf "TAIL_END\\n"\nread line\n');
  const id=(await start(service)).session!.id;await output(service,id,'TAIL_END');
  const tail=await service.outputTail(id,targetId);
  expect(new TextEncoder().encode(tail.text).length).toBeLessThanOrEqual(8_000);
  expect(tail.text.endsWith('TAIL_END')).toBe(true);expect(tail.text).not.toContain('line-0000');expect(tail.truncated).toBe(true);
  expect(tail.nextCursor).toBe(service.inspectSession(id,targetId).outputCursor);
  expect(await service.outputTail(id,targetId,tail.nextCursor)).toEqual({text:'',nextCursor:tail.nextCursor,truncated:false});
 });
 test('only a local start or input request ID is reported as already used',async()=>{
  const {service}=fixture();
  const request=req({operation:'start',targetId,agent:'codex',cols:80,rows:24});
  expect(service.hasLocalRequest(request.requestId)).toBe(false);
  const id=(await service.perform(request)).session!.id;await output(service,id,'READY');
  expect(service.hasLocalRequest(request.requestId)).toBe(true);
  service.setRemoteAccess('lan:device-1',true);
  const remote=req({operation:'input',sessionId:id,data:'remote\r'});
  await service.perform(remote,{owner:'lan:device-1',targets:new Set([targetId])});
  expect(service.hasLocalRequest(remote.requestId)).toBe(false);
 });
});
