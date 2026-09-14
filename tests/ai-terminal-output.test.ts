import {expect,test} from 'bun:test';
import {terminalOutputPage} from '../src/aiTerminalOutput';
import {normalizeAiTerminalResponse} from '../src/aiTerminalProtocol';
const session={id:'fixture-session',targetId:'fixture-project',agent:'codex' as const,state:'running' as const,createdAt:'2026-09-13T00:00:00Z',exitCode:null,cols:80,rows:24};

test('spinner callbacks are packed while retaining all text and resumable cursors',()=>{
 const source=Array.from({length:300},(_,i)=>({seq:i+1,text:`\x1b]0;${i} 한글🐳\x07`}));
 let after=0,text='',pages=0;
 do {
  const page=terminalOutputPage(source,after);normalizeAiTerminalResponse({session,...page});
  text+=page.chunks.map(c=>c.text).join('');after=page.nextCursor;pages++;
  if(!page.hasMore)break;
 }while(pages<100);
 expect(text).toBe(source.map(c=>c.text).join(''));
 expect(after).toBe(300);expect(pages).toBeLessThan(4);
 // A different reader can resume inside a previously packed response.
 expect(terminalOutputPage(source,298).chunks.map(c=>c.text).join('')).toBe(source.slice(298).map(c=>c.text).join(''));
 expect(source[0]!.seq).toBe(1);expect(source[0]!.text).toContain('0 한글');
});

test('packed escaped output respects wire bytes, retained-output truncation and replay',()=>{
 const source=Array.from({length:50},(_,i)=>({seq:i+5,text:'\0'.repeat(400)}));
 let after=0,text='';
 do {
  const page=terminalOutputPage(source,after);normalizeAiTerminalResponse({session,...page});
  expect(page.truncated).toBe(after===0);
  expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThan(9000);
  expect(terminalOutputPage(source,after)).toEqual(page);
  text+=page.chunks.map(c=>c.text).join('');after=page.nextCursor;
  if(!page.hasMore)break;
 }while(after<54);
 expect(text).toBe('\0'.repeat(20000));
 expect(terminalOutputPage(source,54)).toMatchObject({chunks:[],nextCursor:54,hasMore:false,truncated:false});
});
