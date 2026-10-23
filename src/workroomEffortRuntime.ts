import type {AiTerminalAgent} from './aiTerminalProtocol';
import type {WorkroomEffortLevel} from './workroomEffortPolicy';
import {cliInfoFromScreen} from './workroomCliCommands';
import {workroomScreenAwaitsAnswer} from './workroomRouteDelivery';

export interface EffortFrame {rows: string[]; cursorRow: number; cursorCol: number; alternate: boolean; dimmedCursorTail?:true}
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
  /** Exact native composer snapshot; Codex shortcuts may preserve a draft without clearing it. */
  codexComposerStable?(frame: EffortFrame): boolean;
  timeoutMs?: number;
  sleep?(ms: number): Promise<void>;
}
const LEVELS = ['low', 'medium', 'high'];
const CODEX_LEVELS = ['none','minimal','low','medium','high','xhigh','max','ultra'];
const HERMES_HINTS = new Set([
  'Try "explain this codebase"', 'Try "write a test for…"', 'Try "refactor the auth module"',
  'Try "/help" for commands', 'Try "fix the lint errors"', 'Try "how does the config loader work?"',
]);
/** The TUI hides its hardware cursor while drawing a placeholder. Require its ready/composer geometry. */
function hermesComposerRow(frame: EffortFrame): number | null {
  if (!frame.alternate) return null;
  let row = -1;
  for (let i = frame.rows.length - 1; i >= 0; i--) if (/^\s*❯(?:\s|$)/.test(frame.rows[i]!)) { row = i; break; }
  if (row < 2 || !/^\s*[─━]{5,}\s*$/.test(frame.rows[row - 1] ?? '')
      || !/^\s*[─━]\s+\S.*[│|]/.test(frame.rows[row - 2] ?? '')
      || !/^\s*[─━]{5,}\s*$/.test(frame.rows[row + 1] ?? '')) return null;
  return row;
}
function hermesReady(frame: EffortFrame): boolean {
  const row = hermesComposerRow(frame);
  return row !== null && /^\s*[─━]\s+ready\s*[│|]/i.test(frame.rows[row - 2] ?? '');
}
function composerText(line: string): string {
  return line.replace(/[│┃]\s*$/, '').replace(/^\s*[>›❯]\s*/, '').trimEnd();
}
export function effortComposerEmpty(frame: EffortFrame | null, agent?: AiTerminalAgent): boolean {
  if (!frame || workroomScreenAwaitsAnswer(frame.rows)) return false;
  if (agent === 'hermes') {
    const row = hermesComposerRow(frame);
    if (row !== null) {
      const text = composerText(frame.rows[row]!);
      return !text || frame.cursorRow !== row && HERMES_HINTS.has(text);
    }
  }
  const line = frame.rows[frame.cursorRow] ?? '';
  const marker = /[>›❯]/.exec(line);
  if (!marker || frame.cursorCol < marker.index + 1 || frame.cursorCol > marker.index + 3) return false;
  const tail=line.slice(marker.index+1).trim();
  if(agent==='claude'&&frame.dimmedCursorTail&&frame.cursorCol===line.indexOf('Try ',marker.index+1)&&/^Try "[^"\r\n]{1,160}"$/.test(tail)
      &&/^\s*[─━]{5,}\s*$/.test(frame.rows[frame.cursorRow-1]??'')
      &&/^\s*[─━]{5,}\s*$/.test(frame.rows[frame.cursorRow+1]??''))return true;
  return !tail || /^(?:ask codex to do anything|type your message|send a message|implement \{feature\}|find and fix a bug in @filename|improve documentation in @filename|explain this codebase|write tests for @filename)[.…]*$/i.test(tail);
}
export async function changeWorkroomEffort(c: EffortRuntimeControl): Promise<'applied' | 'unsupported'> {
  if (!['codex', 'claude', 'hermes'].includes(c.agent)) return 'unsupported';
  if (c.agent === 'claude' && !c.claudeSessionPicker || c.agent === 'codex' && !c.codexDefaultKeys) return 'unsupported';
  if (c.agent === 'hermes') {
    const initial = await c.read();
    // A noninteractive wrapper has no native composer. Never hold its request waiting for a TUI it does not have.
    if (!initial || !effortComposerEmpty(initial, c.agent) && hermesComposerRow(initial) === null
        && !/Hermes Agent|Reasoning effort/i.test(initial.rows.join('\n'))) return 'unsupported';
  }
  const sleep = c.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const check = () => { if (!c.active()) throw Error('워크룸 입력·에포트 설정이 변경되었습니다. 작성한 요청은 유지했습니다.'); };
  const idle = (f: EffortFrame) => c.agent === 'codex' || (c.agent === 'hermes' && hermesComposerRow(f) !== null ? hermesReady(f) : c.idle());
  const composerReady = (f: EffortFrame | null) => !!f && (c.agent === 'codex' && c.codexComposerStable
    ? !workroomScreenAwaitsAnswer(f.rows) && c.codexComposerStable(f) : effortComposerEmpty(f, c.agent));
  let frame: EffortFrame | null = null;
  const deadline = Date.now() + (c.timeoutMs ?? 60000);
  // Codex's native shortcut can configure the next turn while the current turn is running.
  // Claude/Hermes slash commands wait for the current response without interrupting it.
  do {
    check(); frame = await c.read();
    // Hermes TUI repaints its idle clock: raw PTY quiet may never arrive. Its native ready
    // status plus bounded composer geometry is a stronger idle proof than that heuristic.
    if (composerReady(frame) && idle(frame!)) break;
    if (frame && workroomScreenAwaitsAnswer(frame.rows)) throw Error('CLI의 승인·선택 화면에서는 에포트를 자동 변경하지 않습니다. 원본 워크룸을 확인하세요. 작성한 요청은 유지했습니다.');
    if (Date.now() >= deadline) throw Error('현재 응답이 진행 중이거나 CLI 입력칸이 사용 중입니다. 입력 대기 상태에서 다시 보내세요. 작성한 요청은 유지했습니다.');
    await sleep(100);
  } while (true);
  const before = cliInfoFromScreen(c.agent, frame!.rows).effort ?? c.current;
  if (before === c.level) return 'applied';
  if (c.agent !== 'hermes' && (!before || !(c.agent === 'codex' ? CODEX_LEVELS : ['low','medium','high','xhigh','max']).includes(before))) return 'unsupported';
  const wait = async (predicate: (f: EffortFrame) => boolean): Promise<EffortFrame> => {
    for (let attempt = 0; attempt < 80; attempt++) {
      check(); const next = await c.read();
      if (c.agent === 'codex' && c.codexComposerStable && !composerReady(next)) throw Error('Codex 입력이 변경되어 자동 조절을 멈췄습니다. 요청은 전송하지 않았습니다.');
      if (next && predicate(next)) return next;
      await sleep(40);
    }
    throw Error('에포트 자동 변경 결과를 확인하지 못했습니다. 원본 워크룸을 확인하세요. 작성한 요청은 유지했습니다.');
  };
  const write = async (data: string) => {
    check();
    if (c.agent === 'codex' && c.codexComposerStable && !composerReady(await c.read())) throw Error('Codex 입력이 변경되어 자동 조절을 멈췄습니다. 요청은 전송하지 않았습니다.');
    check(); await c.write(data); check();
  };
  if (c.agent === 'codex') {
    // Native non-persistent shortcuts, proven in codex-cli 0.163.0 reasoning_shortcuts.rs.
    let current = before!;
    for (let step = 0; step < CODEX_LEVELS.length && current !== c.level; step++) {
      const direction = CODEX_LEVELS.indexOf(c.level) > CODEX_LEVELS.indexOf(current) ? 1 : -1;
      await write(direction > 0 ? '\x1b.' : '\x1b,');
      const next = await wait(f => { const level = cliInfoFromScreen('codex', f.rows).effort; return !!level && level !== current; });
      const observed = cliInfoFromScreen('codex', next.rows).effort!;
      const rank=CODEX_LEVELS.indexOf(observed), previous=CODEX_LEVELS.indexOf(current), target=CODEX_LEVELS.indexOf(c.level);
      if (rank < 0 || (rank-previous)*direction <= 0 || (target-rank)*direction < 0) throw Error('Codex 에포트 변경이 예상과 다릅니다. 작성한 요청은 유지했습니다.');
      current = observed;
    }
    if (current !== c.level) throw Error('Codex 에포트 자동 변경을 완료하지 못했습니다. 작성한 요청은 유지했습니다.');
  } else if (c.agent === 'claude') {
    await write('/effort\r');
    const picker = await wait(f => /\beffort\b/i.test(f.rows.join('\n')) && LEVELS.every(level => new RegExp('\\b'+level+'\\b','i').test(f.rows.join('\n'))) && /\bs\b[^\n]*(?:(?:this|current)\s+)?session only/i.test(f.rows.join('\n')));
    if (workroomScreenAwaitsAnswer(picker.rows) && !/\beffort\b/i.test(picker.rows.join('\n'))) throw Error('에포트 선택 화면을 확인하지 못했습니다.');
    // Read the model's actual picker labels; xhigh/max vary by model.
    const pickerWords = picker.rows.join('\n');
    const available = ['low','medium','high','xhigh','max'].filter(level => new RegExp('\\b'+level+'\\b','i').test(pickerWords));
    if (!available.includes(before!) || !available.includes(c.level)) throw Error('현재 모델의 에포트 선택 항목을 확인하지 못했습니다.');
    const delta = available.indexOf(c.level) - available.indexOf(before!);
    for (let step = 0; step < Math.abs(delta); step++) await write(delta > 0 ? '\x1b[C' : '\x1b[D');
    await write('s'); // session only; Enter and `/effort <level>` would persist another session's default.
    await wait(f => effortComposerEmpty(f, c.agent) && cliInfoFromScreen('claude', f.rows).effort === c.level);
  } else {
    const command = `/reasoning ${c.level}`; // no --global; Hermes keeps the change in this session.
    const ownDraft = (f: EffortFrame) => {
      if (workroomScreenAwaitsAnswer(f.rows)) return false;
      const line = f.rows[f.cursorRow] ?? '';
      const prefix = /^\s*[>›❯]\s*/.exec(line)?.[0];
      return prefix !== undefined && composerText(line) === command && f.cursorCol === prefix.length + command.length;
    };
    // A text+CR packet is treated as pasted text by the current TUI. Observe our exact draft
    // before a separate Enter; never confirm a changed draft, menu or approval dialog.
    await write(command);
    await wait(ownDraft);
    const ready = await c.read();
    if (!ready || !ownDraft(ready) || !idle(ready)) throw Error('Hermes 입력칸이 변경되었습니다. 작성한 요청은 유지했습니다.');
    await write('\r');
    await wait(f => effortComposerEmpty(f, 'hermes') && cliInfoFromScreen('hermes', f.rows).effort === c.level);
  }
  check(); return 'applied';
}
