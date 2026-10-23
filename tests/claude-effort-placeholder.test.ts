import {expect,test} from 'bun:test';
import {AiTerminalScreen} from '../src/aiTerminalScreen';
import {changeWorkroomEffort,effortComposerEmpty} from '../src/workroomEffortRuntime';

// Observed Claude Code 2.1.308 chrome; no account output or real model call.
const rule='─'.repeat(70),hint='Try "write a test for <filepath>"';
function render(screen:AiTerminalScreen,{dim=true,cursor=2,level='xhigh',text=hint}={}){
 screen.write(`\x1b[H\x1b[2JSet effort level to ${level}\r\n${rule}\r\n❯\u00a0${dim?'\x1b[2m':''}${text}\x1b[0m\r\n${rule}\r\n  manual mode on\x1b[3;${cursor+1}H`,1);
}
test('the real dimmed Claude placeholder is empty; identical user text at Home is still protected',async()=>{
 const screen=new AiTerminalScreen(80,8);
 try{
  render(screen);const frame=await screen.plainRows();expect(effortComposerEmpty(frame,'claude')).toBe(true);expect(effortComposerEmpty(frame,'codex')).toBe(false);
  render(screen,{dim:false});expect(effortComposerEmpty(await screen.plainRows(),'claude')).toBe(false);
  render(screen,{cursor:3});expect(effortComposerEmpty(await screen.plainRows(),'claude')).toBe(false);
  render(screen,{cursor:2+hint.length});expect(effortComposerEmpty(await screen.plainRows(),'claude')).toBe(false);
  render(screen,{text:'preserve my draft'});expect(effortComposerEmpty(await screen.plainRows(),'claude')).toBe(false);
  render(screen,{text:hint});screen.write('\x1b[2;1Hnot composer chrome\x1b[K\x1b[3;3H',2);expect(effortComposerEmpty(await screen.plainRows(),'claude')).toBe(false);
 }finally{screen.dispose();}
});
test('Claude session-only effort round trip accepts its dimmed placeholder again without submitting the hint',async()=>{
 const screen=new AiTerminalScreen(80,8),writes:string[]=[];let level='xhigh';render(screen);
 try{
  const result=await changeWorkroomEffort({agent:'claude',level:'high',current:level,timeoutMs:10,read:()=>screen.plainRows(),active:()=>true,idle:()=>true,claudeSessionPicker:true,codexDefaultKeys:false,sleep:async()=>{},write:data=>{
   writes.push(data);
   if(data==='/effort\r')screen.write('\x1b[H\x1b[2JAdjust effort level\r\nlow medium high xhigh\r\ns for this session only',2);
   else if(data==='\x1b[D')level='high';
   else if(data==='s')render(screen,{level});
  }});
  expect(result).toBe('applied');expect(writes).toEqual(['/effort\r','\x1b[D','s']);
 }finally{screen.dispose();}
});
test('dimmed Claude hint cannot bypass a busy response or a pending approval',async()=>{
 const screen=new AiTerminalScreen(80,8),writes:string[]=[];render(screen);
 try{
  const control={agent:'claude' as const,level:'high' as const,current:'xhigh',read:()=>screen.plainRows(),write:(s:string)=>{writes.push(s);},active:()=>true,idle:()=>false,claudeSessionPicker:true,codexDefaultKeys:false,timeoutMs:0};
  await expect(changeWorkroomEffort(control)).rejects.toThrow('진행 중');expect(writes).toEqual([]);
  const frame=(await screen.plainRows())!;frame.rows[0]='Do you trust this folder?';expect(effortComposerEmpty(frame,'claude')).toBe(false);
 }finally{screen.dispose();}
});
