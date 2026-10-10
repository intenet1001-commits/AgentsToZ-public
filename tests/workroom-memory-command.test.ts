import {expect,test} from 'bun:test';
import {AI_TERMINAL_AGENTS} from '../src/aiTerminalProtocol';
import {WORKROOM_MEMORY_COMMANDS,isWorkroomPaletteCommand,workroomMemoryCommand} from '../src/workroomCliCommands';

test('each CLI types its own memory command; Antigravity has none and keeps the draft',()=>{
  expect(workroomMemoryCommand('claude')).toBe('/remember-session');
  expect(workroomMemoryCommand('hermes')).toBe('/remember_session');
  // Codex's is a `$` skill, not a slash command — the palette check knows that, a slash check would not.
  expect(workroomMemoryCommand('codex')).toBe('$remember-session');
  expect(workroomMemoryCommand('agy')).toBeNull();
});

test('every agent has an entry and every command survives input validation',()=>{
  for(const agent of AI_TERMINAL_AGENTS){
    expect(Object.hasOwn(WORKROOM_MEMORY_COMMANDS,agent)).toBe(true);
    const command=workroomMemoryCommand(agent);
    if(command!==null)expect(isWorkroomPaletteCommand(command,agent)).toBe(true);
  }
});
