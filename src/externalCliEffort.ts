import {stringWidth} from 'bun';
import type {AiTerminalAgent} from './aiTerminalProtocol';
import {classifyWorkroomEffort} from './workroomEffortPolicy';
import {workroomEffortInputIsManual} from './workroomEffortSession';
import {changeWorkroomEffort, effortComposerEmpty, type EffortFrame, type EffortRuntimeControl} from './workroomEffortRuntime';
import {cliInfoFromScreen} from './workroomCliCommands';
import {workroomScreenAwaitsAnswer} from './workroomRouteDelivery';
import type {WorkroomEffortMode} from './workroomEffortMode';

/** Only a complete, single visible composer line at its end is safe to move. */
export function externalCliPrompt(frame: EffortFrame | null): string | null {
  if (!frame || workroomScreenAwaitsAnswer(frame.rows)) return null;
  const line = frame.rows[frame.cursorRow] ?? '';
  const prefix = /^\s*[›❯>] /.exec(line)?.[0];
  if (!prefix) return null;
  const text = line.slice(prefix.length);
  if (!text || /[\x00-\x1f\x7f]/.test(text) || text.length > 4000 || stringWidth(line) !== frame.cursorCol) return null;
  // A continuation below the active row is not a single-line draft.
  const next = frame.rows[frame.cursorRow + 1]?.trim() ?? '';
  if (next && !/^[─━╰└]/.test(next)) return null;
  return text;
}

/** A bounded, fully visible Codex composer. Its native shortcuts never edit this text. */
export function externalCodexDraft(frame: EffortFrame | null): {text: string; stable(next: EffortFrame | null): boolean} | null {
  if (!frame || workroomScreenAwaitsAnswer(frame.rows)) return null;
  let start = frame.cursorRow;
  while (start >= 0 && frame.cursorRow - start < 24 && !/^\s*› /.test(frame.rows[start] ?? '')) start--;
  if (start < 0 || frame.cursorRow - start >= 24) return null;
  const prefix = /^\s*› /.exec(frame.rows[start]!)![0];
  const width = stringWidth(prefix);
  let end = start + 1;
  while (end < frame.rows.length && end - start < 24 && new RegExp('^ {' + width + '}\\S|^ {' + width + '}.*\\S').test(frame.rows[end]!)) end++;
  if (frame.cursorRow >= end || frame.cursorCol < width || frame.cursorCol > stringWidth(frame.rows[frame.cursorRow]!)) return null;
  const following = frame.rows[end]?.trim() ?? '';
  if (following && !/^[─━╰└]/.test(following)) return null;
  const rows = frame.rows.slice(start,end);
  const text = rows.map((line,index) => line.slice(index === 0 ? prefix.length : width)).join('\n');
  if (!text.trim() || text.length > 8000 || /[\x00-\x09\x0b-\x1f\x7f]/.test(text)) return null;
  const cursorRow = frame.cursorRow, cursorCol = frame.cursorCol, alternate = frame.alternate;
  return {text, stable: next => !!next && !workroomScreenAwaitsAnswer(next.rows)
    && next.cursorRow === cursorRow && next.cursorCol === cursorCol && next.alternate === alternate
    && rows.every((line,index) => next.rows[start+index] === line)
    && (next.rows[end] ?? '') === (frame.rows[end] ?? '')};
}

export interface ExternalCliEffortControl extends Omit<EffortRuntimeControl, 'level' | 'current'> {
  mode(): WorkroomEffortMode;
  allowed(): boolean;
  paste(text: string): Promise<void>;
  notice(message: string): void;
}

/** No transcript, prompt log, timer or global CLI setting. The terminal remains the native CLI. */
export class ExternalCliEffort {
  #failedDraft: string | null = null;
  constructor(private readonly control: ExternalCliEffortControl) {}
  async enter(): Promise<void> {
    const c = this.control;
    const frame = await c.read(), draft = c.agent === 'codex' ? externalCodexDraft(frame) : null;
    const text = draft?.text ?? externalCliPrompt(frame);
    if (text === this.#failedDraft) {this.#failedDraft=null; await c.write('\r'); return;}
    if (c.mode() === 'off' || !text || workroomEffortInputIsManual(c.agent,text) || !c.allowed()) {await c.write('\r'); return;}
    const decision = classifyWorkroomEffort(text);
    const current = frame && cliInfoFromScreen(c.agent, frame.rows).effort;
    if (!decision || !current || !['none','minimal','low','medium','high','xhigh','max','ultra'].includes(current)) {await c.write('\r'); return;}
    if (current === decision.tier) {await c.write('\r'); return;}
    if (c.mode() === 'recommend') {c.notice(`권장 에포트: ${decision.tier} · 현재 ${current}`); await c.write('\r'); return;}
    if (draft) {
      try {
        if (!c.active() || !draft.stable(await c.read())) throw Error('Codex 입력이 변경되어 자동 전송을 멈췄습니다. 입력칸을 확인하세요.');
        const changed = await changeWorkroomEffort({...c,level:decision.tier,current,timeoutMs:2000,
          codexComposerStable: next => draft.stable(next),active:() => c.active() && c.mode() === 'auto'});
        if (changed !== 'applied' || !c.active() || !draft.stable(await c.read())) throw Error('Codex 자동 변경을 확인하지 못해 요청을 전송하지 않았습니다. 입력칸을 확인한 뒤 Enter를 눌러 주세요.');
        await c.write('\r');
      } catch (error) {this.#failedDraft=text;c.notice(error instanceof Error ? error.message : String(error));}
      return;
    }
    let cleared = false;
    try {
      if (!c.active()) {await c.write('\r'); return;}
      const latest = await c.read();
      if (externalCliPrompt(latest) !== text) {await c.write('\r'); return;}
      await c.write('\x15'); // Ctrl-U, only at the verified end of a complete single line.
      for (let i = 0; i < 20; i++) {
        if (effortComposerEmpty(await c.read(), c.agent)) {cleared = true; break;}
        await (c.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(25);
      }
      if (!cleared) throw Error('CLI 입력칸 비우기를 확인하지 못했습니다. 입력칸을 확인한 뒤 Enter를 눌러 주세요.');
      const changed = await changeWorkroomEffort({...c, level: decision.tier, current, timeoutMs: 2000,
        active: () => c.active() && c.mode() === 'auto'});
      if (changed !== 'applied') throw Error('이 CLI의 세션 전용 에포트 제어를 확인하지 못했습니다.');
      await c.paste(text);
      cleared = false;
      if (!c.active() || externalCliPrompt(await c.read()) !== text) throw Error('입력이 변경되어 자동 전송을 멈췄습니다. 입력칸을 확인한 뒤 Enter를 눌러 주세요.');
      await c.write('\r');
    } catch (error) {
      this.#failedDraft = text;
      if (cleared) {
        // Restore only to an empty composer; never confirm an unknown picker or approval.
        if (effortComposerEmpty(await c.read(), c.agent)) await c.paste(text);
        else c.notice('자동 변경이 중단됐습니다. 입력칸에 보존할 요청: ' + text);
      }
      c.notice(error instanceof Error ? error.message : String(error));
      // The intercepted Enter is never replayed after an uncertain native write.
    }
  }
}

export const externalCliEffortAgent = (value: string): value is AiTerminalAgent => ['codex','claude','hermes','agy'].includes(value);
