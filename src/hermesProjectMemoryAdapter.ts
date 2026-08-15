/**
 * Hermes 게이트웨이용 프로젝트 장기기억 명령 어댑터.
 *
 * Claude·Codex 어댑터는 **프로젝트마다** 설치된다(`.claude/skills/`, `.agents/skills/`).
 * Hermes의 `/remember_session`·`/memory_*` 명령은 프로젝트 밖(텔레그램 대화)에서
 * 실행되는 게이트웨이 명령이라, 설치도 **기기당 한 번**이다.
 *
 * Hermes가 슬래시 명령으로 인식하는 스킬의 출처는 두 곳뿐이다:
 *   1. `<HERMES_HOME>/skills/` — 스킬 허브·큐레이터가 관리하는 영역
 *   2. `config.yaml`의 `skills.external_dirs`
 * 1번에 넣으면 남의 관리 영역에 파일을 얹는 셈이라, 앱은 자기 폴더를 따로 두고
 * 2번으로 등록한다. 큐레이터가 정리해도 살아남고, 앱이 버전을 올려 덮어써도 안전하다.
 */

import { CURRENT_PROJECT_MEMORY_VERSION, memoryAgentVersionMarker } from './projectMemoryVersion';
import { MEMORY_NOTES_DIR_REL, MEMORY_NOTE_BUDGET_BYTES } from './projectMemoryDocument';

/** `config.yaml`에 적히는 값. HERMES_HOME 기준 상대경로라 기기마다 달라지지 않는다. */
export const HERMES_SKILLS_DIR_REL = 'agentstoz-skills';
export const HERMES_MEMORY_MENU_PLUGIN_NAME = 'agentstoz-memory-menu';
/** 제거된 모호한 호환 별칭. 설치 갱신 시 이 앱이 만든 옛 사본만 정리한다. */
export const LEGACY_HERMES_REMEMBER_SKILL_NAME = 'remember';

/**
 * 저장소의 `templates/hermes/<skill>/SKILL.md` 를 설치본으로 바꾼다.
 *
 * 스킬 본문의 정본은 저장소의 템플릿 하나뿐이다 — 설치기가 자기 사본을 들고 있으면
 * 템플릿이 개선돼도 설치된 쪽은 옛 문구를 계속 쓴다. 여기서는 내용을 건드리지 않고
 * 버전 마커만 얹어, 나중에 무엇이 설치돼 있는지 알 수 있게 한다.
 */
export function stampHermesSkill(template: string, version = CURRENT_PROJECT_MEMORY_VERSION): string {
  const marker = memoryAgentVersionMarker(version);
  const stripped = template.replace(/^<!-- AgentsToZ memory-agent-version:\d+ -->\n?/gm, '');
  // frontmatter 를 닫는 두 번째 `---` 바로 뒤에 넣어, 스킬 파서가 읽는 머리말을 깨지 않는다.
  const match = stripped.match(/^---\n[\s\S]*?\n---\n/);
  if (!match) return `${marker}\n${stripped}`;
  return `${match[0]}\n${marker}\n${stripped.slice(match[0].length).replace(/^\n/, '')}`;
}

/** 설치된 SKILL.md에서 버전 마커를 읽는다. 마커가 없으면 앱이 만든 파일이 아니거나 v1이다. */
export function parseHermesProjectMemorySkillVersion(content: string | null): number {
  if (!content) return 0;
  const match = content.match(/<!-- AgentsToZ memory-agent-version:(\d+) -->/);
  if (match) return Number(match[1]);
  return /^name:\s+(?:remember-session|memory-(?:start|link|sync|status|unlink|stop))\s*$/m.test(content) ? 1 : 0;
}

/** `hermesPendingWork`가 읽는 설치 상태. 서버 상태 객체가 구조적으로 만족한다. */
export interface HermesInstallState {
  hermesPresent: boolean;
  available: string[];
  installed: string[];
  externalDirRegistered: boolean;
  menuPluginInstalled?: boolean;
  menuPluginEnabled?: boolean;
  menuCommandCap?: number;
  legacyAliasPresent?: boolean;
  installedVersion: number;
  currentVersion: number;
  updateAvailable: boolean;
}

/**
 * 설치 버튼이 말해야 하는 것은 "몇 개가 깔렸는가"가 아니라 **무엇이 남았는가**다.
 * `(7/7)`은 완료로 읽히는데, 남은 일이 레거시 별칭 삭제 하나뿐인 상태가 실제로 있었다.
 * 남은 일이 없으면 null — 버튼 자체를 띄우지 않는다.
 */
export function hermesPendingWork(status: HermesInstallState): string | null {
  if (!status.hermesPresent || status.available.length === 0) return null;
  const missing = status.available.length - status.installed.length;
  if (missing > 0) return `명령 ${missing}개 설치`;
  if (status.installedVersion < status.currentVersion) {
    return `v${status.installedVersion} → v${status.currentVersion} 업데이트`;
  }
  if (!status.externalDirRegistered) return 'config.yaml 등록';
  if (status.menuPluginInstalled === false) return 'Telegram 메뉴 plugin 설치';
  if (status.menuPluginEnabled === false) return 'Telegram 메뉴 plugin 활성화';
  if (status.menuCommandCap !== undefined && status.menuCommandCap < 100) return 'Telegram 메뉴 100개 설정';
  if (status.legacyAliasPresent) return '레거시 /remember 정리';
  // 이미 돌고 있던 구버전 sidecar는 legacyAliasPresent를 모른다. 남은 일을 특정하지
  // 못해도 "갱신이 필요하다"는 서버 판정 자체는 버리지 않는다.
  return status.updateAvailable ? '명령 갱신' : null;
}

/**
 * `skills.external_dirs`에 우리 폴더가 이미 등록돼 있는지.
 *
 * Hermes는 이 값을 `~` 확장 + HERMES_HOME 기준 상대경로 해석으로 읽으므로
 * (`agent/skill_utils.py: get_external_skills_dirs`), 같은 폴더를 가리키는 표기가
 * 여럿이다. 그중 앱이 쓰는 표기와 절대경로 표기를 인정한다.
 */
export function hermesExternalDirRegistered(configText: string, hermesHome: string): boolean {
  const absolute = `${hermesHome.replace(/\/+$/, '')}/${HERMES_SKILLS_DIR_REL}`;
  const accepted = new Set([HERMES_SKILLS_DIR_REL, absolute, `~/.hermes/${HERMES_SKILLS_DIR_REL}`]);
  const skills = skillsBlock(configText);
  if (!skills) return false;
  for (const raw of externalDirEntries(skills)) {
    if (accepted.has(raw)) return true;
  }
  return false;
}

/** Hermes user-plugin allow-list에 menu-only plugin이 들어 있는지. */
export function hermesMemoryMenuPluginEnabled(configText: string): boolean {
  const lines = configText.split('\n');
  const start = lines.findIndex(line => /^plugins:\s*$/.test(line));
  if (start === -1) return false;
  let inEnabledList = false;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) break;
    const enabled = line.match(/^\s{2}enabled:\s*(.*)$/);
    if (enabled) {
      const rest = enabled[1]!.trim();
      inEnabledList = rest === '' || rest === '[]';
      if (rest.startsWith('[') && rest.endsWith(']')) {
        return rest.slice(1, -1).split(',').map(value => unquote(value.trim()))
          .includes(HERMES_MEMORY_MENU_PLUGIN_NAME);
      }
      if (rest && rest !== '[]') return unquote(rest) === HERMES_MEMORY_MENU_PLUGIN_NAME;
      continue;
    }
    if (!inEnabledList) continue;
    const item = line.match(/^\s{4}-\s*(.+)$/);
    if (item) {
      if (unquote(item[1]!.trim()) === HERMES_MEMORY_MENU_PLUGIN_NAME) return true;
      continue;
    }
    if (line.trim() !== '') inEnabledList = false;
  }
  return false;
}

function nestedConfigBlock(lines: string[], key: string, indent: number): string[] | null {
  const prefix = ' '.repeat(indent);
  const pattern = new RegExp(`^${prefix}${key}:\\s*$`);
  const start = lines.findIndex(line => pattern.test(line));
  if (start === -1) return null;
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === '' || /^\s*#/.test(line)) { body.push(line); continue; }
    const leading = line.match(/^\s*/)?.[0].length ?? 0;
    if (leading <= indent) break;
    body.push(line);
  }
  return body;
}

/** Hermes renderer와 같은 default/clamp 규칙으로 Telegram menu cap을 읽는다. */
export function hermesTelegramMenuCommandCap(configText: string): number {
  let lines = configText.split('\n');
  for (const [key, indent] of [['platforms', 0], ['telegram', 2], ['extra', 4], ['command_menu', 6]] as const) {
    const body = nestedConfigBlock(lines, key, indent);
    if (!body) return 60;
    lines = body;
  }
  const line = lines.find(value => /^\s{8}max_commands:\s*/.test(value));
  if (!line) return 60;
  const raw = unquote(line.slice(line.indexOf(':') + 1).trim().replace(/\s+#.*$/, ''));
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 60;
  return Math.max(1, Math.min(100, parsed));
}

/** `skills:` 블록의 본문(하위 들여쓰기 줄)만 잘라낸다. 없으면 null. */
function skillsBlock(configText: string): string[] | null {
  const lines = configText.split('\n');
  const start = lines.findIndex(line => /^skills:\s*$/.test(line));
  if (start === -1) return null;
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    // 빈 줄과 주석은 블록을 끝내지 않는다 — 들여쓰기 없는 키가 나와야 끝이다.
    if (line.trim() === '' || /^\s*#/.test(line)) { body.push(line); continue; }
    if (!/^\s/.test(line)) break;
    body.push(line);
  }
  return body;
}

function externalDirEntries(skillsBody: string[]): string[] {
  const entries: string[] = [];
  let inList = false;
  for (const line of skillsBody) {
    const inline = line.match(/^\s{2}external_dirs:\s*(.*)$/);
    if (inline) {
      const rest = inline[1]!.trim();
      inList = rest === '' || rest === '[]';
      // `external_dirs: [a, b]` 와 `external_dirs: a` 두 표기 모두 읽는다.
      if (rest.startsWith('[') && rest.endsWith(']')) {
        for (const part of rest.slice(1, -1).split(',')) {
          const value = unquote(part.trim());
          if (value) entries.push(value);
        }
        inList = false;
      } else if (rest && rest !== '[]') {
        entries.push(unquote(rest));
        inList = false;
      }
      continue;
    }
    if (!inList) continue;
    const item = line.match(/^\s{4}-\s*(.+)$/);
    if (item) { entries.push(unquote(item[1]!.trim())); continue; }
    if (line.trim() !== '' && !/^\s*#/.test(line)) inList = false;
  }
  return entries;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed.startsWith('"') && trimmed.endsWith('"') || trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * `config.yaml`에 우리 폴더를 등록한 새 본문을 만든다. 이미 등록돼 있으면 원본 그대로.
 *
 * YAML 라이브러리로 파싱 후 재직렬화하면 사용자의 주석·순서·따옴표가 전부 날아간다.
 * 이 파일은 사용자가 손으로 관리하는 설정이므로 **필요한 줄만 삽입**한다.
 */
export function withHermesExternalDir(configText: string, hermesHome: string): string {
  if (hermesExternalDirRegistered(configText, hermesHome)) return configText;
  const lines = configText.split('\n');
  const start = lines.findIndex(line => /^skills:\s*$/.test(line));

  if (start === -1) {
    // `skills:` 자체가 없다 — 블록째로 덧붙인다.
    const trailingNewline = configText.endsWith('\n') ? '' : '\n';
    return `${configText}${trailingNewline}skills:\n  external_dirs:\n    - ${HERMES_SKILLS_DIR_REL}\n`;
  }

  let end = start + 1;
  let externalDirsLine = -1;
  for (; end < lines.length; end += 1) {
    const line = lines[end]!;
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) break;
    if (/^\s{2}external_dirs:/.test(line)) externalDirsLine = end;
  }

  if (externalDirsLine === -1) {
    // 블록 끝의 빈 줄 앞에 넣어야 다음 최상위 키와 붙지 않는다.
    let insertAt = end;
    while (insertAt > start + 1 && lines[insertAt - 1]!.trim() === '') insertAt -= 1;
    lines.splice(insertAt, 0, '  external_dirs:', `    - ${HERMES_SKILLS_DIR_REL}`);
    return lines.join('\n');
  }

  const existing = lines[externalDirsLine]!;
  const rest = existing.slice(existing.indexOf('external_dirs:') + 'external_dirs:'.length).trim();
  if (rest === '' ) {
    lines.splice(externalDirsLine + 1, 0, `    - ${HERMES_SKILLS_DIR_REL}`);
    return lines.join('\n');
  }
  if (rest === '[]') {
    lines.splice(externalDirsLine, 1, '  external_dirs:', `    - ${HERMES_SKILLS_DIR_REL}`);
    return lines.join('\n');
  }
  if (rest.startsWith('[') && rest.endsWith(']')) {
    const inner = rest.slice(1, -1).trim();
    lines[externalDirsLine] = `  external_dirs: [${inner ? `${inner}, ` : ''}${HERMES_SKILLS_DIR_REL}]`;
    return lines.join('\n');
  }
  // 스칼라 하나로 적혀 있던 경우 — 리스트로 승격한다.
  lines.splice(externalDirsLine, 1, '  external_dirs:', `    - ${rest}`, `    - ${HERMES_SKILLS_DIR_REL}`);
  return lines.join('\n');
}
