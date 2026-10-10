export type ContextSessionProjectMoveState = 'applied' | 'pending' | 'relocated' | 'unknown';

export interface ContextSessionProjectHint {
  name: string | null;
  /** The folder recorded on the ChatGPT project assignment itself. This is
   * intentionally separate from the pending/applied workspace paths: during a
   * move those three values can disagree. */
  assignedPath?: string | null;
  path: string | null;
  source: 'chatgpt-local-project' | 'claude-relocated';
  moveState: ContextSessionProjectMoveState;
  appliedPath: string | null;
  pendingPath: string | null;
}

export interface ContextSessionMetadata {
  threadTitle: string | null;
  projectHint: ContextSessionProjectHint | null;
}

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const asText = (value: unknown, maxLength = 320): string | null => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
};

const normalizedPath = (value: string | null): string | null => {
  if (!value) return null;
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return null;
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
};

const pathsDiffer = (left: string | null, right: string | null): boolean => {
  const normalizedLeft = normalizedPath(left);
  const normalizedRight = normalizedPath(right);
  return !!normalizedLeft && !!normalizedRight && normalizedLeft !== normalizedRight;
};

const isGenericChatGptTitle = (title: string): boolean => (
  /^(new (voice )?chat|새 (보이스 )?채팅)$/i.test(title.trim())
);

/** Reads only the compact session-index rows, never chat messages. */
export function parseChatGptThreadTitles(indexJsonl: string): Map<string, string> {
  const titles = new Map<string, string>();
  for (const line of indexJsonl.split(/\r?\n/)) {
    try {
      const row = asRecord(JSON.parse(line));
      const sessionId = asText(row?.id, 128);
      const title = asText(row?.thread_name);
      if (!sessionId || !title) continue;
      const previous = titles.get(sessionId);
      if (!previous || !isGenericChatGptTitle(title) || isGenericChatGptTitle(previous)) {
        titles.set(sessionId, title);
      }
    } catch {
      // A concurrently appended JSONL row can be incomplete. Keep the last
      // complete title instead of failing the whole context panel.
    }
  }
  return titles;
}

/**
 * Extracts just a ChatGPT Codex thread title and its local-project assignment.
 * The desktop app state is intentionally treated as optional metadata: callers
 * retain the rollout cwd when it is unavailable or changes shape.
 */
export function parseChatGptThreadMetadata(
  globalState: unknown,
  titles: ReadonlyMap<string, string> = new Map(),
): Map<string, ContextSessionMetadata> {
  const output = new Map<string, ContextSessionMetadata>();
  for (const [sessionId, title] of titles) {
    output.set(sessionId, { threadTitle: title, projectHint: null });
  }

  const root = asRecord(globalState);
  const assignments = asRecord(root?.['thread-project-assignments']);
  const localProjects = asRecord(root?.['local-projects']);
  const atomState = asRecord(root?.['electron-persisted-atom-state']);
  if (!assignments) return output;

  for (const [sessionId, rawAssignment] of Object.entries(assignments)) {
    const assignment = asRecord(rawAssignment);
    if (!assignment || asText(assignment.projectKind, 32) !== 'local') continue;

    const projectId = asText(assignment.projectId, 128);
    const project = projectId ? asRecord(localProjects?.[projectId]) : null;
    const workspace = asRecord(atomState?.[`thread-workspace-state-v1:${sessionId}`]);
    const applied = asRecord(workspace?.applied);
    const pending = asRecord(workspace?.pending);

    const appliedPath = asText(applied?.cwd, 4096);
    const pendingPath = asText(pending?.cwd, 4096);
    const assignedPath = asText(assignment.cwd, 4096) ?? asText(assignment.path, 4096);
    const path = pendingPath ?? assignedPath ?? appliedPath;
    const pendingCoreUpdate = assignment.pendingCoreUpdate === true;
    const moveState: ContextSessionProjectMoveState = (pendingCoreUpdate || pathsDiffer(appliedPath, pendingPath))
      ? 'pending'
      : path
        ? 'applied'
        : 'unknown';

    output.set(sessionId, {
      threadTitle: titles.get(sessionId) ?? null,
      projectHint: {
        name: asText(project?.name),
        assignedPath,
        path,
        source: 'chatgpt-local-project',
        moveState,
        appliedPath,
        pendingPath: pendingPath ?? (moveState === 'pending' ? assignedPath : null),
      },
    });
  }
  return output;
}

/** Parses Claude transcript event metadata while deliberately ignoring messages. */
export function parseClaudeSessionMetadata(transcriptJsonl: string): ContextSessionMetadata {
  let threadTitle: string | null = null;
  let agentName: string | null = null;
  let relocatedCwd: string | null = null;

  for (const line of transcriptJsonl.split(/\r?\n/)) {
    try {
      // Transcript rows can contain full conversation payloads.  Skip every
      // non-metadata event before JSON parsing so this helper only decodes the
      // compact title/relocation rows it is allowed to expose to the panel.
      if (!/^\s*\{\s*"type"\s*:\s*"(?:ai-title|agent-name|relocated)"(?:\s*,|\s*\})/.test(line)) continue;
      const row = asRecord(JSON.parse(line));
      if (!row) continue;
      if (row.type === 'ai-title') threadTitle = asText(row.aiTitle);
      else if (row.type === 'agent-name') agentName = asText(row.agentName);
      else if (row.type === 'relocated') relocatedCwd = asText(row.relocatedCwd, 4096);
    } catch {
      // The bounded tail can begin midway through a JSON row.
    }
  }

  return {
    threadTitle: threadTitle ?? agentName,
    projectHint: relocatedCwd
      ? {
        name: null,
        path: relocatedCwd,
        source: 'claude-relocated',
        moveState: 'relocated',
        appliedPath: null,
        pendingPath: relocatedCwd,
      }
      : null,
  };
}
