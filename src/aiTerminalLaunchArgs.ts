import type {AiTerminalAgent} from './aiTerminalProtocol';
import {aiTerminalPromptArgs} from './aiTerminalPromptArgs';
import type {AiTerminalResume} from './aiTerminalResume';
import {CODEX_HOOK_TRUST_FLAG} from './codexHookTrust';

/**
 * Host-only restricted launch (CS duty, src/csDutyAgent.ts). Claude runs in `dontAsk`: anything outside
 * `allowedTools` is refused without a prompt, so a message from an outside chat cannot talk the session
 * into a shell or a file write. Never reachable from a wire request — only an in-process caller passes it.
 */
export interface AiTerminalLaunchProfile {
  permissionMode: 'dontAsk';
  /**
   * Built-in tools that exist at all (`--tools`). With `--restricted` the CLI also ignores the user's,
   * project's and local settings files — their allow-rules (Bash patterns included) must not merge in —
   * and confines file tools to the working directory. Without it a bare `Grep` reached `~/.ssh` (2026-10-06 review).
   */
  tools: string[];
  allowedTools: string[];
  disallowedTools: string[];
  /** Only these MCP servers load (`--strict-mcp-config`). */
  mcpConfigPath?: string;
}

/**
 * Keep permission flags before positional prompts; Hermes options belong to chat.
 * A restart that continues a conversation (`resume`, src/aiTerminalResume.ts) replaces Claude's
 * `--session-id` with `--resume <id>` (Claude refuses both without `--fork-session`, and a fork would
 * copy every earlier prompt into a second transcript) and runs Codex's `resume <thread>` subcommand.
 */
export function aiTerminalLaunchArgs(agent: AiTerminalAgent, sessionId: string, prompt?: string, bypassPermissions = false, resume?: AiTerminalResume | null, profile?: AiTerminalLaunchProfile | null,
  /** Codex only, and only when every hook it would run is AgentsToZ's own (codexHookTrust.ts). */
  codexHookTrust = false): string[] {
  if (agent === 'hermes') return ['chat', ...(bypassPermissions ? ['--yolo'] : []), ...(prompt ? ['-q', prompt] : [])];
  const resumed = resume?.agent === agent ? resume.conversationId : undefined;
  const identity = agent === 'claude' ? (resumed ? ['--resume', resumed] : ['--session-id', sessionId])
    : agent === 'codex' ? [...(codexHookTrust ? [CODEX_HOOK_TRUST_FLAG] : []), ...(resumed ? ['resume', resumed] : []), '-c', 'tui.status_line=["context-remaining"]'] : [];
  if (profile && agent !== 'claude') throw new Error('제한 실행은 Claude에서만 지원합니다.');
  const permission = profile ? ['--restricted', '--tools', profile.tools.join(','), '--permission-mode', profile.permissionMode, '--allowedTools', profile.allowedTools.join(','),
      ...(profile.disallowedTools.length ? ['--disallowedTools', profile.disallowedTools.join(',')] : []),
      ...(profile.mcpConfigPath ? ['--mcp-config', profile.mcpConfigPath, '--strict-mcp-config'] : [])]
    : !bypassPermissions ? [] : agent === 'codex'
    ? ['--dangerously-bypass-approvals-and-sandbox']
    : agent === 'claude' ? ['--permission-mode', 'bypassPermissions'] : ['--dangerously-skip-permissions'];
  return [...identity, ...permission, ...(prompt ? aiTerminalPromptArgs(agent, prompt) : [])];
}
