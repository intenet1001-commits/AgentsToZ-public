import type {AiTerminalAgent} from './aiTerminalProtocol';
import type {WorkroomEffortLevel} from './workroomEffortPolicy';
import {cliInfoFromScreen} from './workroomCliCommands';
import {workroomScreenAwaitsAnswer} from './workroomRouteDelivery';

export interface EffortFrame {rows: string[]; cursorRow: number; cursorCol: number; alternate: boolean}
export interface EffortRuntimeControl {
  agent: AiTerminalAgent;
  level: WorkroomEffortLevel;
  current?: string;
  read(): Promise<EffortFrame | null>;
  write(data: string): void | Promise<void>;
  active(): boolean;
  idle(): boolean;
  /** Claude's session-only picker was added in 2.1.257. Never use the persistent argument form. */
  claudeSessionPicker: boolean;
  codexDefaultKeys: boolean;
  timeoutMs?: number;
  sleep?(ms: number): Promise<void>;
}
const LEVELS = ['low', 'medium', 'high'];
export function effortComposerEmpty(frame: EffortFrame | null): boolean {
  if (!frame || workroomScreenAwaitsAnswer(frame.rows)) return false;
  const line = frame.rows[frame.cursorRow] ?? '';
  const marker = /[>›❯]/.exec(line);
  if (!marker || frame.cursorCol < marker.index + 1 || frame.cursorCol > marker.index + 3) return false;
  const tail=line.slice(marker.index+1).trim();
  return !tail || /^(?:ask codex to do anything|type your message|send a message|implement \{feature\}|find and fix a bug in @filename|improve documentation in @filename|explain this codebase|write tests for @filename)[.…]*$/i.test(tail);
}
export async function changeWorkroomEffort(c: EffortRuntimeControl): Promise<'applied' | 'unsupported'> {
  if (!['codex', 'claude', 'hermes'].includes(c.agent)) return 'unsupported';
  if (c.agent === 'claude' && !c.claudeSessionPicker || c.agent === 'codex' && !c.codexDefaultKeys) return 'unsupported';
  if (c.agent === 'hermes') {
    const initial = await c.read();
    // A noninteractive wrapper has no native composer. Never hold its request waiting for a TUI it does not have.
    if (!initial || !effortComposerEmpty(initial) && !/Hermes Agent|Reasoning effort/i.test(initial.rows.join('\n'))) return 'unsupported';
  }
  const sleep = c.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const check = () => { if (!c.active()) throw Error('워크룸 입력·에포트 설정이 변경되었습니다. 작성한 요청은 유지했습니다.'); };
  let frame: EffortFrame | null = null;
  const deadline = Date.now() + (c.timeoutMs ?? 60000);
  // Codex's native shortcut can configure the next turn while the current turn is running.
  // Claude/Hermes slash commands wait for the current response without interrupting it.
  do {
    check(); frame = await c.read();
    if (effortComposerEmpty(frame) && (c.agent === 'codex' || c.idle())) break;
    if (frame && workroomScreenAwaitsAnswer(frame.rows)) throw Error('CLI의 승인·선택 화면에서는 에포트를 자동 변경하지 않습니다. 원본 워크룸을 확인하세요. 작성한 요청은 유지했습니다.');
    if (Date.now() >= deadline) throw Error('현재 응답이 진행 중이거나 CLI 입력칸이 사용 중입니다. 입력 대기 상태에서 다시 보내세요. 작성한 요청은 유지했습니다.');
    await sleep(100);
  } while (true);
  const before = cliInfoFromScreen(c.agent, frame!.rows).effort ?? c.current;
  if (before === c.level) return 'applied';
  if (c.agent !== 'hermes' && (!before || !LEVELS.includes(before))) return 'unsupported';
  const wait = async (predicate: (f: EffortFrame) => boolean): Promise<EffortFrame> => {
    for (let attempt = 0; attempt < 80; attempt++) {
      check(); const next = await c.read();
      if (next && predicate(next)) return next;
      await sleep(40);
    }
    throw Error('에포트 자동 변경 결과를 확인하지 못했습니다. 원본 워크룸을 확인하세요. 작성한 요청은 유지했습니다.');
  };
  const write = async (data: string) => { check(); await c.write(data); check(); };
  if (c.agent === 'codex') {
    // Native non-persistent shortcuts, proven in codex-cli 0.163.0 reasoning_shortcuts.rs.
    let current = before!;
    for (let step = 0; step < 4 && current !== c.level; step++) {
      const direction = LEVELS.indexOf(c.level) > LEVELS.indexOf(current) ? 1 : -1;
      await write(direction > 0 ? '\x1b.' : '\x1b,');
      const next = await wait(f => { const level = cliInfoFromScreen('codex', f.rows).effort; return !!level && level !== current; });
      const observed = cliInfoFromScreen('codex', next.rows).effort!;
      if (!LEVELS.includes(observed) || LEVELS.indexOf(observed) !== LEVELS.indexOf(current) + direction) throw Error('Codex 에포트 변경이 예상과 다릅니다. 작성한 요청은 유지했습니다.');
      current = observed;
    }
    if (current !== c.level) throw Error('Codex 에포트 자동 변경을 완료하지 못했습니다. 작성한 요청은 유지했습니다.');
  } else if (c.agent === 'claude') {
    await write('/effort\r');
    const picker = await wait(f => /\beffort\b/i.test(f.rows.join('\n')) && LEVELS.every(level => new RegExp('\\b'+level+'\\b','i').test(f.rows.join('\n'))) && /\bs\b[^\n]*(?:(?:this|current)\s+)?session only/i.test(f.rows.join('\n')));
    if (workroomScreenAwaitsAnswer(picker.rows) && !/\beffort\b/i.test(picker.rows.join('\n'))) throw Error('에포트 선택 화면을 확인하지 못했습니다.');
    const delta = LEVELS.indexOf(c.level) - LEVELS.indexOf(before!);
    for (let step = 0; step < Math.abs(delta); step++) await write(delta > 0 ? '\x1b[C' : '\x1b[D');
    await write('s'); // session only; Enter and `/effort <level>` would persist another session's default.
    await wait(f => effortComposerEmpty(f) && cliInfoFromScreen('claude', f.rows).effort === c.level);
  } else {
    await write(`/reasoning ${c.level}\r`); // no --global; Hermes keeps the change in this session.
    await wait(f => effortComposerEmpty(f) && cliInfoFromScreen('hermes', f.rows).effort === c.level);
  }
  check(); return 'applied';
}
