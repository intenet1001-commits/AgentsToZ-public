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
  /** Current terminal width. Claude's slider footer wraps on a narrow screen, so its clipping depends on width too. */
  cols?: number;
  /** Where the CLI already refused its native control. Nothing is typed there again. */
  refusal?: EffortRefusal;
  /** The CLI refused its native control in a way that will repeat there. The level did not move. */
  refused?(refusal: EffortRefusal): void;
  timeoutMs?: number;
  sleep?(ms: number): Promise<void>;
}
/**
 * How long a whole-request submission waits for the CLI to show an empty, idle composer before an automatic change.
 * It must end well inside every client's wait (browser 15 s, app proxy and MCP 20 s) and the 30 s submission lifetime:
 * a 60 s wait held every write past them, so the request was never typed and its receipt fenced the composer (2026-10-30).
 */
export const WORKROOM_EFFORT_READY_WAIT_MS = 4_000;
/**
 * The keys and their proof share one deadline after the ready wait, and a cancel gets a short one of its own: three
 * separate 80-read waits after a failed `s` reached about 13.6 s of sleep alone, close to the browser's 15 s (2026-10-31 review).
 */
export const WORKROOM_EFFORT_CHANGE_WAIT_MS = 6_000;
export const WORKROOM_EFFORT_CANCEL_WAIT_MS = 1_500;
/**
 * Claude's slider clipped at this size or smaller (a narrower screen wraps its footer onto more rows), or Codex's
 * shortcuts unavailable for this model. Another model or a larger screen tries again.
 */
export interface EffortRefusal {rows?: number; cols?: number; model?: string}
/** The composer was not proven empty and idle in time. Nothing was typed: the caller may go on without the change. */
export class WorkroomEffortNotReadyError extends Error {
  constructor() { super('현재 응답이 진행 중이거나 CLI 입력칸이 사용 중입니다. 입력 대기 상태에서 다시 보내세요. 작성한 요청은 유지했습니다.'); this.name = 'WorkroomEffortNotReadyError'; }
}
const LEVELS = ['low', 'medium', 'high'];
const CLAUDE_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const levelWords = (row: string) => CLAUDE_LEVELS.filter(level => new RegExp('\\b'+level+'\\b','i').test(row));
/**
 * Claude 2.1.314 draws its slider where the composer was: a row that is only 「Effort」, 「Faster … Smarter」, the track
 * (「───▲───」) and right under it one row naming the model's levels (「low  medium  high  xhigh  max」); no composer row
 * below. A transcript row naming levels (`const LEVELS = ['low', 'medium', 'high'];`) or the 「◉ xhigh · /effort」 status
 * line is not the slider: matching either refused a valid change, or typed Escape into the composer when no slider
 * had opened (2026-10-31 review). The title and the track prove it is open; narrower than about 42 columns its rows are
 * cut at both sides (「aster … Smarte」, 「ow  medium  high  xhigh  ma」 at 40, measured 2026-10-31), so `levels` is null
 * unless the level row is whole enough to count arrows on. `top` is the title row; the footer is read from it down only.
 */
function claudeSlider(f: EffortFrame): {top: number; levels: string[] | null} | null {
  let top = -1;
  for (let i = f.rows.length - 1; i >= 0; i--) if (/^\s*Effort\s*$/.test(f.rows[i]!)) { top = i; break; }
  if (top < 0 || f.rows.slice(top + 1).some(row => /^\s*[>›❯](?:\s|$)/.test(row))) return null;
  const track = f.rows.findIndex((row, i) => i > top && i <= top + 4 && /─▲|▲─/.test(row));
  if (track < 0) return null;
  const words = levelWords(f.rows[track + 1] ?? '');
  return {top, levels: LEVELS.every(level => words.includes(level)) ? words : null};
}
/**
 * Its footer 「←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel」 is the only proof that `s`
 * keeps the level for this session. It wraps on a narrow screen (60 columns: 「…s for this session」/「only…」) and is
 * cut off on a short one (12 rows or fewer, measured 2026-10-31 in a 105×11 Workroom), so rows are joined first.
 */
const claudeSessionOnlyHint = (rows: string[]) => /(?:^|[\s·])s\s+(?:for\s+)?(?:(?:this|current)\s+)?session\s+only\b/i
  .test(rows.join(' ').replace(/\s+/g, ' '));
/**
 * Codex 0.166 answers a reasoning shortcut it will not take with this info row and leaves the level as it was. Only a
 * row that is the whole sentence counts: streamed output quoting it (this repository's code and docs do) is not one.
 */
const CODEX_SHORTCUT_REFUSAL = /^\s*(?:[•·■▪◦-]\s*)?Reasoning shortcuts are (?:unavailable for ([\w.:/-]*\w)|disabled until startup completes)\.?\s*$/i;
const codexRefusals = (f: EffortFrame | null) => f?.rows.filter(row => CODEX_SHORTCUT_REFUSAL.test(row)) ?? [];
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
/** Codex 0.166 marks its composer 「»」 at `ultra` and 「›」 at every other level (measured 2026-10-31, same binary). */
function composerText(line: string): string {
  return line.replace(/[│┃]\s*$/, '').replace(/^\s*[>›»❯]\s*/, '').trimEnd();
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
  const marker = /[>›»❯]/.exec(line);
  if (!marker || frame.cursorCol < marker.index + 1 || frame.cursorCol > marker.index + 3) return false;
  const tail=line.slice(marker.index+1).trim();
  // A native placeholder is drawn dimmed with the cursor right after 「❯ 」/「› 」; a draft, even the same words, is not dim
  // or has the cursor after it. Claude: its 「Try "…"」 hint and, since 2.1.314, the next-prompt suggestion it shows after
  // every turn — one row between the composer rules. Codex 0.166: 「Ask a follow-up question」 after the first turn.
  const placeholder=!!frame.dimmedCursorTail&&frame.cursorCol===marker.index+2&&line[marker.index+1]!==undefined&&!line[marker.index+1]!.trim();
  if(agent==='claude'&&placeholder&&tail.length<=200
      &&/^\s*[─━]{5,}\s*$/.test(frame.rows[frame.cursorRow-1]??'')
      &&/^\s*[─━]{5,}\s*$/.test(frame.rows[frame.cursorRow+1]??''))return true;
  if(agent==='codex'&&placeholder&&/^ask a follow-up question$/i.test(tail))return true;
  return !tail || /^(?:ask codex to do anything|type your message|send a message|implement \{feature\}|find and fix a bug in @filename|improve documentation in @filename|explain this codebase|write tests for @filename)[.…]*$/i.test(tail);
}
/**
 * `unchanged`: keys reached the CLI but it cancelled or refused the change, and the screen proves the level is still the
 * one it had and the composer is empty again. The request may go on at that level.
 */
export async function changeWorkroomEffort(c: EffortRuntimeControl): Promise<'applied' | 'unsupported' | 'unchanged'> {
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
    // An effort the CLI does not show can never be changed below, so waiting for its composer only delays the request
    // (the caller still proves the composer empty before the request is typed).
    if (c.agent !== 'hermes' && frame && !(cliInfoFromScreen(c.agent, frame.rows).effort ?? c.current)) return 'unsupported';
    if (Date.now() >= deadline) throw new WorkroomEffortNotReadyError();
    await sleep(100);
  } while (true);
  const before = cliInfoFromScreen(c.agent, frame!.rows).effort ?? c.current;
  if (before === c.level) return 'applied';
  const r = c.refusal;
  if (r && (c.agent === 'claude' && (r.rows !== undefined || r.cols !== undefined)
        && (r.rows === undefined || frame!.rows.length <= r.rows) && (r.cols === undefined || c.cols !== undefined && c.cols <= r.cols)
      // The footer reads 「GPT-6.1-Sol high」 where the refusal says 「gpt-6.1-sol」 (live 0.166, 2026-10-31).
      || c.agent === 'codex' && r.model !== undefined && cliInfoFromScreen('codex', frame!.rows).model?.toLowerCase() === r.model.toLowerCase())) return 'unsupported';
  if (c.agent !== 'hermes' && (!before || !(c.agent === 'codex' ? CODEX_LEVELS : CLAUDE_LEVELS).includes(before))) return 'unsupported';
  const changeDeadline = Date.now() + WORKROOM_EFFORT_CHANGE_WAIT_MS;
  const wait = async (predicate: (f: EffortFrame) => boolean, until = changeDeadline): Promise<EffortFrame> => {
    for (let attempt = 0; attempt < 80 && (attempt === 0 || Date.now() < until); attempt++) {
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
  /**
   * A picker left open after a failed step fenced the Workroom: the request stayed unsent and the person met the slider
   * (2026-10-31, v1594). Escape cancels it without saving anything (「⎿ Cancelled」, measured in Claude 2.1.314). Only
   * when the picker is still open, and only a cancel the screen proves — the level back at `before` and the composer
   * empty — lets the request go on unchanged. Anything else keeps the original refusal.
   */
  const cancelClaudePicker = async (error: unknown, clipped: boolean): Promise<'unchanged'> => {
    const open = await c.read();
    const slider = open && claudeSlider(open);
    if (!slider) throw error;
    try {
      await write('\x1b');
      await wait(f => !claudeSlider(f) && effortComposerEmpty(f, 'claude') && cliInfoFromScreen('claude', f.rows).effort === before,
        Date.now() + WORKROOM_EFFORT_CANCEL_WAIT_MS);
    } catch { throw error; }
    // Cut at the sides: only the width matters. Footer below the screen: the height, and the width it wrapped at.
    if (clipped && !slider.levels) { if (c.cols) c.refused?.({cols: c.cols}); }
    else if (clipped) c.refused?.({rows: open!.rows.length, ...(c.cols ? {cols: c.cols} : {})});
    check(); return 'unchanged';
  };
  if (c.agent === 'codex') {
    // Native non-persistent shortcuts, proven in codex-cli 0.163.0 reasoning_shortcuts.rs.
    let current = before!;
    for (let step = 0; step < CODEX_LEVELS.length && current !== c.level; step++) {
      const direction = CODEX_LEVELS.indexOf(c.level) > CODEX_LEVELS.indexOf(current) ? 1 : -1;
      const refusals = codexRefusals(await c.read()).length;
      await write(direction > 0 ? '\x1b.' : '\x1b,');
      const next = await wait(f => { const level = cliInfoFromScreen('codex', f.rows).effort; return !!level && level !== current || codexRefusals(f).length > refusals; });
      const refusal = codexRefusals(next);
      if (refusal.length > refusals) {
        // 「Reasoning shortcuts are unavailable for gpt-6.1-sol」 (2026-10-31): nothing moved. Only a first refusal with the
        // level still `before` and the composer as it was lets the request go on; a later one leaves a partial change.
        // A shortcut that did apply repaints the footer a moment later, so the level is read once more after a pause.
        const bad = (f: EffortFrame | null) => !f || cliInfoFromScreen('codex', f.rows).effort !== before || !composerReady(f);
        if (step > 0 || bad(next)) throw Error('Codex 에포트 변경이 예상과 다릅니다. 작성한 요청은 유지했습니다.');
        await sleep(200); check();
        if (bad(await c.read())) throw Error('Codex 에포트 변경이 예상과 다릅니다. 작성한 요청은 유지했습니다.');
        const model = CODEX_SHORTCUT_REFUSAL.exec(refusal.at(-1)!)![1];
        if (model) c.refused?.({model});
        check(); return 'unchanged';
      }
      const observed = cliInfoFromScreen('codex', next.rows).effort!;
      const rank=CODEX_LEVELS.indexOf(observed), previous=CODEX_LEVELS.indexOf(current), target=CODEX_LEVELS.indexOf(c.level);
      if (rank < 0 || (rank-previous)*direction <= 0 || (target-rank)*direction < 0) throw Error('Codex 에포트 변경이 예상과 다릅니다. 작성한 요청은 유지했습니다.');
      current = observed;
    }
    if (current !== c.level) throw Error('Codex 에포트 자동 변경을 완료하지 못했습니다. 작성한 요청은 유지했습니다.');
  } else if (c.agent === 'claude') {
    await write('/effort\r');
    // The slider draws as one frame, so an open slider without its footer after this many reads is clipped, not late.
    let withoutHint = 0, picker: EffortFrame;
    const clipped = Error('에포트 선택 화면의 「이 세션만」 안내가 화면에 보이지 않습니다. 작성한 요청은 유지했습니다.');
    try {
      picker = await wait(f => {
        const open = claudeSlider(f);
        if (!open) { withoutHint = 0; return false; }
        if (open.levels && claudeSessionOnlyHint(f.rows.slice(open.top))) return true;
        if (++withoutHint >= 25) throw clipped;
        return false;
      });
    } catch (error) {
      return cancelClaudePicker(error, error === clipped);
    }
    if (workroomScreenAwaitsAnswer(picker.rows) && !/\beffort\b/i.test(picker.rows.join('\n'))) throw Error('에포트 선택 화면을 확인하지 못했습니다.');
    // Read the model's actual picker labels from the slider's own level row; xhigh/max vary by model.
    const available = claudeSlider(picker)!.levels!;
    if (!available.includes(before!) || !available.includes(c.level)) return cancelClaudePicker(Error('현재 모델의 에포트 선택 항목을 확인하지 못했습니다.'), false);
    const delta = available.indexOf(c.level) - available.indexOf(before!);
    for (let step = 0; step < Math.abs(delta); step++) await write(delta > 0 ? '\x1b[C' : '\x1b[D');
    await write('s'); // session only; Enter and `/effort <level>` would persist another session's default.
    // A slider slow to open must not leave `s` a single read before Escape is typed behind it.
    try { await wait(f => effortComposerEmpty(f, c.agent) && cliInfoFromScreen('claude', f.rows).effort === c.level, Math.max(changeDeadline, Date.now() + 1_000)); }
    catch (error) { return cancelClaudePicker(error, false); }
  } else {
    const command = `/reasoning ${c.level}`; // no --global; Hermes keeps the change in this session.
    const ownDraft = (f: EffortFrame) => {
      if (workroomScreenAwaitsAnswer(f.rows)) return false;
      const line = f.rows[f.cursorRow] ?? '';
      const prefix = /^\s*[>›»❯]\s*/.exec(line)?.[0];
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
