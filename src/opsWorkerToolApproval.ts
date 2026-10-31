import type { AiTerminalAgent } from './aiTerminalProtocol';

/**
 * An OPS task handed over from another Mac runs in a Workroom started without the approval bypass, so the CLI asked
 * 「Allow the agentstoz_use MCP server to run tool …?」 at every AgentsToZ call and the task waited for a person at
 * 「승인·확인 필요」 (3호 → 1호, 2026-10-31). The person chose to let that one worker run exactly the tools the handover
 * needs without asking. The approval lives only in that launch's arguments: nothing is written to the CLI's settings.
 *
 * Shell commands, file edits, other MCP servers and every AgentsToZ tool not listed here still ask. Left out on purpose:
 * keys (they answer trust and permission screens), forwarding to another device, computer use, the shared shell, project
 * and repository creation, memory writes, messages, teams and product USE.
 */
export const AGENTSTOZ_USE_MCP_SERVER = 'agentstoz_use';
export const OPS_WORKER_PREAPPROVED_TOOLS = [
  'agentstoz_use_get_control_profile',
  'agentstoz_use_recall_control_context',
  'agentstoz_use_resolve_target',
  'agentstoz_use_read_reference',
  'agentstoz_use_list_projects',
  'agentstoz_use_project_status',
  'agentstoz_use_list_workroom_accounts',
  'agentstoz_use_prepare_agent_launch',
  'agentstoz_use_list_workroom_sessions',
  'agentstoz_use_start_workroom_session',
  'agentstoz_use_read_workroom_session',
  'agentstoz_use_wait_workroom_session',
  'agentstoz_use_send_workroom_instruction',
  'agentstoz_use_close_workroom_session',
  'agentstoz_use_complete_ops_request',
] as const;

/**
 * Launch arguments that pre-approve those tools for one worker. Codex 0.166 reads a per-tool
 * `mcp_servers.<server>.tools.<tool>.approval_mode="approve"` override (measured on 3호: a listed tool ran at once, an
 * unlisted one still asked). Claude takes `--allowedTools`. Hermes and agy keep their own prompts.
 */
export function opsWorkerApprovalArgs(agent: AiTerminalAgent): string[] {
  if (agent === 'codex') return OPS_WORKER_PREAPPROVED_TOOLS.flatMap(tool => ['-c', `mcp_servers.${AGENTSTOZ_USE_MCP_SERVER}.tools.${tool}.approval_mode="approve"`]);
  if (agent === 'claude') return ['--allowedTools', OPS_WORKER_PREAPPROVED_TOOLS.map(tool => `mcp__${AGENTSTOZ_USE_MCP_SERVER}__${tool}`).join(',')];
  return [];
}
