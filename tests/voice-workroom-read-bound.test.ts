import {afterEach,expect,test} from 'bun:test';
import {chmodSync,mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AiTerminalService} from '../src/aiTerminalService';
import {bindVoiceRuntime,voiceOutputTail} from '../src/voiceRuntimeBinding';

/**
 * Workroom output is capped at 6,000 characters, but a Korean screen is ~3 UTF-8 bytes per
 * character. A reused delegate workroom measured 15,413 B (review 2026-09-29) and a pure Hangul
 * screen passes the voice host's 16,000-byte tool limit, which then replaces the whole result —
 * agent/reused included — with 「응답이 큽니다」 although the delegate already switched.
 */
const cleanup:(()=>unknown)[]=[];afterEach(async()=>{for(const step of cleanup.splice(0).reverse())await step();});
const id='project_dense_korean';

async function world(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'voice-read-bound-')));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const dir=join(root,'project');mkdirSync(dir);const exe=join(root,'claude');
  // A Korean answer on screen: 400 dense Hangul lines, then the newest line last.
  writeFileSync(exe,`#!/bin/sh\nstty -echo\ni=0\nwhile [ $i -lt 400 ]; do printf '가나다라마바사아자차카타파하가나다라마바사아자차카타파하\\n'; i=$((i+1)); done\nprintf 'NEWEST_LINE_끝\\n'\nwhile IFS= read -r line; do :; done\n`);chmodSync(exe,0o755);
  const terminal=new AiTerminalService({resolveTarget:async()=>({cwd:dir}),executable:()=>exe});cleanup.push(()=>terminal.shutdown());
  const binding=await bindVoiceRuntime({terminal,targets:async()=>[{id,name:'한국어 프로젝트',role:'managed',scope:'main'}],target:async()=>({label:'한국어 프로젝트',fingerprint:'f'}),
    ops:()=>({fingerprint:'o',projectId:null}),recall:()=>({}),projectRecall:async()=>({}),propose:async()=>({})},{kind:'ops'},{owner:'local',active:()=>true});
  return {terminal,binding};
}
const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));

test('the tail keeps whole characters, the newest ones, within both limits',()=>{
  expect(voiceOutputTail('처음'+'가'.repeat(10),{chars:100,bytes:9})).toBe('가가가');
  // An emoji is two UTF-16 units and four bytes: never half of one.
  expect(voiceOutputTail('a😀😀😀',{chars:100,bytes:9})).toBe('😀😀');
  expect(voiceOutputTail('abcdef',{chars:3,bytes:100})).toBe('def');
  // Still redacted like every voice output.
  expect(voiceOutputTail('token=secret-value 끝',{chars:100,bytes:100})).not.toContain('secret-value');
});

test('connect_project_delegate stays under 12 KB with a dense Korean screen, on start and on reuse',async()=>{
  const w=await world();
  const first:any=await w.binding.run('connect_project_delegate',{targetId:id,agent:'claude'},'voice_request_bound_1');
  const session=first.activeTarget.sessionId as string;
  for(const deadline=Date.now()+5000;Date.now()<deadline&&!w.terminal.inspectSession(session,id).outputCursor;)await Bun.sleep(20);
  await Bun.sleep(400);
  const again:any=await w.binding.run('connect_project_delegate',{targetId:id},'voice_request_bound_2');
  expect(again).toMatchObject({state:'delegate-connected',agent:'claude',reused:true});
  expect(bytes(first)).toBeLessThan(12_000);
  expect(bytes(again)).toBeLessThan(12_000);
  // What is kept is the newest part of the screen.
  expect(again.initialOutput.output).toContain('NEWEST_LINE_끝');
},20_000);

test('workroom reads keep the newest output within the byte budget instead of 6,000 characters',async()=>{
  const w=await world();
  const connected:any=await w.binding.run('connect_project_delegate',{targetId:id,agent:'claude'},'voice_request_bound_3');
  const session=connected.activeTarget.sessionId as string;
  let read:any;
  for(const deadline=Date.now()+5000;Date.now()<deadline;await Bun.sleep(40)){read=await w.binding.run('read_workroom',{targetId:id,sessionId:session},'voice_request_bound_4');if(String(read.output).includes('NEWEST_LINE_끝'))break;}
  expect(read.output).toContain('NEWEST_LINE_끝');
  expect(bytes(read)).toBeLessThan(12_000);
  expect(bytes(await w.binding.run('read_delegate_workroom',{},'voice_request_bound_5'))).toBeLessThan(12_000);
},20_000);
