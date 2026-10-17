/**
 * How a session's activity reads on screen (directory rows, sidebar badge, pop-out title). Pure.
 * Wording follows the host's proof: only an exact turn end says 「완료」; a screen-heuristic one says 「응답 멈춤」.
 * Every group heading is true of every row under it (review 2026-10-16): a guessed end has its own 「응답 멈춤」 group,
 * and a running session whose state is unknown (another Mac, an older sidecar, before the first page) or still starting
 * sits under 「실행 중」 — never 「대기」.
 */
import type {WorkroomActivityView} from './workroomActivityProtocol';

export type WorkroomActivityGroup = 'needs-answer' | 'working' | 'finished' | 'stopped' | 'waiting' | 'running' | 'ended';
export const WORKROOM_ACTIVITY_GROUPS: readonly {id: WorkroomActivityGroup; title: string}[] = [
  {id: 'needs-answer', title: '응답 필요'},
  {id: 'working', title: '작업 중'},
  {id: 'finished', title: '완료'},
  {id: 'stopped', title: '응답 멈춤'},
  {id: 'waiting', title: '대기'},
  {id: 'running', title: '실행 중'},
  {id: 'ended', title: '종료'},
];
export interface WorkroomActivityPresentation {group: WorkroomActivityGroup; label: string; tone: 'needs-answer' | 'working' | 'finished' | 'stopped' | 'waiting' | 'starting' | 'unknown' | 'ended'}

/** `activity` is absent for another Mac's sessions and on an older sidecar: the state is then only running/ended. */
export function workroomActivityPresentation(summaryState: 'running' | 'exited', activity?: WorkroomActivityView | null): WorkroomActivityPresentation {
  if (summaryState === 'exited' || activity?.state === 'exited') {
    const code = activity?.exitCode;
    return {group: 'ended', label: typeof code === 'number' && activity?.cause === 'exit' && code !== 0 ? `종료(코드 ${code})` : '종료', tone: 'ended'};
  }
  switch (activity?.state) {
    case 'needs-answer': return {group: 'needs-answer', label: '응답 필요', tone: 'needs-answer'};
    case 'working': return {group: 'working', label: '작업 중', tone: 'working'};
    case 'starting': return {group: 'running', label: '시작 중', tone: 'starting'};
    case 'turn-finished': return activity.exact ? {group: 'finished', label: '완료', tone: 'finished'} : {group: 'stopped', label: '응답 멈춤', tone: 'stopped'};
    case 'idle': return {group: 'waiting', label: '대기', tone: 'waiting'};
    default: return {group: 'running', label: '실행 중', tone: 'unknown'};
  }
}

/** Pop-out OS title prefix («● 응답 필요 · song-app · Codex CLI — 워크룸»). */
export function workroomActivityTitlePrefix(activity?: WorkroomActivityView | null): string {
  switch (activity?.state) {
    case 'needs-answer': return '● 응답 필요 · ';
    case 'turn-finished': return activity.exact ? '✓ 완료 · ' : '◦ 응답 멈춤 · ';
    case 'working': return '작업 중 · ';
    case 'exited': return '종료 · ';
    default: return '';
  }
}

/** The sidebar badge: sessions waiting on the person (a question or a turn not yet seen). */
export function workroomAttentionCount(sessions: Iterable<WorkroomActivityView>): number {
  let count = 0;
  for (const session of sessions) if (session.state === 'needs-answer' || session.state === 'turn-finished') count++;
  return count;
}

/** The badge's tooltip: it counts proven and guessed turn ends alike, so it names both. */
export function workroomAttentionTitle(count: number): string {
  return `확인할 작업 세션 ${count}개 (응답 필요·완료·응답 멈춤)`;
}

export function workroomOutputAge(lastOutputAt: number | null | undefined, now: number): string {
  if (typeof lastOutputAt !== 'number') return '출력 없음';
  const seconds = Math.max(0, Math.floor((now - lastOutputAt) / 1000));
  if (seconds < 10) return '방금 출력';
  if (seconds < 60) return `${seconds}초 전 출력`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전 출력`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}시간 전 출력`;
  return `${Math.floor(seconds / 86_400)}일 전 출력`;
}
