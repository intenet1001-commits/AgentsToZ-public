import {appendFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {join, dirname} from 'node:path';

// Keep the actual /api/open-orca-agent algorithm (selection, fallback, reuse,
// launch verification). Stub only the OS process boundary, never run Orca/UI.
const fakePath = join(process.env.HOME!, 'Applications/Orca.app/Contents/Resources/bin/orca');
mkdirSync(dirname(fakePath), {recursive: true}); writeFileSync(fakePath, 'fixture only');
const processes = require('child_process');
const originalSync = processes.spawnSync.bind(processes), originalExec = processes.execFile.bind(processes);
let terminal: Record<string, unknown> | null = null;
processes.spawnSync = (command: string, args: string[], options: unknown) => {
  if (command === 'open' || command === '/usr/bin/open' || command === 'osascript') {
    throw new Error('Unexpected native UI launch in isolated Orca fixture');
  }
  return originalSync(command, args, options);
};
// ensureOrcaReady calls open -a Orca after the CLI check; record, do not execute.
const guardedSync = processes.spawnSync;
processes.spawnSync = (command: string, args: string[], options: unknown) => command === 'open' && args.join(' ') === '-a Orca'
  ? {status: 0, stdout: '', stderr: ''} : guardedSync(command, args, options);
processes.execFile = (command: string, args: string[], options: unknown, done: (...args: any[]) => void) => {
  if (command !== 'osascript') return originalExec(command, args, options, done);
  if (!args[1]?.startsWith('do shell script ')) throw new Error('Unexpected osascript in Orca fixture');
  const shell: string = JSON.parse(args[1].slice('do shell script '.length));
  appendFileSync(join(process.env.HOME!, 'orca-processes.jsonl'), JSON.stringify(shell) + '\n');
  let result: any = {};
  if (shell.includes("'terminal' 'create'")) {
    if (shell.includes("'--worktree' 'path:")) {
      done(null, JSON.stringify({ok: false, error: {code: 'selector_not_found', message: 'selector_not_found'}}), ''); return;
    }
    if (!shell.includes("'--worktree' 'id:global-floating-terminal'")) throw new Error('Wrong floating selector');
    terminal = {handle: 'fixture-orca-handle', worktreeId: 'global-floating-terminal',
      title: shell.match(/'--title' '([^']*)'/)?.[1], connected: true, hostPlatform: 'darwin'};
    result = {terminal};
  } else if (shell.includes("'terminal' 'list'")) result = {terminals: terminal ? [terminal] : []};
  else if (shell.includes("'terminal' 'show'")) result = {terminal};
  else if (shell.includes("'terminal' 'read'")) result = {terminal: {...terminal, output: 'READY:fixture'}};
  else if (shell.includes("'worktree' 'list'")) result = {worktrees: []};
  else if (shell.includes("'computer' 'get-app-state'")) result = {text: 'Minimize floating workspace'};
  else if (!shell.includes("'open'") && !shell.includes("'repo' 'add'") && !shell.includes("'terminal' 'switch'")) throw new Error('Unexpected Orca operation: ' + shell);
  done(null, JSON.stringify({ok: true, result}), '');
};
await import('./agentstoz-use-api');
