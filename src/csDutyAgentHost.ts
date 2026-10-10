import {randomUUID} from 'node:crypto';
import {chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import type {AiTerminalLaunchProfile} from './aiTerminalLaunchArgs';
import {
  DUTY_AGENT_FINISHED_MARKER, DUTY_AGENT_IDLE_MS, DUTY_AGENT_NUDGE, DUTY_AGENT_NUDGES_PER_HOUR, DUTY_AGENT_RESTARTS_PER_HOUR, DutyAgentError, EMPTY_DUTY_AGENT,
  dutyAgentLaunchProfile, dutyAgentMcpConfig, dutyAgentPrompt, findMcpServer, KAKAO_MCP_NAMES, normalizeDutyAgentSettings,
  SLACK_MCP_NAMES, type DutyAgentSettings, type McpServerEntry,
} from './csDutyAgent';
import {workroomScreenAwaitsAnswer} from './workroomRouteDelivery';

/** What the host needs from the Workroom service — the real AiTerminalService satisfies it. */
export interface DutyAgentTerminals {
  perform(value: unknown, authority?: undefined, options?: {launchProfile?: AiTerminalLaunchProfile}): Promise<{session?: {id: string; state: string}}>;
  inspectSession(id: string, targetId: string): {state: string; lastOutputAt: number | null};
  screenText(id: string, targetId: string): Promise<{rows?: string[]} | null>;
}

export interface DutyAgentHostDeps {
  dataDir: string;
  terminals: DutyAgentTerminals;
  /** Registered project → display name and its verified folder (fresh at every start). */
  project(targetId: string): Promise<{name: string; cwd: string}>;
  /** Parsed ~/.claude.json (null when unreadable). */
  claudeConfig(): unknown;
  callTool(entry: McpServerEntry, tool: string, args: Record<string, unknown>): Promise<unknown>;
  now?(): number;
  /** Delegation log folders of the two MCP servers (default ~/.local/state/{kakaotalk,slack}-mcp/delegations). */
  delegationLogDirs?: {kakao: string; slack: string};
}

/**
 * Rooms that someone ended with a stop phrase (「봇 그만」) since the duty was switched on. The MCP keeps that
 * only in its own process, so without this a restart (crash, app update, edit) would start them again.
 */
export function stoppedDutyRooms(dirs: {kakao: string; slack: string}, sinceMs: number): {kakao: Set<string>; slack: Set<string>} {
  const result = {kakao: new Set<string>(), slack: new Set<string>()};
  for (const kind of ['kakao', 'slack'] as const) {
    let names: string[] = [];
    try { names = readdirSync(dirs[kind]).filter(name => name.endsWith('.jsonl')); } catch { continue; }
    for (const name of names) {
      const path = join(dirs[kind], name);
      try {
        if (statSync(path).mtimeMs < sinceMs) continue;
        for (const line of readFileSync(path, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          let entry: {event?: string; reason?: string; at?: string; chat?: string; channel?: string};
          try { entry = JSON.parse(line); } catch { continue; }
          if (entry.event !== 'stopped' || !String(entry.reason ?? '').startsWith('stop phrase')) continue;
          if (entry.at && Date.parse(entry.at) < sinceMs) continue;
          const room = kind === 'kakao' ? entry.chat : entry.channel;
          if (room) result[kind].add(room.normalize('NFC').replace(/\s+/g, '').toLowerCase());
        }
      } catch { /* an unreadable log is no evidence either way */ }
    }
  }
  return result;
}

export interface DutyAgentStatus {
  settings: DutyAgentSettings;
  session: {id: string; state: string} | null;
  mcp: {kakao: boolean; slack: boolean};
  /** Why a wanted duty is not running right now (e.g. restart limit), for the panel. */
  problem: string | null;
}

const ALL_STOPPED = '모든 방이 「봇 그만」으로 끝났습니다.';
type Runtime = {sessionId: string | null; restarts: number[]; problem: string | null; nudgedAt: number; nudges: number[]};

/**
 * Keeps one restricted Claude session per project alive while its duty is on. ON/OFF and the room list
 * are saved (an app restart brings the duty back); the session itself is not — it is started again.
 */
export class DutyAgentHost {
  readonly #file: string;
  readonly #runtime = new Map<string, Runtime>();
  #settings: Record<string, DutyAgentSettings>;
  /** When each duty was last switched on by the user — stop phrases before that no longer count. */
  #since: Record<string, number> = {};
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: DutyAgentHostDeps) {
    const dir = join(deps.dataDir, 'cs-duty');
    mkdirSync(dir, {recursive: true, mode: 0o700});
    this.#file = join(dir, 'agent-duty.json');
    this.#settings = this.#load();
  }

  #now() { return this.deps.now?.() ?? Date.now(); }

  #load(): Record<string, DutyAgentSettings> {
    try {
      const raw = JSON.parse(readFileSync(this.#file, 'utf8')) as {projects?: Record<string, unknown>; since?: Record<string, unknown>};
      for (const [id, at] of Object.entries(raw.since ?? {})) if (typeof at === 'number' && Number.isFinite(at)) this.#since[id] = at;
      const out: Record<string, DutyAgentSettings> = {};
      for (const [id, value] of Object.entries(raw.projects ?? {})) {
        try { out[id] = normalizeDutyAgentSettings(value); } catch { /* a broken entry is dropped, not fatal */ }
      }
      return out;
    } catch { return {}; }
  }

  #persist() {
    const tmp = `${this.#file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({version: 1, projects: this.#settings, since: this.#since}, null, 2), {mode: 0o600});
    renameSync(tmp, this.#file);
  }

  /** Every mutation runs one at a time — a double click must not start two sessions. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #rt(id: string): Runtime {
    let rt = this.#runtime.get(id);
    if (!rt) { rt = {sessionId: null, restarts: [], problem: null, nudgedAt: 0, nudges: []}; this.#runtime.set(id, rt); }
    return rt;
  }

  #session(id: string): {id: string; state: string} | null {
    const rt = this.#runtime.get(id);
    if (!rt?.sessionId) return null;
    try { return {id: rt.sessionId, state: this.deps.terminals.inspectSession(rt.sessionId, id).state}; }
    catch { return null; }
  }

  #servers(cwd?: string) {
    const config = this.deps.claudeConfig();
    return {kakao: findMcpServer(config, KAKAO_MCP_NAMES, cwd), slack: findMcpServer(config, SLACK_MCP_NAMES, cwd)};
  }

  status(id: string): DutyAgentStatus {
    const servers = this.#servers();
    return {settings: this.#settings[id] ?? EMPTY_DUTY_AGENT, session: this.#session(id),
      mcp: {kakao: !!servers.kakao, slack: !!servers.slack}, problem: this.#runtime.get(id)?.problem ?? null};
  }

  save(id: string, input: unknown): Promise<DutyAgentStatus> {
    return this.#serial(async () => {
      const next = normalizeDutyAgentSettings({...(input as object), enabled: this.#settings[id]?.enabled === true});
      const changed = JSON.stringify(next) !== JSON.stringify(this.#settings[id] ?? EMPTY_DUTY_AGENT);
      this.#settings[id] = next;
      this.#persist();
      // A running duty serves the rooms it started with; new rooms need a fresh session.
      if (changed && next.enabled) { await this.#close(id); await this.#start(id); }
      return this.status(id);
    });
  }

  start(id: string): Promise<DutyAgentStatus> {
    return this.#serial(async () => {
      const settings = this.#settings[id] ?? EMPTY_DUTY_AGENT;
      this.#settings[id] = {...settings, enabled: true};
      this.#since[id] = this.#now();
      this.#persist();
      this.#rt(id).restarts = [];
      await this.#start(id);
      return this.status(id);
    });
  }

  stop(id: string): Promise<DutyAgentStatus> {
    return this.#serial(async () => {
      if (this.#settings[id]) { this.#settings[id] = {...this.#settings[id]!, enabled: false}; this.#persist(); }
      await this.#close(id);
      this.#rt(id).problem = null;
      return this.status(id);
    });
  }

  /** KakaoTalk rooms or Slack conversations to pick from, read through the same MCP servers. */
  async choices(kind: 'kakao' | 'slack'): Promise<{id: string; title: string}[]> {
    const servers = this.#servers();
    const entry = kind === 'kakao' ? servers.kakao : servers.slack;
    if (!entry) throw new DutyAgentError(kind === 'kakao' ? '카카오톡 MCP(kakaotalk)가 설치되어 있지 않습니다.' : '슬랙 MCP(slack)가 설치되어 있지 않습니다.');
    if (kind === 'kakao') {
      const result = await this.deps.callTool(entry, 'kakao_chats', {}) as {chats?: {title?: string; title_reliable?: boolean}[]};
      return (result?.chats ?? []).filter(chat => chat.title && chat.title_reliable !== false).slice(0, 200)
        .map(chat => ({id: chat.title!, title: chat.title!}));
    }
    const result = await this.deps.callTool(entry, 'slack_list_conversations', {limit: 300}) as {conversations?: {id?: string; name?: string; type?: string}[]};
    return (result?.conversations ?? []).filter(conv => conv.id && conv.name).map(conv => ({
      id: conv.type === 'im' ? `@${conv.name!.replace(/^@/, '')}` : conv.type === 'mpim' ? conv.id! : `#${conv.name!.replace(/^#/, '')}`,
      title: conv.type === 'im' ? `DM · ${conv.name}` : conv.type === 'mpim' ? `그룹 DM · ${conv.name}` : `#${conv.name!.replace(/^#/, '')}`,
    }));
  }

  async #start(id: string) {
    const rt = this.#rt(id);
    const live = this.#session(id);
    if (live?.state === 'running') return;
    const saved = this.#settings[id] ?? EMPTY_DUTY_AGENT;
    try {
      const stopped = stoppedDutyRooms(this.deps.delegationLogDirs ?? {
        kakao: join(homedir(), '.local/state/kakaotalk-mcp/delegations'), slack: join(homedir(), '.local/state/slack-mcp/delegations'),
      }, this.#since[id] ?? 0);
      const key = (room: string) => room.normalize('NFC').replace(/\s+/g, '').toLowerCase();
      const settings = {...saved, kakaoRooms: saved.kakaoRooms.filter(room => !stopped.kakao.has(key(room))),
        slackChannels: saved.slackChannels.filter(room => !stopped.slack.has(key(room)))};
      if (!settings.kakaoRooms.length && !settings.slackChannels.length && (saved.kakaoRooms.length || saved.slackChannels.length)) {
        throw new DutyAgentError(`${ALL_STOPPED} 다시 지키려면 대직을 껐다 켜세요.`);
      }
      const project = await this.deps.project(id);
      const servers = this.#servers(project.cwd);
      const config = dutyAgentMcpConfig(settings, servers.kakao, servers.slack);
      const configPath = join(this.deps.dataDir, 'cs-duty', `agent-mcp-${id}.json`);
      writeFileSync(configPath, JSON.stringify(config, null, 2), {mode: 0o600});
      chmodSync(configPath, 0o600);
      const response = await this.deps.terminals.perform({
        operation: 'start', requestId: randomUUID(), targetId: id, agent: 'claude', cols: 110, rows: 32,
        prompt: dutyAgentPrompt(project.name, settings),
      }, undefined, {launchProfile: dutyAgentLaunchProfile(settings, configPath)});
      if (!response.session?.id) throw new DutyAgentError('대직 세션을 시작하지 못했습니다.');
      rt.sessionId = response.session.id;
      rt.problem = null;
      rt.nudgedAt = this.#now();
    } catch (error) {
      rt.problem = error instanceof Error ? error.message : '대직 세션을 시작하지 못했습니다.';
      throw error;
    }
  }

  async #close(id: string) {
    const rt = this.#runtime.get(id);
    const live = this.#session(id);
    if (rt && live?.state === 'running') {
      await this.deps.terminals.perform({operation: 'close', requestId: randomUUID(), sessionId: live.id, memoryPolicy: 'skip'}).catch(() => undefined);
    }
    if (rt) rt.sessionId = null;
  }

  /** App start: bring back every duty that was on. Failures are recorded, not thrown. */
  boot(): Promise<void> {
    return this.#serial(async () => {
      for (const [id, settings] of Object.entries(this.#settings)) {
        if (settings.enabled) await this.#start(id).catch(() => undefined);
      }
    });
  }

  /**
   * Once a minute: restart a duty whose session ended (at most three times an hour, then it says why), and
   * wake a session that stopped polling. Never types into a question screen.
   */
  tick(): Promise<void> {
    return this.#serial(async () => {
      const now = this.#now();
      for (const [id, settings] of Object.entries(this.#settings)) {
        if (!settings.enabled) continue;
        const rt = this.#rt(id);
        const live = this.#session(id);
        if (live?.state !== 'running') {
          // Every room was ended with a stop phrase: that is the people in the room asking for quiet, not a crash.
          if (rt.problem?.startsWith(ALL_STOPPED)) continue;
          rt.restarts = rt.restarts.filter(at => now - at < 3_600_000);
          if (rt.restarts.length >= DUTY_AGENT_RESTARTS_PER_HOUR) {
            rt.problem = '대직 세션이 한 시간에 세 번 끝나 다시 시작하지 않았습니다. 세션 화면을 확인한 뒤 다시 켜세요.';
            continue;
          }
          rt.restarts.push(now);
          await this.#start(id).catch(() => undefined);
          continue;
        }
        const inspected = this.deps.terminals.inspectSession(live.id, id);
        const quietSince = Math.max(inspected.lastOutputAt ?? 0, rt.nudgedAt);
        if (now - quietSince < DUTY_AGENT_IDLE_MS) continue;
        const screen = await this.deps.terminals.screenText(live.id, id).catch(() => null);
        if (!screen?.rows || workroomScreenAwaitsAnswer(screen.rows)) continue;
        if (screen.rows.some(row => row.includes(DUTY_AGENT_FINISHED_MARKER))) {
          rt.problem = '모든 방의 대직이 끝났습니다(「봇 그만」 등). 다시 지키려면 대직을 껐다 켜세요.';
          continue;
        }
        rt.nudges = rt.nudges.filter(at => now - at < 3_600_000);
        if (rt.nudges.length >= DUTY_AGENT_NUDGES_PER_HOUR) {
          rt.problem = '대직 세션이 계속 멈춰 있어 깨우기를 쉬고 있습니다. 「세션 보기」로 화면을 확인하세요.';
          continue;
        }
        rt.nudges.push(now);
        rt.nudgedAt = now;
        await this.deps.terminals.perform({operation: 'input', requestId: randomUUID(), sessionId: live.id, data: `${DUTY_AGENT_NUDGE}\r`}).catch(() => undefined);
      }
    });
  }

}
