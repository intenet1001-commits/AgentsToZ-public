/**
 * 실행 버튼에 뜨는 AI 목록을 사용자가 고른다.
 *
 * 안 쓰는 AI의 버튼이 프로젝트 카드·워크트리 행마다 4개씩 붙어 있으면 자주 쓰는 버튼이
 * 그만큼 멀어진다. 설치 여부로 자동 판정하지 않는 이유는 따로 있다 — 말없이 사라지는
 * 버튼은 "이 앱엔 그 기능이 없다"로 읽히기 때문이다(그래서 Hermes는 숨기는 대신 눌렀을 때
 * 미설치를 알린다). 표시 여부는 **사용자가 정하고**, 설치 여부는 **눌렀을 때 알린다.**
 *
 * 저장은 기기별 localStorage다. 기기마다 설치된 AI가 다르므로 동기화하지 않는다.
 */

export type LaunchAgent = 'claude' | 'codex' | 'agy' | 'hermes';

/** 표시 순서의 정본. 헤더 체크박스와 버튼 줄이 같은 순서를 쓴다. */
export const ALL_LAUNCH_AGENTS: readonly LaunchAgent[] = ['claude', 'codex', 'agy', 'hermes'];

export const LAUNCH_AGENT_LABELS: Record<LaunchAgent, string> = {
  claude: 'Claude',
  codex: 'Codex',
  agy: 'agy',
  hermes: 'Hermes',
};

export const HIDDEN_LAUNCH_AGENTS_STORAGE_KEY = 'portmanager-hidden-agents';

function isLaunchAgent(value: unknown): value is LaunchAgent {
  return typeof value === 'string' && (ALL_LAUNCH_AGENTS as readonly string[]).includes(value);
}

/**
 * 저장값을 숨김 집합으로 읽는다.
 *
 * 깨진 값·옛 형식·모르는 이름은 **전부 무시하고 빈 집합**으로 떨어진다. 기본값이
 * "다 보임"이어야 하는 이유는 명확하다 — 파싱 실패로 버튼이 사라지면 사용자는 앱이
 * 고장 났다고 읽지, 설정이 깨졌다고 읽지 않는다.
 */
export function parseHiddenLaunchAgents(raw: string | null | undefined): Set<LaunchAgent> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter(isLaunchAgent));
  } catch {
    return new Set();
  }
}

/** 저장 형식. 순서를 고정해 같은 상태가 같은 문자열이 되게 한다. */
export function serializeHiddenLaunchAgents(hidden: ReadonlySet<LaunchAgent>): string {
  return JSON.stringify(ALL_LAUNCH_AGENTS.filter(agent => hidden.has(agent)));
}

export function toggleHiddenLaunchAgent(
  hidden: ReadonlySet<LaunchAgent>,
  agent: LaunchAgent,
): Set<LaunchAgent> {
  const next = new Set(hidden);
  if (next.has(agent)) next.delete(agent);
  else next.add(agent);
  return next;
}

/** 헤더 라벨에 쓰는 요약. 전부 보이면 개수를 말하지 않는다 — 평상시에 조용해야 한다. */
export function describeVisibleLaunchAgents(hidden: ReadonlySet<LaunchAgent>): string {
  const visible = ALL_LAUNCH_AGENTS.filter(agent => !hidden.has(agent));
  if (visible.length === ALL_LAUNCH_AGENTS.length) return 'AI 표시';
  return `AI 표시 ${visible.length}/${ALL_LAUNCH_AGENTS.length}`;
}
