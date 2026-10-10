export type ProjectConversationAgent = 'codex' | 'hermes';

export type RecentProjectConversationState = 'checking' | 'found' | 'none' | 'unavailable';

export type ProjectConversationChoice = 'new' | 'open-app' | 'recent';

export interface ProjectConversationLaunchCommand {
  agent: ProjectConversationAgent;
  mode: 'new' | 'open' | 'reopen';
  surface: 'desktop-app';
}

/**
 * Codex can always create a fresh app conversation and may additionally
 * reopen an exact recent one. Hermes Desktop can open its project-scoped app
 * or reopen an exact recent conversation; neither may substitute a terminal
 * or Orca launch.
 */
export function visibleProjectConversationChoices(
  agent: ProjectConversationAgent,
  recentState: RecentProjectConversationState,
  appAvailable: boolean | null = true,
): ProjectConversationChoice[] {
  if (agent === 'hermes') {
    if (recentState === 'checking' || appAvailable !== true) return [];
    return recentState === 'found' ? ['open-app', 'recent'] : ['open-app'];
  }
  return recentState === 'found' ? ['new', 'recent'] : ['new'];
}

/**
 * Convert a visible choice into the only external surface it is allowed to
 * reach. Hermes Desktop does not expose a verified new-project deep link, so
 * a Hermes "new" request is rejected instead of silently falling through to
 * the selected terminal or Orca launcher.
 */
export function projectConversationLaunchCommand(
  agent: ProjectConversationAgent,
  choice: ProjectConversationChoice,
): ProjectConversationLaunchCommand | null {
  if (choice === 'new') {
    return agent === 'codex'
      ? { agent: 'codex', mode: 'new', surface: 'desktop-app' }
      : null;
  }
  if (choice === 'open-app') {
    return agent === 'hermes'
      ? { agent: 'hermes', mode: 'open', surface: 'desktop-app' }
      : null;
  }
  return { agent, mode: 'reopen', surface: 'desktop-app' };
}

export function recentProjectConversationNote(
  agent: ProjectConversationAgent,
  recentState: RecentProjectConversationState,
  appAvailable: boolean | null = true,
): string {
  const label = agent === 'codex' ? 'Codex' : 'Hermes Desktop';
  if (recentState === 'checking') return `이 프로젝트의 최근 ${label} 대화를 확인하는 중입니다.`;
  if (agent === 'hermes') {
    if (appAvailable === null) {
      return 'Hermes Desktop 설치 상태를 확인할 수 없어 앱 실행을 막았습니다. 새로고침 후 다시 시도해 주세요.';
    }
    if (appAvailable === false) {
      return 'Hermes Desktop 실행 파일을 찾을 수 없어 앱을 열 수 없습니다. Hermes CLI 설치 상태와는 별개입니다.';
    }
    if (recentState === 'found') return '정확히 연결된 최근 Hermes Desktop 대화가 확인되었습니다. 앱 자체를 열거나 최근 대화 열기를 요청할 수 있습니다.';
    if (recentState === 'none') {
      return '이 프로젝트에 정확히 연결된 최근 Hermes Desktop 대화는 없습니다. Hermes Desktop 자체를 열거나, 새 CLI 작업은 별도의 Hermes CLI 버튼에서 시작할 수 있습니다.';
    }
    return '최근 Hermes Desktop 대화 기록은 확인할 수 없습니다. 앱 자체는 열 수 있으며, 새 CLI 작업은 별도의 Hermes CLI 버튼에서 시작하세요.';
  }
  if (recentState === 'found') return `정확히 연결된 최근 ${label} 대화가 확인되었습니다.`;
  if (recentState === 'none') return '이 프로젝트에 연결된 최근 Codex 대화가 없습니다. 새 Codex 앱 대화를 열 수 있습니다.';
  return '최근 Codex 대화를 확인할 수 없습니다. 새 Codex 앱 대화는 열 수 있습니다.';
}
