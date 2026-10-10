import type { ControlProfileAgent, ControlProfileConnection } from './controlProfileConnections';
import { parseAgentsToZUseMcpBuild } from './agentstozUseMcpVersion';

/**
 * 「채널 연동 상태」 — one honest verdict per channel. A config entry is not a
 * working connection, and a recorded "connected" is not a live one, so the
 * states separate what was *configured* from what was *seen answering*.
 *
 * Pure: every input (connection inspection, probe result, gateway evidence,
 * process list) is gathered by the caller.
 */
export type ChannelHealthState =
  | 'verified'
  | 'configured-unverified'
  | 'configured-unresponsive'
  | 'not-installed'
  | 'unknown';

export const CHANNEL_HEALTH_LABEL: Record<ChannelHealthState, string> = {
  verified: '연결됨 · 확인됨',
  'configured-unverified': '설정됨 · 아직 확인 안 됨',
  'configured-unresponsive': '설정됨 · 응답 없음',
  'not-installed': '설치 안 됨',
  unknown: '확인할 수 없음',
};

/** A successful probe stops counting as current evidence after this long. */
export const CHANNEL_PROBE_FRESH_MS = 30 * 60_000;

export type ChannelProbeResult = {
  ok: boolean;
  checkedAt: string;
  serverVersion: string | null;
  projectCount: number | null;
  error: string | null;
};

export type ChannelHealth = {
  id: string;
  kind: 'mcp' | 'telegram';
  title: string;
  state: ChannelHealthState;
  label: string;
  detail: string;
  notes: string[];
  canProbe: boolean;
  checkedAt: string | null;
};

const AGENT_TITLE: Record<ControlProfileAgent, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  hermes: 'Hermes',
  agy: 'Antigravity (agy)',
};

function result(base: Omit<ChannelHealth, 'label'>): ChannelHealth {
  return { ...base, label: CHANNEL_HEALTH_LABEL[base.state] };
}

export type McpChannelInput = {
  kind: 'mcp';
  agent: ControlProfileAgent;
  connection: ControlProfileConnection | null;
  probe: ChannelProbeResult | null;
  now: number;
  currentBuild: number;
};

export type TelegramChannelInput = {
  kind: 'telegram';
  profile: {
    name: string;
    displayName?: string | null;
    gatewayRunning: boolean;
    telegramConfigured: boolean;
    /** Already downgraded by effectiveTelegramState (dead gateway → 'gateway-stopped'). */
    telegramState: string;
  };
};

export function classifyChannelHealth(input: McpChannelInput | TelegramChannelInput): ChannelHealth {
  return input.kind === 'mcp' ? classifyMcp(input) : classifyTelegram(input);
}

function classifyMcp({ agent, connection, probe, now, currentBuild }: McpChannelInput): ChannelHealth {
  const base = { id: `mcp:${agent}`, kind: 'mcp' as const, title: `${AGENT_TITLE[agent]} · AgentsToZ 제어 도구`, notes: [] as string[], canProbe: false, checkedAt: null };
  if (!connection) {
    return result({ ...base, state: 'unknown', detail: '연결 설정을 읽지 못했습니다. 잠시 후 다시 확인하세요.' });
  }
  if (connection.state === 'unavailable') {
    return result({ ...base, state: 'not-installed', detail: `${AGENT_TITLE[agent]}가 이 컴퓨터에 설치돼 있지 않거나, 앱에 포함된 제어 도구를 찾지 못했습니다.` });
  }
  if (connection.state === 'not-configured') {
    return result({ ...base, state: 'not-installed', detail: `${AGENT_TITLE[agent]}에 AgentsToZ 제어 도구가 아직 등록되지 않았습니다. 운영 프로필 패널에서 연결할 수 있습니다.` });
  }
  if (connection.state === 'needs-attention') {
    return result({ ...base, state: 'unknown', detail: `등록된 설정이 이 앱과 맞지 않거나 읽을 수 없습니다. ${connection.message}` });
  }
  const configured = { ...base, canProbe: true };
  const fresh = probe && Number.isFinite(Date.parse(probe.checkedAt)) && now - Date.parse(probe.checkedAt) <= CHANNEL_PROBE_FRESH_MS ? probe : null;
  if (!fresh) {
    return result({ ...configured, state: 'configured-unverified', detail: '설정은 돼 있습니다. 「지금 확인」을 누르면 프로젝트 목록 읽기(읽기 전용)로 실제 응답을 확인합니다.' });
  }
  const notes: string[] = [];
  const build = parseAgentsToZUseMcpBuild(fresh.serverVersion);
  if (fresh.ok && build !== null && currentBuild > 0 && build !== currentBuild) {
    notes.push(`응답한 제어 도구는 v${build} 빌드입니다(이 앱은 v${currentBuild}).`);
  }
  if (fresh.ok) {
    const count = fresh.projectCount === null ? '' : ` 등록 프로젝트 ${fresh.projectCount}개를 읽었습니다.`;
    return result({ ...configured, notes, checkedAt: fresh.checkedAt, state: 'verified', detail: `제어 도구가 실제로 응답했습니다.${count} 이미 실행 중인 ${AGENT_TITLE[agent]} 대화는 도구를 새로고침해야 새 설정을 씁니다.` });
  }
  return result({ ...configured, notes, checkedAt: fresh.checkedAt, state: 'configured-unresponsive', detail: `설정은 돼 있지만 제어 도구가 응답하지 않았습니다.${fresh.error ? ` (${fresh.error})` : ''}` });
}

function classifyTelegram({ profile }: TelegramChannelInput): ChannelHealth {
  const name = profile.displayName?.trim() || profile.name;
  const base = { id: `telegram:${profile.name}`, kind: 'telegram' as const, title: `텔레그램 봇 · Hermes ${name}`, notes: [] as string[], canProbe: false, checkedAt: null };
  const state = profile.telegramState;
  if (state === 'connected' && profile.gatewayRunning) {
    return result({ ...base, state: 'verified', detail: 'Hermes 게이트웨이가 실행 중이고 텔레그램에 연결돼 있습니다.' });
  }
  if (state === 'unknown') {
    return result({ ...base, state: 'unknown', detail: 'Hermes 게이트웨이 상태 파일을 읽지 못했습니다.' });
  }
  if (state === 'gateway-stopped') {
    return result({ ...base, state: 'configured-unresponsive', detail: '마지막 기록은 연결됨이지만 Hermes 게이트웨이가 꺼져 있어 지금은 메시지에 답하지 않습니다.' });
  }
  if (!profile.telegramConfigured && state === 'not-configured') {
    return result({ ...base, state: 'not-installed', detail: '이 Hermes 프로필에는 텔레그램 봇 토큰이 없습니다.' });
  }
  const setting = profile.telegramConfigured ? '봇 토큰은 설정돼 있지만' : '텔레그램 설정 기록은 있지만';
  if (!profile.gatewayRunning) {
    return result({ ...base, state: 'configured-unverified', detail: `${setting} Hermes 게이트웨이가 실행 중이 아니라 연결을 확인할 수 없습니다.` });
  }
  if (state === 'not-configured') {
    // The gateway is up but never loaded Telegram — typically the token was added after it started.
    return result({ ...base, state: 'configured-unresponsive', detail: '봇 토큰은 있지만 실행 중인 Hermes 게이트웨이가 텔레그램을 켜지 않았습니다. 토큰을 넣기 전에 게이트웨이가 시작됐다면 게이트웨이를 다시 시작하세요.' });
  }
  return result({ ...base, state: 'configured-unresponsive', detail: `Hermes 게이트웨이는 실행 중이지만 텔레그램이 연결돼 있지 않습니다 (${telegramStateText(state)}).` });
}

/** Hermes records platform states in English; show beginners a Korean word, raw value only as a fallback. */
const TELEGRAM_STATE_TEXT: Record<string, string> = {
  connecting: '연결 중',
  reconnecting: '다시 연결 중',
  disconnected: '연결 끊김',
  error: '오류',
  fatal: '오류로 멈춤',
  stopped: '멈춤',
};

function telegramStateText(state: string): string {
  return TELEGRAM_STATE_TEXT[state] ?? `기록된 상태: ${state}`;
}

export type AgentsToZUseMcpProcess = {
  pid: number;
  command: string;
  startedAtMs: number;
  /** Why it is probably running old code, or null when it looks current. */
  staleReason: 'replaced-after-start' | 'other-executable' | null;
};

/** macOS/Linux `ps` elapsed time: [[dd-]hh:]mm:ss → seconds. */
export function parsePsElapsed(value: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds);
}

/**
 * Finds running agentstoz_use MCP processes in `ps -axo pid=,etime=,command=`
 * output. Information only: these belong to the AIs that launched them and
 * are never stopped by the app.
 */
export function findAgentsToZUseMcpProcesses(
  psOutput: string,
  current: { executablePath: string | null; executableMtimeMs: number | null; nowMs: number; excludePids?: readonly number[] },
): AgentsToZUseMcpProcess[] {
  const found: AgentsToZUseMcpProcess[] = [];
  for (const line of psOutput.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[3]!.trim();
    // `ps` joins argv with spaces, so an install path with a space ("/Applications/My Apps/…")
    // would split mid-path. Recognise the known executable by prefix before splitting.
    const exe = current.executablePath;
    const program = exe && (command === exe || command.startsWith(`${exe} `)) ? exe : (command.split(/\s+/)[0] ?? '');
    const isMcp = /(?:^|\/)agentstoz-use-mcp(?:\.exe)?$/.test(program) || /(?:^|[\s/])agentstoz-use-mcp-server\.ts(?:\s|$)/.test(command);
    if (!isMcp || current.excludePids?.includes(pid)) continue;
    const elapsed = parsePsElapsed(match[2]!);
    if (elapsed === null) continue;
    const startedAtMs = current.nowMs - elapsed * 1000;
    let staleReason: AgentsToZUseMcpProcess['staleReason'] = null;
    if (current.executablePath && program.endsWith('agentstoz-use-mcp') && program !== current.executablePath) staleReason = 'other-executable';
    else if (current.executableMtimeMs !== null && program === current.executablePath && startedAtMs < current.executableMtimeMs - 2_000) staleReason = 'replaced-after-start';
    found.push({ pid, command, startedAtMs, staleReason });
  }
  return found;
}

export function describeStaleMcpProcesses(processes: readonly AgentsToZUseMcpProcess[]): string | null {
  const stale = processes.filter(process => process.staleReason !== null);
  if (stale.length === 0) return null;
  return `이전 버전 제어 도구 프로세스 ${stale.length}개가 아직 실행 중입니다(PID ${stale.map(process => process.pid).join(', ')}). 그 프로세스를 띄운 AI를 다시 시작하면 새 버전을 씁니다. 앱은 이 프로세스를 종료하지 않습니다.`;
}

export type ChannelHealthReport = {
  channels: ChannelHealth[];
  /** null when the process list could not be read (e.g. Windows): unknown, not "none". */
  mcpProcesses: { running: number; stale: number; message: string | null } | null;
  appMcpVersion: string;
};

export type ChannelHealthReportDeps = {
  listConnections: () => Promise<ControlProfileConnection[]>;
  hermesProfiles: () => TelegramChannelInput['profile'][];
  listProcesses: () => Promise<string | null>;
  executablePath: string | null;
  executableMtimeMs: number | null;
  probes: ReadonlyMap<ControlProfileAgent, ChannelProbeResult>;
  currentBuild: number;
  appMcpVersion: string;
  now: number;
};

const MCP_AGENTS: readonly ControlProfileAgent[] = ['codex', 'claude', 'hermes', 'agy'];

/** Read-only: inspects config, gateway state files and `ps`; never runs an MCP or AI. */
export async function buildChannelHealthReport(deps: ChannelHealthReportDeps): Promise<ChannelHealthReport> {
  const [connections, psOutput] = await Promise.all([
    deps.listConnections().catch(() => null),
    deps.listProcesses().catch(() => null),
  ]);
  const channels = MCP_AGENTS.map(agent => classifyChannelHealth({
    kind: 'mcp', agent, now: deps.now, currentBuild: deps.currentBuild,
    connection: connections?.find(connection => connection.agent === agent) ?? null,
    probe: deps.probes.get(agent) ?? null,
  }));
  let profiles: TelegramChannelInput['profile'][] = [];
  try { profiles = deps.hermesProfiles(); } catch { profiles = []; }
  channels.push(...profiles.map(profile => classifyChannelHealth({ kind: 'telegram', profile })));
  let mcpProcesses: ChannelHealthReport['mcpProcesses'] = null;
  if (psOutput !== null) {
    const processes = findAgentsToZUseMcpProcesses(psOutput, { executablePath: deps.executablePath, executableMtimeMs: deps.executableMtimeMs, nowMs: deps.now });
    mcpProcesses = { running: processes.length, stale: processes.filter(process => process.staleReason !== null).length, message: describeStaleMcpProcesses(processes) };
  }
  return { channels, mcpProcesses, appMcpVersion: deps.appMcpVersion };
}
