import type {AiTerminalAgent} from './aiTerminalProtocol';

/**
 * 「다시 시작」 (VOC 2026-10-02 "이런 경우 리스타트를 할 수 있는 기능이 없네"): a Workroom CLI whose screen is stuck
 * or garbled, or that ended, reopens with the same project, AI and permission mode. The Mac continues the
 * conversation for Claude Code and Codex when it can prove which one it was (src/aiTerminalResume.ts).
 * Mac only: a phone keeps 세션 종료 + 작업 시작.
 */
export function workroomRestartConfirm(label: string): string {
  return `${label}을(를) 끝내고 같은 프로젝트·AI로 다시 엽니다.\n\nClaude Code·Codex는 저장된 이전 대화를 이어서 엽니다. CLI 입력칸에 아직 보내지 않은 내용은 사라집니다.`;
}

export function workroomRestartTitle(state: 'running' | 'exited'): string {
  return state === 'running'
    ? '멈추거나 화면이 깨진 CLI를 끝내고 같은 프로젝트·AI로 다시 엽니다 (Claude Code·Codex는 이전 대화를 이어서)'
    : '같은 프로젝트·AI로 다시 엽니다 (Claude Code·Codex는 이전 대화를 이어서)';
}

/** `resumed` undefined: a sidecar older than this window could only open a fresh conversation. */
export function workroomRestartNotice(agent: AiTerminalAgent, resumed: boolean | undefined): string {
  if (resumed === undefined) return '새 대화로 다시 열었습니다. 실행 중인 Mac 앱 서버가 이전 버전이라 이전 대화를 이어 열지 못했습니다. 앱을 다시 시작하면 이어서 열 수 있습니다.';
  if (resumed) return '이전 대화를 이어서 다시 시작했습니다.';
  if (agent === 'claude' || agent === 'codex') return '저장된 이전 대화가 없어 새 대화로 다시 시작했습니다. 다른 대화를 이어가려면 CLI에서 /resume으로 고르세요.';
  return '새 대화로 다시 시작했습니다. 이 AI는 워크룸에서 이전 대화를 이어 열지 않습니다.';
}
