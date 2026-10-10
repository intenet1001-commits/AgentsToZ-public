export type ProjectCodexConnectionState = 'checking' | 'found' | 'none' | 'unavailable';

/** A metadata read failure is never evidence that a new conversation is needed. */
export function projectCodexPrimaryAction(state: ProjectCodexConnectionState, appAvailable: boolean) {
  if (!appAvailable) return {label: 'Mac의 Codex 앱 준비', enabled: false, intent: 'check' as const};
  if (state === 'found') return {label: 'Mac의 Codex 앱에서 이어 열기', enabled: true, intent: 'continue' as const};
  if (state === 'none') return {label: 'Mac의 Codex 앱에서 처음 열기', enabled: true, intent: 'first' as const};
  return {label: state === 'checking' ? 'Codex 연결 확인 중…' : 'Codex 연결 다시 확인', enabled: state !== 'checking', intent: 'check' as const};
}

export interface ProjectCodexLaunchResult {
  mode: 'prepared' | 'reopened';
  projectConfirmed: true;
  deliveryRequested: true;
  /** OS URL delivery cannot prove foreground window or selected conversation. */
  selectionVerified: false;
}

export function projectCodexLaunchMessage(result: ProjectCodexLaunchResult): string {
  return result.mode === 'prepared'
    ? '프로젝트의 첫 대화를 준비하고 Mac의 Codex 앱에 열기 요청을 보냈습니다. Codex 앱에서 프로젝트를 확인한 뒤 작업하세요.'
    : '확인된 프로젝트 대화를 Mac의 Codex 앱에 여는 요청을 보냈습니다. 앱에서 대화를 확인하세요.';
}
