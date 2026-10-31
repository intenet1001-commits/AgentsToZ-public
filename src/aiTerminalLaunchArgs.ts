import type {AiTerminalAgent} from './aiTerminalProtocol';
import {aiTerminalPromptArgs} from './aiTerminalPromptArgs';
import type {AiTerminalResume} from './aiTerminalResume';
import {CODEX_HOOK_TRUST_FLAG} from './codexHookTrust';
import {opsWorkerApprovalArgs} from './opsWorkerToolApproval';
import {WORKROOM_EFFORT_SUPPORT, type WorkroomEffortLevel} from './workroomEffortPolicy';
import {launchModelError, type AiTerminalLaunchModel} from './workroomTeamInstruction';

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
 * Host-only model choice for one launch (team members, src/workroomTeam.ts). Every CLI has its own flag:
 * Claude `--model`, Codex `-m`, Hermes `chat -m` (+ `--provider`, since a Hermes model may be Claude or OpenAI),
 * Antigravity `--model`. Never part of a wire request; the value is checked before it reaches argv.
 */
export {launchModelError, type AiTerminalLaunchModel} from './workroomTeamInstruction';
export function launchModelArgs(agent: AiTerminalAgent, choice?: AiTerminalLaunchModel | null): string[] {
  if (!choice) return [];
  const error = launchModelError(agent, choice); if (error) throw new Error(error);
  return agent === 'codex' || agent === 'hermes' ? ['-m', choice.model, ...(choice.provider ? ['--provider', choice.provider] : [])] : ['--model', choice.model];
}

/**
 * Keep permission flags before positional prompts; Hermes options belong to chat.
 * A restart that continues a conversation (`resume`, src/aiTerminalResume.ts) replaces Claude's
 * `--session-id` with `--resume <id>` (Claude refuses both without `--fork-session`, and a fork would
 * copy every earlier prompt into a second transcript) and runs Codex's `resume <thread>` subcommand.
 */
export function aiTerminalLaunchArgs(agent: AiTerminalAgent, sessionId: string, prompt?: string, bypassPermissions = false, resume?: AiTerminalResume | null, profile?: AiTerminalLaunchProfile | null,
  /** Codex only, and only when every hook it would run is AgentsToZ's own (codexHookTrust.ts). */
  codexHookTrust = false,
  /**
   * 「에포트 자동」 (w16, workroomEffortPolicy.ts): the level the host chose for this launch, passed with each CLI's own
   * flag. Omitted or null: the arguments are byte-identical to before. A restricted launch (profile) ignores it; Antigravity
   * gets `--effort` only for a team member's pinned level, which names its model variant (auto never drives agy).
   */
  effort?: WorkroomEffortLevel | null,
  /** Host-only per-launch model (see AiTerminalLaunchModel). Omitted: byte-identical arguments. */
  model?: AiTerminalLaunchModel | null,
  /**
   * Host-only: this launch is the worker for an OPS task another Mac handed over (opsWorkerToolApproval.ts). Only
   * the AgentsToZ tools that handover needs are pre-approved; a bypass or restricted launch never takes them.
   */
  opsWorker = false): string[] {
  const level = effort && !profile && (WORKROOM_EFFORT_SUPPORT[agent] === 'launch' || agent === 'agy') ? effort : null;
  // Hermes' configured TUI rejects --reasoning. Its classic CLI supports the
  // launch-only flag; leave the person's interface preference alone otherwise.
  const chosen = launchModelArgs(agent, model);
  if (agent === 'hermes') return ['chat', ...chosen, ...(level ? ['--cli', '--reasoning', level] : []), ...(bypassPermissions ? ['--yolo'] : []), ...(prompt ? ['-q', prompt] : [])];
  const resumed = resume?.agent === agent ? resume.conversationId : undefined;
  const identity = agent === 'claude' ? (resumed ? ['--resume', resumed] : ['--session-id', sessionId])
    : agent === 'codex' ? [...(codexHookTrust ? [CODEX_HOOK_TRUST_FLAG] : []), ...(resumed ? ['resume', resumed] : []), '-c', 'tui.status_line=["model-with-reasoning","context-remaining"]',
      ...(level ? ['-c', `model_reasoning_effort="${level}"`] : [])] : [];
  if (profile && agent !== 'claude') throw new Error('제한 실행은 Claude에서만 지원합니다.');
  const permission = profile ? ['--restricted', '--tools', profile.tools.join(','), '--permission-mode', profile.permissionMode, '--allowedTools', profile.allowedTools.join(','),
      ...(profile.disallowedTools.length ? ['--disallowedTools', profile.disallowedTools.join(',')] : []),
      ...(profile.mcpConfigPath ? ['--mcp-config', profile.mcpConfigPath, '--strict-mcp-config'] : [])]
    // Omitting the flag inherits user settings, including approval_policy=never and
    // sandbox_mode=danger-full-access. Ordinary starts and history resumes must
    // explicitly select their normal policy without changing that global config.
    : !bypassPermissions ? (agent === 'codex' ? ['--ask-for-approval', 'on-request', '--sandbox', 'workspace-write']
      : agent === 'claude' ? ['--permission-mode', 'default'] : []) : agent === 'codex'
    ? ['--dangerously-bypass-approvals-and-sandbox']
    : agent === 'claude' ? ['--permission-mode', 'bypassPermissions'] : ['--dangerously-skip-permissions'];
  const preapproved = opsWorker && !bypassPermissions && !profile ? opsWorkerApprovalArgs(agent) : [];
  return [...identity, ...permission, ...preapproved, ...chosen, ...((agent === 'claude' || agent === 'agy') && level ? ['--effort', level] : []), ...(prompt ? aiTerminalPromptArgs(agent, prompt) : [])];
}
