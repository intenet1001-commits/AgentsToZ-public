import {expect,test} from 'bun:test';
import {changeWorkroomEffort,effortComposerEmpty,type EffortFrame,type EffortRuntimeControl} from '../src/workroomEffortRuntime';
const levels=['low','medium','high'];
function fixture(agent:'codex'|'claude'|'hermes',initial='medium'){
 let level=initial,picker=false,selected=levels.indexOf(initial),active=true,idle=true,draft='';
 const writes:string[]=[];
 const frame=():EffortFrame=>picker?{rows:['Adjust effort level','low medium high','s for this session only'],cursorRow:2,cursorCol:0,alternate:false}:{rows:[agent==='codex'?`model: gpt-6.1-sol ${level}`:agent==='claude'?`◐ ${level} · /effort`:`✓ Reasoning effort set to '${level}' (session only — add --global to persist)`,'› '+draft],cursorRow:1,cursorCol:2+draft.length,alternate:false};
 const control:EffortRuntimeControl={agent,level:'high',current:initial,read:async()=>frame(),write:data=>{writes.push(data);if(agent==='codex')level=levels[levels.indexOf(level)+(data==='\x1b.'?1:-1)]!;else if(agent==='claude'){if(data==='/effort\r')picker=true;else if(data==='s'){level=levels[selected]!;picker=false;}else selected+=data==='\x1b[C'?1:-1;}else if(data==='\r'){level=/reasoning (\w+)/.exec(draft)![1]!;draft='';}else draft=data;},active:()=>active,idle:()=>idle,claudeSessionPicker:true,codexDefaultKeys:true,sleep:async()=>{}};
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
test('Hermes observes its command draft before a separate Enter, without --global (no model is called)',async()=>{const f=fixture('hermes');expect(await changeWorkroomEffort(f.control)).toBe('applied');expect(f.writes).toEqual(['/reasoning high','\r']);});
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

/** Native Hermes 0.22 TUI: synthetic placeholder cursor, separate Enter, short mutation acknowledgement. */
function nativeHermes() {
 let level='medium',draft='',placeholder=true,ack=false;
 const writes:string[]=[];
 const frame=():EffortFrame=>({rows:[ack?` ·  reasoning: ${level}`:' Hermes Agent',
  ' ─ ready │ gpt 6 sol high │ 30.7k tok', ' ────────────────────────────────────────',
  ' ❯ '+(placeholder?'Try "fix the lint errors"':draft), ' ────────────────────────────────────────',
  ' ⚚ [OMH] v2.0.4 │ ready'],cursorRow:placeholder?5:3,cursorCol:placeholder?0:3+draft.length,alternate:true});
 const control:EffortRuntimeControl={agent:'hermes',level:'low',current:'medium',read:async()=>frame(),
  write:data=>{writes.push(data);if(data==='\r'){level=draft.replace('/reasoning ','');draft='';ack=true;}
   else {draft=data.replace(/\r/g,'');placeholder=false;}},
  active:()=>true,idle:()=>true,claudeSessionPicker:false,codexDefaultKeys:false,sleep:async()=>{}};
 return {control,writes,frame,setDraft:(text:string)=>{draft=text;placeholder=false;}};
}
test('native Hermes placeholder starts automatic control and low/high changes each receive a real acknowledgement',async()=>{
 const f=nativeHermes();expect(effortComposerEmpty(f.frame(),'hermes')).toBe(true);
 expect(await changeWorkroomEffort(f.control)).toBe('applied');
 f.control.level='high';expect(await changeWorkroomEffort(f.control)).toBe('applied');
 expect(f.writes).toEqual(['/reasoning low','\r','/reasoning high','\r']);
});
test('native Hermes ready chrome proves idle even when its clock prevents raw-output quiet',async()=>{
 const f=nativeHermes();f.control.idle=()=>false;
 expect(await changeWorkroomEffort(f.control)).toBe('applied');expect(f.writes).toEqual(['/reasoning low','\r']);
});
test('busy Hermes chrome cannot use the ready exception to submit a command',async()=>{
 const f=nativeHermes();f.control.idle=()=>false;f.control.timeoutMs=0;f.setDraft('');
 const read=f.control.read;f.control.read=async()=>{const s=(await read())!;s.rows[1]=' ─ thinking… │ gpt 6 sol';return s;};
 await expect(changeWorkroomEffort(f.control)).rejects.toThrow('진행 중');expect(f.writes).toEqual([]);
});
test('native Hermes busy status overrides a stale generic idle observation',async()=>{
 const f=nativeHermes();f.control.timeoutMs=0;f.setDraft('');
 const read=f.control.read;f.control.read=async()=>{const s=(await read())!;s.rows[1]=' ─ thinking… │ gpt 6 sol';return s;};
 await expect(changeWorkroomEffort(f.control)).rejects.toThrow('진행 중');expect(f.writes).toEqual([]);
});
test('Hermes becoming busy after its draft was observed never receives Enter',async()=>{
 const f=nativeHermes();f.control.idle=()=>false;const read=f.control.read;let reads=0;
 f.control.read=async()=>{const s=(await read())!;if(f.writes.length&&++reads===2)s.rows[1]=' ─ thinking… │ gpt 6 sol';return s;};
 await expect(changeWorkroomEffort(f.control)).rejects.toThrow('입력칸이 변경');expect(f.writes).toEqual(['/reasoning low']);
});
test('a user-typed Hermes hint with the hardware cursor in it is still a draft',async()=>{
 const f=nativeHermes();f.setDraft('Try "fix the lint errors"');f.control.timeoutMs=0;
 expect(effortComposerEmpty(f.frame(),'hermes')).toBe(false);
 await expect(changeWorkroomEffort(f.control)).rejects.toThrow('입력칸');expect(f.writes).toEqual([]);
});
test('native Hermes drafts remain protected after its welcome banner has scrolled away',async()=>{
 const f=nativeHermes();f.setDraft('preserve my draft');f.control.timeoutMs=0;
 const read=f.control.read;f.control.read=async()=>{const s=(await read())!;s.rows[0]='a previous response';return s;};
 await expect(changeWorkroomEffort(f.control)).rejects.toThrow('입력칸');expect(f.writes).toEqual([]);
});
test('a changed Hermes draft between observation and Enter is never submitted',async()=>{
 const f=nativeHermes();let reads=0;const read=f.control.read;
 f.control.read=async()=>{if(f.writes.length&&++reads===2)f.setDraft('/reasoning low plus my draft');return read();};
 await expect(changeWorkroomEffort(f.control)).rejects.toThrow('입력칸이 변경');
 expect(f.writes).toEqual(['/reasoning low']);
});
test('Hermes approval replacing the command draft never receives Enter',async()=>{
 const f=nativeHermes(),read=f.control.read;
 f.control.read=async()=>f.writes.length?{rows:['Do you trust this folder?','› 1. Yes','  2. No'],cursorRow:1,cursorCol:0,alternate:true}:read();
 await expect(changeWorkroomEffort(f.control)).rejects.toThrow('확인하지 못');expect(f.writes).toEqual(['/reasoning low']);
});
test('revoking Hermes after typing its own command never sends Enter',async()=>{
 const f=nativeHermes();f.control.active=()=>!f.writes.length;
 await expect(changeWorkroomEffort(f.control)).rejects.toThrow('변경');expect(f.writes).toEqual(['/reasoning low']);
});
test('an unrecognized Hermes mutation response is not treated as an applied effort',async()=>{
 const f=nativeHermes(),write=f.control.write;
 f.control.write=async data=>{await write(data);if(data==='\r')f.control.read=async()=>({rows:['unsupported effort','❯ '],cursorRow:1,cursorCol:2,alternate:true});};
 await expect(changeWorkroomEffort(f.control)).rejects.toThrow('확인하지 못');expect(f.writes).toEqual(['/reasoning low','\r']);
});
