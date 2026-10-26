import {describe,expect,test} from 'bun:test';
import {Terminal} from '@xterm/headless';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AiTerminalService,type AiTerminalDependencies} from '../src/aiTerminalService';
import {normalizeAiTerminalResponse,type AiTerminalRequest} from '../src/aiTerminalProtocol';
import {AiTerminalScreen} from '../src/aiTerminalScreen';
import {workroomReadableLayout} from '../src/workroomReadableScreen';

const write=(terminal:Terminal,text:string)=>new Promise<void>(resolve=>terminal.write(text,resolve));
const visibleRows=(terminal:Terminal)=>Array.from({length:terminal.rows},(_,row)=>terminal.buffer.active.getLine(terminal.buffer.active.baseY+row)?.translateToString(true)??'');
const denseGrid=()=>{
 let drawing='\x1b[H\x1b[2J╭'+'─'.repeat(98)+'╮';
 for(let row=2;row<=26;row++){drawing+=`\x1b[${row};1H`;for(let cell=0;cell<25;cell++)drawing+=`\x1b[${cell%2?32:31}m${String(row).padStart(2,'0')}${String(cell).padStart(2,'0')}`;}
 return drawing+'\x1b[0m\x1b[27;1H│ ready · opus 5 high'+ ' '.repeat(79)+'│\x1b[28;1H╰'+'─'.repeat(98)+'╯\x1b[14;1H';
};

describe('remote readable output preserves structure without changing the host terminal',()=>{
 test('normal prose and isolated box characters still flow; parsed box rows and alternate buffers keep columns',()=>{
  for(const text of ['한글 설명 '.repeat(40),'README: use │ only as an example','single corner ╭ is prose'])expect(workroomReadableLayout([text],false)).toBe('flow');
  expect(workroomReadableLayout(['╭────────────╮','│ ready      │','╰────────────╯'],false)).toBe('grid');
  expect(workroomReadableLayout(['│ Session: synthetic','│ /help for commands'],false)).toBe('grid');
  expect(workroomReadableLayout(['fullscreen menu without borders'],true)).toBe('grid');
  expect(workroomReadableLayout(['ordinary output after exiting the TUI'],false)).toBe('flow');
 });

 test('actual two-page serializer keeps its original grid across a host resize; strict v1 responses expose no private metadata',async()=>{
  const cwd=mkdtempSync(join(tmpdir(),'agentstoz-readable-grid-'));
  let emit!:(text:string)=>void,exit!:()=>void,finish!:(code:number)=>void;
  const resized:[number,number][]=[],written:string[]=[];
  const deps:AiTerminalDependencies={resolveTarget:async()=>({cwd}),executable:()=>'/fixture/no-cli-is-executed',env:{HOME:cwd},activitySampler:false,maxBufferChars:1024,
   spawn:(_args,options)=>{const p=options.terminal as {data:(pty:unknown,data:Uint8Array)=>void;exit:()=>void};emit=text=>p.data(null,new TextEncoder().encode(text));exit=()=>{p.exit();finish(0);};return {pid:123456,exited:new Promise<number>(resolve=>{finish=resolve;}),kill:()=>{throw Error('No actual process may be signaled');},terminal:{write:(data:string)=>{written.push(data);return data.length;},resize:(cols:number,rows:number)=>{resized.push([cols,rows]);},close:()=>{}}};},signalGroup:()=>exit()};
  const service=new AiTerminalService(deps),client=new Terminal({cols:100,rows:28,scrollback:0,allowProposedApi:true});
  let next=0;const req=(request:Omit<AiTerminalRequest,'requestId'>)=>({...request,requestId:`readable-grid-${++next}`});
  try{
   const id=(await service.perform(req({operation:'start',targetId:'synthetic-grid-project',agent:'hermes',cols:100,rows:28}))).session!.id;
   // More retained-cursor boundaries than serialized chunks; no shell, real agent, account, or user output.
   emit('\x1b[H'.repeat(500));
   emit(denseGrid());
   const first=await service.perform(req({operation:'read',sessionId:id,after:0,snapshot:true}));
   expect(first.truncated).toBe(true);expect(first.hasMore).toBe(true);expect(first.chunks).toHaveLength(4);
   expect(first.session).toMatchObject({cols:100,rows:28});normalizeAiTerminalResponse(first);
   await write(client,first.chunks!.map(chunk=>chunk.text).join(''));
   await service.perform(req({operation:'resize',sessionId:id,cols:78,rows:40}));
   const second=await service.perform(req({operation:'read',sessionId:id,after:first.nextCursor!,snapshot:true}));
   // These bytes are still the original snapshot, so changing to the live 78x40 grid here corrupts its rows.
   expect(second.session).toMatchObject({cols:100,rows:28});expect(second.hasMore).toBe(false);normalizeAiTerminalResponse(second);
   expect(Object.keys(second).sort()).toEqual(['chunks','hasMore','nextCursor','session','truncated']);
   client.resize(second.session!.cols,second.session!.rows);await write(client,second.chunks!.map(chunk=>chunk.text).join(''));
   const rows=visibleRows(client);
   expect(rows[0]).toBe('╭'+'─'.repeat(98)+'╮');expect(rows[1]).toStartWith('0200020102020203');
   expect(rows[26]).toContain('ready · opus 5 high');expect(rows[27]).toBe('╰'+'─'.repeat(98)+'╯');
   expect(client.buffer.active.cursorX).toBe(0);expect(client.buffer.active.cursorY).toBe(13);
   const live=await service.perform(req({operation:'read',sessionId:id,after:second.nextCursor!})),list=await service.perform(req({operation:'list'}));
   expect(live.session).toMatchObject({cols:78,rows:40});expect(list.sessions?.find(session=>session.id===id)).toMatchObject({cols:78,rows:40});
   expect(resized).toEqual([[78,40]]);expect(written).toEqual([]);
  }finally{client.dispose();await service.shutdown();rmSync(cwd,{recursive:true,force:true});}
 });

 test('cached grid metadata expires with its existing snapshot instead of retaining a viewer or resizing a PTY',async()=>{
  let now=0;const screen=new AiTerminalScreen(100,28,()=>now);screen.write(denseGrid(),50);
  try{
   const retained=[{seq:50,text:'last'}],first=await screen.snapshotPage(0,retained,50);expect(first?.hasMore).toBe(true);
   expect(await screen.snapshotPage(first!.nextCursor,retained,50)).toMatchObject({cols:100,rows:28});
   now=120001;expect(await screen.snapshotPage(first!.nextCursor,retained,50)).toBeNull();
  }finally{screen.dispose();}
 });
});
