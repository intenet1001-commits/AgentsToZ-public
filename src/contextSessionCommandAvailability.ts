import type {ContextCommandBinding} from './contextSessionCommand';
import type {ContextSession} from './contextSessionMemoryPath';
import {dockContextCommandMessages} from './i18n';

export type ContextCommandCopy=typeof dockContextCommandMessages.ko;
/** `workroom`: an exactly bound local Claude Code Workroom. `orca`: a Claude whose Orca terminal the context list found
 *  to be exactly one live handle (surfacePresence `live`); the host proves it again before it writes. */
export type ContextCommandMode='workroom'|'orca'|'manual';
export interface ContextCommandSupport {available:boolean;mode:ContextCommandMode;reason:string}

const MANUAL_SURFACE:Record<string,string>={terminal:'Terminal.app',iterm:'iTerm',vscode:'VS Code',cmux:'cmux'};

/** Provider capability is independent of memory readiness and snapshot freshness. Every reason is a standing fact
 *  about the row's surface, never a temporary state. */
export function contextCommandAvailability(session:Pick<ContextSession,'sourceAgent'|'sessionId'|'surfaceKind'>&{surfacePresence?:ContextSession['surfacePresence'];workroomSessionId?:ContextSession['workroomSessionId']},binding?:ContextCommandBinding,copy:ContextCommandCopy=dockContextCommandMessages.ko):ContextCommandSupport{
  if(session.sourceAgent==='codex')return {available:false,mode:'manual',reason:session.surfaceKind==='desktop-app'?copy.codexApp:copy.codex};
  // A row kept only for its unconfirmed command (DockSessionsPanel): its window is gone, so nothing can reach it.
  if(session.surfacePresence==='gone')return {available:false,mode:'manual',reason:copy.closed};
  if(binding?.providerSessionId===session.sessionId)return {available:true,mode:'workroom',reason:copy.workroom};
  // A Workroom Claude in a conversation other than the one it launched with (Claude starts as `--session-id <Workroom id>`):
  // after /clear (or a /resume·/fork typed there) the new conversation is never bound (src/aiTerminalService.ts), so this
  // row is that Workroom's newer conversation, not an 「unknown」 window.
  if(session.workroomSessionId&&session.workroomSessionId!==session.sessionId)return {available:false,mode:'manual',reason:copy.workroomUnbound};
  // The conversation its Workroom launched with, but no running Workroom is bound to it — usually that Workroom has
  // ended (an app restart ends them all). It said 「창을 확인하지 못해」, which read as a fault (3호, 2026-10-31). Not
  // 「closed」 outright: a running Workroom whose binding the dock has not read yet looks the same.
  if(session.workroomSessionId&&session.workroomSessionId===session.sessionId)return {available:false,mode:'manual',reason:copy.workroomNotBound};
  if(session.surfaceKind==='orca-worktree'||session.surfaceKind==='orca-floating')
    return session.surfacePresence==='live'?{available:true,mode:'orca',reason:copy.orca}:{available:false,mode:'manual',reason:copy.orcaUnbound};
  const surface=MANUAL_SURFACE[session.surfaceKind];
  return {available:false,mode:'manual',reason:surface?copy.surface.replace('{surface}',surface):session.surfaceKind==='claude-bg-agent'?copy.bgAgent:copy.unknown};
}

/**
 * One row's /compact·/clear button. A Workroom saves and syncs as part of the command, so it needs only a memory the
 * dock can sync; an Orca terminal is never saved through here, so its memory must already be saved and synced
 * (`saved`). When only the memory blocks a supported row, the row says so instead of a generic reason.
 */
export function contextCommandButtonState(input:{busy:boolean;saving:boolean;canSync:boolean;pending:boolean;support:ContextCommandSupport;memorySaved:boolean;memoryReason:string},copy:ContextCommandCopy=dockContextCommandMessages.ko):{enabled:boolean;reason:string}{
  if(!input.support.available)return {enabled:false,reason:input.support.reason};
  if(input.pending)return {enabled:false,reason:copy.pending};
  if(input.busy||input.saving)return {enabled:false,reason:copy.busy};
  if(!input.canSync||input.support.mode==='orca'&&!input.memorySaved)return {enabled:false,reason:`${input.memoryReason} · ${copy.memoryFirst}`};
  return {enabled:true,reason:input.support.reason};
}

export function contextCommandManualGuide(session:Pick<ContextSession,'sourceAgent'>):string{
  return session.sourceAgent==='codex'
    ?'먼저 지금 저장·동기화를 완료하세요. 원본 대화에서 작업이 끝난 뒤 빈 입력칸의 /compact를 선택하면 요약합니다. 새 컨텍스트는 앱의 새 대화로 시작하세요. 여기서는 명령을 전송하지 않습니다.'
    :'먼저 지금 저장·동기화를 완료하세요. 원본 Claude 입력칸에서 작업이 끝난 뒤 /compact 또는 /clear를 실행하세요. 여기서는 명령을 전송하지 않습니다.';
}
