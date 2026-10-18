/**
 * The one Codex `agentstoz_use` MCP entry shape. Two installers write it — the
 * OPS profile connection (src/controlProfileConnections.ts) and the Buzz Agent
 * bootstrap (buzz-agent-bootstrap-server.ts) — and they used to compare
 * different things: the bootstrap demanded an AGENTSTOZ_CONTROLLER_PORT_ID env
 * pin and rejected the profile's entry as a "conflict", while the profile
 * ignored env entirely. Both now build and judge the entry here.
 *
 * The controller pin is optional: the local API authorizes a readable profile
 * token first (api-server `/api/agentstoz-use/action`) and only falls back to
 * the pinned controller when no profile is connected.
 */

import {agentsToZUseMcpCommandNeedsUpgrade} from './agentsToZUseMcpLauncher';

export const AGENTSTOZ_USE_CODEX_SERVER_NAME = 'agentstoz_use';
export const AGENTSTOZ_USE_CONTROLLER_ENV = 'AGENTSTOZ_CONTROLLER_PORT_ID';

export type AgentsToZUseCodexMcpVerdict =
  /** No entry registered. */
  | 'missing'
  /** Registered and able to call tools. */
  | 'ready'
  /** Registered for this executable, but without a controller pin and no readable profile. */
  | 'needs-controller'
  /** Registered with something else (other command, args, transport, controller, or disabled). */
  | 'conflict'
  /** Registered by **us**, but with the older app-bundle command. Safe to rewrite to the launcher. */
  | 'outdated';

export function agentsToZUseCodexMcpAddArgv(codex: string, executable: string, controllerPortId?: string | null): string[] {
  return [
    codex, 'mcp', 'add',
    ...(controllerPortId ? ['--env', `${AGENTSTOZ_USE_CONTROLLER_ENV}=${controllerPortId}`] : []),
    AGENTSTOZ_USE_CODEX_SERVER_NAME, '--', executable,
  ];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Judges `codex mcp get agentstoz_use --json` output. */
export function classifyAgentsToZUseCodexMcpEntry(
  config: unknown,
  expected: {
    executable: string; controllerPortId?: string | null; profileAvailable?: boolean;
    /** 지금 설치된 앱 안의 실행 파일. 우리가 예전에 적어 둔 모양을 알아보기 위해서만 쓴다. */
    bundledExecutable?: string | null;
  },
): AgentsToZUseCodexMcpVerdict {
  const entry = record(config);
  if (!entry) return 'missing';
  if (entry.enabled === false) return 'conflict';
  const transport = record(entry.transport);
  if (!transport) return 'conflict';
  if (transport.type !== undefined && transport.type !== 'stdio') return 'conflict';
  // 우리가 적은 옛 모양(앱 번들 경로)이면 충돌이 아니라 **올릴 것**이다 — 그 경로는 앱을 교체할
  // 때마다 깨지므로 그대로 둘 이유가 없다(2026-10-06). 남이 만든 연결은 여전히 충돌이다.
  if (transport.command !== expected.executable) {
    return agentsToZUseMcpCommandNeedsUpgrade(transport.command, expected.executable, expected.bundledExecutable ?? null)
      ? 'outdated' : 'conflict';
  }
  if (transport.args !== undefined && transport.args !== null
    && !(Array.isArray(transport.args) && transport.args.length === 0)) return 'conflict';
  const env = record(transport.env) ?? {};
  const pinned = env[AGENTSTOZ_USE_CONTROLLER_ENV];
  if (pinned !== undefined && typeof pinned !== 'string') return 'conflict';
  if (!expected.controllerPortId) return 'ready';
  if (pinned !== undefined) return pinned === expected.controllerPortId ? 'ready' : 'conflict';
  return expected.profileAvailable ? 'ready' : 'needs-controller';
}
