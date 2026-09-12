import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const AGENTSTOZ_INVOCATION_VERSION = 1;
const START = '<!-- AgentsToZ invocation:start -->';
const END = '<!-- AgentsToZ invocation:end -->';

const BODY = `# AgentsToZ conversational control

Treat an explicit \`/agentstoz\`, \`$agentstoz\`, or a request addressed to “AgentsToZ”/“에이전츠투지”/“아젠투지” as a request to use the installed \`agentstoz_use_*\` MCP tools.

- Use MCP tools directly. Do not replace them with curl, shell networking, or guessed local paths.
- List projects or workspace roots first and use only IDs returned by those tools.
- Creating a project uses \`agentstoz_use_create_project\`; it creates the folder, initializes Git with an initial commit, registers the project, and initializes DEV long-term memory.
- Before creating a project, ask about a GitHub repository only when the user has not already decided. Repository visibility must be explicit. Creating the local project does not require GitHub.
- For Workroom, start or list a session, read its initial output, and then send the instruction. Supported agents are Codex, Claude, Hermes, and agy.
- Use a durable mission only when the user requests continuing orchestration or the work spans multiple projects or agents. After a restart, resume only on an explicit request to continue.
- Report success only from a successful MCP result. If the tools are unavailable, say that the local AgentsToZ bridge is offline.

Arguments or the words following the invocation are the user's request. Continue naturally when the invocation is spoken in an active voice conversation.`;

function managedBlock(): string {
  return `${START}\n<!-- AgentsToZ invocation-version:${AGENTSTOZ_INVOCATION_VERSION} -->\n${BODY}\n${END}`;
}

export function withAgentsToZInvocation(existing: string): string {
  const block = managedBlock();
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  if (start >= 0 && end >= start) {
    const after = end + END.length;
    return `${existing.slice(0, start)}${block}${existing.slice(after)}`;
  }
  return `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${block}\n`;
}

const SKILL = `---
name: agentstoz
description: Control the local AgentsToZ app through its installed MCP tools when the user invokes /agentstoz, $agentstoz, addresses AgentsToZ by name, or asks to create/manage a project or Workroom through AgentsToZ.
---

${BODY}
`;

const CLAUDE_COMMAND = `---
description: Control AgentsToZ projects, memory, missions, and Workroom agents
argument-hint: "[request]"
---

${BODY}

Handle this request now: $ARGUMENTS
`;

export type AgentsToZInvocationTarget = 'codex' | 'claude' | 'antigravity' | 'hermes';
export interface AgentsToZInvocationInstallResult {
  target: AgentsToZInvocationTarget;
  paths: string[];
  changed: boolean;
}

function atomicWrite(path: string, content: string): boolean {
  const destination = existsSync(path) && lstatSync(path).isSymbolicLink() ? realpathSync(path) : path;
  const previous = existsSync(destination) ? readFileSync(destination, 'utf8') : null;
  if (previous === content) return false;
  mkdirSync(dirname(destination), { recursive: true });
  const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, destination);
  } catch (error) {
    try { unlinkSync(temp); } catch {}
    throw error;
  }
  return true;
}

function installTarget(target: AgentsToZInvocationTarget, writes: Array<[string, string]>): AgentsToZInvocationInstallResult {
  let changed = false;
  for (const [path, content] of writes) changed = atomicWrite(path, content) || changed;
  return { target, paths: writes.map(([path]) => path), changed };
}

export function installAgentsToZInvocation(input: { home: string; hermesHome?: string | null }): AgentsToZInvocationInstallResult[] {
  const results = [
    installTarget('codex', [
      [join(input.home, '.codex', 'skills', 'agentstoz', 'SKILL.md'), SKILL],
      [join(input.home, '.codex', 'AGENTS.md'), withAgentsToZInvocation(read(join(input.home, '.codex', 'AGENTS.md')))],
    ]),
    installTarget('claude', [
      [join(input.home, '.claude', 'commands', 'agentstoz.md'), CLAUDE_COMMAND],
      [join(input.home, '.claude', 'skills', 'agentstoz', 'SKILL.md'), SKILL],
      [join(input.home, '.claude', 'CLAUDE.md'), withAgentsToZInvocation(read(join(input.home, '.claude', 'CLAUDE.md')))],
    ]),
    installTarget('antigravity', [
      [join(input.home, '.gemini', 'skills', 'agentstoz', 'SKILL.md'), SKILL],
      [join(input.home, '.gemini', 'GEMINI.md'), withAgentsToZInvocation(read(join(input.home, '.gemini', 'GEMINI.md')))],
    ]),
  ];
  if (input.hermesHome) {
    results.push(installTarget('hermes', [
      [join(input.hermesHome, 'skills', 'agentstoz', 'SKILL.md'), SKILL],
      [join(input.hermesHome, 'SOUL.md'), withAgentsToZInvocation(read(join(input.hermesHome, 'SOUL.md')))],
    ]));
  }
  return results;
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}
