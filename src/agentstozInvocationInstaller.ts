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
import {agyGlobalConfigDir} from './agentOutputStyleInstaller';
import {CONTROL_PROFILE_ALIASES} from './controlProfileContract';
import {AGENTSTOZ_TARGET_ALIAS_GUIDANCE} from './conversationTargetAlias';
import {AGENTSTOZ_MENTION_GUIDANCE} from './agentstozMention';
import {AGENTSTOZ_TEAM_SKILL, AGENTSTOZ_TEAM_SKILL_NAME} from './agentstozTeamSkill';
import {UNFINISHED_WORK_MANAGED_MARKER, UNFINISHED_WORK_SKILL, UNFINISHED_WORK_SKILL_NAME, UNFINISHED_WORK_SKILL_VERSION} from './unfinishedWorkSkill';

export const AGENTSTOZ_INVOCATION_VERSION = 10;
const START = '<!-- AgentsToZ invocation:start -->';
const END = '<!-- AgentsToZ invocation:end -->';
const VERSION_STAMP = `<!-- AgentsToZ invocation-version:${AGENTSTOZ_INVOCATION_VERSION} -->`;

const BODY = `# AgentsToZ conversational control

Treat an explicit \`/agentstoz\`, \`$agentstoz\`, or a request addressed to “AgentsToZ”/“에이전츠투지”/“아젠투지” as a request to use the installed \`agentstoz_use_*\` MCP tools.

Shared invocation aliases: ${CONTROL_PROFILE_ALIASES.join(', ')}. Recognize direct requests; a quotation or mere mention is not an execution request. A name-only greeting reads profile status and does not create a mission.

${AGENTSTOZ_TARGET_ALIAS_GUIDANCE} Use \`agentstoz_use_resolve_target\` before acting on any of these aliases. The result selects a target; only a successful Workroom action proves where the work record belongs.

${AGENTSTOZ_MENTION_GUIDANCE}

- First call \`agentstoz_use_get_control_profile\` to resolve the connected user profile, independent of the current folder or AI. Read relevant operating memory with \`agentstoz_use_recall_control_context\`; target project memory remains separate. Do not create a replacement Control on connection or memory errors.
- When the user says “아젠투지, 기억해” or explicitly asks AgentsToZ to remember an operating decision, submit it with \`agentstoz_use_propose_control_memory\`. For a shared Control folder, a candidate is not a completed save and only the authenticated person may review it in the AgentsToZ panel or SAS-approved remote control. Never call a review endpoint or approve your own candidate. A local-only app-data profile may report \`saved=true\` immediately.
- Use MCP tools directly. Do not replace them with curl, shell networking, or guessed local paths.
- List projects or workspace roots first and use only IDs returned by those tools.
- Creating a project uses \`agentstoz_use_create_project\`; it creates the folder, initializes Git with an initial commit, registers the project, and initializes DEV long-term memory.
- Registering an existing folder uses \`agentstoz_use_register_existing_project\` after listing workspace roots. Give its exact folder name directly under a registered root; registration preserves its Git and memory files. If that root is not registered, add it in the app first.
- Before creating a project, ask about a GitHub repository only when the user has not already decided. Repository visibility must be explicit. Creating the local project does not require GitHub.
- Before an AI launch, follow the shared choice preparation above; a tool name is not the user's surface choice. After the choices are resolved, pass the chosen surface explicitly to the matching launch tool, including internal for a Workroom. For an explicitly selected Workroom, start or list a session, read its initial output, and then send the instruction. Supported agents are Codex, Claude, Hermes, and agy.
- For an explicit task on another device, use \`agentstoz_use_list_ops_devices\`, select its exact endpointId, then \`agentstoz_use_submit_ops_request\` and \`agentstoz_use_wait_ops_request\` until its actual result. The receiving device opens its own configured OPS AI. Preserve endpointId/requestId and exact text on retry; use \`agentstoz_use_get_ops_request_result\` after interruption. Admission or a window is not completion. A receiving OPS worker submits its actual result and evidence with \`agentstoz_use_complete_ops_request\` using its private task capability. Never expose that capability or automatically replay an unknown outcome with a fresh ID.
- Use a durable mission only when the user requests continuing orchestration or the work spans multiple projects or agents. After a restart, resume only on an explicit request to continue.
- For 팀 작전 (one task split across several AI agents, each in its own git worktree, one leader merging), follow the ${AGENTSTOZ_TEAM_SKILL_NAME} skill and its \`agentstoz_use_*_team\` tools. Any model can lead.
- For 미처리·미완료 업무/과제, 후속 작업, backlog or 장기기억 진행 현황 of a registered AgentsToZ project (current or named, e.g. 아젠투지데브), follow the ${UNFINISHED_WORK_SKILL_NAME} skill (Claude \`/${UNFINISHED_WORK_SKILL_NAME}\`, Codex \`$${UNFINISHED_WORK_SKILL_NAME}\`): read-only; improvement instructions only after the user picks.
- Report success only from a successful MCP result. If the tools are unavailable, say that the local AgentsToZ bridge is offline.

Arguments or the words following the invocation are the user's request. Continue naturally when the invocation is spoken in an active voice conversation.`;

function managedBlock(): string {
  return `${START}\n${VERSION_STAMP}\n${BODY}\n${END}`;
}

/**
 * Never downgrade. Every installed app rewrites these files when its sidecar starts, so an older
 * build (a backup bundle, another device's checkout, a dev api-server) used to roll a newer block
 * back until the newer app started again. A copy stamped with a higher version is kept; an equal,
 * older or unstamped one is replaced as before. Builds before invocation 10 lack this check and
 * still rewrite once when they start.
 */
function newerInvocation(text: string): boolean {
  const stamp = /<!-- AgentsToZ invocation-version:(\d+) -->/.exec(text);
  return !!stamp && Number(stamp[1]) > AGENTSTOZ_INVOCATION_VERSION;
}

export function withAgentsToZInvocation(existing: string): string {
  const block = managedBlock();
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  if (start >= 0 && end >= start) {
    if (newerInvocation(existing.slice(start, end))) return existing;
    const after = end + END.length;
    return `${existing.slice(0, start)}${block}${existing.slice(after)}`;
  }
  return `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${block}\n`;
}

const SKILL = `---
name: agentstoz
description: "Control AgentsToZ through installed MCP tools for /agentstoz, $agentstoz, a direct AgentsToZ request, @OPS, @project-DEV, @project-USE, or a #project memory reference in a connected agent CLI or app."
---

${VERSION_STAMP}
${BODY}
`;

const CLAUDE_COMMAND = `---
description: Control AgentsToZ projects, memory, missions, and Workroom agents
argument-hint: "[request]"
---

${VERSION_STAMP}
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

/** A whole file that carries BODY: a copy stamped newer than ours stays as it is (see newerInvocation). */
function invocationFile(path: string, content: string): [string, string] {
  const current = read(path);
  return [path, newerInvocation(current) ? current : content];
}

function installTarget(target: AgentsToZInvocationTarget, writes: Array<[string, string]>): AgentsToZInvocationInstallResult {
  let changed = false;
  for (const [path, content] of writes) changed = atomicWrite(path, content) || changed;
  return { target, paths: writes.map(([path]) => path), changed };
}

// A user may already own a skill with this generic name. Never overwrite or follow
// a foreign file/symlink; future versions may replace only our own managed skill.
// The folder is checked too: a symlinked folder would carry the write to wherever it
// points, and a folder holding someone else's files is theirs even without a SKILL.md.
// Only an empty folder (or one left with our own interrupted temp file) is taken over.
function unfinishedSkillWrite(skillsDir: string): Array<[string, string]> {
  const folder = join(skillsDir, UNFINISHED_WORK_SKILL_NAME);
  const path = join(folder, 'SKILL.md');
  const info = (target: string) => { try { return lstatSync(target); } catch (error: any) { if (error?.code === 'ENOENT') return null; throw error; } };
  const folderInfo = info(folder);
  if (!folderInfo) return [[path, UNFINISHED_WORK_SKILL]];
  if (folderInfo.isSymbolicLink() || !folderInfo.isDirectory()) return [];
  const skillInfo = info(path);
  if (skillInfo) {
    if (skillInfo.isSymbolicLink() || !skillInfo.isFile()) return [];
    const current = readFileSync(path, 'utf8');
    if (!current.includes(UNFINISHED_WORK_MANAGED_MARKER)) return [];
    // Never downgrade our own skill either; the unstamped first release counts as version 1.
    const stamp = /<!-- AgentsToZ agentstoz-unfinished-work skill-version:(\d+) -->/.exec(current);
    if (Number(stamp?.[1] ?? 1) > UNFINISHED_WORK_SKILL_VERSION) return [[path, current]];
    return [[path, UNFINISHED_WORK_SKILL]];
  }
  if (readdirSync(folder).some(name => !name.startsWith('SKILL.md.tmp-'))) return [];
  return [[path, UNFINISHED_WORK_SKILL]];
}

// The CLI has its own skill home; do not create a missing CLI home or write
// through a symlinked parent when installing this managed skill.
function agyCliSkillsDir(home: string): string | null {
  const gemini = join(home, '.gemini');
  const cli = join(gemini, 'antigravity-cli');
  const skills = join(cli, 'skills');
  try {
    for (const path of [gemini, cli]) {
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isDirectory()) return null;
    }
    try {
      const info = lstatSync(skills);
      if (info.isSymbolicLink() || !info.isDirectory()) return null;
    } catch (error: any) {
      if (error?.code !== 'ENOENT') return null;
    }
    return skills;
  } catch { return null; }
}

/** Only a caller that has verified the agy executable may request its first CLI home. */
export function reconcileAgyCliUnfinishedWork(home: string, options: {createCliHome?: boolean} = {}): AgentsToZInvocationInstallResult {
  let skills = agyCliSkillsDir(home);
  if (!skills && options.createCliHome) {
    const gemini = join(home, '.gemini');
    const cli = join(gemini, 'antigravity-cli');
    try {
      const parent = lstatSync(gemini);
      if (parent.isDirectory() && !parent.isSymbolicLink()) {
        try { mkdirSync(cli, {mode: 0o700}); }
        catch (error: any) { if (error?.code !== 'EEXIST') throw error; }
        skills = agyCliSkillsDir(home);
      }
    } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  }
  return installTarget('antigravity', skills ? unfinishedSkillWrite(skills) : []);
}

export function installAgentsToZInvocation(input: { home: string; hermesHome?: string | null; hermesHomes?: readonly string[] }): AgentsToZInvocationInstallResult[] {
  // Decided before anything is written: agy's config folder must be agy's own, never one made here.
  const agyConfig = agyGlobalConfigDir(input.home);
  const agyCliSkills = agyCliSkillsDir(input.home);
  const results = [
    installTarget('codex', [
      invocationFile(join(input.home, '.codex', 'skills', 'agentstoz', 'SKILL.md'), SKILL),
      [join(input.home, '.codex', 'skills', AGENTSTOZ_TEAM_SKILL_NAME, 'SKILL.md'), AGENTSTOZ_TEAM_SKILL],
      ...unfinishedSkillWrite(join(input.home, '.codex', 'skills')),
      [join(input.home, '.codex', 'AGENTS.md'), withAgentsToZInvocation(read(join(input.home, '.codex', 'AGENTS.md')))],
    ]),
    installTarget('claude', [
      invocationFile(join(input.home, '.claude', 'commands', 'agentstoz.md'), CLAUDE_COMMAND),
      [join(input.home, '.claude', 'commands', 'remember_agentstoz.md'), CLAUDE_REMEMBER_COMMAND],
      invocationFile(join(input.home, '.claude', 'skills', 'agentstoz', 'SKILL.md'), SKILL),
      [join(input.home, '.claude', 'skills', AGENTSTOZ_TEAM_SKILL_NAME, 'SKILL.md'), AGENTSTOZ_TEAM_SKILL],
      ...unfinishedSkillWrite(join(input.home, '.claude', 'skills')),
      [join(input.home, '.claude', 'CLAUDE.md'), withAgentsToZInvocation(read(join(input.home, '.claude', 'CLAUDE.md')))],
    ]),
    installTarget('antigravity', [
      invocationFile(join(input.home, '.gemini', 'skills', 'agentstoz', 'SKILL.md'), SKILL),
      [join(input.home, '.gemini', 'skills', AGENTSTOZ_TEAM_SKILL_NAME, 'SKILL.md'), AGENTSTOZ_TEAM_SKILL],
      ...unfinishedSkillWrite(join(input.home, '.gemini', 'skills')),
      // The IDE/config customization home and the CLI skill home are separate.
      // Only use each when its own pre-existing home is present.
      ...(agyConfig ? [invocationFile(join(agyConfig, 'skills', 'agentstoz', 'SKILL.md'), SKILL), [join(agyConfig, 'skills', AGENTSTOZ_TEAM_SKILL_NAME, 'SKILL.md'), AGENTSTOZ_TEAM_SKILL] as [string, string]] : []),
      ...(agyConfig ? unfinishedSkillWrite(join(agyConfig, 'skills')) : []),
      ...(agyCliSkills ? unfinishedSkillWrite(agyCliSkills) : []),
      [join(input.home, '.gemini', 'GEMINI.md'), withAgentsToZInvocation(read(join(input.home, '.gemini', 'GEMINI.md')))],
      ...(agyConfig ? [[join(agyConfig, 'GEMINI.md'), withAgentsToZInvocation(read(join(agyConfig, 'GEMINI.md')))] as [string, string]] : []),
    ]),
  ];
  for (const hermesHome of new Set([input.hermesHome, ...(input.hermesHomes ?? [])].filter((value):value is string=>!!value))) {
    results.push(installTarget('hermes', [
      invocationFile(join(hermesHome, 'skills', 'agentstoz', 'SKILL.md'), SKILL),
      [join(hermesHome, 'skills', 'remember_agentstoz', 'SKILL.md'), HERMES_REMEMBER_SKILL],
      [join(hermesHome, 'skills', AGENTSTOZ_TEAM_SKILL_NAME, 'SKILL.md'), AGENTSTOZ_TEAM_SKILL],
      ...unfinishedSkillWrite(join(hermesHome, 'skills')),
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
