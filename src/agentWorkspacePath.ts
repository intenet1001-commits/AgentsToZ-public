/**
 * The ChatGPT app gives each Codex conversation its own folder under
 * `~/Documents/Codex/<YYYY-MM-DD>/<slug>`. It is scratch space for that one
 * thread, not a project — work that matters gets moved into a real repository
 * afterwards.
 *
 * The usage panel judges long-term memory by the session's cwd, so such a row
 * correctly reports "no memory here" and then offered to initialize it. That
 * invites writing `.agent-memory` into a folder nobody will open again, and it
 * is also why the row seems not to know which project the work belongs to: the
 * session genuinely ran somewhere else.
 */
export type AgentWorkspaceKind = 'codex-thread-workspace' | 'project';

const CODEX_THREAD_WORKSPACE_RE = /(^|\/)Documents\/Codex\/\d{4}-\d{2}-\d{2}\/[^/]+\/?$/;

export function classifyAgentWorkspacePath(folderPath: string | null | undefined): AgentWorkspaceKind {
  const normalized = (folderPath ?? '').replace(/\\/g, '/').trim();
  if (!normalized) return 'project';
  return CODEX_THREAD_WORKSPACE_RE.test(normalized) ? 'codex-thread-workspace' : 'project';
}

export function isCodexThreadWorkspace(folderPath: string | null | undefined): boolean {
  return classifyAgentWorkspacePath(folderPath) === 'codex-thread-workspace';
}
