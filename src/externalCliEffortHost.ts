import {resolveAppDataDirFromEnvironment} from './appDataDir';
import {createWorkroomEffortSetting} from './workroomEffortSetting';
import {AiTerminalScreen} from './aiTerminalScreen';
import {ExternalCliEffort, externalCliEffortAgent} from './externalCliEffort';
import {workroomEffortRuntimeSupport} from './workroomEffortRuntimeSupport';
import {codexEffortModel} from './codexEffortModel';

// Bun's PTY API is newer than this project's pinned ambient types (also used by AiTerminalService).
type NativeTerminal = {write(data:string | Uint8Array):number;resize(cols:number,rows:number):void;close():void};
const spawnPty = Bun.spawn as unknown as (args:string[], options:{cwd:string;env:NodeJS.ProcessEnv;
  terminal:{cols:number;rows:number;data(terminal:NativeTerminal,bytes:Uint8Array):void}}) => {
    terminal:NativeTerminal;exited:Promise<number>;kill(signal:string):void;
  };

/** Standalone PTY host used identically by cmux, Orca, iTerm and Terminal. No HTTP listener or AI call. */
export async function runExternalCliEffort(args: string[]): Promise<number> {
  const [agent, executable, command, ...nativeArgs] = args;
  if (!agent || !externalCliEffortAgent(agent) || !executable || !command) throw Error('외부 CLI 실행 인자를 확인하세요.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error('에포트 자동 조절 CLI는 대화형 터미널에서 실행하세요.');
  if (process.platform !== 'darwin') throw Error('외부 CLI 에포트 호스트는 현재 macOS에서 지원합니다.');
  const setting = createWorkroomEffortSetting(resolveAppDataDirFromEnvironment());
  const support = workroomEffortRuntimeSupport(executable, agent, process.env, process.cwd());
  const allowed = agent === 'codex' ? support.codexDefaultKeys && codexEffortModel({env:process.env,cwd:process.cwd()}).ok
    : agent === 'claude' ? support.claudeSessionPicker && !process.env.CLAUDE_CODE_EFFORT_LEVEL
    : agent === 'hermes';
  const cols = process.stdout.columns || 100, rows = process.stdout.rows || 28;
  // The real terminal answers device/cursor queries. This headless observer sends no replies.
  const screen = new AiTerminalScreen(cols, rows);
  let seq = 0, ended = false, lastOutputAt = 0;
  const decoder = new TextDecoder();
  const suffix = nativeArgs.map(value => "'"+value.replaceAll("'", "'\"'\"'")+"'").join(' ');
  const cliCommand = command + (suffix ? ' '+suffix : '') + (agent === 'codex' ? ' -c \'tui.status_line=["model-with-reasoning","context-remaining"]\'' : '');
  const child = spawnPty(['/bin/zsh','-l','-c',cliCommand], {cwd:process.cwd(),env:process.env,
    terminal:{cols,rows,data(_terminal, bytes) {lastOutputAt=Date.now();const text = decoder.decode(bytes,{stream:true}); screen.write(text,++seq); process.stdout.write(bytes);}},
  });
  const terminal = child.terminal!;
  const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve,ms));
  const control = new ExternalCliEffort({agent, ...support,
    mode:() => setting.getMode!(), allowed:() => allowed,
    read:() => screen.plainRows(), write:data => {terminal.write(data);},
    active:() => !ended && process.stdin.readableLength === 0,
    idle:() => Date.now()-lastOutputAt >= 1000,
    async paste(text) {terminal.write(screen.bracketedPasteMode ? '\x1b[200~'+text+'\x1b[201~' : text); await delay(160);},
    notice:message => {process.stderr.write('\r\nAgentsToZ: '+message+'\r\n');},
  });
  const onData = (bytes: Buffer) => {
    const text = bytes.toString('utf8');
    if (text === '\r' || text === '\n') {
      process.stdin.pause();
      void control.enter().catch(error => {process.stderr.write(String(error)+'\r\n');}).finally(() => {if (!ended) process.stdin.resume();});
    } else {terminal.write(bytes);}
  };
  const resize = () => {const c = process.stdout.columns || 100, r = process.stdout.rows || 28; terminal.resize(c,r); screen.resize(c,r);};
  const stop = () => {if (!ended) child.kill('SIGHUP');};
  const wasRaw = !!process.stdin.isRaw;
  process.stdin.setRawMode(true); process.stdin.on('data',onData); process.stdout.on('resize',resize);
  process.stdin.on('end',stop); process.on('SIGTERM',stop); process.on('SIGHUP',stop);
  try {return await child.exited;}
  finally {
    ended = true; process.stdin.off('data',onData); process.stdout.off('resize',resize); process.stdin.off('end',stop);
    process.off('SIGTERM',stop); process.off('SIGHUP',stop); process.stdin.setRawMode(wasRaw); process.stdin.pause();
    terminal.close(); screen.dispose();
  }
}
