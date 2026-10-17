import {expect,test} from 'bun:test';
import {changeWorkroomEffort,effortComposerEmpty,type EffortFrame,type EffortRuntimeControl} from '../src/workroomEffortRuntime';
const levels=['low','medium','high'];
function fixture(agent:'codex'|'claude'|'hermes',initial='medium'){
 let level=initial,picker=false,selected=levels.indexOf(initial),active=true,idle=true;
 const writes:string[]=[];
 const frame=():EffortFrame=>picker?{rows:['Adjust effort level','low medium high','s for this session only'],cursorRow:2,cursorCol:0,alternate:false}:{rows:[agent==='codex'?`model: gpt-6.1-sol ${level}`:agent==='claude'?`◐ ${level} · /effort`:`✓ Reasoning effort set to '${level}' (session only — add --global to persist)`,'› '],cursorRow:1,cursorCol:2,alternate:false};
 const control:EffortRuntimeControl={agent,level:'high',current:initial,read:async()=>frame(),write:data=>{writes.push(data);if(agent==='codex')level=levels[levels.indexOf(level)+(data==='\x1b.'?1:-1)]!;else if(agent==='claude'){if(data==='/effort\r')picker=true;else if(data==='s'){level=levels[selected]!;picker=false;}else selected+=data==='\x1b[C'?1:-1;}else level=/reasoning (\w+)/.exec(data)![1]!;},active:()=>active,idle:()=>idle,claudeSessionPicker:true,codexDefaultKeys:true,sleep:async()=>{}};
 return {control,writes,frame,revoke:()=>{active=false;},busy:()=>{idle=false;},ready:()=>{idle=true;}};
}
test('Codex changes only this session through one verified shortcut per level in both directions',async()=>{
 const f=fixture('codex','low');expect(await changeWorkroomEffort(f.control)).toBe('applied');expect(f.writes).toEqual(['\x1b.','\x1b.']);
 f.control.level='low';f.control.current='high';expect(await changeWorkroomEffort(f.control)).toBe('applied');expect(f.writes.slice(2)).toEqual(['\x1b,','\x1b,']);
 expect(f.writes.some(x=>x.includes('/model')||x.includes('\r'))).toBe(false);
});
test('Codex native shortcut can prepare the next request without interrupting a running response',async()=>{const f=fixture('codex');f.busy();expect(await changeWorkroomEffort(f.control)).toBe('applied');expect(f.writes).toEqual(['\x1b.']);});
test('Claude changes through the session-only slider, never the persistent argument or Enter form (no live Claude)',async()=>{
 const f=fixture('claude','low');expect(await changeWorkroomEffort(f.control)).toBe('applied');expect(f.writes).toEqual(['/effort\r','\x1b[C','\x1b[C','s']);
 expect(f.writes).not.toContain('/effort high\r');expect(f.writes.at(-1)).not.toBe('\r');
});
test('Hermes uses session-scoped reasoning and never --global (no model is called)',async()=>{const f=fixture('hermes');expect(await changeWorkroomEffort(f.control)).toBe('applied');expect(f.writes).toEqual(['/reasoning high\r']);});
test('an already applied level does not write anything',async()=>{const f=fixture('codex','high');expect(await changeWorkroomEffort(f.control)).toBe('applied');expect(f.writes).toEqual([]);});
test('unsupported session-only Claude or remapped Codex keys never receives a speculative command',async()=>{
 for(const agent of ['claude','codex'] as const){const f=fixture(agent);f.control.claudeSessionPicker=false;f.control.codexDefaultKeys=false;expect(await changeWorkroomEffort(f.control)).toBe('unsupported');expect(f.writes).toEqual([]);}
});
test('a permission dialog is never answered by effort adjustment',async()=>{const f=fixture('claude');f.control.read=async()=>({rows:['Do you trust this folder?','› 1. Yes','  2. No'],cursorRow:1,cursorCol:0,alternate:false});await expect(changeWorkroomEffort(f.control)).rejects.toThrow('승인');expect(f.writes).toEqual([]);});
test('a partially typed native draft is preserved without clearing or submitting it',async()=>{const f=fixture('codex');f.control.timeoutMs=0;f.control.read=async()=>({rows:['model: gpt-6.1-sol medium','› my draft'],cursorRow:1,cursorCol:10,alternate:false});await expect(changeWorkroomEffort(f.control)).rejects.toThrow('입력칸');expect(f.writes).toEqual([]);});
test('Claude and Hermes wait for the existing response instead of interrupting it',async()=>{
 for(const agent of ['claude','hermes'] as const){const f=fixture(agent);f.busy();f.control.sleep=async()=>{expect(f.writes).toEqual([]);f.ready();};expect(await changeWorkroomEffort(f.control)).toBe('applied');}
});
test('a busy session times out with the original user request untouched',async()=>{const f=fixture('hermes');f.busy();f.control.timeoutMs=0;await expect(changeWorkroomEffort(f.control)).rejects.toThrow('진행 중');expect(f.writes).toEqual([]);});
test('revocation before the native command writes nothing',async()=>{const f=fixture('codex');f.revoke();await expect(changeWorkroomEffort(f.control)).rejects.toThrow('변경');expect(f.writes).toEqual([]);});
test('an unconfirmed native change is not retried or reported as applied',async()=>{const f=fixture('codex');f.control.write=data=>{f.writes.push(data);};await expect(changeWorkroomEffort(f.control)).rejects.toThrow('확인하지 못');expect(f.writes).toEqual(['\x1b.']);});
test('the native composer proof requires the cursor at the empty prompt',()=>{const f=fixture('codex');expect(effortComposerEmpty(f.frame())).toBe(true);expect(effortComposerEmpty({...f.frame(),cursorCol:7})).toBe(false);expect(effortComposerEmpty(null)).toBe(false);});

test('Home on a partially typed draft is not mistaken for an empty composer',()=>{const f=fixture('codex');expect(effortComposerEmpty({...f.frame(),rows:['model: gpt-6.1-sol medium','› preserve my draft'],cursorCol:2})).toBe(false);});

test('a noninteractive Hermes wrapper is unsupported without waiting or writing a command', async () => {
 const f=fixture('hermes');f.control.read=async()=>({rows:['READY:hermes'],cursorRow:1,cursorCol:0,alternate:false});
 expect(await changeWorkroomEffort(f.control)).toBe('unsupported');expect(f.writes).toEqual([]);
});
