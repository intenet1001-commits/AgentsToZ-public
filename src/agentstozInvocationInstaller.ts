import {
  existsSync,
  readdirSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import {CONTROL_PROFILE_ALIASES} from './controlProfileContract';

export const AGENTSTOZ_INVOCATION_VERSION = 3;
const START = '<!-- AgentsToZ invocation:start -->';
const END = '<!-- AgentsToZ invocation:end -->';

const BODY = `# AgentsToZ conversational control

Treat an explicit \`/agentstoz\`, \`$agentstoz\`, or a request addressed to “AgentsToZ”/“에이전츠투지”/“아젠투지” as a request to use the installed \`agentstoz_use_*\` MCP tools.

Shared invocation aliases: ${CONTROL_PROFILE_ALIASES.join(', ')}. Recognize direct requests; a quotation or mere mention is not an execution request. A name-only greeting reads profile status and does not create a mission.

- First call \`agentstoz_use_get_control_profile\` to resolve the connected user profile, independent of the current folder or AI. Read relevant operating memory with \`agentstoz_use_recall_control_context\`; target project memory remains separate. Do not create a replacement Control on connection or memory errors.
- When the user says “아젠투지, 기억해” or explicitly asks AgentsToZ to remember an operating decision, submit it with \`agentstoz_use_propose_control_memory\`. For a shared Control folder, a candidate is not a completed save and only the authenticated person may review it in the AgentsToZ panel or SAS-approved remote control. Never call a review endpoint or approve your own candidate. A local-only app-data profile may report \`saved=true\` immediately.
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

const CLAUDE_REMEMBER_COMMAND = `---
description: Propose one AgentsToZ operating-memory item without approving it
argument-hint: "[what to remember]"
---

Call \`agentstoz_use_get_control_profile\`, then call \`agentstoz_use_propose_control_memory\` once for this explicit request: $ARGUMENTS

Use a stable request ID for retries. If the result is pending, say clearly that it is only a candidate and has not been saved. Never call a review or approval endpoint. If the result explicitly returns \`saved=true\` for a local-only app-data profile, report that local save accurately.
`;

const HERMES_REMEMBER_SKILL = `---
name: remember_agentstoz
description: Propose an AgentsToZ operating-memory item when the user says 아젠투지, 기억해 or invokes /remember_agentstoz.
---

Call \`agentstoz_use_get_control_profile\`, then call \`agentstoz_use_propose_control_memory\` once with the user's explicit operating decision. Use a stable request ID for retries. A shared Control-folder result is only a candidate until an authenticated person reviews it; never review or approve it yourself. A local-only app-data result may explicitly return \`saved=true\`.
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

export function installAgentsToZInvocation(input: { home: string; hermesHome?: string | null; hermesHomes?: readonly string[] }): AgentsToZInvocationInstallResult[] {
  const results = [
    installTarget('codex', [
      [join(input.home, '.codex', 'skills', 'agentstoz', 'SKILL.md'), SKILL],
      [join(input.home, '.codex', 'AGENTS.md'), withAgentsToZInvocation(read(join(input.home, '.codex', 'AGENTS.md')))],
    ]),
    installTarget('claude', [
      [join(input.home, '.claude', 'commands', 'agentstoz.md'), CLAUDE_COMMAND],
      [join(input.home, '.claude', 'commands', 'remember_agentstoz.md'), CLAUDE_REMEMBER_COMMAND],
      [join(input.home, '.claude', 'skills', 'agentstoz', 'SKILL.md'), SKILL],
      [join(input.home, '.claude', 'CLAUDE.md'), withAgentsToZInvocation(read(join(input.home, '.claude', 'CLAUDE.md')))],
    ]),
    installTarget('antigravity', [
      [join(input.home, '.gemini', 'skills', 'agentstoz', 'SKILL.md'), SKILL],
      [join(input.home, '.gemini', 'GEMINI.md'), withAgentsToZInvocation(read(join(input.home, '.gemini', 'GEMINI.md')))],
    ]),
  ];
  for (const hermesHome of new Set([input.hermesHome, ...(input.hermesHomes ?? [])].filter((value):value is string=>!!value))) {
    results.push(installTarget('hermes', [
      [join(hermesHome, 'skills', 'agentstoz', 'SKILL.md'), SKILL],
      [join(hermesHome, 'skills', 'remember_agentstoz', 'SKILL.md'), HERMES_REMEMBER_SKILL],
      [join(hermesHome, 'SOUL.md'), withAgentsToZInvocation(read(join(hermesHome, 'SOUL.md')))],
    ]));
  }
  return results;
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** Include only real configured homes; do not make a missing CLI look installed. */
export function configuredHermesInvocationHomes(home:string, activeHome?:string):string[]{
  const roots=[join(home,'.hermes'),...(activeHome?[activeHome]:[])];
  const profileRoot=join(home,'.hermes','profiles');
  if(existsSync(profileRoot)){
    const info=lstatSync(profileRoot);if(info.isDirectory()&&!info.isSymbolicLink()){
      for(const child of readdirSync(profileRoot,{withFileTypes:true}).slice(0,100))if(child.isDirectory()&&!child.isSymbolicLink())roots.push(join(profileRoot,child.name));
    }
  }
  return [...new Set(roots)].filter(root=>{
    if(!isAbsolute(root)||!existsSync(root)||lstatSync(root).isSymbolicLink())return false;
    const config=join(root,'config.yaml');return existsSync(config)&&lstatSync(config).isFile()&&!lstatSync(config).isSymbolicLink();
  });
}
