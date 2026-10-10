import type {AiTerminalAgent} from './aiTerminalProtocol';

/**
 * Workroom CLI conveniences (VOC 2026-09-24): the model/effort a CLI shows on
 * screen, its slash commands, and per-device slash favorites.
 *
 * Model/effort is display evidence read from the terminal, never a setting of
 * our own — the CLI's own picker (/model, /effort) is what changes it. Screen
 * formats were checked on live Claude Code 2.1 and Codex 0.156 sessions.
 */
export interface WorkroomCliInfo {model?: string; effort?: string}

const EFFORT = '(minimal|low|medium|high|xhigh|max|ultra)';

export function cliInfoFromScreen(agent: AiTerminalAgent, lines: readonly string[]): WorkroomCliInfo {
  const info: WorkroomCliInfo = {};
  for (const line of [...lines].reverse()) {
    if (agent === 'codex') {
      // Newest line first: 「• Model changed to gpt-6-sol high」 after a /model pick wins over the start banner.
      const changed = new RegExp(`Model changed to (\\S+)(?:\\s+${EFFORT})?\\b`).exec(line);
      const m = changed ?? new RegExp(`model:\\s+(\\S.*?)\\s+${EFFORT}\\b`).exec(line);
      if (m && !info.model) { info.model = m[1]!.trim(); if (m[2]) info.effort = m[2]; }
    } else if (agent === 'claude') {
      if (!info.effort) {
        const e = new RegExp(`[◐◑◒◓○●◔◕]\\s+${EFFORT}\\s+·\\s+/effort`).exec(line) ?? new RegExp(`Set effort (?:level )?to ${EFFORT}\\b`).exec(line);
        if (e) info.effort = e[1]!;
      }
      if (!info.model) {
        // 「⎿ Set model to Sonnet 4.6 for this session only with high effort」 (live format, 2026-09-25).
        const set = new RegExp(`Set model to (.+?)(?:\\s+for this session only)?(?:\\s+with ${EFFORT} effort)?(?:\\s+\\(default\\))?\\s*$`).exec(line);
        const banner = /\b((?:Opus|Sonnet|Haiku|Fable)\s\d+(?:\.\d+)?(?:\s\(1M context\))?)\s+·\s+Claude/.exec(line);
        if (set) { info.model = set[1]!.trim(); if (set[2] && !info.effort) info.effort = set[2]; } else if (banner) info.model = banner[1]!;
      }
    }
    if (info.model && info.effort) break;
  }
  return info;
}

/** Buttons open the CLI's own picker; the choice is made in the terminal with the key row. */
export const WORKROOM_MODEL_COMMANDS: Record<AiTerminalAgent, {command: string; label: string}[]> = {
  claude: [{command: '/model', label: '모델 변경'}, {command: '/effort', label: '에포트 변경'}],
  codex: [{command: '/model', label: '모델·에포트 변경'}],
  hermes: [],
  agy: [],
};

/**
 * The live CLI's own memory command. Typing it into the running session is better than drafting a
 * prompt: the agent that holds the conversation writes the memory, while the app's 「지금 저장」 runs a
 * separate process that only sees git plus injected session records. Codex and Antigravity have no
 * such command, so those keep the draft path instead of typing something that would not run.
 */
export const WORKROOM_MEMORY_COMMANDS: Record<AiTerminalAgent, string | null> = {
  claude: '/remember-session',
  codex: '$remember-session',
  hermes: '/remember_session',
  agy: null,
};

export function workroomMemoryCommand(agent: AiTerminalAgent): string | null {
  const command = WORKROOM_MEMORY_COMMANDS[agent] ?? null;
  return command !== null && isWorkroomPaletteCommand(command, agent) ? command : null;
}

export interface SlashCommand {command: string; description: string}
export const WORKROOM_SLASH_COMMANDS: Record<AiTerminalAgent, SlashCommand[]> = {
  claude: [
    {command: '/remember-session', description: '이 프로젝트의 기억 스킬 실행'},
    {command: '/model', description: '모델 변경'},
    {command: '/effort', description: '에포트(추론 강도) 변경'},
    {command: '/context', description: '컨텍스트 사용량 보기'},
    {command: '/usage', description: '사용량·한도'},
    {command: '/compact', description: '대화를 요약해 컨텍스트 줄이기'},
    {command: '/clear', description: '새 대화로 비우기'},
    {command: '/resume', description: '이전 대화 이어가기'},
    {command: '/status', description: '상태'},
    {command: '/agents', description: '에이전트'},
    {command: '/mcp', description: 'MCP 서버'},
    {command: '/permissions', description: '권한'},
    {command: '/help', description: '도움말'},
  ],
  codex: [
    {command: '$remember-session', description: '이 프로젝트의 기억 스킬 실행'},
    {command: '/model', description: '모델·에포트 변경'},
    {command: '/status', description: '세션 상태·사용량'},
    {command: '/compact', description: '대화를 요약해 컨텍스트 줄이기'},
    {command: '/new', description: '새 대화'},
    {command: '/diff', description: '변경 내용 보기'},
    {command: '/review', description: '변경 리뷰'},
    {command: '/approvals', description: '승인 모드'},
    {command: '/mcp', description: 'MCP 서버'},
    {command: '/init', description: 'AGENTS.md 만들기'},
  ],
  hermes: [
    {command: '/help', description: '도움말'},
    {command: '/omh-model', description: '모델'},
    {command: '/omh-status', description: '상태'},
  ],
  agy: [{command: '/help', description: '도움말'}],
};

/** A leading CLI `/token` or Codex skill `$token` before the cursor. */
export function slashCommandQuery(value: string, cursor = value.length): string | null {
  const m = /^\s*[/$]([A-Za-z0-9:_-]*)$/.exec(value.slice(0, cursor));
  return m ? m[1]! : null;
}

export function slashCommandCandidates(agent: AiTerminalAgent, value: string, cursor = value.length): SlashCommand[] {
  const query = slashCommandQuery(value, cursor);
  if (query === null) return [];
  const q = query.toLowerCase();
  const prefix=value.trimStart()[0];
  return WORKROOM_SLASH_COMMANDS[agent].filter(c => c.command[0]===prefix&&c.command.slice(1).toLowerCase().startsWith(q));
}

// Favorites belong to the CLI, not the project: /model means the same everywhere.
const FAVORITES_KEY = 'portmanager-workroom-slash-favorites';
const MAX_FAVORITES = 12;
export const DEFAULT_SLASH_FAVORITES: Record<AiTerminalAgent, string[]> = {
  claude: ['/model', '/effort', '/context', '/compact'],
  codex: ['/model', '/status', '/compact'],
  hermes: [],
  agy: [],
};
type Store = Pick<Storage, 'getItem' | 'setItem'> | null | undefined;

/** One command token: it is typed into a CLI, so no spaces, control characters or paths. */
export function isValidSlashCommand(value: string): boolean {
  return /^\/[A-Za-z0-9][A-Za-z0-9:_-]{0,39}$/.test(value);
}
/** Codex invokes a project skill with `$`, while Claude uses `/`. */
export function isWorkroomPaletteCommand(value:string,agent:AiTerminalAgent):boolean {
  return isValidSlashCommand(value)||agent==='codex'&&/^\$[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(value);
}

function readAll(store: Store): Partial<Record<AiTerminalAgent, string[]>> | null {
  try {
    const raw = store?.getItem(FAVORITES_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

export function readSlashFavorites(store: Store, agent: AiTerminalAgent): string[] {
  const saved = readAll(store)?.[agent];
  if (!Array.isArray(saved)) return [...DEFAULT_SLASH_FAVORITES[agent]];
  return [...new Set(saved.filter((c): c is string => typeof c === 'string' && isWorkroomPaletteCommand(c,agent)))].slice(0, MAX_FAVORITES);
}

export function toggleSlashFavorite(store: Store, agent: AiTerminalAgent, command: string): string[] {
  if (!isWorkroomPaletteCommand(command,agent)) return readSlashFavorites(store, agent);
  const current = readSlashFavorites(store, agent);
  const next = current.includes(command) ? current.filter(c => c !== command) : [...current, command].slice(-MAX_FAVORITES);
  try { store?.setItem(FAVORITES_KEY, JSON.stringify({...(readAll(store) ?? {}), [agent]: next})); } catch { /* Private browsing refuses the write. */ }
  return next;
}
